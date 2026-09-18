import './native-primitives.ts';
import type { Context } from '@deepseek-ai/cordis';
import { agentEvents, emitAgentEvent } from '@deepseek-ai/dsh-agent';
import type { Agent, AgentFactory, AgentHandle, AgentOptions, AgentCancelCause, CancelOptions, InboxTarget, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent';
import { ReactLoopInbox, turnBoundaryProjectionDefinition } from '@deepseek-ai/dsh-agent-loop';
import { createScope } from '@deepseek-ai/dsh-scope';
import { SessionPreparation, SessionLogOffset } from '@deepseek-ai/dsh-session';
import type { Session, SessionId, UserMessage, TurnEndReason } from '@deepseek-ai/dsh-session';
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence';
import { DshTrajectoryWriter } from '../dsh-trajectory/index.ts';
import type { TaskDriver } from '../task-orchestration/index.ts';
import { appendObserverDiagnostic } from './observer-diagnostics.ts';

const textOf = (message: { content: readonly unknown[] }) => message.content.flatMap(block => {
  const item = block as { type?: string; text?: string };
  return item.type === 'text' ? [item.text ?? ''] : [];
}).join('\n');

async function abortable<T>(operation: T | PromiseLike<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let rejectAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(signal.reason);
    signal.addEventListener('abort', rejectAbort, { once: true });
  });
  try { return await Promise.race([Promise.resolve(operation), aborted]); }
  finally { signal.removeEventListener('abort', rejectAbort); }
}

/** A native DSH Agent whose single execution engine is the external Multica driver. */
export class MulticaAgent implements Agent {
  readonly scope;
  readonly ctx: Context;
  readonly inbox: ReactLoopInbox;
  private readonly dispatch;
  private readonly writer: DshTrajectoryWriter;
  private activity?: Promise<void>;
  private abort?: AbortController;
  private maintenance = false;
  private waking = false;
  private disposed = false;
  private halted = false;
  private running = false;

  constructor(loopCtx: Context, readonly id: SessionId, readonly options: AgentOptions,
    readonly session: Session, private readonly driver: TaskDriver) {
    this.scope = createScope(loopCtx, this);
    this.ctx = this.scope.ctx;
    this.dispatch = agentEvents(loopCtx, this);
    this.inbox = new ReactLoopInbox(this.ctx.sessionProjections, session, this.dispatch);
    this.writer = new DshTrajectoryWriter(session, { flush: async () => { await this.ctx.sessions.flush(session); } });
  }

  get status(): 'running' | 'idle' { return this.running ? 'running' : 'idle'; }
  private statusTo(running: boolean): void {
    if (this.running === running) return;
    this.running = running;
    this.dispatch.emit('agent/status', { status: this.status });
  }

  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    if (this.disposed) throw new Error('Agent is disposed');
    if (this.halted) throw new Error('External execution needs reconciliation; detach and resume this session before submitting more work');
    this.inbox.append(this.abort?.signal.aborted ? 'next-turn' : target, message);
    if (wakeup) { this.waking = true; this.kick(); }
  }
  followup(message: UserMessage): void { this.send(message, 'next-turn', true); }
  steer(message: UserMessage): void { this.send(message, 'next-step', true); }
  inject(message: UserMessage): void { this.send(message, 'next-step', false); }
  cancel(cause: AgentCancelCause, options?: CancelOptions): void {
    if (cause.kind === 'disposed') this.disposed = true;
    if (!options?.keepInbox) this.inbox.clear();
    this.abort?.abort(cause);
  }
  async whenIdle(): Promise<void> { while (this.activity) await this.activity; }
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.activity || this.disposed || this.halted) throw new Error('Agent is unavailable for maintenance');
    this.maintenance = true;
    this.abort = new AbortController();
    // Invoke synchronously after reserving the idle phase, per the DSH Agent contract.
    let operation: Promise<T>;
    try { operation = Promise.resolve(task(this.abort.signal)); } catch (error) { operation = Promise.reject(error); }
    this.activity = operation.then(() => undefined, () => undefined).finally(() => {
      this.activity = undefined; this.abort = undefined; this.maintenance = false; this.kick();
    });
    return operation;
  }

  /** Resume unfinished durable work using the same user rpcId, without submitting a new task identity. */
  start(): void {
    if (this.inbox.hasPending || this.boundary().openTurnStartSeq !== null) this.waking = true;
    this.kick();
  }
  private boundary() {
    const state = this.ctx.sessionProjections.stateOf(this.session, 'turnBoundary');
    if (!state) throw new Error('Native turnBoundary projection unavailable');
    return state;
  }
  private kick(): void {
    if (!this.waking || this.activity || this.maintenance || this.disposed || this.halted) return;
    this.abort = new AbortController();
    this.activity = Promise.resolve().then(() => this.drain()).catch(error => {
      this.halted = true;
      this.dispatch.emit('agent/error', { turn: this.boundary().lastTurn, step: 0, error });
    }).finally(() => {
      this.activity = undefined; this.abort = undefined; this.statusTo(false); this.kick();
    });
    this.statusTo(true);
  }

  private async drain(): Promise<void> {
    while (!this.disposed && !this.halted && this.waking) {
      this.waking = false;
      const state = this.boundary();
      const turn = state.openTurnStartSeq === null ? state.lastTurn + 1 : state.lastTurn;
      const signal = this.abort!.signal;
      const open = state.openTurnStartSeq !== null;
      if (!open) this.session.append('turn/start', { turn });
      let step = 0;
      let resumedMessages: UserMessage[] | undefined;
      if (open) {
        const events = this.session.snapshotEvents();
        const boundary = state.lastStepBoundary;
        if (boundary?.kind === 'start' && boundary.seq > state.openTurnStartSeq!) {
          const start = events.find(event => event.seq === boundary.seq);
          if (start?.type !== 'step/start') throw new Error('Invalid persisted step boundary');
          step = start.data.step;
          resumedMessages = events.slice(Number(boundary.seq) + 1).flatMap(event => event.type === 'user/message' ? [event.data] : []);
          if (resumedMessages.length === 0) {
            // No driver can be called before its user/message is durably flushed.
            this.session.append('step/end', { turn, step });
            resumedMessages = undefined;
          }
        } else if (boundary && boundary.seq > state.openTurnStartSeq!) {
          const start = events.findLast(event => event.type === 'step/start');
          if (start?.type === 'step/start') step = start.data.step;
        }
      }
      let reason: TurnEndReason = { kind: 'completed' };
      let first = !open;
      let externalStarted = false;
      let externalRequestId: string | undefined;
      try {
        while (resumedMessages || this.inbox.hasPending) {
          signal.throwIfAborted();
          let messages: UserMessage[];
          if (resumedMessages) { messages = resumedMessages; resumedMessages = undefined; }
          else {
            const claimed = this.inbox.claim(first ? 'next-turn' : 'next-step', turn);
            first = false;
            if (!claimed.length) break;
            const decision = await this.dispatch.waterfall('agent/pre-step', { messages: claimed, turn, step: step + 1, signal }, async () => ({ kind: 'enter', messages: claimed }));
            signal.throwIfAborted();
            if (decision.kind === 'reject') break;
            messages = decision.messages;
            this.session.append('step/start', { turn, step: ++step });
            for (const message of messages) this.session.append('user/message', message, { surfaceOp: 'append' });
          }
          // This checkpoint precedes every external side effect; rpcId survives a crash.
          await this.ctx.sessions.flush(this.session);
          const primary = messages.findLast(message => 'rpcId' in message.source) ?? messages.at(-1);
          if (!primary) throw new Error('Cannot execute an empty external prompt');
          const source = primary.source as { rpcId?: string };
          const requestId = source.rpcId ?? primary.id;
          externalRequestId = requestId;
          // Multica Chat Session owns durable conversation history and native
          // provider resume. DSH sends only the current user prompt; it does
          // not forward a second history representation to the executor.
          const request = { sessionId: this.id, requestId, prompt: messages.map(textOf).join('\n'), signal };
          externalStarted = true;
          await this.driver.run(request, (event, binding) => this.writer.append(event, { ...binding, turn, step }).then(() => undefined));
          externalStarted = false;
          this.session.append('step/end', { turn, step });
          await this.ctx.sessions.flush(this.session);
          if (!this.inbox.nextStep.length) {
            await this.dispatch.serial('agent/turn-stopping', { turn, signal });
            if (!this.inbox.nextStep.length) break;
          }
        }
      } catch (error) {
        // Pending/cancel-unconfirmed is deliberately left OPEN. A later resume
        // reconciles the exact task, and no next queued task can overtake it.
        if ((error instanceof Error && error.name === 'TaskPendingError')
          || (externalStarted && !(error instanceof Error && error.name === 'TaskExecutionError'))) {
          this.halted = true;
          if (externalRequestId) appendObserverDiagnostic(this.session, error, { requestId: externalRequestId, turn, step });
          this.dispatch.emit('agent/error', { turn, step, error });
          await this.ctx.sessions.flush(this.session);
          return;
        }
        const confirmedCancelled = error instanceof Error && error.name === 'TaskExecutionError'
          && 'outcome' in error && error.outcome === 'cancelled';
        reason = signal.aborted ? { kind: 'aborted', reason: signal.reason as AgentCancelCause }
          : confirmedCancelled ? { kind: 'aborted', reason: { kind: 'legacy' } }
          : { kind: 'error', error: { message: error instanceof Error ? error.message : String(error), code: 'UNKNOWN' } };
        this.dispatch.emit('agent/error', { turn, step, error });
        if (this.boundary().lastStepBoundary?.kind === 'start') this.session.append('step/end', { turn, step });
      }
      // Wakes consumed by steering steps in this turn must not create an
      // empty extra turn. New deliveries during close/flush can arm it again.
      this.waking = false;
      this.session.append('turn/end', { turn, reason });
      await this.ctx.sessions.flush(this.session);
      if (this.inbox.nextTurn.length && !this.disposed) this.waking = true;
      // Cancellation applies to this activity only; a later queued turn gets a fresh signal.
      this.abort = new AbortController();
    }
  }
}

/** Registers through the official public AgentFactory boundary and native JSONL write leases. */
export function installMulticaFactory(ctx: Context, driver: TaskDriver): AgentFactory {
  if (typeof driver?.run !== 'function') throw new Error('Real Multica TaskDriver is required');
  ctx.sessionProjections.register(turnBoundaryProjectionDefinition);
  const active = new Set<() => Promise<void>>();
  const pending = new Set<Promise<AgentHandle>>();
  const factoryAbort = new AbortController();
  ctx.effect(() => async () => {
    factoryAbort.abort(new Error('Multica factory unloaded'));
    await Promise.allSettled([...pending]);
    await Promise.all([...active].map(dispose => dispose()));
  });

  const construct = async (owner: Context, options: CreateAgentOptions | ResumeAgentOptions): Promise<AgentHandle> => {
    owner.fiber.assertActive();
    const ownerAbort = new AbortController();
    let agent: MulticaAgent | undefined;
    let stored: SessionHandle | undefined;
    let preparation: SessionPreparation | undefined;
    let detachSession: (() => void) | undefined;
    let detachAgent: (() => void) | undefined;
    let disposing: Promise<void> | undefined;
    let initialized = false;
    let ownerDisposer: () => void | Promise<void> = () => {};
    const dispose = (byOwner = false): Promise<void> => disposing ??= (async () => {
      ownerAbort.abort(new Error('Agent lifecycle disposed'));
      const failures: unknown[] = [];
      for (const close of [async () => { agent?.cancel({ kind: 'disposed' }); await agent?.whenIdle(); },
        async () => { await agent?.scope.dispose(); }, async () => { await stored?.close(); },
        async () => { detachAgent?.(); detachSession?.(); }]) {
        try { await close(); } catch (error) { failures.push(error); }
      }
      preparation?.[Symbol.dispose]();
      active.delete(dispose);
      if (!byOwner) await ownerDisposer();
      if (failures.length) throw new AggregateError(failures, 'Agent disposal failed');
    })();
    ownerDisposer = owner.effect(() => () => {
      ownerAbort.abort(new Error('Agent owner disposed'));
      // The create continuation owns cleanup until all acquired handles are assigned.
      if (initialized && !disposing) return dispose(true);
    });
    const signal = AbortSignal.any([ownerAbort.signal, factoryAbort.signal, ...options.signal ? [options.signal] : []]);
    try {
      signal.throwIfAborted();
      let storedCount = 0;
      if ('resumeSessionId' in options) {
        stored = await ctx.sessionPersistence.open(options.resumeSessionId, 'write', { signal });
        signal.throwIfAborted();
        const read = await stored.read(0, undefined, { signal });
        signal.throwIfAborted();
        storedCount = read.events.length;
        preparation = SessionPreparation.create(ctx.sessions.prepare(options.resumeSessionId, {
          seed: [...read.events], meta: structuredClone(stored.header), inheritedEventCount: stored.inheritedEventCount, eventState: read.eventState,
        }));
      } else {
        preparation = SessionPreparation.create(ctx.sessions.prepare(options.sessionId, {
          seed: options.seed, meta: options.meta, inheritedEventCount: options.inheritedEventCount,
        }));
        stored = await ctx.sessionPersistence.create(preparation.session.header, { inheritedEventCount: preparation.session.inheritedEventCount, signal });
      }
      signal.throwIfAborted();
      agent = new MulticaAgent(ctx, preparation.session.id, options.agentOptions ?? {}, preparation.session, driver);
      const commit = await abortable(options.setup?.(agent.ctx, agent), signal);
      signal.throwIfAborted(); owner.fiber.assertActive();
      // Match native factory ordering: commit may append final setup facts.
      // A rejected commit must leave an unmaterialized create lease reusable.
      commit?.commit();
      // Persist unpublished seed/setup events before publication. Live writes are
      // already routed by the official persistence backend's session/event hook.
      const suffix = agent.session.snapshotEvents(SessionLogOffset(storedCount));
      if (suffix.length) await stored.append(suffix);
      signal.throwIfAborted(); owner.fiber.assertActive();
      detachSession = agent.ctx.sessions.enter(agent.session);
      detachAgent = ctx.agents.enter(agent, options.parentAgent);
      agent.ctx.sessions.announce(agent.session);
      signal.throwIfAborted();
      ctx.agents.announce(agent);
      signal.throwIfAborted();
      emitAgentEvent(ctx, agent, 'agent/session-start', { source: 'resumeSessionId' in options ? 'resume' : 'startup' });
      signal.throwIfAborted();
      initialized = true;
      active.add(dispose);
      preparation[Symbol.dispose](); preparation = undefined;
      agent.start();
      return { agent, dispose };
    } catch (error) { await dispose().catch(() => {}); throw error; }
  };
  const tracked: typeof construct = (owner, options) => {
    const operation = construct(owner, options);
    pending.add(operation);
    void operation.then(() => pending.delete(operation), () => pending.delete(operation));
    return operation;
  };
  const factory: AgentFactory = { createAgent: tracked, resume: tracked };
  ctx.agents.setFactory(factory);
  return factory;
}
