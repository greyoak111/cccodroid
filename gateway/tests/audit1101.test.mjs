// 十路并发 Bug 审查（11-01）的回归测试：一条一个，编号对应报告 B01–B30
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
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
  const call = async (p, body) => { const r = await fetch(`http://127.0.0.1:${srv.address().port}${p}`, { method: "POST", body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  call.url = `http://127.0.0.1:${srv.address().port}`;
  return call;
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

test("B19 全局是第三方、某个会话单独用官方账户在跑：不许退出登录", async (t) => {
  const { routeLogin } = await import("../gw/login.mjs");
  const { RUNS } = await import("../gw/runs.mjs");
  const { providerById } = await import("../gw/providers.mjs");
  const login = ["anthropic", "claude"].map((id) => providerById(id)).find((p) => p && p.login);
  assert.ok(login, "找到官方账户那家");
  const { routeProviders, applyProvider } = await import("../gw/providers.mjs");
  const { SETTINGS } = await import("../gw/settings-store.mjs");
  // 全局切到一家第三方（用 Key 的），只让那个会话单独用官方账户
  const pg = await serve(routeProviders);
  const c = await pg("/api/providers/save", { label: "B19", baseUrl: "https://b19.invalid", apiKey: "k-fixture" });
  const was = SETTINGS.provider; SETTINGS.provider = c.body.id; applyProvider();
  t.after(() => { SETTINGS.provider = was; applyProvider(); });
  const go = await serve(routeLogin);
  RUNS.set("b19", { id: "b19", provider: login.id, ended: false });
  try {
    const r = await go("/api/login/logout", {});
    assert.equal(r.status, 409);
  } finally { RUNS.delete("b19"); }
});

test("B29 历史补算把子代理的 token 也算上（和实时统计同一口径）", async () => {
  const { routeUsage } = await import("../gw/usage.mjs");
  const go = await serve(routeUsage);
  const sid = crypto.randomUUID(), dir = path.join(CFG.home, ".claude", "projects", "-b29"), ts = "2026-01-02T03:04:05.000Z";
  fs.mkdirSync(path.join(dir, sid, "subagents"), { recursive: true });
  const asst = (id, i, o) => JSON.stringify({ type: "assistant", sessionId: sid, timestamp: ts, uuid: crypto.randomUUID(), message: { id, role: "assistant", model: "m-b29", usage: { input_tokens: i, output_tokens: o }, content: [{ type: "text", text: "x" }] } });
  fs.writeFileSync(path.join(dir, sid + ".jsonl"), [JSON.stringify({ type: "user", sessionId: sid, timestamp: ts, uuid: crypto.randomUUID(), message: { role: "user", content: "问" } }), asst("msg-main", 100, 20)].join("\n") + "\n");
  fs.writeFileSync(path.join(dir, sid, "subagents", "agent-a.jsonl"), JSON.stringify({ ...JSON.parse(asst("msg-sub", 300, 40)), isSidechain: true }) + "\n");
  assert.equal((await go("/api/usage/import", {})).status, 200);
  const h = String(Math.floor(Date.parse(ts) / 3600e3));
  const r = await (await fetch(go.url + "/api/usage")).json();
  assert.equal(r.hours[h].i, 400);
  assert.equal(r.hours[h].o, 60);
  assert.equal(r.hours[h].st[sid], 460);
});

test("B21 两个字体同时导入：两个都留下；导入中途删掉的不会被写回", async () => {
  const { routeFonts } = await import("../gw/fonts.mjs");
  const go = await serve(routeFonts);
  const port = go.url.split(":").pop();
  const font = (n) => Buffer.concat([Buffer.from([0, 1, 0, 0]), Buffer.alloc(12), Buffer.from("font-" + n)]);
  const list = async () => (await (await fetch(go.url + "/api/fonts")).json()).items.map((f) => f.file);
  const old = await (await fetch(go.url + "/api/fonts?name=old.ttf", { method: "POST", body: font("old") })).json();
  // 两个慢上传：先各发一半，再一起收尾
  const slow = (name, buf) => {
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/api/fonts?name=" + name, headers: { "content-length": buf.length } });
    const done = new Promise((ok) => req.on("response", (r) => { let s = ""; r.on("data", (d) => s += d).on("end", () => ok(JSON.parse(s))); }));
    req.write(buf.subarray(0, 8));
    return { finish: () => { req.end(buf.subarray(8)); return done; } };
  };
  const a = slow("a.ttf", font("a")), b = slow("b.ttf", font("b"));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await go("/api/fonts/del", { id: old.font.id })).status, 200);   // 上传途中删掉旧的
  await a.finish(); await b.finish();
  const now = await list();
  assert.ok(now.includes("a.ttf") && now.includes("b.ttf"), "两个都在：" + now);
  assert.ok(!now.includes("old.ttf"), "删掉的没被写回");
});

test("B22 多行说明的自定义命令：在界面里改了正文再保存，frontmatter 还是合法 YAML、其他项原样", async (t) => {
  // 用 yq 当独立的 YAML 解析器核对；没装的机器跳过（11-01 独立审查）
  if (spawnSync("yq", ["--version"]).error) return t.skip("没有 yq");
  const { commandRoutes, parseCmd } = await import("../gw/commands.mjs");
  const go = await serve(commandRoutes(() => []));
  const dir = path.join(process.env.HOME, ".claude", "commands");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "b22.md");
  fs.writeFileSync(file, "---\ndescription: |\n  第一行说明\n  第二行说明\nallowed-tools:\n  - Bash\n  - Read\n---\n旧正文\n");
  const c = parseCmd(fs.readFileSync(file, "utf8"));
  assert.equal(c.description, "第一行说明\n第二行说明");
  const r = await go("/api/commands/save", { scope: "user", name: "b22", description: c.description, body: "新正文" });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  const out = fs.readFileSync(file, "utf8"), fm = out.split("---\n")[1];
  const y = JSON.parse(execFileSync("yq", ["-o=json", "."], { input: fm, encoding: "utf8" }));
  assert.equal(y.description, "第一行说明 第二行说明");
  assert.deepEqual(y["allowed-tools"], ["Bash", "Read"]);
  assert.match(out, /新正文\n$/);
});

test("B15 会话包里的数据坏了：按 CRC 认出来，不导入；好的包照常导入", async () => {
  const { zipToFile, zipEntries } = await import("../gw/bigfile.mjs");
  const { importSessions } = await import("../gw/sessionops.mjs");
  const mk = (sid) => {
    const src = path.join(CFG.home, "b15-" + sid + ".jsonl");
    fs.writeFileSync(src, JSON.stringify({ type: "user", uuid: crypto.randomUUID(), sessionId: sid, message: { role: "user", content: "SYNTHETIC 原文".repeat(50) } }) + "\n");
    const man = path.join(CFG.home, "b15-man-" + sid + ".json");
    fs.writeFileSync(man, JSON.stringify({ format: "cccodroid-sessions", sessions: [{ id: sid }] }));
    return [{ name: "manifest.json", file: man }, { name: `sessions/${sid}.jsonl`, file: src }];
  };
  // 篡改：把会话那条的数据里能解开但内容变了的一个 bit 找出来
  const sidBad = crypto.randomUUID(), bad = path.join(CFG.home, "b15-bad.zip");
  await zipToFile(bad, mk(sidBad));
  const ent = zipEntries(bad).find((e) => e.name.endsWith(".jsonl"));
  const orig = fs.readFileSync(bad);
  let found = false;
  const zlib = await import("node:zlib");
  const good = zlib.inflateRawSync(orig.subarray(ent.data, ent.data + ent.csize));
  for (let i = ent.data; i < ent.data + ent.csize && !found; i++) for (let b = 0; b < 8 && !found; b++) {
    const t = Buffer.from(orig); t[i] ^= 1 << b;
    let out; try { out = zlib.inflateRawSync(t.subarray(ent.data, ent.data + ent.csize)); } catch { continue; }
    if (out.length === good.length && !out.equals(good)) { fs.writeFileSync(bad, t); found = true; }
  }
  assert.ok(found, "造出一个能解开但内容变了的包");
  await assert.rejects(importSessions(bad), /损坏/);
  assert.equal(fs.existsSync(path.join(CFG.home, ".claude", "projects")) && fs.readdirSync(path.join(CFG.home, ".claude", "projects"), { recursive: true }).some((f) => String(f).includes(sidBad)), false, "坏的没发布出来");
  const sidOk = crypto.randomUUID(), ok = path.join(CFG.home, "b15-ok.zip");
  await zipToFile(ok, mk(sidOk));
  assert.deepEqual((await importSessions(ok)).imported, [sidOk]);
});

test("B23 旧组件卸载：新底座已接管的同名文件留下，组件自己的照删", async () => {
  const { compRemove, COMP_DIR } = await import("../gw/components.mjs");
  const P = process.env.CCAPP_PREFIX, info = path.join(P, "var/lib/dpkg/info");
  fs.mkdirSync(info, { recursive: true });
  fs.mkdirSync(path.join(P, "bin"), { recursive: true });
  for (const f of ["bin/b23-demo", "bin/b23-own"]) fs.writeFileSync(path.join(P, f), "x");
  // 底座的包清单认领 bin/b23-demo；组件自己带的 .list 认领 bin/b23-own（不能算底座的）
  fs.writeFileSync(path.join(info, "b23-base.list"), `/data/data/cc.codroid/files/usr/bin/b23-demo\n`);
  fs.writeFileSync(path.join(info, "b23-comp.list"), `/data/data/cc.codroid/files/usr/bin/b23-own\n`);
  fs.mkdirSync(COMP_DIR, { recursive: true });
  fs.writeFileSync(path.join(COMP_DIR, "b23old.json"), JSON.stringify({ id: "b23old", files: ["bin/b23-demo", "bin/b23-own", "var/lib/dpkg/info/b23-comp.list"], shared: [] }));
  const r = await compRemove("b23old");
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(fs.existsSync(path.join(P, "bin/b23-demo")), "底座接管的文件不能删");
  assert.ok(!fs.existsSync(path.join(P, "bin/b23-own")), "组件自己的文件照删");
  assert.ok(!fs.existsSync(path.join(info, "b23-comp.list")));
  fs.rmSync(path.join(info, "b23-base.list"), { force: true });
  fs.rmSync(path.join(P, "bin/b23-demo"), { force: true });
});

test("B18 新会话只暂存了型号、项目默认另一家：界面预览和真跑认同一家", async () => {
  const { routeProviders } = await import("../gw/providers.mjs");
  const { PROJECTS } = await import("../gw/projects.mjs");
  const { effectiveModel } = await import("../gw/sessmodel.mjs");
  const { pickProvider } = await import("../gw/run.mjs");
  const go = await serve(routeProviders);
  const b = await go("/api/providers/save", { label: "B18", baseUrl: "https://b18.invalid", apiKey: "k-fixture", defaultModel: "b-model" });
  const dir = path.join(CFG.workspace, "b18proj"); fs.mkdirSync(dir, { recursive: true });
  PROJECTS.push({ id: "b18p", name: "b18", path: dir, model: "", effort: "", perm: "", provider: b.body.id });
  try {
    const pre = effectiveModel(null, "b18p", { model: "a-only" });
    const run = pickProvider({ projectId: "b18p", pin: { model: "a-only" } });
    assert.equal(pre.provider, run.P.id, "预览和运行要认同一家");
    // 带了厂商的选择：两边都按选的那家
    const g = effectiveModel(null, "b18p", { provider: run.P.id === b.body.id ? undefined : b.body.id, model: "x" });
    assert.ok(g.provider);
  } finally { PROJECTS.splice(PROJECTS.findIndex((p) => p.id === "b18p"), 1); }
});

test("复核 中-1/中-2 定时任务已入队：条目被 ✕ 掉不再一直「在跑」；入队后任务被删就不开跑", async (t) => {
  const { _schedForTest: S } = await import("../gw/sched.mjs");
  const { QUEUE, START_GUARDS } = await import("../gw/queue.mjs");
  const { RUNS, maxParallel } = await import("../gw/runs.mjs");
  const allow = S.DB.allowLogin; S.DB.allowLogin = true;
  // 并行占满：入队的条目留在队列里，不会真起 claude
  const fake = [];
  for (let i = 0; i < maxParallel(); i++) { const id = "dsk-busy" + i; fake.push(id); RUNS.set(id, { id, text: "", startedAt: Date.now(), log: [], idle: false, ended: false, lane: "x:" + i }); }
  t.after(() => { S.DB.allowLogin = allow; for (const id of fake) RUNS.delete(id); });
  const mk = (id) => { const task = { id, name: id, prompt: "做事", on: true, freq: { kind: "once" }, nextAt: null, busy: "run", session: "new", perm: "read" }; S.DB.tasks.push(task); return task; };
  // 中-1
  const a = mk("dsk-a");
  const ia = await S.fire(a, { reason: "due" });
  assert.ok(ia && QUEUE.includes(ia), "排在队列里");
  assert.ok(S.running().some((x) => x.taskId === "dsk-a"));
  QUEUE.splice(QUEUE.indexOf(ia), 1);            // 用户在队列里 ✕ 掉
  assert.ok(!S.running().some((x) => x.taskId === "dsk-a"), "队列里没了就不算在跑");
  S.tick();
  assert.equal(a.on, false, "一次性任务照常按时间已过关掉，不会冻住");
  // 中-2
  const b = mk("dsk-b");
  const ib = await S.fire(b, { reason: "due" });
  assert.ok(ib && QUEUE.includes(ib));
  S.DB.tasks.splice(S.DB.tasks.indexOf(b), 1);    // 入队之后删掉任务
  assert.equal(START_GUARDS.every((g) => g(ib) !== false), false, "开跑前要拦下");
  assert.ok(!S.running().some((x) => x.taskId === "dsk-b") || QUEUE.includes(ib));
  QUEUE.splice(QUEUE.indexOf(ib), 1);
  S.DB.tasks.splice(S.DB.tasks.indexOf(a), 1);
});
