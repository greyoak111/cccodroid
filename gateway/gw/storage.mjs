// 存储（D10）：本应用占了多少、哪些能清，按六类分开管（方案见 D10-存储清理方案 v2，11-09 用户定稿）。
//   1 缓存：写死的几个目录，清的时候全清（刚写过的、有进程开着的不碰）
//   2 临时文件 $TMPDIR：7 天没动过的（含 claude 的后台命令输出、测试残留）；有进程开着、属于在跑 / 排队会话的不碰
//   3 claude 的杂物：debug 日志、shell 快照、MCP 日志 30 天前的；.claude.json 的备份留最新 5 份
//      （保留期改成永久以后 claude 自己不再清这些，见 retention.mjs）
//   4 会话：永不自动删，只列最大的几个（删走会话列表 → 回收站）
//   5 程序和你的文件：只报大小
//   6 已有的清理入口（回收站、隔离的旧工具包残留、卸掉的组件留下的运行数据、用量统计）：汇总，跳回原处
// 自动清理（默认开、每周，可选每天 / 每月，可关）只动第 1–3 类，网关空闲时跑。
// 删除一律经 rmChecked：路径先解析真实位置，必须落在这一类允许的目录里、不在永不碰名单里；删了什么记日志。
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { CFG, PATHS, PREFIX, log } from "./config.mjs";
import { SETTINGS } from "./settings-store.mjs";
import { isObj, loadState, saveState } from "./statefile.mjs";
import { runList } from "./runs.mjs";
import { NEXT, readBody, sendJson } from "./http.mjs";
import { sessionRetention } from "./retention.mjs";

const DAY = 86400e3;
export const TMP_DAYS = 7, JUNK_DAYS = 30, KEEP_BACKUPS = 5;
const FRESH = 10 * 60e3;               // 缓存里 10 分钟内写过的不删：可能正在下载
const TOP = 20;                        // 列表最多列几项
const WALK_MAX = 200000;               // 一个条目里最多数这么多个文件，再多就当「看不全」不删
export const AUTO_EVERY = { day: DAY, week: 7 * DAY, month: 30 * DAY };

const H = (...r) => path.join(CFG.home, ...r);
const DATA = () => process.env.CCAPP_DATA_DIR || "";
const FILES_DIR = () => (PREFIX ? path.dirname(PREFIX) : "");
const TMP = () => (PREFIX ? path.join(PREFIX, "tmp") : "");
const CLAUDE_TMP = () => (TMP() ? path.join(TMP(), "claude-" + process.getuid()) : "");
const STATE_FILE = () => H("ccapp-storage.json");

// ── 永不碰：设置与状态、密钥、技能、插件、记忆、说明文件、审计与网关日志（落在这些下面的一律不删，哪怕规则算错了） ──
const NEVER = () => [H(".keys"), H(".ssh"), H(".gateway-token"), H(".bldtools"), H(".claude", "skills"), H(".claude", "plugins"),
  H(".claude", "projects"), H(".claude", "CLAUDE.md"), H(".claude", "settings.json"), H(".claude", ".credentials.json"), H(".claude.json"),
  H(".cache", "ccapp-login"), H(".cache", "llama-api-key"), H("priv-audit.jsonl"), H("gateway.log"), H(".ccapp-userconf"), H(".config")];
const NEVER_NAME = /^(ccapp-key.*|\.gateway-token|.*\.pem|id_[a-z0-9]+(\.pub)?|known_hosts|hosts\.yml)$/;

/** 真实路径：最后一级是软链的不跟（删的是链接本身） */
function realOf(p) {
  try { return path.join(fs.realpathSync(path.dirname(p)), path.basename(p)); } catch { return null; }
}
const realDir = (d) => { try { return fs.realpathSync(d); } catch { return null; } };
const under = (p, root) => p === root || p.startsWith(root.endsWith("/") ? root : root + "/");
/** 删之前最后一道：真实位置在允许的目录里（不能是目录本身）、不在永不碰名单里 */
export function rmChecked(p, roots) {
  const r = realOf(p);
  if (!r) return { ok: false, why: "gone" };
  const rs = roots.map(realDir).filter(Boolean);
  if (!rs.some((root) => r !== root && under(r, root))) return { ok: false, why: "outside" };
  const nv = NEVER().map((x) => realOf(x) || x);
  if (nv.some((x) => under(r, x) || under(x, r)) || NEVER_NAME.test(path.basename(r))) return { ok: false, why: "protected" };
  try { fs.rmSync(r, { recursive: true, force: true }); return { ok: true }; }
  catch (e) {
    // 解开的包里有只读目录：先改成可写再删一次
    try { chmodTree(r); fs.rmSync(r, { recursive: true, force: true }); return { ok: true }; } catch { return { ok: false, why: e.code || e.message }; }
  }
}
function chmodTree(d) {
  let st; try { st = fs.lstatSync(d); } catch { return; }
  if (!st.isDirectory()) return;
  try { fs.chmodSync(d, 0o700); } catch {}
  for (const n of fs.readdirSync(d)) chmodTree(path.join(d, n));
}

// ── 谁在用：本应用 uid 的进程开着的文件、所在目录（/proc 只看得见自己 uid 的） ──
export function openPaths() {
  const out = [];
  let pids = []; try { pids = fs.readdirSync("/proc").filter((n) => /^\d+$/.test(n)); } catch {}
  for (const pid of pids) {
    let fds = []; try { fds = fs.readdirSync(`/proc/${pid}/fd`); } catch { continue; }
    for (const fd of fds) { try { const t = fs.readlinkSync(`/proc/${pid}/fd/${fd}`); if (t.startsWith("/")) out.push(t.replace(/ \(deleted\)$/, "")); } catch {} }
    try { out.push(fs.readlinkSync(`/proc/${pid}/cwd`)); } catch {}
  }
  return out;
}
const inUse = (open, p) => { const r = realOf(p) || p; return open.some((o) => under(o, r) || under(o, p)); };

/** 正在跑、排着队的会话号：它们的临时目录不动 */
async function liveSessions() {
  const s = new Set();
  for (const r of runList()) if (r.sessionId) s.add(r.sessionId);
  try { const q = await import("./queue.mjs"); for (const it of q.QUEUE) { const sid = q.sidForItem(it); if (sid) s.add(sid); } } catch {}
  return s;
}

/** 一棵树：文件字节数、最新修改时刻、有没有数完。tick 让出事件循环 */
async function treeInfo(p, { skipName, collect = false } = {}) {
  let bytes = 0, newest = 0, n = 0, full = true;
  const files = [];
  const walk = async (q) => {
    let st; try { st = await fs.promises.lstat(q); } catch { return; }
    if (++n > WALK_MAX) { full = false; return; }
    if (n % 2000 === 0) await new Promise((r) => setImmediate(r));
    newest = Math.max(newest, st.mtimeMs);
    if (st.isDirectory()) {
      let es = []; try { es = await fs.promises.readdir(q); } catch { full = false; return; }
      for (const e of es) { if (skipName && skipName.test(e)) continue; await walk(path.join(q, e)); if (!full) return; }
    } else { bytes += st.size; if (collect) files.push({ p: q, size: st.size, mtime: st.mtimeMs }); }
  };
  await walk(p);
  return { bytes, newest, full, files };
}

// ── 第 1 类：缓存 ──
export function cacheDirs() {
  const d = DATA(), f = FILES_DIR();
  return [
    { id: "webview", dir: d && path.join(d, "cache", "WebView", "Default", "HTTP Cache"), keep: /^(index|index-dir)$/ },
    { id: "npm", dir: H(".npm", "_cacache") },
    { id: "pip", dir: H(".cache", "pip") },
    { id: "gh", dir: H(".cache", "gh") },
    { id: "pkg", dir: f && path.join(f, "pkg", "cache") },
    { id: "apt", dir: PREFIX && path.join(PREFIX, "var", "cache", "apt") },
    { id: "lineage", file: H(".cache", "ccapp-lineage-index.json") },
  ].filter((x) => x.dir || x.file);
}
/** 缓存目录里能删的文件（目录结构留着：apt 少了 archives/partial 会报错） */
async function cacheCandidates(open, now) {
  const items = [];
  for (const c of cacheDirs()) {
    const it = { id: c.id, path: c.dir || c.file, bytes: 0, files: [] };
    if (c.file) {
      try { const st = fs.lstatSync(c.file); if (st.isFile() && now - st.mtimeMs > FRESH && !inUse(open, c.file)) { it.bytes = st.size; it.files.push(c.file); } } catch {}
    } else {
      const t = await treeInfo(c.dir, { skipName: c.keep, collect: true });
      for (const f of t.files) if (now - f.mtime > FRESH && !inUse(open, f.p)) { it.bytes += f.size; it.files.push(f.p); }
    }
    items.push(it);
  }
  return items;
}

// ── 第 2 类：临时文件 ──
/** $TMPDIR 里的条目：顶层每一项；claude-<uid> 往下拆到 <项目>/<会话号> */
async function tmpUnits(open, live, now) {
  const root = TMP(), ct = CLAUDE_TMP(), units = [];
  if (!root) return units;
  const add = async (p, rel, sid) => {
    let st; try { st = fs.lstatSync(p); } catch { return; }
    if (st.isSocket() || st.isFIFO() || st.isCharacterDevice() || st.isBlockDevice()) return;
    const t = await treeInfo(p);
    const busy = inUse(open, p), active = !!(sid && live.has(sid));
    const age = now - t.newest;
    units.push({ path: p, rel, bytes: t.bytes, newest: t.newest, inUse: busy, active, full: t.full,
      auto: !busy && !active && t.full && age > TMP_DAYS * DAY });
  };
  let top = []; try { top = fs.readdirSync(root); } catch {}
  for (const n of top) {
    const p = path.join(root, n);
    if (p !== ct) { await add(p, n); continue; }
    let slugs = []; try { slugs = fs.readdirSync(ct); } catch {}
    for (const s of slugs) {
      if (s === "bundled-skills") continue;         // claude 解出来的内置技能：在跑的 claude 用到时才读，不动
      const sp = path.join(ct, s);
      let es = []; try { es = fs.lstatSync(sp).isDirectory() ? fs.readdirSync(sp) : null; } catch {}
      if (es === null) { await add(sp, path.join(n, s)); continue; }
      for (const e of es) await add(path.join(sp, e), path.join(n, s, e), /^[0-9a-f-]{36}$/.test(e) ? e : null);
    }
  }
  return units;
}

// ── 第 3 类：claude 的杂物 ──
async function junkUnits(open, live, now) {
  const units = [];
  const old = (st) => now - st.mtimeMs > JUNK_DAYS * DAY;
  const fileUnit = (p, kind, st, auto) => units.push({ path: p, kind, bytes: st.size, newest: st.mtimeMs, inUse: inUse(open, p), auto: auto && !inUse(open, p) });
  const each = (dir, fn) => { let ns = []; try { ns = fs.readdirSync(dir); } catch {} for (const n of ns) { const p = path.join(dir, n); let st; try { st = fs.lstatSync(p); } catch { continue; } fn(p, n, st); } };
  each(H(".claude", "debug"), (p, n, st) => {
    if (!st.isFile()) return;                       // latest 这个软链不动
    const sid = n.replace(/\.txt$/, "");
    fileUnit(p, "debug", st, old(st) && !live.has(sid));
  });
  each(H(".claude", "shell-snapshots"), (p, n, st) => { if (st.isFile()) fileUnit(p, "snapshot", st, old(st)); });
  const backs = [];
  each(H(".claude", "backups"), (p, n, st) => { if (st.isFile() && n.startsWith(".claude.json.backup")) backs.push({ p, st }); });
  backs.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs).forEach((b, i) => fileUnit(b.p, "backup", b.st, i >= KEEP_BACKUPS));
  // MCP 服务器的日志：~/.cache/claude-cli-nodejs/<项目>/mcp-logs-<服务器>/*
  each(H(".cache", "claude-cli-nodejs"), (pp, n, st) => {
    if (!st.isDirectory()) return;
    each(pp, (lp, ln, lst) => { if (lst.isDirectory() && ln.startsWith("mcp-logs-")) each(lp, (f, fn2, fst) => { if (fst.isFile()) fileUnit(f, "mcp-log", fst, old(fst)); }); });
  });
  return units;
}
const JUNK_ROOTS = () => [H(".claude", "debug"), H(".claude", "shell-snapshots"), H(".claude", "backups"), H(".cache", "claude-cli-nodejs")];

// ── 第 4 类：会话（只看） ──
async function sessionSizes() {
  const out = [];
  const proj = PATHS.projects;
  let dirs = []; try { dirs = fs.readdirSync(proj); } catch {}
  for (const d of dirs) {
    let fs2 = []; try { fs2 = fs.readdirSync(path.join(proj, d)).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
    for (const f of fs2) {
      const id = f.slice(0, -6), file = path.join(proj, d, f);
      let size = 0; try { const st = fs.statSync(file); if (!st.isFile()) continue; size = st.size; } catch { continue; }
      const side = (await treeInfo(path.join(proj, d, id))).bytes + (await treeInfo(H(".claude", "file-history", id))).bytes;
      out.push({ id, bytes: size + side, file });
    }
  }
  out.sort((a, b) => b.bytes - a.bytes);
  const total = out.reduce((a, s) => a + s.bytes, 0);
  const { NAMES, peekSession } = await import("./sessions.mjs");
  const top = out.slice(0, TOP).map((s) => { let title = NAMES[s.id] || ""; if (!title) try { title = peekSession(s.file).title || ""; } catch {} return { id: s.id, bytes: s.bytes, title }; });
  return { count: out.length, bytes: total, top };
}

// ── 第 5 类：程序和文件（只看） ──
function du(p) {
  return new Promise((resolve) => {
    try { fs.lstatSync(p); } catch { return resolve(null); }
    const bin = PREFIX && fs.existsSync(path.join(PREFIX, "bin", "du")) ? path.join(PREFIX, "bin", "du") : "du";
    execFile(bin, ["-sk", p], { timeout: 180e3, maxBuffer: 1 << 20 }, (_e, out) => {
      const k = parseInt(String(out || "").trim().split(/\s/)[0], 10);
      resolve(Number.isFinite(k) ? k * 1024 : null);
    });
  });
}
function pkgSizes() {
  const f = FILES_DIR(); if (!f || !PREFIX) return [];
  let db; try { db = JSON.parse(fs.readFileSync(path.join(f, "pkg", "installed.json"), "utf8")); } catch { return []; }
  const out = [];
  for (const [name, r] of Object.entries(isObj(db?.pkgs) ? db.pkgs : {})) {
    if (!isObj(r) || r.auto) continue;                        // 依赖带进来的不单列
    let bytes = 0;
    for (const rel of Array.isArray(r.files) ? r.files : []) { if (typeof rel !== "string" || rel.includes("..")) continue; try { const st = fs.lstatSync(path.join(PREFIX, rel)); if (st.isFile()) bytes += st.size; } catch {} }
    out.push({ name, version: String(r.version || ""), bytes });
  }
  return out.sort((a, b) => b.bytes - a.bytes).slice(0, TOP);
}
async function programs() {
  const f = FILES_DIR();
  const claudeDir = H(".local", "share", "cccodroid", "claude");
  let cur = ""; try { cur = path.basename(fs.realpathSync(path.join(claudeDir, "current"))); } catch {}
  const versions = [];
  try { for (const v of fs.readdirSync(claudeDir)) if (v !== "current" && fs.lstatSync(path.join(claudeDir, v)).isDirectory()) versions.push({ version: v, current: v === cur, bytes: await du(path.join(claudeDir, v)) }); } catch {}
  const known = new Set([".claude", ".cache", ".npm", ".local", ".ccapp-trash", ".cccodroid", path.basename(CFG.workspace)]);
  const homeDirs = [];
  try {
    for (const n of fs.readdirSync(CFG.home)) {
      const p = H(n);
      if (known.has(n) || !fs.lstatSync(p).isDirectory()) continue;
      const bytes = await du(p);
      if (bytes != null && bytes >= 1 << 20) homeDirs.push({ path: "~/" + n, bytes });   // 不到 1 MB 的不列
    }
  } catch {}
  homeDirs.sort((a, b) => (b.bytes || 0) - (a.bytes || 0));
  return {
    toolkit: PREFIX ? await du(PREFIX) : null,
    components: f ? await du(path.join(f, "components")) : null,
    compData: await du(H(".cccodroid")),
    pkgs: pkgSizes(),
    claude: versions,
    workspace: await du(CFG.workspace),
    shared: process.env.CCAPP_SHARED ? await du(process.env.CCAPP_SHARED) : null,
    home: homeDirs.slice(0, 12),
  };
}

// ── 第 6 类：已有的入口（汇总） ──
async function entries() {
  const out = {};
  try { const { listTrash } = await import("./sessionops.mjs"); const t = listTrash(); out.trash = { count: t.length, bytes: t.reduce((a, m) => a + (m.size || 0), 0) }; } catch {}
  try {
    const root = FILES_DIR(); let bytes = 0, count = 0;
    if (root) for (const n of fs.readdirSync(root)) if (/^orphans-\d{8}$/.test(n)) { count++; bytes += (await treeInfo(path.join(root, n))).bytes; }
    out.orphans = { count, bytes };
  } catch {}
  try { const { compLeftovers } = await import("./components.mjs"); const l = await compLeftovers(); out.compData = { count: l.length, bytes: l.reduce((a, x) => a + x.bytes, 0), items: l }; } catch {}
  try { out.usage = { bytes: fs.statSync(H("ccapp-usage.json")).size }; } catch { out.usage = { bytes: 0 }; }
  return out;
}

// ── 状态：上次扫描、自动清理记录 ──
const shape = (j) => (isObj(j) ? { lastAuto: Number(j.lastAuto) || 0, history: Array.isArray(j.history) ? j.history.filter(isObj).slice(-30) : [], scan: isObj(j.scan) ? j.scan : null } : undefined);
let ST = null;
const st = () => ST || (ST = loadState(STATE_FILE(), { shape, fallback: () => ({ lastAuto: 0, history: [], scan: null }), max: 4 << 20 }).data);
const saveSt = () => saveState(STATE_FILE(), st(), { pretty: false });

export function autoCleanCfg() {
  const a = isObj(SETTINGS.autoClean) ? SETTINGS.autoClean : {};
  return { enabled: a.enabled !== false, every: AUTO_EVERY[a.every] ? a.every : "week" };
}

const sum = (xs) => xs.reduce((a, x) => a + (x.bytes || 0), 0);
const tilde = (p) => (p && under(p, CFG.home) ? "~" + p.slice(CFG.home.length) : p);
let SCANNING = null;
/** 扫一遍（同一时刻只跑一份）。结果存盘，存储页打开就有上次的 */
export function scanStorage() {
  if (SCANNING) return SCANNING;
  SCANNING = (async () => {
    const t0 = Date.now(), open = openPaths(), live = await liveSessions();
    const cache = await cacheCandidates(open, t0);
    const tmp = await tmpUnits(open, live, t0);
    const junk = await junkUnits(open, live, t0);
    let free = null, total = null;
    try { const s = fs.statfsSync(CFG.home); free = s.bavail * s.bsize; total = s.blocks * s.bsize; } catch {}
    const r = {
      at: Date.now(), ms: Date.now() - t0,
      device: { free, total },
      app: DATA() ? await du(DATA()) : await du(CFG.home),
      retention: sessionRetention(),
      cache: { bytes: sum(cache), items: cache.map((c) => ({ id: c.id, path: tilde(c.path), bytes: c.bytes, count: c.files.length })) },
      tmp: { bytes: sum(tmp), auto: sum(tmp.filter((u) => u.auto)), count: tmp.length,
        top: [...tmp].sort((a, b) => b.bytes - a.bytes).slice(0, TOP).map((u) => ({ rel: u.rel, bytes: u.bytes, newest: u.newest, inUse: u.inUse, active: u.active, auto: u.auto })) },
      junk: { bytes: sum(junk), auto: sum(junk.filter((u) => u.auto)), count: junk.length, autoCount: junk.filter((u) => u.auto).length },
      sessions: await sessionSizes(),
      programs: await programs(),
      entries: await entries(),
    };
    st().scan = r; saveSt();
    return r;
  })().finally(() => { SCANNING = null; });
  return SCANNING;
}

/** 清第 1–3 类。tmp 可以带 picks（相对 $TMPDIR 的条目，界面上勾的），没带就按规则（7 天）。返回 { freed, n, skipped } */
export async function cleanStorage(cats, { picks = null, auto = false, at = Date.now() } = {}) {
  const now = Date.now(), open = openPaths(), live = await liveSessions();
  let freed = 0, n = 0, skipped = 0;
  const done = {};
  const rm = (p, bytes, roots, cat) => {
    const r = rmChecked(p, roots);
    if (r.ok) { freed += bytes; n++; done[cat] = (done[cat] || 0) + bytes; }
    else if (r.why !== "gone") { skipped++; log(`[存储] 没删 ${tilde(p)}：${r.why}`); }
  };
  if (cats.includes("cache")) {
    const dirs = cacheDirs();
    for (const it of await cacheCandidates(open, now)) {
      const c = dirs.find((x) => x.id === it.id);
      const roots = c.dir ? [c.dir] : [path.dirname(c.file)];
      for (const f of it.files) { let s = 0; try { s = fs.lstatSync(f).size; } catch {} rm(f, s, roots, "cache"); }
    }
  }
  if (cats.includes("tmp") && TMP()) {
    const want = Array.isArray(picks) ? new Set(picks.map(String)) : null;
    for (const u of await tmpUnits(open, live, now)) {
      // 勾的也要过：有进程开着、会话还在跑的照样不删；没数完的不删
      const ok = want ? want.has(u.rel) && !u.inUse && !u.active && u.full : u.auto;
      if (ok) rm(u.path, u.bytes, [TMP()], "tmp");
    }
  }
  if (cats.includes("junk")) for (const u of await junkUnits(open, live, now)) if (u.auto) rm(u.path, u.bytes, JUNK_ROOTS(), "junk");
  const rec = { at, auto, freed, n, skipped, cats: done };
  st().history.push(rec); st().history = st().history.slice(-30);
  if (auto) st().lastAuto = at;
  saveSt();
  log(`[存储] ${auto ? "自动" : "手动"}清理 ${cats.join("+")}：删了 ${n} 项，腾出 ${(freed / 1048576).toFixed(1)} MB${skipped ? `，${skipped} 项没删（见上）` : ""}`);
  return rec;
}

// ── 自动清理：每小时看一眼，到期又空闲（没有在跑、排队的）就清第 1–3 类 ──
let AUTO_T = null;
export async function autoCleanTick(now = Date.now()) {
  const cfg = autoCleanCfg();
  if (!cfg.enabled) return null;
  if (now - st().lastAuto < AUTO_EVERY[cfg.every]) return null;
  if (runList().length) return null;
  try { const q = await import("./queue.mjs"); if (q.QUEUE.length) return null; } catch {}
  if (SCANNING) return null;
  return cleanStorage(["cache", "tmp", "junk"], { auto: true, at: now });
}
export function startAutoClean() {
  if (AUTO_T) return;
  // 启动 10 分钟后第一次看（错过了的这时补上），之后每小时
  const tick = () => autoCleanTick().catch((e) => log("[存储] 自动清理失败：" + e.message));
  AUTO_T = setTimeout(function again() { tick(); AUTO_T = setTimeout(again, 3600e3); AUTO_T.unref?.(); }, 600e3);
  AUTO_T.unref?.();
}

// ── 路由：/api/storage ──
export async function routeStorage(req, res, u, p) {
  if (!p.startsWith("/api/storage")) return NEXT;
  if (p === "/api/storage" && req.method === "GET") {
    const s = st();
    return sendJson(res, 200, { ok: true, scan: s.scan, scanning: !!SCANNING, auto: { ...autoCleanCfg(), lastAt: s.lastAuto || 0 }, history: s.history.slice(-10).reverse(), retention: sessionRetention() });
  }
  if (p === "/api/storage/scan" && req.method === "POST") {
    scanStorage().catch((e) => log("[存储] 扫描失败：" + e.message));
    return sendJson(res, 200, { ok: true, scanning: true });
  }
  if (p === "/api/storage/clean" && req.method === "POST") {
    let b = {}; try { b = JSON.parse((await readBody(req)) || "{}"); } catch { return sendJson(res, 400, { ok: false, message: "bad json" }); }
    const cat = String(b.cat || "");
    if (!["cache", "tmp", "junk"].includes(cat)) return sendJson(res, 400, { ok: false, message: "bad cat" });
    const picks = cat === "tmp" && Array.isArray(b.picks) ? b.picks.filter((x) => typeof x === "string" && x.length < 4096).slice(0, 200) : null;
    const r = await cleanStorage([cat], { picks });
    scanStorage().catch(() => {});
    return sendJson(res, 200, { ok: true, ...r });
  }
  return NEXT;
}
