# Remote session protocol v1

This document describes the strict endpoint protocol implemented by `gateway/gw/remote/protocol.mjs`. It is not a public proxy for the local gateway, an encryption specification, or a claim that real devices/cloud deployment have been accepted. Pairing and encrypted transport belong to the separate crypto/relay modules.

## Boundary and authority

The tablet owns the mapping from a random `remoteSessionId` to one local session. No wire frame contains a local `sessionId`, a gateway URL, a working directory, model settings, environment, attachments, a file operation, or arbitrary tool arguments. Text beginning with `/` remains ordinary text; the tablet adapter must not send it through the local slash-command dispatcher.

A validated shape is **not** authorization. Before reading or dispatching, the host checks its own current grant, device pairing and authenticated sender. The grant must come from trusted local state, never from the peer. Grant validation, deduplication, original-request validation, revocation and dispatch must share the adapter's serialization boundary. The protocol module performs no I/O and cannot enforce this boundary by itself.

### Common frame

All endpoint frames have exactly these keys, plus `commandId` on command/query/receipt frames and optional `correlationId` only on the seven view/hosting-RPC types listed below.

| Field | Type / meaning |
| --- | --- |
| `v` | Integer `1` |
| `type` | Explicit allowlisted type |
| `messageId` | Unique transport frame ID |
| `fromDeviceId`, `toDeviceId` | Explicit authenticated device IDs; must differ |
| `hostInstanceId` | Tablet process-lifetime identity; changes invalidate old controls |
| `remoteSessionId` | Opaque hosted-session handle, not a local session ID |
| `grantVersion` | Positive safe integer; reauthorization must use fresh authority |
| `runId` | Concrete run ID, or `null` when the session has no run |
| `issuedAt`, `expiresAt` | Milliseconds since Unix epoch; safe nonnegative integers |
| `payload` | Type-specific exact object |
| `commandId` | Stable ID of the original control, also used by its query and receipts |
| `correlationId` | Optional opaque view/hosting-RPC request ID; independent from control and approval IDs; both request and response require it for `assertCorrelation` |

IDs match `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`. Production identity/handle generators must use cryptographically random IDs; checking shape alone does not prove entropy. Device names and session titles are not identities. All routing/authority fields, message ID, timestamps and sequence data must be authenticated by the secure envelope; moving an encrypted message to another route must fail authentication.

Unknown fields are rejected at every defined object level. In-memory inputs also reject getters, custom prototypes, cycles, sparse arrays, non-finite numbers, functions, `undefined`, symbols and prototype-pollution keys. Successful validation returns a detached, recursively frozen JSON object.

## Controls, responses and truthful receipts

| Type | Additional binding | Exact payload |
| --- | --- | --- |
| `message.submit` | `commandId`; `runId` may be `null` | `{text}` |
| `request.respond` | `commandId`; concrete `runId` | `{requestId, requestVersion, response}` |
| `run.stop` | `commandId`; concrete `runId` | `{}` |
| `control.query` | Original `commandId` and original run binding | `{}` |
| `control.receipt` | Original `commandId`; reversed device direction | `{status, code?, result?}` |

`requestVersion` is a positive integer. A response is exactly one of:

- Permission: `{kind:'permission', decision:'allow'|'deny', reason?}`.
- Question: `{kind:'question', answers:[{questionId, optionIds:[optionId], text?}]}`. At least one answer is required; question and option IDs cannot repeat. Each answer needs selected options or nonempty free text.
- Plan: `{kind:'plan', decision:'approve'|'reject', reason?}`. Approval means the original plan confirmation only; it does not change permission mode or automatically approve later tools.

The original request remains the source of tool input. No response accepts `always`, `mode`, `updatedInput`, `updatedPermissions`, `interrupt`, replacement tool input or persistent rules. The control adapter must verify that question IDs/options and free-text/multi-select choices belong to the original request, not merely that they are well formed.

A trusted request supplied to `assertBinding` has `{requestId,requestVersion,runId,state,kind,expiresAt,detailsComplete,questions?}`. It must still be `pending`, unexpired and bound to the current concrete run. The response kind must match the original kind; `local` requests cannot be remotely answered. Allow/approve and question submissions require `detailsComplete === true`. Question submissions must answer every original question, select only its original option IDs and respect `multiSelect`; free text remains supported. Partial or unavailable approval details must disable approval; denial remains possible. Details completeness must reflect actual fully delivered scope, not a remote claim.

### Receipt payload

- `received`: the tablet has recorded the command, not completed it. No `code` or `result`.
- `applied`: the original capability has verifiably accepted/completed the operation. Requires `result`, forbids `code`.
- `rejected`: not dispatched. Requires a listed `code`, forbids `result`.
- `unknown`: outcome cannot safely be established. Allows a listed `code`, forbids `result`. Never automatically redispatch.

Applied results are exact objects:

- Message: `{kind:'message', delivery:'accepted'|'queued'}`. This does not mean the AI has finished responding.
- Request: `{kind:'request', requestId, requestVersion}`. Must match the original request.
- Stop: `{kind:'stop', runState:'stopped'|'ended'}`. The adapter must observe the original run end. Socket write, interrupt initiation and relay acknowledgement are not proof of stop.

`control.receipt` is a tablet statement. The relay's queue/delivery acknowledgement must not be promoted to `received` or `applied`.

## Hosting and strictly projected data

Phone-bound types are `host.invite`, `host.revoke`, `host.declined`, `host.released`, `session.snapshot`, `session.notice`, `history.page`, `event.batch` and `control.receipt`. Host-bound types are `host.accept`, `host.decline`, `host.release`, `host.revoked`, `session.subscribe`, `session.unsubscribe`, `history.get` and the three controls plus `control.query`. The route's authenticated peer must match the explicit direction; payload validity never makes a phone authoritative for a snapshot or receipt.

| Type | Exact payload |
| --- | --- |
| `host.invite` | `{title,deviceName,expiresAt}`; invitation expiry is after issue time; title/name ≤512 bytes |
| `host.accept` | `{}`; correlated `session.snapshot` is the tablet acknowledgement; acceptance is not approval of a tool |
| `host.decline` | `{}`; explicitly decline an invited grant; requires the tablet acknowledgement, not optimistic local success |
| `host.declined` | `{}`; correlated, bound tablet acknowledgement of decline; contains no session data |
| `host.revoke` | `{reason:'revoked'|'expired'|'unpaired'}`; does not mean stopping the task; optional correlated cleanup ack during component retirement |
| `host.revoked` | `{}`; phone → host, exact reverse binding and correlation of `host.revoke`; cache cleanup only, never an execution receipt |
| `host.release` | `{}`; phone → host, voluntarily surrender an invited/active grant during component retirement; never stops the original run |
| `host.released` | `{}`; host → phone, exact bound acknowledgement after host revocation barrier; no content/control capability |
| `session.subscribe` | `{}` |
| `session.unsubscribe` | `{}` |
| `history.get` | `{cursor:null|string,limit:1..50}` |
| `session.snapshot` | `{streamId,seq,title,grant:{state,expiresAt},run:{runId,state},pending:[Request],items:[Record],historyCursor:null|string,historyHasMore:boolean}` |
| `session.notice` | `{run:{runId,state},pending:[{requestId,requestVersion,expiresAt}],eventId}`; opaque background metadata only |
| `history.page` | `{streamId,seq,items:[Record],cursor:null|string,nextCursor:null|string,hasMore:boolean}` |
| `event.batch` | `{streamId,fromSeq,toSeq,events:[{seq,type:'snapshot.required',payload:{}}]}` |

`streamId` is an ID. `seq` is a nonnegative safe integer. Each batch has 1–50 events, begins at `fromSeq >= 1`, has contiguous event sequence numbers, and ends exactly at `toSeq`. At this integration stage the only event is a bounded invalidation hint that instructs the phone to re-fetch the authorized snapshot. No arbitrary event payload or tool/API invocation is accepted. `request.open`, `request.closed`, `history.content`, generic fetch and connection/pairing messages are not currently endpoint types; pending requests are delivered in the snapshot. Future additions require an agreed schema, not an arbitrary JSON fallback.

Snapshot grant state is `active|revoked|expired`. Snapshot run state is `idle|running|waiting|ended|stopping|stopped|needs-local`; its `runId` must equal the frame's run binding. A null run requires state `idle` and no pending requests. Every pending request has the same concrete run binding. These are state displays, not authority supplied by the phone; a current trusted host grant is still checked separately before access/control.

A history cursor is opaque bounded text (1–1024 UTF-8 bytes) or `null`; it is not a path. If `hasMore` is true, `nextCursor` must be non-null and different from `cursor`; if false, `nextCursor` must be null. Each history/snapshot frame has at most 50 records with unique IDs and still fits the 64KiB frame budget. `HISTORY_PAGE_BYTES` is the upper bound of a logical assembled page, not permission to emit a 256KiB frame. Adapters may return a smaller page. A single display string is bounded to 48KiB and may need a marked preview to fit. Approval details must never be silently truncated into an approvable preview.

### Record

A display record is exactly `{id,kind,role?,text?,toolName?,toolStatus?,toolInputText?,toolResultText?,source?,timestamp?,truncated?}`:

- `kind`: `message|tool`.
- `role`: `user|assistant|system`; only for a message.
- `toolName`: nonempty display text ≤512 bytes; `toolStatus`: `running|done|error`; `toolInputText`/`toolResultText`: plain display strings. These fields are only for a tool record.
- `text`, `toolInputText`, `toolResultText`: each ≤48KiB and subject to the total frame limit.
- `source`: `phone|host`; `timestamp`: nonnegative safe integer milliseconds; `truncated`: boolean.

Executable input objects, raw local events, file paths as fetch targets and unfiltered transcript objects are not record fields. Paths/commands already inside authorized display text are not actionable file/shell capabilities.

### Request

A pending request is exactly `{requestId,requestVersion,runId,state,kind,expiresAt,detailsComplete,toolName?,summary?,detailText?,questions?}`:

- `requestId`/concrete `runId`: IDs; `requestVersion`: positive integer; `state`: only `pending`.
- `kind`: `permission|question|plan|local`.
- `detailsComplete`: boolean; `local` must be false. Permission/plan with true must have nonempty `detailText` containing the full approval scope.
- `toolName`: nonempty text ≤512 bytes; `summary`: text ≤4KiB; `detailText`: text ≤24KiB.
- Question requests require 1–16 `questions`; other kinds must not have this field.
- A question is exactly `{questionId,question,header?,multiSelect,options:[{optionId,label,description?}]}`. `question`/`label` are nonempty text ≤4KiB, `header` ≤512 bytes, `description` ≤4KiB, `multiSelect` boolean; at most 32 options per question. Question IDs and per-question option IDs must be unique.

The tablet control adapter produces this projection from the original request, retains its original tool input privately and maps the scoped answer IDs back to that original. The remote peer cannot replace the input. Complete approval details over 24KiB are currently a **local-handling gap**: do not clip the details and set `detailsComplete:true`; mark incomplete or local, disable remote approval and instruct the user to handle it on the tablet. Large-detail chunk transfer is not implemented by this version.

### Background notification metadata

A pinned authenticated TLS peer connection may remain open for user-enabled remote reminders even while no remote session is being viewed. Connection alone is not a subscription to conversation content. Do not emit history pages, snapshots, logs, tool inputs, approval bodies or message text just because a peer is connected. The runtime emits `session.notice` only for an active, unexpired hosted-session grant, in the host → phone direction.

`session.notice` has **exactly** `{run:{runId,state},pending:[{requestId,requestVersion,expiresAt}],eventId}`:

- `run.runId` must equal the frame's run binding. State is exactly `running|waiting|idle|ended|stopped`. Null run is allowed only with state `idle` and an empty pending list.
- `pending` has at most `LIMITS.NOTICE_PENDING === 32` opaque request references, unique by `requestId`; each version is a positive integer and expiry is a nonnegative safe millisecond timestamp. Closed requests disappear from a subsequent notice. Expired references never authorize an answer; the opened snapshot/original request must be revalidated.
- `eventId` is a bounded opaque ID. The producer must reuse a stable event ID for retransmitting the same original run/request notification fact, never generate a fresh identity merely because TLS reconnects. Notification deduplication keys must also include the complete device/host/session/grant context; a same-looking event ID in another grant is not the same authority. Changes that need a new update must be represented by the runtime without re-alerting the same pending fact.
- No title, tool name, question text, detail, log, history, message/body or arbitrary kind field is allowed, including inside `run` and pending entries. No `commandId` or `correlationId` is allowed.

This frame can support pending-request reminders, run-ended reminders and stale/closed notification refresh without transmitting conversation content. Invitations still use `host.invite`; `session.notice` cannot be sent under an invited or revoked/expired grant. The schema checks the event ID's shape, not its cross-frame stability; runtime/notification tests must verify stable IDs and bounded deduplication.

A notice is **not** a snapshot, a permission request to act on, a control receipt or a view-RPC reply. It must never set `canControl:true`, auto-accept an invitation, approve a tool or imply successful stop. Opening the remote page still requires a fully verified current `session.snapshot`, including authority, run and pending details. `assertBinding` keeps strict run matching for notices; a receiving background manager that updates its cached run reference must separately verify the authenticated current session lease and treat the new run as notification-only until snapshot recovery. The correlated-snapshot run-change exception does not apply to notices or controls.

### View/hosting-RPC correlation

Only `host.accept`, `host.decline`, `host.declined`, `host.release`, `host.released`, `host.revoke`, `host.revoked`, `session.subscribe`, `history.get`, `session.snapshot` and `history.page` allow optional top-level `correlationId`. An actual RPC must set it in the request and echo it unchanged in the response. The field is distinct from `commandId` and a pending approval's `requestId`.

`assertCorrelation(responseFrame,requestFrame,{now?})` requires:

1. `session.subscribe → session.snapshot`, `host.accept → session.snapshot`, `host.decline → host.declined`, `host.release → host.released`, `host.revoke → host.revoked`, or `history.get → history.page`, with both correlation IDs present and equal. A successful send/relay acknowledgement cannot complete accepting or declining.
2. Reversed source/recipient devices and exact host lifetime, remote session and grant version. **Only a `session.snapshot` response may announce a different current run** from the original subscribe/accept request; its payload run and every pending request must still match the response frame's run. Null → current, old → current and old → idle are valid read-only recovery cases.
3. Every non-snapshot response retains the exact request run binding. For history, require the exact echoed `cursor` and no more records than the requested `limit`.
4. Both frames still valid at the injected time.

It returns true or throws a listed protocol error. The snapshot exception permits revalidating a hosted session after a normal run change, not applying a control to a different run. `validateFrame({expected})`, `assertBinding` and all controls/query/receipts remain strictly run-bound. The runtime must separately validate the current authenticated session-level grant before serving a readonly subscribe whose cached run is stale; it must never reuse that relaxation for dispatch. Cross-device, cross-session, changed-grant and changed-host replies remain rejected even when they carry a new run. The phone must check page generation/stream sequence so an older authenticated snapshot cannot overwrite a later one. Unsolicited trusted snapshots may omit correlation; callers must not use them to resolve an outstanding RPC. A correlation ID alone does not authorize reading a session.

## State machines and stable command IDs

### Grant

`grantTransition(state,event)` permits only:

- `none + invite → invited`
- `invited + accept → active`
- `invited + decline → revoked` (not available after activation)
- `invited|active + revoke → revoked`
- `invited|active + expire → expired`

Revoked/expired grants cannot be revived. A new invitation needs a fresh grant authority; connection loss alone neither revokes authority nor stops the task. Grant/connection/execution states are separate dimensions.

The authority passed to `assertBinding` is `{hostDeviceId,phoneDeviceId,hostInstanceId,remoteSessionId,grantVersion,runId,state,expiresAt}`. Device direction, host lifetime, remote session, grant version, run and expiry must all match. Invitation payload expiry must equal the trusted grant expiry. Controls go phone → host; receipts go host → phone. The post-revocation/expiry cleanup exceptions are an outbound `host.revoke` notice and empty `host.declined` / `host.released` acknowledgements to the already-bound phone; their complete routing binding and fresh frame lifetime are still checked, and they convey no reading/control capability. All snapshots, reads, controls and receipts remain disabled. Restarting the host must create a new `hostInstanceId` and not replay old controls.

The runtime may collect terminal local grant metadata without clearing the durable command journal: a missing or terminal handle has no dispatch authority, and a process restart also rotates `hostInstanceId`. A paired, authenticated read/resume for a missing handle receives only a reversed-binding `host.revoke`; a cleanup release for a missing handle receives only an empty `host.released` with the original correlation/run binding. Neither exception provides a snapshot, approval or fresh lease. The phone keeps bounded, non-authorizing revoke/decline tombstones for the maximum accepted frame lifetime plus future clock skew; ordinary active-session quota is counted separately, and unexpired tombstones are not evicted to admit a new invitation. Unacknowledged, unexpired `release-pending` records remain durable and reserve real storage slots across both device roles.

### Receipt

`receiptTransition(state,next)` permits `null → received`, `received → applied|rejected|unknown`, and an explicitly reconciled `unknown → applied|rejected`. Repeating the same state is idempotent; applied/rejected cannot be undone. No transition from `unknown` back to `received` is possible.

The UI may show sending locally, but only a tablet receipt permits received/applied. After timeout, query the original `commandId` rather than generating another command ID. A query retains the **original** run binding even after the run ends. The adapter first validates current device/host/session/grant authority, then verifies the query against the recorded original run. It must not silently substitute a new current run.

### Pure command ledger

`createCommandLedger({now?,maxEntries?})` is a bounded in-memory helper, **not a durable exactly-once store**. Methods:

- `record(validControl) → {duplicate, receipt}`. Only the three side-effecting controls can be recorded. First entry becomes `received`; duplicates return the recorded receipt without redispatch.
- `get(commandId,binding) → receipt|null`.
- `settle(commandId,binding,{status,code?,result?}) → receipt`.
- `markUnknown(commandId,binding) → receipt`.
- `size` getter.

The required `binding` has exactly the six common authority fields: `{fromDeviceId,toDeviceId,hostInstanceId,remoteSessionId,grantVersion,runId}`. No lookup is available by bare command ID. Reusing an ID with a changed capability, payload, device, grant, session or run is `COMMAND_CONFLICT`. The hash omits transport `messageId` and transport timestamps so retrying the same control can use a fresh transport frame while preserving authority and operation. Terminal receipt details cannot be changed under the same state.

The ledger retains no message text/tool input, only fingerprints, binding, request references and receipts. When full it fails closed; it does not evict deduplication records to make an old side-effecting command executable again. The adapter must persist the received record before dispatch. A crash between recording and the original capability accepting may be irreducibly unknown. A new in-memory ledger after a crash is not permission to replay. Durable adapter policy must retain tombstones for the lifetime of that authority or rotate/invalidate it before removing them.

## Limits and time

All sizes are UTF-8 bytes, not JavaScript character counts.

| Exported limit | Value |
| --- | --- |
| `FRAME_BYTES` | 65,536 |
| `TEXT_BYTES` | 16,384 |
| `HISTORY_ITEMS` | 50 |
| `HISTORY_PAGE_BYTES` | 262,144 logical page; split over bounded frames |
| `LOW_QUEUE_BYTES` | 524,288; transport must enforce before socket buffering |
| `CONTROL_TTL_MS` | 60,000 for controls and their queries |
| `FRAME_TTL_MS` | 300,000 maximum for other endpoint frames |
| `CLOCK_SKEW_MS` | 5,000 future-issue tolerance only |
| `MAX_COMMANDS` | 2,048 default and maximum in-memory ledger entries |
| `REQUEST_DETAIL_BYTES` | 24,576; larger approval scope requires local handling |
| `PENDING_REQUESTS` | 128 |
| `NOTICE_PENDING` | 32 opaque references, no approval content |
| `QUESTIONS`, `QUESTION_OPTIONS` | 16 questions, 32 options per question |
| `CURSOR_BYTES` | 1,024 |

Frames expire exactly at `expiresAt` (no expiry grace). `expiresAt` must be strictly after `issuedAt`, and a peer cannot extend TTL beyond its type's maximum. Host grant and original request deadlines are independent and must also be checked. Bounded JSON clone depth/node/byte budgets prevent pathological in-memory inputs.

The constants alone do not implement transport backpressure, 3 Mbps shaping, history assembly, durable storage or cache cleanup. Those belong to the data/phone/relay adapters. Control/approval/receipt priority must be scheduled before entering the socket; an unbounded socket buffer would defeat priority.

## Exports

- `PROTOCOL_VERSION`, `LIMITS`, `ERROR_CODES`, `CONTROL_TYPES`, `RECEIPT_STATUSES`.
- `ProtocolError`: `.name === 'ProtocolError'`, `.code` is a listed error. Validator messages never echo request bodies, unknown field names or credentials.
- `validateFrame(frame,{now?,expected?})`: validate shape, lifetime and optional exact expected six-field binding; return frozen clone.
- `parseFrame(string|Buffer|Uint8Array,options?)`: bound raw input, reject invalid UTF-8/JSON, then validate.
- `createFrame(type,binding,payload,{now?,ttlMs?,messageId?,commandId?,correlationId?})`: construct and validate. A command ID is always supplied by the caller, never silently generated on retry. Transport message IDs default to `randomUUID()`.
- `assertBinding(frame,grant,{now?,direction?,request?})`: validate frame and trusted current authority; default direction `toHost`, other value `toPhone`; returns `true` or throws.
- `assertCorrelation(responseFrame,requestFrame,{now?})`: match a view/hosting-RPC reply to its original request and reverse authority binding; only snapshot recovery can announce a different current run, as above.
- `grantTransition`, `receiptTransition`, `commandFingerprint`, `createCommandLedger` as above.

`now` may be a fixed millisecond timestamp or an injected clock function. Factories/imports do not start services, touch the filesystem or read real HOME, sessions or keys.

## Error codes

`INVALID_SCHEMA`, `UNKNOWN_FIELD`, `UNSUPPORTED_VERSION`, `UNSUPPORTED_TYPE`, `LIMIT_EXCEEDED`, `EXPIRED`, `NOT_YET_VALID`, `DEVICE_MISMATCH`, `HOST_INSTANCE_MISMATCH`, `SESSION_MISMATCH`, `GRANT_MISMATCH`, `GRANT_REVOKED`, `GRANT_NOT_ACTIVE`, `RUN_MISMATCH`, `REQUEST_MISMATCH`, `REQUEST_EXPIRED`, `REQUEST_CLOSED`, `DETAILS_INCOMPLETE`, `COMMAND_CONFLICT`, `COMMAND_UNKNOWN`, `INVALID_TRANSITION`, `LEDGER_FULL`, `OFFLINE`, `RESYNC_REQUIRED`, `FORBIDDEN`, `INTERNAL_ERROR`.

Error codes are stable machine values. User-facing translated explanations belong to the UI; arbitrary internal exception text must not be sent as a protocol error.

## Isolated verification

Run `node scripts/test.mjs remote-protocol` from the project directory. The runner creates disposable HOME/workspace and uses pure synthetic devices, grants, requests and messages. No real conversation, credential, model call, app installation, bridge restart or cloud deployment is involved. Cross-device notification/lock-screen/network-change and real cryptographic transport acceptance remain separate tests.
