import { readFile, writeFile, access } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { resolve } from 'node:path';

// Local Dex OIDC authorization-code flow. Never seeds identities/tokens in SQL.
const directory = resolve(process.argv[2] ?? '.runtime/daytona');
const issuer = 'http://localhost:35556/dex';
const redirectUri = 'http://localhost:33000/dashboard';
const state = randomBytes(24).toString('hex');
const verifier = randomBytes(32).toString('base64url');
const authorization = new URL(`${issuer}/auth`);
for (const [key, value] of Object.entries({ client_id: 'daytona', redirect_uri: redirectUri,
  response_type: 'code', scope: 'openid email profile', state,
  code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' })) {
  authorization.searchParams.set(key, value);
}
const login = await fetch(authorization);
if (!login.ok || !login.url.startsWith(`${issuer}/auth/local/login?`)) throw new Error('Unexpected Dex login page');
const password = (await readFile(resolve(directory, 'login-password'), 'utf8')).trim();
let response = await fetch(login.url, { method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ login: 'dev@daytona.local', password }) });
let location = response.headers.get('location');
for (let count = 0; count < 8 && location; count++) {
  const target = new URL(location, issuer);
  if (target.origin === new URL(redirectUri).origin && target.pathname === '/dashboard') break;
  if (target.origin !== new URL(issuer).origin) throw new Error('Unexpected OIDC redirect origin');
  response = await fetch(target, { redirect: 'manual' });
  if (response.status === 200) {
    const html = await response.text();
    const action = html.match(/<form[^>]*action="([^"]+)"/u)?.[1]?.replaceAll('&amp;', '&') ?? target.href;
    const request = html.match(/name="req" value="([^"]+)"/u)?.[1];
    if (!request || target.pathname !== '/dex/approval') throw new Error('Unexpected Dex authorization page');
    const formUrl = new URL(action, target);
    if (formUrl.origin !== new URL(issuer).origin) throw new Error('Unexpected approval origin');
    response = await fetch(formUrl, { method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ req: request, approval: 'approve' }) });
  }
  location = response.headers.get('location');
}
if (!location) throw new Error('Dex login did not return an authorization code');
const callback = new URL(location, issuer);
if (callback.origin !== new URL(redirectUri).origin || callback.pathname !== '/dashboard' || callback.searchParams.get('state') !== state) {
  throw new Error('OIDC callback mismatch');
}
const code = callback.searchParams.get('code');
if (!code) throw new Error('Missing OIDC code');
const tokens = await fetch(`${issuer}/token`, { method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'authorization_code', client_id: 'daytona', redirect_uri: redirectUri, code, code_verifier: verifier }) });
if (!tokens.ok) throw new Error(`Dex token exchange HTTP ${tokens.status}`);
const payload = await tokens.json();
if (typeof payload.id_token !== 'string') throw new Error('Dex did not return an ID token');
await writeFile(resolve(directory, 'oidc-tokens.json'), JSON.stringify(payload), { mode: 0o600 });
console.log('Daytona local OIDC authentication succeeded; tokens saved privately.');
const api = 'http://localhost:33000/api';
const headers = { Authorization: `Bearer ${payload.id_token}` };
const orgResponse = await fetch(`${api}/organizations`, { headers });
if (!orgResponse.ok) throw new Error(`Daytona organizations HTTP ${orgResponse.status}`);
const organizations = await orgResponse.json();
const personal = organizations.filter(item => item.personal === true);
if (personal.length !== 1) throw new Error('Expected exactly one personal Daytona organization');
const organizationId = personal[0].id;
headers['X-Daytona-Organization-ID'] = organizationId;
const keyFile = resolve(directory, 'api-key.json');
let saved = false;
try { await access(keyFile); saved = true; } catch {}
if (!saved) {
  const existingResponse = await fetch(`${api}/api-keys`, { headers });
  if (!existingResponse.ok) throw new Error(`Daytona API key list HTTP ${existingResponse.status}`);
  const existing = await existingResponse.json();
  if (existing.some(item => item.name === 'dsh-mvp')) throw new Error('MVP API key exists upstream but not locally; reconcile credentials before creating another');
  const created = await fetch(`${api}/api-keys`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'dsh-mvp', permissions: ['write:sandboxes', 'write:snapshots', 'read:runners'] }) });
  if (!created.ok) throw new Error(`Daytona API key create HTTP ${created.status}`);
  const key = await created.json();
  await writeFile(keyFile, JSON.stringify({ organizationId, apiUrl: api, response: key }), { mode: 0o600, flag: 'wx' });
}
console.log('Daytona personal organization and API key prepared; credentials remain in private runtime files.');
