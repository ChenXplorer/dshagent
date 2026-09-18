import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

test('pinned Hub patch keeps internal control traffic explicit and loopback-only', async () => {
  const manifest = JSON.parse(await readFile(resolve(root, '../patches/dsh-hub/manifest.json'), 'utf8')) as {
    id: string; patch: string; sha256: string; baseCommit: string;
  };
  const patch = await readFile(resolve(root, '../patches/dsh-hub', manifest.patch));
  assert.equal(createHash('sha256').update(patch).digest('hex'), manifest.sha256);
  assert.equal(manifest.baseCommit, 'cc730d0091337767e437e0964c9f93ba3f490de7');
  assert.match(manifest.id, /internal-auth-v4$/u);

  const text = patch.toString('utf8');
  assert.match(text, /DSH_HUB_INTERNAL_AUTH/u);
  assert.match(text, /HTTP loopback DSH_HUB_PUBLIC_ORIGIN/u);
  assert.match(text, /InternalAccessVerifier/u);
  assert.match(text, /internal operator token must contain at least 32 characters/u);
  assert.match(text, /loopback HTTP requires originSecret/u);
  assert.match(text, /url\.protocol === 'http:' \? 'ws:' : 'wss:'/u);
  assert.match(text, /pnpm-lock\.yaml/u);
  assert.match(text, /managed\.filter\(plugin => plugin\.packageName !== change\.packageName\)/u);
  assert.match(text, /checkedAt: _checkedAt/u);

  const compose = await readFile(resolve(root, 'compose.yaml'), 'utf8');
  assert.match(compose, /127\.0\.0\.1:\$\{DSH_HUB_BIND_PORT/u);
  const example = await readFile(resolve(root, '.env.example'), 'utf8');
  assert.match(example, /DSH_HUB_INTERNAL_AUTH=true/u);
});
