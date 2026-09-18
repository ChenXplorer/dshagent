import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

/** The public configuration shape consumed by the pinned upstream Node Agent. */
export interface NodeAgentProfileInput {
  runtimeId: string;
  profileDirectory: string;
  profileName?: string;
  dshExecutable?: string;
  snapshotPaths?: string[];
}

export interface NodeAgentConfigInput {
  hubUrl: string;
  /** Required only for the private loopback HTTP Hub mode. */
  originSecret?: string;
  nodeId: string;
  accessClientId: string;
  accessClientSecret: string;
  enrollmentCode?: string;
  hubPublicKey: string;
  stateDirectory: string;
  ipcEndpoint: string;
  profiles: NodeAgentProfileInput[];
}

const IDENTIFIER = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u;
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/u;

function text(value: unknown, field: string, max = 4096): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/u.test(value)) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function absolutePath(value: unknown, field: string): string {
  const result = text(value, field);
  if (!isAbsolute(result) && !WINDOWS_ABSOLUTE.test(result)) throw new Error(`${field} must be absolute`);
  return result;
}

function identifier(value: unknown, field: string): string {
  const result = text(value, field, 64);
  if (!IDENTIFIER.test(result)) throw new Error(`${field} is invalid`);
  return result;
}

function hubKey(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096
    || /[\u0000-\u0009\u000b\u000c\u000e-\u001f]/u.test(value)) {
    throw new Error('hubPublicKey is invalid');
  }
  if (value.length < 80) throw new Error('hubPublicKey is too short');
  return value;
}

/**
 * Validate and build exactly the upstream Node Agent JSON shape. Secrets are
 * copied only into the returned object; this helper never logs them.
 */
export function renderNodeAgentConfig(input: NodeAgentConfigInput): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Node Agent input must be an object');
  let hub: URL;
  try { hub = new URL(text(input.hubUrl, 'hubUrl')); } catch { throw new Error('hubUrl must be an HTTPS or loopback HTTP origin'); }
  const loopbackHttp = hub.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(hub.hostname);
  if (hub.pathname !== '/' || hub.search || hub.hash || hub.username || hub.password || (hub.protocol !== 'https:' && !loopbackHttp)) {
    throw new Error('hubUrl must be an HTTPS or loopback HTTP origin without path, credentials, query, or fragment');
  }
  const originSecret = input.originSecret === undefined ? undefined : text(input.originSecret, 'originSecret');
  if (loopbackHttp && (originSecret === undefined || originSecret.length < 32)) throw new Error('loopback HTTP requires originSecret with at least 32 characters');
  if (hub.protocol === 'https:' && originSecret !== undefined) throw new Error('originSecret is accepted only for loopback HTTP');
  const nodeId = identifier(input.nodeId, 'nodeId');
  const accessClientId = text(input.accessClientId, 'accessClientId', 512);
  const accessClientSecret = text(input.accessClientSecret, 'accessClientSecret', 4096);
  if (accessClientSecret.length < 32) throw new Error('accessClientSecret must be at least 32 characters');
  // The official enrollment response returns a PEM value with line breaks.
  // Permit CR/LF here while still rejecting every other control character.
  const hubPublicKey = hubKey(input.hubPublicKey);
  const stateDirectory = absolutePath(input.stateDirectory, 'stateDirectory');
  const ipcEndpoint = text(input.ipcEndpoint, 'ipcEndpoint');
  const profiles = input.profiles;
  if (!Array.isArray(profiles) || profiles.length < 1 || profiles.length > 64) throw new Error('profiles must contain between 1 and 64 entries');
  const runtimeIds = new Set<string>();
  const profileDirectories = new Set<string>();
  const managementProfiles = profiles.map((profile, index) => {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new Error(`profiles[${String(index)}] is invalid`);
    const runtimeId = identifier(profile.runtimeId, `profiles[${String(index)}].runtimeId`);
    if (runtimeIds.has(runtimeId)) throw new Error('profiles runtimeId values must be unique');
    runtimeIds.add(runtimeId);
    const profileDirectory = absolutePath(profile.profileDirectory, `profiles[${String(index)}].profileDirectory`);
    const directoryKey = profileDirectory.replace(/[\\/]+/gu, '/').replace(/\/$/u, '').toLowerCase();
    if (profileDirectories.has(directoryKey)) throw new Error('profiles profileDirectory values must be unique');
    profileDirectories.add(directoryKey);
    const profileName = text(profile.profileName ?? 'web', `profiles[${String(index)}].profileName`, 64);
    const dshExecutable = text(profile.dshExecutable ?? 'dsh', `profiles[${String(index)}].dshExecutable`);
    const snapshotPaths = profile.snapshotPaths ?? [];
    if (!Array.isArray(snapshotPaths) || snapshotPaths.length > 64) throw new Error(`profiles[${String(index)}].snapshotPaths is invalid`);
    return {
      runtimeId,
      profileDirectory,
      profileName,
      dshExecutable,
      snapshotPaths: snapshotPaths.map((path, pathIndex) => absolutePath(path, `profiles[${String(index)}].snapshotPaths[${String(pathIndex)}]`)),
    };
  });
  const result: Record<string, unknown> = {
    hubUrl: hub.toString().replace(/\/$/u, ''), nodeId, accessClientId, accessClientSecret,
    ...(originSecret === undefined ? {} : { originSecret }),
    hubPublicKey, stateDirectory, ipcEndpoint,
    management: { profiles: managementProfiles },
  };
  if (input.enrollmentCode !== undefined) result.enrollmentCode = text(input.enrollmentCode, 'enrollmentCode', 512);
  return result;
}

export async function writeNodeAgentConfig(inputPath: string, outputPath: string): Promise<void> {
  const source = resolve(text(inputPath, 'inputPath'));
  const destination = resolve(text(outputPath, 'outputPath'));
  if (!isAbsolute(inputPath) || !isAbsolute(outputPath)) throw new Error('inputPath and outputPath must be absolute');
  const raw = JSON.parse(await readFile(source, 'utf8')) as NodeAgentConfigInput;
  const config = renderNodeAgentConfig(raw);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await writeFile(destination, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(destination, 0o600);
}

if (process.argv[1]?.endsWith('render-node-agent-config.ts')) {
  const [inputPath, outputPath] = process.argv.slice(2);
  if (!inputPath || !outputPath) throw new Error('Usage: npx tsx render-node-agent-config.ts <absolute-input.json> <absolute-output.json>');
  await writeNodeAgentConfig(inputPath, outputPath);
  console.log(`Node Agent config written to ${resolve(outputPath)}`);
}
