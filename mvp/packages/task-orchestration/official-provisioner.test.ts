import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Daytona } from '@daytona/sdk';
import { OfficialMulticaClient } from '../multica-client/index.ts';
import { createOfficialSegmentProvisioner } from './official-provisioner.ts';

/** Actual SDK and adapter against a local HTTP contract fixture, not sandbox acceptance. */
async function fixture(t: TestContext) {
  const agents: Record<string, unknown>[] = [], projects: Record<string, unknown>[] = [], chats: Record<string, unknown>[] = [];
  const resourceMap = new Map<string, unknown[]>();
  const methods: string[] = [];
  let origin = '';
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://fixture.invalid');
    methods.push(req.method!);
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString(); const body = raw ? JSON.parse(raw) : {};
    const reply = (value: unknown, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (url.pathname === '/api/sandbox/sandbox') return reply({ id: 'sandbox', name: 'sandbox', organizationId: 'org', user: 'daytona',
      state: 'started', labels: { 'dsh-mvp-user-id': 'user' }, toolboxProxyUrl: `${origin}/toolbox`, env: {} });
    if (url.pathname.endsWith('/files/info')) return reply({ isDir: true });
    if (url.pathname === '/api/runtimes') return reply([
      { id: 'runtime-codex', daemon_id: 'daemon', workspace_id: 'workspace', provider: 'codex', status: 'online', last_seen_at: new Date().toISOString() },
      { id: 'runtime-claude', daemon_id: 'daemon', workspace_id: 'workspace', provider: 'claude', status: 'online', last_seen_at: new Date().toISOString() },
    ]);
    if (url.pathname === '/api/agents') {
      if (req.method === 'GET') return reply(agents);
      const agent = { ...body, id: `agent-${agents.length}`, workspace_id: 'workspace', custom_args: [], custom_env: {} }; agents.push(agent); return reply(agent);
    }
    const agentUpdate = /^\/api\/agents\/([^/]+)$/u.exec(url.pathname);
    if (agentUpdate && req.method === 'PUT') {
      const agent = agents.find(item => item.id === decodeURIComponent(agentUpdate[1]!));
      if (!agent) return reply({ message: 'agent not found' }, 404);
      Object.assign(agent, body);
      return reply(agent);
    }
    if (url.pathname === '/api/projects') {
      if (req.method === 'GET') return reply({ projects });
      const project = { id: `project-${projects.length}`, title: body.title, workspace_id: 'workspace' };
      projects.push(project); resourceMap.set(project.id, body.resources.map((resource: object) => ({ ...resource, id: 'resource' }))); return reply(project);
    }
    const resources = /^\/api\/projects\/([^/]+)\/resources$/u.exec(url.pathname);
    if (resources) return reply({ resources: resourceMap.get(resources[1]) });
    if (url.pathname === '/api/chat/sessions') {
      if (req.method === 'GET') return reply(chats);
      const chat = { ...body, id: `chat-${chats.length}`, workspace_id: 'workspace', status: 'active' }; chats.push(chat); return reply(chat);
    }
    reply({ message: `Unexpected fixture route ${url.pathname}` }, 400);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string'); origin = `http://127.0.0.1:${address.port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const provision = createOfficialSegmentProvisioner({
    daytona: new Daytona({ apiUrl: `${origin}/api`, apiKey: 'fixture', target: 'local', otelEnabled: false }),
    client: new OfficialMulticaClient({ baseUrl: origin, token: 'fixture', workspaceId: 'workspace' }),
    workspaceRoot: '/workspace', maxConcurrentTasks: 2, resolveDaemonId: async () => 'daemon',
  });
  return { provision, agents, projects, chats, methods, resourceMap };
}
const input = { mode: 'create' as const, userId: 'user', dshSessionId: 'session', segmentId: 'segment', runtime: 'codex' as const, sandboxId: 'sandbox' };

test('unit/official SDK: resources provision once then reconcile with reads only', async t => {
  const f = await fixture(t);
  const first = await f.provision(input);
  assert.equal(f.agents.length, 1); assert.equal(f.projects.length, 1); assert.equal(f.chats.length, 1);
  f.methods.length = 0;
  assert.deepEqual(await f.provision({ ...input, mode: 'reconcile' }), first);
  assert.ok(f.methods.every(method => method === 'GET'));
});

test('unit/official SDK: missing resource after uncertain provisioning never repeats create', async t => {
  const f = await fixture(t);
  await f.provision(input); f.chats.length = 0; f.methods.length = 0;
  await assert.rejects(f.provision({ ...input, mode: 'reconcile' }), /refusing another create/u);
  assert.ok(f.methods.every(method => method === 'GET'));
});

test('unit/official SDK: runtime switch rebinds the same Agent and reuses the same Chat Session', async t => {
  const f = await fixture(t);
  const first = await f.provision(input);
  const switched = await f.provision({ ...input, segmentId: 'segment-2', runtime: 'claude-code', previous: { ...first, segmentId: input.segmentId } });
  assert.equal(f.agents.length, 1);
  assert.equal(f.projects.length, 1);
  assert.equal(f.chats.length, 1);
  assert.equal(switched.chatSessionId, first.chatSessionId);
  assert.equal(switched.projectId, first.projectId);
  assert.equal(switched.workDir, first.workDir);
  assert.equal(f.agents[0].runtime_id, 'runtime-claude');
  assert.ok(f.methods.includes('PUT'));
});

test('unit/official SDK: post-upgrade switching adopts previous resources by ID without a second Chat', async t => {
  const f = await fixture(t);
  const first = await f.provision(input);
  (f.agents[0] as Record<string, unknown>).name = 'legacy segment agent';
  (f.projects[0] as Record<string, unknown>).title = 'legacy segment project';
  (f.chats[0] as Record<string, unknown>).title = 'legacy segment chat';
  const switched = await f.provision({ ...input, segmentId: 'segment-upgrade', runtime: 'claude-code', previous: { ...first, segmentId: input.segmentId } });
  assert.equal(f.agents.length, 1);
  assert.equal(f.projects.length, 1);
  assert.equal(f.chats.length, 1);
  assert.equal(switched.agentId, first.agentId);
  assert.equal(switched.projectId, first.projectId);
  assert.equal(switched.chatSessionId, first.chatSessionId);
});

test('unit/official SDK: adopted native CLI overrides and wrong directory are rejected', async t => {
  const f = await fixture(t);
  await f.provision(input); f.agents[0].model = 'unexpected-model';
  await assert.rejects(f.provision({ ...input, mode: 'reconcile' }), /overrides/u);
  delete f.agents[0].model; f.resourceMap.set('project-0', [{ id: 'wrong', resource_type: 'local_directory', resource_ref: { local_path: '/elsewhere' } }]);
  await assert.rejects(f.provision({ ...input, mode: 'reconcile' }), /directory\/Daemon/u);
});
