# Daytona 0.187.0 self-host deployment candidate

> 2026-09-14 状态更新：真实部署与端到端验收已经完成。下文包含早期检查记录；当前版本、安装步骤和最终边界以 [部署手册](../../docs/deployment-handbook.md) 与验收结果为准。

Source: official `daytonaio/daytona`, tag `v0.187.0`, commit
`8a446cb96331737e5a2118cbcaa0604d95c07f71`.

`compose.json` is derived from the official release's `docker/docker-compose.yaml`
by `derive-compose.mjs`. It is Docker Compose JSON (valid YAML). This is a real
API/proxy/Runner/Dex/PostgreSQL/Redis/registry/MinIO stack, with no mock services.

Deployment prerequisites:

1. An isolated Docker daemon whose data-root, temporary files and managed
   containerd state are on `/home/dev/`. Use its explicit Unix socket for every
   command. Do not use the existing daemon at `/var/run/docker.sock`.
2. A dedicated Docker bridge network with verified outbound connectivity,
   correct DNS and no overlapping host/container routes. Supply its name via
   `DAYTONA_DOCKER_NETWORK`.
3. A verified digest-pinned MinIO image in `DAYTONA_MINIO_IMAGE`, and a bcrypt
   login password hash in `DAYTONA_LOGIN_PASSWORD_HASH`.

```sh
node mvp/deploy/daytona/create-config.mjs /home/dev/dshagent-mvp/runtime/daytona
docker --host unix:///path/to/isolated-docker.sock compose \
  --env-file /home/dev/dshagent-mvp/runtime/daytona/.env \
  -f mvp/deploy/daytona/compose.json config --quiet
docker --host unix:///path/to/isolated-docker.sock compose \
  --env-file /home/dev/dshagent-mvp/runtime/daytona/.env \
  -f mvp/deploy/daytona/compose.json up -d
```

The generator creates config once with exclusive writes; it does not rotate
existing database/encryption keys. Dex may run as a non-root container user;
before start, inspect the pinned image's UID and grant ownership only to the
dedicated `state/dex` directory and read access to `dex.json`. Likewise verify
bind-directory ownership for each official image. Do not loosen all of `/home`.

Forward loopback ports `33000`, `34000`, `35556` over SSH. Login at
`http://localhost:33000/dashboard` as `dev@daytona.local` with the password
whose hash you supplied. Create the API key through the real dashboard/API.
Configure SDK `@daytona/sdk@0.187.0` with `apiUrl=http://localhost:33000/api` and
the returned key. Verify `*.proxy.localhost` resolves to the forwarded proxy
for SDK Toolbox calls as required by upstream; API health alone is insufficient.

All persistent bind mounts are under the runtime state directory, including
the Runner's nested Docker image/container state. Recreating the Runner must
not delete this directory. API 1.5 GiB and Runner 5 GiB are upper bounds, not
reservations; observe actual total host memory before executing two CLIs.

`DAYTONA_RUNNER_AVAILABILITY_SCORE_THRESHOLD` can lower the upstream scheduler
threshold for a constrained lab after checking real memory and disk pressure.
It defaults to the upstream value `10`; lowering it is not a substitute for
production capacity planning.

Optional upstream services omitted: SSH gateway, pgAdmin, registry UI, MailDev,
Jaeger and OTel collector. SSH/email/admin UI acceptance is outside this MVP.
Tracing is disabled, and the local seeded Dex identity avoids signup email.
The upstream API retains its email config; any feature requiring SMTP remains
unavailable until an SMTP service is explicitly configured.

This stack has now been deployed and accepted in the recorded Windows/Ubuntu environment.
See [deployment findings](../../docs/daytona-deployment.md) for lifecycle and
isolated-daemon details.
