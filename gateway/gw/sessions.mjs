import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline";
import { CFG, LAST_LANG, PATHS, log, tr, tz } from "./config.mjs";
import { SID_RE, TRASH_KEEP_DAYS, inTrash, exportSessions, deleteMessage, forkSession, importSessions, listTrash, locateUserTurn, purgeTrash, realWorkspace, restoreSession, rewindFiles, rewindFixup, trashSession, undoDelete } from "./sessionops.mjs";
import { goalStateOf, tasksOf } from "./goal.mjs";
import { backfillAgents, readAgentIndex, settleAgentRecs } from "./agents.mjs";
import { bodyToFile, forEachLine } from "./bigfile.mjs";
import { agentFilesOf, findLineOffset, latestContextTokens, lineHas, readSessionForward, readSessionPage, transcriptItems } from "./transcript.mjs";
import { lineageCached, lineageForSession } from "./lineage.mjs";
import { chapterView } from "./archive-core.mjs";
import { incompleteItem } from "./incomplete.mjs";
import { runOfSession } from "./runs.mjs";
import { archiveBrief, archiveDb, archivedTitle } from "./archive-store.mjs";
import { NEXT, readBody, sendJson } from "./http.mjs";
import { isInjected } from "./integrity.mjs";
import { isObj, loadState, saveState } from "./statefile.mjs";

// ── 会话重命名表 ──────────────────────────────────────────────────────
// 文件坏了（解析不了、或是 null / 数组之类）：留底成 .bad-* 再当没有，别让整个会话列表跟着抛错（#98 03-012）
const namesShape = (j) => {
  if (!isObj(j)) return undefined;
  const out = {};
  for (const [id, v] of Object.entries(j)) if (typeof v === "string" && v) out[id] = v;
  return out;
};
export let NAMES = loadState(PATHS.names, { shape: namesShape, fallback: () => ({}) }).data;
// 会话标题只在这里定：用户改过的 > 建档的最新一章题名 > 第一句提问。列表、详情、搜索都走它，免得顶栏和侧栏各说各的（#44）
const sessionTitle = (id, meta) => NAMES[id] || archivedTitle(id) || meta.title;

// 改名表的版本：每次落盘加一。脉络/剖面的缓存戳带上它，改名（键数不变）也会重建（DeepSeek 复核 #6）
export let NAMES_REV = 0;
/** 写 JSON 表：走 statefile 的临时文件 + fsync + rename；返回是否写成，调用方要据此回 500（197-2.6） */
function writeJsonTable(file, obj) {
  return saveState(file, obj);
}
export function saveNames() {
  NAMES_REV++;
  const ok = writeJsonTable(PATHS.names, NAMES);
  if (!ok) log("会话标题没保存上（存储满了或没有权限）");
  return ok;
}
// 置顶表：会话号 → 置顶时刻
const PINS_FILE = path.join(CFG.home, "ccapp-session-pins.json");
const pinsShape = (j) => {
  if (!isObj(j)) return undefined;
  const out = {};
  for (const [id, v] of Object.entries(j)) if (Number.isFinite(+v)) out[id] = +v;
  return out;
};
// PINS 以前坏了不留下底，下一次保存就把用户置顶全盖掉（197-9.8）
export let PINS = loadState(PINS_FILE, { shape: pinsShape, fallback: () => ({}) }).data;
export function savePins() {
  const ok = writeJsonTable(PINS_FILE, PINS);
  if (!ok) log("会话置顶没保存上（存储满了或没有权限）");
  return ok;
}

// ── 会话（claude 的 transcript 文件）─────────────────────────────────
/** 项目目录名 → 真实 cwd（从 jsonl 里读，目录名本身不可逆） */
export const PEEK_CACHE = new Map();   // 标题/cwd 取自文件开头，写进去就不变了，没必要每次列表都重读
// Claude Code 自己的 /resume 只滤 sessionKind=daemon / daemon-worker（后台守护进程开的会话，不是用户
// 开的那条对话）；bg 是用户自己甩到后台的会话，在 /resume 里带「bg」标记照常显示，这里不能一起藏掉。
// 同样不按 isSidechain / 标题猜：用户从工具调用里接出来的会话、被复用成任务的会话都不能因此消失。
const HIDDEN_KINDS = new Set(["daemon", "daemon-worker"]);
const KIND_CACHE = new Map();   // 文件 → { size, mtimeMs, ino, kind }：分类要扫每个文件的开头，缓存住
function sessionKindOf(file, st) {
  const hit = KIND_CACHE.get(file);
  if (hit && st && hit.size === st.size && hit.mtimeMs === st.mtimeMs && (hit.ino == null || st.ino == null || hit.ino === st.ino)) return hit.kind;
  let kind = "", fd = null;
  try {
    fd = fs.openSync(file, "r");
    // 和 Claude Code 读 /resume 元数据一样：只看文件开头 64 KB 里第一条带 parentUuid 的记录。sessionKind
    // 就在这条记录上；不整份读，免得几千个会话时列表被磁盘拖住。找不到就当普通会话（宁可多显示，不误藏）。
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const head = buf.toString("utf8", 0, n);
    for (const line of head.split("\n")) {
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch {
        // 这一行被 64 KB 截断 / 不是完整 JSON：只有它看起来就是主记录时才停，其余（如超长正文）继续往下找。
        // 解析不了就当普通会话显示——宁可多显示，也不能把用户自己的对话藏掉。
        if (line.includes('"parentUuid":')) break;
        continue;
      }
      if (!ev || !Object.prototype.hasOwnProperty.call(ev, "parentUuid")) continue;
      if (typeof ev.sessionKind === "string") kind = ev.sessionKind;
      break;
    }
  } catch {} finally {
    if (fd != null) try { fs.closeSync(fd); } catch {}
  }
  const rec = { size: st?.size, mtimeMs: st?.mtimeMs, ino: st?.ino, kind };
  KIND_CACHE.set(file, rec);
  if (KIND_CACHE.size > 5000) KIND_CACHE.delete(KIND_CACHE.keys().next().value);
  return kind;
}
/** st：调用方已经 stat 过就传进来。缓存带上 size/mtime/inode：同尺寸原地改写、删消息重写也能察觉（200-15-08） */
export function peekSession(file, st = null) {
  let cur = st;
  if (!cur) { try { cur = fs.statSync(file); } catch { cur = null; } }
  const hit = PEEK_CACHE.get(file);
  if (hit && cur && hit.size === cur.size && hit.mtimeMs === cur.mtimeMs && (hit.ino == null || cur.ino == null || hit.ino === cur.ino)) return hit;
  const rec = peekSessionRaw(file);
  if (cur) { rec.size = cur.size; rec.mtimeMs = cur.mtimeMs; rec.ino = cur.ino; }
  PEEK_CACHE.set(file, rec);
  if (PEEK_CACHE.size > 5000) PEEK_CACHE.delete(PEEK_CACHE.keys().next().value);   // 只增不减（200-6-05）
  return rec;
}
function peekSessionRaw(file) {
  let title = "", cwd = "", firstMsg = "", created = 0;
  let fd = null;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(196608);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.toString("utf8", 0, n).split("\n")) {
      if (!line.trim()) continue;
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      if (ev.cwd && !cwd) cwd = ev.cwd;
      if (!created && ev.timestamp) created = Date.parse(ev.timestamp) || 0;
      if (ev.type === "attachment") continue;

      let text = "";
      const c = ev.message?.content;
      if (typeof c === "string") text = c;
      else if (Array.isArray(c)) {
        const t = c.find((x) => x && x.type === "text");
        if (t) text = t.text;
      }
      if (!text && typeof ev.content === "string" && ev.type === "queue-operation") text = ev.content;

      if (text && ev.type === "user" && !isInjected(text)) { firstMsg = text; break; }
      if (text && !firstMsg && !isInjected(text)) firstMsg = text;
    }
  } catch {} finally {
    // read 抛错（比如路径是目录 → EISDIR）时也要关 fd；以前关闭在 try 里，列表每刷一次漏一个
    if (fd != null) try { fs.closeSync(fd); } catch {}
  }
  title = firstMsg.replace(/\s+/g, " ").trim().slice(0, 90);
  return { title: title || "(无标题)", cwd, created };
}

export function listSessions(limit = 150) {
  const found = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(PATHS.projects, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch (e) {
    // 目录还不存在是正常的（刚装、还没跑过会话）；读不了（权限、IO 错误）不能当成空表（FIND-015）
    if (e.code === "ENOENT") return [];
    const out = [];
    out.error = e.code || e.message || "read_failed";
    out.total = 0;
    return out;
  }

  for (const d of dirs) {
    const dir = path.join(PATHS.projects, d.name);
    let files = [];
    // 只认普通文件：以 .jsonl 结尾的目录以前会被当成会话，peek 每次读它都漏一个 fd，最终 EMFILE
    try { files = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile() && d.name.endsWith(".jsonl")).map((d) => d.name); } catch { continue; }
    for (const f of files) {
      const full = path.join(dir, f);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      found.push({
        id: f.replace(/\.jsonl$/, ""),
        file: full,
        project: d.name,
        mtime: st.mtimeMs,
        size: st.size,
        ino: st.ino,
      });
    }
  }

  // 先滤守护进程会话，再排序、截断：反过来的话，最近的守护会话会占掉 limit 名额，把用户自己的对话挤出去
  for (const s of found) s.hidden = HIDDEN_KINDS.has(sessionKindOf(s.file, { size: s.size, mtimeMs: s.mtime, ino: s.ino }));
  const visible = found.filter((s) => !s.hidden);
  visible.sort((a, b) => b.mtime - a.mtime);
  const shown = visible.filter((s, i) => i < limit || PINS[s.id]);
  const out = shown.map((s) => {
    const meta = peekSession(s.file, { size: s.size, mtimeMs: s.mtime, ino: s.ino }), ab = archiveBrief(s.id, s.size, lineageCached(s.id)?.compacts?.length || 0);
    return {
      id: s.id,
      no: ab.no, misc: ab.misc,
      created: meta.created || 0,
      pinned: PINS[s.id] || 0,
      title: sessionTitle(s.id, meta),
      archived: !NAMES[s.id] && !!archivedTitle(s.id),
      renamed: !!NAMES[s.id],
      cwd: meta.cwd,
      mtime: s.mtime,
      sizeKb: Math.round(s.size / 1024),
      currentProject: meta.cwd === CFG.workspace || meta.cwd === realWorkspace(),
    };
  });
  out.total = visible.length;
  return out;
}

// ── 会话内容搜索 ──
// 每个 jsonl 只抽人和助手的正文（跳过工具结果、<…> 包起来的系统注入），按读到的字节偏移增量追加。
// 索引放内存：首次搜索要扫一遍全部会话，之后只读新追加的部分。
const SEARCH_IDX = new Map();   // file → { off, text, lower, skip }
// 常驻上限（按字符，text + lower 两份 UTF-16 约 4 字节/字）：最近的会话常驻，超出的旧会话搜时现读、用完就扔，
// 搜得全但内存有顶（审查 中5）。单个会话另设上限：超了不建索引、查询时流式扫，避免一个 32 MB 的中文会话把 RSS 顶到几百 MB（195-Q.3）
const SEARCH_KEEP_CHARS = 16e6;
const SEARCH_FILE_KEEP = 4e6;
const SEARCH_STREAM_SIZE = Number(process.env.CCAPP_SEARCH_STREAM_SIZE) || (12 << 20);
const normText = (s) => String(s).normalize("NFKC").toLowerCase();
function searchText(line) {
  if (line.length > 4e6 || !(line.includes('"user"') || line.includes('"assistant"'))) return "";
  let ev; try { ev = JSON.parse(line); } catch { return ""; }
  // 侧链（子代理）和压缩摘要是另一条线的内容，界面不显示，不放进人看的搜索（200-15-04）
  if ((ev.type !== "user" && ev.type !== "assistant") || ev.isMeta || ev.isSidechain || ev.isCompactSummary) return "";
  const c = ev.message?.content, out = [];
  if (typeof c === "string") out.push(c);
  else if (Array.isArray(c)) for (const b of c) if (b && b.type === "text" && typeof b.text === "string") out.push(b.text);
  return out.filter((t) => t && !isInjected(t)).join(" ").replace(/\s+/g, " ").trim();
}
/** 大文件不建索引，按查询流式扫（内存有顶，搜得全；每查一次读一遍） */
async function streamSearch(file, needle) {
  let count = 0, snippet = "";
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const t = searchText(line);
      if (!t) continue;
      const low = normText(t), src = t.length === low.length ? t : low;
      let i = low.indexOf(needle);
      while (i >= 0 && count < 99) {
        count++;
        if (!snippet) { const a = Math.max(0, i - 30), b = Math.min(src.length, i + needle.length + 60); snippet = (a > 0 ? "…" : "") + src.slice(a, b).replace(/\n/g, " ") + (b < src.length ? "…" : ""); }
        i = low.indexOf(needle, i + needle.length);
      }
      if (count >= 99) break;
    }
  } finally { rl.close(); }
  return { count, snippet };
}
// 增量的前提是文件只往后追加。删消息（整份重写）、撤销（抄回备份）、导入覆盖都不是：长度可能还变长了，
// 照旧偏移接着读会留着已删的命中、漏掉恢复的正文（审查 B14）。所以记下 inode 和偏移前 64 字节，对不上就从头建
const SEARCH_TAIL = 64;
async function indexTail(fh, off) {
  if (!off) return "";
  const n = Math.min(SEARCH_TAIL, off), buf = Buffer.alloc(n);
  const { bytesRead } = await fh.read(buf, 0, n, off - n);
  return buf.subarray(0, bytesRead).toString("base64");
}
async function indexSessionFile(file, size) {
  let e = SEARCH_IDX.get(file);
  if (!e || size < e.off) e = { off: 0, text: "", lower: "", skip: false };
  // 文件本身就很大：不建索引，查询时流式扫（Q.3）
  if (size > SEARCH_STREAM_SIZE) { e = { off: size, text: "", lower: "", skip: true }; SEARCH_IDX.set(file, e); return e; }
  if (e.skip) return e;
  if (e.off) {
    const fh = await fs.promises.open(file, "r");
    try {
      const st = await fh.stat();
      if (st.ino !== e.ino || (await indexTail(fh, e.off)) !== e.tail) e = { off: 0, text: "", lower: "", skip: false };
    } finally { await fh.close(); }
  }
  if (size > e.off) {
    const fh = await fs.promises.open(file, "r");
    try {
      e.ino = (await fh.stat()).ino;
      let pos = e.off, rest = Buffer.alloc(0);
      const parts = [];
      while (pos < size) {
        const buf = Buffer.alloc(Math.min(4 << 20, size - pos));
        const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
        if (!bytesRead) break;
        pos += bytesRead;
        const chunk = rest.length ? Buffer.concat([rest, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
        const nl = chunk.lastIndexOf(10);
        if (nl < 0) { rest = Buffer.from(chunk); continue; }
        rest = Buffer.from(chunk.subarray(nl + 1));
        for (const line of chunk.toString("utf8", 0, nl).split("\n")) { const t = searchText(line); if (t) parts.push(t); }
        await new Promise((r) => setImmediate(r));   // 别一口气把事件循环占住
      }
      // 末行不带换行（导入的、被打断的记录）：能解析成完整 JSON 就收进来，不然最后一条正文永远搜不到（200-15-03）
      if (rest.length) {
        const tail = rest.toString("utf8");
        try { JSON.parse(tail.trim()); const t = searchText(tail); if (t) parts.push(t); pos = size; rest = Buffer.alloc(0); } catch {}
      }
      e.off = pos - rest.length;   // 半行留到下次
      e.tail = await indexTail(fh, e.off);
      if (parts.length) {
        const add = (e.text ? "\n" : "") + parts.join("\n");
        e.text += add;
        e.lower += normText(add);   // NFKC + 小写：前后端归一化口径一致（200-15-06）
        if (e.text.length > SEARCH_FILE_KEEP) { e = { off: size, text: "", lower: "", skip: true }; SEARCH_IDX.set(file, e); return e; }
      }
    } finally { await fh.close(); }
  }
  SEARCH_IDX.set(file, e);
  return e;
}
let searchChain = Promise.resolve();
let importBusy = false;
export function searchSessions(q) {
  const run = searchChain.then(() => searchSessionsNow(q));
  searchChain = run.catch(() => {});
  return run;
}
async function searchSessionsNow(q) {
  // 按码点截 200：以前按 UTF-16 码元切，可能切在代理对中间，长查询还会假命中（200-15-12）
  const needle = normText([...String(q || "").replace(/\s+/g, " ").trim()].slice(0, 200).join(""));
  if (!needle) return { q, results: [] };
  const t0 = Date.now();
  const files = [];
  let dirs = [];
  try { dirs = fs.readdirSync(PATHS.projects, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch {}
  for (const d of dirs) {
    const dir = path.join(PATHS.projects, d.name);
    let names = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile() && d.name.endsWith(".jsonl")).map((d) => d.name); } catch { continue; }
    for (const f of names) {
      const full = path.join(dir, f);
      try { const st = fs.statSync(full); files.push({ id: f.slice(0, -6), file: full, mtime: st.mtimeMs, size: st.size, ino: st.ino }); } catch {}
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const seen = new Set(files.map((f) => f.file));
  for (const k of SEARCH_IDX.keys()) if (!seen.has(k)) SEARCH_IDX.delete(k);

  const results = [];
  let kept = 0;
  for (const f of files) {
    const meta = peekSession(f.file, { size: f.size, mtimeMs: f.mtime, ino: f.ino });
    const title = sessionTitle(f.id, meta);
    let e;
    try { e = await indexSessionFile(f.file, f.size); } catch { continue; }
    kept += e.text.length;
    if (kept > SEARCH_KEEP_CHARS) SEARCH_IDX.delete(f.file);
    let i = -1, count = 0, snippet = "";
    if (e.skip) {
      // 大文件没建索引：流式扫一遍（内存有顶，搜得全）
      const s = await streamSearch(f.file, needle);
      count = s.count; snippet = s.snippet;
      i = count ? 0 : -1;
    } else {
      i = e.lower.indexOf(needle);
      if (i >= 0) {
        // 归一化可能改变长度（NFKC / 个别字符小写后变长）：对不上时用归一化文本出摘录，别切错原文
        const src = e.text.length === e.lower.length ? e.text : e.lower;
        const a = Math.max(0, i - 30), b = Math.min(src.length, i + needle.length + 60);
        snippet = (a > 0 ? "…" : "") + src.slice(a, b).replace(/\n/g, " ") + (b < src.length ? "…" : "");
        for (let j = i; j >= 0 && count < 99; j = e.lower.indexOf(needle, j + needle.length)) count++;
      }
    }
    const inTitle = normText(title).includes(needle);
    if (!inTitle && i < 0) continue;
    results.push({
      id: f.id, title, renamed: !!NAMES[f.id], cwd: meta.cwd, mtime: f.mtime, created: meta.created || 0,
      pinned: PINS[f.id] || 0, sizeKb: Math.round(f.size / 1024), snippet, count, inTitle,
    });
  }
  const ms = Date.now() - t0;
  if (ms > 1500) log(`会话搜索 ${files.length} 个文件用了 ${ms}ms`);
  return { q, results: results.slice(0, 100), total: results.length, ms };
}

// claude 按工作目录（真实路径）把会话存进 projects/<编码>/：非字母数字换成 -，过长截断加哈希（和 seal.mjs 的记忆目录同一算法）
const projEnc = (p) => { const s = p.replace(/[^a-zA-Z0-9]/g, "-"); return s.length <= 200 ? s : s.slice(0, 200) + "-" + crypto.createHash("sha256").update(p).digest("hex").slice(0, 8); };
/** 找会话记录。给了 cwd（这一轮实际在哪跑）就先找 claude 按这个目录会去读的那份：同一个会话号出现在
 *  两个项目目录里（手工拷会话）时，封签核对的和 --resume 读的才是同一份（0.6.9 审计 200-S-07，F8）。没给或那里没有，照旧按目录顺序取第一份 */
export function findSessionFile(id, cwd) {
  if (!SID_RE.test(id)) return null;   // 防目录穿越
  if (cwd && typeof cwd === "string") {
    let real = cwd; try { real = fs.realpathSync(cwd); } catch {}
    for (const name of new Set([projEnc(real), projEnc(path.resolve(cwd))])) {
      const full = path.join(PATHS.projects, name, id + ".jsonl");
      if (fs.existsSync(full)) return { file: full, project: name };
    }
  }
  let dirs = [];
  try {
    dirs = fs.readdirSync(PATHS.projects, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch { return null; }
  for (const d of dirs) {
    const full = path.join(PATHS.projects, d.name, id + ".jsonl");
    if (fs.existsSync(full)) return { file: full, project: d.name };
  }
  return null;
}

// ── 路由：/api/sessions/search /api/sessions /api/sessions/trash /api/trash /api/trash/restore /api/trash/purge /api/sessions/export /api/sessions/import /api/session/ ──
/** 只剩后台任务的 idle 轮：先结束它、等它收尾，再删 / 回退 / 删消息（195-A.3）。
 *  真正在生成的返回 false（调用方回 409）。复用 queue.abortRun（和「排队消息要槽位时结束空闲轮」同一口径）；
 *  动态 import 避免 sessions ↔ queue 顶层成环。进程被杀后 close 才来（abortRun 有 5+2 秒兜底），等它从 RUNS 消失再动文件 */
async function idleRetired(id) {
  const live = runOfSession(id);
  if (!live) return true;
  if (!live.idle) return false;
  try {
    const { abortRun } = await import("./queue.mjs");
    if (!abortRun(live, { hold: false })) return true;
  } catch (e) { log("结束空闲轮失败：" + e.message); return false; }
  const until = Date.now() + 8000;
  while (runOfSession(id) && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  return !runOfSession(id);
}

export async function routeSessions(req, res, u, p) {
  // ── 会话 ──
  if (req.method === "GET" && p === "/api/sessions/search") {
    return sendJson(res, 200, await searchSessions(String(u.searchParams.get("q") || "")));
  }
  if (req.method === "GET" && p === "/api/sessions") {
    // limit：界面点「再显示」逐次加 150；首次列表每个文件要读开头取标题，所以默认只给最近 150 个
    const list = listSessions(Math.min(5000, Math.max(150, parseInt(u.searchParams.get("limit"), 10) || 150)));
    // 会话目录读不了：以前回 200 空表，和「真的没有会话」分不出来（FIND-015）。界面会显示这条错误并给重试
    if (list.error) return sendJson(res, 500, { ok: false, error: "read_failed", message: tz("会话列表读不出来（{msg}），不是没有会话；检查存储权限后再刷新。", { msg: list.error }) });
    // total：用户能看到的会话一共多少个（不含后台守护会话）。列表只给最近 limit 个（加置顶），界面据此说「最近 N 个，共 M 个」（#178-3）
    return sendJson(res, 200, { sessions: list, workspace: CFG.workspace, count: list.length, total: list.total ?? list.length });
  }
  // ── 会话管理：批量进回收站 / 回收站 / 导出 / 导入 ──
  if (req.method === "POST" && p === "/api/sessions/trash") {
    const b = JSON.parse((await readBody(req)) || "{}");
    // busy：正在生成没删；failed：已经不在了（别处删了、已在回收站）或删的时候出错——界面分开说（#176-2）
    const done = [], failed = [], busy = [];
    for (const id of [].concat(b.ids || [])) {
      if (runOfSession(id)) { busy.push(id); failed.push(id); continue; }
      try { (trashSession(String(id)).ok ? done : failed).push(id); } catch { failed.push(id); }
    }
    if (done.length) log(`${done.length} 个会话进回收站`);
    return sendJson(res, 200, { ok: true, done, failed, busy });
  }
  if (req.method === "GET" && p === "/api/trash") {
    return sendJson(res, 200, { items: listTrash(), keepDays: TRASH_KEEP_DAYS });
  }
  if (req.method === "POST" && p === "/api/trash/restore") {
    const b = JSON.parse((await readBody(req)) || "{}");
    const done = [], failed = [];
    for (const id of [].concat(b.ids || [])) {
      let r; try { r = restoreSession(String(id)); } catch (e) { r = { ok: false, error: e.message }; }
      (r.ok ? done : failed).push(r.ok ? id : { id, error: r.error });
    }
    return sendJson(res, 200, { ok: true, done, failed });
  }
  if (req.method === "POST" && p === "/api/trash/purge") {
    const b = JSON.parse((await readBody(req)) || "{}");
    const ids = b.all ? listTrash().map((m) => m.id) : [].concat(b.ids || []).map(String);
    const n = await purgeTrash(ids);
    log(`回收站：彻底删除 ${n} 个会话`);
    return sendJson(res, 200, { ok: true, purged: n });
  }
  if (req.method === "POST" && p === "/api/sessions/export") {
    const b = JSON.parse((await readBody(req)) || "{}");
    const ids = b.all ? listSessions(100000).map((x) => x.id) : [].concat(b.ids || []).map(String);
    try {
      const r = await exportSessions(ids);
      log(`导出 ${r.count} 个会话 → ${r.file}`);
      return sendJson(res, 200, { ok: true, ...r, shared: !!process.env.CCAPP_SHARED && r.file.startsWith(process.env.CCAPP_SHARED) });
    } catch (e) { return sendJson(res, 400, { ok: false, message: e.message }); }
  }
  if (req.method === "POST" && p === "/api/sessions/import") {
    // 请求体直接落盘、逐条解压写盘（gw/bigfile.mjs），内存不跟包大小走：1 GB 以上的会话也导得进。
    // 一次只导一个（审查 10-30 第九份 中3）；包上限是 zip32 的 4 GB，解出来的总量受剩余空间限制
    if (importBusy) { req.resume(); return sendJson(res, 409, { ok: false, message: tz("上一个导入还没完，等它结束再导") }); }
    // 先按请求声明的大小看空间：包和解出来的都要落盘，不够就别开始写（审查 v0513b 低-5）
    const want = Number(req.headers["content-length"]) || 0;
    let free = Infinity; try { const st = fs.statfsSync(CFG.home); free = st.bavail * st.bsize; } catch {}
    if (want && free < want * 2 + (512 << 20)) { req.resume(); return sendJson(res, 507, { ok: false, message: tz("存储空间不够了") }); }
    importBusy = true;
    const tmp = path.join(CFG.home, `.import-${Date.now()}.zip`);
    try {
      // 没写 Content-Length（分块上传）的上面查不了：按剩余空间给个顶，别把存储写满（11-03 审查 I-8）
      await bodyToFile(req, tmp, Math.min(0xffffffff, Number.isFinite(free) ? Math.max(0, Math.floor((free - (512 << 20)) / 2)) : 0xffffffff));
      const r = await importSessions(tmp);
      log(`导入会话：${r.imported.length} 个，跳过 ${r.skipped.length} 个`);
      return sendJson(res, 200, { ok: true, ...r });
    } catch (e) { if (e.imported?.length) log(`导入会话：放好 ${e.imported.length} 个后出错`); return sendJson(res, 400, { ok: false, message: e.message, imported: e.imported || [] }); }
    finally { importBusy = false; fs.rmSync(tmp, { force: true }); }
  }
  if (p.startsWith("/api/session/")) {
    let rest;
    try { rest = decodeURIComponent(p.slice("/api/session/".length)); } catch { return sendJson(res, 400, { error: "bad path" }); }
    const [id, action] = rest.split("/");
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id || "")) return sendJson(res, 400, { error: "bad session id" });
    const found = findSessionFile(id);

    if (req.method === "GET" && !action) {
      // trashed：在回收站里（可恢复）。界面据此给「恢复」，而不是一律当成没了（#173）
      if (!found) return sendJson(res, 404, { error: "not found", trashed: inTrash(id) });
      const meta = peekSession(found.file);
      const live = runOfSession(id);
      const limit = Math.min(200, Math.max(10, Number(u.searchParams.get("limit")) || 40));
      // 正在生成的那一轮走事件总线，这里不重复给
      const excludeFrom = Number(u.searchParams.get("exclude")) || (live ? live.startedAt : 0);
      // 冷启动后缓存可能还没跟上：只为这个会话补扫新增的部分，压缩分隔才带得上章节标签（FIND-019）
      const rec = await lineageForSession(id, found.file);
      // 脉络里点站 / 章标题：anchor=压缩消息 uuid（或 start）→ 字节偏移，从那里往后读；after=往下续读
      let fwd = null;
      if (u.searchParams.has("anchor")) {
        const a = String(u.searchParams.get("anchor"));
        if (a === "start") fwd = 0;
        else {
          // 偏移：章节用脉络索引里的；书签自己带着（off）。都先核对那一行确实是它，对不上再整文件找
          const c = rec?.compacts.find((x) => x.uuid === a), hint = c ? c.off : Number(u.searchParams.get("off"));
          // 「上次读到」带的是那一页的起点，不是行首：核对不上就从那里往后找，再不行才从头
          const ok = Number.isFinite(hint) && hint >= 0;
          fwd = ok && await lineHas(found.file, hint, a) ? hint : ok && hint > 0 ? await findLineOffset(found.file, a, hint) : -1;
          if (fwd < 0) fwd = await findLineOffset(found.file, a);
          if (fwd < 0) return sendJson(res, 404, { error: "anchor not found" });
        }
      } else if (u.searchParams.has("after")) fwd = Math.max(0, Number(u.searchParams.get("after")) || 0);
      const page = fwd !== null
        ? await readSessionForward(found.file, { after: fwd, limit, excludeFrom })
        : await readSessionPage(found.file, { before: u.searchParams.has("before") ? Number(u.searchParams.get("before")) : null, limit, excludeFrom });
      // 压缩处标上第几章、题名、档号，前端画成章节分隔
      if (rec && page.items.some((it) => it.compact)) {
        const chs = chapterView(rec, archiveDb().sessions[id] || null);
        for (const it of page.items) {
          if (!it.compact || !it.uuid) continue;
          const k = rec.compacts.findIndex((x) => x.uuid === it.uuid);
          const ch = k >= 0 ? chs.chapters[k + 1] : null;
          if (ch) Object.assign(it, { chapter: ch.n, chTitle: ch.title || rec.compacts[k].q || "", chGhost: !ch.title, chNo: ch.no });
        }
      }
      // 有子代理记录的 Agent 卡打个标，前端据此给「查看过程」
      const subs = agentFilesOf(found.file);
      if (subs.size) for (const it of page.items) if (it.role === "tool_use" && subs.has(it.id)) it.sub = true;
      // 上一轮没跑完的持久提示（FIND-040）：中断卡被忽略 / 清掉后，半截回复也要能认出来。
      // 只在这一页读到了记录末尾时挂在最后一条之后；这个会话正在生成就先不挂
      const atEnd = fwd !== null ? page.next === page.size : !u.searchParams.has("before");
      const inc = incompleteItem(id, { atEnd, live: !!live });
      if (inc) page.items.push(inc);
      const wantMeta = !u.searchParams.has("before") && (!u.searchParams.has("after") || u.searchParams.get("meta") === "1");
      return sendJson(res, 200, {
        id,
        title: sessionTitle(id, meta),
        cwd: meta.cwd,
        items: page.items,
        cursor: fwd !== null ? page.from : page.cursor,
        next: fwd !== null ? page.next : undefined,
        size: page.size,
        // 正向读的那一页本身不带用量：首屏（书签 / 上次读到 / 章节）另从尾部取最新的，翻页不取（#89）
        contextTokens: fwd === null ? page.contextTokens : u.searchParams.has("after") ? undefined : await latestContextTokens(found.file),
        liveRunId: live ? live.id : null,
        // 翻页不带；重连续读的首屏（after + meta=1）要带，界面刚把它们清掉（#178-1）
        goal: wantMeta ? goalStateOf(found.file) : undefined,
        tasks: wantMeta ? tasksOf(id) : undefined,
      });
    }

    // 子代理联络簿：有落盘的读落盘（网关跑的时候记的），没有就从 claude 的记录里现推（旧会话，不写文件）
    if (req.method === "GET" && action === "agents") {
      if (!found) return sendJson(res, 404, { error: "not found" });
      const meta = peekSession(found.file);
      let recs = meta.cwd ? readAgentIndex(meta.cwd, id) : [], src = "book";
      if (!recs.length) { recs = backfillAgents(found.file); src = "transcript"; }
      const live = runOfSession(id)?.agents?.agents;
      recs = settleAgentRecs(recs, new Set(live ? [...live.values()].filter((a) => a.status === "running").map((a) => a.id) : []));
      return sendJson(res, 200, { records: recs, src });
    }

    // 子代理的过程（按需取：点开 Agent 卡的「过程」才读）
    if (req.method === "GET" && action === "agent") {
      if (!found) return sendJson(res, 404, { error: "not found" });
      const f = agentFilesOf(found.file).get(String(u.searchParams.get("tool") || ""));
      if (!f) return sendJson(res, 200, { items: [] });
      // 从尾部异步倒读最近约 400 项：以前给的是开头 400 项，长代理最后几步和汇报反而看不到；
      // 也别为拿尾巴同步从头扫到尾卡住网关（#71）。和翻历史共用 readSessionPage
      const pick = (ev) => ev.type === "user" && typeof ev.message?.content === "string" ? []   // 第一条是主代理给它的提示，Agent 卡参数里已有
        : transcriptItems({ ...ev, isSidechain: false }).filter((it) => it.role !== "thinking" && it.role !== "user" && it.role !== "hookctx");
      let items = [], more = false;
      try { const p = await readSessionPage(f, { limit: 100, pick }); items = p.items; more = p.cursor > 0; } catch {}
      // 截掉的头上别留着「调用被截掉、只剩结果」的孤儿
      if (more) while (items.length && items[0].role === "tool_result") items.shift();
      return sendJson(res, 200, { items, more });
    }

    if (req.method === "DELETE" && !action) {
      if (!found) return sendJson(res, 404, { error: "not found" });
      if (!(await idleRetired(id))) return sendJson(res, 409, { error: "busy", message: tz("这个会话正在生成中。") });
      // 删除先进回收站（30 天内可恢复），彻底删除走 /api/trash/purge
      let r;
      try { r = trashSession(id); } catch (e) { return sendJson(res, 500, { error: e.message }); }
      if (r.ok) log(`会话进回收站 ${id.slice(0, 8)}`);
      // 写不进 meta 是服务端/存储问题，别报成 404（195-N.1）
      return sendJson(res, r.ok ? 200 : r.error === "write_failed" ? 500 : 404, r);
    }

    if (req.method === "POST" && action === "rename") {
      const b = JSON.parse((await readBody(req)) || "{}");
      const name = String(b.title || "").trim().slice(0, 120);
      if (!name) return sendJson(res, 400, { error: "empty" });
      if (!found) return sendJson(res, 404, { error: "not found" });      // 不存在的会话不往名字表里记（审查 v0513b 低-6）
      const before = NAMES[id]; NAMES[id] = name;
      if (!saveNames()) { if (before === undefined) delete NAMES[id]; else NAMES[id] = before; return sendJson(res, 500, { ok: false, error: "write_failed", message: tz("没保存上：存储满了或没有权限") }); }
      return sendJson(res, 200, { ok: true, title: name });
    }

    // 回退到某条用户消息之前：文件（claude 检查点）+ 可选连对话一起（截到这条之前另起一个会话，原会话不动）
    if (req.method === "POST" && action === "rewind") {
      const b = JSON.parse((await readBody(req)) || "{}");
      if (!(await idleRetired(id))) return sendJson(res, 409, { error: "busy", message: tz("这个会话正在生成中，等它答完再回退。") });
      const loc = locateUserTurn(id, String(b.userText || ""), b.after, String(b.uuid || "").slice(0, 64));
      if (!loc.ok) return sendJson(res, loc.status || 400, { error: "locate", message: loc.message });
      const uuid = loc.users[loc.best].uuid;
      // 真回退也先试算一次：要拿到会动哪些文件，回退后逐个核对（见 rewindFixup）
      const dry = uuid ? await rewindFiles(id, uuid, true) : { ok: false, error: "no uuid" };
      let files = dry;
      if (!b.dryRun && dry.ok && dry.canRewind !== false && (dry.filesChanged || []).length) {
        files = await rewindFiles(id, uuid, false);
        const fx2 = rewindFixup(loc.found.file, id, uuid, dry.filesChanged);
        if (fx2.fixed || fx2.failed) log(`回退补救：补写 ${fx2.fixed} 个，失败 ${fx2.failed} 个`);
        if (fx2.failed) files = { ok: false, error: tz("有 {n} 个文件没能还原", { n: fx2.failed }) };
        else files = { ...files, ok: true, canRewind: true, filesChanged: dry.filesChanged, insertions: dry.insertions, deletions: dry.deletions };
      }
      // 早于检查点的消息（或这一轮之后根本没改文件）claude 会说不能回退：代码这块就当「没有可撤销的」
      const fx = files.ok && files.canRewind !== false
        ? { canRewind: true, files: files.filesChanged || null, insertions: files.insertions || 0, deletions: files.deletions || 0 }
        : { canRewind: false, reason: String(files.error || "").slice(0, 300) };
      if (b.dryRun) return sendJson(res, 200, { ok: true, ...fx });
      if (!fx.canRewind && !b.conversation) return sendJson(res, 409, { error: "cannot", message: tz("这条消息之后的文件改动没有留底，没法撤销。") + (fx.reason ? "（" + fx.reason + "）" : "") });
      log(`回退 ${id.slice(0, 8)}：文件${fx.canRewind ? "已撤销" : "未动"}${b.conversation ? "，对话截到这条之前" : ""}`);
      let fork = null;
      if (b.conversation && loc.best === 0) fork = { ok: true, fresh: true };   // 退到第一条之前 = 空会话，前端直接开新会话
      else if (b.conversation) {
        fork = forkSession(id, String(b.userText || ""), b.after, { before: true, uuid: String(b.uuid || "").slice(0, 64) });
        if (!fork.ok) return sendJson(res, fork.status || 400, { error: "fork", message: fork.message, files: fx });
      }
      return sendJson(res, 200, { ok: true, files: fx, fork });
    }

    // 删一条消息（which: user = 这一轮的提问；bot = 这一轮 Claude 的整条回复），可撤销最近一次
    if (req.method === "POST" && (action === "delmsg" || action === "undodel")) {
      const b = JSON.parse((await readBody(req)) || "{}");
      // 只剩后台任务的 idle 轮：先结束它（否则永远 409），真正在生成的仍拒绝（195-A.3）
      if (action === "delmsg" && !(await idleRetired(id))) return sendJson(res, 409, { ok: false, error: "delmsg", message: tz("这个会话正在生成中，等它答完再删。") });
      let r;
      try { r = action === "delmsg" ? deleteMessage(id, String(b.userText || ""), Number(b.after) || 0, b.which === "user" ? "user" : "bot", String(b.uuid || "").slice(0, 64), String(b.replyUuid || "").slice(0, 64), Array.isArray(b.offs) ? b.offs.slice(0, 64).map(Number) : []) : undoDelete(id, String(b.undo || "")); }
      catch (e) { r = { ok: false, status: 500, message: e.message }; }
      return sendJson(res, r.ok ? 200 : r.status, r.ok ? r : { ok: false, error: action, message: tr(LAST_LANG, r.message) });
    }

    if (req.method === "POST" && action === "fork") {
      const b = JSON.parse((await readBody(req)) || "{}");
      let r;
      try { r = forkSession(id, String(b.userText || ""), Number(b.after) || 0, { uuid: String(b.uuid || "").slice(0, 64), latest: b.latest === true }); }
      catch (e) { r = { ok: false, status: 500, message: e.message }; }
      return sendJson(res, r.ok ? 200 : r.status, r.ok ? r : { ok: false, error: "fork", message: tr(LAST_LANG, r.message) });
    }

    if (req.method === "POST" && action === "pin") {
      const b = JSON.parse((await readBody(req)) || "{}");
      const before = PINS[id];
      if (b.pin === false) delete PINS[id]; else PINS[id] = Date.now();
      if (!savePins()) { if (before === undefined) delete PINS[id]; else PINS[id] = before; return sendJson(res, 500, { ok: false, error: "write_failed", message: tz("没保存上：存储满了或没有权限") }); }
      return sendJson(res, 200, { ok: true, pinned: PINS[id] || 0 });
    }
  }
  return NEXT;
}
