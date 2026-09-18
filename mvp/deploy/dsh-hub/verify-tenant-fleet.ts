import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { DshHubClient } from '../../packages/dsh-hub-control/index.ts';
import { TenantRepository } from '../../packages/tenant-control/index.ts';
import type { HubFleetInput } from './reconcile-node-agent-fleet.ts';

type JsonObject = Record<string, unknown>;

export interface VerifyTenantFleetOptions {
  gatewayConfigPath: string;
  fleetInputPath: string;
  /** Refuse a partial import when fewer active tenants than expected are found. */
  minimumActiveUsers?: number;
  fetchImpl?: typeof fetch;
}

export interface VerifyTenantFleetResult {
  activeUsers: number;
  privateWorkspaceOverrides: number;
  stableHubAssignments: number;
  nodes: Array<{ nodeId: string; configuredProfiles: number; assignedProfiles: number }>;
  hub: { onlineNodes: number; advertisedRuntimes: number; verifiedTargetRuntimes: number };
}

function object(value: unknown, field: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as JsonObject;
}

function absolute(value: unknown, field: string): string {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error(`${field} must be an absolute path`);
  return resolve(value);
}

async function json(path: string, field: string): Promise<JsonObject> {
  return object(JSON.parse(await readFile(path, 'utf8')), field);
}

function profiles(config: JsonObject, nodeId: string): Array<{ runtimeId: string }> {
  const management = object(config.management, `${nodeId}.management`);
  if (!Array.isArray(management.profiles)) throw new Error(`${nodeId}.management.profiles must be an array`);
  const rows = management.profiles.map((item, index) => object(item, `${nodeId}.management.profiles[${String(index)}]`));
  const ids = rows.map(row => row.runtimeId);
  if (ids.some(id => typeof id !== 'string' || !id)) throw new Error(`${nodeId} has an invalid Profile Runtime ID`);
  if (new Set(ids).size !== ids.length) throw new Error(`${nodeId} has duplicate Profile Runtime IDs`);
  if (rows.length > 64) throw new Error(`${nodeId} exceeds the upstream 64 Profile limit`);
  return rows as Array<{ runtimeId: string }>;
}

/**
 * Read-only proof that the three tenant control-plane stores agree:
 * TenantRepository, rendered upstream Node Agent configs, and the live Hub
 * node/runtime inventory. It intentionally does not create Workspaces,
 * restart Node Agents, or submit a Hub command.
 */
export async function verifyTenantFleet(options: VerifyTenantFleetOptions): Promise<VerifyTenantFleetResult> {
  const gatewayConfigPath = absolute(options.gatewayConfigPath, 'gatewayConfigPath');
  const fleetInputPath = absolute(options.fleetInputPath, 'fleetInputPath');
  const gateway = await json(gatewayConfigPath, 'gateway config');
  const fleet = await json(fleetInputPath, 'fleet input') as unknown as HubFleetInput;
  const database = absolute(gateway.database, 'gateway config.database');
  if (absolute(fleet.database, 'fleet input.database') !== database) throw new Error('Gateway config and fleet input use different tenant databases');
  if (!Array.isArray(fleet.nodes) || !fleet.nodes.length) throw new Error('fleet input.nodes is empty');
  const runtime = object(gateway.standardRuntime, 'gateway config.standardRuntime');
  const overrides = object(runtime.userOverrides, 'gateway config.standardRuntime.userOverrides');
  const hubConfig = object(gateway.hub, 'gateway config.hub');
  if (typeof hubConfig.baseUrl !== 'string' || typeof hubConfig.internalOperatorToken !== 'string' || typeof hubConfig.originSecret !== 'string') {
    throw new Error('gateway config.hub must contain the private Hub client configuration');
  }

  const repository = new TenantRepository(database);
  const users = repository.listUsers().filter(user => user.status === 'active');
  try {
    if (options.minimumActiveUsers !== undefined && (!Number.isSafeInteger(options.minimumActiveUsers) || options.minimumActiveUsers < 1 || users.length < options.minimumActiveUsers)) {
      throw new Error(`Expected at least ${String(options.minimumActiveUsers)} active tenants; found ${String(users.length)}`);
    }
    const assignments = users.map(user => {
      const target = repository.getHubProfileTarget(user.id);
      if (!target) throw new Error(`Tenant ${user.id} has no stable Hub Profile target`);
      const override = object(overrides[user.id], `userOverrides.${user.id}`);
      const multica = object(override.multica, `userOverrides.${user.id}.multica`);
      if (typeof multica.workspaceId !== 'string' || !multica.workspaceId) throw new Error(`Tenant ${user.id} has no private Multica Workspace override`);
      return { userId: user.id, nodeId: target.nodeId, runtimeId: target.runtimeId };
    });
    const nodeConfigs = await Promise.all(fleet.nodes.map(async node => ({ node, profiles: profiles(await json(absolute(node.outputPath, `fleet node ${node.nodeId}.outputPath`), `Node Agent ${node.nodeId} config`), node.nodeId) })));
    const nodeById = new Map(nodeConfigs.map(item => [item.node.nodeId, item]));
    for (const assignment of assignments) {
      const node = nodeById.get(assignment.nodeId);
      if (!node) throw new Error(`Tenant ${assignment.userId} points to unknown Hub Node ${assignment.nodeId}`);
      if (!node.profiles.some(profile => profile.runtimeId === assignment.runtimeId)) throw new Error(`Tenant ${assignment.userId} Runtime ${assignment.runtimeId} is absent from Node ${assignment.nodeId}`);
    }

    const hub = new DshHubClient({ baseUrl: hubConfig.baseUrl, internalOperatorToken: hubConfig.internalOperatorToken, originSecret: hubConfig.originSecret, ...(typeof hubConfig.origin === 'string' ? { origin: hubConfig.origin } : {}), ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
    const live = await hub.listNodes();
    const onlineNodes = new Set(live.nodes.filter(node => node.online !== false && node.status !== 'offline').map(node => node.nodeId));
    const advertised = new Map(live.runtimes.map(item => [item.runtimeId, item]));
    for (const assignment of assignments) {
      if (!onlineNodes.has(assignment.nodeId)) throw new Error(`Hub Node ${assignment.nodeId} is not online`);
      const target = advertised.get(assignment.runtimeId);
      if (!target || target.nodeId !== assignment.nodeId) throw new Error(`Hub does not advertise ${assignment.runtimeId} on ${assignment.nodeId}`);
    }
    return {
      activeUsers: users.length,
      privateWorkspaceOverrides: assignments.length,
      stableHubAssignments: assignments.length,
      nodes: nodeConfigs.map(({ node, profiles: configured }) => ({ nodeId: node.nodeId, configuredProfiles: configured.length, assignedProfiles: assignments.filter(item => item.nodeId === node.nodeId).length })),
      hub: { onlineNodes: onlineNodes.size, advertisedRuntimes: live.runtimes.length, verifiedTargetRuntimes: assignments.length },
    };
  } finally {
    repository.close();
  }
}

if (process.argv[1]?.endsWith('verify-tenant-fleet.ts')) {
  const [gatewayConfigPath, fleetInputPath, expected] = process.argv.slice(2);
  if (!gatewayConfigPath || !fleetInputPath) throw new Error('Usage: npx tsx deploy/dsh-hub/verify-tenant-fleet.ts <absolute-gateway-config.json> <absolute-fleet-input.json> [minimum-active-users]');
  const minimumActiveUsers = expected === undefined ? undefined : Number(expected);
  const result = await verifyTenantFleet({ gatewayConfigPath, fleetInputPath, ...(minimumActiveUsers === undefined ? {} : { minimumActiveUsers }) });
  console.log(JSON.stringify(result));
}
