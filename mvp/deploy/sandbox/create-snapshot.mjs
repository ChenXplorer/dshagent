import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { routeMinioThroughLoopback } from './minio-loopback.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const project = resolve(here, '../../..');
const runtime = resolve(project, '.runtime/daytona');
const stage = resolve(runtime, 'snapshot-build');
const name = process.env.DSH_SNAPSHOT_NAME ?? 'dsh-mvp-cli-official-codex01540-claude21270';
if (!/^[a-z0-9][a-z0-9-]{2,100}$/.test(name)) throw new Error('Invalid snapshot name');
const multicaSha256 = process.env.DSH_MULTICA_SHA256?.toLowerCase();
if (!multicaSha256 || !/^[0-9a-f]{64}$/u.test(multicaSha256)) throw new Error('DSH_MULTICA_SHA256 must pin the official unmodified Multica binary (64 lowercase hex characters)');
const binary = resolve(process.argv[2] ?? resolve(project, '../dshagent-upstream/build/multica/multica-linux-amd64'));
const output = resolve(runtime, 'snapshot.json');
const intent = resolve(runtime, process.env.DSH_SNAPSHOT_NAME ? `${name}.intent.json` : 'snapshot.intent.json');
let secret = '';
async function optional(path) { try { return await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
function safeMessage(error) { return String(error?.message ?? 'Snapshot operation failed').replaceAll(secret || '\0', '[redacted]').slice(0, 1800); }
async function main() {
  routeMinioThroughLoopback();
  process.env.NO_PROXY = [process.env.NO_PROXY, 'minio', '127.0.0.1', 'localhost'].filter(Boolean).join(',');
  process.env.no_proxy = process.env.NO_PROXY;
  const { Daytona, Image } = await import('@daytona/sdk');
  const credentials = JSON.parse(await readFile(resolve(runtime, 'api-key.json'), 'utf8'));
  secret = credentials.response.value;
  const daytona = new Daytona({ apiKey: secret, apiUrl: credentials.apiUrl, target: 'us', otelEnabled: false });
  await mkdir(stage, { recursive: true, mode: 0o700 });
  let snapshot;
  try { snapshot = await daytona.snapshot.get(name); } catch (error) { if (error.statusCode !== 404) throw error; }
  if (!snapshot) {
    if (await optional(intent)) throw new Error('Snapshot submission intent already exists but no matching snapshot is visible; reconcile before any retry');
    const bytes = await readFile(binary);
    if (createHash('sha256').update(bytes).digest('hex') !== multicaSha256) throw new Error('Official Multica binary checksum mismatch');
    await copyFile(binary, resolve(stage, 'multica'));
    let dockerfile = await readFile(resolve(here, 'Dockerfile'), 'utf8');
    if (process.env.DSH_SNAPSHOT_BUILD_PROXY) {
      const proxy = new URL(process.env.DSH_SNAPSHOT_BUILD_PROXY);
      if (!['http:', 'https:'].includes(proxy.protocol) || proxy.username || proxy.password || proxy.search || proxy.hash || proxy.pathname !== '/') throw new Error('Build proxy must be a credential-free HTTP origin');
      dockerfile = dockerfile.replace('ARG DSH_BUILD_HTTP_PROXY\n', `ARG DSH_BUILD_HTTP_PROXY=${proxy.origin}\n`);
    }
    await writeFile(resolve(stage, 'Dockerfile'), dockerfile);
    // Relative COPY source avoids Windows drive paths entering OCI build contexts.
    process.chdir(stage);
    const image = Image.fromDockerfile('Dockerfile');
    await writeFile(intent, JSON.stringify({ name, createdAt: new Date().toISOString(), multicaSha256, multicaSource: 'official-unmodified', recipeSha256: createHash('sha256').update(dockerfile).digest('hex'), resources: { cpu: 2, memory: 3, disk: 8 } }, null, 2), { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ name, status: 'submitting', resources: { cpu: 2, memory: 3, disk: 8 } }));
    // The self-hosted build-log domain can be inaccessible from Windows while
    // the API and build are healthy. SDK polling works without log streaming.
    snapshot = await daytona.snapshot.create({ name, image, resources: { cpu: 2, memory: 3, disk: 8 } }, { timeout: 120 });
  } else {
    console.log(JSON.stringify({ name, status: 'reconciling', state: snapshot.state }));
    while (!['active', 'error', 'build_failed'].includes(snapshot.state)) { await delay(5000); snapshot = await daytona.snapshot.get(name); }
  }
  if (snapshot.state !== 'active') throw new Error(`Official snapshot ${snapshot.state}: ${snapshot.errorReason ?? 'inspect build log'}`);
  if (snapshot.cpu !== 2 || snapshot.mem !== 3 || snapshot.disk !== 8) throw new Error('Existing snapshot resources do not match requested recipe');
  await writeFile(output, JSON.stringify({ name, id: snapshot.id, imageName: snapshot.imageName, state: snapshot.state, cpu: snapshot.cpu, memory: snapshot.mem, disk: snapshot.disk, multicaSha256, multicaSource: 'official-unmodified', codex: '0.154.0', claude: '2.1.270', user: 'daytona', verifiedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ name, status: 'active', output }));
}
main().catch(error => { console.error(safeMessage(error)); process.exitCode = 1; });
