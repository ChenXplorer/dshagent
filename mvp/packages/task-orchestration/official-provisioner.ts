import { createHash } from 'node:crypto';
import { posix, join as hostJoin } from 'node:path';
import { mkdir as makeDirectory } from 'node:fs/promises';
import { DaytonaNotFoundError } from '@daytona/sdk';
import type { Daytona, Sandbox } from '@daytona/sdk';
import type { OfficialMulticaClient, RuntimeTarget } from '../multica-client/index.ts';
import { PERSONAL_SANDBOX_LABELS } from '../sandbox-management/index.ts';
import type { TaskOrchestratorOptions } from './index.ts';

export interface OfficialSegmentProvisionerOptions {
  client: OfficialMulticaClient;
  daytona: Daytona;
  workspaceRoot: string;
  maxConcurrentTasks: number;
  /** Resolve the actual Daemon registered by sandbox bootstrap, never a global first match. */
  resolveDaemonId(input: { userId: string; sandboxId: string }): Promise<string>;
  /** Optional roots for registered Daemons. Local roots are used directly by
   * a local Windows daemon; Daytona roots are prepared through Daytona FS. */
  runtimeRoots?: Record<string, { root: string; mode: 'daytona' | 'local' | 'external' }>;
}

/** Concrete composition callback using official Multica APIs and Daytona file APIs only. */
export function createOfficialSegmentProvisioner(options: OfficialSegmentProvisionerOptions): TaskOrchestratorOptions['provisionExecutionSegment'] {
  if (!options.workspaceRoot.startsWith('/') || options.workspaceRoot === '/' || posix.normalize(options.workspaceRoot) !== options.workspaceRoot) {
    throw new Error('workspaceRoot must be a normalized absolute sandbox directory');
  }
  if (!Number.isInteger(options.maxConcurrentTasks) || options.maxConcurrentTasks < 2 || options.maxConcurrentTasks > 50) {
    throw new Error('maxConcurrentTasks must be between 2 and 50');
  }
  return async input => {
    const fallbackDaemonId = await options.resolveDaemonId({ userId: input.userId, sandboxId: input.sandboxId });
    const requested: RuntimeTarget = input.runtimeTarget ?? { daemonId: fallbackDaemonId, kind: input.runtime };
    const daemonId = requested.daemonId;
    const runtime = await options.client.selectRuntime(requested);
    const sessionKey = digest([input.userId, input.dshSessionId]);
    const rootSpec = options.runtimeRoots?.[daemonId] ?? { root: options.workspaceRoot, mode: 'daytona' as const };
    const workDir = input.previous?.daemonId === daemonId ? input.previous.workDir :
      (rootSpec.mode === 'local' ? hostJoin(rootSpec.root, `session-${sessionKey}`) : posix.join(rootSpec.root, `session-${sessionKey}`));
    if (!isWithinRoot(workDir, rootSpec.root, rootSpec.mode)) throw new Error('Execution directory escapes the configured personal workspace root');
    const sandbox = rootSpec.mode === 'daytona' ? await options.daytona.get(input.sandboxId) : undefined;
    if (sandbox && (sandbox.id !== input.sandboxId || sandbox.labels[PERSONAL_SANDBOX_LABELS.user] !== input.userId || sandbox.state !== 'started')) {
      throw new Error('Cannot prepare a directory in an unowned or unavailable personal sandbox');
    }
    if (sandbox) {
      await ensureDirectory(sandbox, rootSpec.root, input.mode);
      await ensureDirectory(sandbox, workDir, input.mode);
    } else if (rootSpec.mode === 'local') {
      // A local_directory resource is validated by Multica before dispatch;
      // make the per-session directory locally so the first task can start.
      await makeDirectory(rootSpec.root, { recursive: true });
      await makeDirectory(workDir, { recursive: true });
    } else {
      // An external Daemon owns its filesystem. The Project resource is still
      // declared through Multica, but this DSH Host must not mkdir on it.
    }

    // One logical DSH session owns one Multica Agent and one Chat Session.
    // The Agent is the stable carrier; its runtime binding is changed through
    // Multica when the user switches Codex/Claude. Execution segments remain
    // local correlation records for task/runtime history only.
    const agentName = `DSH session ${sessionKey}`;
    const listedAgents = await options.client.listAgents();
    const matchedAgents = listedAgents.filter(agent => agent.name === agentName);
    if (matchedAgents.length > 1) throw new Error('Multiple official Agents match this execution segment');
    const previousAgent = input.previous ? listedAgents.find(agent => agent.id === input.previous!.agentId) : undefined;
    if (matchedAgents[0] && previousAgent && matchedAgents[0].id !== previousAgent.id) throw new Error('Stable and previous Agent bindings conflict for this DSH session');
    // Adopt the previous resource by ID when upgrading from the old
    // per-segment naming scheme. This is a read-only lookup, so it cannot
    // create a second logical Agent/Chat during the first post-upgrade switch.
    let agent = matchedAgents[0] ?? previousAgent;
    if (!agent) {
      requireCreation(input.mode, 'Agent');
      agent = await options.client.createAgent({ name: agentName, runtimeId: runtime.id, maxConcurrentTasks: options.maxConcurrentTasks });
    }
    if (agent.runtime_id !== runtime.id) {
      if (input.mode !== 'create') {
        // Reconciliation may adopt a partially completed runtime switch, but
        // it must never issue a second mutation after an uncertain call.
        throw new Error('Agent runtime differs during read-only reconciliation; runtime switch must be reconciled explicitly');
      }
      agent = await options.client.switchAgentRuntime({ agentId: agent.id, runtimeId: runtime.id });
    }
    if (agent.runtime_id !== runtime.id || agent.max_concurrent_tasks !== options.maxConcurrentTasks) throw new Error('Official Agent Runtime or concurrency differs from requested binding');
    if (agent.model || (Array.isArray(agent.custom_args) ? agent.custom_args.length : agent.custom_args) || agent.custom_env && Object.keys(agent.custom_env as object).length) {
      throw new Error('Official Agent unexpectedly overrides native CLI model or configuration');
    }

    const projectName = `DSH session ${sessionKey}`;
    const listedProjects = await options.client.listProjects();
    const matchedProjects = listedProjects.filter(project => project.title === projectName);
    if (matchedProjects.length > 1) throw new Error('Multiple official Projects match this DSH session');
    const previousProject = input.previous ? listedProjects.find(project => project.id === input.previous!.projectId) : undefined;
    if (matchedProjects[0] && previousProject && matchedProjects[0].id !== previousProject.id) throw new Error('Stable and previous Project bindings conflict for this DSH session');
    let projectId = matchedProjects[0]?.id ?? previousProject?.id;
    if (!projectId) {
      requireCreation(input.mode, 'Project');
      projectId = (await options.client.createDirectoryProject({ title: projectName, daemonId, localPath: workDir })).id;
    }
    if (input.previous && projectId !== input.previous.projectId) throw new Error('Runtime switch changed the DSH directory Project');
    const projectResources = await options.client.listProjectResources(projectId);
    const matchingResources = projectResources.filter(resource => resource.resource_type === 'local_directory' &&
      resource.resource_ref.local_path === workDir && resource.resource_ref.daemon_id === daemonId &&
      resource.resource_ref.execution_mode === 'in_place');
    if (matchingResources.length > 1) throw new Error('Multiple Official Project resources match this runtime');
    if (matchingResources.length === 0) {
      requireCreation(input.mode, 'Project directory/Daemon runtime resource');
      await options.client.createProjectResource({ projectId, daemonId, localPath: workDir });
    }

    const chatName = `DSH session ${sessionKey}`;
    const listedChats = await options.client.listChatSessions();
    const matchedChats = listedChats.filter(chat => chat.title === chatName);
    if (matchedChats.length > 1) throw new Error('Multiple official Chats match this execution segment');
    const previousChat = input.previous ? listedChats.find(chat => chat.id === input.previous!.chatSessionId) : undefined;
    if (matchedChats[0] && previousChat && matchedChats[0].id !== previousChat.id) throw new Error('Stable and previous Chat bindings conflict for this DSH session');
    let chat = matchedChats[0] ?? previousChat;
    if (!chat) {
      requireCreation(input.mode, 'Chat');
      chat = await options.client.createChatSession({ agentId: agent.id, projectId, title: chatName });
    }
    if (chat.agent_id !== agent.id || chat.project_id !== projectId || chat.status === 'archived') throw new Error('Official Chat does not match the DSH session');
    return { daemonId, agentId: agent.id, runtimeId: runtime.id, projectId, chatSessionId: chat.id, workDir };
  };
}

function isWithinRoot(path: string, root: string, mode: 'daytona' | 'local' | 'external'): boolean {
  if (mode === 'daytona') return path.startsWith(`${root}/`);
  if (mode === 'external') {
    if (!root.startsWith('/') && !/^[A-Za-z]:[\\/]/u.test(root)) return false;
    const normalizedPath = path.replace(/[\\/]+/g, '/');
    const normalizedRoot = root.replace(/[\\/]+/g, '/').replace(/\/$/u, '');
    return normalizedPath.startsWith(`${normalizedRoot}/`);
  }
  const normalizedPath = path.replace(/[\\/]+/g, '/').toLowerCase();
  const normalizedRoot = root.replace(/[\\/]+/g, '/').replace(/\/$/u, '').toLowerCase();
  return normalizedPath.startsWith(`${normalizedRoot}/`);
}

function digest(parts: string[]): string { return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32); }
function requireCreation(mode: 'create' | 'reconcile', resource: string): void {
  if (mode !== 'create') throw new Error(`${resource} absent during read-only reconciliation; refusing another create POST`);
}
async function ensureDirectory(sandbox: Sandbox, path: string, mode: 'create' | 'reconcile'): Promise<void> {
  try {
    if (!(await sandbox.fs.getFileDetails(path)).isDir) throw new Error('Sandbox workspace path exists but is not a directory');
  } catch (error) {
    if (!(error instanceof DaytonaNotFoundError)) throw error;
    requireCreation(mode, 'Workspace directory');
    await sandbox.fs.createFolder(path, '700');
    if (!(await sandbox.fs.getFileDetails(path)).isDir) throw new Error('Daytona did not confirm workspace creation');
  }
}
