import type { CapabilitySnapshot, McpServerRef, RuntimeKind, SkillRef } from "./types.ts";

export const NATIVE_DSH_PROFILE = "dsh-native";
export const PLATFORM_DSH_PROFILE = "dsh-platform";

export const RUNTIME_MATRIX: Record<
  RuntimeKind,
  {
    label: string;
    cli: string;
    skillPath: string;
    mcpSupported: boolean;
    sessionResume: boolean;
    notes: string[];
  }
> = {
  dsh: {
    label: "DSH",
    cli: "dsh",
    skillPath: ".dsh/skills/",
    mcpSupported: true,
    sessionResume: true,
    notes: [
      "Must run on a native profile that still has dsh-agent-loop.",
      "Never point a DSH runtime at the platform profile that loads this plugin.",
    ],
  },
  codex: {
    label: "Codex",
    cli: "codex",
    skillPath: "$CODEX_HOME/skills/",
    mcpSupported: true,
    sessionResume: true,
    notes: ["Skills land in a per-run CODEX_HOME, never the machine-wide Codex dir."],
  },
  "claude-code": {
    label: "Claude Code",
    cli: "claude",
    skillPath: ".claude/skills/",
    mcpSupported: true,
    sessionResume: true,
    notes: ["Multica injects skills and MCP before the Claude CLI starts."],
  },
  pi: {
    label: "Pi",
    cli: "pi",
    skillPath: ".pi/skills/",
    mcpSupported: false,
    sessionResume: true,
    notes: [
      "Pi does not read Multica-managed MCP configuration.",
      "Session resume depends on a local session file on the original machine.",
    ],
  },
};

export function isNativeDshProfile(profile: string | undefined): boolean {
  return profile === NATIVE_DSH_PROFILE;
}

export function snapshotCapabilities(
  runtime: RuntimeKind,
  skills: SkillRef[],
  mcp: McpServerRef[],
): CapabilitySnapshot {
  const row = RUNTIME_MATRIX[runtime];
  return {
    runtime,
    skills,
    mcp: row.mcpSupported ? mcp : [],
    mcpSupported: row.mcpSupported,
    skillPath: row.skillPath,
    sessionResume: row.sessionResume,
    notes: row.notes,
  };
}

export function environmentLabel(
  kind:
    | "personal-ephemeral"
    | "personal-persistent"
    | "project-shared"
    | "local-machine",
): string {
  switch (kind) {
    case "personal-ephemeral":
      return "个人临时沙箱";
    case "personal-persistent":
      return "个人持久沙箱";
    case "project-shared":
      return "项目共享沙箱";
    case "local-machine":
      return "我的电脑";
  }
}
