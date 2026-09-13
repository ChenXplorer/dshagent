import { RecursionGuardError } from "../plugin/errors.ts";
import type { SubmitTaskInput } from "../plugin/types.ts";
import type { OfficialMulticaPlane } from "../multica/official.ts";
import type { MulticaControlPlane } from "../multica/control-plane.ts";
import type { SimulatedMultica } from "./backend.ts";

const PREFIX = "/api/multica";
const TERMINAL = new Set(["task/completed", "task/failed", "task/canceled"]);

export type MulticaHttpBackend =
  | SimulatedMultica
  | MulticaControlPlane
  | OfficialMulticaPlane;

export async function handleMulticaHttp(
  sim: MulticaHttpBackend,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const path = stripPrefix(url.pathname);
  const method = request.method.toUpperCase();

  try {
    if (method === "GET" && path === "/health") {
      const live = await Promise.resolve(sim.snapshotLive());
      return json({
        ok: true,
        transport: "http",
        plugin: "dsh-multica-runtime",
        live: live.live,
        provider: "provider" in live ? live.provider : "deepseek",
        model: "model" in live ? live.model : undefined,
        dialects: "dialects" in live ? live.dialects : undefined,
        executors: "executors" in live ? live.executors : undefined,
        binaries: "binaries" in live ? live.binaries : undefined,
        daemon: "daemon" in live ? live.daemon : undefined,
        plane: "plane" in live ? live.plane : "loopback",
      });
    }
    if (method === "GET" && path === "/runtimes") {
      return json(await sim.listRuntimes());
    }
    if (method === "POST" && path === "/agents") {
      const body = (await request.json()) as {
        runtime: "dsh" | "codex" | "claude-code" | "pi";
        machineId: string;
        nativeProfile?: string;
      };
      return json(await sim.ensureAgent(body), 201);
    }
    if (method === "POST" && path === "/sessions") {
      const body = (await request.json()) as {
        agentId: string;
        dshSessionId: string;
        segmentId: string;
        resumeCliSessionId?: string;
      };
      return json(await sim.ensureSession(body), 201);
    }
    if (method === "POST" && path === "/tasks") {
      const body = (await request.json()) as SubmitTaskInput;
      const result = await sim.submitTask(body);
      const status = result.status === "unknown" ? 202 : 201;
      return json(result, status);
    }
    if (method === "GET" && path === "/tasks") {
      const clientRequestId = url.searchParams.get("clientRequestId");
      if (!clientRequestId) return json({ missing: true }, 404);
      const task = await sim.getTaskByClientRequestId(clientRequestId);
      return task ? json(task) : json({ missing: true }, 404);
    }
    if (method === "POST" && path === "/debug/drop-ack") {
      sim.dropNextAck();
      return json({ armed: true });
    }

    if (isControlPlane(sim)) {
      if (method === "POST" && path === "/internal/register") {
        const body = (await request.json()) as {
          machineId: string;
          tools: Array<{ runtime: "dsh" | "codex" | "claude-code" | "pi"; cli: string; executor: string }>;
        };
        return json(sim.registerDaemon(body), 201);
      }
      if (method === "POST" && path === "/internal/heartbeat") {
        const body = (await request.json()) as { machineId: string };
        return json(sim.heartbeatDaemon(body.machineId));
      }
      if (method === "GET" && path === "/internal/claim") {
        const machineId = url.searchParams.get("machineId") ?? "";
        const waitMs = Number(url.searchParams.get("waitMs") ?? 8000);
        const task = await sim.claimTask(machineId, Math.min(Math.max(waitMs, 250), 20_000));
        return json({ task });
      }
      if (method === "POST" && path === "/internal/events") {
        const body = (await request.json()) as {
          taskId: string;
          event: Parameters<MulticaControlPlane["ingestDaemonEvent"]>[1];
        };
        sim.ingestDaemonEvent(body.taskId, body.event);
        return json({ ok: true });
      }
    }

    const taskMatch = path.match(/^\/tasks\/([^/]+)(\/(cancel|events))?$/);
    if (taskMatch) {
      const taskId = decodeURIComponent(taskMatch[1] ?? "");
      const rest = taskMatch[2] ?? "";
      if (method === "GET" && rest === "") {
        const task = await sim.getTask(taskId);
        return task ? json(task) : json({ missing: true }, 404);
      }
      if (method === "POST" && rest === "/cancel") {
        await sim.cancelTask(taskId);
        return json({ canceled: true });
      }
      if (method === "GET" && rest === "/events") {
        const task = await sim.getTask(taskId);
        if (!task) return json({ missing: true }, 404);
        return sse(sim, taskId);
      }
    }

    return json({ error: `no route ${method} ${path}` }, 404);
  } catch (error) {
    if (error instanceof RecursionGuardError) {
      return json(
        { code: error.code, message: error.message, profile: extractProfile(error.message) },
        409,
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    return json({ error: message }, 500);
  }
}

function isControlPlane(sim: MulticaHttpBackend): sim is MulticaControlPlane {
  return "registerDaemon" in sim;
}

function sse(sim: MulticaHttpBackend, taskId: string): Response {
  const encoder = new TextEncoder();
  let unsub: (() => void) | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      unsub = sim.subscribe(taskId, (event) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        if (TERMINAL.has(event.type)) {
          unsub?.();
          unsub = undefined;
          controller.close();
        }
      });
    },
    cancel() {
      unsub?.();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stripPrefix(pathname: string): string {
  if (pathname === PREFIX) return "/";
  if (pathname.startsWith(`${PREFIX}/`)) return pathname.slice(PREFIX.length);
  return pathname;
}

function extractProfile(message: string): string {
  const match = message.match(/profile "([^"]+)"/);
  return match?.[1] ?? "unknown";
}
