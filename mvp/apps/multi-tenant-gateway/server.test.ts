import { createServer } from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProfileComposer, HostSupervisor, TenantRepository, type HostLaunchInput, type TenantHostHandle } from '../../packages/tenant-control/index.ts';
import { startMultiTenantGateway } from './server.ts';

async function freePort(): Promise<number> {
  const server = createServer(); await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const port = (server.address() as import('node:net').AddressInfo).port; await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); return port;
}

class FakeHost implements TenantHostHandle {
  readonly requests: string[] = []; closed = false; private sequence = 0;
  constructor(readonly userId: string, readonly profileVersion: number, readonly baseUrl: string) {}
  async request(path: string, init: { body?: string } = {}): Promise<Response> {
    this.requests.push(path);
    if (path === '/v1/runtimes') return Response.json({ runtimes: [
      { runtimeId: 'runtime-a', daemonId: 'daemon-a', kind: 'codex', provider: 'codex', label: 'A Codex', status: 'online', lastSeenAt: new Date().toISOString(), deviceName: 'Alice laptop' },
      { runtimeId: 'runtime-b', daemonId: 'daemon-b', kind: 'claude-code', provider: 'claude-code', label: 'B Claude', status: 'online', lastSeenAt: new Date().toISOString(), deviceName: 'Alice server' },
    ] });
    if (path === '/v1/sessions') {
      const value = init.body ? JSON.parse(init.body) as { sessionId?: string } : {};
      return Response.json({ sessionId: value.sessionId ?? `${this.userId}-session-${++this.sequence}` }, { status: 201 });
    }
    if (path === '/mvp/skills') return Response.json({ skills: [] });
    return Response.json({ ok: true });
  }
  async openWeb(): Promise<Response> {
    this.requests.push('web:launch');
    return new Response(null, { status: 303, headers: { location: '/', 'set-cookie': `dsh_web_${this.userId}=signed; Path=/; HttpOnly` } });
  }
  async webRequest(path: string): Promise<Response> {
    this.requests.push(`web:${path}`);
    if (path === '/' || path === '/index.html') return new Response('<!doctype html><title>DeepSeek Harness</title><main>chat</main>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
    if (path === '/assets/main.js') return new Response('console.log("chat")', { headers: { 'content-type': 'text/javascript' } });
    return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  }
  async close(): Promise<void> { this.closed = true; }
}

async function setup(options: { pluginPathRoots?: string[]; allowUnmanagedPluginPaths?: boolean; resolveUserWorkspaceId?: (userId: string) => string; mockUserId?: string } = {}) {
  const repo = new TenantRepository(':memory:');
  const alice = repo.createUser({ id: 'alice', email: 'alice@example.com', token: 'alice-token-123456789012345678901234' });
  const bob = repo.createUser({ id: 'bob', email: 'bob@example.com', token: 'bob-token-123456789012345678901234' });
  const composer = new ProfileComposer(repo); const hosts: FakeHost[] = [];
  const supervisor = new HostSupervisor({ repository: repo, composer, sandbox: { ensure: async id => ({ id: `sandbox-${id}` }) }, launcher: { launch: async (input: HostLaunchInput) => { const host = new FakeHost(input.userId, input.profile.version, `http://${input.userId}`); hosts.push(host); return host; } }, idleMs: 60_000 });
  // The fixture treats /plugins as a deployment-staged trusted root.  The
  // isolation test below passes an empty root list to exercise the rejection.
  const port = await freePort(); const close = await startMultiTenantGateway({ repository: repo, composer, supervisor, port, pluginPathRoots: ['/plugins'], resolveUserWorkspaceId: userId => `workspace-${userId}`, ...options });
  return { repo, alice, bob, hosts, port, close };
}

test('multi-tenant Gateway authenticates, owns Sessions, filters Runtimes and applies profile/skill changes', async () => {
  const state = await setup(); const url = `http://127.0.0.1:${String(state.port)}`;
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  try {
    const uiLaunch = await fetch(`${url}/`, { headers: auth(state.alice.token), redirect: 'manual' });
    assert.equal(uiLaunch.status, 303); assert.equal(uiLaunch.headers.get('location'), '/'); assert.match(uiLaunch.headers.get('set-cookie') ?? '', /dsh_gateway_web=1/u);
    const ui = await fetch(`${url}/`, { headers: { ...auth(state.alice.token), Cookie: 'dsh_gateway_web=1; dsh_web_alice=signed' } });
    assert.equal(ui.status, 200); assert.match(await ui.text(), /DeepSeek Harness/u);
    const control = await fetch(`${url}/control`, { headers: auth(state.alice.token) }); assert.equal(control.status, 200); assert.match(await control.text(), /DSH Tenant Control/u);
    const asset = await fetch(`${url}/assets/main.js`, { headers: auth(state.alice.token) }); assert.equal(asset.status, 200); assert.match(await asset.text(), /console\.log/u);
    const unauthorized = await fetch(`${url}/v1/profile`); assert.equal(unauthorized.status, 401);
    const forbiddenHubView = await fetch(`${url}/v1/control/nodes`, { headers: auth(state.alice.token) }); assert.equal(forbiddenHubView.status, 403);
    const profile = await fetch(`${url}/v1/profile`, { headers: auth(state.alice.token) }); assert.equal(profile.status, 200); assert.equal((await profile.json()).userId, 'alice');
    const created = await fetch(`${url}/v1/sessions`, { method: 'POST', headers: { ...auth(state.alice.token), 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'alice-session' }) });
    assert.equal(created.status, 201); assert.equal((await created.json()).sessionId, 'alice-session'); assert.equal(state.hosts.length, 1);
    const foreignCreate = await fetch(`${url}/v1/sessions`, { method: 'POST', headers: { ...auth(state.bob.token), 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'alice-session' }) }); assert.equal(foreignCreate.status, 404);
    const listed = await fetch(`${url}/v1/sessions`, { headers: auth(state.alice.token) });
    assert.equal(listed.status, 200); assert.deepEqual((await listed.json()).sessions.map((item: any) => item.sessionId), ['alice-session']);
    const foreign = await fetch(`${url}/v1/sessions/alice-session/messages`, { method: 'POST', headers: { ...auth(state.bob.token), 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'steal' }) }); assert.equal(foreign.status, 404);
    const candidates = await fetch(`${url}/v1/daemon-candidates`, { headers: auth(state.alice.token) });
    assert.deepEqual((await candidates.json()).candidates.map((item: any) => item.daemonId), ['daemon-a', 'daemon-b']);
    const daemon = await fetch(`${url}/v1/daemons/discover`, { method: 'POST', headers: { ...auth(state.alice.token), 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'Alice local', daemonId: 'daemon-a', workspacesRoot: 'C:\\Users\\alice\\code', executionMode: 'local' }) });
    assert.equal(daemon.status, 201); assert.equal((await daemon.json()).workspaceId, 'workspace-alice');
    const duplicateDaemon = await fetch(`${url}/v1/daemons/discover`, { method: 'POST', headers: { ...auth(state.alice.token), 'Content-Type': 'application/json' }, body: JSON.stringify({ daemonId: 'daemon-a', workspacesRoot: '/workspace', executionMode: 'external' }) }); assert.equal(duplicateDaemon.status, 409);
    const forgedDefault = await fetch(`${url}/v1/daemons`, { method: 'POST', headers: { ...auth(state.alice.token), 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'Forged default', daemonId: 'daemon-b', workspaceId: 'workspace-a', runtimeIds: [], managed: true, status: 'online' }) }); assert.equal(forgedDefault.status, 403);
    const managed = state.repo.registerDaemon({ userId: 'alice', label: 'Platform default', daemonId: 'daemon-managed', workspaceId: 'workspace-a', runtimeIds: [], managed: true, status: 'online' });
    const changeManaged = await fetch(`${url}/v1/daemons/${managed.id}`, { method: 'PATCH', headers: { ...auth(state.alice.token), 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'tampered' }) }); assert.equal(changeManaged.status, 403);
    const removeManaged = await fetch(`${url}/v1/daemons/${managed.id}`, { method: 'DELETE', headers: auth(state.alice.token) }); assert.equal(removeManaged.status, 403);
    const runtimes = await fetch(`${url}/v1/runtimes`, { headers: auth(state.alice.token) }); assert.deepEqual((await runtimes.json()).runtimes.map((item: any) => item.runtimeId), ['runtime-a']);
    const skills = await fetch(`${url}/v1/skills`, { method: 'PUT', headers: { ...auth(state.alice.token), 'Content-Type': 'application/json' }, body: JSON.stringify({ skills: [{ key: 'alice-skill', name: 'Alice Skill', version: '1', description: '', content: 'hello', enabled: true }] }) }); assert.equal(skills.status, 200);
    const patched = await fetch(`${url}/v1/profile`, { method: 'PATCH', headers: { ...auth(state.alice.token), 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: 1, defaultRuntime: 'claude-code', plugins: [{ id: 'alice-plugin', version: '1', modulePath: '/plugins/alice.js', enabled: true }] }) }); assert.equal(patched.status, 200); assert.equal(state.hosts[0]!.closed, true); assert.equal((await patched.clone().json()).defaultRuntime, 'claude-code');
    const revisions = await fetch(`${url}/v1/profile/revisions`, { headers: auth(state.alice.token) }); assert.equal((await revisions.json()).revisions.length, 2);
    const nextSession = await fetch(`${url}/v1/sessions`, { method: 'POST', headers: { ...auth(state.alice.token), 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'alice-session-2' }) }); assert.equal(nextSession.status, 201); assert.equal(state.hosts.length, 3);
    const closed = await fetch(`${url}/v1/sessions/alice-session-2`, { method: 'DELETE', headers: auth(state.alice.token) }); assert.equal(closed.status, 204);
    assert.equal(state.repo.countSessions('alice'), 1);
    const reopened = await fetch(`${url}/v1/sessions/alice-session-2/runtime`, { method: 'POST', headers: { ...auth(state.alice.token), 'Content-Type': 'application/json' }, body: JSON.stringify({ runtime: 'codex' }) }); assert.equal(reopened.status, 200);
    assert.equal(state.repo.countSessions('alice'), 2);
  } finally { await state.close(); state.repo.close(); }
});

test('explicit no-login MVP mode assigns browser requests to one mock user', async () => {
  const state = await setup({ mockUserId: 'alice' });
  try {
    const profile = await fetch(`http://127.0.0.1:${String(state.port)}/v1/profile`);
    assert.equal(profile.status, 200);
    assert.equal((await profile.json()).userId, 'alice');
  } finally { await state.close(); state.repo.close(); }
});

test('Daemon discovery fails closed without a private tenant workspace resolver', async () => {
  const state = await setup({ resolveUserWorkspaceId: undefined });
  try {
    const response = await fetch(`http://127.0.0.1:${String(state.port)}/v1/daemon-candidates`, {
      headers: { Authorization: `Bearer ${state.alice.token}` },
    });
    assert.equal(response.status, 501);
    assert.equal(state.hosts.length, 0);
  } finally { await state.close(); state.repo.close(); }
});

test('tenant Profile rejects unstaged local Plugin paths but accepts Hub package manifests', async () => {
  const state = await setup({ pluginPathRoots: [] }); const url = `http://127.0.0.1:${String(state.port)}`;
  const headers = { Authorization: `Bearer ${state.alice.token}`, 'Content-Type': 'application/json' };
  try {
    const outside = await fetch(`${url}/v1/profile`, { method: 'PATCH', headers, body: JSON.stringify({ expectedVersion: 1, plugins: [{ id: 'outside', version: '1.0.0', modulePath: '/tmp/untrusted.js', enabled: true }] }) });
    assert.equal(outside.status, 403);
    const packagePlugin = await fetch(`${url}/v1/profile`, { method: 'PATCH', headers, body: JSON.stringify({ expectedVersion: 1, plugins: [{ id: 'hub-plugin', version: '1.2.3', packageName: '@example/dsh-plugin', enabled: true }] }) });
    assert.equal(packagePlugin.status, 200);
  } finally { await state.close(); state.repo.close(); }
});

test('100 tenant identities can open isolated Sessions concurrently', async () => {
  const repo = new TenantRepository(':memory:');
  const users = Array.from({ length: 100 }, (_, index) => {
    const id = `user-${String(index).padStart(3, '0')}`;
    return { ...repo.createUser({ id, email: `${id}@example.com`, token: `${id}-token-123456789012345678901234` }), id };
  });
  const composer = new ProfileComposer(repo);
  const supervisor = new HostSupervisor({ repository: repo, composer, sandbox: { ensure: async id => ({ id: `sandbox-${id}` }) }, launcher: { launch: async input => new FakeHost(input.userId, input.profile.version, `http://${input.userId}`) }, idleMs: 60_000 });
  const port = await freePort(); const close = await startMultiTenantGateway({ repository: repo, composer, supervisor, port });
  try {
    const results = await Promise.all(users.map(user => fetch(`http://127.0.0.1:${String(port)}/v1/sessions`, { method: 'POST', headers: { Authorization: `Bearer ${user.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: `${user.id}-session` }) })));
    assert.ok(results.every(response => response.status === 201));
    assert.equal(repo.countSessions('user-000'), 1); assert.equal(repo.countSessions('user-099'), 1);
    const foreign = await fetch(`http://127.0.0.1:${String(port)}/v1/sessions/user-000-session/messages`, { method: 'POST', headers: { Authorization: `Bearer ${users[99]!.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'cross-tenant' }) });
    assert.equal(foreign.status, 404);
  } finally { await close(); repo.close(); }
});

test('concurrent Session admission checks are serialized per user', async () => {
  const state = await setup();
  state.repo.updateProfile('alice', { maxConcurrentSessions: 1 }, 1);
  const url = `http://127.0.0.1:${String(state.port)}`;
  const headers = { Authorization: `Bearer ${state.alice.token}`, 'Content-Type': 'application/json' };
  try {
    const responses = await Promise.all([
      fetch(`${url}/v1/sessions`, { method: 'POST', headers, body: JSON.stringify({ sessionId: 'alice-session-a' }) }),
      fetch(`${url}/v1/sessions`, { method: 'POST', headers, body: JSON.stringify({ sessionId: 'alice-session-b' }) }),
    ]);
    assert.deepEqual(responses.map(response => response.status).sort((a, b) => a - b), [201, 429]);
    assert.equal(state.repo.countSessions('alice'), 1);
  } finally { await state.close(); state.repo.close(); }
});

test('trusted SSO can auto-provision a tenant and operators can create users', async () => {
  const repo = new TenantRepository(':memory:');
  const operator = repo.createUser({ id: 'operator', email: 'operator@example.com', token: 'operator-token-123456789012345678901234' });
  const composer = new ProfileComposer(repo);
  const supervisor = new HostSupervisor({ repository: repo, composer, sandbox: { ensure: async id => ({ id: `sandbox-${id}` }) }, launcher: { launch: async input => new FakeHost(input.userId, input.profile.version, `http://${input.userId}`) }, idleMs: 60_000 });
  const port = await freePort();
  const close = await startMultiTenantGateway({ repository: repo, composer, supervisor, port, operatorUserIds: ['operator'], autoProvisionIdentity: true,
    identityProvider: { authenticate: async req => ({ userId: req.headers['x-test-user'] as string, email: req.headers['x-test-email'] as string }) } });
  const url = `http://127.0.0.1:${String(port)}`;
  try {
    const first = await fetch(`${url}/v1/profile`, { headers: { 'x-test-user': 'sso-user', 'x-test-email': 'sso@example.com' } });
    assert.equal(first.status, 200); assert.equal((await first.json()).userId, 'sso-user');
    const users = await fetch(`${url}/v1/control/users`, { headers: { 'x-test-user': 'operator', 'x-test-email': 'operator@example.com' } });
    assert.equal(users.status, 200); assert.ok((await users.json()).users.some((item: any) => item.id === 'sso-user'));
    const created = await fetch(`${url}/v1/control/users`, { method: 'POST', headers: { 'x-test-user': 'operator', 'x-test-email': 'operator@example.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'manual-user', email: 'manual@example.com' }) });
    assert.equal(created.status, 201); assert.equal((await created.json()).user.id, 'manual-user');
    const disabled = await fetch(`${url}/v1/control/users/manual-user`, { method: 'PATCH', headers: { 'x-test-user': 'operator', 'x-test-email': 'operator@example.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'disabled' }) });
    assert.equal(disabled.status, 200); assert.equal((await disabled.json()).status, 'disabled');
    const denied = await fetch(`${url}/v1/profile`, { headers: { 'x-test-user': 'manual-user', 'x-test-email': 'manual@example.com' } });
    assert.equal(denied.status, 401);
  } finally { await close(); repo.close(); }
});

test('operator Gateway reuses DSH Hub enrollment and node revocation APIs', async () => {
  const repo = new TenantRepository(':memory:');
  const operator = repo.createUser({ id: 'operator', email: 'operator@example.com', token: 'operator-token-123456789012345678901234' });
  const composer = new ProfileComposer(repo);
  const supervisor = new HostSupervisor({ repository: repo, composer, sandbox: { ensure: async id => ({ id: `sandbox-${id}` }) }, launcher: { launch: async input => new FakeHost(input.userId, input.profile.version, `http://${input.userId}`) }, idleMs: 60_000 });
  const calls: string[] = [];
  const hub = {
    listNodes: async () => ({ nodes: [], runtimes: [] }), listSessions: async () => [], listAudit: async () => [],
    listEnrollments: async () => [{ nodeId: 'node-a', displayName: 'A', expiresAt: 1000, createdAt: 900 }],
    createEnrollment: async (input: { nodeId: string; displayName: string; expiresInSeconds?: number }) => { calls.push(`create:${input.nodeId}`); return { nodeId: input.nodeId, displayName: input.displayName, code: 'one-time-code', expiresAt: 1000, createdAt: 900 }; },
    cancelEnrollment: async (nodeId: string) => { calls.push(`cancel:${nodeId}`); },
    revokeNode: async (nodeId: string) => { calls.push(`revoke:${nodeId}`); },
  };
  const port = await freePort();
  const close = await startMultiTenantGateway({ repository: repo, composer, supervisor, port, hub, operatorUserIds: ['operator'] });
  const url = `http://127.0.0.1:${String(port)}`; const headers = { Authorization: `Bearer ${operator.token}`, 'Content-Type': 'application/json' };
  try {
    const pending = await fetch(`${url}/v1/control/enrollments`, { headers }); assert.equal(pending.status, 200); assert.equal((await pending.json()).enrollments[0].nodeId, 'node-a');
    const created = await fetch(`${url}/v1/control/enrollments`, { method: 'POST', headers, body: JSON.stringify({ nodeId: 'node-a', displayName: 'A', expiresInSeconds: 600 }) }); assert.equal(created.status, 201); assert.equal((await created.json()).code, 'one-time-code');
    const cancelled = await fetch(`${url}/v1/control/enrollments/node-a/cancel`, { method: 'POST', headers, body: '{}' }); assert.equal(cancelled.status, 200);
    const revoked = await fetch(`${url}/v1/control/nodes/node-a/revoke`, { method: 'POST', headers, body: '{}' }); assert.equal(revoked.status, 200);
    assert.deepEqual(calls, ['create:node-a', 'cancel:node-a', 'revoke:node-a']);
    const forbidden = await fetch(`${url}/v1/control/enrollments`, { headers: { Authorization: `Bearer ${operator.token}` } }); assert.equal(forbidden.status, 200);
  } finally { await close(); repo.close(); }
});
