import type {
  DshSessionEvent,
  HandoffPayload,
  MulticaTaskEvent,
  RuntimeKind,
} from "./types.ts";

export interface TranslateContext {
  runtime: RuntimeKind;
  turn: number;
  step: number;
  time?: number;
}

/**
 * Multica task events → DSH session events.
 *
 * Native DSH vocabulary is used only when the fact is actually known:
 * committed assistant text becomes `assistant/message`; turn/step boundaries
 * are platform-owned. Incomplete or CLI-specific payloads stay on
 * `multica/*` and are never forged into an LLM stream.
 */
export function translateMulticaEvent(
  event: MulticaTaskEvent,
  ctx: TranslateContext,
): Omit<DshSessionEvent, "seq">[] {
  const time = ctx.time ?? event.time;
  const base = { time };

  switch (event.type) {
    case "task/accepted":
      return [
        {
          ...base,
          type: "multica/task",
          data: {
            phase: "accepted",
            taskId: event.taskId,
            runtime: ctx.runtime,
            ...event.data,
          },
        },
      ];
    case "task/started":
      return [
        {
          ...base,
          type: "turn/start",
          data: { turn: ctx.turn, runtime: ctx.runtime, taskId: event.taskId },
        },
        {
          ...base,
          type: "step/start",
          data: { turn: ctx.turn, step: ctx.step, taskId: event.taskId },
        },
        {
          ...base,
          type: "multica/task",
          data: { phase: "started", taskId: event.taskId, runtime: ctx.runtime },
        },
      ];
    case "cli/session":
      return [
        {
          ...base,
          type: "multica/task",
          data: { phase: "cli-session", ...event.data, taskId: event.taskId },
        },
      ];
    case "text/delta":
      return [
        {
          ...base,
          type: "multica/stream",
          data: {
            kind: "text",
            text: event.data.text,
            taskId: event.taskId,
          },
        },
      ];
    case "text/committed":
      return [
        {
          ...base,
          type: "assistant/message",
          data: {
            text: String(event.data.text ?? ""),
            runtime: ctx.runtime,
            taskId: event.taskId,
          },
        },
      ];
    case "tool/call":
    case "tool/result":
      return [
        {
          ...base,
          type: "multica/tool",
          data: { phase: event.type, taskId: event.taskId, ...event.data },
        },
      ];
    case "usage":
      return [
        {
          ...base,
          type: "multica/usage",
          data: { taskId: event.taskId, ...event.data },
        },
      ];
    case "cli/unknown":
      return [
        {
          ...base,
          type: "multica/raw",
          data: { taskId: event.taskId, ...event.data },
        },
      ];
    case "skill/injected":
    case "mcp/applied":
    case "mcp/skipped":
      return [
        {
          ...base,
          type: "multica/capability",
          data: { phase: event.type, taskId: event.taskId, ...event.data },
        },
      ];
    case "task/completed":
      return [
        {
          ...base,
          type: "step/end",
          data: { turn: ctx.turn, step: ctx.step, taskId: event.taskId },
        },
        {
          ...base,
          type: "turn/end",
          data: { turn: ctx.turn, taskId: event.taskId },
        },
        {
          ...base,
          type: "multica/task",
          data: { phase: "completed", taskId: event.taskId, runtime: ctx.runtime },
        },
      ];
    case "task/failed":
      return [
        {
          ...base,
          type: "step/end",
          data: {
            turn: ctx.turn,
            step: ctx.step,
            taskId: event.taskId,
            error: true,
          },
        },
        {
          ...base,
          type: "turn/end",
          data: { turn: ctx.turn, taskId: event.taskId, error: true },
        },
        {
          ...base,
          type: "multica/error",
          data: { taskId: event.taskId, ...event.data },
        },
      ];
    case "task/canceled":
      return [
        {
          ...base,
          type: "turn/end",
          data: { turn: ctx.turn, taskId: event.taskId, canceled: true },
        },
        {
          ...base,
          type: "multica/task",
          data: { phase: "canceled", taskId: event.taskId },
        },
      ];
    case "task/heartbeat":
      return [];
    default:
      return [
        {
          ...base,
          type: "multica/raw",
          data: { taskId: event.taskId, type: event.type, ...event.data },
        },
      ];
  }
}

export function summarizeSession(
  events: readonly { type: string; data: Record<string, unknown> }[],
): string {
  const texts = events
    .filter((event) => event.type === "assistant/message" || event.type === "user/message")
    .map((event) => String(event.data.text ?? "").trim())
    .filter(Boolean);
  if (texts.length === 0) return "(empty session)";
  const tail = texts.slice(-4);
  return tail.join("\n---\n").slice(0, 1200);
}

export function isNativeAssistantEvent(type: string): boolean {
  return type === "assistant/message" || type === "assistant/attempt";
}

/**
 * Pack the previous CLI's last turns into the prompt the next runtime sees.
 * Without this, switching Codex → Claude keeps the DSH session but the new
 * CLI starts amnesiac.
 */
export function composeTaskPrompt(
  userText: string,
  handoff?: HandoffPayload,
): string {
  if (!handoff || handoff.summary === "(empty session)") return userText;
  return [
    "HANDOFF",
    `from: ${handoff.from}`,
    `to: ${handoff.to}`,
    "---",
    handoff.summary,
    "---",
    userText,
  ].join("\n");
}
