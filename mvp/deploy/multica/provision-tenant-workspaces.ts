import { createHash } from 'node:crypto';
import { chmod, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { TenantRepository } from '../../packages/tenant-control/index.ts';

type JsonObject = Record<string, unknown>;
type Workspace = { id: string; slug: string };

export interface TenantWorkspaceProvisioningResult {
  users: number;
  created: number;
  reused: number;
  configPath: string;
}

export interface TenantWorkspaceProvisioningOptions {
  configPath: string;
  fetchImpl?: typeof fetch;
}

function object(value: unknown, field: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as JsonObject;
}

function text(value: unknown, field: string, max = 4096): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/u.test(value)) throw new Error(`${field} is invalid`);
  return value;
}

function workspace(value: unknown): Workspace {
  const row = object(value, 'workspace');
  return { id: text(row.id, 'workspace.id', 256), slug: text(row.slug, 'workspace.slug', 128) };
}

function slugFor(userId: string): string {
  return `dsh-tenant-${createHash('sha256').update(userId).digest('hex').slice(0, 24)}`;
}

async function privateReplace(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.next`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
}

/**
 * Reconciles one official Multica Workspace per active tenant, then writes the
 * existing StandardRuntime userOverrides shape. It uses only Multica's public
 * Workspace API; it never writes Multica's database or modifies Multica.
 */
export async function provisionTenantWorkspaces(options: TenantWorkspaceProvisioningOptions): Promise<TenantWorkspaceProvisioningResult> {
  if (!isAbsolute(options.configPath)) throw new Error('configPath must be absolute');
  const configPath = resolve(options.configPath);
  const mode = (await stat(configPath)).mode & 0o777;
  if (process.platform !== 'win32' && (mode & 0o077) !== 0) throw new Error('Gateway config must be owner-only before provisioning tenant credentials');
  const config = object(JSON.parse(await readFile(configPath, 'utf8')), 'config');
  const database = resolve(text(config.database, 'database'));
  if (!isAbsolute(text(config.database, 'database'))) throw new Error('database must be absolute');
  const standardRuntime = object(config.standardRuntime, 'standardRuntime');
  const baseMultica = object(standardRuntime.multica, 'standardRuntime.multica');
  const daemonTemplate = object(standardRuntime.daemonTemplate, 'standardRuntime.daemonTemplate');
  const baseUrl = new URL(text(baseMultica.localApiUrl, 'standardRuntime.multica.localApiUrl'));
  if (baseUrl.username || baseUrl.password || baseUrl.pathname !== '/' || !['http:', 'https:'].includes(baseUrl.protocol)) throw new Error('Multica URL must be an HTTP(S) origin');
  const token = text(baseMultica.token, 'standardRuntime.multica.token');
  const overrides = standardRuntime.userOverrides === undefined ? {} : object(standardRuntime.userOverrides, 'standardRuntime.userOverrides');
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const list = async (): Promise<Workspace[]> => {
    const response = await fetchImpl(new URL('/api/workspaces/', baseUrl), { headers, redirect: 'error', signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Official Multica workspace listing failed with HTTP ${response.status}`);
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error('Official Multica workspace listing returned invalid JSON');
    return rows.map(workspace);
  };
  const create = async (userId: string, slug: string): Promise<Workspace> => {
    const response = await fetchImpl(new URL('/api/workspaces/', baseUrl), {
      method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ name: `DSH ${userId}`, slug }),
    });
    if (response.status === 409) {
      const found = (await list()).find(item => item.slug === slug);
      if (found) return found;
    }
    if (!response.ok) throw new Error(`Official Multica workspace creation failed with HTTP ${response.status}`);
    return workspace(await response.json());
  };

  const repository = new TenantRepository(database);
  const users = repository.listUsers().filter(user => user.status === 'active');
  repository.close();
  let catalog = await list();
  let created = 0; let reused = 0;
  const intentPath = `${configPath}.workspace-intent.json`;
  await privateReplace(intentPath, { configPath, users: users.map(user => ({ userId: user.id, slug: slugFor(user.id) })), startedAt: new Date().toISOString() });
  try {
    for (const user of users) {
      const existingOverride = overrides[user.id] === undefined ? undefined : object(overrides[user.id], `userOverrides.${user.id}`);
      if (existingOverride) {
        const configured = object(existingOverride.multica, `userOverrides.${user.id}.multica`);
        const workspaceId = text(configured.workspaceId, `userOverrides.${user.id}.multica.workspaceId`, 256);
        if (!catalog.some(item => item.id === workspaceId)) throw new Error(`Configured Multica workspace for ${user.id} is not visible to the official token`);
        reused++;
        continue;
      }
      const slug = slugFor(user.id);
      let target = catalog.find(item => item.slug === slug);
      if (!target) {
        target = await create(user.id, slug);
        if (target.slug !== slug) throw new Error('Official Multica workspace response changed the requested slug');
        catalog = [...catalog, target]; created++;
      } else reused++;
      overrides[user.id] = {
        multica: { localApiUrl: baseUrl.origin, token, workspaceId: target.id },
        daemonTemplate: { ...daemonTemplate, token, workspaceId: target.id },
      };
    }
    standardRuntime.userOverrides = overrides;
    await privateReplace(configPath, config);
    await unlink(intentPath).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    return { users: users.length, created, reused, configPath };
  } catch (error) {
    // Keep the credential-free intent. A retry reconciles deterministic slugs
    // through GET before issuing another POST; Multica enforces slug uniqueness.
    throw error;
  }
}

if (process.argv[1]?.endsWith('provision-tenant-workspaces.ts')) {
  const configPath = process.argv[2];
  if (!configPath) throw new Error('Usage: npx tsx provision-tenant-workspaces.ts <absolute-private-gateway-config.json>');
  const result = await provisionTenantWorkspaces({ configPath });
  console.log(JSON.stringify({ users: result.users, created: result.created, reused: result.reused }));
}
