// 上传的图片按内容认格式（群友 11-08：抖音存下来的图名叫 .png / .jpg，内容其实是 HEIF / AVIF）。
// 扩展名和内容对不上时：
//   - 内容是 JPEG / PNG / GIF / WebP：只把扩展名改对。claude 的 Read 按扩展名报 media_type，对不上会被接口拒，模型就看不到图；
//   - 内容是 HEIF / AVIF：界面预览不了、多数接口也不收，用 magick 转成 JPEG 交出去；转不了就把扩展名改成真实的，至少不再冒充 PNG。
// 只看图片扩展名（和没有扩展名）的文件，别的照旧。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { log } from "./config.mjs";

const IMG_EXT = new Set(["", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".heif", ".avif", ".bmp"]);
const HEIF_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "msf1"]);
const AVIF_BRANDS = new Set(["avif", "avis"]);

/** 按文件头认：{ ext, kind: "web"（WebView 和接口都认）| "heif" | "avif" } 或 null */
export function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: ".jpg", kind: "web" };
  if (buf.readUInt32BE(0) === 0x89504e47) return { ext: ".png", kind: "web" };
  if (buf.toString("latin1", 0, 4) === "GIF8") return { ext: ".gif", kind: "web" };
  if (buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return { ext: ".webp", kind: "web" };
  if (buf.toString("latin1", 4, 8) === "ftyp") {
    const brand = buf.toString("latin1", 8, 12).toLowerCase();
    if (AVIF_BRANDS.has(brand)) return { ext: ".avif", kind: "avif" };
    if (HEIF_BRANDS.has(brand)) return { ext: ".heic", kind: "heif" };
  }
  return null;
}
const sameExt = (a, b) => a === b || (a === ".jpeg" && b === ".jpg") || (a === ".heif" && b === ".heic");

function head(file) {
  const fd = fs.openSync(file, "r");
  try { const b = Buffer.alloc(16); return b.subarray(0, fs.readSync(fd, b, 0, 16, 0)); } finally { fs.closeSync(fd); }
}

/** HEIF / AVIF → JPEG（magick 在工具包里；解析外来文件，HOME / TMPDIR 指到一次性目录，令牌类变量不给） */
async function toJpeg(src, dst) {
  let env;
  // 和 inlineimg 缩图同一套环境（claude 的 PATH 里有工具包的 magick）；别用 termEnv，它会顺手写终端的钥匙文件
  try { env = { ...(await import("./claude.mjs")).claudeEnv() }; } catch { env = { ...process.env }; }
  // 工具包的 bin 在前，网关自己的 PATH 兜底（找不到 magick 就按真实格式命名，见下）
  env.PATH = [env.PATH, process.env.PATH].filter(Boolean).join(":");
  for (const k of Object.keys(env)) if (/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(k)) delete env[k];
  const work = path.join(path.dirname(dst), `.imgfix-${crypto.randomBytes(6).toString("hex")}`);
  fs.mkdirSync(work, { recursive: true });
  env.HOME = work; env.TMPDIR = work;
  return new Promise((ok) => {
    execFile("magick", [src + "[0]", "-auto-orient", "-quality", "90", "jpg:" + dst], { timeout: 60000, env, cwd: work }, (err) => {
      fs.rmSync(work, { recursive: true, force: true });
      let good = false;
      try { good = !err && sniffImage(head(dst))?.ext === ".jpg"; } catch {}
      if (!good) { try { fs.rmSync(dst, { force: true }); } catch {} if (err) log(`[upload] 转 JPEG 失败：${String(err.message).slice(0, 200)}`); }
      ok(good);
    });
  });
}

/** 上传收完、挂名之前用：返回该用的扩展名（可能换了），file 的内容可能被就地换成 JPEG。不是图片 / 认不出：原样返回 ext */
export async function fixUploadedImage(file, ext) {
  const e = String(ext || "").toLowerCase();
  if (!IMG_EXT.has(e)) return ext;
  let s = null;
  try { s = sniffImage(head(file)); } catch {}
  if (!s) return ext;
  if (s.kind === "web") return sameExt(e, s.ext) ? ext : s.ext;
  // HEIF / AVIF：转 JPEG；转不了就按真实格式命名
  const out = file + ".jpg";
  if (await toJpeg(file, out)) {
    try { fs.renameSync(out, file); return ".jpg"; } catch { try { fs.rmSync(out, { force: true }); } catch {} }
  }
  return sameExt(e, s.ext) ? ext : s.ext;
}
