// 网关在跑的时候核对 files/app（安装包铺下来的那份）。起网关前应用已逐文件核过一遍（AppFiles.java），
// 但网关一跑就是几天，这期间被改的东西不用等重启就生效：界面脚本每次请求现读（改了能替用户点「允许」）、
// TOOLS.md 每轮拼进系统提示、建档规范模型会自己去读、bin/claude 终端里直接跑、pre/ 在 PATH 最前。
// 刚起来时 files/app 是核过的，这时把清单（FILES）和几个小目录的内容读进内存：
//   · 小目录（TOOLS.md、archive、guard、bin、pre、scripts、gw）：每轮起 claude 前、平时每分钟看一眼，被改就用内存里的原样写回，多出来的删掉
//   · 界面文件：下发前按清单核哈希，不对就不发（503），等没有在跑的回话和终端时退出，让应用按安装包还原后重起
// 只在部署出来的那份上生效（目录里有 FILES）；开发时直接跑仓库里的网关没有 FILES，改文件热更新照旧。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import module from "node:module";
import { pathToFileURL } from "node:url";
import { HERE, log } from "./config.mjs";
import { tamperRecord } from "./tamper.mjs";

// lib/ 里是子 node 经 NODE_OPTIONS --require 的 execpath.cjs（预加载的原生库 0.6.7 起搬进了 APK 原生库目录，见 build.sh）。
// gw/ 是网关自己的源码：已经加载的模块不会热换，但被改过的文件要在下一次起进程（包括不是 Java 托管的那种）之前写回核过的那份。
const SNAP_DIRS = ["archive/", "guard/", "bin/", "pre/", "scripts/", "lib/", "gw/"];
const SNAP_FILES = ["TOOLS.md"];
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

export function appGuard(root, { onRestart, expect, onBadList } = {}) {
  const want = new Map();
  let list = null;
  try { list = fs.readFileSync(path.join(root, "FILES")); } catch {}
  // 应用起网关时交来了安装包里清单的哈希（GatewayService）：盘上这份读不到、或者对不上（核完到起进程这一下被换了），
  // 不能退回「没有清单就不核」—— 那等于删掉 FILES 就关掉整层（11-03 自查审计 G-06）
  if (expect && (!list || sha(list) !== expect)) { onBadList?.(list ? "FILES（和安装包对不上）" : "FILES（读不到）"); return null; }
  if (!list) return null;
  for (const l of list.toString("utf8").split("\n")) if (l.length > 65) want.set(l.slice(65), l.slice(0, 64));
  if (!want.size) return null;
  const dirs = new Set();          // 清单里出现过的目录（含各级上级），「多出来的」判断别把它们删了
  for (const k of want.keys()) for (let i = k.indexOf("/"); i > 0; i = k.indexOf("/", i + 1)) dirs.add(k.slice(0, i));
  const snapped = (rel) => SNAP_FILES.includes(rel) || SNAP_DIRS.some((d) => rel.startsWith(d));
  const snap = new Map();          // rel → { buf, mode }
  const seen = new Map();          // rel → "size:mtime"，没变就不重读
  let restartWanted = "";
  const late = [];
  for (const [rel, h] of want) {
    if (!snapped(rel)) continue;
    try {
      const f = path.join(root, rel), st = fs.lstatSync(f);
      const buf = st.isFile() ? fs.readFileSync(f) : null;
      if (buf && sha(buf) === h) { snap.set(rel, { buf, mode: st.mode & 0o777 }); seen.set(rel, `${st.size}:${st.mtimeMs}:${st.ctimeMs}`); }
      // 起网关前应用刚核过，这里还对不上：核完到读进来的这一下被换了（DeepSeek 复核建议 9），要求重启让应用再还原一次
      else late.push(rel);
    } catch {
      // 读不到（被删、EACCES、I/O 错）同样要还原：漏进 snap 就永远不会被 check 补回
      late.push(rel);
    }
  }

  if (late.length) setImmediate(() => restart(`${late.slice(0, 5).join(", ")}（启动时就和安装包对不上）`));

  function restart(why) {
    if (!restartWanted) { log(`⚠️ [应用文件] 被改动：${why}；等没有在跑的回话和终端时重启网关，由应用按安装包还原`); tamperRecord("runtime", [why]); }
    restartWanted ||= why;
    onRestart?.(why);
  }

  /** 小目录核一遍：被改的写回，多出来的删掉。返回动过的文件 */
  /** 写回/删除前确认父目录真实路径还在 root 里：SNAP_DIR 被换成软链时，fs 会跟着链写到别处（审查 11-05） */
  const parentInside = (f) => {
    try {
      const base = fs.realpathSync(root), real = fs.realpathSync(path.dirname(f));
      return real === base || real.startsWith(base + path.sep);
    } catch { return false; }
  };
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
      if (!parentInside(f)) { restart(`${rel}（上级目录被换成软链）`); continue; }
      // 先写临时文件再换名：以前先 rm 再写，写失败（满盘/被杀）就把原文件也弄没了（0.6.9 审计 196 补充 11）
      const tmp = path.join(path.dirname(f), `.${path.basename(f)}.heal-${process.pid}`);
      try {
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(tmp, s.buf, { mode: s.mode });
        fs.chmodSync(tmp, s.mode);
        fs.renameSync(tmp, f);
        const n = fs.lstatSync(f); seen.set(rel, `${n.size}:${n.mtimeMs}:${n.ctimeMs}`);
        fixed.push(rel);
      } catch (e) {
        try { fs.rmSync(tmp, { force: true }); } catch {}
        restart(`${rel}（写不回去：${e.message}）`);
      }
    }
    // 多出来的：bin、pre 在 PATH 里，scripts、archive、guard 也只该有安装包里的那些
    for (const d of SNAP_DIRS) {
      const dir = path.join(root, d);
      // 目录本身是软链/不普通：不 readdir、更不按里面的条目删除，交给应用重启时按安装包还原
      try { const dst = fs.lstatSync(dir); if (dst.isSymbolicLink() || !dst.isDirectory()) { restart(`${d}（目录被换成软链）`); continue; } } catch { continue; }
      if (!parentInside(path.join(dir, "x"))) { restart(`${d}（目录被换成软链）`); continue; }
      let ents; try { ents = fs.readdirSync(dir); } catch { continue; }
      for (const n of ents) {
        const rel = d + n;
        if (want.has(rel) || dirs.has(rel)) continue;
        try { fs.rmSync(path.join(root, rel), { recursive: true, force: true }); fixed.push(rel + "（多出来的）"); } catch {}
      }
    }
    if (fixed.length) { log(`⚠️ [应用文件] 被改动，已按启动时的原样还原：${fixed.slice(0, 20).join(", ")}`); tamperRecord("runtime", fixed); }
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
    /** 要加载的代码：快照里有就给内存里那份（启动时核过），清单里有就现读现核，对不上或安装包里没有给 null */
    code(rel) {
      const s = snap.get(rel);
      if (s) return s.buf;
      const h = want.get(rel);
      if (!h) return null;
      try { const b = fs.readFileSync(path.join(root, rel)); return sha(b) === h ? b : null; } catch { return null; }
    },
    get restartWanted() { return restartWanted; },
  };
}

// 网关自己用的那一份：只在部署出来的目录上（有 FILES）
let idleTimer = null;
const FILES_SHA = process.env.CCAPP_FILES_SHA || "";
delete process.env.CCAPP_FILES_SHA;
export const APP = appGuard(HERE, {
  expect: FILES_SHA,
  // 刚起来、还没有回话和终端：直接退出，应用重拉前按安装包还原（AppFiles.tampered 也核 FILES 自己）
  onBadList(why) {
    log(`⚠️ [应用文件] ${why}，退出等应用按安装包还原`);
    tamperRecord("runtime", [why]);
    setImmediate(() => process.exit(3));
  },
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
// 网关自己的模块：启动时静态 import 的那批在应用核过之后马上就读完了，之后用到才 import 的（十来处）要再读盘 ——
// 这时候盘上的可能已经被换过。挂一个加载钩子：files/app 里的代码一律用核过的字节（gw/ 等在快照里，直接用内存里那份），
// 对不上、或安装包里根本没有的，不加载并要求重启还原
if (APP && typeof module.registerHooks !== "function") log("⚠️ [应用文件] 这个 node 没有 module.registerHooks，后来才加载的网关模块不核");
if (APP && typeof module.registerHooks === "function") {
  const base = pathToFileURL(HERE + path.sep).href;
  module.registerHooks({
    load(url, ctx, next) {
      // 软链解析后可能变成安装目录外的 file: URL：不能放行，否则等于跳过清单核对（审查 11-05）
      if (!url.startsWith(base)) {
        if (url.startsWith("file:")) { APP.restart(`${url}（安装包外的文件）`); throw new Error(`[应用文件] ${url} 不在安装目录里`); }
        return next(url, ctx);
      }
      const rel = decodeURIComponent(url.slice(base.length).replace(/[?#].*$/, ""));
      const buf = APP.code(rel);
      if (!buf) { APP.restart(`${rel}（加载时和安装包对不上）`); throw new Error(`[应用文件] ${rel} 和安装包对不上，拒绝加载`); }
      // 格式自己定，不往下调默认加载：下一层是 boot.mjs 的钩子，它按盘上现读的字节核，盘上被改了会直接退出；
      // 这里有核过的那份就用它，盘上的等 check() 写回、或空闲时重启再还原，不打断正在跑的回话
      const format = /\.mjs$/.test(rel) ? "module" : /\.cjs$/.test(rel) ? "commonjs" : /\.json$/.test(rel) ? "json" : null;
      if (format) return { format, source: buf, shortCircuit: true };
      const r = next(url, ctx);
      return { ...r, source: buf, shortCircuit: true };
    },
  });
}
// 10 秒一次：只是 lstat 几十个文件；guard 钩子每次工具调用都重新起、建档规范模型随时会读，窗口别留太长
if (APP) setInterval(() => { try { APP.check(); } catch {} }, 10e3).unref?.();
/** 每轮起 claude 前调：小目录被改的先写回 */
export const checkAppFiles = () => { try { return APP ? APP.check() : []; } catch { return []; } };
