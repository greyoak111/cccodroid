// pkg —— 在 cccodroid 里装 Termux 仓库的包。
//
// Termux 的包把路径写死成 /data/data/com.termux/…，而 cc.codroid 和 com.termux 一样长（10 个字符），
// 所以和打工具包时一样，逐字节把 /data/data/com.termux/ 换成 /data/data/cc.codroid/ 就能原样跑，
// 不用 patchelf、不用 proot。zip 类归档（.jar/.whl…）里面是压缩过的，要解开改完再压回去。
//
// 规矩：
//   · 工具包（以及扩展页装的组件）已有的包不重装、不升级 —— 它们归工具包管，更新工具包才换版本
//   · 包里的文件和已有文件撞名：保留原来的，不覆盖（记作 shared）
//   · 白名单里的包在本机实测过；别的包要加 --unverified，能不能跑要自己试
//   · 装了什么记在 files/pkg/installed.json（工具包目录之外）。工具包更新会整个换掉 usr/，
//     之后 `pkg restore` 按记录重新装回
//   · 每个包也写 var/lib/dpkg/info/<包>.list（有的 postinst 靠它判断别的包在不在）
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { TERMUX_KEYS, verifyDetached } from "./pgp.mjs";     // 正本在 devkit/pgp.mjs，打包时拷到这旁边

const PREFIX = process.env.PREFIX || process.env.CCAPP_PREFIX;
if (!PREFIX || !fs.existsSync(path.join(PREFIX, ".devkit-ok"))) {
  console.error("pkg：工具包还没装好（找不到 $PREFIX/.devkit-ok）");
  process.exit(1);
}
const FILES = path.dirname(PREFIX);
const STATE = path.join(FILES, "pkg");
const DB = path.join(STATE, "installed.json");
const INFO = path.join(PREFIX, "var/lib/dpkg/info");
const TERMUX = "/data/data/com.termux/";
const TARGET = "/data/data/" + (FILES.match(/^\/data\/(?:data|user\/\d+)\/([^/]+)\/files$/) || [])[1] + "/";
const BIN = (n) => path.join(PREFIX, "bin", n);
if (TARGET.length !== TERMUX.length) { console.error(`pkg：本应用的包名必须恰好 10 个字符才能等长改写（现在是 ${TARGET}）`); process.exit(1); }
// 经加载器（targetSdk 36）时 dpkg 脚本等仍要 termux-exec 的 linker 版，才能起数据目录里的程序
const ENV = { ...process.env, PATH: [path.join(PREFIX, "bin"), process.env.PATH].join(":"), LD_PRELOAD: process.env.CCAPP_BIONIC_PRELOAD || "" };

// 和工具包用同一组仓库（devkit/devkit.json 的 repos）
const REPOS = [
  { name: "main", base: "https://packages-cf.termux.dev/apt/termux-main/", dist: "stable", component: "main", arch: "aarch64",
    mirrors: ["https://packages.termux.dev/apt/termux-main/", "https://grimler.se/termux/termux-main/",
      "https://mirrors.tuna.tsinghua.edu.cn/termux/apt/termux-main/", "https://mirrors.ustc.edu.cn/termux/apt/termux-main/",
      "https://mirrors.bfsu.edu.cn/termux/apt/termux-main/", "https://mirror.nju.edu.cn/termux/apt/termux-main/"] },
  { name: "glibc", base: "https://packages-cf.termux.dev/apt/termux-glibc/", dist: "glibc", component: "stable", arch: "aarch64",
    mirrors: ["https://packages.termux.dev/apt/termux-glibc/"] },          // 国内镜像都没同步 glibc 仓库（2026-10-20 查过清华/中科大/北外/南大）
  { name: "x11", base: "https://packages-cf.termux.dev/apt/termux-x11/", dist: "x11", component: "main", arch: "aarch64",
    mirrors: ["https://packages.termux.dev/apt/termux-x11/",
      "https://mirrors.tuna.tsinghua.edu.cn/termux/apt/termux-x11/", "https://mirrors.ustc.edu.cn/termux/apt/termux-x11/",
      "https://mirrors.bfsu.edu.cn/termux/apt/termux-x11/", "https://mirror.nju.edu.cn/termux/apt/termux-x11/"] },
];
// 仓库索引的签名钥：Termux 自动构建钥（termux-keyring 的 termux-autobuilds.gpg；与 keyserver.ubuntu.com、keys.openpgp.org 上同指纹的一致）。
// Release 验过签名，Packages.gz 按 Release 里的 sha256 核，每个 .deb 再按 Packages 里的 sha256 核 —— 所以从哪个镜像下都一样可信。
// 签名文件取不到的源一律不用，官方域名也一样（以前官方域名会退回只靠 HTTPS，整条信任链就落到中间人手里）；全都取不到时用缓存的旧索引
// 钥匙（TERMUX_KEYS）和验签都在旁边的 pgp.mjs

// 在本应用里没有意义的包（给 Termux App 本身发广播的）
const EXCLUDE = new Set(["termux-am", "termux-am-socket", "termux-api", "termux-tools", "termux-exec", "termux-keyring", "termux-licenses"]);
// 解包时丢掉的文件：Termux App 专属脚本；以及我们自己的 pkg/apt 入口别被盖掉
const DROP = new Set(["usr/bin/termux-wake-lock", "usr/bin/termux-wake-unlock", "usr/bin/pkg", "usr/bin/apt", "usr/bin/apt-get"]);
// 本机实测能用的包（装上 + 跑过一遍）。值是验证时跑的命令
// 2026-10-17 在工具包 devkit-2026.10.15.1 上实测（装上 + 编译 / 起服务 / 跑一段代码）
const VERIFIED = {
  rust: "rustc -V",                 // rustc + cargo（含 crates.io 依赖）
  golang: "go version",
  zig: "zig version",
  ruby: "ruby -v",
  php: "php -v",
  lua54: "lua5.4 -v",
  "python-numpy": "python3 -c 'import numpy; print(numpy.__version__)'",
  neovim: "nvim --version",
  vim: "vim --version",
  nano: "nano --version",
  tmux: "tmux -V",
  htop: "htop --version",
  tree: "tree --version",
  wget: "wget --version",
  rsync: "rsync --version",
  redis: "redis-server --version",
  postgresql: "postgres --version",
  libreoffice: "soffice --headless --version",  // 无头转 PDF（文件查看器看 ppt/doc 用），2026-10-17 实测
};

const HELP = `用法：pkg <命令> [参数]
  install <包…>        安装（连同依赖）。不在白名单里的包要加 --unverified
  uninstall <包…>      卸载用 pkg 装的包（remove 同义）；不再被需要的依赖一并卸掉
  list                 列出用 pkg 装的包
  search <关键词>      在仓库里搜（名字和简介）
  show <包>            包的信息：版本、大小、依赖、装没装、谁装的
  files <包>           列出用 pkg 装的包放了哪些文件
  update               重新下载仓库索引（平时一天自动刷新一次）
  upgrade [包…]        把用 pkg 装的包升到仓库里的新版
  restore              工具包更新后，把之前用 pkg 装的包重新装回
  verified             列出本机实测过的包（白名单）
说明：包来自 Termux 官方仓库，按本应用路径改写后安装。工具包自带的包（clang、python、node…）
不经 pkg 升级，更新工具包时一起换新。`;

// ── 小工具 ─────────────────────────────────────────────────────────────
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const mb = (n) => (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + " MB";
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
function writeJson(f, v) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f + ".tmp", JSON.stringify(v, null, 1));
  fs.renameSync(f + ".tmp", f);
}
const die = (msg, code = 1) => { console.error("pkg：" + msg); process.exit(code); };
function hashFile(f) {
  const h = crypto.createHash("sha256"), fd = fs.openSync(f, "r"), buf = Buffer.alloc(1 << 20);
  try { for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, n)); } finally { fs.closeSync(fd); }
  return h.digest("hex");
}
function curlBuf(url, timeout = 120) {
  const r = spawnSync(BIN("curl"), ["-fsSL", "--proto", "=https", "--proto-redir", "=https", "--retry", "2", "--max-time", String(timeout), url], { env: ENV, maxBuffer: 256 << 20 });
  if (r.status !== 0) throw new Error(`${url}：${String(r.stderr || "").trim().split("\n").pop() || "curl rc=" + r.status}`);
  return r.stdout;
}

// Debian 版本比较（epoch:upstream-revision，~ 排在一切之前）
function verCmp(a, b) {
  const parse = (v) => { const m = /^(?:(\d+):)?(.*?)(?:-([^-]*))?$/.exec(v); return [Number(m[1] || 0), m[2], m[3] || "0"]; };
  const ord = (c) => (c === "~" ? -1 : !c ? 0 : /[A-Za-z]/.test(c) ? c.charCodeAt(0) : c.charCodeAt(0) + 256);
  const part = (x, y) => {
    let i = 0, j = 0;
    while (i < x.length || j < y.length) {
      while ((i < x.length && !/\d/.test(x[i])) || (j < y.length && !/\d/.test(y[j]))) {
        const cx = i < x.length && !/\d/.test(x[i]) ? x[i] : "", cy = j < y.length && !/\d/.test(y[j]) ? y[j] : "";
        const d = ord(cx) - ord(cy);
        if (d) return d;
        if (cx) i++; if (cy) j++;
      }
      let nx = "", ny = "";
      while (i < x.length && /\d/.test(x[i])) nx += x[i++];
      while (j < y.length && /\d/.test(y[j])) ny += y[j++];
      const d = Number(nx || 0) - Number(ny || 0);
      if (d) return d;
    }
    return 0;
  };
  const [ea, ua, ra] = parse(a), [eb, ub, rb] = parse(b);
  return ea - eb || part(ua, ub) || part(ra, rb);
}
function verOk(have, op, want) {
  if (!op) return true;
  const c = verCmp(have, want);
  return { ">=": c >= 0, ">": c >= 0, "<=": c <= 0, "<": c <= 0, ">>": c > 0, "<<": c < 0, "=": c === 0 }[op] ?? true;
}
const atom = (s) => { const m = /^\s*([^\s(]+)\s*(?:\(\s*([<>=]+)\s*([^)\s]+)\s*\))?/.exec(s); if (!m) return { name: "" }; return { name: m[1].replace(/:any$/, ""), op: m[2], ver: m[3] }; };

// 锁里那个 pid 还是不是 pkg：pid 会被复用，只看活没活会把不相干的进程当成「另一个 pkg」（审查 低14）。
// 别的用户的进程（kill 报 EPERM）不可能是我们的 pkg；/proc 读不到 cmdline 时保守当它在跑
function pkgAlive(pid) {
  try { process.kill(pid, 0); } catch { return false; }
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("pkg"); } catch { return true; }
}

// 同一时间只许一个 pkg 在改东西
function lock() {
  fs.mkdirSync(STATE, { recursive: true });
  const f = path.join(STATE, ".lock");
  // 用 wx 原子占锁：先查再写，两个 pkg 同时起来会都以为自己拿到了（审查 10-30 第九份 安卓低15）。占着的进程已经没了就清掉重占
  for (let i = 0; ; i++) {
    try { fs.writeFileSync(f, String(process.pid), { flag: "wx" }); break; }
    catch (e) { if (e.code !== "EEXIST" || i >= 2) throw e; }
    let pid = 0; try { pid = Number(fs.readFileSync(f, "utf8")); } catch {}
    if (pid && pid !== process.pid && pkgAlive(pid)) die(`另一个 pkg（pid ${pid}）正在运行，等它结束再试`);
    try { fs.unlinkSync(f); } catch {}
  }
  process.on("exit", () => { try { if (fs.readFileSync(f, "utf8") === String(process.pid)) fs.unlinkSync(f); } catch {} });
  for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(s, () => { console.error("\npkg：被中断（再跑一次同样的命令会接着来）"); process.exit(130); });
}

// ── 已装的是什么 ───────────────────────────────────────────────────────
function devkitId() { return readJson(path.join(PREFIX, ".devkit-ok"), {}); }
function db() {
  const d = readJson(DB, null) || { pkgs: {} };
  d.pkgs ||= {};
  return d;
}
/** 工具包的 lock（包名 → 版本）。只用来判断依赖的版本要求够不够；拿不到就当未知 */
function baseVersions() {
  const id = devkitId(), f = path.join(STATE, "devkit.lock.json");
  let l = readJson(f, null);
  if (!l || l._for !== id.sha256) {
    l = null;
    if (id.base) {
      try { l = JSON.parse(curlBuf(id.base + "devkit.lock.json", 60).toString()); l._for = id.sha256; writeJson(f, l); } catch {}
    }
  }
  return new Map(((l && l.packages) || []).map((p) => [p.name, p.version]));
}
/** 模块化工具包（0.3.9 起）：没装的模块里有哪些包（包名 → 模块名）。这些包归模块管，pkg 不另装一份 ——
 *  不然以后装模块就和 pkg 装的撞了。整包工具包返回空表 */
function absentModulePkgs() {
  const m = new Map();
  const mj = readJson(path.join(PREFIX, "libexec/devkit/modules.json"), null);
  for (const b of (mj && mj.modules) || []) {
    if (b.kind === "base" || fs.existsSync(path.join(PREFIX, b.dir, ".ok"))) continue;
    // 共享层不单独露面：报给用它的模块
    const name = b.kind === "shared" ? (b.users || []).map((u) => ((mj.modules.find((x) => x.id === u) || {}).name || {}).zh || u).join("、") : (b.name || {}).zh || b.id;
    for (const p of b.packages || []) if (!m.has(p.name)) m.set(p.name, name);
  }
  return m;
}
function dieForModules(names) {
  const mods = absentModulePkgs(), hit = new Map();
  for (const n of names) if (mods.has(n)) hit.set(mods.get(n), [...(hit.get(mods.get(n)) || []), n]);
  if (!hit.size) return;
  die([...hit].map(([mod, ns]) => `${ns.slice(0, 6).join("、")}${ns.length > 6 ? " 等" : ""} 在工具包的「${mod}」模块里`).join("\n") +
    "\n先到 扩展 → 工具包模块 装上它，再来 pkg install（不另装一份，免得和模块撞）");
}

/** 盘上所有包（工具包、组件、pkg 装的）：名字来自 var/lib/dpkg/info/*.list */
function onDisk() {
  const s = new Set();
  try { for (const f of fs.readdirSync(INFO)) if (f.endsWith(".list")) s.add(f.slice(0, -5)); } catch {}
  return s;
}
/** 路径（相对 $PREFIX）→ 认领它的包 */
function owners() {
  const m = new Map(), pre = TARGET + "files/usr/";
  let fsl = []; try { fsl = fs.readdirSync(INFO); } catch {}
  for (const f of fsl) {
    if (!f.endsWith(".list")) continue;
    const pk = f.slice(0, -5);
    for (const l of fs.readFileSync(path.join(INFO, f), "utf8").split("\n")) if (l.startsWith(pre)) {
      const r = l.slice(pre.length);
      if (!m.has(r)) m.set(r, []);
      m.get(r).push(pk);
    }
  }
  return m;
}


// ── 仓库索引（缓存一天）───────────────────────────────────────────────
function loadRepo(repo) {
  const cf = path.join(STATE, "index", repo.name + ".json");
  const c = readJson(cf, null);
  if (c && !FORCE_UPDATE && Date.now() - c.at < 86400e3) return c;
  let lastErr;
  for (const base of [repo.base, ...repo.mirrors]) {
    try {
      const relBuf = curlBuf(`${base}dists/${repo.dist}/Release`);
      let sig = null; try { sig = curlBuf(`${base}dists/${repo.dist}/Release.gpg`, 60).toString(); } catch {}
      if (!sig) throw new Error("Release 的签名取不到");
      verifyDetached(relBuf, sig, TERMUX_KEYS);              // 签名不对直接抛，换下一个源
      const rel = relBuf.toString();
      const rp = `${repo.component}/binary-${repo.arch}/Packages.gz`;
      const want = (rel.split("SHA256:")[1] || "").split("\n").find((l) => l.trim().endsWith(" " + rp));
      if (!want) throw new Error("Release 里没有 " + rp);
      const gz = curlBuf(`${base}dists/${repo.dist}/${rp}`, 300);
      if (sha256(gz) !== want.trim().split(/\s+/)[0]) throw new Error("Packages.gz 和 Release 记的哈希对不上");
      const pkgs = {};
      for (const blk of zlib.gunzipSync(gz).toString().split("\n\n")) {
        const f = {};
        for (const l of blk.split("\n")) { const m = l.match(/^([\w-]+): (.*)$/); if (m) f[m[1]] = m[2]; }
        if (!f.Package) continue;
        pkgs[f.Package] = { v: f.Version, f: f.Filename, h: f.SHA256, s: +f.Size, i: +(f["Installed-Size"] || 0) * 1024,
          d: [f["Pre-Depends"], f.Depends].filter(Boolean).join(", "), p: f.Provides || "", t: f.Description || "", hp: f.Homepage || "" };
      }
      const out = { at: Date.now(), date: (rel.match(/^Date: (.+)$/m) || [])[1] || "", from: base, pkgs };
      writeJson(cf, out);
      return out;
    } catch (e) { lastErr = e; }
  }
  if (c) { console.error(`pkg：仓库 ${repo.name} 刷新失败（${lastErr.message}），先用旧索引`); return c; }
  throw lastErr;
}
let FORCE_UPDATE = false, IDX = null;
function index() {
  if (IDX) return IDX;
  const pkgs = new Map(), provides = new Map();
  // 单个仓库取不到就先跳过（例如 glibc 仓库国内没有镜像，连不上官方时不该连累 main 里的包）；全取不到才报错
  let okRepos = 0, lastErr;
  for (const repo of REPOS) {
    let r;
    try { r = loadRepo(repo); okRepos++; repo.from = r.from; }
    catch (e) { lastErr = e; console.error(`pkg：仓库 ${repo.name} 的索引取不到（${e.message}），这次先不用它`); continue; }
    for (const [n, p] of Object.entries(r.pkgs)) {
      if (pkgs.has(n)) continue;
      pkgs.set(n, { name: n, ...p, repo });
      for (const v of p.p.split(",")) {
        const k = v.trim().split(/[\s(]/)[0];
        if (k) { if (!provides.has(k)) provides.set(k, []); provides.get(k).push(n); }
      }
    }
  }
  if (!okRepos) throw lastErr;
  return (IDX = { pkgs, provides });
}

// ── 求解：要装哪些包、按什么顺序 ──────────────────────────────────────
/**
 * @return {order: 依赖在前的包名, problems: 满足不了的}
 * 盘上已有的包算满足（工具包的有版本信息就核对版本要求）；pkg 自己装过的旧版本需要更新时一并升级
 */
function solve(roots, { upgrade = false } = {}) {
  const ix = index(), have = onDisk(), base = baseVersions(), mine = db().pkgs;
  const order = [], seen = new Set(), problems = [];
  const installedVer = (n) => (mine[n] ? mine[n].version : base.get(n));
  const satisfied = (a) => {
    if (have.has(a.name)) {
      const v = installedVer(a.name);
      if (!v || verOk(v, a.op, a.ver)) return true;
      if (mine[a.name]) return false;                          // 自己装的旧版：升级
      problems.push(`${a.name} 要 ${a.op} ${a.ver}，工具包里是 ${v}（等工具包更新）`);
      return true;
    }
    return (ix.provides.get(a.name) || []).some((p) => have.has(p));
  };
  const visit = (n, from) => {
    if (seen.has(n)) return;
    seen.add(n);
    if (EXCLUDE.has(n)) return;
    const p = ix.pkgs.get(n);
    if (!p) { problems.push(`仓库里没有 ${n}${from ? `（${from} 要的）` : ""}`); return; }
    for (const d of p.d.split(",")) {
      if (!d.trim()) continue;
      const alts = d.split("|").map(atom);
      if (alts.some(satisfied)) continue;
      const pick = alts.map((a) => (ix.pkgs.has(a.name) ? a.name : (ix.provides.get(a.name) || [])[0])).find(Boolean);
      if (!pick) { problems.push(`${d.trim()}（${n} 要的）仓库里没有`); continue; }
      const a = alts.find((x) => x.name === pick);
      if (a && a.op && !verOk(ix.pkgs.get(pick).v, a.op, a.ver)) problems.push(`${n} 要 ${pick} ${a.op} ${a.ver}，仓库里是 ${ix.pkgs.get(pick).v}`);
      visit(pick, n);
    }
    order.push(n);                                             // 依赖在前
  };
  for (const r of roots) {
    const n = ix.pkgs.has(r) ? r : (ix.provides.get(r) || [])[0] || r;
    if (have.has(n) && !(upgrade && mine[n])) continue;
    visit(n, null);
  }
  // 已经是这个版本的（restore / upgrade 时会碰到）不再装
  return { order: order.filter((n) => !(have.has(n) && (!mine[n] || mine[n].version === ix.pkgs.get(n).v))), problems };
}

// ── 下载 ───────────────────────────────────────────────────────────────
function download(p) {
  const dir = path.join(STATE, "cache");
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, path.basename(p.f).replace(/:/g, "%3a"));
  if (fs.existsSync(dest) && hashFile(dest) === p.h) return dest;
  const part = dest + ".part";
  const tty = process.stderr.isTTY;
  let gone = 0;                                                // 回 404 的源数：全是 404 就是索引过期（包已经换了新版本）
  // 索引是从哪个源拿到的，包就先从那儿下（官方连不上时不用每个包都先在官方地址上空等）
  const all = [p.repo.base, ...p.repo.mirrors], from = p.repo.from;
  for (const base of from && all.includes(from) ? [from, ...all.filter((b) => b !== from)] : all) {
    for (let i = 0; i < 3; i++) {
      // 进度条走 stderr 照常显示；stdout 只收 HTTP 状态码
      const r = spawnSync(BIN("curl"), ["-fL", "--proto", "=https", "--proto-redir", "=https", tty ? "-#" : "-sS", "-C", "-", "--speed-limit", "10000", "--speed-time", "30", "-w", "%{http_code}", "-o", part, base + p.f],
        { env: ENV, stdio: ["ignore", "pipe", "inherit"] });
      if (String(r.stdout || "").trim() === "404") { gone++; break; }
      let size = 0; try { size = fs.statSync(part).size; } catch {}
      if (size >= p.s) {
        if (size === p.s && hashFile(part) === p.h) { fs.renameSync(part, dest); return dest; }
        fs.rmSync(part, { force: true });                      // 坏了：从头再来
      } else if (r.status === 0) fs.rmSync(part, { force: true });
    }
    console.error(`  ${new URL(base).host} 下载不顺，换镜像…`);
  }
  if (gone === 1 + p.repo.mirrors.length) { const e = new Error(`${p.name} ${p.v}：仓库里已经没有这个文件（索引过期）`); e.stale = true; throw e; }
  throw new Error(`${p.name}：下载失败或文件校验不符`);
}

// ── 解包 + 改写 ────────────────────────────────────────────────────────
/** 不整个读进内存：按 ar 头逐个找成员，返回 {name, offset, size} */
function arMembers(file) {
  const fd = fs.openSync(file, "r"), st = fs.fstatSync(fd), out = [];
  try {
    const magic = Buffer.alloc(8); fs.readSync(fd, magic, 0, 8, 0);
    if (magic.toString() !== "!<arch>\n") throw new Error("不是 deb（ar 归档）");
    const h = Buffer.alloc(60);
    for (let off = 8; off + 60 <= st.size;) {
      fs.readSync(fd, h, 0, 60, off);
      const name = h.subarray(0, 16).toString().trim().replace(/\/$/, ""), size = parseInt(h.subarray(48, 58).toString().trim(), 10);
      out.push({ name, offset: off + 60, size });
      off += 60 + size + (size % 2);
    }
  } finally { fs.closeSync(fd); }
  return out;
}
function extractMember(file, m, dst) {
  const fd = fs.openSync(file, "r"), out = fs.openSync(dst, "w"), buf = Buffer.alloc(1 << 20);
  try {
    for (let done = 0; done < m.size;) {
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, m.size - done), m.offset + done);
      if (n <= 0) throw new Error("deb 被截断");
      fs.writeSync(out, buf, 0, n); done += n;
    }
  } finally { fs.closeSync(fd); fs.closeSync(out); }
}
function decompress(buf, name) {
  if (name.endsWith(".gz")) return zlib.gunzipSync(buf);
  if (name.endsWith(".xz")) return execFileSync(BIN("xz"), ["-dc"], { input: buf, env: ENV, maxBuffer: 64 << 20 });
  if (name.endsWith(".zst")) return execFileSync(BIN("zstd"), ["-dc"], { input: buf, env: ENV, maxBuffer: 64 << 20 });
  return buf;
}
function* readTar(buf) {
  const str = (b) => { const i = b.indexOf(0); return b.subarray(0, i < 0 ? b.length : i).toString(); };
  for (let off = 0; off + 512 <= buf.length;) {
    const h = buf.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    const size = parseInt(str(h.subarray(124, 136)).trim() || "0", 8);
    yield { name: str(h.subarray(0, 100)).replace(/^\.\//, ""), type: String.fromCharCode(h[156] || 48), data: buf.subarray(off + 512, off + 512 + size) };
    off += 512 + Math.ceil(size / 512) * 512;
  }
}
function controlScripts(file, members) {
  const m = members.find((x) => x.name.startsWith("control.tar"));
  if (!m) return {};
  const fd = fs.openSync(file, "r"), raw = Buffer.alloc(m.size);
  try { fs.readSync(fd, raw, 0, m.size, m.offset); } finally { fs.closeSync(fd); }
  const out = {};
  for (const e of readTar(decompress(raw, m.name))) if (["postinst", "prerm", "postrm"].includes(e.name)) out[e.name] = e.data.toString();
  return out;
}

const A = Buffer.from(TERMUX), B = Buffer.from(TARGET);
function swap(buf) {
  let i = buf.indexOf(A);
  if (i < 0) return [buf, 0];
  const out = Buffer.from(buf); let n = 0;
  for (; i >= 0; i = out.indexOf(A, i + A.length)) { B.copy(out, i); n++; }
  return [out, n];
}
const swapStr = (s) => swap(Buffer.from(s))[0].toString();

// zip 类归档：条目是 deflate 压缩的，平铺替换找不到。按中央目录顺序原样重建（jlink 之类会拒绝重排过的归档）
const ZIP_EXT = [".jmod", ".jar", ".zip", ".whl", ".egg", ".aar", ".apk"];
const CRC_TABLE = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function rewriteZip(buf) {
  const LOC = 0x04034b50, CEN = 0x02014b50, EOCD = 0x06054b50;
  let base = -1;
  for (const o of [0, 4, 8]) if (o + 4 <= buf.length && buf.readUInt32LE(o) === LOC) { base = o; break; }
  if (base < 0) return [buf, 0];
  let eocd = -1;
  for (let i = buf.length - 22; i >= base && i >= buf.length - 22 - 65535; i--) if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  if (eocd < 0) return [buf, 0];
  const nent = buf.readUInt16LE(eocd + 10), cdOff = buf.readUInt32LE(eocd + 16) + base;
  if (nent === 0xffff || cdOff === 0xffffffff) return [buf, 0];
  let hits = 0, pos = base, p = cdOff;
  const locals = [], cens = [];
  for (let i = 0; i < nent; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN) return [buf, 0];
    const cen = Buffer.from(buf.subarray(p, p + 46));
    const nlen = cen.readUInt16LE(28), elen = cen.readUInt16LE(30), clen = cen.readUInt16LE(32);
    const name = Buffer.from(buf.subarray(p + 46, p + 46 + nlen));
    const extra = Buffer.from(buf.subarray(p + 46 + nlen, p + 46 + nlen + elen));
    const comment = Buffer.from(buf.subarray(p + 46 + nlen + elen, p + 46 + nlen + elen + clen));
    const method = cen.readUInt16LE(10), csize = cen.readUInt32LE(20), lo = cen.readUInt32LE(42) + base;
    p += 46 + nlen + elen + clen;
    if (lo + 30 > buf.length || buf.readUInt32LE(lo) !== LOC) return [buf, 0];
    const lnlen = buf.readUInt16LE(lo + 26), lelen = buf.readUInt16LE(lo + 28);
    const lh = Buffer.from(buf.subarray(lo, lo + 30));
    const lname = Buffer.from(buf.subarray(lo + 30, lo + 30 + lnlen)), lextra = buf.subarray(lo + 30 + lnlen, lo + 30 + lnlen + lelen);
    const [nameOut, kn] = swap(name), [lnameOut] = swap(lname);
    hits += kn;
    let data = Buffer.from(buf.subarray(lo + 30 + lnlen + lelen, lo + 30 + lnlen + lelen + csize));
    let usize = cen.readUInt32LE(24), crc = cen.readUInt32LE(16);
    if (method === 8) {
      let raw; try { raw = zlib.inflateRawSync(data); } catch { return [buf, 0]; }
      const [dec, k] = swap(raw);
      if (k) { hits += k; data = zlib.deflateRawSync(dec, { level: 9 }); usize = dec.length; crc = crc32(dec); cen.writeUInt32LE(data.length, 20); cen.writeUInt32LE(usize, 24); cen.writeUInt32LE(crc, 16); }
    } else if (method === 0) {
      const [d, k] = swap(data);
      if (k) { hits += k; data = d; crc = crc32(d); cen.writeUInt32LE(crc, 16); }
    } else return [buf, 0];
    lh.writeUInt16LE(lh.readUInt16LE(6) & ~8, 6); cen.writeUInt16LE(cen.readUInt16LE(8) & ~8, 8);
    cen.writeUInt32LE(pos - base, 42);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(usize, 22); lh.writeUInt32LE(crc, 14);
    locals.push(lh, lnameOut, lextra, data); cens.push(cen, nameOut, extra, comment);
    pos += 30 + lnlen + lelen + data.length;
  }
  if (!hits) return [buf, 0];
  const cd = Buffer.concat(cens), e = Buffer.from(buf.subarray(eocd, eocd + 22));
  e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(pos - base, 16);
  return [Buffer.concat([buf.subarray(0, base), ...locals, cd, e, buf.subarray(eocd + 22)]), hits];
}

/** 解到暂存区并就地改写。返回 {root: 暂存区里对应 $PREFIX 的目录, files, dirs, scripts} */
function unpack(p, deb) {
  const stage = path.join(STATE, "stage", p.name);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  const members = arMembers(deb);
  const dm = members.find((m) => m.name.startsWith("data.tar"));
  if (!dm) throw new Error(`${p.name}：deb 里没有 data.tar`);
  const dt = path.join(stage, dm.name);
  extractMember(deb, dm, dt);
  const r = spawnSync(BIN("tar"), ["-xf", dt, "-C", stage, "--no-same-owner"], { env: ENV, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${p.name}：解包失败：${(r.stderr || "").trim().split("\n").pop()}`);
  fs.rmSync(dt);
  const root = path.join(stage, TERMUX.slice(1), "files", "usr");
  const files = [], dirs = [];
  let patched = 0;
  (function walk(rel) {
    const abs = rel ? path.join(root, rel) : root;
    let ents; try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const d of ents) {
      const r = rel ? rel + "/" + d.name : d.name, f = path.join(root, r);
      if (DROP.has("usr/" + r)) { fs.rmSync(f, { force: true }); continue; }
      if (d.isDirectory()) { dirs.push(r); walk(r); continue; }
      if (d.isSymbolicLink()) {
        const t = fs.readlinkSync(f), t2 = swapStr(t);
        if (t2 !== t) { fs.unlinkSync(f); fs.symlinkSync(t2, f); }
      } else if (d.isFile()) {
        const st = fs.statSync(f);
        if (st.nlink > 1) { const b = fs.readFileSync(f); fs.unlinkSync(f); fs.writeFileSync(f, b, { mode: st.mode }); }   // 硬链接拆开，各改各的
        const b = fs.readFileSync(f);
        const [o, k] = ZIP_EXT.some((e) => r.toLowerCase().endsWith(e)) ? rewriteZip(b) : swap(b);
        if (k) { fs.writeFileSync(f, o); fs.chmodSync(f, st.mode & 0o7777); patched++; }
      } else continue;
      files.push(r);
    }
  })("");
  // 前缀之外的条目（极少，如 Termux 的 home 目录模板）不要
  return { root, files, dirs, patched, scripts: controlScripts(deb, members), stage };
}

/** update-alternatives 的 --install/--slave → [{link: 相对 $PREFIX, target: 绝对路径（已改写）, group, prio}] */
function alternatives(script) {
  const flat = (script || "").replace(/\\\n/g, " "), out = [];
  for (const m of flat.matchAll(/--install\s+"([^"]+)"\s+"([^"]+)"\s+"([^"]+)"\s+(\d+)((?:\s+--slave\s+"[^"]+"\s+"[^"]+"\s+"[^"]+")*)/g)) {
    const links = [[m[1], m[3]]];
    for (const s of m[5].matchAll(/--slave\s+"([^"]+)"\s+"([^"]+)"\s+"([^"]+)"/g)) links.push([s[1], s[3]]);
    for (const [l, t] of links) { const r = relOf(swapStr(l)); if (r) out.push({ link: r, target: swapStr(t), group: m[2], prio: +m[4] }); }
  }
  return out;
}
/**
 * 按 dpkg 的规矩摆 alternatives 链接：同一个链接谁优先级高指向谁；真文件（某个包自带的同名命令）压过链接；
 * 工具包自己的链接不动。pkg 建的链接记在 d.altLinks，候选没了就删掉。装、卸之后各跑一次
 */
function relinkAlts(d) {
  const best = new Map(), managed = new Set(d.altLinks || []);
  for (const rec of Object.values(d.pkgs)) for (const a of rec.alts || []) {
    if (!fs.existsSync(a.target)) continue;
    const b = best.get(a.link);
    if (!b || a.prio > b.prio) best.set(a.link, a);
  }
  for (const r of new Set([...managed, ...best.keys()])) {
    const f = path.join(PREFIX, r), want = best.get(r);
    let st = null; try { st = fs.lstatSync(f); } catch {}
    if (st && !managed.has(r)) continue;                       // 工具包的、或某个包的真文件
    if (st && !st.isSymbolicLink()) { managed.delete(r); continue; }
    if (!want) { if (st) fs.unlinkSync(f); managed.delete(r); continue; }
    if (st && fs.readlinkSync(f) === want.target) continue;
    if (st) fs.unlinkSync(f);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.symlinkSync(want.target, f);
    managed.add(r);
  }
  d.altLinks = [...managed].sort();
  writeJson(DB, d);
}
const restOf = (script) => (script || "").replace(/# Automatically added by termux_step_create_alternatives[\s\S]*?# End automatically added section/g, "")
  .split("\n").filter((l) => l.trim() && !l.startsWith("#!") && !/^\s*exit 0\s*$/.test(l)).length > 0;
const relOf = (abs) => abs.startsWith(TARGET + "files/usr/") ? abs.slice((TARGET + "files/usr/").length) : null;

// ── 装 ─────────────────────────────────────────────────────────────────
function placeOne(p, u, { auto, upgrade }, d) {
  const old = d.pkgs[p.name], mineBefore = new Set((old && old.files) || []);
  // 升级 / 重装：先清掉旧版独有的文件（新版也有的直接覆盖）
  if (old) removeFiles(p.name, old, owners(), new Set(u.files));
  const rec = { version: p.v, repo: p.repo.name, auto: old ? (upgrade ? old.auto : old.auto && auto) : auto, at: Date.now(), state: "installing",
    deps: p.d, files: [], shared: [], base: devkitId().sha256 || "" };
  // 已经在的（工具包、组件或别的包放的）不覆盖、不归我们，记进 shared
  const alt = new Set(d.altLinks || []);
  for (const r of u.files) {
    let exists = false; try { fs.lstatSync(path.join(PREFIX, r)); exists = true; } catch {}
    (exists && !mineBefore.has(r) && !alt.has(r) ? rec.shared : rec.files).push(r);
  }
  d.altLinks = [...alt].filter((r) => !rec.files.includes(r));   // 被真文件取代的链接不再归 alternatives 管
  d.pkgs[p.name] = rec; writeJson(DB, d);                      // 先记"将要放哪些"：搬到一半被杀也能按它卸干净
  for (const r of rec.files) {
    const dst = path.join(PREFIX, r);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    try { fs.rmSync(dst, { force: true }); } catch {}
    fs.renameSync(path.join(u.root, r), dst);
  }
  for (const r of u.dirs) fs.mkdirSync(path.join(PREFIX, r), { recursive: true });
  rec.alts = alternatives(u.scripts.postinst);                 // 链接由 relinkAlts 统一摆
  // 卸载时要跑的脚本、首次配置脚本：前缀已改写，放在 files/pkg/scripts/<包>/
  const sd = path.join(STATE, "scripts", p.name);
  fs.rmSync(sd, { recursive: true, force: true });
  for (const k of ["postinst", "prerm", "postrm"]) if (u.scripts[k] && restOf(u.scripts[k])) {
    fs.mkdirSync(sd, { recursive: true });
    fs.writeFileSync(path.join(sd, k), swapStr(u.scripts[k]).replace(/^.*\/py3compile" -p .*$/gm, ":"), { mode: 0o755 });
  }
  const pre = TARGET + "files/usr/";
  fs.mkdirSync(INFO, { recursive: true });
  fs.writeFileSync(path.join(INFO, p.name + ".list"), [...u.dirs, ...rec.files].map((r) => pre + r).join("\n") + "\n");
  writeJson(DB, d);
  return rec;
}
function runScript(name, kind, ...args) {
  const f = path.join(STATE, "scripts", name, kind);
  if (!fs.existsSync(f)) return;
  const r = spawnSync(BIN("sh"), [f, ...args], { env: ENV, stdio: "inherit", cwd: process.env.HOME || FILES });
  if (r.status !== 0) console.error(`  （${name} 的 ${kind} 退出码 ${r.status}，继续）`);
}

function install(names, { unverified = false, auto = false, upgrade = false } = {}) {
  const ix = index(), have = onDisk(), mine = db().pkgs;
  const roots = [];
  for (const n of names) {
    const real = ix.pkgs.has(n) ? n : (ix.provides.get(n) || [])[0];
    if (!real) { const near = [...ix.pkgs.keys()].filter((k) => k.includes(n)).slice(0, 6); die(`仓库里没有 ${n}${near.length ? "。相近的：" + near.join(" ") : ""}`); }
    if (EXCLUDE.has(real)) die(`${real} 是给 Termux App 本身用的，在 cccodroid 里没有意义`);
    if (have.has(real) && !mine[real]) { console.log(`${real} 已在工具包里（${baseVersions().get(real) || "版本未知"}），不用装`); continue; }
    if (have.has(real) && mine[real] && !upgrade) { console.log(`${real} ${mine[real].version} 已经装了`); continue; }
    if (!VERIFIED[real] && !unverified && !auto) die(`${real} 还没在 cccodroid 上验证过。确定要试就加 --unverified：pkg install --unverified ${real}\n本机实测过的：${Object.keys(VERIFIED).join(" ")}`);
    roots.push(real);
  }
  if (!roots.length) return;
  dieForModules(roots);
  const { order, problems } = solve(roots, { upgrade });
  dieForModules(order);
  if (problems.length) {
    console.error("依赖有问题：\n  " + problems.join("\n  "));
    if (!unverified) die("没有装（加 --unverified 可以硬装，后果自负）");
  }
  if (!order.length) { console.log("没有要装的"); return; }
  const dl = order.reduce((s, n) => s + ix.pkgs.get(n).s, 0), inst = order.reduce((s, n) => s + ix.pkgs.get(n).i, 0);
  console.log(`要装 ${order.length} 个包：${order.map((n) => n + " " + ix.pkgs.get(n).v).join("、")}`);
  console.log(`下载约 ${mb(dl)}，装好占约 ${mb(inst)}`);
  try {
    const sf = fs.statfsSync(FILES), free = sf.bavail * sf.bsize;
    if (free < (dl * 2 + inst) * 1.1) die(`存储空间不够：要约 ${mb((dl * 2 + inst) * 1.1)}，剩 ${mb(free)}`);
  } catch {}
  const debs = [];
  for (const [i, n] of order.entries()) {
    const p = ix.pkgs.get(n);
    console.log(`下载 [${i + 1}/${order.length}] ${n} ${p.v}（${mb(p.s)}）`);
    try { debs.push([p, download(p)]); }
    catch (e) {
      // 索引是一天一刷，期间仓库发了新版、旧文件被删就会 404：刷新索引重新求解，只重来一次
      if (!e.stale || FORCE_UPDATE) throw e;
      console.error(`${e.message}，刷新仓库索引后重试…`);
      FORCE_UPDATE = true; IDX = null;
      return install(names, { unverified, auto, upgrade });
    }
  }
  const d = db(), placed = [];
  for (const [p, deb] of debs) {
    process.stdout.write(`安装 ${p.name} … `);
    const u = unpack(p, deb);
    const rec = placeOne(p, u, { auto: auto || !roots.includes(p.name), upgrade }, d);
    console.log(`${rec.files.length} 个文件${u.patched ? `，改写 ${u.patched} 个` : ""}${rec.shared.length ? `，${rec.shared.length} 个已存在、保留原样` : ""}`);
    fs.rmSync(u.stage, { recursive: true, force: true });
    placed.push(p);
  }
  relinkAlts(d);
  for (const p of placed) {                                    // 依赖在前，与 dpkg 一致
    if (fs.existsSync(path.join(STATE, "scripts", p.name, "postinst"))) { console.log(`配置 ${p.name}`); runScript(p.name, "postinst", "configure"); }
    d.pkgs[p.name].state = "ok"; writeJson(DB, d);
  }
  for (const [, deb] of debs) fs.rmSync(deb, { force: true });
  for (const p of placed) if (roots.includes(p.name) && VERIFIED[p.name]) {
    const r = spawnSync(BIN("sh"), ["-c", VERIFIED[p.name]], { env: ENV, encoding: "utf8", timeout: 30000 });
    console.log(r.status === 0 ? `✓ ${p.name}：${(r.stdout || r.stderr).trim().split("\n")[0]}` : `⚠ ${p.name} 装上了，但「${VERIFIED[p.name]}」失败：${(r.stderr || r.stdout || "").trim().split("\n").pop()}`);
  }
  console.log("完成");
}

// ── 卸 ─────────────────────────────────────────────────────────────────
/** 删掉 rec 里归这个包的文件；别的包（.list）也认领的、或 keep 里的留下 */
function removeFiles(name, rec, own, keep = new Set()) {
  const dirs = new Set();
  for (const r of rec.files || []) {
    if (keep.has(r) || (own.get(r) || []).some((o) => o !== name)) continue;
    try { fs.rmSync(path.join(PREFIX, r), { force: true }); } catch {}
    dirs.add(path.dirname(r));
  }
  // 空目录往上收（只删空的）
  for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
    for (let x = dir; x && x !== "."; x = path.dirname(x)) { try { fs.rmdirSync(path.join(PREFIX, x)); } catch { break; } }
  }
}
function uninstall(names, { force = false } = {}) {
  const d = db(), ix = index();
  for (const n of names) {
    if (!d.pkgs[n]) { onDisk().has(n) ? die(`${n} 是工具包（或扩展组件）带的，不能用 pkg 卸`) : die(`${n} 没有用 pkg 装过`); }
  }
  const gone = new Set(names);
  // 剩下的 pkg 包里还有谁依赖要卸的
  const needs = (n) => (d.pkgs[n].deps || "").split(",").flatMap((x) => x.split("|").map((a) => atom(a).name)).filter(Boolean);
  for (const n of Object.keys(d.pkgs)) {
    if (gone.has(n)) continue;
    const hit = needs(n).filter((x) => gone.has(x));
    if (hit.length && !force) die(`${n} 要用 ${hit.join("、")}，先卸 ${n}（或加 --force）`);
  }
  // 自动装上的依赖：没人要了就一起卸
  for (let changed = true; changed;) {
    changed = false;
    const wanted = new Set();
    for (const n of Object.keys(d.pkgs)) if (!gone.has(n)) for (const x of needs(n)) { wanted.add(x); for (const pv of (ix.provides.get(x) || [])) wanted.add(pv); }
    for (const n of Object.keys(d.pkgs)) if (d.pkgs[n].auto && !gone.has(n) && !wanted.has(n)) { gone.add(n); changed = true; }
  }
  if (!gone.size) { console.log("没有要卸的"); return; }
  console.log(`卸载：${[...gone].join("、")}`);
  for (const n of gone) runScript(n, "prerm", "remove");
  for (const n of gone) {
    const own = owners();
    removeFiles(n, d.pkgs[n], own);
    try { fs.rmSync(path.join(INFO, n + ".list"), { force: true }); } catch {}
    runScript(n, "postrm", "remove");
    fs.rmSync(path.join(STATE, "scripts", n), { recursive: true, force: true });
    delete d.pkgs[n]; writeJson(DB, d);
  }
  relinkAlts(d);
  console.log("完成");
}

// ── 工具包换了版本 ─────────────────────────────────────────────────────
/** 记录里的包在盘上已经没了（工具包整个换掉了 usr/）：返回这些包名 */
function lost() {
  const d = db(), have = onDisk();
  return Object.keys(d.pkgs).filter((n) => !have.has(n));
}
// 要装回的包名先落盘、装成功才删：以前先删旧记录再下载，索引或下载一失败清单就没了，再 restore 说「没有要装回的」（审查 B24）
const PENDING = () => path.join(STATE, "restore-pending.json");
function pendingRestore() {
  try { const j = JSON.parse(fs.readFileSync(PENDING(), "utf8")); return Array.isArray(j) ? j.filter((n) => typeof n === "string" && n) : []; } catch { return []; }
}
function restore() {
  const d = db(), gone = lost(), pend = pendingRestore();
  if (!gone.length && !pend.length) { console.log("没有要装回的"); return; }
  const manual = [...new Set([...pend, ...gone.filter((n) => !d.pkgs[n].auto)])];
  writeJson(PENDING(), manual);
  for (const n of gone) delete d.pkgs[n];                      // 旧记录作废，按新工具包重新求解
  writeJson(DB, d);
  console.log(`工具包更新后要装回：${manual.join("、")}`);
  if (manual.length) install(manual, { unverified: true, upgrade: true });
  fs.rmSync(PENDING(), { force: true });
}

// ── 入口 ───────────────────────────────────────────────────────────────
let argv = process.argv.slice(2);
const flag = (...ks) => { const has = argv.some((a) => ks.includes(a)); argv = argv.filter((a) => !ks.includes(a)); return has; };
const unverified = flag("--unverified"), force = flag("--force"), json = flag("--json");
flag("-y", "--yes", "--assume-yes", "-q", "--quiet", "--no-install-recommends");
const sub = argv.shift() || "help", args = argv;

if (["help", "-h", "--help"].includes(sub)) { console.log(HELP); process.exit(0); }
const MUT = ["install", "add", "uninstall", "remove", "purge", "autoremove", "upgrade", "full-upgrade", "restore", "reinstall", "update"];
if (MUT.includes(sub)) lock();
if (sub !== "restore") {
  const l = lost();
  if (l.length) console.error(`提示：工具包换过版本，之前用 pkg 装的 ${l.filter((n) => !db().pkgs[n].auto).join("、") || l.join("、")} 已不在，运行 pkg restore 装回`);
  else if (pendingRestore().length) console.error(`提示：上次 pkg restore 没装完（${pendingRestore().join("、")}），再运行一次 pkg restore 接着装`);
}
try {
  switch (sub) {
    case "install": case "add": case "reinstall":
      if (!args.length) die("要装什么？pkg install <包>");
      if (sub === "reinstall") for (const n of args) if (db().pkgs[n]) { uninstall([n], { force: true }); }
      install(args, { unverified });
      break;
    case "uninstall": case "remove": case "purge": case "rm":
      if (!args.length) die("要卸什么？pkg uninstall <包>");
      uninstall(args, { force });
      break;
    case "autoremove": uninstall([], {}); break;
    case "list": case "list-installed": {
      const d = db().pkgs, ks = Object.keys(d).sort();
      if (json) { console.log(JSON.stringify(d, (k, v) => (k === "files" || k === "shared" ? v.length : v), 1)); break; }
      if (!ks.length) { console.log("还没有用 pkg 装过包（工具包自带的不算）"); break; }
      for (const n of ks) console.log(`${n.padEnd(28)} ${d[n].version.padEnd(16)} ${d[n].auto ? "（依赖）" : ""}${d[n].state !== "ok" ? " ⚠ 没装完，重装或卸掉" : ""}`);
      break;
    }
    case "list-all": for (const n of [...index().pkgs.keys()].sort()) console.log(n); break;
    case "search": {
      if (!args.length) die("搜什么？pkg search <关键词>");
      const q = args.join(" ").toLowerCase(), have = onDisk(), mine = db().pkgs;
      const hits = [...index().pkgs.values()].filter((p) => p.name.toLowerCase().includes(q) || p.t.toLowerCase().includes(q))
        .sort((a, b) => (b.name.includes(q) - a.name.includes(q)) || a.name.localeCompare(b.name));
      for (const p of hits.slice(0, 60)) {
        const tag = mine[p.name] ? "[已装]" : have.has(p.name) ? "[工具包]" : VERIFIED[p.name] ? "[实测]" : "";
        console.log(`${p.name} ${p.v} ${tag}\n  ${p.t}`);
      }
      if (hits.length > 60) console.log(`…共 ${hits.length} 个，只列前 60 个`);
      if (!hits.length) console.log("没找到");
      break;
    }
    case "show": case "info": {
      for (const n of args) {
        const p = index().pkgs.get(n), mine = db().pkgs[n], base = onDisk().has(n) && !mine;
        if (!p && !mine) { console.log(`仓库里没有 ${n}`); continue; }
        console.log(`包：${n}`);
        if (p) console.log(`仓库版本：${p.v}（${p.repo.name}）\n下载：${mb(p.s)}  装好：${mb(p.i)}\n简介：${p.t}\n主页：${p.hp}\n依赖：${p.d || "无"}`);
        console.log(`状态：${mine ? `已用 pkg 装 ${mine.version}${mine.auto ? "（作为依赖）" : ""}` : base ? `工具包自带 ${baseVersions().get(n) || ""}` : "没装"}`);
        console.log(`本机实测：${VERIFIED[n] ? "是" : "否（装要加 --unverified）"}\n`);
      }
      break;
    }
    case "files": {
      const r = db().pkgs[args[0]];
      if (!r) die(`${args[0] || "?"} 没有用 pkg 装过`);
      for (const f of r.files) console.log(path.join(PREFIX, f));
      break;
    }
    case "update": FORCE_UPDATE = true; index(); console.log("仓库索引已更新"); break;
    case "upgrade": case "full-upgrade": {
      FORCE_UPDATE = sub === "upgrade" && !args.length;
      const d = db().pkgs, ix = index();
      const want = (args.length ? args : Object.keys(d).filter((n) => !d[n].auto)).filter((n) => d[n]);
      const stale = Object.keys(d).filter((n) => ix.pkgs.has(n) && verCmp(ix.pkgs.get(n).v, d[n].version) > 0);
      if (!stale.length) { console.log("用 pkg 装的包都是最新的（工具包自带的包随工具包更新）"); break; }
      console.log(`有新版：${stale.map((n) => `${n} ${d[n].version}→${ix.pkgs.get(n).v}`).join("、")}`);
      install(want.filter((n) => stale.includes(n)).concat(stale.filter((n) => !want.includes(n) && !args.length)), { unverified: true, upgrade: true });
      break;
    }
    case "restore": restore(); break;
    case "verified": for (const [n, c] of Object.entries(VERIFIED)) console.log(`${n.padEnd(16)} ${c}`); break;
    default: die(`不认识的命令 ${sub}\n\n${HELP}`, 2);
  }
} catch (e) {
  die(e.message);
}
