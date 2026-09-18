# DSH integration: verified contracts and remaining work

Verified on 2026-09-14 against official source commit
[`c291e7961a515f6d7af9304e7fd1d257929aef26`](https://github.com/deepseek-ai/deepseek-harness/tree/c291e7961a515f6d7af9304e7fd1d257929aef26)
and published npm packages `0.1.5-rc.2`. The npm package version is a deployment
pin; it is not a claim that its publication git revision equals today's master.
Use the deployment npm lockfile to fix transitive dependencies, whose upstream
manifests use caret ranges. Upstream currently requires Node `^22.19.0 || >=24`.

## Reused APIs

| Requirement | Official capability | Project responsibility |
| --- | --- | --- |
| Agent loop replacement | `@deepseek-ai/dsh-agent`: `AgentFactory.createAgent(ownerCtx, options)`, `resume(ownerCtx, options)`, `ctx.agents.setFactory(factory)` | Implement external execution driver; preserve the official lifecycle and owner scope |
| Session identity/history | `ctx.sessions.prepare`, `enter`, `announce`; official `Session` | Bind external user/sandbox/task IDs; never create a competing history store |
| Durable history | `ctx.sessionPersistence.create/open`, handle `append/read/flush/close`; `ctx.sessions.flush(session)` | Own write handle while agent attached; await checkpoint before acknowledging external event cursor |
| Browser commands | `@deepseek-ai/dsh-api-session-controller` service `ctx.sessionController`; generated `ctx.remote.session` | Route fixed trusted user and runtime choice to the existing service |
| Browser updates | `session.follow` snapshot plus ordered events and optional `assistant-stream`; official connection under `/api` | Proxy the official connection and preserve streaming, errors and identity validation |
| Trajectory | Native `assistant/message`, `tool/call`, `tool/result`, `turn/*`, `step/*`; official conversation/trajectory projections | Convert only facts actually reported by Multica; custom metadata requires explicit compatibility patch |

Source locations at the commit above:

- `packages/core/agent/src/index.ts`: factory, owner-context lifecycle, registry.
- `packages/core/agent/src/runtime-types.ts`: complete Agent interface and live stream protocol.
- `packages/core/session/src/{index,types,known-event-types,invariant}.ts`: append, format 3, cold-reader vocabulary and turn/tool invariants.
- `packages/session/session-persistence/src/index.ts`: backend contract and durability.
- `packages/api/session-controller/src/{index,types,commands}.ts`: session operations and request deduplication.
- `packages/bundle/web-app/cordis.patch.yml`: official Web roster and connection mount.
- `packages/client/ui-trajectory/src/client/trajectory-contract.ts`: trajectory consumes native conversation projections.

## Gateway and Web contract

Use the real DSH Web frontend. Its transport is Typert RPC/fetch/SSE, **not an
invented REST `/sessions` API**. Official commands include:

```ts
session.create({ sessionId?, cwd?, agentPreset? })
session.prompt({ requestId, sessionId, mode: 'queue' | 'steer', content })
session.cancel({ sessionId })
session.follow({ address: { kind: 'session', sessionId }, assistantStream: true })
```

`requestId` already deduplicates against the official Agent inbox and accepted
`user/message.source.rpcId`; reuse it rather than creating a second prompt
queue. The Gateway must inject its server-side user identity and validate all
session access. A reverse proxy alone does not satisfy business routing. A
small DSH host plugin can invoke `ctx.sessionController` and provide the
project-specific runtime/user association while leaving the framework Web
transport and views intact. Its exact route/UI extension remains to implement.

## Agent lifecycle obligations

The default loop is not just an HTTP callback. A custom factory must implement
the real `Agent` contract, including durable inbox splices, queue edit/remove,
owner-scoped create/resume/setup/commit/publication, cancellation convergence,
`whenIdle`, maintenance ownership and proper disposal. The legacy
`bck/legacy-prototype/src/plugin/dsh-native.ts` does not satisfy the current complete contract and
must not be copied verbatim.

Create persists the prepared Session header; resume opens the **existing**
write handle, reads its log, restores the official Session and separately
reconciles the external task. A local open turn after a process restart does
not prove that the Multica task is dead. Preserve setup-before-publication
ordering. Register Session/Agent with their native registries and preserve
scope-aware emission; do not swallow persistence errors.

The official turn-boundary projection is installed by the stock agent-loop.
Replacing that loop requires retaining/registering equivalent projection
support for plugins that consume it; this is a specific remaining integration
check, not a claim that every default-loop plugin remains compatible.

## Implemented trajectory module

Public export: `mvp/packages/dsh-trajectory/index.ts`.

```ts
const writer = new DshTrajectoryWriter(agent.session, {
  flush: async () => { await ctx.sessions.flush(agent.session); },
});
await writer.append(input, {
  userId, sandboxId, taskId, runtime: 'codex', turn, step,
});
```

`input` is a normalized `assistant`, `tool-call`, `tool-result` or `raw` event
with stable upstream `eventId`, `time` and JSON `raw`. The loop owns native
turn/step boundaries. Only forward credential-scrubbed raw payloads; CLI model
configuration and API keys are never trajectory payloads.

Every projection carries its external association and payload fingerprint in
native event data. Each original event is separately retained as an ignorable
`multica/event`. A restarted writer reads the **official Session log** to find
prior raw/native projections, detects event ID reuse with changed data and
repairs a crash between the two writes. Concurrent replay through one writer
serializes append/checkpoint operations. There must be one writer per live
Session. Even a duplicate retry reattempts the checkpoint after prior flush
failure. Tool call IDs include the task identity, so independent CLI sessions
reusing `callId=1` cannot collide.

Missing provider/model values are explicitly `unknown`; usage remains absent
when not supplied. No native LLM stream is invented from final CLI text.
Actual incremental presentation is **not yet implemented** and needs the
upstream CLI/Multica event stream and an appropriate DSH presentation adapter.

## Explicit upstream patch

`SessionEvent.ignorable` is the documented compatibility mechanism for
downstream informational events. However rc.2 `Session.append` cannot set the
envelope flag. Putting `ignorable` inside `data` does not work. The official
known-event registry explicitly rejects registering arbitrary external event
names as the solution. Reusing model replayState, tool-result meta or injected
user messages for unrelated lifecycle records would misrepresent their
meaning and/or pollute model-visible history.

`mvp/apps/dsh-host/patch-session.mjs` therefore applies a narrow, explicit
patch to the official npm Session artifact. It adds
`appendInformational('multica/...', data)` and passes `ignorable: true` through
the normal validated append path. The script checks exact version and unique
source anchors, fails on unexpected artifacts and is idempotent. The method
rejects other namespaces. The project type augmentation accurately identifies
this added API; it is not presented as an unmodified upstream feature.

## Validation and limitations

Executed locally against installed official npm Session/LLM `0.1.5-rc.2`:

```sh
node mvp/apps/dsh-host/patch-session.mjs mvp/packages/dsh-trajectory
node --experimental-strip-types --test mvp/packages/dsh-trajectory/trajectory.test.ts
```

Seven passing tests cover native message derivation and JSON reload, task-scoped
tool correlation, unmatched-result deferral/replay, failed-flush retry, partial-write recovery, concurrent
duplicate delivery/payload conflicts, and raw event exclusion from derived
model history. TypeScript 5.9.3 typecheck also passes. These tests use the real
`Session` implementation, but their injected checkpoint is a unit-test hook:
The `dsh-loop/loop.test.ts` suite now additionally runs native Cordis, AgentRegistry,
SessionStore, projections and the actual JSONL backend against temporary disk
directories. Seven tests pass: queued turns and raw-event cold reload; concurrent
sessions with pending-turn resume using the same rpcId; setup rejection rollback;
cancellation awaiting external settlement; caller abort during setup; steering
without a phantom extra turn; sanitized observer diagnostics persisted to native
JSONL while retaining an open turn. The external
TaskDriver is a test double in these tests. Actual Web rendering, real external
CLI execution and the full deployment are separate end-to-end gates.

The Gateway test uses an actual loopback HTTP/SSE server and a business-service
test double to check token/fixed-identity enforcement, native request mapping and
unchanged follow frames. Together the focused loop/trajectory/Gateway suite has
15 passing tests after workspace dependency consolidation.

## Concrete external loop and host composition

`mvp/packages/dsh-loop/index.ts` installs `AgentFactory` through
`ctx.agents.setFactory`. It uses the official scope, registries, SessionPreparation,
JSONL write leases and publication hooks. `multica-plugin.ts` loads a deployment
module exporting `createDriver({ctx})`; no model-driving fallback is installed.
DSH's native `agent/pre-step` and `agent/turn-stopping` hooks remain active. DSH
model-request hooks and DSH tools do not automatically run inside an external
Claude/Codex CLI: those CLI engines own their own prompts and tools.

The second guarded compatibility patch, `patch-loop-primitives.mjs`, exports the
existing rc.2 `ReactLoopInbox` and `inboxProjectionDefinition` from its compiled
entry point. It changes no queue logic and mounts no stock AgentLoop service.
This reuses native durable splices, pending input projections, and inbox events.

Each external prompt is committed to `user/message` and flushed before the
driver may submit a task. Its native `source.rpcId` is the durable idempotency
identity. Unconfirmed execution/cancellation, transcript gaps, network failures
during execution and observation deadlines leave the DSH turn open. The agent
rejects new input until reconciliation. After disposing the halted owner, native
resume reuses that original request id. A host restart alone does not activate
every persisted session: replaying the exact accepted Gateway request triggers
native SessionController resume before its durable rpcId deduplication. A cold
GET of the event stream only reads history. It never declares an uncertain
Multica process stopped. Same-session queued turns are serial; different sessions
remain independent. Steering waits for the next external task boundary; it does
not interrupt the CLI's private internal step mid-execution.

An observer exception additionally appends an ignorable
`multica/observer-error` with request/turn/step and allowlisted error classification,
HTTP status or transport code. Arbitrary exception messages, stacks, response
bodies and request headers are excluded. Unknown classes stay explicitly unknown.
This diagnostic preserves the open turn; it is not a synthetic task failure or
completion. The live host loaded this module during the coordinated dshtrace2
upgrade restart; it cannot reconstruct earlier unrecorded exceptions.

`create-profile.mjs` generates a JSON-as-YAML overlay disabling the exact stock
`agent-loop` row, inserting `mvp-multica-loop`, and configuring native JSONL
persistence. Cordis treats `name` on an update as an identity assertion, so a
different name on the existing row would be skipped; the explicit disable/insert
composition was verified through the official `--dump-config` output. `bootstrap.mjs`
registers TS loading and explicitly calls the official exported `runCli`,
avoiding rc.2's silent `import.meta.main` gate on Node 24.1.

The MVP-owned Gateway lives in `apps/dsh-host/gateway.ts`. It binds loopback,
authenticates a deployment token and fixes user/workspace identity in trusted
configuration. Its `/v1` routes call official `ctx.sessionController`
create/prompt/cancel/follow; the event endpoint relays the original native SSE
frames. These are explicitly the MVP Gateway's routes, not invented DSH REST
endpoints. Runtime selection delegates to the durable TaskOrchestrator API.
Official DSH Web remains available on its native separate port.

Actual Windows deployment smoke validation on 2026-09-14 passed with the genuine
private TaskOrchestrator configuration: Gateway health200, official session create201,
native follow SSE200, and native Web token exchange303 followed by cookie-authenticated
HTML200. The created session was independently read from the native JSONL backend.
No model task was submitted during this smoke gate. Browser visual rendering remains
unverified: the available in-app browser rejected its local URL with
`net::ERR_BLOCKED_BY_CLIENT`. This does not count as UI-render acceptance.

`capture-acceptance.ts` reads native persisted events via the actual JSONL backend
and opens the MVP correlation SQLite database read-only. It exports event hashes,
tool IDs, raw/native event identities and task/runtime/session mappings without
prompt or credential contents. `compare-acceptance.mjs` checks those facts across
a settled host restart and duplicate prompt replay. Prepare these artifacts before
and after the real acceptance run; the scripts do not themselves prove that a
restart or real model execution has occurred.

## Actual first concurrent CLI acceptance (2026-09-14)

The first sandbox provisioning attempt failed with Daytona's own daemon health
timeout before Multica task creation. Both accepted DSH turns remained open.
After the Runner networking fix, the empty failed instance was explicitly deleted
through Daytona, deletion was verified, and its reservation was cleared through
the audited recovery operation. DSH was then restarted and the two original
request IDs were replayed. This was a recovered run, not first-attempt success.

The original nine-event native prefixes remained unchanged. Each session retained
exactly one user message and one turn start, acquired exactly one real Multica
task, and shared the same single personal Daytona sandbox. The CLI acceptance
observer independently verified completed tasks and overlapping execution from
the proof files produced by the real Codex CLI shell tools.

The final native JSONL and actual Gateway SSE snapshots were captured before
further test turns: each session had 24 persisted events, a closed turn, eight
raw Multica events, one native tool call and its result paired by the real call
ID. Each task's final native assistant message contained its exact proof marker.
Neither session had duplicate trajectory projections, and no task was active.
The Gateway snapshots had cursor 23 and `hasMore: false`.

Private evidence is stored under `.runtime/dsh/acceptance/`:
`first-bootstrap-pending.json`, `first-recovery-receipts.json`,
`first-recovery-pending.json`, `first-settled.json`, and
`first-gateway-proof.json`. The actual CLI proof fixture is
`.runtime/driver/first-concurrency.json`. Credentials and prompts are not copied
into this document. The post-settlement restart/replay gate below subsequently
passed; the visual Web-render gate remains outstanding.

The subsequent runtime matrix also passed native JSONL and actual Gateway SSE
checks for five successful tasks: mixed Codex/Claude execution, switching the
original session to Claude with its previous context/files, two parallel Claude
tasks, and the Claude task surviving cancellation of its Codex sibling. Each
task's final assistant message contained its own `MATRIX_` proof marker, and all
six tool calls had their genuine results. Evidence is in `matrix-settled.json`
and `matrix-gateway-proof.json` under the same private acceptance directory.

The cancelled Codex task was checked separately: its 17-event native log and
Gateway snapshot ended with `turn/end` reason `aborted` and cancellation kind
`user`, correlated to the actual cancelled task. It contained one tool call,
zero tool results and zero final assistant messages. That interrupted call is
retained without a fabricated completion. Evidence is in
`matrix-cancelled.json` and `matrix-cancelled-gateway.json`.

The original session then switched back from Claude to Codex. Its native log
reached 62 events with a completed third turn. The new task's final assistant
message contained the exact `ROUNDTRIP_` marker in both native persistence and
the Gateway snapshot; its tool call/result were paired and seven raw events
were retained. This validates the same DSH session's Codex → Claude → Codex
sequence together with the CLI-side context and file proof. Evidence is in
`roundtrip-settled.json` and `roundtrip-gateway-proof.json`.

The first queue-capacity run produced real proof files for all three tasks, but
one official-completed task retained four CLI descendants. The platform correctly
kept that DSH turn open and the task unsettled. After the explicitly verified
orphan cleanup, the original observer naturally appended `step/end` and completed
`turn/end`, without host restart or request replay. All three final `QUEUE_`
markers and tool pairs then passed native/Gateway verification. The initial
queue fixture remains a failed/deadline attempt; recovery is recorded separately
in `queue-after-orphan-cleanup.json` and `queue-recovered-gateway-proof.json`.
This evidence does not replace a fresh queue run against the Daemon cleanup fix.

During the coordinated idle dshtrace2 upgrade, the DSH host was stopped and
restarted with the revised real Daemon configuration. The original accepted
request for each of nine existing sessions was replayed twice (18 accepted
receipts). All nine histories retained their exact original event-hash prefixes,
raw/native projections, genuine tool IDs and task/segment/runtime/sandbox
mappings. No task was recreated and all turns stayed closed, including the
cancelled session. Each resumed session appended only the official
`session/end-seed` record. Evidence: `all-before-upgrade.json`,
`all-replay-receipts.json`, and `all-after-upgrade-replay.json`;
`compare-acceptance.mjs` passed against those actual captures.

A fresh three-task queue run on dshtrace2 then completed automatically, with no
manual orphan cleanup, host restart or request replay. All three final `QUEUE_`
markers, tool pairs and completed native turns passed native JSONL and actual
Gateway SSE checks; there were no duplicate projections or active tasks.
Evidence is in `queue-dshtrace2-settled.json` and
`queue-dshtrace2-gateway-proof.json`.

The actual native Codex executable was then killed during its own tool command,
after validating the task identity and Daemon ancestry. The confirmed failed
task produced a closed 16-event DSH log with native `turn/end` kind `error`, one
tool call, no tool result, no final assistant message and four raw events. The
Gateway snapshot preserved that same failure. Evidence is in
`cli-native-failed.json` and `cli-native-failed-gateway.json`. An earlier attempt
had killed only the npm wrapper; Codex completed that task, which remains
recorded as completed in `cli-wrapper-kill-completed.json` and is not counted as
a successful fault-injection gate.

After an official idle Daemon stop, a new Gateway request bootstrapped the same
personal sandbox and Daemon identity and completed normally. Its 20-event native
log and Gateway snapshot contained the exact `MVP_RECOVERY_` final marker, one
paired tool execution and six raw events, with a completed turn and no duplicate
projections. Evidence is in `daemon-recovery-settled.json` and
`daemon-recovery-gateway.json`.

The final live outbox gate stopped the actual Multica Server during a running
CLI task, observed pending transcript data, restored the server, restarted DSH
and resumed the exact accepted request. The same Multica task/message identities
were retained. The native log recorded a sanitized `multica/observer-error`
classification `TypeError / transport / ECONNREFUSED`, then continued that same
turn after cold resume. Its 32-event final log contained one original user
message/turn, eleven raw events, two genuine tool pairs and the exact
`OUTBOX_FINAL_` assistant marker. Native JSONL and Gateway SSE checks confirmed
completed status, zero duplicate projections and no active task; both services
were restored. Evidence is in `outbox-settled.json`, `outbox-gateway-proof.json`
and the private `.runtime/driver/outbox-replay.json` operation record. This is
explicit short-outage recovery, not a claim that long-disconnected upstream
terminal-state reports are durably replayed.
