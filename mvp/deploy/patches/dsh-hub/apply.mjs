import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8'));
const source = process.argv[2];
if (!source || process.argv.slice(3).some(value => value !== '--check')) {
  throw new Error('Usage: node apply.mjs <pinned-dsh-hub-git-checkout> [--check]');
}
const sourceDirectory = resolve(source);
const patchPath = resolve(directory, manifest.patch);
const digest = createHash('sha256').update(readFileSync(patchPath)).digest('hex');
if (digest !== manifest.sha256) throw new Error('DSH Hub patch checksum does not match manifest');

function git(args, checked = true) {
  const result = spawnSync('git', ['-C', sourceDirectory, ...args], { encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  if (checked && result.status !== 0) throw new Error(result.stderr || `git ${args[0]} failed`);
  return result;
}

if (git(['rev-parse', 'HEAD']).stdout.trim() !== manifest.baseCommit) {
  throw new Error(`Expected DSH Hub commit ${manifest.baseCommit}; refusing another version`);
}
if (git(['apply', '--reverse', '--check', patchPath], false).status === 0) {
  console.log(JSON.stringify({ status: 'already-applied', patch: manifest.id }));
  process.exit(0);
}
if (git(['status', '--porcelain']).stdout.trim()) {
  throw new Error('Expected a clean DSH Hub checkout; refusing to overwrite existing changes');
}
git(['apply', '--check', patchPath]);
if (process.argv.includes('--check')) {
  console.log(JSON.stringify({ status: 'applicable', patch: manifest.id }));
} else {
  git(['apply', patchPath]);
  git(['apply', '--reverse', '--check', patchPath]);
  console.log(JSON.stringify({ status: 'applied', patch: manifest.id }));
}
