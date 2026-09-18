/** Explicit real stop/start acceptance; does not create a sandbox or submit a model task. */
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Daytona, type Sandbox } from '@daytona/sdk';
import { OfficialMulticaClient } from '../packages/multica-client/index.ts';
import { CorrelationRepository } from '../packages/persistence/index.ts';
import { PersonalSandboxError } from '../packages/sandbox-management/index.ts';
import { readDaemonHealth, validateDaemonHealth } from '../packages/sandbox-management/bootstrap.ts';
import { buildNativeCliConfiguration } from '../packages/cli-configuration/index.ts';
import { createConfiguredPersonalSandboxService, type DeploymentDriverConfiguration } from '../apps/dsh-host/create-driver.ts';

const [mode, configPath, fixturePath, evidencePath] = process.argv.slice(2);
if (!['assert-active', 'cycle-idle'].includes(mode) || !configPath || !fixturePath || !evidencePath) {
  throw new Error('Arguments: assert-active|cycle-idle private-driver-json first-concurrency-json NEW-evidence-json');
}
const config = JSON.parse(await readFile(configPath, 'utf8')) as DeploymentDriverConfiguration;
const fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as { trials: Array<{ requestId: string; nonce: string }> };
const repository = new CorrelationRepository(config.correlationDatabase);
const daytona = new Daytona({ apiUrl: config.daytona.apiUrl, apiKey: config.daytona.apiKey,
  organizationId: config.daytona.organizationId, target: config.daytona.target, otelEnabled: false });
const client = new OfficialMulticaClient({ baseUrl: config.multica.localApiUrl, token: config.multica.token, workspaceId: config.multica.workspaceId });
const service = createConfiguredPersonalSandboxService(config, repository, daytona, client);
const evidence: Record<string, unknown> = { mode, startedAt: new Date().toISOString(), phase: 'checking' };
let ownsEvidence = false;
const persist = () => writeFile(evidencePath, JSON.stringify(evidence, null, 2));
// Deadline exits only this observer. Persisted pausing/resuming states remain authoritative; never auto-rollback remote state.
const deadline = setTimeout(() => { console.error('Lifecycle observer deadline elapsed; reconcile persisted state before retrying'); process.exit(1); }, 5 * 60_000);
async function hashes(sandbox: Sandbox, paths: string[]): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const path of paths) result[path] = createHash('sha256').update(await sandbox.fs.downloadFile(path, 20)).digest('hex');
  return result;
}
try {
  const binding = repository.getSandbox(config.userId);
  if (!binding?.sandboxId || binding.state !== 'ready') throw new Error('Lifecycle acceptance requires an existing ready personal binding');
  evidence.sandboxId = binding.sandboxId;
  const sandbox = await daytona.get(binding.sandboxId);
  if (sandbox.state !== 'started') throw new Error('Live sandbox is not started');
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2), { flag: 'wx' }); ownsEvidence = true;
  const active = repository.listActiveTasks(config.userId);
  if (mode === 'assert-active') {
    if (!active.length) throw new Error('No real active task exists to prove stop refusal');
    evidence.activeRequestIds = active.map(task => task.requestId);
    evidence.phase = 'stop-refusal'; await persist();
    try { await service.pausePersonalSandbox(config.userId); throw new Error('Stop unexpectedly accepted while tasks are active'); }
    catch (error) { if (!(error instanceof PersonalSandboxError) || error.code !== 'ACTIVE_TASKS') throw error; }
    if (repository.getSandbox(config.userId)?.state !== 'ready' || (await daytona.get(binding.sandboxId)).state !== 'started') throw new Error('Stop refusal altered sandbox state');
    evidence.stopRefused = true;
  } else {
    if (active.length) throw new Error('Wait for every real task to settle before idle lifecycle acceptance');
    const beforeHealth = await readDaemonHealth(sandbox);
    if (!beforeHealth) throw new Error('Live Daemon missing'); validateDaemonHealth(beforeHealth, config.daemon);
    if (beforeHealth.active_task_ids.length || beforeHealth.claims_in_flight || beforeHealth.transcript_outbox_error ||
        Object.values(beforeHealth.transcript_pending_by_task).some(value => value !== 0)) throw new Error('Daemon is not actually idle and flushed');
    const paths = buildNativeCliConfiguration(config.daemon.nativeCli).files.map(file => file.path);
    if (config.daemon.nativeCli.codex.modelCatalogPath) paths.push(config.daemon.nativeCli.codex.modelCatalogPath);
    for (const trial of fixture.trials) {
      const task = repository.getTask(trial.requestId);
      const resources = task ? repository.getSegmentResources(task.segmentId) : undefined;
      if (!resources || task?.state !== 'completed') throw new Error('Proof fixture task has not completed');
      paths.push(`${resources.workDir}/mvp-proof-${trial.nonce}.json`);
    }
    const before = await hashes(sandbox, paths); evidence.beforeFileHashes = before;
    evidence.phase = 'stopping'; await persist(); await service.pausePersonalSandbox(config.userId);
    const stopped = await daytona.get(binding.sandboxId);
    if (stopped.state !== 'stopped' || repository.getSandbox(config.userId)?.state !== 'paused') throw new Error('Official stop not confirmed');
    evidence.stopConfirmed = true; evidence.phase = 'starting'; await persist();
    const resumed = await service.resumePersonalSandbox(config.userId);
    if (resumed.id !== binding.sandboxId || resumed.state !== 'started' || repository.getSandbox(config.userId)?.state !== 'ready') throw new Error('Resume changed sandbox identity or failed readiness');
    const after = await hashes(resumed, paths); evidence.afterFileHashes = after;
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Proof files or native CLI configuration changed across lifecycle');
    const afterHealth = await readDaemonHealth(resumed);
    if (!afterHealth) throw new Error('Resumed Daemon missing'); validateDaemonHealth(afterHealth, config.daemon);
    if (afterHealth.status !== 'running') throw new Error('Resumed Daemon not ready');
    evidence.resumeConfirmed = true; evidence.daemonId = afterHealth.daemon_id;
  }
  evidence.complete = true; evidence.phase = 'complete'; evidence.finishedAt = new Date().toISOString(); await persist();
  console.log(JSON.stringify({ complete: true, mode, sandboxId: evidence.sandboxId, evidencePath }));
} catch {
  evidence.complete = false; evidence.failure = 'Lifecycle acceptance stopped; persisted state and existing sandbox preserved';
  if (ownsEvidence) await persist(); console.error(evidence.failure); process.exitCode = 1;
} finally { clearTimeout(deadline); repository.close(); }
