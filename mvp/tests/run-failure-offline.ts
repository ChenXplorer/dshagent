/** Explicit live native CLI failure / idle Daemon auto-recovery acceptance. Never run by unit tests. */
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Daytona } from '@daytona/sdk';
import { OfficialMulticaClient } from '../packages/multica-client/index.ts';
import { CorrelationRepository } from '../packages/persistence/index.ts';
import { confirmSandboxTaskSettled, readDaemonHealth, validateDaemonHealth, shellArgument } from '../packages/sandbox-management/bootstrap.ts';
import type { DeploymentDriverConfiguration } from '../apps/dsh-host/create-driver.ts';

const [mode, configPath, tokenPath, evidencePath] = process.argv.slice(2);
if (!['own-cli-failure', 'idle-daemon-recovery'].includes(mode) || !configPath || !tokenPath || !evidencePath) {
  throw new Error('Arguments: own-cli-failure|idle-daemon-recovery private-driver-json gateway-token NEW-evidence-json');
}
const config = JSON.parse(await readFile(configPath, 'utf8')) as DeploymentDriverConfiguration;
const token = (await readFile(tokenPath, 'utf8')).trim();
const repository = new CorrelationRepository(config.correlationDatabase);
const daytona = new Daytona({ apiUrl: config.daytona.apiUrl, apiKey: config.daytona.apiKey,
  organizationId: config.daytona.organizationId, target: config.daytona.target, otelEnabled: false });
const client = new OfficialMulticaClient({ baseUrl: config.multica.localApiUrl, token: config.multica.token, workspaceId: config.multica.workspaceId });
const nonce = randomUUID(), sessionId = randomUUID(), requestId = randomUUID();
const marker = `MVP_${mode === 'own-cli-failure' ? 'FAILURE' : 'RECOVERY'}_${nonce}`;
const command = `python3 -c ${shellArgument(`import time;time.sleep(${mode === 'own-cli-failure' ? 90 : 0});print('${marker}')`)}`;
const prompt = `Authorized isolated MVP acceptance. Use your shell tool to run exactly this harmless command once, wait for completion and return its printed marker. Do not delegate or edit any files.\n${command}`;
const evidence: Record<string, unknown> = { mode, startedAt: new Date().toISOString(), sessionId, requestId, nonce, prompt, phase: 'checking' };
let ownsEvidence = false;
const persist = () => writeFile(evidencePath, JSON.stringify(evidence, null, 2));
const deadlineTimer = setTimeout(() => { console.error('Live observer deadline; preserve state and reconcile before further action'); process.exit(1); }, 15 * 60_000);
async function gateway(path: string, body?: object): Promise<Record<string, unknown>> {
  const response = await fetch(`http://127.0.0.1:3380${path}`, { method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error('Gateway request was not confirmed');
  return response.json() as Promise<Record<string, unknown>>;
}
try {
  const gatewayHealth = await gateway('/v1/health');
  if (gatewayHealth.ready !== true || gatewayHealth.engine !== 'multica' || gatewayHealth.userId !== config.userId) throw new Error('Gateway readiness mismatch');
  const beforeBinding = repository.getSandbox(config.userId);
  if (!beforeBinding?.sandboxId || beforeBinding.state !== 'ready' || repository.listActiveTasks(config.userId).length) throw new Error('An existing idle personal sandbox is required');
  const sandbox = await daytona.get(beforeBinding.sandboxId);
  const beforeHealth = await readDaemonHealth(sandbox);
  if (!beforeHealth) throw new Error('Daemon initially unavailable'); validateDaemonHealth(beforeHealth, config.daemon);
  if (beforeHealth.status !== 'running' || beforeHealth.active_task_ids.length || beforeHealth.claims_in_flight || beforeHealth.transcript_outbox_error ||
      Object.values(beforeHealth.transcript_pending_by_task).some(value => value !== 0)) throw new Error('Daemon initially not idle/flushed');
  evidence.sandboxId = sandbox.id; evidence.daemonId = beforeHealth.daemon_id; evidence.creationRequestId = beforeBinding.creationRequestId;
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2), { flag: 'wx' }); ownsEvidence = true;
  if (mode === 'idle-daemon-recovery') {
    evidence.phase = 'official-daemon-stop'; await persist();
    const result = await sandbox.process.executeCommand(`env HOME=${shellArgument(config.daemon.home)} ${shellArgument(`${config.daemon.home}/bin/multica`)} daemon stop`, undefined, undefined, 30);
    if (result.exitCode !== 0) throw new Error('Official Daemon stop was not confirmed');
    let absent = false;
    for (let attempt = 0; attempt < 20; attempt++) { if (!await readDaemonHealth(sandbox)) { absent = true; break; } await delay(500); }
    if (!absent) throw new Error('Daemon remained online');
    if ((await daytona.get(sandbox.id)).state !== 'started' || repository.getSandbox(config.userId)?.sandboxId !== sandbox.id) throw new Error('Daemon stop altered personal sandbox');
    evidence.offlineObserved = true; evidence.phase = 'offline-before-admission'; await persist();
  }
  evidence.phase = 'gateway-session-create-sent'; await persist();
  evidence.createReceipt = await gateway('/v1/sessions', { sessionId });
  evidence.phase = 'gateway-prompt-sent'; await persist();
  evidence.submitReceipt = await gateway(`/v1/sessions/${sessionId}/messages`, { requestId, text: prompt, mode: 'queue' }); await persist();
  if (mode === 'own-cli-failure') {
    const deadline = Date.now() + 4 * 60_000;
    let killed = false;
    while (Date.now() < deadline) {
      const task = repository.getTask(requestId);
      const health = await readDaemonHealth(sandbox);
      if (task?.externalTaskId && health) {
        validateDaemonHealth(health, config.daemon);
        if (health.pid !== beforeHealth.pid) throw new Error('Target Daemon identity changed before owned CLI failure');
        if (!health.active_task_ids.includes(task.externalTaskId)) { await delay(1000); continue; }
        // Only extract nonsecret IDs. Never emit environ or complete argv. No broad process-group kill.
        const source = `import pathlib,os,signal,json,sys
daemon=int(sys.argv[1]); task=('MULTICA_TASK_ID='+sys.argv[2]).encode(); marker=sys.argv[3].encode(); candidates=[]; shell_started=False
def stat_fields(p):
  stat=(p/'stat').read_text(); return stat[stat.rfind(')')+2:].split()
def owned_ancestry(pid):
  seen=set()
  while pid>1 and pid not in seen:
    if pid==daemon: return True
    seen.add(pid); pid=int(stat_fields(pathlib.Path('/proc')/str(pid))[1])
  return False
for p in pathlib.Path('/proc').iterdir():
  if not p.name.isdigit(): continue
  try:
    if task not in (p/'environ').read_bytes().split(b'\\0'): continue
    fields=stat_fields(p); args=(p/'cmdline').read_bytes()
    if marker in args: shell_started=True
    exe=(p/'exe').resolve()
    if exe.name=='codex' and b'app-server' in args.split(b'\\0') and owned_ancestry(int(p.name)): candidates.append((int(p.name),fields[19],str(exe)))
  except (FileNotFoundError,ProcessLookupError): pass
if len(candidates)>1: raise RuntimeError('ambiguous owned native Codex executable')
if shell_started and len(candidates)==1:
  pid,start,exe=candidates[0]; target=pathlib.Path('/proc')/str(pid); fd=os.pidfd_open(pid)
  if task not in (target/'environ').read_bytes().split(b'\\0') or b'app-server' not in (target/'cmdline').read_bytes().split(b'\\0') or stat_fields(target)[19]!=start or str((target/'exe').resolve())!=exe or not owned_ancestry(pid): raise RuntimeError('native target identity changed')
  signal.pidfd_send_signal(fd,signal.SIGKILL); os.close(fd); print(json.dumps({'killed':True,'pid':pid,'startTicks':start,'exe':exe}))
else: print(json.dumps({'killed':False}))`;
        evidence.phase = 'owned-cli-process-inspection'; await persist();
        const result = await sandbox.process.executeCommand(`sudo -n python3 -c ${shellArgument(source)} ${shellArgument(String(health.pid))} ${shellArgument(task.externalTaskId)} ${shellArgument(marker)}`, undefined, undefined, 20);
        if (result.exitCode !== 0) throw new Error('Owned CLI audit failed; no broader kill is allowed');
        const inspected = JSON.parse(result.result) as { killed: boolean; pid?: number; startTicks?: string; exe?: string };
        if (inspected.killed) { evidence.killedCliPid = inspected.pid; evidence.killedNativeExecutable = inspected.exe; evidence.killedStartTicks = inspected.startTicks; evidence.externalTaskId = task.externalTaskId; evidence.phase = 'owned-cli-killed'; await persist(); killed = true; break; }
      }
      await delay(1000);
    }
    if (!killed) throw new Error('No unambiguous executing own CLI found; no process was killed');
  }
  const deadline = Date.now() + 9 * 60_000;
  let terminal = false;
  while (Date.now() < deadline) {
    const task = repository.getTask(requestId);
    if (task) { evidence.taskState = task.state; evidence.externalTaskId = task.externalTaskId; }
    if (task && ['completed', 'failed', 'cancelled'].includes(task.state)) { terminal = true; break; }
    await persist(); await delay(1000);
  }
  const task = repository.getTask(requestId);
  if (!terminal || !task?.externalTaskId) throw new Error('Task did not reach positively confirmed terminal state');
  if (task.state !== (mode === 'own-cli-failure' ? 'failed' : 'completed')) throw new Error('Actual task outcome differs from the intended acceptance case');
  const resources = repository.getSegmentResources(task.segmentId)!;
  const taskBinding = { taskId: task.externalTaskId, agentId: resources.agentId, runtimeId: resources.runtimeId, chatSessionId: resources.chatSessionId };
  const settled = await confirmSandboxTaskSettled(sandbox, config.daemon, task.externalTaskId);
  if (!settled.executionStopped || !settled.transcriptFlushed) throw new Error('Owned CLI children or transcript outbox still unconfirmed');
  evidence.settlement = settled;
  const actualTask = await client.getTask(taskBinding); evidence.officialTaskStatus = actualTask.status;
  const afterBinding = repository.getSandbox(config.userId);
  if (afterBinding?.sandboxId !== beforeBinding.sandboxId || afterBinding.creationRequestId !== beforeBinding.creationRequestId) throw new Error('Personal sandbox was replaced');
  const afterHealth = await readDaemonHealth(sandbox);
  if (!afterHealth) throw new Error('Daemon did not recover'); validateDaemonHealth(afterHealth, config.daemon);
  if (afterHealth.status !== 'running') throw new Error('Daemon is not ready');
  await client.selectRuntime({ daemonId: config.daemon.daemonId, kind: 'codex' });
  await client.selectRuntime({ daemonId: config.daemon.daemonId, kind: 'claude-code' });
  evidence.complete = true; evidence.phase = 'complete'; evidence.finishedAt = new Date().toISOString(); await persist();
  console.log(JSON.stringify({ complete: true, mode, sessionId, requestId, sandboxId: sandbox.id, evidencePath }));
} catch {
  evidence.complete = false; evidence.failure = 'Live failure/recovery acceptance stopped; owned resources and intents preserved for reconciliation';
  if (ownsEvidence) await persist(); console.error(evidence.failure); process.exitCode = 1;
} finally { clearTimeout(deadlineTimer); repository.close(); }
