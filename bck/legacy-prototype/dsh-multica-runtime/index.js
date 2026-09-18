/**
 * Cordis entry for `dsh plugin add`.
 * `cordis.patch.yml` disables `agent-loop`; this module calls
 * `ctx.agents.setFactory` the same way `@deepseek-ai/dsh-agent-loop` does.
 */
export { name, inject, apply, PLUGIN_ID, LOOP_ROW_ID, PLUGIN_PATCH } from "../src/plugin/apply.ts";
