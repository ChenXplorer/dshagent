import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const path = process.argv[2];
if (!path) throw new Error('Pass the private DSH profile path');
const profile = JSON.parse(await readFile(path, 'utf8'));
if (!Array.isArray(profile) || !profile.some(row => row.id === 'agent-loop' && row.disabled === true)) throw new Error('Expected reviewed Multica profile');
let changed = false;
const name = fileURLToPath(new URL('../../packages/ui-runtime-selector/index.mjs', import.meta.url));
const existing = profile.flatMap(row => row.insert ?? []).find(row => row.id === 'mvp-runtime-selector');
if (existing && existing.name !== name) throw new Error('Existing Runtime selector points to a different package');
if (!existing) { profile.push({ insert: [{ id: 'mvp-runtime-selector', name, config: {} }] }); changed = true; }
const settings = profile.find(row => row.id === 'ui-settings-models');
if (!settings) { profile.push({ id: 'ui-settings-models', disabled: true }); changed = true; }
else if (!settings.disabled) { settings.disabled = true; changed = true; }
if (changed) {
  await copyFile(path, `${path}.runtime-ui-${Date.now()}.bak`);
  await writeFile(path, JSON.stringify(profile, null, 2) + '\n', { mode: 0o600 });
}
console.log(changed ? 'Enabled native Runtime UI in reviewed profile' : 'Native Runtime UI already enabled');
