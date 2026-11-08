// 纯 zip 读取（只认 stored / deflate），不碰网关配置：主线程和解压 worker（zip-worker.mjs）共用。
// 出错不直接造带文案的 Error（worker 里没有界面语言），交给调用方的 fail(code, vars) 去翻译。
import zlib from "node:zlib";

export function zipReadCore(buf, max, fail) {
  let e = buf.length - 22;
  let total = 0;
  const tooBig = () => fail("tooBig", { n: Math.round(max / 1048576) });
  // 目录尾记录只可能在最后 22+65535 字节里（注释最长 64KB）：不是 zip 时别从尾扫到头（审查 v0.5.3 B2）
  const floor = Math.max(0, buf.length - 22 - 65535);
  while (e >= floor && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < floor) e = -1;
  if (e < 0) throw fail("notZip");
  const n = buf.readUInt16LE(e + 10);
  let p = buf.readUInt32LE(e + 16);
  const out = [];
  for (let i = 0; i < n; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw fail("badDir");
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
    if (method !== 0 && method !== 8) throw fail("method", { name });
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
