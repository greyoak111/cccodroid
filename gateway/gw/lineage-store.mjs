// 脉络 · 显式亲缘记录：home/ccapp-lineage.json。只记事实（谁从谁分出来、从哪条消息分），不记布局。
// 单独成一个小模块，是为了让 sessionops（分叉 / 回退）能直接写，不和 sessions / lineage 绕成循环引用。
// 格式见规划 §3.3：{ v: 1, edges: { <子会话>: { primary: { id, at, kind }, extra: [ { id, at, how, note } ] } } }
import path from "node:path";
import { CFG, log } from "./config.mjs";
import { isObj, loadState, saveState } from "./statefile.mjs";

const FILE = path.join(CFG.home, "ccapp-lineage.json");
let DB = null;

// edges 必须是普通对象：数组也是 object，往数组上写会话号键 JSON.stringify 时全丢，文件永远还是 []（195-Z.7）
const lineageShape = (j) => {
  if (!isObj(j) || !isObj(j.edges)) return undefined;
  const edges = {};
  for (const [id, e] of Object.entries(j.edges)) {
    if (!isObj(e)) continue;
    const v = {};
    if (isObj(e.primary)) v.primary = { ...e.primary, id: typeof e.primary.id === "string" ? e.primary.id : String(e.primary.id || "") };
    if (Array.isArray(e.extra)) v.extra = e.extra.filter(isObj).slice(-EXTRA_MAX);
    if (Array.isArray(e.nosig)) v.nosig = e.nosig.filter((x) => typeof x === "string").slice(-EXTRA_MAX);
    edges[id] = v;
  }
  return { ...j, v: 1, edges };
};

export function lineageDb() {
  if (DB) return DB;
  DB = loadState(FILE, { shape: lineageShape, fallback: () => ({ v: 1, edges: {} }) }).data;
  return DB;
}

let lastSaveOk = true;
function save() {
  lastSaveOk = saveState(FILE, DB ?? { v: 1, edges: {} });
  if (!lastSaveOk) log("写脉络记录失败");
  return lastSaveOk;
}
/** 最近一次 save 是否写成（merge 路由据此回 500，195-2.8） */
export const lineageSaveOk = () => lastSaveOk;

/** 分叉 / 回退时记主父。at：子会话里最后一条和父会话共有的消息（分叉点） */
export function recordPrimary(child, parent, at, kind = "fork") {
  if (!child || !parent || child === parent) return true;
  const db = lineageDb();
  db.edges[child] = { ...(db.edges[child] || {}), primary: { id: parent, at: at || null, kind } };
  return save();
}

/** 汇合时记附加父（新会话拿到会话号那一刻，run.mjs 调）。how：compact | excerpt | summary | manual。
 *  manual 是「补记来源」：手动给已有会话连一条，和原有的合并去重。
 *  一个会话最多挂 EXTRA_MAX 个附加父（审查 v0.5.13 低6：接口刷不爆记录文件）；返回这次实际记上的条数 */
export const EXTRA_MAX = 32;
export function recordExtra(child, list) {
  if (!child || !Array.isArray(list)) return 0;
  let n = 0;
  const db = lineageDb(), cur = db.edges[child] || {};
  const extra = (cur.extra || []).slice();
  for (const x of list) {
    if (!x || !x.id || x.id === child) continue;
    const i = extra.findIndex((y) => y.id === x.id);
    const v = { id: x.id, at: x.at || null, how: x.how || "excerpt", note: x.note || "" };
    if (i >= 0) extra[i] = v; else if (extra.length < EXTRA_MAX) extra.push(v); else continue;
    n++;
  }
  if (!n) return 0;
  db.edges[child] = { ...cur, extra };
  save();
  return n;
}

/** 去掉一条附加父（补记错了） */
export function dropExtra(child, id) {
  if (!child || !id) return false;
  const db = lineageDb(), cur = db.edges[child] || (db.edges[child] = {});
  if (cur.extra) cur.extra = cur.extra.filter((x) => x.id !== id);
  // 同时记一笔「别按落款连它」：落款在会话正文里删不掉，导进来的记录、伪造的落款都能凭空连出汇合线（审查 v0513b 低-25）
  const no = new Set(cur.nosig || []); no.add(id);
  cur.nosig = [...no].slice(-EXTRA_MAX);
  return save();
}

/** 会话彻底删掉时清掉它作为「子」的记录（它作为别人的父的记录留着：子会话那边画成「源自已删除的会话」） */
export function forgetChild(child) {
  const db = lineageDb();
  if (!db.edges[child]) return true;
  delete db.edges[child];
  return save();
}
