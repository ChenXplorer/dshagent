/** Explicit coordinated idle deployment. Stop the DSH host before invoking; never creates a sandbox. */
import { createHash } from 'node:crypto';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Daytona } from '@daytona/sdk';
import { CorrelationRepository } from '../packages/persistence/index.ts';
import { OfficialMulticaClient } from '../packages/multica-client/index.ts';
import { createConfiguredPersonalSandboxService, type DeploymentDriverConfiguration } from '../apps/dsh-host/create-driver.ts';
import { buildNativeCliConfiguration } from '../packages/cli-configuration/index.ts';
import { readDaemonHealth, validateDaemonHealth, shellArgument } from '../packages/sandbox-management/bootstrap.ts';

const [configPath, fixturePath, revision, newBinaryPath, expectedHash, evidencePath] = process.argv.slice(2);
if (!configPath || !fixturePath || !/^dshtrace[1-9][0-9]*$/u.test(revision ?? '') || !newBinaryPath || !/^[a-f0-9]{64}$/u.test(expectedHash ?? '') || !evidencePath) {
  throw new Error('Arguments: private-driver-json first-fixture-json dshtraceN new-binary-path exact-binary-sha256 NEW-evidence-json');
}
const config = JSON.parse(await readFile(configPath, 'utf8')) as DeploymentDriverConfiguration;
const fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as { trials: Array<{ requestId: string; nonce: string }> };
const repository = new CorrelationRepository(config.correlationDatabase);
const daytona = new Daytona({ ...config.daytona, otelEnabled: false });
const client = new OfficialMulticaClient({ baseUrl: config.multica.localApiUrl, token: config.multica.token, workspaceId: config.multica.workspaceId });
const evidence: Record<string, unknown> = { startedAt: new Date().toISOString(), fromVersion: config.daemon.expectedDaemonVersion, fromBinaryPath: config.daemon.binaryLocalPath, toVersion: revision, toBinaryPath: newBinaryPath, phase: 'guard' };
let ownsEvidence = false;
const save = () => writeFile(evidencePath, JSON.stringify(evidence, null, 2));
const deadline = setTimeout(() => { console.error('Deployment deadline exceeded; inspect retained intent before recovery'); process.exit(1); }, 5 * 60_000);
try {
  // The host must be unavailable so no new Gateway request can race the process replacement.
  let reachable = false;
  try { await fetch('http://127.0.0.1:3380/v1/health', { signal: AbortSignal.timeout(1500) }); reachable = true; } catch { /* offline required */ }
  if (reachable) throw new Error('Stop the DSH host before Daemon deployment');
  const binding = repository.getSandbox(config.userId);
  if (!binding?.sandboxId || binding.state !== 'ready' || repository.listActiveTasks(config.userId).length) throw new Error('Existing ready sandbox with no active intents required');
  const sandbox = await daytona.get(binding.sandboxId);
  if (sandbox.state !== 'started') throw new Error('Sandbox must already be started');
  const beforeHealth = await readDaemonHealth(sandbox);
  if (!beforeHealth) throw new Error('Old Daemon must be available for identity validation');
  validateDaemonHealth(beforeHealth, config.daemon);
  if (beforeHealth.active_task_ids.length || beforeHealth.claims_in_flight || beforeHealth.transcript_outbox_error || Object.values(beforeHealth.transcript_pending_by_task).some(Boolean)) throw new Error('Old Daemon is not idle and flushed');
  if (!isAbsolute(newBinaryPath) || (await realpath(newBinaryPath)).toLowerCase() === (await realpath(config.daemon.binaryLocalPath)).toLowerCase()) throw new Error('Keep the previous immutable binary; provide a distinct absolute new binary path');
  const binary = await readFile(newBinaryPath);
  if (createHash('sha256').update(binary).digest('hex') !== expectedHash) throw new Error('Local binary differs from reviewed build');
  evidence.sandboxId = sandbox.id; evidence.binarySha256 = expectedHash;
  evidence.previousBinarySha256 = createHash('sha256').update(await readFile(config.daemon.binaryLocalPath)).digest('hex');
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2), { flag: 'wx' }); ownsEvidence = true;
  const paths = buildNativeCliConfiguration(config.daemon.nativeCli).files.map(file => file.path);
  if (config.daemon.nativeCli.codex.modelCatalogPath) paths.push(config.daemon.nativeCli.codex.modelCatalogPath);
  for (const trial of fixture.trials) {
    const task = repository.getTask(trial.requestId);
    const resource = task && repository.getSegmentResources(task.segmentId);
    if (!resource || task?.state !== 'completed') throw new Error('Original proof task is not settled');
    paths.push(`${resource.workDir}/mvp-proof-${trial.nonce}.json`);
  }
  const hashes = async () => Object.fromEntries(await Promise.all(paths.map(async path => [path, createHash('sha256').update(await sandbox.fs.downloadFile(path, 20)).digest('hex')])));
  const before = await hashes(); evidence.beforeFileHashes = before;
  const staged = `${config.daemon.home}/bin/multica-${revision}`;
  await sandbox.fs.uploadFile(binary, staged);
  const verification = await sandbox.process.executeCommand(`chmod 700 ${shellArgument(staged)} && ${shellArgument(staged)} version --output json`, undefined, undefined, 30);
  if (verification.exitCode !== 0) throw new Error('Staged binary failed to execute');
  const version = JSON.parse(verification.result) as { version?: string; os?: string; arch?: string };
  if (version.version !== revision || version.os !== 'linux' || version.arch !== 'amd64') throw new Error('Staged actual binary version differs');
  evidence.verifiedBinary = version; evidence.phase = 'stopping-old-daemon'; await save();
  const stopped = await sandbox.process.executeCommand(`env HOME=${shellArgument(config.daemon.home)} ${shellArgument(`${config.daemon.home}/bin/multica`)} daemon stop`, undefined, undefined, 30);
  if (stopped.exitCode !== 0) throw new Error('Official Daemon stop failed');
  const stopDeadline = Date.now() + 30_000;
  while (await readDaemonHealth(sandbox)) { if (Date.now() > stopDeadline) throw new Error('Old Daemon still responds'); await delay(500); }
  evidence.oldHealthAbsent = true;
  config.daemon.expectedDaemonVersion = revision;
  config.daemon.binaryLocalPath = newBinaryPath;
  await writeFile(configPath, JSON.stringify(config, null, 2));
  evidence.privateConfigUpdated = true; evidence.phase = 'production-bootstrap'; await save();
  const service = createConfiguredPersonalSandboxService(config, repository, daytona, client);
  const resumed = await service.ensurePersonalSandbox(config.userId);
  if (resumed.id !== sandbox.id || resumed.state !== 'started') throw new Error('Bootstrap changed sandbox identity/state');
  const health = await readDaemonHealth(resumed);
  if (!health) throw new Error('New Daemon missing'); validateDaemonHealth(health, config.daemon);
  if (health.pid === beforeHealth.pid || health.status !== 'running') throw new Error('New Daemon process was not confirmed');
  const after = await hashes(); evidence.afterFileHashes = after;
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Native CLI configuration or proof files changed');
  evidence.daemonId = health.daemon_id; evidence.previousPid = beforeHealth.pid; evidence.pid = health.pid;
  evidence.complete = true; evidence.phase = 'complete'; evidence.finishedAt = new Date().toISOString(); await save();
  console.log(JSON.stringify({ complete: true, sandboxId: sandbox.id, revision, evidencePath }));
} catch {
  evidence.complete = false; evidence.failure = 'Deployment stopped; inspect retained phase and exact existing resource before recovery';
  if (ownsEvidence) await save(); console.error(evidence.failure); process.exitCode = 1;
} finally { clearTimeout(deadline); repository.close(); }
