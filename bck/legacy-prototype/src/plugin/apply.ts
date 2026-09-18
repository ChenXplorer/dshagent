import type { AgentHooks } from "./agent.ts";
import { MulticaRuntimeFactory, installFactory } from "./factory.ts";
import { BindingStore } from "./mapping.ts";
import type { AgentFactory, MulticaClient, PluginCatalog } from "./types.ts";

/** Cordis row id of the stock loop this plugin displaces. */
export const LOOP_ROW_ID = "agent-loop";
export const PLUGIN_ID = "multica-runtime";
export const name = "dsh-multica-runtime";
export const inject = ["agents", "sessions"] as const;

/**
 * Patch layer shipped as `dsh.bundle.patch`. Disable the default loop (a
 * patch cannot rename a row) then insert this plugin — same shape as the
 * official "replace the loop" recipe.
 */
export const PLUGIN_PATCH = `- id: ${LOOP_ROW_ID}
  disabled: true
- insert:
    - id: ${PLUGIN_ID}
      name: ${name}
`;

export interface AgentsRegistry {
  setFactory(factory: AgentFactory): () => void;
  factory?: AgentFactory | null;
}

export interface CordisContext {
  effect(fn: () => () => void, label?: string): void;
  agents: AgentsRegistry;
}

export interface PluginConfig {
  client: MulticaClient;
  catalog: PluginCatalog;
  bindings?: BindingStore;
  hooks?: AgentHooks;
}

export class MiniCordis implements CordisContext {
  readonly agents: InMemoryAgentsRegistry;
  private readonly disposers: Array<() => void> = [];

  constructor(agents?: InMemoryAgentsRegistry) {
    this.agents = agents ?? new InMemoryAgentsRegistry();
  }

  effect(fn: () => () => void, _label?: string): void {
    this.disposers.push(fn());
  }

  dispose(): void {
    while (this.disposers.length > 0) {
      this.disposers.pop()?.();
    }
  }
}

export class InMemoryAgentsRegistry implements AgentsRegistry {
  factory: AgentFactory | null = null;

  setFactory(factory: AgentFactory): () => void {
    const previous = this.factory;
    this.factory = factory;
    return () => {
      this.factory = previous;
    };
  }
}

const silentHooks: AgentHooks = {
  onTrace() {},
  onSessionEvent() {},
  onStatus() {},
};

/**
 * Cordis entry. Mirrors `@deepseek-ai/dsh-agent-loop`:
 * `ctx.effect(() => ctx.agents.setFactory(factory))`.
 * Uninstall restores the previous factory (stock loop on a real profile).
 */
export function apply(ctx: CordisContext, config: PluginConfig): MulticaRuntimeFactory {
  const bindings = config.bindings ?? new BindingStore();
  const factory = new MulticaRuntimeFactory(
    bindings,
    config.client,
    config.catalog,
    config.hooks ?? silentHooks,
  );
  ctx.effect(
    () => installFactory(ctx.agents, factory),
    "dsh-multica-runtime.setFactory()",
  );
  return factory;
}
