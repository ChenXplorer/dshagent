import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { MulticaApiError, type OfficialMulticaClient } from "../multica-client/index.ts";
import type { OfficialSkill, OfficialSkillSummary } from "../multica-client/index.ts";

/** A DSH-owned Skill declaration. Multica remains the execution registry. */
export interface DshManagedSkill {
  /** Stable DSH identifier; it is stored in the Multica config marker. */
  key: string;
  name: string;
  version: string;
  description: string;
  content: string;
  config?: Record<string, unknown>;
  files?: Array<{ path: string; content: string }>;
}

export interface SkillSyncResult {
  agentId: string;
  skills: Array<{ key: string; id: string; name: string; version: string; changed: boolean; enabled: boolean }>;
  assigned: string[];
  deleted: string[];
}

export interface DshSkillState {
  key: string;
  id?: string;
  name: string;
  version: string;
  description: string;
  attached: boolean;
  enabled: boolean;
}

export interface DshSkillDistributionOptions {
  /** Re-read DSH sources before a catalog read, toggle, or Agent sync. */
  reload?: () => Promise<readonly DshManagedSkill[]>;
  /** Persist a tenant's replacement declarations so a Host restart keeps them. */
  persist?: (skills: readonly DshManagedSkill[]) => Promise<void>;
  /** Namespace Multica markers when several tenants share one workspace. */
  namespace?: string;
}

/** Reads the conventional DSH Skill tree: <root>/<skill>/SKILL.md. */
export async function loadDshManagedSkills(root: string): Promise<DshManagedSkill[]> {
  if (typeof root !== "string" || !root.trim() || !isAbsolute(root)) throw new Error("managedSkillsDir must be an absolute directory");
  const absoluteRoot = resolve(root);
  const entries = await readdir(absoluteRoot, { withFileTypes: true });
  const skills: DshManagedSkill[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const skillRoot = join(absoluteRoot, entry.name);
    const skillFile = join(skillRoot, "SKILL.md");
    let source: string;
    try { source = await readFile(skillFile, "utf8"); }
    catch { continue; }
    const parsed = parseSkillFrontmatter(source);
    const files = await loadSupportingFiles(skillRoot, skillFile);
    skills.push({
      key: `dsh:${relative(absoluteRoot, skillRoot).replace(/[\\/]+/gu, "/")}`,
      name: parsed.name ?? basename(skillRoot),
      version: parsed.version ?? "1.0.0",
      description: parsed.description ?? "DSH managed Skill",
      content: parsed.content,
      files,
      config: { source: "dsh-skill-directory", directory: relative(absoluteRoot, skillRoot).replace(/[\\/]+/gu, "/") },
    });
  }
  return skills;
}

/**
 * Adapts the official DSH `ctx.skills` registry into the same declarations.
 * The registry is optional so the driver can also run on a minimal DSH
 * profile; directory and inline declarations remain explicit alternatives.
 */
export async function loadDshRegistrySkills(ctx: unknown, options: { cwd?: string; sources?: readonly string[] } = {}): Promise<DshManagedSkill[]> {
  if (!ctx || typeof ctx !== "object") return [];
  const registry = (ctx as { skills?: unknown }).skills as {
    list?: (options?: { cwd?: string }) => Promise<readonly DshRegistrySummary[]>;
    get?: (name: string, options?: { cwd?: string }) => Promise<DshRegistryDefinition | undefined>;
  } | undefined;
  if (typeof registry?.list !== "function" || typeof registry.get !== "function") return [];
  const allowed = options.sources ? new Set(options.sources) : undefined;
  const summaries = await registry.list(options.cwd ? { cwd: options.cwd } : undefined);
  const skills: DshManagedSkill[] = [];
  for (const summary of summaries) {
    if (!summary || typeof summary.name !== "string" || (allowed && !allowed.has(summary.source))) continue;
    const definition = await registry.get(summary.name, options.cwd ? { cwd: options.cwd } : undefined);
    if (!definition || typeof definition.content !== "string" || !definition.content.trim()) continue;
    const metadata = definition.metadata && typeof definition.metadata === "object" ? definition.metadata : {};
    const version = typeof metadata.version === "string" && metadata.version.trim()
      ? metadata.version : `registry-${createHash("sha256").update(definition.content).digest("hex").slice(0, 12)}`;
    let files: Array<{ path: string; content: string }> = [];
    if (typeof definition.path === "string" && isAbsolute(definition.path)) {
      try {
        const details = await stat(definition.path);
        const skillFile = details.isDirectory() ? join(definition.path, "SKILL.md") : definition.path;
        files = await loadSupportingFiles(dirname(skillFile), skillFile);
      } catch {
        // A provider may expose a virtual body without a readable local path.
      }
    }
    skills.push({
      key: `dsh-registry:${definition.name}`,
      name: definition.name,
      version,
      description: definition.description,
      content: definition.content,
      files,
      config: { source: "dsh-registry", provider: definition.provider, dshSource: definition.source },
    });
  }
  return skills;
}

interface DshRegistrySummary { name: string; description: string; source: string; provider: string }
interface DshRegistryDefinition extends DshRegistrySummary { content: string; path?: string; metadata?: Readonly<Record<string, unknown>> }

function parseSkillFrontmatter(source: string): { name?: string; description?: string; version?: string; content: string } {
  const normalized = source.replace(/^\uFEFF/u, "");
  if (!normalized.startsWith("---\n") && !normalized.startsWith("---\r\n")) return { content: normalized };
  const end = normalized.search(/\r?\n---(?:\r?\n|$)/u);
  if (end < 0) return { content: normalized };
  const header = normalized.slice(4, end).split(/\r?\n/u);
  const values: Record<string, string> = {};
  for (const line of header) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/u.exec(line);
    if (match) values[match[1]!.toLowerCase()] = match[2]!.trim().replace(/^(["'])(.*)\1$/u, "$2");
  }
  return { name: values.name, description: values.description, version: values.version,
    content: normalized.slice(end).replace(/^\r?\n---\r?\n/u, "").replace(/^\r?\n/u, "") };
}

async function loadSupportingFiles(root: string, skillFile: string): Promise<Array<{ path: string; content: string }>> {
  const output: Array<{ path: string; content: string }> = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (path !== skillFile) output.push({ path: relative(root, path).replace(/[\\/]+/gu, "/"), content: await readFile(path, "utf8") });
    }
  };
  await walk(root);
  return output;
}

const MARKER_KEY = "dshagent";

function text(value: string, field: string, max = 512): string {
  if (typeof value !== "string" || !value.trim() || value.trim() !== value || value.length > max) {
    throw new Error(`${field} must be a non-empty trimmed string`);
  }
  return value;
}

function safeFilePath(path: string): string {
  text(path, "skill.file.path");
  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(path) || path.split(/[\\/]/u).includes("..")) {
    throw new Error(`Invalid Skill file path: ${path}`);
  }
  return path;
}

function digest(skill: DshManagedSkill): string {
  return createHash("sha256").update(JSON.stringify([
    skill.key, skill.name, skill.version, skill.description, skill.content,
    skill.config ?? {}, skill.files ?? [],
  ])).digest("hex");
}

function marker(skill: DshManagedSkill, namespace?: string): Record<string, string> {
  const key = text(skill.key, "skill.key");
  return { key: namespace ? `${text(namespace, 'skill.namespace', 128)}:${key}` : key, version: text(skill.version, "skill.version"), sha256: digest(skill) };
}

function markedBy(value: OfficialSkillSummary): Record<string, unknown> | undefined {
  const config = value.config;
  if (!config || typeof config !== "object" || Array.isArray(config)) return undefined;
  const valueMarker = (config as Record<string, unknown>)[MARKER_KEY];
  return valueMarker && typeof valueMarker === "object" && !Array.isArray(valueMarker)
    ? valueMarker as Record<string, unknown> : undefined;
}

function sameFiles(actual: OfficialSkillFileLike[], wanted: Array<{ path: string; content: string }>): boolean {
  if (actual.length !== wanted.length) return false;
  return wanted.every((file, index) => actual[index]?.path === file.path && actual[index]?.content === file.content);
}

type OfficialSkillFileLike = { path: string; content: string };

function desiredConfig(skill: DshManagedSkill, enabled = true, namespace?: string): Record<string, unknown> {
  return { ...(skill.config ?? {}), [MARKER_KEY]: { ...marker(skill, namespace), enabled } };
}

function validateSkill(skill: DshManagedSkill): void {
  text(skill.key, "skill.key");
  text(skill.name, "skill.name");
  text(skill.version, "skill.version");
  if (typeof skill.content !== "string" || !skill.content.trim()) throw new Error("skill.content must be non-empty text");
  if (skill.content.length > 256 * 1024) throw new Error("Skill content exceeds 256 KiB");
  for (const file of skill.files ?? []) {
    safeFilePath(file.path);
    if (typeof file.content !== "string" || file.content.length > 1024 * 1024) throw new Error("Invalid Skill supporting file");
  }
}

/**
 * Synchronizes DSH declarations to the official Multica workspace and attaches
 * them to the stable session Agent. It never copies the user's project files.
 */
export class MulticaSkillDistributor {
  private readonly inFlight = new Map<string, Promise<SkillSyncResult>>();
  private readonly reload?: () => Promise<readonly DshManagedSkill[]>;
  private readonly persist?: (skills: readonly DshManagedSkill[]) => Promise<void>;
  private readonly namespace?: string;
  private declarations: readonly DshManagedSkill[];

  constructor(private readonly client: OfficialMulticaClient, declarations: readonly DshManagedSkill[], options: DshSkillDistributionOptions = {}) {
    this.validateDeclarations(declarations);
    this.declarations = [...declarations];
    this.reload = options.reload;
    this.persist = options.persist;
    this.namespace = options.namespace;
  }

  get skills(): readonly DshManagedSkill[] { return this.declarations; }

  /** Replace the DSH declaration snapshot for a tenant Host.  The next
   * syncAgent call applies it to the official Multica Agent; no project files
   * or CLI configuration are touched. */
  async replaceDeclarations(declarations: readonly DshManagedSkill[]): Promise<void> {
    this.validateDeclarations(declarations);
    await this.persist?.(declarations);
    this.declarations = [...declarations];
  }

  async listSkillStates(): Promise<DshSkillState[]> {
    await this.reloadDeclarations();
    const workspaceSkills = await this.client.listSkills();
    return this.declarations.map(declaration => {
      const matches = workspaceSkills.filter(skill => markedBy(skill)?.key === this.markerKey(declaration));
      if (matches.length > 1) throw new Error(`Multiple Multica Skills match DSH key ${declaration.key}`);
      const match = matches[0];
      const currentMarker = match ? markedBy(match) : undefined;
      const enabled = currentMarker?.enabled !== false;
      return {
        key: declaration.key,
        ...(match ? { id: match.id } : {}),
        name: declaration.name,
        version: declaration.version,
        description: declaration.description,
        attached: Boolean(match),
        enabled,
      };
    });
  }

  async setSkillEnabledGlobally(key: string, enabled: boolean): Promise<void> {
    await this.reloadDeclarations();
    text(key, "skill.key");
    if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean");
    const declaration = this.declarations.find(skill => skill.key === key);
    if (!declaration) throw new Error(`Unknown DSH Skill key: ${key}`);
    const workspaceSkills = await this.client.listSkills();
    const matches = workspaceSkills.filter(skill => markedBy(skill)?.key === this.markerKey(declaration));
    if (matches.length > 1) throw new Error(`Multiple Multica Skills match DSH key ${key}`);
    let skill = matches[0];
    if (!skill) {
      const sameName = workspaceSkills.find(item => item.name === this.multicaName(declaration));
      if (sameName) throw new Error(`Multica Skill name ${declaration.name} is already owned outside DSH`);
      skill = await this.client.createSkill({
        name: this.multicaName(declaration),
        description: declaration.description,
        content: declaration.content,
        config: desiredConfig(declaration, enabled, this.namespace),
        files: declaration.files ?? [],
      });
    } else {
      const full = await this.client.getSkill(skill.id);
      const config = full.config && typeof full.config === "object" && !Array.isArray(full.config)
        ? { ...(full.config as Record<string, unknown>) } : {};
      config[MARKER_KEY] = { ...(markedBy(skill) ?? this.marker(declaration)), enabled };
      await this.client.updateSkill(skill.id, { config });
    }

    // Apply the global setting immediately to every existing Agent. New
    // Agents are handled by syncAgent, which reads the marker above.
    const agents = await this.client.listAgents();
    for (const agent of agents) {
      const assigned = await this.client.listAgentSkills(agent.id);
      const match = assigned.find(item => markedBy(item)?.key === this.markerKey(declaration));
      if (match) await this.client.setAgentSkillEnabled(agent.id, match.id, enabled);
    }
  }

  syncAgent(agentId: string): Promise<SkillSyncResult> {
    text(agentId, "agentId");
    const existing = this.inFlight.get(agentId);
    if (existing) return existing;
    const operation = this.syncAgentOnce(agentId).finally(() => this.inFlight.delete(agentId));
    this.inFlight.set(agentId, operation);
    return operation;
  }

  private async syncAgentOnce(agentId: string): Promise<SkillSyncResult> {
    await this.reloadDeclarations();
    const workspaceSkills = await this.client.listSkills();
    const declaredKeys = new Set(this.declarations.map(skill => this.markerKey(skill)));
    const deleted: string[] = [];
    // DSH owns only Skills carrying our marker. A declaration removed from
    // the DSH source must not leave an orphaned Multica Skill behind. The
    // official DELETE cascades its Agent-Skill assignments for every session.
    for (const existing of workspaceSkills) {
      const key = markedBy(existing)?.key;
      if (typeof key === "string" && this.ownsMarker(key) && !declaredKeys.has(key)) {
        await this.client.deleteSkill(existing.id);
        deleted.push(existing.id);
      }
    }
    const results: SkillSyncResult["skills"] = [];
    for (const declaration of this.declarations) {
      const wantedMarker = this.marker(declaration);
      const matches = workspaceSkills.filter(skill => markedBy(skill)?.key === wantedMarker.key);
      if (matches.length > 1) throw new Error(`Multiple Multica Skills match DSH key ${declaration.key}`);
      const sameName = workspaceSkills.find(skill => skill.name === this.multicaName(declaration));
      let current = matches[0];
      if (!current && sameName) {
        throw new Error(`Multica Skill name ${declaration.name} is already owned outside DSH`);
      }
      let changed = false;
      const currentMarker = current ? markedBy(current) : undefined;
      const enabled = currentMarker?.enabled !== false;
      if (!current) {
        let created: OfficialSkill;
        try {
          created = await this.client.createSkill({
            name: this.multicaName(declaration),
            description: declaration.description,
            content: declaration.content,
            config: desiredConfig(declaration, enabled, this.namespace),
            files: declaration.files ?? [],
          });
        } catch (error) {
          // A concurrent creator may win between list and POST. Re-read and
          // adopt only a Skill carrying our exact DSH key.
          if (!(error instanceof MulticaApiError) || error.status !== 409) throw error;
          const afterConflict = (await this.client.listSkills()).filter(skill => markedBy(skill)?.key === wantedMarker.key);
          if (afterConflict.length !== 1) throw error;
          current = afterConflict[0];
          created = await this.client.getSkill(current.id);
        }
        current = created;
        changed = true;
      } else {
        const full = await this.client.getSkill(current.id);
        const wantedConfig = desiredConfig(declaration, enabled, this.namespace);
        const upToDate = full.content === declaration.content
          && full.description === declaration.description
          && JSON.stringify(full.config) === JSON.stringify(wantedConfig)
          && sameFiles(full.files, declaration.files ?? []);
        if (!upToDate) {
          current = await this.client.updateSkill(current.id, {
            name: this.multicaName(declaration),
            description: declaration.description,
            content: declaration.content,
            config: wantedConfig,
            files: declaration.files ?? [],
          });
          changed = true;
        }
      }
      results.push({ key: declaration.key, id: current.id, name: current.name, version: declaration.version, changed, enabled });
    }
    const assigned = await this.client.ensureAgentSkills(agentId, results.map(skill => skill.id));
    const assignedIds = assigned.map(skill => skill.id);
    for (const skill of results) {
      if (!assignedIds.includes(skill.id)) throw new Error(`Multica Agent did not attach Skill ${skill.id}`);
      if (!skill.enabled) await this.client.setAgentSkillEnabled(agentId, skill.id, false);
    }
    return { agentId, skills: results, assigned: assignedIds, deleted };
  }

  private validateDeclarations(declarations: readonly DshManagedSkill[]): void {
    const keys = new Set<string>();
    for (const skill of declarations) {
      validateSkill(skill);
      if (keys.has(skill.key)) throw new Error(`Duplicate DSH Skill key: ${skill.key}`);
      keys.add(skill.key);
    }
  }

  private marker(skill: DshManagedSkill): Record<string, string> { return marker(skill, this.namespace); }
  private markerKey(skill: DshManagedSkill): string { return this.marker(skill).key; }
  private ownsMarker(value: string): boolean { return !this.namespace || value.startsWith(`${this.namespace}:`); }
  /** Multica Skill names are workspace-global; namespace them when tenants share a workspace. */
  private multicaName(skill: DshManagedSkill): string {
    if (!this.namespace) return skill.name;
    const prefix = createHash('sha256').update(this.namespace).digest('hex').slice(0, 16);
    return `dsh-${prefix}-${skill.name}`.slice(0, 256);
  }

  private async reloadDeclarations(): Promise<void> {
    if (!this.reload) return;
    const declarations = await this.reload();
    this.validateDeclarations(declarations);
    this.declarations = [...declarations];
  }
}

/** Example DSH-managed Skill used by the local acceptance test and docs. */
export const ANIME_PHRASE_SKILL: DshManagedSkill = {
  key: "anime-phrase-transformer",
  name: "dsh-anime-phrase-transformer",
  version: "1.0.0",
  description: "把普通中文改写成克制、清晰、可读的二次元角色台词。",
  content: `# 二次元语句转化\n\n当用户要求“二次元化”“动漫语气”或“角色台词”时，按以下规则改写文本。\n\n- 保留原句的事实、任务、数字、代码和专有名词，不擅自增加结论。\n- 只改变表达语气：可以使用适度的角色感、节奏感和画面感，但不要堆砌中二词。\n- 默认输出两部分：\n  1. **改写结果**：一到三句自然台词。\n  2. **语气说明**：一句话说明使用了什么语气。\n- 用户没有要求改写时，正常回答，不主动把所有内容动漫化。\n- 不模仿现实人物，不生成仇恨、骚扰或露骨内容。\n\n示例：\n- 输入：请先运行测试，再提交代码。\n- 输出：改写结果：先让测试之火照过这份代码，确认无误后，再把它交给版本库吧。\n  语气说明：轻度冒险叙事风，保留了原任务顺序。\n`,
  config: { output_language: "zh-CN", style: "restrained-anime" },
};
