// 网关在跑的时候核对 files/app（安装包铺下来的那份）。起网关前应用已逐文件核过一遍（AppFiles.java），
// 但网关一跑就是几天，这期间被改的东西不用等重启就生效：界面脚本每次请求现读（改了能替用户点「允许」）、
// TOOLS.md 每轮拼进系统提示、建档规范模型会自己去读、bin/claude 终端里直接跑、pre/ 在 PATH 最前。
// 刚起来时 files/app 是核过的，这时把清单（FILES）和几个小目录的内容读进内存：
//   · 小目录（TOOLS.md、archive、guard、bin、pre、scripts）：每轮起 claude 前、平时每分钟看一眼，被改就用内存里的原样写回，多出来的删掉
//   · 界面文件：下发前按清单核哈希，不对就不发（503），等没有在跑的回话和终端时退出，让应用按安装包还原后重起
// 只在部署出来的那份上生效（目录里有 FILES）；开发时直接跑仓库里的网关没有 FILES，改文件热更新照旧。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { HERE, log } from "./config.mjs";

// lib/ 里是起 claude 时 --preload 的库和网关自己 --require 的 execpath.cjs，和 bin/claude 一样在执行链上（DeepSeek 复核 11-03 第三轮）
const SNAP_DIRS = ["archive/", "guard/", "bin/", "pre/", "scripts/", "lib/"];
const SNAP_FILES = ["TOOLS.md"];
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

export function appGuard(root, { onRestart } = {}) {
  const want = new Map();
  try {
    for (const l of fs.readFileSync(path.join(root, "FILES"), "utf8").split("\n")) if (l.length > 65) want.set(l.slice(65), l.slice(0, 64));
  } catch { return null; }
  if (!want.size) return null;
  const dirs = new Set();          // 清单里出现过的目录（含各级上级），「多出来的」判断别把它们删了
  for (const k of want.keys()) for (let i = k.indexOf("/"); i > 0; i = k.indexOf("/", i + 1)) dirs.add(k.slice(0, i));
  const snapped = (rel) => SNAP_FILES.includes(rel) || SNAP_DIRS.some((d) => rel.startsWith(d));
  const snap = new Map();          // rel → { buf, mode }
  const seen = new Map();          // rel → "size:mtime"，没变就不重读
  let restartWanted = "";
  for (const [rel, h] of want) {
    if (!snapped(rel)) continue;
    try {
      const f = path.join(root, rel), st = fs.lstatSync(f);
      const buf = st.isFile() ? fs.readFileSync(f) : null;
      if (buf && sha(buf) === h) { snap.set(rel, { buf, mode: st.mode & 0o777 }); seen.set(rel, `${st.size}:${st.mtimeMs}:${st.ctimeMs}`); }
      // 起网关前应用刚核过，这里对不上多半是清单读法的问题：只记一笔，不触发重启（免得来回重拉）
      else log(`⚠️ [应用文件] ${rel} 启动时就和安装包对不上，不替它兜底`);
    } catch {}
  }

  function restart(why) {
    if (!restartWanted) log(`⚠️ [应用文件] 被改动：${why}；等没有在跑的回话和终端时重启网关，由应用按安装包还原`);
    restartWanted ||= why;
    onRestart?.(why);
  }

  /** 小目录核一遍：被改的写回，多出来的删掉。返回动过的文件 */
  function check() {
    const fixed = [];
    for (const [rel, s] of snap) {
      const f = path.join(root, rel);
      let st = null; try { st = fs.lstatSync(f); } catch {}
      const k = st ? `${st.size}:${st.mtimeMs}:${st.ctimeMs}` : "";
      if (st && st.isFile() && seen.get(rel) === k) continue;
      if (st && st.isFile() && st.size === s.buf.length) {
        try { if (fs.readFileSync(f).equals(s.buf)) { seen.set(rel, k); continue; } } catch {}
      }
      try {
        try { fs.rmSync(f, { recursive: true, force: true }); } catch {}
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, s.buf, { mode: s.mode });
        fs.chmodSync(f, s.mode);
        const n = fs.lstatSync(f); seen.set(rel, `${n.size}:${n.mtimeMs}:${n.ctimeMs}`);
        fixed.push(rel);
      } catch (e) { restart(`${rel}（写不回去：${e.message}）`); }
    }
    // 多出来的：bin、pre 在 PATH 里，scripts、archive、guard 也只该有安装包里的那些
    for (const d of SNAP_DIRS) {
      let ents; try { ents = fs.readdirSync(path.join(root, d)); } catch { continue; }
      for (const n of ents) {
        const rel = d + n;
        if (want.has(rel) || dirs.has(rel)) continue;
        try { fs.rmSync(path.join(root, rel), { recursive: true, force: true }); fixed.push(rel + "（多出来的）"); } catch {}
      }
    }
    if (fixed.length) log(`⚠️ [应用文件] 被改动，已按启动时的原样还原：${fixed.slice(0, 20).join(", ")}`);
    return fixed;
  }

  const okCache = new Map();       // rel → "size:mtime"（核过、对的）
  /** 下发前核：这个文件（相对 root）内容对不对得上安装包 */
  function served(rel, buf, st) {
    const h = want.get(rel);
    if (!h) { restart(`${rel}（安装包里没有）`); return false; }
    const k = st ? `${st.size}:${st.mtimeMs}:${st.ctimeMs}` : null;
    if (k && okCache.get(rel) === k) return true;
    if (sha(buf) !== h) { okCache.delete(rel); restart(rel); return false; }
    if (k) okCache.set(rel, k);
    return true;
  }

  return {
    check, served,
    has: (rel) => want.has(rel),
    /** 清单里某个目录下的文件名（不含子目录），排好序：app.js 的分段以它为准，少一段、多一段都算改过 */
    list: (dir) => [...want.keys()].filter((k) => k.startsWith(dir) && !k.slice(dir.length).includes("/")).map((k) => k.slice(dir.length)).sort(),
    restart,
    text: (rel) => snap.get(rel)?.buf.toString("utf8") ?? null,
    get restartWanted() { return restartWanted; },
  };
}

// 网关自己用的那一份：只在部署出来的目录上（有 FILES）
let idleTimer = null;
export const APP = appGuard(HERE, {
  onRestart() {
    if (idleTimer) return;
    // 等空闲再退：正在跑的回话和终端不打断。退出后 GatewayService 一秒后重拉，起之前按安装包还原
    idleTimer = setInterval(async () => {
      const [{ RUNS }, { TERMS }] = await Promise.all([import("./runs.mjs"), import("./terminal.mjs")]);
      if (RUNS.size || [...TERMS.values()].some((t) => t.alive)) return;
      log("[应用文件] 空闲了，重启网关还原");
      process.kill(process.pid, "SIGTERM");
    }, 5000);
    idleTimer.unref?.();
  },
});
// 10 秒一次：只是 lstat 几十个文件；guard 钩子每次工具调用都重新起、建档规范模型随时会读，窗口别留太长
if (APP) setInterval(() => { try { APP.check(); } catch {} }, 10e3).unref?.();
/** 每轮起 claude 前调：小目录被改的先写回 */
export const checkAppFiles = () => { try { return APP ? APP.check() : []; } catch { return []; } };
