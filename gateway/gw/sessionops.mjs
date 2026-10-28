import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { CFG, LAST_LANG, PATHS, log, tr, tz } from "./config.mjs";
import { NAMES, PEEK_CACHE, PINS, findSessionFile, peekSession, saveNames, savePins } from "./sessions.mjs";
import { claudeCmd, claudeEnv, killTree } from "./claude.mjs";
import { LAST_SESSION, forgetSession, runOfSession } from "./runs.mjs";
import { forgetChild, recordPrimary } from "./lineage-store.mjs";

// ── 会话管理：回收站 / 导出 / 导入 ─────────────────────────────────────
// 回收站放在 claude 的 projects 目录之外（它看不见，--resume 也就找不回来），同一文件系统，挪进挪出都是 rename。
// 每个会话一格：<id>.jsonl + 同名目录（子代理、超长工具结果）+ meta.json（原项目目录、标题、删除时间）。
const TRASH_DIR = path.join(CFG.home, ".ccapp-trash");
export const TRASH_KEEP_DAYS = 30;
// 只当单个目录名用：不许全是点（「.」「..」拼进路径就跳出了所在目录，回收站清理曾因此删掉整个 home）
export const SID_RE = /^(?!\.+$)[A-Za-z0-9._-]{1,200}$/;

// ── 分叉：从某一轮之后另起一个会话 ──
// 把 transcript 从头抄到「这一轮的最后一行」（下一条用户消息之前），换个会话号写成新文件。
// 和 claude 自带的 --fork-session 是一回事，只是能挑从哪一轮分。原会话一个字节都不动。
// 定位那一轮：前端给出这一轮的用户消息原文 + 它后面还有几条用户消息（after）。
// 斜杠命令在界面上有气泡、在 transcript 里却是 <command-name> 行，单靠计数会错位，
// 所以先按原文找候选，再取倒数位置最接近 after 的那条；原文一条都对不上就拒绝，绝不切错地方。
const forkNorm = (t) => String(t || "").replace(/\[图片\]/g, "").replace(/\s+/g, " ").trim();
function forkUserText(ev) {
  if (!ev || ev.type !== "user" || ev.isSidechain || ev.isMeta || ev.isCompactSummary) return null;
  const c = ev.message?.content;
  if (typeof c === "string") return c && !c.startsWith("<") ? c : null;
  if (!Array.isArray(c)) return null;
  const texts = c.filter((x) => x.type === "text" && x.text && !x.text.startsWith("<")).map((x) => x.text);
  if (c.some((x) => x.type === "image")) texts.push("[图片]");
  return texts.length ? texts.join("\n") : null;
}

// ── 分叉（续）/ 回退 / 回收站 / 导出导入 ───────────────────────────────
export function locateUserTurn(id, userText, after) {
  const found = findSessionFile(id);
  if (!found) return { ok: false, status: 404, message: tz("找不到这个会话。") };
  const lines = fs.readFileSync(found.file, "utf8").split("\n");
  const users = [];
  lines.forEach((line, i) => {
    if (!line.includes('"user"')) return;
    let ev; try { ev = JSON.parse(line); } catch { return; }
    const t = forkUserText(ev);
    if (t != null) users.push({ i, t: forkNorm(t), uuid: ev.uuid || null });
  });
  const want = forkNorm(userText), head = want.slice(0, 80);
  const same = (t) => t === want || (head.length >= 8 && (t.startsWith(head) || want.startsWith(t.slice(0, 80))));
  let best = -1;
  users.forEach((u, j) => {
    if (!same(u.t)) return;
    const d = Math.abs(users.length - 1 - j - (Number(after) || 0));
    if (best < 0 || d < Math.abs(users.length - 1 - best - (Number(after) || 0))) best = j;
  });
  if (best < 0) return { ok: false, status: 409, message: tz("在会话记录里找不到这一轮，刷新后再试。") };
  return { ok: true, found, lines, users, best };
}

export function forkSession(id, userText, after, { before = false } = {}) {
  const loc = locateUserTurn(id, userText, after);
  if (!loc.ok) return loc;
  const { found, lines, users } = loc;
  const best = before ? loc.best - 1 : loc.best;      // 回退：只留这条之前的
  const cut = best + 1 < users.length ? users[best + 1].i : lines.length;
  if (cut === lines.length && runOfSession(id)) return { ok: false, status: 409, message: tz("这一轮还在生成，等它答完再分叉。") };
  const nid = crypto.randomUUID();
  const out = [];
  let at = null;   // 分叉点：抄过去的最后一条链上消息（脉络的主父记录用）
  for (const line of lines.slice(0, cut)) {
    if (!line.trim()) continue;
    if (line.includes('"uuid"')) { try { const e = JSON.parse(line); if (e.uuid && !e.isSidechain && /^(user|assistant|system)$/.test(e.type)) at = e.uuid; } catch {} }
    if (!line.includes(id)) { out.push(line); continue; }
    try { const ev = JSON.parse(line); if (ev.sessionId === id) ev.sessionId = nid; out.push(JSON.stringify(ev)); }
    catch { out.push(line); }
  }
  const dir = path.dirname(found.file);
  fs.writeFileSync(path.join(dir, nid + ".jsonl"), out.join("\n") + "\n");
  // 同名目录里是子代理记录、超长工具结果：一起抄过去，引用它们的路径照旧有效
  const side = path.join(dir, id);
  try { if (fs.statSync(side).isDirectory()) fs.cpSync(side, path.join(dir, nid), { recursive: true }); } catch {}
  const title = (NAMES[id] || peekSession(found.file).title || "").slice(0, 100);
  NAMES[nid] = title + " · " + tr(LAST_LANG, before ? tz("回退") : tz("分叉")); saveNames();
  recordPrimary(nid, id, at, before ? "rewind" : "fork");
  log(`会话分叉 ${id.slice(0, 8)} → ${nid.slice(0, 8)}（保留 ${best + 1}/${users.length} 轮）`);
  return { ok: true, id: nid, title: NAMES[nid], kept: best + 1, total: users.length };
}

// ── 删一条消息：用户的一条提问，或 Claude 的一整条回复（含它的工具调用和结果） ──
// 原地改 transcript：删掉的行从文件里拿走，后面挂在它们身上的行（parentUuid）顺着链接到最近一个没删的祖先，
// claude 下一轮 --resume 沿 parentUuid 回溯时就看不到它们了。改前整份抄进回收站的 .edits/（留 30 天），撤销就是抄回来。
// 文件检查点（file-history-snapshot）、摘要这些不在对话链上的行不动。
const EDITS_DIR = path.join(TRASH_DIR, ".edits");
const UNDO = new Map();   // 会话号 → 最近一次删消息的 { backup, size, mtime }：撤销前核对文件没再变过
const CHAIN_TYPES = new Set(["user", "assistant", "system", "progress", "attachment"]);
export function deleteMessage(id, userText, after, which) {
  if (runOfSession(id)) return { ok: false, status: 409, message: tz("这个会话正在生成中，等它答完再删。") };
  const loc = locateUserTurn(id, userText, after);
  if (!loc.ok) return loc;
  const { found, lines, users, best } = loc;
  const from = users[best].i, to = best + 1 < users.length ? users[best + 1].i : lines.length;
  const drop = new Set();
  if (which === "user") drop.add(from);
  else for (let i = from + 1; i < to; i++) {
    const l = lines[i]; if (!l.trim()) continue;
    try { const ev = JSON.parse(l); if (CHAIN_TYPES.has(ev.type) && !ev.isSidechain) drop.add(i); } catch {}
  }
  if (!drop.size) return { ok: false, status: 409, message: tz("这条消息在会话记录里没有可删的内容。") };
  const parentOf = new Map();
  for (const i of drop) { try { const ev = JSON.parse(lines[i]); if (ev.uuid) parentOf.set(ev.uuid, ev.parentUuid ?? null); } catch {} }
  const up = (u) => { let n = 0; while (u && parentOf.has(u) && n++ < 100000) u = parentOf.get(u); return u; };
  const out = [];
  lines.forEach((l, i) => {
    if (drop.has(i) || !l.trim()) return;
    if (!parentOf.size || !l.includes("arentUuid")) return out.push(l);
    let ev; try { ev = JSON.parse(l); } catch { return out.push(l); }
    let ch = false;
    for (const k of ["parentUuid", "logicalParentUuid"]) if (ev[k] && parentOf.has(ev[k])) { ev[k] = up(ev[k]); ch = true; }
    out.push(ch ? JSON.stringify(ev) : l);
  });
  const bdir = EDITS_DIR;
  fs.mkdirSync(bdir, { recursive: true });
  const backup = id + "." + Date.now() + ".jsonl";
  fs.copyFileSync(found.file, path.join(bdir, backup));
  const tmp = found.file + ".tmp-del";
  fs.writeFileSync(tmp, out.join("\n") + "\n");
  fs.renameSync(tmp, found.file);
  PEEK_CACHE.delete(found.file);
  const st = fs.statSync(found.file);
  UNDO.set(id, { backup, size: st.size, mtime: st.mtimeMs });
  log(`删消息 ${id.slice(0, 8)}：第 ${best + 1} 轮的${which === "user" ? "提问" : "回复"}，${drop.size} 行`);
  return { ok: true, removed: drop.size, undo: backup };
}
/** 撤销删消息：把备份抄回去。只认这次网关运行里最近一次删除，且之后会话文件没再变过（免得吞掉新的一轮） */
export function undoDelete(id, backup) {
  const u = UNDO.get(id);
  if (!u || u.backup !== backup) return { ok: false, status: 409, message: tz("只能撤销最近一次删除。") };
  if (runOfSession(id)) return { ok: false, status: 409, message: tz("这个会话正在生成中。") };
  const found = findSessionFile(id), src = path.join(EDITS_DIR, backup);
  if (!found || !fs.existsSync(src)) return { ok: false, status: 404, message: tz("备份已经不在了。") };
  const st = fs.statSync(found.file);
  if (st.size !== u.size || st.mtimeMs !== u.mtime) return { ok: false, status: 409, message: tz("删除之后会话又有了新内容，没法撤销。") };
  fs.copyFileSync(src, found.file);
  PEEK_CACHE.delete(found.file);
  UNDO.delete(id);
  log(`撤销删消息 ${id.slice(0, 8)}`);
  return { ok: true };
}

/** 把 Claude 改过的文件退回到某条用户消息之前（claude 的文件检查点，只覆盖 Edit / Write / NotebookEdit，命令改的不算）。
 *  每轮一个进程也没关系：检查点记在会话记录里，--resume 起来就能用（2026-10-19 实测）。dryRun 只算会动哪些文件。 */
export function rewindFiles(sid, userUuid, dryRun) {
  return new Promise((resolve) => {
    const [cmd0, args0] = claudeCmd(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--resume", sid]);
    const child = spawn(cmd0, args0, { cwd: fs.existsSync(CFG.workspace) ? CFG.workspace : CFG.home, env: claudeEnv(), stdio: ["pipe", "pipe", "pipe"], detached: true });
    let buf = "", done = false, err = "", exited = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(t); try { child.stdin.end(); } catch {} setTimeout(() => { if (!exited) killTree(child); }, 3000); resolve(r); };
    const t = setTimeout(() => finish({ ok: false, error: tz("回退超时") }), 60000);
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");   // 按流解码：多字节字符跨块不会被拆坏
    child.stdout.on("data", (d) => {
      buf += d; let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const l = buf.slice(0, i); buf = buf.slice(i + 1);
        let ev; try { ev = JSON.parse(l); } catch { continue; }
        if (ev.type !== "control_response") continue;
        const r = ev.response || {};
        if (r.subtype === "error") finish({ ok: false, error: String(r.error || "rewind failed") });
        else finish({ ok: true, ...(r.response || {}) });
      }
    });
    child.stderr.on("data", (d) => { err += d; });
    child.stdin.on("error", () => {});
    child.on("close", () => { exited = true; finish({ ok: false, error: err.trim().slice(-300) || "claude exited" }); });
    child.stdin.write(JSON.stringify({ type: "control_request", request_id: "rw-" + Date.now(), request: { subtype: "rewind_files", user_message_id: userUuid, dry_run: !!dryRun } }) + "\n");
  });
}

/** claude 自己的回退跨文件系统时会悄悄失败：备份在应用私有目录，工作区在 /sdcard（FUSE），
 *  改过的文件写不回去（新建的文件删得掉），响应照样说成功（2026-10-19 实测）。
 *  这里按会话记录里的快照逐个核对 files（试算给的清单），不对的自己从备份拷回去 / 删掉。
 *  目标状态：这条消息的快照里有 → 用它的备份（备份名为 null 表示那时文件不存在）；
 *  没有（之后才第一次改到）→ 用之后最早一份快照里的备份，那就是第一次改之前的样子。 */
export function rewindFixup(sessionFile, sid, uuid, files) {
  const snaps = [];   // [{ id, backups }]，同一条消息的快照更新合并进去
  try {
    for (const l of fs.readFileSync(sessionFile, "utf8").split("\n")) {
      // 两种记录：每条用户消息一份快照（file-history-snapshot）；轮次中途第一次改到某个文件时补一条 file-history-delta，挂到它所属的快照上
      const snap = l.includes('"file-history-snapshot"'), delta = l.includes('"file-history-delta"');
      if (!snap && !delta) continue;
      let ev; try { ev = JSON.parse(l); } catch { continue; }
      const sn = ev.snapshot || {}, id = delta ? ev.snapshotMessageId : (ev.messageId || sn.messageId);
      if (!id) continue;
      let cur = snaps.find((x) => x.id === id);
      if (!cur) snaps.push(cur = { id, backups: {} });
      if (delta) { if (ev.trackingPath && ev.backup) cur.backups[ev.trackingPath] = ev.backup; }
      else Object.assign(cur.backups, sn.trackedFileBackups || {});
    }
  } catch { return { fixed: 0, failed: 0 }; }
  const at = snaps.findIndex((x) => x.id === uuid);
  if (at < 0) return { fixed: 0, failed: 0 };
  const absOf = (k, b) => b && b.realParentDir ? path.join(b.realParentDir, path.basename(k)) : path.resolve(CFG.workspace, k);
  const hist = path.join(CFG.home, ".claude", "file-history", sid);
  let fixed = 0, failed = 0;
  for (const want of files || []) {
    let entry;
    for (let i = at; i < snaps.length && entry === undefined; i++) {
      for (const [k, b] of Object.entries(snaps[i].backups)) if (absOf(k, b) === want) { entry = b; break; }
    }
    if (entry === undefined) continue;                 // 快照里查不到：不碰
    try {
      if (!entry.backupFileName) {                     // 那时还不存在
        if (fs.existsSync(want)) { fs.unlinkSync(want); fixed++; }
        continue;
      }
      const src = path.join(hist, entry.backupFileName);
      const data = fs.readFileSync(src);
      let curr = null; try { curr = fs.readFileSync(want); } catch {}
      if (curr && curr.equals(data)) continue;
      fs.mkdirSync(path.dirname(want), { recursive: true });
      fs.writeFileSync(want, data);
      fixed++;
    } catch (e) { failed++; log(`回退补救失败 ${want}: ${e.message}`); }
  }
  return { fixed, failed };
}

export function trashSession(id) {
  const found = findSessionFile(id);
  if (!found) return { ok: false, error: "not found" };
  const meta = peekSession(found.file);
  const slot = path.join(TRASH_DIR, id);
  fs.rmSync(slot, { recursive: true, force: true });
  fs.mkdirSync(slot, { recursive: true });
  const st = fs.statSync(found.file);
  fs.renameSync(found.file, path.join(slot, id + ".jsonl"));
  const side = path.join(PATHS.projects, found.project, id);
  if (fs.existsSync(side)) fs.renameSync(side, path.join(slot, "dir"));
  fs.writeFileSync(path.join(slot, "meta.json"), JSON.stringify({
    id, project: found.project, title: NAMES[id] || meta.title, renamed: !!NAMES[id], pinned: PINS[id] || 0,
    cwd: meta.cwd, mtime: st.mtimeMs, size: st.size, deletedAt: Date.now(),
  }));
  if (PINS[id]) { delete PINS[id]; savePins(); }
  PEEK_CACHE.delete(found.file);
  delete NAMES[id]; saveNames();
  // 删的正好是「最近跑过的那条」：别让前端下次打开时又指回去（会显示「找不到这个会话」而不是欢迎页）
  if (LAST_SESSION && LAST_SESSION.id === id) forgetSession();
  return { ok: true };
}

export function listTrash() {
  let ids = [];
  try { ids = fs.readdirSync(TRASH_DIR); } catch { return []; }
  const out = [];
  for (const id of ids) {
    try { out.push(JSON.parse(fs.readFileSync(path.join(TRASH_DIR, id, "meta.json"), "utf8"))); } catch {}
  }
  return out.sort((a, b) => b.deletedAt - a.deletedAt);
}

export function restoreSession(id) {
  if (!SID_RE.test(id)) return { ok: false, error: "bad id" };
  const slot = path.join(TRASH_DIR, id);
  let meta;
  try { meta = JSON.parse(fs.readFileSync(path.join(slot, "meta.json"), "utf8")); } catch { return { ok: false, error: "not found" }; }
  if (findSessionFile(id)) return { ok: false, error: "exists" };
  const dir = path.join(PATHS.projects, SID_RE.test(meta.project || "") ? meta.project : projectSlug(realWorkspace()));
  fs.mkdirSync(dir, { recursive: true });
  fs.renameSync(path.join(slot, id + ".jsonl"), path.join(dir, id + ".jsonl"));
  if (fs.existsSync(path.join(slot, "dir"))) fs.renameSync(path.join(slot, "dir"), path.join(dir, id));
  if (meta.renamed && meta.title) { NAMES[id] = meta.title; saveNames(); }
  if (meta.pinned) { PINS[id] = meta.pinned; savePins(); }
  fs.rmSync(slot, { recursive: true, force: true });
  return { ok: true };
}

export function purgeTrash(ids) {
  let n = 0;
  for (const id of ids) {
    if (!SID_RE.test(id)) continue;
    const slot = path.join(TRASH_DIR, id);
    if (fs.existsSync(slot)) { fs.rmSync(slot, { recursive: true, force: true }); forgetChild(id); n++; }
  }
  return n;
}

/** 回收站里放满 30 天的自动清掉（网关启动时跑一次） */
export function expireTrash() {
  const cut = Date.now() - TRASH_KEEP_DAYS * 86400000;
  const old = listTrash().filter((m) => m.deletedAt < cut).map((m) => m.id);
  if (old.length) log(`回收站：清掉 ${purgeTrash(old)} 个放满 ${TRASH_KEEP_DAYS} 天的会话`);
  // 删消息留的备份也一样
  try { for (const f of fs.readdirSync(EDITS_DIR)) { const p = path.join(EDITS_DIR, f); if (fs.statSync(p).mtimeMs < cut) fs.rmSync(p, { force: true }); } } catch {}
}

/** claude 给 cwd 起项目目录名的规则：非字母数字一律换成 -。
 *  它拿的是解析过符号链接的真实路径（/sdcard → /storage/emulated/0），这边也得先 realpath，否则对不上 */
export function realWorkspace() { try { return fs.realpathSync(CFG.workspace); } catch { return CFG.workspace; } }
function projectSlug(cwd) { return String(cwd).replace(/[^A-Za-z0-9]/g, "-"); }

// 极简 zip（只 deflate / store，够会话包用）。不引第三方包：网关是单文件分发的
function zipBuild(entries) {
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

export function zipRead(buf, max = 512 * 1024 * 1024) {
  let e = buf.length - 22;
  let total = 0;
  const tooBig = () => new Error(tz("压缩包解开后太大（超过 {n} MB），没有导入", { n: Math.round(max / 1048576) }));
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error(tz("不是 zip 文件"));
  const n = buf.readUInt16LE(e + 10);
  let p = buf.readUInt32LE(e + 16);
  const out = [];
  for (let i = 0; i < n; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(tz("zip 目录损坏"));
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const lo = buf.readUInt32LE(p + 42);
    const usize = buf.readUInt32LE(p + 24);
    // Windows 上打的包可能用反斜杠分目录
    const name = buf.toString("utf8", p + 46, p + 46 + nlen).replace(/\\/g, "/");
    p += 46 + nlen + xlen + clen;
    if (name.endsWith("/")) continue;
    const ds = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
    const body = buf.subarray(ds, ds + csize);
    if (method !== 0 && method !== 8) throw new Error(tz("不支持的压缩方式：{name}", { name }));
    if ((total += usize) > max) throw tooBig();
    let data;
    try { data = method === 8 ? zlib.inflateRawSync(body, { maxOutputLength: max - total + usize }) : Buffer.from(body); }
    catch (err) { if (err.code === "ERR_BUFFER_TOO_LARGE" || err.code === "ERR_OUT_OF_RANGE") throw tooBig(); throw err; }
    total += data.length - usize;    // 目录里写的大小可能是假的：按实际解出来的算
    if (total > max) throw tooBig();
    out.push({ name, data });
  }
  return out;
}

/** 导出：manifest.json + sessions/<id>.jsonl + sessions/<id>/…（子代理等） */
export function exportSessions(ids) {
  const entries = [], list = [];
  const walk = (dir, rel) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, d.name);
      if (d.isDirectory()) walk(f, rel + "/" + d.name);
      else if (d.isFile()) entries.push({ name: rel + "/" + d.name, data: fs.readFileSync(f) });
    }
  };
  for (const id of ids) {
    const found = findSessionFile(id);
    if (!found) continue;
    const meta = peekSession(found.file);
    entries.push({ name: `sessions/${id}.jsonl`, data: fs.readFileSync(found.file) });
    const side = path.join(PATHS.projects, found.project, id);
    if (fs.existsSync(side)) walk(side, `sessions/${id}`);
    list.push({ id, title: NAMES[id] || meta.title, renamed: !!NAMES[id], cwd: meta.cwd, mtime: fs.statSync(found.file).mtimeMs });
  }
  if (!list.length) throw new Error(tz("没有可导出的会话"));
  entries.unshift({ name: "manifest.json", data: JSON.stringify({ format: "cccodroid-sessions", version: 1, exportedAt: Date.now(), sessions: list }, null, 1) });
  const base = process.env.CCAPP_SHARED && fs.existsSync(process.env.CCAPP_SHARED) ? process.env.CCAPP_SHARED : CFG.home;
  const dir = path.join(base, "exports");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  const file = path.join(dir, `sessions-${stamp}.zip`);
  const zip = zipBuild(entries);
  fs.writeFileSync(file, zip);
  return { file, count: list.length, bytes: zip.length };
}

/** 导入：一律落进当前工作区（cwd 改写成本机工作区，--resume 才找得到）；同 id 已有的跳过 */
export function importSessions(buf) {
  const files = zipRead(buf);
  const man = files.find((f) => f.name === "manifest.json");
  let manifest = {};
  try { manifest = JSON.parse(man.data.toString("utf8")); } catch { throw new Error(tz("缺少 manifest.json，不是会话包")); }
  if (manifest.format !== "cccodroid-sessions") throw new Error(tz("不是 cccodroid 会话包"));
  const ws = realWorkspace();
  const dir = path.join(PATHS.projects, projectSlug(ws));
  fs.mkdirSync(dir, { recursive: true });
  const res = { imported: [], skipped: [] };
  for (const s of manifest.sessions || []) {
    const id = String(s.id || "");
    if (!SID_RE.test(id)) continue;
    const main = files.find((f) => f.name === `sessions/${id}.jsonl`);
    if (!main) continue;
    if (findSessionFile(id) || fs.existsSync(path.join(TRASH_DIR, id))) { res.skipped.push(id); continue; }
    const lines = main.data.toString("utf8").split("\n").map((l) => {
      if (!l.includes('"cwd"')) return l;
      try { const ev = JSON.parse(l); if (ev.cwd) ev.cwd = ws; return JSON.stringify(ev); } catch { return l; }
    });
    fs.writeFileSync(path.join(dir, id + ".jsonl"), lines.join("\n"));
    if (s.mtime) try { fs.utimesSync(path.join(dir, id + ".jsonl"), new Date(), new Date(s.mtime)); } catch {}
    const pre = `sessions/${id}/`;
    for (const f of files) {
      if (!f.name.startsWith(pre)) continue;
      const rel = f.name.slice(pre.length);
      if (rel.split("/").some((x) => !x || x === "." || x === "..")) continue;   // 防目录穿越
      const dst = path.join(dir, id, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, f.data);
    }
    if (s.renamed && s.title) NAMES[id] = String(s.title).slice(0, 120);
    res.imported.push(id);
  }
  saveNames();
  return res;
}
