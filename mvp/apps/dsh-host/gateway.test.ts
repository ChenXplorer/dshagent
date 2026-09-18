import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { SessionId } from '@deepseek-ai/dsh-session';
import { startGateway } from './gateway.ts';

test('Gateway enforces fixed identity/token and delegates native session operations and unchanged follow frames', async () => {
  // The business service is a test double here; actual Cordis/JSONL is tested
  // separately in dsh-loop. This exercises real HTTP and SSE protocol handling.
  const reservation = createServer();
  await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = (reservation.address() as AddressInfo).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const calls: Array<[string, unknown]> = [];
  const frame = { type: 'reset', reason: 'test' };
  const token = 'test-gateway-secret-32-characters-minimum';
  const controller: Parameters<typeof startGateway>[0] = {
    async create(input) { calls.push(['create', input]); return { sessionId: SessionId('real-id') }; },
    async prompt(input) { calls.push(['prompt', input]); return { accepted: true }; },
    cancel(input) { calls.push(['cancel', input]); return { accepted: true }; },
    async *follow(input) {
      calls.push(['follow', input]);
      // An opaque native frame passes through unchanged; projection belongs to DSH.
      yield frame as never;
    },
  };
  const close = await startGateway(controller, {
    async run() { throw new Error('Gateway must never execute the driver directly'); },
    async selectRuntime(id, runtime) { calls.push(['runtime', { id, runtime }]); },
  }, { token, userId: 'fixed-user', cwd: process.cwd(), port });
  const url = `http://127.0.0.1:${port}`;
  const post = (path: string, value: unknown) => fetch(url + path, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(value),
  });
  try {
    assert.equal((await fetch(url + '/v1/health')).status, 401);
    assert.equal((await post('/v1/sessions', { userId: 'another-user' })).status, 400);
    assert.deepEqual(await (await post('/v1/sessions', {})).json(), { sessionId: 'real-id' });
    assert.equal((calls[0]![1] as { cwd: string }).cwd, process.cwd());
    assert.deepEqual(await (await post('/v1/sessions/real-id/messages', { requestId: 'persist-me', text: 'hello' })).json(), { accepted: true });
    assert.deepEqual(calls[1], ['prompt', { sessionId: 'real-id', requestId: 'persist-me', mode: 'queue', content: [{ type: 'text', text: 'hello' }] }]);
    assert.deepEqual(await (await post('/v1/sessions/real-id/cancel', {})).json(), { accepted: true });
    assert.equal((await post('/v1/sessions/real-id/runtime', { runtime: 'unknown' })).status, 400);
    assert.deepEqual(await (await post('/v1/sessions/real-id/runtime', { runtime: 'codex' })).json(), { selected: 'codex' });
    const events = await fetch(url + '/v1/sessions/real-id/events', { headers: { authorization: `Bearer ${token}` } });
    assert.equal(await events.text(), `data: ${JSON.stringify(frame)}\n\n`);
    assert.deepEqual(calls.map(item => item[0]), ['create', 'prompt', 'cancel', 'runtime', 'follow']);
  } finally { await close(); }
});
