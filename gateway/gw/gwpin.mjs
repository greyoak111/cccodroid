// 网关起 claude 用的 glibc（files/gw/glibc，安全 4 第 2 层）：每次起 claude 前按安装包钉的哈希再核一遍。
// 应用（GwRuntime.java）起网关前核过、写好，钉子经 CCAPP_GW_GLIBC_PIN 交过来（文件名 → sha256）；
// 网关跑着的这段时间里同 uid 的进程能改 files/gw/glibc，这里不核的话 claude 加载的就是改过的 libc。
// 文件没动过（大小、修改时间、ctime、inode 都没变）就用上次的结论，32 个文件 lstat 一遍。
// 对不上：这一轮不起，留痕，等空闲时重启网关，应用重拉前按钉子重新写好（appfiles.mjs 的 APP.restart）。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { PATHS, log, tz } from "./config.mjs";
import { APP } from "./appfiles.mjs";

let PIN = null;
try { const o = JSON.parse(process.env.CCAPP_GW_GLIBC_PIN || "null"); if (o && typeof o === "object" && Object.keys(o).length) PIN = o; } catch {}
delete process.env.CCAPP_GW_GLIBC_PIN;
const DIR = process.env.CCAPP_GW_GLIBC_LIB || "";
const seen = new Map();          // 文件 → [指纹, sha256]

function sha256(f) {
  const h = crypto.createHash("sha256"), fd = fs.openSync(f, "r"), b = Buffer.alloc(1 << 20);
  try { let n; while ((n = fs.readSync(fd, b, 0, b.length)) > 0) h.update(b.subarray(0, n)); } finally { fs.closeSync(fd); }
  return h.digest("hex");
}

/** 对不上的文件名列表；没有钉子（开发布局、开发版退回 $PREFIX 时）返回 [] */
export function gwGlibcBad({ pin = PIN, dir = DIR } = {}) {
  if (!pin || !dir || PATHS.claudeLib !== dir) return [];
  const bad = [];
  for (const [name, want] of Object.entries(pin)) {
    const f = path.join(dir, name);
    try {
      const st = fs.lstatSync(f);
      if (!st.isFile()) { bad.push(name); continue; }
      const fp = `${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.ino}`;
      const c = seen.get(f);
      // 刚改过的不信缓存：时间戳有粒度，同一刻里写两遍、大小不变，指纹就一样
      const got = c && c[0] === fp && Date.now() - st.ctimeMs > 2000 ? c[1] : sha256(f);
      seen.set(f, [fp, got]);
      if (got !== want) bad.push(name);
    } catch { bad.push(name); }
  }
  // 多出来的也算：ld.so 按 --library-path 找库，往这里塞一个钉子里没有的同名库就能被加载
  try { for (const n of fs.readdirSync(dir)) if (!Object.hasOwn(pin, n)) bad.push(n); } catch { bad.push("."); }
  return bad;
}

/** 起 claude 前调：对不上返回给人看的原因（这一轮别起），并要求空闲时重启网关、由应用重新写好；能起返回 "" */
export function gwRuntimeBlocked() {
  const bad = gwGlibcBad();
  if (!bad.length) return "";
  log(`⚠️ [网关运行库] files/gw/glibc 和安装包对不上：${bad.slice(0, 6).join(", ")}`);
  APP?.restart(`gw/glibc/${bad[0]}（网关运行库和安装包对不上）`);
  return tz("网关自己的运行库被改过，这一轮没有启动 Claude Code。网关会在空闲时重启、按安装包还原，稍后再发送。");
}
