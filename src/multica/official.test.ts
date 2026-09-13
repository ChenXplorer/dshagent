import assert from "node:assert/strict";
import test from "node:test";
import { OfficialMulticaPlane } from "./official.ts";

function mockOfficial(): { plane: OfficialMulticaPlane; calls: string[] } {
  const calls: string[] = [];
  let seq = 0;
  let status = "running";
  const runtimeId = "rt-codex";
  const agentId = "ag-codex";
  const chatId = "chat-1";
  const taskId = "task-official";
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const path = new URL(url).pathname;
    calls.push(`${method} ${path}`);
    if (path === "/api/runtimes") {
      return json([
        {
          id: runtimeId,
          name: "Codex",
          launch_header: "codex app-server",
          last_seen_at: new Date().toISOString(),
        },
      ]);
    }
    if (method === "GET" && path === "/api/agents") {
      return json([{ id: agentId, name: "Codex", runtime_id: runtimeId }]);
    }
    if (method === "PUT" && path === `/api/agents/${agentId}/env`) return json({ ok: true });
    if (method === "POST" && path === "/api/chat/sessions") return json({ id: chatId }, 201);
    if (method === "POST" && path.endsWith("/messages") && path.includes("/chat/sessions/")) {
      return json({ task_id: taskId }, 201);
    }
    if (path === `/api/tasks/${taskId}/messages`) {
      seq += 1;
      if (seq === 1) {
        return json([
          { task_id: taskId, seq: 1, type: "tool_use", tool: "exec_command", input: { command: "ls" } },
        ]);
      }
      return json([
        { task_id: taskId, seq: 1, type: "tool_use", tool: "exec_command", input: { command: "ls" } },
        { task_id: taskId, seq: 2, type: "text", text: "PLUGIN_OFFICIAL_OK README.md" },
      ]);
    }
    if (path === `/api/agents/${agentId}/tasks`) {
      if (seq >= 2) status = "completed";
      return json([
        {
          id: taskId,
          status,
          result: { output: "PLUGIN_OFFICIAL_OK README.md" },
        },
      ]);
    }
    return json({ error: `unexpected ${method} ${path}` }, 404);
  };
  const plane = new OfficialMulticaPlane(
    {
      baseUrl: "http://official.test",
      token: "mul_test",
      workspaceId: "ws_test",
    },
    fetchImpl,
  );
  return { plane, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("official plane maps Codex runtime and drives a chat task", async () => {
  const { plane } = mockOfficial();
  const live = await plane.snapshotLive();
  assert.equal(live.plane, "official");
  assert.equal(live.binaries.codex, true);
  const runtimes = await plane.listRuntimes();
  assert.equal(runtimes[0]?.runtime, "codex");
  const agent = await plane.ensureAgent({ runtime: "codex", machineId: "cube-personal" });
  const session = await plane.ensureSession({
    agentId: agent.id,
    dshSessionId: "dsh_1",
    segmentId: "seg_1",
  });
  const submitted = await plane.submitTask({
    clientRequestId: "req-1",
    agentId: agent.id,
    sessionId: session.id,
    prompt: "hi",
    cwd: "/work/auth-service",
    runtime: "codex",
    machineId: "cube-personal",
    skills: [],
    mcp: [],
  });
  assert.equal(submitted.status, "accepted");
  const events: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), 4000);
    plane.subscribe(submitted.taskId, (event) => {
      events.push(event.type);
      if (event.type === "task/completed") {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  assert.ok(events.includes("tool/call"));
  assert.ok(events.includes("text/committed"));
  const task = await plane.getTask(submitted.taskId);
  assert.equal(task?.status, "completed");
  const committed = task?.events.find((event) => event.type === "text/committed");
  assert.match(String(committed?.data["text"]), /PLUGIN_OFFICIAL_OK/);
});
