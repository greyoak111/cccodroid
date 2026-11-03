// 图片随消息直接发（第三方兼容兜底，接口设置里勾了才做）
//
// 平常的路：附件只以 @路径 接在消息末尾，claude 用 Read 读回来，图在 tool_result 里。官方接口和多数厂商都认。
// 有的第三方调用方式把 Anthropic 转成 OpenAI 时不映射 tool_result 里的 image：要么整块丢，要么把 base64 当文字塞给模型，
// 模型就照着乱码编一张图出来。勾上之后，消息里提到的图片再各带一份 image 块跟在用户消息里（这个位置各家都认）。
// 两条路并存：@路径 文字一字不动，模型照样能 Read、能拿路径改文件；只是多一份图。
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { log } from "./config.mjs";

const MAX_IMAGES = 5;
const MAX_RAW = 3.75 * 1024 * 1024;        // base64 后 5 MB 是官方单图上限，第三方只会更紧
const MAX_SHRINK = 64 * 1024 * 1024;       // 再大的原图不交给 magick 缩（缩在别的进程里，但也要读、要时间），只走 Read
const REF = /@(\/[^\s"'<>`]+?\.(?:png|jpe?g|gif|webp))(?=[\s"'<>`),.;，。；]|$)/gi;

/** 按文件头认格式：扩展名和内容对不上时，按扩展名报 media_type 会被拒 */
function sniff(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.readUInt32BE(0) === 0x89504e47) return "image/png";
  if (buf.toString("latin1", 0, 4) === "GIF8") return "image/gif";
  if (buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

/** 这家要不要兜底：设置里勾了的，且不是端侧小模型 */
export const wantsInline = (P) => !!(P && P.inlineImages && !P.local);

/** 消息里提到的图片路径（去重、存在的、最多 5 张） */
export function imageRefs(msg) {
  const out = [];
  for (const m of String(msg || "").matchAll(REF)) {
    const p = m[1];
    if (out.includes(p)) continue;
    try { if (!fs.statSync(p).isFile()) continue; } catch { continue; }
    out.push(p);
    if (out.length >= MAX_IMAGES) break;
  }
  return out;
}

// 先看大小、只读文件头认格式，合适了才整读：以前先把整张图读进网关内存再判断太大（审查 v0.5.20 07-012）
const sizeOf = (f) => { try { return fs.statSync(f).size; } catch { return -1; } };
function head(f) {
  const fd = fs.openSync(f, "r");
  try { const b = Buffer.alloc(12); return b.subarray(0, fs.readSync(fd, b, 0, 12, 0)); } finally { fs.closeSync(fd); }
}

function block(buf) {
  const mt = sniff(buf);
  return mt && buf.length <= MAX_RAW ? { type: "image", source: { type: "base64", media_type: mt, data: buf.toString("base64") } } : null;
}

/** 太大的图缩到长边 1568（官方建议的尺寸）再发；没有 magick 或缩失败就不带，留给 Read 那条路 */
function shrink(file, { tmpDir, env }) {
  const out = path.join(tmpDir, `inline-${process.pid}-${Date.now().toString(36)}.jpg`);
  return new Promise((ok) => {
    execFile("magick", [file + "[0]", "-auto-orient", "-resize", "1568x1568>", "-quality", "85", out], { timeout: 30000, env }, (err) => {
      let buf = null;
      if (!err) try { buf = fs.readFileSync(out); } catch {}
      try { fs.unlinkSync(out); } catch {}
      ok(buf);
    });
  });
}

/** 起一轮之前用：太大的图会先缩（env 给 claude 那套，magick 在它的 PATH 里） */
export async function inlineImages(msg, P, { tmpDir, env } = {}) {
  if (!wantsInline(P)) return [];
  const blocks = [];
  for (const f of imageRefs(msg)) {
    const size = sizeOf(f);
    if (size < 0) continue;
    let b = null;
    try {
      if (size <= MAX_RAW) b = block(fs.readFileSync(f));
      else if (size <= MAX_SHRINK && tmpDir && sniff(head(f))) { const s = await shrink(f, { tmpDir, env }); if (s) b = block(s); }
    } catch { continue; }
    if (b) blocks.push(b); else log(`[图片随消息] ${path.basename(f)} 没带上（格式不认或太大且缩不了），只走 Read`);
  }
  return blocks;
}

/** 插话用（同步写 stdin，不能等）：只带不用缩的 */
export function inlineImagesSync(msg, P) {
  if (!wantsInline(P)) return [];
  const blocks = [];
  for (const f of imageRefs(msg)) {
    let b = null;
    const size = sizeOf(f);
    try { if (size >= 0 && size <= MAX_RAW) b = block(fs.readFileSync(f)); } catch {}
    if (b) blocks.push(b); else log(`[图片随消息] ${path.basename(f)} 没带上（插话里不缩图），只走 Read`);
  }
  return blocks;
}
