import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HostSupervisor, PersistentTenantSandboxManager, ProfileComposer, TenantRepository, filterRuntimesForUser, type EffectiveProfile, type HostLaunchInput, type TenantHostHandle } from './index.ts';

async function withRepo<T>(fn: (repo: TenantRepository) => Promise<T> | T): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'dshagent-tenant-')); const repo = new TenantRepository(join(root, 'control.db'));
  try { return await fn(repo); } finally { repo.close(); await rm(root, { recursive: true, force: true }); }
}

class FakeHost implements TenantHostHandle {
  readonly requests: Array<{ path: string; init?: unknown }> = [];
  closed = false; drained = false;
  constructor(readonly userId: string, readonly profileVersion: number, readonly baseUrl: string) {}
  async request(path: string, init?: unknown): Promise<Response> {
    this.requests.push({ path, init });
    if (path === '/v1/runtimes') return Response.json({ runtimes: [
      { runtimeId: 'r-codex', daemonId: 'daemon-a', kind: 'codex', label: 'A Codex' },
      { runtimeId: 'r-claude', daemonId: 'daemon-b', kind: 'claude-code', label: 'B Claude' },
    ] });
    if (path === '/v1/sessions') return Response.json({ sessionId: `${this.userId}-session` }, { status: 201 });
    if (path === '/mvp/skills') return Response.json({ skills: [] });
    return Response.json({ accepted: true, path });
  }
  async drain(): Promise<void> { this.drained = true; }
  async close(): Promise<void> { this.closed = true; }
}

test('TenantRepository isolates users, versions Profile changes, and keeps Skill updates next-task', async () => {
  await withRepo(repo => {
    const alice = repo.createUser({ id: 'alice', email: 'alice@example.com', token: 'alice-token-123456789012345678901234' });
    const bob = repo.createUser({ id: 'bob', email: 'bob@example.com', token: 'bob-token-123456789012345678901234' });
    assert.equal(repo.authenticate(alice.token)?.id, 'alice');
    assert.equal(repo.authenticate(bob.token)?.id, 'bob');
    assert.equal(repo.authenticate('wrong-token'), undefined);
    const v2 = repo.updateProfile('alice', { plugins: [{ id: 'alice-plugin', version: '1.0.0', modulePath: '/plugins/alice/index.js', enabled: true }] }, 1);
    assert.equal(v2.version, 2);
    assert.equal(repo.getProfile('bob').plugins.length, 0);
    const skill = { key: 'a-skill', name: 'Alice Skill', version: '1', description: '', content: 'do alice things', enabled: true };
    const afterSkill = repo.updateSkills('alice', [skill]);
    assert.equal(afterSkill.version, 2, 'Skill changes do not create a Host/Profile restart version');
    assert.equal(repo.getProfile('alice').skills[0]?.key, 'a-skill');
    const v3 = repo.rollbackProfile('alice', 1, 2);
    assert.equal(v3.version, 3);
    assert.equal(repo.getProfile('alice').plugins.length, 0);
    assert.equal(repo.getProfile('alice').skills.length, 1, 'rollback preserves current Skill declarations');
    assert.equal(repo.listProfileRevisions('alice').length, 3);
  });
});

test('TenantRepository counts active Sessions, allows explicit close, and reopens durable DSH history', async () => {
  await withRepo(repo => {
    repo.createUser({ id: 'alice', email: 'alice@example.com' });
    assert.equal(repo.countSessions('alice'), 0);
    const first = repo.saveSession('alice', 'session-1');
    assert.equal(first.status, 'active');
    assert.equal(repo.countSessions('alice'), 1);
    assert.equal(repo.closeSession('alice', 'session-1'), true);
    assert.equal(repo.countSessions('alice'), 0);
    assert.equal(repo.closeSession('alice', 'session-1'), false);
    const reopened = repo.touchSession('alice', 'session-1');
    assert.equal(reopened.status, 'active');
    assert.equal(repo.countSessions('alice'), 1);
  });
});

test('ProfileComposer keeps system baseline separate from user Profile', async () => {
  await withRepo(repo => {
    repo.createUser({ id: 'alice', email: 'alice@example.com' });
    const composer = new ProfileComposer(repo, {
      systemPlugins: [{ id: 'system-loop', version: '1', modulePath: '/system/loop.js', enabled: true }],
      systemSkills: [{ key: 'system-skill', name: 'System Skill', version: '1', description: '', content: 'baseline', enabled: true }],
    });
    const profile = composer.compose('alice');
    assert.deepEqual(profile.systemPlugins.map(item => item.id), ['system-loop']);
    assert.deepEqual(profile.systemSkills.map(item => item.key), ['system-skill']);
    assert.deepEqual(profile.loadMode, { plugins: 'host-start', skills: 'next-task' });
  });
});

test('Tenant Profile cannot shadow the DSH Agent Loop or platform plugins', async () => {
  await withRepo(repo => {
    repo.createUser({ id: 'alice', email: 'alice@example.com' });
    assert.throws(() => repo.updateProfile('alice', { plugins: [{ id: 'agent-loop', version: '1.0.0', modulePath: '/plugins/replace.js', enabled: true }] }), /reserved by DSH/);
  });
});

test('Tenant Plugins may use an exact Hub-managed npm package without a local module path', async () => {
  await withRepo(repo => {
    repo.createUser({ id: 'alice', email: 'alice@example.com' });
    const next = repo.updateProfile('alice', { plugins: [{ id: 'alice-plugin', packageName: '@example/dsh-plugin', version: '1.2.3', enabled: true }] });
    assert.deepEqual(next.plugins[0], { id: 'alice-plugin', packageName: '@example/dsh-plugin', version: '1.2.3', enabled: true });
    assert.throws(() => repo.updateProfile('alice', { plugins: [{ id: 'bad', version: '1.0.0', enabled: true } as any] }), /packageName or modulePath/);
    assert.throws(() => repo.updateProfile('alice', { plugins: [{ id: 'bad', packageName: '../escape', version: '1.0.0', enabled: true }] }), /valid npm package name/);
  });
});

test('Runtime catalog is deny-by-default until a user Daemon is registered', () => {
  const runtimes = [{ runtimeId: 'r', daemonId: 'd', kind: 'codex', label: 'Codex', status: 'online' }] as any;
  assert.deepEqual(filterRuntimesForUser(runtimes, []), []);
});

test('Hub Profile targets balance 100 tenants, persist assignment and enforce node capacity', async () => {
  await withRepo(repo => {
    const assignments = [] as Array<{ userId: string; nodeId: string; runtimeId: string }>;
    for (let index = 0; index < 100; index++) {
      const userId = `user-${String(index).padStart(3, '0')}`;
      repo.createUser({ id: userId, email: `${userId}@example.com` });
      assignments.push(repo.assignHubProfileTarget(userId, [
        { nodeId: 'node-a', runtimeId: `tenant-${userId}` },
        { nodeId: 'node-b', runtimeId: `tenant-${userId}` },
      ]));
    }
    assert.equal(assignments.filter(item => item.nodeId === 'node-a').length, 50);
    assert.equal(assignments.filter(item => item.nodeId === 'node-b').length, 50);
    const first = assignments[0]!;
    assert.deepEqual(repo.assignHubProfileTarget(first.userId, [
      { nodeId: 'node-a', runtimeId: `tenant-${first.userId}` },
      { nodeId: 'node-b', runtimeId: `tenant-${first.userId}` },
    ]), repo.getHubProfileTarget(first.userId));
    assert.throws(() => repo.assignHubProfileTarget(first.userId, [
      { nodeId: 'node-c', runtimeId: `tenant-${first.userId}` },
    ]), /absent from the configured shard set/u);
  });
});

test('PersistentTenantSandboxManager registers exactly one managed default Daemon per user Sandbox', async () => {
  await withRepo(async repo => {
    repo.createUser({ id: 'alice', email: 'alice@example.com' });
    let creates = 0;
    const manager = new PersistentTenantSandboxManager(repo, {
      provider: 'daytona',
      ensure: async () => ({ id: `sandbox-${++creates}` }),
      defaultDaemon: userId => ({ label: `Default ${userId}`, daemonId: `daemon-${userId}`, workspaceId: 'w', runtimeIds: [], managed: true, status: 'online' }),
    });
    assert.equal((await manager.ensure('alice')).id, 'sandbox-1');
    assert.equal((await manager.ensure('alice')).id, 'sandbox-1');
    assert.equal(repo.listDaemons('alice').length, 1);
    assert.equal(repo.listDaemons('alice')[0]!.managed, true);
    assert.equal(creates, 1);
  });
});

test('HostSupervisor starts one Host per user, serializes starts, and stops idle Hosts', async () => {
  await withRepo(async repo => {
    repo.createUser({ id: 'alice', email: 'alice@example.com' }); repo.createUser({ id: 'bob', email: 'bob@example.com' });
    const composer = new ProfileComposer(repo); const launched: FakeHost[] = [];
    const launcher = { launch: async (input: HostLaunchInput) => { const host = new FakeHost(input.userId, input.profile.version, `http://${input.userId}`); launched.push(host); return host; } };
    let clock = 0;
    const supervisor = new HostSupervisor({ repository: repo, composer, sandbox: { ensure: async userId => ({ id: `sandbox-${userId}` }) }, launcher,
      idleMs: 100, now: () => clock });
    const [aliceA, aliceB, bob] = await Promise.all([supervisor.acquire('alice'), supervisor.acquire('alice'), supervisor.acquire('bob')]);
    assert.equal(aliceA, aliceB); assert.notEqual(aliceA, bob); assert.equal(launched.length, 2);
    supervisor.release('alice'); supervisor.release('alice'); supervisor.release('bob');
    clock = 101; const stopped = await supervisor.stopIdle();
    assert.deepEqual(stopped.sort(), ['alice', 'bob']); assert.equal(launched.every(host => host.closed), true);
    const next = await supervisor.acquire('alice'); assert.notEqual(next, aliceA); assert.equal(launched.length, 3);
  });
});

test('HostSupervisor applies a DSH Hub Profile before first launch and skips duplicate idle wake-ups', async () => {
  await withRepo(async repo => {
    repo.createUser({ id: 'alice', email: 'alice@example.com' });
    const composer = new ProfileComposer(repo); const calls: string[] = []; let launches = 0; let clock = 0;
    const supervisor = new HostSupervisor({ repository: repo, composer, sandbox: { ensure: async () => ({ id: 'sandbox' }) },
      applyProfile: async ({ userId, profile }) => { calls.push(`apply:${userId}:v${profile.version}`); },
      launcher: { launch: async input => { calls.push(`launch:v${input.profile.version}`); launches++; return new FakeHost(input.userId, input.profile.version, `http://${input.userId}-${String(launches)}`); } }, idleMs: 1, now: () => clock });
    await supervisor.acquire('alice'); supervisor.release('alice');
    assert.deepEqual(calls, ['apply:alice:v1', 'launch:v1']);
    clock = 2;
    await supervisor.stopIdle();
    await supervisor.acquire('alice');
    assert.deepEqual(calls, ['apply:alice:v1', 'launch:v1', 'launch:v1']);
    await supervisor.closeAll();
  });
});
