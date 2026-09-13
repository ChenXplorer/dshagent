import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import { MulticaAgent } from "./agent.ts";
import {
  apply,
  InMemoryAgentsRegistry,
  LOOP_ROW_ID,
  MiniCordis,
  name as PLUGIN_NAME,
  PLUGIN_PATCH,
} from "./apply.ts";
import {
  NATIVE_DSH_PROFILE,
  PLATFORM_DSH_PROFILE,
  snapshotCapabilities,
} from "./capabilities.ts";
import { RecursionGuardError, SwitchBlockedError } from "./errors.ts";
import { composeTaskPrompt, isNativeAssistantEvent, translateMulticaEvent } from "./events.ts";
import { MulticaRuntimeFactory } from "./factory.ts";
import { fetchAgainstHandler, HttpMulticaClient } from "./http-client.ts";
import { BindingStore } from "./mapping.ts";
import { submitWithReconcile } from "./reconcile.ts";
import { SimulatedMultica } from "../sim/backend.ts";
import { dialectFor, systemPromptFor } from "../sim/deepseek.ts";
import { mapWorkspaceCwd, parseClaudeJsonl, parseCodexJsonl } from "../sim/cli-runner.ts";
import { handleMulticaHttp } from "../sim/http.ts";
import type { AgentFactory, MulticaClient, TraceEntry } from "./types.ts";

const catalog = {
  skills: [{ id: "sk_jira", name: "jira", version: "1.4.0" }],
  mcp: [{ id: "mcp_jira", name: "jira", transport: "http" as const }],
};

function setup(client: MulticaClient = new SimulatedMultica({ delayMs: 0 })) {
  const traces: TraceEntry[] = [];
  const bindings = new BindingStore();
  const factory = new MulticaRuntimeFactory(bindings, client, catalog, {
    onTrace: (entry) => traces.push(entry),
    onSessionEvent: () => {},
    onStatus: () => {},
  });
  const sim = client instanceof SimulatedMultica ? client : undefined;
  return { sim, client, traces, bindings, factory };
}

async function spawn(
  factory: MulticaRuntimeFactory,
  id: string,
  runtime: "codex" | "claude-code" | "pi" | "dsh" = "codex",
) {
  const handle = await factory.createAgent({ sessionId: id });
  const agent = handle.agent as MulticaAgent;
  await agent.select({
    runtime,
    environment: "personal-persistent",
    cwd: "/work/auth-service",
    machineId: "cube-personal",
    nativeProfile: runtime === "dsh" ? NATIVE_DSH_PROFILE : undefined,
  });
  return { handle, agent };
}

afterEach(() => {
  // nothing shared
});

test("runtime is per session, never a global factory field", async () => {
  const { factory, bindings } = setup();
  const a = await spawn(factory, "sess-a", "codex");
  const b = await spawn(factory, "sess-b", "claude-code");
  assert.equal(bindings.current("sess-a").runtime, "codex");
  assert.equal(bindings.current("sess-b").runtime, "claude-code");
  assert.equal(a.agent.status, "idle");
  assert.notEqual(bindings.current("sess-a").id, bindings.current("sess-b").id);
});

test("DSH runtime targeting the platform profile is rejected (recursion guard)", async () => {
  const { factory } = setup();
  const handle = await factory.createAgent({ sessionId: "sess-dsh" });
  const agent = handle.agent as MulticaAgent;
  await assert.rejects(
    () =>
      agent.select({
        runtime: "dsh",
        environment: "personal-persistent",
        cwd: "/work/auth-service",
        machineId: "cube-personal",
        nativeProfile: PLATFORM_DSH_PROFILE,
      }),
    RecursionGuardError,
  );
});

test("DSH runtime on the native profile is allowed", async () => {
  const { factory, bindings } = setup();
  const { agent } = await spawn(factory, "sess-native", "dsh");
  agent.followup({ id: "m1", text: "用原生 loop 跑一次" });
  await agent.whenIdle();
  assert.equal(bindings.current("sess-native").runtime, "dsh");
  const text = agent.session.events
    .filter((event) => event.type === "assistant/message")
    .map((event) => String(event.data.text));
  assert.match(text.join("\n"), /dsh-native/);
});

test("Pi drops MCP; Codex keeps MCP", () => {
  const pi = snapshotCapabilities("pi", catalog.skills, catalog.mcp);
  const codex = snapshotCapabilities("codex", catalog.skills, catalog.mcp);
  assert.equal(pi.mcpSupported, false);
  assert.equal(pi.mcp.length, 0);
  assert.equal(codex.mcpSupported, true);
  assert.equal(codex.mcp.length, 1);
});

test("Pi run records mcp/skipped and does not pretend MCP was applied", async () => {
  const { factory } = setup();
  const { agent } = await spawn(factory, "sess-pi", "pi");
  agent.followup({ id: "m1", text: "查 Jira" });
  await agent.whenIdle();
  const phases = agent.session.events
    .filter((event) => event.type === "multica/capability")
    .map((event) => event.data.phase);
  assert.ok(phases.includes("mcp/skipped"));
  assert.ok(!phases.includes("mcp/applied"));
});

test("committed text becomes assistant/message; vendor frames stay on multica/raw", () => {
  const committed = translateMulticaEvent(
    {
      id: "e1",
      taskId: "t1",
      type: "text/committed",
      time: 1,
      data: { text: "hello" },
    },
    { runtime: "codex", turn: 1, step: 1 },
  );
  assert.equal(committed[0]?.type, "assistant/message");
  assert.equal(committed[0]?.data.text, "hello");

  const unknown = translateMulticaEvent(
    {
      id: "e2",
      taskId: "t1",
      type: "cli/unknown",
      time: 1,
      data: { frame: "tool_progress" },
    },
    { runtime: "codex", turn: 1, step: 1 },
  );
  assert.equal(unknown[0]?.type, "multica/raw");
  assert.equal(isNativeAssistantEvent(unknown[0]!.type), false);
});

test("unknown CLI events never forge a native assistant stream", async () => {
  const { factory } = setup();
  const { agent } = await spawn(factory, "sess-raw", "codex");
  agent.followup({ id: "m1", text: "改 factory" });
  await agent.whenIdle();
  const raw = agent.session.events.filter((event) => event.type === "multica/raw");
  assert.ok(raw.length >= 1);
  for (const event of raw) {
    assert.notEqual(event.type, "assistant/message");
  }
  const native = agent.session.events.filter(
    (event) => event.type === "assistant/message",
  );
  assert.ok(native.every((event) => typeof event.data.text === "string"));
});

test("switching runtime keeps the DSH session and opens a new segment", async () => {
  const { factory, bindings } = setup();
  const { agent } = await spawn(factory, "sess-switch", "codex");
  agent.followup({ id: "m1", text: "查 Jira 里我的票" });
  await agent.whenIdle();
  await agent.select({
    runtime: "claude-code",
    environment: "personal-persistent",
    cwd: "/work/auth-service",
    machineId: "cube-personal",
  });
  const binding = bindings.require("sess-switch");
  assert.equal(binding.segments.length, 2);
  assert.equal(binding.segments[0]?.runtime, "codex");
  assert.equal(binding.segments[1]?.runtime, "claude-code");
  assert.ok(binding.segments[0]?.closedAt);
  const handoff = agent.session.events.filter(
    (event) => event.type === "multica/handoff",
  );
  assert.equal(handoff.length, 1);
  assert.equal(handoff[0]?.data.from, "codex");
  assert.equal(handoff[0]?.data.to, "claude-code");
});

test("cannot switch runtime while a task is running", async () => {
  const sim = new SimulatedMultica({ delayMs: 30 });
  const { factory } = setup(sim);
  const { agent } = await spawn(factory, "sess-block", "codex");
  agent.followup({ id: "m1", text: "长时间任务" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(agent.status, "running");
  await assert.rejects(
    () =>
      agent.select({
        runtime: "pi",
        environment: "personal-persistent",
        cwd: "/work/auth-service",
        machineId: "cube-personal",
      }),
    SwitchBlockedError,
  );
  agent.cancel("user");
  await agent.whenIdle();
});

test("cross-machine switch emits sync-required instead of pretending files moved", async () => {
  const { factory } = setup();
  const { agent } = await spawn(factory, "sess-sync", "codex");
  await agent.select({
    runtime: "codex",
    environment: "local-machine",
    cwd: "/Users/chen/auth-service",
    machineId: "laptop-chen",
  });
  const sync = agent.session.events.filter(
    (event) => event.type === "multica/sync-required",
  );
  assert.equal(sync.length, 1);
  assert.equal(sync[0]?.data.fromMachine, "cube-personal");
  assert.equal(sync[0]?.data.toMachine, "laptop-chen");
});

test("unknown submit is reconciled via clientRequestId", async () => {
  const sim = new SimulatedMultica({ delayMs: 0, dropFirstAck: true });
  const { factory, bindings } = setup(sim);
  const { agent } = await spawn(factory, "sess-unk", "codex");
  agent.followup({ id: "m1", text: "对账" });
  await agent.whenIdle();
  const segment = bindings.current("sess-unk");
  assert.ok(segment.currentTaskId === undefined);
  assert.equal(segment.status, "idle");
  const assistant = agent.session.events.filter(
    (event) => event.type === "assistant/message",
  );
  assert.ok(assistant.length >= 1);
});

test("submitWithReconcile polls until the task appears", async () => {
  const sim = new SimulatedMultica({ delayMs: 0, dropFirstAck: true });
  const agent = await sim.ensureAgent({
    runtime: "codex",
    machineId: "cube-personal",
  });
  const session = await sim.ensureSession({
    agentId: agent.id,
    dshSessionId: "s",
    segmentId: "seg",
  });
  const accepted = await submitWithReconcile(
    sim,
    {
      clientRequestId: "req_test",
      agentId: agent.id,
      sessionId: session.id,
      prompt: "hi",
      cwd: "/tmp",
      runtime: "codex",
      machineId: "cube-personal",
      skills: [],
      mcp: [],
    },
    { waitMs: 1, retries: 5 },
  );
  assert.equal(accepted.status, "accepted");
  assert.ok(accepted.taskId.startsWith("task_"));
});

test("composeTaskPrompt packs the previous turns for the next CLI", () => {
  const packed = composeTaskPrompt("继续改 token", {
    from: "codex",
    to: "claude-code",
    fromEnv: "personal-persistent",
    toEnv: "personal-persistent",
    summary: "查一下 Jira\n---\nAUTH-214 还在做",
  });
  assert.match(packed, /^HANDOFF/);
  assert.match(packed, /from: codex/);
  assert.match(packed, /to: claude-code/);
  assert.match(packed, /AUTH-214/);
  assert.match(packed, /继续改 token$/);
  assert.equal(composeTaskPrompt("hello"), "hello");
});

test("switching runtime feeds the handoff summary into the next task prompt", async () => {
  const { factory, sim } = setup();
  assert.ok(sim);
  const { agent } = await spawn(factory, "sess-pack", "codex");
  agent.followup({ id: "m1", text: "查一下 Jira 里我名下还没做完的票" });
  await agent.whenIdle();
  await agent.select({
    runtime: "claude-code",
    environment: "personal-persistent",
    cwd: "/work/auth-service",
    machineId: "cube-personal",
  });
  agent.followup({ id: "m2", text: "继续改 token 刷新" });
  await agent.whenIdle();
  assert.ok(sim.lastSubmit);
  assert.equal(sim.lastSubmit?.handoff?.from, "codex");
  assert.equal(sim.lastSubmit?.handoff?.to, "claude-code");
  assert.match(sim.lastSubmit?.prompt ?? "", /HANDOFF/);
  assert.match(sim.lastSubmit?.prompt ?? "", /查一下 Jira/);
  const assistant = agent.session.events
    .filter((event) => event.type === "assistant/message")
    .map((event) => String(event.data.text))
    .join("\n");
  assert.match(assistant, /已接收 handoff（codex → claude-code）/);
});

test("apply() mounts the factory over the stock loop and uninstall restores it", async () => {
  const previous: AgentFactory = {
    createAgent: async () => {
      throw new Error("stock loop");
    },
    resumeAgent: async () => {
      throw new Error("stock loop");
    },
  };
  const registry = new InMemoryAgentsRegistry();
  registry.setFactory(previous);
  const ctx = new MiniCordis(registry);
  const sim = new SimulatedMultica({ delayMs: 0 });
  const factory = apply(ctx, { client: sim, catalog });
  assert.equal(ctx.agents.factory, factory);
  assert.equal(PLUGIN_NAME, "dsh-multica-runtime");
  const { agent } = await spawn(factory, "sess-mount", "codex");
  agent.followup({ id: "m1", text: "ping" });
  await agent.whenIdle();
  ctx.dispose();
  assert.equal(ctx.agents.factory, previous);
});

test("bundle patch disables agent-loop and inserts this plugin", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const yaml = readFileSync(
    join(here, "../../dsh-multica-runtime/cordis.patch.yml"),
    "utf8",
  );
  assert.match(yaml, new RegExp(`id: ${LOOP_ROW_ID}`));
  assert.match(yaml, /disabled: true/);
  assert.match(yaml, /name: dsh-multica-runtime/);
  assert.match(PLUGIN_PATCH, /disabled: true/);
});

test("HttpMulticaClient drives a turn over HTTP + SSE", async () => {
  const gateway = new SimulatedMultica({ delayMs: 0 });
  const client = new HttpMulticaClient({
    baseUrl: "http://multica.test/api/multica",
    fetch: fetchAgainstHandler((request) => handleMulticaHttp(gateway, request)),
  });
  const { factory } = setup(client);
  const { agent } = await spawn(factory, "sess-http", "codex");
  agent.followup({ id: "m1", text: "查一下 Jira 里我的票" });
  await agent.whenIdle();
  const assistant = agent.session.events.filter(
    (event) => event.type === "assistant/message",
  );
  assert.ok(assistant.length >= 1);
  assert.equal(client.transport, "http");
  assert.equal(client.lastCall()?.method, "GET");
  assert.match(client.lastCall()?.path ?? "", /\/events$/);
});

test("HTTP submit unknown is reconciled via clientRequestId", async () => {
  const gateway = new SimulatedMultica({ delayMs: 0 });
  const client = new HttpMulticaClient({
    baseUrl: "http://multica.test/api/multica",
    fetch: fetchAgainstHandler((request) => handleMulticaHttp(gateway, request)),
  });
  await client.dropNextAck();
  const { factory, bindings } = setup(client);
  const { agent } = await spawn(factory, "sess-http-unk", "codex");
  agent.followup({ id: "m1", text: "对账" });
  await agent.whenIdle();
  assert.equal(bindings.current("sess-http-unk").status, "idle");
  const assistant = agent.session.events.filter(
    (event) => event.type === "assistant/message",
  );
  assert.ok(assistant.length >= 1);
});

test("Codex uses OpenAI dialect, Claude uses Anthropic dialect", () => {
  assert.equal(dialectFor("codex"), "openai");
  assert.equal(dialectFor("dsh"), "openai");
  assert.equal(dialectFor("pi"), "openai");
  assert.equal(dialectFor("claude-code"), "anthropic");
  const prompt = systemPromptFor({
    clientRequestId: "req",
    agentId: "a",
    prompt: "hi",
    cwd: "/work/auth-service",
    runtime: "codex",
    machineId: "cube-personal",
    skills: [{ id: "sk_jira", name: "jira", version: "1" }],
    mcp: [{ id: "mcp_jira", name: "jira", transport: "http" }],
  });
  assert.match(prompt, /Codex CLI/);
  assert.match(prompt, /cwd=\/work\/auth-service/);
  assert.doesNotMatch(prompt, /sk-/);
});

test("workspace cwd maps into the real CLI worktree", () => {
  assert.equal(mapWorkspaceCwd("/work/auth-service"), "/workspace/work/auth-service");
});

test("Codex JSONL agent_message becomes committed text", () => {
  const acc = { text: "" };
  const deltas: string[] = [];
  parseCodexJsonl(
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "CODEX_OK" },
    }),
    acc,
    { onDelta: (text) => deltas.push(text) },
  );
  parseCodexJsonl(
    JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 10, output_tokens: 2 },
    }),
    acc,
    { onDelta: () => undefined },
  );
  assert.equal(acc.text, "CODEX_OK");
  assert.deepEqual(deltas, ["CODEX_OK"]);
  assert.equal(acc.inputTokens, 10);
});

test("Claude stream-json result becomes committed text", () => {
  const acc = { text: "" };
  parseClaudeJsonl(
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "partial" }] },
    }),
    acc,
    { onDelta: () => undefined },
  );
  parseClaudeJsonl(
    JSON.stringify({
      type: "result",
      subtype: "success",
      result: "CLAUDE_OK\nREADME.md",
      usage: { input_tokens: 12, output_tokens: 4 },
    }),
    acc,
    { onDelta: () => undefined },
  );
  assert.equal(acc.text, "CLAUDE_OK\nREADME.md");
  assert.equal(acc.outputTokens, 4);
});

