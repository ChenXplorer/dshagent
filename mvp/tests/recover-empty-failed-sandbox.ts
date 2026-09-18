/** Explicit one-off repair. Never called by Gateway/driver or retried automatically. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Daytona, DaytonaError, DaytonaNotFoundError } from '@daytona/sdk';
import { CorrelationRepository } from '../packages/persistence/index.ts';
import { PERSONAL_SANDBOX_LABELS } from '../packages/sandbox-management/index.ts';
import type { DeploymentDriverConfiguration } from '../apps/dsh-host/create-driver.ts';

const [configPath, sandboxId, creationRequestId, evidencePath, ownerOidcPath] = process.argv.slice(2);
if (!configPath || !sandboxId || !creationRequestId || !evidencePath) throw new Error('Pass private config, explicitly authorized failed sandbox ID, exact creation request ID, NEW audit JSON');
const config = JSON.parse(await readFile(configPath, 'utf8')) as DeploymentDriverConfiguration;
const repository = new CorrelationRepository(config.correlationDatabase);
const ownerOidc = ownerOidcPath ? JSON.parse(await readFile(ownerOidcPath, 'utf8')) as { id_token: string } : undefined;
const daytona = new Daytona({ apiUrl: config.daytona.apiUrl, ...(ownerOidc ? { jwtToken: ownerOidc.id_token } : { apiKey: config.daytona.apiKey }),
  organizationId: config.daytona.organizationId, target: config.daytona.target, otelEnabled: false });
const evidence: Record<string, unknown> = { sandboxId, creationRequestId, userId: config.userId, authMode: ownerOidc ? 'explicit-owner-oidc' : 'deployment-key', startedAt: new Date().toISOString(), phase: 'validating' };
let ownsEvidence = false;
const persist = () => writeFile(evidencePath, JSON.stringify(evidence, null, 2));
const deadline = setTimeout(() => { console.error('Repair observer timed out; no automatic deletion or reservation retry'); process.exit(1); }, 120_000);
try {
  const binding = repository.getSandbox(config.userId);
  if (!binding || binding.creationRequestId !== creationRequestId || binding.sandboxId !== null || binding.state !== 'creation_unknown') throw new Error('Exact never-bound unknown reservation required');
  const check = new DatabaseSync(config.correlationDatabase, { readOnly: true });
  try {
    const taskCount = Number(check.prepare('SELECT COUNT(*) count FROM task_intents WHERE userId = ?').get(config.userId)?.count);
    const segmentCount = Number(check.prepare('SELECT COUNT(*) count FROM execution_segments WHERE userId = ?').get(config.userId)?.count);
    if (taskCount !== 0 || segmentCount !== 0) throw new Error('Reservation has execution references');
    evidence.taskCount = taskCount; evidence.segmentCount = segmentCount;
  } finally { check.close(); }
  const sandbox = await daytona.get(sandboxId);
  if (sandbox.id !== sandboxId || sandbox.state !== 'error' || sandbox.errorReason !== 'timeout waiting for daemon to start' ||
      sandbox.labels[PERSONAL_SANDBOX_LABELS.user] !== config.userId || sandbox.labels[PERSONAL_SANDBOX_LABELS.creation] !== creationRequestId) {
    throw new Error('Exact empty startup-timeout sandbox ownership/state mismatch');
  }
  evidence.previousState = sandbox.state; evidence.errorReason = sandbox.errorReason;
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2), { flag: 'wx' }); ownsEvidence = true;
  evidence.phase = 'official-delete-sent-once'; await persist();
  try { await daytona.delete(sandbox, 60); evidence.deleteReturned = true; }
  catch (error) {
    evidence.deleteResponseUnknown = true;
    if (error instanceof DaytonaError) evidence.deleteError = { name: error.name, statusCode: error.statusCode, errorCode: error.errorCode };
  }
  let absent = false;
  try { await daytona.get(sandboxId); }
  catch (error) { if (error instanceof DaytonaNotFoundError) absent = true; else throw error; }
  if (!absent) throw new Error('Official GET did not confirm deletion');
  evidence.officialGet404Confirmed = true; evidence.phase = 'deletion-confirmed-before-reservation-cas'; await persist();
  if (!repository.clearUnboundSandboxAfterVerifiedDeletion({ userId: config.userId, creationRequestId, deletedSandboxId: sandboxId, deletionEvidence: evidencePath })) {
    throw new Error('Reservation changed; it was not cleared');
  }
  evidence.reservationCleared = true; evidence.audit = repository.getSandboxReplacementAudits(config.userId);
  evidence.phase = 'complete-awaiting-native-resume'; evidence.finishedAt = new Date().toISOString(); await persist();
  console.log(JSON.stringify({ deletedSandboxId: sandboxId, officialGet404Confirmed: true, reservationCleared: true, evidencePath }));
} catch {
  evidence.failure = 'Explicit repair stopped; inspect audit before any further operation';
  if (ownsEvidence) await persist(); console.error(evidence.failure); process.exitCode = 1;
} finally { clearTimeout(deadline); repository.close(); }
