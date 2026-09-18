import { createHash } from "node:crypto";
import type {
  OfficialAgent, OfficialChatSession, OfficialRuntime, OfficialTask,
  OfficialTaskMessage, RuntimeTarget, RuntimeDescriptor, SubmissionIntent, SubmissionResult,
  TaskBinding, TranscriptBatch, OfficialProject, OfficialProjectResource, OfficialSkill,
  OfficialSkillFile, OfficialSkillSummary,
} from "./types.ts";

export class MulticaApiError extends Error {
  readonly status: number;
  readonly operation: string;
  constructor(status: number, operation: string) {
    // Never echo upstream bodies: they may contain credentials or user prompts.
    super(`Official Multica ${operation} returned HTTP ${status}`);
    this.status = status;
    this.operation = operation;
  }
}
export class MulticaProtocolError extends Error {}

export interface MulticaClientConfig {
  baseUrl: string;
  token: string;
  workspaceId: string;
  timeoutMs?: number;
  heartbeatGraceMs?: number;
  fetchImpl?: typeof fetch;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MulticaProtocolError("Official Multica returned a non-object");
  }
  return value as Record<string, unknown>;
}
function string(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw new MulticaProtocolError(`Missing ${field}`);
  return value;
}
function rows(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new MulticaProtocolError("Official Multica returned a non-array");
  return value;
}
function integer(value: unknown, field: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new MulticaProtocolError(`Invalid ${field}`);
  }
  return value as number;
}
function id(value: string): string { return encodeURIComponent(string(value, "identifier")); }
function task(value: unknown): OfficialTask {
  const row = object(value);
  for (const field of ["id", "agent_id", "runtime_id", "status"]) string(row[field], field);
  return row as unknown as OfficialTask;
}
function skillSummary(value: unknown, workspaceId: string): OfficialSkillSummary {
  const row = object(value);
  for (const field of ["id", "workspace_id", "name", "description"]) string(row[field], `skill.${field}`);
  if (row.workspace_id !== workspaceId) throw new MulticaProtocolError("Skill workspace mismatch");
  return row as unknown as OfficialSkillSummary;
}
function skillFile(value: unknown): OfficialSkillFile {
  const row = object(value);
  string(row.path, "skill.file.path");
  string(row.content, "skill.file.content");
  return row as unknown as OfficialSkillFile;
}
function skill(value: unknown, workspaceId: string): OfficialSkill {
  const row = skillSummary(value, workspaceId) as OfficialSkill;
  string(row.content, "skill.content");
  if (!Array.isArray(row.files)) throw new MulticaProtocolError("Missing skill.files");
  row.files = row.files.map(skillFile);
  return row;
}

/** Thin official REST adapter. Scheduling, CLI processes and task storage belong to Multica. */
export class OfficialMulticaClient {
  private readonly baseUrl: string;
  private readonly config: MulticaClientConfig;
  private readonly fetchImpl: typeof fetch;
  constructor(config: MulticaClientConfig) {
    const url = new URL(config.baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
      throw new Error("Multica baseUrl must be an HTTP(S) origin without credentials");
    }
    string(config.token, "token");
    string(config.workspaceId, "workspaceId");
    this.baseUrl = url.origin;
    this.config = config;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 30_000),
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.config.token}`,
        "X-Workspace-ID": this.config.workspaceId,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new MulticaApiError(response.status, `${method} ${path}`);
    if (response.status === 204) return undefined;
    try { return await response.json(); }
    catch { throw new MulticaProtocolError(`Invalid JSON for ${method} ${path}`); }
  }

  async listRuntimes(): Promise<OfficialRuntime[]> {
    return rows(await this.request("GET", "/api/runtimes")).map(value => {
      const row = object(value);
      for (const field of ["id", "workspace_id", "provider", "status"]) string(row[field], field);
      if (row.workspace_id !== this.config.workspaceId) throw new MulticaProtocolError("Runtime workspace mismatch");
      return row as unknown as OfficialRuntime;
    });
  }

  /** User-facing runtime catalog. The daemon is the machine boundary; each
   * registered CLI is exposed as one selectable runtime. */
  async listRuntimeDescriptors(): Promise<RuntimeDescriptor[]> {
    return (await this.listRuntimes()).flatMap(runtime => {
      const daemonId = runtime.daemon_id;
      if (!daemonId) return [];
      const provider = runtime.provider.toLowerCase();
      const kind: RuntimeDescriptor["kind"] | undefined =
        provider === "codex" ? "codex" : provider === "claude" || provider === "claude-code" ? "claude-code" : undefined;
      if (!kind) return [];
      const deviceName = typeof runtime.device_name === "string" ? runtime.device_name : undefined;
      const runtimeName = typeof runtime.runtime_name === "string" ? runtime.runtime_name :
        typeof runtime.name === "string" ? runtime.name : undefined;
      const suffix = runtimeName || deviceName || daemonId.slice(0, 8);
      return [{ runtimeId: runtime.id, daemonId, kind, provider: runtime.provider,
        label: `${suffix} · ${kind === "claude-code" ? "Claude Code" : "Codex"}`,
        status: runtime.status, lastSeenAt: runtime.last_seen_at, deviceName, runtimeName }];
    });
  }

  async selectRuntime(target: RuntimeTarget): Promise<OfficialRuntime> {
    string(target.daemonId, "daemonId");
    if (!["codex", "claude-code"].includes(target.kind)) throw new Error("Unsupported CLI kind");
    const provider = target.kind === "claude-code" ? "claude" : "codex";
    const matches = (await this.listRuntimes()).filter(runtime =>
      runtime.daemon_id === target.daemonId && runtime.provider === provider &&
      (!target.runtimeId || runtime.id === target.runtimeId));
    if (matches.length !== 1) throw new Error(`Expected exactly one ${provider} runtime on the bound daemon; found ${matches.length}`);
    const runtime = matches[0]!;
    const seen = typeof runtime.last_seen_at === "string" ? Date.parse(runtime.last_seen_at) : NaN;
    const age = Date.now() - seen;
    if (runtime.status !== "online" || !Number.isFinite(seen) || age < -60_000 || age > (this.config.heartbeatGraceMs ?? 60_000)) {
      throw new Error("The bound Daytona runtime is offline or has no fresh heartbeat");
    }
    return runtime;
  }

  async createAgent(input: { name: string; runtimeId: string; maxConcurrentTasks: number }): Promise<OfficialAgent> {
    if (!Number.isInteger(input.maxConcurrentTasks) || input.maxConcurrentTasks < 2 || input.maxConcurrentTasks > 50) {
      throw new Error("MVP agent concurrency must be between 2 and 50");
    }
    const row = object(await this.request("POST", "/api/agents", {
      name: string(input.name, "name"), runtime_id: string(input.runtimeId, "runtimeId"),
      visibility: "private", max_concurrent_tasks: input.maxConcurrentTasks,
      // Leave model, custom_env and custom_args absent: CLI native configuration owns them.
    }));
    string(row.id, "agent.id");
    if (row.runtime_id !== input.runtimeId) throw new MulticaProtocolError("Created agent runtime mismatch");
    if (integer(row.max_concurrent_tasks, "max_concurrent_tasks", 2) !== input.maxConcurrentTasks) {
      throw new MulticaProtocolError("Created agent concurrency mismatch");
    }
    return row as unknown as OfficialAgent;
  }

  async listAgents(): Promise<OfficialAgent[]> {
    return rows(await this.request("GET", "/api/agents")).map(value => {
      const row = object(value);
      for (const field of ["id", "name", "runtime_id"]) string(row[field], field);
      if (row.workspace_id !== this.config.workspaceId) throw new MulticaProtocolError("Agent workspace mismatch");
      integer(row.max_concurrent_tasks, "max_concurrent_tasks", 1);
      return row as unknown as OfficialAgent;
    });
  }

  /**
   * Switch the runtime bound to a logical Multica Agent.
   *
   * Multica keeps chat_session.agent_id stable; the official Agent update
   * endpoint is the runtime binding operation used by the server itself. The
   * Chat Session therefore remains the durable conversation carrier while the
   * next task is stamped with the newly bound runtime. No DSH prompt or CLI
   * session id is manufactured here.
   */
  async switchAgentRuntime(input: { agentId: string; runtimeId: string }): Promise<OfficialAgent> {
    const agentId = string(input.agentId, "agentId");
    const runtimeId = string(input.runtimeId, "runtimeId");
    const row = object(await this.request("PUT", `/api/agents/${id(agentId)}`, { runtime_id: runtimeId }));
    string(row.id, "agent.id");
    string(row.runtime_id, "agent.runtime_id");
    if (row.id !== agentId || row.runtime_id !== runtimeId) {
      throw new MulticaProtocolError("Switched agent runtime mismatch");
    }
    integer(row.max_concurrent_tasks, "max_concurrent_tasks", 1);
    return row as unknown as OfficialAgent;
  }

  /** Workspace-managed Skills are the official Multica capability registry. */
  async listSkills(): Promise<OfficialSkillSummary[]> {
    return rows(await this.request("GET", "/api/skills")).map(value => skillSummary(value, this.config.workspaceId));
  }

  async getSkill(skillId: string): Promise<OfficialSkill> {
    return skill(await this.request("GET", `/api/skills/${id(skillId)}`), this.config.workspaceId);
  }

  async createSkill(input: {
    name: string;
    description: string;
    content: string;
    config?: unknown;
    files?: Array<{ path: string; content: string }>;
  }): Promise<OfficialSkill> {
    const row = await this.request("POST", "/api/skills", {
      name: string(input.name, "skill.name"),
      description: input.description ?? "",
      content: string(input.content, "skill.content"),
      config: input.config ?? {},
      files: input.files ?? [],
    });
    return skill(row, this.config.workspaceId);
  }

  async updateSkill(skillId: string, input: {
    name?: string;
    description?: string;
    content?: string;
    config?: unknown;
    files?: Array<{ path: string; content: string }>;
  }): Promise<OfficialSkill> {
    const row = await this.request("PUT", `/api/skills/${id(skillId)}`, input);
    return skill(row, this.config.workspaceId);
  }

  async deleteSkill(skillId: string): Promise<void> {
    await this.request("DELETE", `/api/skills/${id(skillId)}`);
  }

  async listAgentSkills(agentId: string): Promise<OfficialSkillSummary[]> {
    return rows(await this.request("GET", `/api/agents/${id(agentId)}/skills`))
      .map(value => skillSummary(value, this.config.workspaceId));
  }

  /** Replaces the official Agent assignment, preserving the caller's existing skills. */
  async setAgentSkills(agentId: string, skillIds: string[]): Promise<OfficialSkillSummary[]> {
    const clean = [...new Set(skillIds.map(value => string(value, "skillId")))];
    return rows(await this.request("PUT", `/api/agents/${id(agentId)}/skills`, { skill_ids: clean }))
      .map(value => skillSummary(value, this.config.workspaceId));
  }

  async addAgentSkills(agentId: string, skillIds: string[]): Promise<OfficialSkillSummary[]> {
    const clean = [...new Set(skillIds.map(value => string(value, "skillId")))];
    return rows(await this.request("POST", `/api/agents/${id(agentId)}/skills/add`, { skill_ids: clean }))
      .map(value => skillSummary(value, this.config.workspaceId));
  }

  async setAgentSkillEnabled(agentId: string, skillId: string, enabled: boolean): Promise<void> {
    if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean");
    await this.request("PUT", `/api/agents/${id(agentId)}/skills/${id(skillId)}/enabled`, { enabled });
  }

  async removeAgentSkill(agentId: string, skillId: string): Promise<void> {
    await this.request("DELETE", `/api/agents/${id(agentId)}/skills/${id(skillId)}`);
  }

  async ensureAgentSkills(agentId: string, skillIds: string[]): Promise<OfficialSkillSummary[]> {
    const current = await this.listAgentSkills(agentId);
    const missing = [...new Set(skillIds)].filter(idValue => !current.some(item => item.id === idValue));
    if (missing.length === 0) return current;
    // The incremental endpoint preserves an existing disabled assignment.
    // A full replacement would recreate every row with enabled=true.
    await this.addAgentSkills(agentId, missing);
    return this.listAgentSkills(agentId);
  }

  async listProjects(): Promise<OfficialProject[]> {
    const response = object(await this.request("GET", "/api/projects"));
    return rows(response.projects).map(value => {
      const row = object(value);
      string(row.id, "project.id");
      string(row.title, "project.title");
      if (row.workspace_id !== this.config.workspaceId) throw new MulticaProtocolError("Project workspace mismatch");
      return row as unknown as OfficialProject;
    });
  }

  async listProjectResources(projectId: string): Promise<OfficialProjectResource[]> {
    const response = object(await this.request("GET", `/api/projects/${id(projectId)}/resources`));
    return rows(response.resources).map(value => {
      const row = object(value);
      string(row.id, "resource.id");
      string(row.resource_type, "resource_type");
      object(row.resource_ref);
      return row as unknown as OfficialProjectResource;
    });
  }

  async listChatSessions(): Promise<OfficialChatSession[]> {
    return rows(await this.request("GET", "/api/chat/sessions?status=all")).map(value => {
      const row = object(value);
      string(row.id, "chat.id");
      string(row.agent_id, "chat.agent_id");
      if (row.workspace_id !== this.config.workspaceId) throw new MulticaProtocolError("Chat workspace mismatch");
      return row as unknown as OfficialChatSession;
    });
  }

  /** Bind one DSH conversation's durable directory; provision it via Daytona first. */
  async createDirectoryProject(input: { title: string; daemonId: string; localPath: string }): Promise<{ id: string }> {
    if ((!input.localPath.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(input.localPath)) || input.localPath.includes("\0")) {
      throw new Error("Expected an absolute runtime directory");
    }
    const row = object(await this.request("POST", "/api/projects", {
      title: string(input.title, "title"),
      resources: [{ resource_type: "local_directory", resource_ref: {
        local_path: input.localPath, daemon_id: string(input.daemonId, "daemonId"), execution_mode: "in_place",
      } }],
    }));
    return { id: string(row.id, "project.id") };
  }

  /** Add a local-directory resource for another registered Daemon to the same
   * logical Project. Multica resolves the resource by daemon_id at dispatch. */
  async createProjectResource(input: { projectId: string; daemonId: string; localPath: string }): Promise<OfficialProjectResource> {
    if ((!input.localPath.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(input.localPath)) || input.localPath.includes("\0")) {
      throw new Error("Expected an absolute runtime directory");
    }
    const row = object(await this.request("POST", `/api/projects/${id(input.projectId)}/resources`, {
      resource_type: "local_directory",
      resource_ref: { local_path: input.localPath, daemon_id: string(input.daemonId, "daemonId"), execution_mode: "in_place" },
    }));
    string(row.id, "resource.id"); string(row.resource_type, "resource_type"); object(row.resource_ref);
    return row as unknown as OfficialProjectResource;
  }

  async createChatSession(input: { agentId: string; projectId: string; title: string }): Promise<OfficialChatSession> {
    const row = object(await this.request("POST", "/api/chat/sessions", {
      agent_id: string(input.agentId, "agentId"), project_id: string(input.projectId, "projectId"), title: input.title,
    }));
    string(row.id, "chat.id");
    if (row.agent_id !== input.agentId || row.project_id !== input.projectId || row.workspace_id !== this.config.workspaceId) {
      throw new MulticaProtocolError("Created chat binding mismatch");
    }
    return row as unknown as OfficialChatSession;
  }

  async submitPrepared(intent: SubmissionIntent): Promise<SubmissionResult> {
    try {
      const row = object(await this.request("POST", `/api/chat/sessions/${id(intent.chatSessionId)}/messages`, { content: intent.content }));
      return {
        status: "accepted", taskId: string(row.task_id, "task_id"), messageId: string(row.message_id, "message_id"),
        ...(typeof row.queued === "boolean" ? { queued: row.queued } : {}),
      };
    } catch (error) {
      if (error instanceof MulticaApiError) {
        // 408 is ambiguous; other 4xx responses reject before mutation in the pinned handler.
        if (error.status < 500 && error.status !== 408) throw error;
        return { status: "unknown", reason: "server-error" };
      }
      return { status: "unknown", reason: error instanceof MulticaProtocolError ? "invalid-response" : "transport" };
    }
  }

  async reconcileSubmission(intent: SubmissionIntent): Promise<SubmissionResult> {
    const messages = rows(await this.request("GET", `/api/chat/sessions/${id(intent.chatSessionId)}/messages`));
    const matches = messages.map(object).filter(row =>
      row.chat_session_id === intent.chatSessionId && row.role === "user" && row.content === intent.content);
    if (matches.length === 0) return { status: "unknown", reason: "not-observed" };
    if (matches.length !== 1) return { status: "unknown", reason: "multiple-matches" };
    const match = matches[0]!;
    return { status: "accepted", taskId: string(match.task_id, "task_id"), messageId: string(match.id, "message.id") };
  }

  async getTask(binding: TaskBinding): Promise<OfficialTask> {
    const list = rows(await this.request("GET", `/api/agents/${id(binding.agentId)}/tasks?include_usage=true`)).map(task);
    const match = list.find(row => row.id === binding.taskId);
    if (!match) throw new Error("Task missing from official agent history; reconciliation required");
    if (match.agent_id !== binding.agentId || match.chat_session_id !== binding.chatSessionId || match.runtime_id !== binding.runtimeId) {
      throw new MulticaProtocolError("Task binding mismatch");
    }
    return match;
  }

  async readTaskMessages(taskId: string, since = 0): Promise<TranscriptBatch> {
    integer(since, "since");
    const messages = rows(await this.request("GET", `/api/tasks/${id(taskId)}/messages?since=${since}`)).map(value => {
      const row = object(value);
      if (row.task_id !== taskId) throw new MulticaProtocolError("Transcript task mismatch");
      integer(row.seq, "seq", 1);
      string(row.type, "type");
      return row as unknown as OfficialTaskMessage;
    }).sort((a, b) => a.seq - b.seq);
    const unique = new Map<number, OfficialTaskMessage>();
    for (const message of messages) {
      if (message.seq <= since) continue;
      const previous = unique.get(message.seq);
      if (previous && JSON.stringify(previous) !== JSON.stringify(message)) throw new MulticaProtocolError("Conflicting transcript sequence");
      unique.set(message.seq, message);
    }
    let sequence = since;
    const gaps: TranscriptBatch["gaps"] = [];
    for (const message of unique.values()) {
      if (message.seq !== sequence + 1) gaps.push({ after: sequence, before: message.seq });
      sequence = message.seq;
    }
    return {
      messages: [...unique.values()].map(raw => ({ eventId: `multica:${taskId}:message:${raw.seq}`, raw })),
      nextSequence: gaps.length ? since : sequence,
      gaps,
    };
  }

  /** Cancellation acknowledgement is a server state, not proof that the CLI process exited. */
  async cancelTask(binding: TaskBinding): Promise<{ task: OfficialTask; executionStopped: "unverified" }> {
    await this.getTask(binding);
    const row = task(await this.request("POST", `/api/tasks/${id(binding.taskId)}/cancel`));
    if (row.id !== binding.taskId || row.agent_id !== binding.agentId || row.chat_session_id !== binding.chatSessionId || row.runtime_id !== binding.runtimeId) {
      throw new MulticaProtocolError("Cancelled task binding mismatch");
    }
    return { task: row, executionStopped: "unverified" };
  }
}

/** Stable correlation in the official message content, since upstream has no idempotency field. */
export function prepareSubmission(input: { requestId: string; chatSessionId: string; content: string }): SubmissionIntent {
  string(input.requestId, "requestId");
  string(input.chatSessionId, "chatSessionId");
  string(input.content, "content");
  const digest = createHash("sha256").update(JSON.stringify([input.chatSessionId, input.requestId])).digest("hex");
  const marker = `<!-- dsh-request:${digest} -->`;
  return { requestId: input.requestId, chatSessionId: input.chatSessionId, marker, content: `${input.content}\n\n${marker}` };
}
