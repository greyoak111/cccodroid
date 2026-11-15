// ── 这个会话是不是应用里开的 ────────────────────────────────────────
// 会话列表以前把所有 .jsonl 都当用户对话；技能、脚本、终端里 `claude -p` 开的会话也会混进来，
// 跑几次就多几条。转录里分不出来（都是 entrypoint sdk-cli，子进程还继承网关的环境变量），
// 只有网关自己知道哪些是它开的：起一轮拿到会话号、分叉 / 回退、导入时各记一笔。
// 没记过的 sdk-cli 会话不藏，自动归进「杂项」：侧栏不出现，「对话」页杂项组里看得到、能一键清；
// 认错了用户点「移出杂项」，以用户为准（archive 的 miscBy=user），以后不再自动归。
//
// 存储：home/ccapp-managed-sessions.json  { since, ids: { 会话号: 记下的时刻 } }
// since：第一次运行到这一版时的时刻。比它早的会话一律当应用会话——升级不把历史会话藏起来；
// 这之后才出现的、又没记过的会话，才是外部/无头会话。
import path from "node:path";
import { CFG, log } from "./config.mjs";
import { isObj, loadState, saveState } from "./statefile.mjs";
import { onShutdown } from "./crashguard.mjs";

const FILE = path.join(CFG.home, "ccapp-managed-sessions.json");
const MAX_IDS = 5000;
const SID_RE = /^[A-Za-z0-9_-]{8,64}$/;

const shape = (j) => {
  if (!isObj(j)) return undefined;
  const ids = {};
  if (isObj(j.ids)) {
    for (const [sid, at] of Object.entries(j.ids)) {
      if (SID_RE.test(sid) && Number.isFinite(+at)) ids[sid] = +at;
    }
  }
  return { since: Number.isFinite(+j.since) ? +j.since : 0, ids };
};

let DB = loadState(FILE, { shape, fallback: () => ({ since: 0, ids: {} }) }).data;
let saveT = 0;

function saveNow() {
  const ids = Object.keys(DB.ids);
  // 和会话模型记录一样留个上限：会话删了以后标记不会自动消失，不封顶会一直长
  if (ids.length > MAX_IDS) {
    for (const id of ids.sort((a, b) => (DB.ids[a] || 0) - (DB.ids[b] || 0)).slice(0, ids.length - MAX_IDS)) delete DB.ids[id];
  }
  if (!DB.since) DB.since = Date.now();
  if (!saveState(FILE, DB, { pretty: false })) log("会话归属记录没保存上（存储满了或没有权限）");
}
function save() {
  clearTimeout(saveT);
  saveT = setTimeout(() => { saveT = 0; saveNow(); }, 300);
}

// 第一次运行到这一版：把此刻当分界。已有的会话都更早，照旧当应用会话。
if (!DB.since) { DB.since = Date.now(); saveNow(); }

/** SIGTERM 收尾：把防抖里还没写的那一段落盘（和 sessmodel 同一套） */
export function flushManagedSessions() {
  clearTimeout(saveT);
  saveT = 0;
  saveNow();
}
onShutdown("会话归属", flushManagedSessions);

export function managedSince() { return DB.since; }

/** 网关起了一轮、拿到会话号：记下这是应用里开的。重复调用无害（--resume 也会走到这里）。 */
export function noteManaged(sid) {
  if (!sid || !SID_RE.test(String(sid))) return;
  DB.ids[String(sid)] = Date.now();
  save();
}

/** 外部 / 无头会话：没记过、又是 SDK 方式跑的（交互式终端是 entrypoint cli，不算）。 */
export function looksBackground(sid, created, entrypoint) {
  return entrypoint === "sdk-cli" && !isManaged(sid, created);
}

/** 这个会话算不算应用里开的：记过的算；created 比分界早的（升级前的老会话）也算。 */
export function isManaged(sid, created) {
  if (!sid) return false;
  if (DB.ids[String(sid)]) return true;
  return DB.since > 0 && created > 0 && created < DB.since;
}
