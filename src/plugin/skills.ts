import { snapshotCapabilities } from "./capabilities.ts";
import type {
  CapabilitySnapshot,
  McpServerRef,
  RuntimeKind,
  SkillRef,
} from "./types.ts";

/**
 * Skills always sync. MCP only syncs when the target CLI actually reads
 * Multica-managed MCP config (Pi does not).
 */
export function planCapabilitySync(
  runtime: RuntimeKind,
  skills: SkillRef[],
  mcp: McpServerRef[],
): CapabilitySnapshot {
  return snapshotCapabilities(runtime, skills, mcp);
}
