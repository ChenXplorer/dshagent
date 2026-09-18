import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { CorrelationRepository } from "../packages/persistence/index.ts";
import { OfficialMulticaClient } from "../packages/multica-client/index.ts";
import type { DeploymentDriverConfiguration } from "../apps/dsh-host/create-driver.ts";

/** Live acceptance: DSH session -> real Multica Daemon -> native CLI with a DSH Skill. */
const [configPath = ".runtime/driver/config.json", tokenPath = ".runtime/dsh/gateway.token"] = process.argv.slice(2);
const config = JSON.parse(await readFile(configPath, "utf8")) as DeploymentDriverConfiguration;
const token = (await readFile(tokenPath, "utf8")).trim();
const repository = new CorrelationRepository(config.correlationDatabase);
const client = new OfficialMulticaClient({ baseUrl: config.multica.localApiUrl, token: config.multica.token, workspaceId: config.multica.workspaceId });
const sessionId = randomUUID();
const requestId = randomUUID();
const prompt = "请把这句话转成克制、清晰的二次元角色台词：请先运行测试，再提交代码。只输出改写结果和一句语气说明。";
async function gateway(path: string, body?: object): Promise<any> {
  const response = await fetch(`http://127.0.0.1:3380${path}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Gateway ${path} returned HTTP ${response.status}`);
  return value;
}
try {
  await gateway("/v1/sessions", { sessionId });
  await gateway(`/v1/sessions/${sessionId}/messages`, { requestId, text: prompt });
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const task = repository.getTask(requestId);
    if (task && ["completed", "failed", "cancelled"].includes(task.state)) {
      if (task.state !== "completed") throw new Error(`Skill task ended as ${task.state}`);
      const segment = repository.getExecutionSegment(task.segmentId)!;
      const resources = repository.getSegmentResources(task.segmentId)!;
      const binding = { taskId: task.externalTaskId!, agentId: resources.agentId, runtimeId: resources.runtimeId, chatSessionId: resources.chatSessionId };
      const transcript = await client.readTaskMessages(binding.taskId, 0);
      const text = transcript.messages.map(message => message.raw.content ?? "").filter(Boolean).join("\n");
      const skills = await client.listAgentSkills(binding.agentId);
      const applied = skills.find(skill => skill.name === "dsh-anime-phrase-transformer");
      if (!applied) throw new Error("The real Multica Agent does not have the DSH anime Skill attached");
      console.log(JSON.stringify({ sessionId, requestId, taskId: binding.taskId, agentId: binding.agentId, runtimeId: binding.runtimeId,
        skillId: applied.id, skillEnabled: applied.enabled, response: text.slice(-2000), dshState: segment.runtime }));
      break;
    }
    await delay(1000);
  }
  if (!repository.getTask(requestId)) throw new Error("Live Skill task observation timed out");
} finally { repository.close(); }

