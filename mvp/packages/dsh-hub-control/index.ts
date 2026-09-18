import { createHash } from 'node:crypto';

/**
 * Thin client for the public DSH Hub control-plane API.  We intentionally do
 * not copy Hub's storage or Node Agent implementation into this repository:
 * the deployed Hub owns node identity, signed transport, capability commands,
 * audit and its own authenticated operator session.  The tenant gateway uses
 * this client when Hub is configured and keeps its business policy separate.
 */

export interface DshHubClientOptions {
  baseUrl: string;
  /** Server-to-server token for the private, loopback Hub control plane. */
  internalOperatorToken: string;
  /** Secret injected by the trusted reverse proxy for the Hub origin guard. */
  originSecret: string;
  origin?: string;
  fetchImpl?: typeof fetch;
  /** Maximum time to wait for an asynchronous Hub command, such as npm install. */
  commandTimeoutMs?: number;
  timeoutMs?: number;
}

export interface HubNodeSummary {
  nodeId: string;
  displayName: string;
  status?: string;
  online?: boolean;
  [key: string]: unknown;
}

export interface HubRuntimeSummary {
  runtimeId: string;
  nodeId?: string;
  status?: string;
  online?: boolean;
  capabilities?: Array<{ name: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

export interface HubPendingEnrollment {
  nodeId: string;
  displayName: string;
  expiresAt: number;
  createdAt: number;
}

export interface HubEnrollmentGrant extends HubPendingEnrollment {
  /** One-time code returned by Hub; it is never persisted by Hub. */
  code: string;
}

export interface HubCommandRequest {
  nodeId: string;
  runtimeId: string;
  capability: string;
  capabilityVersion: string;
  operation: string;
  payload: unknown;
}

export interface HubCommand {
  commandId: string;
  nodeId: string;
  runtimeId: string;
  capability: string;
  operation: string;
  status?: string;
  [key: string]: unknown;
}

export interface HubCommandWaitOptions {
  timeoutMs?: number;
  pollMs?: number;
  acknowledge?: boolean;
}

function text(value: unknown, field: string, max = 1024): string {
  if (typeof value !== 'string' || !value.trim() || value.trim() !== value || value.length > max || /[\u0000-\u001f]/u.test(value)) {
    throw new Error(`${field} must be a non-empty trimmed string`);
  }
  return value;
}

// HubNodeId and HubRuntimeId use the same lowercase identifier grammar in the
// official protocol. Keep this guard in the thin client so invalid mappings
// fail before an authenticated command is enqueued.
const HUB_IDENTIFIER = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u;
function hubIdentifier(value: unknown, field: string): string {
  const result = text(value, field, 64);
  if (!HUB_IDENTIFIER.test(result)) throw new Error(`${field} must be a valid DSH Hub identifier`);
  return result;
}

function origin(value: string): string {
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== '/' && parsed.pathname !== '')) {
    throw new Error('DSH Hub baseUrl must be an HTTP(S) origin without credentials');
  }
  return parsed.origin;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('DSH Hub returned an invalid object');
  return value as Record<string, unknown>;
}

function rows(value: unknown, field: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`DSH Hub response is missing ${field}`);
  return value.map(object);
}

/** Official DSH Hub REST surface used by the outer platform. */
export class DshHubClient {
  private readonly baseUrl: string;
  private readonly internalOperatorToken: string;
  private readonly originSecret: string;
  private readonly originHeader: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly commandTimeoutMs: number;

  constructor(options: DshHubClientOptions) {
    this.baseUrl = origin(text(options.baseUrl, 'baseUrl'));
    this.internalOperatorToken = text(options.internalOperatorToken, 'internalOperatorToken', 4096);
    if (this.internalOperatorToken.length < 32) throw new Error('internalOperatorToken must contain at least 32 characters');
    this.originSecret = text(options.originSecret, 'originSecret', 4096);
    if (this.originSecret.length < 32) throw new Error('originSecret must contain at least 32 characters');
    this.originHeader = options.origin ? origin(options.origin) : this.baseUrl;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new Error('timeoutMs must be positive');
    this.commandTimeoutMs = options.commandTimeoutMs ?? 300_000;
    if (!Number.isFinite(this.commandTimeoutMs) || this.commandTimeoutMs < this.timeoutMs) throw new Error('commandTimeoutMs must be at least timeoutMs');
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    if (!path.startsWith('/hub/v1/')) throw new Error('DSH Hub path must be under /hub/v1');
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');
    headers.set('x-dsh-internal-operator-token', this.internalOperatorToken);
    headers.set('x-dsh-origin-secret', this.originSecret);
    headers.set('Origin', this.originHeader);
    if (init.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init, redirect: 'error', signal: init.signal ?? AbortSignal.timeout(this.timeoutMs), headers,
    });
    if (!response.ok) throw new Error(`DSH Hub ${init.method ?? 'GET'} ${path} failed with HTTP ${response.status}`);
    if (response.status === 204) return undefined;
    try { return await response.json(); } catch { throw new Error(`DSH Hub ${path} returned invalid JSON`); }
  }

  async me(): Promise<{ email: string; expiresAt?: number }> {
    const row = object(await this.request('/hub/v1/me'));
    return { email: text(row.email, 'hub.email', 320), ...(typeof row.expiresAt === 'number' ? { expiresAt: row.expiresAt } : {}) };
  }

  async listNodes(): Promise<{ nodes: HubNodeSummary[]; runtimes: HubRuntimeSummary[] }> {
    const row = object(await this.request('/hub/v1/nodes'));
    const nodes = rows(row.nodes, 'nodes').map(item => ({ ...item, nodeId: hubIdentifier(item.nodeId, 'node.nodeId'), displayName: text(item.displayName, 'node.displayName', 256) }));
    const runtimes = rows(row.runtimes, 'runtimes').map(item => ({ ...item, runtimeId: hubIdentifier(item.runtimeId, 'runtime.runtimeId'), ...(item.nodeId === undefined ? {} : { nodeId: hubIdentifier(item.nodeId, 'runtime.nodeId') }) }));
    return { nodes, runtimes };
  }

  async listEnrollments(): Promise<HubPendingEnrollment[]> {
    const row = object(await this.request('/hub/v1/enrollments'));
    return rows(row.enrollments, 'enrollments').map(item => ({
      nodeId: hubIdentifier(item.nodeId, 'enrollment.nodeId'),
      displayName: text(item.displayName, 'enrollment.displayName', 256),
      expiresAt: finiteTimestamp(item.expiresAt, 'enrollment.expiresAt'),
      createdAt: finiteTimestamp(item.createdAt, 'enrollment.createdAt'),
    }));
  }

  async createEnrollment(input: { nodeId: string; displayName: string; expiresInSeconds?: number }): Promise<HubEnrollmentGrant> {
    const expiresInSeconds = input.expiresInSeconds ?? 900;
    if (!Number.isSafeInteger(expiresInSeconds) || expiresInSeconds < 60 || expiresInSeconds > 86_400) {
      throw new Error('Hub enrollment expiry must be between 60 and 86400 seconds');
    }
    const row = object(await this.request('/hub/v1/enrollments', {
      method: 'POST',
      body: JSON.stringify({ nodeId: hubIdentifier(input.nodeId, 'nodeId'), displayName: text(input.displayName, 'displayName', 256), expiresInSeconds }),
    }));
    return {
      nodeId: hubIdentifier(row.nodeId, 'enrollment.nodeId'),
      displayName: text(row.displayName, 'enrollment.displayName', 256),
      code: text(row.code, 'enrollment.code', 1024),
      expiresAt: finiteTimestamp(row.expiresAt, 'enrollment.expiresAt'),
      createdAt: typeof row.createdAt === 'number' ? finiteTimestamp(row.createdAt, 'enrollment.createdAt') : Date.now(),
    };
  }

  async cancelEnrollment(nodeId: string): Promise<void> {
    const id = hubIdentifier(nodeId, 'nodeId');
    await this.request(`/hub/v1/enrollments/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: '{}' });
  }

  async revokeNode(nodeId: string): Promise<void> {
    const id = hubIdentifier(nodeId, 'nodeId');
    await this.request(`/hub/v1/nodes/${encodeURIComponent(id)}/revoke`, { method: 'POST', body: '{}' });
  }

  async listSessions(nodeId?: string): Promise<Record<string, unknown>[]> {
    const suffix = nodeId === undefined ? '' : `?nodeId=${encodeURIComponent(hubIdentifier(nodeId, 'nodeId'))}`;
    const row = object(await this.request(`/hub/v1/sessions${suffix}`));
    return rows(row.sessions, 'sessions');
  }

  async listAudit(options: { nodeId?: string; limit?: number } = {}): Promise<Record<string, unknown>[]> {
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new Error('Hub audit limit must be between 1 and 10000');
    const query = new URLSearchParams({ limit: String(limit) });
    if (options.nodeId !== undefined) query.set('nodeId', hubIdentifier(options.nodeId, 'nodeId'));
    const row = object(await this.request(`/hub/v1/audit?${query.toString()}`));
    return rows(row.records, 'records');
  }

  async enqueueCommand(input: HubCommandRequest): Promise<HubCommand> {
    const normalized = {
      nodeId: hubIdentifier(input.nodeId, 'nodeId'), runtimeId: hubIdentifier(input.runtimeId, 'runtimeId'),
      capability: text(input.capability, 'capability', 256), capabilityVersion: text(input.capabilityVersion, 'capabilityVersion', 64),
      operation: text(input.operation, 'operation', 128), payload: input.payload,
    };
    const row = object(await this.request('/hub/v1/commands', { method: 'POST', body: JSON.stringify(normalized) }));
    const command = object(row.command);
    return { ...command, commandId: text(command.commandId, 'command.commandId', 256), nodeId: hubIdentifier(command.nodeId, 'command.nodeId'), runtimeId: hubIdentifier(command.runtimeId, 'command.runtimeId'), capability: text(command.capability, 'command.capability', 256), operation: text(command.operation, 'command.operation', 128) };
  }

  async getCommand(commandId: string): Promise<HubCommand> {
    const id = text(commandId, 'commandId', 256);
    const row = object(await this.request(`/hub/v1/commands/${encodeURIComponent(id)}`));
    const command = object(row.command);
    return { ...command, commandId: text(command.commandId, 'command.commandId', 256), nodeId: hubIdentifier(command.nodeId, 'command.nodeId'), runtimeId: hubIdentifier(command.runtimeId, 'command.runtimeId'), capability: text(command.capability, 'command.capability', 256), operation: text(command.operation, 'command.operation', 128) };
  }

  async acknowledgeCommand(commandId: string): Promise<void> {
    const id = text(commandId, 'commandId', 256);
    await this.request(`/hub/v1/commands/${encodeURIComponent(id)}`, { method: 'POST', body: '{}' });
  }

  /** Wait for the official Hub command journal to reach a terminal state. */
  async waitForCommand(command: HubCommand | string, options: HubCommandWaitOptions = {}): Promise<HubCommand> {
    const commandId = typeof command === 'string' ? text(command, 'commandId', 256) : text(command.commandId, 'command.commandId', 256);
    // Package installation and rollback are remote asynchronous commands. They
    // can safely outlive one HTTP request, so do not apply the short REST
    // deadline used by request() to a real Profile transaction.
    const timeoutMs = options.timeoutMs ?? this.commandTimeoutMs;
    const pollMs = options.pollMs ?? 250;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(pollMs) || pollMs <= 0) throw new Error('Hub command wait timings must be positive');
    const deadline = Date.now() + timeoutMs;
    let latest = typeof command === 'string' ? await this.getCommand(commandId) : command;
    while (!['ok', 'error', 'outcome-unknown'].includes(String(latest.status))) {
      if (Date.now() >= deadline) throw new Error(`DSH Hub command ${commandId} did not reach a terminal state`);
      await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
      latest = await this.getCommand(commandId);
    }
    if (options.acknowledge !== false) await this.acknowledgeCommand(commandId);
    if (latest.status !== 'ok') throw new Error(`DSH Hub command ${commandId} finished with ${String(latest.status)}`);
    return latest;
  }
}

/**
 * Fail before enqueueing a Profile transaction when its Node Agent is not
 * connected, or when the assigned Runtime is absent or does not advertise the
 * official Plugin capability. The Runtime itself may be offline: dsh.plugins
 * is executed by the long-lived Node Agent against the Runtime's profile, which
 * is what lets tenant Hosts remain stopped until a Session needs one.
 */
export async function assertHubProfileTargetAvailable(
  client: DshHubClient,
  target: { nodeId: string; runtimeId: string },
): Promise<void> {
  const nodeId = hubIdentifier(target.nodeId, 'nodeId');
  const runtimeId = hubIdentifier(target.runtimeId, 'runtimeId');
  const fleet = await client.listNodes();
  const node = fleet.nodes.find(item => item.nodeId === nodeId);
  if (!node || node.status === 'revoked') throw new Error(`DSH Hub node ${nodeId} is not registered`);
  if (node.online !== true) throw new Error(`DSH Hub node ${nodeId} is offline`);
  const runtime = fleet.runtimes.find(item => item.nodeId === nodeId && item.runtimeId === runtimeId);
  if (!runtime) throw new Error(`DSH Hub runtime ${nodeId}/${runtimeId} is not registered`);
  const capabilities = Array.isArray(runtime.capabilities) ? runtime.capabilities : [];
  if (!capabilities.some(item => item && typeof item === 'object' && item.name === 'dsh.plugins')) {
    throw new Error(`DSH Hub runtime ${nodeId}/${runtimeId} does not expose dsh.plugins`);
  }
}

export interface HubProfileCommand {
  nodeId: string;
  runtimeId: string;
  profileVersion: number;
  /** npm package manifests understood by the official dsh.plugins capability. */
  plugins: Array<{ packageName: string; version: string }>;
}

function packageName(value: unknown): string {
  const result = text(value, 'plugin.packageName', 214);
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(result)) throw new Error(`Plugin ${result} is not an npm package name accepted by DSH Hub`);
  return result;
}

function semver(value: unknown): string {
  const result = text(value, 'plugin.version', 128);
  // dsh.plugins 3.0.0 accepts npm's exact SemVer form.  Do this check before
  // enqueueing so a malformed version cannot become a durable Hub command.
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(result)) {
    throw new Error(`Plugin version ${result} is not a valid SemVer`);
  }
  return result;
}

function lockHash(value: unknown): string {
  const result = text(value, 'plugin.lockHash', 64);
  if (!/^[A-Za-z0-9_-]{43}$/u.test(result)) throw new Error('Plugin lock hash is invalid');
  return result;
}

function finiteTimestamp(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative timestamp`);
  return value;
}

function mutationId(profileVersion: number, index: number, packageNameValue: string): string {
  const raw = `dsh-profile-${String(profileVersion)}-${String(index)}-${packageNameValue}`;
  // Keep the readable form for normal packages while honoring Hub's 256-byte
  // id limit for the longest valid scoped package name.
  return raw.length <= 256 ? raw : `dsh-profile-${createHash('sha256').update(raw).digest('hex')}`;
}

function rollbackMutationId(profileVersion: number, index: number, packageNameValue: string, changeId: string): string {
  const raw = `dsh-profile-${String(profileVersion)}-rollback-${String(index)}-${packageNameValue}-${changeId}`;
  return raw.length <= 256 ? raw : `dsh-profile-${createHash('sha256').update(raw).digest('hex')}`;
}

type ProfileCompensation =
  | { operation: 'rollback'; changeId: string; packageName: string }
  | { operation: 'apply'; packageName: string; version: string };

function compensationMutationId(profileVersion: number, index: number, item: ProfileCompensation): string {
  const identity = item.operation === 'rollback' ? item.changeId : `${item.packageName}-${item.version}`;
  const raw = `dsh-profile-${String(profileVersion)}-compensate-${String(index)}-${item.operation}-${identity}`;
  return raw.length <= 256 ? raw : `dsh-profile-${createHash('sha256').update(raw).digest('hex')}`;
}

function resultObject(command: HubCommand, operation: string): Record<string, unknown> {
  if (!command.result || typeof command.result !== 'object' || Array.isArray(command.result)) {
    throw new Error(`DSH Hub plugin ${operation} did not return an object`);
  }
  return command.result as Record<string, unknown>;
}

/** Undo only mutations completed by this request, in reverse order. */
async function compensateProfileMutations(
  client: DshHubClient,
  target: { nodeId: string; runtimeId: string; profileVersion: number },
  undo: ProfileCompensation[],
): Promise<void> {
  if (undo.length === 0) return;
  const inventory = resultObject(await client.waitForCommand(await client.enqueueCommand({
    nodeId: target.nodeId, runtimeId: target.runtimeId, capability: 'dsh.plugins', capabilityVersion: '3.0.0', operation: 'inventory', payload: {},
  })), 'compensation inventory');
  let expectedLockHash = lockHash(inventory.lockHash);
  for (const [index, item] of [...undo].reverse().entries()) {
    const payload = item.operation === 'rollback'
      ? { clientMutationId: compensationMutationId(target.profileVersion, index, item), changeId: item.changeId, expectedLockHash }
      : { clientMutationId: compensationMutationId(target.profileVersion, index, item), packageName: item.packageName, version: item.version, expectedLockHash };
    const command = await client.waitForCommand(await client.enqueueCommand({
      nodeId: target.nodeId, runtimeId: target.runtimeId, capability: 'dsh.plugins', capabilityVersion: '3.0.0', operation: item.operation, payload,
    }));
    expectedLockHash = lockHash(resultObject(command, `compensation ${item.operation}`).lockHash);
  }
}

/**
 * Apply a Profile's npm Plugin set through the official Hub capability.
 * Hub's public contract applies one package at a time and uses the current
 * lock hash as its optimistic concurrency token, so this helper reads the
 * inventory and waits for each transaction instead of inventing a profile API.
 */
export async function requestProfileTransaction(client: DshHubClient, input: HubProfileCommand): Promise<HubCommand[]> {
  if (!Number.isSafeInteger(input.profileVersion) || input.profileVersion < 1) throw new Error('profileVersion must be a positive integer');
  const nodeId = hubIdentifier(input.nodeId, 'nodeId'); const runtimeId = hubIdentifier(input.runtimeId, 'runtimeId');
  const inventory = await client.waitForCommand(await client.enqueueCommand({
    nodeId, runtimeId, capability: 'dsh.plugins', capabilityVersion: '3.0.0', operation: 'inventory', payload: {},
  }));
  const result = inventory.result;
  if (!result || typeof result !== 'object' || Array.isArray(result) || typeof (result as Record<string, unknown>).lockHash !== 'string') {
    throw new Error('DSH Hub plugin inventory did not return a lock hash');
  }
  const inventoryResult = result as Record<string, unknown>;
  let expectedLockHash = lockHash(inventoryResult.lockHash);
  let installed = Array.isArray(inventoryResult.plugins) ? inventoryResult.plugins.filter(item => item && typeof item === 'object' && !Array.isArray(item)) as Array<Record<string, unknown>> : [];
  const commands: HubCommand[] = [];
  const undo: ProfileCompensation[] = [];

  // The official capability has no generic "remove" operation.  When the
  // desired Profile drops a package, or asks for an older version, first use
  // the recorded transactional rollback chain.  This keeps the Hub-managed
  // package.json/lockfile and the DSH Profile in the same state; if no safe
  // rollback exists, fail before applying anything else.
  const desired = new Map<string, string>();
  for (const manifest of input.plugins) {
    const name = packageName(manifest.packageName); const version = semver(manifest.version);
    if (desired.has(name)) throw new Error(`Profile contains duplicate Hub Plugin ${name}`);
    desired.set(name, version);
  }
  const mismatched = installed.some(item => {
    if (item.enabled !== true || typeof item.packageName !== 'string') return false;
    const target = desired.get(item.packageName);
    return target === undefined || item.version !== target;
  });
  let history: Array<Record<string, unknown>> = [];
  try {
    if (mismatched) {
    const historyCommand = await client.waitForCommand(await client.enqueueCommand({
      nodeId, runtimeId, capability: 'dsh.plugins', capabilityVersion: '3.0.0', operation: 'history', payload: {},
    }));
    const historyResult = historyCommand.result;
    if (!historyResult || typeof historyResult !== 'object' || Array.isArray(historyResult)
      || !Array.isArray((historyResult as Record<string, unknown>).changes)) {
      throw new Error('DSH Hub plugin history did not return changes');
    }
    history = ((historyResult as Record<string, unknown>).changes as unknown[])
      .filter((item: unknown): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item));
    for (let current of [...installed]) {
      if (current.enabled !== true || typeof current.packageName !== 'string') continue;
      const targetVersion = desired.get(current.packageName);
      if (targetVersion !== undefined && current.version === targetVersion) continue;
      let guard = 0;
      while (current.enabled === true && (targetVersion === undefined || current.version !== targetVersion)) {
        const currentPackageName = current.packageName;
        if (typeof currentPackageName !== 'string') throw new Error('DSH Hub plugin inventory has an invalid package name');
        if (++guard > 10_000) throw new Error(`DSH Hub rollback chain is too long for ${currentPackageName}`);
        const candidate = [...history].reverse().find(change =>
          change.packageName === currentPackageName
          // A failed rollback may have restored the original package state but
          // failed while recreating an absent lockfile. Retry the same official
          // rollback only when its recorded lock still matches the inventory.
          && (change.status === 'applied' || change.status === 'rollback-failed')
          && change.toVersion === current.version && change.afterLockHash === expectedLockHash
          && typeof change.changeId === 'string');
        if (!candidate) {
          if (targetVersion === undefined) throw new Error(`DSH Hub cannot safely remove enabled Plugin ${currentPackageName}; use an official rollback target`);
          // A package may have been installed outside Hub history.  Applying
          // the exact desired version is safe; only deletion requires a
          // recorded rollback transaction.
          break;
        }
        const changeId = candidate.changeId;
        if (typeof changeId !== 'string') throw new Error(`DSH Hub rollback history has an invalid change id for ${currentPackageName}`);
        const rollback = await client.waitForCommand(await client.enqueueCommand({
          nodeId, runtimeId, capability: 'dsh.plugins', capabilityVersion: '3.0.0', operation: 'rollback',
          payload: { clientMutationId: rollbackMutationId(input.profileVersion, input.plugins.findIndex(item => item.packageName === currentPackageName), currentPackageName, changeId), changeId, expectedLockHash },
        }));
        commands.push(rollback);
        undo.push({ operation: 'apply', packageName: packageName(currentPackageName), version: semver(candidate.toVersion) });
        const restored = rollback.result;
        if (!restored || typeof restored !== 'object' || Array.isArray(restored)
          || typeof (restored as Record<string, unknown>).lockHash !== 'string'
          || !Array.isArray((restored as Record<string, unknown>).plugins)) {
          throw new Error('DSH Hub plugin rollback did not return an inventory');
        }
        expectedLockHash = lockHash((restored as Record<string, unknown>).lockHash);
        installed = ((restored as Record<string, unknown>).plugins as unknown[])
          .filter((item: unknown): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item));
        const next = installed.find(item => item.packageName === current.packageName);
        if (!next) { current.enabled = false; break; }
        current = next;
        if (candidate.status === 'applied') candidate.status = 'rolled-back';
      }
      }
    }
    for (const [index, manifest] of input.plugins.entries()) {
    const name = packageName(manifest.packageName); const version = semver(manifest.version);
    // The official operation is transactional but still records an update;
    // avoid creating a needless change when this exact healthy package is
    // already present on the target Node.
    if (installed.some(item => item.packageName === name && item.version === version && item.healthy === true && item.enabled === true)) continue;
    const command = await client.waitForCommand(await client.enqueueCommand({
      nodeId, runtimeId, capability: 'dsh.plugins', capabilityVersion: '3.0.0', operation: 'apply',
      payload: { clientMutationId: mutationId(input.profileVersion, index, name), packageName: name, version, expectedLockHash },
    }));
    commands.push(command);
    const updated = command.result;
    if (!updated || typeof updated !== 'object' || Array.isArray(updated) || typeof (updated as Record<string, unknown>).lockHash !== 'string') {
      throw new Error('DSH Hub plugin apply did not return a lock hash');
    }
    const updatedResult = updated as Record<string, unknown>;
    expectedLockHash = lockHash(updatedResult.lockHash);
    const change = updatedResult.change;
    if (!change || typeof change !== 'object' || Array.isArray(change) || typeof (change as Record<string, unknown>).changeId !== 'string') {
      throw new Error('DSH Hub plugin apply did not return a change id');
    }
    undo.push({ operation: 'rollback', changeId: text((change as Record<string, unknown>).changeId, 'plugin.changeId', 256), packageName: name });
    const plugin = updatedResult.plugin;
    if (plugin && typeof plugin === 'object' && !Array.isArray(plugin)) installed = [...installed.filter(item => item.packageName !== name), plugin as Record<string, unknown>];
    }
  } catch (error) {
    try {
      await compensateProfileMutations(client, { nodeId, runtimeId, profileVersion: input.profileVersion }, undo);
    } catch (compensationError) {
      throw new AggregateError([error, compensationError], 'DSH Hub Profile transaction and compensation both failed');
    }
    throw error;
  }
  return commands;
}
