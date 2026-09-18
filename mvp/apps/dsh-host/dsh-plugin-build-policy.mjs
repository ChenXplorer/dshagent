import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;

function approvedNames(value) {
  const names = (value || 'koffi').split(',').map(item => item.trim()).filter(Boolean);
  if (!names.every(item => PACKAGE_NAME.test(item))) throw new Error('DSH_PLUGIN_APPROVED_BUILD_PACKAGES contains an invalid package name');
  return [...new Set(names)];
}

/**
 * pnpm 10+ records unreviewed dependency build scripts as a placeholder in the
 * Profile workspace. Only names explicitly supplied by platform deployment are
 * made runnable; a tenant Plugin cannot silently approve its own build script.
 */
export async function preparePnpmBuildPolicy(profileDirectory, configuredPackages) {
  const approved = approvedNames(configuredPackages);
  await mkdir(profileDirectory, { recursive: true });
  const path = join(profileDirectory, 'pnpm-workspace.yaml');
  let source = '';
  try { source = await readFile(path, 'utf8'); } catch { /* created below */ }

  const lines = source ? source.split(/\r?\n/u) : [];
  let start = lines.findIndex(line => line === 'allowBuilds:');
  if (start < 0) {
    if (lines.length && lines.at(-1) !== '') lines.push('');
    lines.push('allowBuilds:');
    start = lines.length - 1;
  }
  let end = start + 1;
  while (end < lines.length && (lines[end].startsWith(' ') || lines[end].startsWith('\t') || lines[end] === '')) end++;

  for (const name of approved) {
    const matcher = new RegExp(`^(\\s{2}${name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}:)(.*)$`, 'u');
    const index = lines.findIndex((line, offset) => offset > start && offset < end && matcher.test(line));
    if (index < 0) {
      lines.splice(end, 0, `  ${name}: true`);
      end++;
      continue;
    }
    // Keep an explicit false as an operator decision. Replace only pnpm's
    // generated prompt, which is not an approved policy yet.
    if (/set this to true or false/u.test(lines[index])) lines[index] = `  ${name}: true`;
  }
  await writeFile(path, `${lines.join('\n').replace(/\n*$/u, '')}\n`, { mode: 0o600 });
}
