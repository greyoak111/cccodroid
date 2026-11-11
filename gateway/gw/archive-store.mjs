// 建档 · 档案文件：home/ccapp-archive.json。题名、章节状态、改动历史都在这里，会话记录（jsonl）一个字节都不改。
// 单独成一个小模块：会话列表（sessions.mjs）要读题名，不和 archive / lineage 绕成循环引用。
// 格式：{ v: 1, sessions: { <会话>: { title, misc, miscBy, chapters: { <章序>: { title, status, same, by, at, spec, locked, hist: [ { title, at, by } ] } } } } }
//   title：最新一章（卷）的题名，交档时算好存着，会话列表直接用
//   misc：归入杂项（测试、试模型这类用完即弃的会话）；miscBy：ai / user —— 用户定过的，AI 不再改
import path from "node:path";
import { CFG } from "./config.mjs";
import { isObj, loadState, saveState } from "./statefile.mjs";

const FILE = path.join(CFG.home, "ccapp-archive.json");
let DB = null;

// sessions 得是普通对象：数组也是 object，可往里放会话号键，JSON.stringify 时全丢（#98 03-011）。
// 语法坏 / sessions 不是普通对象：留底成 .bad-* 再从空的起（P1-9：以前解析失败不留底，下一次建档把全部题名盖掉）。
// 单个会话条目坏了就地丢掉，不让它把交档 / 杂项接口打成 500（200-5-06）
const archiveShape = (j) => {
  if (!isObj(j) || !isObj(j.sessions)) return undefined;
  const sessions = {};
  for (const [id, e] of Object.entries(j.sessions)) {
    if (!isObj(e)) continue;
    const chapters = {};
    if (isObj(e.chapters)) for (const [k, c] of Object.entries(e.chapters)) {
      if (!/^\d{1,4}$/.test(k) || !isObj(c)) continue;
      chapters[k] = {
        ...c,
        title: typeof c.title === "string" ? c.title : null,
        hist: Array.isArray(c.hist) ? c.hist.filter(isObj).slice(-20) : [],
      };
    }
    sessions[id] = { ...e, title: typeof e.title === "string" ? e.title : null, chapters };
  }
  return { ...j, v: 1, sessions };
};

export function archiveDb() {
  if (DB) return DB;
  const r = loadState(FILE, { shape: archiveShape, fallback: () => ({ v: 1, sessions: {} }) });
  // 读坏了又没留成底（BUG-P01）：原档案还在磁盘上没读进来，空表不能当成当前状态缓存 —— 否则下一次交档把整份档案盖成只剩这一条。
  // 这次给个用完即弃的空表（保存会被 statefile 拒掉、如实报错），下次调用再读一遍：故障一过就接回原档案
  if (r.bad && !r.kept) return r.data;
  DB = r.data;
  return DB;
}

/** 返回写成没有：调用方要据此报错，别写失败了还回 ok（网关一重启内存里的就没了 —— 审查 中2） */
export function saveArchive() {
  if (!DB) return false;      // 还没读进来（或者没读成，见 archiveDb）：没有可保存的当前状态，别拿空表去盖
  return saveState(FILE, DB);
}

/** 会话彻底删掉时清掉它的档案（195-A.7 / Y.3） */
export function archiveForget(id) {
  const db = archiveDb();
  if (!db.sessions[id]) return true;
  delete db.sessions[id];
  return saveArchive();
}

/** 会话包里带来的档案（导出时随会话一起放进 manifest，#98 03-001）：只收认得的字段、按类型过一遍；
 *  本机已经有这条会话的档案就不动。返回收没收 */
export function archiveImport(id, e) {
  const db = archiveDb();
  if (!e || typeof e !== "object" || Array.isArray(e) || !e.chapters || typeof e.chapters !== "object" || Array.isArray(e.chapters)) return false;
  // 旧条目只有个空壳（没题名、没有一章有题名）时照样收包里的：彻底删除没清档案时，导入同 ID 的包会被它挡住（195-Y.3）
  const old = db.sessions[id];
  if (old && (old.title || Object.values(old.chapters || {}).some((c) => c && c.title))) return false;
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
export function archiveBrief(id, size, compacts) {
  const e = archiveDb().sessions[id];
  if (!e) return { no: null, misc: false };
  const ns = Object.keys(e.chapters || {}).filter((k) => e.chapters[k]?.title).map(Number);
  return { no: ns.length ? String(id).slice(0, 4) + "·" + Math.max(...ns) : null, misc: miscOf(e, size, compacts) };
}

// AI 标的杂项只对小会话算数：压缩过（有第 2 章，或记录里数到压缩）、会话文件超过 512 KB，就当它判错了 ——
// AI 多在第一轮就判「用完即弃」，后来干成正经活也不会改口（11-03 群反馈）。用户自己归入的照旧算。
// 档案里的标记不动，规则以后要改也能回退
export const MISC_AI_MAX = 512 * 1024;
export function miscOf(e, size = 0, compacts = 0) {
  if (!e?.misc) return false;
  if (e.miscBy === "user") return true;
  const big = Object.keys(e.chapters || {}).some((k) => Number(k) >= 2) || compacts >= 1 || size > MISC_AI_MAX;
  return !big;
}
