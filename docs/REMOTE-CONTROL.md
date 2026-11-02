# Tablet one-shot remote controls

Implementation: `gateway/gw/remote/tablet-control.mjs`. This is an injected, host-side capability coordinator, not a local HTTP API proxy, SDK replacement, model runner, or permission-policy editor. Network frames and errors use the shared v1 `protocol.mjs`; there is no private control protocol.

## Original App source facts

The integration baseline is `ca71f5b0f9b957c116f310f4057d20291bffa265`.

- `gw/queue.mjs` owns message lanes and the durable local run marker. A normal message submitted while a session runs waits in that lane; an idle run may accept an injection. The remote adapter does not add an implicit interruption mode.
- The original `gw/run.mjs` recognizes several local slash commands before spawning; other slash strings may reach the CLI command parser. The trusted `enqueueRemoteText` hook, not arbitrary `/api/chat` fields, marks remote text literal and carries its device/command provenance. The shared run hook prevents slash dispatch and image-path scanning while retaining the original marker neutralization, security prompts and tool hooks.
- Pending original requests are `run.perms: Map<requestId, p>`. `answerPerm` synchronously checks that Map, writes the original `control_response`, then removes the request. It keeps the original tool input; only `AskUserQuestion` adds `answers`. Cancellation removes the Map entry. The original App has no generic request TTL, so remote controls apply an independent, host-owned deadline.
- Local `always` can add permissions and local `mode` can change global settings. Neither is a remote capability. The `remoteOnce` hook refuses those fields and does not populate `guardOk`, so a one-shot remote guard approval does not approve the rest of that category. Guard requests about prompt/security-rule modifications are local-only.
- `ExitPlanMode` approval uses the original plan input and changes only that run to `default` (逐项确认). It does not save global settings, choose bypass mode or auto-approve subsequent tools. Since the existing `setMode` proves a stdin write rather than an SDK success response, remote approval is limited to runs already in `default` or restrictive `plan`. Already-permissive/unknown modes require tablet-local handling rather than pretending a default-mode switch was confirmed.
- `run_start` is not delivery: provider/bridge/process preparation can still fail. Delivery is the original stream-json `user` event with `isReplay: true`. The original App emits `message_delivered` for the first item and `inject` for a replayed injected item.
- `abortRun` starts an interruption, holds that lane, and tries to kill the original process tree. `/api/abort`'s `killed` is not completion. Its seven-second fallback can call `endRun` without a child `close`; that bookkeeping `run_end` is not enough for a remote stop success.

Only the integration owner changes shared `run.mjs`, `queue.mjs`, `runs.mjs` and runtime wiring. This component does not remove or weaken any existing local safety hook.

## API

```js
const control = createTabletControl({
  deviceId, hostInstanceId,
  ledgerPath,                 // explicit absolute, private path; no HOME fallback
  readGrant,                 // synchronous host-owned lookup by opaque remote ID
  executor,                  // original App operations, below
  now,                       // optional clock function
  requestTtlMs,              // default 5 minutes, from original p.at
  receiptTimeoutMs,          // default 60 seconds, then outcome unknown
  maxRecords,                // default/max shared LIMITS.MAX_COMMANDS (2048)
});
```

The factory and `TabletControl` class are both exported. Importing the module performs no I/O. Constructing it opens only the explicitly supplied ledger and subscribes to the supplied executor.

A grant is the shared v1 host-owned object `{hostDeviceId,phoneDeviceId,hostInstanceId,remoteSessionId,grantVersion,state,expiresAt,runId}` plus a private `localSessionId`. Only the tablet stores that mapping. Its actual current run comes from `executor`, not a peer claim or stale persisted `grant.runId`.

Methods:

- `submit(frame, authenticatedPeerId) → Promise<control.receipt frame>` handles only `message.submit`, `request.respond`, `run.stop`. Shape/authorization/pre-dispatch failures reject with a shared `ProtocolError.code`; they do not dispatch. Outcomes after durable recording are received/applied/rejected/unknown receipts.
- `query(controlQueryFrame, authenticatedPeerId) → Promise<control.receipt frame>` queries the same stable command ID and original run binding. The current device/process/session/grant must remain authorized, but the original run can already have ended.
- `describeRequests(localSessionId) → Request[]` is a tablet-internal call for the data adapter. It exposes only that run's original pending requests, using the strict shared Request schema. It is not an externally routable session-ID endpoint.
- `revoke(remoteSessionId, mutateGrant) → Promise` erects an immediate no-dispatch barrier and serializes the synchronous local grant mutation. Revocation does not call `abortRun`, delete a session or terminate the original task.
- `serialize(remoteSessionId, fn) → Promise` is the same boundary for trusted local authority changes.
- `onReceipt(fn) → unsubscribe` publishes validated host receipt frames. Callbacks run outside the dispatch critical section; current grant/revocation is checked again before output.
- `observe(originalEvent) → Promise` accepts original injected executor events; `onEvent` normally invokes it. It is not a remotely exposed API.
- `close()` unsubscribes, removes listeners/timers and prevents new control operations. Received records remain durably recorded and become unknown upon reopening.

### Injected original execution contract

The executor has synchronous `getRun(runId)`, `getRunOfSession(localSessionId)`, `submitText({sessionId,text,commandId,literalText:true,sourceDeviceId})`, `answerPerm(run,requestId,answer,{remoteOnce:true,planDefault})`, `abortRun(run)`, and `onEvent(fn) → unsubscribe`.

- `submitText` is normally the trusted original `enqueueRemoteText`; it validates original provider readiness and queue bounds, retains local safety checks, and returns the actual queue item. `false` means definitely not dispatched. It does not accept arbitrary remote cwd/model/environment/tool/permission fields.
- `answerPerm` delegates to the original synchronous one-shot handler. It returns true only when the original handler accepts and removes the original request, false when definitely not accepted. No replacement tool input is passed.
- `abortRun` delegates only to that exact original run, never a global stop or arbitrary task ID.
- Side-effecting methods must not return promises or schedule hidden later dispatch. A throw or contract violation is conservatively unknown, not permission to retry.
- `capabilities: {literalText:true,messageReplay:true,remoteOnce:true,planDefault:true}` may be declared only after those shared hooks are actually wired. Missing literal/replay support refuses messages; missing remoteOnce refuses guard approvals; missing planDefault refuses plan approval.

Original delivery events require `type`, `sessionId`, `runId`, original `itemId`, `remoteCommandId`, and `sourceDeviceId`. Only exact session/expected-run/item/command/source matches can settle a message. For historical `inject` events without `sessionId`, the adapter can resolve it only through the actual original `RUNS` object for that run, never through a UI current-session variable or peer claim. The controller listens to the original child object's `close` and waits for `run.ended`; the shared hook also records `run.processClosed`. A forced `run_end`, `aborted`, idle state, socket write or relay ACK is not a stopped receipt.

## Request binding and complete scope

The descriptor is `{requestId,requestVersion,runId,state:'pending',kind,expiresAt,detailsComplete,toolName?,summary?,detailText?,questions?}` from the shared protocol. Full details include original input, tool-use ID, explanations, blocked path, guard, suggestions and agent source, not merely the first preview lines.

A host `WeakMap` binds each original Map object to a SHA-256 of its complete canonical value and a monotonically increasing requestVersion. Response requires that exact object still be in the exact run's `perms`, same local session, unchanged digest, exact version and unexpired deadline. Reusing an ID or mutating any original input/summary invalidates the old descriptor. A restarted process has a new `hostInstanceId`; the old version is not sufficient to restore old authority.

`AskUserQuestion` descriptors generate `q0`, `q1`, … and `q0:o0`, `q0:o1`, … on the tablet. Responses map these back to the exact original question text and option labels. All original questions must be answered; forged/cross-question options, repeated IDs, unexpected single-choice multiselect and conflicting text+selection fail closed. Free answers are plain strings, never injected tool input.

A serialized descriptor is strictly below 24 KiB and is validated by the real v1 Request validator through a synthetic local-only snapshot. Oversized scope, unsupported question shapes/limits or security-rule guards produce a small `kind:'local', detailsComplete:false` descriptor; shared v1 rejects remote responses to it. No truncated scope can be approved. Chunked large details are not implemented.

## Durability, concurrency and truthful outcomes

- Stable command identity hashes capability + six authority fields + commandId + payload; transport IDs/timestamps can change without making a new operation. Changing any operation or binding is a conflict.
- The private journal stores fingerprints, binding, request references and receipts, not message text, tool input or answers. It uses 0600 exclusive temporary files, fsync, atomic rename and directory fsync before dispatch. Errors poison the controller instead of silently resetting deduplication.
- Journal capacity is bounded (2048 records; 4 MiB). It retains terminal tombstones and refuses new commands when full; it does not evict and make an old command executable again. Production rotation must first invalidate the old authority. Corrupt or unsafe existing storage fails closed.
- All commands for one opaque session share a serial boundary. Local/remote request competition additionally uses the original synchronous `answerPerm` Map check/delete, so only one response wins. Revocation bars queued commands before dispatch; already accepted actions are not falsely described as undone.
- Successful revocation may reclaim its in-memory dispatch barrier only after the same serialized mutation leaves the grant missing, terminal or expired; failed mutation retains the barrier. Local metadata collection never deletes or rewrites command journal entries. A command ID from an old lease remains conflicting under a new lease, not a fresh dispatch opportunity.
- Duplicate control returns the prior receipt without calling the original executor again. Reopening a journal changes received → unknown and never automatically dispatches that operation. A crash between durable receipt and original acceptance is intentionally not advertised as exactly once.
- Message success waits for the original replay of its actual item and expected execution run. An ended original run without that replay produces unknown. A queued message can remain received and time out to unknown; the controller never secretly resends or promotes it. The shared original `finish()` must not auto-pump remote `pendingInject` entries that were written but not replayed: retain them held for explicit local review or drop them as uncertain, never automatically send them to a second run.
- Stop success requires observed real child close (or an ended run that never spawned) plus that same run's ended flag. Timeout becomes unknown; later original evidence can reconcile it without another kill. This confirms termination of the original run, not rollback of completed writes or proof that every external descendant side effect was undone.

## Isolated verification

Run from the development tree:

```text
node scripts/test.mjs remote-tablet-control
```

The existing runner creates disposable HOME/workspace/prefix, strips inherited `CCAPP_*`, and refuses unsafe direct test imports. Unit fixtures cover authority, stable IDs, original request digests, request expiry/cancellation, serial revoke and local/remote competition, question mapping, plan/guard limits, journal crash/limit/corruption and truthful stop semantics.

`tests/fixtures/remote-control-cli.mjs` is a disposable stream-json process, not Claude or a model simulator that calls any provider. The integration test uses the actual App `enqueueRemoteText` → `startRun` → original `can_use_tool`/`answerPerm` → `isReplay` → `abortRun` paths, asserts original safety arguments remain attached, forbids fetch, and reaps its child. It reads/writes only test-created files. Test counts/results must be taken from the current command output, not this document.

## Explicit remaining gaps

- The original mode-switch path has no SDK-success-gated plan-approval hook. Remote plan approval therefore fails closed for `acceptEdits`, `auto`, `bypassPermissions`, `dontAsk` or unknown modes, and when the mode changed since its descriptor. A future expansion must wait for actual SDK acknowledgement, not a successful socket write.
- v1 question response currently has no reject/skip answer shape. Valid original choices/free answers work; remote “do not answer” is not invented here. The tablet can handle it locally or stop the original run.
- Large request-detail chunking and digest-bound complete-detail delivery acknowledgement are not implemented. Oversized requests are local-only. Runtime transport must only expose a complete validated descriptor; if it cannot deliver it whole it must not enable approval.
- Sender pairing, authenticated transport, relay connectivity, resync-before-control, GUI and notifications are runtime/phone/crypto responsibilities. Passing a peer-supplied string as `authenticatedPeerId` is not authentication.
- A new process invalidates old grants. Persisted old outcomes are retained but are not silently rebound to a new grant/process. Uncertain crashed actions require local investigation; no reconciliation by guessed transcript text.
- Device/source metadata is tied to original runtime events. Long-term transcript provenance depends on the shared history integration; this ledger intentionally stores no conversation content.
- No two-device/model/cloud deployment, lock-screen/background notification or network-switch acceptance is claimed by these fixtures. No installation, service restart, real session/key access, commit or push is part of these tests.
