import { readFileSync } from "node:fs";
import { NATIVE_DSH_PROFILE, PLATFORM_DSH_PROFILE } from "../plugin/capabilities.ts";
import { RecursionGuardError } from "../plugin/errors.ts";
import { createId, now } from "../plugin/ids.ts";
import type {
  EnvironmentKind,
  MulticaAgentRef,
  MulticaSessionRef,
  MulticaTask,
  MulticaTaskEvent,
  RuntimeKind,
  SubmitTaskInput,
  SubmitTaskResult,
  Unsubscribe,
} from "../plugin/types.ts";
import { dialectFor } from "../sim/deepseek.ts";

interface OfficialRuntime {
  id: string;
  name?: string;
  launch_header?: string;
  last_seen_at?: string;
  metadata?: { version?: string };
}

interface OfficialAgent {
  id: string;
  name: string;
  runtime_id: string;
  has_custom_env?: boolean;
}

interface OfficialTaskRow {
  id: string;
  status: string;
  agent_id?: string;
  chat_session_id?: string;
  error?: string | null;
  result?: { output?: string } | null;
}

interface OfficialTaskMessage {
  task_id: string;
  seq: number;
  type: string;
  tool?: string;
  input?: Record<string, unknown> | null;
  output?: string;
  content?: string;
  text?: string;
}

export interface OfficialConfig {
  baseUrl: string;
  token: string;
  workspaceId: string;
}

const HEARTBEAT_GRACE_MS = 45_000;

export function loadOfficialConfig(): OfficialConfig | undefined {
  let token = process.env["MULTICA_TOKEN"] ?? "";
  let workspaceId = process.env["MULTICA_WORKSPACE_ID"] ?? "";
  try {
    if (!token) token = readFileSync("/opt/multica-official/pat.token", "utf8").trim();
    if (!workspaceId) {
      workspaceId = readFileSync("/opt/multica-official/workspace.id", "utf8").trim();
    }
  } catch {
    /* files are optional when env is set */
  }
  if (!token || !workspaceId) return undefined;
  const fromEnv = (
    process.env["MULTICA_OFFICIAL_URL"] ||
    process.env["MULTICA_SERVER_URL"] ||
    ""
  ).replace(/\/$/, "");
  const baseUrl =
    fromEnv && !fromEnv.includes("/api/multica")
      ? fromEnv
      : "http://127.0.0.1:18080";
  return { baseUrl, token, workspaceId };
}

function runtimeKindFromHeader(header: string): RuntimeKind | undefined {
  const value = header.toLowerCase();
  if (value.includes("codex")) return "codex";
  if (value.includes("claude")) return "claude-code";
  if (value.includes("pi")) return "pi";
  if (value.includes("dsh") || value.includes("deepseek")) return "dsh";
  return undefined;
}

/**
 * Plugin-facing Multica plane that talks to the official Server.
 * Execution is the official Daemon (Codex / Claude CLI).
 */
export class OfficialMulticaPlane {
  readonly kind = "official" as const;
  ackDropArmed = false;
  lastSubmit: SubmitTaskInput | undefined;
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly workspaceId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly tasks = new Map<string, MulticaTask>();
  private readonly byRequest = new Map<string, string>();
  private readonly listeners = new Map<string, Set<(event: MulticaTaskEvent) => void>>();
  private readonly agentCache = new Map<string, MulticaAgentRef>();
  private readonly sessionCache = new Map<string, MulticaSessionRef>();
  private readonly chatBySession = new Map<string, string>();
  private readonly follow = new Map<string, { agentId: string; chatId: string }>();

  constructor(config: OfficialConfig, fetchImpl?: typeof fetch) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.token = config.token;
    this.workspaceId = config.workspaceId;
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async snapshotLive() {
    const runtimes = await this.officialRuntimes();
    const online = runtimes.filter((row) => this.isOnline(row));
    const kinds = new Set(
      online
        .map((row) => runtimeKindFromHeader(row.launch_header ?? row.name ?? ""))
        .filter(Boolean),
    );
    return {
      live: online.length > 0,
      provider: "deepseek",
      model: "deepseek-flash",
      dialects: {
        dsh: dialectFor("dsh"),
        codex: dialectFor("codex"),
        "claude-code": dialectFor("claude-code"),
        pi: dialectFor("pi"),
      },
      plane: "official" as const,
      executors: {
        dsh: kinds.has("dsh") ? "official-daemon" : "unavailable",
        codex: kinds.has("codex") ? "official-daemon" : "unavailable",
        "claude-code": kinds.has("claude-code") ? "official-daemon" : "unavailable",
        pi: kinds.has("pi") ? "official-daemon" : "unavailable",
      },
      binaries: {
        codex: kinds.has("codex"),
        claude: kinds.has("claude-code"),
      },
      daemon: {
        online: online.length > 0,
        count: 1,
        machines: [
          {
            machineId: "official-daemon",
            online: online.length > 0,
            tools: [...kinds],
            lastHeartbeat: Date.now(),
            ageMs: 0,
          },
        ],
      },
    };
  }

  async listRuntimes() {
    const official = await this.officialRuntimes();
    const rows: Array<{
      id: string;
      runtime: RuntimeKind;
      machineId: string;
      environment: EnvironmentKind;
      nativeProfile?: string;
      online: boolean;
    }> = [];
    for (const item of official) {
      const kind = runtimeKindFromHeader(item.launch_header ?? item.name ?? "");
      if (!kind) continue;
      rows.push({
        id: item.id,
        runtime: kind,
        machineId: "cube-personal",
        environment: "personal-persistent",
        nativeProfile: kind === "dsh" ? NATIVE_DSH_PROFILE : undefined,
        online: this.isOnline(item),
      });
    }
    return rows;
  }

  async ensureAgent(input: {
    runtime: RuntimeKind;
    machineId: string;
    nativeProfile?: string;
  }): Promise<MulticaAgentRef> {
    if (input.runtime === "dsh" && input.nativeProfile !== NATIVE_DSH_PROFILE) {
      throw new RecursionGuardError(input.nativeProfile ?? PLATFORM_DSH_PROFILE);
    }
    const key = `${input.runtime}:${input.machineId}:${input.nativeProfile ?? ""}`;
    const cached = this.agentCache.get(key);
    if (cached) return cached;
    const runtimeId = await this.runtimeIdFor(input.runtime);
    const agents = await this.json<OfficialAgent[]>("GET", "/api/agents");
    let found = agents.find((agent) => agent.runtime_id === runtimeId);
    if (!found) {
      found = await this.json<OfficialAgent>("POST", "/api/agents", {
        name: input.runtime === "claude-code" ? "Claude" : title(input.runtime),
        runtime_id: runtimeId,
        visibility: "workspace",
        instructions: "You are a coding agent. Keep answers short.",
      });
    }
    await this.ensureAgentEnv(found.id);
    const ref: MulticaAgentRef = {
      id: found.id,
      runtime: input.runtime,
      machineId: input.machineId,
    };
    this.agentCache.set(key, ref);
    return ref;
  }

  async ensureSession(input: {
    agentId: string;
    dshSessionId: string;
    segmentId: string;
    resumeCliSessionId?: string;
  }): Promise<MulticaSessionRef> {
    const key = `${input.agentId}:${input.segmentId}`;
    const existing = this.sessionCache.get(key);
    if (existing) return existing;
    if (input.resumeCliSessionId) {
      const created: MulticaSessionRef = {
        id: input.resumeCliSessionId,
        agentId: input.agentId,
        cliSessionId: input.resumeCliSessionId,
      };
      this.sessionCache.set(key, created);
      this.chatBySession.set(created.id, input.resumeCliSessionId);
      return created;
    }
    const chat = await this.json<{ id: string }>("POST", "/api/chat/sessions", {
      agent_id: input.agentId,
      title: `dsh ${input.dshSessionId.slice(0, 8)}`,
    });
    const created: MulticaSessionRef = {
      id: chat.id,
      agentId: input.agentId,
      cliSessionId: chat.id,
    };
    this.sessionCache.set(key, created);
    this.chatBySession.set(created.id, chat.id);
    return created;
  }

  async submitTask(input: SubmitTaskInput): Promise<SubmitTaskResult> {
    if (input.runtime === "dsh" && input.nativeProfile !== NATIVE_DSH_PROFILE) {
      throw new RecursionGuardError(input.nativeProfile ?? PLATFORM_DSH_PROFILE);
    }
    this.lastSubmit = input;
    const existingId = this.byRequest.get(input.clientRequestId);
    if (existingId) {
      if (this.ackDropArmed) {
        this.ackDropArmed = false;
        return { status: "unknown", clientRequestId: input.clientRequestId };
      }
      return {
        status: "accepted",
        taskId: existingId,
        sessionId: this.tasks.get(existingId)?.sessionId ?? input.sessionId ?? existingId,
      };
    }

    const chatId = input.sessionId
      ? (this.chatBySession.get(input.sessionId) ?? input.sessionId)
      : undefined;
    if (!chatId) throw new Error("official chat session is missing");
    const sent = await this.json<{ task_id: string }>(
      "POST",
      `/api/chat/sessions/${encodeURIComponent(chatId)}/messages`,
      { content: input.prompt },
    );
    const taskId = sent.task_id;
    const task: MulticaTask = {
      id: taskId,
      clientRequestId: input.clientRequestId,
      status: "queued",
      sessionId: input.sessionId,
      cliSessionId: input.resumeCliSessionId,
      events: [],
    };
    this.tasks.set(taskId, task);
    this.byRequest.set(input.clientRequestId, taskId);
    this.follow.set(taskId, { agentId: input.agentId, chatId });
    this.note(task, this.ev(taskId, "task/accepted", { clientRequestId: input.clientRequestId }));
    this.note(
      task,
      this.ev(taskId, "task/started", {
        cwd: input.cwd,
        cli: input.runtime,
        dialect: dialectFor(input.runtime),
        plane: "official",
      }),
    );
    void this.pollTask(taskId, input.runtime);

    if (this.ackDropArmed) {
      this.ackDropArmed = false;
      return { status: "unknown", clientRequestId: input.clientRequestId };
    }
    return { status: "accepted", taskId, sessionId: input.sessionId ?? taskId };
  }

  async cancelTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    try {
      await this.json("POST", `/api/tasks/${encodeURIComponent(taskId)}/cancel`);
    } catch {
      /* already terminal */
    }
    if (task && task.status !== "completed" && task.status !== "failed") {
      task.status = "canceled";
      this.note(task, this.ev(taskId, "task/canceled", { plane: "official" }));
    }
  }

  async getTask(taskId: string): Promise<MulticaTask | undefined> {
    const task = this.tasks.get(taskId);
    return task ? { ...task, events: [...task.events] } : undefined;
  }

  async getTaskByClientRequestId(clientRequestId: string): Promise<MulticaTask | undefined> {
    const id = this.byRequest.get(clientRequestId);
    return id ? this.getTask(id) : undefined;
  }

  subscribe(taskId: string, handler: (event: MulticaTaskEvent) => void): Unsubscribe {
    const set = this.listeners.get(taskId) ?? new Set();
    set.add(handler);
    this.listeners.set(taskId, set);
    const existing = this.tasks.get(taskId);
    if (existing) {
      for (const event of existing.events) handler(event);
    }
    return () => {
      this.listeners.get(taskId)?.delete(handler);
    };
  }

  dropNextAck(): void {
    this.ackDropArmed = true;
  }

  private async pollTask(taskId: string, runtime: RuntimeKind): Promise<void> {
    const meta = this.follow.get(taskId);
    const task = this.tasks.get(taskId);
    if (!meta || !task) return;
    let lastSeq = 0;
    let assistant = "";
    for (let i = 0; i < 300; i += 1) {
      if (task.status === "canceled") return;
      try {
        const messages = await this.json<OfficialTaskMessage[]>(
          "GET",
          `/api/tasks/${encodeURIComponent(taskId)}/messages`,
        );
        for (const message of messages) {
          if (message.seq <= lastSeq) continue;
          lastSeq = message.seq;
          if (message.type === "tool_use") {
            this.note(
              task,
              this.ev(taskId, "tool/call", {
                name: message.tool ?? "tool",
                args: message.input ?? {},
              }),
            );
          } else if (message.type === "tool_result") {
            this.note(
              task,
              this.ev(taskId, "tool/result", {
                name: message.tool ?? "tool",
                preview: (message.output ?? "").slice(0, 400),
              }),
            );
          } else if (
            message.type === "text" ||
            message.type === "agent_message" ||
            message.type === "assistant"
          ) {
            const text = message.text ?? message.content ?? message.output ?? "";
            if (text) {
              assistant += text;
              this.note(task, this.ev(taskId, "text/delta", { text }));
            }
          }
        }
        const rows = await this.json<OfficialTaskRow[]>(
          "GET",
          `/api/agents/${encodeURIComponent(meta.agentId)}/tasks`,
        );
        const row = rows.find((item) => item.id === taskId);
        if (row?.status === "completed") {
          const text =
            assistant ||
            row.result?.output ||
            (await this.latestAssistant(meta.chatId)) ||
            "(empty model reply)";
          this.note(
            task,
            this.ev(taskId, "text/committed", {
              text,
              executor: "official-daemon",
              plane: "official",
              runtime,
            }),
          );
          this.note(task, this.ev(taskId, "task/completed", { plane: "official" }));
          return;
        }
        if (row?.status === "failed") {
          this.note(
            task,
            this.ev(taskId, "task/failed", {
              message: row.error || "official task failed",
              plane: "official",
            }),
          );
          return;
        }
        if (row?.status === "cancelled" || row?.status === "canceled") {
          this.note(task, this.ev(taskId, "task/canceled", { plane: "official" }));
          return;
        }
      } catch {
        /* retry */
      }
      await sleep(400);
    }
    this.note(task, this.ev(taskId, "task/failed", { message: "official poll timed out" }));
  }

  private async latestAssistant(chatId: string): Promise<string> {
    try {
      const messages = await this.json<Array<{ role?: string; content?: string }>>(
        "GET",
        `/api/chat/sessions/${encodeURIComponent(chatId)}/messages`,
      );
      const assistant = [...messages].reverse().find((row) => row.role === "assistant");
      return assistant?.content ?? "";
    } catch {
      return "";
    }
  }

  private async runtimeIdFor(kind: RuntimeKind): Promise<string> {
    const runtimes = await this.officialRuntimes();
    const match = runtimes.find(
      (row) => runtimeKindFromHeader(row.launch_header ?? row.name ?? "") === kind && this.isOnline(row),
    );
    if (!match) {
      throw new Error(`官方 Daemon 上没有在线的 ${kind} runtime`);
    }
    return match.id;
  }

  private async officialRuntimes(): Promise<OfficialRuntime[]> {
    return this.json<OfficialRuntime[]>("GET", "/api/runtimes");
  }

  private isOnline(row: OfficialRuntime): boolean {
    if (!row.last_seen_at) return true;
    const seen = Date.parse(row.last_seen_at);
    if (Number.isNaN(seen)) return true;
    return Date.now() - seen < HEARTBEAT_GRACE_MS;
  }

  private async ensureAgentEnv(agentId: string): Promise<void> {
    const key = process.env["DEEPSEEK_API_KEY"] ?? "";
    const custom_env: Record<string, string> = {
      CODEX_HOME: process.env["CODEX_HOME"] ?? "/workspace/.runtime/codex-home",
      CLAUDE_CONFIG_DIR:
        process.env["CLAUDE_CONFIG_DIR"] ?? "/workspace/.runtime/claude-home",
    };
    if (key) custom_env["DEEPSEEK_API_KEY"] = key;
    await this.json("PUT", `/api/agents/${encodeURIComponent(agentId)}/env`, { custom_env });
  }

  private note(task: MulticaTask, event: MulticaTaskEvent): void {
    if (event.type === "task/started") task.status = "running";
    if (event.type === "task/completed") task.status = "completed";
    if (event.type === "task/failed") task.status = "failed";
    if (event.type === "task/canceled") task.status = "canceled";
    task.events.push(event);
    for (const listener of this.listeners.get(task.id) ?? []) listener(event);
  }

  private ev(
    taskId: string,
    type: MulticaTaskEvent["type"],
    data: Record<string, unknown> = {},
  ): MulticaTaskEvent {
    return { id: createId("ev"), taskId, type, time: now(), data };
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.token}`,
        "X-Workspace-ID": this.workspaceId,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`official ${method} ${path} ${response.status}: ${text}`);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}

function title(runtime: string): string {
  return runtime.charAt(0).toUpperCase() + runtime.slice(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
