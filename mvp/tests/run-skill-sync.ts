import { readFile } from "node:fs/promises";
import { OfficialMulticaClient } from "../packages/multica-client/index.ts";
import { loadDshManagedSkills, MulticaSkillDistributor } from "../packages/skill-distribution/index.ts";

/** Live smoke: sync the configured DSH Skills to one existing official Agent. */
const configPath = process.env.DSH_MVP_CONFIG ?? ".runtime/driver/config.json";
const config = JSON.parse(await readFile(configPath, "utf8")) as {
  multica: { localApiUrl: string; token: string; workspaceId: string };
  managedSkillsDir?: string;
};
if (!config.managedSkillsDir) throw new Error("DSH_MVP_CONFIG must enable managedSkillsDir for this smoke");
const client = new OfficialMulticaClient({ baseUrl: config.multica.localApiUrl, token: config.multica.token, workspaceId: config.multica.workspaceId });
const agents = await client.listAgents();
if (!agents.length) throw new Error("No existing Multica Agent to verify against");
const skills = await loadDshManagedSkills(config.managedSkillsDir);
const result = await new MulticaSkillDistributor(client, skills).syncAgent(agents[0]!.id);
const attached = await client.listAgentSkills(agents[0]!.id);
console.log(JSON.stringify({
  agentId: result.agentId,
  synced: result.skills.map(({ key, id, name, version, changed }) => ({ key, id, name, version, changed })),
  attached: attached.map(({ id, name, enabled }) => ({ id, name, enabled })),
}));

