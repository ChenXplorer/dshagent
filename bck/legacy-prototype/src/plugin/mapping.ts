import { MappingError } from "./errors.ts";
import { createId, now } from "./ids.ts";
import type {
  ExecutionSegment,
  SegmentStatus,
  SessionBinding,
  SessionSelection,
} from "./types.ts";

/**
 * DSH Session ↔ Multica Agent / Session / Task.
 *
 * Bindings are keyed only by DSH session id. Runtime is a property of the
 * current execution segment, never of the factory, so two live sessions can
 * run Codex and Claude at the same time without trampling each other.
 */
export class BindingStore {
  private readonly bySession = new Map<string, SessionBinding>();

  get(sessionId: string): SessionBinding | undefined {
    return this.bySession.get(sessionId);
  }

  require(sessionId: string): SessionBinding {
    const binding = this.bySession.get(sessionId);
    if (!binding) {
      throw new MappingError(`No binding for DSH session ${sessionId}`);
    }
    return binding;
  }

  ensure(sessionId: string): SessionBinding {
    const existing = this.bySession.get(sessionId);
    if (existing) return existing;
    const created: SessionBinding = { dshSessionId: sessionId, segments: [] };
    this.bySession.set(sessionId, created);
    return created;
  }

  current(sessionId: string): ExecutionSegment {
    const binding = this.require(sessionId);
    const segment = binding.segments.at(-1);
    if (!segment || segment.closedAt) {
      throw new MappingError(
        `DSH session ${sessionId} has no open execution segment`,
      );
    }
    return segment;
  }

  currentOrNull(sessionId: string): ExecutionSegment | undefined {
    const binding = this.bySession.get(sessionId);
    const segment = binding?.segments.at(-1);
    if (!segment || segment.closedAt) return undefined;
    return segment;
  }

  openSegment(sessionId: string, selection: SessionSelection): ExecutionSegment {
    const binding = this.ensure(sessionId);
    const previous = binding.segments.at(-1);
    if (previous && !previous.closedAt) {
      if (previous.status === "running" || previous.status === "canceling") {
        throw new MappingError(
          "Cannot open a new segment while a task is still in flight",
        );
      }
      previous.closedAt = now();
      previous.status = previous.status === "unknown" ? "unknown" : "idle";
    }
    const segment: ExecutionSegment = {
      id: createId("seg"),
      runtime: selection.runtime,
      environment: selection.environment,
      cwd: selection.cwd,
      machineId: selection.machineId,
      nativeProfile: selection.nativeProfile,
      status: "idle",
      openedAt: now(),
    };
    binding.segments.push(segment);
    return segment;
  }

  bindMultica(
    sessionId: string,
    refs: { agentId: string; sessionId: string },
  ): ExecutionSegment {
    const segment = this.current(sessionId);
    segment.multicaAgentId = refs.agentId;
    segment.multicaSessionId = refs.sessionId;
    return segment;
  }

  bindTask(
    sessionId: string,
    taskId: string,
    clientRequestId: string,
  ): ExecutionSegment {
    const segment = this.current(sessionId);
    segment.currentTaskId = taskId;
    segment.clientRequestId = clientRequestId;
    segment.status = "running";
    return segment;
  }

  markUnknown(sessionId: string, clientRequestId: string): ExecutionSegment {
    const segment = this.current(sessionId);
    segment.clientRequestId = clientRequestId;
    segment.currentTaskId = undefined;
    segment.status = "unknown";
    return segment;
  }

  setStatus(sessionId: string, status: SegmentStatus): ExecutionSegment {
    const segment = this.current(sessionId);
    segment.status = status;
    if (status === "idle" || status === "failed") {
      segment.currentTaskId = status === "idle" ? undefined : segment.currentTaskId;
    }
    return segment;
  }

  list(): SessionBinding[] {
    return [...this.bySession.values()];
  }
}
