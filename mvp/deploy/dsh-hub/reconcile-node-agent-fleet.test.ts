import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TenantRepository } from '../../packages/tenant-control/index.ts';
import { reconcileNodeAgentFleet } from './reconcile-node-agent-fleet.ts';

test('reconciles 100 active users into two persistent upstream Node Agent configs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-hub-fleet-'));
  const database = join(root, 'tenant.db');
  const repository = new TenantRepository(database);
  try {
    for (let index = 0; index < 100; index++) {
      const id = `user-${String(index).padStart(3, '0')}`;
      repository.createUser({ id, email: `${id}@example.com`, token: `${id}-token-123456789012345678901234` });
    }
  } finally { repository.close(); }
  const common = {
    hubUrl: 'http://127.0.0.1:19190', originSecret: 'o'.repeat(32),
    accessClientId: 'node.internal', accessClientSecret: 'x'.repeat(32),
    hubPublicKey: 'p'.repeat(80), dshExecutable: join(root, 'bin', 'dsh'),
  };
  try {
    const result = await reconcileNodeAgentFleet({ database, hostStateDirectory: join(root, 'hosts'), nodes: [
      { ...common, nodeId: 'tenant-node-a', runtimeIdTemplate: 'tenant-{userId}', stateDirectory: join(root, 'node-a'), ipcEndpoint: join(root, 'node-a.sock'), outputPath: join(root, 'node-a.json') },
      { ...common, nodeId: 'tenant-node-b', runtimeIdTemplate: 'tenant-{userId}', stateDirectory: join(root, 'node-b'), ipcEndpoint: join(root, 'node-b.sock'), outputPath: join(root, 'node-b.json') },
    ] });
    assert.equal(result.users, 100);
    assert.deepEqual(result.nodes.map(node => node.profiles), [50, 50]);
    const configs = await Promise.all(result.nodes.map(async node => JSON.parse(await readFile(node.outputPath, 'utf8')) as any));
    const profiles = configs.flatMap(config => config.management.profiles);
    assert.equal(profiles.length, 100);
    assert.equal(new Set(profiles.map((profile: any) => profile.runtimeId)).size, 100);
    assert.equal(new Set(profiles.map((profile: any) => profile.profileDirectory)).size, 100);
    assert.equal(profiles.every((profile: any) => profile.profileName === 'web' && profile.snapshotPaths.length === 1), true);
    assert.equal(configs.every(config => config.originSecret === 'o'.repeat(32)), true);
    await Promise.all(profiles.flatMap((profile: any) => [stat(profile.profileDirectory), stat(profile.snapshotPaths[0])]));
    const reopened = new TenantRepository(database);
    try { assert.equal(reopened.getHubProfileTarget('user-000')?.runtimeId, 'tenant-user-000'); }
    finally { reopened.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('fleet reconciliation refuses a single-node 100-user plan and invalid runtime templates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-hub-fleet-invalid-'));
  const database = join(root, 'tenant.db');
  const repository = new TenantRepository(database); repository.close();
  const node = { hubUrl: 'https://hub.example.com', nodeId: 'tenant-node-a', runtimeIdTemplate: 'web',
    accessClientId: 'client-id', accessClientSecret: 'x'.repeat(32), hubPublicKey: 'p'.repeat(80),
    stateDirectory: join(root, 'node'), ipcEndpoint: join(root, 'node.sock'), outputPath: join(root, 'node.json'), dshExecutable: join(root, 'bin', 'dsh') };
  try {
    await assert.rejects(reconcileNodeAgentFleet({ database, hostStateDirectory: join(root, 'hosts'), nodes: [node] }), /between 2 and 64/);
    await assert.rejects(reconcileNodeAgentFleet({ database, hostStateDirectory: join(root, 'hosts'), nodes: [node, { ...node, nodeId: 'tenant-node-b', outputPath: join(root, 'node-b.json') }] }), /must include \{userId\}/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
