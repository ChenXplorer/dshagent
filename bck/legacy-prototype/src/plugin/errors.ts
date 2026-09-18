export class PluginError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PluginError";
    this.code = code;
  }
}

export class RecursionGuardError extends PluginError {
  constructor(profile: string) {
    super(
      "recursion_guard",
      `Runtime DSH cannot target profile "${profile}" because it loads this Multica plugin. Use a native profile that still has dsh-agent-loop.`,
    );
    this.name = "RecursionGuardError";
  }
}

export class SwitchBlockedError extends PluginError {
  constructor(reason: string) {
    super("switch_blocked", reason);
    this.name = "SwitchBlockedError";
  }
}

export class CapabilityError extends PluginError {
  constructor(message: string) {
    super("capability", message);
    this.name = "CapabilityError";
  }
}

export class MappingError extends PluginError {
  constructor(message: string) {
    super("mapping", message);
    this.name = "MappingError";
  }
}
