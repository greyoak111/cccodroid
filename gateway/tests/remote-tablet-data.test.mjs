// Run only through scripts/test.mjs: every real source import stays in fake HOME.
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createTabletData, createSourceAdapter, readBoundedSessionPage, TABLET_DATA_LIMITS } from "../gw/remote/tablet-data.mjs";
import { normaliseLive, normaliseHistory, normaliseSnapshot } from "../gw/remote/presentation.mjs";
import { transcriptItems } from "../gw/transcript.mjs";
import { findSessionFile, peekSession } from "../gw/sessions.mjs";
import { RUNS, runOfSession } from "../gw/runs.mjs";
import { onPublish, publish } from "../gw/bus.mjs";

const wireBytes = (v) => Buffer.byteLength(JSON.stringify(v));
const wait = (n = 25) => new Promise((resolve) => setTimeout(resolve, n));
async function eventually(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await wait(5); }
  assert.fail("synthetic data projection did not settle");
}
const assertCode = async (promise, code) => assert.rejects(promise, (e) => e.code === code);
let n = 0;
function fixture({ count = 20, aText = (i) => `answer ${i}` } = {}) {
  const sid = `remote-data-${++n}`, dir = path.join(process.env.HOME, ".claude", "projects", "-fake-remote-data");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, sid + ".jsonl"), rows = [];
  for (let i = 0; i < count; i++) {
    rows.push({ type: "user", uuid: `u-${i}`, timestamp: new Date(1000 + i * 2000).toISOString(), message: { content: `question ${i}` }, sessionId: sid });
    rows.push({ type: "assistant", uuid: `a-${i}`, timestamp: new Date(2000 + i * 2000).toISOString(), message: { content: [{ type: "text", text: aText(i) }] }, sessionId: sid });
  }
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return { sid, file, rows };
}
function harness(f = fixture(), options = {}) {
  const listeners = new Set(), runs = new Map();
  const stats = { subscribes: 0, unsubscribes: 0, descriptions: [] };
  const adapter = createSourceAdapter({
    findSessionFile: (sid) => sid === f.sid ? { file: f.file } : null,
    peekSession: () => ({ title: "fake hosted session", cwd: "/private/project", secret: "never" }),
    transcriptItems, runOfSession: (sid) => runs.get(sid),
    onPublish: (fn) => { stats.subscribes++; listeners.add(fn); return () => { stats.unsubscribes++; listeners.delete(fn); }; },
  });
  const data = createTabletData({ adapter, hostInstanceId: "host-test", ...options });
  return { ...f, data, adapter, runs, stats, listeners, emit: (ev) => { for (const fn of listeners) fn(ev); },
    async grant(extra = {}) {
      return data.authorize({ localSessionId: f.sid, deviceId: "phone-a", grantVersion: 1, expiresAt: Date.now() + 60000, ...extra });
    } };
}

test("module import has no gateway/environment startup side effects", () => {
  const source = new URL("../gw/remote/tablet-data.mjs", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `const fs = await import('node:fs'); const before = fs.readdirSync(process.env.HOME); await import(${JSON.stringify(source)}); if (JSON.stringify(before) !== JSON.stringify(fs.readdirSync(process.env.HOME))) process.exit(2);`],
    { env: { ...process.env, HOME: process.env.HOME, CCAPP_TEST: "1" }, encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  const code = fs.readFileSync(new URL("../gw/remote/tablet-data.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(code, /from ["']\.\.\//);
});

test("explicit authorization maps only one local session, rejects wrong host/device/grant and local-id traversal", async (t) => {
  const h = harness(); t.after(() => h.data.dispose());
  const c = await h.grant();
  assert.notEqual(c.remoteSessionId, h.sid);
  assert.equal(h.stats.subscribes, 0);
  const p = await h.data.history(c, { limit: 5 });
  assert.equal(p.items.length, 5);
  assert.equal(p.type, "history.page");
  const wire = JSON.stringify(p);
  assert.ok(!wire.includes(h.sid)); assert.ok(!wire.includes(h.file)); assert.ok(!wire.includes("/private/project"));
  await assertCode(h.data.history({ ...c, deviceId: "other-phone" }), "SESSION_NOT_AUTHORIZED");
  await assertCode(h.data.history({ ...c, hostInstanceId: "old-host" }), "STALE_HOST");
  await assertCode(h.data.history({ ...c, grantVersion: 2 }), "STALE_GRANT");
  await assertCode(h.data.history({ ...c, remoteSessionId: h.sid }), "SESSION_NOT_AUTHORIZED");
  await assertCode(h.data.authorize({ localSessionId: "../secret", deviceId: "phone", grantVersion: 1, expiresAt: Date.now() + 1000 }), "INVALID_GRANT");
  await assertCode(h.grant({ localSessionId: "not-hosted" }), "SESSION_NOT_FOUND");
  await assertCode(h.data.history(c, { cursor: "/etc/passwd" }), "INVALID_CURSOR");
  assert.equal(h.data.revoke(c.remoteSessionId), true);
  await assertCode(h.data.history(c), "SESSION_NOT_AUTHORIZED");
});

test("bounded pagination preserves every sibling and item despite byte/item bounds", async (t) => {
  const f = fixture({ count: 31, aText: (i) => `answer ${i} ` + "长".repeat(3500) });
  // A line with several display blocks exercises private itemBefore cursors.
  const last = { type: "assistant", uuid: "multi", message: { content: Array.from({ length: 8 }, (_, i) => ({ type: "text", text: `block ${i}` })) } };
  fs.appendFileSync(f.file, JSON.stringify(last) + "\n");
  const h = harness(f, { limits: { pageBytes: 9000 } }); t.after(() => h.data.dispose());
  const c = await h.grant(), seen = [];
  let cursor = null, pages = 0;
  do {
    const page = await h.data.history(c, { cursor, limit: 7 });
    assert.ok(page.items.length <= 7); assert.ok(wireBytes(page) <= 9000);
    seen.unshift(...page.items.map((i) => i.text.split(" ").slice(0, 2).join(" ")));
    cursor = page.cursor; pages++; assert.ok(pages < 100);
  } while (cursor);
  const want = [...Array.from({ length: 31 }, (_, i) => [`question ${i}`, `answer ${i}`]).flat(), ...Array.from({ length: 8 }, (_, i) => `block ${i}`)];
  assert.deepEqual(seen, want);
  assert.ok(pages > 10);
});

test("history is an exact display whitelist; tool/env/thinking/attachment metadata is never blindly copied", async (t) => {
  const f = fixture({ count: 0 });
  const rows = [
    { type: "user", message: { content: "hello" }, env: { TOKEN: "private-token" }, cwd: "/workspace" },
    { type: "assistant", message: { content: [
      { type: "thinking", thinking: "private-reasoning" },
      { type: "tool_use", id: "bash-one", name: "Bash", input: { command: "printf safe", env: { TOKEN: "private-token" }, private: "omit-me" } },
      { type: "tool_use", id: "unknown", name: "CustomTool", input: { secret: "custom-secret" } },
      { type: "text", text: "display text" },
    ] } },
    { type: "attachment", attachment: { secret: "attachment-secret" } },
    { type: "user", isSidechain: true, message: { content: "sidechain-secret" } },
  ];
  fs.writeFileSync(f.file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const h = harness(f); t.after(() => h.data.dispose()); const c = await h.grant();
  const p = await h.data.history(c);
  assert.deepEqual(p.items.map((i) => i.role), ["user", "tool_use", "tool_use", "assistant"]);
  assert.deepEqual(p.items[1].input, { command: "printf safe" });
  assert.equal(p.items[1].previewOnly, true); assert.equal(p.items[2].inputOmitted, true);
  assert.doesNotMatch(JSON.stringify(p), /private-token|private-reasoning|omit-me|custom-secret|attachment-secret|sidechain-secret|\/workspace/);
});

test("oversized display content is UTF-8 chunked on demand using scoped refs, never arbitrary files", async (t) => {
  const value = "多字节-".repeat(5000), h = harness(fixture({ count: 1, aText: () => value }));
  t.after(() => h.data.dispose()); const c = await h.grant();
  const p = await h.data.history(c), a = p.items.find((i) => i.role === "assistant");
  assert.equal(a.truncated, true); assert.equal(a.detailsAvailable, true);
  const ref = a.details[0].contentRef; let offset = 0, rebuilt = "";
  do {
    const part = await h.data.content(c, { contentRef: ref, offset, limit: 257 });
    assert.ok(part.next > offset); assert.ok(wireBytes(part) < 2048); assert.ok(!part.text.includes("�"));
    rebuilt += part.text; offset = part.next;
    if (part.done) break;
  } while (offset < Buffer.byteLength(value));
  assert.equal(rebuilt, value);
  await assertCode(h.data.content(c, { contentRef: h.file }), "INVALID_CONTENT_REF");
  await assertCode(h.data.content({ ...c, deviceId: "phone-b" }, { contentRef: ref }), "SESSION_NOT_AUTHORIZED");
  fs.appendFileSync(h.file, "\n");
  assert.equal((await h.data.content(c, { contentRef: ref, limit: 4 })).text, "多");
  fs.writeFileSync(h.file, "changed source\n");
  await assertCode(h.data.content(c, { contentRef: ref }), "STALE_CONTENT");
});

test("bounded reader reports huge-line gaps and advances without unbounded scan or losing older rows", async () => {
  const f = fixture({ count: 1 });
  fs.appendFileSync(f.file, JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "x".repeat(150000) }] } }) + "\n");
  const limits = { lineBytes: 8192, scanBytes: 16384 };
  let before = null, scans = 0, gaps = 0; const seen = [];
  do {
    const p = await readBoundedSessionPage(f.file, { before, transcriptItems, limit: 5, limits });
    assert.ok(p.scannedBytes <= limits.scanBytes); gaps += p.gaps.length; seen.unshift(...p.entries.map((e) => e.item.text));
    assert.notDeepEqual(p.cursor, before); before = p.cursor; scans++; assert.ok(scans < 20);
  } while (before);
  assert.ok(gaps > 0); assert.ok(scans > 1); assert.deepEqual(seen, ["question 0", "answer 0"]);
});

test("source cursors allow append, detect replacement/truncation, and expire on the grant", async (t) => {
  let now = Date.now();
  const h = harness(fixture({ count: 5 }), { now: () => now, limits: { tokenTtlMs: 100 } }); t.after(() => h.data.dispose());
  const c = await h.grant(); const p = await h.data.history(c, { limit: 2 });
  fs.appendFileSync(h.file, JSON.stringify({ type: "user", message: { content: "later append" } }) + "\n");
  assert.equal((await h.data.history(c, { cursor: p.cursor, limit: 2 })).items.length, 2);
  now += 101;
  await assertCode(h.data.history(c, { cursor: p.cursor }), "INVALID_CURSOR");
  const p2 = await h.data.history(c, { limit: 2 });
  fs.writeFileSync(h.file, "short\n");
  await assertCode(h.data.history(c, { cursor: p2.cursor }), "STALE_CURSOR");
});

test("ordinary snapshots cannot evict the explicit history frontier before its original TTL", async (t) => {
  let now = Date.now();
  const h = harness(fixture({ count: 8 }), { now: () => now, limits: { cursors: 3, tokenTtlMs: 100 } });
  t.after(() => h.data.dispose()); const c = await h.grant();
  const first = await h.data.history(c, { limit: 2 });
  assert.ok(first.cursor);
  const snapshotTokens = [];
  for (let i = 0; i < 70; i++) snapshotTokens.push((await h.data.snapshot(c, { limit: 2 })).history.cursor);
  await assertCode(h.data.history(c, { cursor: snapshotTokens[0], limit: 2 }), "INVALID_CURSOR");
  await assertCode(h.data.history({ ...c, deviceId: "other-phone" }, { cursor: first.cursor }), "SESSION_NOT_AUTHORIZED");
  await assertCode(h.data.history({ ...c, grantVersion: 2 }, { cursor: first.cursor }), "STALE_GRANT");
  const second = await h.data.history(c, { cursor: first.cursor, limit: 2 });
  assert.equal(second.items.length, 2); assert.notEqual(second.cursor, first.cursor);
  for (let i = 0; i < 5; i++) await h.data.snapshot(c, { limit: 2 });
  const replay = await h.data.history(c, { cursor: first.cursor, limit: 2 });
  assert.deepEqual(replay.items, second.items, 'a phone cache rejection may retry its original input cursor');
  for (let i = 0; i < 5; i++) await h.data.snapshot(c, { limit: 2 });
  const third = await h.data.history(c, { cursor: replay.cursor, limit: 2 });
  for (let i = 0; i < 5; i++) await h.data.snapshot(c, { limit: 2 });
  await assertCode(h.data.history(c, { cursor: first.cursor }), "INVALID_CURSOR");
  now += 50;
  const afterTime = await h.data.history(c, { cursor: third.cursor, limit: 2 });
  for (let i = 0; i < 5; i++) await h.data.snapshot(c, { limit: 2 });
  now += 51;
  await assertCode(h.data.history(c, { cursor: third.cursor }), "INVALID_CURSOR");
  assert.equal((await h.data.history(c, { cursor: afterTime.cursor, limit: 2 })).items.length, 2);
});

test("pinned history cursors keep the same count cap, lose protection on stream reset and never cross reauthorization", async (t) => {
  const h = harness(fixture({ count: 8 }), { limits: { cursors: 3 } });
  t.after(() => h.data.dispose());
  assert.throws(() => createTabletData({ adapter: h.adapter, limits: { cursors: 2 } }), (cause) => cause.code === "INVALID_LIMIT");
  const c = await h.grant();
  const first = await h.data.history(c, { limit: 2 });
  const oldestSnapshot = (await h.data.snapshot(c, { limit: 2 })).history.cursor;
  await h.data.snapshot(c, { limit: 2 });
  const newestSnapshot = (await h.data.snapshot(c, { limit: 2 })).history.cursor;
  assert.ok(newestSnapshot);
  await assertCode(h.data.history(c, { cursor: oldestSnapshot }), "INVALID_CURSOR");
  const off = h.data.subscribe(c, () => {});
  for (let i = 0; i < 3; i++) await h.data.snapshot(c, { limit: 2 });
  await assertCode(h.data.history(c, { cursor: first.cursor }), "INVALID_CURSOR");
  off();
  const page = await h.data.history(c, { limit: 2 });
  const next = await h.grant({ deviceId: "phone-b", grantVersion: 2 });
  await assertCode(h.data.history(c, { cursor: page.cursor }), "SESSION_NOT_AUTHORIZED");
  await assertCode(h.data.history(next, { cursor: page.cursor }), "INVALID_CURSOR");
});

test("on-demand subscription filters before export and keeps a private sequence rather than global bus IDs", async (t) => {
  const h = harness(undefined, { limits: { batchMs: 5 } }); t.after(() => h.data.dispose());
  const c = await h.grant();
  h.emit({ type: "delta", runId: "r-a", text: "not viewing" });
  assert.equal(h.stats.subscribes, 0);
  h.runs.set(h.sid, { id: "r-a", sessionId: h.sid, startedAt: Date.now(), perms: new Map(), log: [] });
  const delivered = [], off = h.data.subscribe(c, (value) => { delivered.push(value); return true; });
  const s = await h.data.snapshot(c); assert.equal(s.seq, 0); assert.equal(s.resumable, true);
  h.emit({ type: "state", runs: [{ id: "private-run", sessionId: "other", text: "private" }] });
  h.emit({ type: "delta", runId: "other-run", text: "unhosted" });
  h.emit({ type: "delta", runId: "r-a", sessionId: "other", text: "spoofed mismatch" });
  h.emit({ type: "thinking_delta", runId: "r-a", text: "secret-thought" });
  h.emit({ type: "delta", runId: "r-a", text: "visible", secret: "raw-env", sessionId: h.sid });
  const b = h.data.events(c, { streamId: s.streamId, after: 0 });
  assert.deepEqual(b.events, [{ seq: 1, type: "delta", runId: "r-a", text: "visible" }]);
  await wait(); assert.equal(delivered.length, 1); assert.equal(delivered[0].events.length, 1);
  off(); assert.equal(h.stats.unsubscribes, 1); assert.equal(h.listeners.size, 0);
  h.emit({ type: "delta", runId: "r-a", text: "closed" });
  assert.equal(h.data.events(c, { streamId: s.streamId, after: 1 }).gap.reason, "not_subscribed");
  const off2 = h.data.subscribe(c, () => {}), s2 = await h.data.snapshot(c);
  assert.notEqual(s2.streamId, s.streamId);
  assert.equal(h.data.events(c, { streamId: s.streamId, after: 1 }).gap.reason, "stream_changed");
  off2();
});

test("only trusted live user ingress sourceDeviceId survives as phone provenance", async (t) => {
  const h = harness(fixture({ count: 0 })); t.after(() => h.data.dispose());
  fs.appendFileSync(h.file, JSON.stringify({ type: "user", source: "phone", sourceDeviceId: "forged-transcript-device", message: { content: "history is not trusted provenance" } }) + "\n");
  const c = await h.grant();
  h.runs.set(h.sid, { id: "provenance-run", sessionId: h.sid, startedAt: Date.now(), log: [], perms: new Map() });
  const off = h.data.subscribe(c, () => {}), snapshot = await h.data.snapshot(c);
  h.emit({ type: "run_start", sessionId: h.sid, runId: "provenance-run", text: "remote start", source: "host", sourceDeviceId: "phone-a" });
  h.emit({ type: "inject", runId: "provenance-run", text: "remote injection", sourceDeviceId: "phone-a" });
  h.emit({ type: "inject", runId: "provenance-run", text: "bare source is not authority", source: "phone" });
  h.emit({ type: "delta", runId: "provenance-run", text: "assistant is not user ingress", sourceDeviceId: "phone-a" });
  const batch = h.data.events(c, { streamId: snapshot.streamId, after: snapshot.seq });
  assert.equal(batch.events[0].source, "phone"); assert.equal(batch.events[1].source, "phone");
  assert.equal(Object.hasOwn(batch.events[2], "source"), false); assert.equal(Object.hasOwn(batch.events[3], "source"), false);
  assert.equal(JSON.stringify(batch).includes("phone-a"), false, "device ID is not a display field");
  const live = normaliseLive(batch.events, { runId: "provenance-run" });
  assert.equal(live[0].source, "phone"); assert.equal(live[1].source, "phone"); assert.equal(live[2].source, undefined);
  const history = normaliseHistory(await h.data.history(c)); assert.equal(history.items[0].source, undefined);
  off();
});

test("run_end after removal still binds observed run and cannot expose another session", async (t) => {
  const h = harness(); t.after(() => h.data.dispose()); const c = await h.grant();
  const off = h.data.subscribe(c, () => {});
  h.runs.set(h.sid, { id: "end-me", sessionId: h.sid, startedAt: Date.now(), log: [], perms: new Map() });
  h.emit({ type: "run_start", sessionId: h.sid, runId: "end-me", text: "start", startedAt: 1 });
  const s = await h.data.snapshot(c); h.runs.delete(h.sid);
  h.emit({ type: "run_end", runId: "end-me", sessionId: h.sid, aborted: true, resultText: "not-an-extra-result" });
  const b = h.data.events(c, { streamId: s.streamId, after: s.seq });
  assert.deepEqual(b.events, [{ seq: 2, type: "run_end", runId: "end-me", aborted: true }]);
  off();
});

test("snapshot captures history/live barrier before await and only exports bounded pending request summaries", async (t) => {
  const h = harness(fixture({ count: 3 })); t.after(() => h.data.dispose()); const c = await h.grant();
  h.runs.set(h.sid, { id: "barrier-run", sessionId: h.sid, startedAt: Date.now(), log: [
    { type: "run_start", runId: "barrier-run", sessionId: h.sid, text: "in-flight" },
    { type: "delta", runId: "barrier-run", text: "x".repeat(400000) },
    { type: "thinking", runId: "barrier-run", text: "secret-reasoning" },
    { type: "tool_use", runId: "barrier-run", id: "write-one", name: "Write", input: { file_path: "/fake/path", content: "text", env: "secret-env" } },
  ], perms: new Map([["p", { id: "p", tool: "Bash", input: { command: "must-go-via-control-details" }, suggestions: ["never"] }]]) });
  const off = h.data.subscribe(c, () => {});
  const promise = h.data.snapshot(c);
  h.emit({ type: "delta", runId: "barrier-run", text: "later event" });
  fs.appendFileSync(h.file, JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(), message: { content: [{ type: "text", text: "must-not-duplicate" }] } }) + "\n");
  const s = await promise;
  assert.equal(s.seq, 0); assert.equal(s.liveGap, true);
  assert.equal(s.history.items.length, 6);
  assert.deepEqual(s.run.pendingRequests, [{ id: "p", tool: "Bash", detailsComplete: false }]);
  assert.equal(s.run.id, "barrier-run"); assert.ok(wireBytes(s) <= TABLET_DATA_LIMITS.frameBytes);
  assert.doesNotMatch(JSON.stringify(s), /secret-reasoning|secret-env|must-go-via-control-details|must-not-duplicate|suggestions/);
  assert.equal(h.data.events(c, { streamId: s.streamId, after: s.seq }).events[0].text, "later event");
  off();
});

test("slow listener retains one in-flight callback; ring overflow produces explicit gap", async (t) => {
  const h = harness(undefined, { limits: { batchMs: 5, ringBytes: 3000, ringItems: 4 } }); t.after(() => h.data.dispose());
  const c = await h.grant(); h.runs.set(h.sid, { id: "slow-run", sessionId: h.sid, startedAt: Date.now(), perms: new Map(), log: [] });
  let release, calls = 0; const delivered = [];
  const off = h.data.subscribe(c, (v) => { calls++; delivered.push(v); return calls === 1 ? new Promise((r) => { release = r; }) : true; });
  const s = await h.data.snapshot(c);
  h.emit({ type: "delta", runId: "slow-run", text: "first" }); await wait();
  assert.equal(calls, 1);
  for (let i = 0; i < 1000; i++) h.emit({ type: "delta", runId: "slow-run", text: `long-${i}-` + "z".repeat(500) });
  await wait(); assert.equal(calls, 1);
  const gap = h.data.events(c, { streamId: s.streamId, after: 0 });
  assert.equal(gap.gap.reason, "window_exceeded"); assert.equal(gap.requiresSnapshot, true);
  assert.equal(gap.events.length, 0); assert.ok(wireBytes(gap) < 1000);
  release(true); await wait(); await wait();
  assert.equal(calls, 2); assert.equal(delivered[1].gap.reason, "window_exceeded");
  assert.equal(delivered[1].to, 1001); off();
});

test("snapshot ACK unblocks an overflow without skipping events arriving during the snapshot read", async (t) => {
  let sourceListener, finishRead;
  const adapter = {
    describe: () => ({ title: "ACK fixture" }),
    readHistory: () => new Promise((resolve) => { finishRead = resolve; }),
    subscribe: (fn) => { sourceListener = fn; return () => { sourceListener = null; }; },
  };
  const data = createTabletData({ adapter, hostInstanceId: "ack-host", limits: { batchMs: 5, ringItems: 4 } });
  t.after(() => data.dispose());
  const c = await data.authorize({ localSessionId: "selected", deviceId: "phone", grantVersion: 1, expiresAt: Date.now() + 60000 });
  const delivered = [];
  data.subscribe(c, (batch) => { delivered.push(batch); return true; });
  for (let i = 0; i < 6; i++) sourceListener({ type: "note", sessionId: "selected", text: `burst ${i}` });
  const pending = data.snapshot(c);
  sourceListener({ type: "note", sessionId: "selected", text: "during read A" });
  sourceListener({ type: "note", sessionId: "selected", text: "during read B" });
  await eventually(() => delivered.length === 1);
  assert.equal(delivered[0].gap.reason, "window_exceeded");
  assert.equal(delivered[0].to, 8, "the later gap head is not a delivered event anchor");
  await wait(); assert.equal(delivered.length, 1, "gap remains blocked until the exact snapshot is sent");
  finishRead({ entries: [], cursor: null });
  const snapshot = await pending;
  assert.equal(snapshot.seq, 6);
  assert.equal(data.ackSnapshot(c, { streamId: "other-stream", seq: 6 }), false);
  assert.equal(data.ackSnapshot(c, { streamId: snapshot.streamId, seq: 8 }), false, "head is not a completed snapshot anchor");
  assert.equal(data.ackSnapshot(c, snapshot), true);
  await eventually(() => delivered.length === 2);
  assert.equal(delivered[1].gap, null);
  assert.deepEqual(delivered[1].events.map((event) => [event.seq, event.text]), [[7, "during read A"], [8, "during read B"]]);
  sourceListener({ type: "perm_request", sessionId: "selected", id: "approval", tool: "Bash", input: { secret: "never" } });
  await eventually(() => delivered.length === 3);
  assert.equal(delivered[2].events[0].type, "perm_request");
  assert.doesNotMatch(JSON.stringify(delivered), /never/);
});

test("late gap callbacks cannot undo a sent snapshot ACK and ACKs never rewind", async (t) => {
  const h = harness(undefined, { limits: { batchMs: 5, ringItems: 4 } });
  t.after(() => h.data.dispose()); const c = await h.grant();
  let releaseGap;
  const delivered = [];
  const off = h.data.subscribe(c, (batch) => {
    delivered.push(batch);
    return delivered.length === 1 ? new Promise((resolve) => { releaseGap = resolve; }) : true;
  });
  for (let i = 0; i < 8; i++) h.emit({ type: "note", sessionId: h.sid, text: `overflow ${i}` });
  await eventually(() => typeof releaseGap === "function");
  const older = await h.data.snapshot(c);
  h.emit({ type: "note", sessionId: h.sid, text: "newer anchor" });
  const newer = await h.data.snapshot(c);
  assert.equal(h.data.ackSnapshot(c, newer), true);
  assert.equal(h.data.ackSnapshot(c, older), false);
  h.emit({ type: "delta", sessionId: h.sid, text: "after ACK" });
  releaseGap(true);
  await eventually(() => delivered.length === 2);
  assert.equal(delivered[1].gap, null);
  assert.deepEqual(delivered[1].events.map((event) => event.text), ["after ACK"]);
  off();
  const off2 = h.data.subscribe(c, () => {});
  assert.equal(h.data.ackSnapshot(c, newer), false, "old stream cannot acknowledge a new viewer");
  assert.throws(() => h.data.ackSnapshot({ ...c, deviceId: "other-phone" }, newer), (error) => error.code === "SESSION_NOT_AUTHORIZED");
  assert.throws(() => h.data.ackSnapshot({ ...c, grantVersion: 2 }, newer), (error) => error.code === "STALE_GRANT");
  off2(); h.data.revoke(c.remoteSessionId);
  assert.throws(() => h.data.ackSnapshot(c, newer), (error) => error.code === "SESSION_NOT_AUTHORIZED");
});

test("late rejected gap callbacks also leave a snapshot ACK unblocked", async (t) => {
  const h = harness(undefined, { limits: { batchMs: 5, ringItems: 2 } });
  t.after(() => h.data.dispose()); const c = await h.grant();
  let rejectGap; const delivered = [];
  h.data.subscribe(c, (batch) => {
    delivered.push(batch);
    return delivered.length === 1 ? new Promise((_, reject) => { rejectGap = reject; }) : true;
  });
  for (let i = 0; i < 4; i++) h.emit({ type: "note", sessionId: h.sid, text: `gap ${i}` });
  await eventually(() => typeof rejectGap === "function");
  const raw = await h.data.snapshot(c); assert.equal(h.data.ackSnapshot(c, raw), true);
  h.emit({ type: "note", sessionId: h.sid, text: "not lost after rejection" });
  rejectGap(new Error("synthetic rejected callback"));
  await eventually(() => delivered.length === 2);
  assert.equal(delivered[1].gap, null);
  assert.equal(delivered[1].events[0].text, "not lost after rejection");
});

test("snapshot byte budgets preserve every withheld historical sibling through the cursor", async (t) => {
  for (const count of [20, 70]) {
    const f = fixture({ count: 0 });
    const texts = Array.from({ length: count }, (_, i) => `message ${i} ` + "x".repeat(1900));
    fs.writeFileSync(f.file, JSON.stringify({ type: "assistant", uuid: "many-blocks", message: { content: texts.map((text) => ({ type: "text", text })) } }) + "\n");
    const h = harness(f); t.after(() => h.data.dispose()); const c = await h.grant();
    const full = await h.data.snapshot(c);
    assert.equal(full.history.hasMore, count > 49);
    const raw = await h.data.snapshot(c, { maxBytes: 16000 });
    assert.ok(wireBytes(raw) <= 16000); assert.ok(raw.history.items.length < full.history.items.length);
    const shown = normaliseSnapshot(raw, { scope: c.remoteSessionId });
    const pending = Array.from({ length: 2 }, (_, i) => ({ requestId: `p${i}`, requestVersion: i + 1, runId: "synthetic-run",
      state: "pending", kind: "permission", expiresAt: Date.now() + 60000, detailsComplete: true, detailText: "d".repeat(20000) }));
    assert.ok(wireBytes({ ...shown, pending, grant: { state: "active", expiresAt: c.expiresAt } }) < 60000);
    let cursor = raw.history.cursor, pages = 0;
    const seen = raw.history.items.map((item) => item.text);
    assert.ok(cursor, "the shortened snapshot retains an older continuation even if the unrestricted source fits");
    while (cursor) {
      const page = await h.data.history(c, { cursor });
      seen.unshift(...page.items.map((item) => item.text)); cursor = page.cursor;
      assert.ok(++pages < 20);
    }
    assert.deepEqual(seen, texts);
  }
});

test("small snapshot budgets bound busy live windows and leave history before withheld rows", async (t) => {
  const h = harness(fixture({ count: 5 })); t.after(() => h.data.dispose()); const c = await h.grant();
  h.runs.set(h.sid, { id: "budget-run", sessionId: h.sid, startedAt: Date.now(), perms: new Map(),
    log: Array.from({ length: 60 }, (_, i) => ({ type: "assistant_text", runId: "budget-run", text: `live ${i} ` + "y".repeat(1500) })) });
  const raw = await h.data.snapshot(c, { maxBytes: 9000 });
  assert.ok(wireBytes(raw) <= 9000); assert.equal(raw.liveGap, true);
  const shown = normaliseSnapshot(raw);
  assert.ok(shown.items.length <= 50); assert.equal(shown.items[0].role, "system");
  let cursor = raw.history.cursor;
  const seen = raw.history.items.map((item) => item.text);
  while (cursor) { const page = await h.data.history(c, { cursor }); seen.unshift(...page.items.map((item) => item.text)); cursor = page.cursor; }
  assert.deepEqual(seen, [...Array.from({ length: 5 }, (_, i) => [`question ${i}`, `answer ${i}`]).flat()]);
});

test("small snapshot budgets bound duplicate pending summaries without claiming complete details", async (t) => {
  const h = harness(fixture({ count: 0 })); t.after(() => h.data.dispose()); const c = await h.grant();
  h.runs.set(h.sid, { id: "many-requests", sessionId: h.sid, startedAt: Date.now(), log: [], perms: new Map(Array.from({ length: 32 }, (_, i) =>
    [`p${i}`, { id: `p${i}-` + "i".repeat(120), tool: "t".repeat(128), input: { secret: "never-export-summary-input" } }])) });
  const raw = await h.data.snapshot(c, { maxBytes: 2048 });
  assert.ok(wireBytes(raw) <= 2048); assert.equal(raw.run.pendingRequestsTruncated, true);
  assert.ok(raw.run.pendingRequests.length > 0 && raw.run.pendingRequests.length < 32);
  assert.ok(raw.run.pendingRequests.every((request) => request.detailsComplete === false));
  assert.equal(normaliseSnapshot(raw).run.state, "waiting");
  assert.doesNotMatch(JSON.stringify(raw), /never-export-summary-input/);
});

test("one-Record gap pages reserve the notice without losing the undelivered message", async (t) => {
  const f = fixture({ count: 1 }); fs.appendFileSync(f.file, "invalid-json-private-path\n");
  const h = harness(f); t.after(() => h.data.dispose()); const c = await h.grant();
  const raw = await h.data.history(c, { limit: 1 });
  assert.equal(raw.items.length, 0); assert.equal(raw.gaps[0].reason, "invalid_line");
  const first = normaliseHistory(raw);
  assert.equal(first.items.length, 1); assert.equal(first.items[0].role, "system");
  assert.ok(first.cursor); assert.doesNotMatch(JSON.stringify(first), /invalid-json-private-path/);
  const texts = []; let cursor = first.cursor, pages = 0;
  while (cursor) {
    const next = await h.data.history(c, { cursor, limit: 1 });
    assert.equal(next.gaps.length, 0, "reported newer gap is not scanned again");
    texts.unshift(...next.items.map((item) => item.text)); cursor = next.cursor;
    assert.ok(++pages < 5);
  }
  assert.deepEqual(texts, ["question 0", "answer 0"]);
});

test("revocation and expiry detach sources immediately, including async source reads", async (t) => {
  let now = Date.now(), finishRead;
  const adapter = { describe: () => ({ title: "revocation fixture" }), readHistory: () => new Promise((r) => { finishRead = r; }), subscribe: () => () => {} };
  const data = createTabletData({ adapter, hostInstanceId: "expiry-host", now: () => now }); t.after(() => data.dispose());
  const c = await data.authorize({ localSessionId: "a", deviceId: "p", grantVersion: 1, expiresAt: now + 1000 });
  const pending = data.history(c); data.revoke(c.remoteSessionId); finishRead({ entries: [], cursor: null });
  await assertCode(pending, "SESSION_NOT_AUTHORIZED");
  const h = harness(undefined, { now: () => now }); t.after(() => h.data.dispose()); const c2 = await h.grant();
  h.data.subscribe(c2, () => {}); now = c2.expiresAt + 1;
  assert.throws(() => h.data.events(c2), (e) => e.code === "SESSION_NOT_AUTHORIZED");
  assert.equal(h.stats.unsubscribes, 1); assert.equal(h.listeners.size, 0);
});

test("one source read per selected session fails busy without queueing and survives grant replacement", async (t) => {
  let finish;
  const adapter = { describe: () => ({ title: "concurrency fixture" }), readHistory: () => new Promise((r) => { finish = r; }) };
  const data = createTabletData({ adapter, hostInstanceId: "single-read-host" }); t.after(() => data.dispose());
  const grant = (phone) => data.authorize({ localSessionId: "selected", deviceId: phone, grantVersion: 1, expiresAt: Date.now() + 60000 });
  const old = await grant("old-phone"), pending = data.history(old);
  await assertCode(data.history(old), "READ_BUSY"); await assertCode(data.snapshot(old), "READ_BUSY");
  const current = await grant("new-phone"); await assertCode(data.history(current), "READ_BUSY");
  finish({ entries: [], cursor: null }); await assertCode(pending, "SESSION_NOT_AUTHORIZED");
  const allowed = data.history(current); finish({ entries: [], cursor: null }); assert.equal((await allowed).items.length, 0);
});

test("one phone per local session invalidates old cursors/content and old callbacks", async (t) => {
  const h = harness(); t.after(() => h.data.dispose()); const old = await h.grant();
  h.data.subscribe(old, () => assert.fail("old subscriber must not receive new events"));
  const p = await h.data.history(old, { limit: 2 });
  const current = await h.grant({ deviceId: "new-phone", grantVersion: 2 });
  await assertCode(h.data.history(old, { cursor: p.cursor }), "SESSION_NOT_AUTHORIZED");
  await assertCode(h.data.history(current, { cursor: p.cursor }), "INVALID_CURSOR");
  assert.equal(h.listeners.size, 0);
});

test("explicit factory connects real source modules inside runner fake HOME", async (t) => {
  const f = fixture({ count: 2 });
  const adapter = createSourceAdapter({ findSessionFile, peekSession, transcriptItems, runOfSession, onPublish });
  const data = createTabletData({ adapter, hostInstanceId: "real-source-fixture", limits: { batchMs: 5 } });
  t.after(() => { data.dispose(); RUNS.delete("fixture-source-run"); });
  const c = await data.authorize({ localSessionId: f.sid, deviceId: "fixture-phone", grantVersion: 1, expiresAt: Date.now() + 60000 });
  RUNS.set("fixture-source-run", { id: "fixture-source-run", sessionId: f.sid, startedAt: Date.now(), log: [], perms: new Map() });
  const off = data.subscribe(c, () => {}), s = await data.snapshot(c);
  assert.equal(s.history.items.length, 4);
  publish({ type: "delta", runId: "fixture-source-run", text: "source bus fixture" });
  publish({ type: "delta", runId: "not-selected", text: "do not export" });
  assert.equal(data.events(c, { streamId: s.streamId, after: s.seq }).events[0].text, "source bus fixture");
  off();
});

test("source retained item bytes remain bounded and lower scan limits still make progress", async () => {
  const f = fixture({ count: 12, aText: () => "s".repeat(600) });
  let before = null, count = 0, iterations = 0;
  do {
    const p = await readBoundedSessionPage(f.file, { before, transcriptItems, limit: 20, limits: { scanBytes: 2048 } });
    assert.ok(p.entries.reduce((sum, entry) => sum + wireBytes(entry.item), 0) <= 2048);
    count += p.entries.length; assert.notDeepEqual(before, p.cursor); before = p.cursor;
    iterations++; assert.ok(iterations < 40);
  } while (before);
  assert.equal(count, 24);
});

test("canonical protocol IDs containing punctuation remain valid data context IDs", async (t) => {
  const h = harness(undefined, { hostInstanceId: "host:v1.2" }); t.after(() => h.data.dispose());
  const c = await h.grant({ deviceId: "phone:paired.1", remoteSessionId: "remote:grant.1" });
  assert.equal((await h.data.history(c, { limit: 1 })).items.length, 1);
});

test("invalid public limits and stale future sequences fail closed", async (t) => {
  const h = harness(); t.after(() => h.data.dispose()); const c = await h.grant();
  await assertCode(h.data.history(c, { limit: 51 }), "INVALID_LIMIT");
  await assertCode(h.data.history(c, { limit: -1 }), "INVALID_LIMIT");
  await assertCode(h.data.snapshot(c, { maxBytes: 2047 }), "INVALID_LIMIT");
  await assertCode(h.data.snapshot(c, { maxBytes: 61441 }), "INVALID_LIMIT");
  await assertCode(h.data.snapshot(c, { reserveItems: -1 }), "INVALID_LIMIT");
  await assertCode(h.data.snapshot(c, { limit: 1, reserveItems: 2 }), "INVALID_LIMIT");
  assert.throws(() => h.data.ackSnapshot(c, { streamId: "s", seq: -1 }), (e) => e.code === "INVALID_SEQUENCE");
  assert.throws(() => createTabletData({ adapter: h.adapter, limits: { frameBytes: 1000000 } }), (e) => e.code === "INVALID_LIMIT");
  const off = h.data.subscribe(c, () => {}), s = await h.data.snapshot(c);
  assert.equal(h.data.events(c, { streamId: s.streamId, after: 99 }).gap.reason, "future_sequence");
  assert.throws(() => h.data.events(c, { streamId: s.streamId, after: -1 }), (e) => e.code === "INVALID_SEQUENCE");
  off();
});
