import { isAbsolute } from 'node:path';
import { TenantRepository } from '../../packages/tenant-control/index.ts';

/** Small operator-side helper; it never accepts a user token from the Web API. */
export function provisionUser(database: string, input: { id: string; email: string; defaultRuntime?: 'codex' | 'claude-code' }): { userId: string; token: string } {
  if (!isAbsolute(database)) throw new Error('database must be absolute');
  const repository = new TenantRepository(database);
  try { const created = repository.createUser(input); return { userId: created.user.id, token: created.token }; }
  finally { repository.close(); }
}

if (process.argv[1]?.endsWith('provision-user.ts')) {
  const [database, id, email, runtime] = process.argv.slice(2);
  if (!database || !id || !email) throw new Error('Usage: npx tsx provision-user.ts <absolute-db> <user-id> <email> [codex|claude-code]');
  console.log(JSON.stringify(provisionUser(database, { id, email, ...(runtime ? { defaultRuntime: runtime as 'codex' | 'claude-code' } : {}) })));
}
