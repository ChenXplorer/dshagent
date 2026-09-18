import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { TenantRepository } from '../../packages/tenant-control/index.ts';
import type { CliKind } from '../../packages/multica-client/index.ts';
import { provisionTenantWorkspaces, type TenantWorkspaceProvisioningResult } from '../multica/provision-tenant-workspaces.ts';
import { reconcileNodeAgentFleet, type HubFleetInput, type HubFleetResult } from '../dsh-hub/reconcile-node-agent-fleet.ts';

type JsonObject = Record<string, unknown>;

export interface OnboardTenantOptions {
  /** Owner-only Gateway config. It receives the tenant's private Workspace ID. */
  gatewayConfigPath: string;
  /** Owner-only Node Agent fleet input. It receives the tenant's Hub target. */
  fleetInputPath: string;
  user: { id: string; email: string; defaultRuntime?: CliKind };
  /** Allows an idempotent retry for the same enabled user and email. */
  allowExisting?: boolean;
  fetchImpl?: typeof fetch;
}

export interface OnboardTenantResult {
  userId: string;
  created: boolean;
  workspaceId: string;
  workspaceProvisioning: TenantWorkspaceProvisioningResult;
  fleet: HubFleetResult;
  /** Node Agent reads management.profiles only at process start. */
  nodeAgentRestartRequired: Array<{ nodeId: string; configPath: string }>;
  /** Sandboxes are intentionally created by the existing on-demand Host flow. */
  sandbox: 'created-on-first-host-acquire';
}

function object(value: unknown, field: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as JsonObject;
}

function absolute(value: string, field: string): string {
  if (!isAbsolute(value)) throw new Error(`${field} must be an absolute path`);
  return resolve(value);
}

async function readJson(path: string, field: string): Promise<JsonObject> {
  return object(JSON.parse(await readFile(path, 'utf8')), field);
}

/**
 * Creates one tenant record, then reuses the existing official Multica
 * Workspace provisioner and DSH Hub Node Agent fleet reconciler. It does not
 * create a second control plane or call a private Multica database.
 *
 * A Sandbox is deliberately lazy: HostSupervisor acquires it when the user
 * first opens a DSH Session. This avoids allocating 100 idle Sandboxes during
 * account import while preserving one durable personal Sandbox per active user.
 */
export async function onboardTenant(options: OnboardTenantOptions): Promise<OnboardTenantResult> {
  const gatewayConfigPath = absolute(options.gatewayConfigPath, 'gatewayConfigPath');
  const fleetInputPath = absolute(options.fleetInputPath, 'fleetInputPath');
  const gatewayConfig = await readJson(gatewayConfigPath, 'gateway config');
  const fleet = await readJson(fleetInputPath, 'fleet input') as unknown as HubFleetInput;
  const database = absolute(String(gatewayConfig.database ?? ''), 'gateway config.database');
  if (absolute(String(fleet.database ?? ''), 'fleet input.database') !== database) {
    throw new Error('Gateway config and Hub fleet input must use the same tenant database');
  }

  const repository = new TenantRepository(database);
  let created = false;
  try {
    const existing = repository.getUser(options.user.id);
    if (existing) {
      if (options.allowExisting !== true) throw new Error(`Tenant ${options.user.id} already exists`);
      if (existing.email !== options.user.email || existing.status !== 'active') throw new Error(`Tenant ${options.user.id} cannot be reused with this identity`);
    } else {
      repository.createUser(options.user);
      created = true;
    }
  } finally {
    repository.close();
  }

  // The Workspace helper persists standardRuntime.userOverrides atomically.
  // The fleet helper persists stable node/runtime placement in TenantRepository
  // and renders only the upstream Node Agent configuration shape.
  const workspaceProvisioning = await provisionTenantWorkspaces({ configPath: gatewayConfigPath, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
  const fleetResult = await reconcileNodeAgentFleet(fleet);
  const savedConfig = await readJson(gatewayConfigPath, 'gateway config');
  const standardRuntime = object(savedConfig.standardRuntime, 'gateway config.standardRuntime');
  const overrides = object(standardRuntime.userOverrides, 'gateway config.standardRuntime.userOverrides');
  const override = object(overrides[options.user.id], `userOverrides.${options.user.id}`);
  const multica = object(override.multica, `userOverrides.${options.user.id}.multica`);
  const workspaceId = multica.workspaceId;
  if (typeof workspaceId !== 'string' || !workspaceId) throw new Error(`Workspace provisioning did not persist ${options.user.id}`);

  return {
    userId: options.user.id,
    created,
    workspaceId,
    workspaceProvisioning,
    fleet: fleetResult,
    nodeAgentRestartRequired: fleetResult.nodes.map(node => ({ nodeId: node.nodeId, configPath: node.outputPath })),
    sandbox: 'created-on-first-host-acquire',
  };
}

if (process.argv[1]?.endsWith('onboard-tenant.ts')) {
  const [gatewayConfigPath, fleetInputPath, id, email, runtime] = process.argv.slice(2);
  if (!gatewayConfigPath || !fleetInputPath || !id || !email) {
    throw new Error('Usage: npx tsx deploy/onboarding/onboard-tenant.ts <absolute-gateway-config.json> <absolute-fleet-input.json> <user-id> <email> [codex|claude-code]');
  }
  const result = await onboardTenant({ gatewayConfigPath, fleetInputPath, user: { id, email, ...(runtime ? { defaultRuntime: runtime as CliKind } : {}) } });
  // Deliberately excludes credentials. The caller must review the rendered
  // Node Agent config and restart only the affected Agent(s) under change control.
  console.log(JSON.stringify(result));
}
