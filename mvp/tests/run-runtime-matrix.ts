/** Explicit live model acceptance. Run only after the first-concurrency evidence passed. */
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Daytona, DaytonaNotFoundError } from '@daytona/sdk';
import { CorrelationRepository } from '../packages/persistence/index.ts';
import { prepareSubmission } from '../packages/multica-client/index.ts';
import { shellArgument } from '../packages/sandbox-management/bootstrap.ts';
import type { DeploymentDriverConfiguration } from '../apps/dsh-host/create-driver.ts';

const [configPath, tokenPath, firstEvidencePath, evidencePath] = process.argv.slice(2);
if (!configPath || !tokenPath || !firstEvidencePath || !evidencePath) throw new Error('Pass config, Gateway token, successful first evidence, and NEW output paths');
const config = JSON.parse(await readFile(configPath, 'utf8')) as DeploymentDriverConfiguration;
const first = JSON.parse(await readFile(firstEvidencePath, 'utf8')) as {
  complete: boolean; sandboxId: string; trials: Array<{ sessionId: string; requestId: string; nonce: string }>;
};
if (!first.complete || first.trials.length !== 2) throw new Error('First real concurrency gate has not passed');
const token = (await readFile(tokenPath, 'utf8')).trim();
const repository = new CorrelationRepository(config.correlationDatabase);
const daytona = new Daytona({ ...config.daytona, otelEnabled: false });
const sandbox = await daytona.get(first.sandboxId);
type Proof = { nonce: string; cwd: string; start: number; end: number; predecessorNonce?: string };
type Trial = { sessionId: string; requestId: string; runtime: 'codex' | 'claude-code'; nonce: string; prompt: string;
  createSent?: boolean; runtimeSelectionSent?: boolean; submitSent?: boolean; receipt?: unknown; cancelSent?: boolean;
  proof?: Proof; taskId?: string; workDir?: string; state?: string };
const evidence = { startedAt: new Date().toISOString(), sandboxId: first.sandboxId, userId: config.userId,
  trials: [] as Trial[], passed: [] as string[], complete: false, finishedAt: '', failure: '' };
let ownsEvidence = false;
let persistence = Promise.resolve();
const persist = () => {
  const contents = JSON.stringify(evidence, null, 2);
  persistence = persistence.then(() => writeFile(evidencePath, contents));
  return persistence;
};
async function gateway(path: string, body: object) {
  const response = await fetch(`http://127.0.0.1:3380${path}`, { method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Gateway operation HTTP ${response.status}; preserve intent, do not blindly retry`);
  return response.json();
}
function trial(runtime: Trial['runtime'], seconds: number, sessionId: string = randomUUID(), predecessor?: string): Trial {
  const nonce = randomUUID();
  const code = `import json,time,pathlib; start=time.time(); `
    + (predecessor ? `old=json.loads(pathlib.Path('mvp-proof-${predecessor}.json').read_text()); ` : '')
    + `pathlib.Path('started-${nonce}').write_text(str(start)); time.sleep(${seconds}); `
    + `f=pathlib.Path('matrix-${nonce}.json').open('x'); json.dump({'nonce':'${nonce}','cwd':str(pathlib.Path.cwd()),'start':start,'end':time.time()`
    + (predecessor ? `,'predecessorNonce':old['nonce']` : '') + `},f); f.close(); print('MATRIX_${nonce}')`;
  const item: Trial = { sessionId, requestId: randomUUID(), nonce, runtime,
    prompt: `Authorized harmless runtime acceptance. In your assigned working directory, run exactly this command once with your shell tool. Do not delegate. Wait for completion and reply with the printed marker.\npython3 -c ${shellArgument(code)}` };
  evidence.trials.push(item); return item;
}
async function prepare(item: Trial, create: boolean) {
  if (create) { item.createSent = true; await persist(); await gateway('/v1/sessions', { sessionId: item.sessionId }); }
  item.runtimeSelectionSent = true; await persist();
  await gateway(`/v1/sessions/${item.sessionId}/runtime`, { runtime: item.runtime });
}
async function submit(item: Trial) {
  item.submitSent = true; await persist();
  item.receipt = await gateway(`/v1/sessions/${item.sessionId}/messages`, { requestId: item.requestId, text: item.prompt });
  await persist();
}
async function observe(items: Trial[], condition: () => Promise<boolean>, timeoutMs = 600_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const item of items) {
      const task = repository.getTask(item.requestId);
      item.state = task?.state; item.taskId = task?.externalTaskId ?? undefined;
      if (task) item.workDir = repository.getSegmentResources(task.segmentId)?.workDir;
    }
    await persist();
    if (await condition()) return;
    if (items.some(item => item.state === 'failed')) throw new Error('A real CLI task failed');
    await delay(1000);
  }
  throw new Error('Observation deadline; keep existing tasks and evidence for reconciliation');
}
async function started(item: Trial) {
  if (!item.workDir) return false;
  const script = `import pathlib,sys;print('yes' if pathlib.Path(sys.argv[1]).exists() else 'no')`;
  const result = await sandbox.process.executeCommand(`python3 -c ${shellArgument(script)} ${shellArgument(`${item.workDir}/started-${item.nonce}`)}`, undefined, undefined, 15);
  if (result.exitCode !== 0) throw new Error('Actual sandbox start-marker probe failed');
  return result.result.trim() === 'yes';
}
async function proof(item: Trial) {
  if (!item.workDir) throw new Error('Missing real work directory');
  const data = await sandbox.fs.downloadFile(`${item.workDir}/matrix-${item.nonce}.json`);
  item.proof = JSON.parse(data.toString('utf8')) as Proof;
  if (item.proof.nonce !== item.nonce || item.proof.cwd !== item.workDir || !Number.isFinite(item.proof.start)
    || !Number.isFinite(item.proof.end) || item.proof.end <= item.proof.start) throw new Error('Invalid real command proof');
}
function overlap(a: Trial, b: Trial) {
  if (!a.proof || !b.proof || Math.max(a.proof.start, b.proof.start) >= Math.min(a.proof.end, b.proof.end)) throw new Error('Actual CLI shell execution did not overlap');
}
try {
  if (repository.listActiveTasks(config.userId).length) throw new Error('Previous live tasks must settle before this gate');
  if (repository.getSandbox(config.userId)?.sandboxId !== sandbox.id) throw new Error('Personal sandbox binding changed');
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2), { flag: 'wx' }); ownsEvidence = true;

  // Switch one existing session while its sibling is really executing Codex.
  const sibling = trial('codex', 45, first.trials[1].sessionId);
  const switched = trial('claude-code', 20, first.trials[0].sessionId, first.trials[0].nonce);
  const original = repository.getTask(first.trials[0].requestId)!;
  const originalResources = repository.getSegmentResources(original.segmentId)!;
  await prepare(sibling, false); await submit(sibling);
  await observe([sibling], () => started(sibling));
  await prepare(switched, false); await submit(switched);
  await observe([sibling, switched], async () => [sibling, switched].every(item => item.state === 'completed'));
  await proof(sibling); await proof(switched); overlap(sibling, switched);
  const switchedTask = repository.getTask(switched.requestId)!;
  const switchedResources = repository.getSegmentResources(switchedTask.segmentId)!;
  if (switchedTask.segmentId === original.segmentId || switchedResources.workDir !== originalResources.workDir
    || switchedResources.projectId !== originalResources.projectId || switchedResources.chatSessionId !== originalResources.chatSessionId
    || switched.proof?.predecessorNonce !== first.trials[0].nonce) throw new Error('Runtime switch did not preserve files with a fresh CLI session');
  const submission = repository.getTaskSubmission(switched.requestId)?.content ?? '';
  if (submission !== prepareSubmission({ requestId: switched.requestId, chatSessionId: switchedResources.chatSessionId, content: switched.prompt }).content) throw new Error('Runtime switch submitted a DSH-generated handoff instead of the raw prompt');
  const siblingSegment = repository.getExecutionSegment(repository.getTask(sibling.requestId)!.segmentId)!;
  if (siblingSegment.runtime !== 'codex') throw new Error('Sibling runtime changed');
  evidence.passed.push('mixed parallel CLI execution', 'session runtime switch preserves files and one Chat Session', 'raw current prompt only', 'sibling runtime unchanged'); await persist();

  const claudes = [trial('claude-code', 20), trial('claude-code', 20)];
  for (const item of claudes) await prepare(item, true);
  await Promise.all(claudes.map(submit));
  await observe(claudes, async () => claudes.every(item => item.state === 'completed'));
  for (const item of claudes) await proof(item);
  overlap(claudes[0], claudes[1]);
  if (claudes[0].workDir === claudes[1].workDir) throw new Error('Claude parallel directories overlap');
  evidence.passed.push('two Claude Code tasks overlap in isolated directories'); await persist();

  const cancelled = trial('codex', 90); const survivor = trial('claude-code', 35);
  await prepare(cancelled, true); await prepare(survivor, true);
  await Promise.all([submit(cancelled), submit(survivor)]);
  await observe([cancelled, survivor], async () => (await started(cancelled)) && (await started(survivor)));
  cancelled.cancelSent = true; await persist(); await gateway(`/v1/sessions/${cancelled.sessionId}/cancel`, {});
  await observe([cancelled, survivor], async () => cancelled.state === 'cancelled' && survivor.state === 'completed');
  await proof(survivor);
  try {
    await sandbox.fs.getFileDetails(`${cancelled.workDir}/matrix-${cancelled.nonce}.json`);
    throw new Error('Cancelled long-running command reached its final write');
  } catch (error) { if (!(error instanceof DaytonaNotFoundError)) throw error; }
  evidence.passed.push('cancel running Codex without cancelling parallel Claude');
  if (repository.getSandbox(config.userId)?.sandboxId !== sandbox.id) throw new Error('Runtime matrix replaced personal sandbox');
  evidence.complete = true; evidence.finishedAt = new Date().toISOString(); await persist();
  console.log(JSON.stringify({ complete: true, evidencePath, gates: evidence.passed }));
} catch {
  evidence.failure = 'Runtime matrix incomplete; inspect private evidence and existing tasks before taking further actions';
  if (ownsEvidence) await persist(); console.error(evidence.failure); process.exitCode = 1;
} finally { repository.close(); }
