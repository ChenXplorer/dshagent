// src/multica/official.ts
import { readFileSync } from "node:fs";

// src/plugin/capabilities.ts
var NATIVE_DSH_PROFILE = "dsh-native";
var PLATFORM_DSH_PROFILE = "dsh-platform";
var RUNTIME_MATRIX = {
  dsh: {
    label: "DSH",
    cli: "dsh",
    skillPath: ".dsh/skills/",
    mcpSupported: true,
    sessionResume: true,
    notes: [
      "Must run on a native profile that still has dsh-agent-loop.",
      "Never point a DSH runtime at the platform profile that loads this plugin."
    ]
  },
  codex: {
    label: "Codex",
    cli: "codex",
    skillPath: "$CODEX_HOME/skills/",
    mcpSupported: true,
    sessionResume: true,
    notes: ["Skills land in a per-run CODEX_HOME, never the machine-wide Codex dir."]
  },
  "claude-code": {
    label: "Claude Code",
    cli: "claude",
    skillPath: ".claude/skills/",
    mcpSupported: true,
    sessionResume: true,
    notes: ["Multica injects skills and MCP before the Claude CLI starts."]
  },
  pi: {
    label: "Pi",
    cli: "pi",
    skillPath: ".pi/skills/",
    mcpSupported: false,
    sessionResume: true,
    notes: [
      "Pi does not read Multica-managed MCP configuration.",
      "Session resume depends on a local session file on the original machine."
    ]
  }
};
function snapshotCapabilities(runtime, skills, mcp) {
  const row = RUNTIME_MATRIX[runtime];
  return {
    runtime,
    skills,
    mcp: row.mcpSupported ? mcp : [],
    mcpSupported: row.mcpSupported,
    skillPath: row.skillPath,
    sessionResume: row.sessionResume,
    notes: row.notes
  };
}

// src/plugin/errors.ts
var PluginError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "PluginError";
    this.code = code;
  }
};
var RecursionGuardError = class extends PluginError {
  constructor(profile) {
    super(
      "recursion_guard",
      `Runtime DSH cannot target profile "${profile}" because it loads this Multica plugin. Use a native profile that still has dsh-agent-loop.`
    );
    this.name = "RecursionGuardError";
  }
};
var MappingError = class extends PluginError {
  constructor(message) {
    super("mapping", message);
    this.name = "MappingError";
  }
};

// src/plugin/ids.ts
function createId(prefix) {
  const uuid = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}_${uuid}`;
}
function now() {
  return Date.now();
}

// src/sim/deepseek.ts
function dialectFor(runtime) {
  return runtime === "claude-code" ? "anthropic" : "openai";
}

// src/multica/official.ts
var HEARTBEAT_GRACE_MS = 45e3;
function loadOfficialConfig() {
  let token = process.env["MULTICA_TOKEN"] ?? "";
  let workspaceId = process.env["MULTICA_WORKSPACE_ID"] ?? "";
  try {
    if (!token) token = readFileSync("/opt/multica-official/pat.token", "utf8").trim();
    if (!workspaceId) {
      workspaceId = readFileSync("/opt/multica-official/workspace.id", "utf8").trim();
    }
  } catch {
  }
  if (!token || !workspaceId) return void 0;
  const fromEnv = (process.env["MULTICA_OFFICIAL_URL"] || process.env["MULTICA_SERVER_URL"] || "").replace(/\/$/, "");
  const baseUrl = fromEnv && !fromEnv.includes("/api/multica") ? fromEnv : "http://127.0.0.1:18080";
  return { baseUrl, token, workspaceId };
}
function runtimeKindFromHeader(header) {
  const value = header.toLowerCase();
  if (value.includes("codex")) return "codex";
  if (value.includes("claude")) return "claude-code";
  if (value.includes("pi")) return "pi";
  if (value.includes("dsh") || value.includes("deepseek")) return "dsh";
  return void 0;
}
var OfficialMulticaPlane = class {
  kind = "official";
  ackDropArmed = false;
  lastSubmit;
  baseUrl;
  token;
  workspaceId;
  fetchImpl;
  tasks = /* @__PURE__ */ new Map();
  byRequest = /* @__PURE__ */ new Map();
  listeners = /* @__PURE__ */ new Map();
  agentCache = /* @__PURE__ */ new Map();
  sessionCache = /* @__PURE__ */ new Map();
  chatBySession = /* @__PURE__ */ new Map();
  follow = /* @__PURE__ */ new Map();
  constructor(config, fetchImpl) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.token = config.token;
    this.workspaceId = config.workspaceId;
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
  }
  async snapshotLive() {
    const runtimes = await this.officialRuntimes();
    const online = runtimes.filter((row) => this.isOnline(row));
    const kinds = new Set(
      online.map((row) => runtimeKindFromHeader(row.launch_header ?? row.name ?? "")).filter(Boolean)
    );
    return {
      live: online.length > 0,
      provider: "deepseek",
      model: "deepseek-flash",
      dialects: {
        dsh: dialectFor("dsh"),
        codex: dialectFor("codex"),
        "claude-code": dialectFor("claude-code"),
        pi: dialectFor("pi")
      },
      plane: "official",
      executors: {
        dsh: kinds.has("dsh") ? "official-daemon" : "unavailable",
        codex: kinds.has("codex") ? "official-daemon" : "unavailable",
        "claude-code": kinds.has("claude-code") ? "official-daemon" : "unavailable",
        pi: kinds.has("pi") ? "official-daemon" : "unavailable"
      },
      binaries: {
        codex: kinds.has("codex"),
        claude: kinds.has("claude-code")
      },
      daemon: {
        online: online.length > 0,
        count: 1,
        machines: [
          {
            machineId: "official-daemon",
            online: online.length > 0,
            tools: [...kinds],
            lastHeartbeat: Date.now(),
            ageMs: 0
          }
        ]
      }
    };
  }
  async listRuntimes() {
    const official = await this.officialRuntimes();
    const rows = [];
    for (const item of official) {
      const kind = runtimeKindFromHeader(item.launch_header ?? item.name ?? "");
      if (!kind) continue;
      rows.push({
        id: item.id,
        runtime: kind,
        machineId: "cube-personal",
        environment: "personal-persistent",
        nativeProfile: kind === "dsh" ? NATIVE_DSH_PROFILE : void 0,
        online: this.isOnline(item)
      });
    }
    return rows;
  }
  async ensureAgent(input) {
    if (input.runtime === "dsh" && input.nativeProfile !== NATIVE_DSH_PROFILE) {
      throw new RecursionGuardError(input.nativeProfile ?? PLATFORM_DSH_PROFILE);
    }
    const key = `${input.runtime}:${input.machineId}:${input.nativeProfile ?? ""}`;
    const cached = this.agentCache.get(key);
    if (cached) return cached;
    const runtimeId = await this.runtimeIdFor(input.runtime);
    const agents = await this.json("GET", "/api/agents");
    let found = agents.find((agent) => agent.runtime_id === runtimeId);
    if (!found) {
      found = await this.json("POST", "/api/agents", {
        name: input.runtime === "claude-code" ? "Claude" : title(input.runtime),
        runtime_id: runtimeId,
        visibility: "workspace",
        instructions: "You are a coding agent. Keep answers short."
      });
    }
    await this.ensureAgentEnv(found.id);
    const ref = {
      id: found.id,
      runtime: input.runtime,
      machineId: input.machineId
    };
    this.agentCache.set(key, ref);
    return ref;
  }
  async ensureSession(input) {
    const key = `${input.agentId}:${input.segmentId}`;
    const existing = this.sessionCache.get(key);
    if (existing) return existing;
    if (input.resumeCliSessionId) {
      const created2 = {
        id: input.resumeCliSessionId,
        agentId: input.agentId,
        cliSessionId: input.resumeCliSessionId
      };
      this.sessionCache.set(key, created2);
      this.chatBySession.set(created2.id, input.resumeCliSessionId);
      return created2;
    }
    const chat = await this.json("POST", "/api/chat/sessions", {
      agent_id: input.agentId,
      title: `dsh ${input.dshSessionId.slice(0, 8)}`
    });
    const created = {
      id: chat.id,
      agentId: input.agentId,
      cliSessionId: chat.id
    };
    this.sessionCache.set(key, created);
    this.chatBySession.set(created.id, chat.id);
    return created;
  }
  async submitTask(input) {
    if (input.runtime === "dsh" && input.nativeProfile !== NATIVE_DSH_PROFILE) {
      throw new RecursionGuardError(input.nativeProfile ?? PLATFORM_DSH_PROFILE);
    }
    this.lastSubmit = input;
    const existingId = this.byRequest.get(input.clientRequestId);
    if (existingId) {
      if (this.ackDropArmed) {
        this.ackDropArmed = false;
        return { status: "unknown", clientRequestId: input.clientRequestId };
      }
      return {
        status: "accepted",
        taskId: existingId,
        sessionId: this.tasks.get(existingId)?.sessionId ?? input.sessionId ?? existingId
      };
    }
    const chatId = input.sessionId ? this.chatBySession.get(input.sessionId) ?? input.sessionId : void 0;
    if (!chatId) throw new Error("official chat session is missing");
    const sent = await this.json(
      "POST",
      `/api/chat/sessions/${encodeURIComponent(chatId)}/messages`,
      { content: input.prompt }
    );
    const taskId = sent.task_id;
    const task = {
      id: taskId,
      clientRequestId: input.clientRequestId,
      status: "queued",
      sessionId: input.sessionId,
      cliSessionId: input.resumeCliSessionId,
      events: []
    };
    this.tasks.set(taskId, task);
    this.byRequest.set(input.clientRequestId, taskId);
    this.follow.set(taskId, { agentId: input.agentId, chatId });
    this.note(task, this.ev(taskId, "task/accepted", { clientRequestId: input.clientRequestId }));
    this.note(
      task,
      this.ev(taskId, "task/started", {
        cwd: input.cwd,
        cli: input.runtime,
        dialect: dialectFor(input.runtime),
        plane: "official"
      })
    );
    void this.pollTask(taskId, input.runtime);
    if (this.ackDropArmed) {
      this.ackDropArmed = false;
      return { status: "unknown", clientRequestId: input.clientRequestId };
    }
    return { status: "accepted", taskId, sessionId: input.sessionId ?? taskId };
  }
  async cancelTask(taskId) {
    const task = this.tasks.get(taskId);
    try {
      await this.json("POST", `/api/tasks/${encodeURIComponent(taskId)}/cancel`);
    } catch {
    }
    if (task && task.status !== "completed" && task.status !== "failed") {
      task.status = "canceled";
      this.note(task, this.ev(taskId, "task/canceled", { plane: "official" }));
    }
  }
  async getTask(taskId) {
    const task = this.tasks.get(taskId);
    return task ? { ...task, events: [...task.events] } : void 0;
  }
  async getTaskByClientRequestId(clientRequestId) {
    const id = this.byRequest.get(clientRequestId);
    return id ? this.getTask(id) : void 0;
  }
  subscribe(taskId, handler) {
    const set = this.listeners.get(taskId) ?? /* @__PURE__ */ new Set();
    set.add(handler);
    this.listeners.set(taskId, set);
    const existing = this.tasks.get(taskId);
    if (existing) {
      for (const event of existing.events) handler(event);
    }
    return () => {
      this.listeners.get(taskId)?.delete(handler);
    };
  }
  dropNextAck() {
    this.ackDropArmed = true;
  }
  async pollTask(taskId, runtime) {
    const meta = this.follow.get(taskId);
    const task = this.tasks.get(taskId);
    if (!meta || !task) return;
    let lastSeq = 0;
    let assistant = "";
    for (let i = 0; i < 300; i += 1) {
      if (task.status === "canceled") return;
      try {
        const messages = await this.json(
          "GET",
          `/api/tasks/${encodeURIComponent(taskId)}/messages`
        );
        for (const message of messages) {
          if (message.seq <= lastSeq) continue;
          lastSeq = message.seq;
          if (message.type === "tool_use") {
            this.note(
              task,
              this.ev(taskId, "tool/call", {
                name: message.tool ?? "tool",
                args: message.input ?? {}
              })
            );
          } else if (message.type === "tool_result") {
            this.note(
              task,
              this.ev(taskId, "tool/result", {
                name: message.tool ?? "tool",
                preview: (message.output ?? "").slice(0, 400)
              })
            );
          } else if (message.type === "text" || message.type === "agent_message" || message.type === "assistant") {
            const text = message.text ?? message.content ?? message.output ?? "";
            if (text) {
              assistant += text;
              this.note(task, this.ev(taskId, "text/delta", { text }));
            }
          }
        }
        const rows = await this.json(
          "GET",
          `/api/agents/${encodeURIComponent(meta.agentId)}/tasks`
        );
        const row = rows.find((item) => item.id === taskId);
        if (row?.status === "completed") {
          const text = assistant || row.result?.output || await this.latestAssistant(meta.chatId) || "(empty model reply)";
          this.note(
            task,
            this.ev(taskId, "text/committed", {
              text,
              executor: "official-daemon",
              plane: "official",
              runtime
            })
          );
          this.note(task, this.ev(taskId, "task/completed", { plane: "official" }));
          return;
        }
        if (row?.status === "failed") {
          this.note(
            task,
            this.ev(taskId, "task/failed", {
              message: row.error || "official task failed",
              plane: "official"
            })
          );
          return;
        }
        if (row?.status === "cancelled" || row?.status === "canceled") {
          this.note(task, this.ev(taskId, "task/canceled", { plane: "official" }));
          return;
        }
      } catch {
      }
      await sleep(400);
    }
    this.note(task, this.ev(taskId, "task/failed", { message: "official poll timed out" }));
  }
  async latestAssistant(chatId) {
    try {
      const messages = await this.json(
        "GET",
        `/api/chat/sessions/${encodeURIComponent(chatId)}/messages`
      );
      const assistant = [...messages].reverse().find((row) => row.role === "assistant");
      return assistant?.content ?? "";
    } catch {
      return "";
    }
  }
  async runtimeIdFor(kind) {
    const runtimes = await this.officialRuntimes();
    const match = runtimes.find(
      (row) => runtimeKindFromHeader(row.launch_header ?? row.name ?? "") === kind && this.isOnline(row)
    );
    if (!match) {
      throw new Error(`\u5B98\u65B9 Daemon \u4E0A\u6CA1\u6709\u5728\u7EBF\u7684 ${kind} runtime`);
    }
    return match.id;
  }
  async officialRuntimes() {
    return this.json("GET", "/api/runtimes");
  }
  isOnline(row) {
    if (!row.last_seen_at) return true;
    const seen = Date.parse(row.last_seen_at);
    if (Number.isNaN(seen)) return true;
    return Date.now() - seen < HEARTBEAT_GRACE_MS;
  }
  async ensureAgentEnv(agentId) {
    const key = process.env["DEEPSEEK_API_KEY"] ?? "";
    const custom_env = {
      CODEX_HOME: process.env["CODEX_HOME"] ?? "/workspace/.runtime/codex-home",
      CLAUDE_CONFIG_DIR: process.env["CLAUDE_CONFIG_DIR"] ?? "/workspace/.runtime/claude-home"
    };
    if (key) custom_env["DEEPSEEK_API_KEY"] = key;
    await this.json("PUT", `/api/agents/${encodeURIComponent(agentId)}/env`, { custom_env });
  }
  note(task, event) {
    if (event.type === "task/started") task.status = "running";
    if (event.type === "task/completed") task.status = "completed";
    if (event.type === "task/failed") task.status = "failed";
    if (event.type === "task/canceled") task.status = "canceled";
    task.events.push(event);
    for (const listener of this.listeners.get(task.id) ?? []) listener(event);
  }
  ev(taskId, type, data = {}) {
    return { id: createId("ev"), taskId, type, time: now(), data };
  }
  async json(method, path, body) {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.token}`,
        "X-Workspace-ID": this.workspaceId,
        ...body !== void 0 ? { "Content-Type": "application/json" } : {}
      },
      body: body !== void 0 ? JSON.stringify(body) : void 0
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`official ${method} ${path} ${response.status}: ${text}`);
    }
    if (response.status === 204) return void 0;
    return await response.json();
  }
};
function title(runtime) {
  return runtime.charAt(0).toUpperCase() + runtime.slice(1);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// src/plugin/dsh-native.ts
import { emitAgentEvent } from "@deepseek-ai/dsh-agent";
import { createAssistantMessage } from "@deepseek-ai/dsh-llm";
import { createScope } from "@deepseek-ai/dsh-scope";

// src/plugin/mapping.ts
var BindingStore = class {
  bySession = /* @__PURE__ */ new Map();
  get(sessionId) {
    return this.bySession.get(sessionId);
  }
  require(sessionId) {
    const binding = this.bySession.get(sessionId);
    if (!binding) {
      throw new MappingError(`No binding for DSH session ${sessionId}`);
    }
    return binding;
  }
  ensure(sessionId) {
    const existing = this.bySession.get(sessionId);
    if (existing) return existing;
    const created = { dshSessionId: sessionId, segments: [] };
    this.bySession.set(sessionId, created);
    return created;
  }
  current(sessionId) {
    const binding = this.require(sessionId);
    const segment = binding.segments.at(-1);
    if (!segment || segment.closedAt) {
      throw new MappingError(
        `DSH session ${sessionId} has no open execution segment`
      );
    }
    return segment;
  }
  currentOrNull(sessionId) {
    const binding = this.bySession.get(sessionId);
    const segment = binding?.segments.at(-1);
    if (!segment || segment.closedAt) return void 0;
    return segment;
  }
  openSegment(sessionId, selection) {
    const binding = this.ensure(sessionId);
    const previous = binding.segments.at(-1);
    if (previous && !previous.closedAt) {
      if (previous.status === "running" || previous.status === "canceling") {
        throw new MappingError(
          "Cannot open a new segment while a task is still in flight"
        );
      }
      previous.closedAt = now();
      previous.status = previous.status === "unknown" ? "unknown" : "idle";
    }
    const segment = {
      id: createId("seg"),
      runtime: selection.runtime,
      environment: selection.environment,
      cwd: selection.cwd,
      machineId: selection.machineId,
      nativeProfile: selection.nativeProfile,
      status: "idle",
      openedAt: now()
    };
    binding.segments.push(segment);
    return segment;
  }
  bindMultica(sessionId, refs) {
    const segment = this.current(sessionId);
    segment.multicaAgentId = refs.agentId;
    segment.multicaSessionId = refs.sessionId;
    return segment;
  }
  bindTask(sessionId, taskId, clientRequestId) {
    const segment = this.current(sessionId);
    segment.currentTaskId = taskId;
    segment.clientRequestId = clientRequestId;
    segment.status = "running";
    return segment;
  }
  markUnknown(sessionId, clientRequestId) {
    const segment = this.current(sessionId);
    segment.clientRequestId = clientRequestId;
    segment.currentTaskId = void 0;
    segment.status = "unknown";
    return segment;
  }
  setStatus(sessionId, status) {
    const segment = this.current(sessionId);
    segment.status = status;
    if (status === "idle" || status === "failed") {
      segment.currentTaskId = status === "idle" ? void 0 : segment.currentTaskId;
    }
    return segment;
  }
  list() {
    return [...this.bySession.values()];
  }
};

// src/plugin/events.ts
function composeTaskPrompt(userText, handoff) {
  if (!handoff || handoff.summary === "(empty session)") return userText;
  return [
    "HANDOFF",
    `from: ${handoff.from}`,
    `to: ${handoff.to}`,
    "---",
    handoff.summary,
    "---",
    userText
  ].join("\n");
}

// src/plugin/skills.ts
function planCapabilitySync(runtime, skills, mcp) {
  return snapshotCapabilities(runtime, skills, mcp);
}

// src/plugin/reconcile.ts
var RETRIES = 8;
var DEFAULT_WAIT_MS = 25;
async function submitWithReconcile(client, input, options) {
  const submitted = await client.submitTask(input);
  if (submitted.status === "accepted") return submitted;
  const waitMs = options?.waitMs ?? DEFAULT_WAIT_MS;
  const retries = options?.retries ?? RETRIES;
  let last;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    last = await client.getTaskByClientRequestId(input.clientRequestId);
    if (last && last.status !== "unknown" && last.id) {
      return {
        status: "accepted",
        taskId: last.id,
        sessionId: last.sessionId ?? input.sessionId ?? ""
      };
    }
    await sleep2(waitMs * (attempt + 1));
  }
  throw new Error(
    `Task submit state unknown after reconcile (clientRequestId=${input.clientRequestId}, last=${last?.status ?? "missing"})`
  );
}
function sleep2(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// src/plugin/dsh-native.ts
var DshNativeFactory = class {
  constructor(pluginCtx, client, config = {}) {
    this.pluginCtx = pluginCtx;
    this.client = client;
    this.config = config;
  }
  pluginCtx;
  client;
  config;
  async createAgent(ownerCtx, options) {
    ownerCtx.fiber?.assertActive?.();
    const live = this.reuseLive(options.sessionId);
    if (live) return live;
    const attached = this.attachedSession(ownerCtx, options.sessionId);
    if (attached) {
      return this.publish(ownerCtx, options.sessionId, attached, options, void 0, "startup");
    }
    const cwd = options.meta?.cwd && options.meta.cwd.startsWith("/") ? options.meta.cwd : process.cwd();
    const session = this.pluginCtx.sessions.prepare(options.sessionId, {
      ...options.seed === void 0 ? {} : { seed: options.seed },
      ...options.inheritedEventCount === void 0 ? {} : { inheritedEventCount: options.inheritedEventCount },
      meta: { cwd, ...options.meta }
    });
    const persistence = this.persistence(ownerCtx);
    let stored;
    try {
      stored = persistence?.create ? await persistence.create(session.header, {
        inheritedEventCount: session.inheritedEventCount,
        ...options.signal === void 0 ? {} : { signal: options.signal }
      }) : void 0;
    } catch (error) {
      if (isAlreadyExists(error)) {
        return this.resume(ownerCtx, {
          resumeSessionId: options.sessionId,
          agentOptions: options.agentOptions,
          parentAgent: options.parentAgent,
          setup: options.setup,
          signal: options.signal
        });
      }
      throw error;
    }
    try {
      return await this.publish(ownerCtx, options.sessionId, session, options, stored, "startup", 0);
    } catch (error) {
      await stored?.close?.().catch(() => {
      });
      throw error;
    }
  }
  async resume(ownerCtx, options) {
    ownerCtx.fiber?.assertActive?.();
    const id = options.resumeSessionId;
    const live = this.reuseLive(id);
    if (live) return live;
    const attached = this.attachedSession(ownerCtx, id);
    if (attached) {
      const persistence2 = this.persistence(ownerCtx);
      let stored;
      try {
        stored = persistence2?.open ? await persistence2.open(id, "write", options.signal === void 0 ? void 0 : { signal: options.signal }) : void 0;
      } catch {
        stored = void 0;
      }
      return this.publish(ownerCtx, id, attached, options, stored, "resume");
    }
    const persistence = this.persistence(ownerCtx);
    if (!persistence?.open) {
      throw new Error("cannot resume: session persistence is not configured (load a dsh-session-persistence backend)");
    }
    const handle = await persistence.open(id, "write", options.signal === void 0 ? void 0 : { signal: options.signal });
    try {
      const coldRead = await handle.read?.(
        0,
        Number.MAX_SAFE_INTEGER,
        options.signal === void 0 ? void 0 : { signal: options.signal }
      );
      const persisted = Array.isArray(coldRead?.events) ? coldRead.events : [];
      const closers = interruptedClosers(persisted);
      if (closers.length > 0 && handle.append) await handle.append(closers);
      const eventState = coldRead?.eventState;
      const session = this.pluginCtx.sessions.prepare(id, {
        seed: [...persisted, ...closers],
        meta: handle.header ? structuredClone(handle.header) : void 0,
        inheritedEventCount: handle.inheritedEventCount,
        ...eventState === "detached" || eventState === "shared-frozen" ? { eventState } : {}
      });
      return await this.publish(ownerCtx, id, session, options, handle, "resume", persisted.length + closers.length);
    } catch (error) {
      await handle.close?.().catch(() => {
      });
      throw error;
    }
  }
  persistence(_ownerCtx) {
    const value = this.pluginCtx.get?.("sessionPersistence");
    if (!value || typeof value !== "object") return void 0;
    return value;
  }
  reuseLive(id) {
    const agent = this.pluginCtx.agents.get?.(id);
    if (!agent || typeof agent !== "object") return void 0;
    if (!("followup" in agent)) return void 0;
    return { agent, dispose: async () => {
    } };
  }
  attachedSession(_ownerCtx, id) {
    return this.pluginCtx.sessions.get?.(id);
  }
  async publish(ownerCtx, id, session, options, stored, source, storedCount = 0) {
    const agent = new DshNativeAgent(
      this.pluginCtx,
      id,
      options.agentOptions ?? {},
      session,
      this.client,
      this.config
    );
    try {
      if (options.setup) {
        const commit = await options.setup(agent.ctx, agent);
        commit?.commit?.();
      }
      await flushUnstored(stored, session, storedCount);
    } catch (error) {
      await stored?.close?.().catch(() => {
      });
      await agent.scope.dispose().catch(() => {
      });
      throw error;
    }
    let detachSession;
    let detachAgent;
    let unfollowOwner;
    let disposing;
    const dispose = async () => {
      disposing ??= (async () => {
        agent.cancel({ kind: "disposed" });
        await agent.whenIdle();
        detachAgent?.();
        detachSession?.();
        await stored?.close?.().catch(() => {
        });
        await agent.scope.dispose();
        try {
          unfollowOwner?.();
        } catch {
        }
      })();
      return disposing;
    };
    try {
      unfollowOwner = ownerCtx.effect(() => () => {
        void dispose();
      }, `dsh-multica-runtime.lifecycle(${id})`) ?? void 0;
      detachSession = agent.ctx.sessions.enter(session);
      detachAgent = this.pluginCtx.agents.enter(agent, options.parentAgent);
      agent.ctx.sessions.announce(session);
      this.pluginCtx.agents.announce(agent);
      emitAgentEvent(agent.ctx, agent, "agent/session-start", { source });
      return { agent, dispose };
    } catch (error) {
      await dispose().catch(() => {
      });
      throw error;
    }
  }
};
var DshNativeAgent = class {
  id;
  options;
  session;
  inbox;
  scope;
  ctx;
  bindings = new BindingStore();
  status = "idle";
  disposed = false;
  turn = 0;
  driveChain = Promise.resolve();
  idleWaiters = [];
  cancelCause;
  activeUnsub;
  client;
  config;
  catalog;
  constructor(ownerCtx, id, options, session, client, config) {
    this.id = id;
    this.options = options;
    this.session = session;
    this.client = client;
    this.config = config;
    this.catalog = config.catalog ?? { skills: [], mcp: [] };
    this.turn = lastTurnNumber(sessionEvents(session));
    this.scope = createScope(ownerCtx, this);
    this.ctx = this.scope.ctx;
    this.inbox = new NativeInbox((message, kind, turn) => {
      if (kind === "inserted") {
        emitAgentEvent(this.ctx, this, "agent/inbox/inserted", { message });
      } else if (kind === "discarded") {
        emitAgentEvent(this.ctx, this, "agent/inbox/discarded", { message });
      } else {
        emitAgentEvent(this.ctx, this, "agent/inbox/claimed", { message, turn });
      }
    });
    this.bindings.ensure(this.id);
    this.bindings.openSegment(this.id, {
      runtime: config.runtime ?? "codex",
      environment: config.environment ?? "personal-persistent",
      machineId: config.machineId ?? "cube-personal",
      cwd: session.header.cwd ?? process.cwd()
    });
  }
  send(message, target, wakeup) {
    this.inbox.append(target, message);
    if (wakeup) this.wake();
  }
  followup(message) {
    this.send(message, "next-turn", true);
  }
  steer(message) {
    this.send(message, "next-step", true);
  }
  inject(message) {
    this.send(message, "next-step", false);
  }
  cancel(cause, options) {
    this.cancelCause = cause;
    if (cause && typeof cause === "object" && "kind" in cause && cause.kind === "disposed") {
      this.disposed = true;
    }
    if (!options?.keepInbox) this.inbox.clear();
    const segment = this.bindings.currentOrNull(this.id);
    if (segment?.currentTaskId) {
      void this.client.cancelTask(segment.currentTaskId);
    }
    this.activeUnsub?.();
    this.activeUnsub = void 0;
  }
  async runMaintenance(task) {
    if (this.status !== "idle") throw new Error(`agent "${this.id}" already has active work`);
    const controller = new AbortController();
    return task(controller.signal);
  }
  whenIdle() {
    if (this.status === "idle") return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }
  wake() {
    if (this.disposed) return;
    if (this.status === "idle") {
      this.status = "running";
      emitAgentEvent(this.ctx, this, "agent/status", { status: "running" });
    }
    this.driveChain = this.driveChain.then(() => this.drain()).catch((error) => {
      this.session.append("turn/end", {
        turn: this.turn,
        reason: {
          kind: "error",
          error: { message: error instanceof Error ? error.message : String(error), code: "UNKNOWN" }
        }
      });
      this.becomeIdle();
    });
  }
  async drain() {
    while (!this.disposed) {
      const claimed = this.inbox.claim("next-turn", this.turn + 1);
      if (claimed.length === 0) break;
      this.cancelCause = void 0;
      await this.runTurn(claimed);
    }
    this.becomeIdle();
  }
  async runTurn(messages) {
    const selection = this.bindings.current(this.id);
    if (selection.runtime === "dsh" && (selection.nativeProfile ?? PLATFORM_DSH_PROFILE) !== NATIVE_DSH_PROFILE) {
      throw new RecursionGuardError(selection.nativeProfile ?? PLATFORM_DSH_PROFILE);
    }
    this.turn += 1;
    const turn = this.turn;
    this.session.append("turn/start", { turn });
    for (const message of messages) {
      this.session.append("user/message", message, { surfaceOp: "append" });
    }
    this.session.append("step/start", { turn, step: 1 });
    const prompt = composeTaskPrompt(messages.map(messageText).join("\n\n"));
    const capabilities = planCapabilitySync(selection.runtime, this.catalog.skills, this.catalog.mcp);
    const agent = await this.client.ensureAgent({
      runtime: selection.runtime,
      machineId: selection.machineId,
      nativeProfile: selection.nativeProfile
    });
    const session = await this.client.ensureSession({
      agentId: agent.id,
      dshSessionId: this.id,
      segmentId: selection.id,
      resumeCliSessionId: selection.multicaSessionId
    });
    this.bindings.bindMultica(this.id, { agentId: agent.id, sessionId: session.id });
    const clientRequestId = createId("req");
    this.bindings.markUnknown(this.id, clientRequestId);
    const accepted = await submitWithReconcile(this.client, {
      clientRequestId,
      agentId: agent.id,
      sessionId: session.id,
      resumeCliSessionId: session.cliSessionId,
      prompt,
      cwd: selection.cwd,
      runtime: selection.runtime,
      machineId: selection.machineId,
      nativeProfile: selection.nativeProfile,
      skills: capabilities.skills,
      mcp: capabilities.mcp
    });
    this.bindings.bindTask(this.id, accepted.taskId, clientRequestId);
    await this.consume(accepted.taskId, turn);
  }
  consume(taskId, turn) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        this.activeUnsub?.();
        this.activeUnsub = void 0;
        if (error) reject(error);
        else resolve();
      };
      this.activeUnsub = this.client.subscribe(taskId, (event) => {
        try {
          if (event.type === "text/committed") {
            const text = String(event.data["text"] ?? "");
            this.session.append(
              "assistant/message",
              {
                turn,
                step: 1,
                message: createAssistantMessage({
                  content: [{ type: "text", text }],
                  source: {
                    provider: this.options.provider ?? "deepseek-official",
                    model: this.options.model ?? "deepseek-flash"
                  }
                }),
                stream: []
              },
              { surfaceOp: "append" }
            );
          }
          if (event.type === "task/completed") {
            this.session.append("step/end", { turn, step: 1 });
            this.session.append("turn/end", { turn, reason: { kind: "completed" } });
            this.bindings.setStatus(this.id, "idle");
            finish();
          } else if (event.type === "task/failed") {
            this.session.append("step/end", { turn, step: 1 });
            this.session.append("turn/end", {
              turn,
              reason: {
                kind: "error",
                error: { message: String(event.data["message"] ?? "task failed"), code: "UNKNOWN" }
              }
            });
            finish();
          } else if (event.type === "task/canceled") {
            this.session.append("step/end", { turn, step: 1 });
            this.session.append("turn/end", {
              turn,
              reason: { kind: "aborted", reason: { kind: "user" } }
            });
            finish();
          }
        } catch (error) {
          finish(error);
        }
      });
      if (this.cancelCause) {
        void this.client.cancelTask(taskId).finally(() => finish());
      }
    });
  }
  becomeIdle() {
    this.status = "idle";
    emitAgentEvent(this.ctx, this, "agent/status", { status: "idle" });
    const waiters = this.idleWaiters.splice(0);
    for (const waiter of waiters) waiter();
  }
};
function messageText(message) {
  if ("text" in message && typeof message.text === "string" && message.text) return message.text;
  const content = message.content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => typeof block.text === "string" ? block.text : "").filter(Boolean).join("\n");
}
var NativeInbox = class {
  constructor(notify) {
    this.notify = notify;
  }
  notify;
  lists = {
    "next-turn": [],
    "next-step": []
  };
  get nextTurn() {
    return this.lists["next-turn"];
  }
  get nextStep() {
    return this.lists["next-step"];
  }
  append(target, message) {
    this.lists[target].push(message);
    this.notify(message, "inserted");
  }
  clear() {
    for (const target of ["next-step", "next-turn"]) {
      const removed = this.lists[target].splice(0);
      for (const message of removed) this.notify(message, "discarded");
    }
  }
  claim(target, turn) {
    const claimed = this.lists["next-step"].splice(0);
    if (target === "next-turn") claimed.push(...this.lists["next-turn"].splice(0, 1));
    for (const message of claimed) this.notify(message, "claimed", turn);
    return claimed;
  }
};
function sessionEvents(session) {
  if (typeof session.snapshotEvents === "function") {
    try {
      const snap = session.snapshotEvents();
      return Array.isArray(snap) ? [...snap] : [];
    } catch {
      return [];
    }
  }
  return Array.isArray(session.events) ? [...session.events] : [];
}
function lastTurnNumber(events) {
  let turn = 0;
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const rec = event;
    if (rec.type !== "turn/start" && rec.type !== "turn/end") continue;
    const n = rec.data?.turn;
    if (typeof n === "number" && Number.isFinite(n) && n > turn) turn = n;
  }
  return turn;
}
function interruptedClosers(events) {
  let openTurn = null;
  let openStep = null;
  let last = null;
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const rec = event;
    if (typeof rec.seq === "number") {
      last = { seq: rec.seq, time: typeof rec.time === "number" ? rec.time : 0 };
    }
    if (rec.type === "turn/start") {
      openTurn = typeof rec.data?.turn === "number" ? rec.data.turn : openTurn;
      openStep = null;
    } else if (rec.type === "turn/end") {
      openTurn = null;
      openStep = null;
    } else if (rec.type === "step/start") {
      openStep = typeof rec.data?.step === "number" ? rec.data.step : openStep;
    } else if (rec.type === "step/end") {
      openStep = null;
    }
  }
  if (openTurn === null || last === null) return [];
  const closers = [];
  let seq = last.seq + 1;
  if (openStep !== null) {
    closers.push({ type: "step/end", seq, time: last.time, data: { turn: openTurn, step: openStep } });
    seq += 1;
  }
  closers.push({
    type: "turn/end",
    seq,
    time: last.time,
    data: { turn: openTurn, reason: { kind: "interrupted" } }
  });
  return closers;
}
function isAlreadyExists(error) {
  if (!error || typeof error !== "object") return false;
  const name2 = "name" in error ? String(error.name) : "";
  const message = "message" in error ? String(error.message) : String(error);
  return name2 === "SessionAlreadyExistsError" || /already exists/i.test(message);
}
async function flushUnstored(stored, session, storedCount) {
  if (!stored?.append) return;
  const events = sessionEvents(session);
  if (events.length <= storedCount) return;
  await stored.append([...events.slice(storedCount)]);
}
function applyNative(ctx, client, config = {}) {
  const factory = new DshNativeFactory(ctx, client, config);
  ctx.effect(() => ctx.agents.setFactory(factory), "dsh-multica-runtime.setFactory()");
  const installOwnsHost = (owner) => {
    const webServer = owner.get?.("webServer") ?? owner.webServer;
    if (typeof webServer?.tapIndex !== "function") return;
    owner.effect(
      () => webServer.tapIndex((html) => {
        if (html.includes("__DSH_TRANSPORT__")) return html;
        return html.replace(
          /<head([^>]*)>/i,
          `<head$1><script>globalThis.__DSH_TRANSPORT__=Object.assign(globalThis.__DSH_TRANSPORT__||{},{ownsHost:true});</script>`
        );
      }),
      "dsh-multica-runtime.ownsHost"
    );
  };
  if (typeof ctx.inject === "function") ctx.inject(["webServer"], installOwnsHost);
  else installOwnsHost(ctx);
  return factory;
}

// dsh-multica-runtime/entry.ts
var name = "dsh-multica-runtime";
var inject = ["agents", "sessions"];
var LOOP_ROW_ID = "agent-loop";
var PLUGIN_ID = "multica-runtime";
function apply(ctx, config = {}) {
  const official = loadOfficialConfig();
  if (!official) {
    throw new Error(
      "dsh-multica-runtime: official Multica is not configured (token / workspace id missing)"
    );
  }
  const client = new OfficialMulticaPlane(official);
  return applyNative(ctx, client, config);
}
export {
  LOOP_ROW_ID,
  PLUGIN_ID,
  apply,
  inject,
  name
};
