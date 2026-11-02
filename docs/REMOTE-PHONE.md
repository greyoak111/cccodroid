# Phone remote transport and state

This is the phone-side module contract, not a deployed service or a dual-device acceptance report. The coordinator owns all routing/network integration. The phone module does not import gateway configuration, load a local session, read credentials, start sockets, or change the global frontend API base.

## Exports and construction

`gateway/gw/remote/phone.mjs` exports `createPhoneManager`, `PhoneError`, and `PHONE_LIMITS`.

```js
import { createPhoneManager } from './remote/phone.mjs';
const phone = createPhoneManager({ deviceId: 'phone-id', transport });
// Optional injection: now, newCommandId, timeoutMs, maxCacheBytes,
// maxItems, maxCommands. Do not use page-controlled device IDs or clocks.
```

The injected `transport` is the **trusted local adapter after peer authentication, pairing, AEAD and protocol validation**, not a raw public-relay message receiver. Protocol validation alone is not device authentication. Relay delivery acknowledgements cannot be passed off as tablet receipts. Real deployment must provide this adapter; tests use only synthetic in-memory adapters.

### Injected transport methods

All bindings returned below are normalized to **phone → tablet** order. A binding is exactly `{fromDeviceId,toDeviceId,hostInstanceId,remoteSessionId,grantVersion,runId}`; `runId` is `null` only when there is no run. No tablet-local `sessionId`, path or URL belongs here.

| Method | Returns |
| --- | --- |
| `list({deviceId,signal})` | `SessionSummary[]` or `{sessions: SessionSummary[]}` |
| `open({deviceId,remoteSessionId,resume,binding,signal})` | Complete authenticated `TabletSnapshot` below |
| `accept({deviceId,hostDeviceId,remoteSessionId,grantVersion,signal})` | Complete active `TabletSnapshot`; accepting never approves a tool |
| `decline({deviceId,hostDeviceId,remoteSessionId,grantVersion,signal})` | Authenticated host acknowledgement `{remoteSessionId,deviceId:hostDeviceId,grantVersion,state:'declined'}` |
| `history({binding,cursor,limit,maxBytes,signal})` | `{binding,streamId,items,cursor,hasMore}` |
| `send(frame,{signal,priority:'control'})` | Authenticated canonical `control.receipt` frame from the tablet |
| `query(frame,{signal,priority:'control'})` | Authenticated canonical `control.receipt` frame from the tablet |
| `close({binding,signal})` | Optional best-effort unsubscribe; never stops the tablet run or revokes its grant |
| `subscribe(fn)` | Optional `unsubscribe()`; delivers the normalized events below |

`accept` and `decline` are optional for adapter construction but their corresponding operations fail closed with `FORBIDDEN` if omitted. The coordinator's current protocol/runtime now supplies the explicit authenticated `host.decline → host.declined` exchange; the phone contract still requires the normalized host acknowledgement above. Do not silently map phone decline to host-authoritative `host.revoke`, and do not claim the tablet has heard a local-only dismissal. Other listed request methods except `close` are required. `send` and `query` consume full frames constructed by canonical `createFrame`; `query` is a `control.query` frame with the **same original commandId**, not a newly generated side-effecting command. Receipts have reversed device direction and the original host/session/grant/run binding.

A session summary is `{remoteSessionId,deviceId:hostDeviceId,title,deviceName,grantVersion,state:'invited'|'active',expiresAt,pendingCount}`. Titles/device names are display-only, never authority. The manager projects these fields and never forwards arbitrary list fields to the WebView. The list is restricted to grants/invitations for this phone, not a tablet session directory.

A `TabletSnapshot` is:

```js
{
  binding: {fromDeviceId, toDeviceId, hostInstanceId, remoteSessionId,
            grantVersion, runId},
  grant: {state: 'active', expiresAt},
  run: {runId, state: 'idle' /* running|waiting|ended|stopping|stopped|needs-local */},
  pending: [
    {requestId, requestVersion, runId, expiresAt, kind: 'permission',
     state: 'pending', detailsComplete: true /* plus normalized display fields */}
  ],
  items: [{id, kind: 'message', role: 'assistant', text: 'Already authorized display data'}],
  streamId, seq,
  historyCursor: null, historyHasMore: false
}
```

The adapter maps canonical wire `session.snapshot` / `history.page` into this local shape. It must filter authorized display fields before giving them to the manager; the manager also enforces canonical Record/Request fields. Pending `kind` is `permission`, `question`, `plan`, or `local`; questions and options use the IDs supplied by the tablet control adapter, never IDs invented by the UI. Requests use `toolName`, `summary`, `detailText`, `questions` (not raw `tool`/`input`). Permission/plan complete details require nonempty `detailText`, at most 24 KiB; larger scope must be incomplete/local handling, not silently clipped and approved. Records use `kind:'message'|'tool'`, with plain `toolName/toolStatus/toolInputText/toolResultText` for tools. The canonical wire `event.batch` currently carries `snapshot.required` invalidations, so the runtime should fetch/validate a new snapshot before normalizing it; it must not turn a wire invalidation into fabricated display records. Larger history pages require bounded adapter assembly.

### Normalized transport events

These are **local adapter events**, not extra wire message types. Agent 01 owns canonical wire types. `binding` in these normalized events is phone → tablet; canonical receipt frames are tablet → phone.

```js
{type:'connection', state:'online' /* offline|connecting */}
{type:'session.snapshot', binding, snapshot: tabletSnapshot}
{type:'event.batch', binding, streamId, seq, items}
{type:'control.receipt', frame: canonicalReceiptFrame}
{type:'host.revoke', binding}
{type:'reset'} // explicit local unpair/config reset: clears all temporary content
```

`connection:online` starts a new authenticated `open(...resume:true)`; it does **not** unlock controls. Grant, host lifecycle, run and the complete pending snapshot must be checked first. Changed run IDs are accepted only with a fresh verified snapshot; a changed host lifecycle/grant fails closed and clears content. Incremental gaps or stream changes trigger a fresh snapshot, not blind appending. Lower/duplicate sequence events do not overwrite newer state. A fully validated lower-sequence snapshot push on the same stream may be ignored only while the current snapshot is still verified and ready; it cannot restore controls during reconnect. A lower-sequence correlated resync still fails closed. Unsolicited snapshot pushes cannot make a syncing/offline/invalid state ready; only the outstanding correlated current-authority resync can do that. Invalid pending details and revocation are checked before the stale-push exception. A revocation clears remote content and does not send `run.stop`.

## Manager methods and local JSON envelope

| Manager method | Returns |
| --- | --- |
| `status()`, `list()`, `open(remoteSessionId)`, `accept(remoteSessionId)`, `decline(remoteSessionId)`, `close()` | `{snapshot}` |
| `history(cursor = null, scope?)` | `{snapshot,page:{items,cursor,hasMore}}` |
| `command({generation,binding,type,commandId,payload})` | `{snapshot,receipt}`; recommended `/command` route entry, also validates original `requestVersion` |
| `sendText(text,commandId?,scope?)` | `{snapshot,receipt}` |
| `respond(requestId,response,commandId?,scope?)` | `{snapshot,receipt}` |
| `stop(commandId?,scope?)` | `{snapshot,receipt}` |
| `query(commandId,scope?)` | `{snapshot,receipt}` |
| `resync()`, `receive(event)` | `{snapshot}`; runtime/test adapter hooks |
| `subscribe(fn)` | Synchronous initial and subsequent **flat snapshots**, returns `unsubscribe` |
| `dispose()` | Abort/clear/unsubscribe, no tablet execution action |

All request methods are asynchronous; validation/transport failures have a `code`. A control whose outcome may have become uncertain returns a typed `unknown` receipt rather than reporting false success. Optional `scope` is `{generation,binding}`. **The local HTTP route must pass scope from the frontend on every history/control/query call.** Omitting it is only for trusted internal callers/tests, not an HTTP fallback. Opening/closing/selecting a page invalidates its prior generation; late HTTP/transport replies do not update another session. `open` does not accept an invitation implicitly; use explicit `accept`.

The immutable, detached, **flat PhoneSnapshot** is:

```js
{
  revision, generation, deviceId,
  connection: 'offline', // connecting|online
  phase: 'idle', // opening|invited|syncing|ready|offline|revoked|expired
  verified: false, canControl: false, cached: false,
  sessions: [],
  active: null, // {remoteSessionId,deviceId:hostDeviceId,title,deviceName}
  binding: null, grant: null, run: null,
  pending: [], items: [], receipts: [],
  streamId: null, seq: 0,
  historyCursor: null, historyHasMore: false, historyBusy: false,
  lastSyncedAt: null, error: null, // sanitized code only, never raw logs/secrets
  cache: {bytes,items,maxBytes,maxItems,truncated}
}
```

`cached:true` means current messages are stale/offline display data, **not approval authority**. Only `verified && canControl && connection==='online' && phase==='ready' && grant.state==='active' && grant.expiresAt>now` permits controls. The run may remain running while the phone is offline. Received text/stop/approval is not applied. A stop is applied only with canonical `{kind:'stop',runState:'stopped'|'ended'}` evidence from the tablet.

## Frontend `remoteTransport`

`gateway/web/app/13r-remote-transport.js` defines the closed-over `remoteTransport` and `createRemoteTransport(options)`; it also exposes `window.remoteTransport` and `window.createRemoteTransport` for remote-view integration and isolated browser/VM tests. No existing `api()` helper or global base changes. No token/private key/remote content is read from or stored in localStorage/sessionStorage. Same-origin HttpOnly app cookies stay under the existing local access boundary.

| Frontend method | Returns |
| --- | --- |
| `status()`, `open(id)`, `accept(id)`, `decline(id)`, `close()` | Flat `PhoneSnapshot` |
| `list()` | Session summaries array |
| `history(cursor)` | `{items,cursor,hasMore}` |
| `sendText(text,commandId?)`, `respond(requestId,response,commandId?)`, `stop(commandId?)`, `query(commandId)` | Receipt |
| `subscribe(fn)` | Immediate flat snapshot and subsequent snapshots; synchronous unsubscribe function |
| `setDraft(text)`, `getDraft()` | Optional bounded **memory-only** draft helpers; snapshot includes `draft` |
| `destroy()` | Clear memory and local subscription |

The frontend only calls the following restricted routes; the coordinator implements access checks and routes:

| Route | Request | Response |
| --- | --- | --- |
| `GET /api/remote/status` | none | `{snapshot}` |
| `GET /api/remote/sessions` | none | `{snapshot}` |
| `POST /api/remote/open` | `{remoteSessionId}` | `{snapshot}` |
| `POST /api/remote/accept` | `{remoteSessionId}` | `{snapshot}` |
| `POST /api/remote/decline` | `{remoteSessionId}` | `{snapshot}` |
| `POST /api/remote/close` | `{}` | `{snapshot}` |
| `POST /api/remote/history` | `{generation,binding,cursor}` | `{snapshot,page}` |
| `POST /api/remote/command` | `{generation,binding,type,commandId,payload}` | `{snapshot,receipt}` |
| `POST /api/remote/query` | `{generation,binding,commandId}` | `{snapshot,receipt}` |
| `GET /api/remote/events` | same-origin EventSource | `event: snapshot`, `data: <flat PhoneSnapshot JSON>` |

Errors should be `{error:{code}}` and a non-2xx status. EventSource `onopen` never enables controls. Reconnect first fetches current backend status and waits for the manager's authenticated reconciliation. Retry delay is bounded exponential backoff (1–30 seconds), cancelled when leaving/destroying/unsubscribing. HTTP requests use `credentials:'same-origin'`, `cache:'no-store'`, `redirect:'error'`, and abort/time limits.

### Restricted command payloads

- `message.submit`: `{text}` only, at most 16 KiB UTF-8. Slash prefixes remain ordinary text; this layer never interprets them as a local command.
- `request.respond`: `{requestId,requestVersion,response}`. The frontend obtains requestVersion from the current pending snapshot; the manager checks again. Responses follow canonical protocol:
  - permission: `{kind:'permission',decision:'allow'|'deny',reason?}`;
  - question: `{kind:'question',answers:[{questionId,optionIds:[optionId],text?}]}`;
  - plan: `{kind:'plan',decision:'approve'|'reject',reason?}`.
- `run.stop`: `{}` only; bound to the exact current original run.

No `always`, bypass mode, arbitrary tool input, model/workspace/env setting, attachments, local file API or terminal API is available. The tablet remains the final source of permission and answer validity.

### Command IDs and uncertainty

Both phone manager and frontend retain a bounded per-view journal and never automatically resend a side-effecting control, even with the same ID after a timeout. A duplicate ID with different operation/payload/authority fails closed. Unknown outcomes are queried with the original ID; querying an unfamiliar ID reserves it as **query-only**, so a page reload is not an excuse to send it as a new command. The UI should retain/show the commandId of uncertain operations and let users query it. A new explicitly created command is a new user action, not an automatic retry. No controls are queued offline. Memory is deliberately cleared on close/revoke/unpair, not persisted as a secret-bearing queue; crash-safe applied deduplication belongs to the tablet control journal.

## Bounds and verification

Defaults: messages cache 512 KiB / 500 records; one history page in flight (50 records / 256 KiB); 64 session summaries; 128 pending cards; 256 commands per view (fail closed rather than evicting deduplication); 64 subscribers; eight concurrent transport operations; 15-second adapter request timeout. Browser response/cache bounds are checked independently. Approval details are not silently truncated. Caches and drafts clear on close/revoke/expiry/reset; leaving a remote view must call close/destroy rather than merely hide its DOM.

Run with the isolated runner:

```sh
node scripts/test.mjs remote-phone
```

Current review assertions and browser acceptance have not run on this public integration branch. Prior development counts are not current validation; see the [acceptance record](REMOTE-REVIEW-ACCEPTANCE.zh-CN.md). Tests use temporary HOME/PREFIX/WORKSPACE and synthetic identities/receipts, and include real frontend source in a VM plus manager/protocol integration. VM timer doubles do not prove browser binding correctness; real Chromium checks remain necessary. The boot subscription permits only a completely empty `remote-unconfigured` sentinel to acquire its first actual local identity, not silent replacement of an existing bound device. Module fixtures do not establish real two-device authentication, Android background/lock-screen/cell-network notifications, original-tool execution or physical-network scheduling.
