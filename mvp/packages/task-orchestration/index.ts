import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { MulticaApiError, OfficialMulticaClient, prepareSubmission } from '../multica-client/index.ts';
import type { CliKind, OfficialTask, OfficialTaskMessage, RuntimeDescriptor, RuntimeTarget, TaskBinding } from '../multica-client/index.ts';
import { CorrelationRepository } from '../persistence/index.ts';
import type { ExecutionSegment, SegmentExecutionResources, TaskIntent, TaskState } from '../persistence/index.ts';
import type { ExecutionBinding, Json, TrajectoryInput } from '../dsh-trajectory/index.ts';
import type { DshManagedSkill, DshSkillState, MulticaSkillDistributor } from '../skill-distribution/index.ts';

export interface TaskDriverRequest {
  sessionId: string;
  requestId: string;
  prompt: string;
  runtime?: CliKind;
  signal?: AbortSignal;
}
export type TaskDriverBinding = Omit<ExecutionBinding, 'turn' | 'step'>;
export type TaskEventSink = (input: TrajectoryInput, binding: TaskDriverBinding) => Promise<void>;
export interface TaskDriver {
  run(request: TaskDriverRequest, onEvent: TaskEventSink): Promise<void>;
  isBusy?(): boolean;
  runtimeState?(sessionId: string): { runtime: CliKind; runtimeId?: string; daemonId?: string; label?: string; busy: boolean };
  listRuntimes?(): Promise<RuntimeDescriptor[]>;
  selectRuntime?(sessionId: string, runtime: CliKind | RuntimeTarget): Promise<void>;
  listManagedSkills?(): Promise<ManagedSkillCatalog>;
  setManagedSkillEnabled?(key: string, enabled: boolean): Promise<ManagedSkillCatalog>;
  replaceManagedSkills?(skills: readonly DshManagedSkill[]): Promise<ManagedSkillCatalog>;
}

export interface ManagedSkillCatalog {
  busy: boolean;
  skills: DshSkillState[];
}

export interface TaskOrchestratorOptions {
  userId: string;
  defaultRuntime: CliKind;
  /** Target used when a new session has not selected a concrete runtime yet. */
  defaultRuntimeTarget?: RuntimeTarget;
  repository: CorrelationRepository;
  client: OfficialMulticaClient;
  /** Optional DSH-managed Skill bridge; Multica remains the Skill registry. */
  skillDistributor?: MulticaSkillDistributor;
  ensurePersonalSandbox(userId: string): Promise<{ id: string }>;
  /** Must use official APIs; mode:reconcile must perform reads only, never another create POST. */
  provisionExecutionSegment(input: {
    mode: 'create' | 'reconcile'; userId: string; dshSessionId: string;
    segmentId: string; runtime: CliKind; runtimeTarget?: RuntimeTarget; sandboxId: string; previous?: SegmentExecutionResources;
  }): Promise<Omit<SegmentExecutionResources, 'segmentId'>>;
  /** Positive Daemon evidence: REST task cancellation alone does not prove process exit or transcript flush. */
  confirmTaskSettled(input: { userId: string; sandboxId: string; task: OfficialTask; binding: TaskBinding }): Promise<{
    executionStopped: boolean; transcriptFlushed: boolean;
  }>;
  /** Per-user active Task quota. Multica's Agent slot limit remains the
   * execution guard; this value prevents one tenant from consuming all
   * sessions in the shared workspace. */
  maxConcurrentTasks?: number;
  pollIntervalMs?: number;
  maxWaitMs?: number;
}

export class TaskPendingError extends Error { override name = 'TaskPendingError'; }
export class TaskExecutionError extends Error {
  override name = 'TaskExecutionError';
  constructor(message: string, readonly outcome: 'cancelled' | 'failed' = 'failed') { super(message); }
}

/** Correlation and native API glue only. Multica owns scheduling, queueing and CLI execution. */
export class TaskOrchestrator implements TaskDriver {
  private readonly options: TaskOrchestratorOptions;
  private readonly activeSessions = new Set<string>();
  constructor(options: TaskOrchestratorOptions) {
    if (!options.userId?.trim()) throw new Error('Trusted fixed userId is required');
    if (!['codex', 'claude-code'].includes(options.defaultRuntime)) throw new Error('Unsupported default Runtime');
    for (const value of [options.pollIntervalMs ?? 1000, options.maxWaitMs ?? 600000]) {
      if (!Number.isFinite(value) || value <= 0) throw new Error('Polling and deadline values must be positive');
    }
    const maxConcurrentTasks = options.maxConcurrentTasks ?? 4;
    if (!Number.isInteger(maxConcurrentTasks) || maxConcurrentTasks < 2 || maxConcurrentTasks > 50) throw new Error('maxConcurrentTasks must be between 2 and 50');
    this.options = options;
  }

  runtimeState(sessionId: string): { runtime: CliKind; runtimeId?: string; daemonId?: string; label?: string; busy: boolean } {
    const { repository, userId, defaultRuntime } = this.options;
    const selected = repository.getSelectedRuntimeTarget(userId, sessionId);
    const latest = repository.getLatestExecutionSegment(userId, sessionId);
    const resources = latest ? repository.getSegmentResources(latest.segmentId) : undefined;
    const target = selected?.runtimeId || selected?.daemonId ? selected : resources ?
      { runtime: latest!.runtime, runtimeId: resources.runtimeId, daemonId: resources.daemonId, label: null } : undefined;
    return {
      runtime: target?.runtime ?? selected?.runtime ?? latest?.runtime ?? defaultRuntime,
      ...(target?.runtimeId ? { runtimeId: target.runtimeId } : {}),
      ...(target?.daemonId ? { daemonId: target.daemonId } : {}),
      ...(target?.label ? { label: target.label } : {}),
      busy: this.activeSessions.has(sessionId) || repository.listActiveTasks(userId).some(task => repository.getExecutionSegment(task.segmentId)?.dshSessionId === sessionId),
    };
  }

  isBusy(): boolean { return this.activeSessions.size > 0 || this.isGloballyBusy(); }

  async listRuntimes(): Promise<RuntimeDescriptor[]> { return this.options.client.listRuntimeDescriptors(); }

  async selectRuntime(sessionId: string, selection: CliKind | RuntimeTarget): Promise<void> {
    if (this.activeSessions.has(sessionId)) throw new TaskPendingError('Cannot select Runtime while the session driver is active');
    const { repository, userId, client } = this.options;
    if (repository.listActiveTasks(userId).some(task => repository.getExecutionSegment(task.segmentId)?.dshSessionId === sessionId)) {
      throw new TaskPendingError('Cannot select Runtime while the DSH session has an unresolved task');
    }
    const latest = repository.getLatestExecutionSegment(userId, sessionId);
    const resources = latest ? repository.getSegmentResources(latest.segmentId) : undefined;
    const requestedKind = typeof selection === 'string' ? selection : selection.kind;
    const target = await this.resolveRuntimeTarget(requestedKind, typeof selection === 'string' ? undefined : selection, resources);
    if (resources && (resources.runtimeId !== target.runtimeId || resources.daemonId !== target.daemonId)) {
      // Runtime selection is a Multica Agent binding operation. DSH only
      // performs the call on behalf of the session; it never creates a new
      // Chat Session or manufactures provider context.
      const current = await client.selectRuntime({ daemonId: target.daemonId, kind: target.kind, runtimeId: target.runtimeId });
      await client.switchAgentRuntime({ agentId: resources.agentId, runtimeId: current.id });
    }
    repository.selectRuntimeTarget(userId, sessionId, { runtime: target.kind, runtimeId: target.runtimeId ?? null, daemonId: target.daemonId, label: null });
  }

  async listManagedSkills(): Promise<ManagedSkillCatalog> {
    const distributor = this.options.skillDistributor;
    const busy = this.isGloballyBusy();
    if (!distributor) return { busy, skills: [] };
    return { busy, skills: await distributor.listSkillStates() };
  }

  async setManagedSkillEnabled(key: string, enabled: boolean): Promise<ManagedSkillCatalog> {
    if (this.isGloballyBusy()) throw new TaskPendingError('Cannot change Skills while a task is active');
    const distributor = this.options.skillDistributor;
    if (!distributor) throw new Error('DSH Skill distribution is unavailable');
    await distributor.setSkillEnabledGlobally(key, enabled);
    return this.listManagedSkills();
  }

  /** Control-plane update used by the multi-tenant Gateway.  Skills are
   * refreshed in the running Host and become effective on the next Task. */
  async replaceManagedSkills(skills: readonly DshManagedSkill[]): Promise<ManagedSkillCatalog> {
    if (this.isGloballyBusy()) throw new TaskPendingError('Cannot change Skills while a task is active');
    const distributor = this.options.skillDistributor;
    if (!distributor) throw new Error('DSH Skill distribution is unavailable');
    await distributor.replaceDeclarations(skills);
    return this.listManagedSkills();
  }

  async run(request: TaskDriverRequest, onEvent: TaskEventSink): Promise<void> {
    if (!request.requestId || !request.sessionId || !request.prompt.trim()) throw new Error('Session, request and prompt are required');
    if (request.runtime !== undefined && !['codex', 'claude-code'].includes(request.runtime)) throw new Error('Unsupported Runtime');
    if (this.activeSessions.has(request.sessionId)) throw new TaskPendingError('This DSH session already has an active driver; other sessions remain independent');
    this.activeSessions.add(request.sessionId);
    try { await this.runOwned(request, onEvent); }
    finally { this.activeSessions.delete(request.sessionId); }
  }

  private async runOwned(request: TaskDriverRequest, onEvent: TaskEventSink): Promise<void> {
    const { repository, userId, client } = this.options;
    const existing = repository.getTask(request.requestId);
    let intent: TaskIntent;
    let segment: ExecutionSegment;
    let resources: SegmentExecutionResources;
    let created = false;
    if (existing) {
      segment = repository.getExecutionSegment(existing.segmentId)!;
      if (existing.userId !== userId || !segment || segment.dshSessionId !== request.sessionId ||
          (request.runtime !== undefined && segment.runtime !== request.runtime) ||
          existing.inputDigest !== this.commandDigest(request, segment.runtime)) throw new Error('Request identity or session ownership conflict');
      resources = repository.getSegmentResources(segment.segmentId)!;
      if (!resources) throw new TaskPendingError('Execution segment provisioning must be reconciled');
      intent = existing;
    } else {
      if (request.signal?.aborted) throw new TaskExecutionError('Task cancelled before submission', 'cancelled');
      const maxConcurrentTasks = this.options.maxConcurrentTasks ?? 4;
      // `run()` adds the current Session before entering this branch, so the
      // in-memory count closes the same-process race while the durable count
      // covers tasks restored after a Host restart.
      if (this.activeSessions.size > maxConcurrentTasks || this.options.repository.listActiveTasks(userId).length >= maxConcurrentTasks) {
        throw new TaskPendingError('User Task quota reached; wait for an active Task to settle');
      }
      const sandbox = await this.options.ensurePersonalSandbox(userId);
      const latest = repository.getLatestExecutionSegment(userId, request.sessionId);
      const selected = repository.getSelectedRuntimeTarget(userId, request.sessionId);
      const runtime = request.runtime ?? selected?.runtime ?? latest?.runtime ?? this.options.defaultRuntime;
      const selectedTarget = (!request.runtime || selected?.runtime === runtime) && selected?.runtimeId && selected.daemonId ?
        { kind: runtime, runtimeId: selected.runtimeId, daemonId: selected.daemonId } : undefined;
      const runtimeTarget = await this.resolveRuntimeTarget(runtime, selectedTarget,
        latest && latest.runtime === runtime ? repository.getSegmentResources(latest.segmentId) : undefined);
      const sameSessionActive = repository.listActiveTasks(userId).some(task => repository.getExecutionSegment(task.segmentId)?.dshSessionId === request.sessionId);
      if (sameSessionActive) throw new TaskPendingError('Previous task in this DSH session must finish or reconcile before a new turn or Runtime switch');
      const latestResources = latest ? repository.getSegmentResources(latest.segmentId) : undefined;
      const sameTarget = latestResources && latestResources.runtimeId === runtimeTarget.runtimeId && latestResources.daemonId === runtimeTarget.daemonId;
      segment = latest && (sameTarget || !latestResources && latest.runtime === runtime) ? latest : repository.putExecutionSegment({
        segmentId: randomUUID(), userId, dshSessionId: request.sessionId, ordinal: (latest?.ordinal ?? -1) + 1, runtime,
      });
      const previousSegment = repository.getPreviousExecutionSegment(segment.segmentId);
      resources = await this.ensureSegment(segment, sandbox.id, previousSegment ? repository.getSegmentResources(previousSegment.segmentId) : undefined, runtimeTarget);
      await client.selectRuntime({ daemonId: resources.daemonId, kind: runtime, runtimeId: resources.runtimeId });
      if (request.signal?.aborted) throw new TaskExecutionError('Task cancelled before submission', 'cancelled');
      const reserved = repository.reserveTask({ requestId: request.requestId, userId, segmentId: segment.segmentId, inputDigest: this.commandDigest(request, runtime) });
      intent = reserved.task;
      created = reserved.created;
      if (created) {
        // Multica owns the durable Chat Session history and provider resume
        // decision. Submit only the user's current prompt; DSH must not
        // duplicate or rewrite conversation context.
        repository.saveTaskSubmission(prepareSubmission({ requestId: request.requestId, chatSessionId: resources.chatSessionId, content: request.prompt }));
      }
    }

    // Attach DSH-managed Skills to the stable official Agent before the
    // message is submitted. This uses Multica's Agent-Skill API; project
    // files are never copied as part of this synchronization. Running this
    // during reconciliation also repairs an interrupted first sync.
    if (this.options.skillDistributor) await this.options.skillDistributor.syncAgent(resources.agentId);

    const submission = repository.getTaskSubmission(request.requestId);
    if (!submission) throw new TaskPendingError('Persisted request has no confirmed outbound payload; manual reconciliation is required');
    if (intent.state === 'failed' && !intent.externalTaskId) throw new TaskExecutionError('Multica definitively rejected this persisted submission');
    if (!intent.externalTaskId) {
      let accepted;
      try { accepted = created ? await client.submitPrepared(submission) : await client.reconcileSubmission(submission); }
      catch (error) {
        if (error instanceof MulticaApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && created) {
          repository.confirmTaskSubmissionRejected(request.requestId, `${error.operation}:HTTP-${error.status}`);
        }
        throw error;
      }
      if (accepted.status !== 'accepted') {
        repository.markTaskSubmissionUnknown(request.requestId);
        throw new TaskPendingError('Multica submission outcome is unknown; no repeated POST was sent');
      }
      if (!repository.completeTaskSubmission(request.requestId, accepted.taskId)) {
        if (repository.getTask(request.requestId)?.externalTaskId !== accepted.taskId) throw new Error('Task binding changed during submission reconciliation');
      }
      intent = repository.getTask(request.requestId)!;
    }
    const binding: TaskBinding = { taskId: intent.externalTaskId!, agentId: resources.agentId, runtimeId: resources.runtimeId, daemonId: resources.daemonId, chatSessionId: resources.chatSessionId };
    await this.followTask(request, intent, segment.runtime, binding, onEvent);
  }

  private async ensureSegment(segment: ExecutionSegment, sandboxId: string, previous?: SegmentExecutionResources, runtimeTarget?: RuntimeTarget): Promise<SegmentExecutionResources> {
    const repository = this.options.repository;
    const existing = repository.getSegmentResources(segment.segmentId);
    if (existing) return existing;
    const owner = repository.reserveSegmentProvisioning(segment.segmentId);
    let resources: SegmentExecutionResources;
    try {
      resources = { ...await this.options.provisionExecutionSegment({
        mode: owner ? 'create' : 'reconcile', userId: segment.userId, dshSessionId: segment.dshSessionId,
        segmentId: segment.segmentId, runtime: segment.runtime, runtimeTarget, sandboxId, previous,
      }), segmentId: segment.segmentId };
    } catch {
      repository.markSegmentProvisioningUnknown(segment.segmentId);
      throw new TaskPendingError('Official Multica execution segment provisioning requires reconciliation; create will not be blindly repeated');
    }
    if (previous && previous.daemonId === resources.daemonId && resources.workDir !== previous.workDir) {
      throw new Error('Runtime switching on one Daemon must preserve the DSH session working directory');
    }
    if (!repository.completeSegmentProvisioning(resources)) {
      const adopted = repository.getSegmentResources(segment.segmentId);
      if (!adopted || (Object.keys(resources) as Array<keyof SegmentExecutionResources>).some(key => adopted[key] !== resources[key])) throw new Error('Execution segment resources changed during reconciliation');
    }
    return resources;
  }

  private async followTask(request: TaskDriverRequest, intent: TaskIntent, runtime: CliKind, binding: TaskBinding, onEvent: TaskEventSink): Promise<void> {
    const { repository, client, userId } = this.options;
    const trajectoryBinding: TaskDriverBinding = { userId, taskId: binding.taskId, sandboxId: intent.sandboxId, runtime };
    const deadline = Date.now() + (this.options.maxWaitMs ?? 600000);
    const observed = new Set<string>();
    while (Date.now() < deadline) {
      let stored = repository.getTask(request.requestId)!;
      if (request.signal?.aborted && ['submitted', 'queued', 'running'].includes(stored.state)) {
        repository.updateTaskState(request.requestId, stored.state, 'cancel_requested');
        stored = repository.getTask(request.requestId)!;
      }
      let task = await client.getTask(binding);
      if (stored.state === 'cancel_requested' && ['queued', 'dispatched', 'running', 'waiting_local_directory', 'deferred'].includes(task.status)) {
        // Official CancelTaskWithResult updates active rows only; a repeat returns an existing terminal row.
        // Reconcile first, then retry this idempotent cancellation, never the task creation POST.
        try { task = (await client.cancelTask(binding)).task; }
        catch { throw new TaskPendingError('Cancellation outcome is unconfirmed; its persisted intent will reconcile before a safe cancellation retry'); }
      }
      if (!observed.has(task.status)) {
        await onEvent({ kind: 'raw', eventId: `multica:${binding.taskId}:status:${task.status}`, time: 0,
          eventType: 'task-status', raw: { taskId: task.id, status: task.status } }, trajectoryBinding);
        observed.add(task.status);
      }
      await this.syncTranscript(request.requestId, binding.taskId, trajectoryBinding, onEvent);
      const nextState = normalizeTaskState(task.status);
      if (nextState === undefined) throw new TaskPendingError('Unknown official task state; retained raw event and awaiting reconciliation');
      if (['completed', 'failed', 'cancelled'].includes(nextState)) {
        const settled = await this.options.confirmTaskSettled({ userId, sandboxId: intent.sandboxId, task, binding });
        if (settled.executionStopped && settled.transcriptFlushed) {
          // Flush confirmation precedes a final durable read, so late daemon events are not lost.
          await this.syncTranscript(request.requestId, binding.taskId, trajectoryBinding, onEvent);
          const current = repository.getTask(request.requestId)!;
          if (current.state !== nextState && !repository.updateTaskState(request.requestId, current.state, nextState)) throw new TaskPendingError('Task settlement raced another observer');
          if (nextState === 'completed') return;
          throw new TaskExecutionError(nextState === 'cancelled' ? 'Multica CLI execution was cancelled and stopped' : 'Multica CLI execution failed', nextState === 'cancelled' ? 'cancelled' : 'failed');
        }
      } else if (stored.state !== 'cancel_requested' && !['completed', 'failed', 'cancelled'].includes(stored.state)) {
        const rank: Partial<Record<TaskState, number>> = { submitted: 0, queued: 1, running: 2 };
        if ((rank[nextState] ?? -1) > (rank[stored.state] ?? -1)) repository.updateTaskState(request.requestId, stored.state, nextState);
      }
      await delay(this.options.pollIntervalMs ?? 1000);
    }
    throw new TaskPendingError('Task observation deadline elapsed; execution/cancellation is not declared complete');
  }

  private async syncTranscript(requestId: string, taskId: string, binding: TaskDriverBinding, onEvent: TaskEventSink): Promise<void> {
    const since = this.options.repository.getTaskCursor(requestId);
    const batch = await this.options.client.readTaskMessages(taskId, since);
    if (batch.gaps.length) throw new TaskPendingError('Official task transcript has a sequence gap; synchronization position was not advanced');
    for (const event of batch.messages) await onEvent(projectTaskMessage(event.eventId, event.raw), binding);
    if (!this.options.repository.advanceTaskCursor(requestId, since, batch.nextSequence)) throw new TaskPendingError('Transcript cursor changed concurrently; replay before continuing');
  }

  private commandDigest(request: TaskDriverRequest, runtime: CliKind): string {
    return createHash('sha256').update(JSON.stringify([request.sessionId, request.prompt, runtime])).digest('hex');
  }

  private isGloballyBusy(): boolean {
    return this.activeSessions.size > 0 || this.options.repository.listActiveTasks(this.options.userId).length > 0;
  }

  private async resolveRuntimeTarget(kind: CliKind, requested?: RuntimeTarget, previous?: SegmentExecutionResources): Promise<RuntimeTarget> {
    if (requested) {
      if (requested.kind !== kind) throw new Error('Runtime kind and target differ');
      return requested;
    }
    if (previous && previous.runtimeId && previous.daemonId) {
      return { kind, runtimeId: previous.runtimeId, daemonId: previous.daemonId };
    }
    if (this.options.defaultRuntimeTarget && this.options.defaultRuntimeTarget.kind === kind) return this.options.defaultRuntimeTarget;
    const matches = (await this.options.client.listRuntimeDescriptors()).filter(runtime => runtime.kind === kind && runtime.status === 'online');
    if (matches.length === 1) return { kind, runtimeId: matches[0]!.runtimeId, daemonId: matches[0]!.daemonId };
    if (matches.length === 0) throw new Error(`No online ${kind} runtime is registered`);
    throw new Error(`Multiple ${kind} runtimes are registered; select one in the Runtime menu first`);
  }

}

export { createOfficialSegmentProvisioner } from './official-provisioner.ts';
export type { OfficialSegmentProvisionerOptions } from './official-provisioner.ts';

function normalizeTaskState(status: string): TaskState | undefined {
  if (['queued', 'dispatched', 'waiting_local_directory', 'deferred'].includes(status)) return 'queued';
  if (['running', 'completed', 'failed', 'cancelled'].includes(status)) return status as TaskState;
  return undefined;
}

/** Patched wire supplies genuine call_id; unpaired/unknown legacy messages remain raw. */
export function projectTaskMessage(eventId: string, raw: OfficialTaskMessage): TrajectoryInput {
  const parsedTime = raw.created_at ? Date.parse(raw.created_at) : 0;
  const base = { eventId, time: Number.isFinite(parsedTime) && parsedTime >= 0 ? parsedTime : 0, raw: raw as unknown as Json };
  if (raw.type === 'text' && typeof raw.content === 'string') return { ...base, kind: 'assistant', text: raw.content };
  if (typeof raw.call_id === 'string' && raw.call_id.trim()) {
    if (raw.type === 'tool_use' && typeof raw.tool === 'string' && raw.tool &&
        (raw.input === undefined || raw.input !== null && typeof raw.input === 'object' && !Array.isArray(raw.input))) {
      return { ...base, kind: 'tool-call', callId: raw.call_id, name: raw.tool, arguments: JSON.stringify(raw.input ?? {}) };
    }
    if (raw.type === 'tool_result' && (typeof raw.output === 'string' || raw.output === undefined && typeof raw.output_truncated === 'boolean')) {
      return { ...base, kind: 'tool-result', callId: raw.call_id,
        content: [{ type: 'text', text: (raw.output ?? '') + (raw.output_truncated === true ? '\n[Multica output truncated]' : '') }],
        ...(typeof raw.is_error === 'boolean' ? { isError: raw.is_error } : {}) };
    }
  }
  return { ...base, kind: 'raw', eventType: raw.type };
}
