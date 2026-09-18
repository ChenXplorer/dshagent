import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Context } from '@deepseek-ai/cordis';
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session';
import Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl';
import SessionProjections from '@deepseek-ai/dsh-session-projection';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type {} from '../../packages/dsh-loop/observer-diagnostics.ts';

type Correlation = { taskId: string; eventId: string; projection: string; runtime: string; sandboxId: string };
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
};
const digest = (event: SessionEvent) => createHash('sha256').update(canonical(event)).digest('hex');

/** Read-only evidence: native backend validates actual JSONL, SQLite opens readOnly. No messages/secrets are exported. */
export async function captureAcceptance(input: { sessionsRoot: string; correlationDatabase: string; userId: string; sessionIds: string[]; proofMarkers?: Record<string, { marker: string; requestId: string }> }) {
  const ctx = new Context();
  await ctx.plugin(SessionStore); await ctx.plugin(SessionProjections);
  await ctx.plugin(Jsonl, { root: input.sessionsRoot, compression: 'none' });
  const db = new DatabaseSync(input.correlationDatabase, { readOnly: true });
  try {
    const active = db.prepare("SELECT requestId,externalTaskId,state FROM task_intents WHERE userId=? AND state NOT IN ('completed','failed','cancelled')").all(input.userId);
    const sessions = [];
    for (const id of input.sessionIds) {
      const handle = await ctx.sessionPersistence.open(SessionId(id), 'read');
      try {
        const { events } = await handle.read(0);
        const counts: Record<string, number> = {};
        const projections: Array<Correlation & { seq: number; type: string }> = [];
        const calls: Array<{ callId: string; name: string; seq: number }> = [];
        const results: Array<{ callId: string; seq: number }> = [];
        const turnEndings: Array<{ seq: number; turn: number; kind: string; cancellationKind?: string }> = [];
        const observerErrors: Array<{ seq: number; requestId: string; errorType: string; category: string; transportCode?: string; httpStatus?: number }> = [];
        let openTurn = false;
        for (const event of events) {
          counts[event.type] = (counts[event.type] ?? 0) + 1;
          if (event.type === 'turn/start') openTurn = true;
          if (event.type === 'turn/end') {
            openTurn = false;
            turnEndings.push({ seq: event.seq, turn: event.data.turn, kind: event.data.reason.kind,
              ...(event.data.reason.kind === 'aborted' ? { cancellationKind: event.data.reason.reason.kind } : {}) });
          }
          const data = event.data as unknown as { multica?: Correlation };
          if (data.multica) projections.push({ ...data.multica, seq: event.seq, type: event.type });
          if (event.type === 'tool/call') calls.push({ callId: event.data.callId, name: event.data.name, seq: event.seq });
          if (event.type === 'tool/result') results.push({ callId: event.data.message.source.callId, seq: event.seq });
          if (event.type === 'multica/observer-error') observerErrors.push({ seq: event.seq, ...event.data });
        }
        const keys = projections.map(value => canonical([value.taskId, value.eventId, value.projection]));
        const tasks = db.prepare(`SELECT task_intents.requestId,task_intents.externalTaskId,task_intents.state,
          task_intents.sandboxId,execution_segments.segmentId,execution_segments.runtime,execution_segments.externalSessionId
          FROM task_intents JOIN execution_segments USING(segmentId)
          WHERE execution_segments.userId=? AND execution_segments.dshSessionId=? ORDER BY task_intents.requestId`).all(input.userId, id);
        const proof = input.proofMarkers?.[id];
        const proofTaskId = proof ? tasks.find(task => task.requestId === proof.requestId)?.externalTaskId : undefined;
        const lastAssistant = events.findLast(event => event.type === 'assistant/message' && (!proof || (proofTaskId &&
          (event.data as unknown as { multica?: Correlation }).multica?.taskId === proofTaskId)));
        const finalText = lastAssistant?.type === 'assistant/message' ? lastAssistant.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') : '';
        const proofMarker = proof?.marker;
        sessions.push({ sessionId: id, eventCount: events.length, eventDigests: events.map(digest), counts, openTurn,
          ...proofMarker ? { proofMarker, proofTaskId, finalAssistantContainsProof: finalText.includes(proofMarker) } : {},
          duplicateProjections: keys.length - new Set(keys).size, projections, calls, results, turnEndings, observerErrors,
          callsWithoutResult: calls.filter(call => !results.some(result => result.callId === call.callId)).length,
          resultsWithoutCall: results.filter(result => !calls.some(call => call.callId === result.callId)).length, tasks });
      } finally { await handle.close(); }
    }
    return { capturedAt: new Date().toISOString(), activeTasks: active, sessions };
  } finally { db.close(); await ctx.fiber.dispose(); }
}

if (process.argv[1]?.endsWith('capture-acceptance.ts')) {
  const [sessionsRoot, configPath, sessionList, output] = process.argv.slice(2);
  if (!sessionsRoot || !configPath || !sessionList || !output) throw new Error('Pass sessionsRoot privateDriverConfig sessionIdsJson outputJson');
  const config = JSON.parse(await readFile(configPath, 'utf8')) as { userId: string; correlationDatabase: string };
  const list: unknown = JSON.parse(await readFile(sessionList, 'utf8'));
  const trials = (list as { trials?: Array<{ sessionId: string; nonce: string; requestId: string; proofMarker?: string }> }).trials;
  const sessionIds = Array.isArray(list) ? list : trials?.map(trial => trial.sessionId);
  if (!Array.isArray(sessionIds) || !sessionIds.length || sessionIds.some(id => typeof id !== 'string')) throw new Error('Input must be sessionIds[] or the real concurrency fixture with trials');
  const proofMarkers = trials ? Object.fromEntries(trials.map(trial => [trial.sessionId, { marker: trial.proofMarker ?? `MVP_PROOF_${trial.nonce}`, requestId: trial.requestId }])) : undefined;
  const evidence = await captureAcceptance({ sessionsRoot, ...config, sessionIds, proofMarkers });
  await writeFile(output, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ output, activeTasks: evidence.activeTasks.length, sessions: evidence.sessions.map(({ sessionId, eventCount, openTurn, duplicateProjections, resultsWithoutCall }) => ({ sessionId, eventCount, openTurn, duplicateProjections, resultsWithoutCall })) }));
}
