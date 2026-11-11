// ── 上一轮没跑完的持久标记（FIND-040）──────────────────────────────
// 中断卡会被「忽略」、被下一轮成功答完清掉，中断记录本身也只留 20 条；卡没了之后，
// 会话记录里半截的助手回复和完整回复就分不出来了。
// 这里另存一份「这个会话有一轮没正常结束」，不跟着中断卡走：
//   · 一轮开跑时记上（网关被系统结束时，标记已经落盘，不依赖运行标记能不能恢复）；
//   · 收到这一轮的结果就清掉（答完 / 报错都算正常结束）；
//   · 打开会话看历史时，若这一页读到了记录末尾且没有正在生成的那一轮，末尾挂一行提示。
// 存储：home/ccapp-incomplete.json  { 会话号: { at, runId } }，留最近 1000 条。
import path from "node:path";
import { CFG, LAST_LANG, log, tr, tz } from "./config.mjs";
import { isObj, loadState, saveState } from "./statefile.mjs";

const FILE = path.join(CFG.home, "ccapp-incomplete.json");
const MAX = 1000;
const shape = (j) => {
  if (!isObj(j)) return undefined;
  const out = {};
  for (const [sid, r] of Object.entries(j)) {
    if (!isObj(r) || !/^[A-Za-z0-9_-]{1,80}$/.test(sid)) continue;
    out[sid] = { at: Number.isFinite(+r.at) ? +r.at : 0, ...(typeof r.runId === "string" ? { runId: r.runId.slice(0, 60) } : {}) };
  }
  return out;
};
const DB = loadState(FILE, { shape, fallback: () => ({}) }).data;
function saveNow() {
  const ids = Object.keys(DB);
  if (ids.length > MAX) for (const id of ids.sort((a, b) => (DB[a].at || 0) - (DB[b].at || 0)).slice(0, ids.length - MAX)) delete DB[id];
  const ok = saveState(FILE, DB, { pretty: false });
  if (!ok) log("未完成标记没保存上（存储满了或没有权限）");
  return ok;
}
/** 这个会话有一轮开始了、还没等到结果 */
export function markIncomplete(sid, runId) {
  if (!sid) return false;
  DB[sid] = { at: Date.now(), ...(typeof runId === "string" && runId ? { runId } : {}) };
  return saveNow();
}
/** 这一轮走到了结果（答完或报错）：不再是「没跑完」 */
export function clearIncomplete(sid) {
  if (sid && DB[sid]) { delete DB[sid]; return saveNow(); }
  return true;
}
export function incompleteOf(sid) { return (sid && DB[sid]) || null; }
/** 历史页末尾的持久提示；atEnd = 这一页读到了记录末尾，live = 这个会话正在生成（那时的「没跑完」是上一轮的，先不挂） */
export function incompleteItem(sid, { atEnd = false, live = false } = {}) {
  if (!atEnd || live || !incompleteOf(sid)) return null;
  return { role: "note", text: tr(LAST_LANG, tz("（上一轮没有正常结束，上面的回复可能不完整）")), incomplete: true };
}
