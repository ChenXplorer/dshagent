import { createHash } from 'node:crypto';
import { createAssistantMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm';
import type { ContentBlock, TokenUsage } from '@deepseek-ai/dsh-llm';
import type { Session, SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-session/types';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface ExecutionBinding {
  userId: string;
  taskId: string;
  sandboxId: string;
  runtime: 'codex' | 'claude-code';
  turn: number;
  step: number;
}

interface ExternalRecord {
  /** Stable upstream identity; never a newly generated ID on each poll. */
  eventId: string;
  time: number;
  raw: Json;
}

export type TrajectoryInput = ExternalRecord & (
  | { kind: 'assistant'; text: string; provider?: string; model?: string; usage?: TokenUsage }
  | { kind: 'tool-call'; callId: string; name: string; arguments: string }
  | { kind: 'tool-result'; callId: string; content: ContentBlock[]; isError?: boolean }
  | { kind: 'raw'; eventType: string }
);

interface Correlation extends ExecutionBinding {
  eventId: string;
  upstreamTime: number;
  fingerprint: string;
  projection: 'raw' | 'native';
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'multica/event': { multica: Correlation; eventType: string; raw: Json };
  }
}

declare module '@deepseek-ai/dsh-session' {
  interface Session {
    /** Minimal recorded upstream patch; unavailable in an unpatched rc.2 install. */
    appendInformational(type: 'multica/event', data: {
      multica: Correlation; eventType: string; raw: Json;
    }): SessionEvent<'multica/event'>;
  }
}

/**
 * Writes directly to the official DSH Session. The loop owns turn/step boundaries.
 * The same DSH log stores raw events, correlation and native projections, so a
 * crash between raw and projected writes can be repaired by replaying the event.
 */
export class DshTrajectoryWriter {
  private readonly session: Session;
  private readonly flush: () => Promise<void>;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(session: Session, options: { flush: () => Promise<void> }) {
    if (typeof session.appendInformational !== 'function') {
      throw new Error('DSH Session lacks appendInformational; apply the pinned dsh-host session patch before loading the Multica loop');
    }
    this.session = session;
    this.flush = options.flush;
  }

  append(input: TrajectoryInput, binding: ExecutionBinding): Promise<{ seq: SessionSeq; duplicate: boolean }> {
    const work = this.tail.then(() => this.write(input, binding));
    this.tail = work.catch(() => {});
    return work;
  }

  private async write(input: TrajectoryInput, binding: ExecutionBinding): Promise<{ seq: SessionSeq; duplicate: boolean }> {
    if (!input.eventId || !binding.taskId || !binding.userId || !binding.sandboxId) {
      throw new Error('Trajectory records require stable event, task, user and sandbox identities');
    }
    if (!Number.isSafeInteger(input.time) || input.time < 0) throw new Error('Invalid upstream event timestamp');
    const fingerprint = createHash('sha256').update(canonical({ input, binding })).digest('hex');
    const base = { ...binding, eventId: input.eventId, upstreamTime: input.time, fingerprint };
    const records = this.session.snapshotEvents();
    const find = (projection: Correlation['projection']) => records.find((event) => {
      const correlation = (event.data as { multica?: Correlation }).multica;
      if (correlation?.taskId !== binding.taskId || correlation.eventId !== input.eventId || correlation.projection !== projection) return false;
      if (correlation.fingerprint !== fingerprint) throw new Error(`Upstream event identity conflict: ${binding.taskId}/${input.eventId}`);
      return true;
    });
    const previousRaw = find('raw');
    const previousNative = find('native');
    const raw = previousRaw ?? this.session.appendInformational('multica/event', {
      multica: { ...base, projection: 'raw' },
      eventType: input.kind === 'raw' ? input.eventType : input.kind,
      raw: input.raw,
    });
    let native: SessionEvent | undefined = previousNative;
    // A genuine result ID alone cannot establish a missing/legacy call's
    // identity. Keep the raw event until its exact native call exists.
    const nativeEligible = input.kind !== 'tool-result' || this.session.snapshotEvents().some(event =>
      event.type === 'tool/call' && event.data.callId === scopedCallId(binding.taskId, input.callId));
    const multica: Correlation = { ...base, projection: 'native' };
    const position = { turn: binding.turn, step: binding.step, multica };
    if (!native && nativeEligible) {
      switch (input.kind) {
        case 'assistant':
          native = this.session.append('assistant/message', {
            ...position,
            message: createAssistantMessage({
              content: [{ type: 'text', text: input.text }],
              // Unknown is explicit; a configured route is not proof of observed usage.
              source: { provider: input.provider ?? 'unknown', model: input.model ?? 'unknown' },
            }),
            // Multica CLI output is not a native model wire stream. Do not invent it.
            stream: [],
            ...(input.usage === undefined ? {} : { usage: input.usage }),
          }, { surfaceOp: 'append' });
          break;
        case 'tool-call':
          native = this.session.append('tool/call', {
            ...position, callId: scopedCallId(binding.taskId, input.callId), name: input.name, arguments: input.arguments,
          });
          break;
        case 'tool-result': {
          const callId = scopedCallId(binding.taskId, input.callId);
          const message = createToolResultMessage({ callId, content: input.content, isError: input.isError ?? false });
          native = this.session.append('tool/result', { ...position, message }, { surfaceOp: 'append' });
          break;
        }
      }
    }
    // Also flush on duplicate retries: previous append may have survived in RAM
    // after a failed checkpoint. No external cursor may advance before this resolves.
    await this.flush();
    return { seq: (native ?? raw).seq, duplicate: input.kind === 'raw' || !nativeEligible ? previousRaw !== undefined : previousNative !== undefined };
  }
}

function scopedCallId(taskId: string, callId: string) {
  if (!callId) throw new Error('Tool execution lacks its upstream call ID');
  return ToolCallId(`multica:${JSON.stringify([taskId, callId])}`);
}

function canonical(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
