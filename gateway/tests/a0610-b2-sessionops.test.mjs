// 0.6.10 车道 b2：会话删除 / 回收站 / 恢复 / 导出导入 / 彻底删除（195-A.1/A.5/A.7/A.10/A.14、197-2.2/2.3/2.4、197-9.9、200-8-04、196-真机.1/2、195-Y.2/Y.3/Y.5/Y.6）
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { CFG, PATHS } from "../gw/config.mjs";
import { NAMES, PINS, findSessionFile, routeSessions, saveNames, savePins, sessionPresence } from "../gw/sessions.mjs";
import { LAST_SESSION, TRASH_HOOKS, rememberSession } from "../gw/runs.mjs";
import * as ops from "../gw/sessionops.mjs";
import { archiveDb, archiveImport, saveArchive } from "../gw/archive-store.mjs";
import * as sessmodel from "../gw/sessmodel.mjs";
import * as integration from "../gw/integrity.mjs";
import { lineageDb, recordPrimary } from "../gw/lineage-store.mjs";

const TRASH = path.join(CFG.home, ".ccapp-trash"), EDITS = path.join(TRASH, ".edits");
const slotOf = (id) => path.join(TRASH, id);
const metaOf = (id) => path.join(slotOf(id), "meta.json");
const insideOf = (id) => path.join(slotOf(id), id + ".jsonl");
// 共用临时 home：跑完清掉本测试留下的会话（含恢复/导入回去的），别影响后面的用量补算
after(() => fs.rmSync(path.join(PATHS.projects, "-b2-ops"), { recursive: true, force: true }));
const ORPHANS = path.join(CFG.home, "ccapp-session-orphans.json");
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const uid = () => crypto.randomUUID();

function makeSession({ cwd = CFG.workspace, q = "这一轮的问题", q2 = "" } = {}) {
  const sid = crypto.randomUUID();
  const dir = path.join(PATHS.projects, "-b2-ops");
  fs.mkdirSync(dir, { recursive: true });
  const turn = (text, parent = null) => {
    const u = { type: "user", sessionId: sid, uuid: uid(), parentUuid: parent, cwd, timestamp: new Date().toISOString(), message: { role: "user", content: text } };
    const a = { type: "assistant", sessionId: sid, uuid: uid(), parentUuid: u.uuid, cwd, timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "回答" }] } };
    return [u, a];
  };
  const first = turn(q);
  const lines = [...first];
  let last = first;
  if (q2) { last = turn(q2, first[1].uuid); lines.push(...last); }
  const file = path.join(dir, sid + ".jsonl");
  fs.writeFileSync(file, lines.map((x) => JSON.stringify(x)).join("\n") + "\n");
  return { sid, file, aUuid: first[1].uuid, a2Uuid: q2 ? last[1].uuid : null, q, q2 };
}

// ── 删消息 ──
test("删提问后记下回复起点并落盘；仍拒绝单独删那条回复；撤销后清掉（195-A.1）", () => {
  const s = makeSession({ q: "第一问", q2: "第二问" });
  const r = ops.deleteMessage(s.sid, s.q2, 0, "user");
  assert.equal(r.ok, true);
  const saved = readJson(ORPHANS);
  assert.ok(saved[s.sid]?.includes(s.a2Uuid), "回复起点要写进盘上的表");
  // 界面把上一问当成这一气泡的提问：记录里却连着上一轮的回复，按轮删会带走它 → 要拒绝
  const again = ops.deleteMessage(s.sid, s.q, 0, "bot", "", s.a2Uuid);
  assert.equal(again.ok, false);
  assert.equal(again.status, 409);
  assert.match(again.message, /提问已经删掉/);
  assert.equal(ops.undoDelete(s.sid, r.undo).ok, true);
  const after = readJson(ORPHANS);
  assert.equal(after[s.sid], undefined, "撤销后这一格要清掉");
});

test("删消息备份有顶：每个会话只留最近 20 份（195-A.10）", () => {
  const s = makeSession({ q: "要删的提问" });
  fs.mkdirSync(EDITS, { recursive: true });
  for (let i = 0; i < 25; i++) fs.writeFileSync(path.join(EDITS, `${s.sid}.${Date.now() - 100000 + i}.jsonl`), "x");
  assert.equal(ops.deleteMessage(s.sid, s.q, 0, "user").ok, true);
  const mine = fs.readdirSync(EDITS).filter((n) => n.startsWith(s.sid + "."));
  assert.ok(mine.length <= 20, `留下了 ${mine.length} 份`);
  assert.ok(mine.some((n) => fs.readFileSync(path.join(EDITS, n), "utf8").includes("要删的提问")), "新备份不能被自己删掉");
});

test("会话文件不在时删消息回错误而不是抛（200-8-04 的异常路径）", () => {
  const s = makeSession({ q: "x" });
  fs.rmSync(s.file);
  let r;
  assert.doesNotThrow(() => { r = ops.deleteMessage(s.sid, "x", 0, "user"); });
  assert.equal(r.ok, false);
});

// ── 回收站 ──
const diskError = () => Object.assign(new Error("测试磁盘 I/O 错误"), { code: "EIO" });
function failRename(t, when) {
  const rename = fs.renameSync;
  return t.mock.method(fs, "renameSync", (a, b) => { if (when(a, b)) throw diskError(); return rename(a, b); });
}
function withSide(s) {
  const side = path.join(path.dirname(s.file), s.sid), extra = path.join(side, "data.txt");
  fs.mkdirSync(side);
  fs.writeFileSync(extra, "附件");
  return { ...s, side, extra, text: fs.readFileSync(s.file, "utf8") };
}
async function request(route, method, url, body) {
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { method });
  const u = new URL(url, "http://fixture.invalid");
  let code, data;
  await route(req, { writeHead(c) { code = c; }, end(b) { data = JSON.parse(b); } }, u, u.pathname);
  return { code, ...data };
}
// 子进程只用 runner 的临时 HOME/前缀：真实换名后在指定位置退出，绕过异常回滚，模拟中断。
function interrupt(sid, action, method, file) {
  const code = `import fs from 'node:fs';
    const ops = await import(${JSON.stringify(new URL("../gw/sessionops.mjs", import.meta.url).href)});
    const [sid, action, method, file] = JSON.parse(process.argv[1]);
    const run = fs[method];
    fs[method] = (...args) => {
      const result = run(...args);
      if (args[method === 'renameSync' && action === 'trashSession' ? 1 : 0] === file) process.exit(97);
      return result;
    };
    await ops[action](action === 'purgeTrash' ? [sid] : sid);
    process.exit(98);`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code, JSON.stringify([sid, action, method, file])], { encoding: "utf8", timeout: 8000 });
  assert.equal(r.status, 97, r.stderr || String(r.error ?? "没走到中断点"));
}

test("回收失败保留正文、附件和状态；连回滚也失败则由恢复收口", (t) => {
  const seen = [];
  TRASH_HOOKS.push((id) => seen.push(id));
  try {
    for (const at of ["meta", "main", "side", "rollback"]) {
      const s = withSide(makeSession());
      NAMES[s.sid] = "保留标题"; PINS[s.sid] = 314;
      assert(saveNames()); assert(savePins());
      const fail = failRename(t, (a, b) => at === "meta" ? b === metaOf(s.sid) : at === "main" ? a === s.file :
        a === s.side || (at === "rollback" && a === insideOf(s.sid)));
      if (at === "meta") assert.equal(ops.trashSession(s.sid).error, "write_failed");
      else assert.throws(() => ops.trashSession(s.sid), /磁盘 I\/O/);
      fail.mock.restore();
      assert.deepEqual(seen, []);
      if (at === "rollback") {
        assert.equal(fs.readFileSync(insideOf(s.sid), "utf8"), s.text);
        assert.equal(sessionPresence(s.sid), "unreadable", "待恢复的会话不能被当成已丢失");
        ops.recoverTrash({ hooks: false });
      }
      assert.equal(fs.readFileSync(s.file, "utf8"), s.text);
      assert.equal(fs.readFileSync(s.extra, "utf8"), "附件");
      assert.equal(NAMES[s.sid], "保留标题");
      assert.equal(PINS[s.sid], 314);
      assert.equal(fs.existsSync(slotOf(s.sid)), false);
      assert.deepEqual(seen, []);
      if (at === "rollback") {
        assert(ops.trashSession(s.sid).ok);
        assert.equal(readJson(PATHS.names)[s.sid], undefined);
        assert(ops.restoreSession(s.sid).ok);
        assert.equal(readJson(PATHS.names)[s.sid], "保留标题");
        assert.equal(readJson(path.join(CFG.home, "ccapp-session-pins.json"))[s.sid], 314);
        assert.deepEqual(seen, [s.sid]);
      }
      delete NAMES[s.sid]; delete PINS[s.sid];
    }
    assert(saveNames()); assert(savePins());
  } finally { TRASH_HOOKS.pop(); }
});

test("重启先收口文件，再重放已经提交的回收通知；半截恢复可重试", () => {
  // 不监听端口、不启动真实网关；核对启动位置，下面用退出的子进程验两阶段的磁盘行为。
  const server = fs.readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  assert.match(server, /server\.listen\(CFG\.port[^\n]*\{\n[\s\S]*?recoverTrash\(\{ hooks: false \}\);[^\n]*\n[^\n]*recoverRunMark\(\);[^\n]*\n[^\n]*recoverTrash\(\);/);
  const partial = withSide(makeSession()), committed = withSide(makeSession());
  const seen = [];
  TRASH_HOOKS.push((id) => { if (id === partial.sid || id === committed.sid) seen.push(id); });
  try {
    interrupt(partial.sid, "trashSession", "renameSync", insideOf(partial.sid));
    interrupt(committed.sid, "trashSession", "renameSync", path.join(slotOf(committed.sid), "dir"));
    ops.recoverTrash({ hooks: false });
    assert.equal(fs.readFileSync(partial.file, "utf8"), partial.text);
    assert.equal(fs.readFileSync(partial.extra, "utf8"), "附件");
    assert.equal(fs.existsSync(slotOf(partial.sid)), false);
    assert.equal(readJson(metaOf(committed.sid)).tx.phase, "notify");
    assert.deepEqual(seen, []);
    ops.recoverTrash(); ops.recoverTrash();
    assert.deepEqual(seen, [committed.sid]);
    interrupt(committed.sid, "restoreSession", "renameSync", path.join(slotOf(committed.sid), "dir"));
    assert.equal(fs.existsSync(committed.extra), true);
    assert.equal(sessionPresence(committed.sid), "unreadable");
    ops.recoverTrash({ hooks: false });
    assert.equal(fs.existsSync(committed.extra), false);
    assert.equal(readJson(metaOf(committed.sid)).tx.phase, "ready");
    assert(ops.restoreSession(committed.sid).ok);
    assert.equal(fs.readFileSync(committed.file, "utf8"), committed.text);
    assert.equal(fs.readFileSync(committed.extra, "utf8"), "附件");
    assert.deepEqual(seen, [committed.sid]);
  } finally { TRASH_HOOKS.pop(); }
});

test("回收提交后移除最近会话或执行通知失败，保留 notify 直到重试成功", (t) => {
  const s = makeSession(), last = path.join(CFG.home, "ccapp-last-session.json");
  rememberSession(s.sid);
  const rm = fs.rmSync;
  const fail = t.mock.method(fs, "rmSync", (p, o) => { if (p === last) throw diskError(); return rm(p, o); });
  let attempts = 0, hookFails = false;
  TRASH_HOOKS.push((id) => { if (id === s.sid) { attempts++; if (hookFails) throw diskError(); } });
  try {
    assert.throws(() => ops.trashSession(s.sid), { code: "write_failed" });
    assert.equal(LAST_SESSION?.id, s.sid);
    assert.equal(readJson(last).id, s.sid);
    assert.equal(readJson(metaOf(s.sid)).tx.phase, "notify");
    fail.mock.restore();
    hookFails = true;
    assert.throws(() => ops.restoreSession(s.sid), /磁盘 I\/O/);
    assert.equal(readJson(metaOf(s.sid)).tx.phase, "notify");
    assert.equal(LAST_SESSION, null);
    assert.equal(fs.existsSync(last), false);
    hookFails = false;
    ops.recoverTrash();
    assert(ops.restoreSession(s.sid).ok);
    assert.equal(attempts, 3, "恢复会话不再重发删除通知");
  } finally { TRASH_HOOKS.pop(); }
});

test("项目回收会话未成功时，不删除磁盘上的项目目录", async (t) => {
  const { routeProjects } = await import("../gw/projects.mjs");
  const cwd = fs.mkdtempSync(path.join(CFG.workspace, "trash-project-"));
  const projectData = path.join(cwd, "保留.txt");
  fs.writeFileSync(projectData, "项目数据");
  const made = await request(routeProjects, "POST", "/api/projects", { name: "回收回归", mode: "dir", path: cwd });
  assert.equal(made.code, 200, JSON.stringify(made));
  const s = makeSession({ cwd });
  const projectUrl = `/api/projects/${made.project.id}`;
  const fail = failRename(t, (_a, b) => b === metaOf(s.sid));
  const result = await request(routeProjects, "DELETE", projectUrl + "?withDir=1");
  fail.mock.restore();
  assert.equal(result.code, 500);
  assert.equal(result.error, "trash_failed");
  assert.equal(fs.readFileSync(projectData, "utf8"), "项目数据");
  assert.equal(findSessionFile(s.sid)?.file, s.file);
  assert.equal((await request(routeProjects, "DELETE", projectUrl)).code, 200);
  fs.rmSync(cwd, { recursive: true });
});

test("回收站 meta 原子写、占用含附件目录；老条目按主记录大小报（195-A.14、196-真机.2）", () => {
  const s = makeSession();
  const sideDir = path.join(path.dirname(s.file), s.sid);
  fs.mkdirSync(path.join(sideDir, "subagents"), { recursive: true });
  fs.writeFileSync(path.join(sideDir, "subagents", "agent-1.jsonl"), "x".repeat(5000));
  const mainSize = fs.statSync(s.file).size;
  assert.equal(ops.trashSession(s.sid).ok, true);
  const m = ops.listTrash().find((x) => x.id === s.sid);
  assert.ok(m, "回收站里要列出来");
  assert.equal(typeof m.total, "number");
  assert.ok(m.total >= mainSize + 5000);
  assert.equal(m.size, m.total, "界面报的 size 用整格 total");
});

test("恢复时原 cwd 已不在：改写成当前工作区，能接着 --resume（197-2.2）", () => {
  const gone = path.join(CFG.workspace, "b2-gone-cwd");
  fs.rmSync(gone, { recursive: true, force: true });
  const s = makeSession({ cwd: gone });
  assert.equal(ops.trashSession(s.sid).ok, true);
  assert.equal(ops.restoreSession(s.sid).ok, true);
  const f = findSessionFile(s.sid);
  assert.ok(f);
  const first = JSON.parse(fs.readFileSync(f.file, "utf8").split("\n")[0]);
  const ws = fs.realpathSync(ops.realWorkspace());
  assert.equal(fs.realpathSync(first.cwd), ws);
});

test("恢复时标题写盘失败：不挪文件、不删回收站，（Y.2）", () => {
  const s = makeSession();
  const namesFile = path.join(CFG.home, "ccapp-session-names.json");
  const marker = "恢复用的名字";
  // 先把标题记进去，trash 时才会写 meta.renamed
  ops.trashSession(s.sid);
  const metaFile = path.join(CFG.home, ".ccapp-trash", s.sid, "meta.json");
  const m = readJson(metaFile); m.renamed = true; m.title = marker; fs.writeFileSync(metaFile, JSON.stringify(m));
  const oldNames = fs.existsSync(namesFile) ? fs.readFileSync(namesFile) : null;
  fs.rmSync(namesFile, { force: true }); fs.mkdirSync(namesFile);
  try {
    const r = ops.restoreSession(s.sid);
    assert.equal(r.ok, false);
    assert.equal(r.error, "write_failed");
    assert.equal(ops.inTrash(s.sid), true, "写不进标题时回收站这一格要留着");
    assert.equal(findSessionFile(s.sid), null, "也不能把主记录先挪回去");
  } finally {
    fs.rmSync(namesFile, { recursive: true, force: true });
    if (oldNames != null) fs.writeFileSync(namesFile, oldNames);
    assert.equal(ops.restoreSession(s.sid).ok, true);
  }
});

// ── 彻底删除 ──
test("彻底删除各处状态：写盘失败可在同一进程重试，不把内存缺项当成清理成功", async (t) => {
  const cwd = path.join(CFG.workspace, "b2-ops-cwd");
  fs.mkdirSync(cwd, { recursive: true });
  const s = makeSession({ cwd, q2: "要删的第二问" });
  assert(ops.deleteMessage(s.sid, s.q2, 0, "user").ok);
  assert(readJson(ORPHANS)[s.sid]);
  // 各处都放一点该会话的数据
  archiveImport(s.sid, { chapters: { 1: { title: "章一" } } }); saveArchive();
  assert.ok(archiveDb().sessions[s.sid]);
  sessmodel.setSessModel(s.sid, { model: "m1" }); sessmodel.flushSessModel();
  const bmFile = path.join(CFG.home, "ccapp-bookmarks.json");
  fs.writeFileSync(bmFile, JSON.stringify([{ id: "b1", sid: s.sid, uuid: uid(), off: 0, para: 0, role: "assistant", excerpt: "", at: 0 }]));
  integration.sealSession(s.sid, s.file);
  recordPrimary(s.sid, "parent-x");
  fs.mkdirSync(EDITS, { recursive: true }); fs.writeFileSync(path.join(EDITS, s.sid + ".1.jsonl"), "x");
  const hist = path.join(CFG.home, ".claude", "file-history", s.sid); fs.mkdirSync(hist, { recursive: true }); fs.writeFileSync(path.join(hist, "a"), "x");
  const agentDir = path.join(cwd, ".cccodroid", "agents", s.sid.slice(0, 8)); fs.mkdirSync(agentDir, { recursive: true }); fs.writeFileSync(path.join(agentDir, "a"), "x");
  // claude 按会话号另存的几处（D10）：环境快照、任务清单、调试日志、$TMPDIR 下的后台命令输出；别的会话的不动
  const C = (...r) => path.join(CFG.home, ".claude", ...r), other = uid();
  const sideDirs = [C("session-env", s.sid), C("tasks", s.sid), path.join(ops.claudeTmpRoot(), "-b2-slug", s.sid, "tasks")];
  for (const d of sideDirs) { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, "x.output"), "x"); }
  fs.mkdirSync(C("debug"), { recursive: true }); fs.writeFileSync(C("debug", s.sid + ".txt"), "x");
  const keep = [C("session-env", other), path.join(ops.claudeTmpRoot(), "-b2-slug", other)];
  for (const d of keep) fs.mkdirSync(d, { recursive: true });
  assert.equal(ops.trashSession(s.sid).ok, true);
  const clean = makeSession();
  assert(ops.trashSession(clean.sid).ok);
  const stores = [
    ["ccapp-archive.json", "archive", (v) => v.sessions[s.sid]],
    [path.basename(bmFile), "bookmarks", (v) => v.find((b) => b.sid === s.sid)],
    ["ccapp-session-models.json", "session model", (v) => v[s.sid]],
    ["ccapp-session-seals.json", "seal", (v) => v[s.sid]],
    ["ccapp-lineage.json", "lineage", (v) => v.edges[s.sid]],
    [path.basename(ORPHANS), "orphan messages", (v) => v[s.sid]],
  ];
  for (const [i, [basename, label, entry]] of stores.entries()) {
    const file = path.join(CFG.home, basename);
    const fail = failRename(t, (_a, b) => b === file);
    const response = await request(routeSessions, "POST", "/api/trash/purge", { ids: i ? [s.sid] : [s.sid, clean.sid] });
    fail.mock.restore();
    assert.equal(response.code, 500);
    assert.equal(response.ok, false);
    assert.equal(response.purged, i ? 0 : 1);
    assert.ok(response.error.includes(label), response.error);
    assert.ok(entry(readJson(file)), `${label} 尚未写盘`);
    assert.ok(fs.existsSync(insideOf(s.sid)), "失败时保留最后一份正文以及清理记录");
    assert.equal(ops.listTrash().find((m) => m.id === s.sid)?.purgePending, true);
    assert.equal(ops.restoreSession(s.sid).error, "purge_pending");
  }
  assert.equal(await ops.purgeTrash([s.sid]), 1);
  assert.equal(fs.existsSync(slotOf(s.sid)), false);
  for (const [basename, label, entry] of stores) assert.equal(entry(readJson(path.join(CFG.home, basename))), undefined, label);
  assert.equal(archiveDb().sessions[s.sid], undefined);
  assert.equal(readJson(path.join(CFG.home, "ccapp-session-models.json"))[s.sid], undefined);
  assert.equal(readJson(bmFile).some((b) => b.sid === s.sid), false);
  assert.equal(readJson(path.join(CFG.home, "ccapp-session-seals.json"))[s.sid], undefined);
  assert.equal(lineageDb().edges[s.sid], undefined);
  assert.equal(fs.existsSync(path.join(EDITS, s.sid + ".1.jsonl")), false);
  assert.equal(fs.existsSync(hist), false);
  assert.equal(fs.existsSync(agentDir), false);
  for (const d of sideDirs) assert.equal(fs.existsSync(d), false, d);
  assert.equal(fs.existsSync(C("debug", s.sid + ".txt")), false);
  for (const d of keep) { assert.equal(fs.existsSync(d), true, d); fs.rmSync(d, { recursive: true, force: true }); }
});

test("已经删掉正文但还未收口的条目仍可重试，不用等满 30 天", async (t) => {
  const pending = makeSession(), other = makeSession();
  assert(ops.trashSession(pending.sid).ok);
  assert(ops.trashSession(other.sid).ok);
  interrupt(pending.sid, "purgeTrash", "rmSync", insideOf(pending.sid));
  assert(!fs.existsSync(insideOf(pending.sid)));
  assert(ops.inTrash(pending.sid));
  const read = fs.readFileSync;
  const fail = t.mock.method(fs, "readFileSync", (f, ...args) => { if (f === metaOf(other.sid)) throw diskError(); return read(f, ...args); });
  assert.equal(ops.listTrash().find((m) => m.id === pending.sid)?.purgePending, true);
  const all = await request(routeSessions, "POST", "/api/trash/purge", { all: true });
  assert.equal(all.code, 500, "用户选清空时不能跳过一格却报成功");
  assert.equal(all.purged, 0);
  await ops.expireTrash();
  fail.mock.restore();
  assert(!fs.existsSync(slotOf(pending.sid)));
  assert(ops.inTrash(other.sid));
});

test("P2-3：回收通知没落盘的重删补跑钩子、按已删除返回，不再报「同名会话已存在」", () => {
  const s = makeSession();
  const hook = () => { throw new Error("钩子写盘失败"); };
  TRASH_HOOKS.push(hook);
  try {
    assert.throws(() => ops.trashSession(s.sid), /钩子写盘失败/);
  } finally { TRASH_HOOKS.pop(); }
  // 文件已进回收站、phase 停在 notify：重删应补跑钩子并成功，而不是 409
  assert.equal(readJson(metaOf(s.sid)).tx.phase, "notify");
  assert(ops.listTrash().some((m) => m.id === s.sid));
  assert.equal(ops.trashSession(s.sid).ok, true);
  assert.equal(readJson(metaOf(s.sid)).tx.phase, "ready");
  assert.equal(findSessionFile(s.sid), null);
  // 再来一次仍是幂等成功
  assert.equal(ops.trashSession(s.sid).ok, true);
});

test("旧版槽位按落点恢复；附件归属不明时不清理", async () => {
  for (const phase of ["intent", "ready", "restore-tail", "split"]) {
    const s = withSide(makeSession());
    const st = fs.statSync(s.file);
    fs.mkdirSync(slotOf(s.sid), { recursive: true });
    fs.writeFileSync(metaOf(s.sid), JSON.stringify({ id: s.sid, project: path.basename(path.dirname(s.file)), cwd: CFG.workspace,
      title: "旧版", size: st.size, mtime: st.mtimeMs, deletedAt: Date.now() }));
    if (phase === "ready" || phase === "split") fs.renameSync(s.file, insideOf(s.sid));
    if (phase === "ready" || phase === "restore-tail") fs.renameSync(s.side, path.join(slotOf(s.sid), "dir"));
    if (phase === "intent") ops.recoverTrash({ hooks: false });
    else {
      assert(ops.listTrash().some((m) => m.id === s.sid));
      if (phase === "split") {
        await assert.rejects(ops.purgeTrash([s.sid]), /无法确认归属/);
        assert.equal(fs.readFileSync(insideOf(s.sid), "utf8"), s.text);
        assert.equal(fs.readFileSync(s.extra, "utf8"), "附件");
        // P2-2：附件留在项目目录是旧版中断留下的合法状态，恢复时认作本会话附件、只搬回主记录
      }
      assert(ops.restoreSession(s.sid).ok);
    }
    assert(!fs.existsSync(slotOf(s.sid)));
    assert.equal(fs.readFileSync(s.file, "utf8"), s.text);
    assert.equal(fs.readFileSync(s.extra, "utf8"), "附件");
  }
});

test("同号槽位不能覆盖；旧版槽位彻底删除不碰同号活副本的状态", async () => {
  const s = withSide(makeSession());
  assert(ops.trashSession(s.sid).ok);
  const old = readJson(metaOf(s.sid)); delete old.tx;
  fs.writeFileSync(metaOf(s.sid), JSON.stringify(old));
  fs.writeFileSync(s.file, s.text.replace(s.q, "新对话"));
  const hist = path.join(CFG.home, ".claude", "file-history", s.sid);
  fs.mkdirSync(hist, { recursive: true });
  fs.writeFileSync(path.join(hist, "new"), "新检查点");
  assert(archiveImport(s.sid, { title: "新档案", chapters: {} })); assert(saveArchive());
  NAMES[s.sid] = "新标题"; assert(saveNames());
  assert.equal(ops.trashSession(s.sid).error, "exists");
  assert.equal(ops.restoreSession(s.sid).error, "exists");
  assert.equal(fs.readFileSync(insideOf(s.sid), "utf8"), s.text);
  assert.equal(await ops.purgeTrash([s.sid]), 1);
  assert.match(fs.readFileSync(s.file, "utf8"), /新对话/);
  assert.equal(fs.readFileSync(path.join(hist, "new"), "utf8"), "新检查点");
  assert.equal(archiveDb().sessions[s.sid].title, "新档案");
  assert.equal(readJson(PATHS.names)[s.sid], "新标题");
});

// ── 导出 / 导入 / 分叉 ──
test("失败的清理先收口；批量清理锁住后面的同号导入，最终只发布一份", async (t) => {
  const first = makeSession(), s = withSide(makeSession());
  const pack = (name) => {
    const f = path.join(CFG.home, name + ".zip");
    fs.writeFileSync(f, ops.zipBuild([
      { name: "manifest.json", data: JSON.stringify({ format: "cccodroid-sessions", sessions: [{ id: s.sid, archive: { title: name, chapters: {} } }] }) },
      { name: `sessions/${s.sid}.jsonl`, data: s.text.replace(s.q, name) },
      { name: `sessions/${s.sid}/data.txt`, data: name },
    ]));
    return f;
  };
  const a = pack("zip-a"), b = pack("zip-b");
  const hist = path.join(CFG.home, ".claude", "file-history", s.sid);
  fs.mkdirSync(hist, { recursive: true });
  assert(archiveImport(s.sid, { title: "旧档案", chapters: {} })); assert(saveArchive());
  assert(ops.trashSession(first.sid).ok);
  assert(ops.trashSession(s.sid).ok);
  const rm = fs.rmSync;
  const fail = t.mock.method(fs, "rmSync", (f, o) => { if (f === hist) throw diskError(); return rm(f, o); });
  await assert.rejects(ops.purgeTrash([s.sid]), /磁盘 I\/O/);
  await assert.rejects(ops.importSessions(a), /磁盘 I\/O/);
  assert.equal(findSessionFile(s.sid), null);
  fail.mock.restore();
  const purge = ops.purgeTrash([first.sid, s.sid]);
  assert.equal(ops.restoreSession(s.sid).error, "busy");
  const [n, ra, rb] = await Promise.all([purge, ops.importSessions(a), ops.importSessions(b)]);
  assert.equal(n, 2);
  assert.deepEqual([...ra.imported, ...rb.imported], [s.sid]);
  assert.deepEqual([...ra.skipped, ...rb.skipped], [s.sid]);
  const winner = ra.imported.length ? "zip-a" : "zip-b";
  const f = findSessionFile(s.sid).file;
  assert.match(fs.readFileSync(f, "utf8"), new RegExp(winner));
  assert.equal(fs.readFileSync(path.join(path.dirname(f), s.sid, "data.txt"), "utf8"), winner);
  assert.equal(archiveDb().sessions[s.sid].title, winner);
  assert(!fs.existsSync(slotOf(s.sid)));
  assert(!fs.existsSync(hist));
  fs.rmSync(f);
  fs.rmSync(path.join(path.dirname(f), s.sid), { recursive: true });
});

test("导出先写 .part 再换名、0600；导入回收站里同号会话先恢复再跳过（197-9.9、195-A.5）", async () => {
  const s = makeSession({ q: "导出这个会话" });
  const out = await ops.exportSessions([s.sid]);
  assert.ok(fs.existsSync(out.file));
  assert.equal(fs.statSync(out.file).mode & 0o777, 0o600);
  const dir = path.dirname(out.file);
  assert.equal(fs.readdirSync(dir).some((n) => n.includes(".part-")), false, "不留半截临时文件");
  assert.equal(ops.trashSession(s.sid).ok, true);
  const r = await ops.importSessions(out.file);
  assert.ok(r.skipped.includes(s.sid));
  assert.equal(findSessionFile(s.sid) !== null, true, "回收站里的要先恢复出来");
});

test("导入的会话 mtime 改成现在：列表里立刻看得到（196-会话.5）", async () => {
  const s = makeSession({ q: "很久以前导入" });
  const old = new Date("2020-01-02T03:04:05Z"); fs.utimesSync(s.file, old, old);
  const out = await ops.exportSessions([s.sid]);
  ops.trashSession(s.sid);
  await ops.purgeTrash([s.sid]);
  const r = await ops.importSessions(out.file);
  assert.ok(r.imported.includes(s.sid));
  const f = findSessionFile(s.sid);
  assert.ok(f);
  assert.ok(Date.now() - fs.statSync(f.file).mtimeMs < 60000, "按导入时间排，而不是包里的旧时间");
  fs.rmSync(f.file, { force: true });   // 导入落在工作区项目目录：清掉，别影响后面的用量补算
});

test("分叉先写 .part：成功后不留临时文件（195-Y.6）", () => {
  const s = makeSession({ q: "从这里分叉" });
  const r = ops.forkSession(s.sid, s.q, 0);
  assert.equal(r.ok, true);
  const dir = path.dirname(s.file);
  assert.equal(fs.readdirSync(dir).some((n) => n.startsWith(r.id + ".jsonl.part-")), false);
  assert.ok(fs.existsSync(path.join(dir, r.id + ".jsonl")));
});

test("回退补救用临时文件换名，目标换成软链时不跟过去写（195-Y.5）", () => {
  const s = makeSession({ q: "回退" });
  const want = path.join(CFG.workspace, "b2-rewind-file.txt");
  fs.writeFileSync(want, "现在的内容");
  const hist = path.join(CFG.home, ".claude", "file-history", s.sid);
  fs.mkdirSync(hist, { recursive: true });
  fs.writeFileSync(path.join(hist, "b1"), "备份的内容");
  const snapUuid = uid();
  fs.appendFileSync(s.file, JSON.stringify({ type: "file-history-snapshot", messageId: snapUuid, snapshot: { trackedFileBackups: { "b2-rewind-file.txt": { backupFileName: "b1" } } } }) + "\n");
  const r = ops.rewindFixup(s.file, s.sid, snapUuid, [want]);
  assert.equal(r.fixed, 1);
  assert.equal(fs.readFileSync(want, "utf8"), "备份的内容");
  assert.equal(fs.readdirSync(path.dirname(want)).some((n) => n.startsWith(".rewind-")), false);
  // 目标换成软链：备份不同、需要写时被挡下，受害文件不动
  const victim = path.join(CFG.workspace, "b2-rewind-victim.txt");
  fs.writeFileSync(victim, "别动我");
  fs.rmSync(want, { force: true }); fs.symlinkSync(victim, want);
  fs.writeFileSync(path.join(hist, "b1"), "又一份备份");
  const r2 = ops.rewindFixup(s.file, s.sid, snapUuid, [want]);
  assert.equal(r2.failed, 1);
  assert.equal(fs.readFileSync(victim, "utf8"), "别动我");
  fs.rmSync(want, { force: true }); fs.rmSync(victim, { force: true });
});
