# Official Multica Server deployment

This directory deploys the **unmodified upstream Multica Server**. The DSH
adapter uses its public REST API; it does not fork or patch Multica.

## Artifacts and database

Build or obtain `multica-server`, `multica-migrate`, and `multica` from the same
pinned upstream commit. Record and verify their SHA-256 hashes before copying
them to the server. Keep binaries and state under `/home` when the root volume
is small.

Create a PostgreSQL database, then apply the official migrations before the
first start:

```bash
set -a
. /home/dev/dshagent-mvp/runtime/multica-server/server.env
set +a
/home/dev/dshagent-mvp/artifacts/multica-official/multica-migrate up
```

Copy `server.env.example` to the private runtime directory, replace every
placeholder, and set mode `0600`. Do not commit the PAT, JWT secret, model key,
or Daytona key.

## Start and verify

Install `multica-server.service` as a user unit after adjusting the absolute
artifact path, then run:

```bash
systemctl --user daemon-reload
systemctl --user enable --now multica-server.service
curl --fail http://127.0.0.1:18381/readyz
```

Use the upstream `bootstrap-local.mjs` only for a private development
deployment. It creates a real Multica user, Workspace and PAT through official
HTTP endpoints. Production identity provisioning belongs in the platform
control plane.

The Sandbox Daemon must reach this Server through an explicitly firewalled
bridge relay. Bind Multica itself to loopback where possible; allow the relay
only from the Daytona sandbox subnet. The `serverUrl` placed in each tenant's
Daemon configuration must be the bridge address, while DSH Hosts use the
loopback `localApiUrl`.

Each tenant needs a private Multica Workspace/PAT entry in
`standardRuntime.userOverrides`. Shared Workspace credentials are rejected by
default. The Gateway derives a stable tenant suffix for the Daemon ID,
workspaces root, Codex home, Claude home, and native model catalog path.
