// 0.6.10 车道 b2：会话删除 / 回收站 / 恢复 / 导出导入 / 彻底删除（195-A.1/A.5/A.7/A.10/A.14、197-2.2/2.3/2.4、197-9.9、200-8-04、196-真机.1/2、195-Y.2/Y.3/Y.5/Y.6）
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { CFG, PATHS } from "../gw/config.mjs";
import { findSessionFile } from "../gw/sessions.mjs";
import * as ops from "../gw/sessionops.mjs";
import { archiveDb, archiveImport, saveArchive } from "../gw/archive-store.mjs";
import * as sessmodel from "../gw/sessmodel.mjs";
import * as integration from "../gw/integrity.mjs";
import { lineageDb, recordPrimary } from "../gw/lineage-store.mjs";

const EDITS = path.join(CFG.home, ".ccapp-trash", ".edits");
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
test("彻底删除清掉 archive、sessmodel、书签、封签、脉络、.edits、file-history、agents（195-A.7、197-2.3/2.4、196-真机.1、195-Y.3）", async () => {
  const cwd = path.join(CFG.workspace, "b2-ops-cwd");
  fs.mkdirSync(cwd, { recursive: true });
  const s = makeSession({ cwd });
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
  assert.equal(await ops.purgeTrash([s.sid]), 1);
  assert.equal(fs.existsSync(path.join(CFG.home, ".ccapp-trash", s.sid)), false);
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

// ── 导出 / 导入 / 分叉 ──
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
