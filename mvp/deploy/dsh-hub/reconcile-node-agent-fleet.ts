import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { TenantRepository } from '../../packages/tenant-control/index.ts';
import { renderNodeAgentConfig, type NodeAgentConfigInput } from './render-node-agent-config.ts';

export interface HubFleetNodeInput extends Omit<NodeAgentConfigInput, 'profiles'> {
  runtimeIdTemplate: string;
  outputPath: string;
  dshExecutable: string;
}

export interface HubFleetInput {
  database: string;
  hostStateDirectory: string;
  nodes: HubFleetNodeInput[];
  maxProfilesPerNode?: number;
}

export interface HubFleetResult {
  users: number;
  nodes: Array<{ nodeId: string; profiles: number; outputPath: string }>;
}

const IDENTIFIER = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u;

function absolute(value: unknown, field: string): string {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error(`${field} must be an absolute path`);
  return resolve(value);
}

function runtimeId(template: unknown, userId: string, field: string): string {
  if (typeof template !== 'string' || !template.includes('{userId}')) throw new Error(`${field} must include {userId}`);
  const value = template.replaceAll('{userId}', userId);
  if (!IDENTIFIER.test(value)) throw new Error(`${field} renders an invalid Hub Runtime ID for ${userId}`);
  return value;
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(path, 0o600);
}

/**
 * Reconcile active tenants into the pinned upstream Node Agent configuration
 * shape. The tool allocates stable node/runtime ownership in TenantRepository;
 * it does not restart a Node Agent or implement any Hub transport itself.
 */
export async function reconcileNodeAgentFleet(input: HubFleetInput): Promise<HubFleetResult> {
  const database = absolute(input.database, 'database');
  const hostRoot = absolute(input.hostStateDirectory, 'hostStateDirectory');
  if (!Array.isArray(input.nodes) || input.nodes.length < 2 || input.nodes.length > 64) {
    throw new Error('nodes must contain between 2 and 64 entries for a 100-user fleet');
  }
  const capacity = input.maxProfilesPerNode ?? 64;
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 64) throw new Error('maxProfilesPerNode must be between 1 and 64');
  const nodeIds = new Set<string>(); const outputs = new Set<string>();
  const nodes = input.nodes.map((node, index) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) throw new Error(`nodes[${String(index)}] is invalid`);
    if (!IDENTIFIER.test(node.nodeId)) throw new Error(`nodes[${String(index)}].nodeId is invalid`);
    if (nodeIds.has(node.nodeId)) throw new Error('node IDs must be unique');
    nodeIds.add(node.nodeId);
    const outputPath = absolute(node.outputPath, `nodes[${String(index)}].outputPath`);
    if (outputs.has(outputPath)) throw new Error('Node Agent output paths must be unique');
    outputs.add(outputPath);
    absolute(node.dshExecutable, `nodes[${String(index)}].dshExecutable`);
    runtimeId(node.runtimeIdTemplate, 'validation-user', `nodes[${String(index)}].runtimeIdTemplate`);
    return { ...node, outputPath };
  });

  const repository = new TenantRepository(database);
  try {
    const users = repository.listUsers().filter(user => user.status === 'active');
    for (const user of users) {
      repository.assignHubProfileTarget(user.id, nodes.map((node, index) => ({
        nodeId: node.nodeId,
        runtimeId: runtimeId(node.runtimeIdTemplate, user.id, `nodes[${String(index)}].runtimeIdTemplate`),
      })), capacity);
    }

    const summaries: HubFleetResult['nodes'] = [];
    for (const node of nodes) {
      const assigned = users.map(user => ({ user, target: repository.getHubProfileTarget(user.id) }))
        .filter(row => row.target?.nodeId === node.nodeId);
      if (!assigned.length) continue; // never replace a live config with an empty management set
      const profiles = assigned.map(({ user, target }) => {
        const profileDirectory = join(hostRoot, user.id, 'home', 'profiles', 'web');
        return {
          runtimeId: target!.runtimeId,
          profileDirectory,
          profileName: 'web',
          dshExecutable: resolve(node.dshExecutable),
          snapshotPaths: [join(hostRoot, user.id, 'sessions')],
        };
      });
      // The upstream management supervisor may receive a dsh.plugins command
      // before the on-demand Host has ever started. Prepare only the owned
      // directories; the official DSH CLI/Hub installer remains responsible
      // for package.json, the Connector bundle and Cordis patch contents.
      for (const profile of profiles) {
        await mkdir(profile.profileDirectory, { recursive: true, mode: 0o700 });
        for (const path of profile.snapshotPaths) await mkdir(path, { recursive: true, mode: 0o700 });
      }
      const config = renderNodeAgentConfig({
        hubUrl: node.hubUrl, nodeId: node.nodeId, accessClientId: node.accessClientId,
        accessClientSecret: node.accessClientSecret, ...(node.enrollmentCode ? { enrollmentCode: node.enrollmentCode } : {}),
        ...(node.originSecret ? { originSecret: node.originSecret } : {}),
        hubPublicKey: node.hubPublicKey, stateDirectory: node.stateDirectory, ipcEndpoint: node.ipcEndpoint,
        profiles,
      });
      await writePrivateJson(node.outputPath, config);
      summaries.push({ nodeId: node.nodeId, profiles: profiles.length, outputPath: node.outputPath });
    }
    return { users: users.length, nodes: summaries };
  } finally { repository.close(); }
}

if (process.argv[1]?.endsWith('reconcile-node-agent-fleet.ts')) {
  const [inputPath] = process.argv.slice(2);
  if (!inputPath) throw new Error('Usage: npx tsx reconcile-node-agent-fleet.ts <absolute-private-input.json>');
  const source = absolute(inputPath, 'inputPath');
  const input = JSON.parse(await readFile(source, 'utf8')) as HubFleetInput;
  const result = await reconcileNodeAgentFleet(input);
  console.log(JSON.stringify(result));
}
