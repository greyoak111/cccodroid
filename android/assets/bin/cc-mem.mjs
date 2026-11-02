// cc-mem —— 内存管家：重活之前清场，跑的时候压住「杀了又活」的后台应用。
// 经 priv（Shizuku，shell 身份）调 am / dumpsys；默认关闭，在 cccodroid 设置里打开。
//
// 保护谁（不碰）：
//   1. 安卓自己判为前台 / 可见 / 可感知 / 常驻的进程（分屏另一半、挂前台通知的代理、正在播放的音乐……）
//   2. 自动识别：桌面、输入法、无障碍服务、VPN、Shizuku、本应用、系统核心组件
//   3. 设置里的白名单
// 其余处于「服务 / 缓存」档的应用都可以停。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const HOME = process.env.CCAPP_HOME || process.env.HOME || HERE;
const SETTINGS_FILE = path.join(HOME, "ccapp-settings.json");
const STATE_FILE = path.join(HOME, ".cc-mem-state.json");

const HELP = `用法:
  cc-mem status [--json]          内存账：可用多少、谁占着、哪些受保护、哪些可以停
  cc-mem clear [--hard] [--dry-run] [--json]
                                  停掉白名单以外的后台应用（默认 stop-app，--hard 用 force-stop）
  cc-mem run [--] <命令…>         重活专用：清场（force-stop）+ 系统内存压缩，跑命令期间
                                  每 2 秒巡视一次，复活的立刻再停；结束后打印报告
  cc-mem protected                列出受保护的应用及原因
  cc-mem tame <包名…>             长期限制后台（治反复复活的）；cc-mem untame <包名…> 恢复原状
  cc-mem tamed                    列出被限制的应用
  cc-mem jobs [--per <MB>] [--explain]
                                  按现在的可用内存算安全的并行数，只打印一个数字：make -j$(cc-mem jobs)
                                  --per 每个任务估多少 MB（默认 700，C++ 编译的量级；轻活给 200～300）
内存管家默认关闭：status / protected / jobs / clear --dry-run 随时可用，其余要先在设置里打开。`;

// ── 基础 ──────────────────────────────────────────────────────────────
function privArgv() {
  // cccodroid：priv.mjs 和本文件同在 app/bin，直接用 node 跑（解包出来的文件不一定带可执行位）
  const sib = path.join(HERE, "priv.mjs");
  return fs.existsSync(sib) ? [process.execPath, sib] : ["priv"];   // 开发端：PATH 上的 priv
}
function priv(cmd, timeout = 30000) {
  // 两路合成一路再读：开发端的 rish 客户端会把输出随机拆到 stdout / stderr 两个管道，分开接收各得一半
  const r = spawnSync("/system/bin/sh", ["-c", `exec "$@" 2>&1`, "sh", ...privArgv(), `{ ${cmd}\n} 2>&1`], { encoding: "utf8", timeout, maxBuffer: 64 << 20 });
  if (r.error) throw new Error(`priv 调用失败：${r.error.message}`);
  // 125 连不上 cccodroid、126 Shizuku 没运行/没授权、127 起进程失败：都不能当成「没有输出」往下走，否则会显示「可停的应用 0 个」
  if (r.status >= 125 && r.status <= 127) throw new Error((r.stdout || "").replace(/^priv: /gm, "").trim() || "priv 不可用（Shizuku 没启动或没授权）");
  return { out: r.stdout || "", err: r.stdout || "", code: r.status };
}
const sh = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
const PKG_RE = /^[A-Za-z][\w]*(\.[\w]+)+$/;

function readJson(f, dflt) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return dflt; } }
function config() {
  const s = readJson(SETTINGS_FILE, {});
  const g = s.memGuard || {};
  return { enabled: !!g.enabled, whitelist: Array.isArray(g.whitelist) ? g.whitelist.filter((p) => PKG_RE.test(p)) : [] };
}

function meminfo() {
  const v = {};
  for (const l of fs.readFileSync("/proc/meminfo", "utf8").split("\n")) {
    const m = l.match(/^(\w+):\s+(\d+)/);
    if (m) v[m[1]] = Number(m[2]) * 1024;
  }
  return {
    total: v.MemTotal, available: v.MemAvailable, free: v.MemFree,
    anon: v.AnonPages, fileCache: (v.Cached || 0) + (v.Buffers || 0) - (v.Shmem || 0),
    swapUsed: (v.SwapTotal || 0) - (v.SwapFree || 0),
  };
}
const MB = (b) => `${Math.round(b / 1048576)}M`;
const GB = (b) => `${(b / 1073741824).toFixed(1)}G`;

// ── 进程与保护名单 ────────────────────────────────────────────────────
// dumpsys activity lru 的分档：这些档里的应用可以停（服务、缓存、上一个应用、备份、重量级）
const KILLABLE = /^(svc|svcb|cch.*|prev|bkup|hvy|psvc)$/;
const CLASS_NAME = { pers: "常驻", sys: "系统", fg: "前台", vis: "可见", prcp: "可感知", prcl: "可感知", impf: "可感知", home: "桌面", svc: "服务", svcb: "服务", prev: "上一个应用", bkup: "备份", hvy: "重量级" };
// 动了会出事的系统组件（多数本来就在常驻档，这里兜底）
const CORE = [/^android$/, /^android\./, /^com\.android\.(systemui|phone|providers\..*|networkstack.*|bluetooth|nfc|se|shell|server\..*|inputdevices|location\.fused|externalstorage|mtp|settings|permissioncontroller|packageinstaller|vending)$/,
  /^com\.google\.android\.(permissioncontroller|packageinstaller)$/,      // 权限弹窗、安装确认被停掉会打断用户（审查 10-29 第六份 低1）
  /^com\.google\.android\.(gms|gsf|ext\.services)$/, /^moe\.shizuku\.privileged\.api$/, /^cc\.codroid$/, /^li\.dsh\./];

/** 进程分档（lru）+ 每个进程加载了哪些包（processes）。
 *  后者要紧：停掉一个包，安卓会连带杀掉所有加载过它的进程 —— 停 WebView 包就把用 WebView 的应用全带走了，
 *  停联想日历连分屏服务一起死（实测）。所以「不停的进程」依赖的包也必须保护。 */
function processes() {
  const out = priv("echo @LRU; dumpsys activity lru; echo @PROC; dumpsys activity processes | grep -E '^ +\\*[A-Z]+\\* |packageList=|packageDependencies=|->[0-9]+:.* s[1-9]'", 60000).out;
  const [lru, proc = ""] = out.split("@PROC");
  const loaded = [];        // { pid, own: 所属的包, pkgs: 活着就离不开的包（自己的 + 依赖的 + 稳定连着的提供者） }
  let cur = null;
  for (const l of proc.split("\n")) {
    const h = l.match(/^\s+\*[A-Z]+\*.*ProcessRecord\{\w+ (\d+):/);
    if (h) { cur = { pid: Number(h[1]), own: [], pkgs: [] }; loaded.push(cur); continue; }
    const d = l.match(/package(List|Dependencies)=\{([^}]*)\}/);
    if (d && cur) {
      const ps = d[2].split(",").map((x) => x.trim()).filter(Boolean);
      cur.pkgs.push(...ps);
      if (d[1] === "List") cur.own.push(...ps);
    }
    // 稳定的 ContentProvider 连接：提供者进程一死，安卓连客户端一起杀
    const c = l.match(/^\s+- \w+\/([^/\s]+)\/\S*->\d+:\S+ s([1-9]\d*)\//);
    if (c && cur) cur.pkgs.push(c[1]);
  }
  // 一行进程都没读到：dumpsys 被拒或格式不认识。直接报错，别让界面说「0 个」
  if (!/^\s*#\s*\d+:/m.test(lru)) throw new Error("读不到进程列表（dumpsys activity lru）：" + (lru.replace(/^@LRU\s*/, "").trim().slice(0, 200) || "没有输出"));
  const list = [];
  for (const l of lru.split("\n")) {
    const m = l.match(/^\s*#\s*\d+:\s+(\S+).*?\s(\d+):([^\s/]+)\/(\S+)/);
    if (!m) continue;
    const [, cls, pid, proc, uid] = m;
    if (!/^u\d+a\d+$/.test(uid)) continue;            // 只管普通应用：系统 uid（1000 等）和隔离进程（…i93）不碰
    const own = (loaded.find((x) => x.pid === Number(pid)) || {}).own || [];
    // 进程名不一定是包名（实测 com.huawei.hwid.core 属于另一个包），以 packageList 为准
    const pkgs = own.length ? own : [proc.split(":")[0]];
    for (const pkg of pkgs) if (PKG_RE.test(pkg)) list.push({ cls, pid: Number(pid), proc, pkg, uid });
  }
  return { list, loaded };
}

function autoProtected() {
  const why = new Map();
  const add = (pkg, reason) => { if (pkg && PKG_RE.test(pkg) && !why.has(pkg)) why.set(pkg, reason); };
  // 一次 priv 拿全：桌面、输入法（默认与已启用）、无障碍、VPN 归属 uid
  const q = priv([
    "echo @HOME; cmd package resolve-activity --brief -c android.intent.category.HOME -a android.intent.action.MAIN | tail -1",
    "echo @IME; settings get secure default_input_method",
    "echo @A11Y; settings get secure enabled_accessibility_services",
    "echo @WEBVIEW; dumpsys webviewupdate | grep -oE 'Current WebView package \\(name, version\\): \\([^,]+'",
    "echo @VPN; dumpsys connectivity | grep -E 'Transports: VPN' | grep -oE 'OwnerUid: [0-9]+' | sort -u",
  ].join("; ")).out;
  let sec = "";
  const vpnUids = [];
  for (const l of q.split("\n")) {
    if (l.startsWith("@")) { sec = l.slice(1).trim(); continue; }
    const t = l.trim();
    if (!t || t === "null") continue;
    if (sec === "HOME") add(t.split("/")[0], "桌面");
    else if (sec === "IME") add(t.split("/")[0], "输入法");
    else if (sec === "A11Y") for (const s of t.split(":")) add(s.split("/")[0], "无障碍服务");
    else if (sec === "WEBVIEW") add(t.replace(/.*\(/, ""), "WebView 提供者");
    else if (sec === "VPN") { const m = t.match(/(\d+)/); if (m) vpnUids.push(m[1]); }
  }
  if (vpnUids.length) {
    const pl = priv(vpnUids.map((u) => `pm list packages --uid ${u}`).join("; ")).out;
    for (const m of pl.matchAll(/package:(\S+)/g)) add(m[1], "VPN");
  }
  return why;
}

/** 当前每个应用该怎么处置：protect（附原因）或 stop */
function plan() {
  const cfg = config();
  const { list: procs, loaded } = processes();
  const auto = autoProtected();
  const byPkg = new Map();
  for (const p of procs) {
    const e = byPkg.get(p.pkg) || { pkg: p.pkg, procs: [], classes: new Set() };
    e.procs.push(p); e.classes.add(p.cls.replace(/\+.*$/, ""));
    byPkg.set(p.pkg, e);
  }
  const apps = [];
  for (const e of byPkg.values()) {
    let reason = null;
    if (cfg.whitelist.includes(e.pkg)) reason = "白名单";
    else if (auto.has(e.pkg)) reason = auto.get(e.pkg);
    else if (CORE.some((r) => r.test(e.pkg))) reason = "系统核心";
    else {
      const keep = e.procs.find((p) => !KILLABLE.test(p.cls.replace(/\+.*$/, "")));
      if (keep) { const c = keep.cls.replace(/\+.*$/, ""); reason = CLASS_NAME[c] || c; }
    }
    apps.push({ pkg: e.pkg, pids: e.procs.map((p) => p.pid), classes: [...e.classes], protect: !!reason, reason });
  }
  // 依赖闭包：活下来的进程加载着的包都不能停；多保护一个包，就多一批进程活下来 —— 迭代到不再变化
  const procName = new Map(procs.map((p) => [p.pid, p.proc]));
  for (let changed = true; changed;) {
    changed = false;
    const doomed = new Set(apps.filter((a) => !a.protect).map((a) => a.pkg));
    for (const lp of loaded) {
      // 整个进程都归要停的包，才算会死。以前只要有一个归属包要停就跳过 —— 白名单包和别的包同进程时，
      // 停那个包会把白名单包的进程一起带走（#107 09-011）：有一个归属包要留，进程就得活，它加载的包全保护
      if (lp.own.length && lp.own.every((p) => doomed.has(p))) continue;
      for (const p of lp.pkgs) {
        if (!doomed.has(p)) continue;
        const a = apps.find((x) => x.pkg === p);
        a.protect = true; a.reason = `被 ${procName.get(lp.pid) || "pid " + lp.pid} 依赖`;
        doomed.delete(p); changed = true;
      }
    }
  }
  return { cfg, apps, auto };
}

/** 每个进程的 PSS（共享库按使用者均摊，加起来才不重复）。
 *  shell 身份读不到别人的 smaps_rollup，只能借 dumpsys meminfo 的汇总（约 2 秒） */
function pssByPid() {
  // 只要「Total PSS by process」那一段（特权命令白名单不收 sed，在这边截）
  const all = priv("dumpsys meminfo", 60000).out;
  const at = all.indexOf("Total PSS by process");
  const r = at < 0 ? "" : all.slice(at).split(/\n\s*\n/)[0];
  const m = {};
  for (const x of r.matchAll(/([\d,]+)K: \S+ \(pid (\d+)/g)) m[x[2]] = Number(x[1].replace(/,/g, "")) * 1024;
  return m;
}

/** 停一批包，逐个带回成败：{ stopped, failed }。以前整串只看最后一条的退出码，某个包没停下也报成停了（#107 09-003）。
 *  用 && / || 接 echo 标记（不用 $?：特权命令免问规则认不清变量，会逐条弹确认） */
function stopPkgs(pkgs, hard) {
  if (!pkgs.length) return { stopped: [], failed: [] };
  const verb = hard ? "am force-stop" : "am stop-app";
  const out = priv(pkgs.map((p) => `${verb} ${sh(p)} && echo @ok ${sh(p)} || echo @fail ${sh(p)}`).join("; "), 60000).out;
  const ok = new Set([...out.matchAll(/^@ok (\S+)\s*$/gm)].map((m) => m[1]));
  return { stopped: pkgs.filter((p) => ok.has(p)), failed: pkgs.filter((p) => !ok.has(p)) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function requireEnabled(cfg) {
  if (cfg.enabled) return;
  console.error("cc-mem: 内存管家没有打开。到 cccodroid「设置 → 内存管家」里打开后再用（status / protected / clear --dry-run 不受限）。");
  process.exit(3);
}

// ── 命令 ──────────────────────────────────────────────────────────────
async function cmdStatus(json) {
  const mem = meminfo();
  const { cfg, apps } = plan();
  const pss = pssByPid();
  // 一个进程加载了几个包：它的 PSS 按包数均摊，不然合计按包重复算（#107 09-012）
  const share = new Map();
  for (const a of apps) for (const p of a.pids) share.set(p, (share.get(p) || 0) + 1);
  for (const a of apps) a.pss = Math.round(a.pids.reduce((s, p) => s + (pss[p] || 0) / share.get(p), 0));
  apps.sort((x, y) => y.pss - x.pss);
  if (json) return console.log(JSON.stringify({ enabled: cfg.enabled, whitelist: cfg.whitelist, mem, apps }, null, 1));
  console.log(`内存管家：${cfg.enabled ? "已开启" : "未开启（设置里打开）"}`);
  console.log(`总量 ${GB(mem.total)}  可用 ${GB(mem.available)}（空闲 ${GB(mem.free)} + 可回收缓存）  进程匿名内存 ${GB(mem.anon)}  文件缓存 ${GB(mem.fileCache)}  swap 已用 ${GB(mem.swapUsed)}`);
  const stop = apps.filter((a) => !a.protect), keep = apps.filter((a) => a.protect);
  console.log(`\n可以停的 ${stop.length} 个，合计约 ${MB(stop.reduce((s, a) => s + a.pss, 0))}：`);
  for (const a of stop) console.log(`  ${MB(a.pss).padStart(6)}  ${a.pkg}`);
  console.log(`\n受保护的 ${keep.length} 个：`);
  for (const a of keep) console.log(`  ${MB(a.pss).padStart(6)}  ${a.pkg}  （${a.reason}）`);
}

async function cmdProtected() {
  const { cfg, auto } = plan();
  console.log("自动识别：");
  for (const [p, r] of auto) console.log(`  ${p}  （${r}）`);
  console.log("白名单：" + (cfg.whitelist.length ? "\n  " + cfg.whitelist.join("\n  ") : "（空）"));
  console.log("另外：安卓判为前台 / 可见 / 可感知 / 常驻的进程、系统核心组件，一律不动。");
}

async function cmdClear(hard, dry, json) {
  const before = meminfo();
  const { cfg, apps } = plan();
  if (!dry) requireEnabled(cfg);
  const targets = apps.filter((a) => !a.protect).map((a) => a.pkg);
  let r = { stopped: targets, failed: [] };
  if (!dry) { r = stopPkgs(targets, hard); await sleep(1500); }
  const after = meminfo();
  const res = { dryRun: dry, mode: hard ? "force-stop" : "stop-app", stopped: r.stopped, failed: r.failed, availableBefore: before.available, availableAfter: after.available };
  if (json) return console.log(JSON.stringify(res));
  if (!targets.length) return console.log("没有可停的后台应用。");
  if (r.stopped.length) console.log(`${dry ? "（演练，没真停）将要" : "已"}${hard ? "强制停止" : "停止"} ${r.stopped.length} 个：${r.stopped.join("、")}`);
  if (r.failed.length) console.log(`没停下 ${r.failed.length} 个：${r.failed.join("、")}`);
  if (!dry) console.log(`可用内存 ${GB(before.available)} → ${GB(after.available)}`);
}

async function cmdRun(argv) {
  if (argv[0] === "--") argv = argv.slice(1);
  if (!argv.length) { console.error(HELP); process.exit(2); }
  const { cfg, apps } = plan();
  requireEnabled(cfg);
  const start = meminfo();
  const first = stopPkgs(apps.filter((a) => !a.protect).map((a) => a.pkg), true).stopped;
  try { priv("am compact system", 20000); } catch {}
  await sleep(800);
  const ready = meminfo();
  console.error(`cc-mem: 清场 ${first.length} 个应用，可用内存 ${GB(start.available)} → ${GB(ready.available)}；开始执行`);

  const revived = new Map();            // 包名 → 复活被压次数
  const tamedNow = new Set();
  let minAvail = ready.available, busy = false, done = false, off = false;
  const tick = setInterval(() => {
    const m = meminfo().available;
    if (m < minAvail) minAvail = m;
    if (busy || done || off) return;
    busy = true;
    try {
      // 跑着的时候用户在设置里关了内存管家：不再清后台，这一轮限制过的恢复原级别；命令本身照常跑完（#107 09-002）
      if (!config().enabled) {
        off = true;
        for (const p of tamedNow) try { if (untame(p).code === 0) tamedNow.delete(p); } catch {}
        console.error("cc-mem: 内存管家关掉了，不再清后台" + (tamedNow.size ? `（这几个没恢复成：${[...tamedNow].join("、")}，可 cc-mem untame）` : ""));
        return;
      }
      const back = stopPkgs(plan().apps.filter((a) => !a.protect).map((a) => a.pkg), true).stopped;
      if (back.length) {
        for (const p of back) {
          const n = (revived.get(p) || 0) + 1;
          revived.set(p, n);
          // 学乖：一次重活里被压下 3 次还往回爬的，直接限制后台（cc-mem untame 可恢复）
          if (n === 3 && !tamedNow.has(p)) { tamedNow.add(p); try { tame(p); } catch {} }
        }
      }
    } catch {}
    busy = false;
  }, 2000);

  const child = spawn(argv[0], argv.slice(1), { stdio: "inherit" });
  for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(s, () => child.kill(s));
  const code = await new Promise((r) => {
    child.on("exit", (c, sig) => r(c ?? (sig ? 128 : 1)));
    child.on("error", (e) => { console.error(`cc-mem: 启动失败：${e.message}`); r(127); });
  });
  done = true; clearInterval(tick);
  const end = meminfo();
  const rv = [...revived].map(([p, n]) => `${p}×${n}`);
  console.error(`cc-mem: 结束（退出码 ${code}）。可用内存 开跑 ${GB(ready.available)}，最低 ${GB(minAvail)}，结束 ${GB(end.available)}` +
    (rv.length ? `；期间压下复活 ${rv.length} 个：${rv.join("、")}` : "；期间没有应用复活") +
    (tamedNow.size ? `；反复复活、已限制后台：${[...tamedNow].join("、")}（cc-mem untame <包名> 恢复）` : ""));
  process.exit(code);
}

// 限制一个包的后台，记下原来的级别；返回 priv 结果
function tame(p) {
  const st = readJson(STATE_FILE, { tamed: {} });
  const prev = (priv(`am get-bg-restriction-level ${sh(p)}`).out.trim().split(/\s+/).pop()) || "adaptive_bucket";
  if (!(p in st.tamed)) st.tamed[p] = prev;
  const r = priv(`am set-bg-restriction-level ${sh(p)} restricted`);
  if (r.code === 0) fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2), { mode: 0o600 });
  return { r, prev: st.tamed[p] };
}

// 恢复一个包原来的后台级别（tame 记下的）；返回 priv 结果
function untame(p) {
  const st = readJson(STATE_FILE, { tamed: {} });
  const prev = st.tamed[p] || "adaptive_bucket";
  const r = priv(`am set-bg-restriction-level ${sh(p)} ${sh(prev)}`);
  if (r.code === 0) { delete st.tamed[p]; fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2), { mode: 0o600 }); }
  return { ...r, prev };
}

function cmdTame(pkgs, undo) {
  const cfg = config();
  if (!undo) requireEnabled(cfg);             // 恢复随时可以：关了内存管家以后正要靠它把限制解开
  const st = readJson(STATE_FILE, { tamed: {} });
  for (const p of pkgs) {
    if (!PKG_RE.test(p)) { console.error(`跳过非法包名：${p}`); continue; }
    if (!undo) {
      if (CORE.some((r) => r.test(p))) { console.error(`跳过系统核心：${p}`); continue; }
      const { r, prev } = tame(p);
      if (r.code === 0) st.tamed[p] = prev;
      console.log(r.code === 0 ? `已限制后台：${p}（原来是 ${prev}）` : `失败：${p} ${r.err.trim()}`);
    } else {
      const prev = st.tamed[p] || "adaptive_bucket";
      const r = priv(`am set-bg-restriction-level ${sh(p)} ${sh(prev)}`);
      if (r.code === 0) { delete st.tamed[p]; console.log(`已恢复：${p} → ${prev}`); }
      else console.log(`失败：${p} ${r.err.trim()}`);
    }
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2), { mode: 0o600 });
}

// ── 并行数：留出系统和前台要用的，剩下的按每个任务的估计量分；不超过 CPU 核数 ──
function cmdJobs(argv) {
  const i = argv.indexOf("--per"), per = Math.max(50, Number(i >= 0 ? argv[i + 1] : 700) || 700) * 1048576;
  const m = meminfo(), cpus = Math.max(1, (os.availableParallelism ? os.availableParallelism() : os.cpus().length));
  const reserve = Math.max(1.5 * 1073741824, m.total * 0.12);   // 系统、输入法、WebView、Claude 本身
  const n = Math.max(1, Math.min(cpus, Math.floor((m.available - reserve) / per)));
  if (argv.includes("--explain")) {
    const g = (b) => (b / 1073741824).toFixed(1) + " GB";
    console.error(`可用 ${g(m.available)} − 预留 ${g(reserve)}，每个任务按 ${Math.round(per / 1048576)} MB 算 → ${n}（CPU ${cpus} 核）` +
      (n === 1 && m.available - reserve < per ? "。内存紧：先 cc-mem status 看谁占着，或单线程跑" : ""));
  }
  console.log(n);
}

// ── 入口 ──────────────────────────────────────────────────────────────
const [cmd, ...rest] = process.argv.slice(2);
const flag = (f) => rest.includes(f);
try {
  if (!cmd || cmd === "-h" || cmd === "--help") { console.log(HELP); process.exit(cmd ? 0 : 2); }
  else if (cmd === "status") await cmdStatus(flag("--json"));
  else if (cmd === "protected") await cmdProtected();
  else if (cmd === "clear") await cmdClear(flag("--hard"), flag("--dry-run"), flag("--json"));
  else if (cmd === "run") await cmdRun(rest);
  else if (cmd === "jobs") cmdJobs(rest);
  else if (cmd === "tame") cmdTame(rest, false);
  else if (cmd === "untame") cmdTame(rest, true);
  else if (cmd === "tamed") { const st = readJson(STATE_FILE, { tamed: {} }); const e = Object.entries(st.tamed); console.log(e.length ? e.map(([p, v]) => `${p}（原来 ${v}）`).join("\n") : "（无）"); }
  else { console.error(HELP); process.exit(2); }
} catch (e) {
  console.error(`cc-mem: ${e.message}`);
  process.exit(1);
}
