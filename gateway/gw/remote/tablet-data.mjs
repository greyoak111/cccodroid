import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";

// This module never imports the gateway: those imports read HOME and may start work.
// Only the local, already-authenticated runtime may call authorize/revoke.
export const TABLET_DATA_LIMITS = Object.freeze({
  frameBytes: 60 * 1024, pageItems: 50, pageBytes: 60 * 1024,
  eventBytes: 16 * 1024, ringBytes: 512 * 1024, ringItems: 256,
  previewBytes: 2048, contentBytes: 8192, liveBytes: 24 * 1024,
  scanBytes: 2 * 1024 * 1024, lineBytes: 1024 * 1024,
  grants: 32, cursors: 64, contentRefs: 128, listeners: 4, reads: 1,
  tokenTtlMs: 5 * 60 * 1000, batchMs: 150,
});
const SID = /^[A-Za-z0-9_-]{1,80}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const bytes = (v) => Buffer.byteLength(JSON.stringify(v));
const hash = (v) => createHash("sha256").update(v).digest("hex");
const fail = (code) => { const e = new Error(code); e.code = code; throw e; };
const text = (v) => typeof v === "string" ? v : "";
const number = (v) => Number.isFinite(v) ? v : 0;
const tick = () => new Promise((resolve) => setImmediate(resolve));

function clipped(v, max) {
  const value = text(v);
  if (value.length <= max && Buffer.byteLength(value) <= max) return value;
  // Copy only a bounded prefix, not a second multi-megabyte run.log string.
  let prefix = value.slice(0, max);
  if (/[\uD800-\uDBFF]/.test(prefix.slice(-1))) prefix = prefix.slice(0, -1);
  const b = Buffer.from(prefix);
  let end = Math.min(max, b.length);
  while (end > 0 && (b[end] & 0xc0) === 0x80) end--;
  return b.toString("utf8", 0, end);
}
function limitsOf(options = {}) {
  const limits = { ...TABLET_DATA_LIMITS };
  for (const [k, v] of Object.entries(options)) {
    if (!(k in limits) || !Number.isSafeInteger(v) || v <= 0 || v > limits[k]) fail("INVALID_LIMIT");
    limits[k] = v;
  }
  if (limits.frameBytes < 2048 || limits.pageBytes < 1024 || limits.eventBytes < 512 || limits.cursors < 3) fail("INVALID_LIMIT");
  return limits;
}
function boundedMap(map, key, value, max) {
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value);
}
function ownString(item, field) {
  if (field === "text") return typeof item?.text === "string" ? item.text : null;
  if (/^input\.[A-Za-z_]+$/.test(field)) {
    const v = item?.input?.[field.slice(6)];
    return typeof v === "string" ? v : null;
  }
  return null;
}

// These are display previews, never permission inputs. Unknown tool inputs and
// environment/configuration fields are deliberately not recursively serialized.
const TOOL_FIELDS = Object.freeze({
  Bash: ["command", "description", "timeout"],
  Read: ["file_path", "offset", "limit", "pages"],
  Write: ["file_path", "content"],
  Edit: ["file_path", "old_string", "new_string", "replace_all"],
  Glob: ["pattern", "path"],
  Grep: ["pattern", "path", "glob", "output_mode"],
  Agent: ["description", "prompt", "subagent_type"],
  Task: ["description", "prompt", "subagent_type"],
  WebFetch: ["url", "prompt"], WebSearch: ["query"],
});

function projectItem(item, limits, reference = null) {
  if (!item || typeof item !== "object") return null;
  const role = item.role;
  const out = { role };
  const details = [];
  const preview = (value, field, max = limits.previewBytes) => {
    const valueText = text(value), shown = clipped(valueText, max);
    if (shown !== valueText) {
      (out.truncatedFields ||= []).push(field);
      const ref = reference?.(field, Buffer.byteLength(valueText));
      if (ref) details.push({ contentRef: ref, field, bytes: Buffer.byteLength(valueText) });
    }
    return shown;
  };
  if (["user", "assistant", "note"].includes(role)) {
    out.text = preview(item.text, "text");
    if (typeof item.uuid === "string") out.uuid = clipped(item.uuid, 128);
    if (role === "note" && item.compact === true) out.compact = true;
  } else if (role === "tool_result") {
    out.id = clipped(item.id, 128); out.ok = item.ok === true;
    out.text = preview(item.text, "text");
    // transcriptItems itself clips tool results to 4000 chars. Do not claim a
    // complete source result even when our own preview fits.
    out.previewOnly = true;
  } else if (role === "tool_use") {
    out.id = clipped(item.id, 128); out.name = clipped(item.name, 128);
    out.previewOnly = true; out.input = {};
    const fields = Object.hasOwn(TOOL_FIELDS, item.name) ? TOOL_FIELDS[item.name] : null;
    if (!fields) out.inputOmitted = true;
    else for (const field of fields) {
      const value = item.input?.[field];
      if (typeof value === "string") out.input[field] = preview(value, "input." + field, Math.min(1024, limits.previewBytes));
      else if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) out.input[field] = value;
    }
  } else return null; // thinking, attachments and arbitrary transcript roles.
  if (details.length) out.details = details;
  if (out.truncatedFields) { out.truncated = true; out.detailsAvailable = details.length > 0; }
  if (item.truncated === true || item.previewOnly === true) out.truncated = true;
  // JSON escaping can be six times larger than UTF-8 input. A second pass keeps
  // control-character-heavy previews inside the actual wire budget as well.
  if (bytes(out) > limits.eventBytes && out.input) {
    const max = Math.max(4, Math.min(128, Math.floor((limits.eventBytes - 300) / (Math.max(1, Object.keys(out.input).length) * 6))));
    for (const field of Object.keys(out.input)) if (typeof out.input[field] === "string") out.input[field] = clipped(out.input[field], max);
    out.truncated = true; out.previewOnly = true;
  }
  if (bytes(out) > limits.eventBytes) {
    out.text = clipped(out.text, Math.max(16, Math.floor((limits.eventBytes - 512) / 6)));
    out.truncated = true;
  }
  if (bytes(out) > limits.eventBytes) return { role, text: "", truncated: true, previewOnly: true };
  return out;
}

function requestSummary(p) {
  return { id: clipped(p?.id, 128), tool: clipped(p?.tool, 128), detailsComplete: false };
}
function projectEvent(ev, limits) {
  if (!ev || typeof ev !== "object") return null;
  const out = { type: ev.type };
  if (typeof ev.runId === "string") out.runId = clipped(ev.runId, 128);
  // Only original run ingress adds this marker after authenticated remote
  // submission. Transcript/source strings are not provenance and projectItem
  // deliberately never copies them. The actual device ID stays on the tablet.
  if ((ev.type === "run_start" || ev.type === "inject") && typeof ev.sourceDeviceId === "string" && ID.test(ev.sourceDeviceId)) out.source = "phone";
  const txt = (field = "text") => {
    out[field] = clipped(ev[field], Math.min(limits.previewBytes, Math.max(16, Math.floor((limits.eventBytes - 512) / 6))));
    if (out[field] !== text(ev[field])) { out.truncated = true; out.requiresSnapshot = true; }
  };
  switch (ev.type) {
    case "run_start": txt(); out.startedAt = number(ev.startedAt); break;
    case "init": break; // Do not export model, permission mode, version or local sid.
    case "run_busy": out.startedAt = number(ev.startedAt); break;
    case "run_idle": out.bg = number(ev.bg); break;
    case "run_end": out.aborted = ev.aborted === true; break;
    case "inject": case "delta": case "assistant_text": case "sub_text":
      txt(); if (typeof ev.parent === "string") out.parent = clipped(ev.parent, 128);
      // Rollback counts JS characters in the original uncommitted delta, not
      // the byte-limited preview. This count never enters public Records.
      if (ev.type === "delta" && out.truncated) out.originalTextLength = text(ev.text).length;
      break;
    case "text_commit": break;
    case "tool_use": case "tool_result": {
      const item = projectItem({ ...ev, role: ev.type }, limits);
      if (!item) return null;
      const { role, ...fields } = item; Object.assign(out, fields);
      if (typeof ev.parent === "string") out.parent = clipped(ev.parent, 128);
      break;
    }
    case "phase":
      if (!["wait", "think", "tool", "text", "retry"].includes(ev.phase)) return null;
      out.phase = ev.phase;
      if (ev.phase === "tool") { out.id = clipped(ev.id, 128); out.name = clipped(ev.name, 128); out.chars = number(ev.chars); }
      if (ev.phase === "retry") { out.attempt = number(ev.attempt); out.max = number(ev.max); out.delayMs = number(ev.delayMs); }
      break;
    case "discard_partial": out.text = number(ev.text); out.think = number(ev.think); break;
    case "compacting": break;
    case "compacted": out.pre = number(ev.pre); out.post = number(ev.post); break;
    case "note": txt(); break;
    case "error": txt("message"); break; // Never stderr/detail or raw bridge errors.
    case "sub_progress":
      out.parent = clipped(ev.parent, 128); out.desc = clipped(ev.desc, 200);
      out.tokens = number(ev.tokens); out.tools = number(ev.tools); break;
    case "sub_done": out.parent = clipped(ev.parent, 128); out.status = clipped(ev.status, 40); break;
    case "perm_request": Object.assign(out, requestSummary(ev)); break;
    case "perm_resolved":
      out.id = clipped(ev.id, 128); out.behavior = ["allow", "deny", "cancel"].includes(ev.behavior) ? ev.behavior : "unknown"; break;
    default: return null; // In particular: global state/hello/quota/settings/thinking.
  }
  return bytes(out) <= limits.eventBytes ? out : null;
}

/** Local-only data plane. context = {hostInstanceId,remoteSessionId,deviceId,grantVersion}. */
export function createTabletData({ adapter, hostInstanceId = randomUUID(), now = Date.now, limits: options } = {}) {
  if (!adapter || typeof adapter.describe !== "function" || typeof adapter.readHistory !== "function") fail("INVALID_ADAPTER");
  if (!ID.test(hostInstanceId)) fail("INVALID_HOST");
  const limits = limitsOf(options), grants = new Map();
  let stopSource = null, disposed = false;
  const reading = new Set();
  async function withRead(g, work) {
    // Historical/body reads never queue: even a revoked old read retains its
    // slot until I/O finishes, so reauthorization cannot multiply allocations.
    if (reading.has(g.localSessionId)) fail("READ_BUSY");
    reading.add(g.localSessionId);
    try { return await work(); } finally { reading.delete(g.localSessionId); }
  }

  const checkLocal = () => { if (disposed) fail("DISPOSED"); };
  function active(g) {
    if (grants.get(g.remoteSessionId) !== g) return false;
    if (g.expiresAt <= now()) { remove(g); return false; }
    return true;
  }
  function resolve(context) {
    checkLocal();
    if (!context || context.hostInstanceId !== hostInstanceId) fail("STALE_HOST");
    const g = grants.get(context.remoteSessionId);
    if (!g || !active(g) || context.deviceId !== g.deviceId) fail("SESSION_NOT_AUTHORIZED");
    if (context.grantVersion !== g.grantVersion) fail("STALE_GRANT");
    return g;
  }
  function recheck(g, context) { if (resolve(context) !== g) fail("SESSION_NOT_AUTHORIZED"); }
  function pruneTokens(g) {
    for (const map of [g.cursors, g.refs]) for (const [key, value] of map) if (value.expiresAt <= now()) map.delete(key);
    if (!g.cursors.has(g.historyCursor)) g.historyCursor = null;
    if (!g.cursors.has(g.previousHistoryCursor)) g.previousHistoryCursor = null;
  }
  function renewExpiry(g) {
    g.expiryTimer = setTimeout(() => { if (active(g)) renewExpiry(g); }, Math.min(0x7fffffff, Math.max(1, g.expiresAt - now())));
    g.expiryTimer.unref?.();
  }
  function disconnectSource() {
    if (![...grants.values()].some((g) => g.listeners.size)) {
      const stop = stopSource; stopSource = null;
      try { stop?.(); } catch {}
    }
  }
  function resetStream(g) {
    g.streamId = randomUUID(); g.seq = 0; g.ring = []; g.ringBytes = 0; g.runIds.clear();
    g.snapshots.clear(); g.snapshotAck = -1; g.historyCursor = g.previousHistoryCursor = null;
  }
  function remove(g) {
    clearTimeout(g.timer); clearTimeout(g.expiryTimer);
    g.listeners.clear(); g.ring = []; g.ringBytes = 0; g.cursors.clear(); g.historyCursor = g.previousHistoryCursor = null; g.refs.clear(); g.snapshots.clear();
    grants.delete(g.remoteSessionId); disconnectSource();
  }
  function current(g) {
    const run = adapter.current?.(g.localSessionId);
    return run?.sessionId === g.localSessionId && typeof run.id === "string" && !run.ended ? run : null;
  }
  function rememberRun(g, runId) {
    if (typeof runId === "string") boundedMap(g.runIds, runId, true, 8);
  }
  function gapBatch(g, after, reason) {
    return { type: "event.batch", remoteSessionId: g.remoteSessionId, streamId: g.streamId,
      after, to: g.seq, events: [], gap: { reason, oldest: g.ring[0]?.seq ?? g.seq + 1, head: g.seq }, requiresSnapshot: true, more: false };
  }
  function batch(g, { streamId, after = 0, limit = limits.pageItems } = {}) {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > limits.pageItems) fail("INVALID_SEQUENCE");
    if (!g.listeners.size) return gapBatch(g, after, "not_subscribed");
    if (streamId !== g.streamId) return gapBatch(g, after, "stream_changed");
    if (after > g.seq) return gapBatch(g, after, "future_sequence");
    if (after < (g.ring[0]?.seq ?? g.seq + 1) - 1) return gapBatch(g, after, "window_exceeded");
    const out = { type: "event.batch", remoteSessionId: g.remoteSessionId, streamId: g.streamId, after, to: after, events: [], gap: null, more: false };
    for (const event of g.ring) {
      if (event.seq <= after) continue;
      if (out.events.length >= limit || bytes(out) + bytes(event) + 64 > limits.frameBytes) break;
      out.events.push(event); out.to = event.seq;
    }
    out.more = out.to < g.seq;
    return out;
  }
  function schedule(g) {
    if (!g.timer && g.listeners.size && active(g)) {
      g.timer = setTimeout(() => { g.timer = null; flush(g); }, limits.batchMs);
      g.timer.unref?.();
    }
  }
  function flush(g) {
    if (!active(g)) return;
    for (const s of g.listeners) {
      if (s.busy || s.blocked || s.after === g.seq) continue;
      const out = batch(g, { streamId: g.streamId, after: s.after }), epoch = s.ackEpoch;
      s.busy = true;
      // At most one callback promise per listener: a slow socket cannot grow an
      // unbounded queue of promises or retain copies of old event batches.
      Promise.resolve().then(() => active(g) && g.listeners.has(s) ? s.listener(out) : false).then((accepted) => {
        s.busy = false;
        if (!active(g) || !g.listeners.has(s)) return;
        // A successfully sent snapshot may have ACKed while this callback was
        // pending. Never let its old gap/completion undo that exact anchor.
        if (epoch === s.ackEpoch && accepted !== false) {
          // A gap is not delivery of the missing events. Its head must never
          // advance the anchor past a snapshot that is still being read.
          if (out.gap) s.blocked = true;
          else s.after = Math.max(s.after, out.to);
        }
        if (!s.blocked && s.after < g.seq && (accepted !== false || epoch !== s.ackEpoch)) schedule(g);
      }).catch(() => {
        s.busy = false;
        if (!active(g) || !g.listeners.has(s)) return;
        if (epoch === s.ackEpoch) s.blocked = true;
        else if (!s.blocked && s.after < g.seq) schedule(g);
      });
    }
  }
  function ingest(ev) {
    if (!ev || typeof ev !== "object") return;
    for (const g of [...grants.values()]) {
      if (!active(g) || !g.listeners.size) continue;
      // Reject an explicit sid mismatch before consulting runId. Events without
      // sid must match a run actually observed for this authorized local session.
      if (ev.sessionId != null && ev.sessionId !== g.localSessionId) continue;
      const run = current(g); if (run) rememberRun(g, run.id);
      if (ev.sessionId !== g.localSessionId && !(typeof ev.runId === "string" && g.runIds.has(ev.runId))) continue;
      const event = projectEvent(ev, limits); if (!event) continue;
      rememberRun(g, ev.runId);
      const entry = { seq: ++g.seq, ...event }, size = bytes(entry);
      g.ring.push(entry); g.ringBytes += size;
      while (g.ring.length && (g.ring.length > limits.ringItems || g.ringBytes > limits.ringBytes)) g.ringBytes -= bytes(g.ring.shift());
      schedule(g);
    }
  }
  function reference(g, key, field, size) {
    if (!key || typeof adapter.readContent !== "function") return null;
    const ref = randomUUID();
    boundedMap(g.refs, ref, { key, field, size, expiresAt: now() + limits.tokenTtlMs }, limits.contentRefs);
    return ref;
  }
  function cursor(g, sourceCursor, excludeFrom) {
    if (sourceCursor == null) return null;
    const token = randomUUID();
    g.cursors.set(token, { sourceCursor, excludeFrom, expiresAt: now() + limits.tokenTtlMs });
    // Pushes continually mint unrelated latest-window cursors. Protect the
    // explicit frontier and its input (the phone may reject a full cache page),
    // within the unchanged count/TTL/grant bound. Other tokens remain FIFO.
    while (g.cursors.size > limits.cursors) {
      const oldest = [...g.cursors.keys()].find((key) => key !== g.historyCursor && key !== g.previousHistoryCursor);
      g.cursors.delete(oldest);
    }
    return token;
  }
  function capture(g) {
    const captured = adapter.capture?.(g.localSessionId) || {};
    const run = captured.run ?? current(g);
    if (run?.sessionId === g.localSessionId && !run.ended) rememberRun(g, run.id);
    return { run: run?.sessionId === g.localSessionId && !run.ended ? run : null, before: captured.before ?? null };
  }
  async function readPage(g, context, { sourceCursor = null, excludeFrom = 0, limit = limits.pageItems, maxBytes = limits.pageBytes, reserveGap = true, allowEmpty = false } = {}) {
    let source;
    try { source = await adapter.readHistory(g.localSessionId, { before: sourceCursor, excludeFrom, limit }); }
    catch (e) { recheck(g, context); fail(e?.code === "STALE_CURSOR" ? "STALE_CURSOR" : "SOURCE_UNAVAILABLE"); }
    recheck(g, context);
    if (!source || !Array.isArray(source.entries) || source.entries.length > limits.pageItems) fail("INVALID_SOURCE_PAGE");
    const items = [], gaps = Array.isArray(source.gaps) ? source.gaps.slice(0, 4).map((v) => ({ reason: ["line_too_large", "scan_limit", "invalid_line", "too_many_blocks"].includes(v.reason) ? v.reason : "source_gap" })) : [];
    // Presentation adds one fixed Record for a missing source slice. Reserve its
    // slot before selecting entries, while private continuations still exist.
    const itemLimit = Math.max(0, limit - (reserveGap && gaps.length ? 1 : 0));
    let next = source.cursor ?? null;
    for (let i = source.entries.length - 1; i >= 0; i--) {
      const entry = source.entries[i];
      const item = projectItem(entry.item, limits, (field, size) => reference(g, entry.key, field, size));
      if (!item) continue;
      // The absolute source block position survives sibling pagination and
      // preview clipping. Export only its hash; local file identity stays here.
      if (entry.key) item.recordKey = hash(JSON.stringify([g.remoteSessionId, entry.key.identity, entry.key.start, entry.key.index]));
      if (items.length >= itemLimit || bytes(items) + bytes(item) + 1024 > maxBytes) {
        // 'after' retains this undelivered item but not a newer source gap that
        // was already reported. In particular a one-Record gap page progresses.
        if (!items.length) {
          if (!allowEmpty && itemLimit > 0) fail("INVALID_SOURCE_PAGE");
          next = entry.after ?? sourceCursor;
          if (next == null) fail("INVALID_SOURCE_PAGE");
        } else if (next == null) fail("INVALID_SOURCE_PAGE");
        break;
      }
      items.unshift(item); next = entry.before ?? null;
    }
    return { type: "history.page", remoteSessionId: g.remoteSessionId, items,
      cursor: cursor(g, next, excludeFrom), hasMore: next != null, gaps };
  }
  function checkedLimit(limit) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > limits.pageItems) fail("INVALID_LIMIT");
    return limit;
  }
  function frame(value) { if (bytes(value) > limits.frameBytes) fail("PAYLOAD_TOO_LARGE"); return value; }

  return Object.freeze({
    hostInstanceId,
    async authorize({ localSessionId, remoteSessionId = randomUUID(), deviceId, grantVersion, expiresAt } = {}) {
      checkLocal();
      if (!SID.test(localSessionId || "") || !ID.test(remoteSessionId) || remoteSessionId === localSessionId || !ID.test(deviceId || "") ||
          !Number.isSafeInteger(grantVersion) || grantVersion < 1 || !Number.isSafeInteger(expiresAt) || expiresAt <= now()) fail("INVALID_GRANT");
      if (grants.has(remoteSessionId)) fail("GRANT_EXISTS");
      const prior = [...grants.values()].find((g) => g.localSessionId === localSessionId);
      if (!prior && grants.size >= limits.grants) fail("GRANT_LIMIT");
      let meta;
      try { meta = await adapter.describe(localSessionId); } catch { fail("SOURCE_UNAVAILABLE"); }
      checkLocal();
      if (!meta) fail("SESSION_NOT_FOUND");
      if (expiresAt <= now()) fail("INVALID_GRANT");
      // Recheck after async source I/O: two local authorization clicks may race.
      if (grants.has(remoteSessionId)) fail("GRANT_EXISTS");
      const existing = [...grants.values()].find((g) => g.localSessionId === localSessionId);
      if (existing) remove(existing);
      if (grants.size >= limits.grants) fail("GRANT_LIMIT");
      const g = { localSessionId, remoteSessionId, deviceId, grantVersion, expiresAt, title: clipped(meta.title, 300),
        listeners: new Set(), ring: [], ringBytes: 0, cursors: new Map(), historyCursor: null, previousHistoryCursor: null, refs: new Map(), runIds: new Map(), snapshots: new Map(), snapshotAck: -1, seq: 0, streamId: randomUUID() };
      grants.set(remoteSessionId, g); renewExpiry(g);
      return { hostInstanceId, remoteSessionId, deviceId, grantVersion, expiresAt, title: g.title };
    },
    revoke(remoteSessionId) { checkLocal(); const g = grants.get(remoteSessionId); if (!g) return false; remove(g); return true; },
    async history(context, { cursor: token = null, limit = limits.pageItems } = {}) {
      const g = resolve(context); checkedLimit(limit); pruneTokens(g);
      let state;
      if (token != null) { state = g.cursors.get(token); if (!state) fail("INVALID_CURSOR"); }
      else { const c = capture(g); state = { sourceCursor: c.before, excludeFrom: c.run?.startedAt || 0 }; }
      return withRead(g, async () => {
        const streamId = g.streamId;
        const page = frame(await readPage(g, context, { ...state, limit, maxBytes: Math.min(limits.pageBytes, limits.frameBytes) }));
        if (streamId === g.streamId) { g.previousHistoryCursor = token; g.historyCursor = page.cursor; }
        return page;
      });
    },
    // maxBytes is the complete raw snapshot budget after the runtime reserves
    // its verified pending/grant/envelope. Never trim normalized history Records:
    // only this layer still owns the continuation before every withheld item.
    async snapshot(context, { limit = limits.pageItems, maxBytes = limits.frameBytes, reserveItems = 1 } = {}) {
      const g = resolve(context); checkedLimit(limit); pruneTokens(g);
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 2048 || maxBytes > limits.frameBytes ||
          !Number.isSafeInteger(reserveItems) || reserveItems < 0 || reserveItems > limit) fail("INVALID_LIMIT");
      return withRead(g, async () => {
        const c = capture(g), run = c.run;
        const pending = [];
        if (run?.perms instanceof Map) for (const p of run.perms.values()) { if (pending.length === 32) break; pending.push(p); }
        const out = { type: "session.snapshot", remoteSessionId: g.remoteSessionId, hostInstanceId, grantVersion: g.grantVersion,
          streamId: g.streamId, seq: g.seq, resumable: g.listeners.size > 0, title: g.title,
          run: run ? { id: clipped(run.id, 128), startedAt: number(run.startedAt), idle: run.idle === true, backgroundCount: number(run.bgTasks),
            pendingRequests: pending.map(requestSummary), pendingRequestsTruncated: (run.perms?.size || 0) > pending.length } : null,
          liveEvents: [], liveGap: false };
        // These are presence-only summaries, not approval details. The runtime
        // adds its independently verified complete Requests after projection.
        while (out.run?.pendingRequests.length > 1 && bytes(out) + 512 > maxBytes) {
          out.run.pendingRequests.pop(); out.run.pendingRequestsTruncated = true;
        }
        // Keep room for the history envelope and the fixed presentation gap
        // Record even when a busy run has a very large local log.
        const itemBudget = limit - reserveItems;
        const liveBudget = Math.min(limits.liveBytes, Math.max(0, maxBytes - bytes(out) - 1536));
        let liveBytes = 0;
        const log = Array.isArray(run?.log) ? run.log : [];
        for (let i = log.length - 1; i >= 0; i--) {
          if (log[i]?.sessionId != null && log[i].sessionId !== g.localSessionId) continue;
          if (log[i]?.runId != null && log[i].runId !== run.id) continue;
          const event = projectEvent(log[i], limits); if (!event) continue;
          const cost = bytes(event) + 1;
          if (out.liveEvents.length >= itemBudget || liveBytes + cost > liveBudget) { out.liveGap = true; break; }
          out.liveEvents.unshift(event); liveBytes += cost; if (event.truncated) out.liveGap = true;
        }
        const budget = Math.min(limits.pageBytes, maxBytes - bytes(out) - 512);
        const historyLimit = Math.max(0, itemBudget - out.liveEvents.length);
        out.history = historyLimit && budget >= 1024
          ? await readPage(g, context, { sourceCursor: c.before, excludeFrom: run?.startedAt || 0, limit: historyLimit, maxBytes: budget, reserveGap: false, allowEmpty: true })
          : { type: "history.page", remoteSessionId: g.remoteSessionId, items: [], cursor: cursor(g, c.before, run?.startedAt || 0), hasMore: c.before != null, gaps: [] };
        recheck(g, context);
        if (bytes(out) > maxBytes) fail("PAYLOAD_TOO_LARGE");
        const result = frame(out);
        if (result.streamId === g.streamId) boundedMap(g.snapshots, result.seq, true, limits.cursors);
        return result;
      });
    },
    // Local runtime calls this only after successfully sending this exact
    // snapshot. An ACK must not skip events received during its awaited read.
    ackSnapshot(context, { streamId, seq } = {}) {
      const g = resolve(context);
      if (!Number.isSafeInteger(seq) || seq < 0) fail("INVALID_SEQUENCE");
      if (streamId !== g.streamId || seq < g.snapshotAck || !g.snapshots.has(seq)) return false;
      g.snapshotAck = seq;
      for (const s of g.listeners) {
        s.ackEpoch++;
        s.after = Math.max(s.after, seq);
        s.blocked = false;
      }
      for (const anchor of g.snapshots.keys()) if (anchor < seq) g.snapshots.delete(anchor);
      if ([...g.listeners].some((s) => s.after < g.seq)) schedule(g);
      return true;
    },
    events(context, options = {}) { return frame(batch(resolve(context), options)); },
    subscribe(context, listener) {
      const g = resolve(context);
      if (typeof listener !== "function") fail("INVALID_LISTENER");
      if (typeof adapter.subscribe !== "function") fail("LIVE_UNAVAILABLE");
      if (g.listeners.size >= limits.listeners) fail("LISTENER_LIMIT");
      if (!g.listeners.size) resetStream(g);
      const s = { listener, after: g.seq, busy: false, blocked: false, ackEpoch: 0 };
      g.listeners.add(s);
      try { if (!stopSource) { const stop = adapter.subscribe(ingest); if (typeof stop !== "function") fail("INVALID_ADAPTER"); stopSource = stop; } }
      catch { g.listeners.delete(s); disconnectSource(); fail("LIVE_UNAVAILABLE"); }
      const run = current(g); if (run) rememberRun(g, run.id);
      let done = false;
      return () => {
        if (done) return; done = true; g.listeners.delete(s);
        if (!g.listeners.size) { clearTimeout(g.timer); g.timer = null; resetStream(g); }
        disconnectSource();
      };
    },
    async content(context, { contentRef, offset = 0, limit = limits.contentBytes } = {}) {
      const g = resolve(context); pruneTokens(g);
      const ref = g.refs.get(contentRef); if (!ref) fail("INVALID_CONTENT_REF");
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 4 || limit > limits.contentBytes) fail("INVALID_RANGE");
      return withRead(g, async () => {
      let value;
      try { value = await adapter.readContent(g.localSessionId, { key: ref.key, field: ref.field }); }
      catch { recheck(g, context); fail("STALE_CONTENT"); }
      recheck(g, context);
      if (typeof value !== "string") fail("STALE_CONTENT");
      const b = Buffer.from(value);
      if (b.length !== ref.size || offset > b.length || (offset < b.length && (b[offset] & 0xc0) === 0x80)) fail("INVALID_RANGE");
      let end = Math.min(b.length, offset + limit);
      while (end > offset && end < b.length && (b[end] & 0xc0) === 0x80) end--;
      return frame({ type: "history.content", remoteSessionId: g.remoteSessionId, contentRef, field: ref.field,
        offset, next: end, bytes: b.length, text: b.toString("utf8", offset, end), done: end === b.length, previewOnly: true });
      });
    },
    dispose() { if (disposed) return; for (const g of [...grants.values()]) remove(g); disposed = true; },
  });
}

// Source continuations stay inside the tablet. A head hash allows ordinary
// appends while detecting replaced/truncated files and changes at the boundary.
function fileIdentity(st) { return `${st.dev}:${st.ino}`; }
async function headOf(fh, size) {
  const n = Math.min(4096, size), b = Buffer.alloc(n);
  const { bytesRead } = await fh.read(b, 0, n, size - n);
  if (bytesRead !== n) fail("STALE_CURSOR");
  return { end: size, hash: hash(b) };
}
async function previousLine(fh, end, budget, maxLine, skip = false) {
  let pos = end, scanned = 0, parts = [], length = 0, tooLarge = skip;
  if (pos > 0 && !skip) {
    const last = Buffer.alloc(1); const r = await fh.read(last, 0, 1, pos - 1);
    if (r.bytesRead !== 1) fail("STALE_CURSOR");
    if (last[0] === 10) pos--;
  }
  const lineEnd = pos;
  while (pos > 0 && scanned < budget) {
    const n = Math.min(64 * 1024, pos, budget - scanned), start = pos - n, b = Buffer.alloc(n);
    const { bytesRead } = await fh.read(b, 0, n, start);
    if (bytesRead !== n) fail("STALE_CURSOR");
    const nl = b.lastIndexOf(10), part = b.subarray(nl + 1);
    scanned += n; length += part.length;
    if (length > maxLine) { tooLarge = true; parts = []; }
    if (!tooLarge) parts.unshift(part);
    pos = start;
    if (nl >= 0) return { start: start + nl + 1, end: lineEnd, next: start + nl + 1, scanned,
      line: tooLarge ? null : Buffer.concat(parts), gap: tooLarge ? "line_too_large" : null };
  }
  if (pos === 0) return { start: 0, end: lineEnd, next: 0, scanned, line: tooLarge ? null : Buffer.concat(parts), gap: tooLarge ? "line_too_large" : null };
  return { next: pos, scanned, skip: true, line: null, gap: "scan_limit" };
}

/** Bounded, selected-transcript reader; not a route and never accepts a remote path. */
export async function readBoundedSessionPage(file, { before = null, limit = 50, excludeFrom = 0, transcriptItems, limits: options } = {}) {
  const limits = limitsOf(options);
  if (typeof transcriptItems !== "function" || !Number.isSafeInteger(limit) || limit < 1 || limit > limits.pageItems) fail("INVALID_ADAPTER");
  const fh = await fs.promises.open(file, "r");
  try {
    const st = await fh.stat(), identity = fileIdentity(st);
    const saved = before && typeof before === "object" ? before : null;
    if (saved && (saved.identity !== identity || st.size < saved.head.end)) fail("STALE_CURSOR");
    const head = saved?.head || await headOf(fh, st.size);
    if (saved && (await headOf(fh, head.end)).hash !== head.hash) fail("STALE_CURSOR");
    let pos = saved?.offset ?? head.end, itemBefore = saved?.itemBefore ?? null, skip = saved?.skip === true;
    if (!Number.isSafeInteger(pos) || pos < 0 || pos > head.end) fail("STALE_CURSOR");
    let scanned = 0, next = null, retained = 0;
    const entries = [], gaps = [];
    while (pos > 0 && scanned < limits.scanBytes && entries.length < limit) {
      const originalEnd = pos;
      const row = await previousLine(fh, pos, limits.scanBytes - scanned, limits.lineBytes, skip);
      scanned += row.scanned;
      if (row.skip && (entries.length || originalEnd !== (saved?.offset ?? head.end))) {
        // The remaining scan budget may be smaller than an ordinary line.
        // Defer that whole line to a fresh page instead of declaring it lost.
        next = { identity, head, offset: originalEnd, ...(itemBefore != null ? { itemBefore, lineHash: saved.lineHash } : {}) };
        break;
      }
      pos = row.next; skip = row.skip === true;
      next = pos > 0 ? { identity, head, offset: pos, ...(skip ? { skip: true } : {}) } : null;
      if (row.gap) { if (gaps.length < 4) gaps.push({ reason: row.gap }); itemBefore = null; continue; }
      if (!row.line?.length) { itemBefore = null; continue; }
      const lineHash = hash(row.line);
      if (itemBefore != null && saved.lineHash !== lineHash) fail("STALE_CURSOR");
      let ev;
      try { ev = JSON.parse(row.line.toString("utf8")); } catch { if (gaps.length < 4) gaps.push({ reason: "invalid_line" }); itemBefore = null; continue; }
      if (Array.isArray(ev.message?.content) && ev.message.content.length > 2048) {
        if (gaps.length < 4) gaps.push({ reason: "too_many_blocks" }); itemBefore = null; continue;
      }
      if (excludeFrom && ev.timestamp && Date.parse(ev.timestamp) >= excludeFrom) { itemBefore = null; continue; }
      const items = transcriptItems(ev);
      if (!Array.isArray(items)) fail("INVALID_ADAPTER");
      const endIndex = itemBefore == null ? items.length : itemBefore;
      if (!Number.isSafeInteger(endIndex) || endIndex < 0 || endIndex > items.length) fail("STALE_CURSOR");
      const startIndex = Math.max(0, endIndex - (limit - entries.length));
      const older = (index) => index > 0 ? { identity, head, offset: originalEnd, itemBefore: index, lineHash } : next;
      const selected = []; let withheld = false;
      for (let i = endIndex - 1; i >= startIndex; i--) {
        const cost = bytes(items[i]);
        if (cost > limits.scanBytes) {
          if (gaps.length < 4) gaps.push({ reason: "line_too_large" });
          continue;
        }
        if (retained + cost > limits.scanBytes) { next = older(i + 1); withheld = true; break; }
        selected.unshift({ item: items[i], key: { start: row.start, end: row.end, hash: lineHash, index: i, identity }, before: older(i), after: older(i + 1) });
        retained += cost;
      }
      entries.unshift(...selected);
      if (withheld) break;
      if (startIndex > 0) { next = older(startIndex); break; }
      itemBefore = null;
      if (scanned < limits.scanBytes && pos > 0) await tick();
    }
    if (pos > 0 && scanned >= limits.scanBytes && gaps.length < 4) gaps.push({ reason: "scan_limit" });
    return { entries, cursor: next, gaps, scannedBytes: scanned };
  } finally { await fh.close(); }
}

/** Explicitly bind already-loaded gateway functions; no dynamic import side effects. */
export function createSourceAdapter({ findSessionFile, peekSession, transcriptItems, runOfSession = () => null, onPublish, limits: options } = {}) {
  if (typeof findSessionFile !== "function" || typeof transcriptItems !== "function") fail("INVALID_ADAPTER");
  const limits = limitsOf(options);
  const found = (sid) => {
    if (!SID.test(sid || "")) fail("SESSION_NOT_FOUND");
    const file = findSessionFile(sid)?.file;
    if (typeof file !== "string") fail("SESSION_NOT_FOUND");
    return file;
  };
  return Object.freeze({
    describe(sid) {
      let file; try { file = found(sid); } catch { return null; }
      const meta = typeof peekSession === "function" ? peekSession(file) : {};
      return { title: typeof meta?.title === "string" ? meta.title : "" };
    },
    current: (sid) => runOfSession(sid),
    capture(sid) {
      const file = found(sid), st = fs.statSync(file);
      // Synchronous small anchor capture is the history/live barrier; no new run
      // can append between this stat/read and the caller recording its sequence.
      const n = Math.min(4096, st.size), b = Buffer.alloc(n), fd = fs.openSync(file, "r");
      try { if (fs.readSync(fd, b, 0, n, st.size - n) !== n) fail("STALE_CURSOR"); } finally { fs.closeSync(fd); }
      return { run: runOfSession(sid), before: { identity: fileIdentity(st), head: { end: st.size, hash: hash(b) }, offset: st.size } };
    },
    readHistory: (sid, options) => readBoundedSessionPage(found(sid), { ...options, transcriptItems, limits }),
    async readContent(sid, { key, field }) {
      if (!key || !Number.isSafeInteger(key.start) || !Number.isSafeInteger(key.end) || !Number.isSafeInteger(key.index) || key.index < 0 ||
          key.end - key.start > limits.lineBytes || key.start < 0 || key.end < key.start) fail("STALE_CONTENT");
      const fh = await fs.promises.open(found(sid), "r");
      try {
        const st = await fh.stat(); if (fileIdentity(st) !== key.identity || st.size < key.end) fail("STALE_CONTENT");
        const b = Buffer.alloc(key.end - key.start); const { bytesRead } = await fh.read(b, 0, b.length, key.start);
        if (bytesRead !== b.length || hash(b) !== key.hash) fail("STALE_CONTENT");
        const ev = JSON.parse(b.toString("utf8"));
        if (Array.isArray(ev.message?.content) && ev.message.content.length > 2048) fail("STALE_CONTENT");
        const items = transcriptItems(ev), value = ownString(items[key.index], field);
        if (value == null) fail("STALE_CONTENT");
        return value;
      } finally { await fh.close(); }
    },
    ...(typeof onPublish === "function" ? { subscribe: (listener) => onPublish(listener) } : {}),
  });
}
