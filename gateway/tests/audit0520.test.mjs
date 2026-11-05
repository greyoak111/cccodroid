// v0.5.20 十路审查（#95–#110）的回归测试：一条一个，编号对应 issue 里的条目号
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

function repo(name, files) {
  const d = path.join(CFG.workspace, "a0520-" + name);
  fs.mkdirSync(d, { recursive: true });
  const g = (...a) => execFileSync("git", a, { cwd: d, encoding: "utf8" });
  g("init", "-q"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
  for (const [f, v] of Object.entries(files)) fs.writeFileSync(path.join(d, f), v);
  g("add", "-A"); g("commit", "-q", "-m", "base");
  return { d, g, w: (f, v) => fs.writeFileSync(path.join(d, f), v), has: (f) => fs.existsSync(path.join(d, f)) };
}
const headFiles = (g) => g("ls-tree", "--name-only", "HEAD").trim().split("\n").sort();

test("07-011 ..notes.txt 是正常文件名：只提交它，没选的留着", async () => {
  const { d, g, w } = repo("dots", { "base.txt": "b" });
  w("..notes.txt", "n"); w("ordinary.txt", "o");
  const c = await gitGo("/api/git/commit", { dir: d, message: "m", files: ["..notes.txt"] });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.deepEqual(g("show", "--name-only", "--format=", "HEAD").trim().split("\n"), ["..notes.txt"]);
  assert.match(g("status", "--porcelain"), /ordinary\.txt/);
});

test("07-011 给了清单但为空 / 有一项在仓库外：拒绝，不退化成全仓提交", async () => {
  const { d, g, w } = repo("empty", { "base.txt": "b" });
  w("x.txt", "x");
  const head = g("rev-parse", "HEAD");
  for (const files of [[], ["../outside.txt"], ["x.txt", "../outside.txt"]]) {
    const c = await gitGo("/api/git/commit", { dir: d, message: "m", files });
    assert.equal(c.status, 400, JSON.stringify(files));
  }
  assert.equal(g("rev-parse", "HEAD"), head);
});

test("07-003 只选暂存的重命名：旧路径的删除一起提交，没选的修改留着", async () => {
  const { d, g, w } = repo("ren", { "old.txt": "same content\n".repeat(5), "other.txt": "o" });
  g("mv", "old.txt", "new.txt"); w("other.txt", "o2");
  const c = await gitGo("/api/git/commit", { dir: d, message: "m", files: ["new.txt"] });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.deepEqual(headFiles(g), ["new.txt", "other.txt"]);
  assert.equal(g("status", "--porcelain").trim(), "M other.txt");
});

test("07-004 撤销已暂存的新文件：取消跟踪并删掉", async () => {
  const { d, g, w, has } = repo("added", { "base.txt": "b" });
  w("new.txt", "n"); g("add", "new.txt");
  const r = await gitGo("/api/git/discard", { dir: d, file: "new.txt" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(has("new.txt"), false);
  assert.equal(g("status", "--porcelain").trim(), "");
});

test("07-004 撤销已暂存的重命名：旧文件回来，新名字没了", async () => {
  const { d, g, has } = repo("unren", { "old.txt": "same content\n".repeat(5) });
  g("mv", "old.txt", "new.txt");
  const r = await gitGo("/api/git/discard", { dir: d, file: "new.txt" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(has("new.txt"), false);
  assert.equal(fs.readFileSync(path.join(d, "old.txt"), "utf8"), "same content\n".repeat(5));
  assert.equal(g("status", "--porcelain").trim(), "");
});

test("07-004 撤销重命名时旧名那里又有了文件：动手前就拒绝，不拆一半", async () => {
  const { d, g, w, has } = repo("unren2", { "old.txt": "same content\n".repeat(5) });
  g("mv", "old.txt", "new.txt"); w("old.txt", "我后来又建的");
  const st = g("status", "--porcelain");
  const r = await gitGo("/api/git/discard", { dir: d, file: "new.txt" });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(has("new.txt"), true);
  assert.equal(fs.readFileSync(path.join(d, "old.txt"), "utf8"), "我后来又建的");
  assert.equal(g("status", "--porcelain"), st);
});

test("07-004 撤销给的是已暂存的目录：拒绝，不清了索引才报错", async () => {
  const { d, g, w } = repo("dir", { "base.txt": "b" });
  fs.mkdirSync(path.join(d, "sub")); w("sub/x.txt", "x"); g("add", "sub");
  const st = g("status", "--porcelain");
  const r = await gitGo("/api/git/discard", { dir: d, file: "sub" });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(g("status", "--porcelain"), st);
});

test("撤销普通修改照旧：改回上次提交", async () => {
  const { d, g, w } = repo("mod", { "a.txt": "v1" });
  w("a.txt", "v2");
  const r = await gitGo("/api/git/discard", { dir: d, file: "a.txt" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(fs.readFileSync(path.join(d, "a.txt"), "utf8"), "v1");
  assert.equal(g("status", "--porcelain").trim(), "");
});

// ── 会话搬动/恢复/导入/建档：失败不能留半截（#98）。故障注入：只让特定的 rename 失败 ──
import crypto from "node:crypto";
import { PATHS } from "../gw/config.mjs";
function failRename(when, fn) {
  const orig = fs.renameSync;
  fs.renameSync = (a, b) => { if (when(String(a), String(b))) { const e = new Error("EIO: injected"); e.code = "EIO"; throw e; } return orig(a, b); };
  try { return fn(); } finally { fs.renameSync = orig; }
}
async function failRenameAsync(when, fn) {
  const orig = fs.renameSync;
  fs.renameSync = (a, b) => { if (when(String(a), String(b))) { const e = new Error("EIO: injected"); e.code = "EIO"; throw e; } return orig(a, b); };
  try { return await fn(); } finally { fs.renameSync = orig; }
}
function sessionWithSide(projDir) {
  const sid = crypto.randomUUID(), d = path.join(PATHS.projects, projDir);
  fs.mkdirSync(path.join(d, sid, "subagents"), { recursive: true });
  fs.writeFileSync(path.join(d, sid + ".jsonl"), JSON.stringify({ type: "user", uuid: crypto.randomUUID(), sessionId: sid, cwd: "/x", message: { role: "user", content: "hi" } }) + "\n");
  fs.writeFileSync(path.join(d, sid, "subagents", "agent-1.jsonl"), "{}\n");
  return { sid, d };
}

test("03-003 搬会话时附件目录搬不过去：报错，原会话和附件原样留着", async () => {
  const { moveSession } = await import("../gw/projects.mjs");
  const { findSessionFile } = await import("../gw/sessions.mjs");
  const { sid, d } = sessionWithSide("-a0520-move");
  assert.throws(() => failRename((a) => a === path.join(d, sid), () => moveSession(sid, null)), /没搬过去/);
  assert.equal(findSessionFile(sid).file, path.join(d, sid + ".jsonl"));
  assert.ok(fs.existsSync(path.join(d, sid, "subagents", "agent-1.jsonl")));
  // 正常再搬一次：两部分一起过去
  assert.equal(moveSession(sid, null).ok, true);
  const nf = findSessionFile(sid).file;
  assert.notEqual(path.dirname(nf), d);
  assert.ok(fs.existsSync(path.join(path.dirname(nf), sid, "subagents", "agent-1.jsonl")));
  assert.equal(fs.existsSync(path.join(d, sid)), false);
});

test("03-014 回收站恢复：附件放不回去不动主记录；主记录放不回去附件退回回收站；都能再点恢复", async () => {
  const ops = await import("../gw/sessionops.mjs");
  const { findSessionFile } = await import("../gw/sessions.mjs");
  const { sid, d } = sessionWithSide("-a0520-trash");
  assert.equal(ops.trashSession(sid).ok, true);
  assert.throws(() => failRename((a) => a.endsWith(path.join(sid, "dir")), () => ops.restoreSession(sid)));
  assert.equal(findSessionFile(sid), null);
  assert.ok(ops.listTrash().some((m) => m.id === sid));
  assert.throws(() => failRename((a) => a.endsWith(sid + ".jsonl"), () => ops.restoreSession(sid)));
  assert.equal(findSessionFile(sid), null);
  assert.ok(ops.listTrash().some((m) => m.id === sid), "附件退回去了，这格照旧列着");
  assert.equal(ops.restoreSession(sid).ok, true);
  assert.ok(fs.existsSync(path.join(d, sid, "subagents", "agent-1.jsonl")));
});

test("03-014 旧版留下的半截（主记录已回去、附件还在回收站）：再点恢复把附件补回去", async () => {
  const ops = await import("../gw/sessionops.mjs");
  const { sid, d } = sessionWithSide("-a0520-half");
  assert.equal(ops.trashSession(sid).ok, true);
  const slot = path.join(CFG.home, ".ccapp-trash", sid);
  fs.renameSync(path.join(slot, sid + ".jsonl"), path.join(d, sid + ".jsonl"));   // 模拟旧版：主记录先回去了
  assert.equal(ops.restoreSession(sid).ok, true);
  assert.ok(fs.existsSync(path.join(d, sid, "subagents", "agent-1.jsonl")));
  assert.equal(fs.existsSync(slot), false);
});

test("03-002 导入时后一条出错：前面放好的那条标题照样落盘，并报出放好了哪些", async () => {
  const { zipToFile } = await import("../gw/bigfile.mjs");
  const { importSessions } = await import("../gw/sessionops.mjs");
  const a = crypto.randomUUID(), b = crypto.randomUUID(), files = [];
  for (const sid of [a, b]) {
    const src = path.join(CFG.home, "a0520-" + sid + ".jsonl");
    fs.writeFileSync(src, JSON.stringify({ type: "user", uuid: crypto.randomUUID(), sessionId: sid, message: { role: "user", content: "x" } }) + "\n");
    files.push({ name: `sessions/${sid}.jsonl`, file: src });
  }
  const man = path.join(CFG.home, "a0520-man.json");
  fs.writeFileSync(man, JSON.stringify({ format: "cccodroid-sessions", sessions: [{ id: a, renamed: true, title: "我起的名字" }, { id: b }] }));
  const zip = path.join(CFG.home, "a0520-imp.zip");
  await zipToFile(zip, [{ name: "manifest.json", file: man }, ...files]);
  const err = await failRenameAsync((x) => x.endsWith(b + ".jsonl.part"), () => importSessions(zip).then(() => null, (e) => e));
  assert.ok(err, "第二条应当出错");
  assert.deepEqual(err.imported, [a]);
  assert.equal(JSON.parse(fs.readFileSync(PATHS.names, "utf8"))[a], "我起的名字");
});

test("03-007 建档存不上：内存不留没存上的题名和用户锁，AI 之后还能交", async () => {
  const { fileChapter } = await import("../gw/archive.mjs");
  const { archiveDb } = await import("../gw/archive-store.mjs");
  const { sid } = sessionWithSide("-a0520-arch");
  assert.equal((await fileChapter(sid, { title: "接手网关修复并验证", chapter: 1 })).ok, true);
  const before = JSON.stringify(archiveDb().sessions[sid]);
  const r = await failRenameAsync((x) => x.endsWith("ccapp-archive.json.tmp"), () => fileChapter(sid, { title: "用户改的题名", chapter: 1, by: "user" }));
  assert.equal(r.ok, false);
  assert.equal(JSON.stringify(archiveDb().sessions[sid]), before);
  assert.equal((await fileChapter(sid, { title: "整理组件技能冲突", chapter: 1 })).ok, true);
});

test("02-005 新会话首条结束后，跟着它排的消息落盘时补上会话号，重启后还认得原会话", async () => {
  const { QUEUE, RUN_SESSIONS, saveRunMark } = await import("../gw/queue.mjs");
  const s = crypto.randomUUID();
  RUN_SESSIONS.set("r-a0520-first", s);
  QUEUE.push({ id: "q-a0520", message: "第二条", follow: "r-a0520-first", sessionId: null, held: true, at: Date.now() });
  try {
    saveRunMark();
    const m = JSON.parse(fs.readFileSync(path.join(CFG.home, "ccapp-run-mark.json"), "utf8"));
    assert.equal(m.queue.find((q) => q.id === "q-a0520").sessionId, s);
  } finally {
    QUEUE.splice(QUEUE.findIndex((q) => q.id === "q-a0520"), 1); RUN_SESSIONS.delete("r-a0520-first");
    fs.rmSync(path.join(CFG.home, "ccapp-run-mark.json"), { force: true });
  }
});

test("04-010 auth status 问不出结果：不当成未登录；有上次问出的就沿用并标旧", async () => {
  const login = await import("../gw/login.mjs");
  const prev = PATHS.claudeLoader;
  PATHS.claudeLoader = path.join(CFG.home, "no-such-loader");
  try {
    const v = await login.authStatus(true);
    assert.equal(v.unknown, true);
    assert.match(v.error, /ENOENT/);
  } finally { PATHS.claudeLoader = prev; }
});

test("04-010 复核 #2：退出码 0 但解析不出 loggedIn 也不算未登录；JSON 后面夹着警告照样认", async () => {
  const login = await import("../gw/login.mjs");
  const prev = PATHS.claudeLoader, fake = path.join(CFG.home, "fake-auth.sh");
  const sh = fs.existsSync("/system/bin/sh") ? "/system/bin/sh" : "/bin/sh";
  try {
    PATHS.claudeLoader = fake;
    fs.writeFileSync(fake, `#!${sh}\nprintf %s "{\\"loggedIn\\": true, \\"authMethod\\": \\"claude.ai\\"}"\necho\necho "warning: } something"\nexit 0\n`, { mode: 0o700 });
    const ok = await login.authStatus(true);
    assert.equal(ok.loggedIn, true, JSON.stringify(ok));
    fs.writeFileSync(fake, `#!${sh}\necho "{garbled"\nexit 0\n`, { mode: 0o700 });
    const v = await login.authStatus(true);
    assert.equal(v.stale, true, JSON.stringify(v));
    assert.equal(v.loggedIn, true, "沿用上次问出的");
    fs.writeFileSync(fake, `#!${sh}\necho "Not logged in"\nexit 1\n`, { mode: 0o700 });
    const no = await login.authStatus(true);
    assert.equal(no.loggedIn, false);
    assert.equal(!!no.stale, false, "明说没登录就是确定的");
  } finally { PATHS.claudeLoader = prev; fs.rmSync(fake, { force: true }); }
});

test("04-011 首次补算：since 所在小时里 since 之前的消息也补上，重补不重复", async () => {
  const { routeUsage } = await import("../gw/usage.mjs");
  const srv = http.createServer(async (req, res) => { const u = new URL(req.url, "http://x"); if ((await routeUsage(req, res, u, u.pathname)) === NEXT) res.writeHead(404).end(); });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  after(() => srv.close());
  const url = `http://127.0.0.1:${srv.address().port}`;
  const post = async (op, b = {}) => (await fetch(url + "/api/usage/" + op, { method: "POST", body: JSON.stringify(b) })).json();
  const get = async () => (await fetch(url + "/api/usage")).json();
  await post("clear", { all: true });                 // since = 现在
  const { since } = await get(), h = Math.floor(since / 3600e3), hourStart = h * 3600e3;
  if (since - hourStart < 2000) return;              // 正好整点：没有交界可测
  const sid = crypto.randomUUID(), dir = path.join(PATHS.projects, "-a0520-usage");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, sid + ".jsonl"), JSON.stringify({ type: "user", sessionId: sid, timestamp: new Date(hourStart + 1000).toISOString(), uuid: crypto.randomUUID(), message: { role: "user", content: "交界小时的提问" } }) + "\n");
  const r = await post("import");
  assert.ok(r.prompts >= 1, JSON.stringify(r));
  assert.equal((await get()).hours[h].m, 1);
  await post("import");
  assert.equal((await get()).hours[h].m, 1, "重补不重复加");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("04-009 账本换币种：旧消费不贴上新币种（没汇率时旧账本另存，从零记）", async () => {
  const { _billForTest: B } = await import("../gw/providers.mjs");
  const id = "a0520-cur";
  B.noteBalance(id, "CNY", 100); B.noteBalance(id, "CNY", 90);
  assert.equal(B.billOf(id).spends.reduce((a, x) => a + x[1], 0), 10);
  B.noteBalance(id, "USD", 20);
  const b = B.billOf(id);
  assert.equal(b.currency, "USD");
  assert.equal(b.spends.length + b.spentOld, 0, "旧的 10 元不能当成 10 美元");
  assert.deepEqual(b.oldLedgers.map((x) => [x.currency, x.spent]), [["CNY", 10]]);
});
