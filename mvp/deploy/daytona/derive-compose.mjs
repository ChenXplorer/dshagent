import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

// Derive the deployment from the actual archived official release, rather than
// recreating the server or guessing environment variables.
const source = await readFile(process.argv[2], 'utf8');
const hash = createHash('sha256').update(source).digest('hex');
if (hash !== '93801bd32eaf98b7af010b4d9eea9579caf56ef60caf489d48141bf10d3c63c2') {
  throw new Error('Expected unmodified official v0.187.0 docker/docker-compose.yaml');
}
const compose = YAML.parse(source);
const wanted = new Set(['api', 'proxy', 'runner', 'dex', 'db', 'redis', 'registry', 'minio']);
for (const name of Object.keys(compose.services)) if (!wanted.has(name)) delete compose.services[name];
compose.name = 'dshagent-daytona';
const digests = {
  api: 'daytonaio/daytona-api@sha256:8de6315a378430a58a44ce6c20b41050c2f602446e75f3ff559edbaa0b3758a7',
  runner: 'daytonaio/daytona-runner@sha256:3253f4fdfda80bfc3b13e9e7ddf022cb5412dca94230371091e16cd0860427e0',
  proxy: 'daytonaio/daytona-proxy@sha256:63834f0477e154f92de8d44efb0809dffbd2392c188b6cf41dac94ed8ade26c2',
  db: 'postgres@sha256:4ef4dbc939d61acea57712655ddb4b4ab27419c913f94cca0cd57cb3ea3c2280',
  dex: 'dexidp/dex@sha256:1b4a6eee8550240b0faedad04d984ca939513650e1d9bd423502c67355e3822f',
  registry: 'registry@sha256:bcece5dd3d4b6189e13e7ac71b2ccbc2aae649365f0c589852d687efeba6b290',
};
const env = (service) => {
  const value = compose.services[service].environment;
  if (Array.isArray(value)) compose.services[service].environment = Object.fromEntries(value.map((entry) => {
    const split = entry.indexOf('='); return [entry.slice(0, split), entry.slice(split + 1)];
  }));
  return compose.services[service].environment;
};
const required = (name) => '${' + name + ':?required}';
const state = '${DAYTONA_STATE_DIR:?required}';
for (const [name, service] of Object.entries(compose.services)) {
  if (digests[name]) service.image = digests[name];
  service.restart = 'unless-stopped';
  service.logging = { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } };
  if (name !== 'api' && name !== 'proxy' && name !== 'dex') delete service.ports;
}
compose.services.api.ports = ['127.0.0.1:33000:3000'];
compose.services.proxy.ports = ['127.0.0.1:34000:4000'];
compose.services.dex.ports = ['127.0.0.1:35556:5556'];
Object.assign(env('api'), {
  OTEL_ENABLED: 'false', POSTHOG_API_KEY: '',
  ENCRYPTION_KEY: required('DAYTONA_ENCRYPTION_KEY'), ENCRYPTION_SALT: required('DAYTONA_ENCRYPTION_SALT'),
  DB_PASSWORD: required('DAYTONA_DB_PASSWORD'),
  PUBLIC_OIDC_DOMAIN: 'http://localhost:35556/dex',
  DASHBOARD_URL: 'http://localhost:33000/dashboard', DASHBOARD_BASE_API_URL: 'http://localhost:33000',
  PROXY_DOMAIN: 'proxy.localhost:34000', PROXY_TEMPLATE_URL: 'http://{{PORT}}-{{sandboxId}}.proxy.localhost:34000',
  PROXY_TOOLBOX_BASE_URL: 'http://localhost:34000',
  PROXY_API_KEY: required('DAYTONA_PROXY_KEY'), DEFAULT_RUNNER_API_KEY: required('DAYTONA_RUNNER_KEY'),
  DEFAULT_RUNNER_CPU: '4', DEFAULT_RUNNER_MEMORY: '4', DEFAULT_RUNNER_DISK: '40',
  // Keep the upstream scheduler guard configurable. Production should retain
  // 10; a memory-constrained lab can explicitly lower it after capacity review.
  RUNNER_AVAILABILITY_SCORE_THRESHOLD: '${DAYTONA_RUNNER_AVAILABILITY_SCORE_THRESHOLD:-10}',
  S3_ACCESS_KEY: required('DAYTONA_MINIO_USER'), S3_SECRET_KEY: required('DAYTONA_MINIO_PASSWORD'),
  INTERNAL_REGISTRY_PASSWORD: required('DAYTONA_REGISTRY_PASSWORD'),
  TRANSIENT_REGISTRY_PASSWORD: required('DAYTONA_REGISTRY_PASSWORD'),
  HEALTH_CHECK_API_KEY: required('DAYTONA_HEALTH_KEY'),
  SSH_GATEWAY_API_KEY: required('DAYTONA_SSH_KEY'),
});
// The MVP does not use the optional SSH gateway; do not distribute its public
// example private key or claim SSH is available. Toolbox process APIs suffice.
delete env('api').SSH_GATEWAY_PUBLIC_KEY;
Object.assign(env('proxy'), { PROXY_API_KEY: required('DAYTONA_PROXY_KEY'), OIDC_PUBLIC_DOMAIN: 'http://localhost:35556/dex' });
Object.assign(env('runner'), {
  DAYTONA_RUNNER_TOKEN: required('DAYTONA_RUNNER_KEY'), SSH_GATEWAY_ENABLE: 'false',
  AWS_ACCESS_KEY_ID: required('DAYTONA_MINIO_USER'), AWS_SECRET_ACCESS_KEY: required('DAYTONA_MINIO_PASSWORD'),
  BUILD_CPU_CORES: '2', BUILD_MEMORY_GB: '3',
  HTTP_PROXY: '${DAYTONA_RUNNER_HTTP_PROXY:-}', HTTPS_PROXY: '${DAYTONA_RUNNER_HTTP_PROXY:-}',
  NO_PROXY: 'localhost,127.0.0.1,api,runner,registry,minio,db,redis,dex,10.203.0.0/24,172.20.0.0/16',
});
delete env('runner').SSH_PUBLIC_KEY;
compose.services.runner.volumes = [`${state}/runner-docker:/var/lib/docker`, `${state}/runner-state:/home/daytona/runner`];
compose.services.runner.mem_limit = '5g';
compose.services.runner.cpus = 4;
compose.services.api.mem_limit = '1536m';
compose.services.db.mem_limit = '512m';
compose.services.redis.image = 'redis@sha256:f773b35a95e170d92dd4214a3ec4859b1b7960bf56896ae687646d695f311187';
compose.services.redis.command = ['redis-server', '--appendonly', 'yes'];
compose.services.redis.volumes = [`${state}/redis:/data`];
compose.services.redis.mem_limit = '256m';
env('db').POSTGRES_PASSWORD = required('DAYTONA_DB_PASSWORD');
compose.services.db.volumes = [`${state}/postgres:/var/lib/postgresql/18/docker`];
Object.assign(env('minio'), { MINIO_ROOT_USER: required('DAYTONA_MINIO_USER'), MINIO_ROOT_PASSWORD: required('DAYTONA_MINIO_PASSWORD') });
compose.services.minio.image = '${DAYTONA_MINIO_IMAGE:?pin a verified MinIO image digest}';
compose.services.minio.volumes = [`${state}/minio:/data`];
compose.services.registry.volumes = [`${state}/registry:/var/lib/registry`];
compose.services.dex.volumes = ['${DAYTONA_DEX_CONFIG:?required}:/etc/dex/config.yaml:ro', `${state}/dex:/var/dex`];
delete compose.volumes;
compose.networks['daytona-network'] = { external: true, name: '${DAYTONA_DOCKER_NETWORK:?required}' };
await writeFile(resolve(dirname(fileURLToPath(import.meta.url)), 'compose.json'), JSON.stringify(compose, null, 2) + '\n');
