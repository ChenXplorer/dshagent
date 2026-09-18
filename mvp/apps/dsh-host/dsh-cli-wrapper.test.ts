import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const run = promisify(execFile);

test('Hub-facing DSH CLI wrapper dispatches plugin commands with a private inferred DSH_HOME', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cli-wrapper-'));
  try {
    const profiles = join(root, 'profiles');
    const wrapper = fileURLToPath(new URL('./dsh-cli-wrapper.mjs', import.meta.url));
    await mkdir(profiles);
    const { stdout, stderr } = await run(process.execPath, [wrapper, 'plugin', '--profile', 'web', '--version'], {
      cwd: profiles,
      env: { ...process.env, DSH_HOME: '', DSH_PLUGIN_REGISTRY: 'https://packages.example.test/npm/' },
    });
    assert.match(`${stdout}${stderr}`, /\d+\.\d+\.\d+/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
