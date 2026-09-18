import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session';
import SessionProjections from '@deepseek-ai/dsh-session-projection';
import Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { installMulticaFactory } from './index.ts';
import type { TaskDriver, TaskDriverRequest } from '../task-orchestration/index.ts';

async function fixture(driver: TaskDriver) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-multica-'));
  const ctx = new Context();
  await ctx.plugin(SessionStore);
  await ctx.plugin(SessionProjections);
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(Jsonl, { root, compression: 'none' });
  await ctx.plugin({ name: 'multica-loop-test', inject: ['agents', 'sessions', 'sessionProjections', 'sessionPersistence'], apply(pluginCtx: Context) { installMulticaFactory(pluginCtx, driver); } });
  return { ctx, async close() { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); } };
}
const prompt = (requestId: string) => createUserMessage({ content: [{ type: 'text', text: requestId }], source: { kind: 'user', rpcId: requestId } });

test('native AgentFactory queues turns and persists/reloads official JSONL plus raw trajectory', async () => {
  const calls: string[] = [];
  const requests: TaskDriverRequest[] = [];
  const f = await fixture({ async run(request, sink) {
    calls.push(request.requestId);
    requests.push(request);
    await sink({ kind: 'assistant', eventId: request.requestId, time: 1, raw: { answer: request.requestId }, text: `Answer ${request.requestId}` },
      { userId: 'u', taskId: request.requestId, sandboxId: 's', runtime: 'codex' });
  } });
  try {
    const handle = await f.ctx.agents.create({ sessionId: SessionId('native') });
    handle.agent.followup(prompt('one')); handle.agent.followup(prompt('two'));
    await handle.agent.whenIdle();
    assert.deepEqual(calls, ['one', 'two']);
    assert.equal('history' in requests[0]!, false);
    assert.deepEqual(requests.map(request => request.prompt), ['one', 'two']);
    assert.equal(handle.agent.session.snapshotEvents().filter(event => event.type === 'turn/end').length, 2);
    await handle.dispose();
    const resumed = await f.ctx.agents.resume({ resumeSessionId: SessionId('native') });
    assert.equal(resumed.agent.session.snapshotEvents().filter(event => event.type === 'multica/event').length, 2);
    assert.equal(resumed.agent.session.deriveMessages().length, 4);
    await resumed.dispose();
  } finally { await f.close(); }
});

test('unconfirmed task leaves native turn open, resume reuses rpcId, other sessions remain parallel', async () => {
  const calls: string[] = [];
  let attempt = 0;
  const f = await fixture({ async run(request) {
    calls.push(request.requestId);
    if (request.requestId === 'retry' && ++attempt === 1) { const error = new Error('pending'); error.name = 'TaskPendingError'; throw error; }
  } });
  try {
    const a = await f.ctx.agents.create({ sessionId: SessionId('a') });
    const b = await f.ctx.agents.create({ sessionId: SessionId('b') });
    a.agent.followup(prompt('retry')); b.agent.followup(prompt('parallel'));
    await Promise.all([a.agent.whenIdle(), b.agent.whenIdle()]);
    assert.equal(a.agent.session.snapshotEvents().some(event => event.type === 'turn/end'), false);
    assert.equal(b.agent.session.snapshotEvents().some(event => event.type === 'turn/end'), true);
    assert.throws(() => a.agent.followup(prompt('blocked')), /reconciliation/);
    await a.dispose();
    const resumed = await f.ctx.agents.resume({ resumeSessionId: SessionId('a') });
    await resumed.agent.whenIdle();
    assert.deepEqual(calls.filter(id => id === 'retry'), ['retry', 'retry']);
    assert.equal(resumed.agent.session.snapshotEvents().filter(event => event.type === 'user/message').length, 1);
    assert.equal(resumed.agent.session.snapshotEvents().filter(event => event.type === 'turn/end').length, 1);
    await resumed.dispose(); await b.dispose();
  } finally { await f.close(); }
});

test('setup rejection never publishes registries and permits retry identity', async () => {
  const f = await fixture({ async run() {} });
  try {
    let published = 0;
    f.ctx.on('agent/created', () => { published++; });
    await assert.rejects(f.ctx.agents.create({ sessionId: SessionId('setup'), setup() { throw new Error('invalid setup'); } }), /invalid setup/);
    assert.equal(published, 0);
    assert.equal(f.ctx.sessions.get(SessionId('setup')), undefined);
    await assert.rejects(f.ctx.agents.create({ sessionId: SessionId('setup'), setup() {
      return { commit() { throw new Error('invalid commit'); } };
    } }), /invalid commit/);
    assert.equal(published, 0);
    const ok = await f.ctx.agents.create({ sessionId: SessionId('setup') });
    await ok.dispose();
  } finally { await f.close(); }
});

test('halted observer persists only classified metadata and keeps the native turn open after reload', async () => {
  const secret = 'private-key-and-http-response-body';
  const f = await fixture({ async run() {
    const error = Object.assign(new Error(secret), { name: 'AxiosError', code: 'ECONNRESET', status: 503,
      response: { data: secret }, config: { headers: { authorization: secret } } });
    throw error;
  } });
  try {
    const handle = await f.ctx.agents.create({ sessionId: SessionId('diagnostic') });
    handle.agent.followup(prompt('diagnostic-request'));
    await handle.agent.whenIdle();
    const events = handle.agent.session.snapshotEvents();
    const event = events.find(event => event.type === 'multica/observer-error');
    assert.ok(event?.ignorable);
    assert.deepEqual(event.data, { requestId: 'diagnostic-request', turn: 1, step: 1,
      errorType: 'AxiosError', category: 'transport', transportCode: 'ECONNRESET', httpStatus: 503 });
    assert.equal(JSON.stringify(events).includes(secret), false);
    assert.equal(events.some(event => event.type === 'turn/end'), false);
    await handle.dispose();
    const stored = await f.ctx.sessionPersistence.open(SessionId('diagnostic'), 'read');
    try {
      const loaded = await stored.read(0);
      assert.deepEqual(loaded.events.find(item => item.type === 'multica/observer-error'), event);
    } finally { await stored.close(); }
  } finally { await f.close(); }
});

test('cancel keeps whenIdle pending until external execution confirms termination', async () => {
  let notifyStarted!: () => void;
  const started = new Promise<void>(resolve => { notifyStarted = resolve; });
  let confirm!: () => void;
  const confirmed = new Promise<void>(resolve => { confirm = resolve; });
  const f = await fixture({ async run(request) {
    notifyStarted();
    await new Promise<void>(resolve => request.signal!.addEventListener('abort', () => resolve(), { once: true }));
    await confirmed;
    const error = new Error('stopped'); error.name = 'TaskExecutionError'; throw error;
  } });
  try {
    const handle = await f.ctx.agents.create({ sessionId: SessionId('cancel') });
    handle.agent.followup(prompt('cancel-request'));
    await started;
    handle.agent.cancel({ kind: 'user' });
    let idle = false;
    const settled = handle.agent.whenIdle().then(() => { idle = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(idle, false);
    confirm(); await settled;
    const end = handle.agent.session.snapshotEvents().find(event => event.type === 'turn/end');
    assert.deepEqual(end?.data, { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } });
    await handle.dispose();
  } finally { await f.close(); }
});

test('caller abort during asynchronous setup rolls back native lifecycle', async () => {
  const f = await fixture({ async run() {} });
  try {
    const abort = new AbortController();
    let setupStarted!: () => void;
    const started = new Promise<void>(resolve => { setupStarted = resolve; });
    const creating = f.ctx.agents.create({ sessionId: SessionId('abort-setup'), signal: abort.signal,
      setup() { setupStarted(); return new Promise<void>(() => {}); } });
    await started; abort.abort(new Error('caller stopped'));
    await assert.rejects(creating, /caller stopped/);
    assert.equal(f.ctx.agents.get(SessionId('abort-setup')), undefined);
    assert.equal(f.ctx.sessions.get(SessionId('abort-setup')), undefined);
  } finally { await f.close(); }
});

test('steering at the next external boundary does not append a phantom empty turn', async () => {
  let firstStarted!: () => void;
  const started = new Promise<void>(resolve => { firstStarted = resolve; });
  let releaseFirst!: () => void;
  const release = new Promise<void>(resolve => { releaseFirst = resolve; });
  const calls: string[] = [];
  const f = await fixture({ async run(request) {
    calls.push(request.requestId);
    if (calls.length === 1) { firstStarted(); await release; }
  } });
  try {
    const handle = await f.ctx.agents.create({ sessionId: SessionId('steer') });
    handle.agent.followup(prompt('first')); await started;
    handle.agent.steer(prompt('steering')); releaseFirst();
    await handle.agent.whenIdle();
    assert.deepEqual(calls, ['first', 'steering']);
    const events = handle.agent.session.snapshotEvents();
    assert.equal(events.filter(event => event.type === 'step/start').length, 2);
    assert.equal(events.filter(event => event.type === 'turn/start').length, 1);
    assert.equal(events.filter(event => event.type === 'turn/end').length, 1);
    await handle.dispose();
  } finally { await f.close(); }
});
