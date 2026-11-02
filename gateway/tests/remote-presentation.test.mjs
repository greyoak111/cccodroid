import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { normaliseItems, normaliseHistory, normaliseLive, normaliseSnapshot, createSnapshotNotifier } from "../gw/remote/presentation.mjs";
import { createTabletData, createSourceAdapter } from "../gw/remote/tablet-data.mjs";
import { transcriptItems } from "../gw/transcript.mjs";
import { createFrame, assertCorrelation, validateFrame } from "../gw/remote/protocol.mjs";

const binding = { fromDeviceId: "host", toDeviceId: "phone", hostInstanceId: "host-instance", remoteSessionId: "remote-session", grantVersion: 1, runId: null };
const recordFields = new Set(["id", "kind", "role", "text", "toolName", "toolStatus", "toolInputText", "toolResultText", "source", "timestamp", "truncated"]);
const now = Date.now();
const snapshot = (changes = {}) => ({ streamId: "stream-1", seq: 3, title: "Display title", run: null, liveEvents: [], history: { items: [], cursor: null, hasMore: false, gaps: [] }, ...changes });
const payload = (value) => ({ ...value, grant: { state: "active", expiresAt: now + 60000 }, pending: [] });
const checkSnapshot = (value) => {
  const b = { ...binding, runId: value.run.runId };
  // View responses are correlated with a phone request, not standalone frames.
  const request = createFrame("session.subscribe", { ...b, fromDeviceId: "phone", toDeviceId: "host" }, {}, { now, messageId: "snapshot-request", correlationId: "snapshot-rpc" });
  const response = createFrame("session.snapshot", b, payload(value), { now, correlationId: request.correlationId });
  return assertCorrelation(response, request, { now });
};
const wait = () => new Promise((r) => setTimeout(r, 15));

test("fixed Record whitelist combines tool use/result without exporting source metadata", () => {
  const rows = normaliseItems([
    { role: "user", text: "hi", uuid: "source-uuid", source: "phone", timestamp: 20, localSessionId: "private-id", file: "/private/session" },
    { role: "tool_use", id: "t-1", name: "Bash", input: { command: "printf safe", env: { SECRET: "secret-env" }, private: "omit" } },
    { role: "tool_result", id: "t-1", ok: true, text: "safe output" },
    { role: "note", text: "summary", compact: true, cwd: "/private/cwd" },
    { role: "thinking", text: "private-thinking" },
  ], { scope: "remote-session" });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { id: rows[0].id, kind: "message", role: "user", text: "hi", source: "phone", timestamp: 20 });
  assert.deepEqual(rows[1], { id: rows[1].id, kind: "tool", toolName: "Bash", toolInputText: "command: printf safe", truncated: true, toolResultText: "safe output", toolStatus: "done" });
  assert.equal(rows[2].role, "system");
  rows.forEach((row) => Object.keys(row).forEach((key) => assert.ok(recordFields.has(key), key)));
  assert.doesNotMatch(JSON.stringify(rows), /private-id|\/private|source-uuid|secret-env|private-thinking|omit/);
  checkSnapshot(normaliseSnapshot(snapshot({ history: { items: [
    { role: "tool_use", id: "t-1", name: "Bash", input: { command: "echo safe" } },
    { role: "tool_result", id: "t-1", ok: true, text: "safe" },
  ], cursor: null, hasMore: false } })));
});

test("tool input whitelist is per-tool even when presentation is called without the data projection", () => {
  const values = normaliseItems([
    { role: "tool_use", id: "custom", name: "CustomTool", input: { command: "unknown-tool-secret", query: "unknown-query" } },
    { role: "tool_use", id: "bash", name: "Bash", input: { command: "safe", file_path: "cross-tool-secret", query: "cross-query", env: "env-secret" } },
    { role: "tool_use", id: "proto", name: "constructor", input: { command: "prototype-secret" } },
  ]);
  assert.equal(values[0].toolInputText, ""); assert.equal(values[1].toolInputText, "command: safe"); assert.equal(values[2].toolInputText, "");
  assert.doesNotMatch(JSON.stringify(values), /unknown-tool-secret|unknown-query|cross-tool-secret|cross-query|env-secret|prototype-secret/);
});

test("record identities are stable, scoped and distinguish repeated same-text messages", () => {
  const items = [{ role: "assistant", text: "same", uuid: "one" }, { role: "assistant", text: "same", uuid: "two" }, { role: "assistant", text: "same" }, { role: "assistant", text: "same" }];
  const a = normaliseItems(items, { scope: "a" }), b = normaliseItems(items, { scope: "a" }), c = normaliseItems(items, { scope: "b" });
  assert.deepEqual(a, b); assert.notEqual(a[0].id, c[0].id); assert.equal(new Set(a.map((row) => row.id)).size, 4);
  const blocks = normaliseItems([{ role: "assistant", uuid: "shared-message", text: "block a" }, { role: "assistant", uuid: "shared-message", text: "block b" }]);
  assert.notEqual(blocks[0].id, blocks[1].id);
  assert.notEqual(normaliseItems([{ role: "tool_use", id: "x", name: "Bash", input: {} }])[0].id,
    normaliseItems([{ role: "tool_use", id: "x", name: "Bash", input: {} }], { scope: "other" })[0].id);
});

test("history keeps the opaque continuation and never exposes detail refs or paths as APIs", () => {
  const page = normaliseHistory({ items: [{ role: "assistant", text: "partial", truncated: true, details: [{ contentRef: "private-ref", field: "text" }] }], cursor: "remote-cursor", hasMore: true, file: "/private/file" });
  assert.deepEqual(page, { items: [{ id: page.items[0].id, kind: "message", role: "assistant", text: "partial", truncated: true }], cursor: "remote-cursor", hasMore: true });
  const request = createFrame("history.get", { ...binding, fromDeviceId: "phone", toDeviceId: "host" }, { cursor: null, limit: 50 }, { now, messageId: "history-request", correlationId: "history-rpc" });
  const response = createFrame("history.page", binding, { streamId: "stream-1", seq: 0, items: page.items, cursor: null, nextCursor: page.cursor, hasMore: true }, { now, correlationId: request.correlationId });
  validateFrame(response, { now }); assertCorrelation(response, request, { now });
});

test("live deltas merge, partial discards roll back, tools retain one card, and thoughts/requests stay outside Records", () => {
  const result = normaliseLive([
    { type: "run_start", text: "question", runId: "run-1", sessionId: "local-private", cid: "local-cid" },
    { type: "delta", text: "discard", runId: "run-1" },
    { type: "discard_partial", text: 7, think: 50, runId: "run-1" },
    { type: "delta", text: "actual ", runId: "run-1" }, { type: "delta", text: "answer", runId: "run-1" },
    { type: "thinking_delta", text: "private-thought", runId: "run-1" },
    { type: "perm_request", id: "p", input: { command: "not-approval-details" }, runId: "run-1" },
    { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "/fake/text-path", secret: "never" }, runId: "run-1" },
    { type: "tool_result", id: "tool-1", ok: false, text: "failed", runId: "run-1" },
    { type: "delta", text: "other-session", runId: "another-run" },
  ], { scope: "remote", runId: "run-1" });
  assert.equal(result.length, 3); assert.equal(result[1].text, "actual answer");
  assert.equal(result[2].toolStatus, "error"); assert.equal(result[2].toolResultText, "failed");
  assert.doesNotMatch(JSON.stringify(result), /private-thought|not-approval-details|local-private|local-cid|other-session|never/);
});

test("partial rollback consumes omitted original characters without deleting committed text", () => {
  for (const chunk of ["x".repeat(1024), "多🙂".repeat(300)]) {
    const result = normaliseLive([
      { type: "assistant_text", text: "已提交回答" },
      { type: "tool_use", id: "before-retry", name: "Bash", input: {} },
      { type: "tool_result", id: "before-retry", ok: true, text: "done" },
      ...Array.from({ length: 10 }, () => ({ type: "delta", text: chunk })),
      { type: "discard_partial", text: chunk.length * 10 },
      { type: "delta", text: "重试后的回答" },
    ]);
    assert.deepEqual(result.filter((row) => row.kind === "message").map((row) => row.text), ["已提交回答", "重试后的回答"]);
    assert.equal(result.find((row) => row.kind === "tool").toolResultText, "done");
  }
});

test("commit boundaries protect streamed answers and subagent output is never system state", () => {
  const result = normaliseLive([
    { type: "delta", text: "已流式提交" }, { type: "text_commit" },
    { type: "delta", text: "partial" },
    { type: "sub_text", parent: "agent-tool", text: "任务已经停止" },
    { type: "discard_partial", text: 10000 }, { type: "delta", text: "retry" },
  ]);
  assert.deepEqual(result.map((row) => row.text), ["已流式提交", "[子代理输出]\n任务已经停止", "retry"]);
  assert.ok(result.every((row) => row.role === "assistant"));
  result.forEach((row) => Object.keys(row).forEach((key) => assert.ok(recordFields.has(key), key)));
});

test("source-clipped delta spans rollback by original characters without appending across a missing tail", async (t) => {
  const dir = fs.mkdtempSync(path.join(process.env.CCAPP_TMP, "rollback-preview-")), file = path.join(dir, "fake.jsonl");
  fs.writeFileSync(file, "");
  const makeRun = (log) => ({ id: "retry-run", sessionId: "selected", startedAt: Date.now(), perms: new Map(), log });
  let run = makeRun([{ type: "assistant_text", text: "committed" }, { type: "delta", text: "大🙂".repeat(2000) }, { type: "delta", text: "hidden tail" }]);
  const adapter = createSourceAdapter({ findSessionFile: () => ({ file }), transcriptItems, runOfSession: () => run });
  const data = createTabletData({ adapter, hostInstanceId: "rollback-preview" }); t.after(() => data.dispose());
  const context = await data.authorize({ localSessionId: "selected", deviceId: "phone", grantVersion: 1, expiresAt: Date.now() + 60000 });
  const partial = await data.snapshot(context), delta = partial.liveEvents.find((event) => event.type === "delta");
  assert.equal(delta.originalTextLength, "大🙂".repeat(2000).length); assert.equal(delta.truncated, true);
  const preview = normaliseLive(partial.liveEvents);
  assert.equal(preview.at(-1).text.includes("hidden tail"), false); assert.equal(preview.at(-1).truncated, true);
  run = makeRun([...run.log, { type: "discard_partial", text: "大🙂".repeat(2000).length + "hidden tail".length }, { type: "delta", text: "retry" }]);
  const result = normaliseSnapshot(await data.snapshot(context));
  assert.deepEqual(result.items.filter((row) => row.role === "assistant").map((row) => row.text), ["committed", "retry"]);
  assert.doesNotMatch(JSON.stringify(result), /originalTextLength|recordKey|hidden tail/); checkSnapshot(result);
});

test("identical sibling blocks keep distinct stable IDs across source pages and clipped prefixes", async (t) => {
  const dir = fs.mkdtempSync(path.join(process.env.CCAPP_TMP, "sibling-identity-")), file = path.join(dir, "fake.jsonl");
  for (const texts of [Array(51).fill("same block"), Array.from({ length: 51 }, (_, i) => "x".repeat(3000) + i)]) {
    fs.writeFileSync(file, JSON.stringify({ type: "assistant", uuid: "shared-source-uuid", message: {
      content: texts.map((text) => ({ type: "text", text })),
    } }) + "\n");
    const adapter = createSourceAdapter({ findSessionFile: () => ({ file }), transcriptItems });
    const data = createTabletData({ adapter, hostInstanceId: "sibling-identity" });
    try {
      const context = await data.authorize({ localSessionId: "selected", deviceId: "phone", grantVersion: 1, expiresAt: Date.now() + 60000 });
      const raw = await data.history(context), page = normaliseHistory(raw, { scope: context.remoteSessionId });
      const repeat = normaliseHistory(await data.history(context), { scope: context.remoteSessionId });
      assert.deepEqual(repeat.items.map((item) => item.id), page.items.map((item) => item.id));
      const all = [...page.items]; let cursor = page.cursor;
      for (let n = 0; cursor; n++) {
        assert.ok(n < 20);
        const older = normaliseHistory(await data.history(context, { cursor }), { scope: context.remoteSessionId });
        all.unshift(...older.items); cursor = older.cursor;
      }
      assert.equal(all.length, 51); assert.equal(new Set(all.map((item) => item.id)).size, 51);
      assert.equal(new Map([...all, ...page.items].map((item) => [item.id, item])).size, 51);
      assert.doesNotMatch(JSON.stringify(all), /recordKey|shared-source-uuid|fake\.jsonl|itemBefore|lineHash/);
      all.forEach((row) => Object.keys(row).forEach((key) => assert.ok(recordFields.has(key), key)));
    } finally { data.dispose(); }
  }
});

test("snapshot produces strict state payload for idle/running/waiting/background-ended without inventing stop", () => {
  const idle = normaliseSnapshot(snapshot()); assert.deepEqual(idle.run, { runId: null, state: "idle" }); checkSnapshot(idle);
  const running = normaliseSnapshot(snapshot({ run: { id: "run-1", idle: false, pendingRequests: [] } }));
  assert.deepEqual(running.run, { runId: "run-1", state: "running" }); checkSnapshot(running);
  const waiting = normaliseSnapshot(snapshot({ run: { id: "run-1", idle: false, pendingRequests: [{ id: "p", detailsComplete: false }] } }));
  assert.equal(waiting.run.state, "waiting"); checkSnapshot(waiting);
  const ended = normaliseSnapshot(snapshot({ run: { id: "run-1", idle: true, pendingRequests: [] } }));
  assert.equal(ended.run.state, "ended"); checkSnapshot(ended);
  assert.equal(Object.hasOwn(ended, "pending"), false); assert.equal(Object.hasOwn(ended, "grant"), false); assert.equal(Object.hasOwn(ended, "binding"), false);
});

test("UTF-8, NUL and over-limit input are bounded or fail closed, never malformed Records", () => {
  const rows = normaliseItems([{ role: "assistant", text: "字".repeat(10000) + "\0" }, { role: "tool_use", id: "x", name: "Bash", input: { command: "x".repeat(200000) } }]);
  assert.ok(Buffer.byteLength(rows[0].text) <= 8192); assert.equal(rows[0].truncated, true); assert.ok(!rows[0].text.includes("�"));
  assert.ok(rows[1].toolInputText.length < 1100);
  const withNul = normaliseItems([{ role: "user", text: "a\0b" }])[0]; assert.equal(withNul.text, "a�b"); assert.equal(withNul.truncated, true);
  assert.throws(() => normaliseItems(Array.from({ length: 51 }, () => ({ role: "user", text: "x" }))), (e) => e.code === "LIMIT_EXCEEDED");
});

test("actual tablet snapshot stays within 50 combined Records with a resumable older-history cursor", async (t) => {
  const dir = fs.mkdtempSync(path.join(process.env.CCAPP_TMP, "presentation-")), file = path.join(dir, "fake.jsonl");
  const rows = Array.from({ length: 70 }, (_, i) => ({ type: "user", uuid: `u-${i}`, timestamp: new Date(i + 1).toISOString(), message: { content: `history ${i}` } }));
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const run = { id: "fixture-run", sessionId: "selected", startedAt: Date.now(), log: [
    { type: "run_start", runId: "fixture-run", sessionId: "selected", text: "new user" },
    ...Array.from({ length: 15 }, (_, i) => ({ type: "assistant_text", runId: "fixture-run", text: `live ${i}` })),
  ], perms: new Map() };
  const adapter = createSourceAdapter({ findSessionFile: (sid) => sid === "selected" ? { file } : null, transcriptItems, runOfSession: () => run });
  const data = createTabletData({ adapter, hostInstanceId: "presentation-fixture" }); t.after(() => data.dispose());
  const context = await data.authorize({ localSessionId: "selected", deviceId: "phone", grantVersion: 1, expiresAt: Date.now() + 60000 });
  const source = await data.snapshot(context), result = normaliseSnapshot(source, { scope: context.remoteSessionId });
  assert.ok(result.items.length <= 50); assert.equal(result.historyHasMore, true); assert.equal(result.items.at(-1).text, "live 14");
  checkSnapshot(result);
  const page = normaliseHistory(await data.history(context, { cursor: result.historyCursor }), { scope: context.remoteSessionId });
  const historical = [...page.items, ...result.items.filter((record) => record.text.startsWith("history "))];
  assert.equal(new Set(historical.map((record) => record.id)).size, historical.length);
  assert.deepEqual(historical.map((record) => record.text), Array.from({ length: 70 }, (_, i) => `history ${i}`));
});

test("source gaps become one fixed bounded Record with no source reason or path", () => {
  const reasons = ["line_too_large", "invalid_line", "scan_limit", "too_many_blocks"];
  let fixedText;
  for (const reason of reasons) {
    const page = normaliseHistory({ items: [{ role: "user", text: "retained" }], cursor: "older", hasMore: true,
      gaps: [{ reason, file: "/private/transcript.jsonl", detail: "parser-secret" }] });
    assert.equal(page.items.length, 2); assert.equal(page.items[0].role, "system");
    assert.equal(page.items[0].truncated, true); assert.ok(Buffer.byteLength(page.items[0].text) < 256);
    fixedText ||= page.items[0].text;
    assert.equal(page.items[0].text, fixedText); assert.equal(page.cursor, "older");
    assert.doesNotMatch(JSON.stringify(page), /line_too_large|invalid_line|scan_limit|too_many_blocks|private|parser-secret/);
    const value = normaliseSnapshot(snapshot({ history: { items: [{ role: "user", text: "retained" }], cursor: null, hasMore: false, gaps: [{ reason }] }, liveGap: true }));
    assert.equal(value.items.length, 2, "history and live gaps share one notice");
    assert.equal(value.items[0].text, fixedText); assert.equal(value.historyHasMore, false);
    assert.equal(Object.hasOwn(value, "pending"), false); checkSnapshot(value);
  }
});

test("fifty-Record gap pages reserve a notice at source and never trim continuation-bearing Records", async (t) => {
  const dir = fs.mkdtempSync(path.join(process.env.CCAPP_TMP, "gap-presentation-")), file = path.join(dir, "fake.jsonl");
  const rows = Array.from({ length: 50 }, (_, i) => JSON.stringify({ type: "user", uuid: `gap-${i}`, message: { content: `history ${i}` } }));
  fs.writeFileSync(file, rows.join("\n") + "\ninvalid-line\n");
  const adapter = createSourceAdapter({ findSessionFile: (sid) => sid === "selected" ? { file } : null, transcriptItems });
  const data = createTabletData({ adapter, hostInstanceId: "gap-presentation" }); t.after(() => data.dispose());
  const context = await data.authorize({ localSessionId: "selected", deviceId: "phone", grantVersion: 1, expiresAt: Date.now() + 60000 });
  const raw = await data.history(context), first = normaliseHistory(raw, { scope: context.remoteSessionId });
  assert.equal(first.items.length, 50); assert.equal(first.items[0].role, "system");
  assert.equal(first.hasMore, true);
  const older = normaliseHistory(await data.history(context, { cursor: first.cursor }), { scope: context.remoteSessionId });
  assert.deepEqual([...older.items, ...first.items].filter((record) => record.role === "user").map((record) => record.text),
    Array.from({ length: 50 }, (_, i) => `history ${i}`));
  assert.throws(() => normaliseHistory({ items: Array.from({ length: 50 }, () => ({ role: "user", text: "x" })),
    cursor: null, hasMore: false, gaps: [{ reason: "invalid_line" }] }), (error) => error.code === "LIMIT_EXCEEDED",
    "a caller that did not reserve space fails rather than silently deleting history");
});

test("a long live window gets one fixed gap Record within the combined item cap", async (t) => {
  const dir = fs.mkdtempSync(path.join(process.env.CCAPP_TMP, "live-gap-")), file = path.join(dir, "fake.jsonl");
  fs.writeFileSync(file, "");
  const run = { id: "long-run", sessionId: "selected", startedAt: Date.now(), perms: new Map(), log: Array.from({ length: 60 }, (_, i) =>
    ({ type: "assistant_text", runId: "long-run", text: `line ${i}` })) };
  const adapter = createSourceAdapter({ findSessionFile: (sid) => sid === "selected" ? { file } : null, transcriptItems, runOfSession: () => run });
  const data = createTabletData({ adapter, hostInstanceId: "live-gap" }); t.after(() => data.dispose());
  const context = await data.authorize({ localSessionId: "selected", deviceId: "phone", grantVersion: 1, expiresAt: Date.now() + 60000 });
  const source = await data.snapshot(context), result = normaliseSnapshot(source);
  assert.equal(source.liveGap, true); assert.equal(result.items.length, 50);
  assert.equal(result.items[0].role, "system"); assert.equal(result.items.at(-1).text, "line 59");
  checkSnapshot(result);
});

test("snapshot notifier coalesces batches to one tiny invalidation and supports strict wrapping", async () => {
  const sent = [], notifier = createSnapshotNotifier({ send: (notice) => { sent.push(notice); }, delayMs: 5 });
  for (let i = 1; i <= 1000; i++) notifier.push({ streamId: "s", to: i, events: [{ text: "must-never-forward" }] });
  await notifier.flush(); assert.deepEqual(sent, [{ type: "snapshot.required", streamId: "s", seq: 1000 }]);
  assert.ok(Buffer.byteLength(JSON.stringify(sent)) < 100);
  const seq = 1; // Wire notices have their own contiguous counter, not raw deltas.
  validateFrame(createFrame("event.batch", binding, { streamId: "s", fromSeq: seq, toSeq: seq, events: [{ seq, type: "snapshot.required", payload: {} }] }, { now }), { now });
  notifier.dispose();
});

test("notifier keeps at most one in-flight send plus one latest marker and clears after disposal", async () => {
  const sent = []; let release;
  const notifier = createSnapshotNotifier({ send: (notice) => { sent.push(notice); return sent.length === 1 ? new Promise((r) => { release = r; }) : true; }, delayMs: 5 });
  notifier.push({ streamId: "s", seq: 1 }); const pending = notifier.flush(); await Promise.resolve();
  for (let i = 2; i <= 500; i++) notifier.push({ streamId: "s", seq: i });
  await wait(); assert.equal(sent.length, 1);
  release(true); await pending; await notifier.flush(); assert.equal(sent.length, 2); assert.equal(sent[1].seq, 500);
  notifier.push({ streamId: "s2", seq: 0 }); notifier.dispose();
  assert.equal(notifier.push({ streamId: "s3", seq: 100 }), false); await wait(); assert.equal(sent.length, 2);
});

test("notifier offline rejection retains only latest state and does not run an automatic retry loop", async () => {
  let calls = 0, online = false;
  const notifier = createSnapshotNotifier({ send: () => { calls++; return online; }, delayMs: 5 });
  notifier.push({ streamId: "s", seq: 1 }); assert.equal(await notifier.flush(), false);
  await wait(); assert.equal(calls, 1);
  notifier.push({ streamId: "s", seq: 50 }); online = true; assert.equal(await notifier.flush(), true);
  assert.equal(calls, 2); notifier.dispose();
});
