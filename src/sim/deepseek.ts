import type { RuntimeKind, SubmitTaskInput } from "../plugin/types.ts";

export const DEEPSEEK_MODEL = "deepseek-flash";
const OPENAI_URL = "https://api.deepseek.com/chat/completions";
const ANTHROPIC_URL = "https://api.deepseek.com/anthropic/v1/messages";
const MAX_TOKENS = 1024;

export type LiveDialect = "openai" | "anthropic";

export interface LiveStatus {
  live: boolean;
  provider: "deepseek";
  model: string;
  dialects: Record<RuntimeKind, LiveDialect>;
}

export interface StreamHandlers {
  signal?: AbortSignal;
  onDelta(text: string): void;
}

export interface StreamResult {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
  dialect: LiveDialect;
  model: string;
}

export function deepseekKey(): string {
  try {
    return String(process.env["DEEPSEEK_API_KEY"] ?? "").trim();
  } catch {
    return "";
  }
}

export function dialectFor(runtime: RuntimeKind): LiveDialect {
  return runtime === "claude-code" ? "anthropic" : "openai";
}

export function liveStatus(): LiveStatus {
  return {
    live: deepseekKey().length > 0,
    provider: "deepseek",
    model: DEEPSEEK_MODEL,
    dialects: {
      dsh: "openai",
      codex: "openai",
      "claude-code": "anthropic",
      pi: "openai",
    },
  };
}

export function systemPromptFor(input: SubmitTaskInput): string {
  const skills = input.skills.map((skill) => skill.name).join(", ") || "none";
  const mcp = input.mcp.map((server) => server.name).join(", ") || "none";
  const role =
    input.runtime === "codex"
      ? "You are Codex CLI (OpenAI-compatible) running inside a Multica task."
      : input.runtime === "claude-code"
        ? "You are Claude Code CLI, talking to DeepSeek over the Anthropic-compatible API."
        : input.runtime === "pi"
          ? "You are Pi CLI. You do not have Multica-managed MCP."
          : "You are DSH on a native profile that still has dsh-agent-loop. Do not recurse into the Multica plugin.";
  return [
    role,
    `cwd=${input.cwd}`,
    `skills injected: ${skills}`,
    `mcp: ${mcp}`,
    "Answer in the user's language. Be concrete. Do not invent tool results you did not run.",
    "If a HANDOFF block is present, continue that work; do not restart from zero.",
  ].join("\n");
}

export async function streamDeepseek(
  input: SubmitTaskInput,
  handlers: StreamHandlers,
): Promise<StreamResult> {
  const key = deepseekKey();
  if (!key) throw new Error("DEEPSEEK_API_KEY is not set");
  const dialect = dialectFor(input.runtime);
  if (dialect === "anthropic") {
    return streamAnthropic(input, key, handlers);
  }
  return streamOpenAI(input, key, handlers);
}

async function streamOpenAI(
  input: SubmitTaskInput,
  key: string,
  handlers: StreamHandlers,
): Promise<StreamResult> {
  const response = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      stream: true,
      max_tokens: MAX_TOKENS,
      thinking: { type: "disabled" },
      messages: [
        { role: "system", content: systemPromptFor(input) },
        { role: "user", content: input.prompt },
      ],
    }),
    signal: handlers.signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(await errorText("openai", response));
  }
  let text = "";
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  await readSse(response.body, handlers.signal, (data) => {
    if (data === "[DONE]") return;
    const parsed = JSON.parse(data) as {
      choices?: Array<{ delta?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const piece = parsed.choices?.[0]?.delta?.content;
    if (piece) {
      text += piece;
      handlers.onDelta(piece);
    }
    if (parsed.usage) {
      inputTokens = parsed.usage.prompt_tokens;
      outputTokens = parsed.usage.completion_tokens;
    }
  });
  return { text, inputTokens, outputTokens, dialect: "openai", model: DEEPSEEK_MODEL };
}

async function streamAnthropic(
  input: SubmitTaskInput,
  key: string,
  handlers: StreamHandlers,
): Promise<StreamResult> {
  const response = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      stream: true,
      max_tokens: MAX_TOKENS,
      thinking: { type: "disabled" },
      system: systemPromptFor(input),
      messages: [{ role: "user", content: input.prompt }],
    }),
    signal: handlers.signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(await errorText("anthropic", response));
  }
  let text = "";
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  await readSse(response.body, handlers.signal, (data) => {
    const parsed = JSON.parse(data) as {
      type?: string;
      delta?: { type?: string; text?: string };
      usage?: { input_tokens?: number; output_tokens?: number };
      message?: { usage?: { input_tokens?: number; output_tokens?: number } };
    };
    if (parsed.type === "content_block_delta" && parsed.delta?.text) {
      text += parsed.delta.text;
      handlers.onDelta(parsed.delta.text);
    }
    const usage = parsed.usage ?? parsed.message?.usage;
    if (usage) {
      inputTokens = usage.input_tokens ?? inputTokens;
      outputTokens = usage.output_tokens ?? outputTokens;
    }
  });
  return { text, inputTokens, outputTokens, dialect: "anthropic", model: DEEPSEEK_MODEL };
}

async function readSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
  onData: (data: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (!signal?.aborted) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep = buffer.indexOf("\n\n");
    while (sep >= 0) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(line.indexOf(":") + 1).trim())
        .join("\n");
      if (data) onData(data);
      sep = buffer.indexOf("\n\n");
    }
  }
}

async function errorText(dialect: string, response: Response): Promise<string> {
  const body = await response.text();
  return `DeepSeek ${dialect} ${response.status}: ${body.slice(0, 240)}`;
}
