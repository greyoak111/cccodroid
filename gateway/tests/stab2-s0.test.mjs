// 第二份稳定性报告的两条 S0（Cc-stability-20261111-01-SUB-V1.0）：
//   BUG-P01 读取和留底都失败后，默认空表把完整旧归档整份盖掉
//   BUG-P02 记录改写把写盘错误当成解析错误吞掉，照样发布重复行 / 坏行的会话记录
// 都在测试自己的临时 home 里造数据、注入故障（fs 打补丁），不碰真数据
import "../gw/config.mjs";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { CFG, PATHS } from "../gw/config.mjs";
import { loadState, saveState, stateUnread } from "../gw/statefile.mjs";
import { archiveDb, saveArchive } from "../gw/archive-store.mjs";
import { lineWriter } from "../gw/bigfile.mjs";
import * as ops from "../gw/sessionops.mjs";
import { findSessionFile } from "../gw/sessions.mjs";

// ── fs 故障注入：只对选中的路径 / fd 生效，每个用例结束都撤掉 ──
const orig = { renameSync: fs.renameSync, copyFileSync: fs.copyFileSync, openSync: fs.openSync, writeSync: fs.writeSync };
afterEach(() => Object.assign(fs, orig));
const eacces = (p) => Object.assign(new Error("EACCES: permission denied, " + p), { code: "EACCES" });
/** 读、换名、复制三样都失败（报告里的触发条件：一时的 EACCES） */
function blockFile(file) {
  fs.chmodSync(file, 0);
  fs.renameSync = (a, b) => { if (path.resolve(a) === path.resolve(file)) throw eacces(a); return orig.renameSync(a, b); };
  fs.copyFileSync = (a, b, m) => { if (path.resolve(a) === path.resolve(file)) throw eacces(a); return orig.copyFileSync(a, b, m); };
}
function unblockFile(file) {
  Object.assign(fs, { renameSync: orig.renameSync, copyFileSync: orig.copyFileSync });
  fs.chmodSync(file, 0o600);
}
const bads = (f) => fs.readdirSync(path.dirname(f)).filter((n) => n.startsWith(path.basename(f) + ".bad-"));

// ── BUG-P01 ──
test("P01 通用：读坏又没留底时拒写，原文件一个字节不动；读成功之后照常能写", () => {
  const D = path.join(CFG.home, "s0-state"); fs.mkdirSync(D, { recursive: true });
  const f = path.join(D, "keys.json");
  fs.writeFileSync(f, JSON.stringify({ a: "旧的 A" }));
  const before = fs.readFileSync(f);
  blockFile(f);
  const r = loadState(f, { fallback: () => ({}) });
  assert.equal(r.bad, true);
  assert.equal(r.kept, false, "三样都失败：没留成底");
  assert.deepEqual(r.data, {});
  assert.equal(stateUnread(f), true);
  unblockFile(f);
  // 故障已经解除，但调用方手里还是默认值：这时写下去就是拿 {} 盖掉 A
  assert.equal(saveState(f, { b: "新的 B" }), false, "没读进来之前必须拒写");
  assert.deepEqual(fs.readFileSync(f), before, "原文件不能被改");
  assert.equal(bads(f).length, 0);
  // 重新读一遍：读成功了就解除
  const r2 = loadState(f, { fallback: () => ({}) });
  assert.equal(r2.bad, false);
  assert.deepEqual(r2.data, { a: "旧的 A" });
  assert.equal(stateUnread(f), false);
  assert.equal(saveState(f, { ...r2.data, b: "新的 B" }), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")), { a: "旧的 A", b: "新的 B" });
});

test("P01 通用：没读进来的文件后来被删掉了，就不用再护着", () => {
  const D = path.join(CFG.home, "s0-state"); fs.mkdirSync(D, { recursive: true });
  const f = path.join(D, "gone.json");
  fs.writeFileSync(f, "{}");
  blockFile(f);
  assert.equal(loadState(f).kept, false);
  unblockFile(f);
  fs.rmSync(f);
  assert.equal(saveState(f, { x: 1 }), true);
  assert.equal(stateUnread(f), false);
});

test("P01 留底成功的老路子不变：坏文件挪成 .bad-*，之后照常写（kept=true）", () => {
  const D = path.join(CFG.home, "s0-state"); fs.mkdirSync(D, { recursive: true });
  const f = path.join(D, "broken.json");
  fs.writeFileSync(f, "{oops");
  const r = loadState(f, { fallback: () => ({}) });
  assert.equal(r.bad, true);
  assert.equal(r.kept, true);
  assert.equal(bads(f).length, 1);
  assert.equal(saveState(f, { ok: 1 }), true);
});

test("P01 档案：首次读档失败又没留底 → 交档如实失败、原档案保住；故障过去后接回旧条目，再交档两条都在", () => {
  const FILE = path.join(CFG.home, "ccapp-archive.json");
  const A = { v: 1, sessions: { "aaaaaaaa-0000-4000-8000-000000000001": { title: "旧题名 A", chapters: { 1: { title: "旧题名 A", hist: [] } } } } };
  fs.writeFileSync(FILE, JSON.stringify(A));
  const before = fs.readFileSync(FILE);
  blockFile(FILE);
  const db = archiveDb();                    // 读不了、也留不了底：拿到的是用完即弃的空表
  assert.deepEqual(db.sessions, {});
  unblockFile(FILE);
  db.sessions["bbbbbbbb-0000-4000-8000-000000000002"] = { title: "新题名 B", chapters: { 1: { title: "新题名 B", hist: [] } } };
  assert.equal(saveArchive(), false, "旧档案没读进来：这次保存要拒掉，调用方据此报「没存上」");
  assert.deepEqual(fs.readFileSync(FILE), before, "磁盘上的旧档案一个字节都不能少");
  assert.equal(bads(FILE).length, 0);
  // 同一进程里再来一次（故障已经过去）：重新读到 A，加 B，保存后两条都在
  const db2 = archiveDb();
  assert.equal(db2.sessions["aaaaaaaa-0000-4000-8000-000000000001"]?.title, "旧题名 A");
  db2.sessions["bbbbbbbb-0000-4000-8000-000000000002"] = { title: "新题名 B", chapters: { 1: { title: "新题名 B", hist: [] } } };
  assert.equal(saveArchive(), true);
  const disk = JSON.parse(fs.readFileSync(FILE, "utf8"));
  assert.deepEqual(Object.keys(disk.sessions).sort(), ["aaaaaaaa-0000-4000-8000-000000000001", "bbbbbbbb-0000-4000-8000-000000000002"]);
  assert.equal(archiveDb(), db2, "读成功之后照常缓存");
});

// ── BUG-P02 ──
/** 往名字里含 marker 的文件写时出错：once = 只错一次；short = 先短写一半再错；always = 一直错 */
function failWrites(marker, mode) {
  const fds = new Set();
  let n = 0;
  fs.openSync = (p, ...a) => { const fd = orig.openSync(p, ...a); if (String(p).includes(marker)) fds.add(fd); return fd; };
  fs.writeSync = (fd, b, off = 0, len, pos) => {
    if (fds.has(fd)) {
      n++;
      const eio = Object.assign(new Error("EIO: i/o error, write"), { code: "EIO" });
      if (mode === "once" && n === 1) throw eio;
      if (mode === "always") throw eio;
      if (mode === "short" && n === 1) return orig.writeSync(fd, b, off, Math.max(1, Math.floor((len ?? b.length - off) / 2)), pos);
      if (mode === "short" && n === 2) throw eio;
    }
    return orig.writeSync(fd, b, off, len, pos);
  };
}

const uid = () => crypto.randomUUID();
/** 两轮的会话；第一条回复超过 1 MiB，抄的时候中途就会自动 flush（报告的触发条件） */
function bigSession(cwd = CFG.workspace) {
  const sid = uid(), dir = path.join(PATHS.projects, "-s0-p02");
  fs.mkdirSync(dir, { recursive: true });
  const u1 = { type: "user", sessionId: sid, uuid: uid(), parentUuid: null, cwd, message: { role: "user", content: "第一问" } };
  const a1 = { type: "assistant", sessionId: sid, uuid: uid(), parentUuid: u1.uuid, cwd, message: { role: "assistant", content: [{ type: "text", text: "很长".repeat(400000) }] } };
  const u2 = { type: "user", sessionId: sid, uuid: uid(), parentUuid: a1.uuid, cwd, message: { role: "user", content: "第二问" } };
  const a2 = { type: "assistant", sessionId: sid, uuid: uid(), parentUuid: u2.uuid, cwd, message: { role: "assistant", content: [{ type: "text", text: "短" }] } };
  const file = path.join(dir, sid + ".jsonl");
  fs.writeFileSync(file, [u1, a1, u2, a2].map((x) => JSON.stringify(x)).join("\n") + "\n");
  return { sid, file, dir };
}
const jsonl = (f) => fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
const listJsonl = (dir) => fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl")).sort();

test("P02 分叉：正常写入是 2 行、逐行可解析、无重复 UUID（对照）", () => {
  const s = bigSession();
  const r = ops.forkSession(s.sid, "第一问", 0);
  assert.equal(r.ok, true);
  const f = path.join(s.dir, r.id + ".jsonl");
  const lines = jsonl(f);
  assert.equal(lines.length, 2);
  const ev = lines.map((l) => JSON.parse(l));
  assert.equal(new Set(ev.map((e) => e.uuid)).size, 2);
  assert.ok(ev.every((e) => e.sessionId === r.id));
});

for (const mode of ["once", "short", "always"]) {
  test(`P02 分叉：写盘${mode === "once" ? "错一次" : mode === "short" ? "先短写再错" : "一直错"} → 整次失败，不发布新会话，源记录不变，不留临时文件`, () => {
    const s = bigSession();
    const src = fs.readFileSync(s.file);
    const files0 = listJsonl(s.dir);
    failWrites(".part-", mode);
    assert.throws(() => ops.forkSession(s.sid, "第一问", 0), /EIO/);
    Object.assign(fs, orig);
    assert.deepEqual(listJsonl(s.dir), files0, "不能多出一个分叉会话");
    assert.deepEqual(fs.readFileSync(s.file), src, "源记录一个字节都不变");
    assert.deepEqual(fs.readdirSync(s.dir).filter((n) => n.includes(".part-")), [], "临时文件要清掉");
  });
}

test("P02 恢复改写 cwd：写盘错一次 → 不替换主记录（保留原 cwd），主记录逐行可解析、无重复", () => {
  const gone = path.join(CFG.home, "s0-gone-project");
  fs.mkdirSync(gone, { recursive: true });
  const s = bigSession(gone);
  const src = fs.readFileSync(s.file);
  assert.equal(ops.trashSession(s.sid).ok, true);
  fs.rmSync(gone, { recursive: true, force: true });           // 原项目目录没了：恢复时要改写 cwd
  failWrites(".cwd-", "once");
  const r = ops.restoreSession(s.sid);
  Object.assign(fs, orig);
  assert.equal(r.ok, true, "会话本身照常恢复，只是 cwd 没改成");
  const back = findSessionFile(s.sid)?.file;
  assert.ok(back, "恢复后要找得到");
  assert.deepEqual(fs.readFileSync(back), src, "改写失败：主记录保持原样，不能换成重复 / 坏行的版本");
  const ev = jsonl(back).map((l) => JSON.parse(l));
  assert.equal(new Set(ev.map((e) => e.uuid)).size, ev.length);
  assert.deepEqual(fs.readdirSync(path.dirname(back)).filter((n) => n.includes(".cwd-")), []);
});

test("P02 lineWriter：出过一次写错就作废，后面的 write / close 都抛同一个错，不会把失败的那批再写一遍", () => {
  const f = path.join(CFG.home, "s0-lw.part-x");
  failWrites("s0-lw.part-", "once");
  const w = lineWriter(f);
  const big = "x".repeat(1 << 20);
  assert.throws(() => w.write(big), /EIO/);
  assert.throws(() => w.write("下一行"), /EIO/);
  assert.throws(() => w.close(), /EIO/);
  Object.assign(fs, orig);
  assert.equal(fs.readFileSync(f, "utf8"), "", "失败的那批不能在后面被重写进去");
  fs.rmSync(f, { force: true });
});
