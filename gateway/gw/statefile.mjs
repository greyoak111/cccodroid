import fs from "node:fs";
import path from "node:path";
import { log } from "./config.mjs";
import { readSmallFile } from "./saferead.mjs";

// ── 网关自己的状态文件（home 下的 ccapp-*.json 这一类）：统一的读和写 ──
// 0.6.9 审计的一大家族（R2 状态形状 / R5 写层）：各模块各写各的 JSON.parse，
//   · 语法坏了 → 回落空表，下一次保存把整份覆盖掉（厂商 Key、账本、设置全丢，也不留底）；
//   · 语法对、形状不对（该是数组的是对象、该是对象的是 null）→ 在定时器 / 回调里抛异常，网关崩了重启、重启再崩；
//   · 写盘失败被吞 → 接口回 200「已保存」，重启回退。
// 这里统一成：读的时候按 shape 规整，坏了先把原文件挪成 <文件>.bad-<时间>（留最近 3 份）再回落；写走临时文件 + fsync + 换名，失败如实返回 false。

const BAD_KEEP = 3;

/** 把坏文件挪到一边留底（不删）。返回留底的路径；挪不动返回 null */
export function keepBad(file, why) {
  const dst = `${file}.bad-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  try { fs.renameSync(file, dst); } catch { try { fs.copyFileSync(file, dst); } catch { return null; } }
  log(`⚠️ 状态文件 ${path.basename(file)} ${why}，原文件留底为 ${path.basename(dst)}，按默认值继续`);
  try {
    const dir = path.dirname(file), base = path.basename(file) + ".bad-";
    const olds = fs.readdirSync(dir).filter((n) => n.startsWith(base)).sort();
    for (const n of olds.slice(0, Math.max(0, olds.length - BAD_KEEP))) fs.rmSync(path.join(dir, n), { force: true });
  } catch {}
  return dst;
}

/**
 * 读一份 JSON 状态文件。
 *   shape(j)：把解析出来的值规整成要的形状并返回；形状不对、救不回来就返回 undefined（或抛错）
 *   fallback()：文件不存在 / 坏了时用的默认值（每次新建，别共用一个对象）
 * 返回 { data, missing, bad }：missing = 文件本来就没有；bad = 读坏了（已留底成 .bad-*）
 */
export function loadState(file, { shape = (j) => j, fallback = () => ({}), max = 8 << 20 } = {}) {
  let st = null;
  try { st = fs.lstatSync(file); } catch (e) { if (e.code === "ENOENT") return { data: fallback(), missing: true, bad: false }; }
  const raw = st && st.isFile() && st.size <= max ? readSmallFile(file, max) : null;
  let why = null, data;
  if (raw == null) why = !st ? "读不了" : !st.isFile() ? "不是普通文件" : st.size > max ? `太大（${st.size} 字节）` : "读不了";
  else {
    let j;
    try { j = JSON.parse(raw); } catch { why = "不是合法的 JSON"; }
    if (!why) { try { data = shape(j); } catch { data = undefined; } if (data === undefined) why = "内容的格式不对"; }
  }
  if (!why) return { data, missing: false, bad: false };
  keepBad(file, why);
  return { data: fallback(), missing: false, bad: true };
}

/** 写 JSON 状态文件：同目录临时文件（名字唯一）→ fsync → 换名。成功 true；失败记日志、清临时文件、返回 false（调用方要如实报给用户） */
export function saveState(file, obj, { mode = 0o600, pretty = true } = {}) {
  return writeAtomic(file, JSON.stringify(obj, null, pretty ? 2 : 0), { mode });
}

/** 原子写一份文本 / 二进制。失败返回 false，不抛 */
export function writeAtomic(file, data, { mode = 0o600 } = {}) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${Date.now().toString(36)}${Math.random().toString(16).slice(2, 6)}`);
  let fd = null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = null;
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    if (fd != null) { try { fs.closeSync(fd); } catch {} }
    try { fs.rmSync(tmp, { force: true }); } catch {}
    log(`⚠️ 写 ${path.basename(file)} 失败：${e.code || e.message}`);
    return false;
  }
}

/** 启动时清掉过期的隐藏临时文件（FIND-016）：原子写是「临时文件 → fsync → 换名」，
 *  在 fsync 之后、换名之前被杀就会留下 .<名字>.tmp-…；导入先落 .import-*.zip 也是一个道理。
 *  只清够旧的（默认 1 小时前）：正在写的另一个进程（另一个窗口的导入、上传）不会被打扰。
 *  返回清掉的个数。 */
export function sweepTemps(dirs, { ageMs = 3600e3 } = {}) {
  const now = Date.now();
  let n = 0;
  for (const dir of dirs) {
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!name.startsWith(".") || !(name.includes(".tmp-") || name.startsWith(".part-") || name.startsWith(".import-"))) continue;
      const p = path.join(dir, name);
      try {
        const st = fs.lstatSync(p);
        if (st.isFile() && now - st.mtimeMs >= ageMs) { fs.rmSync(p, { force: true }); n++; }
      } catch {}
    }
  }
  return n;
}

// 常用形状
/** 普通对象（不是数组、不是 null） */
export const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
/** 要求是普通对象，否则 undefined（→ 留底、回落） */
export const asObj = (v) => (isObj(v) ? v : undefined);
/** 要求是数组，否则 undefined */
export const asArr = (v) => (Array.isArray(v) ? v : undefined);
