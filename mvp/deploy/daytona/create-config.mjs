import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';

const directory = process.argv[2];
const passwordHash = process.env.DAYTONA_LOGIN_PASSWORD_HASH;
const minioImage = process.env.DAYTONA_MINIO_IMAGE;
const network = process.env.DAYTONA_DOCKER_NETWORK;
if (!directory || !isAbsolute(directory)) throw new Error('Pass an absolute runtime config directory');
if (!passwordHash?.match(/^\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}$/)) throw new Error('Provide bcrypt DAYTONA_LOGIN_PASSWORD_HASH generated with htpasswd or another standard bcrypt implementation');
if (!minioImage?.match(/@sha256:[a-f0-9]{64}$/)) throw new Error('Provide a verified digest-pinned DAYTONA_MINIO_IMAGE');
if (!network?.match(/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/)) throw new Error('Provide the existing isolated DAYTONA_DOCKER_NETWORK name');
await mkdir(directory, { recursive: true, mode: 0o700 });
const state = resolve(directory, 'state');
await mkdir(state, { recursive: true, mode: 0o700 });
for (const path of ['runner-docker', 'runner-state', 'postgres', 'redis', 'minio', 'registry', 'dex']) {
  await mkdir(resolve(state, path), { recursive: true, mode: 0o700 });
}
const config = {
  issuer: 'http://localhost:35556/dex', storage: { type: 'sqlite3', config: { file: '/var/dex/dex.db' } },
  web: { http: '0.0.0.0:5556', allowedOrigins: ['http://localhost:33000'], allowedHeaders: ['x-requested-with'] },
  staticClients: [{ id: 'daytona', name: 'Daytona', public: true, redirectURIs: [
    'http://localhost:33000', 'http://localhost:33000/dashboard', 'http://localhost:33000/api/oauth2-redirect.html',
    'http://localhost:3009/callback', 'http://proxy.localhost:34000/callback',
  ] }],
  enablePasswordDB: true,
  staticPasswords: [{ email: 'dev@daytona.local', hash: passwordHash, username: 'mvp', userID: 'mvp-user' }],
};
const dexPath = resolve(directory, 'dex.json');
// Dex accepts JSON as valid YAML. Exclusive create never rotates an existing
// encryption key or database secret during an accidental second invocation.
await writeFile(dexPath, JSON.stringify(config, null, 2), { flag: 'wx', mode: 0o600 });
const values = {
  DAYTONA_STATE_DIR: state, DAYTONA_DEX_CONFIG: dexPath, DAYTONA_DOCKER_NETWORK: network, DAYTONA_MINIO_IMAGE: minioImage,
  DAYTONA_MINIO_USER: 'daytona-mvp',
};
for (const name of ['ENCRYPTION_KEY', 'ENCRYPTION_SALT', 'DB_PASSWORD', 'PROXY_KEY', 'RUNNER_KEY', 'MINIO_PASSWORD', 'REGISTRY_PASSWORD', 'HEALTH_KEY', 'SSH_KEY']) {
  values[`DAYTONA_${name}`] = randomBytes(24).toString('hex');
}
await writeFile(resolve(directory, '.env'), Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
console.log(`Created Daytona configuration in ${directory}; no secret values printed.`);
