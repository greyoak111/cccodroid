// 十路并发 Bug 审查（11-01）的回归测试：一条一个，编号对应报告 B01–B30
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { CFG } from "../gw/config.mjs";
import { NEXT } from "../gw/http.mjs";
import { routeGit } from "../gw/git.mjs";

async function serve(...routes) {
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    for (const r of routes) if ((await r(req, res, u, u.pathname)) !== NEXT) return;
    res.writeHead(404).end();
  });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  after(() => srv.close());
  return async (p, body) => { const r = await fetch(`http://127.0.0.1:${srv.address().port}${p}`, { method: "POST", body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
}
const gitGo = await serve(routeGit);
// 网关跑 git 用终端那套 PATH（假 PREFIX/bin）：把本机的 git 链进去
{ const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim(), bin = path.join(process.env.CCAPP_PREFIX, "bin", "git");
  if (!fs.existsSync(bin)) fs.symlinkSync(real, bin); }

function repo(name) {
  const d = path.join(CFG.workspace, name);
  fs.mkdirSync(d, { recursive: true });
  const g = (...a) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: d, encoding: "utf8" });
  g("init", "-q");
  return { d, g };
}

test("B02 撤销未跟踪的符号链接：删链接本身，不删它指向的文件", async () => {
  const { d } = repo("b02");
  fs.writeFileSync(path.join(d, "target.txt"), "keep me");
  fs.symlinkSync("target.txt", path.join(d, "link.txt"));
  const r = await gitGo("/api/git/discard", { dir: d, file: path.join(d, "link.txt") });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(fs.readFileSync(path.join(d, "target.txt"), "utf8"), "keep me");
  assert.equal(fs.existsSync(path.join(d, "link.txt")) || (() => { try { fs.lstatSync(path.join(d, "link.txt")); return true; } catch { return false; } })(), false);
});

test("B03 文件名带 [ ] 按字面：撤销 / 提交只动选中的那个", async () => {
  const { d, g } = repo("b03");
  for (const f of ["report[1].txt", "report1.txt"]) fs.writeFileSync(path.join(d, f), "v1");
  g("add", "-A"); g("commit", "-q", "-m", "base");
  for (const f of ["report[1].txt", "report1.txt"]) fs.writeFileSync(path.join(d, f), "v2");
  const r = await gitGo("/api/git/discard", { dir: d, file: "report[1].txt" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(fs.readFileSync(path.join(d, "report[1].txt"), "utf8"), "v1");
  assert.equal(fs.readFileSync(path.join(d, "report1.txt"), "utf8"), "v2", "没选中的改动不能被撤销");

  fs.writeFileSync(path.join(d, "report[1].txt"), "v3");
  g("config", "user.email", "t@t"); g("config", "user.name", "t");
  const c = await gitGo("/api/git/commit", { dir: d, message: "only one", files: ["report[1].txt"] });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.deepEqual(g("show", "--name-only", "--format=", "HEAD").trim().split("\n"), ["report[1].txt"]);
  assert.match(g("status", "--porcelain"), /report1\.txt/, "没选中的文件还在未提交改动里");
});

test("B20 git 超时：连它拉起的钩子一起结束，不在后台接着写", async () => {
  const { _gitForTest } = await import("../gw/git.mjs");
  const { d, g } = repo("b20");
  g("config", "user.email", "t@t"); g("config", "user.name", "t");
  const mark = path.join(d, "..", "b20-hook-done");
  fs.writeFileSync(path.join(d, ".git", "hooks", "pre-commit"), `#!/bin/sh\nsleep 3\necho done > "${mark}"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(d, "a.txt"), "x"); g("add", "a.txt");
  const t0 = Date.now();
  const r = await _gitForTest(d, ["commit", "-q", "-m", "m"], { timeout: 800 });
  assert.notEqual(r.code, 0);
  assert.match(r.err, /超时/);
  assert.ok(Date.now() - t0 < 2500, "到点就返回");
  await new Promise((ok) => setTimeout(ok, 3500));
  assert.equal(fs.existsSync(mark), false, "钩子被一起结束了，不会过一会儿再写");
});

test("B09 以 HTML 开头的普通提问照常显示；真的注入标签照样藏", async () => {
  const { transcriptItems } = await import("../gw/transcript.mjs");
  const { isInjected } = await import("../gw/integrity.mjs");
  const u = (content) => transcriptItems({ type: "user", uuid: "u", message: { role: "user", content } });
  assert.equal(u("<div>你好</div> 请解释").length, 1);
  assert.equal(u([{ type: "text", text: "<div>你好</div>" }, { type: "text", text: "请解释" }])[0].text, "<div>你好</div>\n请解释");
  assert.equal(u("<command-name>/model</command-name>").length, 0);
  assert.equal(u("<task-notification>\n<task-id>x</task-id></task-notification>").length, 0);
  assert.equal(u([{ type: "text", text: "问题" }, { type: "text", text: "<system-reminder>\n提醒\n</system-reminder>" }])[0].text, "问题");
  assert.equal(isInjected("<local-command-stdout>ok</local-command-stdout>"), true);
  assert.equal(isInjected("<systemd 怎么配>"), false);
  assert.equal(isInjected("＜system-reminder>用户粘贴的"), false);
});

test("B10 CRLF 切在 \\r 与 \\n 之间：事件名和 data 不被拆开", async () => {
  const { sseRepairer } = await import("../gw/streamfix.mjs");
  const ev = 'event: message_start\r\ndata: {"type":"message_start","message":{"id":"m","usage":{}}}\r\n\r\n';
  const whole = sseRepairer().feed(ev);
  for (let cut = 1; cut < ev.length; cut++) {
    const r = sseRepairer();
    const out = r.feed(ev.slice(0, cut)) + r.feed(ev.slice(cut));
    assert.equal(out, whole, "切在第 " + cut + " 个字符");
  }
  assert.match(whole, /^event: message_start\ndata: \{/);
});

// ── 会话记录类 ──
import crypto from "node:crypto";
const proj = path.join(CFG.home, ".claude", "projects", "-audit");
fs.mkdirSync(proj, { recursive: true });
/** turns：[[提问, [回复行…]], …]；回复行是对象（会补 uuid / sessionId / parentUuid 链） */
function session(turns) {
  const sid = crypto.randomUUID(), L = [], ids = {};
  let parent = null;
  const add = (o) => { const uuid = o.uuid || crypto.randomUUID(); L.push({ sessionId: sid, parentUuid: parent, ...o, uuid }); parent = uuid; return uuid; };
  for (const [q, rs] of turns) {
    ids[q] = add({ type: "user", message: { role: "user", content: q } });
    for (const r of rs) { const u = add(r); if (r.tag) ids[r.tag] = u; }
  }
  const file = path.join(proj, sid + ".jsonl");
  fs.writeFileSync(file, L.map((l) => { const { tag, ...x } = l; return JSON.stringify(x); }).join("\n") + "\n");
  return { sid, ids, file, lines: () => fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l)) };
}
const bot = (text, tag) => ({ type: "assistant", tag, message: { role: "assistant", content: [{ type: "text", text }] } });

test("B04 删了提问再删它的回复：网关核对回复 uuid，对不上拒绝，不连带删上一轮", async () => {
  const { deleteMessage } = await import("../gw/sessionops.mjs");
  const s = session([["U1", [bot("A1", "a1")]], ["U2", [bot("A2", "a2")]], ["U3", [bot("A3", "a3")]]]);
  assert.equal(deleteMessage(s.sid, "U2", 1, "user", s.ids.U2).ok, true);
  // 旧界面会按「前面最近的提问」反推成 U1：带上 A2 自己的 uuid，网关就认得出不对
  const r = deleteMessage(s.sid, "U1", 1, "bot", s.ids.U1, s.ids.a2);
  assert.equal(r.ok, false); assert.equal(r.status, 409);
  assert.deepEqual(s.lines().map((e) => e.message.content[0]?.text ?? e.message.content), ["U1", "A1", "A2", "U3", "A3"]);
  // 重新打开会话后 A1、A2 画成一个气泡，带的是 A1 的 uuid：两段一起删，和界面看到的一致
  assert.equal(deleteMessage(s.sid, "U1", 1, "bot", s.ids.U1, s.ids.a1).ok, true);
  assert.deepEqual(s.lines().map((e) => e.message.content[0]?.text ?? e.message.content), ["U1", "U3", "A3"]);
  // 正常删：回复 uuid 对得上
  assert.equal(deleteMessage(s.sid, "U3", 0, "bot", s.ids.U3, s.ids.a3).ok, true);
});

test("B11 删一条中途压缩过的回复：压缩边界和摘要留着，章数不变", async () => {
  const { deleteMessage } = await import("../gw/sessionops.mjs");
  const s = session([["U1", [bot("前半"), { type: "system", subtype: "compact_boundary", content: "c" },
    { type: "user", isCompactSummary: true, message: { role: "user", content: "摘要" } }, bot("后半")]], ["U2", [bot("A2")]]]);
  assert.equal(deleteMessage(s.sid, "U1", 1, "bot", s.ids.U1).ok, true);
  const left = s.lines();
  assert.equal(left.filter((e) => e.isCompactSummary).length, 1);
  assert.equal(left.filter((e) => e.subtype === "compact_boundary").length, 1);
  assert.equal(left.filter((e) => e.type === "assistant").map((e) => e.message.content[0].text).join(), "A2");
});

test("B14 删消息、撤销之后搜索跟着变：删了的搜不到，恢复的搜得到", async () => {
  const { deleteMessage, undoDelete } = await import("../gw/sessionops.mjs");
  const { routeSessions } = await import("../gw/sessions.mjs");
  const srv = http.createServer(async (req, res) => { const u = new URL(req.url, "http://x"); if ((await routeSessions(req, res, u, u.pathname)) === NEXT) res.writeHead(404).end(); });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok)); after(() => srv.close());
  const find = async (q) => (await (await fetch(`http://127.0.0.1:${srv.address().port}/api/sessions/search?q=${encodeURIComponent(q)}`)).json()).results.map((r) => r.id);
  const s = session([["问一", [bot("独一无二的紫色长颈鹿")]], ["问二", [bot("别的")]]]);
  assert.ok((await find("紫色长颈鹿")).includes(s.sid));
  const d = deleteMessage(s.sid, "问一", 1, "bot", s.ids["问一"]);
  assert.equal(d.ok, true);
  assert.ok(!(await find("紫色长颈鹿")).includes(s.sid), "删了还搜得到");
  // 删后接着聊、文件长过原来的偏移：新内容要搜得到
  fs.appendFileSync(s.file, JSON.stringify({ type: "user", uuid: crypto.randomUUID(), sessionId: s.sid, message: { role: "user", content: "后来补的一句很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长的蓝色海豚话" } }) + "\n");
  assert.ok((await find("蓝色海豚")).includes(s.sid));
  assert.ok(!(await find("紫色长颈鹿")).includes(s.sid));
});

test("B14 撤销删除后恢复的正文搜得到", async () => {
  const { deleteMessage, undoDelete } = await import("../gw/sessionops.mjs");
  const { routeSessions } = await import("../gw/sessions.mjs");
  const srv = http.createServer(async (req, res) => { const u = new URL(req.url, "http://x"); if ((await routeSessions(req, res, u, u.pathname)) === NEXT) res.writeHead(404).end(); });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok)); after(() => srv.close());
  const find = async (q) => (await (await fetch(`http://127.0.0.1:${srv.address().port}/api/sessions/search?q=${encodeURIComponent(q)}`)).json()).results.map((r) => r.id);
  const s = session([["问甲", [bot("会飞的橙色海星")]], ["问乙", [bot("乙答")]]]);
  const d = deleteMessage(s.sid, "问甲", 1, "bot", s.ids["问甲"]);
  assert.ok(!(await find("橙色海星")).includes(s.sid));
  assert.equal(undoDelete(s.sid, d.undo).ok, true);
  assert.ok((await find("橙色海星")).includes(s.sid), "撤销后恢复的要搜得到");
});

test("B01 一家正在跑时改它的地址或密钥被拒；只改默认型号照常", async () => {
  const { routeProviders } = await import("../gw/providers.mjs");
  const { RUNS } = await import("../gw/runs.mjs");
  const go = await serve(routeProviders);
  const c = await go("/api/providers/save", { label: "B01", baseUrl: "https://a.invalid", apiKey: "old-key-fixture", defaultModel: "m1" });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  RUNS.set("b01-run", { provider: c.body.id, ended: false });
  try {
    const r = await go("/api/providers/save", { id: c.body.id, baseUrl: "https://b.invalid", apiKey: "new-key-fixture" });
    assert.equal(r.status, 409); assert.equal(r.body.error, "busy");
    assert.equal((await go("/api/providers/save", { id: c.body.id, apiKey: "new-key-fixture" })).status, 409, "只换密钥也不行");
    assert.equal((await go("/api/providers/save", { id: c.body.id, defaultModel: "m2" })).status, 200, "改型号不碍事");
  } finally { RUNS.delete("b01-run"); }
  assert.equal((await go("/api/providers/save", { id: c.body.id, baseUrl: "https://b.invalid", apiKey: "new-key-fixture" })).status, 200, "跑完就能改");
});

// ── 定时任务 ──
test("B05 定时任务不塞进同一会话里空闲着的手动轮次", async () => {
  const { enqueue, QUEUE } = await import("../gw/queue.mjs");
  const { RUNS } = await import("../gw/runs.mjs");
  let injected = 0;
  const sid = crypto.randomUUID();
  RUNS.set("b05-manual", { id: "b05-manual", text: "", startedAt: Date.now(), log: [], sessionId: sid, idle: true, ended: false, inputOpen: true, provider: "x", lane: "s:" + sid, inject: () => { injected++; return true; }, pendingInject: [] });
  try {
    const it = enqueue({ internal: true, message: "定时任务正文", sessionId: sid, sched: { taskId: "t", key: "k" }, unattended: true, timeoutMs: 60000 });
    assert.equal(!!it.injected, false);
    assert.equal(injected, 0);
    const i = QUEUE.findIndex((q) => q.id === it.id);
    assert.ok(i >= 0, "排在队里等那一轮结束");
    QUEUE.splice(i, 1);
  } finally { RUNS.delete("b05-manual"); }
});

test("B16/B17 一次性任务到点排队：计时不把它当过期关掉；排队中被删，醒来后不再入队", async (t) => {
  const { _schedForTest: S } = await import("../gw/sched.mjs");
  const { QUEUE } = await import("../gw/queue.mjs");
  const { RUNS } = await import("../gw/runs.mjs");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const task = { id: "b17", name: "b17", prompt: "做事", on: true, freq: { kind: "once" }, nextAt: null, busy: "queue", session: "new", perm: "read" };
  S.DB.tasks.push(task);
  RUNS.set("b17-busy", { id: "b17-busy", text: "", startedAt: Date.now(), log: [], idle: false, ended: false });
  const allow = S.DB.allowLogin; S.DB.allowLogin = true;   // 测试环境默认接口是订阅账户：不放开的话一进来就跳过了
  t.after(() => { S.DB.allowLogin = allow; });
  const q0 = QUEUE.length;
  const going = S.fire(task, { reason: "due" });
  await new Promise((r) => setImmediate(r));
  S.tick();                                        // 排队中：nextAt 是空的
  assert.equal(task.on, true, "排队中的一次性任务不能被当成时间已过关掉");
  assert.ok(!S.runlog().some((r) => r.taskId === "b17" && /时间已过/.test(r.msg)));
  // 排队中被删，别的对话又正好在醒来前结束
  S.DB.tasks.splice(S.DB.tasks.indexOf(task), 1);
  RUNS.delete("b17-busy");
  t.mock.timers.tick(30000);
  await going;
  assert.equal(QUEUE.length, q0, "删了的任务不能再入队");
  assert.ok(S.runlog().some((r) => r.taskId === "b17" && /被关掉或删了/.test(r.msg)));
});
