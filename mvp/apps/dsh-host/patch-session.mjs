import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Narrow patch for the verified official 0.1.5-rc.2 npm artifact. Preserves the
 * official Session and adds the missing informational envelope append API.
 * An explicit base directory allows patching an isolated deployment install.
 */
export async function patchSession(baseDirectory = process.cwd()) {
  const require = createRequire(resolve(baseDirectory, 'package.json'));
  const manifest = require.resolve('@deepseek-ai/dsh-session/package.json');
  const pkg = JSON.parse(await readFile(manifest, 'utf8'));
  if (pkg.version !== '0.1.5-rc.2') throw new Error(`Unreviewed DSH Session version: ${pkg.version}`);
  const file = require.resolve('@deepseek-ai/dsh-session');
  const original = await readFile(file, 'utf8');
  const marker = '\tappendInformational(type, data) {';
  if (original.includes(marker)) return { file, version: pkg.version, changed: false };
  const anchor = '\tappend(type, data, ...opts) {';
  const envelope = '\t\t\tdata: dataSnapshot,\n\t\t\t...surfaceMetadataSnapshot';
  if (original.split(anchor).length !== 2 || original.split(envelope).length !== 2) {
    throw new Error('Pinned DSH Session patch anchors changed; refusing a speculative patch');
  }
  const method = `${marker}\n\t\tif (!type.startsWith("multica/")) throw new Error("informational append is reserved for Multica metadata");\n\t\treturn this.append(type, data, { ignorable: true });\n\t}\n`;
  const patched = original.replace(anchor, method + anchor).replace(envelope,
    '\t\t\tdata: dataSnapshot,\n\t\t\t...(surfaceOpts?.ignorable === true ? { ignorable: true } : {}),\n\t\t\t...surfaceMetadataSnapshot');
  await writeFile(file, patched, 'utf8');
  return { file, version: pkg.version, changed: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await patchSession(process.argv[2] ?? process.cwd())));
}
