import { randomUUID } from 'node:crypto';
import { DaytonaError, type Daytona, type Sandbox } from '@daytona/sdk';
import type { CorrelationRepository, SandboxBinding } from '../persistence/index.ts';

export const PERSONAL_SANDBOX_LABELS = {
  user: 'dsh-mvp-user-id',
  creation: 'dsh-mvp-creation-id',
} as const;

export type PersonalSandboxErrorCode = 'CREATION_UNKNOWN' | 'OWNERSHIP_CONFLICT' | 'NOT_READY' | 'LIFECYCLE_PENDING' | 'ACTIVE_TASKS' | 'PROVIDER_FAILURE' | 'READINESS_FAILED';

export class PersonalSandboxError extends Error {
  readonly code: PersonalSandboxErrorCode;
  constructor(code: PersonalSandboxErrorCode, message: string) {
    super(message);
    this.name = 'PersonalSandboxError';
    this.code = code;
  }
}

export interface PersonalSandboxOptions {
  client: Daytona;
  repository: CorrelationRepository;
  /** An explicitly provisioned official Daytona snapshot; contains the real CLI/Daemon tooling. */
  snapshot: string;
  timeoutSeconds?: number;
  /** Required, idempotent: verify real Daemon registration, both CLI configs and working directory. */
  ensureExecutionReady: (sandbox: Sandbox, userId: string) => Promise<void>;
}

/** Thin official SDK lifecycle adapter. It does not create a runner or execute platform tasks. */
export class PersonalSandboxService {
  private readonly options: PersonalSandboxOptions;
  private readonly timeoutSeconds: number;
  // Coordinates network operations in this service instance only. SQLite remains authoritative.
  private readonly operations = new Map<string, Promise<void>>();

  constructor(options: PersonalSandboxOptions) {
    if (!options.snapshot?.trim() || options.snapshot !== options.snapshot.trim()) throw new Error('An explicit Daytona snapshot is required');
    this.timeoutSeconds = options.timeoutSeconds ?? 60;
    if (!Number.isFinite(this.timeoutSeconds) || this.timeoutSeconds <= 0) throw new Error('timeoutSeconds must be positive and finite');
    if (typeof options.ensureExecutionReady !== 'function') throw new Error('A real execution readiness check is required');
    this.options = options;
  }

  private serialize<T>(userId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(userId) ?? Promise.resolve();
    const result = previous.then(operation);
    const settled = result.then(() => undefined, () => undefined);
    this.operations.set(userId, settled);
    void settled.then(() => { if (this.operations.get(userId) === settled) this.operations.delete(userId); });
    // The SDK's read methods have long internal HTTP timeouts. Bound the caller's
    // wait while retaining this actual operation in the per-user chain until it
    // finishes. A timeout never releases a second create/start/stop attempt.
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new PersonalSandboxError('LIFECYCLE_PENDING',
        'Sandbox operation exceeded the response deadline; its persisted intent must be reconciled')), this.timeoutSeconds * 1000);
      timer.unref();
      result.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
    });
  }

  ensurePersonalSandbox(userId: string): Promise<Sandbox> {
    return this.serialize(userId, async () => {
      const reservation = this.options.repository.reserveSandbox(userId, randomUUID());
      if (reservation.created) return this.createReserved(reservation.binding);
      const binding = reservation.binding;
      if (!binding.sandboxId) return this.reconcileCreation(binding);
      if (binding.state === 'paused' || binding.state === 'resuming') return this.resumeBound(binding);
      if (binding.state === 'pausing') {
        const sandbox = await this.getOwned(binding);
        if (sandbox.state !== 'stopped' && sandbox.state !== 'archived') {
          throw new PersonalSandboxError('LIFECYCLE_PENDING', 'Previous sandbox stop has not been confirmed; task admission remains closed');
        }
        if (!this.options.repository.completeSandboxPause(userId)) throw this.lifecycleConflict();
        return this.resumeBound(this.options.repository.getSandbox(userId)!);
      }
      const sandbox = await this.getOwned(binding);
      await this.checkExecutionReady(sandbox, userId);
      return sandbox;
    });
  }

  private async createReserved(binding: SandboxBinding): Promise<Sandbox> {
    let sandbox: Sandbox;
    try {
      sandbox = await this.options.client.create({
        user: 'daytona',
        snapshot: this.options.snapshot,
        labels: this.labels(binding),
        public: false,
        autoStopInterval: 0,
        autoArchiveInterval: 0,
        autoDeleteInterval: -1,
      }, { timeout: this.timeoutSeconds });
    } catch (error) {
      // Daytona's ordinary 4xx validation responses prove that no Sandbox was
      // committed. Release only that never-bound reservation so capacity or
      // input problems can be fixed and retried. Timeouts, 409/408/429 and 5xx
      // remain unknown because the provider may have accepted the create.
      if (error instanceof DaytonaError && typeof error.statusCode === 'number'
        && error.statusCode >= 400 && error.statusCode < 500
        && ![408, 409, 425, 429].includes(error.statusCode)) {
        if (!this.options.repository.rejectSandboxCreation(binding.userId, binding.creationRequestId, `daytona-http-${String(error.statusCode)}`)) {
          throw new PersonalSandboxError('OWNERSHIP_CONFLICT', 'Sandbox reservation changed while recording a definitive provider rejection');
        }
        throw new PersonalSandboxError('PROVIDER_FAILURE', 'Daytona definitively rejected sandbox creation; the request may be retried after the provider issue is fixed');
      }
      this.options.repository.markSandboxCreationUnknown(binding.userId, binding.creationRequestId);
      // SDK errors may carry request headers. Do not expose their raw objects through the Gateway.
      throw new PersonalSandboxError('CREATION_UNKNOWN', 'Daytona creation did not return a confirmed result; reconcile the persisted creation ID before retrying');
    }
    return this.bindCreated(binding, sandbox);
  }

  private async reconcileCreation(binding: SandboxBinding): Promise<Sandbox> {
    const matches: Sandbox[] = [];
    try {
      for await (const sandbox of this.options.client.list({ labels: this.labels(binding) })) {
        this.assertOwner(binding, sandbox);
        matches.push(sandbox);
        if (matches.length > 1) break;
      }
    } catch (error) {
      if (error instanceof PersonalSandboxError) throw error;
      throw new PersonalSandboxError('PROVIDER_FAILURE', 'Cannot reconcile the existing Daytona creation intent');
    }
    if (matches.length > 1) throw new PersonalSandboxError('OWNERSHIP_CONFLICT', 'Multiple sandboxes match one user creation intent; manual reconciliation is required');
    if (matches.length === 0) {
      this.options.repository.markSandboxCreationUnknown(binding.userId, binding.creationRequestId);
      throw new PersonalSandboxError('CREATION_UNKNOWN', 'No confirmed sandbox for the persisted creation intent; a new create request is not permitted');
    }
    // list() yields abbreviated DTOs. get() retrieves full current state before adoption.
    let sandbox: Sandbox;
    try { sandbox = await this.options.client.get(matches[0].id); }
    catch { throw new PersonalSandboxError('PROVIDER_FAILURE', 'Cannot read the sandbox found during creation reconciliation'); }
    return this.bindCreated(binding, sandbox);
  }

  private async bindCreated(binding: SandboxBinding, sandbox: Sandbox): Promise<Sandbox> {
    this.assertOwner(binding, sandbox);
    await this.checkExecutionReady(sandbox, binding.userId);
    if (!this.options.repository.completeSandboxCreation(binding.userId, binding.creationRequestId, sandbox.id)) {
      const current = this.options.repository.getSandbox(binding.userId);
      if (current?.state !== 'ready' || current.sandboxId !== sandbox.id || current.creationRequestId !== binding.creationRequestId) {
        throw new PersonalSandboxError('OWNERSHIP_CONFLICT', 'Personal sandbox binding changed during creation reconciliation');
      }
    }
    return sandbox;
  }

  /** MVP pause is official stop(), retaining disk, not freezing active processes or retaining RAM. */
  pausePersonalSandbox(userId: string): Promise<void> {
    return this.serialize(userId, async () => {
      const binding = this.options.repository.getSandbox(userId);
      if (!binding?.sandboxId) throw new PersonalSandboxError('NOT_READY', 'No bound personal sandbox to stop');
      const sandbox = await this.getOwned(binding);
      if (binding.state === 'paused' && (sandbox.state === 'stopped' || sandbox.state === 'archived')) return;
      if (binding.state === 'pausing') {
        if (sandbox.state === 'stopped' || sandbox.state === 'archived') {
          if (!this.options.repository.completeSandboxPause(userId)) throw this.lifecycleConflict();
          return;
        }
        throw new PersonalSandboxError('LIFECYCLE_PENDING', 'Previous stop outcome is still unconfirmed');
      }
      if (binding.state !== 'ready') throw this.lifecycleConflict();
      if (!this.options.repository.beginSandboxPause(userId)) {
        throw new PersonalSandboxError('ACTIVE_TASKS', 'Sandbox stop denied: an active task or concurrent lifecycle transition exists');
      }
      try { await sandbox.stop(this.timeoutSeconds); }
      catch { throw new PersonalSandboxError('LIFECYCLE_PENDING', 'Daytona stop result is unknown; task admission remains closed'); }
      if (sandbox.state !== 'stopped' && sandbox.state !== 'archived') {
        throw new PersonalSandboxError('LIFECYCLE_PENDING', 'Daytona did not confirm the sandbox stopped');
      }
      if (!this.options.repository.completeSandboxPause(userId)) throw this.lifecycleConflict();
    });
  }

  resumePersonalSandbox(userId: string): Promise<Sandbox> {
    return this.serialize(userId, async () => {
      const binding = this.options.repository.getSandbox(userId);
      if (!binding?.sandboxId) throw new PersonalSandboxError('NOT_READY', 'No bound personal sandbox to start');
      if (binding.state === 'ready') {
        const sandbox = await this.getOwned(binding);
        await this.checkExecutionReady(sandbox, userId);
        return sandbox;
      }
      return this.resumeBound(binding);
    });
  }

  private async resumeBound(binding: SandboxBinding): Promise<Sandbox> {
    if (binding.state !== 'paused' && binding.state !== 'resuming') throw this.lifecycleConflict();
    const sandbox = await this.getOwned(binding);
    if (binding.state === 'paused') {
      if (!this.options.repository.beginSandboxResume(binding.userId)) throw this.lifecycleConflict();
      try { await sandbox.start(this.timeoutSeconds); }
      catch { throw new PersonalSandboxError('LIFECYCLE_PENDING', 'Daytona start result is unknown; task admission remains closed'); }
    } else if (sandbox.state !== 'started') {
      // A previous start may still be in flight; never repeatedly send start based on a timeout.
      throw new PersonalSandboxError('LIFECYCLE_PENDING', 'Previous start has not reached confirmed started state');
    }
    await this.checkExecutionReady(sandbox, binding.userId);
    if (!this.options.repository.completeSandboxResume(binding.userId)) throw this.lifecycleConflict();
    return sandbox;
  }

  private labels(binding: SandboxBinding): Record<string, string> {
    return { [PERSONAL_SANDBOX_LABELS.user]: binding.userId, [PERSONAL_SANDBOX_LABELS.creation]: binding.creationRequestId };
  }

  private assertOwner(binding: SandboxBinding, sandbox: Sandbox): void {
    if ((binding.sandboxId && sandbox.id !== binding.sandboxId) ||
        sandbox.labels?.[PERSONAL_SANDBOX_LABELS.user] !== binding.userId ||
        sandbox.labels?.[PERSONAL_SANDBOX_LABELS.creation] !== binding.creationRequestId) {
      throw new PersonalSandboxError('OWNERSHIP_CONFLICT', 'Daytona sandbox identity does not match its persisted user and creation labels');
    }
  }

  private async getOwned(binding: SandboxBinding): Promise<Sandbox> {
    let sandbox: Sandbox;
    try { sandbox = await this.options.client.get(binding.sandboxId!); }
    catch { throw new PersonalSandboxError('PROVIDER_FAILURE', 'Bound Daytona sandbox is unavailable; automatic replacement is disabled'); }
    this.assertOwner(binding, sandbox);
    return sandbox;
  }

  private async checkExecutionReady(sandbox: Sandbox, userId: string): Promise<void> {
    if (sandbox.state !== 'started') throw new PersonalSandboxError('NOT_READY', 'Daytona sandbox is not in started state');
    try {
      if (sandbox.autoStopInterval !== 0) await sandbox.setAutostopInterval(0);
      if (sandbox.autoDeleteInterval !== -1) await sandbox.setAutoDeleteInterval(-1);
    } catch { throw new PersonalSandboxError('PROVIDER_FAILURE', 'Cannot disable automatic sandbox stop/delete before task admission'); }
    try { await this.options.ensureExecutionReady(sandbox, userId); }
    catch { throw new PersonalSandboxError('READINESS_FAILED', 'Sandbox is started but real Multica Daemon, CLI or workspace readiness failed'); }
  }

  private lifecycleConflict(): PersonalSandboxError {
    return new PersonalSandboxError('LIFECYCLE_PENDING', 'Personal sandbox lifecycle state changed; reconcile before continuing');
  }
}
