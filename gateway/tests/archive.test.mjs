// 建档（gw/archive-core.mjs + archive.mjs + archive/cc-archive.mjs）：题名校验、章节、交档、提醒、命令行
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateTitle, pickChapter, chapterView, normStatus } from "../gw/archive-core.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const T0 = Date.parse("2026-10-13T00:00:00Z");

test("题名校验：好的放行，问候 / 日期 / 标点 / 空泛 / 语言不对 / 太长的退回并说明", () => {
  for (const t of ["补齐 9 家厂商官方 Anthropic 接口", "28/36 双包与设置切换", "钉 devkit-2026.10.22.3 工具包", "「定稿脉络建档规范」"]) assert.equal(validateTitle(t, "zh").ok, true, t);
  assert.equal(validateTitle("「定稿脉络建档规范」", "zh").title, "定稿脉络建档规范");
  const bad = { "你好，claude": "问候", "2026-10-22 发版": "日期", "10月22日发版": "日期", "修了一些 bug。": "标点", "对话": "空泛", "Add endpoints": "中文", "修复首装勾选页「开始安装」按钮在屏外的问题": "太长", "发版🚀": "emoji" };
  for (const [t, why] of Object.entries(bad)) assert.equal(validateTitle(t, "zh").ok, false, `${t}（${why}）`);
  assert.equal(validateTitle("Add official endpoints for 9 providers", "en").ok, true);
  assert.equal(validateTitle("补齐接口", "en").ok, false);
  assert.equal(validateTitle("会話のアーカイブを整える", "ja").ok, true, "日文界面不查语言");
  assert.match(validateTitle("你好", "en").errors.join(), /greeting|English/);
});

test("状态：中英文都认，认不出的是 undefined、没给的是 null", () => {
  assert.equal(normStatus("已完成"), "done");
  assert.equal(normStatus("paused"), "paused");
  assert.equal(normStatus(""), null);
  assert.equal(normStatus("随便"), undefined);
});

const rec = (C) => ({
  id: "0ab295fe-0000-0000-0000-000000000000", firstTs: T0, lastTs: T0 + 99e6, uu: ["u0"],
  compacts: Array.from({ length: C }, (_, i) => ({ uuid: "c" + (i + 1), ts: T0 + (i + 1) * 1e6, off: (i + 1) * 1000 })),
});

test("交到哪一章：刚结束的章没题名就是它，否则是进行中的那章；显式章号不能越界", () => {
  assert.equal(pickChapter(rec(0), null).n, 1);
  assert.equal(pickChapter(rec(3), null).n, 3);
  assert.equal(pickChapter(rec(3), { chapters: { 3: { title: "x" } } }).n, 4);
  assert.equal(pickChapter(rec(3), null, 1).n, 1);
  assert.ok(pickChapter(rec(3), null, 5).error);
});

test("章节一览：起止、锚点、字节位置、档号；「同一件事」并成一卷，会话题名取最新一卷", () => {
  const v = chapterView(rec(3), { chapters: { 1: { title: "接手网关修复" }, 2: { title: "修网关的第二段", same: true }, 3: { title: "审 GPU 驱动组件" } } });
  assert.equal(v.chapters.length, 4);
  assert.equal(v.chapters[0].no, "0ab2·1");
  assert.equal(v.chapters[1].anchor, "c1");
  assert.equal(v.chapters[1].off, 1000);
  assert.equal(v.chapters[3].open, true);
  assert.equal(v.volumes.length, 3);
  assert.deepEqual(v.volumes[0].chapters, [1, 2]);
  assert.equal(v.volumes[0].title, "修网关的第二段");
  assert.equal(v.sessionTitle, "审 GPU 驱动组件");
  assert.equal(chapterView(rec(0), null).sessionTitle, null);
});

// ── 网关一侧：假 home 里放会话，交档、提醒、会话列表、命令行 ──
const home = process.env.CCAPP_HOME;
const proj = path.join(home, ".claude", "projects", "-arch");
fs.mkdirSync(proj, { recursive: true });
function session(turns, compacts) {
  const sid = crypto.randomUUID(), L = [];
  let k = 0;
  for (let i = 0; i < turns; i++) {
    L.push({ type: "user", uuid: crypto.randomUUID(), sessionId: sid, timestamp: new Date(T0 + i * 6e4).toISOString(), message: { role: "user", content: "问题 " + i } });
    L.push({ type: "assistant", uuid: crypto.randomUUID(), sessionId: sid, timestamp: new Date(T0 + i * 6e4 + 3e4).toISOString(), message: { role: "assistant", content: [{ type: "text", text: "答" }] } });
    if (k < compacts && i % 2 === 1) { L.push({ type: "user", uuid: crypto.randomUUID(), sessionId: sid, isCompactSummary: true, timestamp: new Date(T0 + i * 6e4 + 4e4).toISOString(), message: { role: "user", content: "摘要" } }); k++; }
  }
  fs.writeFileSync(path.join(proj, sid + ".jsonl"), L.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return sid;
}

test("网关：压缩过、刚结束的章没题名 → 系统提示要求先建档；交了不合格的退回，合格的存档、会话列表换成题名", async () => {
  const { archiveHint, fileChapter } = await import("../gw/archive.mjs");
  const { listSessions } = await import("../gw/sessions.mjs");
  const sid = session(6, 2);
  let h = await archiveHint(sid);
  assert.match(h.note, /chapter 2 of this session has ended/);
  assert.match(h.rule, /cc-archive\.mjs/);
  const bad = await fileChapter(sid, { title: "你好，claude" });
  assert.equal(bad.ok, false);
  const ok = await fileChapter(sid, { title: "接手网关修复并验证" });
  assert.equal(ok.ok, true);
  assert.equal(ok.n, 2);
  h = await archiveHint(sid);
  assert.equal(h.note, "", "交过了就不再催");
  assert.equal(listSessions().find((s) => s.id === sid).title, "接手网关修复并验证");
  // 用户改的锁定：AI 再交同一章被拒
  await fileChapter(sid, { title: "我自己起的名字", chapter: 2, by: "user" });
  const again = await fileChapter(sid, { title: "又一个题名", chapter: 2 });
  assert.equal(again.ok, false);
  const db = JSON.parse(fs.readFileSync(path.join(home, "ccapp-archive.json"), "utf8"));
  assert.equal(db.sessions[sid].chapters[2].hist[0].title, "接手网关修复并验证", "改动留痕");
});

test("网关：没压缩过的会话从第 2 轮起提醒起题名；新会话第一轮只给规则", async () => {
  const { archiveHint } = await import("../gw/archive.mjs");
  assert.equal((await archiveHint(session(0, 0))).note, "");
  assert.match((await archiveHint(session(1, 0))).note, /no title yet/);
  assert.equal((await archiveHint(null)).note, "");
});

test("命令行 cc-archive：带本轮编号交档，网关认出会话；不合格退出码 1 并说明", async () => {
  const { routeArchive } = await import("../gw/archive.mjs");
  const { RUNS } = await import("../gw/runs.mjs");
  const sid = session(4, 1);
  RUNS.set("run-arch-1", { id: "run-arch-1", sessionId: sid });
  const srv = http.createServer((req, res) => { const u = new URL(req.url, "http://127.0.0.1"); routeArchive(req, res, u, u.pathname); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const cli = path.join(HERE, "..", "archive", "cc-archive.mjs");
  const env = { ...process.env, CCAPP_RUN_ID: "run-arch-1", CCAPP_GW_PORT: String(port) };
  // 服务器和命令行在同一个测试进程里答，子进程必须异步起（spawnSync 会卡住事件循环）
  const run = (...a) => new Promise((r) => { const c = spawn(process.execPath, [cli, ...a], { env }); let o = ""; c.stdout.on("data", (d) => (o += d)); c.stderr.on("data", (d) => (o += d)); c.on("close", (code) => r({ code, o })); });
  const r1 = await run("--title", "修了一些 bug。");
  assert.equal(r1.code, 1);
  assert.match(r1.o, /标点/);
  const r2 = await run("--title", "审 GPU 驱动组件");
  assert.equal(r2.code, 0, r2.o);
  assert.match(r2.o, /filed .*·1: 审 GPU 驱动组件/);
  srv.close();
  RUNS.delete("run-arch-1");
});

test("杂项：AI 交档带 misc 归进去；用户移出后 AI 再带也不动；会话列表带档号和杂项标记", async () => {
  const { fileChapter, setMisc } = await import("../gw/archive.mjs");
  const { listSessions } = await import("../gw/sessions.mjs");
  const sid = session(2, 0);
  assert.equal((await fileChapter(sid, { title: "测试建档提醒", misc: true })).ok, true);
  let s = listSessions().find((x) => x.id === sid);
  assert.equal(s.misc, true);
  assert.equal(s.no, sid.slice(0, 4) + "·1");
  setMisc(sid, false);
  await fileChapter(sid, { title: "测试建档提醒第二次", misc: true, chapter: 1 });
  assert.equal(listSessions().find((x) => x.id === sid).misc, false, "用户移出过，AI 不再归入");
  // 没建过档的会话也能被用户归入杂项，档号仍是空的
  const raw = session(1, 0);
  setMisc(raw, true);
  s = listSessions().find((x) => x.id === raw);
  assert.equal(s.misc, true);
  assert.equal(s.no, null);
});

test("脉络弹层：分叉出来的会话带来源（标题、方式、分叉时间），原会话没有来源", async () => {
  const { archiveView } = await import("../gw/archive.mjs");
  const { forkSession } = await import("../gw/sessionops.mjs");
  const sid = session(3, 0);
  const f = forkSession(sid, "问题 1", 1);
  assert.equal(f.ok, true, JSON.stringify(f));
  const v = await archiveView(f.id);
  assert.equal(v.parent.id, sid);
  assert.equal(v.parent.kind, "fork");
  assert.equal(v.parent.title, "问题 0");
  assert.ok(v.parent.ts > 0);
  assert.equal((await archiveView(sid)).parent, null);
});
