import fs from "node:fs";
import path from "node:path";
import { CFG, LIVE, LAST_LANG, log, tr, tz } from "./config.mjs";
import { SETTINGS, saveSettings } from "./settings.mjs";
import { PERM_MODES, PROVIDER, keyOf, providerById } from "./providers.mjs";
import { sessProvider } from "./sessmodel.mjs";
import { isLoginMode } from "./models.mjs";
import { findSessionFile } from "./sessions.mjs";
import { killTree } from "./claude.mjs";
import { goalCheck, tasksCheck } from "./goal.mjs";
import { LAST_SESSION, RUNS, latestRun, maxParallel, runFlag, runList } from "./runs.mjs";
import { NEXT, readBody, sendJson } from "./http.mjs";
import { BOOT, publish } from "./bus.mjs";
import { startRun } from "./run.mjs";
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
  return item.sessionId ? "s:" + item.sessionId : "n:" + (item.follow || item.id);
}
export const laneOfItem = (q) => q.lane || (q.lane = laneOf(q));
const sidOfLane = (lane) => lane.startsWith("s:") ? lane.slice(2) : (RUN_SESSIONS.get(lane.slice(2)) || null);
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
  idle: !!r.idle, bg: r.bgTasks || 0, bgList: r.bgList || [], auto: r.auto || null,
};

/** 改权限模式：存进设置（下一轮沿用），正在跑的那一轮当场切（set_permission_mode） */
export function setPermMode(mode) {
  if (!PERM_MODES.includes(mode)) return false;
  if (SETTINGS.permissionMode !== mode) log(`权限模式 ${SETTINGS.permissionMode} → ${mode}`);   // 排障时看得出是谁、何时切的
  SETTINGS.permissionMode = mode;
  saveSettings();
  for (const r of RUNS.values()) if (r.setMode) r.setMode(mode);
  publish({ type: "perm_mode", mode });
  return true;
}
export function snapshot() {
  return {
    run: runInfo(latestRun()),           // 旧字段：最近开始的那一轮
    runs: runList().map(runInfo),
    maxParallel: maxParallel(),
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
  try {
    if (!RUNS.size && !QUEUE.length) return fs.rmSync(RUN_MARK, { force: true });
    const live = runList().filter((r) => !r.ended);
    fs.writeFileSync(RUN_MARK + ".tmp", JSON.stringify({
      runs: live.map((r) => ({ id: r.id, sessionId: r.sessionId, text: r.text.slice(0, 4000), startedAt: r.startedAt })),
      // 已经写进 stdin、claude 还没吃进去的插话也算排队的：一起留下
      queue: [...live.flatMap((r) => (r.pendingInject || []).map((it) => ({ ...it, injected: false }))), ...QUEUE],
    }), { mode: 0o600 });
    fs.renameSync(RUN_MARK + ".tmp", RUN_MARK);
  } catch {}
}
export let INTERRUPTED = (() => {
  try { const j = JSON.parse(fs.readFileSync(INTR_FILE, "utf8")); if (j && j.id) return j; } catch {}
  return null;
})();
export function setInterrupted(v) {
  INTERRUPTED = v;
  try { v ? fs.writeFileSync(INTR_FILE, JSON.stringify(v), { mode: 0o600 }) : fs.rmSync(INTR_FILE, { force: true }); } catch {}
}
/** 启动时调一次：上一任留下的标记 → 中断记录 + 挂起的队列 */
function recoverRunMark() {
  let m;
  try { m = JSON.parse(fs.readFileSync(RUN_MARK, "utf8")); } catch { return; }
  finally { try { fs.rmSync(RUN_MARK, { force: true }); } catch {} }
  // 并行时可能同时断了好几轮：「继续」卡只挂最近开始的那一轮，其余的会话内容都在，用户打开接着聊就行
  const runs = (Array.isArray(m.runs) ? m.runs : m.run ? [m.run] : []).filter((r) => r && r.id).sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  for (const r of runs) {
    if (r.sessionId) RUN_SESSIONS.set(r.id, r.sessionId);
    log(`⚠️ 上一轮没跑完就被结束了（会话 ${r.sessionId || "未建立"}），已标为中断`);
  }
  if (runs.length) setInterrupted({ ...runs[runs.length - 1], at: Date.now() });
  for (const q of Array.isArray(m.queue) ? m.queue : []) {
    if (!q || !q.id || typeof q.message !== "string") continue;
    if (!q.sessionId && q.follow && RUN_SESSIONS.get(q.follow)) q.sessionId = RUN_SESSIONS.get(q.follow);
    QUEUE.push({ ...q, held: true, intr: true });   // intr：前端据此说「被系统中断」而不是「点了停止」
  }
  if (QUEUE.length) { log(`  排队的 ${QUEUE.length} 条消息已放回队列（挂起，等用户点 ⚡）`); saveRunMark(); }
}
if (LIVE) recoverRunMark();

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
  else run.log.push({ ...ev });
}

/** 一轮结束时要知道的模块（定时任务记运行记录）在这里挂；钩子出错不影响收尾 */
export const END_HOOKS = [];
export function endRun(run, fields = {}) {
  if (run.ended) return;
  if (run.limitTimer) clearTimeout(run.limitTimer);
  for (const h of END_HOOKS) { try { h(run, fields); } catch (e) { log("结束钩子出错: " + e.message); } }
  flushPend(run);
  run.ended = true;
  RUNS.delete(run.id);
  if (!RUNS.size) runFlag(false);
  publish({ type: "run_end", runId: run.id, sessionId: run.sessionId, aborted: !!run.aborted, ...(run.auto ? { auto: run.auto } : {}), ...(run.sched ? { sched: true } : {}), ...fields });
  goalCheck(run.sessionId);
  tasksCheck(run.sessionId);
  run.log = [];
  publishState();
  setImmediate(pump);
}

export function abortRun(run) {
  if (!run || run.ended) return false;
  run.aborted = true;
  // 停止要和排队的消息严格隔开：此刻排着的一律挂起，不许这一轮一结束就自动发出去
  // （以前点停止反而是"立刻发下一条"）。用户点 ⚡ 才发；停止之后新发的消息不受影响，照常先跑
  // 并行时只挂起这个会话自己排着的，别的会话不受影响
  for (const q of QUEUE) if (sameLane(q, run)) { q.held = true; q.intr = false; }
  if (run.child) killTree(run.child);
  return true;
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
  const P = sessProvider(sid);           // 按这个会话用的那家（缓存计时只对原生家有意义）
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
  const P = sessProvider(sid);
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

export function enqueue(body) {
  const item = {
    id: newRunId(),
    message: String(body.message || ""),
    sessionId: body.sessionId ? String(body.sessionId) : null,
    follow: body.follow ? String(body.follow) : null,
    cid: body.cid ? String(body.cid).slice(0, 64) : null,   // 前端自己的消息号：SSE 可能比 POST 的响应先到
    model: body.model || null,
    // 新会话（还没会话号）在输入栏面板里选的模型 / 思考强度：跑起来拿到会话号时记成这个会话自己的（gw/sessmodel.mjs）
    pin: !body.sessionId && body.pin && typeof body.pin === "object" ? Object.fromEntries(["model", "effort", "provider"].filter((k) => typeof body.pin[k] === "string").map((k) => [k, body.pin[k].slice(0, 200)])) : null,
    permissionMode: body.permissionMode || null,
    addDirs: Array.isArray(body.addDirs) ? body.addDirs : [],
    projectId: body.projectId ? String(body.projectId) : null,
    at: Date.now(),
    // 只有网关自己（定时任务、频道）会带的：前端发来的 /api/chat 不许设这些
    ...(body.internal ? { cwd: body.cwd || null, effort: body.effort || null, provider: body.provider || null, sched: body.sched || null, channel: body.channel || null, unattended: !!body.unattended,
      allowedTools: body.allowedTools || null, disallowedTools: body.disallowedTools || null, timeoutMs: body.timeoutMs || 0 } : {}),
    ...(body.auto ? { auto: body.auto } : {}),
  };
  // 插话（"inject"，旧前端叫 "interrupt"）：不打断。消息直接写进正在跑的 claude 的 stdin，
  // claude 会在当前这一步（比如一次工具调用）结束后把它并进对话，同一轮里接着干 —— 和终端里边干边打字一样。
  // 塞不进去（这一轮已在收尾、或者不是同一个会话）就排到队首，这一轮一结束马上发。
  const busyRun = laneRun(laneOfItem(item));
  if (busyRun && busyRun.idle && tryInject(busyRun, item)) { item.injected = true; publishState(); return item; }
  if ((body.mode === "inject" || body.mode === "interrupt") && busyRun) {
    if (tryInject(busyRun, item)) { item.injected = true; return item; }
    QUEUE.unshift(item);
  } else {
    QUEUE.push(item);
  }
  publishState();
  pump();
  return item;
}

function tryInject(run, item) {
  if (!run.inject || item.message.trim().startsWith("/")) return false;   // 斜杠命令得自己单跑一轮
  const same = item.sessionId ? item.sessionId === run.sessionId : (item.follow === run.id || !item.follow);
  if (!same) return false;
  return run.inject(item);
}

// ── 路由：/api/chat /api/interrupted/dismiss /api/queue/ ──
export async function routeQueue(req, res, u, p) {
  if (req.method === "POST" && p === "/api/chat") {
    let b;
    try { b = JSON.parse((await readBody(req)) || "{}"); } catch { return sendJson(res, 400, { error: "bad json" }); }
    if (!String(b.message || "").trim()) return sendJson(res, 400, { error: "empty message" });
    // 看这条消息要用的那家（新会话首条选的 / 会话钉的 / 全局的），不是只看全局
    const bp = (b.pin && typeof b.pin.provider === "string" && !b.sessionId && providerById(b.pin.provider)) || sessProvider(b.sessionId || null);
    if (!keyOf(bp) && !bp.login && !/^\/(model|models|effort|autocompact)\b/.test(String(b.message).trim())) {
      return sendJson(res, 503, {
        error: "no_api_key",
        message: tz("「{name}」还没填 Key。到 设置 → 接口 里填好保存，或换一个接口。", { name: bp.label || bp.id }),
      });
    }
    if (QUEUE.length >= 50) return sendJson(res, 429, { error: "queue_full", message: tz("排队的消息太多了。") });
    const item = enqueue({ ...b, internal: false });
    return sendJson(res, 200, { ok: true, id: item.id, injected: !!item.injected, started: RUNS.has(item.id) });
  }
  if (req.method === "POST" && p === "/api/interrupted/dismiss") {
    setInterrupted(null);
    publishState();
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === "POST" && p.startsWith("/api/queue/")) {
    const b = JSON.parse((await readBody(req)) || "{}");
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
      if (!(lr && tryInject(lr, it))) QUEUE.unshift(it);
    } else if (act === "edit") {
      const t = String(b.text || "").trim();
      if (!t) QUEUE.splice(i, 1); else QUEUE[i].message = t;
    } else return sendJson(res, 404, { error: "unknown action" });
    publishState();
    pump();
    return sendJson(res, 200, { ok: true, queue: snapshot().queue });
  }
  return NEXT;
}
