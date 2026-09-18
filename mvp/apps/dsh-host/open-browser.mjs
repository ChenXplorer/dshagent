import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

// Read shared live logs through Node; never print the private launch token.
const log = fileURLToPath(new URL('../../../.runtime/dsh/host.stdout.log', import.meta.url));
const text = await readFile(log, 'utf8');
let launch;
for (const match of text.matchAll(/https?:\/\/[^\s\x1b<>"']+/g)) {
  try {
    const url = new URL(match[0]);
    if (['localhost', '127.0.0.1'].includes(url.hostname) && url.port === '3080' && url.search) launch = url;
  } catch {}
}
if (!launch) throw new Error('DSH launch URL unavailable; start the DSH host first');
launch.hostname = '127.0.0.1';
const response = await fetch(launch, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
if (response.status !== 303 || !response.headers.has('set-cookie')) throw new Error('DSH launch credential is stale; inspect current host startup');
// Pass the URL in an environment value, not interpolated shell source.
const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -FilePath $env:DSH_BROWSER_LAUNCH_URL'], {
  env: { ...process.env, DSH_BROWSER_LAUNCH_URL: launch.href }, windowsHide: true, stdio: 'ignore',
});
await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('Browser launch failed'))); });
console.log('Opened authenticated DSH at 127.0.0.1:3080 in the default browser.');
