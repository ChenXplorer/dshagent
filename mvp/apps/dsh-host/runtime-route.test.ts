import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { runtimeRoute } from './runtime-route.ts';

test('browser runtime route authenticates, preserves selection and refuses active or invalid changes', async t => {
  let runtime: 'codex' | 'claude-code' = 'codex', busy = false, calls = 0;
  const server = createServer(runtimeRoute({ run: async () => {}, runtimeState: () => ({ runtime, busy: false }),
    selectRuntime: async (_id, next) => { runtime = next; calls++; } },
    { rejection: req => req.headers.cookie === 'unit-session' ? undefined : 401, agentBusy: () => busy }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${(server.address() as {port:number}).port}/mvp/runtime?sessionId=session-a`;
  const get = () => fetch(url, { headers: { cookie: 'unit-session' } });
  const post = (body: unknown) => fetch(url, { method: 'POST', headers: { cookie: 'unit-session', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await fetch(url)).status, 401);
  assert.deepEqual(await (await get()).json(), { runtime: 'codex', busy: false });
  assert.equal((await post({ runtime: 'claude-code' })).status, 200);
  assert.deepEqual(await (await get()).json(), { runtime: 'claude-code', busy: false });
  busy = true;
  assert.equal((await post({ runtime: 'codex' })).status, 409);
  assert.deepEqual(await (await get()).json(), { runtime: 'claude-code', busy: true });
  busy = false;
  assert.equal((await post({ runtime: 'codex', userId: 'other' })).status, 400);
  assert.equal((await post({ runtime: 'invalid' })).status, 400);
  assert.equal(calls, 1);
});
