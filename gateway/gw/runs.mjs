import fs from "node:fs";
import path from "node:path";
import { CFG } from "./config.mjs";
import { SETTINGS } from "./settings-store.mjs";

// ── 会话进程状态 ──────────────────────────────────────────────────────
export const SESSIONS = new Map();   // 内存里记录本次运行见过的会话
// 正在跑的轮次（并行多会话）：runId → run。同一个会话同时只跑一轮，不同会话按设置里的上限同时跑
export const RUNS = new Map();
export const runList = () => [...RUNS.values()];
export const latestRun = () => { let r = null; for (const x of RUNS.values()) if (!r || x.startedAt >= r.startedAt) r = x; return r; };
/** 会话进了回收站之后要做的事（sessionops.trashSession 调）：清中断记录、通知界面、定时任务放下 lastSid…
 *  放在这里而不是 sessionops：queue / sched 都已经引用这个模块，不会绕成循环引用（#173） */
export const TRASH_HOOKS = [];
export const runOfSession = (sid) => (sid && runList().find((r) => r.sessionId === sid)) || null;
// 同时跑几轮：每个 claude 进程要占几百 MB 内存，开多大由用户自己把握
export const MAX_PARALLEL_CAP = 16;
export const maxParallel = () => Math.max(1, Math.min(MAX_PARALLEL_CAP, Math.round(Number(SETTINGS.maxParallel)) || 3));
// 有任务在跑时落一个标记文件：cccodroid 的冻结检测只把「跑任务时被冻」算数 ——
// 空闲时被厂商冻结器冻住无害，以前每次都记，设置页的提醒就老是弹
const RUN_FLAG = path.join(CFG.home, ".run-active");
let flagOn = null;   // 上次写的状态：saveRunMark 每次广播都会同步一次，没变就不碰文件
export const runFlag = (on) => { if (flagOn === !!on) return; flagOn = !!on; try { on ? fs.writeFileSync(RUN_FLAG, String(process.pid)) : fs.rmSync(RUN_FLAG, { force: true }); } catch {} };
runFlag(false);

// 最近真正跑过的会话。落盘保存 —— 网关重启（热替换/重开 App）后前端还能接回原来的对话。
const LAST_SESSION_FILE = path.join(CFG.home, "ccapp-last-session.json");
export let LAST_SESSION = (() => {
  try {
    const j = JSON.parse(fs.readFileSync(LAST_SESSION_FILE, "utf8"));
    if (j && j.id) return { id: String(j.id), at: Number(j.at) || 0 };
  } catch {}
  return null;
})();
export function rememberSession(id) {
  if (!id) return;
  LAST_SESSION = { id: String(id), at: Date.now() };
  try { fs.writeFileSync(LAST_SESSION_FILE, JSON.stringify(LAST_SESSION), { mode: 0o600 }); } catch {}
}
export function forgetSession() {
  LAST_SESSION = null;
  try { fs.rmSync(LAST_SESSION_FILE, { force: true }); } catch {}
}
