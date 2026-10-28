// 脉络 · 显式亲缘记录：home/ccapp-lineage.json。只记事实（谁从谁分出来、从哪条消息分），不记布局。
// 单独成一个小模块，是为了让 sessionops（分叉 / 回退）能直接写，不和 sessions / lineage 绕成循环引用。
// 格式见规划 §3.3：{ v: 1, edges: { <子会话>: { primary: { id, at, kind }, extra: [ { id, at, how, note } ] } } }
import fs from "node:fs";
import path from "node:path";
import { CFG, log } from "./config.mjs";

const FILE = path.join(CFG.home, "ccapp-lineage.json");
let DB = null;

export function lineageDb() {
  if (DB) return DB;
  try { DB = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { DB = null; }
  if (!DB || typeof DB !== "object" || !DB.edges || typeof DB.edges !== "object") DB = { v: 1, edges: {} };
  return DB;
}

function save() {
  try {
    fs.writeFileSync(FILE + ".tmp", JSON.stringify(DB), { mode: 0o600 });
    fs.renameSync(FILE + ".tmp", FILE);
  } catch (e) { log("写脉络记录失败: " + e.message); }
}

/** 分叉 / 回退时记主父。at：子会话里最后一条和父会话共有的消息（分叉点） */
export function recordPrimary(child, parent, at, kind = "fork") {
  if (!child || !parent || child === parent) return;
  const db = lineageDb();
  db.edges[child] = { ...(db.edges[child] || {}), primary: { id: parent, at: at || null, kind } };
  save();
}

/** 会话彻底删掉时清掉它作为「子」的记录（它作为别人的父的记录留着：子会话那边画成「源自已删除的会话」） */
export function forgetChild(child) {
  const db = lineageDb();
  if (!db.edges[child]) return;
  delete db.edges[child];
  save();
}
