import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { DeploymentDriverConfiguration } from '../dsh-host/create-driver.ts';
import type { EffectiveProfile, HostLaunchInput, HostWebRequestInit, TenantHostHandle } from '../../packages/tenant-control/index.ts';

export interface ProcessHostLauncherOptions {
  /** Private state root. Each user gets <root>/<user>/host-v<Profile>. */
  stateDirectory: string;
  nodeExecutable?: string;
  dshStartScript?: string;
  profileGeneratorScript?: string;
  driverModule?: string;
  /** Secrets and Daytona/Multica details are supplied by deployment config, never by the browser. */
  createDriverConfiguration(input: { userId: string; profile: EffectiveProfile; sandboxId: string; runtimeDirectory: string; skillsFile: string }): Promise<DeploymentDriverConfiguration> | DeploymentDriverConfiguration;
  healthTimeoutMs?: number;
  healthPollMs?: number;
  drainTimeoutMs?: number;
  environment?: NodeJS.ProcessEnv;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolvePromise(); }); });
  const value = (server.address() as import('node:net').AddressInfo).port;
  await new Promise<void>((resolvePromise, reject) => server.close(error => error ? reject(error) : resolvePromise()));
  return value;
}

/** Keep the DSH-generated browser token inside this process. The outer
 * Gateway exchanges it for the official signed cookie and never exposes the
 * token in its own URL or JSON responses. */
function launchPathFromOutput(text: string, webPort: number): string | undefined {
  for (const raw of text.match(/https?:\/\/[^\s\x1b<>"']+/gu) ?? []) {
    try {
      const value = new URL(raw);
      if (!['127.0.0.1', 'localhost'].includes(value.hostname) || value.port !== String(webPort) || value.pathname !== '/') continue;
      if (value.searchParams.getAll('token').length !== 1 || value.searchParams.get('token')?.trim() === '') continue;
      return `${value.pathname}${value.search}`;
    } catch { /* Ignore unrelated URLs written by DSH plugins. */ }
  }
  return undefined;
}
async function waitForWebLaunchPath(readOutput: () => string, webPort: number, child: ChildProcess, timeoutMs: number, pollMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = launchPathFromOutput(readOutput(), webPort);
    if (found) return found;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('DSH Host exited before publishing its Web launch URL');
    await delay(pollMs);
  }
  throw new Error('DSH Host did not publish its Web launch URL');
}

function pluginRows(profile: EffectiveProfile): Array<Record<string, unknown>> {
  return [...profile.systemPlugins, ...profile.plugins].filter(item => item.enabled).map(item => {
    // DSH Loader accepts an absolute/file module path or a package
    // specifier. Hub-managed packages use the latter; deployment-staged
    // plugins continue to use their reviewed modulePath.
    const name = item.packageName ?? item.modulePath;
    if (!name) throw new Error(`Plugin ${item.id} has no resolvable modulePath or packageName`);
    return { id: item.id, name, config: { version: item.version, sha256: item.sha256 } };
  });
}

function skillRows(profile: EffectiveProfile): Array<Record<string, unknown>> {
  return [...profile.systemSkills, ...profile.skills].filter(item => item.enabled).map(item => ({ key: item.key, name: item.name, version: item.version, description: item.description, content: item.content, config: { source: item.key.startsWith('system-') ? 'system' : 'tenant-profile' } }));
}

/**
 * Real launcher for the already reviewed DSH host entrypoint. It writes one
 * private Profile/config/session root per user, starts the official DSH process
 * on loopback, and exposes only the host Gateway to HostSupervisor.
 */
export class ProcessHostLauncher {
  private readonly root: string;
  private readonly node: string;
  private readonly script: string;
  private readonly profileScript: string;
  private readonly driverModule: string;
  private readonly healthTimeoutMs: number;
  private readonly healthPollMs: number;
  private readonly drainTimeoutMs: number;
  private readonly environment: NodeJS.ProcessEnv;

  constructor(private readonly options: ProcessHostLauncherOptions) {
    if (!isAbsolute(options.stateDirectory)) throw new Error('stateDirectory must be absolute');
    this.root = resolve(options.stateDirectory); this.node = options.nodeExecutable ?? process.execPath;
    this.script = resolve(options.dshStartScript ?? join(dirname(fileURLToPath(import.meta.url)), '../dsh-host/start.mjs'));
    this.profileScript = resolve(options.profileGeneratorScript ?? join(dirname(this.script), 'create-profile.mjs'));
    this.driverModule = resolve(options.driverModule ?? join(dirname(this.script), 'create-driver.ts'));
    this.healthTimeoutMs = options.healthTimeoutMs ?? 60_000; this.healthPollMs = options.healthPollMs ?? 200;
    this.drainTimeoutMs = options.drainTimeoutMs ?? 120_000;
    if (!Number.isFinite(this.healthTimeoutMs) || this.healthTimeoutMs <= 0 || !Number.isFinite(this.healthPollMs) || this.healthPollMs <= 0 || !Number.isFinite(this.drainTimeoutMs) || this.drainTimeoutMs <= 0) throw new Error('Host health timing must be positive');
    this.environment = { ...process.env, ...options.environment };
  }

  async launch(input: HostLaunchInput): Promise<TenantHostHandle> {
    const userRoot = join(this.root, input.userId); const versionRoot = join(userRoot, `host-v${String(input.profile.version)}`);
    // Session JSONL, DSH correlation records, workspace roots and CLI homes
    // are stable across Profile restarts. Only the reviewed Profile, driver
    // config and logs are versioned, so a plugin rollback cannot orphan a chat.
    // In a Hub deployment, DSH_HOME is the user's managed Profile root; the
    // Node Agent management.profiles[].profileDirectory must point at
    // <userRoot>/home/profiles/web, and runtimeId must match the Gateway map.
    const sessions = join(userRoot, 'sessions'); const workspace = join(userRoot, 'workspace'); const home = join(userRoot, 'home');
    await Promise.all([mkdir(sessions, { recursive: true }), mkdir(workspace, { recursive: true }), mkdir(home, { recursive: true }), mkdir(versionRoot, { recursive: true })]);
    const profilePath = join(versionRoot, 'mvp.cordis.json'); const skillsPath = join(userRoot, 'skills.json'); const configPath = join(versionRoot, 'driver.config.json');
    const customPlugins = pluginRows(input.profile);
    // Tenant Profile version controls tenant configuration. The two platform
    // plugin paths also record the release directory, so re-render an existing
    // file only when a platform release changes those baseline paths. Session
    // JSONL and user plugins remain under their stable locations.
    if (!(await exists(profilePath)) || await needsBaselineRefresh(profilePath, dirname(this.script))) {
      await rm(profilePath, { force: true });
      await runNode(this.node, this.profileScript, [profilePath, sessions, JSON.stringify(customPlugins)]);
    }
    await writeFile(skillsPath, JSON.stringify(skillRows(input.profile), null, 2) + '\n', { mode: 0o600 });
    const config = await this.options.createDriverConfiguration({ userId: input.userId, profile: input.profile, sandboxId: input.sandbox.id, runtimeDirectory: userRoot, skillsFile: skillsPath });
    if (config.userId !== input.userId || !isAbsolute(config.correlationDatabase)) throw new Error('Host driver configuration must belong to the requested user and use an absolute database path');
    await writeFile(configPath, JSON.stringify({ ...config, managedSkillsFile: skillsPath }, null, 2) + '\n', { mode: 0o600 });
    const [webPort, gatewayPort] = await Promise.all([freePort(), freePort()]);
    const token = randomBytes(32).toString('hex');
    const env: NodeJS.ProcessEnv = { ...this.environment, DSH_HOME: home, DSH_MVP_PROFILE_PATCH: profilePath, DSH_MVP_DRIVER_MODULE: this.driverModule, DSH_MVP_CONFIG: configPath, DSH_MVP_USER_ID: input.userId, DSH_MVP_HOST_WORKSPACE: workspace, DSH_MVP_GATEWAY_TOKEN: token, DSH_MVP_GATEWAY_PORT: String(gatewayPort) };
    const child = spawn(this.node, [this.script, '--host', '127.0.0.1', '--port', String(webPort)], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const stdout = createWriteStream(join(versionRoot, 'host.stdout.log'), { flags: 'a' }); const stderr = createWriteStream(join(versionRoot, 'host.stderr.log'), { flags: 'a' });
    let launchOutput = '';
    child.stdout?.on('data', chunk => { launchOutput = (launchOutput + String(chunk)).slice(-16 * 1024); });
    child.stdout?.pipe(stdout); child.stderr?.pipe(stderr);
    let webLaunchPath: string;
    try {
      await waitForHealth(`http://127.0.0.1:${String(gatewayPort)}`, token, child, this.healthTimeoutMs, this.healthPollMs);
      webLaunchPath = await waitForWebLaunchPath(() => launchOutput, webPort, child, this.healthTimeoutMs, this.healthPollMs);
    }
    catch (error) { terminate(child); throw error; }
    return new ProcessHostHandle(input.userId, input.profile.version, `http://127.0.0.1:${String(gatewayPort)}`, token, `http://127.0.0.1:${String(webPort)}`, webLaunchPath!, child, stdout, stderr, this.drainTimeoutMs, this.healthPollMs);
  }
}

class ProcessHostHandle implements TenantHostHandle {
  constructor(readonly userId: string, readonly profileVersion: number, readonly baseUrl: string, private readonly token: string,
    private readonly webBaseUrl: string, private readonly webLaunchPath: string | undefined, private readonly child: ChildProcess,
    private readonly stdout: NodeJS.WritableStream, private readonly stderr: NodeJS.WritableStream, private readonly drainTimeoutMs: number, private readonly pollMs: number) {}
  async request(path: string, init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal } = {}): Promise<Response> {
    if (!path.startsWith('/v1/') && !path.startsWith('/mvp/')) throw new Error('Host request path is outside the owned API');
    const headers = new Headers(init.headers); headers.set('Authorization', `Bearer ${this.token}`); headers.set('Accept', 'application/json');
    return fetch(`${this.baseUrl}${path}`, { method: init.method ?? 'GET', headers, body: init.body, signal: init.signal, redirect: 'error' });
  }
  async openWeb(init: HostWebRequestInit = {}): Promise<Response> {
    if (!this.webLaunchPath) throw new Error('DSH Web launch URL is not available yet');
    return this.webRequest(this.webLaunchPath, init);
  }
  async webRequest(path: string, init: HostWebRequestInit = {}): Promise<Response> {
    if (!path.startsWith('/')) throw new Error('DSH Web request path must be absolute');
    const target = new URL(path, this.webBaseUrl);
    if (target.origin !== this.webBaseUrl) throw new Error('DSH Web request path escapes the user Host');
    const bytes = typeof init.body === 'string' || init.body === undefined ? undefined : (() => { const copy = new Uint8Array(init.body.byteLength); copy.set(init.body); return copy.buffer; })();
    const body = init.body === undefined ? undefined : typeof init.body === 'string' ? init.body : new Blob([bytes!]);
    return fetch(target, { method: init.method ?? 'GET', headers: init.headers, body, signal: init.signal, redirect: 'manual' });
  }
  webSocketUrl(path: string): string {
    // DSH has exactly one browser stream carrier. Do not turn this method
    // into a general private-host tunnel.
    if (path !== '/api/remote.mux') throw new Error('DSH WebSocket path is outside the Remote stream mux');
    const target = new URL(path, this.webBaseUrl);
    target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
    return target.href;
  }
  async drain(): Promise<void> {
    const deadline = Date.now() + this.drainTimeoutMs;
    while (Date.now() < deadline) {
      const response = await fetch(`${this.baseUrl}/v1/health`, { headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(2_000) });
      if (response.ok) { const health = await response.json() as { busy?: boolean }; if (health.busy !== true) return; }
      await delay(this.pollMs);
    }
    throw new Error('DSH Host is busy; Profile change waits for the current Task to finish');
  }
  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) { this.stdout.end(); this.stderr.end(); return; }
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { terminate(this.child); resolve(); }, 5_000); timer.unref?.();
      this.child.once('exit', () => { clearTimeout(timer); resolve(); }); terminate(this.child);
    });
    this.stdout.end(); this.stderr.end();
  }
}

async function exists(path: string): Promise<boolean> { try { await readFile(path); return true; } catch { return false; } }

async function needsBaselineRefresh(profilePath: string, hostDirectory: string): Promise<boolean> {
  try {
    const profile = JSON.parse(await readFile(profilePath, 'utf8')) as Array<{ insert?: Array<{ id?: string; name?: string }> }>;
    const names = new Map(profile.flatMap(row => row.insert ?? []).filter(entry => entry.id && entry.name).map(entry => [entry.id!, resolve(entry.name!)]));
    return names.get('mvp-multica-loop') !== resolve(hostDirectory, 'multica-plugin.ts')
      || names.get('mvp-runtime-selector') !== resolve(hostDirectory, '../../packages/ui-runtime-selector/index.mjs');
  } catch {
    // A corrupt generated Profile is never a safe launch input; regenerate it
    // from the durable tenant manifest before the child Host starts.
    return true;
  }
}

async function runNode(node: string, script: string, args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(node, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); let stderr = '';
    child.stderr?.on('data', chunk => { stderr += String(chunk).slice(-4096); });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolvePromise() : reject(new Error(`Profile generation failed: ${stderr.trim() || `exit ${String(code)}`}`)));
  });
}

async function waitForHealth(baseUrl: string, token: string, child: ChildProcess, timeoutMs: number, pollMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs; let lastError = 'Host has not become ready';
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`DSH Host exited before health check (${String(child.exitCode ?? child.signalCode)})`);
    try {
      const response = await fetch(`${baseUrl}/v1/health`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(Math.min(2_000, timeoutMs)) });
      if (response.ok) { const body = await response.json() as { ready?: boolean }; if (body.ready === true) return; lastError = 'Host health did not report ready'; }
      else lastError = `Host Gateway returned HTTP ${response.status}`;
    } catch (error) { lastError = error instanceof Error ? error.message : 'Host health request failed'; }
    await delay(pollMs);
  }
  throw new Error(`Timed out waiting for DSH Host health: ${lastError}`);
}

function terminate(child: ChildProcess): void { try { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); } catch { /* process may have exited */ } }
