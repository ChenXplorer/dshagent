import assert from 'node:assert/strict';
import test from 'node:test';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import { DshTrajectoryWriter } from './index.ts';
import type { ExecutionBinding, TrajectoryInput } from './index.ts';

const binding: ExecutionBinding = { userId: 'user-a', sandboxId: 'daytona-a', taskId: 'task-a', runtime: 'codex', turn: 1, step: 1 };
const assistant: TrajectoryInput = { eventId: 'message-1', time: 1, kind: 'assistant', text: 'File updated.', raw: { content: 'File updated.' } };

function session(id = 'trajectory-test') {
  const value = Session.create(SessionId(id));
  value.append('turn/start', { turn: 1 });
  value.append('step/start', { turn: 1, step: 1 });
  return value;
}

test('real DSH Session derives native messages and retains raw records through JSON reload', async () => {
  const original = session();
  const writer = new DshTrajectoryWriter(original, { flush: async () => {} });
  await writer.append(assistant, binding);
  const loaded = Session.create(original.id, JSON.parse(JSON.stringify(original.snapshotEvents())), original.header);
  assert.equal(loaded.deriveMessages()[0]?.content[0]?.type, 'text');
  assert.equal(loaded.deriveMessages()[0]?.source.kind, 'model');
  const raw = loaded.snapshotEvents().find((event) => event.type === 'multica/event');
  assert.equal(raw?.ignorable, true);
  assert.deepEqual(raw?.data.raw, assistant.raw);
  const before = loaded.seq;
  const result = await new DshTrajectoryWriter(loaded, { flush: async () => {} }).append(assistant, binding);
  assert.equal(result.duplicate, true);
  assert.equal(loaded.seq, before);
});

test('native tool call/result IDs remain task scoped across repeated CLI call IDs', async () => {
  const value = session();
  const writer = new DshTrajectoryWriter(value, { flush: async () => {} });
  for (const taskId of ['task-a', 'task-b']) {
    await writer.append({ eventId: 'call-1', kind: 'tool-call', callId: '1', name: 'exec_command', arguments: '{"cmd":"pwd"}', time: 2, raw: {} }, { ...binding, taskId });
    await writer.append({ eventId: 'result-1', kind: 'tool-result', callId: '1', content: [{ type: 'text', text: '/workspace' }], time: 3, raw: {} }, { ...binding, taskId });
  }
  const calls = value.snapshotEvents().filter((event) => event.type === 'tool/call');
  const results = value.snapshotEvents().filter((event) => event.type === 'tool/result');
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0]?.data.callId, calls[1]?.data.callId);
  assert.equal(results[0]?.data.message.source.callId, calls[0]?.data.callId);
  assert.equal(results[1]?.data.message.source.callId, calls[1]?.data.callId);
});

test('unpaired tool results remain raw and replay projects only after the genuine call exists', async () => {
  const value = session();
  const writer = new DshTrajectoryWriter(value, { flush: async () => {} });
  const result: TrajectoryInput = { eventId: 'result-before-call', kind: 'tool-result', callId: 'real-id', content: [{ type: 'text', text: 'done' }], time: 2, raw: { call_id: 'real-id' } };
  await writer.append(result, binding);
  assert.equal(value.snapshotEvents().filter(event => event.type === 'tool/result').length, 0);
  assert.equal((await writer.append(result, binding)).duplicate, true);
  await writer.append({ eventId: 'actual-call', kind: 'tool-call', callId: 'real-id', name: 'get_status', arguments: '{}', time: 1, raw: {} }, binding);
  await writer.append(result, binding);
  assert.equal(value.snapshotEvents().filter(event => event.type === 'tool/result').length, 1);
  assert.equal(value.snapshotEvents().filter(event => event.type === 'multica/event').length, 2);
});

test('duplicate retry after failed flush checkpoints again without duplicating messages', async () => {
  const value = session();
  let flushes = 0;
  const writer = new DshTrajectoryWriter(value, { flush: async () => { if (++flushes === 1) throw new Error('disk unavailable'); } });
  await assert.rejects(writer.append(assistant, binding), /disk unavailable/);
  const result = await writer.append(assistant, binding);
  assert.equal(result.duplicate, true);
  assert.equal(flushes, 2);
  assert.equal(value.snapshotEvents().filter((event) => event.type === 'assistant/message').length, 1);
});

test('replay repairs the crash window between raw append and native projection', async () => {
  const complete = session('complete');
  await new DshTrajectoryWriter(complete, { flush: async () => {} }).append(assistant, binding);
  const cut = complete.snapshotEvents().filter((event) => event.type !== 'assistant/message');
  const restored = Session.create(complete.id, cut, complete.header);
  const result = await new DshTrajectoryWriter(restored, { flush: async () => {} }).append(assistant, binding);
  assert.equal(result.duplicate, false);
  assert.equal(restored.snapshotEvents().filter((event) => event.type === 'multica/event').length, 1);
  assert.equal(restored.snapshotEvents().filter((event) => event.type === 'assistant/message').length, 1);
});

test('same identity with changed payload is rejected, concurrent replays deduplicate', async () => {
  const value = session();
  const writer = new DshTrajectoryWriter(value, { flush: async () => {} });
  const results = await Promise.all([writer.append(assistant, binding), writer.append(assistant, binding)]);
  assert.deepEqual(results.map((result) => result.duplicate), [false, true]);
  await assert.rejects(writer.append({ ...assistant, text: 'changed' }, binding), /identity conflict/);
});

test('custom raw events cannot accidentally change the model-visible conversation', async () => {
  const value = session();
  await new DshTrajectoryWriter(value, { flush: async () => {} }).append({ kind: 'raw', eventType: 'daemon.offline', eventId: 'offline-1', time: 5, raw: { state: 'offline' } }, binding);
  assert.deepEqual(value.deriveMessages(), []);
  assert.throws(() => value.appendInformational('user/message' as 'multica/event', {} as never), /reserved/);
});
