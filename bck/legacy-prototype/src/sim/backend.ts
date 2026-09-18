import { NATIVE_DSH_PROFILE, PLATFORM_DSH_PROFILE, RUNTIME_MATRIX } from "../plugin/capabilities.ts";
import { RecursionGuardError } from "../plugin/errors.ts";
import { createId, now } from "../plugin/ids.ts";
import type {
  EnvironmentKind,
  MulticaAgentRef,
  MulticaClient,
  MulticaSessionRef,
  MulticaTask,
  MulticaTaskEvent,
  RuntimeKind,
  SubmitTaskInput,
  SubmitTaskResult,
  Unsubscribe,
} from "../plugin/types.ts";
import { dialectFor, liveStatus, streamDeepseek, type LiveStatus } from "./deepseek.ts";
import {
  canSpawnCli,
  executorFor,
  resolveBin,
  runCliTurn,
  type ExecutorKind,
} from "./cli-runner.ts";

export interface SimOptions {
  delayMs?: number;
  dropFirstAck?: boolean;
  clock?: () => number;
  /** When true, Codex/Claude spawn real CLIs; DSH/Pi call DeepSeek HTTP. */
  live?: boolean;
}

interface RuntimeRow {
  id: string;
  runtime: RuntimeKind;
  machineId: string;
  environment: EnvironmentKind;
  online: boolean;
  nativeProfile?: string;
}

export class SimulatedMultica implements MulticaClient {
  readonly transport = "memory" as const;
  delayMs: number;
  live: boolean;
  ackDropArmed = false;
  lastSubmit: SubmitTaskInput | undefined;
  private readonly clock: () => number;
  private readonly tasks = new Map<string, MulticaTask>();
  private readonly byRequest = new Map<string, string>();
  private readonly listeners = new Map<string, Set<(event: MulticaTaskEvent) => void>>();
  private readonly agents = new Map<string, MulticaAgentRef>();
  private readonly sessions = new Map<string, MulticaSessionRef>();
  private readonly abortors = new Map<string, AbortController>();
  readonly runtimes: RuntimeRow[] = [
    {
      id: "rt_codex_cloud",
      runtime: "codex",
      machineId: "cube-personal",
      environment: "personal-persistent",
      online: true,
    },
    {
      id: "rt_claude_cloud",
      runtime: "claude-code",
      machineId: "cube-project",
      environment: "project-shared",
      online: true,
    },
    {
      id: "rt_pi_cloud",
      runtime: "pi",
      machineId: "cube-personal",
      environment: "personal-persistent",
      online: true,
    },
    {
      id: "rt_dsh_native",
      runtime: "dsh",
      machineId: "cube-personal",
      environment: "personal-persistent",
      online: true,
      nativeProfile: NATIVE_DSH_PROFILE,
    },
    {
      id: "rt_dsh_platform",
      runtime: "dsh",
      machineId: "cube-personal",
      environment: "personal-persistent",
      online: true,
      nativeProfile: PLATFORM_DSH_PROFILE,
    },
    {
      id: "rt_codex_local",
      runtime: "codex",
      machineId: "laptop-chen",
      environment: "local-machine",
      online: true,
    },
  ];

  constructor(options: SimOptions = {}) {
    this.delayMs = options.delayMs ?? 0;
    this.live = options.live ?? false;
    this.ackDropArmed = options.dropFirstAck ?? false;
    this.clock = options.clock ?? now;
  }

  snapshotLive(): LiveStatus & {
    executors: Record<string, ExecutorKind>;
    binaries: { codex?: string; claude?: string };
  } {
    const status = liveStatus();
    return {
      ...status,
      live: this.live && status.live,
      executors: {
        dsh: executorFor("dsh"),
        codex: executorFor("codex"),
        "claude-code": executorFor("claude-code"),
        pi: executorFor("pi"),
      },
      binaries: {
        codex: resolveBin("codex"),
        claude: resolveBin("claude"),
      },
    };
  }

  async listRuntimes() {
    return this.runtimes.map((row) => ({ ...row }));
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
    const existing = this.agents.get(key);
    if (existing) return existing;
    const created: MulticaAgentRef = {
      id: createId("mag"),
      runtime: input.runtime,
      machineId: input.machineId,
    };
    this.agents.set(key, created);
    return created;
  }

  async ensureSession(input: {
    agentId: string;
    dshSessionId: string;
    segmentId: string;
    resumeCliSessionId?: string;
  }): Promise<MulticaSessionRef> {
    const key = `${input.agentId}:${input.segmentId}`;
    const existing = this.sessions.get(key);
    if (existing) return existing;
    const created: MulticaSessionRef = {
      id: createId("msess"),
      agentId: input.agentId,
      cliSessionId: input.resumeCliSessionId ?? createId("cli"),
    };
    this.sessions.set(key, created);
    return created;
  }

  async submitTask(input: SubmitTaskInput): Promise<SubmitTaskResult> {
    if (input.runtime === "dsh" && input.nativeProfile !== NATIVE_DSH_PROFILE) {
      throw new RecursionGuardError(input.nativeProfile ?? PLATFORM_DSH_PROFILE);
    }
    this.lastSubmit = input;
    const existingId = this.byRequest.get(input.clientRequestId);
    if (existingId) {
      const existing = this.tasks.get(existingId);
      if (this.ackDropArmed) {
        this.ackDropArmed = false;
        return { status: "unknown", clientRequestId: input.clientRequestId };
      }
      return {
        status: "accepted",
        taskId: existingId,
        sessionId: existing?.sessionId ?? input.sessionId ?? existingId,
      };
    }

    const taskId = createId("task");
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
    if (this.live) {
      void this.runLive(task, input);
    } else {
      this.pump(task, this.buildEvents(taskId, input));
    }

    if (this.ackDropArmed) {
      this.ackDropArmed = false;
      return { status: "unknown", clientRequestId: input.clientRequestId };
    }
    return { status: "accepted", taskId, sessionId: input.sessionId ?? task.id };
  }

  async cancelTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;
    if (task.status === "completed" || task.status === "failed" || task.status === "canceled") {
      return;
    }
    task.status = "canceled";
    this.abortors.get(taskId)?.abort();
    this.abortors.delete(taskId);
    this.emit(task, {
      id: createId("ev"),
      taskId,
      type: "task/canceled",
      time: this.clock(),
      data: {},
    });
  }

  async getTask(taskId: string): Promise<MulticaTask | undefined> {
    const task = this.tasks.get(taskId);
    return task ? { ...task, events: [...task.events] } : undefined;
  }

  async getTaskByClientRequestId(
    clientRequestId: string,
  ): Promise<MulticaTask | undefined> {
    const id = this.byRequest.get(clientRequestId);
    return id ? this.getTask(id) : undefined;
  }

  subscribe(
    taskId: string,
    handler: (event: MulticaTaskEvent) => void,
  ): Unsubscribe {
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

  private async runLive(task: MulticaTask, input: SubmitTaskInput): Promise<void> {
    const controller = new AbortController();
    this.abortors.set(task.id, controller);
    for (const event of this.buildPreamble(task.id, input)) {
      if (isCanceled(task)) return;
      this.note(task, event);
    }
    try {
      const executor = executorFor(input.runtime);
      const result = canSpawnCli(input.runtime)
        ? await runCliTurn(input, {
            signal: controller.signal,
            onDelta: (text) => {
              if (isCanceled(task)) return;
              this.note(task, this.ev(task.id, "text/delta", { text }));
            },
            onTool: (name, args) => {
              if (isCanceled(task)) return;
              this.note(task, this.ev(task.id, "tool/call", { name, args }));
            },
            onToolResult: (name, preview) => {
              if (isCanceled(task)) return;
              this.note(task, this.ev(task.id, "tool/result", { name, preview }));
            },
          })
        : await streamDeepseek(input, {
            signal: controller.signal,
            onDelta: (text) => {
              if (isCanceled(task)) return;
              this.note(task, this.ev(task.id, "text/delta", { text }));
            },
          });
      if (isCanceled(task)) return;
      this.note(
        task,
        this.ev(task.id, "text/committed", {
          text: result.text || "(empty model reply)",
          dialect: "dialect" in result ? result.dialect : undefined,
          model: result.model,
          executor: "executor" in result ? result.executor : executor,
        }),
      );
      this.note(
        task,
        this.ev(task.id, "usage", {
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          runtime: input.runtime,
          model: result.model,
          provider: "deepseek",
          executor: "executor" in result ? result.executor : executor,
        }),
      );
      task.status = "completed";
      this.note(task, this.ev(task.id, "task/completed", { live: true, executor }));
    } catch (error) {
      if (isCanceled(task) || controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      task.status = "failed";
      this.note(task, this.ev(task.id, "task/failed", { message, live: true }));
    } finally {
      this.abortors.delete(task.id);
    }
  }

  private pump(task: MulticaTask, events: MulticaTaskEvent[]): void {
    const run = async () => {
      for (const event of events) {
        if (isCanceled(task)) return;
        if (this.delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.delayMs));
        }
        if (isCanceled(task)) return;
        this.note(task, event);
      }
    };
    void run();
  }

  private note(task: MulticaTask, event: MulticaTaskEvent): void {
    if (event.type === "task/started") task.status = "running";
    if (event.type === "task/completed") task.status = "completed";
    if (event.type === "task/failed") task.status = "failed";
    this.emit(task, event);
  }

  private emit(task: MulticaTask, event: MulticaTaskEvent): void {
    task.events.push(event);
    for (const listener of this.listeners.get(task.id) ?? []) listener(event);
  }

  private ev(
    taskId: string,
    type: MulticaTaskEvent["type"],
    data: Record<string, unknown> = {},
  ): MulticaTaskEvent {
    return { id: createId("ev"), taskId, type, time: this.clock(), data };
  }

  private buildPreamble(taskId: string, input: SubmitTaskInput): MulticaTaskEvent[] {
    const matrix = RUNTIME_MATRIX[input.runtime];
    const events: MulticaTaskEvent[] = [
      this.ev(taskId, "task/accepted", { clientRequestId: input.clientRequestId }),
      this.ev(taskId, "task/started", {
        cwd: input.cwd,
        cli: matrix.cli,
        live: this.live,
        dialect: dialectFor(input.runtime),
        model: liveStatus().model,
        executor: executorFor(input.runtime),
      }),
      this.ev(taskId, "cli/session", { cliSessionId: input.resumeCliSessionId }),
      this.ev(taskId, "skill/injected", {
        path: matrix.skillPath,
        skills: input.skills.map((skill) => skill.name),
      }),
    ];
    if (matrix.mcpSupported) {
      events.push(
        this.ev(taskId, "mcp/applied", { servers: input.mcp.map((server) => server.name) }),
      );
    } else {
      events.push(
        this.ev(taskId, "mcp/skipped", {
          reason: "runtime does not read Multica-managed MCP configuration",
          dropped: input.mcp.map((server) => server.name),
        }),
      );
    }
    return events;
  }

  private buildEvents(taskId: string, input: SubmitTaskInput): MulticaTaskEvent[] {
    const events = this.buildPreamble(taskId, input);
    const prompt = input.prompt.toLowerCase();
    if (input.runtime === "codex" || input.runtime === "claude-code") {
      events.push(
        this.ev(taskId, "text/delta", { text: runtimePrefix(input.runtime) }),
        this.ev(taskId, "tool/call", {
          name: prompt.includes("jira") ? "jira.search" : "ripgrep",
          args: prompt.includes("jira")
            ? { jql: "assignee = currentUser() AND status != Done" }
            : { pattern: "TODO", path: input.cwd },
        }),
        this.ev(taskId, "tool/result", {
          name: prompt.includes("jira") ? "jira.search" : "ripgrep",
          preview: prompt.includes("jira")
            ? "AUTH-214 token refresh · PAY-88 invoice PDF · OPS-12 sandbox quota"
            : "src/plugin/factory.ts:88 TODO(bind native profile)",
        }),
        this.ev(taskId, "text/committed", { text: committedText(input) }),
        this.ev(taskId, "cli/unknown", {
          vendor: input.runtime,
          frame: "tool_progress",
          payload: { percent: 100, note: "vendor frame with no DSH equivalent" },
        }),
      );
    } else if (input.runtime === "pi") {
      events.push(
        this.ev(taskId, "text/delta", { text: "Pi · " }),
        this.ev(taskId, "text/committed", {
          text: `Pi 在 ${input.cwd} 继续。MCP 未注入（该 CLI 不读 Multica MCP）。Skills 已写入 .pi/skills/。\n\n${committedText(input)}`,
        }),
      );
    } else {
      events.push(
        this.ev(taskId, "text/delta", { text: "DSH native loop · " }),
        this.ev(taskId, "text/committed", {
          text: `走独立 Profile \`${NATIVE_DSH_PROFILE}\` 的原生 Agent Loop，没有再次进入 Multica 插件。\n\n${committedText(input)}`,
        }),
      );
    }
    events.push(
      this.ev(taskId, "usage", { inputTokens: 1800, outputTokens: 420, runtime: input.runtime }),
      this.ev(taskId, "task/completed", {}),
    );
    return events;
  }
}

function isCanceled(task: MulticaTask): boolean {
  return task.status === "canceled";
}

function runtimePrefix(runtime: RuntimeKind): string {
  if (runtime === "codex") return "Codex · ";
  if (runtime === "claude-code") return "Claude Code · ";
  if (runtime === "pi") return "Pi · ";
  return "DSH · ";
}

function committedText(input: SubmitTaskInput): string {
  const prompt = input.prompt.trim();
  const handoffNote = input.handoff
    ? `\n\n已接收 handoff（${input.handoff.from} → ${input.handoff.to}）：\n${input.handoff.summary}`
    : "";
  if (/jira|confluence|飞书|资料/i.test(prompt)) {
    return `查到 3 条与当前用户相关的 Jira。AUTH-214 还在做 token 刷新；PAY-88 卡在发票 PDF；OPS-12 是沙箱配额。\n\n当前 Runtime=${input.runtime}，cwd=${input.cwd}。同一条 DSH Session 可以切到 Codex / Claude Code 继续改代码；CLI 内部会话不会跟着走，需要新的执行段。${handoffNote}`;
  }
  if (/handoff|继续/i.test(prompt) || input.handoff) {
    return `接着上一跳继续。${handoffNote}\n\n当前 Runtime=${input.runtime}，cwd=${input.cwd}。`;
  }
  if (/改|code|实现|plugin|工厂/i.test(prompt)) {
    return `在 ${input.cwd} 打开工作区。建议先把 Recursion Guard 做成工厂入口检查，再接任务提交的 clientRequestId 对账。测试：两个 Session 并行选不同 Runtime，全局 Factory 不得被改写。${handoffNote}`;
  }
  return `已在 ${input.runtime} @ ${input.cwd} 处理：\n${prompt}${handoffNote}`;
}
