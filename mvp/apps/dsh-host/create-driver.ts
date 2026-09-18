import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { Daytona } from '@daytona/sdk';
import { OfficialMulticaClient, type CliKind, type RuntimeTarget } from '../../packages/multica-client/index.ts';
import { CorrelationRepository } from '../../packages/persistence/index.ts';
import { PersonalSandboxService } from '../../packages/sandbox-management/index.ts';
import { createDaemonBootstrap, confirmSandboxTaskSettled, type DaemonBootstrapConfiguration } from '../../packages/sandbox-management/bootstrap.ts';
import { TaskOrchestrator, createOfficialSegmentProvisioner } from '../../packages/task-orchestration/index.ts';
import { loadDshManagedSkills, loadDshRegistrySkills, MulticaSkillDistributor, type DshManagedSkill } from '../../packages/skill-distribution/index.ts';

export interface DeploymentDriverConfiguration {
  userId: string;
  defaultRuntime: CliKind;
  /** Effective per-user active Task quota (capped to Multica's supported range). */
  maxConcurrentTasks?: number;
  correlationDatabase: string;
  daytona: { apiUrl: string; apiKey: string; organizationId?: string; target: string; snapshot: string };
  multica: { localApiUrl: string; token: string; workspaceId: string };
  daemon: DaemonBootstrapConfiguration;
  /** DSH-owned Skills. They are created/updated in Multica and attached to each session Agent. */
  managedSkills?: DshManagedSkill[];
  /** Optional JSON file rewritten by the multi-tenant control plane. */
  managedSkillsFile?: string;
  /** Optional conventional <root>/<skill>/SKILL.md tree for arbitrary DSH Skills. */
  managedSkillsDir?: string;
  /** Read the official DSH ctx.skills registry when this is enabled. */
  syncDshSkills?: boolean;
  /** Optional allowlist for DSH registry source buckets. */
  dshSkillSources?: string[];
  /** Additional Daemons registered in the same Multica workspace. */
  runtimeTargets?: Array<RuntimeTarget & { mode: 'daytona' | 'local' | 'external'; workspacesRoot: string; label?: string }>;
  defaultRuntimeTarget?: RuntimeTarget;
}

/** Shared production lifecycle composition, also used by the explicit live lifecycle acceptance. */
export function createConfiguredPersonalSandboxService(config: DeploymentDriverConfiguration, repository: CorrelationRepository,
  daytona: Daytona, client: OfficialMulticaClient): PersonalSandboxService {
  const bootstrap = createDaemonBootstrap(config.daemon);
  return new PersonalSandboxService({ client: daytona, repository, snapshot: config.daytona.snapshot, timeoutSeconds: 180,
    ensureExecutionReady: async sandbox => {
      await bootstrap(sandbox);
      await client.selectRuntime({ daemonId: config.daemon.daemonId, kind: 'codex' });
      await client.selectRuntime({ daemonId: config.daemon.daemonId, kind: 'claude-code' });
    },
  });
}

/** DSH imports this factory; configuration is a private local JSON file, never a committed credential file. */
export async function createDriver(_input: { ctx?: unknown } = {}): Promise<TaskOrchestrator> {
  const path = process.env.DSH_MVP_CONFIG;
  if (!path || !isAbsolute(path)) throw new Error('DSH_MVP_CONFIG must be an absolute private deployment JSON path');
  const config = JSON.parse(await readFile(path, 'utf8')) as DeploymentDriverConfiguration;
  if (process.env.DSH_MVP_USER_ID && process.env.DSH_MVP_USER_ID !== config.userId) throw new Error('Gateway and driver trusted user identity differ');
  if (!isAbsolute(config.correlationDatabase) || config.multica.workspaceId !== config.daemon.workspaceId || config.multica.token !== config.daemon.token) {
    throw new Error('Driver requires an absolute database path and consistent official Multica workspace credentials');
  }
  const remoteUrl = new URL(config.daemon.serverUrl);
  if (['localhost', '127.0.0.1', '[::1]'].includes(remoteUrl.hostname)) throw new Error('Daemon serverUrl must be reachable from Daytona, not Windows localhost');
  await mkdir(dirname(config.correlationDatabase), { recursive: true });
  const repository = new CorrelationRepository(config.correlationDatabase);
  try {
    const daytona = new Daytona({ apiUrl: config.daytona.apiUrl, apiKey: config.daytona.apiKey, organizationId: config.daytona.organizationId,
      target: config.daytona.target, otelEnabled: false });
    const client = new OfficialMulticaClient({ baseUrl: config.multica.localApiUrl, token: config.multica.token, workspaceId: config.multica.workspaceId });
    const reloadDshSkills = async (): Promise<readonly DshManagedSkill[]> => {
      const directorySkills = config.managedSkillsDir ? await loadDshManagedSkills(config.managedSkillsDir) : [];
      const fileSkills = config.managedSkillsFile ? await loadSkillsFile(config.managedSkillsFile) : [];
      const registrySkills = config.syncDshSkills ? await loadDshRegistrySkills(_input.ctx, {
        cwd: process.env.DSH_MVP_HOST_WORKSPACE,
        sources: config.dshSkillSources,
      }) : [];
      return [...(config.managedSkills ?? []), ...fileSkills, ...directorySkills, ...registrySkills];
    };
    const skillDistributor = new MulticaSkillDistributor(client, await reloadDshSkills(), {
      reload: reloadDshSkills,
      ...(config.managedSkillsFile ? {
        persist: async (skills: readonly DshManagedSkill[]) => {
          await mkdir(dirname(config.managedSkillsFile!), { recursive: true });
          await writeFile(config.managedSkillsFile!, `${JSON.stringify(skills, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
        },
      } : {}),
      // A shared Multica workspace is allowed, so DSH-owned Skill markers
      // must be tenant-scoped and cannot be deleted by another Host.
      namespace: config.userId,
    });
    const personal = createConfiguredPersonalSandboxService(config, repository, daytona, client);
    const runtimeRoots: Record<string, { root: string; mode: 'daytona' | 'local' | 'external' }> = {
      [config.daemon.daemonId]: { root: config.daemon.workspacesRoot, mode: 'daytona' },
      ...Object.fromEntries((config.runtimeTargets ?? []).map(target => [target.daemonId, { root: target.workspacesRoot, mode: target.mode }])) as Record<string, { root: string; mode: 'daytona' | 'local' | 'external' }>,
    };
    const defaultRuntimeTarget = config.defaultRuntimeTarget ?? { daemonId: config.daemon.daemonId, kind: config.defaultRuntime };
    const maxConcurrentTasks = config.maxConcurrentTasks ?? config.daemon.maxConcurrentTasks;
    if (!Number.isInteger(maxConcurrentTasks) || maxConcurrentTasks < 2 || maxConcurrentTasks > 50) throw new Error('Effective maxConcurrentTasks must be between 2 and 50');
    const driver = new TaskOrchestrator({ userId: config.userId, defaultRuntime: config.defaultRuntime, maxConcurrentTasks, defaultRuntimeTarget, repository, client, skillDistributor,
      ensurePersonalSandbox: userId => personal.ensurePersonalSandbox(userId),
      provisionExecutionSegment: createOfficialSegmentProvisioner({ daytona, client, workspaceRoot: config.daemon.workspacesRoot,
        maxConcurrentTasks, runtimeRoots,
        resolveDaemonId: async () => config.daemon.daemonId }),
      confirmTaskSettled: async ({ sandboxId, binding }) => {
        // The platform-managed Daemon is the only one whose process and
        // health endpoint are reachable through this Host's Daytona Sandbox.
        // A user local/remote Daemon is settled from Multica's terminal state
        // and the fully drained transcript; probing the platform Sandbox here
        // would inspect the wrong process and could falsely hold the task open.
        if (!binding.daemonId || binding.daemonId === config.daemon.daemonId) {
          return confirmSandboxTaskSettled(await daytona.get(sandboxId), config.daemon, binding.taskId);
        }
        return { executionStopped: true, transcriptFlushed: true };
      },
    });
    const ctx = _input.ctx as { effect?: (factory: () => () => void) => unknown } | undefined;
    if (typeof ctx?.effect === 'function') ctx.effect(() => () => repository.close());
    else process.once('exit', () => repository.close());
    return driver;
  } catch (error) { repository.close(); throw error; }
}

async function loadSkillsFile(path: string): Promise<DshManagedSkill[]> {
  if (!isAbsolute(path)) throw new Error('managedSkillsFile must be an absolute path');
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) throw new Error('managedSkillsFile must contain an array');
    return parsed as DshManagedSkill[];
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT') return [];
    throw error;
  }
}
