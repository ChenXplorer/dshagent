import { access } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const profile = process.env.DSH_MVP_PROFILE_PATCH;
if (!profile || !isAbsolute(profile)) {
  throw new Error('DSH_MVP_PROFILE_PATCH must name the absolute reviewed Multica profile patch; refusing to start the default model loop');
}
await access(profile);
const parsedProfile = JSON.parse(await (await import('node:fs/promises')).readFile(profile, 'utf8'));
if (!Array.isArray(parsedProfile) || !parsedProfile.some(row => row.id === 'agent-loop' && row.disabled === true)
  || !parsedProfile.some(row => Array.isArray(row.insert) && row.insert.some(entry => entry.id === 'mvp-multica-loop' && typeof entry.name === 'string' && entry.name.endsWith('multica-plugin.ts') && !entry.disabled))) {
  throw new Error('Reviewed profile must disable stock agent-loop and insert the MVP Multica factory');
}
const session = await import('@deepseek-ai/dsh-session');
if (typeof session.Session.prototype.appendInformational !== 'function') {
  throw new Error('Run npm run patch:session before starting the MVP host');
}
const primitives = await import('@deepseek-ai/dsh-agent-loop');
if (typeof primitives.ReactLoopInbox !== 'function') throw new Error('Run npm run patch:loop before starting the MVP host');
const child = spawn(process.execPath, [fileURLToPath(new URL('./bootstrap.mjs', import.meta.url)), 'web', '--patch', profile, '--no-open', ...process.argv.slice(2)], {
  stdio: 'inherit', env: process.env,
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
