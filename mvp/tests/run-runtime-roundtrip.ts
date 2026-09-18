/** Explicit same-DSH-session Claude -> Codex return after the successful runtime matrix. */
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Daytona } from '@daytona/sdk';
import { CorrelationRepository } from '../packages/persistence/index.ts';
import { prepareSubmission } from '../packages/multica-client/index.ts';
import { shellArgument } from '../packages/sandbox-management/bootstrap.ts';
import type { DeploymentDriverConfiguration } from '../apps/dsh-host/create-driver.ts';

const [configPath, tokenPath, firstPath, matrixPath, evidencePath] = process.argv.slice(2);
if (!configPath || !tokenPath || !firstPath || !matrixPath || !evidencePath) throw new Error('Pass private config, token, first success, matrix success, NEW roundtrip evidence');
const config = JSON.parse(await readFile(configPath, 'utf8')) as DeploymentDriverConfiguration;
const token = (await readFile(tokenPath, 'utf8')).trim();
type PreviousTrial = { sessionId: string; requestId: string; nonce: string; runtime?: string; state?: string };
const first = JSON.parse(await readFile(firstPath, 'utf8')) as { complete: boolean; sandboxId: string; trials: PreviousTrial[] };
const matrix = JSON.parse(await readFile(matrixPath, 'utf8')) as { complete: boolean; sandboxId: string; trials: PreviousTrial[] };
if (!first.complete || !matrix.complete || matrix.sandboxId !== first.sandboxId || !first.trials[0]) throw new Error('Both prior live gates must pass in the same sandbox');
const original = first.trials[0];
const claude = matrix.trials.find(item => item.sessionId === original.sessionId && item.runtime === 'claude-code' && item.state === 'completed');
if (!claude) throw new Error('The SAME first DSH session has no completed Claude execution');
const repository = new CorrelationRepository(config.correlationDatabase);
const daytona = new Daytona({ ...config.daytona, otelEnabled: false });
const nonce = randomUUID(), requestId = randomUUID(), sessionId = original.sessionId;
const code = `import pathlib,json,time; start=time.time(); a=json.loads(pathlib.Path('mvp-proof-${original.nonce}.json').read_text()); b=json.loads(pathlib.Path('matrix-${claude.nonce}.json').read_text()); assert a['nonce']=='${original.nonce}'; assert b['nonce']=='${claude.nonce}'; f=pathlib.Path('roundtrip-${nonce}.json').open('x'); json.dump({'nonce':'${nonce}','cwd':str(pathlib.Path.cwd()),'start':start,'end':time.time(),'priorCodexNonce':a['nonce'],'priorClaudeNonce':b['nonce']},f); f.close(); print('ROUNDTRIP_${nonce}')`;
const prompt = `Authorized same-conversation Runtime return acceptance. Read both the original Codex proof and the Claude proof in the SAME assigned directory by running this exact command once with your shell tool. Do not delegate or edit other files. Reply with the printed marker.\npython3 -c ${shellArgument(code)}`;
const trial = { sessionId, requestId, nonce, runtime: 'codex', prompt, runtimeSelectionSent: false, submitSent: false, receipt: undefined as unknown, state: '' };
const evidence: Record<string, unknown> = { startedAt: new Date().toISOString(), userId: config.userId, sandboxId: first.sandboxId,
  firstEvidence: firstPath, matrixEvidence: matrixPath, trials: [trial], phase: 'checking' };
let owned = false;
const persist = () => writeFile(evidencePath, JSON.stringify(evidence, null, 2));
const timeout = setTimeout(() => { console.error('Roundtrip observer deadline; no automatic request retry'); process.exit(1); }, 12 * 60_000);
async function gateway(path: string, body?: object) {
  const response = await fetch(`http://127.0.0.1:3380${path}`, { method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error('Gateway roundtrip operation not confirmed');
  return response.json() as Promise<Record<string, unknown>>;
}
try {
  const health = await gateway('/v1/health');
  if (health.ready !== true || health.engine !== 'multica' || health.userId !== config.userId) throw new Error('Gateway readiness/identity mismatch');
  if (repository.listActiveTasks(config.userId).length) throw new Error('Wait for all live matrix tasks to settle');
  const originalTask = repository.getTask(original.requestId), claudeTask = repository.getTask(claude.requestId);
  if (originalTask?.state !== 'completed' || claudeTask?.state !== 'completed') throw new Error('Prior same-session executions did not complete');
  const originalSegment = repository.getExecutionSegment(originalTask.segmentId)!;
  const claudeSegment = repository.getExecutionSegment(claudeTask.segmentId)!;
  const originalResources = repository.getSegmentResources(originalTask.segmentId)!;
  const claudeResources = repository.getSegmentResources(claudeTask.segmentId)!;
  const latest = repository.getLatestExecutionSegment(config.userId, sessionId);
  if (latest?.segmentId !== claudeSegment.segmentId || latest.runtime !== 'claude-code' || originalSegment.runtime !== 'codex' ||
      originalSegment.dshSessionId !== sessionId || claudeSegment.dshSessionId !== sessionId) throw new Error('Same-session Codex -> Claude history differs from expectation');
  const priorResourceDigest = JSON.stringify([originalResources, claudeResources]);
  evidence.previousSegments = [originalSegment, claudeSegment];
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2), { flag: 'wx' }); owned = true;
  // Deliberately no POST /v1/sessions: the user asked for switching this exact conversation.
  trial.runtimeSelectionSent = true; evidence.phase = 'same-session-select-codex'; await persist();
  await gateway(`/v1/sessions/${sessionId}/runtime`, { runtime: 'codex' });
  trial.submitSent = true; evidence.phase = 'same-session-prompt-sent'; await persist();
  trial.receipt = await gateway(`/v1/sessions/${sessionId}/messages`, { requestId, text: prompt, mode: 'queue' }); await persist();
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    trial.state = repository.getTask(requestId)?.state ?? '';
    if (['completed', 'failed', 'cancelled'].includes(trial.state)) break;
    await persist(); await delay(1000);
  }
  const task = repository.getTask(requestId);
  if (!task || task.state !== 'completed') throw new Error('Returned Codex task not successfully settled');
  const segment = repository.getExecutionSegment(task.segmentId)!;
  const resources = repository.getSegmentResources(task.segmentId)!;
  if (segment.dshSessionId !== sessionId || segment.runtime !== 'codex' || segment.ordinal !== claudeSegment.ordinal + 1 ||
      segment.segmentId === originalSegment.segmentId || segment.segmentId === claudeSegment.segmentId ||
      resources.chatSessionId !== originalResources.chatSessionId || resources.chatSessionId !== claudeResources.chatSessionId ||
      resources.workDir !== originalResources.workDir || resources.workDir !== claudeResources.workDir ||
      resources.projectId !== originalResources.projectId || resources.projectId !== claudeResources.projectId || task.sandboxId !== first.sandboxId) {
    throw new Error('Runtime return changed the shared Chat/Project/directory/sandbox binding');
  }
  const submission = repository.getTaskSubmission(requestId)?.content ?? '';
  if (submission !== prepareSubmission({ requestId, chatSessionId: resources.chatSessionId, content: prompt }).content) {
    throw new Error('DSH persisted a rewritten handoff instead of the raw current prompt');
  }
  if (JSON.stringify([repository.getSegmentResources(originalTask.segmentId), repository.getSegmentResources(claudeTask.segmentId)]) !== priorResourceDigest) throw new Error('Prior execution bindings changed');
  const sandbox = await daytona.get(first.sandboxId);
  const proof = JSON.parse((await sandbox.fs.downloadFile(`${resources.workDir}/roundtrip-${nonce}.json`, 20)).toString()) as {
    nonce: string; cwd: string; start: number; end: number; priorCodexNonce: string; priorClaudeNonce: string;
  };
  if (proof.nonce !== nonce || proof.cwd !== resources.workDir || proof.priorCodexNonce !== original.nonce || proof.priorClaudeNonce !== claude.nonce ||
      !Number.isFinite(proof.start) || !Number.isFinite(proof.end) || proof.end < proof.start) throw new Error('Actual returned Codex proof is invalid');
  evidence.proof = proof; evidence.segment = segment; evidence.resources = resources;
  evidence.passed = ['same-dsh-session-codex-claude-codex', 'one-multica-chat-session', 'same-directory-project-sandbox', 'raw-current-prompt-only', 'both-prior-native-files-read'];
  evidence.complete = true; evidence.phase = 'complete'; evidence.finishedAt = new Date().toISOString(); await persist();
  console.log(JSON.stringify({ complete: true, sessionId, requestId, sandboxId: first.sandboxId, evidencePath }));
} catch {
  evidence.complete = false; evidence.failure = 'Same-session roundtrip stopped; preserve selection/request intent and do not blindly retry';
  if (owned) await persist(); console.error(evidence.failure); process.exitCode = 1;
} finally { clearTimeout(timeout); repository.close(); }
