// 之前的对话留下的后台进程：一轮结束后，claude 起的东西本该跟着走（进程组 + killTree），
// 用 nohup / setsid 脱出去的会留下来，比如一直把改掉的配置写回去的守护进程。起下一轮前查一遍，列出来让用户决定。
//
// 怎么认：网关起 claude 时环境变量带 CCAPP_RUN_ID、CCAPP_GW_PID（run.mjs），子孙进程都继承；
// 带着一个已经结束的轮次编号、还活着的，就是留下来的。抹掉环境（env -i）再起的认不出编号，
// 退一步：被 init 收养（PPID=1）、属于本应用、环境里一个 CCAPP_ 变量都没有的，算「来源不明」（只在 cccodroid 里认，开发机上同 uid 的东西太杂）。
// 用户点过「保留」的按 pid + 启动时刻记住，不再问；它以后新起的子孙也一并不问（顺着 PPID 往上找到保留过的就算）。
// 记录落盘（ccapp-leftover-kept.json），网关重启后照认；只认同一次开机（boot_id）、pid + 启动时刻 + 命令行都对得上的，
// 换了开机或者 pid 被别的进程复用就不算。记录和 ccapp-userconf.json 一样在 home 里，同 uid 改得动，防的是忘了、不是防存心。
// 还在跑的轮次编号别人也读得到（同 uid 能读 /proc/<claude>/environ）：带着它、但比那一轮的 claude 进程起得早的照样列
// （真是那一轮起的都是 claude 的子孙，只会更晚；execve 换环境不改启动时刻。安卓上应用读不了 /proc/stat 的开机时刻，所以比滴答数不比墙钟）。
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { CFG, LIVE, PREFIX, log } from "./config.mjs";
import { descendants } from "./claude.mjs";

let KEPT = null;              // Map("pid:starttime" → 命令行)，第一次用时从盘上读
const KEPT_FILE = () => path.join(CFG.home, "ccapp-leftover-kept.json");
const bootId = () => { try { return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(); } catch { return ""; } };
// 应用自己会起、会被 init 收养的（adb 服务端自己 fork 成守护进程）
const SKIP_COMM = new Set(["adb"]);

function readProc(pid) {
  let stat, status, env = [], cmd = "";
  try { stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8"); status = fs.readFileSync(`/proc/${pid}/status`, "utf8"); } catch { return null; }
  const close = stat.lastIndexOf(")"), f = stat.slice(close + 2).split(" ");
  const comm = stat.slice(stat.indexOf("(") + 1, close);
  const uid = +(/^Uid:\s+(\d+)/m.exec(status) || [])[1];
  try { env = fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0"); } catch {}
  try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" "); } catch {}
  return { pid, ppid: +f[1], start: f[19], comm, uid, env, cmd: cmd || `[${comm}]` };
}
/** 进程启动时刻（开机后的时钟滴答，/proc/<pid>/stat 第 22 项）。读不到返回 null */
export function procStart(pid) { const p = pid ? readProc(pid) : null; return p ? p.start : null; }
/** 「现在」的开机滴答：安卓上应用读不了 /proc/uptime，起一个一闪而过的进程读它自己的启动时刻 */
export function nowTicks() {
  try { const s = execFileSync("/system/bin/cat", ["/proc/self/stat"], { encoding: "utf8", timeout: 3000 }); return s.slice(s.lastIndexOf(")") + 2).split(" ")[19] || null; }
  catch { return null; }
}
function loadKept() {
  if (KEPT) return KEPT;
  KEPT = new Map();
  try {
    const j = JSON.parse(fs.readFileSync(KEPT_FILE(), "utf8")), boot = bootId();
    if (j && boot && j.boot === boot && j.kept && typeof j.kept === "object")
      for (const [k, cmd] of Object.entries(j.kept)) {
        const m = /^(\d+):(\d+)$/.exec(k), p = m && readProc(+m[1]);
        if (p && p.start === m[2] && p.cmd === cmd) KEPT.set(k, cmd);   // 还活着、还是那个进程才认
      }
  } catch {}
  return KEPT;
}
function saveKept() {
  const boot = bootId();
  if (!boot) return;
  // 已经退出的不留
  for (const k of [...KEPT.keys()]) { const [pid, st] = k.split(":"), p = readProc(+pid); if (!p || p.start !== st) KEPT.delete(k); }
  try {
    const tmp = KEPT_FILE() + ".tmp-" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, boot, kept: Object.fromEntries(KEPT) }), { mode: 0o600 });
    fs.renameSync(tmp, KEPT_FILE());
  } catch (e) { log(`[留下的进程] 记不下保留名单：${e.message}`); }
}
const allPids = () => { try { return fs.readdirSync("/proc").filter((n) => /^\d+$/.test(n)).map(Number); } catch { return []; } };

/** 留下来的进程。active：还在跑的轮次 Map(编号字符串 → 那一轮 claude 进程的启动滴答，还没起是 null) */
export function leftoverProcs(active) {
  const me = process.getuid?.(), out = [];
  if (me == null) return out;
  const kept = loadKept(), seen = new Set(), procs = new Map();
  for (const pid of allPids()) { const p = readProc(pid); if (p && p.uid === me) procs.set(pid, p); }
  // 自己或者哪一层祖先是保留过的（保留的看护后来起的探活、sleep 之类）。孤儿只会被 init 收养，接不到别人名下
  const keptLine = (p) => { for (let i = 0; p && i < 64; i++, p = procs.get(p.ppid)) if (kept.has(`${p.pid}:${p.start}`)) return true; return false; };
  for (const [pid, p] of procs) {
    if (pid === process.pid || pid === process.ppid) continue;
    if (keptLine(p)) continue;
    const rid = (p.env.find((e) => e.startsWith("CCAPP_RUN_ID=")) || "").slice(13);
    let kind = null;
    // cccodroid 里只有一个网关，带编号的都算（旧版网关起的不带 CCAPP_GW_PID，环境变量也改得掉，所以不核）；
    // 开发机上同时跑着别的网关、几份测试（端口、home 都可能一样）：测试里只认本进程起的。
    // 开发机上的真网关（LIVE）也会把别的网关实例起的算进来——只是卡片多列几项，还要人点确认，不自动杀
    if (rid) {
      const mine = LIVE || p.env.includes("CCAPP_GW_PID=" + process.pid);
      const t0 = active.get(rid);
      const live = active.has(rid) && t0 != null && +p.start >= +t0;   // 那一轮还没起 claude 就带着它的编号：冒充的
      if (mine && !live) kind = "run";
    }
    else if (LIVE && PREFIX && p.ppid === 1 && !SKIP_COMM.has(p.comm) && !p.env.some((e) => e.startsWith("CCAPP_"))) kind = "unknown";
    if (!kind) continue;
    seen.add(pid);
    out.push({ pid, start: p.start, ppid: p.ppid, kind, cmd: p.cmd.replace(/[\x00-\x1f]/g, " ").slice(0, 200) });
  }
  // 只列最上面那一层：父进程也在单子里的，子进程跟着一起处理
  return out.filter((p) => !seen.has(p.ppid)).slice(0, 30);
}

/** 用户点了保留：连子孙一起记住 */
export function keepProcs(list) {
  const kept = loadKept();
  for (const p of list || []) {
    const root = readProc(p.pid);
    if (!root || root.start !== p.start) continue;     // 卡片上那个已经退出、pid 换了人
    kept.set(`${p.pid}:${root.start}`, root.cmd);
    for (const x of descendants(p.pid)) { const q = readProc(x); if (q) kept.set(`${x}:${q.start}`, q.cmd); }
  }
  saveKept();
}

/** 结束这些进程和它们的子孙。核对启动时刻，pid 已经换了人的不碰 */
export function killProcs(list) {
  const roots = [];
  for (const p of list || []) {
    const now = readProc(p.pid);
    if (now && now.start === p.start && now.uid === process.getuid?.()) roots.push(p.pid);
  }
  // 先全部停住再杀：互相拉起的几个守护进程，不会在杀到一半时把同伴再拉起来。
  // 列子孙和停住之间还能 fork 出新的：停完再列一遍，没有新的为止（最多几轮）
  const all = new Set();
  for (let i = 0; i < 4; i++) {
    const add = [];
    for (const r of roots) for (const x of [r, ...descendants(r)]) if (!all.has(x)) { all.add(x); add.push(x); }
    for (const x of add) try { process.kill(x, "SIGSTOP"); } catch {}
    if (!add.length) break;
  }
  let n = 0;
  for (const x of all) { try { process.kill(x, "SIGKILL"); n++; } catch {} }
  log(`[留下的进程] 结束了 ${n} 个`);
  return n;
}

/** 测试用：丢掉内存里的保留名单，下次从盘上读（模拟网关重启） */
export function _keptReset() { KEPT = null; }
