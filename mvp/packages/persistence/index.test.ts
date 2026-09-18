import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { CorrelationRepository, type ReserveTaskInput } from './index.ts';

const connections = new Map<string, CorrelationRepository[]>();
function databasePath(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-correlations-'));
  const file = join(directory, 'correlations.sqlite');
  connections.set(file, []);
  t.after(() => {
    for (const repository of connections.get(file) ?? []) repository.close();
    connections.delete(file);
    rmSync(directory, { recursive: true, force: true });
  });
  return file;
}
function open(t: TestContext, path: string): CorrelationRepository {
  const repository = new CorrelationRepository(path);
  connections.get(path)!.push(repository);
  return repository;
}
function ready(repository: CorrelationRepository, userId = 'user-a'): void {
  repository.reserveSandbox(userId, `${userId}-create`);
  repository.completeSandboxCreation(userId, `${userId}-create`, `${userId}-sandbox`);
  repository.putExecutionSegment({ segmentId: `${userId}-segment`, userId, dshSessionId: `${userId}-dsh`, ordinal: 0, runtime: 'codex' });
}
const command = (id: string, userId = 'user-a'): ReserveTaskInput => ({
  requestId: id, userId, segmentId: `${userId}-segment`, inputDigest: 'a'.repeat(64),
});

test('Runtime selection persists across connections and enforces ownership and task guard', t => {
  const path = databasePath(t);
  const a = open(t, path); const b = open(t, path);
  a.selectRuntime('user-a', 'user-a-dsh', 'claude-code');
  assert.equal(b.getSelectedRuntime('user-a', 'user-a-dsh'), 'claude-code');
  assert.throws(() => b.selectRuntime('other', 'user-a-dsh', 'codex'), /owner/u);
  ready(a);
  a.reserveTask(command('request'));
  assert.throws(() => b.selectRuntime('user-a', 'user-a-dsh', 'codex'), /unresolved/u);
});

test('explicit empty failed reservation repair preserves audit and never clears changed/bound/referenced ownership', t => {
  const path = databasePath(t); const a = open(t, path); const b = open(t, path);
  a.reserveSandbox('empty', 'failed-create'); a.markSandboxCreationUnknown('empty', 'failed-create');
  const repair = { userId: 'empty', creationRequestId: 'failed-create', deletedSandboxId: 'verified-deleted', deletionEvidence: '/private/official-404.json' };
  assert.equal(b.clearUnboundSandboxAfterVerifiedDeletion({ ...repair, creationRequestId: 'stale' }), false);
  assert.equal(b.clearUnboundSandboxAfterVerifiedDeletion(repair), true);
  assert.equal(a.getSandbox('empty'), undefined);
  assert.equal(a.getSandboxReplacementAudits('empty')[0].deletedSandboxId, 'verified-deleted');
  assert.equal(a.reserveSandbox('empty', 'new-explicit-attempt').created, true);
  assert.equal(b.clearUnboundSandboxAfterVerifiedDeletion(repair), false);
  a.completeSandboxCreation('empty', 'new-explicit-attempt', 'real-new');
  assert.equal(b.clearUnboundSandboxAfterVerifiedDeletion({ ...repair, creationRequestId: 'new-explicit-attempt' }), false);
  a.reserveSandbox('referenced', 'referenced-create'); a.markSandboxCreationUnknown('referenced', 'referenced-create');
  a.putExecutionSegment({ segmentId: 'segment-referenced', userId: 'referenced', dshSessionId: 'referenced-session', ordinal: 0, runtime: 'codex' });
  assert.throws(() => b.clearUnboundSandboxAfterVerifiedDeletion({ ...repair, userId: 'referenced', creationRequestId: 'referenced-create' }), /references/u);
  assert.equal(a.getSandbox('referenced')?.state, 'creation_unknown');
});

test('definitive sandbox creation rejection releases only an unreferenced creating reservation', t => {
  const repository = open(t, databasePath(t));
  repository.reserveSandbox('user', 'request');
  assert.equal(repository.rejectSandboxCreation('user', 'request', 'daytona-http-400'), true);
  assert.equal(repository.getSandbox('user'), undefined);
  assert.deepEqual(repository.listSandboxCreationRejections('user').map(row => row.reason), ['daytona-http-400']);
  assert.equal(repository.rejectSandboxCreation('user', 'request', 'daytona-http-400'), false);
});

test('two independent connections reserve one personal sandbox and reject stale creation completion', t => {
  const file = databasePath(t);
  const first = open(t, file);
  const second = open(t, file);
  assert.equal(first.reserveSandbox('user', 'winner').created, true);
  const contender = second.reserveSandbox('user', 'loser');
  assert.equal(contender.created, false);
  assert.equal(contender.binding.creationRequestId, 'winner');
  assert.equal(second.completeSandboxCreation('user', 'loser', 'wrong-sandbox'), false);
  assert.equal(first.completeSandboxCreation('user', 'winner', 'sandbox'), true);
  assert.equal(second.getSandbox('user')?.sandboxId, 'sandbox');
  assert.equal(second.completeSandboxCreation('user', 'winner', 'replacement'), false);
});

test('actual concurrent worker connections have only one creation winner', async t => {
  const file = databasePath(t);
  // Initialize schema before workers so this test targets reservation contention.
  new CorrelationRepository(file).close();
  const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    import(workerData.moduleUrl).then(({CorrelationRepository}) => {
      const repository = new CorrelationRepository(workerData.file);
      parentPort.postMessage({ready:true});
      parentPort.once('message', () => {
        const result = repository.reserveSandbox('concurrent-user', workerData.id);
        repository.close();
        parentPort.postMessage({result});
        parentPort.close();
      });
    }).catch(error => { throw error; });
  `;
  const workers = ['request-1', 'request-2'].map(id => new Worker(source, {
    eval: true,
    execArgv: ['--experimental-strip-types'],
    workerData: { file, id, moduleUrl: new URL('./index.ts', import.meta.url).href },
  }));
  t.after(async () => { await Promise.all(workers.map(worker => worker.terminate())); });
  await Promise.all(workers.map(worker => new Promise<void>((resolve, reject) => {
    worker.once('error', reject);
    worker.once('message', () => resolve());
  })));
  const results = workers.map(worker => new Promise<{ created: boolean; binding: { creationRequestId: string } }>((resolve, reject) => {
    worker.once('error', reject);
    worker.once('message', message => resolve(message.result));
  }));
  for (const worker of workers) worker.postMessage('start');
  const reservations = await Promise.all(results);
  assert.equal(reservations.filter(result => result.created).length, 1);
  assert.equal(new Set(reservations.map(result => result.binding.creationRequestId)).size, 1);
});

test('unknown sandbox and submission intents survive restart without blind retry', t => {
  const file = databasePath(t);
  const first = new CorrelationRepository(file);
  first.reserveSandbox('unknown-user', 'first-create');
  first.markSandboxCreationUnknown('unknown-user', 'first-create');
  ready(first);
  first.reserveTask(command('request'));
  first.markTaskSubmissionUnknown('request');
  first.close();
  const restarted = open(t, file);
  const creation = restarted.reserveSandbox('unknown-user', 'new-attempt');
  assert.equal(creation.created, false);
  assert.equal(creation.binding.state, 'creation_unknown');
  const submission = restarted.reserveTask(command('request'));
  assert.equal(submission.created, false);
  assert.equal(submission.task.state, 'submission_unknown');
  assert.equal(restarted.beginSandboxPause('user-a'), false);
  assert.throws(() => restarted.updateTaskState('request', 'submission_unknown', 'failed'), /definitive rejection/u);
  assert.equal(restarted.completeTaskSubmission('request', 'reconciled-multica-task'), true);
  assert.equal(restarted.completeTaskSubmission('request', 'different-task'), false);
});

test('reserving a task and pausing sandbox exclude each other across two connections', t => {
  const file = databasePath(t);
  const first = open(t, file);
  const second = open(t, file);
  ready(first);
  first.reserveTask(command('task-1'));
  assert.equal(second.beginSandboxPause('user-a'), false);
  first.completeTaskSubmission('task-1', 'external-1');
  first.updateTaskState('task-1', 'submitted', 'completed');
  assert.equal(second.beginSandboxPause('user-a'), true);
  assert.throws(() => first.reserveTask(command('task-2')), /not ready/u);
  assert.equal(second.completeSandboxPause('user-a'), true);
  assert.throws(() => first.reserveTask(command('task-2')), /not ready/u);
  assert.equal(second.beginSandboxResume('user-a'), true);
  assert.throws(() => first.reserveTask(command('task-2')), /not ready/u);
  assert.equal(second.completeSandboxResume('user-a'), true);
  assert.equal(first.reserveTask(command('task-2')).created, true);
});

test('multiple same-runtime tasks remain independent when one cancels', t => {
  const repository = open(t, databasePath(t));
  ready(repository);
  repository.putExecutionSegment({ segmentId: 'second-segment', userId: 'user-a', dshSessionId: 'second-session', ordinal: 0, runtime: 'codex' });
  repository.reserveTask(command('first'));
  repository.reserveTask({ ...command('second'), segmentId: 'second-segment' });
  for (const id of ['first', 'second']) {
    repository.completeTaskSubmission(id, `external-${id}`);
    repository.updateTaskState(id, 'submitted', 'running');
  }
  assert.equal(repository.listActiveTasks('user-a').length, 2);
  assert.equal(repository.updateTaskState('first', 'running', 'cancel_requested'), true);
  assert.equal(repository.updateTaskState('first', 'running', 'failed'), false);
  assert.equal(repository.updateTaskState('first', 'cancel_requested', 'cancelled'), true);
  assert.equal(repository.getTask('second')?.state, 'running');
  assert.equal(repository.listActiveTasks('user-a').length, 1);
  assert.equal(repository.beginSandboxPause('user-a'), false);
});

test('request replay cannot change owner, payload digest or execution segment', t => {
  const repository = open(t, databasePath(t));
  ready(repository);
  ready(repository, 'user-b');
  repository.reserveTask(command('request'));
  assert.throws(() => repository.reserveTask(command('request', 'user-b')), /identity conflict/u);
  assert.throws(() => repository.reserveTask({ ...command('request'), inputDigest: 'b'.repeat(64) }), /identity conflict/u);
  assert.throws(() => repository.reserveTask({ ...command('new'), segmentId: 'user-b-segment' }), /does not belong/u);
  assert.throws(() => repository.putExecutionSegment({ segmentId: 'stolen', userId: 'user-b', dshSessionId: 'user-a-dsh', ordinal: 1, runtime: 'claude-code' }), /owner conflict/u);
});

test('shared external Chat Sessions remain scoped to one DSH session', t => {
  const repository = open(t, databasePath(t));
  ready(repository);
  repository.reserveSandbox('user-b', 'user-b-create');
  assert.throws(() => repository.completeSandboxCreation('user-b', 'user-b-create', 'user-a-sandbox'), /UNIQUE/u);
  assert.equal(repository.getSandbox('user-b')?.state, 'creating');
  repository.completeExecutionSegmentBinding('user-a-segment', 'multica-session');
  repository.putExecutionSegment({ segmentId: 'switched', userId: 'user-a', dshSessionId: 'user-a-dsh', ordinal: 1, runtime: 'claude-code' });
  assert.equal(repository.completeExecutionSegmentBinding('switched', 'multica-session'), true);
  assert.equal(repository.getLatestExecutionSegment('user-a', 'user-a-dsh')?.runtime, 'claude-code');
  repository.completeSandboxCreation('user-b', 'user-b-create', 'user-b-sandbox');
  repository.putExecutionSegment({ segmentId: 'foreign-segment', userId: 'user-b', dshSessionId: 'user-b-dsh', ordinal: 0, runtime: 'codex' });
  assert.throws(() => repository.completeExecutionSegmentBinding('foreign-segment', 'multica-session'), /owner conflict/u);
  repository.reserveTask(command('task-1'));
  repository.putExecutionSegment({ segmentId: 'independent', userId: 'user-a', dshSessionId: 'independent-session', ordinal: 0, runtime: 'codex' });
  repository.reserveTask({ ...command('task-2'), segmentId: 'independent' });
  repository.completeTaskSubmission('task-1', 'multica-task');
  assert.throws(() => repository.completeTaskSubmission('task-2', 'multica-task'), /UNIQUE/u);
  assert.equal(repository.getTask('task-2')?.state, 'reserved');
});

test('schema v4 migrates execution segments to shared Chat Session bindings', t => {
  const file = databasePath(t);
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    PRAGMA foreign_keys = OFF;
    CREATE TABLE sandbox_bindings (
      userId TEXT PRIMARY KEY,
      creationRequestId TEXT NOT NULL UNIQUE,
      sandboxId TEXT UNIQUE,
      state TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    ) STRICT;
    INSERT INTO sandbox_bindings VALUES ('user-a', 'create', 'sandbox-a', 'ready', '2026-09-14T00:00:00.000Z');
    CREATE TABLE execution_segments (
      segmentId TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      dshSessionId TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      runtime TEXT NOT NULL,
      externalSessionId TEXT UNIQUE,
      UNIQUE(userId,dshSessionId,ordinal)
    ) STRICT;
    INSERT INTO execution_segments VALUES ('legacy-segment', 'user-a', 'session-a', 0, 'codex', NULL);
    PRAGMA user_version = 4;
  `);
  legacy.close();
  const repository = open(t, file);
  assert.equal(repository.completeExecutionSegmentBinding('legacy-segment', 'chat-a'), true);
  repository.putExecutionSegment({ segmentId: 'migrated-segment', userId: 'user-a', dshSessionId: 'session-a', ordinal: 1, runtime: 'claude-code' });
  assert.equal(repository.completeExecutionSegmentBinding('migrated-segment', 'chat-a'), true);
});

test('definitive rejection frees admission guard but does not recycle the idempotency key', t => {
  const repository = open(t, databasePath(t));
  ready(repository);
  repository.reserveTask(command('rejected'));
  assert.throws(() => repository.confirmTaskSubmissionRejected('rejected', ''), /rejectionReference/u);
  assert.equal(repository.confirmTaskSubmissionRejected('rejected', 'multica-http-400-request-reference'), true);
  assert.equal(repository.listActiveTasks('user-a').length, 0);
  assert.equal(repository.reserveTask(command('rejected')).created, false);
  assert.equal(repository.getTask('rejected')?.state, 'failed');
  assert.throws(() => repository.updateTaskState('rejected', 'failed', 'running'), /Invalid/u);
});

test('outbound API payload, resource binding and flushed cursor survive a new connection', t => {
  const file = databasePath(t);
  const repository = open(t, file);
  ready(repository);
  assert.equal(repository.reserveSegmentProvisioning('user-a-segment'), true);
  assert.equal(repository.reserveSegmentProvisioning('user-a-segment'), false);
  repository.completeSegmentProvisioning({ segmentId: 'user-a-segment', daemonId: 'daemon', agentId: 'agent',
    runtimeId: 'runtime', projectId: 'project', chatSessionId: 'chat', workDir: '/workspace/session' });
  repository.reserveTask(command('request'));
  repository.saveTaskSubmission({ requestId: 'request', chatSessionId: 'chat', marker: 'marker', content: 'outbound content' });
  assert.equal(repository.advanceTaskCursor('request', 0, 2), true);
  assert.equal(repository.advanceTaskCursor('request', 0, 3), false);
  const second = open(t, file);
  assert.equal(second.getTaskSubmission('request')?.content, 'outbound content');
  assert.equal(second.getTaskCursor('request'), 2);
  assert.equal(second.getSegmentResources('user-a-segment')?.workDir, '/workspace/session');
  assert.throws(() => second.saveTaskSubmission({ requestId: 'request', chatSessionId: 'chat', marker: 'marker', content: 'different' }), /payload conflict/u);
});

test('cross-connection task admission blocks same DSH session and shared write directory only', t => {
  const file = databasePath(t);
  const first = open(t, file);
  const second = open(t, file);
  ready(first);
  const resources = { daemonId: 'daemon', agentId: 'agent', runtimeId: 'runtime', projectId: 'project', workDir: '/workspace/shared' };
  first.reserveSegmentProvisioning('user-a-segment');
  first.completeSegmentProvisioning({ ...resources, segmentId: 'user-a-segment', chatSessionId: 'chat-one' });
  first.reserveTask(command('first'));
  assert.throws(() => second.reserveTask(command('second')), /session already/u);
  first.putExecutionSegment({ segmentId: 'another-segment', userId: 'user-a', dshSessionId: 'another-session', ordinal: 0, runtime: 'codex' });
  first.reserveSegmentProvisioning('another-segment');
  first.completeSegmentProvisioning({ ...resources, segmentId: 'another-segment', chatSessionId: 'chat-two' });
  assert.throws(() => second.reserveTask({ ...command('second'), segmentId: 'another-segment' }), /Shared working directory/u);
});
