import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { CorrelationRepository } from "../packages/persistence/index.ts";
import { OfficialMulticaClient } from "../packages/multica-client/index.ts";
import type { DeploymentDriverConfiguration } from "../apps/dsh-host/create-driver.ts";

/** Live acceptance: one DSH session uses the same DSH Skill after a CLI switch. */
const [configPath = ".runtime/driver/config.json", tokenPath = ".runtime/dsh/gateway.token"] = process.argv.slice(2);
const config = JSON.parse(await readFile(configPath, "utf8")) as DeploymentDriverConfiguration;
const token = (await readFile(tokenPath, "utf8")).trim();
const repository = new CorrelationRepository(config.correlationDatabase);
const client = new OfficialMulticaClient({ baseUrl: config.multica.localApiUrl, token: config.multica.token, workspaceId: config.multica.workspaceId });
const sessionId = randomUUID();
async function gateway(path: string, body?: object): Promise<any> {
  const response = await fetch(`http://127.0.0.1:3380${path}`, { method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000) });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Gateway ${path} returned HTTP ${response.status}`);
  return value;
}
async function runPrompt(prompt: string) {
  const requestId = randomUUID();
  await gateway(`/v1/sessions/${sessionId}/messages`, { requestId, text: prompt });
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const task = repository.getTask(requestId);
    if (task && ["completed", "failed", "cancelled"].includes(task.state)) {
      if (task.state !== "completed" || !task.externalTaskId) throw new Error(`Skill task ${requestId} ended as ${task.state}`);
      const resources = repository.getSegmentResources(task.segmentId)!;
      const transcript = await client.readTaskMessages(task.externalTaskId, 0);
      return { requestId, taskId: task.externalTaskId, agentId: resources.agentId, chatSessionId: resources.chatSessionId,
        response: transcript.messages.map(message => message.raw.content ?? "").filter(Boolean).join("\n") };
    }
    await delay(1000);
  }
  throw new Error(`Skill task ${requestId} observation timed out`);
}
try {
  await gateway("/v1/sessions", { sessionId });
  const first = await runPrompt("请把这句话改成克制的二次元角色台词：请先运行测试，再提交代码。只输出改写结果和语气说明。");
  const claude = (await client.listRuntimeDescriptors()).find(runtime => runtime.daemonId === config.daemon.daemonId && runtime.kind === "claude-code" && runtime.status === "online");
  if (!claude) throw new Error("No online remote Claude Code runtime is registered");
  await gateway(`/v1/sessions/${sessionId}/runtime`, { runtime: claude.kind, runtimeId: claude.runtimeId, daemonId: claude.daemonId });
  const second = await runPrompt("继续使用二次元语句转化 Skill，把“任务完成了”改成一句克制的动漫台词，并附一句语气说明。");
  if (first.agentId !== second.agentId || first.chatSessionId !== second.chatSessionId) throw new Error("Runtime switch created a second Multica Agent or Chat Session");
  const attached = await client.listAgentSkills(second.agentId);
  const skill = attached.find(item => item.name === "dsh-anime-phrase-transformer");
  if (!skill?.enabled) throw new Error("The switched Agent lost the DSH Skill assignment");
  console.log(JSON.stringify({ sessionId, first: { requestId: first.requestId, taskId: first.taskId, runtime: "codex", response: first.response.slice(-1000) },
    second: { requestId: second.requestId, taskId: second.taskId, runtime: "claude-code", response: second.response.slice(-1000) },
    stableAgentId: second.agentId, stableChatSessionId: second.chatSessionId, skillId: skill.id, skillEnabled: skill.enabled }));
} finally { repository.close(); }

