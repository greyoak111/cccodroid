import fs from "node:fs";
import zlib from "node:zlib";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

// ── zip 由网关自己读：文件名按原始字节解码（Windows 打的包多是 GBK，7zz 在安卓上认不了代码页，-mcp 也不管用） ──
// 只做「读」：中央目录、本地头、stored / deflate 两种方法的解压与 CRC 核对。别的方法（deflate64、bzip2、lzma、AES…）
// 和加密条目交给 7-Zip（archiver.mjs 回落）。分卷 zip 也交给 7-Zip。

const SIG_EOCD = 0x06054b50, SIG_Z64_LOC = 0x07064b50, SIG_Z64_EOCD = 0x06064b50, SIG_CDH = 0x02014b50, SIG_LFH = 0x04034b50;
const CD_MAX = 256 << 20;          // 中央目录最多读 256 MB（几十万条），再大当坏包
export const ZIP_ENTRIES_MAX = 500000;

function readAt(fd, pos, len) {
  const b = Buffer.alloc(len);
  let n = 0;
  while (n < len) { const k = fs.readSync(fd, b, n, len - n, pos + n); if (k <= 0) break; n += k; }
  return n === len ? b : b.subarray(0, n);
}

const LEGACY = ["gbk", "big5", "shift_jis", "euc-kr", "ibm866", "windows-1252"];
const isAscii = (b) => { for (const c of b) if (c > 0x7e || c < 0x20) return false; return true; };
const utf8Strict = (b) => { try { return new TextDecoder("utf-8", { fatal: true }).decode(b); } catch { return null; } };
/** 「编码」选项能用哪些：TextDecoder 认得的 + cp437（老 DOS 包；TextDecoder 不认，按 IBM437 表自己转） */
export const ZIP_ENCODINGS = ["auto", "utf-8", ...LEGACY, "cp437"];
const CP437 = "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";
function decodeLegacy(b, enc) {
  if (enc === "cp437") { let s = ""; for (const c of b) s += c < 0x80 ? String.fromCharCode(c) : CP437[c - 0x80]; return s; }
  try { return new TextDecoder(enc).decode(b); } catch { return b.toString("latin1"); }
}

/** 读 zip 的目录。返回 { entries, encoding, legacy } 或抛错（不是 zip / 分卷 / 坏包，调用方回落 7-Zip）。
 *  enc：没打 UTF-8 标记的文件名按什么解码；"auto" = 全都是合法 UTF-8 就当 UTF-8，否则按 GBK（中文环境最常见） */
export function zipList(file, enc = "auto") {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 65557), tail = readAt(fd, size - tailLen, tailLen);
    let e = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === SIG_EOCD) { e = i; break; }
    if (e < 0) throw new Error("not a zip (no end of central directory)");
    const eocdPos = size - tailLen + e;
    if (tail.readUInt16LE(e + 4) !== 0 || tail.readUInt16LE(e + 6) !== 0) throw new Error("multi-volume zip");
    let total = tail.readUInt16LE(e + 10), cdSize = tail.readUInt32LE(e + 12), cdOff = tail.readUInt32LE(e + 16), z64 = false;
    if (total === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) {
      const loc = readAt(fd, eocdPos - 20, 20);
      if (loc.length < 20 || loc.readUInt32LE(0) !== SIG_Z64_LOC) throw new Error("zip64 locator missing");
      const z = readAt(fd, Number(loc.readBigUInt64LE(8)), 56);
      if (z.readUInt32LE(0) !== SIG_Z64_EOCD) throw new Error("zip64 end record missing");
      z64 = true;
      total = Number(z.readBigUInt64LE(32)); cdSize = Number(z.readBigUInt64LE(40)); cdOff = Number(z.readBigUInt64LE(48));
    }
    if (total > ZIP_ENTRIES_MAX) throw new Error(`too many entries (${total})`);
    // 自解压（exe 前面接 zip）：偏移是相对 zip 开头算的，整体错开了 —— 按 EOCD 实际位置校正（zip64 的中央目录和 EOCD 之间本来隔着 zip64 记录，不校）
    const shift = !z64 && eocdPos - (cdOff + cdSize) > 0 ? eocdPos - (cdOff + cdSize) : 0;
    if (cdSize > CD_MAX || cdOff + shift + cdSize > size) throw new Error("central directory out of range");
    const cd = readAt(fd, cdOff + shift, cdSize);
    const raw = [];
    for (let p = 0; p + 46 <= cd.length && raw.length < total;) {
      if (cd.readUInt32LE(p) !== SIG_CDH) throw new Error("bad central directory");
      const madeBy = cd.readUInt16LE(p + 4), flags = cd.readUInt16LE(p + 8), method = cd.readUInt16LE(p + 10);
      const dtime = cd.readUInt16LE(p + 12), ddate = cd.readUInt16LE(p + 14), crc = cd.readUInt32LE(p + 16);
      let csize = cd.readUInt32LE(p + 20), usize = cd.readUInt32LE(p + 24);
      const nl = cd.readUInt16LE(p + 28), xl = cd.readUInt16LE(p + 30), cl = cd.readUInt16LE(p + 32), ext = cd.readUInt32LE(p + 38);
      let lho = cd.readUInt32LE(p + 42);
      const nameB = cd.subarray(p + 46, p + 46 + nl), extra = cd.subarray(p + 46 + nl, p + 46 + nl + xl);
      let uname = null, mtime = null;
      for (let q = 0; q + 4 <= extra.length;) {
        const id = extra.readUInt16LE(q), len = extra.readUInt16LE(q + 2), d = extra.subarray(q + 4, q + 4 + len);
        if (id === 0x0001) {
          let k = 0;
          if (usize === 0xffffffff && k + 8 <= d.length) { usize = Number(d.readBigUInt64LE(k)); k += 8; }
          if (csize === 0xffffffff && k + 8 <= d.length) { csize = Number(d.readBigUInt64LE(k)); k += 8; }
          if (lho === 0xffffffff && k + 8 <= d.length) { lho = Number(d.readBigUInt64LE(k)); k += 8; }
        } else if (id === 0x7075 && d.length > 5 && d[0] === 1) uname = utf8Strict(d.subarray(5));
        else if (id === 0x5455 && d.length >= 5 && (d[0] & 1)) mtime = d.readUInt32LE(1) * 1000;
        q += 4 + len;
      }
      if (mtime == null) mtime = new Date(1980 + (ddate >> 9), ((ddate >> 5) & 15) - 1, ddate & 31, dtime >> 11, (dtime >> 5) & 63, (dtime & 31) * 2).getTime();
      const host = madeBy >> 8, mode = host === 3 ? ext >>> 16 : 0;
      raw.push({ nameB, uname, utf8: !!(flags & 0x800), flags, method, crc, csize, usize, lho: lho + shift, mtime,
        isDir: (mode & 0xf000) === 0x4000 || (host === 0 && (ext & 0x10) !== 0), isLink: (mode & 0xf000) === 0xa000 });
      p += 46 + nl + xl + cl;
    }
    // 没打 UTF-8 标记的非 ASCII 名字：全都能按 UTF-8 解开就当 UTF-8（很多工具不打标记），否则整包按一种旧编码解
    let legacy = false, use = enc;
    if (enc === "auto") {
      use = "utf-8";
      for (const r of raw) if (!r.utf8 && !r.uname && !isAscii(r.nameB) && utf8Strict(r.nameB) == null) { use = "gbk"; break; }
    }
    const entries = raw.map((r) => {
      let name = r.uname ?? (r.utf8 || isAscii(r.nameB) ? r.nameB.toString("utf8") : null);
      if (name == null) { legacy = true; name = use === "utf-8" ? r.nameB.toString("utf8") : decodeLegacy(r.nameB, use); }
      name = name.replace(/\\/g, "/");
      const isDir = r.isDir || name.endsWith("/");
      return { path: name.replace(/\/+$/, ""), dir: isDir, link: r.isLink, size: isDir ? 0 : r.usize, packed: r.csize, mtime: r.mtime,
        enc: !!(r.flags & 1), method: r.method, crc: r.crc, lho: r.lho };
    });
    return { entries, encoding: use, legacy };
  } finally { fs.closeSync(fd); }
}

/** 这一条能不能由网关自己解（stored / deflate，没加密） */
export const zipNative = (e) => !e.enc && !e.dir && !e.link && (e.method === 0 || e.method === 8);

/** 把一条解到 out（wx：已存在就报错）。按声明的大小封顶（防炸弹：中央目录可以谎报），解完核 CRC */
export async function zipExtract(file, e, out, { onBytes, signal } = {}) {
  if (!zipNative(e)) throw new Error("unsupported zip entry");
  const fd = fs.openSync(file, "r");
  let start;
  try {
    const h = readAt(fd, e.lho, 30);
    if (h.length < 30 || h.readUInt32LE(0) !== SIG_LFH) throw new Error("bad local header");
    start = e.lho + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
  } finally { fs.closeSync(fd); }
  let n = 0, crc = 0;
  const guard = new Transform({
    transform(chunk, _enc, cb) {
      n += chunk.length;
      if (n > e.size) return cb(new Error("entry larger than declared"));
      crc = zlib.crc32(chunk, crc);
      onBytes?.(chunk.length);
      cb(null, chunk);
    },
  });
  if (e.packed === 0) fs.writeFileSync(out, "", { flag: "wx", mode: 0o644 });      // 空文件：没有数据可读（createReadStream 的 end 不能小于 start）
  else {
    const parts = [fs.createReadStream(file, { start, end: start + e.packed - 1 })];
    if (e.method === 8) parts.push(zlib.createInflateRaw());
    parts.push(guard, fs.createWriteStream(out, { flags: "wx", mode: 0o644 }));
    await pipeline(...parts, signal ? { signal } : {});
  }
  if (n !== e.size) throw new Error("size mismatch");
  if ((crc >>> 0) !== (e.crc >>> 0)) throw new Error("CRC mismatch");
}
