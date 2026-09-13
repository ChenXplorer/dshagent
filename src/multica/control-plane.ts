import { NATIVE_DSH_PROFILE, PLATFORM_DSH_PROFILE, RUNTIME_MATRIX } from "../plugin/capabilities.ts";
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
import { dialectFor, liveStatus } from "../sim/deepseek.ts";

export interface DaemonTool {
  runtime: RuntimeKind;
  cli: string;
  executor: string;
}

export interface DaemonHello {
  machineId: string;
  tools: DaemonTool[];
}

export interface ClaimedWork {
  taskId: string;
  input: SubmitTaskInput;
}

interface Waiter {
  machineId: string;
  resolve: (work: ClaimedWork | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Machine {
  machineId: string;
  tools: DaemonTool[];
  lastHeartbeat: number;
  online: boolean;
}

const HEARTBEAT_GRACE_MS = 45_000;

const CATALOG: Array<{
  id: string;
  runtime: RuntimeKind;
  machineId: string;
  environment: EnvironmentKind;
  nativeProfile?: string;
}> = [
  {
    id: "rt_codex_cloud",
    runtime: "codex",
    machineId: "cube-personal",
    environment: "personal-persistent",
  },
  {
    id: "rt_claude_cloud",
    runtime: "claude-code",
    machineId: "cube-project",
    environment: "project-shared",
  },
  {
    id: "rt_pi_cloud",
    runtime: "pi",
    machineId: "cube-personal",
    environment: "personal-persistent",
  },
  {
    id: "rt_dsh_native",
    runtime: "dsh",
    machineId: "cube-personal",
    environment: "personal-persistent",
    nativeProfile: NATIVE_DSH_PROFILE,
  },
  {
    id: "rt_dsh_platform",
    runtime: "dsh",
    machineId: "cube-personal",
    environment: "personal-persistent",
    nativeProfile: PLATFORM_DSH_PROFILE,
  },
  {
    id: "rt_codex_local",
    runtime: "codex",
    machineId: "laptop-chen",
    environment: "local-machine",
  },
];

/**
 * Multica Server control plane.
 * Queues work and fans events out. Never spawns a CLI — that is the daemon.
 */
export class MulticaControlPlane {
  ackDropArmed = false;
  lastSubmit: SubmitTaskInput | undefined;
  private readonly tasks = new Map<string, MulticaTask>();
  private readonly byRequest = new Map<string, string>();
  private readonly listeners = new Map<string, Set<(event: MulticaTaskEvent) => void>>();
  private readonly agents = new Map<string, MulticaAgentRef>();
  private readonly sessions = new Map<string, MulticaSessionRef>();
  private readonly machines = new Map<string, Machine>();
  private readonly queue: ClaimedWork[] = [];
  private waiters: Waiter[] = [];
  private readonly canceled = new Set<string>();

  snapshotLive() {
    this.refreshOnline();
    const status = liveStatus();
    const daemons = [...this.machines.values()].map((machine) => ({
      machineId: machine.machineId,
      online: machine.online,
      tools: machine.tools.map((tool) => tool.runtime),
      lastHeartbeat: machine.lastHeartbeat,
      ageMs: Date.now() - machine.lastHeartbeat,
    }));
    const online = daemons.filter((row) => row.online);
    const executors: Record<string, string> = {
      dsh: "queued",
      codex: "queued",
      "claude-code": "queued",
      pi: "queued",
    };
    for (const machine of this.machines.values()) {
      if (!machine.online) continue;
      for (const tool of machine.tools) executors[tool.runtime] = tool.executor;
    }
    return {
      ...status,
      live: status.live && online.length > 0,
      plane: "server" as const,
      executors,
      binaries: {
        codex: online.some((row) => row.tools.includes("codex")),
        claude: online.some((row) => row.tools.includes("claude-code")),
      },
      daemon: {
        online: online.length > 0,
        count: online.length,
        machines: daemons,
      },
    };
  }

  async listRuntimes() {
    this.refreshOnline();
    return CATALOG.map((row) => {
      const machine = this.machines.get(row.machineId);
      const hasTool = Boolean(
        machine?.online && machine.tools.some((tool) => tool.runtime === row.runtime),
      );
      return { ...row, online: hasTool };
    });
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
    this.note(
      task,
      this.ev(taskId, "task/accepted", { clientRequestId: input.clientRequestId }),
    );
    this.enqueue({ taskId, input });

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
    this.canceled.add(taskId);
    this.note(task, this.ev(taskId, "task/canceled", {}));
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

  registerDaemon(hello: DaemonHello): { ok: true; machineId: string } {
    this.machines.set(hello.machineId, {
      machineId: hello.machineId,
      tools: hello.tools,
      lastHeartbeat: Date.now(),
      online: true,
    });
    return { ok: true, machineId: hello.machineId };
  }

  heartbeatDaemon(machineId: string): { ok: boolean; canceledTaskIds: string[] } {
    const machine = this.machines.get(machineId);
    if (!machine) return { ok: false, canceledTaskIds: [] };
    machine.lastHeartbeat = Date.now();
    machine.online = true;
    const canceledTaskIds = [...this.canceled];
    return { ok: true, canceledTaskIds };
  }

  async claimTask(machineId: string, waitMs: number): Promise<ClaimedWork | null> {
    const ready = this.takeQueued(machineId);
    if (ready) return ready;
    return new Promise((resolve) => {
      const waiter: Waiter = {
        machineId,
        resolve: (work) => resolve(work),
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((row) => row !== waiter);
          resolve(null);
        }, waitMs),
      };
      this.waiters.push(waiter);
    });
  }

  ingestDaemonEvent(taskId: string, event: MulticaTaskEvent): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    const stamped: MulticaTaskEvent = {
      ...event,
      id: event.id || createId("ev"),
      taskId,
      time: event.time || now(),
    };
    this.note(task, stamped);
    if (stamped.type === "task/canceled") this.canceled.add(taskId);
    if (
      stamped.type === "task/completed" ||
      stamped.type === "task/failed" ||
      stamped.type === "task/canceled"
    ) {
      this.canceled.delete(taskId);
    }
  }

  private enqueue(work: ClaimedWork): void {
    const waiter = this.waiters.find((row) => this.canRun(row.machineId, work.input));
    if (waiter) {
      this.waiters = this.waiters.filter((row) => row !== waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(work);
      return;
    }
    this.queue.push(work);
  }

  private takeQueued(machineId: string): ClaimedWork | null {
    const index = this.queue.findIndex((work) => this.canRun(machineId, work.input));
    if (index < 0) return null;
    const [work] = this.queue.splice(index, 1);
    return work ?? null;
  }

  private canRun(machineId: string, input: SubmitTaskInput): boolean {
    this.refreshOnline();
    const machine = this.machines.get(machineId);
    if (!machine?.online) return false;
    if (input.machineId && input.machineId !== machineId) {
      // Cloud daemon may also cover the project machine id used in the catalog.
      if (!(machineId === "cube-personal" && input.machineId === "cube-project")) {
        return false;
      }
    }
    return machine.tools.some((tool) => tool.runtime === input.runtime);
  }

  private refreshOnline(): void {
    const cutoff = Date.now() - HEARTBEAT_GRACE_MS;
    for (const machine of this.machines.values()) {
      machine.online = machine.lastHeartbeat >= cutoff;
    }
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
}

export function preambleEvents(taskId: string, input: SubmitTaskInput): MulticaTaskEvent[] {
  const matrix = RUNTIME_MATRIX[input.runtime];
  const ev = (
    type: MulticaTaskEvent["type"],
    data: Record<string, unknown> = {},
  ): MulticaTaskEvent => ({
    id: createId("ev"),
    taskId,
    type,
    time: now(),
    data,
  });
  const events: MulticaTaskEvent[] = [
    ev("task/started", {
      cwd: input.cwd,
      cli: matrix.cli,
      dialect: dialectFor(input.runtime),
      model: liveStatus().model,
      plane: "daemon",
    }),
    ev("cli/session", { cliSessionId: input.resumeCliSessionId }),
    ev("skill/injected", {
      path: matrix.skillPath,
      skills: input.skills.map((skill) => skill.name),
    }),
  ];
  if (matrix.mcpSupported) {
    events.push(ev("mcp/applied", { servers: input.mcp.map((server) => server.name) }));
  } else {
    events.push(
      ev("mcp/skipped", {
        reason: "runtime does not read Multica-managed MCP configuration",
        dropped: input.mcp.map((server) => server.name),
      }),
    );
  }
  return events;
}
