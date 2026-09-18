import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// This bootstrap uses only the pinned official public auth/workspace/PAT APIs.
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  if (!process.argv[i]?.startsWith('--') || !process.argv[i + 1]) throw new Error('Expected --name value arguments');
  args.set(process.argv[i], process.argv[i + 1]);
}
const baseUrl = new URL(args.get('--base-url') ?? 'http://127.0.0.1:18381');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(baseUrl.hostname) || baseUrl.username || baseUrl.password || baseUrl.pathname !== '/') {
  throw new Error('Local bootstrap requires a loopback server origin');
}
const logPath = resolve(args.get('--log') ?? '.runtime/multica/server.stdout.log');
const outputPath = resolve(args.get('--output') ?? '.runtime/multica/auth.json');
const intentPath = `${outputPath}.intent.json`;
const email = 'dsh-mvp@example.invalid';
const slug = 'dsh-mvp';
async function readOptional(path) {
  try { return await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function api(path, { method = 'GET', body, token } = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    method, redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`Official ${method} ${path} failed: HTTP ${response.status}`);
  return await response.json();
}
async function privateWrite(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
}
async function main() {
  const readiness = await api('/readyz');
  if (readiness.status !== 'ok') throw new Error('Official Server is not ready');
  const existing = await readOptional(outputPath);
  if (existing) {
    const auth = JSON.parse(existing);
    if (auth.baseUrl !== baseUrl.origin || auth.email !== email) throw new Error('Existing identity belongs to a different bootstrap');
    const user = await api('/api/me', { token: auth.token });
    const workspaces = await api('/api/workspaces/', { token: auth.token });
    if (user.id !== auth.userId || !workspaces.some(item => item.id === auth.workspaceId && item.slug === slug)) throw new Error('Saved identity does not match official resources');
    console.log(JSON.stringify({ status: 'reused', ready: true, output: outputPath }));
    return;
  }
  if (await readOptional(intentPath)) throw new Error('Prior bootstrap intent exists; reconcile official resources and private credentials before retrying');
  const before = await readFile(logPath, 'utf8');
  const modeLines = before.split(/\r?\n/).filter(line => line.includes('EmailService:'));
  if (!modeLines.at(-1)?.includes('DEV mode')) throw new Error('Server log does not confirm official non-delivering DEV email mode');
  await privateWrite(intentPath, { baseUrl: baseUrl.origin, email, slug, startedAt: new Date().toISOString() });
  const offset = (await stat(logPath)).size;
  await api('/auth/send-code', { method: 'POST', body: { email } });
  let code;
  for (let i = 0; i < 30; i++) {
    const bytes = await readFile(logPath);
    if (bytes.length < offset) throw new Error('Server log rotated during bootstrap');
    const tail = bytes.subarray(offset).toString('utf8');
    code = /\[DEV\] Verification code for dsh-mvp@example\.invalid: (\d{6})/.exec(tail)?.[1];
    if (code) break;
    await delay(200);
  }
  if (!code) throw new Error('Official verification code was not observed in private log');
  const login = await api('/auth/verify-code', { method: 'POST', body: { email, code } });
  if (typeof login.token !== 'string' || !login.user?.id) throw new Error('Invalid official login response');
  // Retain the received JWT before subsequent mutations, so partial bootstrap can be reconciled.
  await privateWrite(`${outputPath}.login.json`, { baseUrl: baseUrl.origin, email, token: login.token, userId: login.user.id });
  const workspaces = await api('/api/workspaces/', { token: login.token });
  if (!Array.isArray(workspaces)) throw new Error('Invalid workspace listing');
  let workspace = workspaces.find(item => item.slug === slug);
  if (!workspace) workspace = await api('/api/workspaces/', { method: 'POST', token: login.token, body: { name: 'DSH MVP', slug } });
  if (!workspace.id) throw new Error('Invalid official workspace response');
  const pat = await api('/api/tokens/', { method: 'POST', token: login.token, body: { name: 'dsh-mvp-daemon', expires_in_days: 90 } });
  if (typeof pat.token !== 'string' || !pat.id) throw new Error('Invalid official token response');
  await privateWrite(outputPath, { baseUrl: baseUrl.origin, email, userId: login.user.id, workspaceId: workspace.id, tokenId: pat.id, token: pat.token, expiresAt: pat.expires_at, createdAt: new Date().toISOString() });
  console.log(JSON.stringify({ status: 'created', ready: true, output: outputPath }));
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Local bootstrap failed'); process.exitCode = 1; });
