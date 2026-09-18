/** Read-only continuation of an already submitted first-concurrency fixture. Never sends a Gateway message/create/start. */
import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Daytona } from '@daytona/sdk';
import { readDaemonHealth, shellArgument } from '../packages/sandbox-management/bootstrap.ts';
import type { DeploymentDriverConfiguration } from '../apps/dsh-host/create-driver.ts';
import type { SandboxBinding, SegmentExecutionResources, TaskIntent } from '../packages/persistence/index.ts';

const [configPath, fixturePath, evidencePath] = process.argv.slice(2);
if (!configPath || !fixturePath || !evidencePath || fixturePath === evidencePath) throw new Error('Pass private config, original fixture, and NEW observation evidence path');
const config = JSON.parse(await readFile(configPath, 'utf8')) as DeploymentDriverConfiguration;
const fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as { userId: string; overlappingTaskIds?: string[][];
  trials: Array<{ sessionId: string; requestId: string; nonce: string; submitSent: boolean }> };
if (fixture.userId !== config.userId || fixture.trials.length !== 2 || fixture.trials.some(item => !item.submitSent)) throw new Error('Original two-request fixture identity not confirmed');
const database = new DatabaseSync(config.correlationDatabase, { readOnly: true });
const daytona = new Daytona({ apiUrl: config.daytona.apiUrl, apiKey: config.daytona.apiKey,
  organizationId: config.daytona.organizationId, target: config.daytona.target, otelEnabled: false });
const evidence: Record<string, unknown> = { originalFixture: fixturePath, startedAt: new Date().toISOString(), readOnlyContinuation: true,
  requests: fixture.trials.map(({ sessionId, requestId }) => ({ sessionId, requestId })) };
let owned = false;
const persist = () => writeFile(evidencePath, JSON.stringify(evidence, null, 2));
const timeout = setTimeout(() => { console.error('Read-only observation deadline elapsed'); process.exit(1); }, 15 * 60_000);
const readTasks = () => fixture.trials.map(item => database.prepare('SELECT * FROM task_intents WHERE requestId = ?').get(item.requestId) as unknown as TaskIntent | undefined);
try {
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2), { flag: 'wx' }); owned = true;
  let matchedSandbox: string | undefined;
  const overlap = fixture.overlappingTaskIds?.slice() ?? [];
  const deadline = Date.now() + 14 * 60_000;
  let complete = false;
  while (Date.now() < deadline) {
    const binding = database.prepare('SELECT * FROM sandbox_bindings WHERE userId = ?').get(config.userId) as unknown as SandboxBinding | undefined;
    const tasks = readTasks(); evidence.taskStates = tasks.map(task => task?.state ?? 'not-bound');
    if (binding?.sandboxId) {
      if (matchedSandbox && matchedSandbox !== binding.sandboxId) throw new Error('Personal sandbox ID changed during observation');
      matchedSandbox = binding.sandboxId; evidence.sandboxId = matchedSandbox;
      const health = await readDaemonHealth(await daytona.get(matchedSandbox));
      const ids = tasks.map(task => task?.externalTaskId).filter((id): id is string => Boolean(id));
      if (!overlap.length && ids.length === 2 && health && ids.every(id => health.active_task_ids.includes(id))) overlap.push(ids);
      evidence.overlappingTaskIds = overlap;
    }
    if (tasks.some(task => task?.state === 'failed' || task?.state === 'cancelled')) throw new Error('Original task reached a non-success terminal state');
    if (tasks.every(task => task?.state === 'completed')) { complete = true; break; }
    await persist(); await delay(1500);
  }
  if (!complete || !matchedSandbox) throw new Error('Original tasks not complete');
  const sandbox = await daytona.get(matchedSandbox);
  const proofs: Array<{ nonce: string; start: number; end: number; cwd: string }> = [];
  const workDirs: string[] = [];
  for (const [index, task] of readTasks().entries()) {
    if (!task || task.userId !== config.userId) throw new Error('Original task owner mismatch');
    const resourceRow = database.prepare("SELECT resources FROM segment_provisioning WHERE segmentId = ? AND state = 'ready'").get(task.segmentId);
    const resources = JSON.parse(String(resourceRow?.resources)) as SegmentExecutionResources;
    workDirs.push(resources.workDir);
    const trial = fixture.trials[index];
    const result = await sandbox.process.executeCommand(`python3 -c ${shellArgument('import pathlib,sys;print(pathlib.Path(sys.argv[1]).read_text())')} ${shellArgument(`${resources.workDir}/mvp-proof-${trial.nonce}.json`)}`, undefined, undefined, 20);
    if (result.exitCode !== 0) throw new Error('Original proof file unavailable');
    const proof = JSON.parse(result.result) as { nonce: string; start: number; end: number; cwd: string };
    if (proof.nonce !== trial.nonce || proof.cwd !== resources.workDir || !Number.isFinite(proof.start) || !Number.isFinite(proof.end) || proof.end <= proof.start) throw new Error('Invalid original proof');
    proofs.push(proof);
  }
  if (workDirs[0] === workDirs[1] || Math.max(...proofs.map(proof => proof.start)) >= Math.min(...proofs.map(proof => proof.end))) throw new Error('Actual independent shell execution overlap not proved');
  let count = 0;
  for await (const item of daytona.list({ labels: { 'dsh-mvp-user-id': config.userId } })) { if (item.id !== matchedSandbox) throw new Error('Duplicate personal sandbox'); count++; }
  if (count !== 1) throw new Error('Exactly one personal sandbox not confirmed');
  evidence.proofs = proofs; evidence.complete = true; evidence.finishedAt = new Date().toISOString(); await persist();
  console.log(JSON.stringify({ complete: true, sandboxId: matchedSandbox, evidencePath }));
} catch {
  evidence.complete = false; evidence.failure = 'Read-only reconciliation observation stopped; original intents and resources unchanged';
  if (owned) await persist(); console.error(evidence.failure); process.exitCode = 1;
} finally { clearTimeout(timeout); database.close(); }
