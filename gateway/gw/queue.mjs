import fs from "node:fs";
import path from "node:path";
import { CFG, LAST_LANG, log, tr, tz } from "./config.mjs";
import { SETTINGS, saveSettings, capList } from "./settings-store.mjs";
import { PERM_MODES, PROVIDER, keyOf, providerById } from "./providers.mjs";
import { effectiveModel } from "./sessmodel.mjs";
// 这个会话真跑时用哪家：钉的 → 项目默认 → 全局（和 run.mjs 的 pickProvider 一致；只看钉的会漏掉项目，#102 04-004）
const runProvider = (sid) => providerById(effectiveModel(sid).provider) || PROVIDER;
import { isLoginMode } from "./models.mjs";
import { findSessionFile } from "./sessions.mjs";
import { killTree, safeModePerm } from "./claude.mjs";
import { goalCheck, tasksCheck } from "./goal.mjs";
import { LAST_SESSION, RUNS, TRASH_HOOKS, latestRun, maxParallel, runFlag, runList } from "./runs.mjs";
import { NEXT, readBody, sendJson } from "./http.mjs";
import { BOOT, publish } from "./bus.mjs";
import { execIntent, lostProvider, pickProvider, startRun } from "./run.mjs";
import { cleanMergeFrom } from "./merge.mjs";
import { LOCAL_CMD_RE } from "./modelcmd.mjs";
import { tamperPending } from "./tamper.mjs";
import { RATE_LIMITS } from "./stream.mjs";

// ── 生成与排队 ────────────────────────────────────────────────────────
export const QUEUE = [];                 // 等着跑的消息：{ id, message, sessionId, follow, model, permissionMode, addDirs, at }
export const RUN_SESSIONS = new Map();   // runId → sessionId（新会话要等 init 才知道自己的会话号）
export const RUN_LANE = new Map();       // runId → 车道（跟在它后面排队的消息走同一条车道）

// ── 车道：同一个会话里的消息严格按顺序一条条跑，不同会话可以同时跑 ──
//   "s:<会话号>"  发给已有会话的
//   "n:<runId>"   新会话还没拿到会话号：以第一条消息的 runId 为名，后面跟着发的（follow）都进这条车道
function laneOf(item) {
  if (item.follow && RUN_LANE.get(item.follow)) return RUN_LANE.get(item.follow);
  // 跟着的那条自己还在排队、没起跑（RUN_LANE 里还没有它）：沿用它的车道，不然另开一条、变成两个会话（审查 #50 S2-03）
  const q = item.follow && QUEUE.find((x) => x.id === item.follow);
  if (q) return laneOfItem(q);
  return item.sessionId ? "s:" + item.sessionId : "n:" + (item.follow || item.id);
}
export const laneOfItem = (q) => q.lane || (q.lane = laneOf(q));
const sidOfLane = (lane) => lane.startsWith("s:") ? lane.slice(2) : (RUN_SESSIONS.get(lane.slice(2)) || null);
/** 这条消息真正该续的会话：明确给了 → 跟着的那条已经跑出了会话号 → 车道上记着的会话号（#120-1：
 *  跟的那条被撤销、从没启动时 RUN_SESSIONS 里没有它，但车道 n:<首条 runId> 还记着首条跑出来的会话，别因此另起一个会话） */
export const sidForItem = (item) => item.sessionId || (item.follow && RUN_SESSIONS.get(item.follow)) || sidOfLane(laneOfItem(item)) || null;
/** 这条车道上正在跑的那一轮（没有就 null）。新会话 init 之后会话号和车道名对得上 */
function laneRun(lane) {
  const sid = sidOfLane(lane);
  for (const r of RUNS.values()) if (r.lane === lane || (sid && r.sessionId === sid)) return r;
  return null;
}
const sameLane = (q, run) => { const l = laneOfItem(q), sid = sidOfLane(l); return l === run.lane || (!!sid && sid === run.sessionId); };
let RUN_N = 0;
const newRunId = () => `r${BOOT}${(++RUN_N).toString(36)}`;

const runInfo = (r) => r && {
  id: r.id, cid: r.cid, text: r.text.slice(0, 2000), sessionId: r.sessionId, follow: r.follow, startedAt: r.startedAt,
  perms: r.perms ? [...r.perms.values()] : [],
  // sealed：答完了、后台任务还在，但 stdin 已关——插话、停单个任务都送不进去，只能等它结束或整个停掉
  idle: !!r.idle, sealed: !!r.idle && !r.inputOpen && !r.ended, bg: r.bgTasks || 0, bgList: r.bgList || [], auto: r.auto || null, permMode: r.permMode || null,
};

/** 改权限模式：存进设置（下一轮沿用），正在跑的那一轮当场切（set_permission_mode） */
export function setPermMode(mode) {
  if (!PERM_MODES.includes(mode)) return false;
  if (SETTINGS.permissionMode !== mode) log(`权限模式 ${SETTINGS.permissionMode} → ${mode}`);   // 排障时看得出是谁、何时切的
  SETTINGS.permissionMode = mode;
  saveSettings();
  const eff = safeModePerm(mode);   // 安全模式下不问人的几档退回 default（见 claude.mjs），界面显示实际生效的
  for (const r of RUNS.values()) if (r.setMode) {
    r.setMode(eff);
    // 重放（切回会话、断线重连）时 init 里还是起跑时的模式，会把界面改回去，用户想收紧也发不出去（安全通告 GHSA-2w6p）
    for (const e of r.log || []) if (e.type === "init") e.permissionMode = eff;
  }
  publish({ type: "perm_mode", mode: eff });
  return true;
}
export function snapshot() {
  return {
    run: runInfo(latestRun()),           // 旧字段：最近开始的那一轮
    runs: runList().map(runInfo),
    maxParallel: maxParallel(),
    tamper: tamperPending(),           // 应用文件被改过、已还原：界面提示一次（见 tamper.mjs）
    queue: QUEUE.map((q) => ({ id: q.id, cid: q.cid, text: q.message.slice(0, 500), sessionId: q.sessionId, follow: q.follow, at: q.at, held: !!q.held, intr: !!q.intr })),
    provider: PROVIDER.id,
    model: SETTINGS.model || PROVIDER.defaultModel || null,
    lastSessionId: LAST_SESSION ? LAST_SESSION.id : null,
    interrupted: INTERRUPTED,
  };
}
export const publishState = () => { saveRunMark(); publish({ type: "state", ...snapshot() }); };

// ── 被系统杀掉后接得上（A2）──────────────────────────────────────────
// 正在跑的这一轮 + 排队的消息，每次状态变化都落盘；正常收尾、队列清空时删掉。
// App 连同网关被系统结束时它留下来：下次启动把那一轮记成「已中断」（前端给「继续」），
// 排队的消息原样放回队列、一律挂起 —— 杀掉之后不许自己发出去，用户点 ⚡ 才发。
const RUN_MARK = path.join(CFG.home, "ccapp-run-mark.json");
const INTR_FILE = path.join(CFG.home, "ccapp-interrupted.json");
export function saveRunMark() {
  // 「有任务」标记跟着同步：在跑的，加上排着、会自己发出去的（挂起等 ⚡ 的不算）。外壳据此判断划掉时能不能停服务（审查 0601b）
  runFlag(RUNS.size > 0 || QUEUE.some((q) => !q.held));
  try {
    if (!RUNS.size && !QUEUE.length) return fs.rmSync(RUN_MARK, { force: true });
    const live = runList().filter((r) => !r.ended);
    fs.writeFileSync(RUN_MARK + ".tmp", JSON.stringify({
      // done：已经答完、只是进程还留着等后台任务回报，而且任务也都清零了 —— 这时被结束不算中断
      runs: live.map((r) => ({ id: r.id, sessionId: r.sessionId, text: r.text.slice(0, 4000), startedAt: r.startedAt, ...(r.idle && !r.bgTasks ? { done: true } : {}) })),
      // 已经写进 stdin、claude 还没吃进去的插话也算排队的：一起留下
      // 新会话首条还没拿到会话号时跟着发的（只有 follow）：首条已经结束、不在 runs 里了，重启后就认不出属于哪个会话。
      // 落盘时把会话号补实（#97 02-005；跟的那条被撤销时按车道找首条跑出来的会话，#120-1）
      // 送进去还没等到结果的斜杠命令也留下，挂起（可能已经办了一半，等用户点 ⚡ 再发）
      queue: [...live.flatMap((r) => [...(r.pendingInject || []).map((it) => ({ ...it, injected: false })), ...(r.slashFlight || []).map((it) => ({ ...it, injected: false, held: true }))]), ...QUEUE]
        .map((q) => { const sid = q.sessionId || sidForItem(q); return sid ? { ...q, sessionId: sid } : q; }),
    }), { mode: 0o600 });
    fs.renameSync(RUN_MARK + ".tmp", RUN_MARK);
  } catch {}
}
// 中断记录是个列表：并行时一次会断好几轮，每个会话都要有自己的「继续」卡（群友 Yhaizg 11-01：升级时三个会话在跑，只提示了一个）
// 旧版本存的是单条对象，读的时候包成列表
const INTR_MAX = 20;
const intrList = (v) => (Array.isArray(v) ? v : v ? [v] : []).filter((e) => e && typeof e === "object" && e.id).slice(-INTR_MAX);
// 读的时候顺手丢掉会话已经不在了的（老版本回收时没清）：没建会话的照留
export let INTERRUPTED = (() => {
  try { return intrList(JSON.parse(fs.readFileSync(INTR_FILE, "utf8"))).filter((e) => { try { return !e.sessionId || !!findSessionFile(e.sessionId); } catch { return true; } }); } catch {}
  return [];
})();
export function setInterrupted(list) {
  INTERRUPTED = intrList(list);
  try {
    if (!INTERRUPTED.length) return fs.rmSync(INTR_FILE, { force: true });
    fs.writeFileSync(INTR_FILE + ".tmp", JSON.stringify(INTERRUPTED), { mode: 0o600 });   // 写到一半被杀不留半个 JSON
    fs.renameSync(INTR_FILE + ".tmp", INTR_FILE);
  } catch {}
}
/** 这个会话又跑起来了：去掉它的中断记录。没建立会话的（sid 为空）互相分不清，一律不在这里清 ——
 *  界面「重发」「忽略」时按记录 id 单独清（/api/interrupted/dismiss）。以前空会话号会把别的未建会话的中断记录一起清掉（#149-2） */
export function clearInterrupted(sid) {
  if (!sid) return;
  const left = INTERRUPTED.filter((e) => (e.sessionId || "") !== (sid || ""));
  if (left.length !== INTERRUPTED.length) setInterrupted(left);
}
// 会话进了回收站：它的中断记录没用了（不然启动时还会拿它当目标会话打开、挂一张「继续」卡，#173-5）；
// 正开着它的界面收到 session_gone 自己退回新对话（服务端删的：项目连目录删、定时任务不存对话、别的窗口，#173-4）
TRASH_HOOKS.push((id) => {
  clearInterrupted(id);
  publish({ type: "session_gone", id });
  publishState();
});
/** 启动时调一次：上一任留下的标记 → 中断记录 + 挂起的队列 */
export function recoverRunMark() {
  let m;
  try { m = JSON.parse(fs.readFileSync(RUN_MARK, "utf8")); } catch { return; }
  finally { try { fs.rmSync(RUN_MARK, { force: true }); } catch {} }
  // 并行时可能同时断了好几轮：每个会话各记一条，各挂各的「继续」卡
  const runs = (Array.isArray(m.runs) ? m.runs : m.run ? [m.run] : []).filter((r) => r && r.id && !r.done).sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  for (const r of runs) {
    if (r.sessionId) RUN_SESSIONS.set(r.id, r.sessionId);
    log(`⚠️ 上一轮没跑完就被结束了（会话 ${r.sessionId || "未建立"}），已标为中断`);
  }
  if (runs.length) {
    const now = Date.now(), fresh = runs.map((r) => ({ ...r, at: now }));
    // 上次没处理的中断记录留着；同一个会话以这次的为准
    const sids = new Set(fresh.map((r) => r.sessionId || ""));
    setInterrupted([...INTERRUPTED.filter((e) => !sids.has(e.sessionId || "")), ...fresh]);
  }
  for (const q of Array.isArray(m.queue) ? m.queue : []) {
    if (!q || !q.id || typeof q.message !== "string") continue;
    if (!q.sessionId && q.follow && RUN_SESSIONS.get(q.follow)) q.sessionId = RUN_SESSIONS.get(q.follow);
    // 会话已经删了（进了回收站）：这条再也看不到、点不了 ⚡，留着只会让 queued 一直不为 0，工具包更新永远等「任务结束」（群友 10-31）
    if (q.sessionId && !findSessionFile(q.sessionId)) { log(`  会话 ${q.sessionId} 已不在，丢掉它排着的一条消息`); continue; }
    QUEUE.push({ ...q, held: true, intr: true });   // intr：前端据此说「被系统中断」而不是「点了停止」
  }
  if (QUEUE.length) { log(`  排队的 ${QUEUE.length} 条消息已放回队列（挂起，等用户点 ⚡）`); saveRunMark(); }
}

// 逐字增量太碎：攒 40ms 合成一条再发，其它事件到来前先冲掉，保证顺序不乱
export function runEmit(run, ev) {
  if (run.ended) return;
  ev.runId = run.id;
  if (ev.type === "delta" || ev.type === "thinking_delta") {
    if (run.pend && run.pend.type === ev.type) run.pend.text += ev.text;
    else { flushPend(run); run.pend = ev; }
    if (!run.pendTimer) run.pendTimer = setTimeout(() => flushPend(run), 40);
    return;
  }
  flushPend(run);
  record(run, ev);
  publish(ev);
}
export function flushPend(run) {
  if (run.pendTimer) { clearTimeout(run.pendTimer); run.pendTimer = null; }
  const p = run.pend; run.pend = null;
  if (p) { record(run, p); publish(p); }
}
/** 这一轮的完整事件记录 —— 断线太久环形缓冲续不上时，靠它把整轮重放给前端。
 *  相邻增量就地合并，一轮再长也只有"块数"那么多条。 */
function record(run, ev) {
  const last = run.log[run.log.length - 1];
  if (last && last.type === ev.type && (ev.type === "delta" || ev.type === "thinking_delta")) last.text += ev.text;
  else if (last && last.type === "usage" && ev.type === "usage") run.log[run.log.length - 1] = { ...ev };
  else if (last && last.type === "phase" && ev.type === "phase") run.log[run.log.length - 1] = { ...ev };
  // 本轮输出 token 每秒一条，夹在增量中间合并不到：只留一条、原地改成最新的数（重放只要最后的值）
  else if (ev.type === "run_tokens" && run.tokAt != null && run.log[run.tokAt]?.type === "run_tokens") run.log[run.tokAt] = { ...ev };
  else { if (ev.type === "run_tokens") run.tokAt = run.log.length; run.log.push({ ...ev }); }
}

/** 开跑前的最后一道核对（定时任务：入队后任务被删 / 被关就不跑）。返回 false = 丢掉这条 */
export const START_GUARDS = [];
const startable = (q) => START_GUARDS.every((g) => { try { return g(q) !== false; } catch (e) { log("开跑核对出错: " + e.message); return true; } });
/** 一轮结束时要知道的模块（定时任务记运行记录）在这里挂；钩子出错不影响收尾 */
export const END_HOOKS = [];
export function endRun(run, fields = {}) {
  if (run.ended) return;
  if (run.limitTimer) clearTimeout(run.limitTimer);
  for (const h of END_HOOKS) { try { h(run, fields); } catch (e) { log("结束钩子出错: " + e.message); } }
  flushPend(run);
  run.ended = true;
  RUNS.delete(run.id);
  if (!RUNS.size && !QUEUE.some((q) => !q.held)) runFlag(false);
  // at：真正结束的时刻。断线后增量补发的 run_end 晚到几分钟，回复用时不能按收到的时刻算（#142-4）
  publish({ type: "run_end", at: Date.now(), runId: run.id, sessionId: run.sessionId, aborted: !!run.aborted, ...(run.auto ? { auto: run.auto } : {}), ...(run.sched ? { sched: true } : {}), ...fields });
  goalCheck(run.sessionId);
  tasksCheck(run.sessionId);
  run.log = [];
  publishState();
  setImmediate(pump);
}

export function abortRun(run, { hold = true } = {}) {
  if (!run || run.ended) return false;
  run.aborted = true;
  run.readyAbort?.abort();
  // 停止要和排队的消息严格隔开：此刻排着的一律挂起，不许这一轮一结束就自动发出去
  // （以前点停止反而是"立刻发下一条"）。用户点 ⚡ 才发；停止之后新发的消息不受影响，照常先跑
  // 并行时只挂起这个会话自己排着的，别的会话不受影响。
  // hold:false 只给「答完了、只剩后台任务、输入已关」的那种：用户要的是让排着的消息发出去，不是停对话
  if (hold) holdLane(run); else run.retired = true;   // retired：这一轮的回答早就完整了，收尾别报成「已中断」
  if (run.child) {
    const c = run.child;
    killTree(c);
    // 收尾靠 claude 的输出管道关掉（close 事件）。要是哪个子孙另开了进程组、攥着管道没被杀到，close 就永远不来，
    // 这一轮一直挂在「生成中」：5 秒还没收尾就再杀一遍、把管道关掉，还不行就直接收尾
    setTimeout(() => {
      if (run.ended) return;
      log("⏹ 停止 5 秒后还没收尾，强制关掉 claude 的输出管道");
      killTree(c);
      for (const s of [c.stdin, c.stdout, c.stderr]) try { s?.destroy(); } catch {}
      setTimeout(() => { if (!run.ended) { try { run.agents?.close(); } catch {} try { run.requeuePending?.(); } catch (e) { log("退回未送达消息失败: " + e.message); } endRun(run, run.sched && run.costSeen ? { costRaw: run.costSeen } : {}); } }, 2000).unref();
    }, 5000).unref();
  }
  return true;
}

/** 把这个会话排着的消息全挂起：点停止、权限卡上「拒绝并停止」都走这里 */
export function holdLane(run) {
  run.laneHeld = true;   // 已写进 stdin、还没被吃的插话，结束退回队首时也要挂起（#52 P2-3）
  for (const q of QUEUE) if (sameLane(q, run)) { q.held = true; q.intr = false; }
}

// ── 空闲压缩（上游 2.1.299 起只在终端交互模式里有；网关每轮起一个进程，用不上，照它的条件自己做）──
// 上游的条件：自动压缩开着、没关空闲压缩、1 小时缓存、缓存还热、上下文 ≥ 20 万、之后没有新请求、额度没逼近上限。
// 1 小时缓存从接口返回的 cache_creation.ephemeral_1h_input_tokens 看出来（订阅账户就是这种）；
// 第三方厂商的缓存规则各不相同，不做。计时从这一轮结束算起，54 分钟时缓存还剩约 6 分钟。
// 两个环境变量只给测试用（缩短等待、降低门槛）
const IDLE_MS = Number(process.env.CCAPP_IDLE_MS) || 54 * 60 * 1000, IDLE_MIN_TOKENS = Number(process.env.CCAPP_IDLE_MIN) || 200000;
const IDLE = new Map();   // 会话号 → { timer, ctx, at, size }
export function idleDisarm(sid) { const x = IDLE.get(sid); if (x) { clearTimeout(x.timer); IDLE.delete(sid); } }
export function idleDisarmAll() { for (const sid of [...IDLE.keys()]) idleDisarm(sid); }
function autoCompactOff() {
  if (/^(1|true)$/i.test(process.env.DISABLE_COMPACT || "") || /^(1|true)$/i.test(process.env.DISABLE_AUTO_COMPACT || "")) return true;
  try { return JSON.parse(fs.readFileSync(path.join(CFG.home, ".claude", "settings.json"), "utf8")).autoCompactEnabled === false; } catch { return false; }
}
export function idleArm(sid, flags) {
  idleDisarm(sid);
  const ctx = flags.mainCtx || 0;
  const P = runProvider(sid);            // 按这个会话用的那家（缓存计时只对原生家有意义）
  if (SETTINGS.idleCompaction === false || !P.nativeModels || P.local) return;
  if (!flags.cache1h || flags.cache5m || ctx < IDLE_MIN_TOKENS || autoCompactOff()) return;
  let size = -1; try { size = fs.statSync(findSessionFile(sid).file).size; } catch { return; }
  const timer = setTimeout(() => idleFire(sid), IDLE_MS);
  timer.unref?.();
  IDLE.set(sid, { timer, ctx, at: Date.now(), size });
  log(`⏲ 空闲压缩已挂上：会话 ${sid.slice(0, 8)} 上下文 ${ctx}，${IDLE_MS / 60000} 分钟后没动静就压缩`);
}
function idleFire(sid) {
  const x = IDLE.get(sid);
  IDLE.delete(sid);
  const P = runProvider(sid);
  if (!x || SETTINGS.idleCompaction === false || !P.nativeModels) return;
  const why = (() => {
    if (laneRun("s:" + sid)) return "正在跑";
    if (QUEUE.some((q) => sidOfLane(laneOfItem(q)) === sid)) return "有排队的消息";
    try { if (fs.statSync(findSessionFile(sid).file).size !== x.size) return "会话有新内容"; } catch { return "会话文件不见了"; }
    const rl = RATE_LIMITS;
    if (rl && isLoginMode(P) && Math.max(rl.fiveHour?.used || 0, rl.sevenDay?.used || 0) >= 90) return "额度逼近上限";
    return null;
  })();
  if (why) { log(`⏲ 空闲压缩跳过（${why}）：会话 ${sid.slice(0, 8)}`); return; }
  log(`⏲ 空闲压缩：会话 ${sid.slice(0, 8)} 闲置 ${Math.round((Date.now() - x.at) / 60000)} 分钟，上下文 ${x.ctx}`);
  enqueue({ message: "/compact", sessionId: sid, auto: "idle" });
}

/** 有空位就从队列里挑能跑的：车道空闲、且是这条车道上排在最前的（同一会话不许插队、不许同时跑两轮） */
export function pump() {
  const blocked = new Set();
  for (let i = 0; i < QUEUE.length && RUNS.size < maxParallel(); ) {
    const q = QUEUE[i];
    if (q.held) { i++; continue; }                  // 停止时挂起的不自动发，也不挡后面新发的
    if (!startable(q)) { QUEUE.splice(i, 1); publishState(); continue; }
    const lane = laneOfItem(q), key = sidOfLane(lane) || lane;
    if (blocked.has(key) || laneRun(lane)) { blocked.add(key); i++; continue; }
    blocked.add(key);
    const item = QUEUE.splice(i, 1)[0];
    startRun(item).catch((e) => {                   // startRun 同步占槽，RUNS.size 立刻算上它
      log(`run 异常: ${e.stack || e.message}`);
      const r = RUNS.get(item.id);
      if (r) {
        runEmit(r, { type: "error", message: tr(LAST_LANG, tz("内部错误：{err}", { err: e.message })) });
        endRun(r, { failed: true });
      }
    });
  }
}

const MSG_MAX = 2000000;                        // 字（UTF-16 码元）：两百万字早超过任何模型的上下文
const SID_OK = /^[A-Za-z0-9_-]{1,80}$/;
/** 字符串数组：只留字符串，条数、每条长度、总长都有上限（总长见 settings-store 的 capList） */
export const strList = (a, n, len, total) => capList(a, n, len, total);
export function enqueue(body) {
  const item = {
    id: newRunId(),
    message: String(body.message || ""),
    sessionId: body.sessionId ? String(body.sessionId) : null,
    follow: body.follow ? String(body.follow) : null,
    cid: body.cid ? String(body.cid).slice(0, 64) : null,   // 前端自己的消息号：SSE 可能比 POST 的响应先到
    model: typeof body.model === "string" ? body.model.slice(0, 200) : null,
    // 新会话（还没会话号）在输入栏面板里选的模型 / 思考强度：跑起来拿到会话号时记成这个会话自己的（gw/sessmodel.mjs）
    pin: !body.sessionId && body.pin && typeof body.pin === "object" ? Object.fromEntries(["model", "effort", "provider"].filter((k) => typeof body.pin[k] === "string").map((k) => [k, body.pin[k].slice(0, 200)])) : null,
    permissionMode: typeof body.permissionMode === "string" ? body.permissionMode.slice(0, 40) : null,
    addDirs: strList(body.addDirs, 64, 4096, 16384),
    projectId: body.projectId ? String(body.projectId).slice(0, 100) : null,
    // 汇合（脉络阶段 2）：新会话第一条带来的来源，拿到会话号时记进 ccapp-lineage.json
    mergeFrom: !body.sessionId && !body.follow ? cleanMergeFrom(body.mergeFrom) : null,
    at: Date.now(),
    // 只有网关自己（定时任务）会带的：前端发来的 /api/chat 不许设这些
    ...(body.internal ? { cwd: body.cwd || null, effort: body.effort || null, provider: body.provider || null, sched: body.sched || null, unattended: !!body.unattended,
      allowedTools: body.allowedTools || null, disallowedTools: body.disallowedTools || null, timeoutMs: body.timeoutMs || 0, limitCost: +body.limitCost || 0 } : {}),
    ...(body.auto ? { auto: body.auto } : {}),
  };
  // 插话（"inject"，旧前端叫 "interrupt"）：不打断。消息直接写进正在跑的 claude 的 stdin，
  // claude 会在当前这一步（比如一次工具调用）结束后把它并进对话，同一轮里接着干 —— 和终端里边干边打字一样。
  // 塞不进去（这一轮已在收尾、或者不是同一个会话）就排到队首，这一轮一结束马上发。
  const busyRun = laneRun(laneOfItem(item));
  // 定时任务不走这条：塞进别人的轮次，它自己的工具限制、无人值守、时长上限都没了，结束时也认不出是它（审查 B05）。排队等那一轮结束
  // 自动复用空闲进程前还要核对执行配置：面板里刚换了接口/模型/思考强度，消息就不能再悄悄交给旧进程（#120-2）
  if (busyRun && busyRun.idle && !item.sched && sameExec(busyRun, item) && tryInject(busyRun, item)) { item.injected = true; publishState(); return item; }
  if ((body.mode === "inject" || body.mode === "interrupt") && busyRun) {
    // 显式插话也要核对执行配置：面板刚换了接口/模型/思考强度，塞进旧进程就等于还按旧配置跑（同 #120-2）
    if (sameExec(busyRun, item) && tryInject(busyRun, item)) { item.injected = true; return item; }
    QUEUE.unshift(item);
  } else {
    QUEUE.push(item);
  }
  publishState();
  pump();
  return item;
}

function tryInject(run, item) {
  if (!run.inject) return false;
  // 斜杠命令：这一轮答完、只剩后台任务在跑时直接送进 claude（stdin 上照样认 /compact /context 这类，11-05 实测：
  // 就地压缩、后台任务不受影响）。还在生成时照旧排队等这一轮结束；网关自己处理的（/model 等）得自己单跑一轮
  const msg = item.message.trim();
  // 定时任务 / 无人值守的那一轮不收用户的命令：花费会记到任务头上、超预算还会把任务打断（复核 v067b-6）
  if (msg.startsWith("/") && (!run.idle || LOCAL_CMD_RE.test(msg) || run.sched || run.unattended || run.auto)) return false;
  const same = item.sessionId ? item.sessionId === run.sessionId : (item.follow === run.id || !item.follow);
  if (!same) return false;
  return run.inject(item);
}

/** 空闲的后台进程能不能自动收下这条普通消息：除了会话对得上，执行配置也得还是它起跑时那份（#120-2）。
 *  用户在面板里换了接口 / 模型 / 思考强度后保存已经生效；再把消息塞进旧进程就等于还按旧配置跑。
 *  没记下配置的轮次一律不复用（照常排队），宁可慢一步也不静默用错配置。 */
function sameExec(run, item) {
  if (!run.exec) return false;
  let now;
  try { now = execIntent(item); } catch { return false; }
  return now.P.id === run.exec.provider && now.model === run.exec.model && now.effort === run.exec.effort;
}

// ── 路由：/api/chat /api/interrupted/dismiss /api/queue/ ──
export async function routeQueue(req, res, u, p) {
  if (req.method === "POST" && p === "/api/chat") {
    let b;
    try { b = JSON.parse((await readBody(req)) || "{}"); } catch { return sendJson(res, 400, { error: "bad json" }); }
    if (!String(b.message || "").trim()) return sendJson(res, 400, { error: "empty message" });
    // 看这条消息要用的那家（新会话首条选的 / 会话钉的 / 全局的），不是只看全局
    const q0 = { sessionId: b.sessionId ? String(b.sessionId) : null, follow: b.follow || null, projectId: b.projectId ? String(b.projectId) : null,
      pin: !b.sessionId && b.pin && typeof b.pin.provider === "string" ? { provider: b.pin.provider } : null };
    const pk = pickProvider(q0), bp = pk.P;
    // 要用的那家不在了（写错、删了）：当场拒，不悄悄换成全局默认那家发出去（起跑时 startRun 还会再挡一次）
    const lost = lostProvider(q0, pk.sid0, pk.pdef0);
    if (lost) return sendJson(res, 409, { error: "provider_gone", message: lost });
    if (!keyOf(bp) && !bp.login && !/^\/(model|models|effort|autocompact)\b/i.test(String(b.message).trim())) {
      return sendJson(res, 503, {
        error: "no_api_key",
        message: tz("「{name}」还没填 Key。到 设置 → 接口 里填好保存，或换一个接口。", { name: bp.label || bp.id }),
      });
    }
    if (QUEUE.length >= 50) return sendJson(res, 429, { error: "queue_full", message: tz("排队的消息太多了。") });
    // 字段都有上限（审查 v0513b 低-3）：排队 50 条 × 不限长的正文能把内存吃满；会话号这类直接进 claude 的参数
    if (String(b.message).length > MSG_MAX) return sendJson(res, 413, { error: "too_long", message: tz("这条消息太长了（超过 200 万字），改成文件发吧。") });
    for (const k of ["sessionId", "follow"]) if (b[k] != null && b[k] !== "" && !SID_OK.test(String(b[k]))) return sendJson(res, 400, { error: "bad " + k });
    const item = enqueue({ ...b, internal: false, auto: undefined });   // auto（空闲压缩轮）也只许网关自己设（审查 10-30 第九份 后端低8）
    return sendJson(res, 200, { ok: true, id: item.id, injected: !!item.injected, started: RUNS.has(item.id) });
  }
  if (req.method === "POST" && p === "/api/interrupted/dismiss") {
    // 带 id 只忽略那一条；不带（旧界面）全清
    let b; try { b = JSON.parse((await readBody(req)) || "{}"); } catch { return sendJson(res, 400, { error: "bad json" }); }
    setInterrupted(b && typeof b.id === "string" ? INTERRUPTED.filter((e) => e.id !== b.id) : []);
    publishState();
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === "POST" && p.startsWith("/api/queue/")) {
    let b; try { b = JSON.parse((await readBody(req)) || "{}"); } catch { return sendJson(res, 400, { error: "bad json" }); }
    const act = p.slice("/api/queue/".length);
    const i = QUEUE.findIndex((q) => q.id === b.id);
    if (act === "clear") {
      // 带 ids 只清这些（前端只清当前会话的）；不带就全清
      if (Array.isArray(b.ids)) { const ids = new Set(b.ids.map(String)); for (let k = QUEUE.length - 1; k >= 0; k--) if (ids.has(QUEUE[k].id)) QUEUE.splice(k, 1); }
      else QUEUE.length = 0;
    } else if (i < 0) return sendJson(res, 404, { error: "not queued" });
    else if (act === "remove") QUEUE.splice(i, 1);
    else if (act === "promote") {          // ⚡ 插话：塞进正在跑的这一轮（不打断）；塞不进就挪到队首
      const it = QUEUE.splice(i, 1)[0];
      it.held = false;                      // 挂起的消息靠这个放行
      const lr = laneRun(laneOfItem(it));
      // ⚡ 也一样：执行配置变了就宁可排队等这一轮结束，不要把消息塞进用旧接口/旧模型的进程
      if (!(lr && sameExec(lr, it) && tryInject(lr, it))) {
        QUEUE.unshift(it);
        // 那一轮答完了、只剩后台任务：这条只能等它结束。用户点了 ⚡ 就是不等——连同后台任务结束它，收尾后这条接着发。
        // 输入还开着也要结束：配置已经变了，继续等它不会变成能注入的状态（#139 回归）
        if (lr && lr.idle && !lr.ended) { log("⚡ 上一轮只剩后台任务，结束它好发出排着的消息"); abortRun(lr, { hold: false }); }
      }
    } else if (act === "edit") {
      const t = String(b.text || "").trim();
      if (t.length > MSG_MAX) return sendJson(res, 413, { error: "too_long", message: tz("这条消息太长了（超过 200 万字），改成文件发吧。") });
      if (!t) QUEUE.splice(i, 1); else QUEUE[i].message = t;
    } else return sendJson(res, 404, { error: "unknown action" });
    publishState();
    pump();
    return sendJson(res, 200, { ok: true, queue: snapshot().queue });
  }
  return NEXT;
}
