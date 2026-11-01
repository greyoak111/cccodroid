// 大会话文件：按行流式读写 + 边读边写盘的 zip（导出 / 导入会话包）
// 会话记录能长到 1 GB 以上。readFileSync(…, "utf8") 一次读成一个字符串，过了 V8 单串上限（约 512 MB）直接抛错；
// 整包进内存的 zip 也一样撑不住。这里一律按块读、按行交出去、边压边写，内存只跟最长的一行有关
import crypto from "node:crypto";
import fs from "node:fs";
import zlib from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Transform, Writable } from "node:stream";
import { tz } from "./config.mjs";

const CHUNK = 1 << 20;

/** 逐行回调 fn(line, i)，返回 false 就停。最后一行没有换行符也照交；行号和 split("\n") 的一致 */
// 单行上限：内存只跟最长的一行有关，这里给最长的一行也封个顶（没有换行的超大文件别整个读进来，审查 v0513b 低-5）
const LINE_MAX = 256 << 20;
export function forEachLine(file, fn) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    let rest = [], restLen = 0, i = 0, n;
    while ((n = fs.readSync(fd, buf, 0, CHUNK, null)) > 0) {
      let s = 0;
      for (let k = buf.indexOf(10, 0); k >= 0 && k < n; k = buf.indexOf(10, k + 1)) {
        const part = buf.subarray(s, k);
        const line = restLen ? Buffer.concat([...rest, part]).toString("utf8") : part.toString("utf8");
        rest = []; restLen = 0;
        if (fn(line, i++) === false) return i;
        s = k + 1;
      }
      if (s < n) { rest.push(Buffer.from(buf.subarray(s, n))); restLen += n - s; if (restLen > LINE_MAX) throw new Error(tz("文件里有一行超过 {n} MB，处理不了", { n: LINE_MAX >> 20 })); }
    }
    fn(restLen ? Buffer.concat(rest).toString("utf8") : "", i++);
    return i;
  } finally { fs.closeSync(fd); }
}

/** 攒着写：write(line) 自动补换行，close() 落盘。整份不进内存 */
export function lineWriter(file) {
  const fd = fs.openSync(file, "w", 0o600);      // 会话记录只给自己读（分叉出来的以前跟着 umask 是 0644，审查 v0513b 低-10）
  let parts = [], len = 0;
  const flush = () => { if (len) { fs.writeSync(fd, Buffer.concat(parts, len)); parts = []; len = 0; } };
  return {
    write(line) { const b = Buffer.from(line + "\n", "utf8"); parts.push(b); len += b.length; if (len >= CHUNK) flush(); },
    close() { try { flush(); } finally { fs.closeSync(fd); } },
  };
}

/** 逐行改写 src → dst，换行结构原样保留（结尾有没有换行都照旧） */
export function rewriteLines(src, dst, fn) {
  const fd = fs.openSync(dst, "w");
  let parts = [], len = 0, prev = null;
  const put = (s) => { const b = Buffer.from(s, "utf8"); parts.push(b); len += b.length; if (len >= CHUNK) { fs.writeSync(fd, Buffer.concat(parts, len)); parts = []; len = 0; } };
  try {
    forEachLine(src, (l) => { if (prev !== null) put(prev + "\n"); prev = fn(l); });
    if (prev) put(prev);
    if (len) fs.writeSync(fd, Buffer.concat(parts, len));
  } finally { fs.closeSync(fd); }
}

/** 把一段流按行改写（line → line），给导入时改 cwd 用 */
export function lineMapper(fn) {
  let rest = Buffer.alloc(0);
  return new Transform({
    transform(chunk, _e, cb) {
      const b = rest.length ? Buffer.concat([rest, chunk]) : chunk;
      const out = [];
      let s = 0;
      for (let k = b.indexOf(10); k >= 0; k = b.indexOf(10, s)) { out.push(Buffer.from(fn(b.toString("utf8", s, k)) + "\n", "utf8")); s = k + 1; }
      rest = Buffer.from(b.subarray(s));
      if (rest.length > LINE_MAX) return cb(new Error(tz("文件里有一行超过 {n} MB，处理不了", { n: LINE_MAX >> 20 })));
      cb(null, out.length ? Buffer.concat(out) : undefined);
    },
    flush(cb) { cb(null, rest.length ? Buffer.from(fn(rest.toString("utf8")), "utf8") : undefined); },
  });
}

// ── 流式 zip（只 deflate，zip32：单条和总量都在 4 GB 以内）──
// 写：每条先写本地头（第 3 位标记：大小和 CRC 在数据后面的描述符里），边读边压边写，最后补中央目录。
// 读：照中央目录找到每条，按字节范围读出来解压，一条一条交给调用方写盘
const ZIP32 = 0xffffffff;
const dosTime = (d) => ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
const dosDate = (d) => (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;

export async function zipToFile(file, entries) {
  const fd = fs.openSync(file, "w");
  let off = 0;
  const put = (b) => { fs.writeSync(fd, b); off += b.length; };
  const now = new Date(), central = [];
  try {
    for (const e of entries) {
      const name = Buffer.from(e.name, "utf8"), at = off;
      const h = Buffer.alloc(30);
      h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0808, 6); h.writeUInt16LE(8, 8);
      h.writeUInt16LE(dosTime(now), 10); h.writeUInt16LE(dosDate(now), 12); h.writeUInt16LE(name.length, 26);
      put(h); put(name);
      let crc = 0, usize = 0, csize = 0;
      const src = e.file ? fs.createReadStream(e.file, { highWaterMark: CHUNK }) : [Buffer.from(e.data)];
      await pipeline(src,
        new Transform({ transform(c, _e, cb) { crc = zlib.crc32(c, crc); usize += c.length; cb(null, c); } }),
        zlib.createDeflateRaw({ level: 6 }),
        new Writable({ write(c, _e, cb) { put(c); csize += c.length; cb(); } }));
      if (usize > ZIP32 || off > ZIP32) throw new Error(tz("会话包超过 4 GB，分几次导出"));
      const dd = Buffer.alloc(16);
      dd.writeUInt32LE(0x08074b50, 0); dd.writeUInt32LE(crc >>> 0, 4); dd.writeUInt32LE(csize, 8); dd.writeUInt32LE(usize, 12);
      put(dd);
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0808, 8); c.writeUInt16LE(8, 10);
      c.writeUInt16LE(dosTime(now), 12); c.writeUInt16LE(dosDate(now), 14);
      c.writeUInt32LE(crc >>> 0, 16); c.writeUInt32LE(csize, 20); c.writeUInt32LE(usize, 24);
      c.writeUInt16LE(name.length, 28); c.writeUInt32LE(at, 42);
      central.push(c, name);
    }
    const cd = Buffer.concat(central), cdAt = off;
    if (cdAt + cd.length > ZIP32 || entries.length > 0xffff) throw new Error(tz("会话包超过 4 GB，分几次导出"));
    put(cd);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(cdAt, 16);
    put(end);
    return off;
  } catch (err) { try { fs.closeSync(fd); } catch {} fs.rmSync(file, { force: true }); throw err; }
  finally { try { fs.closeSync(fd); } catch {} }
}

/** 读 zip 的中央目录（不读数据）：[{ name, method, crc, csize, usize, data }]，data 是数据在文件里的起点 */
export function zipEntries(file) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const tail = Buffer.alloc(Math.min(size, 22 + 65535));
    fs.readSync(fd, tail, 0, tail.length, size - tail.length);
    let e = tail.length - 22;
    while (e >= 0 && tail.readUInt32LE(e) !== 0x06054b50) e--;
    if (e < 0) throw new Error(tz("不是 zip 文件"));
    const n = tail.readUInt16LE(e + 10), cdLen = tail.readUInt32LE(e + 12), cdAt = tail.readUInt32LE(e + 16);
    if (cdAt + cdLen > size) throw new Error(tz("zip 目录损坏"));
    const cd = Buffer.alloc(cdLen);
    fs.readSync(fd, cd, 0, cdLen, cdAt);
    const out = [], lh = Buffer.alloc(30);
    let p = 0;
    for (let i = 0; i < n; i++) {
      if (p + 46 > cdLen || cd.readUInt32LE(p) !== 0x02014b50) throw new Error(tz("zip 目录损坏"));
      const method = cd.readUInt16LE(p + 10), crc = cd.readUInt32LE(p + 16), csize = cd.readUInt32LE(p + 20), usize = cd.readUInt32LE(p + 24);
      const nlen = cd.readUInt16LE(p + 28), xlen = cd.readUInt16LE(p + 30), clen = cd.readUInt16LE(p + 32), lo = cd.readUInt32LE(p + 42);
      const name = cd.toString("utf8", p + 46, p + 46 + nlen).replace(/\\/g, "/");
      p += 46 + nlen + xlen + clen;
      if (name.endsWith("/")) continue;
      if (method !== 0 && method !== 8) throw new Error(tz("不支持的压缩方式：{name}", { name }));
      if (fs.readSync(fd, lh, 0, 30, lo) < 30 || lh.readUInt32LE(0) !== 0x04034b50) throw new Error(tz("zip 目录损坏"));
      const data = lo + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      if (data + csize > size) throw new Error(tz("zip 目录损坏"));
      out.push({ name, method, crc, csize, usize, data });
    }
    return out;
  } finally { fs.closeSync(fd); }
}

/** 把一条解到 dst。budget = { left }：实际解出来的字节从里面扣（目录里写的大小可能是假的），扣光就停 */
export async function zipExtract(file, ent, dst, budget, map) {
  const tooBig = () => new Error(tz("压缩包解开后太大，没有导入"));
  if (ent.csize === 0) {
    if (ent.usize || ent.crc) throw new Error(tz("压缩包里的 {name} 损坏了，没有导入", { name: ent.name }));
    fs.writeFileSync(dst, ""); return;
  }
  const src = fs.createReadStream(file, { start: ent.data, end: ent.data + ent.csize - 1, highWaterMark: CHUNK });
  const steps = [src];
  if (ent.method === 8) steps.push(zlib.createInflateRaw());
  // 解出来的原字节按目录里的 CRC 和长度核对（在改写之前）：压缩数据坏了一个 bit，inflate 往往照样解得开、JSON 也还合法，
  // 不核就把变了质的历史当成功导进来（审查 B15）。核不上就报错，调用方不会发布这份文件
  let crc = 0, n = 0;
  steps.push(new Transform({
    transform(c, _e, cb) { if ((budget.left -= c.length) < 0) return cb(tooBig()); crc = zlib.crc32(c, crc); n += c.length; cb(null, c); },
    flush(cb) { cb((crc >>> 0) !== ent.crc || (ent.usize !== ZIP32 && n !== ent.usize) ? new Error(tz("压缩包里的 {name} 损坏了，没有导入", { name: ent.name })) : null); },
  }));
  if (map) steps.push(lineMapper(map));
  steps.push(fs.createWriteStream(dst));
  try { await pipeline(...steps); } catch (e) { fs.rmSync(dst, { force: true }); throw e; }
}

/** 请求体直接落盘（不进内存），返回字节数；超过 max 就停。App 按次签名的请求照 readBodyBuf 核体哈希 */
export async function bodyToFile(req, file, max) {
  let n = 0;
  const h = crypto.createHash("sha256");
  try {
    await pipeline(req, new Transform({ transform(c, _e, cb) { if ((n += c.length) > max) return cb(new Error("body too large")); h.update(c); cb(null, c); } }), fs.createWriteStream(file));
    if (req.ccBodySha && h.digest("hex") !== req.ccBodySha) throw new Error("body does not match signature");
  } catch (e) { fs.rmSync(file, { force: true }); throw e; }
  return n;
}
