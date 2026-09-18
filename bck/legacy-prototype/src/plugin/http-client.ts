import { RecursionGuardError } from "./errors.ts";
import { now } from "./ids.ts";
import type {
  HttpCallTrace,
  MulticaAgentRef,
  MulticaClient,
  MulticaSessionRef,
  MulticaTask,
  MulticaTaskEvent,
  SubmitTaskInput,
  SubmitTaskResult,
  Unsubscribe,
} from "./types.ts";

export interface HttpMulticaClientOptions {
  baseUrl: string;
  token?: string;
  workspaceId?: string;
  fetch?: typeof fetch;
}

/**
 * Plugin-facing Multica client over HTTP + SSE.
 *
 * Paths are the subset this AgentFactory actually drives, not a dump of the
 * public Multica surface. A real Server can sit behind the same routes;
 * the workbench serves a compatible gateway at `/api/multica`.
 */
export class HttpMulticaClient implements MulticaClient {
  readonly transport = "http" as const;
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly workspaceId?: string;
  private readonly fetchImpl: typeof fetch;
  private last: HttpCallTrace | undefined;

  constructor(options: HttpMulticaClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.token = options.token;
    this.workspaceId = options.workspaceId;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  lastCall(): HttpCallTrace | undefined {
    return this.last;
  }

  async listRuntimes() {
    return this.json("GET", "/runtimes");
  }

  async health() {
    return this.json<{
      ok: boolean;
      live?: boolean;
      provider?: string;
      model?: string;
      dialects?: Record<string, string>;
      executors?: Record<string, string>;
      binaries?: { codex?: boolean; claude?: boolean };
      daemon?: {
        online?: boolean;
        count?: number;
        machines?: Array<{
          machineId: string;
          online: boolean;
          tools: string[];
          ageMs?: number;
        }>;
      };
      plane?: string;
    }>("GET", "/health");
  }

  async ensureAgent(input: {
    runtime: string;
    machineId: string;
    nativeProfile?: string;
  }): Promise<MulticaAgentRef> {
    return this.json("POST", "/agents", input);
  }

  async ensureSession(input: {
    agentId: string;
    dshSessionId: string;
    segmentId: string;
    resumeCliSessionId?: string;
  }): Promise<MulticaSessionRef> {
    return this.json("POST", "/sessions", input);
  }

  async submitTask(input: SubmitTaskInput): Promise<SubmitTaskResult> {
    return this.json("POST", "/tasks", input);
  }

  async cancelTask(taskId: string): Promise<void> {
    await this.json("POST", `/tasks/${encodeURIComponent(taskId)}/cancel`);
  }

  async getTask(taskId: string): Promise<MulticaTask | undefined> {
    const result = await this.json<MulticaTask | { missing: true }>(
      "GET",
      `/tasks/${encodeURIComponent(taskId)}`,
    );
    if (result && "missing" in result) return undefined;
    return result;
  }

  async getTaskByClientRequestId(
    clientRequestId: string,
  ): Promise<MulticaTask | undefined> {
    const query = new URLSearchParams({ clientRequestId }).toString();
    const result = await this.json<MulticaTask | { missing: true }>(
      "GET",
      `/tasks?${query}`,
    );
    if (result && "missing" in result) return undefined;
    return result;
  }

  subscribe(
    taskId: string,
    handler: (event: MulticaTaskEvent) => void,
  ): Unsubscribe {
    const controller = new AbortController();
    void this.consumeSse(taskId, handler, controller.signal);
    return () => controller.abort();
  }

  async dropNextAck(): Promise<void> {
    await this.json("POST", "/debug/drop-ack");
  }

  private async consumeSse(
    taskId: string,
    handler: (event: MulticaTaskEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const response = await this.request(
      "GET",
      `/tasks/${encodeURIComponent(taskId)}/events`,
      undefined,
      signal,
    );
    if (response.status !== 200 || !response.body) {
      throw new Error(`Multica SSE ${response.status} for task ${taskId}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = flushSse(buffer, handler);
      }
    } catch (error) {
      if (signal.aborted) return;
      throw error;
    }
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (this.workspaceId) headers["X-Workspace-ID"] = this.workspaceId;
    return headers;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const response = await this.fetchImpl(url, {
      method,
      headers: {
        ...this.headers(),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
    this.last = {
      at: now(),
      method,
      path,
      status: response.status,
    };
    if (response.status === 409) {
      const payload = (await response.json()) as { message?: string; profile?: string };
      throw new RecursionGuardError(payload.profile ?? "unknown");
    }
    if (response.status === 404) return response;
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Multica HTTP ${response.status} ${method} ${path}: ${text}`);
    }
    return response;
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.request(method, path, body);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}

function flushSse(
  buffer: string,
  handler: (event: MulticaTaskEvent) => void,
): string {
  let rest = buffer;
  let idx = rest.indexOf("\n\n");
  while (idx >= 0) {
    const frame = rest.slice(0, idx);
    rest = rest.slice(idx + 2);
    const dataLine = frame.split("\n").find((line) => line.startsWith("data:"));
    if (dataLine) {
      const json = dataLine.slice(dataLine.indexOf(":") + 1).trim();
      if (json) handler(JSON.parse(json) as MulticaTaskEvent);
    }
    idx = rest.indexOf("\n\n");
  }
  return rest;
}

export function fetchAgainstHandler(
  handler: (request: Request) => Promise<Response>,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    return handler(request);
  }) as typeof fetch;
}
