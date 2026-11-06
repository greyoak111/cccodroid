// 读同 uid 可写的配置：拒绝 FIFO/设备/软链，并限大小。
// 裸 fs.readFileSync 在无写端的 FIFO 上会同步阻塞在 open(2)，事件循环整个冻住；指向 /dev/zero 会无限读。
// 返回 Buffer（enc 为空）或字符串；读不了/不是普通文件/太大返回 null。
import fs from "node:fs";

export function readSmallFile(file, max = 64 << 10, enc = "utf8") {
  let fd = -1;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > max) return null;
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < buf.length) {
      const n = fs.readSync(fd, buf, off, buf.length - off, off);
      if (!n) break;
      off += n;
    }
    return enc ? buf.subarray(0, off).toString(enc) : buf.subarray(0, off);
  } catch { return null; }
  finally { if (fd >= 0) try { fs.closeSync(fd); } catch {} }
}

/** 只读开头 max 字节（说明文件 frontmatter、输出风格摘要用）：文件更大也返回前 max 字节，不返回 null */
export function readHeadFile(file, max = 64 << 10, enc = "utf8") {
  let fd = -1;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return null;
    const n = Math.min(st.size, max);
    const buf = Buffer.alloc(n);
    let off = 0;
    while (off < n) {
      const k = fs.readSync(fd, buf, off, n - off, off);
      if (!k) break;
      off += k;
    }
    return enc ? buf.subarray(0, off).toString(enc) : buf.subarray(0, off);
  } catch { return null; }
  finally { if (fd >= 0) try { fs.closeSync(fd); } catch {} }
}
