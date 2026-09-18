/** Wire contracts verified against the pinned official Go handlers. */
export const MULTICA_SOURCE_COMMIT = "8908fcfbc43d18fc515dec747a100fecccc33556";
export type CliKind = "codex" | "claude-code";
export interface RuntimeTarget { daemonId: string; kind: CliKind; runtimeId?: string }
/** A concrete CLI runtime registered by one Multica Daemon. */
export interface RuntimeDescriptor {
  runtimeId: string;
  daemonId: string;
  kind: CliKind;
  provider: string;
  label: string;
  status: string;
  lastSeenAt: string | null;
  deviceName?: string;
  runtimeName?: string;
}
export interface OfficialRuntime {
  id: string;
  workspace_id: string;
  daemon_id: string | null;
  provider: string;
  status: string;
  last_seen_at: string | null;
  [key: string]: unknown;
}
export interface OfficialAgent {
  id: string;
  name: string;
  runtime_id: string;
  max_concurrent_tasks: number;
  skills?: OfficialSkillSummary[];
  [key: string]: unknown;
}
export interface OfficialSkillSummary {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  config?: unknown;
  created_by?: string | null;
  created_at?: string;
  updated_at?: string;
  enabled?: boolean;
  [key: string]: unknown;
}
export interface OfficialSkillFile {
  id?: string;
  skill_id?: string;
  path: string;
  content: string;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}
export interface OfficialSkill extends OfficialSkillSummary {
  content: string;
  files: OfficialSkillFile[];
}
export interface OfficialProject {
  id: string;
  title: string;
  workspace_id: string;
  [key: string]: unknown;
}
export interface OfficialProjectResource {
  id: string;
  resource_type: string;
  resource_ref: Record<string, unknown>;
  [key: string]: unknown;
}
export interface OfficialChatSession {
  id: string;
  agent_id: string;
  workspace_id: string;
  project_id?: string | null;
  [key: string]: unknown;
}
export interface TaskBinding {
  taskId: string;
  agentId: string;
  chatSessionId: string;
  runtimeId: string;
  /** Daemon identity is carried for settlement/audit; Multica endpoints ignore the extra field. */
  daemonId?: string;
}
export interface OfficialTask {
  id: string;
  agent_id: string;
  runtime_id: string;
  chat_session_id?: string;
  status: string;
  created_at?: string;
  started_at?: string | null;
  completed_at?: string | null;
  result?: unknown;
  error?: string | null;
  usage?: unknown[];
  [key: string]: unknown;
}
export interface OfficialTaskMessage {
  task_id: string;
  seq: number;
  type: string;
  content?: string;
  tool?: string;
  input?: Record<string, unknown>;
  output?: string;
  output_truncated?: boolean;
  created_at?: string;
  [key: string]: unknown;
}
export interface TranscriptBatch {
  messages: Array<{ eventId: string; raw: OfficialTaskMessage }>;
  /** Persist only after DSH has durably recorded every message in this batch. */
  nextSequence: number;
  /** A missing upstream batch is not repaired by pretending its events existed. */
  gaps: Array<{ after: number; before: number }>;
}
/** Persist before sending. One owner may send this intent at most once. */
export interface SubmissionIntent {
  requestId: string;
  chatSessionId: string;
  marker: string;
  content: string;
}
export type SubmissionResult =
  | { status: "accepted"; taskId: string; messageId: string; queued?: boolean }
  | { status: "unknown"; reason: "transport" | "server-error" | "invalid-response" | "not-observed" | "multiple-matches" };
