import { PATHS, CFG } from "../gw/config.mjs";
import "./fixtures/uc-baseline.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import fs from "node:fs";
import path from "node:path";
import { trackWorkIslandReply } from "../gw/work-island-reply.mjs";

const sid = "380925e9-eada-4c9c-84bc-fa32eab575b0";
const textBlock = (text) => ({ type: "text", text });
const assistant = (content, message = {}, event = {}) => ({ type: "assistant", session_id: sid,
  message: { id: "m", role: "assistant", model: "fixture", stop_reason: null, content, ...message }, ...event });
const result = (text, fields = {}) => ({ type: "result", session_id: sid, stop_reason: "end_turn", subtype: "success", is_error: false, result: text, ...fields });
const stream = (event) => ({ type: "stream_event", event });

test("preview comes from a matching final assistant message, not earlier tool turns or sidechains", () => {
  const t = trackWorkIslandReply();
  t.feed(assistant([{ type: "tool_use" }], { id: "tool" }), sid);
  t.feed({ type: "user" }, sid);
  t.feed(stream({ type: "message_start", message: { id: "m", content: [] } }), sid);
  t.feed(stream({ type: "content_block_start", content_block: textBlock("") }), sid);
  t.feed(assistant([textBlock("Hello\n"), textBlock(" world")]), sid);
  t.feed(assistant([textBlock("child")], {}, { parent_tool_use_id: "tool" }), sid);
  t.feed(stream({ type: "message_delta", delta: { stop_reason: "end_turn" } }), sid);
  t.feed(stream({ type: "message_stop" }), sid);
  t.result(result("Hello\n world"), sid);
  assert.equal(t.text, "Hello world");
});

test("preview fails closed on mixed, ambiguous, stale, synthetic, or unsuccessful output", () => {
  const a = assistant([textBlock("OK")]);
  const r = result("OK");
  const cases = [
    [[], r], [[a], result("other")], [[a], result("OK", { session_id: "other" })],
    [[a], result("OK", { is_error: true })], [[a], result("OK", { is_error: undefined })],
    [[a], result("OK", { stop_reason: "max_tokens" })], [[a], result("OK", { stop_reason: undefined })],
    [[a], result("OK", { local_command: "/context" })],
    [[a], result("OK", { subtype: "error_during_execution" })],
    [[assistant([textBlock("OK"), { type: "tool_use" }])], r],
    [[assistant([{ type: "thinking", thinking: "hidden" }]), a], r],
    [[assistant([{ type: "redacted_thinking" }]), a], r],
    [[a, assistant([{ type: "unknown" }])], r],
    [[assistant([textBlock("OK")], { model: "<synthetic>" })], r],
    [[assistant([textBlock("OK")], {}, { isApiErrorMessage: true })], r],
    [[assistant([textBlock("OK")], {}, { isSidechain: true })], r],
    [[assistant([textBlock("OK")], {}, { session_id: "other" })], r],
    [[a, stream({ type: "message_start", message: { id: "new", content: [] } })], r],
    [[a, { type: "user" }], r],
    [[a, stream({ type: "content_block_start", content_block: { type: "thinking" } })], r],
    [[assistant([textBlock("a\u001bb")])], result("a\u001bb")],
    [[assistant([textBlock("<thinking>secret</thinking>")])], result("<thinking>secret</thinking>")],
  ];
  for (const [events, res] of cases) {
    const t = trackWorkIslandReply();
    for (const ev of events) t.feed(ev, sid);
    t.result(res, sid);
    assert.equal(t.text, null, JSON.stringify({ events, res }));
  }
  const t = trackWorkIslandReply();
  t.feed(a, sid);
  t.result(r, sid);
  assert.equal(t.text, "OK");
  t.feed(stream({ type: "message_start", message: { id: "new", content: [] } }), sid);
  assert.equal(t.text, null);
});

test("preview length is bounded without splitting Unicode surrogate pairs", () => {
  const long = "好😀".repeat(100);
  const t = trackWorkIslandReply();
  t.feed(assistant([textBlock(long)]), sid);
  t.result(result(long), sid);
  assert.equal(t.text, "好😀".repeat(79) + "好…");
});

test("gateway sends preview only to a live native notifier, immediately before run_end; never replays it", async (t) => {
  process.env.CCAPP_NATIVE_WORK_ISLAND = "1";
  process.env.ANTHROPIC_API_KEY = "fixture-only-do-not-forward";
  const { routeBus, BOOT, publish } = await import("../gw/bus.mjs");
  const { routeSettings, SETTINGS } = await import("../gw/settings.mjs");
  const { _islandForTest, startWorkIsland, stopWorkIsland } = await import("../gw/work-island.mjs");
  const { startRun } = await import("../gw/run.mjs");
  t.mock.method(_islandForTest.seam, "android", () => true);
  t.mock.method(globalThis, "fetch", async () => { throw new Error("fixture must not send a request"); });
  t.after(stopWorkIsland);

  const cwd = fs.mkdtempSync(path.join(CFG.workspace, "wi-reply-"));
  const cli = path.join(cwd, "fake-cli.sh");
  Object.assign(PATHS, { claude: process.execPath, loader: cli, claudeLoader: cli });
  const sh = fs.existsSync("/system/bin/sh") ? "/system/bin/sh" : "/bin/sh";
  const open = async ({ notify = true, signed = true, since, slow = false } = {}) => {
    const req = Object.assign(new EventEmitter(), { method: "GET", headers: {}, ...(signed ? { ccBodySha: "signed" } : {}) });
    if (since) req.headers["last-event-id"] = since;
    t.after(() => req.emit("close"));
    const chunks = [];
    const res = Object.assign(new EventEmitter(), { writableLength: slow ? 1 : 0, writeHead() {}, write(chunk) { chunks.push(chunk.toString()); return !this.writableLength; } });
    const u = new URL(`http://test/api/events${notify ? "?notify=1" : ""}`);
    await routeBus(req, res, u, u.pathname);
    const frames = () => chunks.flatMap((c) => c.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6))));
    return { frames, chunks, res };
  };
  const settings = async (body) => {
    const req = Object.assign(new EventEmitter(), { method: body === undefined ? "GET" : "POST", headers: {} });
    let status, response;
    const res = { writeHead(code) { status = code; }, end(buf) { response = JSON.parse(buf); } };
    const u = new URL("http://test/api/settings");
    const pending = routeSettings(req, res, u, u.pathname);
    if (body !== undefined) { req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end"); }
    await pending;
    return { status, response };
  };
  const until = async (fn) => {
    const deadline = Date.now() + 10_000;
    while (!fn()) { assert.ok(Date.now() < deadline, "timed out waiting for gateway event"); await delay(20); }
  };
  const native = await open(), web = await open({ notify: false }), unsigned = await open({ signed: false });
  const anchor = `id: ${BOOT}.`;
  const before = native.chunks.find((c) => c.startsWith(anchor)).split("\n")[0].slice(4);
  assert.equal((await settings()).response.workIslandReplyPreview, false);
  assert.equal((await settings({ workIslandReplyPreview: "true" })).status, 400);
  const orig = fs.renameSync;
  const failSave = t.mock.method(fs, "renameSync", (from, to) => {
    if (to === PATHS.settings) throw new Error("fixture write failure");
    return orig(from, to);
  });
  assert.equal((await settings({ workIslandReplyPreview: true })).status, 500);
  assert.equal(SETTINGS.workIslandReplyPreview, false);
  failSave.mock.restore();
  SETTINGS.workIsland = true;
  startWorkIsland();
  const run = async (id, events, exit = 0) => {
    const init = { type: "system", subtype: "init", session_id: sid, model: "fixture" };
    fs.writeFileSync(cli, `#!${sh}\ncat <<'EVENTS'\n${[init, ...events].map((ev) => JSON.stringify(ev)).join("\n")}\nEVENTS\nexit ${exit}\n`, { mode: 0o700 });
    await startRun({ id, message: "fixture", cwd });
    await until(() => native.frames().some((e) => e.type === "run_end" && e.runId === id));
  };
  const good = [assistant([textBlock("Final reply")]), result("Final reply")];
  await run("off", good);
  assert.ok(!native.frames().some((e) => e.type === "work_island_reply"));
  assert.equal((await settings({ workIslandReplyPreview: true })).response.settings.workIslandReplyPreview, true);
  assert.equal(JSON.parse(fs.readFileSync(PATHS.settings, "utf8")).workIslandReplyPreview, true);
  const slow = await open({ slow: true });
  await run("on", good);
  const frames = native.frames(), i = frames.findIndex((e) => e.type === "work_island_reply");
  assert.ok(i >= 0);
  const end = frames.find((e) => e.type === "run_end" && e.runId === "on");
  assert.deepEqual(frames[i], { type: "work_island_reply", runId: "on", sessionId: sid, text: "Final reply", at: end.at });
  assert.ok(i < frames.indexOf(end));
  assert.ok(native.chunks.find((c) => c.includes('"type":"work_island_reply"')).startsWith("data: "));
  // Resume from before the preview, and let an already-replaying client catch up.
  const reconnect = await open({ since: before });
  slow.res.writableLength = 0;
  slow.res.emit("drain");
  await until(() => slow.frames().some((e) => e.type === "run_end" && e.runId === "on"));
  for (const c of [web, unsigned, reconnect, slow]) assert.ok(!c.frames().some((e) => e.type === "work_island_reply"));
  await run("bad-exit", good, 2);
  await run("mixed", [assistant([{ type: "thinking" }]), ...good]);
  assert.equal(native.frames().filter((e) => e.type === "work_island_reply").length, 1);
  assert.equal((await settings({ workIsland: false })).status, 200);
  await run("parent-off", good);
  assert.equal((await settings({ workIslandReplyPreview: false })).status, 200);
  publish({ type: "test-end" });
  assert.equal(native.frames().filter((e) => e.type === "work_island_reply").length, 1);
  assert.equal(native.frames().filter((e) => e.type === "work_island_reply_clear").length, 2);
  assert.ok(!web.frames().some((e) => e.type === "work_island_reply_clear"));
});
