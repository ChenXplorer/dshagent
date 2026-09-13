import { createId } from "../plugin/ids.ts";
import type { MulticaTaskEvent, RuntimeKind, SubmitTaskInput } from "../plugin/types.ts";
import {
  canSpawnCli,
  executorFor,
  resolveBin,
  runCliTurn,
} from "../sim/cli-runner.ts";
import { streamDeepseek } from "../sim/deepseek.ts";
import {
  preambleEvents,
  type ClaimedWork,
  type DaemonHello,
  type DaemonTool,
} from "./control-plane.ts";

export interface DaemonOptions {
  serverUrl: string;
  machineId: string;
  fetch?: typeof fetch;
  pollMs?: number;
  heartbeatMs?: number;
}

export function detectTools(): DaemonTool[] {
  const tools: DaemonTool[] = [];
  if (resolveBin("codex")) {
    tools.push({ runtime: "codex", cli: "codex", executor: "codex-cli" });
  }
  if (resolveBin("claude")) {
    tools.push({ runtime: "claude-code", cli: "claude", executor: "claude-cli" });
  }
  tools.push({ runtime: "dsh", cli: "dsh", executor: "deepseek-http" });
  tools.push({ runtime: "pi", cli: "pi", executor: "deepseek-http" });
  return tools;
}

/**
 * Multica Daemon. Separate process from the server.
 * Registers local CLIs, claims queued tasks, spawns the tool, streams events back.
 */
export class MulticaDaemon {
  readonly machineId: string;
  private readonly serverUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly pollMs: number;
  private readonly heartbeatMs: number;
  private stopped = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private readonly running = new Map<string, AbortController>();

  constructor(options: DaemonOptions) {
    this.serverUrl = options.serverUrl.replace(/\/$/, "");
    this.machineId = options.machineId;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.pollMs = options.pollMs ?? 8000;
    this.heartbeatMs = options.heartbeatMs ?? 15_000;
  }

  hello(): DaemonHello {
    return { machineId: this.machineId, tools: detectTools() };
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.post("/internal/register", this.hello());
    this.heartbeatTimer = setInterval(() => {
      void this.beat();
    }, this.heartbeatMs);
    void this.beat();
    void this.loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const controller of this.running.values()) controller.abort();
    this.running.clear();
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        const claimed = await this.claim();
        if (claimed) void this.execute(claimed);
      } catch {
        await sleep(1000);
      }
    }
  }

  private async claim(): Promise<ClaimedWork | null> {
    const url = `${this.serverUrl}/internal/claim?machineId=${encodeURIComponent(this.machineId)}&waitMs=${this.pollMs}`;
    const response = await this.fetchImpl(url);
    if (!response.ok) throw new Error(`claim ${response.status}`);
    const body = (await response.json()) as { task: ClaimedWork | null };
    return body.task;
  }

  private async beat(): Promise<void> {
    try {
      const body = (await this.post("/internal/heartbeat", {
        machineId: this.machineId,
      })) as { canceledTaskIds?: string[] };
      for (const taskId of body.canceledTaskIds ?? []) {
        this.running.get(taskId)?.abort();
      }
    } catch {
      /* server may be reloading; next tick retries */
    }
  }

  private async execute(work: ClaimedWork): Promise<void> {
    const controller = new AbortController();
    this.running.set(work.taskId, controller);
    const input = work.input;
    try {
      for (const event of preambleEvents(work.taskId, input)) {
        if (controller.signal.aborted) return;
        await this.emit(work.taskId, event);
      }
      const executor = executorFor(input.runtime);
      const result = canSpawnCli(input.runtime)
        ? await runCliTurn(input, {
            signal: controller.signal,
            onDelta: (text) => {
              void this.emit(work.taskId, this.ev(work.taskId, "text/delta", { text }));
            },
            onTool: (name, args) => {
              void this.emit(work.taskId, this.ev(work.taskId, "tool/call", { name, args }));
            },
            onToolResult: (name, preview) => {
              void this.emit(work.taskId, this.ev(work.taskId, "tool/result", { name, preview }));
            },
          })
        : await streamDeepseek(input, {
            signal: controller.signal,
            onDelta: (text) => {
              void this.emit(work.taskId, this.ev(work.taskId, "text/delta", { text }));
            },
          });
      if (controller.signal.aborted) return;
      await this.emit(
        work.taskId,
        this.ev(work.taskId, "text/committed", {
          text: result.text || "(empty model reply)",
          model: result.model,
          executor: "executor" in result ? result.executor : executor,
          plane: "daemon",
        }),
      );
      await this.emit(
        work.taskId,
        this.ev(work.taskId, "usage", {
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          runtime: input.runtime,
          model: result.model,
          provider: "deepseek",
          executor: "executor" in result ? result.executor : executor,
        }),
      );
      await this.emit(work.taskId, this.ev(work.taskId, "task/completed", { plane: "daemon" }));
    } catch (error) {
      if (controller.signal.aborted) {
        await this.emit(work.taskId, this.ev(work.taskId, "task/canceled", { plane: "daemon" }));
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      await this.emit(work.taskId, this.ev(work.taskId, "task/failed", { message, plane: "daemon" }));
    } finally {
      this.running.delete(work.taskId);
    }
  }

  private ev(
    taskId: string,
    type: MulticaTaskEvent["type"],
    data: Record<string, unknown>,
  ): MulticaTaskEvent {
    return { id: createId("ev"), taskId, type, time: Date.now(), data };
  }

  private async emit(taskId: string, event: MulticaTaskEvent): Promise<void> {
    await this.post("/internal/events", { taskId, event });
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const response = await this.fetchImpl(`${this.serverUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${path} ${response.status}`);
    return response.json();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type { RuntimeKind, SubmitTaskInput };
