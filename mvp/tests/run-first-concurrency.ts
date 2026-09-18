/** Explicit live acceptance command; never included in the unit test glob. Costs real model tokens. */
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Daytona } from '@daytona/sdk';
import { CorrelationRepository } from '../packages/persistence/index.ts';
import { readDaemonHealth, shellArgument } from '../packages/sandbox-management/bootstrap.ts';
import type { DeploymentDriverConfiguration } from '../apps/dsh-host/create-driver.ts';

const [configPath, tokenPath, evidencePath] = process.argv.slice(2);
if (!configPath || !tokenPath || !evidencePath) throw new Error('Pass private driver config, Gateway token, and new evidence JSON absolute paths');
const config = JSON.parse(await readFile(configPath, 'utf8')) as DeploymentDriverConfiguration;
const token = (await readFile(tokenPath, 'utf8')).trim();
const repository = new CorrelationRepository(config.correlationDatabase);
const daytona = new Daytona({ apiUrl: config.daytona.apiUrl, apiKey: config.daytona.apiKey,
  organizationId: config.daytona.organizationId, target: config.daytona.target, otelEnabled: false });
const baseUrl = 'http://127.0.0.1:3380';
type Trial = { sessionId: string; requestId: string; nonce: string; prompt: string; createSent?: boolean; createReceipt?: unknown;
  submitSent?: boolean; submitReceipt?: unknown; proof?: unknown; state?: string };
const trials: Trial[] = [0, 1].map(() => {
  const nonce = randomUUID();
  const source = `import json,time,pathlib; start=time.time(); time.sleep(30); proof=pathlib.Path('mvp-proof-${nonce}.json').open('x'); json.dump({'nonce':'${nonce}','start':start,'end':time.time(),'cwd':str(pathlib.Path.cwd())},proof); proof.close(); print('MVP_PROOF_${nonce}')`;
  return { sessionId: randomUUID(), requestId: randomUUID(), nonce,
    prompt: `This is an authorized harmless MVP runtime acceptance test. In your assigned working directory, use your shell tool to execute exactly this Python command once. Do not delegate or modify any other files. Wait for it to finish and reply with the printed proof marker.\npython3 -c ${shellArgument(source)}` };
});
const evidence: { startedAt: string; userId: string; snapshot: string; trials: Trial[]; overlappingTaskIds: string[][];
  sandboxId?: string; finishedAt?: string; complete?: boolean; failure?: string } = {
  startedAt: new Date().toISOString(), userId: config.userId, snapshot: config.daytona.snapshot, trials, overlappingTaskIds: [],
};
const persist = () => writeFile(evidencePath, JSON.stringify(evidence, null, 2));
let ownsEvidence = false;
async function gateway(path: string, body?: object) {
  const response = await fetch(`${baseUrl}${path}`, { method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Gateway ${path} HTTP ${response.status}; consult persisted intent before any retry`);
  return response.json() as Promise<Record<string, unknown>>;
}
try {
  const health = await gateway('/v1/health');
  if (health.ready !== true || health.engine !== 'multica' || health.userId !== config.userId) throw new Error('Actual Multica Gateway health/identity not confirmed');
  const snapshot = await daytona.snapshot.get(config.daytona.snapshot);
  if (snapshot.state !== 'active') throw new Error('Actual Daytona snapshot is not active; no message was submitted');
  if (repository.getSandbox(config.userId)) throw new Error('First-creation concurrency acceptance requires no previous sandbox reservation; existing intent preserved');
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2), { flag: 'wx' });
  ownsEvidence = true;
  for (const trial of trials) {
    trial.createSent = true; await persist();
    trial.createReceipt = await gateway('/v1/sessions', { sessionId: trial.sessionId }); await persist();
  }
  // Record both outbound intentions first. Only this invocation can send; reruns refuse the existing evidence file.
  for (const trial of trials) trial.submitSent = true;
  await persist();
  const receipts = await Promise.allSettled(trials.map(trial => gateway(`/v1/sessions/${trial.sessionId}/messages`, {
    requestId: trial.requestId, text: trial.prompt, mode: 'queue',
  })));
  receipts.forEach((result, index) => { trials[index].submitReceipt = result.status === 'fulfilled' ? result.value : { unknown: true }; });
  await persist();
  if (receipts.some(result => result.status !== 'fulfilled')) throw new Error('One or more Gateway submission outcomes unknown; no automatic retry');
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    const binding = repository.getSandbox(config.userId);
    if (binding?.sandboxId) {
      evidence.sandboxId = binding.sandboxId;
      const sandbox = await daytona.get(binding.sandboxId);
      const daemon = await readDaemonHealth(sandbox);
      const ids = trials.map(trial => repository.getTask(trial.requestId)?.externalTaskId).filter((value): value is string => Boolean(value));
      if (ids.length === 2 && daemon && ids.every(id => daemon.active_task_ids.includes(id)) && evidence.overlappingTaskIds.length === 0) {
        evidence.overlappingTaskIds.push(ids); await persist();
      }
    }
    for (const trial of trials) trial.state = repository.getTask(trial.requestId)?.state;
    if (trials.every(trial => trial.state === 'completed')) break;
    if (trials.some(trial => trial.state === 'failed' || trial.state === 'cancelled')) throw new Error('Live CLI task failed; preserving actual task references for diagnosis');
    await persist(); await delay(2000);
  }
  if (!trials.every(trial => trial.state === 'completed') || !evidence.sandboxId) throw new Error('Live task observation deadline elapsed; tasks/intent preserved');
  const sandbox = await daytona.get(evidence.sandboxId);
  const directories: string[] = [];
  for (const trial of trials) {
    const task = repository.getTask(trial.requestId)!;
    const resources = repository.getSegmentResources(task.segmentId)!;
    directories.push(resources.workDir);
    const command = `python3 -c ${shellArgument('import pathlib,sys;print(pathlib.Path(sys.argv[1]).read_text())')} ${shellArgument(`${resources.workDir}/mvp-proof-${trial.nonce}.json`)}`;
    const result = await sandbox.process.executeCommand(command, undefined, undefined, 20);
    if (result.exitCode !== 0) throw new Error('Native CLI proof file absent');
    trial.proof = JSON.parse(result.result);
    const proof = trial.proof as { nonce: string; start: number; end: number; cwd: string };
    if (proof.nonce !== trial.nonce || proof.cwd !== resources.workDir || !Number.isFinite(proof.start) || !Number.isFinite(proof.end) || proof.end <= proof.start) {
      throw new Error('Proof nonce, working directory or execution interval mismatch');
    }
  }
  if (directories[0] === directories[1] || !evidence.overlappingTaskIds.length) throw new Error('Parallel execution or directory isolation was not observed');
  const intervals = trials.map(trial => trial.proof as { start: number; end: number });
  if (Math.max(...intervals.map(item => item.start)) >= Math.min(...intervals.map(item => item.end))) throw new Error('Actual shell execution intervals did not overlap');
  let count = 0;
  for await (const item of daytona.list({ labels: { 'dsh-mvp-user-id': config.userId } })) { if (item.id !== evidence.sandboxId) throw new Error('Duplicate personal sandbox observed'); count++; }
  if (count !== 1) throw new Error('Expected exactly one real personal sandbox');
  evidence.complete = true; evidence.finishedAt = new Date().toISOString(); await persist();
  console.log(JSON.stringify({ complete: true, sandboxId: evidence.sandboxId, sessions: trials.map(trial => trial.sessionId), evidencePath }));
} catch (error) {
  evidence.failure = error instanceof Error && error.message.startsWith('Gateway') ? error.message : 'Live acceptance stopped; inspect persisted state and private service logs';
  if (ownsEvidence) await persist();
  console.error(evidence.failure); process.exitCode = 1;
} finally { repository.close(); }
