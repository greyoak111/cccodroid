// ── 定时任务 ──────────────────────────────────────────────────────────
// 到点在指定目录里跑一次 Claude（和用户发消息走同一条队列），没人看着：要确认的一律拒绝。
// 跑完按设置通知、记运行记录，结果存成一个对话（列表里带时钟标记）。
// 计时在网关里：应用活着（前台或后台常驻）就准点。另外把最近一次的时刻报给外壳（事件 sched_next + 文件
// ccapp-sched-next），外壳定一个系统闹钟：到点叫醒应用、没在跑就拉起服务，再调 /api/sched/tick 立刻查一遍。
// 闹钟也没叫醒（被强行停止、厂商拦截）而错过的，下次启动按每个任务的「错过了」处理，不偷偷补跑。存储：home/ccapp-sched.json（任务 + 设置）、home/ccapp-sched-runs.json（运行记录，留最近 500 条）。
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { CFG, LIVE, log, tz } from "./config.mjs";
import { dec, NEXT, readBody, sendJson } from "./http.mjs";
import { END_HOOKS, QUEUE, START_GUARDS, enqueue } from "./queue.mjs";
import { capList } from "./settings-store.mjs";
import { RUNS } from "./runs.mjs";
import { publish } from "./bus.mjs";
import { NAMES, saveNames } from "./sessions.mjs";
import { trashSession } from "./sessionops.mjs";
import { projectById } from "./projects.mjs";
import { isLoginMode } from "./models.mjs";
import { pickProvider } from "./run.mjs";
import { privCall } from "./usage.mjs";
import { usdCny } from "./providers.mjs";

// node 在安卓上可能没拿到时区（TZ 没设就是 UTC）：「每天 09:00」必须按本地时间算
// 按系统设置取的就要跟着系统变：出差、手动改时区后，每天 09:00 要按新时区的 09:00（#107 06-012）。tick 里隔几分钟再问一次
const sysTz = () => { try { return execFileSync("getprop", ["persist.sys.timezone"], { encoding: "utf8", timeout: 2000 }).trim(); } catch { return ""; } };
let TZ_FROM_PROP = false, TZ_CHECKED = 0;
if (!process.env.TZ && Intl.DateTimeFormat().resolvedOptions().timeZone === "UTC") {
  const z = sysTz(); if (z) { process.env.TZ = z; TZ_FROM_PROP = true; }
}
function followSysTz(now) {
  if (!TZ_FROM_PROP || now - TZ_CHECKED < 5 * 60000) return;
  TZ_CHECKED = now;
  const z = sysTz();
  if (!z || z === process.env.TZ) return;
  log(`⏰ 系统时区 ${process.env.TZ} → ${z}，重排定时任务`);
  process.env.TZ = z;                    // node 见到 TZ 被改会重读时区
  for (const t of DB.tasks) if (t.on && t.nextAt != null && t.nextAt > now) refreshNext(t, now);   // 已到点的照常跑，跑完自然按新时区排
}

const FILE = path.join(CFG.home, "ccapp-sched.json");
const RUNS_FILE = path.join(CFG.home, "ccapp-sched-runs.json");
const DB = { tasks: [], dailyBudget: 0, missed: [], sids: [], lastTick: 0, allowLogin: false };   // dailyBudget：美元，0 = 不限
// allowLogin：用订阅账户（官方登录态）跑定时任务。默认关——无人值守使用以 Anthropic 条款为准，要用户自己确认后打开
try { Object.assign(DB, JSON.parse(fs.readFileSync(FILE, "utf8"))); } catch {}
let RUNLOG = [];
try { RUNLOG = JSON.parse(fs.readFileSync(RUNS_FILE, "utf8")); if (!Array.isArray(RUNLOG)) RUNLOG = []; } catch {}
const save = () => { try { fs.writeFileSync(FILE + ".tmp", JSON.stringify(DB, null, 1)); fs.renameSync(FILE + ".tmp", FILE); } catch (e) { log("定时任务保存失败: " + e.message); } pushNext(); };
// 最近一次要跑的时刻（毫秒，0 = 没有）→ 外壳的系统闹钟。只在变了的时候报
const NEXT_FILE = path.join(CFG.home, "ccapp-sched-next");
let lastNext = -1;
function pushNext() {
  const at = DB.tasks.reduce((m, t) => (t.on && t.nextAt && (!m || t.nextAt < m) ? t.nextAt : m), 0);
  if (at === lastNext) return;
  lastNext = at;
  try { fs.writeFileSync(NEXT_FILE, String(at)); } catch {}
  publish({ type: "sched_next", at });
}
const saveRuns = () => { RUNLOG = RUNLOG.slice(-500); try { fs.writeFileSync(RUNS_FILE + ".tmp", JSON.stringify(RUNLOG)); fs.renameSync(RUNS_FILE + ".tmp", RUNS_FILE); } catch {} };
const byId = (id) => DB.tasks.find((t) => t.id === id) || null;
// 失败后的重试定时器（按任务 id）：用户关掉、暂停、删除时要撤掉，否则到点照跑（审查 H4）。
// 不能在 fire 里看 t.on 拦：「只跑一次」「跑满次数」的任务失败那一刻 on 已经是 false，重试本来就该跑
const RETRY = new Map();
const cancelRetry = (id) => { clearTimeout(RETRY.get(id)); RETRY.delete(id); };

// ── 下次什么时候跑 ──
const hm = (s, d = "09:00") => { const m = String(s || d).match(/^(\d{1,2}):(\d{2})$/) || String(d).match(/^(\d{1,2}):(\d{2})$/); return [+m[1], +m[2]]; };
const at = (base, h, mi) => { const d = new Date(base); d.setHours(h, mi, 0, 0); return d; };
function cronField(spec, lo, hi) {
  const set = new Set();
  for (const part of String(spec).split(",")) {
    const [rng, stepS] = part.split("/"); const step = Math.max(1, +stepS || 1);
    let a = lo, b = hi;
    if (rng !== "*") { const m = rng.split("-"); a = +m[0]; b = m.length > 1 ? +m[1] : (stepS ? hi : a); }
    if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error("bad cron");
    // 先夹到 [lo, hi] 再循环：「1-999999999999」这种范围原样循环会同步空转几十分钟，把网关整个卡死（审查 M1）
    a = Math.max(lo, a); b = Math.min(hi, b);
    for (let v = a; v <= b; v += step) if (v >= lo && v <= hi) set.add(v);
  }
  // 「5-3」这种反向范围或越界值展开是空的：保存时就报错，别存下一个永远不跑的任务（审查 v0.5.3 B6）
  if (!set.size) throw new Error("bad cron");
  return set;
}
export function parseCron(expr) {
  const f = String(expr || "").trim().split(/\s+/);
  if (f.length !== 5) throw new Error(tz("cron 要五段：分 时 日 月 周"));
  // 星期按 0..7 展开，再把 7（星期日的别名）并进 0。先替换字符串再展开会把 1-7 变成 1-0，范围就空了（issue #16）
  const dow = new Set([...cronField(f[4], 0, 7)].map((d) => (d === 7 ? 0 : d)));
  return { min: cronField(f[0], 0, 59), hour: cronField(f[1], 0, 23), dom: cronField(f[2], 1, 31), mon: cronField(f[3], 1, 12), dow, domAny: f[2] === "*", dowAny: f[4] === "*" };
}
export function nextAt(task, from = Date.now()) {
  const fq = task.freq || {}, now = new Date(from);
  const after = (d) => d.getTime() > from;
  if (fq.kind === "once") {
    const [h, mi] = hm(fq.time, "02:00"); const d = new Date((fq.date || "") + "T00:00:00"); if (isNaN(d)) return null;
    d.setHours(h, mi, 0, 0); return after(d) ? d.getTime() : null;
  }
  if (fq.kind === "cron") {
    let c; try { c = parseCron(fq.cron); } catch { return null; }
    const d = new Date(from); d.setSeconds(0, 0); d.setMinutes(d.getMinutes() + 1);
    for (let i = 0; i < 366 * 24 * 60; ) {
      const domOk = c.dom.has(d.getDate()), dowOk = c.dow.has(d.getDay());
      const dayOk = c.mon.has(d.getMonth() + 1) && (c.domAny && c.dowAny ? true : c.domAny ? dowOk : c.dowAny ? domOk : domOk || dowOk);
      if (!dayOk) { d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); i += 1440; continue; }
      if (!c.hour.has(d.getHours())) { d.setHours(d.getHours() + 1, 0, 0, 0); i += 60; continue; }
      if (c.min.has(d.getMinutes())) return d.getTime();
      d.setMinutes(d.getMinutes() + 1); i++;
    }
    return null;
  }
  for (let k = 0; k < 400; k++) {
    const day = new Date(now); day.setDate(now.getDate() + k);
    if (fq.kind === "every") {
      const [h0, m0] = hm(fq.from, "08:00"), [h1, m1] = hm(fq.to, "23:00"), step = Math.max(1, +fq.hours || 2) * 60;
      for (let t = h0 * 60 + m0; t <= h1 * 60 + m1; t += step) { const d = at(day, Math.floor(t / 60), t % 60); if (after(d)) return d.getTime(); }
      continue;
    }
    const [h, mi] = hm(fq.time);
    const d = at(day, h, mi);
    if (!after(d)) continue;
    if (fq.kind === "weekly") { const wd = ((d.getDay() + 6) % 7) + 1; if (!(fq.days || [1]).includes(wd)) continue; }
    if (fq.kind === "monthly") {
      const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      const want = fq.day === "last" ? last : Math.min(+fq.day || 1, last);
      if (d.getDate() !== want) continue;
    }
    return d.getTime();
  }
  return null;
}
function refreshNext(t, from = Date.now()) {
  t.nextAt = t.on ? nextAt(t, Math.max(from, t.pausedUntil || 0)) : null;
}

// ── 条件：充电 / 电量 / Wi-Fi ──
function readSys(f) { try { return fs.readFileSync(f, "utf8").trim(); } catch { return null; } }
async function deviceState() {
  const st = { charging: null, battery: null, wifi: null };
  try {
    const r = await privCall({ op: "device_status" }, 3000);
    if (r && r.ok !== false) {
      if (typeof r.charging === "boolean") st.charging = r.charging;
      if (Number.isFinite(+r.battery)) st.battery = +r.battery;
      if (typeof r.wifi === "boolean") st.wifi = r.wifi;
      else if (typeof r.network === "string") st.wifi = /wifi/i.test(r.network);
    }
  } catch {}
  if (st.battery == null) { const c = readSys("/sys/class/power_supply/battery/capacity"); if (c != null && /^\d+$/.test(c)) st.battery = +c; }
  if (st.charging == null) { const s = readSys("/sys/class/power_supply/battery/status"); if (s) st.charging = /^(Charging|Full)$/i.test(s); }
  return st;
}

// ── 记账 ──
const dayKey = (ms) => { const d = new Date(ms); return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate(); };
const costToday = () => RUNLOG.filter((r) => dayKey(r.at) === dayKey(Date.now())).reduce((s, r) => s + (r.cost || 0), 0);
/** 脉络用：会话 → 所属定时任务 { id, name }。运行记录（留最近 500 条）+「同一个会话」任务的 lastSid，
 *  再往前的旧会话按名字「任务名 · 时间」认领；任务已删的只留名字（id 为 null） */
export function schedSessions() {
  const out = new Map(), put = (sid, t) => { if (sid && !out.has(sid)) out.set(sid, { id: t.id, name: t.name }); };
  for (const t of DB.tasks) put(t.lastSid, t);
  for (let i = RUNLOG.length - 1; i >= 0; i--) { const t = byId(RUNLOG[i].taskId); if (t) put(RUNLOG[i].sid, t); }
  for (const sid of DB.sids) {
    if (out.has(sid)) continue;
    const n = NAMES[sid] || "", t = DB.tasks.find((x) => n === x.name || n.startsWith(x.name + " · "));
    put(sid, t || { id: null, name: n.replace(/ · [\d-]+ [\d:]+$/, "") || "?" });
  }
  return out;
}
function addRun(rec) { RUNLOG.push(rec); saveRuns(); publish({ type: "sched", op: "run", taskId: rec.taskId }); return rec; }
function note(t, title, text, sessionId, ok) { publish({ type: "sched_note", taskId: t.id, title, text: String(text || "").slice(0, 200), sessionId: sessionId || null, ok: !!ok }); }

// 这个任务跑起来会用哪家：直接用 run.mjs 的 pickProvider，入参和下面 enqueue 的一致——
// 以前这里抄了一份优先级，少了「会话钉的」那层：项目默认 API、接着的会话钉了官方账户时，门禁放行了、实际用订阅跑（审查 v0.5.20 03-013）
const taskItem = (t) => ({ projectId: t.projectId && projectById(t.projectId) ? t.projectId : null, sessionId: t.session === "same" && t.lastSid ? t.lastSid : null, provider: t.provider || null });
const usesLogin = (t) => { try { return isLoginMode(pickProvider(taskItem(t)).P); } catch { return false; } };

// ── 跑一次 ──
const NULL_AT = new Map();  // 排不出下次时间的任务上次重算的时刻
const MANUAL = new Set();   // 手动「立刻跑一次」还没落到队列里的任务
const RUNNING = new Map();   // key → { taskId, startedAt, attempt, trial }
let keyN = 0;
/** 在跑 / 排着的任务。排队中的条目被用户在队列里 ✕ 掉（或清空）时没有结束钩子来删它：
 *  队列和运行里都已找不到的就清掉，不然任务一直显示「在跑」、到点不关、手动跑一直 409（DeepSeek 复核 中-1） */
function runningNow() {
  const alive = new Set();
  for (const x of [...QUEUE, ...RUNS.values()]) if (x.sched && x.sched.key) alive.add(x.sched.key);
  for (const k of [...RUNNING.keys()]) if (!alive.has(k)) RUNNING.delete(k);
  return [...RUNNING.values()];
}
const WAITING = new Set();   // 到点了、正排队等别的对话跑完的任务 id：计时别把它当成「没排上 / 时间已过」（审查 B17）
async function fire(t, { reason = "due", attempt = 0, trial = false } = {}) {
  if (trial) return fireNow(t, { reason, attempt, trial });
  WAITING.add(t.id);
  try { return await fireNow(t, { reason, attempt, trial }); } finally { WAITING.delete(t.id); }
}
async function fireNow(t, { reason, attempt, trial }) {
  const skip = (msg) => { log(`⏭ 定时任务「${t.name}」跳过：${msg}`); if (!trial) addRun({ taskId: t.id, at: Date.now(), st: "skip", msg }); };
  if (!trial) {
    if (t.until?.kind === "date" && t.until.date && Date.now() > new Date(t.until.date + "T23:59:59").getTime()) { t.on = false; refreshNext(t); save(); return skip(tz("已过有效期，任务已关")); }
    if (t.skipNext && reason === "due") { t.skipNext = false; save(); return skip(tz("按设置跳过这一次")); }
    if (usesLogin(t) && !DB.allowLogin) {
      skip(tz("用订阅账户跑定时任务默认关闭"));
      note(t, tz("定时任务已跳过"), tz("「{n}」要用订阅账户跑：到定时任务页底部「订阅账户」里打开（无人值守使用以 Anthropic 条款为准），或给任务换一个用 API Key 的接口", { n: t.name }), null, false);
      return;
    }
    if (DB.dailyBudget > 0 && costToday() >= DB.dailyBudget) { skip(tz("今天的花费已到上限")); note(t, tz("定时任务已跳过"), tz("「{n}」：今天的花费已到上限", { n: t.name }), null, false); return; }
    const c = t.cond || {};
    if (c.wifi || c.charging || c.battery) {
      const st = await deviceState();
      // 判断不了（老版本 App、Priv 不通）也不跑：仅 Wi-Fi 是为了不走流量，宁可错过一次（#108 09-001）
      if (c.wifi && st.wifi !== true) return skip(st.wifi === false ? tz("没连 Wi-Fi") : tz("判断不了是不是连着 Wi-Fi"));
      if (c.charging && st.charging === false) return skip(tz("没在充电"));
      if (c.battery && st.battery != null && st.battery < c.battery) return skip(tz("电量 {b}%，低于 {m}%", { b: st.battery, m: c.battery }));
    }
  }
  const busy = [...RUNS.values()].some((r) => !r.idle);
  if (busy && !trial) {
    if (t.busy === "skip") return skip(tz("有对话在跑"));
    if (t.busy !== "run") {
      // 排队：每 30 秒看一次，最多等 30 分钟
      const deadline = Date.now() + 30 * 60000;
      while ([...RUNS.values()].some((r) => !r.idle)) {
        if (Date.now() > deadline) return skip(tz("有对话在跑，排队 30 分钟仍没轮到"));
        if (byId(t.id) !== t || (reason === "due" && !t.on)) return skip(tz("排队时任务被关掉或删了"));
        await new Promise((r) => setTimeout(r, 30000));
      }
    }
  }
  // 排队那 30 秒里被删 / 被关、而别的对话又正好在醒来前结束：循环条件直接为假，循环里那道检查没走到（审查 B16）。入队前再看一眼
  if (!trial && (byId(t.id) !== t || (reason === "due" && !t.on))) return skip(tz("排队时任务被关掉或删了"));
  const p = t.projectId ? projectById(t.projectId) : null;
  const perm = t.perm === "proj" ? { permissionMode: "acceptEdits" }
    : t.perm === "custom" ? { permissionMode: "default", allowedTools: capList(String(t.tools || "").split(/[,，\n]/).map((x) => x.trim()).filter(Boolean), 200, 512, 8192) }
    : { permissionMode: "default", disallowedTools: ["Edit", "Write", "MultiEdit", "NotebookEdit"] };
  let message = String(t.prompt || "").trim();
  if (t.carryLast && t.session !== "same") {
    const last = [...RUNLOG].reverse().find((r) => r.taskId === t.id && r.st === "ok" && r.full);
    if (last) message = `${tz("（上一次的结果，供参考）")}\n${last.full}\n\n---\n\n${message}`;
  }
  const key = "s" + Date.now().toString(36) + (++keyN);
  RUNNING.set(key, { taskId: t.id, startedAt: Date.now(), attempt, trial, reason });
  const item = enqueue({
    internal: true, message, projectId: p ? p.id : null,
    sessionId: t.session === "same" && t.lastSid ? t.lastSid : null,
    model: t.model || null, effort: t.effort || null, provider: t.provider || null, ...perm,
    unattended: true, timeoutMs: Math.max(1, +t.limitMin || 15) * 60000, limitCost: +t.limitCost || 0, sched: { taskId: t.id, key },
  });
  log(`⏰ 定时任务「${t.name}」开跑（${reason}${trial ? "，试跑" : ""}）`);
  if (!trial) { t.lastFiredAt = Date.now(); save(); }
  return item;
}

// 入队之后、真开跑之前任务被删 / 被关：不跑了，记一笔跳过（DeepSeek 复核 中-2；入队前那道见 fireNow）
START_GUARDS.push((q) => {
  const ctx = q.sched && RUNNING.get(q.sched.key);
  if (!ctx || ctx.trial) return true;
  const t = byId(ctx.taskId);
  // 排队期间会话可能被改钉到官方账户：真开跑前按这一条实际会用的那家再核一次订阅许可
  if (t && !DB.allowLogin && (() => { try { return isLoginMode(pickProvider(q).P); } catch { return false; } })()) {
    RUNNING.delete(q.sched.key);
    const msg = tz("用订阅账户跑定时任务默认关闭");
    log(`⏭ 定时任务「${t.name}」跳过：${msg}`);
    addRun({ taskId: t.id, at: Date.now(), st: "skip", msg });
    note(t, tz("定时任务已跳过"), tz("「{n}」要用订阅账户跑：到定时任务页底部「订阅账户」里打开（无人值守使用以 Anthropic 条款为准），或给任务换一个用 API Key 的接口", { n: t.name }), null, false);
    return false;
  }
  if (t && (ctx.reason !== "due" || t.on)) return true;
  RUNNING.delete(q.sched.key);
  const msg = tz("排队时任务被关掉或删了");
  log(`⏭ 定时任务${t ? "「" + t.name + "」" : ""}跳过：${msg}`);
  if (t) addRun({ taskId: t.id, at: Date.now(), st: "skip", msg });
  return false;
});

// 一轮结束：记运行记录、改会话名、通知、重试
END_HOOKS.push((run, f) => {
  if (!run.sched) return;
  const ctx = RUNNING.get(run.sched.key); RUNNING.delete(run.sched.key);
  const t = byId(run.sched.taskId); if (!t || !ctx) return;
  const dur = Date.now() - ctx.startedAt, cost = Number(f.costRaw || f.costUsd || 0);
  const text = String(f.finalText || "").trim();
  let st = "ok", msg = text.split("\n").find((l) => l.trim()) || tz("（没有回复）");
  const over = run.overBudget || (t.limitCost > 0 && cost > t.limitCost);
  if (run.timedOut) { st = "err"; msg = tz("超过时长上限 {m} 分钟，已停", { m: t.limitMin || 15 }); }
  else if (run.overBudget) { st = "err"; msg = tz("花费 ${c}，超过单次上限 ${m}", { c: cost.toFixed(2), m: t.limitCost }); }
  else if (run.aborted) { st = "err"; msg = tz("被停止"); }
  else if (f.failed || f.isError) { st = "err"; msg = text || tz("出错了"); }
  else if (t.limitCost > 0 && cost > t.limitCost) { st = "err"; msg = tz("花费 ${c}，超过单次上限 ${m}", { c: cost.toFixed(2), m: t.limitCost }); }
  if (run.denied?.length && st === "ok") msg += "  " + tz("（拒绝了 {n} 次要确认的操作）", { n: run.denied.length });
  const sid = run.sessionId || null;
  if (sid) {
    const d = new Date(ctx.startedAt), stamp = `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    NAMES[sid] = t.session === "same" ? t.name : `${t.name} · ${stamp}`; saveNames();
    if (!DB.sids.includes(sid)) DB.sids.push(sid);
    if (t.session === "same") t.lastSid = sid;
  }
  if (ctx.trial) { note(t, tz("试跑完成"), msg, sid, st === "ok"); return; }
  addRun({ taskId: t.id, at: ctx.startedAt, st, msg: msg.slice(0, 300), full: text.slice(0, 2000), cost, dur, sid, attempt: ctx.attempt });
  t.runsDone = (t.runsDone || 0) + 1;
  if (t.until?.kind === "count" && t.runsDone >= (+t.until.count || 1)) t.on = false;
  if (t.freq?.kind === "once") t.on = false;
  refreshNext(t); save();
  if (sid && t.saveSession === false && st === "ok") { try { trashSession(sid); } catch {} }
  // 通知：每次 / 只在失败时 / 只在有发现时（回复不是那句固定的话）/ 不通知
  const found = !t.quiet || text.replace(/[\s。.!！]/g, "") !== String(t.quiet).replace(/[\s。.!！]/g, "");
  const want = t.notify === "none" ? false : t.notify === "fail" ? st !== "ok" : t.notify === "found" ? (st !== "ok" || found) : true;
  if (want) note(t, st === "ok" ? tz("定时任务完成：{n}", { n: t.name }) : tz("定时任务没成：{n}", { n: t.name }), msg, sid, st === "ok");
  // 超了花费上限不重试：重试就是再花一遍（#98 03-010）
  if (st === "err" && !over && ctx.attempt < (+t.retry || 0)) {
    clearTimeout(RETRY.get(t.id));
    RETRY.set(t.id, setTimeout(() => { RETRY.delete(t.id); if (byId(t.id) === t) fire(t, { reason: "retry", attempt: ctx.attempt + 1 }); }, 2 * 60000));
  }
});

// ── 计时 ──
function tick() {
  const now = Date.now();
  followSysTz(now);
  const gap = DB.lastTick ? now - DB.lastTick : 0;
  const live = new Set(runningNow().map((x) => x.taskId));
  for (const t of DB.tasks) {
    if (!t.on) continue;
    if (t.nextAt == null) {
      // 正排队或正在跑：只跑一次的任务这时 nextAt 已是空的，别当成「时间已过」把它关掉记一笔跳过（审查 B17）
      if (WAITING.has(t.id) || live.has(t.id)) continue;
      // 只跑一次、时间已过还没跑过：关掉并记一笔，免得界面一直显示启用却永远不跑（审查 v0.5.3 B7）
      if (t.freq?.kind === "once" && !t.pausedUntil) { t.on = false; addRun({ taskId: t.id, at: now, st: "skip", msg: tz("只跑一次的时间已过，任务已关") }); continue; }
      // 排不出下次的（如 2 月 31 日）每 30 秒重算一遍要扫满一年：一小时看一次就够
      if (now - (NULL_AT.get(t.id) || 0) < 3600e3) continue;
      NULL_AT.set(t.id, now); refreshNext(t, now); continue;
    }
    if (t.nextAt > now) continue;
    const late = now - t.nextAt;
    // 晚了 3 分钟以上：应用没在跑 / 机器睡死了 —— 按「错过了」的设置来，不默默补跑
    if (late > 3 * 60000 && gap > 3 * 60000 || late > 15 * 60000) {
      const when = t.nextAt;
      if (t.missed === "run") fire(t, { reason: "missed" });
      else if (t.missed === "skip") addRun({ taskId: t.id, at: when, st: "skip", msg: tz("错过了（当时应用没在跑），按设置跳过") });
      else if (!DB.missed.some((m) => m.taskId === t.id && m.at === when)) { DB.missed.push({ taskId: t.id, at: when }); publish({ type: "sched", op: "missed" }); }
      log(`⏰ 定时任务「${t.name}」错过 ${new Date(when).toLocaleString()}（${t.missed || "ask"}）`);
    } else fire(t, { reason: "due" });
    refreshNext(t, now);
  }
  DB.lastTick = now;
  save();
}
if (LIVE) setTimeout(() => { tick(); setInterval(tick, 30000); }, 5000);

// ── 校验 / 整理前端交来的任务 ──
const KINDS = ["daily", "weekly", "monthly", "every", "once", "cron"];
function clean(b, old = {}) {
  const t = { ...old };
  const s = (k, n = 200) => { if (typeof b[k] === "string") t[k] = b[k].trim().slice(0, n); };
  s("name", 60); s("prompt", 8000); s("tools", 500); s("model", 80); s("effort", 20); s("provider", 40); s("quiet", 60);
  if ("projectId" in b) t.projectId = b.projectId && projectById(b.projectId) ? b.projectId : null;
  if (b.freq && KINDS.includes(b.freq.kind)) {
    const f = b.freq, o = { kind: f.kind };
    if (/^\d{1,2}:\d{2}$/.test(f.time || "")) o.time = f.time;
    if (Array.isArray(f.days)) o.days = f.days.map(Number).filter((x) => x >= 1 && x <= 7);
    if (f.day === "last" || (+f.day >= 1 && +f.day <= 28)) o.day = f.day === "last" ? "last" : +f.day;
    if (+f.hours >= 1 && +f.hours <= 24) o.hours = +f.hours;
    if (/^\d{1,2}:\d{2}$/.test(f.from || "")) o.from = f.from;
    if (/^\d{1,2}:\d{2}$/.test(f.to || "")) o.to = f.to;
    if (/^\d{4}-\d{2}-\d{2}$/.test(f.date || "")) o.date = f.date;
    if (typeof f.cron === "string") { parseCron(f.cron); o.cron = f.cron.trim(); }
    t.freq = o;
  }
  const pick = (k, opts) => { if (opts.includes(b[k])) t[k] = b[k]; };
  pick("session", ["new", "same"]); pick("perm", ["ro", "proj", "custom"]); pick("busy", ["queue", "skip", "run"]);
  pick("missed", ["ask", "run", "skip"]); pick("notify", ["all", "fail", "found", "none"]);
  for (const k of ["on", "saveSession", "carryLast"]) if (typeof b[k] === "boolean") t[k] = b[k];
  if (b.cond && typeof b.cond === "object") t.cond = { wifi: !!b.cond.wifi, charging: !!b.cond.charging, battery: [0, 15, 30, 50].includes(+b.cond.battery) ? +b.cond.battery : 0 };
  if ("limitCost" in b) t.limitCost = Math.max(0, Math.min(100, +b.limitCost || 0));
  if ("limitMin" in b) t.limitMin = Math.max(1, Math.min(600, +b.limitMin || 15));
  if ("retry" in b) t.retry = Math.max(0, Math.min(3, +b.retry || 0));
  // 直接调接口也不收 0 次 / 没日期：不然 clean 后 count 成 undefined，详情显示「跑满 undefined 次」（审查 E10）
  if (b.until?.kind === "count" && !(Number.isInteger(+b.until.count) && +b.until.count >= 1)) throw new Error(tz("次数至少填 1"));
  if (b.until?.kind === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(b.until.date || "")) throw new Error(tz("到期日要填一个日期"));
  if (b.until && ["ever", "date", "count"].includes(b.until.kind)) t.until = { kind: b.until.kind, date: /^\d{4}-\d{2}-\d{2}$/.test(b.until.date || "") ? b.until.date : undefined, count: +b.until.count || undefined };
  return t;
}
const DEFAULTS = { on: true, session: "new", perm: "ro", busy: "queue", missed: "ask", notify: "all", saveSession: true, carryLast: false,
  cond: { wifi: false, charging: false, battery: 0 }, limitCost: 0, limitMin: 15, retry: 0, until: { kind: "ever" }, freq: { kind: "daily", time: "09:00" } };

function summary(t) {
  const runs = RUNLOG.filter((r) => r.taskId === t.id);
  const last = runs[runs.length - 1] || null;
  return { ...t, last: last && { st: last.st, at: last.at, msg: last.msg, sid: last.sid }, runs: runs.length };
}
function monthStats() {
  const now = new Date(), m0 = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const rs = RUNLOG.filter((r) => r.at >= m0);
  return { cost: rs.reduce((s, r) => s + (r.cost || 0), 0), runs: rs.filter((r) => r.st !== "skip").length,
    ok: rs.filter((r) => r.st === "ok").length, err: rs.filter((r) => r.st === "err").length, skip: rs.filter((r) => r.st === "skip").length };
}

// ── 路由：/api/sched ──
export async function routeSched(req, res, u, p) {
  if (!p.startsWith("/api/sched")) return NEXT;
  const body = async () => { try { return JSON.parse((await readBody(req)) || "{}"); } catch { return {}; } };
  if (p === "/api/sched" && req.method === "GET") {
    DB.missed = DB.missed.filter((m) => byId(m.taskId));
    return sendJson(res, 200, { tasks: DB.tasks.map(summary), missed: DB.missed, sids: DB.sids.slice(-2000),
      budget: { daily: DB.dailyBudget, today: costToday(), month: monthStats() },
      allowLogin: !!DB.allowLogin, loginTasks: DB.tasks.filter(usesLogin).map((t) => t.id), fx: await Promise.race([usdCny().catch(() => null), new Promise((r) => setTimeout(() => r(null), 1500))]),   // 汇率：中文界面把美元花费换成人民币；取不到就照美元
      running: runningNow().map((x) => x.taskId) });
  }
  if (p === "/api/sched" && req.method === "POST") {
    const b = await body();
    // 每 30 秒整份写盘：任务数设个顶（11-03 审查 I-7）
    if (DB.tasks.length >= 500) return sendJson(res, 400, { error: tz("定时任务太多了（上限 500 个），先删掉一些") });
    let t;
    try { t = clean(b, { ...DEFAULTS, id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), created: Date.now(), runsDone: 0 }); }
    catch (e) { return sendJson(res, 400, { error: e.message }); }
    if (!t.name || !t.prompt) return sendJson(res, 400, { error: tz("名称和要做的事都要填") });
    refreshNext(t); DB.tasks.push(t); save();
    log(`⏰ 新定时任务「${t.name}」 下次 ${t.nextAt ? new Date(t.nextAt).toLocaleString() : "—"}`);
    return sendJson(res, 200, { ok: true, task: summary(t) });
  }
  // 外壳的闹钟响了：立刻查一遍（不用等下一个 30 秒）
  if (p === "/api/sched/tick" && req.method === "POST") { tick(); return sendJson(res, 200, { ok: true, next: lastNext }); }
  if (p === "/api/sched/allow-login" && req.method === "PUT") {
    const b = await body(); DB.allowLogin = !!b.on; save();
    log(`⏰ 用订阅账户跑定时任务：${DB.allowLogin ? "已打开（用户确认了条款提示）" : "已关闭"}`);
    return sendJson(res, 200, { ok: true, allowLogin: DB.allowLogin });
  }
  if (p === "/api/sched/budget" && req.method === "PUT") {
    const b = await body(); DB.dailyBudget = Math.max(0, Math.min(1000, +b.daily || 0)); save();
    return sendJson(res, 200, { ok: true });
  }
  if (p === "/api/sched/missed" && req.method === "POST") {
    const b = await body();
    const i = DB.missed.findIndex((m) => m.taskId === b.taskId && (!b.at || m.at === b.at));
    if (i < 0) return sendJson(res, 404, { error: "not missed" });
    const m = DB.missed.splice(i, 1)[0]; save();
    const t = byId(m.taskId);
    if (t && b.act === "run") fire(t, { reason: "missed" });
    else if (t) addRun({ taskId: t.id, at: m.at, st: "skip", msg: tz("错过了，没补跑") });
    return sendJson(res, 200, { ok: true });
  }
  if (p === "/api/sched/preview" && req.method === "POST") {
    // 表单里实时显示「下次 …」：不保存，只算
    const b = await body();
    try { const t = clean(b, { ...DEFAULTS }); const n1 = nextAt(t); const n2 = n1 && nextAt(t, n1); return sendJson(res, 200, { next: [n1, n2].filter(Boolean) }); }
    catch (e) { return sendJson(res, 200, { next: [], error: e.message }); }
  }
  const m = p.match(/^\/api\/sched\/([^/]+)(\/[a-z]+)?$/);
  if (!m) return NEXT;
  const t = byId(dec(m[1]));
  if (!t) return sendJson(res, 404, { error: tz("任务不存在") });
  const sub = m[2] || "";
  if (!sub && req.method === "GET") return sendJson(res, 200, { task: summary(t), runs: RUNLOG.filter((r) => r.taskId === t.id).slice(-100).reverse().map(({ full, ...r }) => r), running: runningNow().some((x) => x.taskId === t.id) });
  if (!sub && req.method === "PATCH") {
    const b = await body();
    try { clean(b, {}); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    Object.assign(t, clean(b, t));
    if (b.on === true) { t.pausedUntil = 0; t.skipNext = false; }
    if (b.on === false) cancelRetry(t.id);
    refreshNext(t); save();
    return sendJson(res, 200, { ok: true, task: summary(t) });
  }
  if (!sub && req.method === "DELETE") {
    cancelRetry(t.id);
    DB.tasks = DB.tasks.filter((x) => x.id !== t.id); DB.missed = DB.missed.filter((x) => x.taskId !== t.id); save();
    log(`⏰ 删除定时任务「${t.name}」`);
    return sendJson(res, 200, { ok: true });
  }
  if (sub === "/run" && req.method === "POST") {
    const b = await body();
    // 同一任务手动跑还没结束（在排队或在跑）就别再起一次：连点会重复执行、重复花钱（审查 E05 / v0.5.3 B5）
    if (MANUAL.has(t.id) || runningNow().some((r) => r.taskId === t.id)) return sendJson(res, 409, { error: tz("这个任务已经在跑了") });
    MANUAL.add(t.id);
    const go = fire(t, { reason: "manual", trial: !!b.trial }).finally(() => MANUAL.delete(t.id));
    // 有对话在跑时 fire 会排队等最多 30 分钟：别让请求一直挂着，先回「已排队」
    const item = await Promise.race([go, new Promise((r) => setTimeout(() => r("queued"), 3000))]);
    if (item === "queued") return sendJson(res, 200, { ok: true, queued: true });
    return sendJson(res, 200, { ok: !!item, id: item && item.id });
  }
  if (sub === "/pause" && req.method === "POST") {
    const b = await body();
    t.skipNext = b.mode === "skip";
    t.pausedUntil = b.mode === "1d" ? Date.now() + 864e5 : b.mode === "1w" ? 7 * 864e5 + Date.now() : 0;
    if (t.pausedUntil) cancelRetry(t.id);
    refreshNext(t); save();
    return sendJson(res, 200, { ok: true, task: summary(t) });
  }
  return NEXT;
}
export const _schedForTest = { fire, tick, DB, runlog: () => RUNLOG, running: () => runningNow() };   // 只给测试用
