/** Explicit, coordinated live outage gate. Never run alongside other live tasks. */
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Daytona } from '@daytona/sdk';
import { CorrelationRepository } from '../packages/persistence/index.ts';
import { OfficialMulticaClient, type TaskBinding } from '../packages/multica-client/index.ts';
import { readDaemonHealth, shellArgument, validateDaemonHealth } from '../packages/sandbox-management/bootstrap.ts';
import { captureAcceptance } from '../apps/dsh-host/capture-acceptance.ts';
import type { DeploymentDriverConfiguration } from '../apps/dsh-host/create-driver.ts';

const [configPath, tokenPath, firstEvidencePath, evidencePath, sessionsRoot] = process.argv.slice(2);
if (!configPath || !tokenPath || !firstEvidencePath || !evidencePath || !sessionsRoot) throw new Error('Pass private config, Gateway token, passed first evidence, NEW output, native sessions root');
if (process.platform !== 'win32') throw new Error('This gate targets the owned native Windows services');
const config = JSON.parse(await readFile(configPath, 'utf8')) as DeploymentDriverConfiguration;
const first = JSON.parse(await readFile(firstEvidencePath, 'utf8')) as { complete: boolean; sandboxId: string };
if (!first.complete) throw new Error('First real gate must pass before outage testing');
const token = (await readFile(tokenPath, 'utf8')).trim();
const repository = new CorrelationRepository(config.correlationDatabase);
const daytona = new Daytona({ ...config.daytona, otelEnabled: false });
const client = new OfficialMulticaClient({ baseUrl: config.multica.localApiUrl, token: config.multica.token, workspaceId: config.multica.workspaceId });
const sandbox = await daytona.get(first.sandboxId).catch(() => { throw new Error('Owned sandbox unavailable; no outage was injected'); });
const nonce = randomUUID(), sessionId = randomUUID(), requestId = randomUUID();
const controlPath = resolve(dirname(fileURLToPath(import.meta.url)), '../deploy/windows/control-acceptance-service.ps1');
const execute = promisify(execFile);
function command(phase: string) {
  const code = ['import pathlib,time,sys', `p=pathlib.Path('outbox-${nonce}-${phase}')`, 'p.with_suffix(".started").write_text(str(time.time()))',
    'deadline=time.monotonic()+360', 'while not p.with_suffix(".release").exists() and time.monotonic()<deadline: time.sleep(0.2)',
    'ok=p.with_suffix(".release").exists()', `print('OUTBOX_${phase.toUpperCase()}_${nonce}' if ok else 'BARRIER_EXPIRED')`, 'sys.exit(0 if ok else 42)'].join('\n');
  return `python3 -c ${shellArgument(code)}`;
}
const prompt = `Authorized harmless transcript replay acceptance. Run these TWO commands in TWO separate shell-tool calls, in order, exactly once each. Do not delegate or background them. Wait for the first command to finish, then run the second and wait again. The test controller releases both barriers. After both complete reply with OUTBOX_FINAL_${nonce}.\nFirst command:\n${command('first')}\nSecond command:\n${command('final')}`;
const evidence = { startedAt: new Date().toISOString(), sandboxId: sandbox.id, userId: config.userId, sessionId, requestId, nonce, prompt,
  operations: [] as Array<{ service?: string; action: string; at: string; confirmedAt?: string }>, taskId: '', workDir: '',
  initialReconciliation: undefined as unknown, resumedReconciliation: undefined as unknown, pendingSamples: [] as Array<{ at: string; pending: number; active: boolean }>,
  taskStateDuringOutage: '', cursorBeforeOutage: 0, cursorAfterReplay: 0, officialEventIds: [] as string[],
  native: undefined as Awaited<ReturnType<typeof captureAcceptance>> | undefined, complete: false, failure: '' };
let ownsEvidence = false, serverStopped = false, hostStopped = false;
let persistence = Promise.resolve();
const persist = () => { const value = JSON.stringify(evidence, null, 2); persistence = persistence.then(() => writeFile(evidencePath, value)); return persistence; };
async function operation(action: string) { const entry = { action, at: new Date().toISOString() }; evidence.operations.push(entry); await persist(); return entry; }
async function service(name: 'multica' | 'dsh', action: 'stop' | 'start') {
  const entry = { service: name, action, at: new Date().toISOString(), confirmedAt: '' }; evidence.operations.push(entry); await persist();
  await execute('pwsh.exe', ['-NoProfile', '-File', controlPath, '-Service', name, '-Action', action, '-DriverConfiguration', resolve(configPath)], { timeout: 60_000, windowsHide: true });
  entry.confirmedAt = new Date().toISOString(); await persist();
}
async function gateway(path: string, body?: object) {
  const r = await fetch(`http://127.0.0.1:3380${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`Gateway HTTP ${r.status}`); return r.json();
}
async function waitFor(probe: () => Promise<boolean>, milliseconds = 120_000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) { if (await probe()) return; await delay(1000); }
  throw new Error('Bounded outage observation timed out');
}
async function marker(phase: string) {
  if (!evidence.workDir) return false;
  const code = 'import pathlib,sys;print("yes" if pathlib.Path(sys.argv[1]).exists() else "no")';
  const r = await sandbox.process.executeCommand(`python3 -c ${shellArgument(code)} ${shellArgument(`${evidence.workDir}/outbox-${nonce}-${phase}.started`)}`, undefined, undefined, 15);
  if (r.exitCode !== 0) throw new Error('Sandbox marker probe failed'); return r.result.trim() === 'yes';
}
async function release(phase: string) {
  await operation(`release-${phase}`);
  await sandbox.fs.uploadFile(Buffer.from(nonce), `${evidence.workDir}/outbox-${nonce}-${phase}.release`);
}
async function serverReady() {
  try { const r = await fetch(new URL('/readyz', config.multica.localApiUrl), { signal: AbortSignal.timeout(2000) }); return r.ok; } catch { return false; }
}
let binding: TaskBinding;
try {
  if (repository.listActiveTasks(config.userId).length || repository.getSandbox(config.userId)?.sandboxId !== sandbox.id) throw new Error('Outage gate requires the existing idle personal sandbox');
  const health = await readDaemonHealth(sandbox); if (!health) throw new Error('Daemon unavailable'); validateDaemonHealth(health, config.daemon);
  if (health.active_task_ids.length || health.claims_in_flight || Object.values(health.transcript_pending_by_task).some(Boolean)) throw new Error('Daemon is not idle');
  await mkdir(dirname(evidencePath), { recursive: true }); await writeFile(evidencePath, JSON.stringify(evidence, null, 2), { flag: 'wx' }); ownsEvidence = true;
  await operation('create-session'); await gateway('/v1/sessions', { sessionId });
  await operation('select-codex'); await gateway(`/v1/sessions/${sessionId}/runtime`, { runtime: 'codex' });
  await operation('initial-message-post'); await gateway(`/v1/sessions/${sessionId}/messages`, { requestId, text: prompt, mode: 'queue' });
  await waitFor(async () => {
    const task = repository.getTask(requestId); if (!task?.externalTaskId) return false;
    const resource = repository.getSegmentResources(task.segmentId); if (!resource) return false;
    evidence.taskId = task.externalTaskId; evidence.workDir = resource.workDir;
    binding = { taskId: task.externalTaskId, agentId: resource.agentId, chatSessionId: resource.chatSessionId, runtimeId: resource.runtimeId };
    await persist(); return marker('first');
  }, 240_000);
  const submission = repository.getTaskSubmission(requestId); if (!submission) throw new Error('Missing persisted official submission');
  const before = await client.reconcileSubmission(submission);
  if (before.status !== 'accepted' || before.taskId !== evidence.taskId) throw new Error('Initial official message is not unique');
  evidence.initialReconciliation = before; evidence.cursorBeforeOutage = repository.getTaskCursor(requestId); await persist();

  await service('multica', 'stop'); serverStopped = true;
  if (await serverReady()) throw new Error('Server outage was not confirmed');
  await release('first');
  await waitFor(async () => {
    const observed = await readDaemonHealth(sandbox); if (!observed) throw new Error('Daemon unexpectedly exited'); validateDaemonHealth(observed, config.daemon);
    const pending = observed.transcript_pending_by_task[evidence.taskId] ?? 0;
    const active = observed.active_task_ids.includes(evidence.taskId);
    evidence.pendingSamples.push({ at: new Date().toISOString(), pending, active });
    evidence.taskStateDuringOutage = repository.getTask(requestId)?.state ?? 'missing'; await persist();
    if (['completed', 'failed', 'cancelled'].includes(evidence.taskStateDuringOutage)) throw new Error('Observer falsely settled during unconfirmed outage');
    return pending > 0 && active && await marker('final');
  }, 45_000);
  await service('multica', 'start'); serverStopped = false; await waitFor(serverReady, 60_000);
  await waitFor(async () => { const h = await readDaemonHealth(sandbox); if (!h) return false; validateDaemonHealth(h, config.daemon); return !h.transcript_outbox_error && (h.transcript_pending_by_task[evidence.taskId] ?? 0) === 0; }, 60_000);

  // The DSH observer may have halted. Cold native activation + the SAME rpcId
  // is an explicit idempotent reconciliation, never a second Multica message.
  await service('dsh', 'stop'); hostStopped = true;
  await service('dsh', 'start'); hostStopped = false;
  await waitFor(async () => { try { return (await gateway('/v1/health')).ready === true; } catch { return false; } }, 60_000);
  await operation('same-request-native-resume'); await gateway(`/v1/sessions/${sessionId}/messages`, { requestId, text: prompt, mode: 'queue' });
  const resumed = await client.reconcileSubmission(submission);
  if (resumed.status !== 'accepted' || resumed.taskId !== before.taskId || resumed.messageId !== before.messageId || repository.getTask(requestId)?.externalTaskId !== before.taskId) throw new Error('Recovery duplicated or rebound the original Multica message');
  evidence.resumedReconciliation = resumed; await persist();
  await release('final');
  await waitFor(async () => repository.getTask(requestId)?.state === 'completed', 240_000);
  const actual = await client.getTask(binding!); if (actual.status !== 'completed') throw new Error('Official terminal outcome not confirmed');
  const transcript = await client.readTaskMessages(evidence.taskId, 0);
  evidence.officialEventIds = transcript.messages.map(message => message.eventId); evidence.cursorAfterReplay = repository.getTaskCursor(requestId);
  if (transcript.gaps.length || new Set(evidence.officialEventIds).size !== evidence.officialEventIds.length || evidence.cursorAfterReplay !== transcript.nextSequence) throw new Error('Official replay has gaps, duplicates, or an uncommitted DSH cursor');
  await waitFor(async () => {
    evidence.native = await captureAcceptance({ sessionsRoot, correlationDatabase: config.correlationDatabase, userId: config.userId, sessionIds: [sessionId], proofMarkers: { [sessionId]: { marker: `OUTBOX_FINAL_${nonce}`, requestId } } });
    await persist(); return evidence.native.sessions[0]?.openTurn === false;
  }, 30_000);
  const native = evidence.native!.sessions[0]!;
  const projected = new Set(native.projections.filter(p => p.taskId === evidence.taskId).map(p => p.eventId));
  if (native.duplicateProjections || native.callsWithoutResult || native.resultsWithoutCall || !native.finalAssistantContainsProof || evidence.officialEventIds.some(id => !projected.has(id))) throw new Error('Native DSH replay evidence is incomplete or duplicated');
  evidence.complete = true; await persist(); console.log(JSON.stringify({ complete: true, evidencePath, taskId: evidence.taskId }));
} catch {
  evidence.failure = 'Outbox replay gate incomplete; task outcome stays unknown until official reconciliation. Inspect private evidence; no blind message retry.';
  if (ownsEvidence) await persist(); console.error(evidence.failure); process.exitCode = 1;
} finally {
  // Restore only services this invocation positively stopped, even when a gate
  // fails. Starting the server does not assert that an interrupted task ended.
  if (serverStopped) { try { await service('multica', 'start'); } catch { console.error('Owned Multica restart requires attention'); } }
  if (hostStopped) { try { await service('dsh', 'start'); } catch { console.error('Owned DSH restart requires attention'); } }
  repository.close();
}
