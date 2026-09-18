import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';
register();

// Official rc.2 gates its bin on import.meta.main, absent in Node 24.1 even
// though that version satisfies its engine range. Invoke the official export
// explicitly; keep process.argv intact for the real DSH argument parser.
const require = createRequire(import.meta.url);
const manifest = require.resolve('@deepseek-ai/dsh/package.json');
const cli = await import(pathToFileURL(resolve(dirname(manifest), 'lib/bin.js')).href);
if (typeof cli.runCli !== 'function') throw new Error('Pinned official DSH runCli export is unavailable');
await cli.runCli();
