import fs from "node:fs";
import path from "node:path";
import { CFG, LAST_LANG, PATHS, log, tr, tz } from "./config.mjs";
import { SID_RE, TRASH_KEEP_DAYS, inTrash, exportSessions, deleteMessage, forkSession, importSessions, listTrash, locateUserTurn, purgeTrash, realWorkspace, restoreSession, rewindFiles, rewindFixup, trashSession, undoDelete } from "./sessionops.mjs";
import { goalStateOf, tasksOf } from "./goal.mjs";
import { backfillAgents, readAgentIndex, settleAgentRecs } from "./agents.mjs";
import { bodyToFile, forEachLine } from "./bigfile.mjs";
import { agentFilesOf, findLineOffset, latestContextTokens, lineHas, readSessionForward, readSessionPage, transcriptItems } from "./transcript.mjs";
import { lineageCached } from "./lineage.mjs";
import { chapterView } from "./archive-core.mjs";
import { runOfSession } from "./runs.mjs";
import { archiveBrief, archiveDb, archivedTitle } from "./archive-store.mjs";
import { NEXT, readBody, sendJson } from "./http.mjs";
import { isInjected } from "./integrity.mjs";

// ── 会话重命名表 ──────────────────────────────────────────────────────
export let NAMES = {};
{
  let raw = null;
  try { raw = fs.readFileSync(PATHS.names, "utf8"); } catch {}
  if (raw != null) {
    try { NAMES = JSON.parse(raw); } catch { NAMES = null; }
    // 文件坏了（解析不了、或是 null / 数组之类）：当没有，别让整个会话列表跟着抛错（#98 03-012）；
    // 原件留一份底稿再说——下次改名就会把它覆盖掉（DeepSeek 复核 #9，同档案的 .bad- 底稿）
    if (!NAMES || typeof NAMES !== "object" || Array.isArray(NAMES)) {
      NAMES = {};
      try { fs.copyFileSync(PATHS.names, PATHS.names + ".bad-" + Date.now()); } catch {}
    }
  }
}
// 会话标题只在这里定：用户改过的 > 建档的最新一章题名 > 第一句提问。列表、详情、搜索都走它，免得顶栏和侧栏各说各的（#44）
const sessionTitle = (id, meta) => NAMES[id] || archivedTitle(id) || meta.title;

// 改名表的版本：每次落盘加一。脉络/剖面的缓存戳带上它，改名（键数不变）也会重建（DeepSeek 复核 #6）
export let NAMES_REV = 0;
/** 写 JSON 表：先写同目录临时文件再 rename。直接写目标文件在写一半被杀/满盘时会留下截断 JSON，
 *  下次启动只能按空表起，用户改过的标题/置顶就全丢了。 */
function writeJsonTable(file, obj) {
  const tmp = file + ".tmp-" + process.pid;
  try { fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 }); fs.renameSync(tmp, file); }
  catch { try { fs.rmSync(tmp, { force: true }); } catch {} }
}
export function saveNames() {
  NAMES_REV++;
  writeJsonTable(PATHS.names, NAMES);
}
// 置顶表：会话号 → 置顶时刻
const PINS_FILE = path.join(CFG.home, "ccapp-session-pins.json");
export let PINS = {};
try { const j = JSON.parse(fs.readFileSync(PINS_FILE, "utf8")); if (j && typeof j === "object" && !Array.isArray(j)) PINS = j; } catch {}
export function savePins() {
  writeJsonTable(PINS_FILE, PINS);
}

// ── 会话（claude 的 transcript 文件）─────────────────────────────────
/** 项目目录名 → 真实 cwd（从 jsonl 里读，目录名本身不可逆） */
export const PEEK_CACHE = new Map();   // 标题/cwd 取自文件开头，写进去就不变了，没必要每次列表都重读
export function peekSession(file) {
  let hit = PEEK_CACHE.get(file);
  if (hit && hit.title !== "(无标题)") return hit;
  hit = peekSessionRaw(file);
  PEEK_CACHE.set(file, hit);
  return hit;
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
  } catch { return []; }

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
      });
    }
  }

  found.sort((a, b) => b.mtime - a.mtime);
  const shown = found.filter((s, i) => i < limit || PINS[s.id]);
  const out = shown.map((s) => {
    const meta = peekSession(s.file), ab = archiveBrief(s.id, s.size, lineageCached(s.id)?.compacts?.length || 0);
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
  out.total = found.length;
  return out;
}

// ── 会话内容搜索 ──
// 每个 jsonl 只抽人和助手的正文（跳过工具结果、<…> 包起来的系统注入），按读到的字节偏移增量追加。
// 索引放内存：首次搜索要扫一遍全部会话，之后只读新追加的部分。
const SEARCH_IDX = new Map();   // file → { off, text, lower }
// 常驻上限（按字符，text + lower 两份 UTF-16 约 4 字节/字）：最近的会话常驻，超出的旧会话搜时现读、用完就扔，
// 搜得全但内存有顶（审查 中5）
const SEARCH_KEEP_CHARS = 16e6;
function searchText(line) {
  if (line.length > 4e6 || !(line.includes('"user"') || line.includes('"assistant"'))) return "";
  let ev; try { ev = JSON.parse(line); } catch { return ""; }
  if ((ev.type !== "user" && ev.type !== "assistant") || ev.isMeta) return "";
  const c = ev.message?.content, out = [];
  if (typeof c === "string") out.push(c);
  else if (Array.isArray(c)) for (const b of c) if (b && b.type === "text" && typeof b.text === "string") out.push(b.text);
  return out.filter((t) => t && !isInjected(t)).join(" ").replace(/\s+/g, " ").trim();
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
  if (!e || size < e.off) e = { off: 0, text: "", lower: "" };
  if (e.off) {
    const fh = await fs.promises.open(file, "r");
    try {
      const st = await fh.stat();
      if (st.ino !== e.ino || (await indexTail(fh, e.off)) !== e.tail) e = { off: 0, text: "", lower: "" };
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
      e.off = pos - rest.length;   // 半行留到下次
      e.tail = await indexTail(fh, e.off);
      if (parts.length) {
        const add = (e.text ? "\n" : "") + parts.join("\n");
        e.text += add; e.lower += add.toLowerCase();
      }
    } finally { await fh.close(); }
  }
  SEARCH_IDX.set(file, e);
  return e;
}
let searchChain = Promise.resolve();
let importBusy = false;
function searchSessions(q) {
  const run = searchChain.then(() => searchSessionsNow(q));
  searchChain = run.catch(() => {});
  return run;
}
async function searchSessionsNow(q) {
  const needle = q.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 200);
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
      try { const st = fs.statSync(full); files.push({ id: f.slice(0, -6), file: full, mtime: st.mtimeMs, size: st.size }); } catch {}
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const seen = new Set(files.map((f) => f.file));
  for (const k of SEARCH_IDX.keys()) if (!seen.has(k)) SEARCH_IDX.delete(k);

  const results = [];
  let kept = 0;
  for (const f of files) {
    const meta = peekSession(f.file);
    const title = sessionTitle(f.id, meta);
    let e;
    try { e = await indexSessionFile(f.file, f.size); } catch { continue; }
    kept += e.text.length;
    if (kept > SEARCH_KEEP_CHARS) SEARCH_IDX.delete(f.file);
    let i = e.lower.indexOf(needle), count = 0, snippet = "";
    if (i >= 0) {
      const a = Math.max(0, i - 30), b = Math.min(e.text.length, i + needle.length + 60);
      snippet = (a > 0 ? "…" : "") + e.text.slice(a, b).replace(/\n/g, " ") + (b < e.text.length ? "…" : "");
      for (let j = i; j >= 0 && count < 99; j = e.lower.indexOf(needle, j + needle.length)) count++;
    }
    const inTitle = title.toLowerCase().includes(needle);
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

export function findSessionFile(id) {
  if (!SID_RE.test(id)) return null;   // 防目录穿越
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
export async function routeSessions(req, res, u, p) {
  // ── 会话 ──
  if (req.method === "GET" && p === "/api/sessions/search") {
    return sendJson(res, 200, await searchSessions(String(u.searchParams.get("q") || "")));
  }
  if (req.method === "GET" && p === "/api/sessions") {
    // limit：界面点「再显示」逐次加 150；首次列表每个文件要读开头取标题，所以默认只给最近 150 个
    const list = listSessions(Math.min(5000, Math.max(150, parseInt(u.searchParams.get("limit"), 10) || 150)));
    // total：磁盘上一共多少个。列表只给最近 limit 个（加置顶），界面据此说「最近 N 个，共 M 个」（#178-3）
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
    const n = purgeTrash(ids);
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
      const rec = lineageCached(id);
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
      if (runOfSession(id)) return sendJson(res, 409, { error: "busy", message: tz("这个会话正在生成中。") });
      // 删除先进回收站（30 天内可恢复），彻底删除走 /api/trash/purge
      let r;
      try { r = trashSession(id); } catch (e) { return sendJson(res, 500, { error: e.message }); }
      if (r.ok) log(`会话进回收站 ${id.slice(0, 8)}`);
      return sendJson(res, r.ok ? 200 : 404, r);
    }

    if (req.method === "POST" && action === "rename") {
      const b = JSON.parse((await readBody(req)) || "{}");
      const name = String(b.title || "").trim().slice(0, 120);
      if (!name) return sendJson(res, 400, { error: "empty" });
      if (!found) return sendJson(res, 404, { error: "not found" });      // 不存在的会话不往名字表里记（审查 v0513b 低-6）
      NAMES[id] = name; saveNames();
      return sendJson(res, 200, { ok: true, title: name });
    }

    // 回退到某条用户消息之前：文件（claude 检查点）+ 可选连对话一起（截到这条之前另起一个会话，原会话不动）
    if (req.method === "POST" && action === "rewind") {
      const b = JSON.parse((await readBody(req)) || "{}");
      if (runOfSession(id)) return sendJson(res, 409, { error: "busy", message: tz("这个会话正在生成中，等它答完再回退。") });
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
      if (b.pin === false) delete PINS[id]; else PINS[id] = Date.now();
      savePins();
      return sendJson(res, 200, { ok: true, pinned: PINS[id] || 0 });
    }
  }
  return NEXT;
}
