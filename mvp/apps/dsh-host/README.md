# Official DSH host

This directory installs the official `@deepseek-ai/dsh@0.1.5-rc.2`. It does not
implement a replacement DSH server. The included Multica AgentFactory and Gateway
plugin are selected by the generated reviewed Cordis profile patch.

```sh
# From the mvp workspace root:
npm ci
node apps/dsh-host/create-profile.mjs /absolute/path/to/mvp.cordis.json /absolute/path/to/sessions
export DSH_MVP_PROFILE_PATCH=/absolute/path/to/mvp.cordis.json
export DSH_MVP_DRIVER_MODULE=/absolute/path/to/create-driver.ts
# Supply DSH_MVP_CONFIG for the deployment driver, DSH_MVP_USER_ID,
# DSH_MVP_HOST_WORKSPACE, and DSH_MVP_GATEWAY_TOKEN (at least32 characters).
npm start --workspace @dshagent/dsh-host
```

根工作区的 `postinstall` 会在每次 `npm ci` 后自动、幂等地执行两项锁定版本补丁；版本或补丁锚点
不匹配时安装直接失败。上面的启动入口仍会再次检查补丁结果，避免把未补丁的官方依赖误当成
可运行交付物。

The root `mvp/package-lock.json` owns installation. Keep one hoisted native Cordis
and DSH graph; do not create independent nested installs or mix global and local
DSH packages. Separate physical copies can split native service identity and
TypeScript module augmentation even when version numbers are equal.

An isolated remote install can apply the patch with:

```sh
node /path/to/mvp/apps/dsh-host/patch-session.mjs /home/dev/dshagent-mvp/runtime/dsh-host
```

Windows uses the same absolute-path arguments and `$env:NAME='value'` syntax.
`./start-host.ps1` reads the private deployment config, creates an isolated
`.runtime/dsh` native home/profile/token, and starts the official Node process
hidden with logs and its launcher PID recorded there. It refuses an existing
live recorded launcher. Its profile explicitly disables the stock `agent-loop`
and inserts the Multica factory; changing the original row's `name` alone is
not a supported Cordis replacement operation.
Gateway, DSH Web and Multica Server run on Windows; Daytona Docker services and
PostgreSQL run on Ubuntu. Use a reachable Windows LAN address for Multica's
sandbox callback URLs. API keys stay in configuration files outside source.

The launcher refuses missing profile configuration, a profile without the
Multica replacement, an unpatched Session and missing native Inbox exports.
This launcher is not an end-to-end health check. Preserve other DSH plugin rows.

Gateway binds `127.0.0.1:3380` (override `DSH_MVP_GATEWAY_PORT`), authenticates
`Authorization: Bearer <DSH_MVP_GATEWAY_TOKEN>` and fixes its user/workspace:

| Route | Behavior |
| --- | --- |
| `POST /v1/sessions` | Native session create; optional `sessionId` |
| `POST /v1/sessions/:id/messages` | `requestId`, `text`, optional `mode: queue/steer` |
| `POST /v1/sessions/:id/cancel` | Native cancellation request acknowledgement |
| `GET /v1/sessions/:id/events` | Original native follow frames over SSE |
| `GET /v1/runtimes` | Lists online Codex/Claude runtimes with their real `runtimeId` and `daemonId` |
| `POST /v1/sessions/:id/runtime` | Persist a kind-only selection or a concrete `{runtime,runtimeId,daemonId}` through the driver |
| `GET /v1/health` | Gateway readiness and fixed identity |

DSH Web runs separately on its official default port3080. Gateway routes are
MVP-owned and delegate to actual DSH sessionController APIs. A cancel receipt
means accepted, not confirmed process termination.

## Why a Session patch exists

Official Session format 3 requires unknown plugin log events to carry
`ignorable: true`, but rc.2 exposes no append API for that envelope field.
Ordinary event data cannot substitute for the envelope. Without the field,
cold persistence reads reject an external `multica/event`.

`patch-session.mjs` adds `Session.appendInformational(type, data)` to the
**official** Session implementation and propagates the explicit ignorable
flag into the normal validation/append path. The new method only admits the
`multica/` metadata namespace; core transcript events remain native required
events. It verifies package version and unique artifact anchors, is idempotent,
and fails rather than patching an unknown artifact. Native registries,
persistence and the official Session implementation remain in use.

The trajectory package supplies the TypeScript module augmentation. The patch
is an explicit compatibility patch, not an API claimed to exist upstream.
Remove it when upstream provides an equivalent supported capability.

`patch-loop-primitives.mjs` is a second export-only patch exposing upstream's
existing `ReactLoopInbox` and `inboxProjectionDefinition`. The Multica loop uses
those native durable queue primitives without loading the stock model loop.

See [verified API notes](../../docs/dsh-integration.md).
