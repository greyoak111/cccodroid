# Remote tablet data adapter

Development baseline: official `ca71f5b0f9b957c116f310f4057d20291bffa265`.
This is a selected-session, display-only data plane, not a local API proxy or a
control adapter. All validation described below was run with fake sessions in the
existing test runner's temporary HOME. No installed gateway, real sessions,
workspace source, model, bridge or cloud server was used.

## Verified original backend facts

These are facts from the backend source, not assumptions based on frontend calls.

- `gw/sessions.mjs` exports `findSessionFile(id) -> {file, project} | null`,
  `peekSession(file) -> {title, cwd, created}`, and `listSessions`. The remote
  adapter uses the first two only for a locally selected, explicitly authorized
  session. It never calls the global listing/search/export/file routes. The
  original resolver checks the session ID and searches project directory names;
  it does not read project source files. `peekSession` reads at most 196608 bytes
  of the selected transcript. This adapter returns only its title, not `cwd`.
- `gw/transcript.mjs` exports `transcriptItems(ev)`,
  `readSessionPage(file, {before, limit, excludeFrom})`, and
  `readSessionForward(file, {after, limit, excludeFrom})`. Original backward pages
  return `{items, cursor, size, contextTokens}`; `cursor` is a local byte offset.
  Original page limits are **soft** conversation-boundary limits, not a remote
  hard output or allocation limit. Original `transcriptItems` already truncates
  tool-result text and some tool inputs, and returns thinking as a separate role.
- `gw/bus.mjs` exports `onPublish(fn) -> unsubscribe` and `publish(ev)`. In-process
  subscribers receive the original event object, without its SSE `BOOT.seq` ID.
  `/api/events`, `hello`, `state`, and `queue.snapshot()` are global; none is
  forwarded as a remote session stream.
- `gw/queue.mjs` `runEmit(run, ev)` adds `runId` to run events. Most subsequent
  display events do **not** have `sessionId`. The run log combines adjacent
  deltas and can contain a very large text string. The original global ring and
  per-run log are not the remote bounded replay window.
- Original `run_start` has `runId`, `sessionId`, `text`, `startedAt`, `follow`,
  and `cid`; `init` supplies the initialized `sessionId`. In `endRun`, the run
  is removed from `RUNS` before publishing `run_end` with `runId`, `sessionId`,
  and `aborted`; looking up only the currently-running map would lose that event.
- `gw/runs.mjs` exports `RUNS` and `runOfSession(sid)`. A current run has `id`,
  `sessionId`, `startedAt`, `idle`, `perms`, `log`, and other local-only fields.
  Importing it reads HOME and clears a run marker. `stream.mjs`, `sessions.mjs`,
  and their dependencies also have environment/startup behavior. The remote data
  and presentation modules deliberately do not import these modules themselves.
- `stream.translate` emits the concrete `delta`, `assistant_text`, `tool_use`,
  `tool_result`, `phase`, `discard_partial`, compacting and related display events.
  `perm_request` contains original approval data, but a display preview is not a
  complete permission detail. Agent 05 owns request identity, complete details,
  decisions, message delivery, stop, and their actual original-run receipts.

## Files and exported interfaces

`gateway/gw/remote/tablet-data.mjs` exports:

```js
TABLET_DATA_LIMITS
createTabletData({ adapter, hostInstanceId?, now?, limits? })
createSourceAdapter({
  findSessionFile, peekSession?, transcriptItems,
  runOfSession?, onPublish?, limits?
})
readBoundedSessionPage(file, {
  before?, limit?, excludeFrom?, transcriptItems, limits?
})
```

`createTabletData` returns:

- `authorize({localSessionId, remoteSessionId?, deviceId, grantVersion, expiresAt})`.
  This is a **local-only** runtime operation after explicit tablet consent, not a
  remotely callable capability. It checks selected-session existence, creates a
  random remote ID if none was supplied, and replaces an earlier grant for that
  local session. One selected session is authorized to one phone at a time.
- `revoke(remoteSessionId)` stops output and clears that grant's temporary data;
  it does not stop or delete the original task/session.
- `subscribe(context, listener) -> unsubscribe`. First active viewer installs the
  local source subscription; the last viewer removes it and changes stream ID.
  The callback receives bounded internal batches, not public protocol frames.
- `snapshot(context, {limit?})`, `history(context, {cursor?, limit?})`,
  `events(context, {streamId, after, limit?})`.
- `content(context, {contentRef, offset?, limit?})` returns UTF-8 fragments of an
  already-projected, selected transcript display string. It does not accept a
  path or URL, cannot open project files, and is not exposed by protocol v1.
- `dispose()` cancels timers/subscriptions and clears grants.

`context` is exactly the trusted identity information
`{hostInstanceId, remoteSessionId, deviceId, grantVersion}`. The runtime derives
`deviceId` from authenticated pairing/transport identity; an untrusted caller's
claim is not authentication. Source/private cursors, byte offsets and paths stay
inside the tablet. Every asynchronous source read rechecks authorization after
completion so revocation or replacement while awaiting I/O cannot release a page.

Injectable adapters implement `describe(sid)`, `readHistory(sid, options)` and may
provide `capture(sid)`, `current(sid)`, `subscribe(fn)`, `readContent(sid, ref)`.
`readHistory` returns `{entries, cursor, gaps?}` in chronological order; entries
are `{item, key?, before}`. `before` is an adapter-private continuation directly
before that item, including sibling items from a single transcript line. A test
adapter must respect hard input bounds too; unbounded arbitrary adapters cannot
be made memory-safe after they have already allocated their results.

## Exact source factory integration

The following imports and export names were verified in the official source.
Place this wiring in the runtime only when enabling the optional subsystem;
importing `tablet-data.mjs` alone never starts or imports the gateway.

```js
// In gateway/gw/remote/runtime.mjs (owned by the coordinator):
import { findSessionFile, peekSession } from '../sessions.mjs';
import { transcriptItems } from '../transcript.mjs';
import { runOfSession } from '../runs.mjs';
import { onPublish } from '../bus.mjs';
import { createSourceAdapter, createTabletData } from './tablet-data.mjs';
import {
  normaliseSnapshot, normaliseHistory, createSnapshotNotifier,
} from './presentation.mjs';

const adapter = createSourceAdapter({
  findSessionFile, peekSession, transcriptItems, runOfSession, onPublish,
});
const data = createTabletData({ adapter, hostInstanceId });
// Explicitly confirmed local grant, never sourced from a phone request:
const granted = await data.authorize({
  localSessionId, deviceId: authenticatedPhoneId,
  remoteSessionId, grantVersion, expiresAt,
});
const context = {
  hostInstanceId, remoteSessionId: granted.remoteSessionId,
  deviceId: authenticatedPhoneId, grantVersion,
};
const notifier = createSnapshotNotifier({ send: sendAuthenticatedSnapshotNotice });
const unsubscribe = data.subscribe(context, notifier.push); // Subscribe first.
const raw = await data.snapshot(context);
const display = normaliseSnapshot(raw, { scope: granted.remoteSessionId });
// Construct strict v1 payload by adding the CURRENT locally-owned grant and
// pending[] generated/verified by 05; binding belongs to the outer wire frame.
const payload = {
  ...display, grant: { state: currentGrant.state, expiresAt: currentGrant.expiresAt },
  pending: currentVerifiedRequests,
};
```

The runtime must revalidate current grant/run identity before constructing the
response, use protocol `createFrame`/`validateFrame`, echo view RPC
`correlationId`, and enforce complete encoded/encrypted frame limits. A source
run change during an awaited snapshot requires another snapshot rather than
attaching stale pending requests. Revoke/close also disposes the notifier and
unsubscribes. `data.revoke` must share the runtime's serialized boundary with 05.

For history, `normaliseHistory` returns `{items, cursor, hasMore}`, where its
`cursor` is the *next* older continuation. Public `history.page` instead needs:

```js
{
  streamId: currentWireStreamId, seq: currentWireSeq,
  items: page.items,
  cursor: request.payload.cursor,
  nextCursor: page.cursor,
  hasMore: page.hasMore,
}
```

## Public Record presentation

The original run adapter records an internal `text_commit` marker after a main
assistant text event, including when the stream translator suppresses duplicated
final text. Projected clipped deltas retain `originalTextLength` in JS characters.
Bounded live reconstruction uses that span to consume omitted tails during
`discard_partial` and never walks into committed answers. Neither field becomes
a public wire type or Record field. Subagent text is labelled assistant output,
not system runtime state.

`gateway/gw/remote/presentation.mjs` exports:

```js
normaliseItems(items, {scope = 'remote'} = {})   // -> Record[]
normaliseLive(events, {scope = 'remote', runId = null} = {}) // -> Record[]
normaliseHistory(page, {scope = 'remote'} = {}) // -> {items,cursor,hasMore}
normaliseSnapshot(snapshot, {scope = 'remote'} = {})
// -> {streamId,seq,title,run:{runId,state},items,historyCursor,historyHasMore}
createSnapshotNotifier({send, delayMs = 150})   // -> {push,flush,dispose}
```

Only the strict v1 `Record` field allowlist is emitted: `id`, `kind`, `role`,
`text`, `toolName`, `toolStatus`, `toolInputText`, `toolResultText`, `source`,
`timestamp`, `truncated`. IDs are stable, remote-scope hashes of display identity,
not local session IDs. Historical message IDs incorporate a hash of the trusted
absolute source block position so identical siblings remain distinct across pages.
The internal `recordKey`, source location and cursor state are not public Record
fields. Tool-use and matching tool-result combine into a card; missing result on a
historical page does not pretend that the tool is running.
Known tool inputs are preview text only. `run_start` and `inject` may carry
`source:'phone'` only when original trusted local bus/run-log ingress supplied a
valid `sourceDeviceId`; the actual device ID is not exported. A bare `source`
string, transcript field or tool input cannot establish phone provenance. The
presentation layer preserves this projected marker on its user Record. Historical
items without trusted ingress provenance remain unlabelled; matching words alone
must not turn an old message into a phone-originated instruction.

No source objects, environment maps,
request input, arbitrary file-interface fields, detail references, model settings
or thinking are forwarded. Text can naturally contain paths or code that the
original user/assistant/tool already included; a path in text is not a file API.

`normaliseSnapshot` leaves authority out: no `binding`, `grant` or `pending` is
invented. Null run is strict-v1 `idle`. An original run with `idle=true` but a
remaining run ID becomes `ended` (this round ended; background process may remain),
not `stopped`. Pending summaries only inform `waiting`; 05 supplies actual Request
records and their complete-details semantics. The strict protocol currently has
no source-gap flag: the runtime must not claim full history when raw `liveGap` or
`history.gaps` reports missing content. A source gap is a visible limited display,
not a reason to invent approval completeness.

### Initial event delivery

Raw data batches are deliberately **not** wire records/deltas. The notifier
reduces repeated batches to a single latest `{type:'snapshot.required', streamId,
seq}` notice, with a single in-flight send and one pending marker maximum. It does
not retain or transmit per-character content. Failed/offline sends do not create
an unbounded automatic retry loop.

The coordinator wraps notices in the strict public envelope:

```js
{
  streamId: wireStreamId,
  fromSeq: n, toSeq: n,
  events: [{seq: n, type: 'snapshot.required', payload: {}}],
}
```

Wire event sequence must be contiguous. The runtime should keep its own
notification sequence and consistently put it in wire snapshots/history, or
otherwise resynchronize after source-sequence coalescing. It must not declare
`fromSeq..toSeq` covering dropped source deltas while sending only one event.
The phone fetches a new authorized snapshot after invalidation. This is a
bounded recovery-first implementation, not a claim of per-character public
incremental replication.

## Size, filtering and recovery behavior

- No body output without an active viewer. Unknown events and global
  `state/hello/quota/perm_mode` are discarded on the tablet before remote export.
  A raw event with explicit wrong `sessionId` is rejected even if its run ID is
  familiar. Events without a session ID must match an observed/current selected
  run. Ended-run identity is retained in a bounded local map.
- Remote replay has a dedicated stream ID and per-grant sequence; no global SSE
  sequence or global run/queue object leaks. Closed/reopened viewing changes the
  stream ID; overflow/future/changed-stream queries explicitly require a snapshot.
- Defaults: at most 50 items and 60KiB per data page/frame, 16KiB per projected
  event, 512KiB/256 events per replay window, 150ms listener batches. A frame has
  4KiB reserved versus the outer 64KiB limit, but runtime encryption/schema checks
  remain required. One listener has at most one pending promise; a slow receiver
  can cause a marked replay gap, never an unbounded callback queue.
- Selected-transcript reverse scans read at most 2MiB per call and retain at most
  a 1MiB line, reusing verified original `transcriptItems`. Huge/invalid/too-many-
  block rows produce explicit gaps and a progressing continuation. This avoids
  the old reader's soft-limit and oversized-line allocation behavior without
  modifying shared transcript code. Each line has at most 2048 content blocks.
- At most one source/body read per selected local session is in flight. A second
  history/snapshot/content request fails immediately with `READ_BUSY`, without
  queueing or retaining another page. Replacing/revoking a grant does not free the
  old I/O slot until that operation completes. Runtime should coalesce duplicate
  resync requests rather than blindly retrying this condition.
- Cursors and content references are opaque, per-grant, bounded, and expire after
  five minutes. They include private inode/boundary-hash checks, allow ordinary
  appends, and reject changed/truncated source boundaries. They are not a complete
  integrity proof for arbitrary in-place edits elsewhere in a transcript; raw
  content refs additionally verify their exact line hash before every read.
- Snapshot captures a small synchronous selected-file boundary and original run
  before awaited reads, then returns a sequence anchor. Subscribe before snapshot
  and request subsequent events only after that anchor. Combined history/live
  item counts reserve the <=50 Record budget rather than slicing off history and
  silently losing its continuation.
- Original live logs can already be very large. Remote projection copies only a
  bounded string prefix and emits `liveGap` when the local source slice is not
  complete; it does not fix original local log retention. Original history tool
  clipping is a real source limitation: `content` cannot restore bytes already
  removed by `transcriptItems`. Full approval details never come from this path.

## Validation

Commands use the project's runner, which strips real `CCAPP_*` variables, sets
`CCAPP_TEST=1`, and creates a temporary HOME/workspace. Test fixtures do not call
models or mock a frontend as evidence of a backend capability.

```sh
node scripts/test.mjs remote-tablet-data remote-presentation
```

Current review fixes and their regression assertions have not run on this public
integration branch. Earlier development test counts and intermediate failures
are not results for the current source; see the
[current acceptance record](REMOTE-REVIEW-ACCEPTANCE.zh-CN.md).

Test scenarios include selected-session isolation, wrong identity/grant/host,
traversal rejection, inert imports, item/byte pagination and sibling continuation,
whitelist filtering, UTF-8 fragments, oversized-line gaps, cursor expiry,
snapshot/live barriers, overflow recovery, slow listeners, revocation during I/O,
strict Record output, source provenance, partial rollback and repeated sibling
identity across pages. A historical provenance fixture selected an unlabelled
history duplicate by first-text match; the current integration must distinguish
trusted live records without inferring provenance from matching words.

These fixtures do not establish two-device behavior, native notifications,
real-model execution or physical-network performance.
