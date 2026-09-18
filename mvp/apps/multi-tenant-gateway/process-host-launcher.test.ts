import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProcessHostLauncher } from './process-host-launcher.ts';
import type { EffectiveProfile } from '../../packages/tenant-control/index.ts';

test('ProcessHostLauncher starts a real child process with a versioned per-user Profile and private Gateway token', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dshagent-host-'));
  const fakeScript = join(root, 'fake-host.mjs');
  await writeFile(fakeScript, `import { createServer } from 'node:http';
const webPort = Number(process.argv[process.argv.indexOf('--port') + 1]);
console.log('DSH Web http://127.0.0.1:' + webPort + '/?token=fake-launch-token');
const server = createServer((req,res) => { if (req.url === '/v1/health') { res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({ready:true,busy:false})); } else { res.writeHead(200, {'content-type':'application/json'}); res.end('{}'); } });
server.listen(Number(process.env.DSH_MVP_GATEWAY_PORT), '127.0.0.1');
process.on('SIGTERM', () => server.close(() => process.exit(0)));`);
  const profile: EffectiveProfile = { userId: 'alice', version: 7, plugins: [
    { id: 'alice-plugin', version: '1', modulePath: '/plugins/alice.js', enabled: true },
    { id: 'npm-plugin', packageName: '@example/dsh-plugin', version: '1.2.3', enabled: true },
  ], skills: [], defaultRuntime: 'codex', maxConcurrentSessions: 8, maxConcurrentTasks: 4, updatedAt: new Date().toISOString(), systemPlugins: [], systemSkills: [], daemons: [], loadMode: { plugins: 'host-start', skills: 'next-task' } };
  const launcher = new ProcessHostLauncher({ stateDirectory: root, dshStartScript: fakeScript, profileGeneratorScript: resolve('apps/dsh-host/create-profile.mjs'), driverModule: resolve('apps/dsh-host/create-driver.ts'),
    createDriverConfiguration: ({ userId, runtimeDirectory }) => ({ userId, defaultRuntime: 'codex', correlationDatabase: join(runtimeDirectory, 'correlation.db'), daytona: { apiUrl: 'http://daytona', apiKey: 'private', target: 'local', snapshot: 'snapshot' }, multica: { localApiUrl: 'http://multica', token: 'private', workspaceId: 'workspace' }, daemon: {} as any }) });
  try {
    const handle = await launcher.launch({ userId: 'alice', profile, sandbox: { id: 'sandbox-a' } });
    const health = await handle.request('/v1/health'); assert.equal(health.status, 200); assert.equal((await health.json()).ready, true);
    const generated = JSON.parse(await readFile(join(root, 'alice', 'host-v7', 'mvp.cordis.json'), 'utf8')) as any[];
    assert.equal(generated.some(row => row.insert?.some((entry: any) => entry.id === 'alice-plugin')), true);
    assert.equal(generated.some(row => row.insert?.some((entry: any) => entry.id === 'npm-plugin' && entry.name === '@example/dsh-plugin')), true);
    await handle.close();
    const upgraded = await launcher.launch({ userId: 'alice', profile: { ...profile, version: 8 }, sandbox: { id: 'sandbox-a' } });
    const v7 = JSON.parse(await readFile(join(root, 'alice', 'host-v7', 'mvp.cordis.json'), 'utf8')) as any[];
    const v8 = JSON.parse(await readFile(join(root, 'alice', 'host-v8', 'mvp.cordis.json'), 'utf8')) as any[];
    assert.equal(JSON.stringify(v7), JSON.stringify(generated)); assert.equal(v8.some(row => row.id === 'session-persistence-jsonl' && row.config.root === join(root, 'alice', 'sessions')), true);
    await upgraded.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
