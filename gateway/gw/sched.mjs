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
import { isObj, loadState, saveState, writeAtomic } from "./statefile.mjs";
import { guarded } from "./crashguard.mjs";
import { dec, NEXT, readBody, sendJson } from "./http.mjs";
import { END_HOOKS, QUEUE, RECOVER_HOOKS, START_GUARDS, enqueue } from "./queue.mjs";
import { capList } from "./settings-store.mjs";
import { RUNS, TRASH_HOOKS, maxParallel } from "./runs.mjs";
import { publish } from "./bus.mjs";
import { NAMES, findSessionFile, saveNames } from "./sessions.mjs";
import { trashSession } from "./sessionops.mjs";
import { projectById } from "./projects.mjs";
import { isLoginMode } from "./models.mjs";
import { pickProvider } from "./run.mjs";
import { privCall } from "./usage.mjs";
import { providerById, usdCny } from "./providers.mjs";

// node 在安卓上可能没拿到时区（TZ 没设就是 UTC）：「每天 09:00」必须按本地时间算
// 按系统设置取的就要跟着系统变：出差、手动改时区后，每天 09:00 要按新时区的 09:00（#107 06-012）。tick 里隔几分钟再问一次
const sysTz = () => { try { return execFileSync("getprop", ["persist.sys.timezone"], { encoding: "utf8", timeout: 2000 }).trim(); } catch { return ""; } };
let TZ_FROM_PROP = false, TZ_CHECKED = 0;
// 以前只在「node 解析成 UTC」时才记下系统时区并开启跟随：本机解析对了 Asia/Shanghai，followSysTz 就永远不执行，
// 出差 / 手动改时区后「每天 09:00」还按旧时区跑（197-5.2）。拿到 getprop 的值就跟随，启动时 TZ 没设的顺手设上
{
  const z = sysTz();
  if (z) { if (!process.env.TZ) process.env.TZ = z; TZ_FROM_PROP = true; }
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
const schedDefault = () => ({ tasks: [], dailyBudget: 0, missed: [], sids: [], lastTick: 0, allowLogin: false, spent: {}, monthly: {}, monthlySeeded: false });   // dailyBudget：美元，0 = 不限
// allowLogin：用订阅账户（官方登录态）跑定时任务。默认关——无人值守使用以 Anthropic 条款为准，要用户自己确认后打开
// tasks 必须是数组：是 {} / 字符串时 tick 每 30 秒抛一次，5 秒后启动的那次就把网关带走，重启再崩（P1-11）
const schedShape = (j) => {
  if (!isObj(j)) return undefined;
  if (j.tasks !== undefined && !Array.isArray(j.tasks)) return undefined;
  const d = { ...schedDefault(), ...j };
  d.tasks = (Array.isArray(j.tasks) ? j.tasks : []).filter((t) => isObj(t) && typeof t.id === "string" && (t.freq === undefined || isObj(t.freq)));
  d.missed = Array.isArray(j.missed) ? j.missed.filter((m) => isObj(m) && typeof m.taskId === "string") : [];
  d.sids = Array.isArray(j.sids) ? j.sids.filter((x) => typeof x === "string") : [];
  d.spent = isObj(j.spent) ? j.spent : {};
  d.monthly = isObj(j.monthly) ? j.monthly : {};
  d.dailyBudget = Number.isFinite(+j.dailyBudget) ? Math.max(0, +j.dailyBudget) : 0;
  d.lastTick = Number.isFinite(+j.lastTick) ? +j.lastTick : 0;
  d.allowLogin = !!j.allowLogin;
  d.monthlySeeded = !!j.monthlySeeded;
  return d;
};
const DB = loadState(FILE, { shape: schedShape, fallback: schedDefault }).data;
// 运行记录也按形状过一遍：数组里混进 null 时 tick 里的 byId(RUNLOG[i].taskId) 会抛
let RUNLOG = loadState(RUNS_FILE, {
  shape: (j) => Array.isArray(j) ? j.filter((r) => isObj(r) && typeof r.taskId === "string") : undefined,
  fallback: () => [],
}).data;
/** 返回这次是否写成；调用方要据它回 500，别写失败了还回 ok（195-N.1） */
const save = () => {
  const ok = saveState(FILE, DB);
  if (!ok) log("定时任务保存失败（存储满了或没有权限）");
  pushNext();
  return ok;
};
// 最近一次要跑的时刻（毫秒，0 = 没有）→ 外壳的系统闹钟。只在变了的时候报
const NEXT_FILE = path.join(CFG.home, "ccapp-sched-next");
let lastNext = -1;
function pushNext() {
  const at = DB.tasks.reduce((m, t) => (t.on && t.nextAt && (!m || t.nextAt < m) ? t.nextAt : m), 0);
  if (at === lastNext) return;
  lastNext = at;
  writeAtomic(NEXT_FILE, String(at));
  publish({ type: "sched_next", at });
}
const saveRuns = () => { RUNLOG = RUNLOG.slice(-500); return writeAtomic(RUNS_FILE, JSON.stringify(RUNLOG)); };
const byId = (id) => DB.tasks.find((t) => t.id === id) || null;
// 失败后的重试定时器（按任务 id）：用户关掉、暂停、删除时要撤掉，否则到点照跑（审查 H4）。
// 不能在 fire 里看 t.on 拦：「只跑一次」「跑满次数」的任务失败那一刻 on 已经是 false，重试本来就该跑
const RETRY = new Map();
const cancelRetry = (id) => { clearTimeout(RETRY.get(id)); RETRY.delete(id); };

// ── 下次什么时候跑 ──
// 时/分要在范围内：以前 99:99 能过正则，setHours 会自己进位成错误时间（200-16-04）。解析数据时按默认值兜底，保存时另用 hmOk 拒绝
const hmParse = (s) => {
  const m = String(s || "").match(/^(\d{1,2}):(\d{2})$/); if (!m) return null;
  const h = +m[1], mi = +m[2];
  return h >= 0 && h <= 23 && mi >= 0 && mi <= 59 ? [h, mi] : null;
};
const hm = (s, d = "09:00") => hmParse(s) || hmParse(d) || [9, 0];
const hmOk = (s) => hmParse(s) !== null;
const at = (base, h, mi) => { const d = new Date(base); d.setHours(h, mi, 0, 0); return d; };
function cronField(spec, lo, hi) {
  const set = new Set();
  for (const part of String(spec).split(",")) {
    const [rng, stepS] = part.split("/");
    // 步长非法时以前 Math.max(1, +stepS || 1) 静默改成 1：*/0 保存后变成每分钟跑一次（199-16-01）
    if (stepS !== undefined && (!/^\d+$/.test(stepS) || +stepS < 1)) throw new Error(tz("cron 的步长不对：{f}", { f: String(part) }));
    if (!/^(\*|\d+)(-\d+)?$/.test(rng)) throw new Error(tz("cron 的字段值不对：{f}", { f: String(part) }));
    const step = stepS !== undefined ? +stepS : 1;
    let a = lo, b = hi;
    if (rng !== "*") { const m = rng.split("-"); a = +m[0]; b = m.length > 1 ? +m[1] : (stepS ? hi : a); }
    if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error(tz("cron 的字段值不对：{f}", { f: String(part) }));
    // 先夹到 [lo, hi] 再循环：「1-999999999999」这种范围原样循环会同步空转几十分钟，把网关整个卡死（审查 M1）
    a = Math.max(lo, a); b = Math.min(hi, b);
    for (let v = a; v <= b; v += step) if (v >= lo && v <= hi) set.add(v);
  }
  // 「5-3」这种反向范围或越界值展开是空的：保存时就报错，别存下一个永远不跑的任务（审查 v0.5.3 B6）
  if (!set.size) throw new Error(tz("cron 的字段值超出了范围：{f}", { f: String(spec) }));
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
    const [h, mi] = hm(fq.time, "09:00"); const d = new Date((fq.date || "") + "T00:00:00"); if (isNaN(d)) return null;   // 缺省与界面 freqText 的 09:00 对齐（200-16-07）
    d.setHours(h, mi, 0, 0); return after(d) ? d.getTime() : null;
  }
  if (fq.kind === "cron") {
    let c; try { c = parseCron(fq.cron); } catch { return null; }
    // 分、时按绝对毫秒往前走：本地时间的 setter 在秋季回拨的重复那一小时里会选到第一次的 02:00，
    // 算出来的「下次」反而比 from 早，下一次 tick 就当成错过了（#132）。跨天才用本地 setter，结果再核一遍晚于 from
    let d = new Date(Math.floor(from / 60000) * 60000 + 60000);
    for (let i = 0; i < 366 * 24 * 60; ) {
      const domOk = c.dom.has(d.getDate()), dowOk = c.dow.has(d.getDay());
      const dayOk = c.mon.has(d.getMonth() + 1) && (c.domAny && c.dowAny ? true : c.domAny ? dowOk : c.dowAny ? domOk : domOk || dowOk);
      if (!dayOk) { const n = new Date(d); n.setDate(n.getDate() + 1); n.setHours(0, 0, 0, 0); d = n > d ? n : new Date(d.getTime() + 3600e3); i += 1440; continue; }
      if (!c.hour.has(d.getHours())) { d = new Date(d.getTime() + (60 - d.getMinutes()) * 60000); i += 60; continue; }
      if (c.min.has(d.getMinutes()) && after(d)) return d.getTime();
      d = new Date(d.getTime() + 60000); i++;
    }
    return null;
  }
  for (let k = 0; k < 400; k++) {
    const day = new Date(now); day.setDate(now.getDate() + k);
    if (fq.kind === "every") {
      const [h0, m0] = hm(fq.from, "00:00"), [h1, m1] = hm(fq.to, "23:59"), step = Math.max(1, +fq.hours || 2) * 60;   // 缺省与 freqText 对齐（200-16-07）
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
// 盘上的 nextAt 可能是旧时区算的：启动时按当前时区把未来的时刻重新排一遍（197-5.3）。
// 已经到点的不动，交给 tick 按「错过了」处理
{
  const now = Date.now();
  let changed = false;
  for (const t of DB.tasks) if (t.on && t.nextAt != null && t.nextAt > now) { refreshNext(t, now); changed = true; }
  if (changed) save();
}
// 月度统计不再被 RUNLOG 的 500 条上限截断（197-5.11）：第一次启动用现有运行记录补种，之后由 addRun 累加
function monthKey(ms) { const d = new Date(ms); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"); }
if (!DB.monthlySeeded) {
  const m = {};
  for (const r of RUNLOG) {
    const b = m[monthKey(+r.at || 0)] || (m[monthKey(+r.at || 0)] = { cost: 0, runs: 0, ok: 0, err: 0, skip: 0 });
    if (r.st === "skip") b.skip++; else b.runs++;
    if (r.st === "ok") b.ok++; else if (r.st === "err") b.err++;
    b.cost += +r.cost || 0;
  }
  DB.monthly = m; DB.monthlySeeded = true; save();
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
const dayKey = (ms) => { const d = new Date(ms); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
// 每日预算用独立的日桶记，不依赖 RUNLOG：它只留最近 500 条（skip 也占名额），连续跳过后会把当天的
// 费用挤掉、预算重新放行（#119-3）。升级时用 RUNLOG 里今天的费用补个种，之后只由结束钩子累加。
{
  const k = dayKey(Date.now());
  if (DB.spent[k] == null) {
    const c = RUNLOG.filter((r) => dayKey(r.at) === k).reduce((s, r) => s + (r.cost || 0), 0);
    if (c > 0) DB.spent[k] = c;
  }
}
const spend = (ms, cost) => {
  if (!(cost > 0)) return;
  const k = dayKey(ms);
  DB.spent[k] = Math.round(((DB.spent[k] || 0) + cost) * 1e6) / 1e6;
  const cut = dayKey(Date.now() - 60 * 86400e3);
  for (const d of Object.keys(DB.spent)) if (d < cut) delete DB.spent[d];
};
const costToday = () => DB.spent[dayKey(Date.now())] || 0;
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
function addRun(rec) {
  RUNLOG.push(rec);
  // 月度聚合单独存：RUNLOG 只留最近 500 条，跳过也会占名额，月度统计会被截断（197-5.11）
  const k = monthKey(rec.at);
  const b = DB.monthly[k] || (DB.monthly[k] = { cost: 0, runs: 0, ok: 0, err: 0, skip: 0 });
  if (rec.st === "skip") b.skip++; else b.runs++;
  if (rec.st === "ok") b.ok++; else if (rec.st === "err") b.err++;
  b.cost = Math.round(((b.cost || 0) + (+rec.cost || 0)) * 1e6) / 1e6;
  saveRuns(); save();
  publish({ type: "sched", op: "run", taskId: rec.taskId });
  return rec;
}
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
  const out = [...RUNNING.values()];
  // 正在 30 分钟排队窗口里的也要算「在跑」：否则界面看不到、手动「立刻跑一次」也不会 409（审查 11-05）
  for (const id of WAITING) if (!out.some((x) => x.taskId === id)) out.push({ taskId: id, startedAt: Date.now(), waiting: true });
  return out;
}
const WAITING = new Set();   // 到点了、正排队等别的对话跑完的任务 id：计时别把它当成「没排上 / 时间已过」（审查 B17）
async function fire(t, { reason = "due", attempt = 0, trial = false } = {}) {
  if (trial) return fireNow(t, { reason, attempt, trial });
  // 同一个任务已经有一个到点等待者时不再叠一个：排期间隔 ≤30 分钟时，每个新计划时刻都会进 fireNow 的忙等，
  // 阻塞结束后同一任务会被连续执行多次（审查 11-05）
  if (WAITING.has(t.id)) { log(`⏭ 定时任务「${t.name}」已在排队，跳过这次重复入队`); return null; }
  WAITING.add(t.id);
  try { return await fireNow(t, { reason, attempt, trial }); } finally { WAITING.delete(t.id); }
}
async function fireNow(t, { reason, attempt, trial }) {
  const skip = (msg) => { log(`⏭ 定时任务「${t.name}」跳过：${msg}`); if (!trial) addRun({ taskId: t.id, at: Date.now(), st: "skip", msg }); };
  // 指定的接口删了：不悄悄换成全局默认那家跑（全局可能是订阅账户，任务内容不该换家发出去）。
  // 放在最前：回落到订阅后下面「订阅账户默认关闭」会先挡住，可报的原因不对，打开了订阅也就挡不住了
  if (t.provider && !providerById(t.provider)) {
    skip(tz("任务指定的接口已经删掉了：编辑任务重新选个接口"));
    if (!trial) note(t, tz("定时任务已跳过"), tz("「{n}」指定的接口已经删掉了：编辑任务重新选个接口", { n: t.name }), null, false);
    return;
  }
  // 每日预算也管试跑：以前试跑跳过这道检查、花掉的钱也不进 DB.spent（197-5.10）
  if (DB.dailyBudget > 0 && costToday() >= DB.dailyBudget) {
    skip(tz("今天的花费已到上限"));
    if (!trial) note(t, tz("定时任务已跳过"), tz("「{n}」：今天的花费已到上限", { n: t.name }), null, false);
    return;
  }
  if (!trial) {
    if (t.until?.kind === "date" && t.until.date && Date.now() > new Date(t.until.date + "T23:59:59").getTime()) { t.on = false; refreshNext(t); save(); return skip(tz("已过有效期，任务已关")); }
    if (t.skipNext && reason === "due" && (!t.skipAt || t.skipAt <= t.nextAt)) { t.skipNext = false; t.skipAt = 0; save(); return skip(tz("按设置跳过这一次")); }
    if (usesLogin(t) && !DB.allowLogin) {
      skip(tz("用订阅账户跑定时任务默认关闭"));
      note(t, tz("定时任务已跳过"), tz("「{n}」要用订阅账户跑：到定时任务页底部「订阅账户」里打开（无人值守使用以 Anthropic 条款为准），或给任务换一个用 API Key 的接口", { n: t.name }), null, false);
      return;
    }
    const c = t.cond || {};
    if (c.wifi || c.charging || c.battery) {
      const st = await deviceState();
      // 判断不了（老版本 App、Priv 不通）也不跑：仅 Wi-Fi 是为了不走流量，宁可错过一次（#108 09-001）
      if (c.wifi && st.wifi !== true) return skip(st.wifi === false ? tz("没连 Wi-Fi") : tz("判断不了是不是连着 Wi-Fi"));
      if (c.charging && st.charging === false) return skip(tz("没在充电"));
      if (c.battery && st.battery != null && st.battery < c.battery) return skip(tz("电量 {b}%，低于 {m}%", { b: st.battery, m: c.battery }));
    }
  }
  // 并行槽和 queue.pump 用同一口径：idle 轮也占一个槽，以前这里按 !idle 判定，任务会在队里干等（197-5.6）
  const busy = RUNS.size >= maxParallel();
  if (busy && !trial) {
    if (t.busy === "skip") return skip(tz("有对话在跑"));
    if (t.busy !== "run") {
      // 排队：每 30 秒看一次，最多等 30 分钟
      const deadline = Date.now() + 30 * 60000;
      while (RUNS.size >= maxParallel()) {
        if (Date.now() > deadline) return skip(tz("有对话在跑，排队 30 分钟仍没轮到"));
        if (byId(t.id) !== t || (reason === "due" && !t.on)) return skip(tz("排队时任务被关掉或删了"));
        await new Promise((r) => setTimeout(r, 30000));
      }
    }
  }
  // 排队那 30 秒里被删 / 被关、而别的对话又正好在醒来前结束：循环条件直接为假，循环里那道检查没走到（审查 B16）。入队前再看一眼
  if (!trial && (byId(t.id) !== t || (reason === "due" && !t.on))) return skip(tz("排队时任务被关掉或删了"));
  const p = t.projectId ? projectById(t.projectId) : null;
  // 项目删了：不悄悄退回工作区跑（「可以改项目目录里的文件」到了工作区就是能改工作区，#178-7）
  if (t.projectId && !p) {
    skip(tz("任务所在的项目已经删掉了：编辑任务重新选个项目"));
    if (!trial) note(t, tz("定时任务已跳过"), tz("「{n}」所在的项目已经删掉了：编辑任务重新选个项目", { n: t.name }), null, false);
    return;
  }
  // 项目记录还在、目录没了（改名/拔卡/被删）：run.cwdOf 会静默回落到工作区，权限和型号却还按项目套（195-K.1）。
  // 这里挡下来，别让任务在用户没选过的目录里跑
  if (p) {
    let isDir = false; try { isDir = fs.statSync(p.path).isDirectory(); } catch {}
    if (!isDir) {
      skip(tz("任务所在的项目目录已经不在了：编辑任务重新选个项目或目录"));
      if (!trial) note(t, tz("定时任务已跳过"), tz("「{n}」所在的项目目录已经不在了：编辑任务重新选个项目或目录", { n: t.name }), null, false);
      return;
    }
  }
  // 接着同一个对话、可那个对话已经删了：--resume 必失败（每次到点都失败、重试也一样，#173-3）。
  // 放下它，这次新开一个；任务详情里标出来
  if (!trial && t.session === "same" && t.lastSid && !findSessionFile(t.lastSid)) {
    log(`⏰ 定时任务「${t.name}」接着的对话 ${t.lastSid} 已不在，这次新开一个`);
    t.lostSid = t.lastSid; t.lastSid = null; save();
  }
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
    sessionId: !trial && t.session === "same" && t.lastSid ? t.lastSid : null,
    model: t.model || null, effort: t.effort || null, provider: t.provider || null, ...perm,
    unattended: true, timeoutMs: Math.max(1, +t.limitMin || 15) * 60000, limitCost: +t.limitCost || 0, sched: { taskId: t.id, key, ...(trial ? { trial: true } : {}) },
  });
  log(`⏰ 定时任务「${t.name}」开跑（${reason}${trial ? "，试跑" : ""}）`);
  if (!trial) { t.lastFiredAt = Date.now(); save(); }
  return item;
}

// 入队之后、真开跑之前任务被删 / 被关：不跑了，记一笔跳过（DeepSeek 复核 中-2；入队前那道见 fireNow）
START_GUARDS.push((q) => {
  if (!q.sched) return true;
  let ctx = RUNNING.get(q.sched.key);
  // 网关重启后从队列恢复的条目（挂起、用户点了放行）：内存里的调度记录没了，按条目重建一份，
  // 守卫照样核、结束照样记运行和次数（#132）。任务已经删了就不跑
  if (!ctx) {
    if (!byId(q.sched.taskId)) { log("⏭ 恢复的定时任务条目：任务已经删了，不跑"); return false; }
    ctx = { taskId: q.sched.taskId, startedAt: Date.now(), attempt: 0, trial: !!q.sched.trial, reason: "recovered" };
    RUNNING.set(q.sched.key, ctx);
  }
  if (ctx.trial) return true;
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
  // 排队期间别的任务可能把当天预算花完了：真开跑前再核一次（#119-2）
  if (t && DB.dailyBudget > 0 && costToday() >= DB.dailyBudget) {
    RUNNING.delete(q.sched.key);
    const msg = tz("今天的花费已到上限");
    log(`⏭ 定时任务「${t.name}」跳过：${msg}`);
    addRun({ taskId: t.id, at: Date.now(), st: "skip", msg });
    note(t, tz("定时任务已跳过"), tz("「{n}」：今天的花费已到上限", { n: t.name }), null, false);
    return false;
  }
  // 不是到点触发的（手动跑、重启后恢复的 reason:"recovered"）任务关着也放行：和手动跑一个意思，旧版缺 ctx 时也是直接放行
  if (t && (ctx.reason !== "due" || t.on)) return true;
  RUNNING.delete(q.sched.key);
  const msg = tz("排队时任务被关掉或删了");
  log(`⏭ 定时任务${t ? "「" + t.name + "」" : ""}跳过：${msg}`);
  if (t) addRun({ taskId: t.id, at: Date.now(), st: "skip", msg });
  return false;
});

// 网关连同那一轮被系统结束：END_HOOKS 没机会跑，运行记录里就像这次没发生过，「接着同一个对话」的下一次也接不上（195-AA.3）。
// 启动恢复时补记一次失败运行，接着的对话写回 lastSid。按 run id 去重：标记没删掉、下次启动又给一遍时不重复记
RECOVER_HOOKS.push((runs) => {
  for (const r of runs) {
    if (!r.sched || !r.sched.taskId || r.sched.trial) continue;
    const t = byId(r.sched.taskId);
    if (!t || RUNLOG.some((x) => x.runId === r.id)) continue;
    log(`⏰ 定时任务「${t.name}」上一轮被系统结束，记一次失败`);
    // 时间记这一轮开始的时候；时长不知道（停机那段不能算进去），不写
    addRun({ taskId: t.id, at: r.startedAt || Date.now(), st: "err", msg: tz("网关被系统结束，这一轮没跑完"), runId: r.id, sid: r.sessionId || null, attempt: 0 });
    if (r.sessionId && t.session === "same") { t.lastSid = r.sessionId; delete t.lostSid; save(); }
  }
});

// 会话进了回收站：接着它的任务放下 lastSid，详情里标「原来的对话已删除」，下一次新开（#173-3）
TRASH_HOOKS.push((id) => {
  let n = 0;
  for (const t of DB.tasks) if (t.lastSid === id) { t.lostSid = id; t.lastSid = null; n++; }
  if (n) { save(); publish({ type: "sched", op: "edit" }); }
});

// 一轮结束：记运行记录、改会话名、通知、重试
END_HOOKS.push((run, f) => {
  if (!run.sched) return;
  const ctx = RUNNING.get(run.sched.key); RUNNING.delete(run.sched.key);
  if (!ctx) return;
  const t = byId(run.sched.taskId), cost = Number(f.costRaw || f.costUsd || 0);
  // 跑着的时候任务被删了：已经花掉的钱照样记进当天的预算日桶，不然后面的任务会在超额以后继续跑（#149-1）。
  // 试跑也记（197-5.10）
  if (!t) { if (cost > 0) { spend(ctx.startedAt, cost); save(); } return; }
  const dur = Date.now() - ctx.startedAt;
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
    // 试跑是新对话：用带时间的名字，也不写回任务的 lastSid（#119-4）。
    // 用户手动改过名的不覆盖：只改「还是任务名 / 任务名 · 时间」的（195-A.4）
    const want = t.session === "same" && !ctx.trial ? t.name : `${t.name} · ${stamp}`;
    const cur = NAMES[sid];
    if (!cur || cur === t.name || cur.startsWith(t.name + " · ")) { NAMES[sid] = want; saveNames(); }
    if (!DB.sids.includes(sid)) DB.sids.push(sid);
    if (DB.sids.length > 2000) DB.sids = DB.sids.slice(-2000);   // 只增不减（200-6-05）
    if (t.session === "same" && !ctx.trial) { t.lastSid = sid; delete t.lostSid; }
  }
  // 试跑花的钱也进日桶（197-5.10），再走原来的通知/提前返回
  spend(ctx.startedAt, cost); save();
  if (ctx.trial) { note(t, tz("试跑完成"), msg, sid, st === "ok"); return; }
  // 这次成功了：之前失败排的 2 分钟重试作废，别再重复跑一遍（手动/计划成功都算）
  if (st === "ok") cancelRetry(t.id);
  // 不存成对话：这次的会话随后进回收站。运行记录和通知就别再指向它了（点了只会 404，#173-1）；完整结果看 full（#173-2）。
  // 接着同一个对话的不回收：下一次还要接着它，回收了就 --resume 失败（#173-3）。
  // 失败轮次也算：saveSession=false 说好的「只留运行记录」，以前失败时仍把会话留在主列表（197-2.5）
  const drop = !!sid && t.saveSession === false && t.session !== "same";
  addRun({ taskId: t.id, at: ctx.startedAt, st, msg: msg.slice(0, 300), full: text.slice(0, 2000), cost, dur, sid: drop ? null : sid, attempt: ctx.attempt });
  t.runsDone = (t.runsDone || 0) + 1;
  if (t.until?.kind === "count" && t.runsDone >= (+t.until.count || 1)) t.on = false;
  if (t.freq?.kind === "once") t.on = false;
  refreshNext(t); save();
  if (drop) { try { trashSession(sid); } catch {} }
  // 通知：每次 / 只在失败时 / 只在有发现时（回复不是那句固定的话）/ 不通知
  const found = !t.quiet || text.replace(/[\s。.!！]/g, "") !== String(t.quiet).replace(/[\s。.!！]/g, "");
  const want = t.notify === "none" ? false : t.notify === "fail" ? st !== "ok" : t.notify === "found" ? (st !== "ok" || found) : true;
  if (want) note(t, st === "ok" ? tz("定时任务完成：{n}", { n: t.name }) : tz("定时任务没成：{n}", { n: t.name }), msg, drop ? null : sid, st === "ok");
  // 超了花费上限不重试：重试就是再花一遍（#98 03-010）
  if (st === "err" && !over && ctx.attempt < (+t.retry || 0)) {
    clearTimeout(RETRY.get(t.id));
    RETRY.set(t.id, setTimeout(guarded("sched 重试", () => { RETRY.delete(t.id); if (byId(t.id) === t) fire(t, { reason: "retry", attempt: ctx.attempt + 1 }).catch((e) => log("定时任务重试出错：" + e.message)); }), 2 * 60000));
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
      // 只跑一次、时间已过还没跑过：关掉并记一笔，免得界面一直显示启用却永远不跑（审查 v0.5.3 B7）。
      // 暂停过（pausedUntil 留着旧值）也要能关，以前它永远不等于 0，任务就永远关不掉（200-16-05）
      if (t.freq?.kind === "once" && (!t.pausedUntil || t.pausedUntil <= now)) { t.on = false; t.pausedUntil = 0; addRun({ taskId: t.id, at: now, st: "skip", msg: tz("只跑一次的时间已过，任务已关") }); continue; }
      // 排不出下次的（如 2 月 31 日）每 30 秒重算一遍要扫满一年：一小时看一次就够
      if (now - (NULL_AT.get(t.id) || 0) < 3600e3) continue;
      NULL_AT.set(t.id, now); refreshNext(t, now); continue;
    }
    if (t.nextAt > now) continue;
    const late = now - t.nextAt;
    // 晚了 3 分钟以上：应用没在跑 / 机器睡死了 —— 按「错过了」的设置来，不默默补跑
    if (late > 3 * 60000 && gap > 3 * 60000 || late > 15 * 60000) {
      const when = t.nextAt;
      if (t.missed === "run") {
        // 「跳过下一次」指的正是这次错过的计划：消费掉标记，别让再下一次 due 被跳
        if (t.skipNext && (!t.skipAt || t.skipAt <= when)) { t.skipNext = false; t.skipAt = 0; addRun({ taskId: t.id, at: when, st: "skip", msg: tz("按设置跳过这一次") }); }
        else fire(t, { reason: "missed" });
      }
      else if (t.missed === "skip") { if (t.skipNext && (!t.skipAt || t.skipAt <= when)) { t.skipNext = false; t.skipAt = 0; } addRun({ taskId: t.id, at: when, st: "skip", msg: tz("错过了（当时应用没在跑），按设置跳过") }); }
      else if (!DB.missed.some((m) => m.taskId === t.id && m.at === when)) { DB.missed.push({ taskId: t.id, at: when }); publish({ type: "sched", op: "missed" }); }
      log(`⏰ 定时任务「${t.name}」错过 ${new Date(when).toLocaleString()}（${t.missed || "ask"}）`);
    } else fire(t, { reason: "due" });
    refreshNext(t, now);
  }
  DB.lastTick = now;
  save();
}
if (LIVE) setTimeout(guarded("sched 首次 tick", () => { tick(); setInterval(guarded("sched tick", tick), 30000); }), 5000);

// ── 校验 / 整理前端交来的任务 ──
const KINDS = ["daily", "weekly", "monthly", "every", "once", "cron"];
function clean(b, old = {}) {
  const t = { ...old };
  const s = (k, n = 200) => { if (typeof b[k] === "string") t[k] = b[k].trim().slice(0, n); };
  s("name", 60); s("prompt", 8000); s("tools", 500); s("model", 80); s("effort", 20); s("provider", 40); s("quiet", 60);
  if ("projectId" in b) t.projectId = b.projectId && projectById(b.projectId) ? b.projectId : null;
  if (b.freq && KINDS.includes(b.freq.kind)) {
    const f = b.freq, o = { kind: f.kind };
    // 以前非法字段逐项静默丢掉：monthly 29–31 变成 1 号、weekly 空/小数永不跑、daily 99:99 归一成错时间（200-16-04）。
    // 只校验给了的字段，没给的那项仍沿用 old / 默认
    if ("time" in f) { if (!hmOk(f.time)) throw new Error(tz("时间要填 0–23 时、0–59 分")); o.time = f.time; }
    if ("days" in f) {
      if (!Array.isArray(f.days) || !f.days.length || !f.days.every((x) => Number.isInteger(+x) && +x >= 1 && +x <= 7))
        throw new Error(tz("星期要选 1–7 之间的整数值，至少一天"));
      o.days = [...new Set(f.days.map(Number))].sort((a, b2) => a - b2);
    }
    if ("day" in f) {
      if (f.day !== "last" && !(Number.isInteger(+f.day) && +f.day >= 1 && +f.day <= 31)) throw new Error(tz("每月几号要填 1–31 或「最后一天」"));
      o.day = f.day === "last" ? "last" : +f.day;
    }
    if ("hours" in f) { if (!(Number.isInteger(+f.hours) && +f.hours >= 1 && +f.hours <= 24)) throw new Error(tz("每隔几小时要填 1–24 的整数")); o.hours = +f.hours; }
    if ("from" in f) { if (!hmOk(f.from)) throw new Error(tz("开始时间要填 0–23 时、0–59 分")); o.from = f.from; }
    if ("to" in f) { if (!hmOk(f.to)) throw new Error(tz("结束时间要填 0–23 时、0–59 分")); o.to = f.to; }
    if (f.kind === "every" && o.from && o.to) {
      const [a, b] = hm(o.from), [c, d] = hm(o.to);
      // 22:00–02:00 这种跨午夜窗口在 nextAt 的每日循环里永远不命中：保存时就拒绝，别存下一个永不跑的任务
      if (a * 60 + b > c * 60 + d) throw new Error(tz("「每隔几小时」的开始时间要早于结束时间；跨午夜请拆成两个任务"));
    }
    if (f.kind === "once") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date || "") || isNaN(new Date(f.date + "T00:00:00"))) throw new Error(tz("只跑一次要填一个日期"));
      o.date = f.date;
    } else if ("date" in f) { if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date || "")) throw new Error(tz("日期格式是 YYYY-MM-DD")); o.date = f.date; }
    if (f.kind === "cron") {
      if (typeof f.cron !== "string" || !f.cron.trim()) throw new Error(tz("cron 表达式要填五段：分 时 日 月 周"));
      parseCron(f.cron); o.cron = f.cron.trim();
    } else if ("cron" in f && typeof f.cron === "string") { parseCron(f.cron); o.cron = f.cron.trim(); }
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
  const b = DB.monthly[monthKey(Date.now())] || { cost: 0, runs: 0, ok: 0, err: 0, skip: 0 };
  return { cost: b.cost || 0, runs: b.runs || 0, ok: b.ok || 0, err: b.err || 0, skip: b.skip || 0 };
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
    refreshNext(t); DB.tasks.push(t);
    if (!save()) { DB.tasks.pop(); pushNext(); return sendJson(res, 500, { ok: false, error: "write_failed", message: tz("没保存上：存储满了或没有权限") }); }
    log(`⏰ 新定时任务「${t.name}」 下次 ${t.nextAt ? new Date(t.nextAt).toLocaleString() : "—"}`);
    return sendJson(res, 200, { ok: true, task: summary(t) });
  }
  // 外壳的闹钟响了：立刻查一遍（不用等下一个 30 秒）
  if (p === "/api/sched/tick" && req.method === "POST") { tick(); return sendJson(res, 200, { ok: true, next: lastNext }); }
  if (p === "/api/sched/allow-login" && req.method === "PUT") {
    const b = await body(), before = DB.allowLogin; DB.allowLogin = !!b.on;
    if (!save()) { DB.allowLogin = before; return sendJson(res, 500, { ok: false, error: "write_failed", message: tz("没保存上：存储满了或没有权限") }); }
    log(`⏰ 用订阅账户跑定时任务：${DB.allowLogin ? "已打开（用户确认了条款提示）" : "已关闭"}`);
    return sendJson(res, 200, { ok: true, allowLogin: DB.allowLogin });
  }
  if (p === "/api/sched/budget" && req.method === "PUT") {
    const b = await body(), before = DB.dailyBudget; DB.dailyBudget = Math.max(0, Math.min(1000, +b.daily || 0));
    if (!save()) { DB.dailyBudget = before; return sendJson(res, 500, { ok: false, error: "write_failed", message: tz("没保存上：存储满了或没有权限") }); }
    return sendJson(res, 200, { ok: true });
  }
  if (p === "/api/sched/missed" && req.method === "POST") {
    const b = await body();
    const i = DB.missed.findIndex((m) => m.taskId === b.taskId && (!b.at || m.at === b.at));
    if (i < 0) return sendJson(res, 404, { error: "not missed" });
    const m = DB.missed.splice(i, 1)[0]; save();
    const t = byId(m.taskId);
    // 只有「跳过」标记早于这次错过时才消费；用户是在错过卡出现之后才设的跳过，要留给下一次计划
    if (t && t.skipNext && (!t.skipAt || t.skipAt <= m.at)) { t.skipNext = false; t.skipAt = 0; save(); }
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
  if (!sub && req.method === "GET") {
    const mine = RUNLOG.filter((r) => r.taskId === t.id);
    // runsTotal：界面只拿到最近 100 次，据此说「只列出最近 100 次」（#178-3）
    return sendJson(res, 200, { task: summary(t), runs: mine.slice(-100).reverse().map(({ full, ...r }) => (r.sid ? r : { ...r, full })), runsTotal: mine.length, running: runningNow().some((x) => x.taskId === t.id) });
  }
  if (!sub && req.method === "PATCH") {
    const b = await body();
    try { clean(b, {}); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    const before = { ...t };
    Object.assign(t, clean(b, t));
    if (b.on === true) { t.pausedUntil = 0; t.skipNext = false; t.skipAt = 0; }
    if (b.on === false) cancelRetry(t.id);
    refreshNext(t);
    if (!save()) { for (const k of Object.keys(t)) delete t[k]; Object.assign(t, before); refreshNext(t); return sendJson(res, 500, { ok: false, error: "write_failed", message: tz("没保存上：存储满了或没有权限") }); }
    return sendJson(res, 200, { ok: true, task: summary(t) });
  }
  if (!sub && req.method === "DELETE") {
    // 正在跑：删了的话这一次的记录、命名、通知、不存对话的回收都没人做了（#178-8）
    if (runningNow().some((x) => x.taskId === t.id)) return sendJson(res, 409, { error: tz("任务正在跑：等它跑完，或先在对话里停掉，再删") });
    cancelRetry(t.id);
    const tasks0 = DB.tasks, missed0 = DB.missed;
    DB.tasks = DB.tasks.filter((x) => x.id !== t.id); DB.missed = DB.missed.filter((x) => x.taskId !== t.id);
    if (!save()) { DB.tasks = tasks0; DB.missed = missed0; return sendJson(res, 500, { ok: false, error: "write_failed", message: tz("没保存上：存储满了或没有权限") }); }
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
    const b = await body(), before = { ...t };
    t.skipNext = b.mode === "skip";
    t.skipAt = t.skipNext ? (t.nextAt || 0) : 0;   // 绑定到当前这一次计划，之后的补跑/改期不会误消费
    t.pausedUntil = b.mode === "1d" ? Date.now() + 864e5 : b.mode === "1w" ? 7 * 864e5 + Date.now() : 0;
    if (t.pausedUntil) cancelRetry(t.id);
    refreshNext(t);
    if (!save()) { for (const k of Object.keys(t)) delete t[k]; Object.assign(t, before); refreshNext(t); return sendJson(res, 500, { ok: false, error: "write_failed", message: tz("没保存上：存储满了或没有权限") }); }
    return sendJson(res, 200, { ok: true, task: summary(t) });
  }
  return NEXT;
}
export const _schedForTest = { fire, tick, clean, DB, runlog: () => RUNLOG, running: () => runningNow(), costToday, hasRetry: (id) => RETRY.has(id) };   // 只给测试用
