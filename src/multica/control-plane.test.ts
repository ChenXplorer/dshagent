import assert from "node:assert/strict";
import test from "node:test";
import { handleMulticaHttp } from "../sim/http.ts";
import { MulticaControlPlane } from "./control-plane.ts";
import { MulticaDaemon } from "./daemon.ts";

function fetchAgainst(plane: MulticaControlPlane): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return handleMulticaHttp(plane, new Request(url, init));
  };
}

test("server queues; daemon claims and is the only thing that starts the task", async () => {
  const server = new MulticaControlPlane();
  const submitted = await server.submitTask({
    clientRequestId: "req-1",
    agentId: "ag",
    prompt: "hi",
    cwd: "/work/auth-service",
    runtime: "codex",
    machineId: "cube-personal",
    skills: [],
    mcp: [],
  });
  assert.equal(submitted.status, "accepted");
  const queued = await server.getTask(submitted.taskId);
  assert.equal(queued?.status, "queued");
  assert.ok(!queued?.events.some((event) => event.type === "task/started"));

  server.registerDaemon({
    machineId: "cube-personal",
    tools: [{ runtime: "codex", cli: "codex", executor: "codex-cli" }],
  });
  const claimed = await server.claimTask("cube-personal", 50);
  assert.equal(claimed?.taskId, submitted.taskId);
  server.ingestDaemonEvent(submitted.taskId, {
    id: "ev1",
    taskId: submitted.taskId,
    type: "task/started",
    time: Date.now(),
    data: { plane: "daemon" },
  });
  const running = await server.getTask(submitted.taskId);
  assert.equal(running?.status, "running");
});

test("laptop daemon is a different machine; cloud daemon does not steal it", async () => {
  const server = new MulticaControlPlane();
  server.registerDaemon({
    machineId: "cube-personal",
    tools: [{ runtime: "codex", cli: "codex", executor: "codex-cli" }],
  });
  await server.submitTask({
    clientRequestId: "req-local",
    agentId: "ag",
    prompt: "hi",
    cwd: "/work/auth-service",
    runtime: "codex",
    machineId: "laptop-chen",
    skills: [],
    mcp: [],
  });
  const stolen = await server.claimTask("cube-personal", 30);
  assert.equal(stolen, null);
});

test("daemon process talks to the server over HTTP", async () => {
  const server = new MulticaControlPlane();
  const daemon = new MulticaDaemon({
    serverUrl: "http://multica.test/api/multica",
    machineId: "cube-personal",
    fetch: fetchAgainst(server),
    pollMs: 200,
    heartbeatMs: 50_000,
  });
  await daemon.start();
  const live = server.snapshotLive();
  assert.equal(live.daemon.online, true);
  assert.ok(live.binaries.codex);
  await daemon.stop();
});
