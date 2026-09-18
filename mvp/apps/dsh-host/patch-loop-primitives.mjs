import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function patchLoopPrimitives(baseDirectory = process.cwd()) {
  const require = createRequire(resolve(baseDirectory, 'package.json'));
  const pkg = JSON.parse(await readFile(require.resolve('@deepseek-ai/dsh-agent-loop/package.json'), 'utf8'));
  if (pkg.version !== '0.1.5-rc.2') throw new Error(`Unreviewed DSH loop version: ${pkg.version}`);
  const file = require.resolve('@deepseek-ai/dsh-agent-loop');
  const original = await readFile(file, 'utf8');
  const marker = 'export { ReactLoopInbox, inboxProjectionDefinition };';
  if (original.includes(marker)) return { changed: false, file };
  if (!original.includes('var ReactLoopInbox = class') || !original.includes('const inboxProjectionDefinition =')) {
    throw new Error('Pinned native inbox definitions not found; refusing speculative patch');
  }
  // Expose the existing official class/definition, without modifying their code
  // and without installing the official model-driving AgentLoop service.
  await writeFile(file, original + '\n' + marker + '\n');
  return { changed: true, file };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await patchLoopPrimitives(process.argv[2] ?? process.cwd())));
}
