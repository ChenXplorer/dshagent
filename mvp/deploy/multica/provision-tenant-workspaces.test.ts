import { createServer } from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TenantRepository } from '../../packages/tenant-control/index.ts';
import { provisionTenantWorkspaces } from './provision-tenant-workspaces.ts';

test('provisions and reuses one official Multica Workspace for each active tenant', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tenant-workspaces-'));
  const database = join(root, 'tenant.db'); const configPath = join(root, 'gateway.json');
  const repository = new TenantRepository(database);
  for (let index = 0; index < 100; index++) repository.createUser({ id: `user-${String(index).padStart(3, '0')}`, email: `user-${String(index)}@example.com` });
  repository.close();
  const workspaces: Array<{ id: string; slug: string }> = [{ id: 'existing', slug: 'existing' }]; let posts = 0;
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer private-token' || req.url !== '/api/workspaces/') { res.writeHead(401).end(); return; }
    if (req.method === 'GET') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(workspaces)); return; }
    let body = ''; for await (const chunk of req) body += chunk; const input = JSON.parse(body);
    const duplicate = workspaces.find(item => item.slug === input.slug); if (duplicate) { res.writeHead(409).end(); return; }
    const row = { id: `workspace-${String(++posts)}`, slug: input.slug }; workspaces.push(row);
    res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify(row));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing test address');
  const config = { database, standardRuntime: { multica: { localApiUrl: `http://127.0.0.1:${String(address.port)}`, token: 'private-token', workspaceId: 'existing' }, daemonTemplate: { token: 'private-token', workspaceId: 'existing', daemonId: 'base' }, userOverrides: {} } };
  await writeFile(configPath, `${JSON.stringify(config)}\n`, { mode: 0o600 }); await chmod(configPath, 0o600);
  try {
    const first = await provisionTenantWorkspaces({ configPath });
    assert.deepEqual({ users: first.users, created: first.created, reused: first.reused }, { users: 100, created: 100, reused: 0 });
    assert.equal(posts, 100);
    const saved = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(Object.keys(saved.standardRuntime.userOverrides).length, 100);
    assert.equal(saved.standardRuntime.userOverrides['user-042'].multica.workspaceId, 'workspace-43');
    assert.equal(saved.standardRuntime.userOverrides['user-042'].daemonTemplate.workspaceId, 'workspace-43');
    if (process.platform !== 'win32') assert.equal((await stat(configPath)).mode & 0o077, 0);
    const second = await provisionTenantWorkspaces({ configPath });
    assert.deepEqual({ users: second.users, created: second.created, reused: second.reused }, { users: 100, created: 0, reused: 100 });
    assert.equal(posts, 100);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});
