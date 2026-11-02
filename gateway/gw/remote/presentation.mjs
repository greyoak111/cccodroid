// A display-only bridge between the selected tablet data plane and protocol v1.
// No gateway imports, authority, files, approval detail construction or control.
import { createHash } from "node:crypto";

export const PRESENTATION_LIMITS = Object.freeze({ items: 50, textBytes: 8192, bytes: 60 * 1024, noticeMs: 150 });
const own = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const safeId = (v) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
const size = (v) => Buffer.byteLength(JSON.stringify(v));
const error = (code) => { const e = new Error(code); e.code = code; throw e; };
function cut(value, limit) {
  if (typeof value !== "string") return "";
  // NUL is not accepted by the public schema. Replacing it preserves a visible
  // indication without accidentally carrying a binary string to a remote view.
  let prefix = value.slice(0, limit).replaceAll("\0", "�");
  if (/[\uD800-\uDBFF]/.test(prefix.slice(-1))) prefix = prefix.slice(0, -1);
  const b = Buffer.from(prefix); let end = Math.min(b.length, limit);
  while (end > 0 && (b[end] & 0xc0) === 0x80) end--;
  return b.toString("utf8", 0, end);
}
function digest(...parts) {
  const h = createHash("sha256");
  for (const part of parts) h.update(String(part)).update("\0");
  return h.digest("hex").slice(0, 32);
}
const toolId = (scope, id) => "t-" + digest(scope, id);
const msgId = (scope, role, uuid, value, occurrence) => "m-" + digest(scope, role, uuid || "", value, occurrence);
const INPUT_FIELDS = Object.freeze({
  Bash: ["command", "description", "timeout"], Read: ["file_path", "offset", "limit", "pages"],
  Write: ["file_path", "content"], Edit: ["file_path", "old_string", "new_string", "replace_all"],
  Glob: ["pattern", "path"], Grep: ["pattern", "path", "glob", "output_mode"],
  Agent: ["description", "prompt", "subagent_type"], Task: ["description", "prompt", "subagent_type"],
  WebFetch: ["url", "prompt"], WebSearch: ["query"],
});
function inputText(value, name) {
  if (!own(value) || !Object.hasOwn(INPUT_FIELDS, name)) return "";
  const parts = [];
  // Defense in depth if a caller bypasses the data projection: even a known
  // field from a different tool is not permission to forward arbitrary input.
  for (const key of INPUT_FIELDS[name]) {
    const v = value[key];
    if (!["string", "boolean", "number"].includes(typeof v) || typeof v === "number" && !Number.isFinite(v)) continue;
    parts.push(key + ": " + cut(String(v), 1024));
  }
  return cut(parts.join("\n"), 4096);
}
function putText(record, key, value, maximum = PRESENTATION_LIMITS.textBytes) {
  if (typeof value !== "string") return;
  const output = cut(value, maximum); record[key] = output;
  if (output !== value) record.truncated = true;
}
function metadata(record, item) {
  // Source is provenance only if supplied by the trusted local ingress; it is
  // never inferred from an untrusted message's words or a filename.
  if (item.source === "phone" || item.source === "host") record.source = item.source;
  else if (item.source === "local") record.source = "host";
  if (Number.isSafeInteger(item.timestamp) && item.timestamp >= 0) record.timestamp = item.timestamp;
  if (item.truncated === true || item.previewOnly === true || item.inputOmitted === true) record.truncated = true;
  return record;
}
function checkedItems(items) {
  if (!Array.isArray(items) || items.length > PRESENTATION_LIMITS.items) error("LIMIT_EXCEEDED");
}
function bounded(records) {
  if (records.length > PRESENTATION_LIMITS.items || size(records) > PRESENTATION_LIMITS.bytes) error("LIMIT_EXCEEDED");
  return records;
}

/** Input is tablet-data's already-projected history items, not raw transcripts. */
export function normaliseItems(items, { scope = "remote" } = {}) {
  checkedItems(items);
  const records = [], tools = new Map(), occurrences = new Map();
  for (const item of items) {
    if (!own(item)) continue;
    if (["user", "assistant", "note"].includes(item.role)) {
      const role = item.role === "note" ? "system" : item.role;
      const value = cut(item.text, PRESENTATION_LIMITS.textBytes);
      const identity = digest(role, item.uuid || "", value), occurrence = occurrences.get(identity) || 0;
      occurrences.set(identity, occurrence + 1);
      const id = typeof item.recordKey === "string" && /^[a-f0-9]{64}$/.test(item.recordKey)
        ? "m-" + digest(scope, role, item.recordKey) : msgId(scope, role, item.uuid, value, occurrence);
      const record = { id, kind: "message", role };
      putText(record, "text", item.text); records.push(metadata(record, item));
    } else if (item.role === "tool_use" || item.role === "tool_result") {
      if (typeof item.id !== "string" || !item.id) continue;
      const id = toolId(scope, item.id);
      let record = tools.get(id);
      if (!record) { record = { id, kind: "tool" }; tools.set(id, record); records.push(record); }
      if (item.role === "tool_use") {
        if (typeof item.name === "string" && item.name.trim()) putText(record, "toolName", item.name, 128);
        record.toolInputText = inputText(item.input, item.name);
        // A historical tool_use without its result may be at a page boundary;
        // absence of a result is not evidence that it is still executing.
        // No status field: strict v1 has no 'unknown' enum, and guessing
        // 'running' or 'done' here would turn a page boundary into a false fact.
        record.truncated = true;
      } else {
        putText(record, "toolResultText", item.text);
        record.toolStatus = item.ok === true ? "done" : "error";
      }
      metadata(record, item);
    }
  }
  return bounded(records);
}

/** Reconstruct only a bounded display slice of the current original run. */
export function normaliseLive(events, { scope = "remote", runId = null } = {}) {
  checkedItems(events);
  const rows = [], tools = new Map(), partials = []; let assistant = null, segment = 0;
  const liveScope = scope + ":live:" + (typeof runId === "string" ? runId : "none");
  function message(role, value, ev, fixed = null) {
    const row = { id: fixed || "l-" + digest(liveScope, role, segment++), kind: "message", role };
    putText(row, "text", value); metadata(row, ev); rows.push(row); return row;
  }
  function appendDelta(ev) {
    if (!assistant) { assistant = message("assistant", "", ev); partials.push({ row: assistant, length: 0 }); }
    const partial = partials.at(-1), value = typeof ev.text === "string" ? ev.text : "";
    const length = Number.isSafeInteger(ev.originalTextLength) && ev.originalTextLength >= value.length ? ev.originalTextLength : value.length;
    // Once a source preview omitted a tail, later deltas cannot close that gap.
    // Keep a visible prefix plus the original character span, never the raw tail.
    if (partial.length === assistant.text.length) putText(assistant, "text", assistant.text + cut(value, PRESENTATION_LIMITS.textBytes));
    partial.length = Math.min(Number.MAX_SAFE_INTEGER, partial.length + length);
    if (partial.length !== assistant.text.length || ev.truncated === true) assistant.truncated = true;
  }
  for (const ev of events) {
    if (!own(ev) || runId != null && ev.runId != null && ev.runId !== runId) continue;
    switch (ev.type) {
      case "run_start":
        assistant = null; partials.length = 0;
        message("user", ev.text, ev, "l-" + digest(liveScope, "start"));
        break;
      case "inject": assistant = null; partials.length = 0; message("user", ev.text, ev); break;
      case "delta": appendDelta(ev); break;
      case "text_commit": assistant = null; partials.length = 0; break;
      case "assistant_text": assistant = null; partials.length = 0; message("assistant", ev.text, ev); break;
      case "sub_text":
        assistant = null; message("assistant", "[子代理输出]\n" + (typeof ev.text === "string" ? ev.text : ""), ev); break;
      case "discard_partial": {
        let remaining = Number.isSafeInteger(ev.text) && ev.text > 0 ? ev.text : 0;
        for (let i = partials.length - 1; i >= 0 && remaining > 0; i--) {
          const partial = partials[i], remove = Math.min(remaining, partial.length);
          partial.length -= remove; remaining -= remove;
          partial.row.text = partial.row.text.slice(0, partial.length);
          if (/[\uD800-\uDBFF]/.test(partial.row.text.slice(-1))) partial.row.text = partial.row.text.slice(0, -1);
          if (!partial.length) { const index = rows.indexOf(partial.row); if (index >= 0) rows.splice(index, 1); partials.splice(i, 1); }
        }
        assistant = null; break;
      }
      case "tool_use": case "tool_result": {
        assistant = null;
        if (ev.type === "tool_use" && !ev.parent) partials.length = 0;
        if (typeof ev.id !== "string" || !ev.id) break;
        const id = toolId(scope, ev.id); let record = tools.get(id);
        if (!record) { record = { id, kind: "tool" }; tools.set(id, record); rows.push(record); }
        if (ev.type === "tool_use") {
          if (typeof ev.name === "string" && ev.name.trim()) putText(record, "toolName", ev.name, 128);
          record.toolInputText = inputText(ev.input, ev.name);
          record.toolStatus ??= "running"; record.truncated = true;
        } else { putText(record, "toolResultText", ev.text); record.toolStatus = ev.ok === true ? "done" : "error"; }
        metadata(record, ev); break;
      }
      case "note": message("system", ev.text, ev); assistant = null; break;
      case "error": message("system", ev.message, ev); assistant = null; break;
      default: break; // No thinking, raw state, request content, model or paths.
    }
  }
  return bounded(rows);
}

const hasSourceGap = (page) => Array.isArray(page?.gaps) && page.gaps.length > 0;
function gapRecord(scope, identity) {
  // Fixed text only: source reasons, transcript paths and parser errors are not
  // display data. This says nothing about the separate control approval scope.
  return { id: "g-" + digest(scope, "source-gap", identity), kind: "message", role: "system",
    text: "部分历史或本轮较早内容未传输，请在平板查看完整会话。", truncated: true };
}
function historyPage(page, scope, notice) {
  if (!own(page)) error("INVALID_SCHEMA");
  const items = normaliseItems(page.items, { scope });
  const cursor = page.cursor == null ? null : safeId(page.cursor) ? page.cursor : error("INVALID_SCHEMA");
  if (notice && hasSourceGap(page)) items.unshift(gapRecord(scope, "history:" + (cursor || "end")));
  return { items: bounded(items), cursor, hasMore: cursor !== null && page.hasMore === true };
}
export function normaliseHistory(page, { scope = "remote" } = {}) {
  return historyPage(page, scope, true);
}

/** The runtime alone adds current binding, grant and 05's verified pending[]. */
export function normaliseSnapshot(snapshot, { scope = "remote" } = {}) {
  if (!own(snapshot) || !safeId(snapshot.streamId) || !Number.isSafeInteger(snapshot.seq) || snapshot.seq < 0) error("INVALID_SCHEMA");
  const history = historyPage(snapshot.history, scope, false);
  const live = normaliseLive(snapshot.liveEvents || [], { scope, runId: snapshot.run?.id ?? null });
  const items = history.items.map((record) => ({ ...record })), toolIndexes = new Map();
  items.forEach((record, i) => { if (record.kind === "tool") toolIndexes.set(record.id, i); });
  for (const record of live) {
    if (record.kind === "tool" && toolIndexes.has(record.id)) {
      const index = toolIndexes.get(record.id); items[index] = { ...items[index], ...record };
    } else { if (record.kind === "tool") toolIndexes.set(record.id, items.length); items.push(record); }
  }
  if (snapshot.liveGap === true || hasSourceGap(snapshot.history)) items.unshift(gapRecord(scope, "snapshot:" + snapshot.streamId));
  bounded(items);
  const runId = snapshot.run == null ? null : safeId(snapshot.run.id) ? snapshot.run.id : error("INVALID_SCHEMA");
  const pending = Array.isArray(snapshot.run?.pendingRequests) && snapshot.run.pendingRequests.length > 0;
  const run = { runId, state: runId === null ? "idle" : pending ? "waiting" : snapshot.run.idle === true ? "ended" : "running" };
  const result = { streamId: snapshot.streamId, seq: snapshot.seq, title: cut(snapshot.title, 512), run, items,
    historyCursor: history.cursor, historyHasMore: history.hasMore };
  if (size(result) > PRESENTATION_LIMITS.bytes) error("LIMIT_EXCEEDED");
  return result;
}

/** Coalesce stream invalidations, not transcript data. A returned false or
 * rejected send retains only the latest marker and waits for explicit flush
 * or a later push; it never creates an unbounded retry loop while offline. */
export function createSnapshotNotifier({ send, delayMs = PRESENTATION_LIMITS.noticeMs } = {}) {
  if (typeof send !== "function" || !Number.isSafeInteger(delayMs) || delayMs < 1 || delayMs > 1000) error("INVALID_SCHEMA");
  let pending = null, timer = null, inFlight = null, disposed = false, epoch = 0;
  function schedule() {
    if (!disposed && pending && !timer && !inFlight) {
      timer = setTimeout(() => { timer = null; void flush(); }, delayMs); timer.unref?.();
    }
  }
  async function flush() {
    if (disposed) return false;
    if (inFlight) return inFlight;
    if (!pending) return true;
    if (timer) { clearTimeout(timer); timer = null; }
    const notice = pending, capturedEpoch = epoch; pending = null;
    const operation = Promise.resolve().then(() => disposed ? false : send(notice)).then((accepted) => {
      if (accepted === false && !disposed && epoch === capturedEpoch && !pending) pending = notice;
      return accepted !== false;
    }).catch(() => {
      if (!disposed && epoch === capturedEpoch && !pending) pending = notice;
      return false;
    });
    inFlight = operation;
    const accepted = await operation; inFlight = null;
    if (accepted) schedule();
    return accepted;
  }
  function push(batch) {
    if (disposed) return false;
    if (!own(batch) || !safeId(batch.streamId)) error("INVALID_SCHEMA");
    const seq = batch.to ?? batch.seq;
    if (!Number.isSafeInteger(seq) || seq < 0) error("INVALID_SCHEMA");
    if (!pending || pending.streamId !== batch.streamId) { epoch++; pending = { type: "snapshot.required", streamId: batch.streamId, seq }; }
    else pending.seq = Math.max(pending.seq, seq);
    schedule(); return true;
  }
  return Object.freeze({ push, flush, dispose() { disposed = true; pending = null; clearTimeout(timer); timer = null; } });
}
