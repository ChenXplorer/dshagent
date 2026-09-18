import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const directory = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(resolve(directory, 'dshtrace2.manifest.json'), 'utf8'));
const source = process.argv[2];
if (!source || process.argv.slice(3).some(value => value !== '--check')) throw new Error('Usage: node apply-process-cleanup.mjs <dshtrace1-checkout> [--check]');
const root = resolve(source);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const patch = resolve(directory, manifest.patch);
if (digest(readFileSync(patch)) !== manifest.sha256 || digest(readFileSync(resolve(directory, 'dshtrace1.patch'))) !== manifest.requiresSha256) throw new Error('Patch checksum mismatch');
function git(args, checked = true) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  if (checked && result.status !== 0) throw new Error(result.stderr || 'Git patch verification failed');
  return result;
}
if (git(['rev-parse', 'HEAD']).stdout.trim() !== manifest.baseCommit) throw new Error('Wrong upstream commit');
git(['apply', '--reverse', '--check', resolve(directory, 'dshtrace1.patch')]);
if (git(['apply', '--reverse', '--check', patch], false).status === 0) {
  console.log(JSON.stringify({ status: 'already-applied', patch: manifest.id }));
} else {
  const codex = readFileSync(resolve(root, 'server/pkg/agent/codex.go'), 'utf8').replaceAll('\r\n', '\n');
  if (digest(codex) !== manifest.codexBaseSha256 || existsSync(resolve(root, 'server/pkg/agent/codex_orphan_cleanup_unix_test.go'))) throw new Error('Codex source differs from the expected baseline; refusing overwrite');
  git(['apply', '--check', patch]);
  if (process.argv.includes('--check')) console.log(JSON.stringify({ status: 'applicable', patch: manifest.id }));
  else {
    git(['apply', patch]);
    git(['apply', '--reverse', '--check', patch]);
    console.log(JSON.stringify({ status: 'applied', patch: manifest.id }));
  }
}
