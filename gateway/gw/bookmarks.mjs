// ── 书签 ──────────────────────────────────────────────────────────────
// 在对话里某一处留个钩子，回头一点就落回那里（侧栏「书签」页统一管理）。
// 一个书签 = 会话 + 消息 uuid + 那一行的字节偏移 + 消息里第几段 + 摘录。
// 偏移是给大会话省事的：跳转时网关先核对偏移处那一行确实是这条消息，对不上才整文件找 uuid。
// 刚答完的回复界面上还没有 uuid（是事件总线推来的）：按角色 + 正文开头去文件尾部认领。
// 清单存在 home/ccapp-bookmarks.json；会话进回收站时书签留着（恢复就回来），彻底删了才清掉。
import fs from "node:fs";
import path from "node:path";
import { CFG, PATHS, log, tz } from "./config.mjs";
import { isObj, loadState, saveState } from "./statefile.mjs";
import { NEXT, readBody, sendJson } from "./http.mjs";
import { findSessionFile, peekSession } from "./sessions.mjs";
import { SID_RE, listTrash } from "./sessionops.mjs";
import { findLineOffset, transcriptItems } from "./transcript.mjs";

const FILE = path.join(CFG.home, "ccapp-bookmarks.json");
const PER_SESSION = 50, TOTAL = 2000;
const UUID_RE = /^[0-9a-f-]{8,64}$/i;

// 语法坏 / 读不了 / 超过 4 MB：留底成 .bad-* 再从空的起；以前下一次添加就把整份盖掉（195-Z.8）
const bmShape = (j) => {
  if (!Array.isArray(j)) return undefined;
  return j.filter((b) => isObj(b) && typeof b.id === "string" && typeof b.sid === "string" && typeof b.uuid === "string")
    .map((b) => ({
      id: b.id, sid: b.sid, uuid: b.uuid,
      off: Number.isFinite(+b.off) ? +b.off : -1,
      para: Math.max(0, Math.min(10000, Math.floor(Number(b.para) || 0))),
      role: b.role === "user" ? "user" : "assistant",
      excerpt: typeof b.excerpt === "string" ? b.excerpt : "",
      at: Number.isFinite(+b.at) ? +b.at : 0,
    }))
    .slice(-TOTAL);
};
let BM = loadState(FILE, { shape: bmShape, fallback: () => [], max: 4 << 20 }).data;
function save() {
  const ok = saveState(FILE, BM, { pretty: false });
  if (!ok) log("书签保存失败（存储满了或没有权限）");
  return ok;
}
/** 会话彻底删掉时清掉它的书签（195-A.7） */
export function forgetBookmarks(sid) {
  if (!sid) return true;
  const n = BM.length;
  BM = BM.filter((b) => b.sid !== sid);
  return BM.length === n ? true : save();
}

/** 文件尾部倒着找：最后一条 role 相同、正文以 head 开头的消息 → { uuid, off }。只看最后 8 MB（刚答完的那几条） */
export async function claimTail(file, role, head, nth = 0) {
  let skip = Math.max(0, Math.floor(Number(nth) || 0));   // 后面还有几条同样开头的（界面数的）：跳过它们
  const want = String(head || "").trim().slice(0, 200);
  if (!want) return null;
  const fh = await fs.promises.open(file, "r");
  try {
    const size = (await fh.stat()).size, from = Math.max(0, size - (8 << 20));
    const buf = Buffer.alloc(size - from); await fh.read(buf, 0, buf.length, from);
    let end = buf.length;
    while (end > 0) {
      const nl = buf.lastIndexOf(10, end - 1), start = nl + 1;
      if (nl < 0 && from > 0) break;   // 头一截可能是半行
      const line = buf.toString("utf8", start, end).trim();
      end = nl < 0 ? 0 : nl;
      if (!line) continue;
      let ev = null; try { ev = JSON.parse(line); } catch { continue; }
      if (!ev.uuid) continue;
      if (transcriptItems(ev).some((it) => it.role === role && String(it.text).trim().startsWith(want))) { if (skip-- > 0) continue; return { uuid: ev.uuid, off: from + start }; }
    }
    return null;
  } finally { await fh.close(); }
}

const pub = (b) => ({ id: b.id, sid: b.sid, uuid: b.uuid, off: b.off, para: b.para, role: b.role, excerpt: b.excerpt, at: b.at });

// ── 路由：/api/bookmarks（GET 列表 / POST 新增）/api/bookmarks/del ──
export async function routeBookmarks(req, res, u, p) {
  if (req.method === "GET" && p === "/api/bookmarks") {
    const sid = u.searchParams.get("session");
    // 会话内：只给按钮上色用，不碰文件
    if (sid) return sendJson(res, 200, { items: BM.filter((b) => b.sid === sid).map(pub) });
    // 书签页：按会话带上标题；会话进了回收站的先藏着，彻底没了的顺手清掉。
    // .claude/projects 读不出来时不能当成「会话都没了」——以前一次 EIO 就把全部书签清空（195-Y.8）
    let canList = true;
    try { fs.accessSync(PATHS.projects, fs.constants.R_OK); } catch { canList = false; }
    if (!canList) return sendJson(res, 200, { items: BM.map(pub), unreadable: true });
    const trash = new Set(listTrash().map((t) => t.id)), out = [], meta = new Map();
    let gone = 0;
    for (const b of BM) {
      if (!meta.has(b.sid)) {
        const f = findSessionFile(b.sid);
        meta.set(b.sid, f ? { title: peekSession(f.file).title || "" } : trash.has(b.sid) ? { trashed: true } : null);
      }
      const m = meta.get(b.sid);
      if (!m) { gone++; continue; }
      if (!m.trashed) out.push({ ...pub(b), title: m.title });
    }
    if (gone) { BM = BM.filter((b) => meta.get(b.sid)); save(); }
    return sendJson(res, 200, { items: out });
  }
  if (req.method === "POST" && p === "/api/bookmarks") {
    let b; try { b = JSON.parse((await readBody(req)) || "{}"); } catch { return sendJson(res, 400, { error: "bad json" }); }
    const sid = String(b.session || ""), role = b.role === "user" ? "user" : "assistant";
    if (!SID_RE.test(sid)) return sendJson(res, 400, { error: "bad session" });
    const found = findSessionFile(sid);
    if (!found) return sendJson(res, 404, { error: "session not found" });
    let uuid = UUID_RE.test(String(b.uuid || "")) ? String(b.uuid) : "", off = -1;
    if (uuid) {
      const hint = Math.max(0, Number(b.hint) || 0);
      off = await findLineOffset(found.file, uuid, hint);
      if (off < 0 && hint) off = await findLineOffset(found.file, uuid);
    } else {
      const c = await claimTail(found.file, role, b.head, b.nth);
      if (c) ({ uuid, off } = c);
    }
    if (!uuid || off < 0) return sendJson(res, 404, { error: "message not found" });
    const para = Math.max(0, Math.min(10000, Math.floor(Number(b.para) || 0)));
    // 同一处（同一条消息同一段）不重复加
    const dup = BM.find((x) => x.sid === sid && x.uuid === uuid && x.para === para);
    if (dup) return sendJson(res, 200, { ok: true, item: pub(dup) });
    if (BM.filter((x) => x.sid === sid).length >= PER_SESSION) return sendJson(res, 409, { error: "full", limit: PER_SESSION });
    const item = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), sid, uuid, off, para, role,
      excerpt: String(b.excerpt || "").replace(/\s+/g, " ").trim().slice(0, 120), at: Date.now() };
    const before = BM.slice();
    BM.push(item);
    if (BM.length > TOTAL) BM.splice(0, BM.length - TOTAL);
    if (!save()) { BM = before; return sendJson(res, 500, { ok: false, error: "write_failed", message: tz("书签没保存上：存储满了或没有权限") }); }
    return sendJson(res, 200, { ok: true, item: pub(item) });
  }
  if (req.method === "POST" && p === "/api/bookmarks/del") {
    let b; try { b = JSON.parse((await readBody(req)) || "{}"); } catch { return sendJson(res, 400, { error: "bad json" }); }
    const ids = new Set((Array.isArray(b.ids) ? b.ids : [b.id]).map(String));
    const before = BM, n = BM.length;
    BM = BM.filter((x) => !ids.has(x.id));
    if (BM.length !== n && !save()) { BM = before; return sendJson(res, 500, { ok: false, error: "write_failed", message: tz("书签没保存上：存储满了或没有权限") }); }
    return sendJson(res, 200, { ok: true, removed: n - BM.length });
  }
  return NEXT;
}
