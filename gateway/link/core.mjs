// ─────────────────────────────────────────────────────────────────────
//  core.mjs —— 设备互联的本地数据层
//
//  只碰 claude 自己的 transcript：扫描 .claude/projects、打包/解包会话、
//  改写 cwd、备份、恢复。网络和配对在 linkd.mjs 里。
//
//  会话文件在两台设备上的路径不可能一样，所以导入时一律把每一行的 cwd
//  改成本机存在的目录：同名项目目录优先，否则落到工作区。
// ─────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";

export const SID_RE = /^(?!\.+$)[A-Za-z0-9._-]{1,200}$/;
const DAY = 86400000;
const PEEK_BYTES = 196608;
// 会话 sidecar 里按文本处理、可以改路径的扩展名；图片 / 压缩包等二进制不动
const TEXT_EXT = new Set([".json", ".jsonl", ".ndjson", ".txt", ".md", ".markdown", ".html", ".htm", ".css",
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".csv", ".tsv", ".svg", ".xml", ".yaml", ".yml", ".log",
  ".sh", ".bash", ".zsh", ".py", ".rb", ".php", ".lua", ".c", ".cc", ".cpp", ".h", ".hpp", ".go", ".rs", ".java"]);

export function ensureDir(p) { try { fs.mkdirSync(p, { recursive: true }); } catch {} }
export function statSafe(p) { try { return fs.statSync(p); } catch { return null; } }
export function readJson(p, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
}
export function writeJson(p, obj) {
  ensureDir(path.dirname(p));
  const tmp = p + ".tmp-" + process.pid + "-" + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, p);
}
export function projectSlug(cwd) { return String(cwd).replace(/[^A-Za-z0-9]/g, "-"); }
export function realWorkspace(ws) {
  try { return fs.realpathSync(ws); } catch { return ws; }
}
export function platformName() {
  return process.platform === "win32" ? "windows" : process.platform === "android" ? "android" : process.platform;
}

/** 从 transcript 开头的环境快照里认出这台会话最初是在哪种系统上建的。
 *  Claude Code 的环境块写的是 `Platform: win32` / `Platform: linux`（安卓也报 linux）。 */
export function detectSessionPlatform(file, maxBytes = 262144) {
  let fd = null;
  try {
    fd = fs.openSync(file, "r");
    const b = Buffer.alloc(maxBytes);
    const n = fs.readSync(fd, b, 0, maxBytes, 0);
    const text = b.subarray(0, n).toString("utf8");
    const m = /(?:Platform|平台)\s*[:：]\s*(win32|linux|darwin|android|freebsd|openbsd)/i.exec(text)
      || /"platform"\s*:\s*"(win32|linux|darwin|android|freebsd|openbsd)"/i.exec(text);
    return m ? m[1].toLowerCase() : "";
  } catch { return ""; }
  finally { if (fd !== null) { try { fs.closeSync(fd); } catch {} } }
}
const normPath = (s) => String(s || "").replace(/\\/g, "/").replace(/\/+$/, "");
const baseName = (s) => normPath(s).split("/").filter(Boolean).pop() || "";

export function makePaths(home, workspace) {
  return {
    home,
    workspace: realWorkspace(workspace || path.join(home, "workspace")),
    projects: path.join(home, ".claude", "projects"),
    trash: path.join(home, ".ccapp-trash"),
    names: path.join(home, "ccapp-session-names.json"),
    pins: path.join(home, "ccapp-session-pins.json"),
    backups: path.join(home, ".ccapp-link-backups"),
    state: path.join(home, "ccapp-link.json"),
    log: path.join(home, "link.log"),
    token: path.join(home, ".gateway-token"),
  };
}

/** 把远端 cwd 映射到本机：同名项目目录 → 工作区 */
export function makeCwdMapper(paths, peerWorkspace) {
  const local = realWorkspace(paths.workspace);
  return (remoteCwd) => {
    const r = normPath(remoteCwd);
    if (!r) return local;
    if (peerWorkspace && normPath(peerWorkspace) === r) return local;
    const base = baseName(r);
    if (base && base.length < 200) {
      const cand = path.join(local, base);
      try { if (fs.statSync(cand).isDirectory()) return fs.realpathSync(cand); } catch {}
    }
    return local;
  };
}

/** 远端 → 本机的路径替换表。
 *  workspace 和 home 都映射，按前缀长度降序（先换更长的）；
 *  额外可以给 [[from, to]]（比如这条会话自己的 cwd 不在工作区里）。
 *  不能写死某台设备的目录：路径来自对端 manifest 或会话包里的 from。 */
export function makePathMap(paths, peer = {}, extra = []) {
  const localWs = realWorkspace(paths.workspace);
  const localHome = path.resolve(paths.home || path.dirname(localWs));
  const pairs = [];
  const seen = new Set();
  const add = (from, to) => {
    const f = String(from || "").replace(/[\\/]+$/, "");
    const t = String(to || "").replace(/[\\/]+$/, "");
    if (!f || !t || normPath(f) === normPath(t)) return;
    const fw = f.replace(/\\/g, "/");
    const fn = f.replace(/\//g, "\\");
    for (const v of new Set([f, fw, fn])) {
      if (!v || seen.has(v)) continue;
      seen.add(v);
      const toV = v.includes("\\") ? t.replace(/\//g, "\\") : t.replace(/\\/g, "/");
      pairs.push([v, toV]);
    }
  };
  for (const [from, to] of extra) add(from, to);
  add(peer.workspace, localWs);
  add(peer.home, localHome);
  pairs.sort((a, b) => b[0].length - a[0].length);
  return pairs;
}

/** 在一段文本里替换路径前缀；要求前后是边界，避免把 /home 换成 /homework */
export function mapPathString(s, pathMap) {
  if (typeof s !== "string" || !s || !pathMap || !pathMap.length) return s;
  let out = s;
  for (const [from, to] of pathMap) {
    let i = 0;
    for (;;) {
      const at = out.indexOf(from, i);
      if (at < 0) break;
      const before = at ? out[at - 1] : "";
      const after = out[at + from.length] || "";
      const okBefore = !before || !/[A-Za-z0-9_.-]/.test(before);
      const okAfter = !after || /[\\/:\s"'`\)\]\},;?#]/.test(after);
      if (okBefore && okAfter) {
        out = out.slice(0, at) + to + out.slice(at + from.length);
        i = at + to.length;
      } else i = at + from.length;
    }
  }
  return out;
}

/** 递归处理 JSON 里的每个字符串（工具参数、工具结果、正文都会覆盖到） */
export function mapPathsDeep(v, pathMap) {
  if (!pathMap || !pathMap.length) return v;
  if (typeof v === "string") return mapPathString(v, pathMap);
  if (Array.isArray(v)) {
    let changed = false;
    const r = v.map((x) => { const y = mapPathsDeep(x, pathMap); if (y !== x) changed = true; return y; });
    return changed ? r : v;
  }
  if (v && typeof v === "object") {
    let changed = false;
    const r = {};
    for (const k of Object.keys(v)) { const y = mapPathsDeep(v[k], pathMap); if (y !== v[k]) changed = true; r[k] = y; }
    return changed ? r : v;
  }
  return v;
}

// ── 内容产物：工作区里被会话引用到的文件 ──────────────────────────────
//  会话只同步 transcript。正文 / 工具结果里提到的截图、报告、导出文件都在
//  工作区，对端把路径映射过去以后本地并没有那个文件，点开就是「文件不存在」。
//  这里把会话提到的工作区文件跟会话包一起带走，落地时写进对端自己的工作区。
const ART_SKIP_DIRS = new Set([".git", "node_modules", "__pycache__", ".venv", "venv", ".cache", ".idea", ".vscode", ".ccapp-link-backups"]);
const ART_MAX_FILES = 1200;   // 候选上限：长会话会提到上千个路径，stat 一遍比起全量打包便宜

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function walkStrings(v, fn) {
  if (typeof v === "string") { fn(v); return; }
  if (Array.isArray(v)) { for (const x of v) walkStrings(x, fn); return; }
  if (v && typeof v === "object") for (const k of Object.keys(v)) walkStrings(v[k], fn);
}

/** 从 transcript 里找出工作区下真实存在的文件。
 *  maxTotal/maxFile 是字节数；只读进内存，不碰别的地方。 */
export function collectArtifacts(paths, buf, { maxTotal = 24 * 1024 * 1024, maxFile = 8 * 1024 * 1024 } = {}) {
  const root = realWorkspace(paths.workspace);
  if (!root || maxTotal <= 0) return { items: [], skipped: [], bytes: 0 };
  const roots = [...new Set([root, root.replace(/\\/g, "/"), root.replace(/\//g, "\\")])].filter(Boolean);
  const re = new RegExp("(?:" + roots.map(escapeRe).join("|") + ")[\\\\/]([^\\s\"'`<>|*?\\n\\r\\t]+)", "g");
  // 先粗略筛行：工作区最后一段目录名多半会出现在路径里，省掉绝大多数 JSON.parse
  const hint = normPath(root).split("/").filter(Boolean).pop() || "";
  const text = Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf || "");
  const found = new Set();
  let lines = 0;
  for (const line of text.split("\n")) {
    if (!line.trim() || !hint || !line.includes(hint)) continue;
    if (++lines > 300000) break;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    walkStrings(ev, (s) => {
      if (s.length < hint.length + 2 || s.length > 300000 || !s.includes(hint)) return;
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(s))) {
        let rel = m[1].replace(/:\d+(?::\d+)?$/, "").replace(/[.,;:!?)\]}>"'`，。、；：！？）】」』]+$/, "");
        rel = rel.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
        if (!rel || rel.length > 300 || !safeRel(rel)) continue;
        if (ART_SKIP_DIRS.has(rel.split("/")[0].toLowerCase())) continue;
        found.add(rel);
        if (found.size >= ART_MAX_FILES) break;
      }
    });
    if (found.size >= ART_MAX_FILES) break;
  }
  // 先只看不读：按修改时间从新到旧，预算不够时优先留最近产出的文件
  const cand = [];
  let total = 0;
  const skipped = [];
  for (const rel of found) {
    const abs = path.join(root, rel);
    const st = statSafe(abs);
    if (!st || !st.isFile()) continue;
    cand.push({ rel, abs, size: st.size, mtime: st.mtimeMs });
  }
  cand.sort((a, b) => b.mtime - a.mtime || a.rel.localeCompare(b.rel));
  const items = [];
  for (const c of cand) {
    if (c.size > maxFile) { skipped.push({ rel: c.rel, size: c.size, why: "big" }); continue; }
    if (total + c.size > maxTotal) { skipped.push({ rel: c.rel, size: c.size, why: "budget" }); continue; }
    let data;
    try { data = fs.readFileSync(c.abs); } catch { skipped.push({ rel: c.rel, size: c.size, why: "read" }); continue; }
    total += data.length;
    items.push({ rel: c.rel, size: data.length, mtime: c.mtime, data });
  }
  return { items, skipped, bytes: total };
}

/** 把会话包里的产物写进本机工作区。本地已经有更新/同样新的文件就不动。 */
export function unpackArtifacts(paths, files, indexData, { maxBytes = 256 * 1024 * 1024 } = {}) {
  let index = null;
  try { index = indexData ? JSON.parse(indexData.toString("utf8")) : null; } catch {}
  const meta = new Map();
  if (index && Array.isArray(index.items)) for (const it of index.items) {
    if (it && safeRel(String(it.rel || ""))) meta.set(String(it.rel), it);
  }
  const root = realWorkspace(paths.workspace);
  const out = { written: 0, skipped: 0, bytes: 0, total: meta.size, dropped: index && Array.isArray(index.skipped) ? index.skipped.length : 0, files: [] };
  if (!root) return out;
  for (const f of files) {
    if (!f.name.startsWith("artifacts/")) continue;
    const rel = f.name.slice("artifacts/".length);
    if (!safeRel(rel)) { out.skipped++; continue; }
    if (out.bytes + f.data.length > maxBytes) { out.skipped++; continue; }
    const target = path.join(root, rel);
    const info = meta.get(rel) || {};
    const remoteM = Number(info.mtime) || 0;
    const st = statSafe(target);
    if (st && st.isFile()) {
      // 本机这份不比对端旧（或没带时间、大小又一样）就当已经有了，别覆盖本地改动
      if (remoteM ? st.mtimeMs >= remoteM - 1000 : st.size === f.data.length) { out.skipped++; continue; }
    }
    try {
      ensureDir(path.dirname(target));
      // 只往工作区里写：中间某一段是软链接指到外面的话，宁可不写
      const realDir = fs.realpathSync(path.dirname(target));
      if (realDir !== root && !realDir.startsWith(root + path.sep)) { out.skipped++; continue; }
      const tmp = target + ".tmp-" + process.pid + "-" + Date.now();
      fs.writeFileSync(tmp, f.data, { mode: 0o600 });
      fs.renameSync(tmp, target);
      if (remoteM) { const t = new Date(remoteM); try { fs.utimesSync(target, t, t); } catch {} }
      out.written++; out.bytes += f.data.length; out.files.push(rel);
    } catch { out.skipped++; }
  }
  return out;
}

/** 只用于判断「两边内容其实一样，只是路径被改写过」 */
export function normalizedHash(buf, pathMap = []) {
  const h = crypto.createHash("sha256");
  for (const line of buf.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    let s = line;
    try {
      let ev = JSON.parse(line);
      if (pathMap && pathMap.length) ev = mapPathsDeep(ev, pathMap);
      delete ev.cwd;
      s = JSON.stringify(ev);
    } catch {}
    h.update(s); h.update("\n");
  }
  return h.digest("hex");
}

// ── 会话扫描 ──────────────────────────────────────────────────────────
function peekSession(file, st, cache) {
  const key = `${st.mtimeMs}:${st.size}`;
  const hit = cache.get(file);
  if (hit && hit.key === key) return hit;
  let title = "", cwd = "", created = 0;
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(Math.min(PEEK_BYTES, Math.max(1, st.size)));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    for (const line of buf.toString("utf8", 0, n).split("\n")) {
      if (!line.trim()) continue;
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      if (ev.cwd && !cwd) cwd = ev.cwd;
      if (!created && ev.timestamp) created = Date.parse(ev.timestamp) || 0;
      if (ev.type === "attachment") continue;
      let text = "";
      const c = ev.message && ev.message.content;
      if (typeof c === "string") text = c;
      else if (Array.isArray(c)) { const t = c.find((x) => x && x.type === "text"); if (t) text = t.text; }
      if (!text && typeof ev.content === "string" && ev.type === "queue-operation") text = ev.content;
      if (text && ev.type === "user" && !text.startsWith("<")) { title = text; break; }
      if (text && !title && !text.startsWith("<")) title = text;
    }
  } catch {}
  const out = { key, title: String(title || "").replace(/\s+/g, " ").trim().slice(0, 90) || "(无标题)", cwd, created };
  cache.set(file, out);
  return out;
}

export class SessionIndex {
  constructor(paths) {
    this.paths = paths;
    this.peek = new Map();
    this.names = readJson(paths.names, {});
    this.pins = readJson(paths.pins, {});
    this.namesMtime = (statSafe(paths.names) || {}).mtimeMs || 0;
    this.pinsMtime = (statSafe(paths.pins) || {}).mtimeMs || 0;
    this.at = 0;
    this.entries = new Map();
  }

  fresh(ms = 3000) { return this.at > 0 && Date.now() - this.at < ms; }

  scan(force = false) {
    if (!force && this.fresh()) return this;
    this.names = readJson(this.paths.names, {});
    this.pins = readJson(this.paths.pins, {});
    this.namesMtime = (statSafe(this.paths.names) || {}).mtimeMs || 0;
    this.pinsMtime = (statSafe(this.paths.pins) || {}).mtimeMs || 0;
    const out = new Map();
    let dirs = [];
    try { dirs = fs.readdirSync(this.paths.projects, { withFileTypes: true }); } catch {}
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const dir = path.join(this.paths.projects, d.name);
      let files = [];
      try { files = fs.readdirSync(dir); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith(".jsonl")) continue;
        const id = f.slice(0, -6);
        if (!SID_RE.test(id)) continue;
        const full = path.join(dir, f);
        const st = statSafe(full);
        if (!st || !st.isFile()) continue;
        const meta = peekSession(full, st, this.peek);
        out.set(id, {
          id, file: full, project: d.name,
          mtime: st.mtimeMs, size: st.size,
          title: this.names[id] || meta.title,
          renamed: !!this.names[id],
          pinned: this.pins[id] || 0,
          cwd: meta.cwd,
          created: meta.created || 0,
        });
      }
    }
    this.entries = out;
    this.at = Date.now();
    return this;
  }

  list(limit = 2000) {
    this.scan();
    return [...this.entries.values()].sort((a, b) => b.mtime - a.mtime).slice(0, limit);
  }

  get(id) {
    this.scan();
    return this.entries.get(id) || null;
  }

  findFile(id) {
    const e = this.get(id);
    return e ? e.file : null;
  }
}

export function trashIds(paths) {
  const out = new Set();
  let list = [];
  try { list = fs.readdirSync(paths.trash); } catch { return out; }
  for (const f of list) {
    // 新版回收站是「一个会话一个目录」：<id>/<id>.jsonl + meta.json；旧版是 <id>.jsonl
    if (!f.startsWith(".") && SID_RE.test(f)) { out.add(f); continue; }
    const m = /^(.+)\.jsonl$/.exec(f);
    if (m && SID_RE.test(m[1])) out.add(m[1]);
  }
  return out;
}

// ── zip：只 deflate / store，够会话包用 ────────────────────────────────
export function zipBuild(entries) {
  const locals = [], centrals = [];
  let off = 0;
  const dosTime = (d) => ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
  const dosDate = (d) => (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
  const now = new Date();
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    const comp = zlib.deflateRawSync(raw, { level: 6 });
    const store = comp.length >= raw.length;
    const body = store ? raw : comp;
    const crc = zlib.crc32(raw) >>> 0;
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6);
    h.writeUInt16LE(store ? 0 : 8, 8); h.writeUInt16LE(dosTime(now), 10); h.writeUInt16LE(dosDate(now), 12);
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(body.length, 18); h.writeUInt32LE(raw.length, 22);
    h.writeUInt16LE(name.length, 26); h.writeUInt16LE(0, 28);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(store ? 0 : 8, 10); c.writeUInt16LE(dosTime(now), 12); c.writeUInt16LE(dosDate(now), 14);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(raw.length, 24);
    c.writeUInt16LE(name.length, 28); c.writeUInt32LE(off, 42);
    locals.push(h, name, body);
    centrals.push(c, name);
    off += h.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

export function zipRead(buf, max = 128 * 1024 * 1024) {
  let e = buf.length - 22;
  let total = 0;
  const tooBig = () => new Error("压缩包太大");
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error("不是 zip 文件");
  const n = buf.readUInt16LE(e + 10);
  let p = buf.readUInt32LE(e + 16);
  const out = [];
  if (n > 5000) throw new Error("zip 文件太多");
  for (let i = 0; i < n; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("zip 目录损坏");
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const lo = buf.readUInt32LE(p + 42);
    const usize = buf.readUInt32LE(p + 24);
    const name = buf.toString("utf8", p + 46, p + 46 + nlen).replace(/\\/g, "/");
    p += 46 + nlen + xlen + clen;
    if (name.endsWith("/")) continue;
    const ds = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
    const body = buf.subarray(ds, ds + csize);
    if (method !== 0 && method !== 8) throw new Error("不支持的压缩方式");
    if ((total += usize) > max) throw tooBig();
    let data;
    try { data = method === 8 ? zlib.inflateRawSync(body, { maxOutputLength: max - total + usize }) : Buffer.from(body); }
    catch (err) { if (err.code === "ERR_BUFFER_TOO_LARGE" || err.code === "ERR_OUT_OF_RANGE") throw tooBig(); throw err; }
    total += data.length - usize;
    if (total > max) throw tooBig();
    out.push({ name, data });
  }
  return out;
}

function safeRel(rel) {
  if (!rel || rel.length > 500) return false;
  if (rel.startsWith("/") || rel.includes("\0") || rel.includes("\\")) return false;
  if (/^[A-Za-z]:/.test(rel)) return false;
  const parts = rel.split("/");
  if (parts.some((x) => !x || x === "." || x === "..")) return false;
  return true;
}

function walkFiles(dir, prefix, out, state, maxBytes) {
  let list = [];
  try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const d of list) {
    if (state.bytes > maxBytes || state.count > 3000) return;
    const f = path.join(dir, d.name);
    if (d.isSymbolicLink()) continue;
    if (d.isDirectory()) { walkFiles(f, prefix + "/" + d.name, out, state, maxBytes); continue; }
    if (!d.isFile()) continue;
    const st = statSafe(f);
    if (!st) continue;
    state.bytes += st.size; state.count++;
    out.push({ name: prefix + "/" + d.name, data: fs.readFileSync(f) });
  }
}

/** 打包一个会话：manifest + session.jsonl + sidecar/…（子代理、超长工具结果）
 *  + artifacts/…（会话引用到的本机工作区文件，artifacts 传 null 就不带） */
export function packSession(paths, entry, { maxBytes = 64 * 1024 * 1024, origin, artifacts = null } = {}) {
  const files = [];
  const state = { bytes: 0, count: 0 };
  const side = path.join(paths.projects, entry.project, entry.id);
  walkFiles(side, "sidecar", files, state, maxBytes);
  const main = fs.readFileSync(entry.file);
  const meta = {
    id: entry.id, title: entry.title, renamed: entry.renamed, cwd: entry.cwd,
    mtime: entry.mtime, size: entry.size, pinned: entry.pinned, created: entry.created,
  };
  // 会话最初建在哪台设备：跟着包走，对端收到后按这个标「手机 / 电脑」
  if (origin && typeof origin === "object") {
    const o = {
      kind: origin.kind === "phone" || origin.kind === "pc" ? origin.kind : "",
      name: String(origin.name || "").slice(0, 60),
      dev: String(origin.dev || "").slice(0, 64),
      platform: String(origin.platform || "").slice(0, 20),
      at: Number(origin.at) || Date.now(),
    };
    if (o.kind) meta.origin = o;
  }
  // 带上本机的目录布局：对端只拿到 zip（比如经中转）时也能把路径映射过去
  const from = { workspace: paths.workspace, home: paths.home, platform: platformName() };
  const man = { format: "cccodroid-link-session", version: 1, sentAt: Date.now(), from, session: meta };
  // 内容产物：正文里引用到的本机工作区文件，跟着会话一起走
  let arts = { items: [], skipped: [], bytes: 0 };
  if (artifacts) {
    try { arts = collectArtifacts(paths, main, artifacts); } catch { arts = { items: [], skipped: [], bytes: 0 }; }
  }
  if (arts.items.length || arts.skipped.length) {
    man.artifacts = { version: 1, count: arts.items.length, bytes: arts.bytes, dropped: arts.skipped.length };
    files.push({
      name: "artifacts.json",
      data: Buffer.from(JSON.stringify({
        version: 1,
        items: arts.items.map((a) => ({ rel: a.rel, size: a.size, mtime: a.mtime })),
        skipped: arts.skipped,
      })),
    });
    for (const a of arts.items) files.push({ name: "artifacts/" + a.rel, data: a.data });
  }
  files.unshift({ name: "session.jsonl", data: main });
  files.unshift({ name: "manifest.json", data: Buffer.from(JSON.stringify(man)) });
  return { buf: zipBuild(files), meta, sidecars: state.count, artifacts: { count: arts.items.length, bytes: arts.bytes, dropped: arts.skipped.length } };
}

function rewriteLines(buf, { oldId, newId, cwd, pathMap = [] }) {
  const out = [];
  const detect = [];
  for (const [f] of pathMap) { detect.push(f); if (f.includes("\\")) detect.push(f.replace(/\\/g, "\\\\")); }
  for (const line of buf.toString("utf8").split("\n")) {
    if (!line.trim()) { out.push(line); continue; }
    const might = line.includes('"cwd"') || (newId && oldId && line.includes(oldId)) || detect.some((f) => line.includes(f));
    if (!might) { out.push(line); continue; }
    try {
      let ev = JSON.parse(line);
      let changed = false;
      if (cwd && ev.cwd && ev.cwd !== cwd) { ev.cwd = cwd; changed = true; }
      if (newId && oldId && ev.sessionId === oldId) { ev.sessionId = newId; changed = true; }
      if (pathMap.length) {
        const mapped = mapPathsDeep(ev, pathMap);
        if (mapped !== ev) { ev = mapped; changed = true; }
      }
      out.push(changed ? JSON.stringify(ev) : line);
    } catch { out.push(line); }
  }
  return Buffer.from(out.join("\n"));
}

/** 把本地会话、或远端 zip，落成一个会话文件。fork=true 时换新会话号。 */
export function writeSession(paths, { id, oldId, title, cwd, mtime, buf, sessionId, sidecars = [], fork = false, pathMap = [] }) {
  const sid = sessionId || id;
  if (!SID_RE.test(sid)) throw new Error("会话号不合法");
  const targetCwd = cwd || realWorkspace(paths.workspace);
  const dir = path.join(paths.projects, projectSlug(targetCwd));
  ensureDir(dir);
  const file = path.join(dir, sid + ".jsonl");
  const old = fork ? null : findSessionFile(paths, sid);
  let backup = null;
  if (old && old !== file) {
    try { backup = backupFile(paths, sid, old); } catch {}
  } else if (old === file) {
    try { backup = backupFile(paths, sid, file); } catch {}
  }
  const data = rewriteLines(buf, { oldId: oldId || id, newId: sid, cwd: targetCwd, pathMap });
  fs.writeFileSync(file, data, { mode: 0o600 });
  // 覆盖旧会话时，旧版本的子代理记录已经进备份；清掉目标目录，别让已经不在新版本里的旧记录留在界面上
  if (!fork) { try { fs.rmSync(path.join(dir, sid), { recursive: true, force: true }); } catch {} }
  if (mtime) { const t = new Date(Number(mtime) || Date.now()); try { fs.utimesSync(file, t, t); } catch {} }
  let n = 0;
  for (const f of sidecars) {
    if (!safeRel(f.name)) continue;
    const dst = path.join(dir, sid, f.name);
    ensureDir(path.dirname(dst));
    fs.writeFileSync(dst, f.data, { mode: 0o600 });
    n++;
  }
  // 换了项目目录：旧位置的文件和子代理记录已经备份过，移走，别留下同一个会话号的两份
  if (old && old !== file) {
    try { fs.rmSync(old, { force: true }); } catch {}
    try { fs.rmSync(path.join(path.dirname(old), sid), { recursive: true, force: true }); } catch {}
  }
  const st = fs.statSync(file);
  return { id: sid, file, dir, cwd: targetCwd, title, backup, size: st.size, mtime: st.mtimeMs, sidecars: n };
}

export function findSessionFile(paths, id) {
  if (!SID_RE.test(id)) return null;
  let dirs = [];
  try { dirs = fs.readdirSync(paths.projects, { withFileTypes: true }); } catch { return null; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const f = path.join(paths.projects, d.name, id + ".jsonl");
    const st = statSafe(f);
    if (st && st.isFile()) return f;
  }
  return null;
}

function backupFile(paths, id, file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(paths.backups, id, stamp);
  ensureDir(dir);
  fs.copyFileSync(file, path.join(dir, "session.jsonl"));
  const side = path.join(path.dirname(file), id);
  try { if (fs.statSync(side).isDirectory()) fs.cpSync(side, path.join(dir, "sidecar"), { recursive: true }); } catch {}
  writeJson(path.join(dir, "meta.json"), { id, at: Date.now(), file });
  pruneBackups(paths, id);
  return dir;
}

export function pruneBackups(paths, id, keep = 10) {
  const dir = path.join(paths.backups, id);
  let list = [];
  try { list = fs.readdirSync(dir).sort(); } catch { return; }
  const cut = Date.now() - 30 * DAY;
  for (let i = 0; i < list.length; i++) {
    const p = path.join(dir, list[i]);
    const st = statSafe(p);
    if (!st) continue;
    if (i < list.length - keep || st.mtimeMs < cut) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }
  }
}

export function listBackups(paths, id) {
  const root = path.join(paths.backups, id);
  const out = [];
  let stamps = [];
  try { stamps = fs.readdirSync(root).sort().reverse(); } catch { return out; }
  for (const s of stamps) {
    const dir = path.join(root, s);
    const st = statSafe(path.join(dir, "session.jsonl"));
    if (!st) continue;
    const meta = readJson(path.join(dir, "meta.json"), {});
    out.push({ id, stamp: s, at: meta.at || st.mtimeMs, size: st.size, file: path.join(dir, "session.jsonl") });
  }
  return out;
}

export function listAllBackups(paths) {
  const out = [];
  let ids = [];
  try { ids = fs.readdirSync(paths.backups); } catch { return out; }
  for (const id of ids) {
    if (!SID_RE.test(id)) continue;
    for (const b of listBackups(paths, id).slice(0, 3)) out.push(b);
  }
  return out.sort((a, b) => b.at - a.at).slice(0, 60);
}

export function restoreBackup(paths, id, stamp) {
  const dir = path.join(paths.backups, id, stamp);
  const file = path.join(dir, "session.jsonl");
  const st = statSafe(file);
  if (!st) throw new Error("备份不存在");
  const meta = readJson(path.join(dir, "meta.json"), {});
  const buf = fs.readFileSync(file);
  let cwd = "";
  try {
    const first = buf.toString("utf8").split("\n").find((l) => l.includes('"cwd"'));
    if (first) cwd = JSON.parse(first).cwd || "";
  } catch {}
  const nid = crypto.randomUUID();
  const sidecars = [];
  const side = path.join(dir, "sidecar");
  const state = { bytes: 0, count: 0 };
  walkFiles(side, "", sidecars, state, 64 * 1024 * 1024);
  for (const f of sidecars) { f.name = f.name.replace(/^\//, ""); }
  return writeSession(paths, {
    id: nid, oldId: id, sessionId: nid, title: "", cwd: cwd || paths.workspace,
    mtime: Date.now(), buf, sidecars, fork: true,
  });
}

/** 从远端 zip 解出会话 */
export function unpackSession(paths, buf, { mapCwd, pathMap, fork = false, titleSuffix = "" } = {}) {
  const files = zipRead(buf);
  const manFile = files.find((f) => f.name === "manifest.json");
  const main = files.find((f) => f.name === "session.jsonl");
  if (!manFile || !main) throw new Error("不是会话包");
  let man;
  try { man = JSON.parse(manFile.data.toString("utf8")); } catch { throw new Error("会话包清单损坏"); }
  if (man.format !== "cccodroid-link-session") throw new Error("不是互联会话包");
  const s = man.session || {};
  if (!SID_RE.test(String(s.id || ""))) throw new Error("会话号不合法");
  const cwd = mapCwd ? mapCwd(s.cwd || "") : realWorkspace(paths.workspace);
  // 对端 manifest 有完整目录布局就用它；经中转只拿到 zip 时用包里的 from；
  // 再把这条会话自己的 cwd 单独映射一次（项目目录可能不在工作区里）。
  const from = man.from && typeof man.from === "object" ? man.from : {};
  const pm = (pathMap && pathMap.length
    ? pathMap
    : makePathMap(paths, { workspace: from.workspace, home: from.home }, s.cwd && cwd ? [[s.cwd, cwd]] : []));
  const sid = fork ? crypto.randomUUID() : String(s.id);
  const sidecars = [];
  for (const f of files) {
    if (!f.name.startsWith("sidecar/")) continue;
    const rel = f.name.slice("sidecar/".length);
    if (!safeRel(rel)) continue;
    let data = f.data;
    // 工具产物里的 JSON / 文本也可能带绝对路径（截图说明、导出清单、脚本），一起改
    if (pm.length && data.length <= 16 * 1024 * 1024 && TEXT_EXT.has(path.extname(rel).toLowerCase())) {
      const txt = data.toString("utf8");
      const mapped = mapPathString(txt, pm);
      if (mapped !== txt) data = Buffer.from(mapped, "utf8");
    }
    sidecars.push({ name: rel, data });
  }
  // 内容产物：写进本机工作区（transcript 里的路径已经映射到这里了）
  const artFile = files.find((f) => f.name === "artifacts.json");
  const arts = artFile ? unpackArtifacts(paths, files, artFile.data) : { written: 0, bytes: 0, total: 0 };
  const title = String(s.title || "").slice(0, 100) || "会话";
  const out = writeSession(paths, {
    id: sid, oldId: String(s.id), sessionId: sid,
    title: fork ? `${title} · ${titleSuffix || "副本"}` : title,
    cwd, mtime: s.mtime, buf: main.data, sidecars, fork, pathMap: pm,
  });
  return { ...out, meta: s, artifacts: arts, title: fork ? `${title} · ${titleSuffix || "副本"}` : title };
}
