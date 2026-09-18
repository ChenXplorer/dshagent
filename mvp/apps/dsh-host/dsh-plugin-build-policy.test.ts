import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { preparePnpmBuildPolicy } from './dsh-plugin-build-policy.mjs';

test('Plugin build policy approves only configured packages and preserves an explicit denial', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-build-policy-'));
  await preparePnpmBuildPolicy(root, 'koffi');
  assert.match(await readFile(join(root, 'pnpm-workspace.yaml'), 'utf8'), /^allowBuilds:\n  koffi: true$/mu);
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'allowBuilds:\n  koffi: false\n  another: set this to true or false\n');
  await preparePnpmBuildPolicy(root, 'koffi,another');
  assert.equal(await readFile(join(root, 'pnpm-workspace.yaml'), 'utf8'), 'allowBuilds:\n  koffi: false\n  another: true\n');
});
