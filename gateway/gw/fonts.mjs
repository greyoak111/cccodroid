// ── 导入字体 ──────────────────────────────────────────────────────────
// 用户自己挑的字体文件存在 home/fonts/<id>.<ext>，清单 home/fonts/fonts.json。
// 界面里两个槽位（界面 / 回复）都能选它（等宽不开放）；theme.js 照清单注入 @font-face，回落链仍是自带字体。
// 只收 ttf / otf / woff / woff2（看文件头，不看扩展名）；ttc 是字体集合，浏览器的 @font-face 不认，不收。
// 字体名从 name 表里读（家族名，优先中文、再英文），读不出来就用文件名。
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { CFG, log } from "./config.mjs";
import { NEXT, readBody, readBodyBuf, sendJson } from "./http.mjs";

const DIR = path.join(CFG.home, "fonts");
const LIST = path.join(DIR, "fonts.json");
export const FONT_MAX = 40 * 1024 * 1024, FONT_COUNT = 10;
const ID_RE = /^[0-9a-f]{12}$/;
const MIME = { ttf: "font/ttf", otf: "font/otf", woff: "font/woff", woff2: "font/woff2" };

/** 看文件头认格式：ttf / otf / woff / woff2，其余（含 ttc）返回 "" */
export function fontFormat(buf) {
  if (buf.length < 12) return "";
  const m = buf.readUInt32BE(0);
  if (m === 0x00010000 || m === 0x74727565) return "ttf";   // 0x00010000 或 'true'（老 Mac 字体）
  if (m === 0x4f54544f) return "otf";                       // 'OTTO'
  if (m === 0x774f4646) return "woff";                      // 'wOFF'
  if (m === 0x774f4632) return "woff2";                     // 'wOF2'
  return "";
}

// name 表：取 nameID 16（排版家族名）或 1（家族名）；平台 3（Windows，UTF-16BE）优先中文，其次英文；平台 1 当兜底
function parseName(t) {
  if (!t || t.length < 6) return "";
  const count = t.readUInt16BE(2), strOff = t.readUInt16BE(4);
  const cands = [];
  for (let i = 0; i < count; i++) {
    const r = 6 + i * 12; if (r + 12 > t.length) break;
    const plat = t.readUInt16BE(r), lang = t.readUInt16BE(r + 4), nid = t.readUInt16BE(r + 6), len = t.readUInt16BE(r + 8), off = t.readUInt16BE(r + 10);
    if (nid !== 1 && nid !== 16) continue;
    const s = strOff + off; if (s + len > t.length) continue;
    let str = "";
    if (plat === 3 || plat === 0) { for (let j = 0; j + 1 < len; j += 2) str += String.fromCharCode(t.readUInt16BE(s + j)); }
    else if (plat === 1) str = t.toString("latin1", s, s + len);
    else continue;
    str = str.replace(/\0/g, "").trim(); if (!str) continue;
    const zh = plat === 3 && [0x0804, 0x0404, 0x0c04, 0x1004].includes(lang), en = (plat === 3 && lang === 0x0409) || plat === 1;
    cands.push({ str, score: (nid === 16 ? 1 : 0) + (zh ? 20 : en ? 10 : 0) + (plat === 3 ? 2 : 0) });
  }
  cands.sort((a, b) => b.score - a.score);
  return cands[0] ? cands[0].str.slice(0, 80) : "";
}

// sfnt（ttf / otf）：表目录里找 'name'
function sfntName(buf, base = 0) {
  const n = buf.readUInt16BE(base + 4);
  for (let i = 0; i < n; i++) {
    const r = base + 12 + i * 16; if (r + 16 > buf.length) break;
    if (buf.toString("latin1", r, r + 4) !== "name") continue;
    const off = buf.readUInt32BE(r + 8), len = buf.readUInt32BE(r + 12);
    return parseName(buf.subarray(off, off + len));
  }
  return "";
}
// woff：每张表单独 zlib 压过（压缩后长度等于原长就是没压）
function woffName(buf) {
  const n = buf.readUInt16BE(12);
  for (let i = 0; i < n; i++) {
    const r = 44 + i * 20; if (r + 20 > buf.length) break;
    if (buf.toString("latin1", r, r + 4) !== "name") continue;
    const off = buf.readUInt32BE(r + 4), clen = buf.readUInt32BE(r + 8), olen = buf.readUInt32BE(r + 12);
    const raw = buf.subarray(off, off + clen);
    return parseName(clen < olen ? zlib.inflateSync(raw, { maxOutputLength: 16 << 20 }) : raw);
  }
  return "";
}
// woff2：表目录用变长整数，所有表拼在一起 brotli 压一次；name 表不做变换，解压后按顺序数过去就是
function woff2Name(buf) {
  const n = buf.readUInt16BE(12), csize = buf.readUInt32BE(20);
  let p = 48, at = 0, nameAt = -1, nameLen = 0;
  const base128 = () => { let v = 0; for (let i = 0; i < 5; i++) { const b = buf[p++]; v = v * 128 + (b & 0x7f); if (!(b & 0x80)) return v; } throw new Error("bad base128"); };
  const TAGS_NAME = 5;   // 已知表序号 5 = 'name'
  for (let i = 0; i < n; i++) {
    const flags = buf[p++], tagIdx = flags & 0x3f, xf = (flags >> 6) & 3;
    let tag = "";
    if (tagIdx === 63) { tag = buf.toString("latin1", p, p + 4); p += 4; }
    const orig = base128();
    // glyf / loca 的变换号 0 表示「变过」，其余表变换号非 0 才算变过；变过的多带一个 transformLength
    const isGL = tagIdx === 10 || tagIdx === 11;
    const len = (isGL ? xf === 0 : xf !== 0) ? base128() : orig;
    if (tagIdx === TAGS_NAME || tag === "name") { nameAt = at; nameLen = len; }
    at += len;
  }
  if (nameAt < 0) return "";
  const all = zlib.brotliDecompressSync(buf.subarray(p, p + csize), { maxOutputLength: 64 << 20 });
  return parseName(all.subarray(nameAt, nameAt + nameLen));
}
export function fontName(buf, fmt) {
  try {
    if (fmt === "ttf" || fmt === "otf") return sfntName(buf);
    if (fmt === "woff") return woffName(buf);
    if (fmt === "woff2") return woff2Name(buf);
  } catch {}
  return "";
}

function load() {
  try { const j = JSON.parse(fs.readFileSync(LIST, "utf8")); if (Array.isArray(j)) return j.filter((f) => f && ID_RE.test(f.id) && MIME[f.fmt]); } catch {}
  return [];
}
function save(list) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(LIST + ".tmp", JSON.stringify(list, null, 1)); fs.renameSync(LIST + ".tmp", LIST);
}
const fileOf = (f) => path.join(DIR, `${f.id}.${f.fmt}`);
const pub = (f) => ({ id: f.id, name: f.name, file: f.file, fmt: f.fmt, size: f.size, at: f.at });

// ── 路由：/api/fonts（GET 清单 / POST 导入）/api/fonts/del /api/fonts/file/<id> ──
export async function routeFonts(req, res, u, p) {
  if (!p.startsWith("/api/fonts")) return NEXT;
  if (req.method === "GET" && p === "/api/fonts") return sendJson(res, 200, { items: load().map(pub), max: FONT_MAX, count: FONT_COUNT });

  if (req.method === "POST" && p === "/api/fonts") {
    if (load().length >= FONT_COUNT) return sendJson(res, 400, { error: "too many", message: "最多导入 10 个字体，先删掉一个再导入" });
    let buf;
    try { buf = await readBodyBuf(req, FONT_MAX); }
    catch { return sendJson(res, 413, { error: "too large", message: "字体文件不能超过 40 MB" }); }
    const fmt = fontFormat(buf);
    if (!fmt) {
      const ttc = buf.length >= 4 && buf.toString("latin1", 0, 4) === "ttcf";
      return sendJson(res, 400, { error: "bad format", message: ttc ? "这是字体集合（.ttc），浏览器用不了；请换成单个的 ttf / otf" : "不是能用的字体文件，只支持 ttf、otf、woff、woff2" });
    }
    const sha = crypto.createHash("sha256").update(buf).digest("hex");
    // 清单在读完上传之后再取：上传那几秒里别的导入 / 删除已经改过它，用开头那份会互相覆盖、把删掉的写回来（审查 B21）。
    // 从这里到 save 没有 await，不会再交错
    const list = load();
    if (list.length >= FONT_COUNT) return sendJson(res, 400, { error: "too many", message: "最多导入 10 个字体，先删掉一个再导入" });
    const dup = list.find((f) => f.sha === sha);
    if (dup) return sendJson(res, 200, { ok: true, font: pub(dup), dup: true });
    const raw = path.basename(u.searchParams.get("name") || "").slice(0, 120);
    const stem = raw.replace(/\.[^.]+$/, "") || "font";
    const f = { id: sha.slice(0, 12), name: fontName(buf, fmt) || stem, file: raw || `${stem}.${fmt}`, fmt, size: buf.length, sha, at: Date.now() };
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(fileOf(f), buf);
    list.push(f); save(list);
    log(`[fonts] 导入 ${f.file}（${f.name}，${fmt}，${buf.length}B）→ ${f.id}`);
    return sendJson(res, 200, { ok: true, font: pub(f) });
  }

  if (req.method === "POST" && p === "/api/fonts/del") {
    let b = {}; try { b = JSON.parse((await readBody(req)) || "{}"); } catch {}
    const list = load(), i = list.findIndex((f) => f.id === b.id);
    if (i < 0) return sendJson(res, 404, { error: "not found" });
    const [f] = list.splice(i, 1);
    try { fs.unlinkSync(fileOf(f)); } catch {}
    save(list);
    log(`[fonts] 删除 ${f.file}（${f.id}）`);
    return sendJson(res, 200, { ok: true });
  }

  const m = /^\/api\/fonts\/file\/([0-9a-f]{12})$/.exec(p);
  if (req.method === "GET" && m) {
    const f = load().find((x) => x.id === m[1]);
    if (!f) return sendJson(res, 404, { error: "not found" });
    let data; try { data = fs.readFileSync(fileOf(f)); } catch { return sendJson(res, 404, { error: "not found" }); }
    // 内容按哈希定了 id，可以放心长缓存；换字体就是换 id
    res.writeHead(200, { "content-type": MIME[f.fmt], "content-length": data.length, "cache-control": "private, max-age=31536000, immutable", "x-content-type-options": "nosniff" });
    return res.end(data);
  }
  return NEXT;
}
