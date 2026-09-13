import { loadOfficialConfig, OfficialMulticaPlane } from "../src/multica/official.ts";
import { applyNative } from "../src/plugin/dsh-native.ts";
import type { RuntimeKind } from "../src/plugin/types.ts";

export const name = "dsh-multica-runtime";
export const inject = ["agents", "sessions"] as const;
export const LOOP_ROW_ID = "agent-loop";
export const PLUGIN_ID = "multica-runtime";

export function apply(
  ctx: Parameters<typeof applyNative>[0],
  config: { runtime?: RuntimeKind; machineId?: string } = {},
) {
  const official = loadOfficialConfig();
  if (!official) {
    throw new Error(
      "dsh-multica-runtime: official Multica is not configured (token / workspace id missing)",
    );
  }
  const client = new OfficialMulticaPlane(official);
  return applyNative(ctx, client, config);
}
