import { NATIVE_DSH_PROFILE, PLATFORM_DSH_PROFILE } from "./capabilities.ts";
import { RecursionGuardError, SwitchBlockedError } from "./errors.ts";
import { composeTaskPrompt, summarizeSession, translateMulticaEvent } from "./events.ts";
import { createId, now } from "./ids.ts";
import { MemoryInbox } from "./inbox.ts";
import type { BindingStore } from "./mapping.ts";
import { submitWithReconcile } from "./reconcile.ts";
import { planCapabilitySync } from "./skills.ts";
import type {
  Agent,
  AgentCancelCause,
  AgentOptions,
  AgentStatus,
  CancelOptions,
  DshSession,
  HandoffPayload,
  InboxTarget,
  MulticaClient,
  PluginCatalog,
  SessionSelection,
  TraceEntry,
  UserMessage,
} from "./types.ts";

export interface AgentHooks {
  onTrace(entry: TraceEntry): void;
  onSessionEvent(): void;
  onStatus(agent: MulticaAgent): void;
}

export class MulticaAgent implements Agent {
  readonly id: string;
  readonly options: AgentOptions;
  readonly session: DshSession;
  readonly inbox: MemoryInbox;
  status: AgentStatus = "idle";
  private disposed = false;
  private turn = 0;
  private readonly idleWaiters: Array<() => void> = [];
  private driveChain: Promise<void> = Promise.resolve();
  private cancelCause: AgentCancelCause | undefined;
  private activeUnsub: (() => void) | undefined;
  private activeTaskId: string | undefined;
  private pendingHandoff: HandoffPayload | undefined;
  private readonly bindings: BindingStore;
  private readonly client: MulticaClient;
  private readonly catalog: PluginCatalog;
  private readonly hooks: AgentHooks;

  constructor(
    id: string,
    options: AgentOptions,
    session: DshSession,
    bindings: BindingStore,
    client: MulticaClient,
    catalog: PluginCatalog,
    hooks: AgentHooks,
  ) {
    this.id = id;
    this.options = options;
    this.session = session;
    this.bindings = bindings;
    this.client = client;
    this.catalog = catalog;
    this.hooks = hooks;
    this.inbox = new MemoryInbox();
  }

  cancel(cause: AgentCancelCause, options?: CancelOptions): void {
    this.cancelCause = cause;
    if (!options?.keepInbox) this.inbox.clear();
    const segment = this.bindings.currentOrNull(this.id);
    if (segment?.currentTaskId) {
      segment.status = "canceling";
      this.activeTaskId = segment.currentTaskId;
      void this.client.cancelTask(segment.currentTaskId);
      this.trace("plugin", "cancel", `cancel task ${segment.currentTaskId}`, {
        cause,
      });
    }
    this.activeUnsub?.();
    this.activeUnsub = undefined;
  }

  whenIdle(): Promise<void> {
    if (this.status === "idle") return Promise.resolve();
    return new Promise((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    this.inbox.append(target, message);
    if (wakeup) this.wake();
  }

  followup(message: UserMessage): void {
    this.send(message, "next-turn", true);
  }

  steer(message: UserMessage): void {
    this.send(message, "next-step", true);
  }

  inject(message: UserMessage): void {
    this.send(message, "next-step", false);
  }

  async select(selection: SessionSelection): Promise<void> {
    if (this.status === "running") {
      throw new SwitchBlockedError(
        "当前任务还在跑。先等它结束，或确认取消后再切换 Runtime / 运行环境。",
      );
    }
    const previous = this.bindings.currentOrNull(this.id);
    if (selection.runtime === "dsh") {
      const profile = selection.nativeProfile ?? PLATFORM_DSH_PROFILE;
      if (profile !== NATIVE_DSH_PROFILE) {
        throw new RecursionGuardError(profile);
      }
    }
    if (
      previous &&
      (previous.runtime !== selection.runtime ||
        previous.environment !== selection.environment ||
        previous.machineId !== selection.machineId ||
        previous.cwd !== selection.cwd)
    ) {
      const summary = summarizeSession(this.session.events);
      const handoff: HandoffPayload = {
        from: previous.runtime,
        to: selection.runtime,
        fromEnv: previous.environment,
        toEnv: selection.environment,
        summary,
      };
      this.session.append({
        type: "multica/handoff",
        time: now(),
        data: {
          from: handoff.from,
          to: handoff.to,
          fromEnv: handoff.fromEnv,
          toEnv: handoff.toEnv,
          summary: handoff.summary,
          packed: summary !== "(empty session)",
        },
      });
      this.pendingHandoff = summary === "(empty session)" ? undefined : handoff;
      if (this.pendingHandoff) {
        this.trace(
          "plugin",
          "handoff",
          `pack ${handoff.from} → ${handoff.to} into next prompt`,
          { bytes: handoff.summary.length },
        );
      }
      if (previous.machineId !== selection.machineId) {
        this.session.append({
          type: "multica/sync-required",
          time: now(),
          data: {
            fromMachine: previous.machineId,
            toMachine: selection.machineId,
            cwd: selection.cwd,
            reason: "cross-machine files are not implicit",
          },
        });
      }
    }
    const segment = this.bindings.openSegment(this.id, selection);
    this.trace(
      "plugin",
      "segment",
      `open ${selection.runtime} @ ${selection.environment}`,
      { segmentId: segment.id, cwd: selection.cwd },
    );
    this.hooks.onSessionEvent();
  }

  dispose(): void {
    this.disposed = true;
    this.cancel("disposed");
    this.becomeIdle();
  }

  private wake(): void {
    if (this.disposed) return;
    if (this.status === "idle") {
      this.status = "running";
      this.hooks.onStatus(this);
    }
    this.driveChain = this.driveChain.then(() => this.drain()).catch((error) => {
      this.session.append({
        type: "multica/error",
        time: now(),
        data: { message: error instanceof Error ? error.message : String(error) },
      });
      this.bindings.setStatus(this.id, "failed");
      this.becomeIdle();
      this.hooks.onSessionEvent();
    });
  }

  private async drain(): Promise<void> {
    while (!this.disposed) {
      const claimed = [
        ...this.inbox.claim("next-step"),
        ...this.inbox.claim("next-turn"),
      ];
      if (claimed.length === 0) {
        this.becomeIdle();
        return;
      }
      this.cancelCause = undefined;
      await this.runTurn(claimed);
    }
  }

  private async runTurn(messages: UserMessage[]): Promise<void> {
    const selection = this.bindings.current(this.id);
    if (selection.runtime === "dsh") {
      const profile = selection.nativeProfile ?? PLATFORM_DSH_PROFILE;
      if (profile !== NATIVE_DSH_PROFILE) {
        throw new RecursionGuardError(profile);
      }
    }

    this.status = "running";
    this.hooks.onStatus(this);
    this.turn += 1;
    const userText = messages.map((message) => message.text).join("\n\n");
    const handoff = this.pendingHandoff;
    this.pendingHandoff = undefined;
    const prompt = composeTaskPrompt(userText, handoff);
    for (const message of messages) {
      this.session.append({
        type: "user/message",
        time: now(),
        data: { id: message.id, text: message.text, source: message.source },
      });
    }

    const capabilities = planCapabilitySync(
      selection.runtime,
      this.catalog.skills,
      this.catalog.mcp,
    );
    this.trace("plugin", "capabilities", "sync skills/MCP", {
      runtime: selection.runtime,
      mcpSupported: capabilities.mcpSupported,
      skillCount: capabilities.skills.length,
      mcpCount: capabilities.mcp.length,
    });

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
    this.bindings.bindMultica(this.id, {
      agentId: agent.id,
      sessionId: session.id,
    });

    const clientRequestId = createId("req");
    this.bindings.markUnknown(this.id, clientRequestId);
    this.trace("plugin", "submit", "submit task (state may be unknown)", {
      clientRequestId,
      handoff: handoff ? `${handoff.from}→${handoff.to}` : undefined,
    });

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
      handoff,
    });

    this.bindings.bindTask(this.id, accepted.taskId, clientRequestId);
    this.activeTaskId = accepted.taskId;
    this.trace("multica", "accepted", `task ${accepted.taskId}`, {
      sessionId: accepted.sessionId,
    });
    this.hooks.onSessionEvent();

    await this.consume(accepted.taskId);
  }

  private consume(taskId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        this.activeUnsub?.();
        this.activeUnsub = undefined;
        this.activeTaskId = undefined;
        if (error) reject(error);
        else resolve();
      };

      this.activeUnsub = this.client.subscribe(taskId, (event) => {
        if (this.cancelCause && event.type !== "task/canceled") {
          return;
        }
        const translated = translateMulticaEvent(event, {
          runtime: this.bindings.current(this.id).runtime,
          turn: this.turn,
          step: 1,
        });
        for (const item of translated) {
          this.session.append(item);
        }
        this.trace("multica", event.type, summarizeEvent(event), event.data);
        this.hooks.onSessionEvent();
        if (event.type === "task/completed") {
          this.bindings.setStatus(this.id, "idle");
          finish();
        } else if (event.type === "task/failed") {
          this.bindings.setStatus(this.id, "failed");
          finish();
        } else if (event.type === "task/canceled") {
          this.bindings.setStatus(this.id, "idle");
          finish();
        }
      });

      if (this.cancelCause) {
        void this.client.cancelTask(taskId).finally(() => finish());
      }
    });
  }

  private becomeIdle(): void {
    this.status = "idle";
    const waiters = this.idleWaiters.splice(0, this.idleWaiters.length);
    for (const waiter of waiters) waiter();
    this.hooks.onStatus(this);
  }

  private trace(
    layer: TraceEntry["layer"],
    kind: string,
    detail: string,
    payload?: Record<string, unknown>,
  ): void {
    this.hooks.onTrace({ at: now(), layer, kind, detail, payload });
  }
}

function summarizeEvent(event: { type: string; data: Record<string, unknown> }): string {
  const text = event.data.text;
  if (typeof text === "string" && text.length > 0) {
    return text.length > 80 ? `${text.slice(0, 80)}…` : text;
  }
  const name = event.data.name;
  if (typeof name === "string") return String(name);
  return event.type;
}
