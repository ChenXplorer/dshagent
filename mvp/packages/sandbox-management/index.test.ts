import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Daytona } from '@daytona/sdk';
import { CorrelationRepository } from '../persistence/index.ts';
import { PERSONAL_SANDBOX_LABELS, PersonalSandboxError, PersonalSandboxService } from './index.ts';

interface FixtureSandbox {
  id: string;
  labels: Record<string, string>;
  state: string;
  autoStopInterval: number;
  autoDeleteInterval: number;
  autoArchiveInterval: number;
  toolboxProxyUrl: string;
  [key: string]: unknown;
}

/** HTTP unit fixture only: exercises the real SDK serialization, never claims a deployed sandbox. */
async function harness(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-daytona-sdk-unit-'));
  const databaseFile = join(directory, 'correlations.sqlite');
  const repositories: CorrelationRepository[] = [];
  const sandboxes = new Map<string, FixtureSandbox>();
  const requests: Array<{ method: string; path: string; body?: Record<string, unknown>; sdkVersion?: string }> = [];
  const faults = { loseNextCreate: false, rejectNextCreate: false, loseNextStop: false, hideList: false };
  let apiUrl = '';
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://fixture.invalid');
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString();
    const body: Record<string, unknown> | undefined = raw ? JSON.parse(raw) : undefined;
    requests.push({ method: request.method!, path: url.pathname, body, sdkVersion: request.headers['x-daytona-sdk-version'] as string | undefined });
    const reply = (data: unknown, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data)); };
    if (url.pathname === '/api/sandbox' && request.method === 'POST') {
      if (faults.rejectNextCreate) { faults.rejectNextCreate = false; reply({ message: 'No available runners' }, 400); return; }
      const id = `fixture-sandbox-${sandboxes.size + 1}`;
      const sandbox: FixtureSandbox = {
        id, name: id, organizationId: 'fixture-org', user: 'daytona', public: false,
        target: 'local', cpu: 2, memory: 4, disk: 20, state: 'started', snapshot: body?.snapshot,
        labels: body?.labels as Record<string, string>, autoStopInterval: body?.autoStopInterval as number,
        autoDeleteInterval: body?.autoDeleteInterval as number, autoArchiveInterval: body?.autoArchiveInterval as number,
        toolboxProxyUrl: `${apiUrl}/toolbox`, env: {},
      };
      sandboxes.set(id, sandbox);
      if (faults.loseNextCreate) { faults.loseNextCreate = false; request.socket.destroy(); return; }
      reply(sandbox); return;
    }
    if (url.pathname === '/api/sandbox' && request.method === 'GET') {
      const labels: Record<string, string> = JSON.parse(url.searchParams.get('labels') ?? '{}');
      const matches = faults.hideList ? [] : [...sandboxes.values()].filter(sandbox => Object.entries(labels).every(([key, value]) => sandbox.labels[key] === value));
      reply({ items: matches, nextCursor: null }); return;
    }
    const match = /^\/api\/sandbox\/([^/]+)(?:\/(.*))?$/u.exec(url.pathname);
    const sandbox = match ? sandboxes.get(decodeURIComponent(match[1])) : undefined;
    if (!sandbox) { reply({ message: 'Fixture route or sandbox not found' }, 404); return; }
    if (!match![2] && request.method === 'GET') { reply(sandbox); return; }
    if (match![2] === 'stop' && request.method === 'POST') {
      sandbox.state = 'stopped';
      if (faults.loseNextStop) { faults.loseNextStop = false; request.socket.destroy(); return; }
      reply({}); return;
    }
    if (match![2] === 'start' && request.method === 'POST') { sandbox.state = 'started'; reply(sandbox); return; }
    if (match![2]?.startsWith('autostop/')) { sandbox.autoStopInterval = Number(match![2].split('/')[1]); reply({}); return; }
    if (match![2]?.startsWith('autodelete/')) { sandbox.autoDeleteInterval = Number(match![2].split('/')[1]); reply({}); return; }
    reply({ message: 'Unexpected fixture operation' }, 400);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  apiUrl = `http://127.0.0.1:${address.port}/api`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const repository of repositories) repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const connect = () => { const repository = new CorrelationRepository(databaseFile); repositories.push(repository); return repository; };
  const repository = connect();
  const client = new Daytona({ apiKey: 'unit-fixture-token', apiUrl, target: 'local', otelEnabled: false });
  let readinessChecks = 0;
  let rejectReadiness = false;
  const service = (store = repository) => new PersonalSandboxService({
    client, repository: store, snapshot: 'fixture-official-snapshot', timeoutSeconds: 2,
    ensureExecutionReady: async () => { readinessChecks++; if (rejectReadiness) throw new Error('Unit simulated Daemon offline'); },
  });
  return { client, service, repository, connect, sandboxes, requests, faults, readinessChecks: () => readinessChecks, rejectReadiness: () => { rejectReadiness = true; } };
}

test('unit/real SDK: same user requests create only one labeled sandbox with automatic stop/delete disabled', async t => {
  const fixture = await harness(t);
  const service = fixture.service();
  const [first, second] = await Promise.all([service.ensurePersonalSandbox('user'), service.ensurePersonalSandbox('user')]);
  assert.equal(first.id, second.id);
  const creates = fixture.requests.filter(request => request.method === 'POST' && request.path === '/api/sandbox');
  assert.equal(creates.length, 1);
  assert.equal(creates[0].sdkVersion, '0.187.0');
  assert.equal(creates[0].body?.autoStopInterval, 0);
  assert.equal(creates[0].body?.autoDeleteInterval, -1);
  assert.equal(creates[0].body?.autoArchiveInterval, 0);
  assert.equal(creates[0].body?.public, false);
  assert.equal(first.labels[PERSONAL_SANDBOX_LABELS.user], 'user');
  assert.equal(fixture.repository.getSandbox('user')?.state, 'ready');
  assert.equal(fixture.readinessChecks(), 2);
});

test('unit/real SDK: lost create response is adopted by labels after restart, without another POST', async t => {
  const fixture = await harness(t);
  fixture.faults.loseNextCreate = true;
  await assert.rejects(fixture.service().ensurePersonalSandbox('user'), (error: PersonalSandboxError) => error.code === 'CREATION_UNKNOWN');
  assert.equal(fixture.repository.getSandbox('user')?.state, 'creation_unknown');
  const recovered = await fixture.service(fixture.connect()).ensurePersonalSandbox('user');
  assert.equal(recovered.id, 'fixture-sandbox-1');
  assert.equal(fixture.requests.filter(request => request.method === 'POST' && request.path === '/api/sandbox').length, 1);
});

test('unit/real SDK: list absence does not authorize a replacement create', async t => {
  const fixture = await harness(t);
  fixture.repository.reserveSandbox('user', 'existing-request');
  fixture.faults.hideList = true;
  await assert.rejects(fixture.service().ensurePersonalSandbox('user'), (error: PersonalSandboxError) => error.code === 'CREATION_UNKNOWN');
  assert.equal(fixture.requests.filter(request => request.method === 'POST').length, 0);
});

test('unit/real SDK: definitive 400 rejection releases only the empty reservation and permits a later retry', async t => {
  const fixture = await harness(t); const service = fixture.service();
  fixture.faults.rejectNextCreate = true;
  await assert.rejects(service.ensurePersonalSandbox('user'), (error: PersonalSandboxError) => error.code === 'PROVIDER_FAILURE');
  assert.equal(fixture.repository.getSandbox('user'), undefined);
  assert.equal(fixture.repository.listSandboxCreationRejections('user').length, 1);
  const sandbox = await service.ensurePersonalSandbox('user');
  assert.equal(sandbox.state, 'started');
  assert.equal(fixture.requests.filter(request => request.method === 'POST' && request.path === '/api/sandbox').length, 2);
});

test('unit/real SDK: active tasks forbid stop; idle stop/start preserves binding and reruns readiness', async t => {
  const fixture = await harness(t);
  const service = fixture.service();
  const sandbox = await service.ensurePersonalSandbox('user');
  fixture.repository.putExecutionSegment({ segmentId: 'segment', userId: 'user', dshSessionId: 'session', ordinal: 0, runtime: 'codex' });
  fixture.repository.reserveTask({ requestId: 'task', userId: 'user', segmentId: 'segment', inputDigest: 'a'.repeat(64) });
  await assert.rejects(service.pausePersonalSandbox('user'), (error: PersonalSandboxError) => error.code === 'ACTIVE_TASKS');
  assert.equal(fixture.requests.filter(request => request.path.endsWith('/stop')).length, 0);
  fixture.repository.completeTaskSubmission('task', 'multica-task');
  fixture.repository.updateTaskState('task', 'submitted', 'completed');
  await service.pausePersonalSandbox('user');
  assert.equal(fixture.repository.getSandbox('user')?.state, 'paused');
  assert.equal(fixture.sandboxes.get(sandbox.id)?.state, 'stopped');
  const resumed = await service.resumePersonalSandbox('user');
  assert.equal(resumed.id, sandbox.id);
  assert.equal(fixture.repository.getSandbox('user')?.state, 'ready');
  assert.equal(fixture.readinessChecks(), 2);
  assert.equal(fixture.requests.filter(request => request.path.endsWith('/start')).length, 1);
});

test('unit/real SDK: stop response loss keeps admission closed until positive state reconciliation', async t => {
  const fixture = await harness(t);
  const service = fixture.service();
  const sandbox = await service.ensurePersonalSandbox('user');
  fixture.faults.loseNextStop = true;
  await assert.rejects(service.pausePersonalSandbox('user'), (error: PersonalSandboxError) => error.code === 'LIFECYCLE_PENDING');
  assert.equal(fixture.repository.getSandbox('user')?.state, 'pausing');
  const resumed = await fixture.service(fixture.connect()).ensurePersonalSandbox('user');
  assert.equal(resumed.id, sandbox.id);
  assert.equal(fixture.requests.filter(request => request.path.endsWith('/stop')).length, 1);
  assert.equal(fixture.repository.getSandbox('user')?.state, 'ready');
});

test('unit/real SDK: readiness failure cannot mark a newly created sandbox ready', async t => {
  const fixture = await harness(t);
  fixture.rejectReadiness();
  await assert.rejects(fixture.service().ensurePersonalSandbox('user'), (error: PersonalSandboxError) => error.code === 'READINESS_FAILED');
  assert.equal(fixture.repository.getSandbox('user')?.state, 'creating');
  assert.equal(fixture.repository.getSandbox('user')?.sandboxId, null);
  await assert.rejects(fixture.service().ensurePersonalSandbox('user'), (error: PersonalSandboxError) => error.code === 'READINESS_FAILED');
  assert.equal(fixture.sandboxes.size, 1);
});

test('unit/real SDK: changed ownership labels prevent reuse and stop', async t => {
  const fixture = await harness(t);
  const service = fixture.service();
  const sandbox = await service.ensurePersonalSandbox('user');
  fixture.sandboxes.get(sandbox.id)!.labels[PERSONAL_SANDBOX_LABELS.user] = 'different-user';
  await assert.rejects(service.ensurePersonalSandbox('user'), (error: PersonalSandboxError) => error.code === 'OWNERSHIP_CONFLICT');
  await assert.rejects(service.pausePersonalSandbox('user'), (error: PersonalSandboxError) => error.code === 'OWNERSHIP_CONFLICT');
  assert.equal(fixture.requests.filter(request => request.path.endsWith('/stop')).length, 0);
});

test('unit/real SDK: caller deadline retains live creation operation instead of permitting another create', async t => {
  const fixture = await harness(t);
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const service = new PersonalSandboxService({
    client: fixture.client, repository: fixture.repository, snapshot: 'fixture-official-snapshot', timeoutSeconds: 0.2,
    ensureExecutionReady: async () => waiting,
  });
  await assert.rejects(service.ensurePersonalSandbox('user'), (error: PersonalSandboxError) => error.code === 'LIFECYCLE_PENDING');
  assert.equal(fixture.repository.getSandbox('user')?.state, 'creating');
  await assert.rejects(service.ensurePersonalSandbox('user'), (error: PersonalSandboxError) => error.code === 'LIFECYCLE_PENDING');
  assert.equal(fixture.requests.filter(request => request.method === 'POST' && request.path === '/api/sandbox').length, 1);
  release();
  assert.equal((await service.ensurePersonalSandbox('user')).id, 'fixture-sandbox-1');
  assert.equal(fixture.repository.getSandbox('user')?.state, 'ready');
});
