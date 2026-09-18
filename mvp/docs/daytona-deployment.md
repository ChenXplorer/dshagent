# Daytona deployment findings

Updated 2026-09-14. The user replaced CubeSandbox with Daytona for this MVP.
The control processes (Gateway, DSH Web, Multica Server) run on Windows; Docker
services (Daytona and PostgreSQL) run on Ubuntu. The sandbox reaches the Windows
Multica Server through a tested LAN address, never `localhost`. Windows-to-Daytona
SDK traffic uses the protected forwarded API/Proxy ports.
CubeSandbox investigation remains evidence, not a deployed dependency: the VM
has no `/dev/kvm`; PVM would replace the host kernel and change global GRUB
arguments, including interface naming that conflicts with the current `ens160`
NetworkManager profile. `/boot` and `/lib/modules` share a root filesystem with
about 480 MiB free. Cubelet also requires XFS/reflink storage. No kernel, boot
configuration, or Cube sandbox deployment was changed by this investigation.

The pinned API derives its AES key with `scrypt(secret, salt, 32)`, so the
generated 48-character hex secret and salt are accepted. Its AuthModule replaces
the public Dex issuer prefix in `jwks_uri` with the internal issuer before key
retrieval; public `localhost:35556` with internal `dex:5556` is intentional.
Source: [encryption service](https://github.com/daytonaio/daytona/blob/8a446cb96331737e5a2118cbcaa0604d95c07f71/apps/api/src/encryption/encryption.service.ts),
[OIDC initialization](https://github.com/daytonaio/daytona/blob/8a446cb96331737e5a2118cbcaa0604d95c07f71/apps/api/src/auth/auth.module.ts).

The Runner's nested Docker daemon may require an outbound proxy independently
of the outer isolated Docker daemon. `DAYTONA_RUNNER_HTTP_PROXY` sets both HTTP
and HTTPS proxy variables; `NO_PROXY` retains internal service/bridge traffic.
An optional relay must bind only the isolated bridge and forward to the existing
host proxy, without changing the existing proxy or global Docker daemon.

## Actual supported source candidate

Daytona's current public `main` states that core development moved private in
June 2026. It is not a current self-host source checkout. The historical source
remains available; do not combine today's cloud SDK documentation with an
arbitrary historical server.

The selected coherent candidate is official tag **v0.187.0**, commit
**8a446cb96331737e5a2118cbcaa0604d95c07f71**, with published
**@daytona/sdk@0.187.0**. DockerHub registry metadata confirms matching API,
Runner, Proxy and optional SSH Gateway images. v0.190.0 source/SDK exist, but
matching complete prebuilt image tags were not found; using `latest` would
silently select v0.187.0 for API. The project pins image digests instead.

Sources: [official repository notice](https://github.com/daytonaio/daytona),
[selected source](https://github.com/daytonaio/daytona/tree/v0.187.0),
[official compose](https://github.com/daytonaio/daytona/blob/v0.187.0/docker/docker-compose.yaml),
[official deployment README](https://github.com/daytonaio/daytona/blob/v0.187.0/docker/README.md).
The source server/runner is AGPL-3.0; the SDK declares Apache-2.0. This is the
official development self-host configuration, not a production support claim.

## Deployment artifacts

`mvp/deploy/daytona/compose.json` derives eight actual services from the
official compose: API, proxy, privileged Docker-in-Docker Runner, PostgreSQL,
Redis, Dex, OCI registry and MinIO. The standard container backend requires
Docker, not KVM. The Runner Dockerfile starts an internal dockerd inside
`docker:28.5.2-dind-alpine3.22`; this does not provide a dedicated guest kernel.

`derive-compose.mjs` validates the upstream compose SHA256 before transforming
it, retaining actual framework environment/API contracts. It removes optional
SSH gateway/admin UIs/test mail/observability. `create-config.mjs` generates
secrets in a private runtime directory, requires a caller-provided bcrypt login
hash and MinIO digest, and refuses to overwrite existing credentials.

All bind data is below `/home/dev/dshagent-mvp/runtime/daytona/state`, especially
**the Runner's internal `/var/lib/docker`**. Without that additional mount the
upstream example could lose local sandbox state on Runner recreation. No
ordinary Compose volume should accidentally allocate new data in the existing
host daemon's almost-full `/var/lib/docker`.

Available MinIO candidate verified from its official Quay registry API:
`quay.io/minio/minio@sha256:cf3dadcfa1fb0324f43958bad1abba986d53c4ecc04d4d50b46c7dcda28bd3cd`
(`RELEASE.2025-09-07T16-13-09Z.hotfix.7aa24e772`). DockerHub `minio/minio:latest`
currently returns 404. Quay pull availability and Daytona S3/STS compatibility
still require an actual check; the compose deliberately requires an explicit
MinIO pin rather than silently substituting another S3 implementation.

## Separate Docker storage without disrupting existing workloads

Use a separate daemon with its own `data-root`, `exec-root`, Unix socket,
PID file, configuration file, bridge and containerd namespaces/state. Keep
its persistent storage and `DOCKER_TMPDIR` on `/home/dev/`. Explicitly inspect
`docker info` through that socket before pulling images. Never share data-root
or restart/migrate the existing daemon as an implicit part of this deployment.

The [Docker daemon documentation](https://docs.docker.com/reference/cli/dockerd/#run-multiple-daemons)
documents these distinct resources for multiple daemons. Setting
`iptables=false`, `ip6tables=false`, `ip-forward=false` on the new daemon avoids
it rewriting the original daemon's firewall setup, **but this alone does not
provide outbound networking**. A dedicated bridge/subnet requires explicitly
scoped forwarding and masquerade rules (or a fully separate network namespace
with an independently configured uplink). Existing LAN, VPN and Docker CIDRs
must be inspected before choosing that subnet. Preserve an exact inventory of
added rules for rollback. Do not flush existing chains or change global policy.

Do not run the privileged DinD Runner with host networking: its internal Docker
firewall operations must remain inside its container network namespace. Verify
container DNS, registry pulls, API→Runner, Runner→API, sandbox→DeepSeek and
sandbox→Multica reachability before accepting this deployment. Container
loopback refers to the sandbox itself; Multica's advertised URL must be a
reachable host address, never `localhost` copied from server configuration.

These network changes are a deployment step to inspect and apply explicitly;
no host Docker, route or firewall mutation was performed by this research task.

## Authentication and SDK routing

Use the included real Dex provider, with a generated local user/password hash.
The supplied candidate exposes only loopback: API/dashboard 33000, proxy34000,
Dex35556. Forward all three for browser access and use matching issuer,
callback and public-domain values. The official proxy also requires wildcard
`*.proxy.localhost` DNS resolution; receiving API health 200 is not proof that
Toolbox calls work.

After a real OIDC login, create an API key through the dashboard or the official
JWT-authenticated `POST /api/api-keys` with its organization context. Runner
tokens and proxy keys are internal credentials, **not** user SDK API keys.
Do not insert guessed key records into PostgreSQL. Self-hosting does not
require a Daytona cloud API key or purchase cloud compute; a cloud deployment
would be a separate choice and needs its own account/key. No cloud prices are
assumed for this local plan.

## Lifecycle and personal sandbox semantics

Verified in the **0.187.0** SDK source:

- `daytona.list({ labels })` is an async iterable; use it to reconcile a
  persistent personal sandbox binding after uncertain creation.
- `sandbox.stop(timeout, force)` stops processes; `sandbox.start(timeout)`
  starts a stopped or restored sandbox and waits for readiness.
- `sandbox.archive()` backs up filesystem state; archive/start is not memory
  suspension. Check backup/S3 and subsequent start before relying on it.
- This version has **no SDK pause/resume methods**. Newer 0.190.0 added a
  process-freeze pause that retains memory, but it is not a 0.187.0 promise.
- Set auto-stop `0` to disable autonomous SDK-idle shutdown while Multica
  executes tasks. CLI execution may not create SDK activity. Let the platform
  stop the personal sandbox only when all its tasks are idle.
- Set auto-delete `-1` to preserve the sandbox. `0` means immediate deletion
  after stop. Do not set `ephemeral:true`, which forces deletion behavior.
- Auto-archive `0` means the server's maximum interval, **not disabled**.

For this MVP, idle stop/start must retain the same sandbox ID, files and CLI
configuration, then restart/reconnect Multica Daemon and confirm registration.
It does not promise that a live CLI process or TCP connection survives. Active
tasks prohibit the stop operation.

The official DinD setup disables per-sandbox resource limits because cgroup
partitioning is unavailable there. Compose applies an outer Runner cap;
reported per-sandbox quota fields are not evidence of enforced isolation.
Single-user execution is suitable for this integration experiment; multiple
user isolation and quotas must be separately validated before expansion.

## Acceptance still pending

Configuration generation and JavaScript syntax checks are complete. Registry
metadata and source API inspection are complete. This is not yet a running
deployment report. Required next evidence: isolated daemon data root, successful
image pulls, healthy real services, real OIDC/API key, active default snapshot,
SDK-created personal sandbox, file/command execution, two CLI tasks, persistent
Daemon registration and idle stop/start recovery. Keep root free space and
actual memory usage under observation throughout these checks.
