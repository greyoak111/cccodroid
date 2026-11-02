// 建档 · 档案文件：home/ccapp-archive.json。题名、章节状态、改动历史都在这里，会话记录（jsonl）一个字节都不改。
// 单独成一个小模块：会话列表（sessions.mjs）要读题名，不和 archive / lineage 绕成循环引用。
// 格式：{ v: 1, sessions: { <会话>: { title, misc, miscBy, chapters: { <章序>: { title, status, same, by, at, spec, locked, hist: [ { title, at, by } ] } } } } }
//   title：最新一章（卷）的题名，交档时算好存着，会话列表直接用
//   misc：归入杂项（测试、试模型这类用完即弃的会话）；miscBy：ai / user —— 用户定过的，AI 不再改
import fs from "node:fs";
import path from "node:path";
import { CFG, log } from "./config.mjs";

const FILE = path.join(CFG.home, "ccapp-archive.json");
let DB = null;

export function archiveDb() {
  if (DB) return DB;
  try { DB = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { DB = null; }
  // sessions 得是普通对象：数组也是 object，可往里放会话号键，JSON.stringify 时全丢（#98 03-011）。
  // 坏了的原文件先留个底再从空的起，别下一次保存把它盖掉
  if (!DB || typeof DB !== "object" || Array.isArray(DB) || !DB.sessions || typeof DB.sessions !== "object" || Array.isArray(DB.sessions)) {
    if (DB) { try { fs.copyFileSync(FILE, FILE + ".bad-" + Date.now()); log("档案文件格式不对，已另存一份，从空的开始"); } catch {} }
    DB = { v: 1, sessions: {} };
  }
  return DB;
}

/** 返回写成没有：调用方要据此报错，别写失败了还回 ok（网关一重启内存里的就没了 —— 审查 中2） */
export function saveArchive() {
  try {
    fs.writeFileSync(FILE + ".tmp", JSON.stringify(DB), { mode: 0o600 });
    fs.renameSync(FILE + ".tmp", FILE);
    return true;
  } catch (e) { log("写档案失败: " + e.message); return false; }
}

/** 会话包里带来的档案（导出时随会话一起放进 manifest，#98 03-001）：只收认得的字段、按类型过一遍；
 *  本机已经有这条会话的档案就不动。返回收没收 */
export function archiveImport(id, e) {
  const db = archiveDb();
  if (db.sessions[id] || !e || typeof e !== "object" || Array.isArray(e) || !e.chapters || typeof e.chapters !== "object" || Array.isArray(e.chapters)) return false;
  const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : null);
  const chapters = {};
  for (const [k, c] of Object.entries(e.chapters).slice(0, 500)) {
    if (!/^\d{1,4}$/.test(k) || !c || typeof c !== "object") continue;
    chapters[k] = { title: str(c.title, 200), status: str(c.status, 20), same: !!c.same, by: str(c.by, 10), at: Number(c.at) || 0, spec: Number(c.spec) || 0, locked: !!c.locked,
      hist: Array.isArray(c.hist) ? c.hist.slice(-20).filter((h) => h && typeof h === "object").map((h) => ({ title: str(h.title, 200), at: Number(h.at) || 0, by: str(h.by, 10) })) : [] };
  }
  db.sessions[id] = { title: str(e.title, 200), chapters, ...(e.misc ? { misc: true, miscBy: str(e.miscBy, 10) } : {}) };
  return true;
}

/** 会话列表用：建过档的会话的最新题名；没建过返回 null */
export const archivedTitle = (id) => archiveDb().sessions[id]?.title || null;

/** 会话列表用：档号（会话号前 4 位·题名所在的最新一章）、是否杂项 */
export function archiveBrief(id) {
  const e = archiveDb().sessions[id];
  if (!e) return { no: null, misc: false };
  const ns = Object.keys(e.chapters || {}).filter((k) => e.chapters[k]?.title).map(Number);
  return { no: ns.length ? String(id).slice(0, 4) + "·" + Math.max(...ns) : null, misc: !!e.misc };
}
