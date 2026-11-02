// v0.5.20 审查第 4 批（#97 #98）：会话、档案、历史读取、常用指令、工作岛
import { CFG, PATHS } from "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// 03-011 / 03-012 要在模块第一次载入前把坏文件放好：先换下别的测试留的，跑完放回
const ARCH = path.join(CFG.home, "ccapp-archive.json");
const keep = (f) => { const b = fs.existsSync(f) ? fs.readFileSync(f) : null; after(() => { if (b) fs.writeFileSync(f, b); else fs.rmSync(f, { force: true }); }); };
keep(ARCH); keep(PATHS.names);
fs.writeFileSync(ARCH, JSON.stringify({ v: 1, sessions: [] }));
fs.writeFileSync(PATHS.names, "[]");
const { archiveDb, saveArchive } = await import("../gw/archive-store.mjs");
const { NAMES, findSessionFile, peekSession } = await import("../gw/sessions.mjs");

test("03-011 档案里 sessions 是数组：当坏文件，另存一份后从空的开始，之后存得住", () => {
  const db = archiveDb();
  assert.equal(Array.isArray(db.sessions), false);
  assert.ok(fs.readdirSync(CFG.home).some((f) => f.startsWith("ccapp-archive.json.bad-")), "原文件留了底");
  db.sessions["s-0520"] = { title: "x", chapters: {} };
  assert.equal(saveArchive(), true);
  assert.equal(JSON.parse(fs.readFileSync(ARCH, "utf8")).sessions["s-0520"].title, "x");
  delete db.sessions["s-0520"]; saveArchive();
  for (const f of fs.readdirSync(CFG.home)) if (f.startsWith("ccapp-archive.json.bad-")) fs.rmSync(path.join(CFG.home, f));
});

test("03-012 会话名文件是数组：当空对象，改名照样存得进去", () => {
  assert.equal(Array.isArray(NAMES), false);
  assert.equal(typeof NAMES, "object");
});

const line = (o) => JSON.stringify(o);
function session(dir, lines, { nl = true } = {}) {
  const sid = crypto.randomUUID(), d = path.join(PATHS.projects, dir);
  fs.mkdirSync(d, { recursive: true });
  const f = path.join(d, sid + ".jsonl");
  fs.writeFileSync(f, lines(sid).join("\n") + (nl ? "\n" : ""));
  return { sid, f, d };
}
const msg = (sid, text, extra = {}) => ({ type: "user", uuid: crypto.randomUUID(), sessionId: sid, timestamp: new Date().toISOString(), cwd: "/x", message: { role: "user", content: text }, ...extra });

test("03-001 导出带上建档，换台机器导回来章节题名还在", async () => {
  const { exportSessions, importSessions } = await import("../gw/sessionops.mjs");
  const { sid, f } = session("-b4-exp", (s) => [line(msg(s, "hi"))]);
  archiveDb().sessions[sid] = { title: "卷名", chapters: { 1: { title: "第一章", status: "done", same: false, by: "user", at: 1, spec: 1, locked: true, hist: [{ title: "旧", at: 0, by: "ai" }], evil: "x" } } };
  saveArchive();
  const out = await exportSessions([sid]);
  // 模拟换机：会话和档案都没了
  fs.rmSync(f); delete archiveDb().sessions[sid]; saveArchive();
  const r = await importSessions(out.file);
  assert.deepEqual(r.imported, [sid]);
  const e = archiveDb().sessions[sid];
  assert.equal(e.title, "卷名");
  assert.equal(e.chapters[1].title, "第一章");
  assert.equal(e.chapters[1].locked, true);
  assert.equal(e.chapters[1].evil, undefined, "只收认得的字段");
  assert.equal(JSON.parse(fs.readFileSync(ARCH, "utf8")).sessions[sid].title, "卷名", "落了盘");
  fs.rmSync(out.file, { force: true });
  delete archiveDb().sessions[sid]; saveArchive();
});

test("03-001 本机已有这条会话的档案：导入不覆盖", async () => {
  const { archiveImport } = await import("../gw/archive-store.mjs");
  archiveDb().sessions["s-mine"] = { title: "我的", chapters: {} };
  assert.equal(archiveImport("s-mine", { title: "包里的", chapters: {} }), false);
  assert.equal(archiveDb().sessions["s-mine"].title, "我的");
  assert.equal(archiveImport("s-new", { title: "x", chapters: [] }), false, "chapters 不是对象不收");
  delete archiveDb().sessions["s-mine"]; delete archiveDb().sessions["s-new"];
});

test("03-004 / 03-005 目录名相同、cwd 不同（b_c 与 b/c 落在同一个目录）：照样改写 cwd，不当成已在目标", async () => {
  const { moveSession } = await import("../gw/projects.mjs");
  const { realWorkspace } = await import("../gw/sessionops.mjs");
  const { projectSlug } = await import("../gw/projects.mjs");
  const ws = realWorkspace(), twin = ws.replace(/\//g, "_");
  assert.equal(projectSlug(twin), projectSlug(ws));
  const { sid, f } = session(projectSlug(ws), (s) => [line(msg(s, "hi", { cwd: twin })), line(msg(s, "again", { cwd: twin }))]);
  assert.equal(peekSession(f).cwd, twin);
  const r = moveSession(sid, null);
  assert.equal(r.ok, true);
  assert.notEqual(r.same, true);
  assert.equal(findSessionFile(sid).file, f, "原地改写");
  assert.equal(peekSession(f).cwd, ws);
  assert.ok(fs.readFileSync(f, "utf8").split("\n").filter(Boolean).every((l) => JSON.parse(l).cwd === ws));
  assert.equal(fs.existsSync(f + ".mv"), false);
  assert.equal(moveSession(sid, null).same, true, "再搬一次才是已在目标");
});

test("03-008 冒号后带空格的旧格式：按 uuid 找得到行首，parentUuid 里的同一个 uuid 不算", async () => {
  const { findLineOffset, lineHas } = await import("../gw/transcript.mjs");
  const u = crypto.randomUUID();
  const rows = (s) => [
    `{"type": "user", "parentUuid": "${u}", "uuid": "${crypto.randomUUID()}", "sessionId": "${s}"}`,
    `{"type": "user", "uuid": "${u}", "sessionId": "${s}"}`,
  ];
  const { f } = session("-b4-loose", rows);
  const off = await findLineOffset(f, u);
  const text = fs.readFileSync(f, "utf8");
  assert.equal(off, text.indexOf("\n") + 1);
  assert.equal(await lineHas(f, off, u), true);
  assert.equal(await lineHas(f, 0, u), false, "只在 parentUuid 里出现的那行不算");
  // 末行没换行也找得到
  const { f: f2 } = session("-b4-loose", rows, { nl: false });
  assert.equal(await findLineOffset(f2, u), fs.readFileSync(f2, "utf8").indexOf("\n") + 1);
});

test("03-008 慢路一块里很多行、uuid 不在：很快返回 -1（不逐行重扫到块尾）", async () => {
  const { findLineOffset } = await import("../gw/transcript.mjs");
  const { f } = session("-b4-big", (s) => Array.from({ length: 60000 }, (_, i) => `{"type": "user", "uuid": "u-${i}", "sessionId": "${s}"}`));
  const t0 = Date.now();
  assert.equal(await findLineOffset(f, crypto.randomUUID()), -1);
  assert.ok(Date.now() - t0 < 1500, `${Date.now() - t0}ms`);
});

test("03-009 正向读：末行没换行但是完整的 JSON，也读出来", async () => {
  const { readSessionForward } = await import("../gw/transcript.mjs");
  const { f } = session("-b4-tail", (s) => [line(msg(s, "第一句")), line({ type: "assistant", uuid: crypto.randomUUID(), sessionId: s, timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "末行的回答" }] } })], { nl: false });
  const r = await readSessionForward(f, { after: 0, limit: 40 });
  assert.match(JSON.stringify(r.items), /末行的回答/);
  // 末行写了一半：不算，等写完
  fs.appendFileSync(f, "\n" + `{"type":"assistant","message":{"content":[{"type":"text","text":"半截`);
  const r2 = await readSessionForward(f, { after: 0, limit: 40 });
  assert.doesNotMatch(JSON.stringify(r2.items), /半截/);
});

test("02-009 常用指令：引号里的转义存一次读一次不增多", async () => {
  const { parseCmd, formatCmd } = await import("../gw/commands.mjs");
  let c = { description: 'a "b" \\ c: d', hint: "it's", body: "x" };
  for (let i = 0; i < 3; i++) c = { ...parseCmd(formatCmd(c)), body: "x" };
  assert.equal(c.description, 'a "b" \\ c: d');
  assert.equal(c.hint, "it's");
  assert.equal(parseCmd("---\ndescription: 'it''s ok'\n---\nx\n").description, "it's ok");
});

test("02-010 工作岛：等你确认时来一个状态快照，不刷回「正在干活」", async () => {
  const { createWorkIsland } = await import("../gw/work-island-core.mjs");
  const sent = [];
  const core = createWorkIsland({ send: (action, title, text, since, state) => sent.push({ action, title, text, state }), runs: () => [{ id: "r1" }], lang: () => "zh", graceMs: 20, idleMs: 30, throttleMs: 0 });
  core.handleEvent({ type: "run_start", id: "r1", startedAt: Date.now() });
  core.handleEvent({ type: "perm_request", tool: "Bash" });
  assert.equal(sent.at(-1).state, "waiting");
  core.handleEvent({ type: "state", run: { id: "r1" } });
  assert.equal(sent.at(-1).state, "waiting");
});

test("02-008 同一秒里给同一个对象发两条长消息：外置成两个文件，不互相覆盖", async () => {
  const { agentBook } = await import("../gw/agents.mjs");
  const cwd = fs.mkdtempSync(path.join(process.env.CCAPP_TMP, "ag0520-")), out = [];
  const b = agentBook({ sessionId: "b4-0520-ag", cwd }, { emit: (e) => out.push(e) });
  const send = (id, text) => b.feed({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "SendMessage", input: { to: "worker", message: text } }] } });
  send("toolu_01AAAAAAAAAAAA1111", "甲".repeat(400));
  send("toolu_01AAAAAAAAAAAA2222", "乙".repeat(400));
  const files = out.filter((e) => e.k === "msg").map((e) => e.file);
  assert.equal(files.length, 2);
  assert.notEqual(files[0], files[1]);
  assert.match(fs.readFileSync(files[0], "utf8"), /甲/);
  assert.match(fs.readFileSync(files[1], "utf8"), /乙/);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("03-006 剖面缓存过后又分出一个会话：再看这一章，新分叉挂上了", async () => {
  const { chapterProfile } = await import("../gw/profile.mjs");
  const iso = (s) => new Date(Date.parse("2026-11-01T00:00:00Z") + s * 1000).toISOString();
  const ask = (S, s, q) => ({ type: "user", uuid: crypto.randomUUID(), sessionId: S, timestamp: iso(s), message: { role: "user", content: q } });
  const say = (S, s, t) => ({ type: "assistant", uuid: crypto.randomUUID(), sessionId: S, timestamp: iso(s), message: { role: "assistant", content: [{ type: "text", text: t }] } });
  const L = [];
  // 父会话在分叉点之后还接着聊（100 秒），子会话 5000 秒才开口：判方向有确定的一票，不靠文件建立先后
  const { sid: S, d } = session("-b4-prof", (s) => { L.push(ask(s, 0, "第一个问题"), say(s, 2, "好"), ask(s, 60, "第二个问题"), say(s, 62, "嗯")); return [...L, ask(s, 100, "父会话接着问")].map(line); });
  const before = await chapterProfile(S, 1);
  assert.deepEqual(before.turns.flatMap((t) => t.kids.map((k) => k.id)), []);
  await new Promise((r) => setTimeout(r, 20));
  const K = crypto.randomUUID();
  fs.writeFileSync(path.join(d, K + ".jsonl"), [...L.map((x) => ({ ...x, sessionId: K })), ask(K, 5000, "换个思路")].map(line).join("\n") + "\n");
  const after_ = await chapterProfile(S, 1);
  assert.deepEqual(after_.turns.flatMap((t) => t.kids.map((k) => k.id)), [K]);
});
