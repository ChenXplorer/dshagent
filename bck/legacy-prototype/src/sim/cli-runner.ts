import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeKind, SubmitTaskInput } from "../plugin/types.ts";
import { DEEPSEEK_MODEL, deepseekKey } from "./deepseek.ts";

export type CliName = "codex" | "claude";
export type ExecutorKind = "codex-cli" | "claude-cli" | "deepseek-http" | "scripted";

const ROOT = process.cwd();
const CODEX_HOME = join(ROOT, ".runtime/codex-home");
const CLAUDE_HOME = join(ROOT, ".runtime/claude-home");
const DEFAULT_WORK = join(ROOT, "work/auth-service");

export interface CliHandlers {
  signal?: AbortSignal;
  onDelta(text: string): void;
  onTool?(name: string, args: Record<string, unknown>): void;
  onToolResult?(name: string, preview: string): void;
}

export interface CliResult {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
  model: string;
  executor: ExecutorKind;
  binary: string;
}

export function resolveBin(name: CliName): string | undefined {
  const path = join(ROOT, "node_modules/.bin", name);
  return existsSync(path) ? path : undefined;
}

export function mapWorkspaceCwd(cwd: string): string {
  if (cwd.startsWith("/workspace/")) return cwd;
  if (cwd.startsWith("/work/")) return join(ROOT, cwd.slice(1));
  return DEFAULT_WORK;
}

export function executorFor(runtime: RuntimeKind): ExecutorKind {
  if (runtime === "codex" && resolveBin("codex")) return "codex-cli";
  if (runtime === "claude-code" && resolveBin("claude")) return "claude-cli";
  if (deepseekKey()) return "deepseek-http";
  return "scripted";
}

export function canSpawnCli(runtime: RuntimeKind): boolean {
  return executorFor(runtime) === "codex-cli" || executorFor(runtime) === "claude-cli";
}

export async function runCliTurn(
  input: SubmitTaskInput,
  handlers: CliHandlers,
): Promise<CliResult> {
  if (input.runtime === "codex") return runCodex(input, handlers);
  if (input.runtime === "claude-code") return runClaude(input, handlers);
  throw new Error(`${input.runtime} has no CLI binary in this workbench`);
}

export function parseCodexJsonl(
  line: string,
  acc: { text: string; inputTokens?: number; outputTokens?: number },
  handlers: CliHandlers,
): void {
  const event = JSON.parse(line) as {
    type?: string;
    item?: {
      type?: string;
      text?: string;
      command?: string;
      aggregated_output?: string;
      name?: string;
      arguments?: Record<string, unknown>;
    };
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item.text) {
    acc.text = event.item.text;
    handlers.onDelta(event.item.text);
  }
  if (event.type === "item.completed" && event.item?.type === "command_execution") {
    handlers.onTool?.("bash", { command: event.item.command ?? "" });
    if (event.item.aggregated_output) {
      handlers.onToolResult?.("bash", event.item.aggregated_output.slice(0, 400));
    }
  }
  if (event.type === "item.completed" && event.item?.type === "mcp_tool_call") {
    handlers.onTool?.(event.item.name ?? "mcp", event.item.arguments ?? {});
  }
  if (event.type === "turn.completed" && event.usage) {
    acc.inputTokens = event.usage.input_tokens;
    acc.outputTokens = event.usage.output_tokens;
  }
}

export function parseClaudeJsonl(
  line: string,
  acc: { text: string; inputTokens?: number; outputTokens?: number },
  handlers: CliHandlers,
): void {
  const event = JSON.parse(line) as {
    type?: string;
    subtype?: string;
    result?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
    message?: {
      content?: Array<{
        type?: string;
        text?: string;
        name?: string;
        input?: Record<string, unknown>;
        content?: string;
      }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
  };
  if (event.type === "assistant") {
    for (const block of event.message?.content ?? []) {
      if (block.type === "text" && block.text) {
        acc.text += block.text;
        handlers.onDelta(block.text);
      }
      if (block.type === "tool_use") {
        handlers.onTool?.(block.name ?? "tool", block.input ?? {});
      }
    }
    const usage = event.message?.usage;
    if (usage) {
      acc.inputTokens = (acc.inputTokens ?? 0) + (usage.input_tokens ?? 0);
      acc.outputTokens = (acc.outputTokens ?? 0) + (usage.output_tokens ?? 0);
    }
  }
  if (event.type === "user") {
    for (const block of event.message?.content ?? []) {
      if (block.type === "tool_result") {
        handlers.onToolResult?.("tool", String(block.content ?? "").slice(0, 400));
      }
    }
  }
  if (event.type === "result") {
    if (typeof event.result === "string" && event.result.trim()) acc.text = event.result;
    if (event.usage) {
      acc.inputTokens = event.usage.input_tokens;
      acc.outputTokens = event.usage.output_tokens;
    }
  }
}

async function runCodex(input: SubmitTaskInput, handlers: CliHandlers): Promise<CliResult> {
  const binary = resolveBin("codex");
  if (!binary) throw new Error("codex CLI is not installed");
  const cwd = mapWorkspaceCwd(input.cwd);
  const args = [
    "exec",
    "--json",
    "--ephemeral",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "-C",
    cwd,
    "-m",
    DEEPSEEK_MODEL,
    input.prompt,
  ];
  const acc = { text: "" };
  await spawnJsonl(binary, args, cwd, codexEnv(), handlers.signal, (line) => {
    parseCodexJsonl(line, acc, handlers);
  });
  return {
    text: acc.text,
    inputTokens: acc.inputTokens,
    outputTokens: acc.outputTokens,
    model: DEEPSEEK_MODEL,
    executor: "codex-cli",
    binary,
  };
}

async function runClaude(input: SubmitTaskInput, handlers: CliHandlers): Promise<CliResult> {
  const binary = resolveBin("claude");
  if (!binary) throw new Error("claude CLI is not installed");
  const cwd = mapWorkspaceCwd(input.cwd);
  const args = [
    "--bare",
    "-p",
    input.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "dontAsk",
    "--allowedTools",
    "Read,Bash",
    "--max-turns",
    "6",
    "--model",
    DEEPSEEK_MODEL,
  ];
  const acc = { text: "" };
  await spawnJsonl(binary, args, cwd, claudeEnv(), handlers.signal, (line) => {
    parseClaudeJsonl(line, acc, handlers);
  });
  return {
    text: acc.text,
    inputTokens: acc.inputTokens,
    outputTokens: acc.outputTokens,
    model: DEEPSEEK_MODEL,
    executor: "claude-cli",
    binary,
  };
}

function spawnJsonl(
  binary: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
  onLine: (line: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd,
      env,
      signal,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buffer = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line.startsWith("{")) {
          try {
            onLine(line);
          } catch {
            /* keep the rest of the stream even if one frame is junk */
          }
        }
        nl = buffer.indexOf("\n");
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const tail = buffer.trim();
      if (tail.startsWith("{")) {
        try {
          onLine(tail);
        } catch {
          /* ignore */
        }
      }
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${binary} exited ${code}: ${stderr.slice(-400) || "no stderr"}`));
    });
  });
}

function codexEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DEEPSEEK_API_KEY: deepseekKey(),
    CODEX_HOME,
    HOME: process.env.HOME ?? "/root",
  };
}

function claudeEnv(): NodeJS.ProcessEnv {
  const key = deepseekKey();
  return {
    ...process.env,
    DEEPSEEK_API_KEY: key,
    ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
    ANTHROPIC_AUTH_TOKEN: key,
    ANTHROPIC_API_KEY: key,
    ANTHROPIC_MODEL: DEEPSEEK_MODEL,
    ANTHROPIC_DEFAULT_OPUS_MODEL: DEEPSEEK_MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL: DEEPSEEK_MODEL,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: DEEPSEEK_MODEL,
    CLAUDE_CODE_SUBAGENT_MODEL: DEEPSEEK_MODEL,
    CLAUDE_CONFIG_DIR: CLAUDE_HOME,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    HOME: process.env.HOME ?? "/root",
  };
}
