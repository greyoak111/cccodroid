import fs from "node:fs";
import path from "node:path";
import { CFG } from "./config.mjs";
import { SETTINGS } from "./settings-store.mjs";
import { writeAtomic } from "./statefile.mjs";
import { guarded } from "./crashguard.mjs";

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
const RUN_PID = String(process.pid);
let wantOn = false;    // 想要的状态
let flagOn = null;     // 上一次确认生效的状态：写失败时与 wantOn 不同，靠定时器重试
let flagTimer = null;
let flagTries = 0;

/** 标记文件的主人还活着吗。pid 被复用成别的进程时也当活着：宁可当「有任务」，也别把另一个网关的标记删了 */
function ownerAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === "EPERM"; }
}

/** 删标记。只删自己的，或主人已经不在了的残留 —— 另一个还活着的网关（开发时手起第二个、热替换的交接间隙）
 *  写的标记不能碰：删了它，界面一划走外壳就把正在跑任务的服务停了（0.6.9 审计 13-03） */
function dropFlag() {
  let pid = "";
  try { pid = fs.readFileSync(RUN_FLAG, "utf8").trim(); } catch { return true; }   // 本来就没有
  if (pid !== RUN_PID) {
    const n = /^\d+$/.test(pid) ? Number(pid) : 0;
    if (n > 0 && n !== process.pid && ownerAlive(n)) return true;
  }
  try { fs.rmSync(RUN_FLAG, { force: true }); return true; } catch { return false; }
}

function syncFlag() {
  flagTimer = null;
  const want = wantOn;
  const ok = want ? writeAtomic(RUN_FLAG, RUN_PID, { mode: 0o600 }) : dropFlag();
  if (ok) { flagOn = want; flagTries = 0; return; }
  // 写不上（存储满、home 暂时不可写）：开始跑时没写上，界面一划走服务就停；跑完没删掉，服务永远不退出。
  // 退避重试到写成为止，状态又变了就按新的来（0.6.9 审计 13-03）
  flagOn = null;
  const ms = Math.min(30000, 500 * (1 << Math.min(flagTries++, 6)));
  flagTimer = setTimeout(guarded("同步 .run-active", syncFlag), ms);
}

export const runFlag = (on) => {
  on = !!on;
  if (on === wantOn && flagTimer) return;   // 同一状态的重试已经排着，别每次调用都立刻重来
  wantOn = on;
  if (flagOn === wantOn && !flagTimer) return;
  syncFlag();
};
// 启动时清掉上一次进程留下的残留（它已经不在了）；主人还活着的留着
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
