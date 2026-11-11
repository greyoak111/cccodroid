// BUG-P03（对照第一轮 FIND-014）：导入的正文发布成功、标题 / 章节档案的原子换名失败时，
// 以前只在日志里记一笔、接口照回「imported」，重启后元数据就没了；同包重试又因为正文已存在直接跳过，
// 永远补不上。本文件按报告2 的复核条件：故障注入 → 明确的部分失败标志 → 解除故障再导同包 → 安全补写，
// 且本地已有的用户标题 / 用户档案不被包里的覆盖。
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { CFG, PATHS } from "../gw/config.mjs";
import { NAMES, saveNames } from "../gw/sessions.mjs";
import { archiveDb, archiveImport, saveArchive } from "../gw/archive-store.mjs";
import * as ops from "../gw/sessionops.mjs";

const ARCHIVE = path.join(CFG.home, "ccapp-archive.json");
const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const readJson = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null);
const line = (o) => JSON.stringify(o) + "\n";
const UUID = () => crypto.randomUUID();

/** 造一条合法会话 + 自定义标题 + 档案，导出成会话包，再把本地这条彻底删掉（连同标题 / 档案） */
async function packWorkshop(tag, title) {
  const dir = path.join(PATHS.projects, "-stab2-g-import-" + tag);
  dirs.push(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const sid = UUID(), cwd = path.join(process.env.CCAPP_TMP, "stab2-g-import-ws-" + tag);
  fs.mkdirSync(cwd, { recursive: true }); dirs.push(cwd);
  fs.writeFileSync(path.join(dir, sid + ".jsonl"),
    line({ type: "user", sessionId: sid, uuid: UUID(), parentUuid: null, cwd, timestamp: new Date().toISOString(), message: { role: "user", content: "包里的提问" } }) +
    line({ type: "assistant", sessionId: sid, uuid: UUID(), parentUuid: null, cwd, timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "包里的回答" }] } }));
  NAMES[sid] = title;
  saveNames();
  assert.equal(archiveImport(sid, { title, chapters: { 1: { title: "第一章·包里的章题", by: "ai", at: 1 } } }), true);
  assert.equal(saveArchive(), true);
  const out = await ops.exportSessions([sid]);
  assert.equal(ops.trashSession(sid).ok, true);
  await ops.purgeTrash([sid]);
  assert.equal(fs.existsSync(path.join(dir, sid + ".jsonl")), false, "正文已从本机删掉");
  assert.equal(readJson(PATHS.names)?.[sid], undefined, "标题已从本机删掉");
  assert.equal(readJson(ARCHIVE)?.sessions?.[sid], undefined, "档案已从本机删掉");
  return { sid, out: out.file, title };
}

/** 只让「标题」「档案」两个文件的原子换名失败（正文照常发布） */
async function importWithMetaFault(file) {
  const orig = fs.renameSync;
  fs.renameSync = (a, b) => {
    if (String(b) === PATHS.names || String(b) === ARCHIVE) throw Object.assign(new Error("boom"), { code: "ENOSPC" });
    return orig(a, b);
  };
  try { return await ops.importSessions(file); } finally { fs.renameSync = orig; }
}

test("标题 / 档案换名失败：接口要报 titleWarning + archiveWarning；同一进程再导同包能补上", async () => {
  const { sid, out, title } = await packWorkshop("a", "包里的标题甲");
  const r1 = await importWithMetaFault(out);
  assert.ok(r1.imported.includes(sid), "正文导进来了");
  assert.equal(r1.titleWarning, true, "标题没落盘要如实说");
  assert.equal(r1.archiveWarning, true, "档案没落盘也要如实说（以前只记日志）");
  assert.equal(readJson(PATHS.names)?.[sid], undefined, "磁盘上确实没有标题");
  assert.equal(readJson(ARCHIVE)?.sessions?.[sid], undefined, "磁盘上确实没有档案");

  // 故障解除，原样再导同一个包：正文已在（skipped），但元数据要补写
  const r2 = await ops.importSessions(out);
  assert.deepEqual(r2.imported, [], "正文不重复导入");
  assert.ok(r2.skipped.includes(sid), "同一个包第二次是跳过正文");
  assert.equal(r2.titleWarning, undefined);
  assert.equal(r2.archiveWarning, undefined);
  assert.equal(readJson(PATHS.names)?.[sid], title, "标题补上了");
  assert.equal(readJson(ARCHIVE)?.sessions?.[sid]?.chapters?.["1"]?.title, "第一章·包里的章题", "档案补上了");
});

test("重启后（内存里的元数据没了）再导同包能补上；本地已有的标题 / 档案不被覆盖", async () => {
  const { sid, out, title } = await packWorkshop("b", "包里的标题乙");
  const r1 = await importWithMetaFault(out);
  assert.equal(r1.titleWarning, true);
  assert.equal(r1.archiveWarning, true);

  // 模拟重启：内存里的标题表 / 档案库回退成磁盘上的样子（都没有这条）
  delete NAMES[sid];
  delete archiveDb().sessions[sid];

  const r2 = await ops.importSessions(out);
  assert.ok(r2.skipped.includes(sid));
  assert.equal(readJson(PATHS.names)?.[sid], title, "重启后重导能把标题补上");
  assert.equal(readJson(ARCHIVE)?.sessions?.[sid]?.chapters?.["1"]?.title, "第一章·包里的章题", "重启后重导能把档案补上");

  // 用户本地改过标题、建过自己的档案（建档接口直接改档案库）：再导同包不许覆盖
  NAMES[sid] = "本地改的标题";
  assert.equal(saveNames(), true);
  archiveDb().sessions[sid] = { title: "本地建的档案", chapters: { 1: { title: "本地章题" } } };
  assert.equal(saveArchive(), true);
  const r3 = await ops.importSessions(out);
  assert.ok(r3.skipped.includes(sid));
  assert.equal(readJson(PATHS.names)?.[sid], "本地改的标题", "本地标题不被包里的覆盖");
  assert.equal(readJson(ARCHIVE)?.sessions?.[sid]?.title, "本地建的档案", "本地档案不被包里的覆盖");
  assert.equal(readJson(ARCHIVE)?.sessions?.[sid]?.chapters?.["1"]?.title, "本地章题");
});
