import { createServer, request as requestUpstream } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { Readable } from 'node:stream';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { CliKind, RuntimeDescriptor } from '../../packages/multica-client/index.ts';
import { HostSupervisor, ProfileComposer, TenantRepository, filterRuntimesForUser, type DaemonRegistration, type HostRequestInit, type TenantSandboxManager, type UserSkillManifest } from '../../packages/tenant-control/index.ts';
import type { DshHubClient } from '../../packages/dsh-hub-control/index.ts';
import { CONTROL_PANEL_HTML } from './ui.ts';

type AuthenticatedUser = { id: string; email: string; status: 'active' | 'disabled'; createdAt: string; updatedAt: string };
class RequestError extends Error { constructor(readonly status: number, message: string) { super(message); } }

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function readBody(req: IncomingMessage, max = 512 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > max) throw new RequestError(413, 'Request body is too large'); chunks.push(bytes); }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new RequestError(400, 'Invalid JSON body'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RequestError(400, 'Request body must be an object');
  return value as Record<string, unknown>;
}
async function readWebBody(req: IncomingMessage, max = 32 * 1024 * 1024): Promise<Buffer | undefined> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > max) throw new RequestError(413, 'DSH Web request body is too large');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}
function bearer(req: IncomingMessage): string {
  const value = req.headers.authorization;
  if (typeof value !== 'string' || !/^Bearer [^\s]+$/u.test(value)) throw new RequestError(401, 'Unauthorized');
  const token = value.slice('Bearer '.length);
  if (token.length > 512) throw new RequestError(401, 'Unauthorized');
  return token;
}
function pathPart(value: string, field: string): string {
  let decoded: string; try { decoded = decodeURIComponent(value); } catch { throw new RequestError(400, `Invalid ${field}`); }
  if (!decoded || decoded.length > 256 || /[\u0000\x00-\x1f/]/u.test(decoded)) throw new RequestError(400, `Invalid ${field}`);
  return decoded;
}
function onlyKeys(input: Record<string, unknown>, keys: readonly string[]): void {
  const accepted = new Set(keys); if (Object.keys(input).some(key => !accepted.has(key))) throw new RequestError(400, 'Unsupported request field');
}
function hostRequestInit(req: IncomingMessage, body?: string): HostRequestInit {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = req.headers['content-type'] ?? 'application/json';
  return { method: req.method, headers, ...(body === undefined ? {} : { body }) };
}
async function copyHostResponse(hostResponse: Response, res: ServerResponse): Promise<void> {
  const headers: Record<string, string> = {};
  for (const [key, value] of hostResponse.headers) if (['content-type', 'cache-control', 'location', 'retry-after'].includes(key.toLowerCase())) headers[key] = value;
  res.writeHead(hostResponse.status, headers);
  if (!hostResponse.body) { res.end(); return; }
  await new Promise<void>((resolve, reject) => {
    Readable.fromWeb(hostResponse.body as import('node:stream/web').ReadableStream).once('error', reject).once('end', resolve).pipe(res);
  });
}
function webRequestHeaders(req: IncomingMessage): Record<string, string> {
  // Never send Gateway credentials or hop-by-hop transport headers to the
  // user Host. The DSH Web cookie and normal browser cache/content headers are
  // enough for the official Web connection.
  const allowed = ['accept', 'accept-language', 'cache-control', 'content-type', 'cookie', 'if-match', 'if-none-match', 'if-modified-since', 'range', 'user-agent'];
  const headers: Record<string, string> = {};
  for (const name of allowed) {
    const value = req.headers[name];
    if (typeof value === 'string') headers[name] = value;
  }
  return headers;
}
function webSocketRequestHeaders(req: IncomingMessage): Record<string, string> {
  // Forward only the WebSocket handshake and the official DSH authority
  // cookie. Do not forward outer Gateway credentials to a private Host.
  // `origin` names the public Gateway while the private Host must validate
  // its own loopback authority, so omit it rather than forwarding a mismatch.
  const allowed = ['connection', 'upgrade', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions', 'cookie', 'user-agent'];
  const headers: Record<string, string> = {};
  for (const name of allowed) {
    const value = req.headers[name];
    if (typeof value === 'string') headers[name] = value;
  }
  return headers;
}
function responseCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const values = headers.getSetCookie?.() ?? [];
  const fallback = response.headers.get('set-cookie');
  return values.length > 0 ? values : fallback ? [fallback] : [];
}
async function copyWebResponse(response: Response, res: ServerResponse, extraCookies: string[] = []): Promise<void> {
  const headers: Record<string, string> = {};
  for (const [key, value] of response.headers) {
    // Node fetch transparently decodes an upstream compressed body.  Do not
    // retain its content-encoding/content-length headers, or a browser will
    // attempt a second decode and reject the page.
    if (['cache-control', 'content-range', 'content-type', 'etag', 'last-modified', 'location', 'vary'].includes(key.toLowerCase())) headers[key] = value;
  }
  const cookies = [...responseCookies(response), ...extraCookies];
  if (cookies.length > 0) res.setHeader('set-cookie', cookies);
  res.writeHead(response.status, headers);
  if (!response.body) { res.end(); return; }
  await new Promise<void>((resolve, reject) => {
    Readable.fromWeb(response.body as import('node:stream/web').ReadableStream).once('error', reject).once('end', resolve).pipe(res);
  });
}

export interface MultiTenantGatewayOptions {
  repository: TenantRepository;
  composer: ProfileComposer;
  supervisor: HostSupervisor;
  sandbox?: TenantSandboxManager & { pause?(userId: string): Promise<boolean> };
  /** Optional real DSH Hub control-plane client. */
  hub?: Pick<DshHubClient, 'listNodes' | 'listSessions' | 'listAudit' | 'listEnrollments' | 'createEnrollment' | 'cancelEnrollment' | 'revokeNode'>;
  /** Optional DSH Hub/SSO identity bridge. If absent, TenantRepository token auth is used. */
  identityProvider?: { authenticate(req: IncomingMessage): Promise<{ userId: string; email?: string }> };
  /** No-login MVP mode. Every request is assigned to this pre-provisioned user. */
  mockUserId?: string;
  /** Provision a first Profile when a trusted SSO identity has no record yet. */
  autoProvisionIdentity?: boolean;
  /** Users allowed to inspect the operator-level Hub control plane. */
  operatorUserIds?: readonly string[];
  /** Deployment-staged roots from which tenant modulePath Plugins may load. */
  pluginPathRoots?: readonly string[];
  /** Explicit local/test escape hatch; never enable for a public Hub deployment. */
  allowUnmanagedPluginPaths?: boolean;
  /** Resolves the authenticated tenant's private Multica workspace without exposing its token. */
  resolveUserWorkspaceId?: (userId: string) => string | Promise<string>;
  port?: number;
  host?: string;
}

function validateTenantPluginSources(value: unknown, roots: readonly string[], allowUnmanaged: boolean): void {
  if (!Array.isArray(value)) throw new RequestError(400, 'plugins must be an array');
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new RequestError(400, 'Plugin manifest must be an object');
    const path = (item as Record<string, unknown>).modulePath;
    const packageName = (item as Record<string, unknown>).packageName;
    // Hub-managed npm packages are installed and checked by the official
    // dsh.plugins capability. They do not need a local filesystem root.
    if (packageName !== undefined) continue;
    if (typeof path !== 'string' || !isAbsolute(path)) throw new RequestError(400, 'Plugin modulePath must be an absolute deployment path');
    if (allowUnmanaged) continue;
    const candidate = resolve(path);
    const trusted = roots.some(root => {
      const rootPath = resolve(root); const rest = relative(rootPath, candidate);
      return rest === '' || (!rest.startsWith(`..${sep}`) && rest !== '..' && !isAbsolute(rest));
    });
    if (!trusted) throw new RequestError(403, 'Plugin modulePath is outside configured deployment plugin roots');
  }
}

/**
 * Public tenant gateway. It authenticates once, checks ownership, then proxies
 * to an on-demand per-user DSH Host. The user token never reaches that Host.
 */
export async function startMultiTenantGateway(options: MultiTenantGatewayOptions): Promise<() => Promise<void>> {
  const port = options.port ?? 3380; const host = options.host ?? '127.0.0.1';
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid Gateway port');
  const activeStreams = new Set<AbortController>();
  // Session admission is serialized per user so the quota check and the
  // subsequent DSH Session creation form one process-local critical section.
  // The Gateway MVP runs as one process; a multi-process deployment needs a
  // shared lease/table before enabling more than one Gateway worker.
  const sessionAdmissionLocks = new Map<string, Promise<void>>();
  const withSessionAdmission = async <T>(userId: string, operation: () => Promise<T>): Promise<T> => {
    const previous = sessionAdmissionLocks.get(userId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    const queued = previous.then(() => current);
    sessionAdmissionLocks.set(userId, queued);
    await previous;
    try { return await operation(); }
    finally { release(); if (sessionAdmissionLocks.get(userId) === queued) sessionAdmissionLocks.delete(userId); }
  };
  const operatorUserIds = new Set(options.operatorUserIds ?? []);
  const isOperator = (user: AuthenticatedUser): boolean => operatorUserIds.has(user.id);
  if (options.mockUserId && options.identityProvider) throw new Error('mockUserId cannot be combined with identityProvider');
  const authenticate = async (req: IncomingMessage): Promise<AuthenticatedUser> => {
    if (options.mockUserId) {
      const user = options.repository.getUser(options.mockUserId);
      if (!user || user.status !== 'active') throw new RequestError(503, 'Configured mock user is unavailable');
      return user;
    }
    if (options.identityProvider) {
      const identity = await options.identityProvider.authenticate(req);
      let user: AuthenticatedUser | undefined;
      try { user = options.repository.getUser(identity.userId); }
      catch { throw new RequestError(401, 'Unauthorized'); }
      if (!user && options.autoProvisionIdentity === true) {
        if (!identity.email) throw new RequestError(401, 'SSO identity did not provide an email');
        try {
          user = options.repository.createUser({ id: identity.userId, email: identity.email }).user;
        } catch {
          // Two Gateway requests may be the first request for the same SSO
          // identity. Re-read after a unique-key race; never mint credentials
          // or expose the competing transaction to the caller.
          try { user = options.repository.getUser(identity.userId); }
          catch { throw new RequestError(401, 'Unauthorized'); }
        }
      }
      if (!user || user.status !== 'active') throw new RequestError(401, 'Unauthorized');
      return user;
    }
    const user = options.repository.authenticate(bearer(req));
    if (!user) throw new RequestError(401, 'Unauthorized');
    return user;
  };
  const withHost = async <T>(user: AuthenticatedUser, fn: (hostHandle: Awaited<ReturnType<HostSupervisor['acquire']>>) => Promise<T>): Promise<T> => {
    const handle = await options.supervisor.acquire(user.id);
    try { return await fn(handle); } finally { options.supervisor.release(user.id); }
  };
  const proxyDshWeb = async (user: AuthenticatedUser, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    await withHost(user, async handle => {
      if (!handle.openWeb || !handle.webRequest) throw new RequestError(503, 'User DSH Web Host is still starting');
      const body = await readWebBody(req);
      const init = { method: req.method, headers: webRequestHeaders(req), ...(body === undefined ? {} : { body }) };
      const gatewayCookie = /(?:^|;\s*)dsh_gateway_web=1(?:;|$)/u.test(req.headers.cookie ?? '');
      const isIndex = req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html');
      // The official DSH Web Host issues an authority-bound signed cookie from
      // its one-time launch URL. Gateway exchanges that URL server-side and
      // forwards only the resulting cookie to the browser at the Gateway
      // origin. The launch token itself never enters the browser history.
      let response = isIndex && !gatewayCookie ? await handle.openWeb(init) : await handle.webRequest(`${url.pathname}${url.search}`, init);
      let launched = isIndex && !gatewayCookie;
      if (isIndex && !launched && response.status === 401) {
        response = await handle.openWeb(init);
        launched = true;
      }
      const marker = launched ? ['dsh_gateway_web=1; Path=/; HttpOnly; SameSite=Lax'] : [];
      await copyWebResponse(response, res, marker);
    });
  };
  const proxyDshWebSocket = async (user: AuthenticatedUser, req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> => {
    const handle = await options.supervisor.acquire(user.id);
    let released = false;
    const release = () => { if (!released) { released = true; options.supervisor.release(user.id); } };
    try {
      if (!handle.webSocketUrl) throw new RequestError(503, 'User DSH WebSocket Host is still starting');
      const target = new URL(handle.webSocketUrl('/api/remote.mux'));
      target.protocol = target.protocol === 'wss:' ? 'https:' : 'http:';
      const upstream = requestUpstream(target, { headers: webSocketRequestHeaders(req) });
      upstream.once('upgrade', (response, upstreamSocket, upstreamHead) => {
        const lines = [`HTTP/${response.httpVersion} ${String(response.statusCode ?? 101)} ${response.statusMessage ?? 'Switching Protocols'}`];
        for (let index = 0; index < response.rawHeaders.length; index += 2) lines.push(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}`);
        socket.write(`${lines.join('\r\n')}\r\n\r\n`);
        if (head.length) upstreamSocket.write(head);
        if (upstreamHead.length) socket.write(upstreamHead);
        socket.pipe(upstreamSocket); upstreamSocket.pipe(socket);
        let closed = false;
        const closePair = () => {
          if (closed) return;
          closed = true;
          if (!socket.destroyed) socket.destroy();
          if (!upstreamSocket.destroyed) upstreamSocket.destroy();
          release();
        };
        socket.once('close', closePair); upstreamSocket.once('close', closePair); upstreamSocket.once('error', closePair);
      });
      upstream.once('response', response => { response.resume(); socket.destroy(); release(); });
      upstream.once('error', () => { socket.destroy(); release(); });
      upstream.end();
    } catch { socket.destroy(); release(); }
  };
  const readRuntimeCatalog = async (user: AuthenticatedUser): Promise<RuntimeDescriptor[]> => withHost(user, async handle => {
    const response = await handle.request('/v1/runtimes', { method: 'GET' });
    if (!response.ok) throw new RequestError(502, `DSH Runtime catalog returned HTTP ${String(response.status)}`);
    const payload = await response.json() as { runtimes?: unknown };
    if (!Array.isArray(payload.runtimes)) throw new RequestError(502, 'DSH Runtime catalog is invalid');
    return payload.runtimes.filter((item): item is RuntimeDescriptor => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
      const row = item as Record<string, unknown>;
      return typeof row.runtimeId === 'string' && typeof row.daemonId === 'string'
        && (row.kind === 'codex' || row.kind === 'claude-code') && typeof row.status === 'string';
    });
  });
  const server = createServer((req, res) => { void (async () => {
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': 'same-origin', 'access-control-allow-headers': 'authorization,content-type' }); res.end(); return; }
    const user = await authenticate(req);
    const url = new URL(req.url ?? '/', `http://${host}`);
    if (req.method === 'GET' && (url.pathname === '/control' || url.pathname === '/control/')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" });
      res.end(CONTROL_PANEL_HTML); return;
    }
    if (!url.pathname.startsWith('/v1/')) return proxyDshWeb(user, req, res, url);
    if (req.method === 'GET' && url.pathname === '/v1/health') {
      return json(res, 200, { ready: true, controlPlane: 'dsh-hub-compatible', userId: user.id });
    }
    if (req.method === 'GET' && url.pathname === '/v1/control/nodes') {
      if (!isOperator(user)) throw new RequestError(403, 'Operator permission required');
      if (!options.hub) throw new RequestError(503, 'DSH Hub control plane is not configured');
      return json(res, 200, await options.hub.listNodes());
    }
    if (url.pathname === '/v1/control/enrollments') {
      if (!isOperator(user)) throw new RequestError(403, 'Operator permission required');
      if (!options.hub) throw new RequestError(503, 'DSH Hub control plane is not configured');
      if (req.method === 'GET') return json(res, 200, { enrollments: await options.hub.listEnrollments() });
      if (req.method === 'POST') {
        const input = await readBody(req, 16 * 1024); onlyKeys(input, ['nodeId', 'displayName', 'expiresInSeconds']);
        if (typeof input.nodeId !== 'string' || typeof input.displayName !== 'string') throw new RequestError(400, 'nodeId and displayName are required');
        if (input.expiresInSeconds !== undefined && typeof input.expiresInSeconds !== 'number') throw new RequestError(400, 'expiresInSeconds must be a number');
        try {
          const grant = await options.hub.createEnrollment({ nodeId: input.nodeId, displayName: input.displayName, ...(input.expiresInSeconds === undefined ? {} : { expiresInSeconds: input.expiresInSeconds }) });
          options.repository.audit(user.id, 'hub.node-enrollment.create', grant.nodeId, { operatorId: user.id, expiresAt: grant.expiresAt });
          return json(res, 201, grant);
        } catch (error) { throw new RequestError(409, `Hub enrollment could not be created: ${error instanceof Error ? error.message : 'unknown error'}`); }
      }
      throw new RequestError(405, 'Method not allowed');
    }
    const enrollmentCancelMatch = /^\/v1\/control\/enrollments\/([^/]+)\/cancel$/.exec(url.pathname);
    if (enrollmentCancelMatch) {
      if (!isOperator(user)) throw new RequestError(403, 'Operator permission required');
      if (!options.hub) throw new RequestError(503, 'DSH Hub control plane is not configured');
      if (req.method !== 'POST') throw new RequestError(405, 'Method not allowed');
      const nodeId = pathPart(enrollmentCancelMatch[1]!, 'node id');
      await options.hub.cancelEnrollment(nodeId);
      options.repository.audit(user.id, 'hub.node-enrollment.cancel', nodeId, { operatorId: user.id });
      return json(res, 200, { cancelled: true, nodeId });
    }
    const nodeRevokeMatch = /^\/v1\/control\/nodes\/([^/]+)\/revoke$/.exec(url.pathname);
    if (nodeRevokeMatch) {
      if (!isOperator(user)) throw new RequestError(403, 'Operator permission required');
      if (!options.hub) throw new RequestError(503, 'DSH Hub control plane is not configured');
      if (req.method !== 'POST') throw new RequestError(405, 'Method not allowed');
      const nodeId = pathPart(nodeRevokeMatch[1]!, 'node id');
      await options.hub.revokeNode(nodeId);
      options.repository.audit(user.id, 'hub.node.revoke', nodeId, { operatorId: user.id });
      return json(res, 200, { revoked: true, nodeId });
    }
    if (url.pathname === '/v1/control/users') {
      if (!isOperator(user)) throw new RequestError(403, 'Operator permission required');
      if (req.method === 'GET') return json(res, 200, { users: options.repository.listUsers() });
      if (req.method === 'POST') {
        const input = await readBody(req, 16 * 1024); onlyKeys(input, ['id', 'email', 'defaultRuntime']);
        if (typeof input.id !== 'string' || typeof input.email !== 'string') throw new RequestError(400, 'id and email are required');
        try {
          const created = options.repository.createUser({ id: input.id, email: input.email, ...(input.defaultRuntime === undefined ? {} : { defaultRuntime: input.defaultRuntime as CliKind }) });
          options.repository.audit(created.user.id, 'user.provisioned-by-operator', created.user.id, { operatorId: user.id });
          return json(res, 201, created);
        } catch (error) { throw new RequestError(409, `User could not be provisioned: ${error instanceof Error ? error.message : 'unknown error'}`); }
      }
      throw new RequestError(405, 'Method not allowed');
    }
    const controlUserMatch = /^\/v1\/control\/users\/([^/]+)$/.exec(url.pathname);
    if (controlUserMatch) {
      if (!isOperator(user)) throw new RequestError(403, 'Operator permission required');
      const targetUserId = pathPart(controlUserMatch[1]!, 'user id');
      if (req.method !== 'PATCH') throw new RequestError(405, 'Method not allowed');
      const input = await readBody(req, 16 * 1024); onlyKeys(input, ['status']);
      if (input.status !== 'active' && input.status !== 'disabled') throw new RequestError(400, 'status must be active or disabled');
      try {
        options.repository.setUserStatus(targetUserId, input.status);
      } catch (error) {
        throw new RequestError(404, `User could not be updated: ${error instanceof Error ? error.message : 'unknown user'}`);
      }
      // Disabling a tenant must stop its active Host promptly.  The durable
      // user status check above prevents new requests even if draining fails;
      // a failed stop is reported so operators can reconcile the child Host.
      if (input.status === 'disabled') {
        try { await options.supervisor.stop(targetUserId); }
        catch (error) { throw new RequestError(409, `User disabled but Host stop is pending: ${error instanceof Error ? error.message : 'unknown error'}`); }
      }
      const updated = options.repository.getUser(targetUserId);
      if (!updated) throw new RequestError(404, 'User not found');
      options.repository.audit(user.id, `user.${input.status}-by-operator`, targetUserId, { operatorId: user.id });
      return json(res, 200, updated);
    }
    if (req.method === 'GET' && url.pathname === '/v1/control/sessions') {
      if (!isOperator(user)) throw new RequestError(403, 'Operator permission required');
      if (!options.hub) throw new RequestError(503, 'DSH Hub control plane is not configured');
      return json(res, 200, { sessions: await options.hub.listSessions() });
    }
    if (req.method === 'GET' && url.pathname === '/v1/profile') {
      return json(res, 200, options.composer.compose(user.id));
    }
    if (req.method === 'GET' && url.pathname === '/v1/sandbox') return json(res, 200, options.repository.getSandbox(user.id) ?? { userId: user.id, state: 'unprovisioned' });
    if (req.method === 'GET' && url.pathname === '/v1/host') {
      const record = options.repository.getHost(user.id); const active = options.supervisor.listActive().find(item => item.userId === user.id);
      return json(res, 200, { ...(record ?? { userId: user.id, status: 'stopped', profileVersion: options.composer.compose(user.id).version, hostUrl: null, updatedAt: new Date().toISOString() }), ...(active ? { active: true, references: active.references } : { active: false, references: 0 }) });
    }
    if (req.method === 'POST' && url.pathname === '/v1/sandbox/stop') {
      await options.supervisor.stop(user.id);
      const paused = options.sandbox?.pause ? await options.sandbox.pause(user.id) : false;
      return json(res, 202, { host: 'stopped', sandbox: paused ? 'paused' : 'unchanged' });
    }
    if (req.method === 'GET' && url.pathname === '/v1/profile/revisions') {
      return json(res, 200, { revisions: options.repository.listProfileRevisions(user.id) });
    }
    if (req.method === 'PATCH' && url.pathname === '/v1/profile') {
      const input = await readBody(req, 256 * 1024); onlyKeys(input, ['expectedVersion', 'plugins', 'defaultRuntime', 'maxConcurrentSessions', 'maxConcurrentTasks']);
      if (input.plugins !== undefined) validateTenantPluginSources(input.plugins, options.pluginPathRoots ?? [], options.allowUnmanagedPluginPaths === true);
      const old = options.repository.getProfile(user.id);
      const next = options.repository.updateProfile(user.id, input as any, typeof input.expectedVersion === 'number' ? input.expectedVersion : undefined);
      // The running Host captures the default Runtime and Task quota when its
      // driver is created.  Restart for those execution-affecting fields as
      // well as Plugin composition; session quota remains Gateway-only.
      const restartHost = input.plugins !== undefined || input.defaultRuntime !== undefined || input.maxConcurrentTasks !== undefined;
      if (restartHost) {
        try { await options.supervisor.restart(user.id); }
        catch (error) {
          // Keep the previous known-good Profile as the next revision; the
          // caller can inspect the failed Host state and retry explicitly.
          options.repository.rollbackProfile(user.id, old.version, next.version);
          throw new RequestError(409, `Profile restart failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        }
      }
      return json(res, 200, options.composer.compose(user.id));
    }
    if (req.method === 'POST' && url.pathname === '/v1/profile/rollback') {
      const input = await readBody(req, 16 * 1024); onlyKeys(input, ['targetVersion', 'expectedVersion']);
      if (typeof input.targetVersion !== 'number') throw new RequestError(400, 'targetVersion is required');
      const previous = options.repository.getProfile(user.id);
      const next = options.repository.rollbackProfile(user.id, input.targetVersion, typeof input.expectedVersion === 'number' ? input.expectedVersion : undefined);
      try { await options.supervisor.restart(user.id); }
      catch (error) {
        // A failed Hub transaction or Host restart must not leave the desired
        // Profile pointing at an unvalidated revision. Roll back by creating a
        // new durable revision; history remains auditable and monotonic.
        try { options.repository.rollbackProfile(user.id, previous.version, next.version); } catch { /* report the original failure */ }
        throw new RequestError(409, `Profile rollback restart failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
      return json(res, 200, { profile: options.composer.compose(user.id), restoredFrom: input.targetVersion, version: next.version });
    }
    if (url.pathname === '/v1/daemons' && req.method === 'GET') return json(res, 200, { daemons: options.repository.listDaemons(user.id) });
    if (url.pathname === '/v1/daemon-candidates' && req.method === 'GET') {
      if (!options.resolveUserWorkspaceId) throw new RequestError(501, 'Daemon discovery is not configured for this deployment');
      await options.resolveUserWorkspaceId(user.id); // proves the catalog belongs to this tenant workspace
      const registered = new Set(options.repository.listDaemons(user.id).map(item => item.daemonId));
      const runtimes = (await readRuntimeCatalog(user)).filter(item => item.status === 'online');
      const grouped = new Map<string, { daemonId: string; label: string; runtimeIds: string[]; runtimes: RuntimeDescriptor[]; registered: boolean }>();
      for (const runtime of runtimes) {
        const current = grouped.get(runtime.daemonId) ?? {
          daemonId: runtime.daemonId, label: runtime.deviceName ?? runtime.runtimeName ?? runtime.daemonId,
          runtimeIds: [], runtimes: [], registered: registered.has(runtime.daemonId),
        };
        current.runtimeIds.push(runtime.runtimeId); current.runtimes.push(runtime); grouped.set(runtime.daemonId, current);
      }
      return json(res, 200, { candidates: [...grouped.values()] });
    }
    if (url.pathname === '/v1/daemons/discover' && req.method === 'POST') {
      if (!options.resolveUserWorkspaceId) throw new RequestError(501, 'Daemon discovery is not configured for this deployment');
      const input = await readBody(req, 32 * 1024); onlyKeys(input, ['daemonId', 'label', 'workspacesRoot', 'executionMode', 'endpoint']);
      if (typeof input.daemonId !== 'string' || typeof input.workspacesRoot !== 'string') throw new RequestError(400, 'daemonId and workspacesRoot are required');
      if (input.executionMode !== 'local' && input.executionMode !== 'external') throw new RequestError(400, 'executionMode must be local or external');
      if (options.repository.listDaemons(user.id).some(item => item.daemonId === input.daemonId)) throw new RequestError(409, 'Daemon is already registered');
      const runtimes = (await readRuntimeCatalog(user)).filter(item => item.daemonId === input.daemonId && item.status === 'online');
      if (!runtimes.length) throw new RequestError(404, 'No online Runtime was discovered for this Daemon');
      const workspaceId = await options.resolveUserWorkspaceId(user.id);
      const daemon = options.repository.registerDaemon({
        userId: user.id, label: typeof input.label === 'string' ? input.label : runtimes[0]!.deviceName ?? input.daemonId,
        daemonId: input.daemonId, workspaceId, runtimeIds: [...new Set(runtimes.map(item => item.runtimeId))],
        workspacesRoot: input.workspacesRoot, executionMode: input.executionMode,
        endpoint: typeof input.endpoint === 'string' ? input.endpoint : undefined, managed: false, status: 'online',
      });
      try { await options.supervisor.restart(user.id); }
      catch (error) {
        options.repository.removeDaemon(user.id, daemon.id);
        throw new RequestError(409, `Discovered Daemon restart failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
      return json(res, 201, daemon);
    }
    if (url.pathname === '/v1/daemons' && req.method === 'POST') {
      const input = await readBody(req, 64 * 1024); onlyKeys(input, ['id', 'label', 'daemonId', 'workspaceId', 'runtimeIds', 'workspacesRoot', 'executionMode', 'endpoint', 'managed', 'status']);
      if (typeof input.label !== 'string' || typeof input.daemonId !== 'string' || typeof input.workspaceId !== 'string' || !Array.isArray(input.runtimeIds) || typeof input.managed !== 'boolean' || typeof input.status !== 'string') throw new RequestError(400, 'label, daemonId, workspaceId, runtimeIds, managed and status are required');
      if (input.managed === true) throw new RequestError(403, 'Only the platform can register a managed default Daemon');
      const daemon = options.repository.registerDaemon({ userId: user.id, id: typeof input.id === 'string' ? input.id : undefined, label: input.label, daemonId: input.daemonId, workspaceId: input.workspaceId, runtimeIds: input.runtimeIds as string[], workspacesRoot: typeof input.workspacesRoot === 'string' ? input.workspacesRoot : undefined, executionMode: typeof input.executionMode === 'string' ? input.executionMode as any : undefined, endpoint: typeof input.endpoint === 'string' ? input.endpoint : undefined, managed: input.managed, status: input.status as DaemonRegistration['status'] });
      try { await options.supervisor.restart(user.id); }
      catch (error) {
        options.repository.removeDaemon(user.id, daemon.id);
        throw new RequestError(409, `Daemon registration restart failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
      return json(res, 201, daemon);
    }
    const daemonMatch = /^\/v1\/daemons\/([^/]+)$/.exec(url.pathname);
    if (daemonMatch) {
      const daemonId = pathPart(daemonMatch[1]!, 'daemon id');
      if (req.method === 'DELETE') {
        const removed = options.repository.getDaemon(user.id, daemonId);
        // The personal Sandbox bootstrap owns the managed default Daemon.
        // A tenant may manage only registrations it created itself; allowing
        // deletion here would remove the platform's guaranteed execution
        // target and leave the user's Profile without its Sandbox binding.
        if (removed?.managed) throw new RequestError(403, 'The platform-managed default Daemon cannot be removed by a user');
        if (!removed || !options.repository.removeDaemon(user.id, daemonId)) throw new RequestError(404, 'Daemon not found');
        try { await options.supervisor.restart(user.id); }
        catch (error) {
          try { options.repository.registerDaemon({ userId: user.id, id: removed.id, label: removed.label, daemonId: removed.daemonId, workspaceId: removed.workspaceId, runtimeIds: removed.runtimeIds, workspacesRoot: removed.workspacesRoot, executionMode: removed.executionMode, endpoint: removed.endpoint, managed: removed.managed, status: removed.status }); } catch { /* report the original failure */ }
          throw new RequestError(409, `Daemon removal restart failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        }
        res.writeHead(204); res.end(); return;
      }
      if (req.method === 'PATCH') {
        const input = await readBody(req, 32 * 1024); onlyKeys(input, ['label', 'runtimeIds', 'workspacesRoot', 'executionMode', 'endpoint', 'status']);
        const previous = options.repository.getDaemon(user.id, daemonId); if (!previous) throw new RequestError(404, 'Daemon not found');
        if (previous.managed) throw new RequestError(403, 'The platform-managed default Daemon cannot be changed by a user');
        const updated = options.repository.updateDaemon(user.id, daemonId, input as any);
        try { await options.supervisor.restart(user.id); }
        catch (error) {
          try { options.repository.updateDaemon(user.id, daemonId, { label: previous.label, runtimeIds: previous.runtimeIds, workspacesRoot: previous.workspacesRoot, executionMode: previous.executionMode, endpoint: previous.endpoint ?? null, status: previous.status }); } catch { /* report the original failure */ }
          throw new RequestError(409, `Daemon update restart failed: ${error instanceof Error ? error.message : 'unknown error'}`);
        }
        return json(res, 200, updated);
      }
      if (req.method === 'GET') { const daemon = options.repository.getDaemon(user.id, daemonId); if (!daemon) throw new RequestError(404, 'Daemon not found'); return json(res, 200, daemon); }
    }
    if (req.method === 'GET' && url.pathname === '/v1/skills') return json(res, 200, { skills: options.composer.compose(user.id).skills });
    if (req.method === 'PUT' && url.pathname === '/v1/skills') {
      const input = await readBody(req, 512 * 1024); onlyKeys(input, ['skills']); if (!Array.isArray(input.skills)) throw new RequestError(400, 'skills must be an array');
      const profile = options.repository.updateSkills(user.id, input.skills as UserSkillManifest[]);
      const effective = options.composer.compose(user.id);
      // Active Hosts refresh the DSH Skill bridge immediately; an idle/new Host
      // gets the same declarations through ProfileComposer on its next start.
      try {
        if (options.supervisor.isActive(user.id)) {
          const declarations = [...effective.systemSkills, ...effective.skills].filter(item => item.enabled).map(item => ({ key: item.key, name: item.name, version: item.version, description: item.description, content: item.content }));
          await withHost(user, async handle => copyHostResponse(await handle.request('/mvp/skills', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ skills: declarations }) }), res));
          return;
        }
      } catch (error) {
        // If no Host is currently running, the persisted Profile is enough for
        // the next Task. Other failures remain visible to the caller.
        if (!(error instanceof Error) || !/fetch|connect|ECONNREFUSED|not found/iu.test(error.message)) throw error;
      }
      return json(res, 200, { skills: profile.skills, applies: 'next-task' });
    }
    if (req.method === 'GET' && url.pathname === '/v1/runtimes') {
      return withHost(user, async handle => {
        const response = await handle.request('/v1/runtimes', { method: 'GET' });
        if (!response.ok) return copyHostResponse(response, res);
        const payload = await response.json() as { runtimes?: unknown };
        const runtimes = Array.isArray(payload.runtimes) ? filterRuntimesForUser(payload.runtimes as any[], options.repository.listDaemons(user.id)) : [];
        return json(res, 200, { runtimes });
      });
    }
    if (req.method === 'GET' && url.pathname === '/v1/sessions') {
      // Only the tenant's own session identifiers cross this boundary. The
      // DSH Host remains the source of transcript/event details.
      return json(res, 200, { sessions: options.repository.listSessions(user.id) });
    }
    const sessionMatch = /^\/v1\/sessions\/([^/]+)(?:\/(messages|cancel|events|runtime))?$/.exec(url.pathname);
    if (req.method === 'POST' && url.pathname === '/v1/sessions') {
      return withSessionAdmission(user.id, async () => {
        const raw = await readBody(req); onlyKeys(raw, ['sessionId']);
        const profile = options.composer.compose(user.id);
        if (options.repository.countSessions(user.id) >= profile.maxConcurrentSessions) throw new RequestError(429, 'User Session quota reached');
        if (raw.sessionId !== undefined) {
          if (typeof raw.sessionId !== 'string') throw new RequestError(400, 'sessionId must be a string');
          const owner = options.repository.getSessionOwner(raw.sessionId);
          if (owner !== undefined && owner !== user.id) throw new RequestError(404, 'Session not found');
        }
        return withHost(user, async handle => {
          const response = await handle.request('/v1/sessions', hostRequestInit(req, JSON.stringify(raw)));
          if (response.ok) {
            let payload: { sessionId?: string; id?: string };
            try { payload = await response.clone().json() as { sessionId?: string; id?: string }; }
            catch { throw new RequestError(502, 'DSH did not return a readable Session identity'); }
            const sid = payload.sessionId ?? payload.id;
            if (typeof sid !== 'string' || !sid.trim()) throw new RequestError(502, 'DSH did not return a Session identity');
            try { options.repository.saveSession(user.id, sid); options.repository.audit(user.id, 'session.open', sid, {}); }
            catch (error) { throw new RequestError(409, `Session ownership could not be recorded: ${error instanceof Error ? error.message : 'unknown error'}`); }
          }
          return copyHostResponse(response, res);
        });
      });
    }
    if (sessionMatch) {
      const sid = pathPart(sessionMatch[1]!, 'session id');
      if (options.repository.getSessionOwner(sid) !== user.id) throw new RequestError(404, 'Session not found');
      const suffix = sessionMatch[2] ? `/${sessionMatch[2]}` : '';
      if (req.method === 'DELETE' && !sessionMatch[2]) {
        options.repository.closeSession(user.id, sid);
        res.writeHead(204); res.end(); return;
      }
      // A durable DSH Session can be reopened after an explicit close. Touch
      // the tenant admission record before proxying so the quota reflects
      // sessions that are actually in use rather than every historical chat.
      options.repository.touchSession(user.id, sid);
      if (req.method === 'GET' && sessionMatch[2] !== 'events') throw new RequestError(405, 'Method not allowed');
      if (req.method !== 'GET' && req.method !== 'POST') throw new RequestError(405, 'Method not allowed');
      if (req.method === 'GET' && sessionMatch[2] === 'events') {
        const abort = new AbortController(); activeStreams.add(abort); res.on('close', () => abort.abort());
        try { await withHost(user, async handle => copyHostResponse(await handle.request(`/v1/sessions/${encodeURIComponent(sid)}${suffix}`, { method: 'GET', signal: abort.signal }), res)); }
        finally { activeStreams.delete(abort); }
        return;
      }
      const raw = await readBody(req); if ('userId' in raw) throw new RequestError(400, 'Identity is controlled by the Gateway');
      if (sessionMatch[2] === 'runtime') {
        onlyKeys(raw, ['runtime', 'runtimeId', 'daemonId']);
        const hasTarget = typeof raw.runtimeId === 'string' || typeof raw.daemonId === 'string';
        if (hasTarget && (typeof raw.runtimeId !== 'string' || typeof raw.daemonId !== 'string' || (raw.runtime !== 'codex' && raw.runtime !== 'claude-code'))) throw new RequestError(400, 'Runtime target requires runtime, runtimeId and daemonId');
        if (!hasTarget && raw.runtime !== 'codex' && raw.runtime !== 'claude-code') throw new RequestError(400, 'Unsupported Runtime');
        if (hasTarget) {
          const registration = options.repository.listDaemons(user.id).find(item => item.daemonId === raw.daemonId && item.status !== 'revoked');
          if (!registration || (registration.runtimeIds.length > 0 && !registration.runtimeIds.includes(raw.runtimeId as string))) throw new RequestError(403, 'Runtime is not registered for this user');
        }
        options.repository.audit(user.id, 'runtime.select', sid, { runtime: raw.runtime, ...(typeof raw.runtimeId === 'string' ? { runtimeId: raw.runtimeId } : {}), ...(typeof raw.daemonId === 'string' ? { daemonId: raw.daemonId } : {}) });
      }
      if (sessionMatch[2] === 'cancel') options.repository.audit(user.id, 'task.cancel.request', sid, {});
      if (sessionMatch[2] === 'messages') options.repository.audit(user.id, 'task.submit.request', sid, { requestId: typeof raw.requestId === 'string' ? raw.requestId.slice(0, 128) : 'unknown' });
      return withHost(user, async handle => copyHostResponse(await handle.request(`/v1/sessions/${encodeURIComponent(sid)}${suffix}`, hostRequestInit(req, JSON.stringify(raw))), res));
    }
    if (req.method === 'GET' && url.pathname === '/v1/audit') {
      return json(res, 200, { records: options.repository.listAudit(user.id), ...(isOperator(user) && options.hub ? { hub: await options.hub.listAudit() } : {}) });
    }
    throw new RequestError(404, 'Route not found');
  })().catch(error => {
    if (res.destroyed) return;
    if (res.headersSent) { res.destroy(); return; }
    json(res, error instanceof RequestError ? error.status : 409, { error: error instanceof Error ? error.message : 'DSH operation failed' });
  }); });
  server.on('upgrade', (req, socket, head) => { void (async () => {
    const url = new URL(req.url ?? '/', `http://${host}`);
    if (url.pathname !== '/api/remote.mux') { socket.destroy(); return; }
    const user = await authenticate(req);
    await proxyDshWebSocket(user, req, socket, head);
  })().catch(() => socket.destroy()); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(); }); });
  return async () => { for (const stream of activeStreams) stream.abort(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); };
}
