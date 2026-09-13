import { emitAgentEvent } from "@deepseek-ai/dsh-agent";
import { createAssistantMessage } from "@deepseek-ai/dsh-llm";
import { createScope } from "@deepseek-ai/dsh-scope";
import { BindingStore } from "./mapping.ts";
import { RecursionGuardError } from "./errors.ts";
import { NATIVE_DSH_PROFILE, PLATFORM_DSH_PROFILE } from "./capabilities.ts";
import { composeTaskPrompt } from "./events.ts";
import { createId } from "./ids.ts";
import { planCapabilitySync } from "./skills.ts";
import { submitWithReconcile } from "./reconcile.ts";
import type {
  AgentCancelCause,
  AgentHandle,
  AgentOptions,
  AgentStatus,
  CancelOptions,
  InboxTarget,
  MulticaClient,
  RuntimeKind,
  UserMessage as PluginUserMessage,
} from "./types.ts";

type AnyCtx = {
  sessions: {
    prepare: (
      id: string,
      options?: {
        seed?: unknown;
        meta?: { cwd?: string; agentPreset?: string };
        inheritedEventCount?: number;
      },
    ) => OfficialSession;
    enter: (session: OfficialSession) => () => void;
    announce: (session: OfficialSession) => void;
  };
  agents: {
    enter: (agent: unknown, owner?: unknown) => () => void;
    announce: (agent: unknown) => void;
    setFactory: (factory: unknown) => () => void;
  };
  effect: (fn: () => (() => void) | void, label?: string) => () => void;
  fiber?: { assertActive?: () => void };
  inject?: (deps: string[], callback: (scoped: AnyCtx) => void) => () => void;
  get?: (name: string) =>
    | {
        create?: (
          header: unknown,
          options?: { inheritedEventCount?: number; signal?: AbortSignal },
        ) => Promise<{ close?: () => Promise<void> }>;
        tapIndex?: (transform: (html: string) => string) => () => void;
      }
    | undefined;
};

interface OfficialSession {
  id: string;
  header: { cwd?: string };
  events: readonly unknown[];
  inheritedEventCount?: number;
  append: (type: string, data: unknown, intent?: { surfaceOp?: "append" | { op: "replace"; startSeq: number; endSeq: number }; sourceEventSeqs?: number[] }) => { seq: number };
}

interface OfficialUserMessage {
  id: string;
  role: "user";
  content: Array<{ type: string; text?: string }>;
  source: { kind: string };
  text?: string;
}

export interface NativePluginConfig {
  runtime?: RuntimeKind;
  machineId?: string;
  environment?: "personal-persistent";
  client?: MulticaClient;
  catalog?: {
    skills: Array<{ id: string; name: string; version: string }>;
    mcp: Array<{ id: string; name: string; transport: string }>;
  };
}

/**
 * Official DSH AgentFactory. createAgent(ownerCtx, options) / resume(ownerCtx, options)
 * match @deepseek-ai/dsh-agent so this can replace dsh-agent-loop.
 */
export class DshNativeFactory {
  constructor(
    private readonly pluginCtx: AnyCtx,
    private readonly client: MulticaClient,
    private readonly config: NativePluginConfig = {},
  ) {}

  async createAgent(ownerCtx: AnyCtx, options: { sessionId: string; agentOptions?: AgentOptions; meta?: { cwd?: string; agentPreset?: string }; seed?: unknown; inheritedEventCount?: number; parentAgent?: unknown; setup?: (ctx: unknown, agent: unknown) => Promise<{ commit?: () => void } | void> | void; signal?: AbortSignal }): Promise<AgentHandle> {
    ownerCtx.fiber?.assertActive?.();
    const cwd = options.meta?.cwd && options.meta.cwd.startsWith("/") ? options.meta.cwd : process.cwd();
    const session = this.pluginCtx.sessions.prepare(options.sessionId, {
      ...options.seed === undefined ? {} : { seed: options.seed },
      ...options.inheritedEventCount === undefined ? {} : { inheritedEventCount: options.inheritedEventCount },
      meta: { cwd, ...options.meta },
    });
    const persistence = this.pluginCtx.get?.("sessionPersistence");
    const stored = persistence?.create
      ? await persistence.create(session.header, {
          inheritedEventCount: session.inheritedEventCount,
          ...options.signal === undefined ? {} : { signal: options.signal },
        })
      : undefined;
    const agent = new DshNativeAgent(
      this.pluginCtx,
      options.sessionId,
      options.agentOptions ?? {},
      session,
      this.client,
      this.config,
    );
    try {
      if (options.setup) {
        const commit = await options.setup(agent.ctx, agent);
        commit?.commit?.();
      }
    } catch (error) {
      await stored?.close?.().catch(() => {});
      await agent.scope.dispose().catch(() => {});
      throw error;
    }
    let detachSession: (() => void) | undefined;
    let detachAgent: (() => void) | undefined;
    const dispose = async () => {
      agent.cancel({ kind: "disposed" } as AgentCancelCause);
      await agent.whenIdle();
      detachAgent?.();
      detachSession?.();
      await stored?.close?.().catch(() => {});
      await agent.scope.dispose();
    };
    detachSession = agent.ctx.sessions.enter(session);
    detachAgent = this.pluginCtx.agents.enter(agent, options.parentAgent);
    agent.ctx.sessions.announce(session);
    this.pluginCtx.agents.announce(agent);
    emitAgentEvent(agent.ctx as never, agent as never, "agent/session-start", { source: "startup" });
    return { agent: agent as never, dispose };
  }

  async resume(ownerCtx: AnyCtx, options: { resumeSessionId: string; agentOptions?: AgentOptions; parentAgent?: unknown; setup?: (ctx: unknown, agent: unknown) => Promise<{ commit?: () => void } | void> | void; signal?: AbortSignal }): Promise<AgentHandle> {
    return this.createAgent(ownerCtx, {
      sessionId: options.resumeSessionId,
      agentOptions: options.agentOptions,
      parentAgent: options.parentAgent,
      setup: options.setup,
      signal: options.signal,
    });
  }
}

class DshNativeAgent {
  readonly id: string;
  readonly options: AgentOptions;
  readonly session: OfficialSession;
  readonly inbox: NativeInbox;
  readonly scope: { ctx: AnyCtx; dispose: () => Promise<void>; rawDispose?: unknown };
  readonly ctx: AnyCtx;
  readonly bindings = new BindingStore();
  status: AgentStatus = "idle";
  private disposed = false;
  private turn = 0;
  private driveChain: Promise<void> = Promise.resolve();
  private idleWaiters: Array<() => void> = [];
  private cancelCause: AgentCancelCause | undefined;
  private activeUnsub: (() => void) | undefined;
  private readonly client: MulticaClient;
  private readonly config: NativePluginConfig;
  private readonly catalog: NonNullable<NativePluginConfig["catalog"]>;

  constructor(
    ownerCtx: AnyCtx,
    id: string,
    options: AgentOptions,
    session: OfficialSession,
    client: MulticaClient,
    config: NativePluginConfig,
  ) {
    this.id = id;
    this.options = options;
    this.session = session;
    this.client = client;
    this.config = config;
    this.catalog = config.catalog ?? { skills: [], mcp: [] };
    this.scope = createScope(ownerCtx as never, this as never) as never;
    this.ctx = this.scope.ctx;
    this.inbox = new NativeInbox((message, kind, turn) => {
      if (kind === "inserted") {
        emitAgentEvent(this.ctx as never, this as never, "agent/inbox/inserted", { message });
      } else if (kind === "discarded") {
        emitAgentEvent(this.ctx as never, this as never, "agent/inbox/discarded", { message });
      } else {
        emitAgentEvent(this.ctx as never, this as never, "agent/inbox/claimed", { message, turn });
      }
    });
    this.bindings.ensure(this.id);
    this.bindings.openSegment(this.id, {
      runtime: config.runtime ?? "codex",
      environment: config.environment ?? "personal-persistent",
      machineId: config.machineId ?? "cube-personal",
      cwd: session.header.cwd ?? process.cwd(),
    });
  }

  send(message: OfficialUserMessage, target: InboxTarget, wakeup: boolean): void {
    this.inbox.append(target, message as never);
    if (wakeup) this.wake();
  }

  followup(message: OfficialUserMessage): void {
    this.send(message, "next-turn", true);
  }

  steer(message: OfficialUserMessage): void {
    this.send(message, "next-step", true);
  }

  inject(message: OfficialUserMessage): void {
    this.send(message, "next-step", false);
  }

  cancel(cause: AgentCancelCause, options?: CancelOptions): void {
    this.cancelCause = cause;
    if (!options?.keepInbox) this.inbox.clear();
    const segment = this.bindings.currentOrNull(this.id);
    if (segment?.currentTaskId) {
      void this.client.cancelTask(segment.currentTaskId);
    }
    this.activeUnsub?.();
    this.activeUnsub = undefined;
  }

  async runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.status !== "idle") throw new Error(`agent "${this.id}" already has active work`);
    const controller = new AbortController();
    return task(controller.signal);
  }

  whenIdle(): Promise<void> {
    if (this.status === "idle") return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private wake(): void {
    if (this.disposed) return;
    if (this.status === "idle") {
      this.status = "running";
      emitAgentEvent(this.ctx as never, this as never, "agent/status", { status: "running" });
    }
    this.driveChain = this.driveChain.then(() => this.drain()).catch((error) => {
      this.session.append("turn/end", {
        turn: this.turn,
        reason: {
          kind: "error",
          error: { message: error instanceof Error ? error.message : String(error), code: "UNKNOWN" },
        },
      });
      this.becomeIdle();
    });
  }

  private async drain(): Promise<void> {
    while (!this.disposed) {
      const claimed = this.inbox.claim("next-turn", this.turn + 1) as OfficialUserMessage[];
      if (claimed.length === 0) break;
      this.cancelCause = undefined;
      await this.runTurn(claimed);
    }
    this.becomeIdle();
  }

  private async runTurn(messages: OfficialUserMessage[]): Promise<void> {
    const selection = this.bindings.current(this.id);
    if (selection.runtime === "dsh" && (selection.nativeProfile ?? PLATFORM_DSH_PROFILE) !== NATIVE_DSH_PROFILE) {
      throw new RecursionGuardError(selection.nativeProfile ?? PLATFORM_DSH_PROFILE);
    }
    this.turn += 1;
    const turn = this.turn;
    this.session.append("turn/start", { turn });
    for (const message of messages) {
      this.session.append("user/message", message, { surfaceOp: "append" });
    }
    this.session.append("step/start", { turn, step: 1 });
    const prompt = composeTaskPrompt(messages.map(messageText).join("\n\n"));
    const capabilities = planCapabilitySync(selection.runtime, this.catalog.skills, this.catalog.mcp);
    const agent = await this.client.ensureAgent({
      runtime: selection.runtime,
      machineId: selection.machineId,
      nativeProfile: selection.nativeProfile,
    });
    const session = await this.client.ensureSession({
      agentId: agent.id,
      dshSessionId: this.id,
      segmentId: selection.id,
      resumeCliSessionId: selection.multicaSessionId,
    });
    this.bindings.bindMultica(this.id, { agentId: agent.id, sessionId: session.id });
    const clientRequestId = createId("req");
    this.bindings.markUnknown(this.id, clientRequestId);
    const accepted = await submitWithReconcile(this.client, {
      clientRequestId,
      agentId: agent.id,
      sessionId: session.id,
      resumeCliSessionId: session.cliSessionId,
      prompt,
      cwd: selection.cwd,
      runtime: selection.runtime,
      machineId: selection.machineId,
      nativeProfile: selection.nativeProfile,
      skills: capabilities.skills,
      mcp: capabilities.mcp,
    });
    this.bindings.bindTask(this.id, accepted.taskId, clientRequestId);
    await this.consume(accepted.taskId, turn);
  }

  private consume(taskId: string, turn: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        this.activeUnsub?.();
        this.activeUnsub = undefined;
        if (error) reject(error);
        else resolve();
      };
      this.activeUnsub = this.client.subscribe(taskId, (event) => {
        try {
          if (event.type === "text/committed") {
            const text = String(event.data["text"] ?? "");
            this.session.append(
              "assistant/message",
              {
                turn,
                step: 1,
                message: createAssistantMessage({
                  content: [{ type: "text", text }],
                  source: {
                    provider: this.options.provider ?? "deepseek-official",
                    model: this.options.model ?? "deepseek-flash",
                  },
                }),
                stream: [],
              },
              { surfaceOp: "append" },
            );
          }
          if (event.type === "task/completed") {
            this.session.append("step/end", { turn, step: 1 });
            this.session.append("turn/end", { turn, reason: { kind: "completed" } });
            this.bindings.setStatus(this.id, "idle");
            finish();
          } else if (event.type === "task/failed") {
            this.session.append("step/end", { turn, step: 1 });
            this.session.append("turn/end", {
              turn,
              reason: {
                kind: "error",
                error: { message: String(event.data["message"] ?? "task failed"), code: "UNKNOWN" },
              },
            });
            finish();
          } else if (event.type === "task/canceled") {
            this.session.append("step/end", { turn, step: 1 });
            this.session.append("turn/end", {
              turn,
              reason: { kind: "aborted", reason: { kind: "user" } },
            });
            finish();
          }
        } catch (error) {
          finish(error);
        }
      });
      if (this.cancelCause) {
        void this.client.cancelTask(taskId).finally(() => finish());
      }
    });
  }

  private becomeIdle(): void {
    this.status = "idle";
    emitAgentEvent(this.ctx as never, this as never, "agent/status", { status: "idle" });
    const waiters = this.idleWaiters.splice(0);
    for (const waiter of waiters) waiter();
  }
}

function messageText(message: OfficialUserMessage | PluginUserMessage): string {
  if ("text" in message && typeof message.text === "string" && message.text) return message.text;
  const content = (message as OfficialUserMessage).content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join("\n");
}

class NativeInbox {
  private readonly lists: Record<InboxTarget, OfficialUserMessage[]> = {
    "next-turn": [],
    "next-step": [],
  };
  constructor(
    private readonly notify: (
      message: OfficialUserMessage,
      kind: "inserted" | "discarded" | "claimed",
      turn?: number,
    ) => void,
  ) {}
  get nextTurn(): readonly OfficialUserMessage[] {
    return this.lists["next-turn"];
  }
  get nextStep(): readonly OfficialUserMessage[] {
    return this.lists["next-step"];
  }
  append(target: InboxTarget, message: OfficialUserMessage): void {
    this.lists[target].push(message);
    this.notify(message, "inserted");
  }
  clear(): void {
    for (const target of ["next-step", "next-turn"] as const) {
      const removed = this.lists[target].splice(0);
      for (const message of removed) this.notify(message, "discarded");
    }
  }
  claim(target: InboxTarget, turn: number): OfficialUserMessage[] {
    const claimed = this.lists["next-step"].splice(0);
    if (target === "next-turn") claimed.push(...this.lists["next-turn"].splice(0, 1));
    for (const message of claimed) this.notify(message, "claimed", turn);
    return claimed;
  }
}

export function applyNative(ctx: AnyCtx, client: MulticaClient, config: NativePluginConfig = {}): DshNativeFactory {
  const factory = new DshNativeFactory(ctx, client, config);
  ctx.effect(() => ctx.agents.setFactory(factory), "dsh-multica-runtime.setFactory()");
  const installOwnsHost = (owner: AnyCtx) => {
    const webServer = owner.get?.("webServer") ?? (owner as { webServer?: { tapIndex?: (transform: (html: string) => string) => () => void } }).webServer;
    if (typeof webServer?.tapIndex !== "function") return;
    owner.effect(
      () =>
        webServer.tapIndex!((html) => {
          if (html.includes("__DSH_TRANSPORT__")) return html;
          return html.replace(
            /<head([^>]*)>/i,
            `<head$1><script>globalThis.__DSH_TRANSPORT__=Object.assign(globalThis.__DSH_TRANSPORT__||{},{ownsHost:true});</script>`,
          );
        }),
      "dsh-multica-runtime.ownsHost",
    );
  };
  if (typeof ctx.inject === "function") ctx.inject(["webServer"], installOwnsHost);
  else installOwnsHost(ctx);
  return factory;
}
