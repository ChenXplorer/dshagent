import { apply, MiniCordis, LOOP_ROW_ID, name as PLUGIN_NAME } from "./apply.ts";
import { NATIVE_DSH_PROFILE } from "./capabilities.ts";
import { RecursionGuardError, SwitchBlockedError } from "./errors.ts";
import type { MulticaRuntimeFactory } from "./factory.ts";
import { createId, now } from "./ids.ts";
import { BindingStore } from "./mapping.ts";
import type {
  AgentHandle,
  EnvironmentKind,
  MulticaClient,
  PluginCatalog,
  RuntimeKind,
  SessionSelection,
  TraceEntry,
} from "./types.ts";

export const DEFAULT_CATALOG: PluginCatalog = {
  skills: [
    { id: "sk_jira", name: "jira", version: "1.4.0" },
    { id: "sk_confluence", name: "confluence", version: "0.9.2" },
    { id: "sk_lark", name: "feishu", version: "2.1.0" },
  ],
  mcp: [
    { id: "mcp_jira", name: "jira", transport: "http" },
    { id: "mcp_git", name: "git", transport: "stdio" },
  ],
};

export interface HostSession {
  id: string;
  title: string;
  createdAt: number;
  selection: SessionSelection;
}

export interface PluginMountState {
  plugin: string;
  loopRow: string;
  loopDisabled: boolean;
  factoryMounted: boolean;
  transport: "memory" | "http";
}

export interface LiveModelState {
  live: boolean;
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
}

export class WorkbenchHost {
  readonly client: MulticaClient;
  readonly cordis: MiniCordis;
  readonly bindings: BindingStore;
  readonly factory: MulticaRuntimeFactory;
  readonly handles = new Map<string, AgentHandle>();
  readonly sessions: HostSession[] = [];
  readonly traces: TraceEntry[] = [];
  liveModel: LiveModelState = { live: false };
  activeId: string | null = null;
  version = 0;
  private listeners = new Set<() => void>();

  constructor(client: MulticaClient) {
    this.client = client;
    this.cordis = new MiniCordis();
    this.bindings = new BindingStore();
    this.factory = apply(this.cordis, {
      client,
      catalog: DEFAULT_CATALOG,
      bindings: this.bindings,
      hooks: {
        onTrace: (entry) => {
          this.traces.unshift(entry);
          if (this.traces.length > 400) this.traces.length = 400;
          this.emit();
        },
        onSessionEvent: () => this.emit(),
        onStatus: () => this.emit(),
      },
    });
  }

  mountState(): PluginMountState {
    return {
      plugin: PLUGIN_NAME,
      loopRow: LOOP_ROW_ID,
      loopDisabled: true,
      factoryMounted: this.cordis.agents.factory === this.factory,
      transport: this.client.transport ?? "memory",
    };
  }

  async probe(): Promise<void> {
    if (!this.client.health) return;
    try {
      const health = await this.client.health();
      this.liveModel = {
        live: Boolean(health.live),
        provider: health.provider,
        model: health.model,
        dialects: health.dialects,
        executors: health.executors,
        binaries: health.binaries,
        daemon: health.daemon,
        plane: health.plane,
      };
      this.emit();
    } catch {
      this.liveModel = { live: false };
      this.emit();
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  async createSession(title?: string): Promise<HostSession> {
    const id = createId("dsh");
    const selection: SessionSelection = {
      runtime: "codex",
      environment: "personal-persistent",
      cwd: "/work/auth-service",
      machineId: "cube-personal",
    };
    const handle = await this.factory.createAgent({
      sessionId: id,
      meta: { cwd: selection.cwd },
    });
    await (handle.agent as import("./agent.ts").MulticaAgent).select(selection);
    this.handles.set(id, handle);
    const row: HostSession = {
      id,
      title: title ?? `会话 ${this.sessions.length + 1}`,
      createdAt: now(),
      selection,
    };
    this.sessions.unshift(row);
    this.activeId = id;
    this.emit();
    return row;
  }

  active(): HostSession | undefined {
    return this.sessions.find((session) => session.id === this.activeId);
  }

  setActive(id: string): void {
    this.activeId = id;
    this.emit();
  }

  agent() {
    if (!this.activeId) return undefined;
    return this.factory.agentOf(this.activeId);
  }

  async send(text: string): Promise<void> {
    const agent = this.agent();
    if (!agent) throw new Error("No active session");
    agent.followup({ id: createId("msg"), text, source: "workbench" });
    this.emit();
  }

  cancel(): void {
    this.agent()?.cancel("user");
    this.emit();
  }

  async switchSelection(patch: Partial<SessionSelection>): Promise<void> {
    const row = this.active();
    const agent = this.agent();
    if (!row || !agent) throw new Error("No active session");
    const next: SessionSelection = { ...row.selection, ...patch };
    if (next.runtime === "dsh") {
      next.nativeProfile = patch.nativeProfile ?? NATIVE_DSH_PROFILE;
    } else {
      next.nativeProfile = undefined;
    }
    if (next.environment === "local-machine") next.machineId = "laptop-chen";
    if (next.environment === "project-shared") next.machineId = "cube-project";
    if (
      next.environment === "personal-persistent" ||
      next.environment === "personal-ephemeral"
    ) {
      next.machineId = "cube-personal";
    }
    try {
      await agent.select(next);
      row.selection = next;
      this.emit();
    } catch (error) {
      if (error instanceof RecursionGuardError || error instanceof SwitchBlockedError) {
        this.traces.unshift({
          at: now(),
          layer: "plugin",
          kind: error.name,
          detail: error.message,
        });
        this.emit();
      }
      throw error;
    }
  }

  dropNextAck(): void {
    const result = this.client.dropNextAck?.();
    this.traces.unshift({
      at: now(),
      layer: "plugin",
      kind: "reconcile-arm",
      detail: "下一次 submit 将返回 unknown，走 clientRequestId 对账",
    });
    this.emit();
    void result;
  }
}

export const RUNTIME_OPTIONS: { id: RuntimeKind; label: string; hint: string }[] = [
  { id: "codex", label: "Codex", hint: "codex CLI · MCP ✓" },
  { id: "claude-code", label: "Claude Code", hint: "claude CLI · MCP ✓" },
  { id: "pi", label: "Pi", hint: "pi CLI · MCP ✕" },
  { id: "dsh", label: "DSH", hint: "native profile only" },
];

export const ENV_OPTIONS: {
  id: EnvironmentKind;
  label: string;
  hint: string;
}[] = [
  { id: "personal-persistent", label: "个人持久沙箱", hint: "空闲暂停，状态可恢复" },
  { id: "personal-ephemeral", label: "个人临时沙箱", hint: "任务结束后回收" },
  { id: "project-shared", label: "项目共享沙箱", hint: "成员共用目录，任务串行" },
  { id: "local-machine", label: "我的电脑", hint: "需要本机 Daemon + CLI" },
];
