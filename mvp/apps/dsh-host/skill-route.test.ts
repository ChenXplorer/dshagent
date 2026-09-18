import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { skillRoute } from './skill-route.ts';

test('global Skill route lists and toggles DSH Skills behind the DSH auth boundary', async t => {
  let enabled = true, calls = 0;
  const server = createServer(skillRoute({
    run: async () => {},
    listManagedSkills: async () => ({ busy: false, skills: [{ key: 'dsh:anime', name: 'Anime', version: '1.0.0', description: 'style', attached: true, enabled }] }),
    setManagedSkillEnabled: async (key, next) => { assert.equal(key, 'dsh:anime'); enabled = next; calls++; return { busy: false, skills: [{ key: 'dsh:anime', name: 'Anime', version: '1.0.0', description: 'style', attached: true, enabled }] }; },
  }, { rejection: req => req.headers.cookie === 'unit-session' ? undefined : 401 }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mvp/skills`;
  const get = () => fetch(url, { headers: { cookie: 'unit-session' } });
  const post = (body: unknown) => fetch(url, { method: 'POST', headers: { cookie: 'unit-session', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await fetch(url)).status, 401);
  assert.deepEqual(await (await get()).json(), { busy: false, skills: [{ key: 'dsh:anime', name: 'Anime', version: '1.0.0', description: 'style', attached: true, enabled: true }] });
  assert.equal((await post({ key: 'dsh:anime', enabled: false })).status, 200);
  assert.deepEqual(await (await get()).json(), { busy: false, skills: [{ key: 'dsh:anime', name: 'Anime', version: '1.0.0', description: 'style', attached: true, enabled: false }] });
  assert.equal((await post({ key: 'dsh:anime' })).status, 400);
  assert.equal((await fetch(url, { method: 'DELETE', headers: { cookie: 'unit-session' } })).status, 405);
  assert.equal(calls, 1);
});
