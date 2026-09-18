import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CorrelationRepository } from '../persistence/index.ts';
import { OfficialMulticaClient } from '../multica-client/index.ts';
import { TaskExecutionError, TaskOrchestrator, TaskPendingError, projectTaskMessage, type TaskDriverRequest, type TaskEventSink, type TaskOrchestratorOptions } from './index.ts';

/** Stateful official HTTP contract fixture: unit evidence only, not a real execution backend. */
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-driver-unit-'));
  const file = join(directory, 'state.sqlite');
  const repositories: CorrelationRepository[] = [];
  t.after(() => { for (const repository of repositories) repository.close(); rmSync(directory, { recursive: true, force: true }); });
  const connect = () => { const repository = new CorrelationRepository(file); repositories.push(repository); return repository; };
  const repository = connect();
  repository.reserveSandbox('user', 'create');
  repository.completeSandboxCreation('user', 'create', 'sandbox');
  const calls: Array<{ method: string; path: string }> = [];
  const submissions: Array<{ chat_session_id: string; role: string; content: string; task_id: string; id: string }> = [];
  const tasks = new Map<string, { id: string; agent_id: string; runtime_id: string; chat_session_id: string; status: string }>();
  const chats = new Map<string, { agentId: string; runtimeId: string }>();
  const provisions: Array<Parameters<TaskOrchestratorOptions['provisionExecutionSegment']>[0]> = [];
  const settlementBindings: Array<Parameters<TaskOrchestratorOptions['confirmTaskSettled']>[0]['binding']> = [];
  const control = { loseNextSubmit: false, completeImmediately: true, settled: true, gap: false, failProvision: false, cancelFailBefore: false, cancelLoseAfter: false };
  const client = new OfficialMulticaClient({
    baseUrl: 'http://unit.invalid', workspaceId: 'workspace', token: 'unit-only',
    fetchImpl: (async (input: string | URL | Request, init: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ method: init.method!, path: url.pathname });
      if (url.pathname === '/api/runtimes') return Response.json(['codex', 'claude'].map(provider => ({
        id: `runtime-${provider}`, daemon_id: 'daemon', workspace_id: 'workspace', provider, status: 'online', last_seen_at: new Date().toISOString(),
      })));
      const agentUpdate = /^\/api\/agents\/([^/]+)$/u.exec(url.pathname);
      if (agentUpdate && init.method === 'PUT') {
        const body = JSON.parse(init.body as string) as { runtime_id: string };
        return Response.json({ id: decodeURIComponent(agentUpdate[1]!), runtime_id: body.runtime_id, max_concurrent_tasks: 2 });
      }
      const messageRoute = /^\/api\/chat\/sessions\/([^/]+)\/messages$/u.exec(url.pathname);
      if (messageRoute) {
        const chatId = decodeURIComponent(messageRoute[1]);
        if (init.method === 'GET') return Response.json(submissions.filter(item => item.chat_session_id === chatId));
        const chat = chats.get(chatId)!;
        const id = `task-${tasks.size + 1}`;
        const body = JSON.parse(init.body as string);
        tasks.set(id, { id, agent_id: chat.agentId, runtime_id: chat.runtimeId, chat_session_id: chatId, status: control.completeImmediately ? 'completed' : 'running' });
        submissions.push({ id: `message-${id}`, task_id: id, chat_session_id: chatId, role: 'user', content: body.content });
        if (control.loseNextSubmit) { control.loseNextSubmit = false; throw new TypeError('unit response loss'); }
        return Response.json({ task_id: id, message_id: `message-${id}` });
      }
      const agentTasks = /^\/api\/agents\/([^/]+)\/tasks$/u.exec(url.pathname);
      if (agentTasks) return Response.json([...tasks.values()].filter(task => task.agent_id === decodeURIComponent(agentTasks[1])));
      const transcript = /^\/api\/tasks\/([^/]+)\/messages$/u.exec(url.pathname);
      if (transcript) {
        const seq = control.gap ? 2 : 1;
        return Response.json(Number(url.searchParams.get('since') ?? 0) >= seq ? [] : [{ task_id: transcript[1], seq, type: 'text', content: `output-${transcript[1]}`, created_at: '2026-09-14T00:00:00Z' }]);
      }
      const cancel = /^\/api\/tasks\/([^/]+)\/cancel$/u.exec(url.pathname);
      if (cancel) {
        if (control.cancelFailBefore) { control.cancelFailBefore = false; throw new TypeError('unit cancellation not delivered'); }
        const task = tasks.get(cancel[1])!; task.status = 'cancelled';
        if (control.cancelLoseAfter) { control.cancelLoseAfter = false; throw new TypeError('unit cancellation response lost'); }
        return Response.json(task);
      }
      throw new Error(`Unexpected unit route ${url.pathname}`);
    }) as typeof fetch,
  });
  const make = (store = repository, overrides: Partial<TaskOrchestratorOptions> = {}) => new TaskOrchestrator({
    userId: 'user', defaultRuntime: 'codex', repository: store, client, pollIntervalMs: 1, maxWaitMs: 1000,
    ensurePersonalSandbox: async () => ({ id: 'sandbox' }),
    provisionExecutionSegment: async input => {
      provisions.push(input);
      if (control.failProvision) throw new Error('unit provisioning transport failure');
      const provider = input.runtime === 'claude-code' ? 'claude' : 'codex';
      const chatSessionId = `chat-${input.dshSessionId}`;
      const resources = { daemonId: 'daemon', agentId: `agent-${input.dshSessionId}`, runtimeId: `runtime-${provider}`,
        projectId: `project-${input.dshSessionId}`, chatSessionId, workDir: `/workspace/${input.dshSessionId}` };
      chats.set(resources.chatSessionId, resources);
      return resources;
    },
    confirmTaskSettled: async input => {
      settlementBindings.push(input.binding);
      return { executionStopped: control.settled, transcriptFlushed: control.settled };
    },
    ...overrides,
  });
  return { make, connect, repository, submissions, tasks, calls, provisions, settlementBindings, control };
}
const request = (requestId: string, sessionId = 'session'): TaskDriverRequest => ({ requestId, sessionId, prompt: 'Modify the test file' });
const discard: TaskEventSink = async () => {};

test('unit: selected Runtime survives restart and unresolved task blocks another selection', async t => {
  const f = fixture(t);
  await f.make().selectRuntime('session', 'claude-code');
  await f.make(f.connect()).run(request('one'), discard);
  assert.equal(f.provisions[0].runtime, 'claude-code');
  f.control.completeImmediately = false;
  await assert.rejects(f.make(f.connect(), { maxWaitMs: 20 }).run(request('two'), discard), TaskPendingError);
  await assert.rejects(f.make().selectRuntime('session', 'codex'), /unresolved/u);
});

test('unit: genuine patched tool IDs project natively while truncation remains explicit', () => {
  const call = projectTaskMessage('call', { task_id: 'task', seq: 1, type: 'tool_use', call_id: 'genuine-id', tool: 'shell', input: { command: 'pwd' } });
  assert.equal(call.kind, 'tool-call');
  if (call.kind === 'tool-call') assert.equal(call.callId, 'genuine-id');
  const noArgs = projectTaskMessage('call-empty', { task_id: 'task', seq: 3, type: 'tool_use', call_id: 'empty-id', tool: 'get_status' });
  assert.equal(noArgs.kind, 'tool-call');
  if (noArgs.kind === 'tool-call') assert.equal(noArgs.arguments, '{}');
  const emptyResult = projectTaskMessage('result-empty', { task_id: 'task', seq: 4, type: 'tool_result', call_id: 'empty-id', output_truncated: false });
  assert.equal(emptyResult.kind, 'tool-result');
  const result = projectTaskMessage('result', { task_id: 'task', seq: 2, type: 'tool_result', call_id: 'genuine-id', output: '/workspace', output_truncated: true });
  assert.equal(result.kind, 'tool-result');
  if (result.kind === 'tool-result') { assert.equal(result.isError, undefined); assert.match(JSON.stringify(result.content), /truncated/u); }
});

test('unit: real API adapter submission is durable and a response-loss restart reconciles without another POST', async t => {
  const f = fixture(t);
  f.control.loseNextSubmit = true;
  await assert.rejects(f.make().run(request('request'), discard), TaskPendingError);
  assert.equal(f.repository.getTask('request')?.state, 'submission_unknown');
  await f.make(f.connect()).run(request('request'), discard);
  assert.equal(f.submissions.length, 1);
  assert.equal(f.provisions.length, 1);
  assert.equal(f.repository.getTask('request')?.state, 'completed');
});

test('unit: two Codex DSH sessions progress concurrently in one personal sandbox', async t => {
  const f = fixture(t);
  f.control.completeImmediately = false;
  const driver = f.make();
  const first = driver.run(request('first', 'session-one'), discard);
  const second = driver.run(request('second', 'session-two'), discard);
  for (let attempt = 0; f.tasks.size !== 2 && attempt < 100; attempt++) await delay(2);
  assert.equal(f.tasks.size, 2);
  assert.equal(f.repository.listActiveTasks('user').length, 2);
  assert.deepEqual(f.provisions.map(item => item.runtime), ['codex', 'codex']);
  for (const task of f.tasks.values()) task.status = 'completed';
  await Promise.all([first, second]);
  assert.equal(f.repository.listActiveTasks('user').length, 0);
});

test('unit: per-user Task quota rejects a third concurrent Session without affecting the first two', async t => {
  const f = fixture(t);
  f.control.completeImmediately = false;
  const driver = f.make(f.repository, { maxConcurrentTasks: 2 });
  const first = driver.run(request('quota-one', 'quota-session-one'), discard);
  const second = driver.run(request('quota-two', 'quota-session-two'), discard);
  for (let attempt = 0; f.tasks.size !== 2 && attempt < 100; attempt++) await delay(2);
  assert.equal(f.tasks.size, 2);
  await assert.rejects(driver.run(request('quota-three', 'quota-session-three'), discard), TaskPendingError);
  assert.equal(f.tasks.size, 2);
  for (const task of f.tasks.values()) task.status = 'completed';
  await Promise.all([first, second]);
  assert.equal(f.repository.listActiveTasks('user').length, 0);
});

test('unit: switching Codex to Claude and back reuses one Multica Chat Session and submits raw prompts', async t => {
  const f = fixture(t);
  const driver = f.make();
  await driver.run(request('one'), discard);
  await driver.run({ ...request('two'), runtime: 'claude-code' }, discard);
  await driver.run({ ...request('three'), runtime: 'codex' }, discard);
  await driver.run({ ...request('four'), runtime: 'codex' }, discard);
  assert.deepEqual(f.provisions.map(item => item.runtime), ['codex', 'claude-code', 'codex']);
  assert.equal(f.provisions[2].previous?.workDir, '/workspace/session');
  assert.equal(new Set(f.submissions.map(item => item.chat_session_id)).size, 1);
  assert.ok(f.settlementBindings.every(binding => binding.daemonId === 'daemon'));
  for (const submission of f.submissions) {
    assert.match(submission.content, /^Modify the test file\n\n<!-- dsh-request:[a-f0-9]{64} -->$/u);
    assert.doesNotMatch(submission.content, /previous work|Claude modified|do not reinject/u);
  }
});

test('unit: failed DSH durable append leaves cursor unchanged for a retry', async t => {
  const f = fixture(t);
  await assert.rejects(f.make().run(request('request'), async input => { if (input.kind === 'assistant') throw new Error('unit fsync failed'); }), /fsync/u);
  assert.equal(f.repository.getTaskCursor('request'), 0);
  const replayed: string[] = [];
  await f.make().run(request('request'), async input => { replayed.push(input.eventId); });
  assert.ok(replayed.includes('multica:task-1:message:1'));
  assert.equal(f.repository.getTaskCursor('request'), 1);
  assert.equal(f.submissions.length, 1);
});

test('unit: transcript gaps retain active task and do not falsely complete', async t => {
  const f = fixture(t);
  f.control.gap = true;
  await assert.rejects(f.make().run(request('request'), discard), /sequence gap/u);
  assert.equal(f.repository.getTaskCursor('request'), 0);
  assert.equal(f.repository.listActiveTasks('user').length, 1);
});

test('unit: cancellation remains active until process exit and transcript flush are both verified', async t => {
  const f = fixture(t);
  f.control.completeImmediately = false;
  f.control.settled = false;
  const controller = new AbortController();
  await assert.rejects(f.make(f.repository, { maxWaitMs: 100 }).run({ ...request('request'), signal: controller.signal }, async input => {
    if (input.kind === 'raw' && input.eventType === 'task-status') controller.abort();
  }), TaskPendingError);
  assert.equal(f.repository.getTask('request')?.state, 'cancel_requested');
  assert.equal(f.repository.beginSandboxPause('user'), false);
  f.control.settled = true;
  await assert.rejects(f.make().run(request('request'), discard), TaskExecutionError);
  assert.equal(f.repository.getTask('request')?.state, 'cancelled');
  assert.equal(f.calls.filter(call => call.path.endsWith('/cancel')).length, 1);
});

test('unit: uncertain segment provisioning changes subsequent callbacks to read-only reconciliation', async t => {
  const f = fixture(t);
  f.control.failProvision = true;
  await assert.rejects(f.make().run(request('first'), discard), TaskPendingError);
  await assert.rejects(f.make(f.connect()).run(request('first'), discard), TaskPendingError);
  assert.deepEqual(f.provisions.map(item => item.mode), ['create', 'reconcile']);
  assert.equal(f.submissions.length, 0);
});

for (const responseLost of [false, true]) test(`unit: cancellation ${responseLost ? 'response loss' : 'not delivered'} recovers from durable intent with a fresh signal`, async t => {
  const f = fixture(t); f.control.completeImmediately = false;
  if (responseLost) f.control.cancelLoseAfter = true; else f.control.cancelFailBefore = true;
  const abort = new AbortController();
  await assert.rejects(f.make().run({ ...request('request'), signal: abort.signal }, async input => {
    if (input.kind === 'raw' && input.eventType === 'task-status') abort.abort();
  }), TaskPendingError);
  assert.equal(f.repository.getTask('request')?.state, 'cancel_requested');
  assert.equal(f.repository.beginSandboxPause('user'), false);
  await assert.rejects(f.make(f.connect()).run(request('request'), discard), (error: TaskExecutionError) => error.outcome === 'cancelled');
  assert.equal(f.repository.getTask('request')?.state, 'cancelled');
  assert.equal(f.calls.filter(call => call.path.endsWith('/cancel')).length, responseLost ? 1 : 2);
  assert.equal(f.submissions.length, 1);
});

test('unit: unknown tool call identity is preserved raw, never fabricated into a native pair', () => {
  const raw = { task_id: 'task', seq: 1, type: 'tool_use', tool: 'Bash', input: { command: 'pwd' } };
  const projected = projectTaskMessage('task:1', raw);
  assert.equal(projected.kind, 'raw');
  assert.deepEqual(projected.raw, raw);
});
