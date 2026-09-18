import { writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
export function buildProfile(sessionsRoot, customPlugins = []) {
  if (!sessionsRoot || !isAbsolute(sessionsRoot)) throw new Error('Pass an absolute DSH session persistence directory');
  if (!Array.isArray(customPlugins)) throw new Error('customPlugins must be an array');
  return [
  // Cordis treats `name` on an update as an identity assertion, not a rename.
  // Disable the official driver and insert a separately identified real factory.
  { id: 'agent-loop', disabled: true },
  { insert: [{ id: 'mvp-multica-loop', name: fileURLToPath(new URL('./multica-plugin.ts', import.meta.url)), config: {} }, ...customPlugins] },
  { id: 'session-persistence-jsonl', config: { root: sessionsRoot, compression: 'none' } },
  // Native deterministic titles remain; inference belongs to the chosen CLI.
  { id: 'session-title-llm', disabled: true },
  // DSH's provider dropdown cannot configure a separate CLI process.
  { id: 'ui-model-selection', disabled: true },
  // Model credentials belong to the native CLIs, not the disabled stock loop.
  { id: 'ui-settings-models', disabled: true },
  { insert: [{ id: 'mvp-runtime-selector', name: fileURLToPath(new URL('../../packages/ui-runtime-selector/index.mjs', import.meta.url)), config: {} }] },
  ];
}
const [output, sessionsRoot, customPluginsJson] = process.argv.slice(2);
if (!output || !sessionsRoot || !isAbsolute(output) || !isAbsolute(sessionsRoot)) throw new Error('Pass absolute profile output path and DSH session persistence directory');
const customPlugins = customPluginsJson ? JSON.parse(customPluginsJson) : [];
const profile = buildProfile(sessionsRoot, customPlugins);
// JSON is YAML; generated paths remain valid on both Windows and Ubuntu.
await writeFile(output, JSON.stringify(profile, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(`Created reviewed Multica profile: ${output}`);
