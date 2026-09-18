import { DatabaseSync } from 'node:sqlite';

export type SandboxState = 'creating' | 'creation_unknown' | 'ready' | 'pausing' | 'paused' | 'resuming';
export interface SandboxBinding {
  userId: string;
  creationRequestId: string;
  sandboxId: string | null;
  state: SandboxState;
  updatedAt: string;
}
export type TaskState = 'reserved' | 'submission_unknown' | 'submitted' | 'queued' | 'running' | 'cancel_requested' | 'completed' | 'failed' | 'cancelled';
export interface ExecutionSegment {
  segmentId: string;
  userId: string;
  dshSessionId: string;
  ordinal: number;
  runtime: 'codex' | 'claude-code';
  externalSessionId: string | null;
}
export interface TaskIntent {
  requestId: string;
  userId: string;
  segmentId: string;
  sandboxId: string;
  /** Digest of the submitted logical command, not prompt contents. */
  inputDigest: string;
  externalTaskId: string | null;
  state: TaskState;
  updatedAt: string;
}
export interface ReserveTaskInput {
  requestId: string;
  userId: string;
  segmentId: string;
  inputDigest: string;
}
export interface SegmentExecutionResources {
  segmentId: string;
  daemonId: string;
  agentId: string;
  runtimeId: string;
  projectId: string;
  chatSessionId: string;
  workDir: string;
}
export interface SelectedRuntimeTarget {
  runtime: ExecutionSegment['runtime'];
  runtimeId: string | null;
  daemonId: string | null;
  label: string | null;
}
export interface StoredSubmission {
  requestId: string;
  chatSessionId: string;
  marker: string;
  content: string;
}
export interface SandboxReplacementAudit {
  userId: string; creationRequestId: string; deletedSandboxId: string; deletionEvidence: string; recordedAt: string;
}

const activeStates: readonly TaskState[] = ['reserved', 'submission_unknown', 'submitted', 'queued', 'running', 'cancel_requested'];
const allowedTransitions: Record<TaskState, readonly TaskState[]> = {
  reserved: ['submission_unknown', 'failed'],
  submission_unknown: ['failed'],
  submitted: ['queued', 'running', 'cancel_requested', 'completed', 'failed', 'cancelled'],
  queued: ['running', 'cancel_requested', 'completed', 'failed', 'cancelled'],
  running: ['cancel_requested', 'completed', 'failed', 'cancelled'],
  cancel_requested: ['completed', 'failed', 'cancelled'],
  completed: [], failed: [], cancelled: [],
};

function identifier(value: string, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.trim() !== value || value.length > 512 || /[\u0000-\u001f]/u.test(value)) {
    throw new Error(`${field} must be a non-empty identifier`);
  }
  return value;
}
function now(): string { return new Date().toISOString(); }

/** Only external correlation records; DSH retains authoritative sessions and trajectories. */
export class CorrelationRepository {
  private readonly db: DatabaseSync;

  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    try {
      this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
      const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
      if (![0, 1, 2, 3, 4, 5].includes(version)) throw new Error('Unsupported correlation database schema version');
      if (version > 0 && version < 5) {
        if (this.hasTable('execution_segments')) this.migrateExecutionSegmentsToSharedChatSessions();
        else {
          // Early schema revisions could contain only the auxiliary tables;
          // let the idempotent schema block below create the missing tables.
          this.db.exec('PRAGMA user_version = 0;');
        }
      }
      this.transaction(() => {
        const currentVersion = Number(this.db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
        if (currentVersion !== 0 && currentVersion !== 5) throw new Error('Unsupported correlation database schema version');
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS sandbox_bindings (
            userId TEXT PRIMARY KEY,
            creationRequestId TEXT NOT NULL UNIQUE,
            sandboxId TEXT UNIQUE,
            state TEXT NOT NULL CHECK(state IN ('creating','creation_unknown','ready','pausing','paused','resuming')),
            updatedAt TEXT NOT NULL,
            CHECK ((state IN ('creating','creation_unknown') AND sandboxId IS NULL) OR
                   (state IN ('ready','pausing','paused','resuming') AND sandboxId IS NOT NULL))
          ) STRICT;
          CREATE TABLE IF NOT EXISTS execution_segments (
            segmentId TEXT PRIMARY KEY,
            userId TEXT NOT NULL REFERENCES sandbox_bindings(userId),
            dshSessionId TEXT NOT NULL,
            ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
            runtime TEXT NOT NULL CHECK(runtime IN ('codex','claude-code')),
            -- A DSH session may reuse the same Multica Chat Session across
            -- multiple local runtime segments. Ownership is checked when a
            -- binding is completed instead of enforcing global uniqueness.
            externalSessionId TEXT,
            UNIQUE(userId,dshSessionId,ordinal)
          ) STRICT;
          CREATE TABLE IF NOT EXISTS task_intents (
            requestId TEXT PRIMARY KEY,
            userId TEXT NOT NULL REFERENCES sandbox_bindings(userId),
            segmentId TEXT NOT NULL REFERENCES execution_segments(segmentId),
            sandboxId TEXT NOT NULL,
            inputDigest TEXT NOT NULL,
            externalTaskId TEXT UNIQUE,
            state TEXT NOT NULL CHECK(state IN ('reserved','submission_unknown','submitted','queued','running','cancel_requested','completed','failed','cancelled')),
            updatedAt TEXT NOT NULL
          ) STRICT;
          CREATE INDEX IF NOT EXISTS task_intents_user_state ON task_intents(userId,state);
          CREATE TABLE IF NOT EXISTS submission_rejections (
            requestId TEXT PRIMARY KEY REFERENCES task_intents(requestId),
            reference TEXT NOT NULL
          ) STRICT;
          CREATE TABLE IF NOT EXISTS segment_provisioning (
            segmentId TEXT PRIMARY KEY REFERENCES execution_segments(segmentId),
            state TEXT NOT NULL CHECK(state IN ('provisioning','unknown','ready')),
            resources TEXT
          ) STRICT;
          CREATE TABLE IF NOT EXISTS task_submissions (
            requestId TEXT PRIMARY KEY REFERENCES task_intents(requestId),
            chatSessionId TEXT NOT NULL,
            marker TEXT NOT NULL,
            content TEXT NOT NULL
          ) STRICT;
          CREATE TABLE IF NOT EXISTS task_sync_positions (
            requestId TEXT PRIMARY KEY REFERENCES task_intents(requestId),
            sequence INTEGER NOT NULL CHECK(sequence >= 0)
          ) STRICT;
          CREATE TABLE IF NOT EXISTS runtime_selections (
            dshSessionId TEXT PRIMARY KEY,
            userId TEXT NOT NULL,
            runtime TEXT NOT NULL CHECK(runtime IN ('codex','claude-code')),
            runtimeId TEXT,
            daemonId TEXT,
            label TEXT
          ) STRICT;
          CREATE TABLE IF NOT EXISTS sandbox_replacements (
            userId TEXT NOT NULL,
            creationRequestId TEXT PRIMARY KEY,
            deletedSandboxId TEXT NOT NULL UNIQUE,
            deletionEvidence TEXT NOT NULL,
            recordedAt TEXT NOT NULL
          ) STRICT;
          CREATE TABLE IF NOT EXISTS sandbox_creation_rejections (
            userId TEXT NOT NULL,
            creationRequestId TEXT PRIMARY KEY,
            reason TEXT NOT NULL,
            recordedAt TEXT NOT NULL
          ) STRICT;
          PRAGMA user_version = 5;
        `);
        // v5 databases created before multi-Daemon selection have the three
        // optional columns absent. Add them idempotently without changing the
        // official Multica correlation data or schema version.
        this.ensureColumn('runtime_selections', 'runtimeId', 'TEXT');
        this.ensureColumn('runtime_selections', 'daemonId', 'TEXT');
        this.ensureColumn('runtime_selections', 'label', 'TEXT');
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private hasTable(name: string): boolean {
    return this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
  }

  private ensureColumn(table: string, column: string, type: string): void {
    const present = this.db.prepare(`PRAGMA table_info(${table})`).all().some((row: any) => row.name === column);
    if (!present) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }

  /**
   * Schema v4 assumed one external Chat Session per execution segment. The
   * Multica-backed model reuses one Chat Session for every runtime segment in
   * a DSH session, so rebuild that table without the global UNIQUE constraint.
   * Foreign keys are disabled only for this atomic table rebuild; all normal
   * repository operations keep them enabled.
   */
  private migrateExecutionSegmentsToSharedChatSessions(): void {
    this.db.exec('PRAGMA foreign_keys = OFF;');
    try {
      this.db.exec('BEGIN IMMEDIATE;');
      this.db.exec(`
        CREATE TABLE execution_segments_v5 (
          segmentId TEXT PRIMARY KEY,
          userId TEXT NOT NULL REFERENCES sandbox_bindings(userId),
          dshSessionId TEXT NOT NULL,
          ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
          runtime TEXT NOT NULL CHECK(runtime IN ('codex','claude-code')),
          externalSessionId TEXT,
          UNIQUE(userId,dshSessionId,ordinal)
        ) STRICT;
        INSERT INTO execution_segments_v5 (segmentId, userId, dshSessionId, ordinal, runtime, externalSessionId)
          SELECT segmentId, userId, dshSessionId, ordinal, runtime, externalSessionId FROM execution_segments;
        DROP TABLE execution_segments;
        ALTER TABLE execution_segments_v5 RENAME TO execution_segments;
        PRAGMA user_version = 5;
      `);
      this.db.exec('COMMIT;');
    } catch (error) {
      try { this.db.exec('ROLLBACK;'); } catch { /* preserve the migration error */ }
      throw error;
    } finally {
      this.db.exec('PRAGMA foreign_keys = ON;');
    }
  }

  close(): void { this.db.close(); }

  /** Explicit operator repair ONLY after official deletion and GET 404 of an empty failed, never-bound sandbox. */
  clearUnboundSandboxAfterVerifiedDeletion(input: Omit<SandboxReplacementAudit, 'recordedAt'>): boolean {
    for (const key of ['userId', 'creationRequestId', 'deletedSandboxId', 'deletionEvidence'] as const) identifier(input[key], key);
    return this.transaction(() => {
      const binding = this.getSandbox(input.userId);
      if (!binding || binding.creationRequestId !== input.creationRequestId || binding.sandboxId !== null || binding.state !== 'creation_unknown') return false;
      if (this.db.prepare('SELECT 1 FROM execution_segments WHERE userId = ? LIMIT 1').get(input.userId) ||
          this.db.prepare('SELECT 1 FROM task_intents WHERE userId = ? LIMIT 1').get(input.userId)) throw new Error('Cannot clear a reservation with execution/task references');
      this.db.prepare('INSERT INTO sandbox_replacements VALUES (?, ?, ?, ?, ?)')
        .run(input.userId, input.creationRequestId, input.deletedSandboxId, input.deletionEvidence, now());
      return this.db.prepare("DELETE FROM sandbox_bindings WHERE userId = ? AND creationRequestId = ? AND sandboxId IS NULL AND state = 'creation_unknown'")
        .run(input.userId, input.creationRequestId).changes === 1;
    });
  }

  getSandboxReplacementAudits(userId: string): SandboxReplacementAudit[] {
    return this.db.prepare('SELECT * FROM sandbox_replacements WHERE userId = ? ORDER BY recordedAt').all(userId) as unknown as SandboxReplacementAudit[];
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getSandbox(userId: string): SandboxBinding | undefined {
    return this.db.prepare('SELECT * FROM sandbox_bindings WHERE userId = ?').get(userId) as unknown as SandboxBinding | undefined;
  }

  /** Only created:true grants the caller permission to send ONE create request. No expiry/retry takeover. */
  reserveSandbox(userId: string, creationRequestId: string): { created: boolean; binding: SandboxBinding } {
    identifier(userId, 'userId'); identifier(creationRequestId, 'creationRequestId');
    return this.transaction(() => {
      const existing = this.getSandbox(userId);
      if (existing) return { created: false, binding: existing };
      this.db.prepare("INSERT INTO sandbox_bindings VALUES (?, ?, NULL, 'creating', ?)").run(userId, creationRequestId, now());
      return { created: true, binding: this.getSandbox(userId)! };
    });
  }

  completeSandboxCreation(userId: string, creationRequestId: string, sandboxId: string): boolean {
    identifier(sandboxId, 'sandboxId');
    return this.db.prepare(`UPDATE sandbox_bindings SET sandboxId = ?, state = 'ready', updatedAt = ?
      WHERE userId = ? AND creationRequestId = ? AND state IN ('creating','creation_unknown') AND sandboxId IS NULL`)
      .run(sandboxId, now(), userId, creationRequestId).changes === 1;
  }

  markSandboxCreationUnknown(userId: string, creationRequestId: string): boolean {
    return this.db.prepare(`UPDATE sandbox_bindings SET state = 'creation_unknown', updatedAt = ?
      WHERE userId = ? AND creationRequestId = ? AND state = 'creating'`).run(now(), userId, creationRequestId).changes === 1;
  }

  /** Release only a never-bound reservation after the provider gave a definitive non-commit response. */
  rejectSandboxCreation(userId: string, creationRequestId: string, reason: string): boolean {
    identifier(userId, 'userId'); identifier(creationRequestId, 'creationRequestId'); identifier(reason, 'reason');
    return this.transaction(() => {
      const binding = this.getSandbox(userId);
      if (!binding || binding.creationRequestId !== creationRequestId || binding.sandboxId !== null || binding.state !== 'creating') return false;
      if (this.db.prepare('SELECT 1 FROM execution_segments WHERE userId = ? LIMIT 1').get(userId) ||
          this.db.prepare('SELECT 1 FROM task_intents WHERE userId = ? LIMIT 1').get(userId)) throw new Error('Cannot reject a Sandbox reservation with execution/task references');
      this.db.prepare('INSERT INTO sandbox_creation_rejections VALUES (?, ?, ?, ?)')
        .run(userId, creationRequestId, reason, now());
      return this.db.prepare("DELETE FROM sandbox_bindings WHERE userId = ? AND creationRequestId = ? AND sandboxId IS NULL AND state = 'creating'")
        .run(userId, creationRequestId).changes === 1;
    });
  }

  listSandboxCreationRejections(userId: string): Array<{ userId: string; creationRequestId: string; reason: string; recordedAt: string }> {
    identifier(userId, 'userId');
    return this.db.prepare('SELECT * FROM sandbox_creation_rejections WHERE userId = ? ORDER BY recordedAt').all(userId) as any;
  }

  /** Must be committed before calling Daytona pause. Blocks admission across all connections. */
  beginSandboxPause(userId: string): boolean {
    return this.transaction(() => {
      if (this.listActiveTasks(userId).length > 0) return false;
      return this.db.prepare("UPDATE sandbox_bindings SET state = 'pausing', updatedAt = ? WHERE userId = ? AND state = 'ready'")
        .run(now(), userId).changes === 1;
    });
  }

  completeSandboxPause(userId: string): boolean {
    return this.db.prepare("UPDATE sandbox_bindings SET state = 'paused', updatedAt = ? WHERE userId = ? AND state = 'pausing'")
      .run(now(), userId).changes === 1;
  }

  beginSandboxResume(userId: string): boolean {
    return this.db.prepare("UPDATE sandbox_bindings SET state = 'resuming', updatedAt = ? WHERE userId = ? AND state = 'paused'")
      .run(now(), userId).changes === 1;
  }

  /** Call only after upstream reconciliation AND Daemon/CLI/workdir readiness confirmation. */
  completeSandboxResume(userId: string): boolean {
    return this.db.prepare("UPDATE sandbox_bindings SET state = 'ready', updatedAt = ? WHERE userId = ? AND state = 'resuming'")
      .run(now(), userId).changes === 1;
  }

  /** Failed pause may reopen admission only after positive upstream readiness confirmation. */
  reconcileSandboxReady(userId: string, sandboxId: string): boolean {
    return this.db.prepare(`UPDATE sandbox_bindings SET state = 'ready', updatedAt = ?
      WHERE userId = ? AND sandboxId = ? AND state IN ('pausing','resuming')`).run(now(), userId, sandboxId).changes === 1;
  }

  putExecutionSegment(input: Omit<ExecutionSegment, 'externalSessionId'>): ExecutionSegment {
    identifier(input.segmentId, 'segmentId'); identifier(input.userId, 'userId'); identifier(input.dshSessionId, 'dshSessionId');
    if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 0) throw new Error('ordinal must be a non-negative safe integer');
    if (!['codex', 'claude-code'].includes(input.runtime)) throw new Error('Unsupported runtime');
    return this.transaction(() => {
      const existing = this.getExecutionSegment(input.segmentId);
      if (existing) {
        for (const key of ['userId', 'dshSessionId', 'ordinal', 'runtime'] as const) {
          if (existing[key] !== input[key]) throw new Error('Execution segment identity conflict');
        }
        return existing;
      }
      // One DSH session cannot acquire a different owner through a new execution segment.
      this.getSelectedRuntime(input.userId, input.dshSessionId);
      const owner = this.db.prepare('SELECT userId FROM execution_segments WHERE dshSessionId = ? LIMIT 1').get(input.dshSessionId);
      if (owner && owner.userId !== input.userId) throw new Error('DSH session owner conflict');
      this.db.prepare('INSERT INTO execution_segments VALUES (?, ?, ?, ?, ?, NULL)')
        .run(input.segmentId, input.userId, input.dshSessionId, input.ordinal, input.runtime);
      return this.getExecutionSegment(input.segmentId)!;
    });
  }

  getExecutionSegment(segmentId: string): ExecutionSegment | undefined {
    return this.db.prepare('SELECT * FROM execution_segments WHERE segmentId = ?').get(segmentId) as unknown as ExecutionSegment | undefined;
  }

  getLatestExecutionSegment(userId: string, dshSessionId: string): ExecutionSegment | undefined {
    return this.db.prepare('SELECT * FROM execution_segments WHERE userId = ? AND dshSessionId = ? ORDER BY ordinal DESC LIMIT 1')
      .get(userId, dshSessionId) as unknown as ExecutionSegment | undefined;
  }

  getSelectedRuntime(userId: string, dshSessionId: string): ExecutionSegment['runtime'] | undefined {
    const row = this.db.prepare('SELECT * FROM runtime_selections WHERE dshSessionId = ?').get(dshSessionId) as any;
    if (row && row.userId !== userId) throw new Error('DSH session owner conflict');
    return row?.runtime as ExecutionSegment['runtime'] | undefined;
  }

  getSelectedRuntimeTarget(userId: string, dshSessionId: string): SelectedRuntimeTarget | undefined {
    const row = this.db.prepare('SELECT * FROM runtime_selections WHERE dshSessionId = ?').get(dshSessionId) as any;
    if (row && row.userId !== userId) throw new Error('DSH session owner conflict');
    if (!row) return undefined;
    return { runtime: row.runtime as ExecutionSegment['runtime'], runtimeId: row.runtimeId ?? null,
      daemonId: row.daemonId ?? null, label: row.label ?? null };
  }

  selectRuntime(userId: string, dshSessionId: string, runtime: ExecutionSegment['runtime']): void {
    this.selectRuntimeTarget(userId, dshSessionId, { runtime, runtimeId: null, daemonId: null, label: null });
  }

  selectRuntimeTarget(userId: string, dshSessionId: string, target: SelectedRuntimeTarget): void {
    identifier(userId, 'userId'); identifier(dshSessionId, 'dshSessionId');
    if (!['codex', 'claude-code'].includes(target.runtime)) throw new Error('Unsupported Runtime');
    this.transaction(() => {
      this.getSelectedRuntime(userId, dshSessionId);
      const owner = this.db.prepare('SELECT userId FROM execution_segments WHERE dshSessionId = ? LIMIT 1').get(dshSessionId);
      if (owner && owner.userId !== userId) throw new Error('DSH session owner conflict');
      if (this.listActiveTasks(userId).some(task => this.getExecutionSegment(task.segmentId)?.dshSessionId === dshSessionId)) {
        throw new Error('Cannot select Runtime while this DSH session has an unresolved task');
      }
      this.db.prepare(`INSERT INTO runtime_selections (dshSessionId,userId,runtime,runtimeId,daemonId,label)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(dshSessionId) DO UPDATE SET runtime = excluded.runtime, runtimeId = excluded.runtimeId,
        daemonId = excluded.daemonId, label = excluded.label`)
        .run(dshSessionId, userId, target.runtime, target.runtimeId, target.daemonId, target.label);
    });
  }

  getPreviousExecutionSegment(segmentId: string): ExecutionSegment | undefined {
    return this.db.prepare(`SELECT previous.* FROM execution_segments previous JOIN execution_segments current
      ON previous.userId = current.userId AND previous.dshSessionId = current.dshSessionId AND previous.ordinal < current.ordinal
      WHERE current.segmentId = ? ORDER BY previous.ordinal DESC LIMIT 1`).get(segmentId) as unknown as ExecutionSegment | undefined;
  }

  completeExecutionSegmentBinding(segmentId: string, externalSessionId: string): boolean {
    identifier(externalSessionId, 'externalSessionId');
    return this.transaction(() => this.completeExecutionSegmentBindingWithinTransaction(segmentId, externalSessionId));
  }

  private completeExecutionSegmentBindingWithinTransaction(segmentId: string, externalSessionId: string): boolean {
    const segment = this.getExecutionSegment(segmentId);
    if (!segment) return false;
    const owner = this.db.prepare(`SELECT userId, dshSessionId FROM execution_segments
      WHERE externalSessionId = ? AND segmentId <> ? LIMIT 1`).get(externalSessionId, segmentId) as
      { userId: string; dshSessionId: string } | undefined;
    if (owner && (owner.userId !== segment.userId || owner.dshSessionId !== segment.dshSessionId)) {
      throw new Error('Execution segment external session owner conflict');
    }
    return this.db.prepare('UPDATE execution_segments SET externalSessionId = ? WHERE segmentId = ? AND externalSessionId IS NULL')
      .run(externalSessionId, segmentId).changes === 1;
  }

  getTask(requestId: string): TaskIntent | undefined {
    return this.db.prepare('SELECT * FROM task_intents WHERE requestId = ?').get(requestId) as unknown as TaskIntent | undefined;
  }

  hasTasksForSegment(segmentId: string): boolean {
    return this.db.prepare('SELECT 1 FROM task_intents WHERE segmentId = ? LIMIT 1').get(segmentId) !== undefined;
  }

  reserveTask(input: ReserveTaskInput): { created: boolean; task: TaskIntent } {
    identifier(input.requestId, 'requestId'); identifier(input.userId, 'userId'); identifier(input.segmentId, 'segmentId');
    if (!/^[a-f0-9]{64}$/u.test(input.inputDigest)) throw new Error('inputDigest must be a SHA256 hex digest');
    return this.transaction(() => {
      const existing = this.getTask(input.requestId);
      if (existing) {
        if (existing.userId !== input.userId || existing.segmentId !== input.segmentId || existing.inputDigest !== input.inputDigest) {
          throw new Error('Request identity conflict');
        }
        return { created: false, task: existing };
      }
      const segment = this.getExecutionSegment(input.segmentId);
      if (!segment || segment.userId !== input.userId) throw new Error('Execution segment does not belong to user');
      const active = this.listActiveTasks(input.userId);
      const directory = this.getSegmentResources(input.segmentId)?.workDir;
      for (const task of active) {
        const other = this.getExecutionSegment(task.segmentId);
        if (other?.dshSessionId === segment.dshSessionId) throw new Error('DSH session already has an unresolved task');
        if (directory && this.getSegmentResources(task.segmentId)?.workDir === directory) {
          throw new Error('Shared working directory has an unresolved task; use an isolated worktree for concurrent writes');
        }
      }
      const sandbox = this.getSandbox(input.userId);
      if (!sandbox || sandbox.state !== 'ready' || !sandbox.sandboxId) throw new Error('Personal sandbox is not ready for task admission');
      this.db.prepare("INSERT INTO task_intents VALUES (?, ?, ?, ?, ?, NULL, 'reserved', ?)")
        .run(input.requestId, input.userId, input.segmentId, sandbox.sandboxId, input.inputDigest, now());
      return { created: true, task: this.getTask(input.requestId)! };
    });
  }

  markTaskSubmissionUnknown(requestId: string): boolean {
    return this.db.prepare("UPDATE task_intents SET state = 'submission_unknown', updatedAt = ? WHERE requestId = ? AND state = 'reserved'")
      .run(now(), requestId).changes === 1;
  }

  completeTaskSubmission(requestId: string, externalTaskId: string): boolean {
    identifier(externalTaskId, 'externalTaskId');
    return this.db.prepare(`UPDATE task_intents SET externalTaskId = ?, state = 'submitted', updatedAt = ?
      WHERE requestId = ? AND externalTaskId IS NULL AND state IN ('reserved','submission_unknown')`)
      .run(externalTaskId, now(), requestId).changes === 1;
  }

  /** Record positive upstream state evidence. Timeouts/disconnects are not terminal failure evidence. */
  updateTaskState(requestId: string, expectedState: TaskState, nextState: TaskState): boolean {
    if (!allowedTransitions[expectedState]?.includes(nextState)) throw new Error('Invalid task state transition');
    // Ambiguous submissions may only be marked failed by explicit reconciliation API below.
    if ((expectedState === 'reserved' || expectedState === 'submission_unknown') && nextState === 'failed') {
      throw new Error('Unresolved submission needs definitive rejection evidence');
    }
    return this.db.prepare('UPDATE task_intents SET state = ?, updatedAt = ? WHERE requestId = ? AND state = ?')
      .run(nextState, now(), requestId, expectedState).changes === 1;
  }

  /** Only use after a definitive upstream rejection; absence in a list/timeout is insufficient. */
  confirmTaskSubmissionRejected(requestId: string, rejectionReference: string): boolean {
    identifier(rejectionReference, 'rejectionReference');
    // Store the evidence as a small external reference in a dedicated relation, not a trajectory.
    return this.transaction(() => {
      const changed = this.db.prepare(`UPDATE task_intents SET state = 'failed', updatedAt = ?
        WHERE requestId = ? AND state IN ('reserved','submission_unknown') AND externalTaskId IS NULL`).run(now(), requestId).changes === 1;
      if (changed) this.db.prepare('INSERT INTO submission_rejections VALUES (?, ?)').run(requestId, rejectionReference);
      return changed;
    });
  }

  listActiveTasks(userId: string): TaskIntent[] {
    const placeholders = activeStates.map(() => '?').join(',');
    return this.db.prepare(`SELECT * FROM task_intents WHERE userId = ? AND state IN (${placeholders}) ORDER BY requestId`)
      .all(userId, ...activeStates) as unknown as TaskIntent[];
  }

  reserveSegmentProvisioning(segmentId: string): boolean {
    return this.db.prepare("INSERT INTO segment_provisioning VALUES (?, 'provisioning', NULL) ON CONFLICT(segmentId) DO NOTHING")
      .run(segmentId).changes === 1;
  }

  markSegmentProvisioningUnknown(segmentId: string): void {
    this.db.prepare("UPDATE segment_provisioning SET state = 'unknown' WHERE segmentId = ? AND state = 'provisioning'").run(segmentId);
  }

  getSegmentResources(segmentId: string): SegmentExecutionResources | undefined {
    const row = this.db.prepare("SELECT resources FROM segment_provisioning WHERE segmentId = ? AND state = 'ready'").get(segmentId);
    return row ? JSON.parse(String(row.resources)) as SegmentExecutionResources : undefined;
  }

  completeSegmentProvisioning(resources: SegmentExecutionResources): boolean {
    for (const key of ['segmentId', 'daemonId', 'agentId', 'runtimeId', 'projectId', 'chatSessionId', 'workDir'] as const) identifier(resources[key], key);
    if (!resources.workDir.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(resources.workDir)) {
      throw new Error('workDir must be an absolute runtime path');
    }
    return this.transaction(() => {
      const changed = this.db.prepare("UPDATE segment_provisioning SET state = 'ready', resources = ? WHERE segmentId = ? AND state IN ('provisioning','unknown')")
        .run(JSON.stringify(resources), resources.segmentId).changes === 1;
      if (changed && !this.completeExecutionSegmentBindingWithinTransaction(resources.segmentId, resources.chatSessionId)) throw new Error('Execution segment chat binding conflict');
      return changed;
    });
  }

  saveTaskSubmission(submission: StoredSubmission): void {
    this.transaction(() => {
      const previous = this.getTaskSubmission(submission.requestId);
      if (previous) {
        if (previous.chatSessionId !== submission.chatSessionId || previous.marker !== submission.marker || previous.content !== submission.content) throw new Error('Immutable submission payload conflict');
        return;
      }
      this.db.prepare('INSERT INTO task_submissions VALUES (?, ?, ?, ?)')
        .run(submission.requestId, submission.chatSessionId, submission.marker, submission.content);
    });
  }

  getTaskSubmission(requestId: string): StoredSubmission | undefined {
    return this.db.prepare('SELECT * FROM task_submissions WHERE requestId = ?').get(requestId) as unknown as StoredSubmission | undefined;
  }

  getTaskCursor(requestId: string): number {
    return Number(this.db.prepare('SELECT sequence FROM task_sync_positions WHERE requestId = ?').get(requestId)?.sequence ?? 0);
  }

  advanceTaskCursor(requestId: string, expected: number, next: number): boolean {
    if (!Number.isSafeInteger(expected) || !Number.isSafeInteger(next) || expected < 0 || next < expected) throw new Error('Invalid transcript cursor progression');
    return this.transaction(() => {
      if (this.getTaskCursor(requestId) !== expected) return false;
      this.db.prepare('INSERT INTO task_sync_positions VALUES (?, ?) ON CONFLICT(requestId) DO UPDATE SET sequence = excluded.sequence').run(requestId, next);
      return true;
    });
  }
}
