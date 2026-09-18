import { createHash } from 'node:crypto';
import { join, posix } from 'node:path';
import { Daytona } from '@daytona/sdk';
import { CorrelationRepository } from '../../packages/persistence/index.ts';
import { PersonalSandboxService } from '../../packages/sandbox-management/index.ts';
import { createDaemonBootstrap, type DaemonBootstrapConfiguration } from '../../packages/sandbox-management/bootstrap.ts';
import { PersonalSandboxProvider } from '../../packages/tenant-control/personal-sandbox-adapter.ts';
import type { DaemonRegistration, EffectiveProfile, SandboxProvider } from '../../packages/tenant-control/index.ts';
import type { MultiTenantDeploymentConfig } from './start.ts';
import type { DeploymentDriverConfiguration } from '../dsh-host/create-driver.ts';

export interface StandardRuntimeConfig {
  daytona: { apiUrl: string; apiKey: string; organizationId?: string; target: string; snapshot: string };
  multica: { localApiUrl: string; token: string; workspaceId: string };
  /** The template points at the official daemon/CLI artifact and is cloned per user. */
  daemonTemplate: DaemonBootstrapConfiguration;
  /** Private per-user credentials/workspace. Required for multi-tenant mode. */
  userOverrides?: Record<string, { multica: { localApiUrl: string; token: string; workspaceId: string }; daemonTemplate: DaemonBootstrapConfiguration }>;
  /** Explicit development escape hatch for a single trusted tenant only. */
  allowSharedMulticaWorkspace?: boolean;
}

function userSuffix(userId: string): string { return createHash('sha256').update(userId).digest('hex').slice(0, 16); }
function runtimeForUser(config: StandardRuntimeConfig, userId: string): { multica: StandardRuntimeConfig['multica']; daemonTemplate: DaemonBootstrapConfiguration } {
  const override = config.userOverrides?.[userId];
  if (override) return override;
  if (config.allowSharedMulticaWorkspace === true) return { multica: config.multica, daemonTemplate: config.daemonTemplate };
  throw new Error(`No private Multica workspace credentials configured for tenant ${userId}; add standardRuntime.userOverrides.${userId}`);
}

/** Used by the Gateway discovery route without exposing the workspace token. */
export function standardUserWorkspaceId(config: StandardRuntimeConfig, userId: string): string {
  return runtimeForUser(config, userId).multica.workspaceId;
}
function userDaemon(config: StandardRuntimeConfig, userId: string): DaemonBootstrapConfiguration {
  const safe = userSuffix(userId); const base = runtimeForUser(config, userId).daemonTemplate;
  const home = posix.join(base.home, safe);
  // CLI state is part of the tenant execution identity.  Keeping only the
  // Daemon home tenant-scoped would still make every user's Codex/Claude
  // credentials, native sessions and model catalog share the template paths.
  const codexHome = posix.join(home, 'codex');
  const claudeHome = posix.join(home, 'claude');
  const nativeCli = {
    ...base.nativeCli,
    codexHome,
    claudeHome,
    codex: {
      ...base.nativeCli.codex,
      ...(base.nativeCli.codex.modelCatalogPath ? { modelCatalogPath: posix.join(codexHome, 'models.json') } : {}),
    },
  };
  return { ...base, nativeCli, daemonId: `${base.daemonId}-${safe}`, home, workspacesRoot: posix.join(base.workspacesRoot, safe) };
}

/** Uses the existing PersonalSandboxService and Daytona SDK; no sandbox API is reimplemented here. */
export function createStandardSandboxProvider(config: MultiTenantDeploymentConfig & { standardRuntime: StandardRuntimeConfig }): SandboxProvider {
  const runtime = config.standardRuntime; const daytona = new Daytona({ apiUrl: runtime.daytona.apiUrl, apiKey: runtime.daytona.apiKey, organizationId: runtime.daytona.organizationId, target: runtime.daytona.target, otelEnabled: false });
  // The Host process opens the same durable correlation database through
  // createDriver(). Keeping one database means sandbox creation and task
  // provisioning reconcile the same user/daemon bindings after a restart;
  // a second database could create a duplicate Sandbox after a response loss.
  const correlation = new CorrelationRepository(join(config.stateDirectory, 'correlation.db'));
  const service = new PersonalSandboxService({ client: daytona, repository: correlation, snapshot: runtime.daytona.snapshot, timeoutSeconds: 180,
    ensureExecutionReady: async (sandbox, userId) => { await createDaemonBootstrap(userDaemon(runtime, userId))(sandbox); },
  });
  return new PersonalSandboxProvider(service, userId => ({ label: 'Platform default Daemon', daemonId: userDaemon(runtime, userId).daemonId, workspaceId: runtimeForUser(runtime, userId).multica.workspaceId, runtimeIds: [], workspacesRoot: userDaemon(runtime, userId).workspacesRoot, executionMode: 'daytona', managed: true, status: 'online' }), () => correlation.close());
}

/** Builds a real per-user DSH Host driver config while keeping credentials private. */
export function createStandardDriverConfiguration(config: MultiTenantDeploymentConfig & { standardRuntime: StandardRuntimeConfig }, input: { userId: string; profile: EffectiveProfile; sandboxId: string; runtimeDirectory: string; skillsFile: string }): DeploymentDriverConfiguration {
  const runtime = config.standardRuntime; const templateDaemon = userDaemon(runtime, input.userId);
  const perUser = runtimeForUser(runtime, input.userId);
  // The platform profile can lower the shared template's Multica slot limit,
  // but never raise it beyond the operator-approved Daemon capacity.
  const maxConcurrentTasks = Math.min(input.profile.maxConcurrentTasks, templateDaemon.maxConcurrentTasks, 50);
  if (!Number.isInteger(maxConcurrentTasks) || maxConcurrentTasks < 2) throw new Error('User Profile maxConcurrentTasks must be at least 2 and fit the Daemon capacity');
  const daemon = { ...templateDaemon, maxConcurrentTasks };
  const customTargets = input.profile.daemons.filter(item => item.status !== 'revoked' && !item.managed).flatMap(item => {
    // A single Multica Chat Session can switch Daemons only when the Daemons
    // belong to the same private workspace.  A registration pointing at a
    // different workspace would silently lose the shared Agent/Chat context.
    if (item.workspaceId !== perUser.multica.workspaceId) throw new Error(`Daemon ${item.id} belongs to a different Multica workspace`);
    // Runtime kind is resolved by the runtime catalog at task selection time;
    // this target only contributes the Daemon's directory root to the Host.
    const runtimeId = item.runtimeIds[0];
    return runtimeId ? [{ daemonId: item.daemonId, kind: input.profile.defaultRuntime, runtimeId, mode: item.executionMode, workspacesRoot: item.workspacesRoot, label: item.label }] : [];
  });
  // Sandbox and Task correlation is shared by the control plane and user Host
  // processes; userId/sessionId are the ownership keys inside that database.
  return { userId: input.userId, defaultRuntime: input.profile.defaultRuntime, maxConcurrentTasks, correlationDatabase: join(config.stateDirectory, 'correlation.db'), daytona: runtime.daytona, multica: perUser.multica, daemon,
    managedSkillsFile: input.skillsFile, runtimeTargets: customTargets,
    runtimeAllowlist: input.profile.daemons.filter(item => item.status !== 'revoked').map(item => ({ daemonId: item.daemonId, runtimeIds: item.runtimeIds })),
    defaultRuntimeTarget: { daemonId: daemon.daemonId, kind: input.profile.defaultRuntime } };
}
