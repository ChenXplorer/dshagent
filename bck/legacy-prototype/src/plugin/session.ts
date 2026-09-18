import { now } from "./ids.ts";
import type { DshSession, DshSessionEvent, DshSessionHeader } from "./types.ts";

export class MemorySession implements DshSession {
  readonly id: string;
  readonly header: DshSessionHeader;
  readonly events: DshSessionEvent[] = [];
  private seq = 0;

  constructor(id: string, header: DshSessionHeader = {}) {
    this.id = id;
    this.header = header;
  }

  append(event: Omit<DshSessionEvent, "seq">): DshSessionEvent {
    const recorded: DshSessionEvent = {
      ...event,
      seq: this.seq++,
      time: event.time ?? now(),
    };
    this.events.push(recorded);
    return recorded;
  }
}
