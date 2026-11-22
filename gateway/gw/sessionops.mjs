import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { Worker } from "node:worker_threads";
import { zipReadCore } from "./zipcore.mjs";
import { CFG, LAST_LANG, PATHS, PREFIX, log, tr, tz } from "./config.mjs";
import { NAMES, PEEK_CACHE, PINS, findSessionFile, peekSession, saveNames, savePins } from "./sessions.mjs";
import { agentsDir } from "./agents.mjs";
import { claudeBlocked, claudeCmd, claudeEnv, killTree } from "./claude.mjs";
import { sealed } from "./edition.mjs";
import { sessionRetention } from "./retention.mjs";
import { LAST_SESSION, TRASH_HOOKS, forgetSession, runOfSession } from "./runs.mjs";
import { forgetChild, recordPrimary } from "./lineage-store.mjs";
import { lineageForget } from "./lineage.mjs";
import { checkSession, forgetSeal, neutralizeMarkers, resealAfterEdit, sealSession, isInjected } from "./integrity.mjs";
import { ucPending } from "./userconf.mjs";
import { forEachLine, lineWriter, writeAll, zipEntries, zipExtract, zipToFile } from "./bigfile.mjs";
import { archiveDb, archiveForget, archiveImport, saveArchive } from "./archive-store.mjs";
import { isObj, loadState, saveState, stateUnread } from "./statefile.mjs";
import { noteManaged } from "./sessmanaged.mjs";

// ── 会话管理：回收站 / 导出 / 导入 ─────────────────────────────────────
// 回收站放在 claude 的 projects 目录之外（它看不见，--resume 也就找不回来），同一文件系统，挪进挪出都是 rename。
// 每个会话一格：<id>.jsonl + 同名目录（子代理、超长工具结果）+ meta.json（原项目目录、标题、删除时间）。
const TRASH_DIR = path.join(CFG.home, ".ccapp-trash");
export const TRASH_KEEP_DAYS = 30;
// 只当单个目录名用：不许全是点（「.」「..」拼进路径就跳出了所在目录，回收站清理曾因此删掉整个 home）
//  也不许是 __proto__ 这类：会话 id 要当对象的键用（封签表、标题表），会改到原型上（11-03 审查 L-2）
export const SID_RE = /^(?!\.+$)(?!(__proto__|constructor|prototype)$)[A-Za-z0-9._-]{1,200}$/;
/** 技能目录名（0.6.9 审计 195-J.5）：技能目录可以是中文或带空格的目录名，列得出来却删不掉。
 *  SID_RE 是为会话 id / 会话文件定的 ASCII 形状，不能拿来卡技能名；这里另起一条：
 *  只收 skills/ 下这次真列出来的那个名字（精确匹配），且必须是单个目录名——
 *  路径分隔符、NUL、「.」「..」一律不收（拼进路径会跳出 skills 目录）。 */
export function skillDirOk(dir, listed) {
  const s = typeof dir === "string" ? dir : "";
  if (!s || s.length > 200 || s === "." || s === ".." || /[/\\\0]/.test(s)) return false;
  return Array.isArray(listed) && listed.includes(s);
}

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
  if (typeof c === "string") return c && !isInjected(c) ? c : null;
  if (!Array.isArray(c)) return null;
  const texts = c.filter((x) => x.type === "text" && x.text && !isInjected(x.text)).map((x) => x.text);
  // 「图片随消息发」时原话里已有 @图片路径，不再补一行 [图片]
  if (c.some((x) => x.type === "image") && !texts.some((x) => /@\/\S+\.(png|jpe?g|gif|webp)\b/i.test(x))) texts.push("[图片]");
  return texts.length ? texts.join("\n") : null;
}

// ── 分叉（续）/ 回退 / 回收站 / 导出导入 ───────────────────────────────
// 界面给了这条消息的 uuid（从历史读出来的都有）就按 uuid 认；原文 + 后面还有几条只是兜底：
// 只读了中间一段时界面数不全后面的条数，同样的话问过两次就可能认到另一轮（审查 #49 P1-2）
export function locateUserTurn(id, userText, after, uuid = "", latest = false) {
  const found = findSessionFile(id);
  if (!found) return { ok: false, status: 404, message: tz("找不到这个会话。") };
  // 按行流式读（gw/bigfile.mjs）：会话 1 GB 以上时整份读成字符串会超过 V8 单串上限，分叉、回退、删消息全挂
  const users = [];
  const count = forEachLine(found.file, (line, i) => {
    if (!line.includes('"user"')) return;
    // 工具结果（带 toolUseResult 键）不是用户说的话：不解析，读几百 MB 的文件结果时省掉大部分时间（审查 v0513b 低-7）。
    // 认的是「,"toolUseResult":」——字符串值里的引号一定转义成 \"，正文里出现这个词不会被误认
    if (line.includes(',"toolUseResult":')) return;
    let ev; try { ev = JSON.parse(line); } catch { return; }
    const t = forkUserText(ev);
    // 只留比对要用的：全文的哈希和前 80 个字。存全文的话，每条都贴了大段文字的会话光这张表就能吃掉上 GB。
    // 前 80 字要另拷一份：V8 的 slice 只是切片，背后拽着整条原文不放
    if (t != null) { const n = forkNorm(t); users.push({ i, h: crypto.createHash("sha1").update(n).digest("hex"), t80: Buffer.from(n.slice(0, 80)).toString(), uuid: ev.uuid || null }); }
  });
  // 脉络卡片「从这里分叉」：不指哪一轮，就是最新一轮（整段抄过去）
  if (latest) return users.length ? { ok: true, found, count, users, best: users.length - 1 } : { ok: false, status: 409, message: tz("这个会话里还没有你的消息，没法分叉。") };
  if (uuid) {
    const j = users.findIndex((u) => u.uuid === uuid);
    if (j >= 0) return { ok: true, found, count, users, best: j };
    // 给了 uuid 却对不上：记录变过（压缩、别处改过），按原文猜可能认错轮，宁可让人刷新（#52 P1-2）
    return { ok: false, status: 409, message: tz("在会话记录里找不到这一轮，刷新后再试。") };
  }
  const want = forkNorm(neutralizeMarkers(userText)), head = want.slice(0, 80), wh = crypto.createHash("sha1").update(want).digest("hex");
  const same = (u) => u.h === wh || (head.length >= 8 && (u.t80.startsWith(head) || want.startsWith(u.t80)));
  // 没 uuid 的只会是这次刚发、还在尾巴上的消息，界面数「后面还有几条」是准的：
  // 只有一条同文就是它；好几条同文时必须恰好对上条数，对不上就拒绝，不挑「最接近的」去猜（#52 P1-2）
  const cand = users.map((u, j) => (same(u) ? j : -1)).filter((j) => j >= 0);
  const exact = cand.filter((j) => users.length - 1 - j === (Number(after) || 0));
  const best = cand.length === 1 ? cand[0] : exact.length === 1 ? exact[0] : -1;
  if (!cand.length) return { ok: false, status: 409, message: tz("在会话记录里找不到这一轮，刷新后再试。") };
  if (best < 0) return { ok: false, status: 409, message: tz("这句话在会话里出现了好几次，认不准是哪一轮。重新打开这个会话再试。") };
  return { ok: true, found, count, users, best };
}

export function forkSession(id, userText, after, { before = false, uuid = "", latest = false } = {}) {
  const loc = locateUserTurn(id, userText, after, uuid, latest && !before);
  if (!loc.ok) return loc;
  const { found, count, users } = loc;
  const best = before ? loc.best - 1 : loc.best;      // 回退：只留这条之前的
  const cut = best + 1 < users.length ? users[best + 1].i : count;
  if (cut === count && runOfSession(id)) return { ok: false, status: 409, message: tz("这一轮还在生成，等它答完再分叉。") };
  const nid = crypto.randomUUID();
  const dir = path.dirname(found.file);
  const dirty = checkSession(id, found.file);          // 原会话不干净（导入的、在别处改过的），分出来的也带着标记
  let at = null;   // 分叉点：抄过去的最后一条链上消息（脉络的主父记录用）
  // 先写临时文件，抄完再换名：写到一半被杀不会在列表里留下一个 UUID 合法、内容只到一半的新会话（195-Y.6）
  const finalFile = path.join(dir, nid + ".jsonl"), tmpFile = path.join(dir, nid + ".jsonl.part-" + process.pid);
  const w = lineWriter(tmpFile);
  try {
    forEachLine(found.file, (line, i) => {
      if (i >= cut) return false;
      if (!line.trim()) return;
      if (line.includes('"uuid"')) { try { const e = JSON.parse(line); if (e.uuid && !e.isSidechain && /^(user|assistant|system)$/.test(e.type)) at = e.uuid; } catch {} }
      if (!line.includes(id)) return w.write(line);
      // 解析失败才原样抄；写盘出错不能落进这个 catch 再写一遍（BUG-P02：重复行、坏行照样发布）
      let out = line;
      try { const ev = JSON.parse(line); if (ev.sessionId === id) { ev.sessionId = nid; out = JSON.stringify(ev); } } catch {}
      w.write(out);
    });
    w.close();      // flush + fsync 出错也算失败：删临时文件，不发布（BUG-P02）
  } catch (e) {
    try { w.close(); } catch {}
    try { fs.rmSync(tmpFile, { force: true }); } catch {}
    throw e;
  }
  // 同名目录里是子代理记录、超长工具结果：一起抄过去，引用它们的路径照旧有效
  // 抄不全就不分叉：分出来的会话读不到子代理过程，还报成功（#98 03-003 同类）。原会话没动，删掉抄了一半的
  const side = path.join(dir, id);
  let sideDir = false; try { sideDir = fs.statSync(side).isDirectory(); } catch {}
  if (sideDir) try { fs.cpSync(side, path.join(dir, nid), { recursive: true }); }
  catch (e) {
    fs.rmSync(path.join(dir, nid), { recursive: true, force: true });
    fs.rmSync(tmpFile, { force: true });
    return { ok: false, status: 500, message: tz("会话附带的文件没抄过去，没有分叉：{err}", { err: e.code || e.message }) };
  }
  try { fs.renameSync(tmpFile, finalFile); }
  catch (e) { fs.rmSync(path.join(dir, nid), { recursive: true, force: true }); fs.rmSync(tmpFile, { force: true }); return { ok: false, status: 500, message: tz("分叉的会话没能落盘：{err}", { err: e.code || e.message }) }; }
  sealSession(nid, finalFile, { flag: dirty || undefined });
  noteManaged(nid);   // 新会话号是网关起的：不记的话会被当成外部会话归进杂项
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
const UNDO = new Map();
// UNDO：会话号 → 最近一次删消息的 { backup, size, mtime }：撤销前核对文件没再变过
// ORPHAN_HEADS：会话号 → 提问被删掉的那几轮回复的第一行 uuid（见 deleteMessage 里的 B04）。
// 以前只在内存里：网关重启后守卫失效，删那条合并气泡会把上一轮的回复一起删掉（195-A.1）。落盘保存
const ORPHAN_FILE = path.join(CFG.home, "ccapp-session-orphans.json");
const ORPHAN_HEADS = new Map();
function loadOrphans() {
  const r = loadState(ORPHAN_FILE, {
    shape: (j) => {
      if (!isObj(j)) return undefined;
      const o = {};
      for (const [k, v] of Object.entries(j)) if (Array.isArray(v)) o[k] = v.filter((x) => typeof x === "string").slice(-200);
      return o;
    },
    fallback: () => ({}),
  });
  // 读盘故障解除后再补旧表；不能拿空的回落值当成已清理。
  if (r.bad && !r.kept) return false;
  for (const [k, v] of Object.entries(r.data)) if (v.length && !ORPHAN_HEADS.has(k)) ORPHAN_HEADS.set(k, new Set(v));
  return true;
}
loadOrphans();
function saveOrphans() {
  const o = {};
  for (const [k, s] of ORPHAN_HEADS) if (s.size) o[k] = [...s].slice(-200);
  const keys = Object.keys(o);
  for (const k of keys.slice(0, Math.max(0, keys.length - 3000))) delete o[k];   // 只增不减（200-6-05）
  return saveState(ORPHAN_FILE, o, { pretty: false });
}
// 删消息的整份备份会越攒越多（本机 63 MB）：每个会话只留最近 20 份、全局最多 300 份（195-A.10）
const EDITS_PER_SID = 20, EDITS_MAX_FILES = 300;
function pruneEdits(sid) {
  let names = [];
  try { names = fs.readdirSync(EDITS_DIR); } catch { return; }
  const mine = names.filter((n) => n.startsWith(sid + ".")).sort();
  for (const n of mine.slice(0, Math.max(0, mine.length - EDITS_PER_SID))) { try { fs.rmSync(path.join(EDITS_DIR, n), { force: true }); } catch {} }
  if (names.length <= EDITS_MAX_FILES) return;
  const old = names.map((n) => { let t = 0; try { t = fs.statSync(path.join(EDITS_DIR, n)).mtimeMs; } catch {} return { n, t }; }).sort((a, b) => a.t - b.t);
  for (const { n } of old.slice(0, names.length - EDITS_MAX_FILES)) { try { fs.rmSync(path.join(EDITS_DIR, n), { force: true }); } catch {} }
}
const CHAIN_TYPES = new Set(["user", "assistant", "system", "progress", "attachment"]);
export function deleteMessage(id, userText, after, which, uuid = "", replyUuid = "", offs = []) {
  if (runOfSession(id)) return { ok: false, status: 409, message: tz("这个会话正在生成中，等它答完再删。") };
  const loc = locateUserTurn(id, userText, after, uuid);
  if (!loc.ok) return loc;
  const { found, count, users, best } = loc;
  const from = users[best].i, to = best + 1 < users.length ? users[best + 1].i : count;
  // 第二遍只看这一轮的行：哪些要删、它们各自的父消息
  const drop = new Set(), parentOf = new Map();
  forEachLine(found.file, (l, i) => {
    if (i >= to) return false;
    if (i < from || (which === "user" ? i !== from : i === from) || !l.trim()) return;
    let ev; try { ev = JSON.parse(l); } catch { return; }
    if (which !== "user" && !(CHAIN_TYPES.has(ev.type) && !ev.isSidechain)) return;
    // 回复中途压缩过：压缩边界和摘要是章节分界，不属于这条回复。删了它章号整体前移、按章号存的题名就套错章（审查 B11）
    if (which !== "user" && (ev.isCompactSummary || (ev.type === "system" && ev.subtype === "compact_boundary"))) return;
    drop.add(i);
    if (ev.uuid) parentOf.set(ev.uuid, ev.parentUuid ?? null);
  });
  if (!drop.size) return { ok: false, status: 409, message: tz("这条消息在会话记录里没有可删的内容。") };
  // 界面给了回复自己的 uuid：它必须在这一轮要删的行里；而且不能落在「提问已删掉的回复」起点或之后——那时界面把它当成单独一轮，
  // 记录里它却和上一轮的回复连成一片，按轮删会把上一轮的回复一起带走（审查 B04）。重新打开会话后两段画成一个气泡，带的是前一段的 uuid，照常放行
  if (which !== "user" && replyUuid) {
    if (!parentOf.has(replyUuid)) return { ok: false, status: 409, message: tz("这条回复和会话记录对不上，重新打开会话再删。") };
    const heads = ORPHAN_HEADS.get(id), order = [...parentOf.keys()];
    if (heads && order.slice(0, order.indexOf(replyUuid) + 1).some((u) => heads.has(u)))
      return { ok: false, status: 409, message: tz("这条回复的提问已经删掉了，没法再单独删它。撤销刚才的删除，或者先删回复再删提问。") };
  }
  const up = (u) => { let n = 0; while (u && parentOf.has(u) && n++ < 100000) u = parentOf.get(u); return u; };
  const bdir = EDITS_DIR;
  fs.mkdirSync(bdir, { recursive: true });
  const backup = id + "." + Date.now() + ".jsonl";
  fs.copyFileSync(found.file, path.join(bdir, backup));
  const dirty = checkSession(id, found.file);          // 改之前先核对，改完重新封签：网关自己改的不算外部改动，原本不干净的也不洗白
  const tmp = found.file + ".tmp-del";
  const w = lineWriter(tmp);
  // 界面手里的字节游标（续读起点、各页起止）换算成改写后的位置：删掉的行、改了父链接的行都会让后面的偏移挪动，
  // 拿旧偏移接着往下读会跳过没读的内容（#153-1）。旧偏移 X → 改写后第一条旧起点 ≥ X 的行的新起点
  const want = [...new Set(offs)].filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  const moved = {};
  let oldAt = 0, newAt = 0, k = 0;
  const put = (s) => { w.write(s); newAt += Buffer.byteLength(s) + 1; };
  try {
    forEachLine(found.file, (l, i) => {
      for (; k < want.length && want[k] <= oldAt; k++) moved[want[k]] = newAt;
      oldAt += Buffer.byteLength(l) + 1;
      if (drop.has(i) || !l.trim()) return;
      if (!parentOf.size || !l.includes("arentUuid")) return put(l);
      let ev; try { ev = JSON.parse(l); } catch { return put(l); }
      let ch = false;
      for (const k of ["parentUuid", "logicalParentUuid"]) if (ev[k] && parentOf.has(ev[k])) { ev[k] = up(ev[k]); ch = true; }
      put(ch ? JSON.stringify(ev) : l);
    });
    for (; k < want.length; k++) moved[want[k]] = newAt;
    w.close();      // flush + fsync 出错也算失败：删临时文件，不发布（BUG-P02）
  } catch (e) {
    // 清理自身别再抛：否则原始错误被盖住、临时文件也留在原处（200-8-04）
    try { w.close(); } catch {}
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
  fs.renameSync(tmp, found.file);
  resealAfterEdit(id, found.file, dirty);
  PEEK_CACHE.delete(found.file);
  lineageForget(id);
  if (which === "user") {
    // 记下这一轮回复的起点：之后界面再单独删它，要能认出来（文件已经换掉，按旧行号从备份里找）
    let head = null;
    forEachLine(path.join(bdir, backup), (l, i) => {
      if (head || i <= from || i >= to || !l.trim()) return head ? false : undefined;
      try { const ev = JSON.parse(l); if (ev.uuid && CHAIN_TYPES.has(ev.type) && !ev.isSidechain) head = ev.uuid; } catch {}
    });
    if (head) { if (!ORPHAN_HEADS.has(id)) ORPHAN_HEADS.set(id, new Set()); ORPHAN_HEADS.get(id).add(head); saveOrphans(); }
  }
  pruneEdits(id);
  const st = fs.statSync(found.file);
  UNDO.set(id, { backup, size: st.size, mtime: st.mtimeMs });
  log(`删消息 ${id.slice(0, 8)}：第 ${best + 1} 轮的${which === "user" ? "提问" : "回复"}，${drop.size} 行`);
  return { ok: true, removed: drop.size, undo: backup, moved, size: st.size };
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
  const dirty = checkSession(id, found.file);
  // 直接 copyFileSync 到活文件会先截断：写一半被杀/满盘会毁掉会话，而备份还在、size/mtime 校验却让重试被 409。
  // 先抄到同目录临时文件，成功后再 rename 替换。
  const tmp = found.file + ".undo-" + process.pid;
  try { fs.copyFileSync(src, tmp); fs.renameSync(tmp, found.file); }
  catch (e) { try { fs.rmSync(tmp, { force: true }); } catch {} throw e; }
  lineageForget(id);
  resealAfterEdit(id, found.file, dirty);
  PEEK_CACHE.delete(found.file);
  UNDO.delete(id);
  ORPHAN_HEADS.delete(id); saveOrphans();   // 抄回删之前的样子：提问回来了，界面也整份重开
  log(`撤销删消息 ${id.slice(0, 8)}`);
  return { ok: true };
}

/** 把 Claude 改过的文件退回到某条用户消息之前（claude 的文件检查点，只覆盖 Edit / Write / NotebookEdit，命令改的不算）。
 *  每轮一个进程也没关系：检查点记在会话记录里，--resume 起来就能用（2026-10-19 实测）。dryRun 只算会动哪些文件。 */
export async function rewindFiles(sid, userUuid, dryRun) {
  // 这里也 --resume 起了 claude：它要是往记录里写了什么，是我们起的，不算外部改动（见 integrity.mjs）
  const sf = findSessionFile(sid)?.file, dirty = checkSession(sid, sf);
  // 起 claude 就会加载用户级钩子：有没确认的改动先别起（见 userconf.mjs），发一条消息在卡片里处理
  if (!sealed() && ucPending()) return { ok: false, error: tz("Claude Code 的用户级配置有改动还没确认。先发一条消息，在弹出的卡片里确认后再试。") };
  const blocked = await claudeBlocked();
  if (blocked) return { ok: false, error: blocked };
  // --resume 只在会话原本所在的项目目录里找得到（同 run.mjs）：不能写死 CFG.workspace，否则项目会话回退必败
  const sessCwd = sf ? peekSession(sf)?.cwd : "";
  const cwd = sessCwd && fs.existsSync(sessCwd) ? sessCwd : (fs.existsSync(CFG.workspace) ? CFG.workspace : CFG.home);
  return new Promise((resolve) => {
    // 试算也会 --resume，和普通对话一样不能让默认或项目保留期清扫会话。
    const [cmd0, args0] = claudeCmd(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--resume", sid,
      "--settings", JSON.stringify({ cleanupPeriodDays: sessionRetention().days })]);
    const child = spawn(cmd0, args0, { cwd, env: claudeEnv(), stdio: ["pipe", "pipe", "pipe"], detached: true });
    let buf = "", done = false, err = "", exited = false, pendingRes = null, killTimer = null;
    const settle = (r) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      if (killTimer) clearTimeout(killTimer);
      resolve(r);
    };
    // 收到 control_response 后先结束 stdin 等进程退出并 resealAfterEdit 再返回，避免紧随其后的续聊撞上旧封条；
    // 最多等 3 秒强杀，防止子进程挂死拖住请求
    const finish = (r) => {
      if (done || pendingRes) return;
      pendingRes = r;
      clearTimeout(t);
      try { child.stdin.end(); } catch {}
      if (exited) { if (sf) resealAfterEdit(sid, sf, dirty); settle(r); return; }
      killTimer = setTimeout(() => { if (!exited) killTree(child); }, 3000);
    };
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
    // spawn 失败（loader 缺失/EACCES/ENOMEM）只发 error：不接就是未捕获异常，整个网关退出
    child.on("error", (e) => { exited = true; settle({ ok: false, error: e.code || e.message }); });
    child.stdin.on("error", () => {});
    child.on("close", () => {
      exited = true;
      if (sf) resealAfterEdit(sid, sf, dirty);
      settle(pendingRes || { ok: false, error: err.trim().slice(-300) || "claude exited" });
    });
    child.stdin.write(JSON.stringify({ type: "control_request", request_id: "rw-" + Date.now(), request: { subtype: "rewind_files", user_message_id: userUuid, dry_run: !!dryRun } }) + "\n");
  });
}

/** claude 自己的回退跨文件系统时会悄悄失败：备份在应用私有目录，工作区在 /sdcard（FUSE），
 *  改过的文件写不回去（新建的文件删得掉），响应照样说成功（2026-10-19 实测）。
 *  这里按会话记录里的快照逐个核对 files（试算给的清单），不对的自己从备份拷回去 / 删掉。
 *  目标状态：这条消息的快照里有 → 用它的备份（备份名为 null 表示那时文件不存在）；
 *  没有（之后才第一次改到）→ 用之后最早一份快照里的备份，那就是第一次改之前的样子。 */
// 回退补救要写的地方：会话记录（可以是导入进来的）决定写哪、写什么，所以应用私有目录里只许写工作区——
// 不然一个构造的会话能把备份写进 ~/.bashrc、~/.claude/settings.json 这类文件，下次启动就跑起来（审查 v0.5.7 L6）。
// 工作区以外的项目目录（/sdcard 上的）照常，回退本来就要能改它们。按真实路径判，软链绕不过去
function realOf(p) {
  let cur = path.resolve(p), rest = "";
  for (;;) {
    try { return path.join(fs.realpathSync(cur), rest); } catch {}
    const up = path.dirname(cur);
    if (up === cur) return path.resolve(p);
    rest = path.join(path.basename(cur), rest); cur = up;
  }
}
const inside = (p, root) => p === root || p.startsWith(root + path.sep);
/** 会话记录里出现过的 cwd（老记录/导入包都可能有；用来限定回退补救能碰的目录）。
 *  只读前 500 行（forEachLine 返回 false 会提前停），避免在超大记录上多扫一遍。
 *  500 行之后才出现的 cwd 不会进 roots，那种项目的回退会被跳过（宁可少修，不写错地方）。 */
function sessionRoots(sessionFile) {
  const roots = new Set();
  let n = 0;
  try {
    forEachLine(sessionFile, (l) => {
      if (n++ >= 500) return false;
      if (!l.includes('"cwd"')) return;
      try { const e = JSON.parse(l); if (typeof e.cwd === "string" && path.isAbsolute(e.cwd)) roots.add(realOf(e.cwd)); } catch {}
    });
  } catch {}
  return [...roots];
}
export function rewindTargetOk(want, roots = []) {
  if (typeof want !== "string" || !path.isAbsolute(want)) return false;
  // 私有目录按整个 App 数据目录算（files 之外还有 shared_prefs、databases、app_webview…，11-03 审查 M-7）
  const r = realOf(want), ws = realOf(CFG.workspace), priv = realOf(path.dirname(path.dirname(CFG.home)));
  // 只允许工作区或这条会话自己记录过的项目目录：以前「不在私有目录内就放行」，
  // 导入的恶意会话能把 /sdcard 下的任意文件写/删掉（审查 11-05）
  if (r === ws) return false;
  if (inside(r, ws)) return true;
  if (inside(r, priv)) return false;   // .claude、shared_prefs 等私有数据，即使会话 cwd=home 也不许
  return roots.some((root) => { if (typeof root !== "string" || !root) return false; const rr = realOf(root); return rr !== ws && inside(r, rr); });
}
export function rewindFixup(sessionFile, sid, uuid, files) {
  const snaps = [];   // [{ id, backups }]，同一条消息的快照更新合并进去
  try {
    forEachLine(sessionFile, (l) => {
      // 两种记录：每条用户消息一份快照（file-history-snapshot）；轮次中途第一次改到某个文件时补一条 file-history-delta，挂到它所属的快照上
      const snap = l.includes('"file-history-snapshot"'), delta = l.includes('"file-history-delta"');
      if (!snap && !delta) return;
      let ev; try { ev = JSON.parse(l); } catch { return; }
      const sn = ev.snapshot || {}, id = delta ? ev.snapshotMessageId : (ev.messageId || sn.messageId);
      if (!id) return;
      let cur = snaps.find((x) => x.id === id);
      if (!cur) snaps.push(cur = { id, backups: {} });
      if (delta) { if (ev.trackingPath && ev.backup) cur.backups[ev.trackingPath] = ev.backup; }
      else Object.assign(cur.backups, sn.trackedFileBackups || {});
    });
  } catch { return { fixed: 0, failed: 0 }; }
  const at = snaps.findIndex((x) => x.id === uuid);
  if (at < 0) return { fixed: 0, failed: 0 };
  // 项目会话的相对快照路径相对该会话的 cwd，不能写死 CFG.workspace（同 rewindFiles）
  const sessCwd = peekSession(sessionFile)?.cwd;
  const roots = sessionRoots(sessionFile);
  const baseCwd = sessCwd && path.isAbsolute(sessCwd) ? sessCwd : (roots[0] || CFG.workspace);
  const absOf = (k, b) => b && b.realParentDir ? path.join(b.realParentDir, path.basename(k)) : path.resolve(baseCwd, k);
  const hist = path.join(CFG.home, ".claude", "file-history", sid);
  let fixed = 0, failed = 0;
  for (const want of files || []) {
    const wantReal = realOf(want);
    let entry;
    for (let i = at; i < snaps.length && entry === undefined; i++) {
      for (const [k, b] of Object.entries(snaps[i].backups)) {
        const p = absOf(k, b);
        if (p === want || realOf(p) === wantReal) { entry = b; break; }
      }
    }
    if (entry === undefined) continue;                 // 快照里查不到：不碰
    if (!rewindTargetOk(want, roots)) { failed++; log(`回退补救跳过 ${want}：不在工作区或这条会话的项目目录里`); continue; }
    // 备份文件名只许是 file-history 目录里的一个文件，不许带路径跳出去
    if (entry.backupFileName && (typeof entry.backupFileName !== "string" || entry.backupFileName !== path.basename(entry.backupFileName) || entry.backupFileName.startsWith("."))) { failed++; continue; }
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
      // 建完上级再按真实路径判一次（中途换成软链的），最后一段不跟软链
      if (!rewindTargetOk(want, roots)) { failed++; continue; }
      // 直接 O_TRUNC 写目标：满盘/写入中断会留下半截或空文件，原内容不在目标路径（195-Y.5）。
      // 先写同目录临时文件，写完 fsync 再换名；目标本身是软链/目录就不碰
      let mode = 0o644; try { const st = fs.lstatSync(want); if (!st.isFile()) { failed++; continue; } mode = st.mode & 0o777; } catch {}
      const tmp = path.join(path.dirname(want), `.rewind-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 6)}`);
      let fd = null;
      try {
        fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
        writeAll(fd, data); fs.fsyncSync(fd); fs.closeSync(fd); fd = null;
        if (!rewindTargetOk(want, roots)) throw new Error("target changed");
        try { if (!fs.lstatSync(want).isFile()) throw new Error("not a file"); } catch (e) { if (e.code !== "ENOENT") throw e; }
        fs.renameSync(tmp, want);
        fixed++;
      } catch (e) { try { if (fd != null) fs.closeSync(fd); } catch {} try { fs.rmSync(tmp, { force: true }); } catch {} throw e; }
    } catch (e) { failed++; log(`回退补救失败 ${want}: ${e.message}`); }
  }
  return { fixed, failed };
}

/** 目录里所有普通文件的大小（不跟软链）：回收站界面按 meta.total 报占用，附件目录以前没算（196-真机.2） */
function dirBytes(dir) {
  let total = 0, ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of ents) {
    const f = path.join(dir, e.name);
    try {
      if (e.isDirectory()) total += dirBytes(f);
      else total += fs.lstatSync(f).size;
    } catch {}
  }
  return total;
}

// meta.json 仍是回收站条目的入口。tx.v=1：moving → notify → ready → restoring 或 purging。
// 文件搬移以 dev/ino 判断实际落点，不靠「上一步写到哪」。notify 是可重放的提交后钩子；
// purging 一旦落盘就不可恢复，条目保留到文件和状态表都清理成功。
const TRASH_PHASES = new Set(["moving", "notify", "ready", "restoring", "purging"]);
const SID_BUSY = new Map();   // 跨异步解包 / 加载清理模块；同步搬移不让出事件循环
const validTrashId = (id) => typeof id === "string" && id !== ".edits" && SID_RE.test(id);
const validProject = (name) => typeof name === "string" && /^(?!\.+$)[A-Za-z0-9._-]{1,255}$/.test(name);
const validName = (name) => typeof name === "string" && name && name !== "." && name !== ".." && !/[/\\\0]/.test(name);
const isEditFor = (name, id) => name.startsWith(id + ".") && /^\d+\.jsonl$/.test(name.slice(id.length + 1));
function holdTrashId(id) {
  let resolve;
  const done = new Promise((r) => { resolve = r; });
  SID_BUSY.set(id, done);
  return () => { SID_BUSY.delete(id); resolve(); };
}
const absent = (f) => { try { return fs.lstatSync(f, { bigint: true }); } catch (e) { if (e.code === "ENOENT") return null; throw e; } };
const fileId = (st) => st ? `${st.dev}:${st.ino}` : null;
const validFileId = (s) => typeof s === "string" && /^\d+:\d+$/.test(s);
const slotOf = (id) => path.join(TRASH_DIR, id);
const mainIn = (slot, id) => path.join(slot, id + ".jsonl");
const sideIn = (slot) => path.join(slot, "dir");
const metaIn = (slot) => path.join(slot, "meta.json");
function syncDir(dir) {
  const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function trashError(code, message) { return Object.assign(new Error(message), { code }); }
const occupied = () => trashError("exists", tz("同名会话已存在"));
function writeTrash(slot, meta) {
  if (!saveState(metaIn(slot), meta, { pretty: false })) throw trashError("write_failed", tz("没保存上：存储满了或没有权限"));
  syncDir(slot);
}
function setTrashPhase(slot, meta, phase, extra = {}) {
  const next = { ...meta, tx: { ...meta.tx, phase, ...extra } };
  writeTrash(slot, next);
  return next;
}
function readTrash(slot, id) {
  const st = absent(slot);
  if (!st) return null;
  if (!st.isDirectory()) throw new Error(`Invalid trash slot: ${id}`);
  const mp = metaIn(slot), mst = absent(mp);
  if (!mst) {
    // 崩溃可能留下只建了目录、或只写了一半临时元数据的占位；里面不能有会话数据。
    if (fs.readdirSync(slot).every((n) => /^\.meta\.json\.tmp-[\da-z-]+$/.test(n))) return null;
    throw new Error(`Trash metadata missing: ${id}`);
  }
  if (!mst.isFile()) throw new Error(`Invalid trash metadata: ${id}`);
  const m = JSON.parse(fs.readFileSync(mp, "utf8"));
  if (!isObj(m) || m.id !== id) throw new Error(`Invalid trash metadata: ${id}`);
  const tx = m.tx;
  if (tx !== undefined && (!isObj(tx) || tx.v !== 1 || !TRASH_PHASES.has(tx.phase) ||
      !validFileId(tx.file) || (tx.side !== null && !validFileId(tx.side)) || !validProject(m.project) ||
      (tx.phase === "restoring" && !validProject(tx.target)) ||
      (tx.phase === "purging" && (!Array.isArray(tx.files) || tx.files.some((f) => !Array.isArray(f) || !cleanupPathOk(f[0], m) || !validFileId(f[1]))))))
    throw new Error(`Invalid trash transaction: ${id}`);
  return m;
}
function removeSlot(slot) {
  // 事务仍未完成时不能用 rm -r 删整格：meta 必须最后删。调用方先确认数据已搬回 / 删除。
  for (const n of fs.readdirSync(slot)) {
    if (n === "meta.json") continue;
    if (!/^\.meta\.json\.tmp-[\da-z-]+$/.test(n)) throw new Error(`Trash slot still contains data: ${path.basename(slot)}`);
    fs.rmSync(path.join(slot, n));
  }
  syncDir(slot);
  fs.rmSync(metaIn(slot), { force: true });
  fs.rmdirSync(slot);
  syncDir(TRASH_DIR);
}
function moveTrashEntry(src, dst, want) {
  if (fileId(absent(src)) !== want) throw new Error(`Trash source changed: ${path.basename(src)}`);
  if (absent(dst)) throw occupied();
  fs.renameSync(src, dst);
}
function syncMove(slot, dir) { syncDir(dir); syncDir(slot); }
function projectParts(project, id) {
  const dir = path.join(PATHS.projects, project);
  return { dir, file: path.join(dir, id + ".jsonl"), side: path.join(dir, id) };
}
function trashIds() {
  try { return fs.readdirSync(TRASH_DIR).filter(validTrashId); }
  catch (e) { if (e.code === "ENOENT") return []; throw e; }
}
// existsSync / findSessionFile 把 I/O 失败也当成没有：删按 SID 共用的状态之前不能这样判断。
function hasLiveCopy(id, except) {
  let dirs;
  try { dirs = fs.readdirSync(PATHS.projects, { withFileTypes: true }); }
  catch (e) { if (e.code === "ENOENT") return false; throw e; }
  return dirs.some((d) => d.isDirectory() && d.name !== except && !!absent(projectParts(d.name, id).file));
}
function updateTrashTable(table, save, id, value) {
  const before = Object.getOwnPropertyDescriptor(table, id);
  if (before?.value === value) return true;
  if (value === undefined) delete table[id]; else table[id] = value;
  if (save()) return true;
  if (before) Object.defineProperty(table, id, before); else delete table[id];
  return false;
}
function notifyTrash(id) {
  let failure;
  for (const f of TRASH_HOOKS) {
    try { f(id); } catch (e) { failure ??= e; log(`回收后续处理出错：${e.message}`); }
  }
  if (failure) throw failure;
}
function completeTrash(slot, meta) {
  const { id, project, tx } = meta;
  if (fileId(absent(mainIn(slot, id))) !== tx.file || fileId(absent(sideIn(slot))) !== tx.side)
    throw new Error(`Trash files changed: ${id}`);
  // 不能用旧的删除事件清掉同号新会话的引用，也不能当作钩子已成功而丢掉撤销依据。
  if (hasLiveCopy(id)) throw occupied();
  let ok = updateTrashTable(PINS, savePins, id, undefined);
  ok = updateTrashTable(NAMES, saveNames, id, undefined) && ok;
  if (LAST_SESSION?.id === id) ok = forgetSession() && ok;
  notifyTrash(id);
  if (!ok) throw trashError("write_failed", tz("没保存上：存储满了或没有权限"));
  syncDir(CFG.home);
  PEEK_CACHE.delete(projectParts(project, id).file);
  return setTrashPhase(slot, meta, "ready");
}
function settleTrashMove(slot, meta) {
  const { id, project, tx } = meta;
  const { dir, file, side } = projectParts(project, id);
  const mf = mainIn(slot, id), sd = sideIn(slot);
  const inFile = fileId(absent(mf)), inSide = fileId(absent(sd));
  if (inFile === tx.file && inSide === tx.side) {
    syncMove(slot, dir);
    return setTrashPhase(slot, meta, "notify");
  }
  // 只有一段成功：先把附件归位，再放回主记录。若中途同名路径被占，拒绝覆盖并保留事务。
  if (inSide) moveTrashEntry(sd, side, tx.side);
  else if (fileId(absent(side)) !== tx.side) throw new Error(`Trash attachment changed: ${id}`);
  if (inFile) moveTrashEntry(mf, file, tx.file);
  else if (fileId(absent(file)) !== tx.file) throw new Error(`Trash transcript changed: ${id}`);
  syncMove(slot, dir);
  removeSlot(slot);
  return null;
}
export function trashSession(id) {
  if (!validTrashId(id)) return { ok: false, error: "bad id" };
  if (SID_BUSY.has(id)) return { ok: false, error: "busy" };
  const slot = slotOf(id);
  if (absent(slot)) {
    const pending = reconcileSlot(id, false);
    if (pending) {
      if (pending.tx?.phase === "purging") return { ok: false, error: "purge_pending" };
      if (!hasLiveCopy(id)) {
        // 回收通知上次没落盘（notify）：把没跑完的钩子补完，按已删除返回；ready 的整条都在回收站，重删直接算成功。
        // 补跑失败就把底层错误报出来，别给误导性的「同名会话已存在」（复核 P2-3）
        if (pending.tx?.phase === "notify") {
          try { completeTrash(slot, pending); } catch (e) { return { ok: false, error: "write_failed", message: e.message }; }
        }
        return { ok: true };
      }
      return { ok: false, error: "exists", message: occupied().message };
    }
  }
  const found = findSessionFile(id);
  if (!found) return { ok: false, error: "not found" };
  const { file, project } = found;
  if (!validProject(project)) throw new Error("Invalid project directory");
  // 这些状态只按会话号索引；已有另一份活记录时不能先挪文件、到通知阶段才拒绝。
  if (hasLiveCopy(id, project)) return { ok: false, error: "exists", message: occupied().message };
  const { dir, side } = projectParts(project, id);
  const st = absent(file), sideSt = absent(side);
  if (!st?.isFile() || (sideSt && !sideSt.isDirectory())) throw new Error("Invalid session files");
  const { title, cwd } = peekSession(file), sideSize = dirBytes(side);
  const meta = { id, project, title: NAMES[id] || title, renamed: !!NAMES[id], pinned: PINS[id] || 0,
    cwd, mtime: Number(st.mtimeNs) / 1e6, size: Number(st.size), sideSize, total: Number(st.size) + sideSize, deletedAt: Date.now(),
    tx: { v: 1, phase: "moving", file: fileId(st), side: fileId(sideSt) } };
  fs.mkdirSync(TRASH_DIR, { recursive: true });
  fs.mkdirSync(slot);   // 不覆盖上一代回收站条目
  try {
    writeTrash(slot, meta);
    syncDir(TRASH_DIR);
    syncDir(CFG.home);
  } catch (e) {
    // 还没搬过任何东西；保留意图亦无害，恢复时按现有落点撤销。
    try { removeSlot(slot); } catch (err) { log(`回收占位清理失败 ${id}: ${err.message}`); }
    if (e.code === "write_failed") return { ok: false, error: e.code, message: e.message };
    throw e;
  }
  try {
    moveTrashEntry(file, mainIn(slot, id), meta.tx.file);
    if (sideSt) moveTrashEntry(side, sideIn(slot), meta.tx.side);
  } catch (e) {
    try { settleTrashMove(slot, meta); } catch (err) { throw new Error(`回收失败，等待恢复 ${id}: ${e.message}; ${err.message}`, { cause: e }); }
    throw e;
  }
  syncMove(slot, dir);
  completeTrash(slot, setTrashPhase(slot, meta, "notify"));
  return { ok: true };
}
/** 只把有证据的槽位当成明确删除，读错不能触发任何撤销。 */
export function trashPresence(id) {
  if (!validTrashId(id)) return "missing";
  const slot = slotOf(id);
  try {
    const m = readTrash(slot, id);
    if (!m) return "missing";
    const st = absent(mainIn(slot, id));
    const tx = m.tx;
    if (tx && tx.phase !== "purging" && (tx.phase === "moving" || tx.phase === "restoring" || fileId(st) !== tx.file)) return "unreadable";
    if (st?.isFile() || tx?.phase === "purging") return hasLiveCopy(id) ? "unreadable" : "present";
    return !tx && legacyRestoreTail(slot, m) ? "present" : "missing";
  } catch { return "unreadable"; }
}
export const inTrash = (id) => trashPresence(id) === "present";

export function listTrash({ strict = false } = {}) {
  const out = [];
  for (const id of trashIds()) {
    try {
      const slot = slotOf(id), m = readTrash(slot, id);
      if (!m || (!m.tx && !absent(mainIn(slot, id)) && !legacyRestoreTail(slot, m))) continue;
      const { tx, ...item } = m;
      if (tx?.phase === "purging") item.purgePending = true;
      out.push({ ...item, size: m.total ?? m.size });   // 老条目没有 total，仍报主记录大小
    } catch (e) {
      // 单格读错不挡住其他会话；用户明确选「清空」时不能跳过故障还报成功。
      if (strict) throw e;
      log(`回收站条目读不了 ${id}: ${e.message}`);
    }
  }
  return out.sort((a, b) => b.deletedAt - a.deletedAt);
}

const isDirPath = (d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } };
/** 把会话记录里的 cwd 改写成当前工作区（恢复 / 导入用来让 --resume 找得到）。临时文件 + 换名；改完重新封签 */
function rewriteCwd(file, cwd, sid) {
  const dirty = checkSession(sid, file);
  const tmp = file + ".cwd-" + process.pid;
  const w = lineWriter(tmp);
  try {
    forEachLine(file, (l) => {
      if (!l.includes('"cwd"')) return w.write(l);
      let out = l;     // 同 forkSession（BUG-P02）：只有解析失败才原样抄，写错照常往外抛
      try { const e = JSON.parse(l); if (e && typeof e.cwd === "string") { e.cwd = cwd; out = JSON.stringify(e); } } catch {}
      w.write(out);
    });
    w.close();      // flush + fsync 出错也算失败：删临时文件，不发布（BUG-P02）
  } catch (e) {
    try { w.close(); } catch {}
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
  fs.renameSync(tmp, file);
  resealAfterEdit(sid, file, dirty);
}

function saveRestoreMeta(meta) {
  const { id, title, renamed, pinned } = meta;
  if ((renamed && title && !updateTrashTable(NAMES, saveNames, id, title)) ||
      (pinned && !updateTrashTable(PINS, savePins, id, pinned))) return false;
  syncDir(CFG.home);
  return true;
}
function finishRestore(slot, meta, file) {
  removeSlot(slot);
  // 原 cwd 不见了则沿用以前的补救；改写会换掉 inode，要在搬移事务收口之后做。
  if (meta.cwd && !isDirPath(meta.cwd)) {
    try { rewriteCwd(file, realWorkspace(), meta.id); } catch (e) { log(`恢复会话：cwd 改写失败（${e.code || e.message}），保留原 cwd`); }
  }
}
function settleRestore(slot, meta) {
  const { id, tx } = meta;
  const { dir, file, side } = projectParts(tx.target, id);
  const mf = mainIn(slot, id), sd = sideIn(slot);
  const inFile = fileId(absent(mf)), inSide = fileId(absent(sd));
  if (!inFile && fileId(absent(file)) === tx.file) {
    if (inSide && inSide === tx.side) moveTrashEntry(sd, side, tx.side); // 老版已放回主记录，只差附件
    else if (inSide || fileId(absent(side)) !== tx.side) throw new Error(`Restore attachment changed: ${id}`);
    syncMove(slot, dir);
    finishRestore(slot, meta, file);
    return null;
  }
  if (inFile !== tx.file) throw new Error(`Restore transcript changed: ${id}`);
  if (inSide !== tx.side) moveTrashEntry(side, sd, tx.side);
  syncMove(slot, dir);
  // 会话仍在回收站。撤回刚为恢复写入的名字/置顶，不重放删除事件。
  if (!hasLiveCopy(id)) {
    if (!updateTrashTable(NAMES, saveNames, id, undefined) || !updateTrashTable(PINS, savePins, id, undefined))
      throw trashError("write_failed", tz("没保存上：存储满了或没有权限"));
    syncDir(CFG.home);
  }
  return setTrashPhase(slot, meta, "ready");
}
// 旧版没有 inode，只认原项目里大小、时间均吻合的记录。
function legacyMainMatches(st, meta) {
  return st?.isFile() && Number(st.size) === meta.size && Math.abs(Number(st.mtimeNs) / 1e6 - meta.mtime) < 1;
}
function legacyRestoreTail(slot, meta) {
  const { id, project } = meta;
  if (!validProject(project) || !Number.isFinite(meta.mtime) || hasLiveCopy(id, project)) return false;
  const { file, side } = projectParts(project, id);
  return !absent(mainIn(slot, id)) && absent(sideIn(slot))?.isDirectory() && !absent(side) && legacyMainMatches(absent(file), meta);
}
function reconcileSlot(id, hooks = true) {
  const slot = slotOf(id);
  let m = readTrash(slot, id);
  if (!m) { if (absent(slot)) removeSlot(slot); return null; }
  if (!m.tx) {
    const main = absent(mainIn(slot, id)), side = absent(sideIn(slot));
    if (!main) {
      // 老版可能在第一段换名前退出。只在原主记录吻合、槽里也没附件时清掉旧占位。
      if (!side && validProject(m.project) && legacyMainMatches(absent(projectParts(m.project, id).file), m)) {
        removeSlot(slot);
        return null;
      }
      return m; // 证据不足时不动原路径
    }
    if (!main.isFile() || (side && !side.isDirectory())) throw new Error(`Invalid legacy trash files: ${id}`);
    const project = validProject(m.project) ? m.project : projectSlug(realWorkspace());
    // 老版没有事务。完整槽位可以升级，旧版漏在项目目录里的附件不能凭 SID 判定归属。
    m = { ...m, project, tx: { v: 1, phase: "notify", file: fileId(main), side: fileId(side), ...(!side ? { legacyNoSide: true } : {}) } };
    if (m.total == null) m.total = m.size + (side ? dirBytes(sideIn(slot)) : 0);
    writeTrash(slot, m);
  }
  if (m.tx.phase === "moving") m = settleTrashMove(slot, m);
  else if (m.tx.phase === "restoring") m = settleRestore(slot, m);
  if (hooks && m?.tx?.phase === "notify") m = completeTrash(slot, m);
  return m;
}
/** 只能在网关拿到主端口后跑：先修文件供队列恢复使用，再在队列恢复之后重放通知。 */
export function recoverTrash({ hooks = true } = {}) {
  for (const id of trashIds()) {
    if (SID_BUSY.has(id)) continue;
    try { reconcileSlot(id, hooks); } catch (e) { log(`回收站恢复失败 ${id}: ${e.message}`); }
  }
}
function restoreUnlocked(id) {
  const slot = slotOf(id), before = readTrash(slot, id);
  let meta = reconcileSlot(id, false);
  if (!meta) return before?.tx?.phase === "restoring" ? { ok: true } : { ok: false, error: "not found" };
  if (meta.tx?.phase === "purging") return { ok: false, error: "purge_pending" };
  const target = validProject(meta.project) ? meta.project : projectSlug(realWorkspace());
  const { dir, file, side } = projectParts(target, id);
  const mf = mainIn(slot, id), sd = sideIn(slot), main = absent(mf), attached = absent(sd);
  if (runOfSession(id)) return { ok: false, error: "busy" };
  if (hasLiveCopy(id)) {
    // 老版先放回主记录留下的附件尾巴：只在原项目、记录身份吻合、附件目标空着时补回。
    if (main || !attached?.isDirectory() || absent(side) || hasLiveCopy(id, target)) return { ok: false, error: "exists" };
    const live = absent(file);
    if (!live?.isFile() || (meta.tx ? fileId(live) !== meta.tx.file || fileId(attached) !== meta.tx.side : !legacyRestoreTail(slot, meta)))
      return { ok: false, error: "exists" };
    if (!meta.tx) notifyTrash(id);  // 旧版有可能没跑完 post-commit 钩子；失败时槽位仍可辨认、重试
    if (!saveRestoreMeta(meta)) return { ok: false, error: "write_failed" };
    const normalized = meta.tx ? meta : { ...meta, tx: { v: 1, file: fileId(live), side: fileId(attached) } };
    const restoring = setTrashPhase(slot, normalized, "restoring", { target });
    settleRestore(slot, restoring);
    return { ok: true };
  }
  if (!main) return { ok: false, error: "not found" };
  if (fileId(main) !== meta.tx.file || fileId(attached) !== meta.tx.side) throw new Error(`Trash files changed: ${id}`);
  if (absent(side)) {
    // 旧版「主记录已进回收站、附件还留在项目目录」的中断状态：那目录正是没搬完的附件（主记录在格子里
    // 说明没有同号活副本），恢复时认作本会话附件、只搬回主记录，别让用户卡在无法恢复也无法清理（复核 P2-2）
    if (!(meta.tx?.legacyNoSide && !attached)) return { ok: false, error: "exists" }; // 不能吃掉早期留下的附件或同号导入正在写的数据
  }
  if (meta.tx.phase === "notify") meta = completeTrash(slot, meta);
  fs.mkdirSync(dir, { recursive: true });
  syncDir(PATHS.projects);
  const restoring = setTrashPhase(slot, meta, "restoring", { target });
  if (!saveRestoreMeta(meta)) {
    settleRestore(slot, restoring);
    return { ok: false, error: "write_failed" };
  }
  try {
    if (attached) moveTrashEntry(sd, side, meta.tx.side);
    moveTrashEntry(mf, file, meta.tx.file);
  } catch (e) {
    try { settleRestore(slot, restoring); } catch (err) { throw new Error(`恢复失败，等待恢复 ${id}: ${e.message}; ${err.message}`, { cause: e }); }
    throw e;
  }
  syncMove(slot, dir);
  finishRestore(slot, restoring, file);
  return { ok: true };
}
export function restoreSession(id) {
  if (!validTrashId(id)) return { ok: false, error: "bad id" };
  if (SID_BUSY.has(id)) return { ok: false, error: "busy" };
  return restoreUnlocked(id);
}

/** claude 放后台命令输出的地方：它的 TMPDIR（claudeEnv 给的 $PREFIX/tmp）下的 claude-<uid> */
export const claudeTmpRoot = () => path.join(PREFIX ? path.join(PREFIX, "tmp") : CFG.home, "claude-" + process.getuid());
function readDirIfPresent(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { if (e.code === "ENOENT") return []; throw e; }
}
function exactCleanupPaths({ id, cwd }) {
  const c = (...parts) => path.join(CFG.home, ".claude", ...parts);
  const files = [c("file-history", id), c("session-env", id), c("tasks", id), c("debug", id + ".txt")];
  // 联络簿只用 SID 前八位；保留存在同前缀会话时有歧义的目录。
  if (typeof cwd === "string" && path.isAbsolute(cwd) && validName(id.slice(0, 8))) {
    files.push(path.join(cwd, ".cccodroid", "agents", id.slice(0, 8)), agentsDir(cwd, id));
  }
  return files;
}
function cleanupPathOk(file, meta) {
  if (typeof file !== "string" || !path.isAbsolute(file) || path.normalize(file) !== file) return false;
  const { id } = meta;
  const tmp = path.relative(claudeTmpRoot(), file).split(path.sep);
  return exactCleanupPaths(meta).includes(file) ||
    (path.dirname(file) === EDITS_DIR && isEditFor(path.basename(file), id)) ||
    (tmp.length === 2 && validName(tmp[0]) && tmp[1] === id);
}
function cleanupFiles(id, meta) {
  const files = exactCleanupPaths(meta);
  const head = id.slice(0, 8);
  if (files.length > 4) {
    const collision = trashIds().some((x) => x !== id && x.startsWith(head)) || readDirIfPresent(PATHS.projects).some((d) =>
      d.isDirectory() && readDirIfPresent(path.join(PATHS.projects, d.name)).some((s) => s.name.startsWith(head) && s.name.endsWith(".jsonl") && s.name !== id + ".jsonl"));
    if (collision) files.length = 4;
  }
  for (const d of readDirIfPresent(claudeTmpRoot())) if (d.isDirectory() && validName(d.name)) files.push(path.join(claudeTmpRoot(), d.name, id));
  for (const d of readDirIfPresent(EDITS_DIR)) if (isEditFor(d.name, id)) files.push(path.join(EDITS_DIR, d.name));
  return [...new Set(files)].flatMap((f) => {
    const st = absent(f);
    return st ? [[f, fileId(st)]] : [];
  });
}
function removeCleanupFile(file, want, strict = false) {
  const st = absent(file);
  if (st && fileId(st) !== want) {
    if (strict) throw new Error(`Trash file changed: ${path.basename(file)}`);
    return;   // 路径已经被新一代使用，不能再按原路径删
  }
  if (st) fs.rmSync(file, { recursive: true, force: true });
  const dir = path.dirname(file);
  if (absent(dir)) syncDir(dir);
}
async function purgeUnlocked(id) {
  // 加载后再读状态。下面的检查、写意图、实际清理不让出事件循环。
  const [{ forgetSessModel }, { forgetBookmarks }] = await Promise.all([import("./sessmodel.mjs"), import("./bookmarks.mjs")]);
  const slot = slotOf(id);
  let meta = reconcileSlot(id, false);
  if (!meta) return false;
  if (!meta.tx) throw new Error(`Cannot purge an incomplete legacy trash slot: ${id}`);
  if (runOfSession(id)) throw trashError("busy", tz("这个会话正在生成中。"));
  const detached = hasLiveCopy(id);
  if (meta.tx.phase === "notify" && !detached) meta = completeTrash(slot, meta);
  if (meta.tx.phase !== "purging") {
    const main = mainIn(slot, id), side = sideIn(slot);
    if (fileId(absent(main)) !== meta.tx.file || fileId(absent(side)) !== meta.tx.side) throw new Error(`Trash files changed: ${id}`);
    if (!detached && meta.tx.legacyNoSide && absent(projectParts(meta.project, id).side))
      throw new Error(`旧回收站条目的附件仍在项目目录，无法确认归属：${id}`);
    // 同号已经有活会话，清理范围只能是回收站这格，不能碰共用的文件和状态表。
    meta = setTrashPhase(slot, meta, "purging", { files: detached ? [] : cleanupFiles(id, meta), detached });
  }
  if (detached && !meta.tx.detached) meta = setTrashPhase(slot, meta, "purging", { detached: true });
  // 换名成功但 fsync 失败后的重试也要先确认意图持久化，不能留下看似可恢复的半格。
  syncDir(slot);
  if (!meta.tx.detached) {
    for (const [f, want] of meta.tx.files) removeCleanupFile(f, want);
    for (const [name, forget] of [["archive", archiveForget], ["bookmarks", forgetBookmarks], ["session model", forgetSessModel], ["seal", forgetSeal], ["lineage", forgetChild]]) {
      if (!forget(id)) throw trashError("write_failed", `回收站清理失败 ${id}: ${name}`);
    }
    if (stateUnread(ORPHAN_FILE) && !loadOrphans()) throw trashError("write_failed", `回收站清理失败 ${id}: orphan messages`);
    if (ORPHAN_HEADS.has(id)) {
      const before = ORPHAN_HEADS.get(id);
      ORPHAN_HEADS.delete(id);
      if (!saveOrphans()) { ORPHAN_HEADS.set(id, before); throw trashError("write_failed", `回收站清理失败 ${id}: orphan messages`); }
    }
    UNDO.delete(id);
    syncDir(CFG.home);
  }
  if (meta.tx.side) removeCleanupFile(sideIn(slot), meta.tx.side, true);
  removeCleanupFile(mainIn(slot, id), meta.tx.file, true);
  removeSlot(slot);
  return true;
}

export async function purgeTrash(ids) {
  let n = 0;
  const failed = [], selected = [];
  // 一次批量操作先锁住整批：等待前一条清理时，后面的槽位不能被恢复又换成同 ID 的新一代。
  for (const id of new Set(ids)) {
    if (!validTrashId(id)) continue;
    if (SID_BUSY.has(id)) { failed.push(`${id}: busy`); continue; }
    selected.push([id, holdTrashId(id)]);
  }
  for (const [id, release] of selected) {
    try { if (await purgeUnlocked(id)) n++; }
    catch (e) { failed.push(`${id}: ${e.message}`); }
    finally { release(); }
  }
  if (failed.length) throw Object.assign(new Error(`回收站清理失败：${failed.join("；").slice(0, 500)}`), { purged: n });
  return n;
}

/** 回收站里放满 30 天的自动清掉，也重试已经确认但未收口的彻底删除。 */
export async function expireTrash() {
  try {
    recoverTrash();
    const cut = Date.now() - TRASH_KEEP_DAYS * 86400000;
    const old = listTrash().filter((m) => !SID_BUSY.has(m.id) && (m.purgePending || m.deletedAt < cut)).map((m) => m.id);
    if (old.length) log(`回收站：清掉 ${await purgeTrash(old)} 个会话`);
    for (const f of readDirIfPresent(EDITS_DIR)) {
      const p = path.join(EDITS_DIR, f.name);
      if (fs.statSync(p).mtimeMs < cut) fs.rmSync(p, { force: true });
    }
  } catch (e) { log("回收站清理失败: " + e.message); }
}

/** claude 给 cwd 起项目目录名的规则：非字母数字一律换成 -，过长截断加 sha256（与 sessions.mjs / seal.mjs 一致）。
 *  它拿的是解析过符号链接的真实路径（/sdcard → /storage/emulated/0），这边也得先 realpath，否则对不上 */
export function realWorkspace() { try { return fs.realpathSync(CFG.workspace); } catch { return CFG.workspace; } }
function projectSlug(cwd) {
  const p = String(cwd), s = p.replace(/[^A-Za-z0-9]/g, "-");
  return s.length <= 200 ? s : s.slice(0, 200) + "-" + crypto.createHash("sha256").update(p).digest("hex").slice(0, 8);
}

// 极简 zip（只 deflate / store，够会话包用）。不引第三方包：网关是单文件分发的
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

// zip 读取本体在 zipcore.mjs（worker 也用）；这里只负责把错误码翻成界面语言
const ZIP_MSG = { tooBig: "压缩包解开后太大（超过 {n} MB），没有导入", notZip: "不是 zip 文件", badDir: "zip 目录损坏", method: "不支持的压缩方式：{name}" };
const zipFail = (code, vars) => new Error(tz(ZIP_MSG[code], vars));
export function zipRead(buf, max = 512 * 1024 * 1024) {
  return zipReadCore(buf, max, zipFail);
}
/** 同 zipRead，但在 worker 线程里解：解压期间网关别的请求照常处理（F7，导入技能包用）。结果、报错与 zipRead 一致 */
export function zipReadAsync(buf, max = 512 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    // 只把这个包的字节交过去：buf 可能是大块共用内存（Buffer 池）里的一段，拷成独立的一份再转移
    const own = new Uint8Array(buf.byteLength);
    own.set(buf);
    let w;
    try { w = new Worker(new URL("./zip-worker.mjs", import.meta.url), { workerData: { buf: own, max }, transferList: [own.buffer] }); }
    catch (err) { return reject(err); }
    let done = false;
    w.once("message", (m) => {
      done = true;
      w.terminate().catch(() => {});
      if (m.files) resolve(m.files.map((f) => ({ name: f.name, data: Buffer.from(f.data.buffer, f.data.byteOffset, f.data.byteLength) })));
      else reject(m.err.code ? zipFail(m.err.code, m.err.vars) : new Error(m.err.message));
    });
    w.once("error", (err) => { if (!done) { done = true; reject(err); } });
    w.once("exit", (code) => { if (!done) { done = true; reject(new Error(tz("zip 目录损坏") + ` (worker ${code})`)); } });
  });
}

/** 导出：manifest.json + sessions/<id>.jsonl + sessions/<id>/…（子代理等） */
// 边读边压边写盘（gw/bigfile.mjs）：一个会话 1 GB 以上也导得出，网关内存不跟着涨。只受 zip32 的 4 GB 和剩余空间限制
const freeBytes = (dir) => { try { const s = fs.statfsSync(dir); return s.bavail * s.bsize; } catch { return Infinity; } };
/** 按顺序用 O_EXCL 先占住一个导出文件名（空文件占位）。
 *  以前先 existsSync 再写临时文件、最后 rename：同一秒的两个导出都看到名字空着，
 *  后 rename 的会把前一个覆盖掉（稳定性报告 FIND-030）。O_EXCL 让第二个从 -2 开始。
 *  跨进程同样成立；返回 null 表示名字用完了。写失败时调用方要删掉占位文件 */
export function reserveExportFile(dir, stamp) {
  const C = fs.constants;
  for (let k = 1; k < 100; k++) {
    const f = path.join(dir, k === 1 ? `sessions-${stamp}.zip` : `sessions-${stamp}-${k}.zip`);
    let fd;
    try { fd = fs.openSync(f, C.O_WRONLY | C.O_CREAT | C.O_EXCL | (C.O_NOFOLLOW || 0), 0o600); }
    catch (e) { if (e.code === "EEXIST") continue; throw e; }
    try { fs.closeSync(fd); } catch {}
    return f;
  }
  return null;
}

export async function exportSessions(ids) {
  const entries = [], list = [];
  const walk = (dir, rel) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, d.name);
      if (d.isDirectory()) walk(f, rel + "/" + d.name);
      else if (d.isFile()) entries.push({ name: rel + "/" + d.name, file: f });
    }
  };
  for (const id of ids) {
    const found = findSessionFile(id);
    if (!found) continue;
    const meta = peekSession(found.file);
    entries.push({ name: `sessions/${id}.jsonl`, file: found.file });
    const side = path.join(PATHS.projects, found.project, id);
    if (fs.existsSync(side)) walk(side, `sessions/${id}`);
    // 建档（章节题名、状态、卷关系）也带上：只带 jsonl 的话，换台机器导回来整理过的章节全没了（#98 03-001）
    const arch = archiveDb().sessions[id];
    list.push({ id, title: NAMES[id] || meta.title, renamed: !!NAMES[id], cwd: meta.cwd, mtime: fs.statSync(found.file).mtimeMs, ...(arch ? { archive: arch } : {}) });
  }
  if (!list.length) throw new Error(tz("没有可导出的会话"));
  entries.unshift({ name: "manifest.json", data: JSON.stringify({ format: "cccodroid-sessions", version: 1, exportedAt: Date.now(), sessions: list }, null, 1) });
  const base = process.env.CCAPP_SHARED && fs.existsSync(process.env.CCAPP_SHARED) ? process.env.CCAPP_SHARED : CFG.home;
  const dir = path.join(base, "exports");
  fs.mkdirSync(dir, { recursive: true });
  if (fs.lstatSync(dir).isSymbolicLink()) throw new Error(tz("导出目录是个软链接，不往里写"));
  if (freeBytes(dir) < (256 << 20)) throw new Error(tz("存储空间不够了"));
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  // 先占名字，再写同目录临时文件，写完再换名：写到一半失败不会在导出目录里留下半截 zip，
  // 也不会毁掉已有导出（197-9.9）。占位和临时文件都用 O_EXCL + O_NOFOLLOW，不跟软链（11-03 审查 L-1）
  const file = reserveExportFile(dir, stamp);
  if (!file) throw new Error(tz("导出目录里同名文件太多了"));
  const C = fs.constants;
  let tmp = null, fd;
  try {
    tmp = file + ".part-" + process.pid + "-" + Math.random().toString(16).slice(2, 6);
    fd = fs.openSync(tmp, C.O_WRONLY | C.O_CREAT | C.O_EXCL | (C.O_NOFOLLOW || 0), 0o600);
  } catch (e) { try { fs.rmSync(file, { force: true }); } catch {} throw e; }
  let bytes;
  try {
    bytes = await zipToFile(tmp, entries, fd);
    fs.renameSync(tmp, file);   // 覆盖自己占住的空文件
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    try { fs.rmSync(file, { force: true }); } catch {}
    throw e;
  }
  return { file, count: list.length, bytes };
}

// 上次导入的档案没写进磁盘（saveArchive 失败）：同一进程里内存还留着这份，下次导入时顺手再落一次盘，
// 别因为「正文已在、跳过」就永远补不上（BUG-P03）
let archivePending = false;

/** 导入：一律落进当前工作区（cwd 改写成本机工作区，--resume 才找得到）；同 id 已有的跳过。
 *  file 是已经落盘的会话包（路由把请求体直接写到盘上）。逐条按字节范围解到目标位置，主记录边解边改 cwd；
 *  解出来的总量不许吃到只剩 512 MB 空间（目录里写的大小可能是假的，按实际解出来的扣） */
export async function importSessions(file) {
  const ents = zipEntries(file);
  const man = ents.find((e) => e.name === "manifest.json");
  let manifest = {};
  try {
    if (!man || man.usize > (16 << 20)) throw 0;
    const tmp = file + ".manifest";
    await zipExtract(file, man, tmp, { left: 16 << 20 });
    try { manifest = JSON.parse(fs.readFileSync(tmp, "utf8")); } finally { fs.rmSync(tmp, { force: true }); }
  } catch { throw new Error(tz("缺少 manifest.json，不是会话包")); }
  if (manifest.format !== "cccodroid-sessions") throw new Error(tz("不是 cccodroid 会话包"));
  if (!Array.isArray(manifest.sessions) || manifest.sessions.length > 5000) throw new Error(tz("会话包里的会话太多了，分几次导入"));
  // 条目按名字、按会话目录先分好：以前每个会话都把全部条目扫一遍，会话多、条目多时卡住网关（11-03 审查 L-3）
  const byName = new Map(), bySide = new Map();
  for (const e of ents) {
    byName.set(e.name, e);
    const m = /^sessions\/([^/]+)\//.exec(e.name);
    if (m) (bySide.get(m[1]) || bySide.set(m[1], []).get(m[1])).push(e);
  }
  const ws = realWorkspace();
  const dir = path.join(PATHS.projects, projectSlug(ws));
  fs.mkdirSync(dir, { recursive: true });
  const budget = { left: freeBytes(dir) - (512 << 20) };
  if (budget.left <= 0) throw new Error(tz("存储空间不够了"));
  const res = { imported: [], skipped: [] };
  const fixCwd = (l) => {
    if (!l.includes('"cwd"')) return l;
    try { const ev = JSON.parse(l); if (ev.cwd) ev.cwd = ws; return JSON.stringify(ev); } catch { return l; }
  };
  // 后面某条坏了会抛错跳出：前面已经放好的几条，标题照样要落盘（#98 03-002），并告诉前端放好了哪些
  let archDirty = false, namesSaved = true, archSaved = true;
  // 标题 / 档案只补不覆盖：同 ID 的正文已经在本地（重试导入、回收站里恢复出来）时也走这里。
  // 上次元数据写失败、或正文导进来后重启丢了元数据，再导一次同一个包就能补上；本地已有的用户标题 /
  // 用户档案不动（NAMES 先到先得；archiveImport 自己会挡住已有题名的旧档案）——BUG-P03
  const absorbMeta = (s, id) => {
    if (s.renamed && s.title && !NAMES[id]) NAMES[id] = String(s.title).slice(0, 120);
    if (archiveImport(id, s.archive)) archDirty = true;
  };
  try { for (const s of manifest.sessions || []) {
    const id = String(s.id || "");
    if (!validTrashId(id)) continue;
    const main = byName.get(`sessions/${id}.jsonl`);
    if (!main) continue;
    // 彻底删除、恢复和两个同号导入不能在解包期间交错。失败的删除在发布新会话前先收口，
    // 否则旧档案/封签/文件检查点仍按 SID 共用，后续重试就分不清新旧。
    while (SID_BUSY.has(id)) await SID_BUSY.get(id);
    const release = holdTrashId(id);
    try {
      if (absent(slotOf(id))) {
        const pending = reconcileSlot(id, false);
        if (pending?.tx?.phase === "purging") await purgeUnlocked(id);
        else if (pending && !hasLiveCopy(id)) {
          const restored = restoreUnlocked(id);
          if (!restored.ok) throw new Error(`恢复回收站会话失败 ${id}: ${restored.error}`);
        }
      }
      if (hasLiveCopy(id)) { absorbMeta(s, id); res.skipped.push(id); continue; }
      const dst = path.join(dir, id + ".jsonl"), side = path.join(dir, id), hadSide = fs.existsSync(side);
      try {
        // 先解到临时名，整条会话（含子代理记录）都解完再改名：中途失败不留半截会话
        await zipExtract(file, main, dst + ".part", budget, fixCwd);
        const pre = `sessions/${id}/`;
        for (const e of bySide.get(id) || []) {
          if (!e.name.startsWith(pre)) continue;
          const rel = e.name.slice(pre.length);
          if (rel.split("/").some((x) => !x || x === "." || x === "..")) continue;   // 防目录穿越
          const out = path.join(side, rel);
          fs.mkdirSync(path.dirname(out), { recursive: true });
          await zipExtract(file, e, out, budget);
        }
        if (hasLiveCopy(id)) throw occupied();
        fs.renameSync(dst + ".part", dst);
      } catch (err) {
        fs.rmSync(dst + ".part", { force: true });
        if (!hadSide && !hasLiveCopy(id)) fs.rmSync(side, { recursive: true, force: true });
        throw err;
      }
      // 导入的会话按 mtime 排：沿用包里的旧时间会被排到最近 150 条之外、折进旧月份，用户看不到（196-会话.5）。
      // 改成「现在导入的」，列表里立刻能看到
      try { const now = new Date(); fs.utimesSync(dst, now, now); } catch {}
      sealSession(id, dst, { flag: "imported" });   // 包里的历史谁都能写：第一次接着聊时提醒模型（见 integrity.mjs）
      absorbMeta(s, id);
      noteManaged(id);    // 用户自己导进来的，当应用会话
      res.imported.push(id);
    } finally { release(); }
  } } catch (e) { e.imported = res.imported; throw e; }
  finally {
    namesSaved = saveNames();
    // 档案写错也要如实报（以前只记日志，接口回 200「导入了」但重启后章节档案没了 —— BUG-P03）。
    // 上次没写成的（archivePending）这次一并重试：正文跳过时也得有机会把元数据补上
    if (archDirty || archivePending) {
      if (saveArchive()) archivePending = false;
      else { archivePending = true; archSaved = false; }
    }
  }
  // 标题 / 档案没落盘：正文已经导进来了，别让接口回 200 就完事，调用方要把这条提示给用户（FIND-014、BUG-P03）
  if (!namesSaved) { res.titleWarning = true; log("导入会话：自定义标题没写进去（存储满了或没有权限）"); }
  if (!archSaved) { res.archiveWarning = true; log("导入会话：档案没写进去（存储满了或没有权限）"); }
  return res;
}
