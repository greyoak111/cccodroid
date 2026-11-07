import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { CFG, LAST_LANG, PATHS, log, tr, tz } from "./config.mjs";
import { NAMES, PEEK_CACHE, PINS, findSessionFile, peekSession, saveNames, savePins } from "./sessions.mjs";
import { claudeBlocked, claudeCmd, claudeEnv, killTree } from "./claude.mjs";
import { sealed } from "./edition.mjs";
import { LAST_SESSION, TRASH_HOOKS, forgetSession, runOfSession } from "./runs.mjs";
import { forgetChild, recordPrimary } from "./lineage-store.mjs";
import { lineageForget } from "./lineage.mjs";
import { checkSession, neutralizeMarkers, resealAfterEdit, sealSession, isInjected } from "./integrity.mjs";
import { ucPending } from "./userconf.mjs";
import { forEachLine, lineWriter, writeAll, zipEntries, zipExtract, zipToFile } from "./bigfile.mjs";
import { archiveDb, archiveImport, saveArchive } from "./archive-store.mjs";

// ── 会话管理：回收站 / 导出 / 导入 ─────────────────────────────────────
// 回收站放在 claude 的 projects 目录之外（它看不见，--resume 也就找不回来），同一文件系统，挪进挪出都是 rename。
// 每个会话一格：<id>.jsonl + 同名目录（子代理、超长工具结果）+ meta.json（原项目目录、标题、删除时间）。
const TRASH_DIR = path.join(CFG.home, ".ccapp-trash");
export const TRASH_KEEP_DAYS = 30;
// 只当单个目录名用：不许全是点（「.」「..」拼进路径就跳出了所在目录，回收站清理曾因此删掉整个 home）
//  也不许是 __proto__ 这类：会话 id 要当对象的键用（封签表、标题表），会改到原型上（11-03 审查 L-2）
export const SID_RE = /^(?!\.+$)(?!(__proto__|constructor|prototype)$)[A-Za-z0-9._-]{1,200}$/;

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
  const w = lineWriter(path.join(dir, nid + ".jsonl"));
  try {
    forEachLine(found.file, (line, i) => {
      if (i >= cut) return false;
      if (!line.trim()) return;
      if (line.includes('"uuid"')) { try { const e = JSON.parse(line); if (e.uuid && !e.isSidechain && /^(user|assistant|system)$/.test(e.type)) at = e.uuid; } catch {} }
      if (!line.includes(id)) return w.write(line);
      try { const ev = JSON.parse(line); if (ev.sessionId === id) ev.sessionId = nid; w.write(JSON.stringify(ev)); }
      catch { w.write(line); }
    });
  } finally { w.close(); }
  // 同名目录里是子代理记录、超长工具结果：一起抄过去，引用它们的路径照旧有效
  // 抄不全就不分叉：分出来的会话读不到子代理过程，还报成功（#98 03-003 同类）。原会话没动，删掉抄了一半的
  const side = path.join(dir, id);
  let sideDir = false; try { sideDir = fs.statSync(side).isDirectory(); } catch {}
  if (sideDir) try { fs.cpSync(side, path.join(dir, nid), { recursive: true }); }
  catch (e) {
    fs.rmSync(path.join(dir, nid), { recursive: true, force: true });
    fs.rmSync(path.join(dir, nid + ".jsonl"), { force: true });
    return { ok: false, status: 500, message: tz("会话附带的文件没抄过去，没有分叉：{err}", { err: e.code || e.message }) };
  }
  sealSession(nid, path.join(dir, nid + ".jsonl"), { flag: dirty || undefined });
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
const ORPHAN_HEADS = new Map();   // 会话号 → 提问被删掉的那几轮回复的第一行 uuid（见 deleteMessage 里的 B04）
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
  } catch (e) { w.close(); fs.rmSync(tmp, { force: true }); throw e; }
  w.close();
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
    if (head) { if (!ORPHAN_HEADS.has(id)) ORPHAN_HEADS.set(id, new Set()); ORPHAN_HEADS.get(id).add(head); }
  }
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
  ORPHAN_HEADS.delete(id);   // 抄回删之前的样子：提问回来了，界面也整份重开
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
    // spawn 失败（loader 缺失/EACCES/ENOMEM）只发 error：不接就是未捕获异常，整个网关退出
    child.on("error", (e) => finish({ ok: false, error: e.code || e.message }));
    child.stdin.on("error", () => {});
    child.on("close", () => { exited = true; if (sf) resealAfterEdit(sid, sf, dirty); finish({ ok: false, error: err.trim().slice(-300) || "claude exited" }); });
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
export function rewindTargetOk(want) {
  if (typeof want !== "string" || !path.isAbsolute(want)) return false;
  // 私有目录按整个 App 数据目录算（files 之外还有 shared_prefs、databases、app_webview…，11-03 审查 M-7）
  const r = realOf(want), priv = realOf(path.dirname(path.dirname(CFG.home))), ws = realOf(CFG.workspace);
  return !inside(r, priv) || (inside(r, ws) && r !== ws);
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
  const absOf = (k, b) => b && b.realParentDir ? path.join(b.realParentDir, path.basename(k)) : path.resolve(CFG.workspace, k);
  const hist = path.join(CFG.home, ".claude", "file-history", sid);
  let fixed = 0, failed = 0;
  for (const want of files || []) {
    let entry;
    for (let i = at; i < snaps.length && entry === undefined; i++) {
      for (const [k, b] of Object.entries(snaps[i].backups)) if (absOf(k, b) === want) { entry = b; break; }
    }
    if (entry === undefined) continue;                 // 快照里查不到：不碰
    if (!rewindTargetOk(want)) { failed++; log(`回退补救跳过 ${want}：在应用私有目录里、又不在工作区`); continue; }
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
      if (!rewindTargetOk(want)) { failed++; continue; }
      const fd = fs.openSync(want, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o644);
      try { writeAll(fd, data); } finally { fs.closeSync(fd); }
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
  // 先写 meta 再挪文件：反过来的话，挪完、写 meta 之前被杀，回收站里就是个没 meta 的孤儿——列不出、恢复不了、过期也不清（审查 中3）。
  // 这样被杀在中间，原会话还在原处，回收站这格没有 jsonl，listTrash 不列它，下次删同一个会话时整格重建
  fs.writeFileSync(path.join(slot, "meta.json"), JSON.stringify({
    id, project: found.project, title: NAMES[id] || meta.title, renamed: !!NAMES[id], pinned: PINS[id] || 0,
    cwd: meta.cwd, mtime: st.mtimeMs, size: st.size, deletedAt: Date.now(),
  }));
  fs.renameSync(found.file, path.join(slot, id + ".jsonl"));
  const side = path.join(PATHS.projects, found.project, id);
  if (fs.existsSync(side)) fs.renameSync(side, path.join(slot, "dir"));
  if (PINS[id]) { delete PINS[id]; savePins(); }
  PEEK_CACHE.delete(found.file);
  delete NAMES[id]; saveNames();
  // 删的正好是「最近跑过的那条」：别让前端下次打开时又指回去（会显示「找不到这个会话」而不是欢迎页）
  if (LAST_SESSION && LAST_SESSION.id === id) forgetSession();
  for (const f of TRASH_HOOKS) { try { f(id); } catch (e) { log(`回收后续处理出错：${e.message}`); } }
  return { ok: true };
}
/** 会话号在不在回收站里：打开失败时界面据此说「在回收站，可恢复」而不是悄悄开新对话（#173） */
export function inTrash(id) { return SID_RE.test(String(id || "")) && fs.existsSync(path.join(TRASH_DIR, id, id + ".jsonl")); }

export function listTrash() {
  let ids = [];
  try { ids = fs.readdirSync(TRASH_DIR); } catch { return []; }
  const out = [];
  for (const id of ids) {
    if (!fs.existsSync(path.join(TRASH_DIR, id, id + ".jsonl"))) continue;   // 删到一半被打断的空格子
    try { out.push(JSON.parse(fs.readFileSync(path.join(TRASH_DIR, id, "meta.json"), "utf8"))); } catch {}
  }
  return out.sort((a, b) => b.deletedAt - a.deletedAt);
}

export function restoreSession(id) {
  if (!SID_RE.test(id)) return { ok: false, error: "bad id" };
  const slot = path.join(TRASH_DIR, id);
  let meta;
  try { meta = JSON.parse(fs.readFileSync(path.join(slot, "meta.json"), "utf8")); } catch { return { ok: false, error: "not found" }; }
  const sideIn = path.join(slot, "dir"), hasSide = fs.existsSync(sideIn);
  const done = findSessionFile(id);
  if (done) {
    // 旧版先放回主记录、附件没放回去就报错的半截：主记录已在、回收站这格只剩附件 —— 把附件补回去收尾（#98 03-014）
    const tail = !fs.existsSync(path.join(slot, id + ".jsonl")) && hasSide && !fs.existsSync(path.join(path.dirname(done.file), id));
    if (!tail) return { ok: false, error: "exists" };
    fs.renameSync(sideIn, path.join(path.dirname(done.file), id));
  } else {
    const dir = path.join(PATHS.projects, SID_RE.test(meta.project || "") ? meta.project : projectSlug(realWorkspace()));
    fs.mkdirSync(dir, { recursive: true });
    // 先放附件、再放主记录：主记录放不回去就把附件挪回回收站，这一格照旧在列表里，可以再点恢复（#98 03-014）
    if (hasSide) fs.renameSync(sideIn, path.join(dir, id));
    try { fs.renameSync(path.join(slot, id + ".jsonl"), path.join(dir, id + ".jsonl")); }
    catch (e) { if (hasSide) try { fs.renameSync(path.join(dir, id), sideIn); } catch {} throw e; }
  }
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

export function zipRead(buf, max = 512 * 1024 * 1024) {
  let e = buf.length - 22;
  let total = 0;
  const tooBig = () => new Error(tz("压缩包解开后太大（超过 {n} MB），没有导入", { n: Math.round(max / 1048576) }));
  // 目录尾记录只可能在最后 22+65535 字节里（注释最长 64KB）：不是 zip 时别从尾扫到头（审查 v0.5.3 B2）
  const floor = Math.max(0, buf.length - 22 - 65535);
  while (e >= floor && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < floor) e = -1;
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
// 边读边压边写盘（gw/bigfile.mjs）：一个会话 1 GB 以上也导得出，网关内存不跟着涨。只受 zip32 的 4 GB 和剩余空间限制
const freeBytes = (dir) => { try { const s = fs.statfsSync(dir); return s.bavail * s.bsize; } catch { return Infinity; } };
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
  // 同一秒导出两次别互相覆盖（审查 v0513b 低-11）：用 wx 先把名字占住，并发的两次也各拿各的
  // 占名用的 fd 直接拿去写，不跟软链（11-03 审查 L-1：以前占完名关掉再按名字重开，中间能被换成软链）
  let file = null, fd;
  const C = fs.constants;
  for (let k = 1; !file && k < 100; k++) {
    const f = path.join(dir, k === 1 ? `sessions-${stamp}.zip` : `sessions-${stamp}-${k}.zip`);
    try { fd = fs.openSync(f, C.O_WRONLY | C.O_CREAT | C.O_EXCL | (C.O_NOFOLLOW || 0), 0o644); file = f; } catch (e) { if (e.code !== "EEXIST") throw e; }
  }
  if (!file) throw new Error(tz("导出目录里同名文件太多了"));
  const bytes = await zipToFile(file, entries, fd);
  return { file, count: list.length, bytes };
}

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
  let archDirty = false;
  try { for (const s of manifest.sessions || []) {
    const id = String(s.id || "");
    if (!SID_RE.test(id)) continue;
    const main = byName.get(`sessions/${id}.jsonl`);
    if (!main) continue;
    if (findSessionFile(id) || fs.existsSync(path.join(TRASH_DIR, id))) { res.skipped.push(id); continue; }
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
      fs.renameSync(dst + ".part", dst);
    } catch (err) {
      fs.rmSync(dst + ".part", { force: true });
      if (!hadSide) fs.rmSync(side, { recursive: true, force: true });
      throw err;
    }
    if (s.mtime) try { fs.utimesSync(dst, new Date(), new Date(s.mtime)); } catch {}
    sealSession(id, dst, { flag: "imported" });   // 包里的历史谁都能写：第一次接着聊时提醒模型（见 integrity.mjs）
    if (s.renamed && s.title) NAMES[id] = String(s.title).slice(0, 120);
    if (archiveImport(id, s.archive)) archDirty = true;
    res.imported.push(id);
  } } catch (e) { e.imported = res.imported; throw e; }
  finally { saveNames(); if (archDirty && !saveArchive()) log("导入会话：档案没写进去"); }
  return res;
}
