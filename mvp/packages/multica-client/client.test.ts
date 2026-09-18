import { test } from "node:test";
import assert from "node:assert/strict";
import { OfficialMulticaClient, MulticaApiError, MulticaProtocolError, prepareSubmission } from "./index.ts";

/** HTTP fixtures are contract unit tests, never deployment/CLI execution evidence. */
function fixture(responses: Array<unknown | (() => Response | Promise<Response>)>) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const client = new OfficialMulticaClient({
    baseUrl: "http://127.0.0.1:18080", token: "unit-test-only", workspaceId: "workspace",
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: new URL(String(input)), init: init ?? {} });
      assert.ok(responses.length, "Unexpected extra HTTP request");
      const next = responses.shift();
      return typeof next === "function" ? next() : Response.json(next);
    }) as typeof fetch,
  });
  return { client, calls };
}
function runtime(id: string, daemonId: string, provider = "codex", lastSeen: string | null = new Date().toISOString()) {
  return { id, daemon_id: daemonId, workspace_id: "workspace", provider, status: "online", last_seen_at: lastSeen };
}
const binding = { taskId: "task", agentId: "agent", chatSessionId: "chat", runtimeId: "runtime" };
const task = { id: "task", agent_id: "agent", chat_session_id: "chat", runtime_id: "runtime", status: "running" };

test("selects the exact personal daemon/provider, never first matching CLI", async () => {
  const { client, calls } = fixture([[runtime("other", "another-user"), runtime("right", "personal"), runtime("claude", "personal", "claude")]]);
  assert.equal((await client.selectRuntime({ daemonId: "personal", kind: "codex" })).id, "right");
  assert.equal(new Headers(calls[0]!.init.headers).get("X-Workspace-ID"), "workspace");
});

test("requires one unambiguous runtime and a fresh heartbeat", async () => {
  for (const runtimes of [
    [runtime("a", "personal"), runtime("b", "personal")],
    [runtime("a", "personal", "codex", null)],
    [runtime("a", "personal", "codex", "2020-01-01T00:00:00Z")],
  ]) {
    const { client } = fixture([runtimes]);
    await assert.rejects(client.selectRuntime({ daemonId: "personal", kind: "codex" }));
  }
});

test("creates a concurrent agent without overriding CLI model/configuration", async () => {
  const { client, calls } = fixture([{ id: "agent", runtime_id: "runtime", max_concurrent_tasks: 4 }]);
  await client.createAgent({ name: "DSH Codex", runtimeId: "runtime", maxConcurrentTasks: 4 });
  const body = JSON.parse(calls[0]!.init.body as string);
  assert.equal(body.max_concurrent_tasks, 4);
  for (const name of ["model", "custom_env", "custom_args", "runtime_config"]) assert.equal(name in body, false);
  await assert.rejects(client.createAgent({ name: "bad", runtimeId: "runtime", maxConcurrentTasks: 1 }));
});

test("adds only missing Agent Skills so disabled assignments are preserved", async () => {
  const existing = { id: "existing", workspace_id: "workspace", name: "existing", description: "existing" };
  const added = { id: "new", workspace_id: "workspace", name: "new", description: "new" };
  const { client, calls } = fixture([[existing], [existing, added], [existing, added]]);
  const result = await client.ensureAgentSkills("agent", ["existing", "new"]);
  assert.deepEqual(result.map(skill => skill.id), ["existing", "new"]);
  assert.deepEqual(calls.map(call => `${call.init.method} ${call.url.pathname}`), [
    "GET /api/agents/agent/skills", "POST /api/agents/agent/skills/add", "GET /api/agents/agent/skills",
  ]);
  assert.deepEqual(JSON.parse(calls[1]!.init.body as string), { skill_ids: ["new"] });
});

test("switches a stable Multica Agent through the official runtime binding update", async () => {
  const { client, calls } = fixture([{ id: "agent", runtime_id: "claude-runtime", max_concurrent_tasks: 4 }]);
  const switched = await client.switchAgentRuntime({ agentId: "agent", runtimeId: "claude-runtime" });
  assert.equal(switched.runtime_id, "claude-runtime");
  assert.equal(calls[0]!.init.method, "PUT");
  assert.equal(calls[0]!.url.pathname, "/api/agents/agent");
  assert.deepEqual(JSON.parse(calls[0]!.init.body as string), { runtime_id: "claude-runtime" });
});

test("directory project binds the exact daemon and accepts an existing isolated worktree", async () => {
  const { client, calls } = fixture([{ id: "project" }]);
  await client.createDirectoryProject({ title: "conversation", daemonId: "personal", localPath: "/workspace/sessions/session-a" });
  assert.deepEqual(JSON.parse(calls[0]!.init.body as string).resources, [{ resource_type: "local_directory", resource_ref: {
    local_path: "/workspace/sessions/session-a", daemon_id: "personal", execution_mode: "in_place",
  } }]);
});

test("uncertain POST is never retried; fresh client reconciles the persisted intent", async () => {
  const intent = prepareSubmission({ requestId: "request-1", chatSessionId: "chat", content: "Run the tests" });
  const first = fixture([() => { throw new TypeError("network timeout"); }]);
  assert.deepEqual(await first.client.submitPrepared(intent), { status: "unknown", reason: "transport" });
  assert.equal(first.calls.length, 1);
  const restarted = fixture([[{ id: "message", chat_session_id: "chat", role: "user", content: intent.content, task_id: "task" }]]);
  assert.deepEqual(await restarted.client.reconcileSubmission(JSON.parse(JSON.stringify(intent))), { status: "accepted", taskId: "task", messageId: "message" });
  assert.equal(restarted.calls[0]!.init.method, "GET");
});

test("same text with different request IDs is distinguishable and unseen submissions stay unknown", async () => {
  const one = prepareSubmission({ requestId: "1", chatSessionId: "chat", content: "continue" });
  const two = prepareSubmission({ requestId: "2", chatSessionId: "chat", content: "continue" });
  assert.notEqual(one.content, two.content);
  const { client } = fixture([[{ id: "m", chat_session_id: "chat", role: "user", content: one.content, task_id: "t" }]]);
  assert.deepEqual(await client.reconcileSubmission(two), { status: "unknown", reason: "not-observed" });
});

test("authorization failures propagate without exposing upstream response bodies", async () => {
  const { client } = fixture([() => new Response("SECRET upstream body", { status: 403 })]);
  await assert.rejects(client.submitPrepared(prepareSubmission({ requestId: "1", chatSessionId: "chat", content: "test" })), error => {
    assert.ok(error instanceof MulticaApiError);
    assert.equal(error.status, 403);
    assert.equal(error.message.includes("SECRET"), false);
    return true;
  });
});

test("malformed acceptance remains unknown because the task may have committed", async () => {
  const { client } = fixture([{ task_id: "task" }]);
  assert.deepEqual(await client.submitPrepared(prepareSubmission({ requestId: "r", chatSessionId: "chat", content: "test" })), { status: "unknown", reason: "invalid-response" });
});

test("replays ordered durable messages and keeps unknown upstream event types", async () => {
  const { client, calls } = fixture([[{ task_id: "task", seq: 3, type: "future_event", custom: "preserved" }, { task_id: "task", seq: 2, type: "tool_result", output: "ok", output_truncated: true }]]);
  const batch = await client.readTaskMessages("task", 1);
  assert.equal(calls[0]!.url.search, "?since=1");
  assert.equal(batch.nextSequence, 3);
  assert.deepEqual(batch.gaps, []);
  assert.equal(batch.messages[0]!.eventId, "multica:task:message:2");
  assert.equal(batch.messages[1]!.raw.type, "future_event");
});

test("gaps do not advance the durable cursor past lost upstream messages", async () => {
  const { client } = fixture([[{ task_id: "task", seq: 1, type: "text" }, { task_id: "task", seq: 4, type: "text" }]]);
  const batch = await client.readTaskMessages("task");
  assert.deepEqual(batch.gaps, [{ after: 1, before: 4 }]);
  assert.equal(batch.nextSequence, 0);
});

test("foreign-task payloads and conflicting sequence IDs fail closed", async () => {
  for (const response of [
    [{ task_id: "another", seq: 1, type: "text" }],
    [{ task_id: "task", seq: 1, type: "text", content: "a" }, { task_id: "task", seq: 1, type: "text", content: "b" }],
  ]) {
    await assert.rejects(fixture([response]).client.readTaskMessages("task"), MulticaProtocolError);
  }
});

test("cancel targets only the bound task and does not claim process-exit proof", async () => {
  const { client, calls } = fixture([[task, { ...task, id: "other-task" }], { ...task, status: "cancelled" }]);
  const cancelled = await client.cancelTask(binding);
  assert.equal(cancelled.task.status, "cancelled");
  assert.equal(cancelled.executionStopped, "unverified");
  assert.equal(calls[1]!.url.pathname, "/api/tasks/task/cancel");
  assert.equal(calls.length, 2);
});

test("mismatched task binding blocks cancellation", async () => {
  const { client, calls } = fixture([[{ ...task, runtime_id: "other-runtime" }]]);
  await assert.rejects(client.cancelTask(binding), MulticaProtocolError);
  assert.equal(calls.length, 1);
});

test("lists official provisioning resources for crash reconciliation without creating anything", async () => {
  const { client, calls } = fixture([
    [{ id: "agent", name: "DSH Codex", runtime_id: "runtime", workspace_id: "workspace", max_concurrent_tasks: 2 }],
    { projects: [{ id: "project", title: "DSH conversation", workspace_id: "workspace" }], total: 1 },
    { resources: [{ id: "resource", resource_type: "local_directory", resource_ref: { daemon_id: "personal", local_path: "/workspace/chat" } }], total: 1 },
    [{ id: "chat", agent_id: "agent", workspace_id: "workspace", title: "segment", project_id: "project" }],
  ]);
  assert.equal((await client.listAgents())[0]!.name, "DSH Codex");
  assert.equal((await client.listProjects())[0]!.id, "project");
  assert.equal((await client.listProjectResources("project"))[0]!.resource_ref.daemon_id, "personal");
  assert.equal((await client.listChatSessions())[0]!.id, "chat");
  assert.ok(calls.every(call => call.init.method === "GET"));
  assert.equal(calls[3]!.url.search, "?status=all");
});

test("provisioning listings reject a crossed workspace instead of adopting foreign resources", async () => {
  const { client } = fixture([{ projects: [{ id: "project", title: "known-name", workspace_id: "other" }] }]);
  await assert.rejects(client.listProjects(), MulticaProtocolError);
});
