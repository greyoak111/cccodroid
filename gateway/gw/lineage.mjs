// 脉络 · 网关这一侧：扫全部会话（含回收站）、增量缓存、给前端的 /api/lineage。
// 推断逻辑在 lineage-core.mjs；显式记录（分叉 / 回退时写）在 lineage-store.mjs。规划见 claude-workspace/session-lineage-plan.md。
//
// 缓存：每个会话按字节偏移增量读，结果落在 home/.cache/ccapp-lineage-index.json。
// 开发端 900 MB 的会话从头扫一遍约 15 秒，所以不能每次重启都重扫；落盘后重启只读新追加的部分。
// 会话记录（jsonl）一个字节都不改。
import fs from "node:fs";
import path from "node:path";
import { CFG, PATHS, log } from "./config.mjs";
import { NEXT, sendJson } from "./http.mjs";
import { NAMES, NAMES_REV, PINS } from "./sessions.mjs";
import { archiveDb, archivedTitle, miscOf } from "./archive-store.mjs";
import { chapterView } from "./archive-core.mjs";
import { runOfSession } from "./runs.mjs";
import { emptyRecord, inferParents, scanSession, weakPrompt } from "./lineage-core.mjs";
import { lineageDb } from "./lineage-store.mjs";

const CACHE_FILE = path.join(CFG.home, ".cache", "ccapp-lineage-index.json");
const TRASH_DIR = path.join(CFG.home, ".ccapp-trash");
const SID = /^[0-9a-f-]{36}$/i;

let RECS = null;          // id → 记录（lineage-core 的 scanSession 结果）
const META = new Map();   // id → { file, project, trashed, mtime }
let building = null, dirty = false, gen = 0, memo = null;
const PROG = { done: 0, total: 0 };   // 首次整理大户要十几秒，页面显示进度   // gen：索引每变一次加一；memo：按 gen 缓存的主父推断

function loadCache() {
  if (RECS) return;
  RECS = new Map();
  try {
    const j = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    if (j && j.v === 2 && Array.isArray(j.recs)) for (const r of j.recs) if (r && r.id) RECS.set(r.id, { ...emptyRecord(r.id), ...r });
  } catch {}
}
function saveCache() {
  if (!dirty) return;
  dirty = false;
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE + ".tmp", JSON.stringify({ v: 2, recs: [...RECS.values()] }), { mode: 0o600 });
    fs.renameSync(CACHE_FILE + ".tmp", CACHE_FILE);
  } catch (e) { log("写脉络缓存失败: " + e.message); }
}

/** 列出全部会话文件：projects 下的，加回收站里的（画成幽灵节点，亲缘不断） */
function listFiles() {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(PATHS.projects, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch {}
  for (const d of dirs) {
    const dir = path.join(PATHS.projects, d.name);
    let names = []; try { names = fs.readdirSync(dir); } catch { continue; }
    for (const f of names) if (f.endsWith(".jsonl") && SID.test(f.slice(0, -6))) out.push({ id: f.slice(0, -6), file: path.join(dir, f), project: d.name, trashed: false });
  }
  let slots = []; try { slots = fs.readdirSync(TRASH_DIR); } catch {}
  for (const id of slots) {
    if (!SID.test(id)) continue;
    const file = path.join(TRASH_DIR, id, id + ".jsonl");
    if (fs.existsSync(file)) out.push({ id, file, project: null, trashed: true });
  }
  return out;
}

/** 刷新索引：大小、开头都没变的会话直接用缓存；变了的只读新追加的部分 */
async function refresh() {
  loadCache();
  const files = listFiles(), alive = new Set();
  PROG.total = files.length; PROG.done = 0;
  for (const f of files) {
    alive.add(f.id); PROG.done++;
    let st; try { st = fs.statSync(f.file); } catch { continue; }
    META.set(f.id, { file: f.file, project: f.project, trashed: f.trashed, mtime: st.mtimeMs });
    const prev = RECS.get(f.id);
    // 只比大小会漏掉「原地改写成同样大小」：scanSession 里的开头哈希永远没机会核对。
    // 大小没变时再比 mtime，只有两者都没变才直接用缓存；mtime 变了仍交给 scanSession 核开头哈希。
    if (prev && prev.size === st.size && prev.off === st.size && prev.mtime === st.mtimeMs) continue;
    // 扫的途中（跨块等待）会话可能被改写、挪走并 forget 了：这时扫出来的是旧样子，不能写回去（#133）
    const fv = FORGOT.get(f.id) || 0;
    try {
      const rec = await scanSession(f.file, prev);
      rec.mtime = st.mtimeMs;
      if ((FORGOT.get(f.id) || 0) === fv) { RECS.set(f.id, rec); dirty = true; gen++; }
    }
    catch (e) { log(`脉络：读 ${f.id.slice(0, 8)} 失败：${e.message}`); }
  }
  for (const id of [...RECS.keys()]) if (!alive.has(id)) { RECS.delete(id); META.delete(id); dirty = true; gen++; }
  saveCache();
}

/** 会话记录被原地改写过（删消息、撤销删除）：扔掉它的索引，下次整份重扫。
 *  不扔的话，改写后又聊得比原来长，增量扫描会当成纯追加，章节的字节位置全错（审查 v0513b 低-27） */
const FORGOT = new Map();   // 会话号 → 扔过几次索引（在途的扫描据此作废）
export function lineageForget(sid) {
  loadCache();
  // 要立刻落盘：只清内存的话，进程在下次 refresh 前被杀，重启后又拿旧缓存按旧 off 增量续读，
  // 改写过的 cwd/消息就会永久留在索引里（移到项目后显示旧项目、轮数重复）。
  FORGOT.set(sid, (FORGOT.get(sid) || 0) + 1);
  if (RECS.delete(sid)) { dirty = true; gen++; saveCache(); }
}

/** 索引与亲缘边的代次戳：变了才需要重算整张图（剖面按它缓存各会话的子边） */
export function lineageStamp() { return gen + ":" + JSON.stringify(lineageDb().edges).length + ":" + Object.keys(NAMES).length + ":" + NAMES_REV; }

/** 并发请求共用一次刷新 */
export function lineageRefresh() {
  if (!building) building = refresh().finally(() => { building = null; });
  return building;
}

/** 会话记录文件（回收站里的不给：汇合、取材料只对活着的会话） */
export function lineageFile(sid) { const m = META.get(sid); return m && !m.trashed ? m.file : null; }

/** 不刷新、只读已有缓存的索引记录（会话页每翻一页都要用，首次整理大户要十几秒，不能等） */
export function lineageCached(sid) { loadCache(); return RECS.get(sid) || null; }

/** 一个会话的最新索引记录（建档用：要知道它压缩过几次、每章从哪儿开始）；没有这个会话返回 null */
export async function lineageRecord(sid) {
  await lineageRefresh();
  return RECS.get(sid) || null;
}

function parentsNow() {
  const db = lineageDb(), key = lineageStamp();
  if (memo?.key !== key) memo = { key, map: inferParents(RECS, { names: NAMES, explicit: db.edges }) };
  return memo.map;
}

/** 一个会话的来源（主父）：{ id, title, kind, at, ts, trashed, missing }；没有来源返回 null */
export async function lineageParent(sid) {
  await lineageRefresh();
  const e = parentsNow().get(sid);
  if (!e) return null;
  const me = RECS.get(sid), p = RECS.get(e.parent), i = me && e.at ? me.uu.indexOf(e.at) : -1;
  return {
    id: e.parent, kind: e.kind || null, at: e.at || null, ts: i >= 0 ? me.ts[i] : 0,
    title: NAMES[e.parent] || archivedTitle(e.parent) || p?.first || "",
    trashed: !!META.get(e.parent)?.trashed, missing: !p,
  };
}

const FORK_TAIL = / · (分叉|回退|分岔|Fork|Rewind|Branch)( \d+)?$/i;
/** 没建档、没改名的旧会话：拿最新一章的章首提问当标题（比第一句「你好，claude」有用） */
const lastQ = (r) => [...r.compacts].reverse().map((c) => c.q).find((q) => q && !weakPrompt(q)) || r.lead || r.first;
const tsAt = (rec, uuid) => { const i = rec && uuid ? rec.uu.indexOf(uuid) : -1; return i >= 0 ? rec.ts[i] : 0; };

/** 按会话号前缀找（档号引用用）：只看已有缓存、不刷新、不碰回收站，同步返回 —— 插话写进 stdin 的那一刻等不起整理索引 */
export function lineageByShort(short) {
  loadCache();
  const adb = archiveDb().sessions, out = [];
  for (const r of RECS.values()) {
    if (!r.id.startsWith(short) || META.get(r.id)?.trashed || !META.get(r.id)) continue;
    const cv = chapterView(r, adb[r.id] || null), name = NAMES[r.id] ? NAMES[r.id].replace(FORK_TAIL, "") : "";
    out.push({ id: r.id, rec: r, file: META.get(r.id).file, title: name || cv.sessionTitle || lastQ(r) || "", chapters: cv.chapters });
  }
  return out;
}

/**
 * 给前端：节点（会话，带每章题名）+ 边。只有元数据和标题，没有消息正文。
 * 旧会话兼容（规划书 §12）：章没建档时 title 为 null，q 是章首第一句提问，界面灰字顶上；
 * 改版前「读隔壁会话记录接手」的痕迹作 kind:"read" 的边（early：读者前 3 轮内读的，算接手）。
 */
export async function lineageGraph() {
  await lineageRefresh();
  const db = lineageDb(), adb = archiveDb().sessions;
  const parents = parentsNow();
  const { projectOfDir } = await import("./projects.mjs");
  const { schedSessions } = await import("./sched.mjs");
  const { realWorkspace } = await import("./sessionops.mjs");
  const sched = schedSessions(), ws = [CFG.workspace, realWorkspace()];
  const nodes = [];
  for (const r of RECS.values()) {
    const m = META.get(r.id) || {}, entry = adb[r.id] || null;
    const cv = chapterView(r, entry);
    const name = NAMES[r.id] ? NAMES[r.id].replace(FORK_TAIL, "") : "";
    const p = projectOfDir(r.cwd);
    const band = p ? { key: "p:" + p.id, name: p.name, color: p.color || null } : ws.includes(r.cwd) || !r.cwd ? { key: "ws" } : { key: "other" };
    nodes.push({
      id: r.id, title: name || cv.sessionTitle || lastQ(r) || "", titleBy: name ? "user" : cv.sessionTitle ? "archive" : null,
      pinned: PINS[r.id] || 0, band, cwd: r.cwd || "", trashed: !!m.trashed,
      sched: sched.get(r.id) || null, misc: miscOf(entry, r.size, r.compacts.length), running: !!runOfSession(r.id),
      firstTs: r.firstTs || r.birth || m.mtime || 0, lastTs: r.lastTs || m.mtime || 0, turns: r.turns, sizeKb: Math.round(r.size / 1024),
      chapters: cv.chapters.map((c) => ({ n: c.n, anchor: c.n === 1 ? "start" : c.anchor, from: c.from, to: c.to, title: c.title, by: c.by, same: c.same, status: c.status, q: (c.n === 1 ? r.lead || r.first : r.compacts[c.n - 2]?.q) || "" })),
    });
  }
  const edges = [], linked = new Set();
  for (const [child, e] of parents) {
    edges.push({ child, parent: e.parent, at: e.at, ts: tsAt(RECS.get(child), e.at), kind: e.kind, source: e.source, missing: !RECS.has(e.parent) });
    linked.add(child + ">" + e.parent);
  }
  for (const [child, e] of Object.entries(db.edges)) for (const x of e.extra || []) {
    if (!x || !x.id) continue;
    edges.push({ child, parent: x.id, at: x.at || null, ts: tsAt(RECS.get(x.id), x.at), kind: "merge", source: "explicit", how: x.how || "", missing: !RECS.has(x.id) });
    linked.add(child + ">" + x.id);
  }
  // 汇合记录丢了（导到别的设备、手动删过 ccapp-lineage.json）：按第一条消息末尾的落款重建
  const byShort = new Map();
  for (const id of RECS.keys()) { const k = id.slice(0, 4); byShort.set(k, byShort.has(k) ? null : id); }
  for (const r of RECS.values()) {
    if (!r.sig || (db.edges[r.id] && (db.edges[r.id].extra || []).length)) continue;
    for (const x of r.sig) {
      const pid = byShort.get(x.short);
      if (!pid || pid === r.id || linked.has(r.id + ">" + pid) || (db.edges[r.id]?.nosig || []).includes(pid)) continue;
      const at = RECS.get(pid).compacts[x.n - 1]?.uuid || null;   // 第 n 章的摘要 = 第 n 次压缩；进行中的章没有，画到来源末端
      edges.push({ child: r.id, parent: pid, at, ts: tsAt(RECS.get(pid), at), kind: "merge", source: "sig", how: "", missing: false });
      linked.add(r.id + ">" + pid);
    }
  }
  for (const r of RECS.values()) for (const x of r.refs || []) {
    if (!RECS.has(x.id) || linked.has(r.id + ">" + x.id) || linked.has(x.id + ">" + r.id)) continue;
    // 读的那一刻，来源已经聊到哪儿：取来源在 x.ts 之前最后一条消息
    edges.push({ child: r.id, parent: x.id, at: x.at, ts: x.ts, kind: "read", source: "inferred", early: x.turn < 3, n: x.n });
  }
  // 一问一答（规划书 §12）：≤2 轮、没压缩过、没亲缘、不在跑 —— 连通测试、「你好」就走的那种。只在图上和杂项一起默认收起，不写杂项标记
  const touched = new Set(edges.flatMap((e) => [e.child, e.parent]));
  for (const n of nodes) n.brief = n.turns <= 2 && n.chapters.length === 1 && !touched.has(n.id) && !n.running && !n.sched && !n.pinned;
  return { nodes, edges };
}

export async function routeLineage(req, res, u, p) {
  if (p !== "/api/lineage") return NEXT;
  if (req.method !== "GET") return sendJson(res, 405, { error: "method" });
  // 首次整理没完成就先回进度，页面轮询（大户从头扫要十几秒，不能让请求干等）
  const job = lineageGraph();
  const quick = await Promise.race([job, new Promise((r) => setTimeout(() => r(null), 1500))]).catch((e) => ({ error: e.message }));
  if (quick === null) { job.catch(() => {}); return sendJson(res, 200, { building: true, done: PROG.done, total: PROG.total }); }
  if (quick.error) return sendJson(res, 500, quick);
  try { return sendJson(res, 200, quick); }
  catch (e) { return sendJson(res, 500, { error: e.message }); }
}
