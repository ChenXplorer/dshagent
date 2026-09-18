import { isAbsolute } from 'node:path';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { TenantRepository, ProfileComposer, PersistentTenantSandboxManager, HostSupervisor, type SandboxProvider, type UserPluginManifest, type UserSkillManifest, type EffectiveProfile } from '../../packages/tenant-control/index.ts';
import { DshHubClient, assertHubProfileTargetAvailable, requestProfileTransaction } from '../../packages/dsh-hub-control/index.ts';
import { ProcessHostLauncher } from './process-host-launcher.ts';
import { startMultiTenantGateway } from './server.ts';
import { createStandardDriverConfiguration, createStandardSandboxProvider, standardUserWorkspaceId, type StandardRuntimeConfig } from './standard-runtime.ts';

export interface MultiTenantDeploymentConfig {
  database: string;
  stateDirectory: string;
  listenHost?: string;
  port?: number;
  idleHostMs?: number;
  systemPlugins?: UserPluginManifest[];
  systemSkills?: UserSkillManifest[];
  /** Private, server-to-server Hub control credential; never exposed to users. */
  hub?: { baseUrl: string; internalOperatorToken: string; originSecret: string; origin?: string };
  /**
   * Require the external DSH Hub in a production deployment.  Tests and the
   * single-user local flow may leave this false, but a public multi-tenant
   * Gateway should fail closed when the control plane is missing.
   */
  requireHub?: boolean;
  /** Optional operator identities for Hub-wide node/session/audit views. */
  operatorUserIds?: string[];
  /** Deployment-staged roots allowed for tenant modulePath Plugins. */
  pluginPathRoots?: string[];
  /** Local/test escape hatch; rejected with requireHub in a public deployment. */
  allowUnmanagedPluginPaths?: boolean;
  /** Explicit mapping from a tenant to the Hub Node Agent Runtime that owns
   * its DSH Host/Profile.  A map avoids guessing from a global node catalog. */
  hubProfileTargets?: Record<string, { nodeId: string; runtimeId: string }>;
  /** Deterministic mapping for fleets whose Hub IDs are provisioned as
   * `tenant-{userId}` (the referenced Node/Runtime must already exist). */
  hubProfileTargetTemplate?: { nodeId: string; runtimeId: string };
  /** Deterministic shard mapping. Each upstream Node Agent supports at most
   * 64 management profiles, so a 100-user deployment should provision at
   * least two entries (and keep each node at or below that limit). */
  /** Stable node shards. runtimeIdTemplate must render a unique Profile
   * Runtime per tenant, for example `tenant-{userId}`. */
  hubProfileTargetShards?: Array<{ nodeId: string; runtimeIdTemplate: string }>;
  /** Optional module resolving a user's Hub Node/Runtime target for Profile transactions. */
  hubProfileTargetModule?: string;
  /** Optional module exporting authenticate(req) for DSH Hub/SSO user identity. */
  identityProviderModule?: string;
  /** Current MVP only: bypass end-user login and bind all Web traffic to one user. */
  mockUserId?: string;
  /** If true, the trusted identity provider may create a default user Profile
   * on first login. Keep false when accounts must be pre-provisioned. */
  autoProvisionIdentity?: boolean;
  /** Optional adapters for non-Daytona providers. */
  sandboxProviderModule?: string;
  driverConfigurationModule?: string;
  /** Standard real Daytona/Multica composition; modules are for extensions. */
  standardRuntime?: StandardRuntimeConfig;
}

function requiredPath(value: unknown, field: string): string { if (typeof value !== 'string' || !isAbsolute(value)) throw new Error(`${field} must be an absolute path`); return value; }

/** Validate the deployment's Hub boundary before any listener or provider is opened. */
export function validateHubConfiguration(config: Pick<MultiTenantDeploymentConfig, 'requireHub' | 'hub' | 'hubProfileTargets' | 'hubProfileTargetModule' | 'hubProfileTargetTemplate' | 'hubProfileTargetShards' | 'allowUnmanagedPluginPaths'>): void {
  if (config.requireHub !== true) return;
  if (config.allowUnmanagedPluginPaths === true) throw new Error('allowUnmanagedPluginPaths cannot be enabled when requireHub=true');
  if (!config.hub) throw new Error('requireHub=true requires a DSH Hub configuration');
  if (!config.hub.internalOperatorToken) throw new Error('requireHub=true requires hub.internalOperatorToken');
  if (!config.hubProfileTargetModule && !config.hubProfileTargets && !config.hubProfileTargetTemplate && !config.hubProfileTargetShards) throw new Error('requireHub=true requires hubProfileTargets, hubProfileTargetTemplate, hubProfileTargetShards or hubProfileTargetModule');
  if (config.hubProfileTargetTemplate) renderHubTargetTemplate(config.hubProfileTargetTemplate, 'validation-user');
  if (config.hubProfileTargetShards) {
    if (config.hubProfileTargetShards.length < 1 || config.hubProfileTargetShards.length > 64) throw new Error('hubProfileTargetShards must contain between 1 and 64 targets');
    for (const [index, target] of config.hubProfileTargetShards.entries()) {
      if (!target || typeof target !== 'object') throw new Error(`hubProfileTargetShards[${String(index)}] must be an object`);
      if (typeof target.runtimeIdTemplate !== 'string' || !target.runtimeIdTemplate.includes('{userId}')) throw new Error(`hubProfileTargetShards[${String(index)}].runtimeIdTemplate must include {userId}`);
      renderHubTargetTemplate({ nodeId: target.nodeId, runtimeId: target.runtimeIdTemplate }, 'validation-user');
    }
  }
}

function validateHubTarget(target: { nodeId: string; runtimeId: string }, field: string): { nodeId: string; runtimeId: string } {
  if (!target || typeof target !== 'object') throw new Error(`${field} must be an object`);
  const check = (value: unknown, name: string): string => {
    if (typeof value !== 'string' || !/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u.test(value)) throw new Error(`${field}.${name} is invalid`);
    return value;
  };
  return { nodeId: check(target.nodeId, 'nodeId'), runtimeId: check(target.runtimeId, 'runtimeId') };
}

function renderHubTargetTemplate(template: { nodeId: string; runtimeId: string }, userId: string): { nodeId: string; runtimeId: string } {
  // Keep the local guard identical to DSH Hub's HubNodeId/HubRuntimeId
  // protocol: identifiers are lowercase and use only DNS-like separators.
  const hubIdentifier = (value: string, field: string): string => {
    if (!/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u.test(value)) throw new Error(`hubProfileTargetTemplate.${field} renders an invalid Hub identifier`);
    return value;
  };
  const render = (value: unknown, field: string): string => {
    if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\u0000-\u001f]/u.test(value)) throw new Error(`hubProfileTargetTemplate.${field} must be a valid string`);
    const rendered = value.replaceAll('{userId}', userId);
    if (rendered.includes('{userId}')) throw new Error(`hubProfileTargetTemplate.${field} renders an invalid Hub identifier`);
    return hubIdentifier(rendered, field);
  };
  return { nodeId: render(template.nodeId, 'nodeId'), runtimeId: render(template.runtimeId, 'runtimeId') };
}

async function loadModule(path: string): Promise<Record<string, unknown>> { return await import(pathToFileURL(requiredPath(path, 'modulePath')).href); }

/** Production composition entrypoint. Secrets stay in this private config and never enter the browser Profile. */
export async function startFromConfig(config: MultiTenantDeploymentConfig): Promise<() => Promise<void>> {
  const database = requiredPath(config.database, 'database'); const stateDirectory = requiredPath(config.stateDirectory, 'stateDirectory');
  const idleHostMs = config.idleHostMs ?? 5 * 60_000;
  if (!Number.isFinite(idleHostMs) || idleHostMs < 0) throw new Error('idleHostMs must be zero or a finite positive duration');
  validateHubConfiguration(config);
  const pluginPathRoots = (config.pluginPathRoots ?? []).map((value, index) => requiredPath(value, `pluginPathRoots[${String(index)}]`));
  let createSandboxProvider: (config: MultiTenantDeploymentConfig) => SandboxProvider;
  let createDriverConfiguration: (input: { userId: string; profile: EffectiveProfile; sandboxId: string; runtimeDirectory: string; skillsFile: string }) => unknown;
  let resolveUserWorkspaceId: ((userId: string) => string) | undefined;
  if (config.standardRuntime) {
    createSandboxProvider = value => createStandardSandboxProvider(value as MultiTenantDeploymentConfig & { standardRuntime: StandardRuntimeConfig });
    createDriverConfiguration = input => createStandardDriverConfiguration(config as MultiTenantDeploymentConfig & { standardRuntime: StandardRuntimeConfig }, input);
    resolveUserWorkspaceId = userId => standardUserWorkspaceId(config.standardRuntime!, userId);
  } else {
    if (!config.sandboxProviderModule || !config.driverConfigurationModule) throw new Error('Provide standardRuntime or both adapter module paths');
    const sandboxModule = await loadModule(config.sandboxProviderModule);
    const sandboxFactory = sandboxModule.createSandboxProvider as ((config: MultiTenantDeploymentConfig) => SandboxProvider) | undefined;
    if (typeof sandboxFactory !== 'function') throw new Error('sandboxProviderModule must export createSandboxProvider(config)');
    createSandboxProvider = sandboxFactory;
    const driverModule = await loadModule(config.driverConfigurationModule);
    const driverFactory = driverModule.createDriverConfiguration as (input: { userId: string; profile: EffectiveProfile; sandboxId: string; runtimeDirectory: string; skillsFile: string }) => unknown;
    if (typeof driverFactory !== 'function') throw new Error('driverConfigurationModule must export createDriverConfiguration(input)');
    createDriverConfiguration = driverFactory;
  }
  const repository = new TenantRepository(database);
  if (config.mockUserId) {
    const mockUser = repository.getUser(config.mockUserId);
    if (!mockUser || mockUser.status !== 'active') throw new Error(`mockUserId ${config.mockUserId} must name a pre-provisioned active user`);
    if (config.identityProviderModule) throw new Error('mockUserId cannot be combined with identityProviderModule');
  }
  const composer = new ProfileComposer(repository, { systemPlugins: config.systemPlugins ?? [], systemSkills: config.systemSkills ?? [] });
  const sandboxProvider = createSandboxProvider(config);
  const sandboxManager = new PersistentTenantSandboxManager(repository, sandboxProvider);
  const launcher = new ProcessHostLauncher({ stateDirectory, createDriverConfiguration: async input => {
    const result = await createDriverConfiguration(input);
    if (!result || typeof result !== 'object') throw new Error('createDriverConfiguration returned an invalid object');
    return result as any;
  } });
  let hub: DshHubClient | undefined;
  if (config.hub) {
    hub = new DshHubClient(config.hub);
  }
  if (config.requireHub === true && hub) {
    // Validate the service credential before opening the public Gateway.  Hub
    // owns the authenticated operator/control-plane session; a later request
    // must not discover a bad Hub token after users already received access.
    await hub.me();
  }
  let identityProvider: { authenticate(req: import('node:http').IncomingMessage): Promise<{ userId: string; email?: string }> } | undefined;
  if (config.identityProviderModule) {
    const module = await loadModule(config.identityProviderModule);
    const authenticate = module.authenticate as ((req: import('node:http').IncomingMessage) => Promise<{ userId: string; email?: string }>) | undefined;
    if (typeof authenticate !== 'function') throw new Error('identityProviderModule must export authenticate(req)');
    identityProvider = { authenticate };
  }
  let applyProfile: ((input: { userId: string; profile: EffectiveProfile }) => Promise<void>) | undefined;
  if (hub && (config.hubProfileTargetModule || config.hubProfileTargets || config.hubProfileTargetTemplate || config.hubProfileTargetShards)) {
    let resolveTarget: ((input: { userId: string; profile: EffectiveProfile }) => Promise<{ nodeId: string; runtimeId: string }> | { nodeId: string; runtimeId: string }) | undefined;
    if (config.hubProfileTargetModule) {
      const module = await loadModule(config.hubProfileTargetModule);
      resolveTarget = module.resolveProfileTarget as typeof resolveTarget;
      if (typeof resolveTarget !== 'function') throw new Error('hubProfileTargetModule must export resolveProfileTarget(input)');
    } else if (config.hubProfileTargets) {
      const targets = config.hubProfileTargets!;
      resolveTarget = ({ userId }) => {
        const target = targets[userId];
        if (!target) throw new Error(`No DSH Hub Node/Runtime target configured for tenant ${userId}`);
        return target;
      };
    } else if (config.hubProfileTargetTemplate) {
      const template = config.hubProfileTargetTemplate!;
      resolveTarget = ({ userId }) => renderHubTargetTemplate(template, userId);
    } else {
      const shards = config.hubProfileTargetShards!;
      resolveTarget = ({ userId }) => {
        const candidates = shards.map((target, index) => {
          if (!target.runtimeIdTemplate.includes('{userId}')) throw new Error(`hubProfileTargetShards[${String(index)}].runtimeIdTemplate must include {userId}`);
          return renderHubTargetTemplate({ nodeId: target.nodeId, runtimeId: target.runtimeIdTemplate }, userId);
        });
        // This durable allocation is the single source of truth shared with
        // reconcile-node-agent-fleet.ts. Do not replace it with a stateless
        // hash: adding a Node must never move an existing tenant's Profile.
        const assigned = repository.assignHubProfileTarget(userId, candidates);
        return { nodeId: assigned.nodeId, runtimeId: assigned.runtimeId };
      };
    }
    applyProfile = async input => {
      const target = validateHubTarget(await resolveTarget!(input), `Hub Profile target for ${input.userId}`);
      // The allocation in TenantRepository is durable, but Hub remains the
      // authority for whether the Node Agent is online and the registered
      // Runtime advertises dsh.plugins. The Runtime process may be stopped;
      // the long-lived Node Agent owns this Profile transaction.
      await assertHubProfileTargetAvailable(hub, target);
      // The official Hub capability installs npm packages. Local modulePath
      // entries are already staged by deployment and are loaded by the DSH
      // Host, so do not misrepresent a DSH id as an npm package name.
      const plugins = [...input.profile.systemPlugins, ...input.profile.plugins]
        .filter(item => item.enabled && item.packageName)
        .map(item => ({ packageName: item.packageName!, version: item.version }));
      await requestProfileTransaction(hub, { ...target, profileVersion: input.profile.version, plugins });
    };
  }
  if (config.requireHub === true && !applyProfile) throw new Error('requireHub=true requires hubProfileTargets, hubProfileTargetTemplate, hubProfileTargetShards or hubProfileTargetModule');
  const supervisor = new HostSupervisor({ repository, composer, sandbox: sandboxManager, launcher, applyProfile, idleMs: idleHostMs });
  const closeGateway = await startMultiTenantGateway({ repository, composer, supervisor, sandbox: sandboxManager, hub, identityProvider, mockUserId: config.mockUserId, autoProvisionIdentity: config.autoProvisionIdentity, operatorUserIds: config.operatorUserIds, pluginPathRoots, allowUnmanagedPluginPaths: config.allowUnmanagedPluginPaths, resolveUserWorkspaceId, host: config.listenHost, port: config.port });
  // Keep the control plane lightweight: a zero value disables automatic
  // collection, otherwise sweep idle Hosts without touching active requests.
  const sweepMs = idleHostMs === 0 ? undefined : Math.max(1_000, Math.min(idleHostMs, 60_000));
  const idleSweep = sweepMs === undefined ? undefined : setInterval(() => { void supervisor.stopIdle().catch(() => { /* next sweep reconciles */ }); }, sweepMs);
  idleSweep?.unref?.();
  const shutdown = async () => { if (idleSweep) clearInterval(idleSweep); await closeGateway(); await supervisor.closeAll(); await sandboxProvider.close?.(); repository.close(); };
  process.once('SIGINT', () => { void shutdown().finally(() => process.exit(0)); });
  process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)); });
  return shutdown;
}

if (process.argv[1] && process.argv[1].endsWith('start.ts')) {
  const configPath = process.env.DSH_TENANT_CONFIG;
  if (!configPath || !isAbsolute(configPath)) throw new Error('DSH_TENANT_CONFIG must be an absolute private JSON path');
  const config = JSON.parse(await readFile(configPath, 'utf8')) as MultiTenantDeploymentConfig;
  await startFromConfig(config);
  console.log(`Multi-tenant DSH Gateway listening on ${config.listenHost ?? '127.0.0.1'}:${String(config.port ?? 3380)}`);
}
