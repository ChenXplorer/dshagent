import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { onboardTenant } from './onboard-tenant.ts';

test('onboards one tenant through existing Workspace and Hub fleet reconcilers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tenant-onboarding-'));
  const database = join(root, 'tenant.db');
  const gatewayConfigPath = join(root, 'gateway.json'); const fleetInputPath = join(root, 'fleet.json');
  const workspaces: Array<{ id: string; slug: string }> = [];
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer private-token' || req.url !== '/api/workspaces/') { res.writeHead(401).end(); return; }
    if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(workspaces)); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body) as { slug: string };
    const created = { id: `workspace-${String(workspaces.length + 1)}`, slug: input.slug }; workspaces.push(created);
    res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify(created));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing test server address');
  const common = { hubUrl: 'http://127.0.0.1:19190', originSecret: 'o'.repeat(32), accessClientId: 'node.internal', accessClientSecret: 'x'.repeat(32), hubPublicKey: 'p'.repeat(80), dshExecutable: join(root, 'bin', 'dsh') };
  const gateway = { database, standardRuntime: { multica: { localApiUrl: `http://127.0.0.1:${String(address.port)}`, token: 'private-token', workspaceId: 'base' }, daemonTemplate: { token: 'private-token', workspaceId: 'base', daemonId: 'base' }, userOverrides: {} } };
  const fleet = { database, hostStateDirectory: join(root, 'hosts'), nodes: [
    { ...common, nodeId: 'node-a', runtimeIdTemplate: 'tenant-{userId}', stateDirectory: join(root, 'node-a'), ipcEndpoint: join(root, 'node-a.sock'), outputPath: join(root, 'node-a.json') },
    { ...common, nodeId: 'node-b', runtimeIdTemplate: 'tenant-{userId}', stateDirectory: join(root, 'node-b'), ipcEndpoint: join(root, 'node-b.sock'), outputPath: join(root, 'node-b.json') },
  ] };
  await writeFile(gatewayConfigPath, JSON.stringify(gateway), { mode: 0o600 }); await chmod(gatewayConfigPath, 0o600);
  await writeFile(fleetInputPath, JSON.stringify(fleet), { mode: 0o600 });
  try {
    const result = await onboardTenant({ gatewayConfigPath, fleetInputPath, user: { id: 'alice', email: 'alice@example.com' } });
    assert.equal(result.created, true); assert.equal(result.workspaceId, 'workspace-1');
    assert.equal(result.workspaceProvisioning.created, 1); assert.equal(result.sandbox, 'created-on-first-host-acquire');
    assert.deepEqual(result.nodeAgentRestartRequired, [{ nodeId: 'node-a', configPath: join(root, 'node-a.json') }]);
    const saved = JSON.parse(await readFile(gatewayConfigPath, 'utf8')) as any;
    assert.equal(saved.standardRuntime.userOverrides.alice.multica.workspaceId, 'workspace-1');
    const retry = await onboardTenant({ gatewayConfigPath, fleetInputPath, user: { id: 'alice', email: 'alice@example.com' }, allowExisting: true });
    assert.equal(retry.created, false); assert.equal(retry.workspaceProvisioning.created, 0);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});
