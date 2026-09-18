import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { TenantRepository } from '../../packages/tenant-control/index.ts';
import { reconcileNodeAgentFleet } from './reconcile-node-agent-fleet.ts';
import { verifyTenantFleet } from './verify-tenant-fleet.ts';

test('read-only fleet verifier requires every tenant Workspace, stable target, rendered Profile and live Hub Runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-fleet-verify-'));
  const database = join(root, 'tenant.db'); const gatewayConfigPath = join(root, 'gateway.json'); const fleetInputPath = join(root, 'fleet.json');
  const repository = new TenantRepository(database);
  for (const id of ['alice', 'bob']) repository.createUser({ id, email: `${id}@example.com` });
  repository.close();
  const common = { hubUrl: 'https://hub.example.test', accessClientId: 'node.internal', accessClientSecret: 'x'.repeat(32), hubPublicKey: 'p'.repeat(80), dshExecutable: join(root, 'bin', 'dsh') };
  const fleet = { database, hostStateDirectory: join(root, 'hosts'), nodes: [
    { ...common, nodeId: 'node-a', runtimeIdTemplate: 'tenant-{userId}', stateDirectory: join(root, 'node-a'), ipcEndpoint: join(root, 'node-a.sock'), outputPath: join(root, 'node-a.json') },
    { ...common, nodeId: 'node-b', runtimeIdTemplate: 'tenant-{userId}', stateDirectory: join(root, 'node-b'), ipcEndpoint: join(root, 'node-b.sock'), outputPath: join(root, 'node-b.json') },
  ] };
  await reconcileNodeAgentFleet(fleet);
  const gateway = { database, standardRuntime: { userOverrides: { alice: { multica: { workspaceId: 'workspace-a' } }, bob: { multica: { workspaceId: 'workspace-b' } } }, hub: undefined }, hub: { baseUrl: 'https://hub.example.test', internalOperatorToken: 't'.repeat(32), originSecret: 'o'.repeat(32) } };
  // Keep the production shape: standardRuntime contains both settings and tenant overrides.
  gateway.standardRuntime.hub = undefined;
  await writeFile(gatewayConfigPath, JSON.stringify(gateway), { mode: 0o600 }); await chmod(gatewayConfigPath, 0o600);
  await writeFile(fleetInputPath, JSON.stringify(fleet), { mode: 0o600 });
  const targets = new TenantRepository(database);
  const mappings = ['alice', 'bob'].map(id => targets.getHubProfileTarget(id)!); targets.close();
  const result = await verifyTenantFleet({ gatewayConfigPath, fleetInputPath, minimumActiveUsers: 2, fetchImpl: async input => {
    const url = new URL(String(input));
    assert.equal(url.pathname, '/hub/v1/nodes');
    return new Response(JSON.stringify({ nodes: [{ nodeId: 'node-a', displayName: 'A', online: true }, { nodeId: 'node-b', displayName: 'B', online: true }], runtimes: mappings.map(target => ({ runtimeId: target.runtimeId, nodeId: target.nodeId, online: true })) }), { status: 200, headers: { 'content-type': 'application/json' } });
  } });
  try {
    assert.equal(result.activeUsers, 2); assert.equal(result.privateWorkspaceOverrides, 2); assert.equal(result.hub.verifiedTargetRuntimes, 2);
    assert.deepEqual(result.nodes.map(node => node.configuredProfiles), [1, 1]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
