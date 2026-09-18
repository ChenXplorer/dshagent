import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Sandbox } from '@daytona/sdk';
import { assertCliSecretsPresent, buildNativeCliConfiguration, type NativeCliConfigurationInput } from '../cli-configuration/index.ts';

export interface DaemonBootstrapConfiguration {
  home: string;
  daemonId: string;
  serverUrl: string;
  workspaceId: string;
  token: string;
  workspacesRoot: string;
  maxConcurrentTasks: number;
  binaryLocalPath: string;
  expectedDaemonVersion: string;
  expectedCodexVersion: string;
  expectedClaudeVersion: string;
  nativeCli: NativeCliConfigurationInput;
  nativeCatalog?: { localPath: string; sha256: string };
  secrets: Record<string, string>;
  /**
   * Optional compatibility gate for the historical enhanced-health patch.
   * The default MVP path uses the official, unmodified Daemon and therefore
   * accepts its core health fields only.
   */
  requireEnhancedHealth?: boolean;
}

export interface DaemonHealth {
  status: string; daemon_id: string; profile: string; server_url: string;
  cli_version: string; os: string; pid: number;
  /** These fields are absent at runtime on an official unmodified Daemon. */
  active_task_ids: string[];
  claims_in_flight: number;
  transcript_pending_by_task: Record<string, number>;
  transcript_outbox_error: boolean;
}

export function shellArgument(value: string): string { return `'${value.replace(/'/gu, `'"'"'`)}'`; }
async function python(sandbox: Sandbox, source: string, args: string[] = [], auditAsRoot = false): Promise<string> {
  const result = await sandbox.process.executeCommand(`${auditAsRoot ? 'sudo -n ' : ''}python3 -c ${shellArgument(source)} ${args.map(shellArgument).join(' ')}`, undefined, undefined, 30);
  if (result.exitCode !== 0) throw new Error('Sandbox bootstrap/probe failed; inspect private sandbox logs');
  return result.result;
}
const healthProbe = `import json,urllib.request,urllib.error
try:
  with urllib.request.urlopen('http://127.0.0.1:19514/health',timeout=3) as r: print(r.read().decode())
except (urllib.error.URLError,TimeoutError): print('null')`;

export async function readDaemonHealth(sandbox: Sandbox): Promise<DaemonHealth | null> {
  return JSON.parse(await python(sandbox, healthProbe)) as DaemonHealth | null;
}

/** Whether this Daemon exposes the optional outbox/claim lifecycle fields. */
export function hasEnhancedHealthEvidence(health: DaemonHealth): boolean {
  return health.active_task_ids !== undefined || health.claims_in_flight !== undefined ||
    health.transcript_pending_by_task !== undefined || health.transcript_outbox_error !== undefined;
}

export function validateDaemonHealth(health: DaemonHealth, configuration: DaemonBootstrapConfiguration): void {
  if (health.daemon_id !== configuration.daemonId || (health.profile !== undefined && health.profile !== '') || health.server_url.replace(/\/$/u, '') !== configuration.serverUrl.replace(/\/$/u, '') ||
      health.cli_version !== configuration.expectedDaemonVersion || health.os !== 'linux' || !Number.isInteger(health.pid) || health.pid <= 1) {
    throw new Error('Live Daemon identity/version differs from the configured personal sandbox');
  }
  const enhanced = hasEnhancedHealthEvidence(health);
  if (configuration.requireEnhancedHealth && !enhanced) {
    throw new Error('Required enhanced Daemon health evidence is unavailable');
  }
  if (enhanced && (!Array.isArray(health.active_task_ids) || !health.active_task_ids.every(value => typeof value === 'string') ||
      !Number.isInteger(health.claims_in_flight) || health.claims_in_flight < 0 ||
      typeof health.transcript_pending_by_task !== 'object' || health.transcript_pending_by_task === null ||
      Object.values(health.transcript_pending_by_task).some(value => !Number.isInteger(value) || value < 0) || typeof health.transcript_outbox_error !== 'boolean')) {
    throw new Error('Malformed enhanced Daemon health evidence');
  }
}

/** Writes real native CLI configuration and launches the pinned official Daemon in the real SDK sandbox. */
export function createDaemonBootstrap(configuration: DaemonBootstrapConfiguration) {
  for (const value of [configuration.home, configuration.workspacesRoot]) {
    if (!value.startsWith('/') || value === '/' || posix.normalize(value) !== value) throw new Error('Daemon directories must be normalized absolute Linux paths');
  }
  if (!configuration.daemonId || !configuration.workspaceId || !configuration.token) throw new Error('Real Multica authentication and Daemon identity are required');
  const native = buildNativeCliConfiguration(configuration.nativeCli);
  if (Boolean(configuration.nativeCli.codex.modelCatalogPath) !== Boolean(configuration.nativeCatalog)) throw new Error('Native catalog path requires a pinned local catalog source');
  assertCliSecretsPresent(native, configuration.secrets);
  const environment: Record<string, string> = { ...native.environment, HOME: configuration.home,
    MULTICA_SERVER_URL: configuration.serverUrl, MULTICA_DAEMON_AUTO_UPDATE: 'false' };
  for (const binding of native.secretBindings) environment[binding.targetEnv] = configuration.secrets[binding.sourceEnv];
  const daemonConfig = { server_url: configuration.serverUrl, app_url: configuration.serverUrl, workspace_id: configuration.workspaceId,
    token: configuration.token, workspaces_root: configuration.workspacesRoot, max_concurrent_tasks: configuration.maxConcurrentTasks };
  const bootstrapFingerprint = createHash('sha256').update(JSON.stringify([native, environment, daemonConfig,
    configuration.expectedDaemonVersion, configuration.expectedCodexVersion, configuration.expectedClaudeVersion,
    configuration.nativeCatalog?.sha256, configuration.requireEnhancedHealth === true])).digest('hex');
  const fingerprintPath = posix.join(configuration.home, 'bootstrap.sha256');
  return async (sandbox: Sandbox): Promise<void> => {
    let catalog: Buffer | undefined;
    if (configuration.nativeCatalog) {
      catalog = await readFile(configuration.nativeCatalog.localPath);
      if (createHash('sha256').update(catalog).digest('hex') !== configuration.nativeCatalog.sha256) throw new Error('Native Codex model catalog hash changed');
      const metadata = JSON.parse(catalog.toString()) as { models?: Array<{ slug: string }> };
      if (!metadata.models?.some(model => model.slug === configuration.nativeCli.codex.model)) throw new Error('Configured model absent from pinned official native catalog');
    }
    let health = await readDaemonHealth(sandbox);
    if (health) {
      validateDaemonHealth(health, configuration);
      const actual = await python(sandbox, 'import pathlib,sys;print(pathlib.Path(sys.argv[1]).read_text().strip())', [fingerprintPath]);
      if (actual.trim() !== bootstrapFingerprint) throw new Error('Running Daemon configuration changed; an explicit idle restart is required');
    } else {
      const privateDirs = [configuration.home, posix.join(configuration.home, '.multica'), posix.join(configuration.home, 'bin'),
        configuration.nativeCli.codexHome, configuration.nativeCli.claudeHome, configuration.workspacesRoot];
      await python(sandbox, 'import os,sys\nfor p in sys.argv[1:]: os.makedirs(p,mode=0o700,exist_ok=True);os.chmod(p,0o700)', privateDirs);
      const binaryPath = posix.join(configuration.home, 'bin', 'multica');
      await sandbox.fs.uploadFile(await readFile(configuration.binaryLocalPath), binaryPath);
      await sandbox.fs.setFilePermissions(binaryPath, { mode: '700' });
      for (const file of [...native.files, { path: posix.join(configuration.home, '.multica/config.json'), contents: JSON.stringify(daemonConfig) },
        { path: posix.join(configuration.home, 'daemon-env.json'), contents: JSON.stringify(environment) },
        { path: fingerprintPath, contents: bootstrapFingerprint }]) {
        await sandbox.fs.uploadFile(Buffer.from(file.contents), file.path);
        await sandbox.fs.setFilePermissions(file.path, { mode: '600' });
      }
      if (catalog) {
        await sandbox.fs.uploadFile(catalog, configuration.nativeCli.codex.modelCatalogPath!);
        await sandbox.fs.setFilePermissions(configuration.nativeCli.codex.modelCatalogPath!, { mode: '600' });
      }
      // Versions are checked without invoking a model. No secret is interpolated into a shell command.
      await python(sandbox, `import subprocess,sys
for command,expected in [('codex',sys.argv[1]),('claude',sys.argv[2])]:
  value=subprocess.check_output([command,'--version'],text=True,timeout=15).strip()
  if expected not in value.split(): raise RuntimeError('CLI version mismatch')`, [configuration.expectedCodexVersion, configuration.expectedClaudeVersion]);
      await python(sandbox, `import os,json,subprocess,sys
home,binary,daemon,slots=sys.argv[1:]
env=os.environ.copy()
for key in ['MULTICA_CODEX_MODEL','MULTICA_CLAUDE_MODEL','OPENAI_API_KEY','ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN']: env.pop(key,None)
env.update(json.load(open(home+'/daemon-env.json')))
with open(home+'/daemon.log','ab',buffering=0) as log:
  subprocess.Popen([binary,'daemon','start','--foreground','--no-auto-update','--no-auto-reload','--daemon-id',daemon,'--max-concurrent-tasks',slots],env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)`,
      [configuration.home, binaryPath, configuration.daemonId, String(configuration.maxConcurrentTasks)]);
    }
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      health = await readDaemonHealth(sandbox);
      if (health) { validateDaemonHealth(health, configuration); if (health.status === 'running') return; }
      await delay(1000);
    }
    throw new Error('Real Multica Daemon did not become ready before the deadline');
  };
}

/** Conservative real process evidence. Sibling CLI descendants defer settlement until they also exit. */
export async function confirmSandboxTaskSettled(sandbox: Sandbox, configuration: DaemonBootstrapConfiguration, taskId: string) {
  const health = await readDaemonHealth(sandbox);
  if (!health) return { executionStopped: false, transcriptFlushed: false };
  validateDaemonHealth(health, configuration);
  const enhanced = hasEnhancedHealthEvidence(health);
  const transcriptFlushed = enhanced && !health.transcript_outbox_error &&
    (health.transcript_pending_by_task?.[taskId] ?? 0) === 0 && !health.active_task_ids?.includes(taskId);
  // Enhanced health can prove that the Daemon has no claim/outbox work. The
  // official unmodified Daemon has no such fields, so continue with the
  // conservative process probe instead of rejecting the task outright.
  if (enhanced && (!transcriptFlushed || health.claims_in_flight !== 0)) return { executionStopped: false, transcriptFlushed };
  const processProbe = `import pathlib,sys,json
daemon=int(sys.argv[1]);marker=('MULTICA_TASK_ID='+sys.argv[2]).encode();parents={};matches=[];unreadable=[]
for p in pathlib.Path('/proc').iterdir():
  if not p.name.isdigit(): continue
  try:
    stat=(p/'stat').read_text();parents[int(p.name)]=int(stat[stat.rfind(')')+2:].split()[1])
    if marker in (p/'environ').read_bytes().split(b'\\0'): matches.append(int(p.name))
  except (FileNotFoundError,ProcessLookupError): pass
  except PermissionError: unreadable.append(int(p.name))
desc={daemon}
while True:
  expanded=desc|{pid for pid,parent in parents.items() if parent in desc}
  if expanded==desc: break
  desc=expanded
print(json.dumps({'stopped':daemon in parents and not matches and len(desc)==1 and not unreadable}))`;
  const first = JSON.parse(await python(sandbox, processProbe, [String(health.pid), taskId], true)) as { stopped: boolean };
  if (!first.stopped) return { executionStopped: false, transcriptFlushed };
  await delay(200);
  const second = JSON.parse(await python(sandbox, processProbe, [String(health.pid), taskId], true)) as { stopped: boolean };
  const after = await readDaemonHealth(sandbox);
  if (!after) return { executionStopped: false, transcriptFlushed: false };
  validateDaemonHealth(after, configuration);
  if (!hasEnhancedHealthEvidence(after)) {
    // Official mode has no daemon-side transcript outbox status. At this
    // boundary TaskDriver has already read the terminal Task messages; a
    // stable health PID with no task descendants is the available evidence.
    return { executionStopped: second.stopped === true && after.pid === health.pid, transcriptFlushed: second.stopped === true };
  }
  return { executionStopped: second.stopped === true && after.pid === health.pid && after.claims_in_flight === 0,
    transcriptFlushed: !after.transcript_outbox_error && (after.transcript_pending_by_task?.[taskId] ?? 0) === 0 && !after.active_task_ids?.includes(taskId) };
}
