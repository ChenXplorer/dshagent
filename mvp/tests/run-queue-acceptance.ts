/** Explicit live model gate. Prepare only; coordinate execution after prior tasks settle. */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Daytona } from '@daytona/sdk';
import { CorrelationRepository } from '../packages/persistence/index.ts';
import { OfficialMulticaClient } from '../packages/multica-client/index.ts';
import { readDaemonHealth, shellArgument, validateDaemonHealth } from '../packages/sandbox-management/bootstrap.ts';
import type { DeploymentDriverConfiguration } from '../apps/dsh-host/create-driver.ts';

const [configPath, tokenPath, firstEvidencePath, evidencePath] = process.argv.slice(2);
if (!configPath || !tokenPath || !firstEvidencePath || !evidencePath) throw new Error('Pass private config, Gateway token, successful first evidence, and NEW output paths');
const config = JSON.parse(await readFile(configPath, 'utf8')) as DeploymentDriverConfiguration;
const first = JSON.parse(await readFile(firstEvidencePath, 'utf8')) as { complete: boolean; sandboxId: string };
if (!first.complete || config.daemon.maxConcurrentTasks !== 2) throw new Error('Requires passed first gate and two official Daemon slots');
const token = (await readFile(tokenPath, 'utf8')).trim();
const repository = new CorrelationRepository(config.correlationDatabase);
const daytona = new Daytona({ ...config.daytona, otelEnabled: false });
const client = new OfficialMulticaClient({ baseUrl: config.multica.localApiUrl, token: config.multica.token, workspaceId: config.multica.workspaceId });
const sandbox = await daytona.get(first.sandboxId).catch(() => { throw new Error('Official personal sandbox unavailable; no queue messages were submitted'); });
type Proof = { nonce: string; cwd: string; start: number; end: number; released: boolean };
type Trial = { name: string; nonce: string; sessionId: string; requestId: string; prompt: string; createSent?: boolean;
  selectSent?: boolean; submitSent?: boolean; receipt?: unknown; submittedAt?: string; taskId?: string; workDir?: string;
  state?: string; officialState?: string; started?: boolean; proof?: Proof; releaseIntentAt?: string; releaseConfirmedAt?: string };
type Sample = { at: string; activeTaskIds: string[]; tasks: Array<{ name: string; officialState?: string; started: boolean }> };
const evidence = { startedAt: new Date().toISOString(), sandboxId: sandbox.id, userId: config.userId, maxConcurrentTasks: 2,
  trials: [] as Trial[], samples: [] as Sample[], queuedObservedAt: '', slotReleasedAt: '', complete: false, failure: '' };
let ownsEvidence = false;
let persistence = Promise.resolve();
const persist = () => { const text = JSON.stringify(evidence, null, 2); persistence = persistence.then(() => writeFile(evidencePath, text)); return persistence; };
async function gateway(path: string, body: object) {
  const result = await fetch(`http://127.0.0.1:3380${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  if (!result.ok) throw new Error(`Gateway HTTP ${result.status}; submission intent retained`);
  return result.json();
}
function trial(name: string, barrier: boolean): Trial {
  const nonce = randomUUID();
  const code = [
    'import json,time,pathlib,sys', 'start=time.time()',
    `pathlib.Path('queue-start-${nonce}').write_text(str(start))`,
    ...(barrier ? [`release=pathlib.Path('queue-release-${nonce}')`, 'deadline=time.monotonic()+540',
      'while not release.exists() and time.monotonic()<deadline: time.sleep(0.2)', 'released=release.exists()'] : ['time.sleep(2)', 'released=True']),
    `pending=pathlib.Path('queue-proof-${nonce}.tmp')`,
    `with pending.open('x') as f: json.dump({'nonce':'${nonce}','cwd':str(pathlib.Path.cwd()),'start':start,'end':time.time(),'released':released},f)`,
    `pending.replace('queue-proof-${nonce}.json')`,
    `print('QUEUE_${nonce}')`, 'sys.exit(0 if released else 42)',
  ].join('\n');
  const item: Trial = { name, nonce, sessionId: randomUUID(), requestId: randomUUID(),
    prompt: `Authorized harmless execution-slot acceptance. Run exactly this command once using your shell tool in your assigned working directory. Do not delegate or run it in background. Wait for completion and reply with its printed marker. The test controller will release the waiting command.\npython3 -c ${shellArgument(code)}` };
  evidence.trials.push(item); return item;
}
async function prepare(item: Trial) {
  item.createSent = true; await persist(); await gateway('/v1/sessions', { sessionId: item.sessionId });
  item.selectSent = true; await persist(); await gateway(`/v1/sessions/${item.sessionId}/runtime`, { runtime: 'codex' });
}
async function submit(item: Trial) {
  item.submitSent = true; item.submittedAt = new Date().toISOString(); await persist();
  item.receipt = await gateway(`/v1/sessions/${item.sessionId}/messages`, { requestId: item.requestId, text: item.prompt, mode: 'queue' });
  await persist();
}
async function sample(): Promise<void> {
  if (repository.getSandbox(config.userId)?.sandboxId !== sandbox.id) throw new Error('Personal sandbox identity changed');
  for (const item of evidence.trials) {
    const task = repository.getTask(item.requestId);
    item.state = task?.state; item.taskId = task?.externalTaskId ?? undefined;
    const resources = task ? repository.getSegmentResources(task.segmentId) : undefined;
    item.workDir = resources?.workDir;
    if (task && task.sandboxId !== sandbox.id) throw new Error('Task admitted to a different sandbox');
    if (item.taskId && resources) {
      const official = await client.getTask({ taskId: item.taskId, agentId: resources.agentId, chatSessionId: resources.chatSessionId, runtimeId: resources.runtimeId });
      item.officialState = official.status;
    }
  }
  const health = await readDaemonHealth(sandbox);
  if (!health) throw new Error('Daemon health unavailable during queue gate');
  validateDaemonHealth(health, config.daemon);
  if (health.active_task_ids.length > 2) throw new Error('Official Daemon exceeded two execution slots');
  const requests = evidence.trials.map(item => ({ nonce: item.nonce, dir: item.workDir ?? null }));
  const script = `import json,pathlib,sys\nout=[]\nfor item in json.loads(sys.argv[1]):\n  d=pathlib.Path(item['dir']) if item['dir'] else None\n  p=d/('queue-proof-'+item['nonce']+'.json') if d else None\n  out.append({'started':bool(d and (d/('queue-start-'+item['nonce'])).exists()),'proof':json.loads(p.read_text()) if p and p.exists() else None})\nprint(json.dumps(out))`;
  const result = await sandbox.process.executeCommand(`python3 -c ${shellArgument(script)} ${shellArgument(JSON.stringify(requests))}`, undefined, undefined, 20);
  if (result.exitCode !== 0) throw new Error('Real queue marker probe failed');
  const markers = JSON.parse(result.result) as Array<{ started: boolean; proof: Proof | null }>;
  if (markers.length !== evidence.trials.length) throw new Error('Marker probe result mismatch');
  markers.forEach((marker, index) => { evidence.trials[index].started = marker.started; evidence.trials[index].proof = marker.proof ?? undefined; });
  evidence.samples.push({ at: new Date().toISOString(), activeTaskIds: health.active_task_ids, tasks: evidence.trials.map(item => ({ name: item.name, officialState: item.officialState, started: item.started === true })) });
  await persist();
  if (evidence.trials.some(item => item.state === 'failed' || item.state === 'cancelled' || item.proof?.released === false)) throw new Error('Real queue task failed or barrier expired');
}
async function observe(condition: () => boolean, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { await sample(); if (condition()) return; await delay(1000); }
  throw new Error('Queue observation deadline; preserve existing intents and tasks');
}
async function release(item: Trial) {
  if (!item.workDir || !item.started || item.proof) throw new Error('Barrier release requires a currently waiting real command');
  item.releaseIntentAt = new Date().toISOString(); await persist();
  await sandbox.fs.uploadFile(Buffer.from(item.nonce), `${item.workDir}/queue-release-${item.nonce}`);
  item.releaseConfirmedAt = new Date().toISOString(); await persist();
}
try {
  if (repository.listActiveTasks(config.userId).length) throw new Error('Previous live tasks must settle before this gate');
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2), { flag: 'wx' }); ownsEvidence = true;
  const a = trial('slot-a', true), b = trial('slot-b', true), c = trial('queued-third', false);
  for (const item of [a, b, c]) await prepare(item);
  const submissions = await Promise.allSettled([submit(a), submit(b)]);
  if (submissions.some(result => result.status !== 'fulfilled')) throw new Error('Initial Gateway submission outcome unknown; never auto retry');
  await observe(() => a.started === true && b.started === true && a.officialState === 'running' && b.officialState === 'running');
  await submit(c);
  await observe(() => c.officialState === 'queued' && !c.started && a.started === true && b.started === true && !a.proof && !b.proof);
  evidence.queuedObservedAt = new Date().toISOString(); await persist();
  // Establish a sustained queue observation, not a fleeting race during dispatch.
  for (let i = 0; i < 3; i++) { await delay(1000); await sample(); if (c.officialState !== 'queued' || c.started || a.proof || b.proof) throw new Error('Third task did not remain queued while both slots were occupied'); }
  await release(a); evidence.slotReleasedAt = a.releaseConfirmedAt!; await persist();
  // Platform settlement deliberately waits for sibling CLI descendants too;
  // the official terminal state proves A freed its slot without waiting for B.
  await observe(() => Boolean(c.proof) && a.officialState === 'completed');
  if (b.proof || !b.started) throw new Error('Sibling ended before third task acquired the released slot');
  await release(b);
  await observe(() => evidence.trials.every(item => item.state === 'completed'));
  for (const item of evidence.trials) {
    const proof = item.proof;
    if (!proof || proof.nonce !== item.nonce || proof.cwd !== item.workDir || !proof.released || !Number.isFinite(proof.start) || !Number.isFinite(proof.end) || proof.end <= proof.start) throw new Error('Invalid real interval proof');
  }
  if (new Set(evidence.trials.map(item => item.taskId)).size !== 3 || new Set(evidence.trials.map(item => item.workDir)).size !== 3) throw new Error('Queue tasks lack distinct official identities or directories');
  if (Math.max(a.proof!.start, b.proof!.start) >= Math.min(a.proof!.end, b.proof!.end)) throw new Error('First two shell commands did not overlap');
  if (c.proof!.start < a.proof!.end || c.proof!.start >= b.proof!.end) throw new Error('Third command did not start after slot release while sibling remained active');
  const edges = evidence.trials.flatMap(item => [{ at: item.proof!.start, delta: 1 }, { at: item.proof!.end, delta: -1 }]).sort((x, y) => x.at - y.at || x.delta - y.delta);
  let running = 0; for (const edge of edges) { running += edge.delta; if (running > 2) throw new Error('Real command intervals overlap three ways'); }
  evidence.complete = true; await persist(); console.log(JSON.stringify({ complete: true, evidencePath, sandboxId: sandbox.id }));
} catch {
  evidence.failure = 'Queue gate incomplete; inspect private evidence and existing tasks before retrying. Barrier commands self-expire after 540 seconds.';
  if (ownsEvidence) await persist(); console.error(evidence.failure); process.exitCode = 1;
} finally { repository.close(); }
