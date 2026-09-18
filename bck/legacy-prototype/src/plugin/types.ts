/**
 * DSH ↔ Multica Runtime Plugin contract.
 *
 * Types on the DSH side mirror `@deepseek-ai/dsh-agent` public surfaces
 * (Agent, AgentFactory, Inbox, session events) closely enough that a Cordis
 * adapter can wrap this package without renaming fields. Types on the Multica
 * side are the subset this plugin actually drives: agent, session, task,
 * stream events. They are not a dump of Multica's full HTTP client.
 */

export type RuntimeKind = "dsh" | "codex" | "claude-code" | "pi";

export type EnvironmentKind =
  | "personal-ephemeral"
  | "personal-persistent"
  | "project-shared"
  | "local-machine";

export type AgentStatus = "idle" | "running";
export type InboxTarget = "next-turn" | "next-step";
export type SessionStartSource = "startup" | "resume" | "clear" | "compact";
export type AgentCancelCause = "user" | "disposed" | "replaced" | "error";

export type SegmentStatus =
  | "idle"
  | "running"
  | "canceling"
  | "unknown"
  | "failed";

export interface AgentOptions {
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  maxTokens?: number;
}

export interface UserMessage {
  id: string;
  text: string;
  source?: string;
}

export interface CancelOptions {
  keepInbox?: boolean;
}

export interface Inbox {
  readonly nextTurn: readonly UserMessage[];
  readonly nextStep: readonly UserMessage[];
  clear(): void;
  append(target: InboxTarget, message: UserMessage): void;
  prepend(target: InboxTarget, message: UserMessage): void;
  replace(messageId: string, newMessage: UserMessage): boolean;
  remove(messageId: string): boolean;
  splice(
    target: InboxTarget,
    start: number,
    deleteCount: number,
    inserted: UserMessage[],
  ): UserMessage[];
}

export type DshEventType =
  | "turn/start"
  | "turn/end"
  | "step/start"
  | "step/end"
  | "user/message"
  | "assistant/message"
  | "assistant/attempt"
  | "agent/inbox/spliced"
  | "multica/task"
  | "multica/stream"
  | "multica/tool"
  | "multica/raw"
  | "multica/handoff"
  | "multica/sync-required"
  | "multica/usage"
  | "multica/capability"
  | "multica/error";

export interface DshSessionEvent {
  seq: number;
  type: DshEventType;
  time: number;
  data: Record<string, unknown>;
}

export interface DshSessionHeader {
  cwd?: string;
}

export interface DshSession {
  readonly id: string;
  readonly header: DshSessionHeader;
  readonly events: readonly DshSessionEvent[];
  append(event: Omit<DshSessionEvent, "seq">): DshSessionEvent;
}

export interface Agent {
  readonly id: string;
  readonly options: AgentOptions;
  readonly session: DshSession;
  readonly inbox: Inbox;
  readonly status: AgentStatus;
  cancel(cause: AgentCancelCause, options?: CancelOptions): void;
  whenIdle(): Promise<void>;
  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void;
  followup(message: UserMessage): void;
  steer(message: UserMessage): void;
  inject(message: UserMessage): void;
}

export interface AgentHandle {
  agent: Agent;
  dispose(): Promise<void>;
}

export interface CreateAgentOptions {
  readonly sessionId: string;
  readonly parentAgent?: Agent;
  readonly meta?: { readonly cwd?: string };
  readonly agentOptions?: AgentOptions;
  readonly signal?: AbortSignal;
}

export interface ResumeAgentOptions {
  readonly resumeSessionId: string;
  readonly parentAgent?: Agent;
  readonly agentOptions?: AgentOptions;
  readonly signal?: AbortSignal;
}

export interface AgentFactory {
  createAgent(options: CreateAgentOptions): Promise<AgentHandle>;
  resumeAgent(options: ResumeAgentOptions): Promise<AgentHandle>;
}

export interface SessionSelection {
  runtime: RuntimeKind;
  environment: EnvironmentKind;
  cwd: string;
  /** Target DSH profile on the daemon. Required when runtime is `dsh`. */
  nativeProfile?: string;
  machineId: string;
}

export interface SkillRef {
  id: string;
  name: string;
  version: string;
}

export interface McpServerRef {
  id: string;
  name: string;
  transport: "stdio" | "http";
}

export interface CapabilitySnapshot {
  runtime: RuntimeKind;
  skills: SkillRef[];
  mcp: McpServerRef[];
  mcpSupported: boolean;
  skillPath: string;
  sessionResume: boolean;
  notes: string[];
}

export interface ExecutionSegment {
  id: string;
  runtime: RuntimeKind;
  environment: EnvironmentKind;
  cwd: string;
  machineId: string;
  nativeProfile?: string;
  multicaAgentId?: string;
  multicaSessionId?: string;
  currentTaskId?: string;
  clientRequestId?: string;
  status: SegmentStatus;
  openedAt: number;
  closedAt?: number;
}

export interface SessionBinding {
  dshSessionId: string;
  segments: ExecutionSegment[];
}

export interface MulticaAgentRef {
  id: string;
  runtime: RuntimeKind;
  machineId: string;
}

export interface MulticaSessionRef {
  id: string;
  agentId: string;
  cliSessionId?: string;
}

export interface HandoffPayload {
  from: RuntimeKind;
  to: RuntimeKind;
  fromEnv: EnvironmentKind;
  toEnv: EnvironmentKind;
  summary: string;
}

export interface SubmitTaskInput {
  clientRequestId: string;
  agentId: string;
  sessionId?: string;
  resumeCliSessionId?: string;
  prompt: string;
  cwd: string;
  runtime: RuntimeKind;
  machineId: string;
  nativeProfile?: string;
  skills: SkillRef[];
  mcp: McpServerRef[];
  handoff?: HandoffPayload;
}

export type SubmitTaskResult =
  | { status: "accepted"; taskId: string; sessionId: string }
  | { status: "unknown"; clientRequestId: string };

export type MulticaTaskEventType =
  | "task/accepted"
  | "task/started"
  | "task/heartbeat"
  | "cli/session"
  | "text/delta"
  | "text/committed"
  | "tool/call"
  | "tool/result"
  | "usage"
  | "cli/unknown"
  | "skill/injected"
  | "mcp/applied"
  | "mcp/skipped"
  | "task/completed"
  | "task/failed"
  | "task/canceled";

export interface MulticaTaskEvent {
  id: string;
  taskId: string;
  type: MulticaTaskEventType;
  time: number;
  data: Record<string, unknown>;
}

export interface MulticaTask {
  id: string;
  clientRequestId: string;
  status: "queued" | "running" | "completed" | "failed" | "canceled" | "unknown";
  sessionId?: string;
  cliSessionId?: string;
  events: MulticaTaskEvent[];
}

export type Unsubscribe = () => void;

export interface HttpCallTrace {
  at: number;
  method: string;
  path: string;
  status: number;
}

export interface MulticaClient {
  listRuntimes(): Promise<
    Array<{
      id: string;
      runtime: RuntimeKind;
      machineId: string;
      environment: EnvironmentKind;
      online: boolean;
      nativeProfile?: string;
    }>
  >;
  ensureAgent(input: {
    runtime: RuntimeKind;
    machineId: string;
    nativeProfile?: string;
  }): Promise<MulticaAgentRef>;
  ensureSession(input: {
    agentId: string;
    dshSessionId: string;
    segmentId: string;
    resumeCliSessionId?: string;
  }): Promise<MulticaSessionRef>;
  submitTask(input: SubmitTaskInput): Promise<SubmitTaskResult>;
  cancelTask(taskId: string): Promise<void>;
  getTask(taskId: string): Promise<MulticaTask | undefined>;
  getTaskByClientRequestId(
    clientRequestId: string,
  ): Promise<MulticaTask | undefined>;
  subscribe(
    taskId: string,
    handler: (event: MulticaTaskEvent) => void,
  ): Unsubscribe;
  dropNextAck?(): void | Promise<void>;
  lastCall?(): HttpCallTrace | undefined;
  health?(): Promise<{
    ok: boolean;
    live?: boolean;
    provider?: string;
    model?: string;
    dialects?: Record<string, string>;
    executors?: Record<string, string>;
    binaries?: { codex?: boolean; claude?: boolean };
    daemon?: {
      online?: boolean;
      count?: number;
      machines?: Array<{
        machineId: string;
        online: boolean;
        tools: string[];
        ageMs?: number;
      }>;
    };
    plane?: string;
  }>;
  transport?: "memory" | "http";
}

export interface PluginCatalog {
  skills: SkillRef[];
  mcp: McpServerRef[];
}

export interface TraceEntry {
  at: number;
  layer: "dsh" | "plugin" | "multica";
  kind: string;
  detail: string;
  payload?: Record<string, unknown>;
}
