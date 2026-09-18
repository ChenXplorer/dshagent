import { createHash, randomBytes, timingSafeEqual, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { CliKind, RuntimeDescriptor } from '../multica-client/index.ts';

/**
 * Multi-tenant control-plane primitives.  This package owns tenant policy and
 * routing only; DSH remains authoritative for Session/Agent state and
 * Multica remains authoritative for Task/CLI execution.
 */

export type TenantUserStatus = 'active' | 'disabled';
export type TenantHostStatus = 'starting' | 'ready' | 'draining' | 'stopped' | 'failed';
export type DaemonExecutionMode = 'daytona' | 'local' | 'external';

export interface UserPluginManifest {
  id: string;
  /**
   * Optional npm package name managed by DSH Hub.  When present, the DSH
   * profile can resolve the plugin from its profile-local node_modules.
   */
  packageName?: string;
  version: string;
  /**
   * Optional package path or immutable artifact reference staged by the
   * platform.  A manifest must provide either modulePath or packageName.
   */
  modulePath?: string;
  enabled: boolean;
  sha256?: string;
}

export interface UserSkillManifest {
  key: string;
  name: string;
  version: string;
  description: string;
  content: string;
  enabled: boolean;
}

export interface UserProfile {
  userId: string;
  version: number;
  plugins: UserPluginManifest[];
  skills: UserSkillManifest[];
  defaultRuntime: CliKind;
  maxConcurrentSessions: number;
  maxConcurrentTasks: number;
  updatedAt: string;
}

export interface EffectiveProfile extends UserProfile {
  /** System baseline is kept separate so user configuration cannot replace it. */
  systemPlugins: UserPluginManifest[];
  systemSkills: UserSkillManifest[];
  /** Daemon/Runtime choices allowed by the tenant policy. */
  daemons: DaemonRegistration[];
  /** Plugins are loaded by a user Host; skills are refreshed before the next Task. */
  loadMode: { plugins: 'host-start'; skills: 'next-task' };
}

export type DaemonRegistrationStatus = 'configured' | 'online' | 'offline' | 'revoked';
export interface DaemonRegistration {
  id: string;
  userId: string;
  label: string;
  daemonId: string;
  workspaceId: string;
  runtimeIds: string[];
  /** Path as seen by the selected Daemon; external means no local mkdir. */
  workspacesRoot: string;
  executionMode: DaemonExecutionMode;
  endpoint?: string;
  managed: boolean;
  status: DaemonRegistrationStatus;
  createdAt: string;
  updatedAt: string;
}
export type DaemonRegistrationInput = Omit<DaemonRegistration, 'id' | 'createdAt' | 'updatedAt' | 'workspacesRoot' | 'executionMode'> & {
  id?: string;
  workspacesRoot?: string;
  executionMode?: DaemonExecutionMode;
};

export interface TenantSessionRecord {
  userId: string;
  sessionId: string;
  hostUserId: string;
  status: 'active' | 'closed';
  createdAt: string;
  updatedAt: string;
}

export interface TenantHostRecord {
  userId: string;
  profileVersion: number;
  status: TenantHostStatus;
  hostUrl: string | null;
  updatedAt: string;
}

export type TenantSandboxState = 'creating' | 'ready' | 'paused' | 'failed';
export interface TenantSandboxRecord {
  userId: string;
  provider: 'daytona' | 'local' | 'external';
  sandboxId: string | null;
  state: TenantSandboxState;
  updatedAt: string;
}

export interface TenantAuditRecord {
  id: string;
  userId: string;
  action: string;
  target: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface TenantHubProfileTarget {
  userId: string;
  nodeId: string;
  runtimeId: string;
  assignedAt: string;
}

export interface CreateTenantUserInput {
  id?: string;
  email: string;
  token?: string;
  defaultRuntime?: CliKind;
}

export interface CreatedTenantUser {
  user: { id: string; email: string; status: TenantUserStatus; createdAt: string; updatedAt: string };
  /** Returned once at creation; only its hash is stored. */
  token: string;
}

export interface TenantUserSummary {
  id: string;
  email: string;
  status: TenantUserStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ProfilePatch {
  plugins?: UserPluginManifest[];
  defaultRuntime?: CliKind;
  maxConcurrentSessions?: number;
  maxConcurrentTasks?: number;
}

/** IDs owned by DSH/the platform. A tenant Plugin may not shadow them. */
const RESERVED_PLUGIN_IDS = new Set([
  'agent-loop', 'mvp-multica-loop', 'session-persistence-jsonl', 'session-title-llm',
  'ui-model-selection', 'ui-settings-models', 'mvp-runtime-selector',
]);

function text(value: unknown, field: string, max = 512): string {
  if (typeof value !== 'string' || !value.trim() || value.trim() !== value || value.length > max || /[\u0000-\u001f]/u.test(value)) {
    throw new Error(`${field} must be a non-empty trimmed string`);
  }
  return value;
}

function userId(value: unknown): string {
  const result = text(value, 'userId', 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(result)) throw new Error('userId contains unsupported characters');
  return result;
}

function email(value: unknown): string {
  const result = text(value, 'email', 320);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(result)) throw new Error('email is invalid');
  return result;
}

function cli(value: unknown, field = 'runtime'): CliKind {
  if (value !== 'codex' && value !== 'claude-code') throw new Error(`${field} must be codex or claude-code`);
  return value;
}

function positiveInt(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`${field} must be an integer from ${min} to ${max}`);
  return value as number;
}

function now(): string { return new Date().toISOString(); }
function hashToken(token: string): Buffer { return createHash('sha256').update(token).digest(); }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

function plugin(value: unknown): UserPluginManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('plugin must be an object');
  const row = value as Record<string, unknown>;
  const packageName = row.packageName === undefined ? undefined : text(row.packageName, 'plugin.packageName', 214);
  if (packageName !== undefined && !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(packageName)) {
    throw new Error('plugin.packageName must be a valid npm package name');
  }
  const modulePath = row.modulePath === undefined ? undefined : text(row.modulePath, 'plugin.modulePath', 2048);
  if (packageName === undefined && modulePath === undefined) throw new Error('plugin requires packageName or modulePath');
  const version = text(row.version, 'plugin.version', 128);
  if (packageName !== undefined && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(version)) {
    throw new Error('plugin.version must be an exact SemVer when packageName is used');
  }
  const result: UserPluginManifest = {
    id: text(row.id, 'plugin.id', 128),
    ...(packageName === undefined ? {} : { packageName }),
    version,
    ...(modulePath === undefined ? {} : { modulePath }), enabled: row.enabled !== false,
    ...(row.sha256 === undefined ? {} : { sha256: text(row.sha256, 'plugin.sha256', 128) }),
  };
  if (result.modulePath?.includes('..')) throw new Error('plugin.modulePath cannot contain parent traversal');
  return result;
}

function skill(value: unknown): UserSkillManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('skill must be an object');
  const row = value as Record<string, unknown>;
  const content = text(row.content, 'skill.content', 256 * 1024);
  return {
    key: text(row.key, 'skill.key', 128), name: text(row.name, 'skill.name', 128),
    version: text(row.version, 'skill.version', 128), description: typeof row.description === 'string' ? row.description : '',
    content, enabled: row.enabled !== false,
  };
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try { return JSON.parse(value) as T; } catch { throw new Error('Stored tenant JSON is corrupt'); }
}

/** SQLite-backed control-plane store. It stores metadata and policy, never CLI transcripts or project files. */
export class TenantRepository {
  private readonly db: DatabaseSync;

  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    try {
      this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
      const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
      if (![0, 1, 2, 3, 4].includes(version)) throw new Error('Unsupported tenant database schema version');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS tenant_users (
          id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, status TEXT NOT NULL CHECK(status IN ('active','disabled')),
          token_hash BLOB NOT NULL UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS tenant_profiles (
          user_id TEXT PRIMARY KEY REFERENCES tenant_users(id) ON DELETE CASCADE, version INTEGER NOT NULL CHECK(version > 0),
          plugins TEXT NOT NULL, skills TEXT NOT NULL, default_runtime TEXT NOT NULL CHECK(default_runtime IN ('codex','claude-code')),
          max_concurrent_sessions INTEGER NOT NULL CHECK(max_concurrent_sessions > 0), max_concurrent_tasks INTEGER NOT NULL CHECK(max_concurrent_tasks > 0),
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS tenant_profile_revisions (
          user_id TEXT NOT NULL REFERENCES tenant_users(id) ON DELETE CASCADE, version INTEGER NOT NULL CHECK(version > 0),
          profile TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(user_id, version)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS tenant_daemons (
          id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES tenant_users(id) ON DELETE CASCADE,
          label TEXT NOT NULL, daemon_id TEXT NOT NULL, workspace_id TEXT NOT NULL, runtime_ids TEXT NOT NULL,
          workspaces_root TEXT NOT NULL DEFAULT '/workspace', execution_mode TEXT NOT NULL DEFAULT 'external' CHECK(execution_mode IN ('daytona','local','external')),
          endpoint TEXT, managed INTEGER NOT NULL CHECK(managed IN (0,1)), status TEXT NOT NULL CHECK(status IN ('configured','online','offline','revoked')),
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(user_id, daemon_id)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS tenant_sessions (
          session_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES tenant_users(id) ON DELETE CASCADE,
          host_user_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','closed')),
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS tenant_hosts (
          user_id TEXT PRIMARY KEY REFERENCES tenant_users(id) ON DELETE CASCADE,
          profile_version INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('starting','ready','draining','stopped','failed')),
          host_url TEXT, updated_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS tenant_sandboxes (
          user_id TEXT PRIMARY KEY REFERENCES tenant_users(id) ON DELETE CASCADE,
          provider TEXT NOT NULL CHECK(provider IN ('daytona','local','external')),
          sandbox_id TEXT UNIQUE, state TEXT NOT NULL CHECK(state IN ('creating','ready','paused','failed')),
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS tenant_audit (
          id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES tenant_users(id) ON DELETE CASCADE,
          action TEXT NOT NULL, target TEXT NOT NULL, metadata TEXT NOT NULL, created_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS tenant_hub_profile_targets (
          user_id TEXT PRIMARY KEY REFERENCES tenant_users(id) ON DELETE CASCADE,
          node_id TEXT NOT NULL, runtime_id TEXT NOT NULL, assigned_at TEXT NOT NULL,
          UNIQUE(node_id, runtime_id)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS tenant_sessions_user ON tenant_sessions(user_id);
        CREATE INDEX IF NOT EXISTS tenant_audit_user_time ON tenant_audit(user_id, created_at);
        CREATE INDEX IF NOT EXISTS tenant_hub_targets_node ON tenant_hub_profile_targets(node_id);
        PRAGMA user_version = 4;
      `);
      if (version === 1) {
        // v1 deployments predate runtime directory metadata. The defaults
        // preserve the old registration semantics until the user edits it.
        const columns = (this.db.prepare('PRAGMA table_info(tenant_daemons)').all() as Array<{ name?: string }>).map(column => column.name);
        if (!columns.includes('workspaces_root')) this.db.exec("ALTER TABLE tenant_daemons ADD COLUMN workspaces_root TEXT NOT NULL DEFAULT '/workspace'");
        if (!columns.includes('execution_mode')) this.db.exec("ALTER TABLE tenant_daemons ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'external'");
        this.db.exec('PRAGMA user_version = 4');
      }
      if (version === 2) {
        // v2 deployments predate explicit Session admission state. Existing
        // records are active so the migration preserves access; closing a
        // Session is an explicit tenant action.
        const columns = (this.db.prepare('PRAGMA table_info(tenant_sessions)').all() as Array<{ name?: string }>).map(column => column.name);
        if (!columns.includes('status')) this.db.exec("ALTER TABLE tenant_sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
        this.db.exec('PRAGMA user_version = 4');
      }
    } catch (error) { this.db.close(); throw error; }
  }

  close(): void { this.db.close(); }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { try { this.db.exec('ROLLBACK'); } catch { /* preserve original */ } throw error; }
  }

  private profileRow(user: string): UserProfile {
    const row = this.db.prepare('SELECT * FROM tenant_profiles WHERE user_id = ?').get(user) as any;
    if (!row) throw new Error(`Unknown tenant ${user}`);
    return {
      userId: row.user_id, version: row.version,
      plugins: parseJson(row.plugins, []), skills: parseJson(row.skills, []),
      defaultRuntime: cli(row.default_runtime), maxConcurrentSessions: row.max_concurrent_sessions,
      maxConcurrentTasks: row.max_concurrent_tasks, updatedAt: row.updated_at,
    };
  }

  createUser(input: CreateTenantUserInput): CreatedTenantUser {
    const id = userId(input.id ?? `user-${randomUUID()}`);
    const mail = email(input.email);
    const token = input.token ?? randomBytes(32).toString('base64url');
    text(token, 'token', 512);
    const runtime = cli(input.defaultRuntime ?? 'codex', 'defaultRuntime');
    const stamp = now();
    const profile: UserProfile = { userId: id, version: 1, plugins: [], skills: [], defaultRuntime: runtime,
      maxConcurrentSessions: 8, maxConcurrentTasks: 4, updatedAt: stamp };
    this.transaction(() => {
      this.db.prepare('INSERT INTO tenant_users VALUES (?, ?, \'active\', ?, ?, ?)').run(id, mail, hashToken(token), stamp, stamp);
      this.db.prepare('INSERT INTO tenant_profiles VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, 1, '[]', '[]', runtime, profile.maxConcurrentSessions, profile.maxConcurrentTasks, stamp);
      this.db.prepare('INSERT INTO tenant_profile_revisions VALUES (?, ?, ?, ?)').run(id, 1, JSON.stringify(profile), stamp);
      this.auditUnsafe(id, 'user.create', id, { email: mail });
    });
    return { user: { id, email: mail, status: 'active', createdAt: stamp, updatedAt: stamp }, token };
  }

  getUser(id: string): CreatedTenantUser['user'] | undefined {
    const row = this.db.prepare('SELECT id,email,status,created_at,updated_at FROM tenant_users WHERE id = ?').get(userId(id)) as any;
    return row ? { id: row.id, email: row.email, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at } : undefined;
  }

  /** Operator-facing inventory; credentials and Profile contents are omitted. */
  listUsers(): TenantUserSummary[] {
    return (this.db.prepare('SELECT id,email,status,created_at,updated_at FROM tenant_users ORDER BY created_at').all() as any[])
      .map(row => ({ id: row.id, email: row.email, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  authenticate(token: string): CreatedTenantUser['user'] | undefined {
    text(token, 'token', 512);
    const digest = hashToken(token);
    const row = this.db.prepare('SELECT id,email,status,token_hash,created_at,updated_at FROM tenant_users').all() as any[];
    for (const candidate of row) {
      const stored = Buffer.from(candidate.token_hash as Uint8Array);
      if (stored.length === digest.length && timingSafeEqual(stored, digest)) {
        if (candidate.status !== 'active') return undefined;
        return { id: candidate.id, email: candidate.email, status: candidate.status, createdAt: candidate.created_at, updatedAt: candidate.updated_at };
      }
    }
    return undefined;
  }

  setUserStatus(id: string, status: TenantUserStatus): void {
    const uid = userId(id); if (status !== 'active' && status !== 'disabled') throw new Error('Invalid user status');
    if (this.db.prepare('UPDATE tenant_users SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), uid).changes !== 1) throw new Error('Unknown tenant');
    this.audit(uid, `user.${status}`, uid, {});
  }

  getHubProfileTarget(id: string): TenantHubProfileTarget | undefined {
    const row = this.db.prepare('SELECT * FROM tenant_hub_profile_targets WHERE user_id = ?').get(userId(id)) as any;
    return row ? { userId: row.user_id, nodeId: row.node_id, runtimeId: row.runtime_id, assignedAt: row.assigned_at } : undefined;
  }

  /** Persist one stable Hub target and enforce the upstream per-node Profile cap. */
  assignHubProfileTarget(id: string, candidates: readonly { nodeId: string; runtimeId: string }[], maxProfilesPerNode = 64): TenantHubProfileTarget {
    const uid = userId(id);
    if (!Number.isInteger(maxProfilesPerNode) || maxProfilesPerNode < 1 || maxProfilesPerNode > 64) throw new Error('Hub node Profile capacity must be between 1 and 64');
    if (!candidates.length) throw new Error('At least one Hub Profile target candidate is required');
    const normalized = candidates.map((candidate, index) => ({
      nodeId: text(candidate.nodeId, `hubTarget[${String(index)}].nodeId`, 64),
      runtimeId: text(candidate.runtimeId, `hubTarget[${String(index)}].runtimeId`, 64),
    }));
    if (new Set(normalized.map(item => item.nodeId)).size !== normalized.length) throw new Error('Hub Profile target candidate nodes must be unique');
    return this.transaction(() => {
      const existing = this.getHubProfileTarget(uid);
      if (existing) {
        if (!normalized.some(item => item.nodeId === existing.nodeId && item.runtimeId === existing.runtimeId)) {
          throw new Error(`Persisted Hub target for ${uid} is absent from the configured shard set`);
        }
        return existing;
      }
      const counts = new Map((this.db.prepare('SELECT node_id, COUNT(*) AS count FROM tenant_hub_profile_targets GROUP BY node_id').all() as any[])
        .map(row => [String(row.node_id), Number(row.count)]));
      const available = normalized.map((target, index) => ({ target, index, count: counts.get(target.nodeId) ?? 0 }))
        .filter(item => item.count < maxProfilesPerNode)
        .sort((left, right) => left.count - right.count || left.index - right.index);
      const selected = available[0]?.target;
      if (!selected) throw new Error('All configured DSH Hub nodes reached their Profile capacity');
      const assignedAt = now();
      this.db.prepare('INSERT INTO tenant_hub_profile_targets (user_id,node_id,runtime_id,assigned_at) VALUES (?, ?, ?, ?)')
        .run(uid, selected.nodeId, selected.runtimeId, assignedAt);
      this.auditUnsafe(uid, 'hub.profile-target.assign', selected.runtimeId, { nodeId: selected.nodeId });
      return { userId: uid, ...selected, assignedAt };
    });
  }

  getProfile(id: string): UserProfile { return clone(this.profileRow(userId(id))); }

  listProfileRevisions(id: string): UserProfile[] {
    const uid = userId(id);
    return (this.db.prepare('SELECT profile FROM tenant_profile_revisions WHERE user_id = ? ORDER BY version').all(uid) as any[])
      .map(row => clone(parseJson(row.profile, {} as UserProfile)));
  }

  updateProfile(id: string, patch: ProfilePatch, expectedVersion?: number): UserProfile {
    const uid = userId(id);
    const normalizedPlugins = patch.plugins === undefined ? undefined : patch.plugins.map(plugin).map(item => {
      if (RESERVED_PLUGIN_IDS.has(item.id)) throw new Error(`Plugin id ${item.id} is reserved by DSH`);
      return item;
    });
    if (normalizedPlugins) {
      const ids = new Set<string>(); const packages = new Set<string>();
      for (const item of normalizedPlugins) {
        if (ids.has(item.id)) throw new Error(`Duplicate user Plugin id ${item.id}`);
        ids.add(item.id);
        if (item.packageName) {
          if (packages.has(item.packageName)) throw new Error(`Duplicate user Plugin package ${item.packageName}`);
          packages.add(item.packageName);
        }
      }
    }
    const normalized: ProfilePatch = {
      ...(normalizedPlugins === undefined ? {} : { plugins: normalizedPlugins }),
      ...(patch.defaultRuntime === undefined ? {} : { defaultRuntime: cli(patch.defaultRuntime, 'defaultRuntime') }),
      ...(patch.maxConcurrentSessions === undefined ? {} : { maxConcurrentSessions: positiveInt(patch.maxConcurrentSessions, 'maxConcurrentSessions', 1, 1000) }),
      ...(patch.maxConcurrentTasks === undefined ? {} : { maxConcurrentTasks: positiveInt(patch.maxConcurrentTasks, 'maxConcurrentTasks', 2, 50) }),
    };
    return this.transaction(() => {
      const current = this.profileRow(uid);
      if (expectedVersion !== undefined && expectedVersion !== current.version) throw new Error(`Profile version conflict; current version is ${current.version}`);
      const next: UserProfile = { ...current, ...normalized, version: current.version + 1, updatedAt: now(),
        plugins: clone(normalized.plugins ?? current.plugins), skills: clone(current.skills) };
      this.writeProfileUnsafe(next);
      this.auditUnsafe(uid, 'profile.update', uid, { fromVersion: current.version, toVersion: next.version });
      return clone(next);
    });
  }

  rollbackProfile(id: string, targetVersion: number, expectedVersion?: number): UserProfile {
    const uid = userId(id); positiveInt(targetVersion, 'targetVersion', 1, Number.MAX_SAFE_INTEGER);
    return this.transaction(() => {
      const current = this.profileRow(uid);
      if (expectedVersion !== undefined && expectedVersion !== current.version) throw new Error(`Profile version conflict; current version is ${current.version}`);
      const row = this.db.prepare('SELECT profile FROM tenant_profile_revisions WHERE user_id = ? AND version = ?').get(uid, targetVersion) as any;
      if (!row) throw new Error(`Unknown Profile revision ${targetVersion}`);
      const target = parseJson(row.profile, {} as UserProfile);
      const next: UserProfile = { ...target, userId: uid, version: current.version + 1, updatedAt: now(), skills: clone(current.skills) };
      this.writeProfileUnsafe(next);
      this.auditUnsafe(uid, 'profile.rollback', uid, { targetVersion, toVersion: next.version });
      return clone(next);
    });
  }

  /** Skill mutations are persisted separately and intentionally do not require Host restart. */
  updateSkills(id: string, skills: UserSkillManifest[]): UserProfile {
    const uid = userId(id); const normalized = skills.map(skill);
    const seen = new Set<string>(); for (const item of normalized) { if (seen.has(item.key)) throw new Error(`Duplicate Skill key ${item.key}`); seen.add(item.key); }
    return this.transaction(() => {
      const current = this.profileRow(uid); const next = { ...current, skills: clone(normalized), updatedAt: now() };
      this.db.prepare('UPDATE tenant_profiles SET skills = ?, updated_at = ? WHERE user_id = ?').run(JSON.stringify(next.skills), next.updatedAt, uid);
      this.auditUnsafe(uid, 'skill.update', uid, { count: next.skills.length, applies: 'next-task' });
      return clone(next);
    });
  }

  private writeProfileUnsafe(profile: UserProfile): void {
    this.db.prepare('UPDATE tenant_profiles SET version = ?, plugins = ?, skills = ?, default_runtime = ?, max_concurrent_sessions = ?, max_concurrent_tasks = ?, updated_at = ? WHERE user_id = ?')
      .run(profile.version, JSON.stringify(profile.plugins), JSON.stringify(profile.skills), profile.defaultRuntime, profile.maxConcurrentSessions, profile.maxConcurrentTasks, profile.updatedAt, profile.userId);
    this.db.prepare('INSERT INTO tenant_profile_revisions VALUES (?, ?, ?, ?)').run(profile.userId, profile.version, JSON.stringify(profile), profile.updatedAt);
  }

  registerDaemon(input: DaemonRegistrationInput): DaemonRegistration {
    const uid = userId(input.userId); const label = text(input.label, 'daemon.label', 128); const daemon = text(input.daemonId, 'daemon.daemonId', 256);
    const workspace = text(input.workspaceId, 'daemon.workspaceId', 256); const ids = [...new Set(input.runtimeIds.map(item => text(item, 'daemon.runtimeId', 256)))];
    if (!ids.length && !input.managed) throw new Error('daemon.runtimeIds must contain at least one Runtime for a user-registered Daemon');
    const workspacesRoot = text(input.workspacesRoot ?? '/workspace', 'daemon.workspacesRoot', 4096);
    const executionMode = input.executionMode ?? 'external';
    if (!['daytona', 'local', 'external'].includes(executionMode)) throw new Error('Invalid daemon execution mode');
    if (executionMode === 'daytona' && (!workspacesRoot.startsWith('/') || workspacesRoot === '/')) throw new Error('Daytona daemon workspacesRoot must be an absolute sandbox path');
    if (executionMode === 'local' && (!workspacesRoot.startsWith('/') && !/^[A-Za-z]:[\\/]/u.test(workspacesRoot))) throw new Error('Local daemon workspacesRoot must be an absolute host path');
    if (executionMode === 'external' && (!workspacesRoot.startsWith('/') && !/^[A-Za-z]:[\\/]/u.test(workspacesRoot))) throw new Error('External daemon workspacesRoot must be absolute');
    const status = input.status; if (!['configured', 'online', 'offline', 'revoked'].includes(status)) throw new Error('Invalid daemon status');
    const id = text(input.id ?? randomUUID(), 'daemon.id', 128); const stamp = now();
    const existing = this.db.prepare('SELECT created_at FROM tenant_daemons WHERE id = ?').get(id) as any;
    if (existing) throw new Error(`Daemon ${id} already exists`);
    this.db.prepare('INSERT INTO tenant_daemons VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, uid, label, daemon, workspace, JSON.stringify(ids), workspacesRoot, executionMode, input.endpoint ?? null, input.managed ? 1 : 0, status, stamp, stamp);
    const result: DaemonRegistration = { id, userId: uid, label, daemonId: daemon, workspaceId: workspace, runtimeIds: ids,
      workspacesRoot, executionMode, ...(input.endpoint ? { endpoint: input.endpoint } : {}), managed: Boolean(input.managed), status, createdAt: stamp, updatedAt: stamp };
    this.audit(uid, 'daemon.register', id, { daemonId: daemon, managed: result.managed });
    return result;
  }

  listDaemons(id: string): DaemonRegistration[] {
    const uid = userId(id);
    return (this.db.prepare('SELECT * FROM tenant_daemons WHERE user_id = ? ORDER BY created_at').all(uid) as any[]).map(row => ({
      id: row.id, userId: row.user_id, label: row.label, daemonId: row.daemon_id, workspaceId: row.workspace_id,
      runtimeIds: parseJson(row.runtime_ids, []), workspacesRoot: row.workspaces_root ?? '/workspace', executionMode: row.execution_mode ?? 'external', ...(row.endpoint ? { endpoint: row.endpoint } : {}), managed: Boolean(row.managed), status: row.status,
      createdAt: row.created_at, updatedAt: row.updated_at,
    }));
  }

  getDaemon(userIdValue: string, id: string): DaemonRegistration | undefined { return this.listDaemons(userIdValue).find(item => item.id === text(id, 'daemon.id', 128)); }

  updateDaemon(userIdValue: string, id: string, patch: Partial<Pick<DaemonRegistration, 'label' | 'runtimeIds' | 'workspacesRoot' | 'executionMode' | 'status'>> & { endpoint?: string | null }): DaemonRegistration {
    const uid = userId(userIdValue); const current = this.getDaemon(uid, id); if (!current) throw new Error('Unknown Daemon registration');
    const next = { ...current, ...(patch.label === undefined ? {} : { label: text(patch.label, 'daemon.label', 128) }),
      ...(patch.runtimeIds === undefined ? {} : { runtimeIds: [...new Set(patch.runtimeIds.map(item => text(item, 'daemon.runtimeId', 256)))] }),
      ...(patch.workspacesRoot === undefined ? {} : { workspacesRoot: text(patch.workspacesRoot, 'daemon.workspacesRoot', 4096) }),
      ...(patch.executionMode === undefined ? {} : { executionMode: patch.executionMode }),
      ...(patch.endpoint === undefined ? {} : { endpoint: patch.endpoint === null ? undefined : text(patch.endpoint, 'daemon.endpoint', 4096) }),
      ...(patch.status === undefined ? {} : { status: patch.status }), updatedAt: now() };
    if (!next.runtimeIds.length && !next.managed) throw new Error('daemon.runtimeIds must contain at least one Runtime for a user-registered Daemon');
    if (!['daytona', 'local', 'external'].includes(next.executionMode)) throw new Error('Invalid daemon execution mode');
    if (next.executionMode === 'daytona' && (!next.workspacesRoot.startsWith('/') || next.workspacesRoot === '/')) throw new Error('Daytona daemon workspacesRoot must be an absolute sandbox path');
    if (next.executionMode !== 'daytona' && (!next.workspacesRoot.startsWith('/') && !/^[A-Za-z]:[\\/]/u.test(next.workspacesRoot))) throw new Error('Daemon workspacesRoot must be absolute');
    if (!['configured', 'online', 'offline', 'revoked'].includes(next.status)) throw new Error('Invalid daemon status');
    this.db.prepare('UPDATE tenant_daemons SET label = ?, runtime_ids = ?, workspaces_root = ?, execution_mode = ?, endpoint = ?, status = ?, updated_at = ? WHERE id = ? AND user_id = ?')
      .run(next.label, JSON.stringify(next.runtimeIds), next.workspacesRoot, next.executionMode, next.endpoint ?? null, next.status, next.updatedAt, next.id, uid);
    this.audit(uid, 'daemon.update', next.id, { status: next.status });
    return next;
  }

  removeDaemon(userIdValue: string, id: string): boolean {
    const uid = userId(userIdValue); const daemon = this.getDaemon(uid, id); if (!daemon) return false;
    const changed = this.db.prepare('DELETE FROM tenant_daemons WHERE user_id = ? AND id = ?').run(uid, daemon.id).changes === 1;
    if (changed) this.audit(uid, 'daemon.remove', daemon.id, {});
    return changed;
  }

  saveSession(userIdValue: string, sessionId: string): TenantSessionRecord {
    const uid = userId(userIdValue); const sid = text(sessionId, 'sessionId', 256); const stamp = now();
    const existing = this.db.prepare('SELECT * FROM tenant_sessions WHERE session_id = ?').get(sid) as any;
    if (existing && existing.user_id !== uid) throw new Error('Session owner conflict');
    if (!existing) this.db.prepare('INSERT INTO tenant_sessions (session_id,user_id,host_user_id,status,created_at,updated_at) VALUES (?, ?, ?, \'active\', ?, ?)').run(sid, uid, uid, stamp, stamp);
    else this.db.prepare("UPDATE tenant_sessions SET status = 'active', updated_at = ? WHERE session_id = ? AND user_id = ?").run(stamp, sid, uid);
    return { userId: uid, sessionId: sid, hostUserId: uid, status: 'active', createdAt: existing?.created_at ?? stamp, updatedAt: stamp };
  }

  /** Mark a known Session as recently used and reopen it after an explicit close. */
  touchSession(userIdValue: string, sessionId: string): TenantSessionRecord {
    const uid = userId(userIdValue); const sid = text(sessionId, 'sessionId', 256); const stamp = now();
    const existing = this.db.prepare('SELECT * FROM tenant_sessions WHERE session_id = ?').get(sid) as any;
    if (!existing || existing.user_id !== uid) throw new Error('Unknown or foreign Session');
    this.db.prepare("UPDATE tenant_sessions SET status = 'active', updated_at = ? WHERE session_id = ? AND user_id = ?").run(stamp, sid, uid);
    return { userId: uid, sessionId: sid, hostUserId: existing.host_user_id, status: 'active', createdAt: existing.created_at, updatedAt: stamp };
  }

  /** Close only the tenant admission record; DSH JSONL remains durable and can be reopened. */
  closeSession(userIdValue: string, sessionId: string): boolean {
    const uid = userId(userIdValue); const sid = text(sessionId, 'sessionId', 256);
    const changed = this.db.prepare("UPDATE tenant_sessions SET status = 'closed', updated_at = ? WHERE session_id = ? AND user_id = ? AND status = 'active'").run(now(), sid, uid).changes === 1;
    if (changed) this.audit(uid, 'session.close', sid, {});
    return changed;
  }

  getSessionOwner(sessionId: string): string | undefined {
    const row = this.db.prepare('SELECT user_id FROM tenant_sessions WHERE session_id = ?').get(text(sessionId, 'sessionId', 256)) as any;
    return row?.user_id;
  }

  countSessions(id: string): number { return Number((this.db.prepare("SELECT COUNT(*) AS count FROM tenant_sessions WHERE user_id = ? AND status = 'active'").get(userId(id)) as any)?.count ?? 0); }

  /** List only this tenant's admission records; DSH remains authoritative for transcript contents. */
  listSessions(id: string, includeClosed = false): TenantSessionRecord[] {
    const uid = userId(id);
    const rows = (includeClosed
      ? this.db.prepare('SELECT * FROM tenant_sessions WHERE user_id = ? ORDER BY updated_at DESC').all(uid)
      : this.db.prepare("SELECT * FROM tenant_sessions WHERE user_id = ? AND status = 'active' ORDER BY updated_at DESC").all(uid)) as any[];
    return rows.map(row => ({ userId: row.user_id, sessionId: row.session_id, hostUserId: row.host_user_id,
      status: row.status, createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  saveHost(record: TenantHostRecord): void {
    const uid = userId(record.userId); const status = record.status; if (!['starting', 'ready', 'draining', 'stopped', 'failed'].includes(status)) throw new Error('Invalid Host status');
    this.db.prepare(`INSERT INTO tenant_hosts (user_id,profile_version,status,host_url,updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET profile_version=excluded.profile_version,status=excluded.status,host_url=excluded.host_url,updated_at=excluded.updated_at`)
      .run(uid, positiveInt(record.profileVersion, 'profileVersion', 1, Number.MAX_SAFE_INTEGER), status, record.hostUrl, record.updatedAt);
  }

  getHost(id: string): TenantHostRecord | undefined {
    const row = this.db.prepare('SELECT * FROM tenant_hosts WHERE user_id = ?').get(userId(id)) as any;
    return row ? { userId: row.user_id, profileVersion: row.profile_version, status: row.status, hostUrl: row.host_url, updatedAt: row.updated_at } : undefined;
  }

  getSandbox(id: string): TenantSandboxRecord | undefined {
    const row = this.db.prepare('SELECT * FROM tenant_sandboxes WHERE user_id = ?').get(userId(id)) as any;
    return row ? { userId: row.user_id, provider: row.provider, sandboxId: row.sandbox_id, state: row.state, updatedAt: row.updated_at } : undefined;
  }

  saveSandbox(record: TenantSandboxRecord): void {
    const uid = userId(record.userId); const provider = record.provider;
    if (!['daytona', 'local', 'external'].includes(provider)) throw new Error('Invalid Sandbox provider');
    if (!['creating', 'ready', 'paused', 'failed'].includes(record.state)) throw new Error('Invalid Sandbox state');
    if ((record.state === 'ready' || record.state === 'paused') && !record.sandboxId) throw new Error('Ready Sandbox requires an id');
    this.db.prepare(`INSERT INTO tenant_sandboxes (user_id,provider,sandbox_id,state,updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET provider=excluded.provider,sandbox_id=excluded.sandbox_id,state=excluded.state,updated_at=excluded.updated_at`)
      .run(uid, provider, record.sandboxId, record.state, record.updatedAt);
  }

  audit(userIdValue: string, action: string, target: string, metadata: Record<string, unknown>): void {
    this.auditUnsafe(userId(userIdValue), text(action, 'audit.action', 128), text(target, 'audit.target', 256), metadata);
  }
  private auditUnsafe(uid: string, action: string, target: string, metadata: Record<string, unknown>): void {
    this.db.prepare('INSERT INTO tenant_audit VALUES (?, ?, ?, ?, ?, ?)').run(randomUUID(), uid, action, target, JSON.stringify(metadata), now());
  }
  listAudit(id: string): TenantAuditRecord[] {
    const uid = userId(id);
    return (this.db.prepare('SELECT * FROM tenant_audit WHERE user_id = ? ORDER BY created_at').all(uid) as any[]).map(row => ({
      id: row.id, userId: row.user_id, action: row.action, target: row.target, metadata: parseJson(row.metadata, {}), createdAt: row.created_at,
    }));
  }
}

export interface ProfileComposerOptions {
  systemPlugins?: readonly UserPluginManifest[];
  systemSkills?: readonly UserSkillManifest[];
}

/** Composes the immutable system baseline with one user's current desired state. */
export class ProfileComposer {
  private readonly systemPlugins: UserPluginManifest[];
  private readonly systemSkills: UserSkillManifest[];
  constructor(private readonly repository: TenantRepository, options: ProfileComposerOptions = {}) {
    this.systemPlugins = (options.systemPlugins ?? []).map(plugin);
    this.systemSkills = (options.systemSkills ?? []).map(skill);
    if (new Set(this.systemPlugins.map(item => item.id)).size !== this.systemPlugins.length) throw new Error('Duplicate system Plugin id');
    if (new Set(this.systemSkills.map(item => item.key)).size !== this.systemSkills.length) throw new Error('Duplicate system Skill key');
  }
  compose(userIdValue: string): EffectiveProfile {
    const profile = this.repository.getProfile(userIdValue);
    const systemPluginIds = new Set(this.systemPlugins.map(item => item.id));
    if (profile.plugins.some(item => systemPluginIds.has(item.id))) throw new Error('User Plugin id conflicts with a system Plugin');
    const pluginIds = new Set<string>();
    const packageNames = new Set<string>();
    for (const item of profile.plugins) {
      if (pluginIds.has(item.id)) throw new Error(`Duplicate user Plugin id ${item.id}`);
      pluginIds.add(item.id);
      if (item.packageName) {
        if (packageNames.has(item.packageName)) throw new Error(`Duplicate user Plugin package ${item.packageName}`);
        packageNames.add(item.packageName);
      }
    }
    const systemSkillKeys = new Set(this.systemSkills.map(item => item.key));
    if (profile.skills.some(item => systemSkillKeys.has(item.key))) throw new Error('User Skill key conflicts with a system Skill');
    return { ...profile, systemPlugins: clone(this.systemPlugins), systemSkills: clone(this.systemSkills), daemons: clone(this.repository.listDaemons(userIdValue)),
      loadMode: { plugins: 'host-start', skills: 'next-task' } };
  }
}

export interface SandboxLease {
  id: string;
  state?: string;
  /** Optional identity of the platform-managed Daemon inside this Sandbox. */
  defaultDaemon?: Omit<DaemonRegistration, 'id' | 'createdAt' | 'updatedAt' | 'userId'>;
}
export interface TenantSandboxManager {
  ensure(userId: string): Promise<SandboxLease>;
}

export interface SandboxProvider {
  readonly provider: TenantSandboxRecord['provider'];
  ensure(userId: string): Promise<SandboxLease>;
  pause?(userId: string, sandboxId: string): Promise<void>;
  resume?(userId: string, sandboxId: string): Promise<void>;
  /** Release provider-side resources owned by the control-plane process. */
  close?(): void | Promise<void>;
  defaultDaemon?(userId: string): Omit<DaemonRegistration, 'id' | 'createdAt' | 'updatedAt' | 'userId' | 'workspacesRoot' | 'executionMode'> & Partial<Pick<DaemonRegistration, 'workspacesRoot' | 'executionMode'>> | undefined;
}

/** Persistence and per-user locking around the real Daytona/Local provider. */
export class PersistentTenantSandboxManager implements TenantSandboxManager {
  private readonly locks = new Map<string, Promise<void>>();
  constructor(private readonly repository: TenantRepository, private readonly provider: SandboxProvider) {}
  private async withLock<T>(user: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(user) ?? Promise.resolve(); let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; }); const queued = previous.then(() => current); this.locks.set(user, queued); await previous;
    try { return await operation(); } finally { release(); if (this.locks.get(user) === queued) this.locks.delete(user); }
  }
  async ensure(userIdValue: string): Promise<SandboxLease> {
    const user = userId(userIdValue);
    return this.withLock(user, async () => {
      const existing = this.repository.getSandbox(user);
      if (existing?.sandboxId && existing.state === 'ready') {
        await this.ensureDefaultDaemon(user);
        return { id: existing.sandboxId, state: existing.state };
      }
      if (existing?.sandboxId && existing.state === 'paused' && this.provider.resume) {
        await this.provider.resume(user, existing.sandboxId);
        this.repository.saveSandbox({ ...existing, state: 'ready', updatedAt: now() });
        await this.ensureDefaultDaemon(user);
        return { id: existing.sandboxId, state: 'ready' };
      }
      const stamp = now(); this.repository.saveSandbox({ userId: user, provider: this.provider.provider, sandboxId: existing?.sandboxId ?? null, state: 'creating', updatedAt: stamp });
      try {
        const lease = await this.provider.ensure(user);
        if (!lease?.id) throw new Error('Sandbox provider returned no id');
        this.repository.saveSandbox({ userId: user, provider: this.provider.provider, sandboxId: lease.id, state: 'ready', updatedAt: now() });
        await this.ensureDefaultDaemon(user);
        this.repository.audit(user, 'sandbox.ready', lease.id, { provider: this.provider.provider });
        return lease;
      } catch (error) {
        this.repository.saveSandbox({ userId: user, provider: this.provider.provider, sandboxId: existing?.sandboxId ?? null, state: 'failed', updatedAt: now() });
        throw error;
      }
    });
  }
  private async ensureDefaultDaemon(user: string): Promise<void> {
    const descriptor = this.provider.defaultDaemon?.(user); if (!descriptor) return;
    const existing = this.repository.listDaemons(user).find(item => item.daemonId === descriptor.daemonId);
    if (!existing) this.repository.registerDaemon({ userId: user, ...descriptor, managed: true, runtimeIds: descriptor.runtimeIds ?? [], status: descriptor.status ?? 'online' });
  }
  async pause(userIdValue: string): Promise<boolean> {
    const user = userId(userIdValue); const existing = this.repository.getSandbox(user); if (!existing?.sandboxId || existing.state !== 'ready' || !this.provider.pause) return false;
    await this.provider.pause(user, existing.sandboxId); this.repository.saveSandbox({ ...existing, state: 'paused', updatedAt: now() }); this.repository.audit(user, 'sandbox.paused', existing.sandboxId, {}); return true;
  }
}

export interface HostRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

/** Browser-facing DSH Web requests are separate from the Host's private
 * `/v1/*` control Gateway. The implementation keeps the official DSH Web
 * launch credential inside the Host process boundary. */
export interface HostWebRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  signal?: AbortSignal;
}

export interface TenantHostHandle {
  readonly userId: string;
  readonly profileVersion: number;
  readonly baseUrl: string;
  request(path: string, init?: HostRequestInit): Promise<Response>;
  /** Optional official DSH Web bridge. Launch performs the one-time browser
   * cookie exchange; request forwards an already authenticated Web request. */
  openWeb?(init?: HostWebRequestInit): Promise<Response>;
  webRequest?(path: string, init?: HostWebRequestInit): Promise<Response>;
  /** Exact, private target for DSH Web's Remote-stream WebSocket mux. */
  webSocketUrl?(path: string): string;
  /** Drain is optional; when supplied, Profile restart waits for DSH/Multica idle. */
  drain?(): Promise<void>;
  close(): Promise<void>;
}

export interface HostLaunchInput {
  userId: string;
  profile: EffectiveProfile;
  sandbox: SandboxLease;
}
export interface TenantHostLauncher { launch(input: HostLaunchInput): Promise<TenantHostHandle>; }

interface ActiveHost { handle: TenantHostHandle; references: number; lastUsedAt: number; }

/** On-demand one-Host-per-user supervisor. Different users run independently; a user's Sessions share one Host. */
export class HostSupervisor {
  private readonly active = new Map<string, ActiveHost>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly idleMs: number;
  private readonly nowFn: () => number;
  constructor(private readonly options: {
    repository: TenantRepository;
    composer: ProfileComposer;
    sandbox: TenantSandboxManager;
    launcher: TenantHostLauncher;
    /** Optional DSH Hub capability bridge for node/profile transactions. */
    applyProfile?: (input: { userId: string; profile: EffectiveProfile }) => Promise<void>;
    idleMs?: number;
    now?: () => number;
  }) {
    this.idleMs = options.idleMs ?? 5 * 60_000;
    if (!Number.isFinite(this.idleMs) || this.idleMs < 0) throw new Error('Host idleMs must be non-negative');
    this.nowFn = options.now ?? Date.now;
  }

  private async withUserLock<T>(user: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(user) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    const queue = previous.then(() => current);
    this.locks.set(user, queue);
    await previous;
    try { return await operation(); } finally { release(); if (this.locks.get(user) === queue) this.locks.delete(user); }
  }

  async acquire(userIdValue: string): Promise<TenantHostHandle> {
    const user = userId(userIdValue);
    return this.withUserLock(user, async () => {
      const profile = this.options.composer.compose(user); const current = this.active.get(user);
      if (current && current.handle.profileVersion === profile.version) { current.references++; current.lastUsedAt = this.nowFn(); return current.handle; }
      if (current) await this.closeUnsafe(user, current);
      const sandbox = await this.options.sandbox.ensure(user);
      // A newly provisioned or upgraded user Host must have its Profile
      // committed to the optional DSH Hub before DSH consumes the profile.
      // An unchanged stopped Host already has the same Hub revision, so an
      // idle wake-up does not create another capability transaction.
      const persistedHost = this.options.repository.getHost(user);
      if (!persistedHost || persistedHost.profileVersion !== profile.version) {
        await this.options.applyProfile?.({ userId: user, profile });
      }
      this.options.repository.saveHost({ userId: user, profileVersion: profile.version, status: 'starting', hostUrl: null, updatedAt: new Date(this.nowFn()).toISOString() });
      try {
        const handle = await this.options.launcher.launch({ userId: user, profile, sandbox });
        this.active.set(user, { handle, references: 1, lastUsedAt: this.nowFn() });
        this.options.repository.saveHost({ userId: user, profileVersion: profile.version, status: 'ready', hostUrl: handle.baseUrl, updatedAt: new Date(this.nowFn()).toISOString() });
        return handle;
      } catch (error) {
        this.options.repository.saveHost({ userId: user, profileVersion: profile.version, status: 'failed', hostUrl: null, updatedAt: new Date(this.nowFn()).toISOString() });
        throw error;
      }
    });
  }

  release(userIdValue: string): void {
    const user = userId(userIdValue); const current = this.active.get(user); if (!current) return;
    current.references = Math.max(0, current.references - 1); current.lastUsedAt = this.nowFn();
  }

  async restart(userIdValue: string): Promise<TenantHostHandle | undefined> {
    const user = userId(userIdValue);
    return this.withUserLock(user, async () => {
      const profile = this.options.composer.compose(user);
      // Hub owns the signed node/Profile transaction when configured. The
      // existing Host remains serving until this control-plane operation has
      // succeeded; a failed Hub update cannot take down the old Host.
      await this.options.applyProfile?.({ userId: user, profile });
      const current = this.active.get(user); if (current) { this.options.repository.saveHost({ userId: user, profileVersion: current.handle.profileVersion, status: 'draining', hostUrl: current.handle.baseUrl, updatedAt: new Date(this.nowFn()).toISOString() }); await this.closeUnsafe(user, current); }
      // A restart is lazy: Profile is persisted now, and the next request starts
      // the Host with the new composition. This avoids 100 idle Hosts.
      this.options.repository.saveHost({ userId: user, profileVersion: profile.version, status: 'stopped', hostUrl: null, updatedAt: new Date(this.nowFn()).toISOString() });
      return undefined;
    });
  }

  async stop(userIdValue: string): Promise<void> {
    const user = userId(userIdValue);
    await this.withUserLock(user, async () => {
      const current = this.active.get(user);
      if (current) {
        this.options.repository.saveHost({ userId: user, profileVersion: current.handle.profileVersion, status: 'draining', hostUrl: current.handle.baseUrl, updatedAt: new Date(this.nowFn()).toISOString() });
        await this.closeUnsafe(user, current);
      }
      const profile = this.options.composer.compose(user);
      this.options.repository.saveHost({ userId: user, profileVersion: profile.version, status: 'stopped', hostUrl: null, updatedAt: new Date(this.nowFn()).toISOString() });
    });
  }

  /** Stop every child Host before the outer Gateway closes its repository. */
  async closeAll(): Promise<void> {
    for (const user of [...this.active.keys()]) await this.stop(user);
  }

  async stopIdle(): Promise<string[]> {
    const stopped: string[] = [];
    for (const [user, current] of [...this.active]) {
      if (current.references === 0 && this.nowFn() - current.lastUsedAt >= this.idleMs) {
        await this.withUserLock(user, async () => {
          const latest = this.active.get(user); if (!latest || latest.references !== 0 || this.nowFn() - latest.lastUsedAt < this.idleMs) return;
          await this.closeUnsafe(user, latest);
          const profile = this.options.composer.compose(user);
          this.options.repository.saveHost({ userId: user, profileVersion: profile.version, status: 'stopped', hostUrl: null, updatedAt: new Date(this.nowFn()).toISOString() });
          stopped.push(user);
        });
      }
    }
    return stopped;
  }

  listActive(): Array<{ userId: string; profileVersion: number; references: number; baseUrl: string }> {
    return [...this.active.values()].map(item => ({ userId: item.handle.userId, profileVersion: item.handle.profileVersion, references: item.references, baseUrl: item.handle.baseUrl }));
  }

  isActive(userIdValue: string): boolean { return this.active.has(userId(userIdValue)); }

  private async closeUnsafe(user: string, current: ActiveHost): Promise<void> {
    await current.handle.drain?.();
    await current.handle.close();
    if (this.active.get(user) === current) this.active.delete(user);
  }
}

/** Filter the Multica catalog by the Daemons explicitly allowed for this user. */
export function filterRuntimesForUser(runtimes: RuntimeDescriptor[], registrations: DaemonRegistration[]): RuntimeDescriptor[] {
  const allowed = registrations.filter(item => item.status !== 'revoked');
  // An empty registry means the tenant has no authorized execution target.
  // Returning the complete Multica catalog here would expose another user's
  // Daemon/Runtime choices and could let a caller guess an unregistered target.
  if (!allowed.length) return [];
  return runtimes.filter(item => allowed.some(registration => registration.daemonId === item.daemonId &&
    (registration.runtimeIds.length === 0 || registration.runtimeIds.includes(item.runtimeId))));
}
