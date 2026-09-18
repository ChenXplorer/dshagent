import { MulticaAgent, type AgentHooks } from "./agent.ts";
import { MappingError } from "./errors.ts";
import type { BindingStore } from "./mapping.ts";
import { MemorySession } from "./session.ts";
import type {
  AgentFactory,
  AgentHandle,
  CreateAgentOptions,
  MulticaClient,
  PluginCatalog,
  ResumeAgentOptions,
} from "./types.ts";

export class MulticaRuntimeFactory implements AgentFactory {
  readonly bindings: BindingStore;
  private readonly agents = new Map<string, MulticaAgent>();
  private readonly sessions = new Map<string, MemorySession>();
  private readonly client: MulticaClient;
  private readonly catalog: PluginCatalog;
  private readonly hooks: AgentHooks;

  constructor(
    bindings: BindingStore,
    client: MulticaClient,
    catalog: PluginCatalog,
    hooks: AgentHooks,
  ) {
    this.bindings = bindings;
    this.client = client;
    this.catalog = catalog;
    this.hooks = hooks;
  }

  sessionOf(id: string): MemorySession | undefined {
    return this.sessions.get(id);
  }

  agentOf(id: string): MulticaAgent | undefined {
    return this.agents.get(id);
  }

  async createAgent(options: CreateAgentOptions): Promise<AgentHandle> {
    if (this.agents.has(options.sessionId)) {
      throw new MappingError(`Agent ${options.sessionId} already exists`);
    }
    const session = new MemorySession(options.sessionId, options.meta ?? {});
    this.sessions.set(session.id, session);
    const agent = new MulticaAgent(
      options.sessionId,
      options.agentOptions ?? {},
      session,
      this.bindings,
      this.client,
      this.catalog,
      this.hooks,
    );
    this.agents.set(agent.id, agent);
    this.bindings.ensure(agent.id);
    return {
      agent,
      dispose: async () => {
        agent.dispose();
        this.agents.delete(agent.id);
      },
    };
  }

  async resumeAgent(options: ResumeAgentOptions): Promise<AgentHandle> {
    const existing = this.agents.get(options.resumeSessionId);
    if (existing) {
      return {
        agent: existing,
        dispose: async () => {
          existing.dispose();
          this.agents.delete(existing.id);
        },
      };
    }
    return this.createAgent({
      sessionId: options.resumeSessionId,
      parentAgent: options.parentAgent,
      agentOptions: options.agentOptions,
      signal: options.signal,
    });
  }
}

export function installFactory(
  registry: { setFactory(factory: AgentFactory): () => void },
  factory: AgentFactory,
): () => void {
  return registry.setFactory(factory);
}
