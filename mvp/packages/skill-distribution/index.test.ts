import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OfficialMulticaClient } from "../multica-client/index.ts";
import { ANIME_PHRASE_SKILL, loadDshManagedSkills, loadDshRegistrySkills, MulticaSkillDistributor } from "./index.ts";

function clientFixture(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  return new OfficialMulticaClient({ baseUrl: "http://multica.invalid", token: "unit-test-token", workspaceId: "workspace",
    fetchImpl: handler as typeof fetch });
}
const summary = (id: string, config: unknown = {}) => ({ id, workspace_id: "workspace", name: ANIME_PHRASE_SKILL.name,
  description: ANIME_PHRASE_SKILL.description, config });

test("loads arbitrary DSH Skill directories with metadata and supporting files", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-skills-"));
  const skillRoot = join(root, "sample");
  await mkdir(join(skillRoot, "references"), { recursive: true });
  await writeFile(join(skillRoot, "SKILL.md"), "---\nname: sample-style\ndescription: 示例\nversion: 2.0.0\n---\n\n# 规则\n", "utf8");
  await writeFile(join(skillRoot, "references", "tone.md"), "保留事实。\n", "utf8");
  const [skill] = await loadDshManagedSkills(root);
  assert.equal(skill!.key, "dsh:sample");
  assert.equal(skill!.name, "sample-style");
  assert.equal(skill!.version, "2.0.0");
  assert.equal(skill!.content, "# 规则\n");
  assert.deepEqual(skill!.files, [{ path: "references/tone.md", content: "保留事实。\n" }]);
});

test("adapts the official DSH ctx.skills registry without reimplementing its discovery", async () => {
  const ctx = { skills: {
    async list() { return [{ name: "registry-style", description: "来自 DSH", source: "user-dsh", provider: "filesystem" }]; },
    async get() { return { name: "registry-style", description: "来自 DSH", source: "user-dsh", provider: "filesystem", content: "# DSH 规则\n", metadata: { version: "3.0.0" } }; },
  } };
  const skills = await loadDshRegistrySkills(ctx, { sources: ["user-dsh"] });
  assert.deepEqual(skills.map(skill => ({ key: skill.key, name: skill.name, version: skill.version, content: skill.content })),
    [{ key: "dsh-registry:registry-style", name: "registry-style", version: "3.0.0", content: "# DSH 规则\n" }]);
});

test("lists the global DSH Skill catalog and preserves a disabled marker", async () => {
  const config = { dshagent: { key: ANIME_PHRASE_SKILL.key, version: ANIME_PHRASE_SKILL.version, sha256: "hash", enabled: false } };
  const client = clientFixture(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/skills" && init.method === "GET") return Response.json([summary("skill-anime", config)]);
    throw new Error(`Unexpected ${init.method} ${url.pathname}`);
  });
  assert.deepEqual(await new MulticaSkillDistributor(client, [ANIME_PHRASE_SKILL]).listSkillStates(), [{
    key: ANIME_PHRASE_SKILL.key, id: "skill-anime", name: ANIME_PHRASE_SKILL.name, version: ANIME_PHRASE_SKILL.version,
    description: ANIME_PHRASE_SKILL.description, attached: true, enabled: false,
  }]);
});

test("deletes stale DSH-owned Skills while leaving foreign Skills untouched", async () => {
  const calls: Array<string> = [];
  const client = clientFixture(async (input, init) => {
    const url = new URL(String(input)); calls.push(`${init.method ?? "GET"} ${url.pathname}`);
    if (url.pathname === "/api/skills" && init.method === "GET") return Response.json([
      summary("stale", { dshagent: { key: "dsh:removed", version: "1.0.0", sha256: "old" } }),
      summary("foreign", { source: "user" }),
    ]);
    if (url.pathname === "/api/skills/stale" && init.method === "DELETE") return new Response(null, { status: 204 });
    if (url.pathname === "/api/agents/agent/skills" && init.method === "GET") return Response.json([]);
    throw new Error(`Unexpected ${init.method} ${url.pathname}`);
  });
  const result = await new MulticaSkillDistributor(client, []).syncAgent("agent");
  assert.deepEqual(result.deleted, ["stale"]);
  assert.deepEqual(calls, ["GET /api/skills", "DELETE /api/skills/stale", "GET /api/agents/agent/skills"]);
});

test("namespaces DSH markers so a shared Multica workspace cannot delete another tenant's Skill", async () => {
  const deleted: string[] = [];
  const client = clientFixture(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/skills" && init.method === "GET") return Response.json([
      summary("tenant-a-stale", { dshagent: { key: "alice:removed", version: "1.0.0", sha256: "old" } }),
      summary("tenant-b", { dshagent: { key: "bob:kept", version: "1.0.0", sha256: "other" } }),
    ]);
    if (url.pathname === "/api/skills/tenant-a-stale" && init.method === "DELETE") { deleted.push("tenant-a-stale"); return new Response(null, { status: 204 }); }
    if (url.pathname === "/api/agents/agent/skills" && init.method === "GET") return Response.json([]);
    throw new Error(`Unexpected ${init.method} ${url.pathname}`);
  });
  const result = await new MulticaSkillDistributor(client, [], { namespace: "alice" }).syncAgent("agent");
  assert.deepEqual(result.deleted, ["tenant-a-stale"]);
  assert.deepEqual(deleted, ["tenant-a-stale"]);
});

test("reloads DSH declarations before syncing a source deletion", async () => {
  const client = clientFixture(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/skills" && init.method === "GET") return Response.json([summary("skill-anime", {
      dshagent: { key: ANIME_PHRASE_SKILL.key, version: ANIME_PHRASE_SKILL.version, sha256: "old" },
    })]);
    if (url.pathname === "/api/skills/skill-anime" && init.method === "DELETE") return new Response(null, { status: 204 });
    if (url.pathname === "/api/agents/agent/skills" && init.method === "GET") return Response.json([]);
    throw new Error(`Unexpected ${init.method} ${url.pathname}`);
  });
  const distributor = new MulticaSkillDistributor(client, [ANIME_PHRASE_SKILL], { reload: async () => [] });
  const result = await distributor.syncAgent("agent");
  assert.deepEqual(result.deleted, ["skill-anime"]);
});

test("globally disables a DSH Skill in Multica and on every existing Agent", async () => {
  const config = { dshagent: { key: ANIME_PHRASE_SKILL.key, version: ANIME_PHRASE_SKILL.version, sha256: "hash", enabled: true } };
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  const client = clientFixture(async (input, init) => {
    const url = new URL(String(input));
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init.method ?? "GET", path: url.pathname, body });
    if (url.pathname === "/api/skills" && init.method === "GET") return Response.json([summary("skill-anime", config)]);
    if (url.pathname === "/api/skills/skill-anime" && init.method === "GET") return Response.json({ ...summary("skill-anime", config), content: ANIME_PHRASE_SKILL.content, files: [] });
    if (url.pathname === "/api/skills/skill-anime" && init.method === "PUT") return Response.json({ ...summary("skill-anime", body.config), content: ANIME_PHRASE_SKILL.content, files: [] });
    if (url.pathname === "/api/agents" && init.method === "GET") return Response.json([{ id: "agent-a", workspace_id: "workspace", name: "Agent A", runtime_id: "runtime", max_concurrent_tasks: 2 }]);
    if (url.pathname === "/api/agents/agent-a/skills" && init.method === "GET") return Response.json([summary("skill-anime", config)]);
    if (url.pathname === "/api/agents/agent-a/skills/skill-anime/enabled" && init.method === "PUT") {
      assert.deepEqual(body, { enabled: false });
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected ${init.method} ${url.pathname}`);
  });
  await new MulticaSkillDistributor(client, [ANIME_PHRASE_SKILL]).setSkillEnabledGlobally(ANIME_PHRASE_SKILL.key, false);
  assert.equal(calls[2]!.body.config.dshagent.enabled, false);
  assert.deepEqual(calls.map(call => `${call.method} ${call.path}`), [
    "GET /api/skills", "GET /api/skills/skill-anime", "PUT /api/skills/skill-anime",
    "GET /api/agents", "GET /api/agents/agent-a/skills", "PUT /api/agents/agent-a/skills/skill-anime/enabled",
  ]);
});

test("syncs a DSH Skill through official create and Agent assignment APIs", async () => {
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  let attached = false;
  const client = clientFixture(async (input, init) => {
    const url = new URL(String(input));
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init.method ?? "GET", path: url.pathname, body });
    if (url.pathname === "/api/skills" && init.method === "GET") return Response.json([]);
    if (url.pathname === "/api/skills" && init.method === "POST") return Response.json({ ...summary("skill-anime", body.config), content: body.content, files: body.files }, { status: 201 });
    if (url.pathname === "/api/agents/agent/skills" && init.method === "GET") return Response.json(attached ? [summary("skill-anime", {})] : []);
    if (url.pathname === "/api/agents/agent/skills/add" && init.method === "POST") {
      assert.deepEqual(body.skill_ids, ["skill-anime"]);
      attached = true;
      return Response.json([summary("skill-anime", {})]);
    }
    throw new Error(`Unexpected ${init.method} ${url.pathname}`);
  });
  const result = await new MulticaSkillDistributor(client, [ANIME_PHRASE_SKILL]).syncAgent("agent");
  assert.deepEqual(result.skills.map(skill => skill.id), ["skill-anime"]);
  assert.deepEqual(result.assigned, ["skill-anime"]);
  assert.deepEqual(calls.map(call => `${call.method} ${call.path}`), [
    "GET /api/skills", "POST /api/skills", "GET /api/agents/agent/skills", "POST /api/agents/agent/skills/add", "GET /api/agents/agent/skills",
  ]);
  assert.equal(calls[1]!.body.name, ANIME_PHRASE_SKILL.name);
  assert.match(calls[1]!.body.content, /二次元语句转化/u);
  assert.equal(calls[3]!.body.skill_ids[0], "skill-anime");
});

test("updates the DSH-owned Skill but preserves existing non-DSH assignments", async () => {
  const config = { dshagent: { key: ANIME_PHRASE_SKILL.key, version: "0.9.0", sha256: "old" } };
  const calls: Array<string> = [];
  let agentSkills = [summary("existing", {})];
  const client = clientFixture(async (input, init) => {
    const url = new URL(String(input)); calls.push(`${init.method ?? "GET"} ${url.pathname}`);
    if (url.pathname === "/api/skills" && init.method === "GET") return Response.json([summary("skill-anime", config)]);
    if (url.pathname === "/api/skills/skill-anime" && init.method === "GET") return Response.json({ ...summary("skill-anime", config), content: "old", files: [] });
    if (url.pathname === "/api/skills/skill-anime" && init.method === "PUT") return Response.json({ ...summary("skill-anime", JSON.parse(String(init.body)).config), content: ANIME_PHRASE_SKILL.content, files: [] });
    if (url.pathname === "/api/agents/agent/skills" && init.method === "GET") return Response.json(agentSkills);
    if (url.pathname === "/api/agents/agent/skills/add" && init.method === "POST") {
      assert.deepEqual(JSON.parse(String(init.body)).skill_ids, ["skill-anime"]);
      agentSkills = [...agentSkills, summary("skill-anime", {})];
      return Response.json(agentSkills);
    }
    throw new Error(`Unexpected ${init.method} ${url.pathname}`);
  });
  const result = await new MulticaSkillDistributor(client, [ANIME_PHRASE_SKILL]).syncAgent("agent");
  assert.equal(result.skills[0]!.changed, true);
  assert.ok(calls.includes("PUT /api/skills/skill-anime"));
});

test("does not overwrite a same-named Skill that DSH does not own", async () => {
  const client = clientFixture(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/skills" && init.method === "GET") return Response.json([summary("foreign", { source: "user" })]);
    throw new Error(`Unexpected ${init.method} ${url.pathname}`);
  });
  await assert.rejects(new MulticaSkillDistributor(client, [ANIME_PHRASE_SKILL]).syncAgent("agent"), /already owned outside DSH/u);
});

test("reconciles a concurrent create conflict only when the DSH marker is present", async () => {
  let listed = false;
  let attached = false;
  const client = clientFixture(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/skills" && init.method === "GET") {
      if (!listed) return Response.json([]);
      return Response.json([summary("skill-anime", { dshagent: { key: ANIME_PHRASE_SKILL.key } })]);
    }
    if (url.pathname === "/api/skills" && init.method === "POST") { listed = true; return new Response("conflict", { status: 409 }); }
    if (url.pathname === "/api/skills/skill-anime" && init.method === "GET") return Response.json({ ...summary("skill-anime", {}), content: ANIME_PHRASE_SKILL.content, files: [] });
    if (url.pathname === "/api/agents/agent/skills" && init.method === "GET") return Response.json(attached ? [summary("skill-anime", {})] : []);
    if (url.pathname === "/api/agents/agent/skills/add" && init.method === "POST") { attached = true; return Response.json([summary("skill-anime", {})]); }
    throw new Error(`Unexpected ${init.method} ${url.pathname}`);
  });
  const result = await new MulticaSkillDistributor(client, [ANIME_PHRASE_SKILL]).syncAgent("agent");
  assert.equal(result.skills[0]!.id, "skill-anime");
});
