import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { CFG, GLIBC_PRELOAD, PATHS, PREFIX, glibcEnv, loadPgp, log, tz } from "./config.mjs";
import { SETTINGS } from "./settings-store.mjs";
import { enosysRun } from "./claude.mjs";
import { NEXT, readBody, sendJson } from "./http.mjs";
import { termEnv } from "./terminal.mjs";
import { sha256File } from "./components.mjs";
import { SKILLS_DIR } from "./extensions.mjs";
import { archiveProblem, parseTarListing, zipEntries } from "./archive-check.mjs";
import { ucAppBegin, ucAppWrote } from "./userconf.mjs";

// ── 自定义组件：用户自己导入的 Linux arm64 程序（不经市场，来源由用户负责） ─────────────────
// 放在 ~/.cccodroid/custom/<id>/（app/ 原样解开的程序，deps/ 自动补的 glibc 库），不进 $PREFIX：换工具包不会被冲掉。
// 入口包装在 ~/.cccodroid/bin（claudeEnv 的 PATH 里，排在工具包 bin 之后，所以不许和工具包的命令重名）；
// 技能在 ~/.claude/skills/custom-<id>/，Claude 由此知道有这个程序、怎么跑起来的。
// 适配按 ELF 的解释器分：glibc（经本应用的 ld-linux + seccomp 垫片）、bionic（安卓原生，设库路径）、
// 静态（套 seccomp 监督器）；x86 / 32 位 / musl 跑不了，分析时如实说。缺的 glibc 库从 Termux 的 glibc 仓库补。
const CUSTOM_DIR = PREFIX ? path.join(CFG.home, ".cccodroid", "custom") : "";
const CUSTOM_BIN = PREFIX ? path.join(CFG.home, ".cccodroid", "bin") : "";
const CUSTOM_REC = "cccodroid-custom.json";
const CUSTOM_STAGES = new Map();          // 分析过、还没装的：stage → { dir, root, report, at }
const GLIBC_REPO = "https://packages-cf.termux.dev/apt/termux-glibc/";
const GLIBC_REPO_LIB = "data/data/com.termux/files/usr/glibc/lib/";
const ELF_ARCH = { 183: "arm64", 62: "x86_64", 40: "arm32", 3: "x86", 243: "riscv64" };
const verCmp = (a, b) => { const x = a.split("."), y = b.split("."); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (+x[i] || 0) - (+y[i] || 0); if (d) return d; } return 0; };

/** 读 ELF：架构、位数、类型、解释器、依赖的库、SONAME、要求的最高 GLIBC 版本。不是 ELF 返回 null */
function elfInfo(file) {
  let fd; try { fd = fs.openSync(file, "r"); } catch { return null; }
  try {
    const h = Buffer.alloc(64);
    if (fs.readSync(fd, h, 0, 64, 0) < 64 || h.readUInt32BE(0) !== 0x7f454c46) return null;
    const info = { arch: ELF_ARCH[h.readUInt16LE(18)] || "machine-" + h.readUInt16LE(18), bits: h[4] === 2 ? 64 : 32, type: h.readUInt16LE(16), interp: "", needed: [], soname: "", glibc: "" };
    if (info.bits !== 64 || h[5] !== 1) return info;
    const phoff = Number(h.readBigUInt64LE(32)), phsz = h.readUInt16LE(54), phnum = h.readUInt16LE(56);
    // 程序头表的大小是文件自己报的：64 位的每项固定 56 字节，项数正常也就几十（最多 0xffff×0xffff ≈ 4 GB，审查 v0513b 低-12）
    if (phsz !== 56 || phnum > 1024) return info;
    const ph = Buffer.alloc(phsz * phnum); fs.readSync(fd, ph, 0, ph.length, phoff);
    const loads = []; let dyn = null;
    for (let i = 0; i < phnum; i++) {
      const o = i * phsz, t = ph.readUInt32LE(o);
      const off = Number(ph.readBigUInt64LE(o + 8)), va = Number(ph.readBigUInt64LE(o + 16)), fsz = Number(ph.readBigUInt64LE(o + 32));
      if (t === 1) loads.push({ off, va, fsz });
      else if (t === 3) { const b = Buffer.alloc(Math.min(fsz, 4096)); fs.readSync(fd, b, 0, b.length, off); info.interp = b.toString("latin1").replace(/\0[\s\S]*$/, ""); }
      else if (t === 2) dyn = { off, fsz };
    }
    if (dyn) {
      const d = Buffer.alloc(Math.min(dyn.fsz, 1 << 20)); fs.readSync(fd, d, 0, d.length, dyn.off);
      const need = []; let strtab = 0, strsz = 0, son = -1;
      for (let o = 0; o + 16 <= d.length; o += 16) {
        const tag = Number(d.readBigInt64LE(o)), val = Number(d.readBigUInt64LE(o + 8));
        if (tag === 0) break;
        if (tag === 1) need.push(val); else if (tag === 5) strtab = val; else if (tag === 10) strsz = val; else if (tag === 14) son = val;
      }
      const seg = loads.find((l) => strtab >= l.va && strtab < l.va + l.fsz);
      if (seg && strsz) {
        const s = Buffer.alloc(Math.min(strsz, 8 << 20)); fs.readSync(fd, s, 0, s.length, seg.off + (strtab - seg.va));
        const str = (i) => { const e = s.indexOf(0, i); return s.toString("latin1", i, e < 0 ? s.length : e); };
        info.needed = need.map(str);
        if (son >= 0) info.soname = str(son);
        for (const m of s.toString("latin1").matchAll(/GLIBC_(\d+\.\d+)/g)) if (!info.glibc || verCmp(m[1], info.glibc) > 0) info.glibc = m[1];
      }
    }
    return info;
  } catch { return null; } finally { fs.closeSync(fd); }
}
/** ELF 归类：glibc / bionic / musl / static 是程序，lib 是库，unsupported 是这台机器跑不了的 */
function elfKind(e, name) {
  if (e.arch !== "arm64" || e.bits !== 64) return "unsupported";
  if (/ld-linux|\/lib(64)?\/ld-/.test(e.interp)) return "glibc";
  if (/linker64$/.test(e.interp)) return "bionic";
  if (/ld-musl/.test(e.interp)) return "musl";
  if (e.interp) return "unsupported";
  if (e.soname || /\.so(\.[\d.]+)?$/.test(name) || (e.type === 3 && e.needed.length)) return "lib";
  return "static";
}
let GLIBC_VER;
function glibcVersion() {
  if (GLIBC_VER !== undefined) return GLIBC_VER;
  GLIBC_VER = "";
  try { const m = /release version (\d+\.\d+)/.exec(fs.readFileSync(path.join(PATHS.glibcLib, "libc.so.6")).toString("latin1")); if (m) GLIBC_VER = m[1]; } catch {}
  return GLIBC_VER;
}
const runP = (cmd, args, opts = {}) => new Promise((resolve) => execFile(cmd, args, { env: termEnv(), timeout: 600000, maxBuffer: 16 << 20, ...opts },
  (err, out, errOut) => resolve({ code: err ? (err.code || 1) : 0, out: String(out || ""), err: String(errOut || err?.message || "") })));
/** 包里的目录可能是只读的（0555，tar / unzip 都照原样还原）：之后遍历、删除都会 EACCES。解开后把真目录都放开成本人可读写（不跟软链） */
function openDirs(p) {
  let st; try { st = fs.lstatSync(p); } catch { return; }
  if (!st.isDirectory()) return;
  if ((st.mode & 0o700) !== 0o700) try { fs.chmodSync(p, (st.mode & 0o7777) | 0o700); } catch {}
  let ds = []; try { ds = fs.readdirSync(p); } catch {}
  for (const d of ds) openDirs(path.join(p, d));
}
/** 删目录：删不动（只读目录）就先放开权限再删；还删不掉只记日志，不抛（11-04 报告 六-9） */
function rmTree(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); return; } catch {}
  try { openDirs(p); fs.rmSync(p, { recursive: true, force: true }); } catch (e) { log(`[custom] 删不掉 ${p}：${e.code || e.message}`); }
}
/**
 * 解压，同时盯着实际写了多少：包里登记的大小能造假（zip 中央目录写 1 KB，数据流解出几 GB），
 * 所以按所在分区可用空间的减少量算，超过上限、条目数太多、或者分区快满了就杀掉（11-04 报告 六-9）
 */
const UNPACK_MAX_FILES = 200000, UNPACK_RESERVE = 512 * 1024 * 1024;
function runCapped(cmd, args, dir, max) {
  return new Promise((resolve) => {
    let f0; try { f0 = fs.statfsSync(dir); } catch {}
    let over = 0;
    const ch = execFile(cmd, args, { env: termEnv(), timeout: 600000, maxBuffer: 16 << 20 }, (err, out, errOut) => {
      clearInterval(t);
      resolve(over ? { code: "TOOBIG", used: over, out: "", err: "" } : { code: err ? (err.code || 1) : 0, out: String(out || ""), err: String(errOut || err?.message || "") });
    });
    const t = setInterval(() => {
      if (over || !f0) return;
      let f; try { f = fs.statfsSync(dir); } catch { return; }
      const used = (f0.bavail - f.bavail) * f.bsize, files = f0.ffree - f.ffree;
      if (used > max || files > UNPACK_MAX_FILES || f.bavail * f.bsize < UNPACK_RESERVE) { over = Math.max(used, 1); try { ch.kill("SIGKILL"); } catch {} }
    }, 200);
  });
}
function walkFiles(root, rel = "", out = [], cap = 50000) {
  for (const d of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    if (out.length >= cap) break;
    const r = rel ? rel + "/" + d.name : d.name;
    if (d.isDirectory()) walkFiles(root, r, out, cap); else out.push({ rel: r, link: d.isSymbolicLink(), file: d.isFile() });
  }
  return out;
}
const customSlug = (s) => String(s || "").toLowerCase().replace(/\.(tar\.(gz|xz|bz2|zst)|tgz|txz|tbz2?|tar|zip)$/i, "")
  .replace(/[-_.]?(v?\d+(\.\d+)+.*|linux.*|aarch64.*|arm64.*)$/i, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "program";
const CMD_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
// 正在安装中的命令名 → 组件 id：补库、patchelf 这些 await 期间先占住名字，别让另一个组件装同一个命令（#122-4）
const CMD_RESERVED = new Map();
/** 命令名能不能用：工具包里已有（PATH 里排在前面，会被盖住）、别的自定义组件正占着 / 已经占了，都不行 */
function customCmdClash(cmd, selfId) {
  if (fs.existsSync(path.join(PREFIX, "bin", cmd))) return "toolkit";
  // PATH 里排在自定义组件后面的：cccodroid 自带的（priv…）和安卓系统的（am、settings…）。同名会把它们盖住，
  // 应用自己按名字调的 priv 也会被劫持（11-03 审查 L-9）
  const bin = process.env.CCAPP_BIN;
  for (const d of [bin && path.join(bin, "..", "pre"), bin, "/system/bin", "/system/xbin"]) if (d && fs.existsSync(path.join(d, cmd))) return "system";
  const rsv = CMD_RESERVED.get(cmd);
  if (rsv && rsv !== selfId) return "busy";
  const w = path.join(CUSTOM_BIN, cmd);
  // 用 headOf：lstat + O_NOFOLLOW|O_NONBLOCK，FIFO/设备文件不会把网关事件循环卡死（审查 11-05）
  if (fs.existsSync(w)) { const m = /cccodroid-custom-id: ([a-z0-9-]+)/.exec(headOf(w, 400)); if (!m || m[1] !== selfId) return "custom"; }
  return "";
}

/** 测试用：直接看命令名预留和冲突判断（#122-4） */
export const _customForTest = { CMD_RESERVED, customCmdClash, customSkill, rmTree, runCapped, headOf };

const GZ_MAX = 256 << 20, DEB_MAX = 512 << 20;
// Termux glibc 仓库的 Contents（文件 → 包）与 Packages（包 → 下载地址、sha256），缓存一天。
// 先用 Termux 自动构建钥验 Release 的签名，再按 Release 里的 SHA256 核 Contents 和 Packages：
// 以前只信 TLS，镜像或中间人给一份自洽的 Packages 就能塞进任意 .so（11-03 审查 M-5，同 devkit.mjs 的 loadRepo）
async function glibcRepoIndex(fresh = false) {
  const cache = path.join(CUSTOM_DIR, ".cache"); fs.mkdirSync(cache, { recursive: true });
  const get = async (name, url) => {
    const f = path.join(cache, name), part = f + "." + crypto.randomBytes(3).toString("hex") + ".part";
    try { if (!fresh && Date.now() - fs.statSync(f).mtimeMs < 86400000) return fs.readFileSync(f); } catch {}
    const r = await runP(path.join(PREFIX, "bin", "curl"), ["-fsSL", "--max-time", "120", "--retry", "2", "-o", part, url]);
    if (r.code) { fs.rmSync(part, { force: true }); if (fs.existsSync(f)) return fs.readFileSync(f); throw new Error(tz("取不到 glibc 仓库索引：{msg}", { msg: r.err.trim().split("\n").pop() })); }
    fs.renameSync(part, f); return fs.readFileSync(f);
  };
  const { TERMUX_KEYS, verifyDetached } = await loadPgp();
  const rel = await get("Release-glibc", GLIBC_REPO + "dists/glibc/Release");
  verifyDetached(rel, (await get("Release-glibc.gpg", GLIBC_REPO + "dists/glibc/Release.gpg")).toString(), TERMUX_KEYS);
  const sums = new Map();
  for (const l of (rel.toString().split("SHA256:")[1] || "").split("\n")) { const m = /^ ([0-9a-f]{64})\s+\d+\s+(\S+)$/.exec(l); if (m) sums.set(m[2], m[1]); else if (l && !l.startsWith(" ")) break; }
  const checked = async (name, rp) => {
    const b = await get(name, GLIBC_REPO + "dists/glibc/" + rp);
    if (sums.get(rp) === crypto.createHash("sha256").update(b).digest("hex")) return b;
    if (!fresh) throw Object.assign(new Error("stale"), { stale: true });   // 缓存和新的 Release 对不上：整套重取一次
    throw new Error(tz("glibc 仓库的 {f} 和签过名的 Release 对不上", { f: rp }));
  };
  let contentsGz, pkgsBuf;
  try { contentsGz = await checked("Contents-glibc.gz", "Contents-aarch64.gz"); pkgsBuf = await checked("Packages-glibc", "stable/binary-aarch64/Packages"); }
  catch (e) { if (e.stale) return glibcRepoIndex(true); throw e; }
  const contents = zlib.gunzipSync(contentsGz, { maxOutputLength: GZ_MAX }).toString();
  const lib = new Map();
  for (const l of contents.split("\n")) {
    if (!l.startsWith(GLIBC_REPO_LIB)) continue;
    const sp = l.lastIndexOf(" "), p = l.slice(GLIBC_REPO_LIB.length, sp).trim();
    if (!p.includes("/")) lib.set(p, l.slice(sp + 1).split(",")[0].replace(/^.*\//, ""));
  }
  const pk = new Map();
  for (const blk of pkgsBuf.toString().split("\n\n")) {
    const f = Object.fromEntries(blk.split("\n").map((x) => [x.slice(0, x.indexOf(":")), x.slice(x.indexOf(":") + 1).trim()]));
    if (f.Package) pk.set(f.Package, { version: f.Version, file: f.Filename, sha256: f.SHA256, size: +f.Size || 0 });
  }
  return { lib, pk };
}

/** 一个目录里所有 ELF 的「能提供的库名」（文件名 + SONAME） */
function libNamesIn(dir) { try { return fs.readdirSync(dir); } catch { return []; } }

// 解开之前先按包里登记的大小算总量：几十 KB 的压缩包能解出几十 GB，把存储写满（审查 v0.5.7 L4）
const UNPACK_MAX = 2 * 1024 * 1024 * 1024;
async function unpackedSize(sp, zip) {
  if (zip) {
    const r = await runP(path.join(PREFIX, "bin", "unzip"), ["-Zt", sp]);
    const m = /(\d+) bytes uncompressed/.exec(r.out);
    return m ? Number(m[1]) : null;
  }
  const r = await runP(path.join(PREFIX, "bin", "tar"), ["-tvf", sp], { maxBuffer: 64 << 20 });
  if (r.code) return null;
  let n = 0;
  for (const l of r.out.split("\n")) { const v = Number(l.trim().split(/\s+/)[2]); if (Number.isFinite(v)) n += v; }
  return n;
}

/** 分析：解开（压缩包）或拷进（单个文件）暂存区，逐个看 ELF，列出程序、缺的库、能补的库 */
async function customAnalyze(src) {
  if (!PREFIX) return { ok: false, message: "only available in cccodroid" };
  let sp = String(src || "").trim();
  if (!sp) return { ok: false, message: tz("没给文件") };
  if (!path.isAbsolute(sp)) sp = path.join(CFG.workspace, sp);
  let st; try { st = fs.statSync(sp); } catch { return { ok: false, message: tz("找不到文件：{p}", { p: sp }) }; }
  if (!st.isFile()) return { ok: false, message: tz("要选一个文件（程序本身或压缩包）") };
  for (const [k, v] of CUSTOM_STAGES) if (Date.now() - v.at > 3600000) { rmTree(v.dir); CUSTOM_STAGES.delete(k); }
  const stage = crypto.randomBytes(6).toString("hex");
  const dir = path.join(CUSTOM_DIR, ".stage-" + stage), x = path.join(dir, "x");
  fs.mkdirSync(x, { recursive: true });
  const base = path.basename(sp), warnings = [];
  const fail = (m) => { rmTree(dir); return { ok: false, message: m }; };
  const isTar = /\.(tar\.(gz|xz|bz2|zst)|tgz|txz|tbz2?|tar)$/i.test(base), isZip = /\.zip$/i.test(base);
  if (isTar || isZip) {
    // 先拷进私有暂存区再查、再解：查和解是两次打开，源文件在共享存储上，中间能被换成另一个包（11-03 审查 L-5）
    const own = path.join(dir, "src-" + base);
    try { fs.copyFileSync(sp, own); } catch (e) { return fail(tz("拷不进暂存区：{msg}", { msg: e.code || e.message })); }
    sp = own;
    const n = await unpackedSize(sp, isZip);
    if (n == null) return fail(tz("读不出压缩包的目录，可能已损坏"));
    if (n > UNPACK_MAX) return fail(tz("解开后有 {n} MB，超过 {max} MB 的上限", { n: Math.round(n / 1048576), max: UNPACK_MAX >> 20 }));
    // 解之前按目录查：有条目要经过包里的软链、或者路径跳出包外的，整包不解（见 archive-check.mjs）
    let entries;
    try {
      if (isZip) entries = zipEntries(sp);
      else {
        const r = await runP(path.join(PREFIX, "bin", "tar"), ["-tv", "--quoting-style=c", "-f", sp], { maxBuffer: 64 << 20 });
        if (r.code) return fail(tz("读不出压缩包的目录，可能已损坏"));
        entries = parseTarListing(r.out);
      }
    } catch { return fail(tz("读不出压缩包的目录，可能已损坏")); }
    const bad = archiveProblem(entries);
    if (bad) return fail(tz("这个压缩包里有条目会写到包外面（{p}），为安全起见不解开", { p: String(bad.name).slice(0, 200) }));
  }
  if (isTar) {
    const r = await runCapped(path.join(PREFIX, "bin", "tar"), ["-xf", sp, "-C", x, "--no-same-owner"], x, UNPACK_MAX);
    if (r.code === "TOOBIG") return fail(tz("解开后有 {n} MB，超过 {max} MB 的上限", { n: Math.round(r.used / 1048576), max: UNPACK_MAX >> 20 }));
    if (r.code) return fail(tz("解压失败：{msg}", { msg: r.err.trim().split("\n").slice(-2).join(" ") }));
  } else if (isZip) {
    const r = await runCapped(path.join(PREFIX, "bin", "unzip"), ["-q", "-o", sp, "-d", x], x, UNPACK_MAX);
    if (r.code === "TOOBIG") return fail(tz("解开后有 {n} MB，超过 {max} MB 的上限", { n: Math.round(r.used / 1048576), max: UNPACK_MAX >> 20 }));
    if (r.code > 1) return fail(tz("解压失败：{msg}", { msg: r.err.trim().split("\n").slice(-2).join(" ") }));
  } else if (/\.(deb|rpm|apk|appimage)$/i.test(base)) {
    return fail(tz("{ext} 包还不支持：请用程序本身、或 .tar.gz / .zip 压缩包", { ext: base.split(".").pop() }));
  } else {
    const head = Buffer.alloc(4); const fd = fs.openSync(sp, "r"); fs.readSync(fd, head, 0, 4, 0); fs.closeSync(fd);
    if (head.readUInt32BE(0) !== 0x7f454c46 && head.toString("latin1", 0, 2) !== "#!") return fail(tz("认不出这个文件：不是程序（ELF）、脚本，也不是支持的压缩包"));
    const name = base.replace(/[^\w.+-]/g, "_");
    fs.copyFileSync(sp, path.join(x, name)); fs.chmodSync(path.join(x, name), 0o755);
  }
  openDirs(x);
  // 解出来的软链只许指向包内：绝对路径或者跳出去的一律删掉（不然装进去以后顺着它能碰到别处）
  const all = walkFiles(x);
  for (const f of all.filter((a) => a.link)) {
    const abs = path.join(x, f.rel); let t = "";
    try { t = fs.readlinkSync(abs); } catch {}
    const to = path.resolve(path.dirname(abs), t);
    if (path.isAbsolute(t) || !(to === x || to.startsWith(x + path.sep))) { fs.rmSync(abs, { force: true }); warnings.push(tz("去掉了指向包外的软链：{p}", { p: f.rel })); }
  }
  // 只有一个顶层目录（常见的 foo-1.2-linux-arm64/）就以它为根
  let root = x;
  const top = fs.readdirSync(x);
  if (top.length === 1 && fs.statSync(path.join(x, top[0])).isDirectory()) root = path.join(x, top[0]);
  const files = walkFiles(root).filter((f) => f.file || f.link);
  if (!files.length) return fail(tz("里面是空的"));
  let bytes = 0;
  const elves = [], scripts = [];
  for (const f of files) {
    const abs = path.join(root, f.rel);
    let s; try { s = fs.statSync(abs); } catch { continue; }
    if (!s.isFile()) continue;
    bytes += s.size;
    const e = elfInfo(abs);
    if (e) { elves.push({ rel: f.rel, ...e, kind: elfKind(e, path.basename(f.rel)), exec: (s.mode & 0o111) !== 0 }); continue; }
    if (s.mode & 0o111) {
      const b = Buffer.alloc(128); const fd = fs.openSync(abs, "r"); const n = fs.readSync(fd, b, 0, 128, 0); fs.closeSync(fd);
      const line = b.toString("utf8", 0, n).split("\n")[0];
      if (line.startsWith("#!")) scripts.push({ rel: f.rel, interp: line.slice(2).trim() });
    }
  }
  // 库目录：放着 .so 的目录（相对根），程序启动时按它们找库
  const libDirs = [...new Set(elves.filter((e) => e.kind === "lib").map((e) => path.dirname(e.rel)))];
  const provided = new Set();
  for (const d of libDirs) for (const n of libNamesIn(path.join(root, d))) provided.add(n);
  for (const e of elves) if (e.soname) provided.add(e.soname);
  const glibcHave = new Set(libNamesIn(PATHS.glibcLib));
  const bionicHave = new Set([...libNamesIn(path.join(PREFIX, "lib")), ...libNamesIn("/system/lib64")]);
  const gv = glibcVersion();
  const missingGlibc = new Set();
  const isGlibcLib = (e) => e.kind === "lib" && e.needed.some((n) => /^libc\.so\.6$|^ld-linux/.test(n));
  for (const e of elves) {
    if (e.kind === "glibc" || isGlibcLib(e)) e.missing = e.needed.filter((n) => !provided.has(n) && !glibcHave.has(n));
    else if (e.kind === "bionic") e.missing = e.needed.filter((n) => !provided.has(n) && !bionicHave.has(n));
    else e.missing = [];
    if (e.kind === "glibc" || isGlibcLib(e)) for (const n of e.missing) missingGlibc.add(n);
    if (gv && e.glibc && verCmp(e.glibc, gv) > 0) warnings.push(tz("{p} 要求 GLIBC_{need}，本机是 {have}，可能跑不起来", { p: e.rel, need: e.glibc, have: gv }));
  }
  // 缺的 glibc 库：查 Termux glibc 仓库，能补的装的时候下载
  let fixable = [], unresolved = [];
  if (missingGlibc.size) {
    try {
      const ix = await glibcRepoIndex();
      for (const n of missingGlibc) { const pkg = ix.lib.get(n); if (pkg && ix.pk.has(pkg)) fixable.push({ soname: n, pkg, size: ix.pk.get(pkg).size }); else unresolved.push(n); }
    } catch (e) { warnings.push(e.message); unresolved = [...missingGlibc]; }
  }
  const progs = elves.filter((e) => ["glibc", "bionic", "static", "musl", "unsupported"].includes(e.kind) && (e.exec || e.kind !== "unsupported"))
    .map((e) => ({ rel: e.rel, kind: e.kind, arch: e.arch, bits: e.bits, interp: e.interp, needed: e.needed, missing: e.missing || [], glibc: e.glibc }))
    .concat(scripts.map((s) => ({ rel: s.rel, kind: "script", interp: s.interp, needed: [], missing: [] })));
  const okKinds = new Set(["glibc", "bionic", "static", "script"]);
  const inBin = (r) => !r.includes("/") || /(^|\/)(s?bin)\/[^/]+$/.test(r);
  for (const p of progs) {
    p.cmd = path.basename(p.rel).replace(/\.(sh|py|bin|AppImage)$/i, "").replace(/[^A-Za-z0-9._+-]/g, "-");
    p.suggest = okKinds.has(p.kind) && inBin(p.rel) && !/\.(so|py|sh)$/.test(p.rel) || (p.kind !== "script" && okKinds.has(p.kind) && progs.filter((q) => okKinds.has(q.kind)).length === 1);
    p.clash = CMD_RE.test(p.cmd) ? customCmdClash(p.cmd, "") : "bad";
    if (p.kind === "unsupported") p.why = p.arch !== "arm64" ? tz("这是 {arch} 程序，手机（arm64）跑不了", { arch: p.bits === 32 && p.arch === "arm32" ? "32 位 ARM" : p.arch }) : tz("解释器 {i} 认不出", { i: p.interp });
    if (p.kind === "musl") p.why = tz("musl 程序暂不支持：找同一个程序的静态版或 glibc 版");
  }
  progs.sort((a, b) => (b.suggest - a.suggest) || a.rel.localeCompare(b.rel));
  if (!progs.some((p) => okKinds.has(p.kind))) {
    const why = progs.find((p) => p.why)?.why;
    return fail(why || tz("没找到能运行的程序（arm64 的 ELF 或脚本）"));
  }
  const id0 = customSlug(base);
  let id = id0; for (let i = 2; fs.existsSync(path.join(CUSTOM_DIR, id)); i++) id = (id0.slice(0, 36) + "-" + i);
  const report = {
    ok: true, stage, source: base, id, name: base.replace(/\.(tar\.(gz|xz|bz2|zst)|tgz|txz|tbz2?|tar|zip)$/i, ""),
    files: files.length, bytes, programs: progs.slice(0, 60), libDirs, fixable, unresolved, warnings,
    glibc: gv, gpu: fs.existsSync(path.join(PREFIX, "bin", "lgpu-run")),
    readme: files.map((f) => f.rel).find((r) => /^readme(\.(md|txt))?$/i.test(path.basename(r)) && !r.includes("/", r.indexOf("/") + 1)) || "",
  };
  CUSTOM_STAGES.set(stage, { dir, root, report, at: Date.now() });
  return report;
}

/** 从 glibc 仓库补库：按 soname 找包、下载、核对 sha256、只取用得上的 .so（软链解成实体），
 *  补进来的库自己还缺什么接着补，最多 6 轮 */
async function customFetchLibs(want, deps, have, log2) {
  const ix = await glibcRepoIndex();
  const cache = path.join(CUSTOM_DIR, ".cache"), got = [];
  // 仓库里找不到、或包里没有这个文件的：一路记着，最后报「还缺」。以前每轮把 want 清空，补进来的库自己缺的二级依赖找不到就悄悄丢了（#104 05-011）
  const miss = new Set();
  fs.mkdirSync(deps, { recursive: true });
  for (let round = 0; want.size && round < 6; round++) {
    const byPkg = new Map();
    for (const n of want) { if (have.has(n)) continue; const p = ix.lib.get(n); if (p && ix.pk.has(p)) (byPkg.get(p) || byPkg.set(p, []).get(p)).push(n); else miss.add(n); }
    want = new Set();
    for (const [pkg, names] of byPkg) {
      const m = ix.pk.get(pkg), deb = path.join(cache, path.basename(m.file));
      if (!(m.size > 0 && m.size <= DEB_MAX) || !/^[0-9a-f]{64}$/.test(m.sha256 || "")) throw new Error(tz("{pkg} 的索引条目不对", { pkg }));
      let ok = false; try { ok = (await sha256File(deb)) === m.sha256; } catch {}
      if (!ok) {
        const part = deb + "." + crypto.randomBytes(3).toString("hex") + ".part";
        log2(tz("下载 {pkg}（{mb} MB）", { pkg, mb: Math.max(1, Math.round(m.size / 1048576)) }));
        const r = await runP(path.join(PREFIX, "bin", "curl"), ["-fsSL", "--max-time", "900", "--retry", "2", "-o", part, GLIBC_REPO + m.file]);
        if (r.code) { fs.rmSync(part, { force: true }); throw new Error(tz("下载 {pkg} 失败：{msg}", { pkg, msg: r.err.trim().split("\n").pop() })); }
        if ((await sha256File(part)) !== m.sha256) { fs.rmSync(part, { force: true }); throw new Error(tz("{pkg} 校验不对", { pkg })); }
        fs.renameSync(part, deb);
      }
      // .deb 是 ar 包：找 data.tar.*，用工具包的 tar 解到临时目录
      const buf = fs.readFileSync(deb); let off = 8, member = null;
      while (off + 60 <= buf.length) {
        const nm = buf.toString("latin1", off, off + 16).trim().replace(/\/$/, ""), size = parseInt(buf.toString("latin1", off + 48, off + 58), 10);
        if (nm.startsWith("data.tar")) { member = { nm, data: buf.subarray(off + 60, off + 60 + size) }; break; }
        off += 60 + size + (size & 1);
      }
      if (!member) throw new Error(tz("{pkg} 的包结构不对", { pkg }));
      const tmp = path.join(cache, "x-" + pkg + "-" + crypto.randomBytes(3).toString("hex")); fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
      const tf = path.join(tmp, member.nm); fs.writeFileSync(tf, member.data);
      // 解之前看目录：条目跳出包外、或经过包里的软链的，整包不解（同导入程序时的检查）
      const ls = await runP(path.join(PREFIX, "bin", "tar"), ["-tv", "--quoting-style=c", "-f", tf], { maxBuffer: 64 << 20 });
      let bad = ls.code ? { name: "?" } : null;
      try { if (!bad) bad = archiveProblem(parseTarListing(ls.out)); } catch { bad = { name: "?" }; }
      if (bad) { fs.rmSync(tmp, { recursive: true, force: true }); throw new Error(tz("{pkg} 里有条目会写到包外面，不解开", { pkg })); }
      const r = await runP(path.join(PREFIX, "bin", "tar"), ["-xf", tf, "-C", tmp, "--no-same-owner", "./" + GLIBC_REPO_LIB]);
      if (r.code) { fs.rmSync(tmp, { recursive: true, force: true }); throw new Error(tz("解开 {pkg} 失败：{msg}", { pkg, msg: r.err.trim().split("\n").pop() })); }
      const libd = path.join(tmp, GLIBC_REPO_LIB);
      for (const n of names) {
        if (have.has(n)) continue;
        let real; try { real = fs.realpathSync(path.join(libd, n)); } catch { miss.add(n); continue; }
        if (!real.startsWith(tmp + path.sep)) { miss.add(n); continue; }
        fs.copyFileSync(real, path.join(deps, n)); fs.chmodSync(path.join(deps, n), 0o755);
        have.add(n); got.push({ soname: n, pkg, version: m.version });
        const e = elfInfo(path.join(deps, n));
        for (const d of (e && e.needed) || []) if (!have.has(d)) want.add(d);
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  // 下载的 .deb 只是中转（gcc-libs 就 20 多 MB），用完删掉；索引留着
  for (const f of fs.readdirSync(cache)) if (f.endsWith(".deb")) fs.rmSync(path.join(cache, f), { force: true });
  return { got, still: [...new Set([...miss, ...want])].filter((n) => !have.has(n)) };   // 6 轮还没补完的也算缺
}

// patchelf 写进程序的解释器：一律用工具包里的 ld.so —— 路径固定。PATHS.loader 在「经加载器」时是 APK 里那份，
// 它所在的 /data/app/~~随机名/ 每次更新都变，写进去下次更新就失效。36 版下 exec 这样的程序由 exec-shim 改走 APK 里的 ld.so
const STABLE_LD = () => path.join(PATHS.glibcLib, "ld-linux-aarch64.so.1");
const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
/** 一个入口的包装脚本：按程序类型套上能让它在这里跑起来的那层 */
function customWrapper(id, p, appDir, libs, opts) {
  const prog = path.join(appDir, p.rel), sh = path.join(PREFIX, "bin", "sh");
  const er = SETTINGS.staticCompat !== false ? enosysRun() : "";
  // 注释行里的名字来自用户导入的归档：换行抹掉，免得多出一行被当命令执行（审查 10-29 L3）
  const one = (s) => String(s).replace(/[\r\n]/g, " ");
  const head = `#!${sh}\n# cccodroid-custom-id: ${one(id)}\n# 自定义组件「${one(id)}」的入口：${one(p.rel)}（${p.kind}）。由扩展页生成，卸载组件时一起删掉。\n`;
  const erLine = `ER=${shq(er)}; [ -n "$ER" ] && [ -x "$ER" ] || ER=\n`;
  if (p.kind === "glibc") {
    if (opts.gpu) { const own = libs.filter((l) => l !== PATHS.glibcLib); return head + `exec ${shq(path.join(PREFIX, "bin", "lgpu-run"))}${own.length ? " -L " + shq(own.join(":")) : ""} -- ${shq(prog)} "$@"\n`; }
    const pre = GLIBC_PRELOAD ? ` --preload ${shq(GLIBC_PRELOAD)}` : "";
    if (opts.patchelf) return head + `unset LD_PRELOAD LD_LIBRARY_PATH\n` + erLine + `exec $ER \${ER:+-f} ${shq(prog)} "$@"\n`;
    // 摘掉 termux-exec 的 bionic 垫片（glibc 的 ld.so 带不了它）；库路径里只放 glibc 的目录
    return head + `unset LD_PRELOAD LD_LIBRARY_PATH\n` + erLine +
      `exec $ER \${ER:+-f} ${shq(PATHS.loader)} --library-path ${shq(libs.join(":"))}${pre} --argv0 "$0" ${shq(prog)} "$@"\n`;
  }
  if (p.kind === "bionic") {
    const own = libs.filter((l) => l !== PATHS.glibcLib && !l.endsWith("/deps"));
    return head + (own.length ? `export LD_LIBRARY_PATH=${shq(own.join(":"))}\${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}\n` : "") + `exec ${shq(prog)} "$@"\n`;
  }
  if (p.kind === "static") return head + erLine + `exec $ER \${ER:+-f} ${shq(prog)} "$@"\n`;
  return head + `exec ${shq(prog)} "$@"\n`;          // 脚本：保留 termux-exec，#!/usr/bin/env 之类才认得
}

// description 一律写成带引号的 YAML 字符串：说明里有「用途: 转换」这种冒号，裸写就是不合法的 YAML（#135）
function customSkill(rec) {
  const one = (v, n = 500) => String(v == null ? "" : v).replace(/[\r\n\u0000-\u001f\u007f]+/g, " ").trim().slice(0, n);
  const name = one(rec.name, 80), desc = one(rec.desc, 500), source = one(rec.source, 300);
  const kindZh = { glibc: "glibc 程序（Linux 发行版那种），经本应用的 glibc 加载器启动", bionic: "安卓原生程序（bionic）", static: "静态链接程序", script: "脚本" };
  const lines = rec.entries.map((e) => `- \`${e.cmd}\` → \`${path.join(rec.dir, "app", e.rel)}\`：${kindZh[e.kind] || e.kind}${e.gpu ? "，经 gpu-driver-glibc 的 lgpu-run 用 GPU（Vulkan / Turnip）" : ""}${e.patchelf ? "，已用 patchelf 改了解释器和 RUNPATH" : ""}`);
  return `---
name: custom-${rec.id}
description: ${JSON.stringify(`用户自己导入的程序「${name}」${desc ? "：" + desc : ""}（cccodroid 自定义组件）。命令：${rec.entries.map((e) => e.cmd).join("、")}。用户提到它或要用这些命令时使用。`)}
---

# ${name}（自定义组件）

用户在扩展页「自定义组件」里自己导入的 Linux arm64 程序（来源：\`${source}\`）。**没经过 cccodroid 验证**，能不能用以实际运行为准。
${desc ? "\n用户的说明：" + desc + "\n" : ""}
## 运行链路

${lines.join("\n")}

- 入口是 \`~/.cccodroid/bin/<命令>\` 的包装脚本（在 PATH 里），程序文件在 \`${rec.dir}/app/\`${rec.readme ? "，自带说明 `" + path.join(rec.dir, "app", rec.readme) + "`" : ""}。
- glibc 程序的库按这个顺序找：${rec.libs.map((l) => "`" + l + "`").join(" → ")}。${rec.deps.length ? "\n- 从 Termux glibc 仓库补进来的库（在 deps/）：" + rec.deps.map((d) => `${d.soname}（${d.pkg} ${d.version}）`).join("、") + "。" : ""}
- 包装脚本会摘掉 termux-exec 的 LD_PRELOAD，并套上 seccomp 垫片（安卓会拦一些系统调用，垫片把它们改成返回 ENOSYS）。

## 出错时

- \`error while loading shared libraries: libXXX.so\`：缺库。告诉用户缺哪个；Termux glibc 仓库有的，可以在扩展页删掉这个组件后重新导入（导入时会自动补）。
- \`Bad system call\` 或直接被杀：撞了安卓的 seccomp。确认设置里「静态程序兼容」开着。
- 程序找不到自己的数据文件：有的程序按 /proc/self/exe 找自己的位置，经加载器启动时那会指向加载器。可以在扩展页对这个组件改用 patchelf 方式重装。
- 程序要图形界面（X11 / Wayland）：这里没有桌面，跑不了界面，只能用它的命令行功能。
- 不要改 \`${rec.dir}\` 里的文件，也不要往 \`~/.cccodroid/bin\` 里手写脚本；要改就让用户在扩展页重新导入。
`;
}

async function customInstall(b) {
  if (!PREFIX) return { ok: false, message: "only available in cccodroid" };
  const s = CUSTOM_STAGES.get(String(b.stage || ""));
  if (!s) return { ok: false, message: tz("分析结果过期了，重新导入一次") };
  const id = String(b.id || "");
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) return { ok: false, message: tz("名字只能用小写字母、数字和 -") };
  const dir = path.join(CUSTOM_DIR, id);
  if (fs.existsSync(dir)) return { ok: false, message: tz("已经有一个叫 {id} 的自定义组件了，换个名字或先卸载它", { id }) };
  const progs = new Map(s.report.programs.map((p) => [p.rel, p]));
  const entries = [], seen = new Set();
  for (const e of Array.isArray(b.entries) ? b.entries : []) {
    const p = progs.get(String(e.rel || "")), cmd = String(e.cmd || "");
    if (!p || !["glibc", "bionic", "static", "script"].includes(p.kind)) continue;
    if (!CMD_RE.test(cmd)) return { ok: false, message: tz("命令名不合法：{c}", { c: cmd }) };
    if (seen.has(cmd)) return { ok: false, message: tz("命令名重复：{c}", { c: cmd }) };
    const clash = customCmdClash(cmd, id);
    if (clash) return { ok: false, message: clash === "toolkit" ? tz("命令 {c} 工具包里已经有了，换个名字", { c: cmd }) : clash === "system" ? tz("命令 {c} 是系统或 cccodroid 自带的，换个名字", { c: cmd }) : clash === "busy" ? tz("命令 {c} 正在被另一个组件安装，稍后再试或换个名字", { c: cmd }) : tz("命令 {c} 被别的自定义组件占了", { c: cmd }) };
    seen.add(cmd);
    entries.push({ rel: p.rel, cmd, kind: p.kind, gpu: !!e.gpu && p.kind === "glibc" && s.report.gpu, patchelf: !!e.patchelf && p.kind === "glibc" && !e.gpu });
  }
  if (!entries.length) return { ok: false, message: tz("至少选一个要用的命令") };
  // 同名技能是用户自己的（不是我们生成的）、或者是个软链：不覆盖（11-03 审查 L-10）
  const sk0 = path.join(SKILLS_DIR, "custom-" + id);
  if (fs.existsSync(sk0) && !customSkillOurs(sk0, id)) return { ok: false, message: tz("已经有一个叫 custom-{id} 的技能了，换个名字", { id }) };
  // 先占住命令名：下面补库、patchelf 都要等，另一个组件的安装会在这期间看到这个名字已被占用（#122-4）
  for (const e of entries) CMD_RESERVED.set(e.cmd, id);
  const msgs = [], log2 = (m) => { msgs.push(m); log(`[custom] ${id}：${m}`); };
  const appDir = path.join(dir, "app"), deps = path.join(dir, "deps");
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.renameSync(s.root, appDir);
    rmTree(s.dir);
    CUSTOM_STAGES.delete(b.stage);
    // 补库
    let got = [], still = [];
    const need = new Set(s.report.fixable.map((f) => f.soname));
    if (need.size && b.fetchLibs !== false) {
      const have = new Set([...libNamesIn(PATHS.glibcLib)]);
      for (const d of s.report.libDirs) for (const n of libNamesIn(path.join(appDir, d))) have.add(n);
      ({ got, still } = await customFetchLibs(need, deps, have, log2));
    }
    const libs = [...s.report.libDirs.map((d) => path.join(appDir, d)), ...(got.length ? [deps] : []), PATHS.glibcLib];
    // patchelf 方式：直接改程序的解释器和 RUNPATH（/proc/self/exe 才指向程序本身）
    for (const e of entries.filter((x) => x.patchelf)) {
      const f = path.join(appDir, e.rel);
      const r = await runP(path.join(PREFIX, "bin", "patchelf"), ["--set-interpreter", STABLE_LD(), "--set-rpath", libs.join(":"), f]);
      if (r.code) throw new Error(tz("patchelf 改 {p} 失败：{msg}", { p: e.rel, msg: r.err.trim().split("\n").pop() }));
    }
    // 等完补库 / patchelf 再核一次：名字要是被别处抢了（极端情况下预留之外还有手写入口），宁可回滚也不覆盖
    for (const e of entries) {
      if (customCmdClash(e.cmd, id)) throw new Error(tz("命令 {c} 在安装期间被占了，已取消这次安装", { c: e.cmd }));
    }
    fs.mkdirSync(CUSTOM_BIN, { recursive: true });
    for (const e of entries) {
      try { fs.chmodSync(path.join(appDir, e.rel), 0o755); } catch {}
      fs.writeFileSync(path.join(CUSTOM_BIN, e.cmd), customWrapper(id, e, appDir, libs, e), { mode: 0o755 });
    }
    const rec = {
      id, name: String(b.name || id).slice(0, 80), desc: String(b.desc || "").slice(0, 400), source: s.report.source,
      dir, at: Date.now(), entries, libs, deps: got, unresolved: [...s.report.unresolved, ...still], readme: s.report.readme,
      bytes: s.report.bytes,
    };
    fs.writeFileSync(path.join(dir, CUSTOM_REC), JSON.stringify(rec, null, 1));
    const sk = path.join(SKILLS_DIR, "custom-" + id), ucb = ucAppBegin();
    fs.mkdirSync(sk, { recursive: true });
    fs.writeFileSync(path.join(sk, "SKILL.md"), customSkill(rec));
    ucAppWrote([sk], ucb);
    log(`[custom] ${id} 已装：${entries.map((e) => e.cmd + "(" + e.kind + ")").join(" ")}，补库 ${got.length} 个`);
    return { ok: true, id, log: msgs, unresolved: rec.unresolved };
  } catch (e) {
    customRemove(id, true);
    return { ok: false, message: e.message, log: msgs };
  } finally {
    // 成功时入口文件已经写好（customCmdClash 认文件），失败时 customRemove 也清干净了：预留都可以放掉
    for (const e of entries) if (CMD_RESERVED.get(e.cmd) === id) CMD_RESERVED.delete(e.cmd);
  }
}

/** 网关启动时按记录重写入口：「静态程序兼容」开关、工具包路径变了，入口跟着变；装了 GPU 组件以后被卸掉的，退回普通方式 */
export function customRefresh() {
  if (!PREFIX) return;
  const gpu = fs.existsSync(path.join(PREFIX, "bin", "lgpu-run"));
  for (const r of customRecords()) {
    try {
      fs.mkdirSync(CUSTOM_BIN, { recursive: true });
      for (const e of r.entries) fs.writeFileSync(path.join(CUSTOM_BIN, e.cmd), customWrapper(r.id, e, path.join(r.dir, "app"), r.libs, { gpu: e.gpu && gpu, patchelf: e.patchelf }), { mode: 0o755 });
    } catch (e) { log(`[custom] ${r.id} 入口重写失败：${e.message}`); }
    // 早先「经加载器」时装的会把 APK 里 ld.so 的路径写进程序：改回工具包里那份（APK 一更新那个路径就没了）
    for (const e of r.entries.filter((x) => x.patchelf)) {
      const f = path.join(r.dir, "app", e.rel), want = STABLE_LD(), info = elfInfo(f);
      if (!info || !info.interp || info.interp === want) continue;
      runP(path.join(PREFIX, "bin", "patchelf"), ["--set-interpreter", want, f])
        .then((x) => log(`[custom] ${r.id}/${e.rel} 解释器 ${info.interp} → ${want}${x.code ? " 失败：" + x.err.trim().split("\n").pop() : ""}`));
    }
  }
}
function customRecords() {
  const out = [];
  try { for (const d of fs.readdirSync(CUSTOM_DIR)) { if (d.startsWith(".")) continue; try { out.push(JSON.parse(fs.readFileSync(path.join(CUSTOM_DIR, d, CUSTOM_REC), "utf8"))); } catch {} } } catch {}
  return out.sort((a, b) => b.at - a.at);
}
function customList() {
  if (!PREFIX) return { supported: false };
  return { supported: true, gpu: fs.existsSync(path.join(PREFIX, "bin", "lgpu-run")), items: customRecords().map((r) => ({
    id: r.id, name: r.name, desc: r.desc, source: r.source, at: r.at, bytes: r.bytes, unresolved: r.unresolved || [],
    deps: (r.deps || []).length, entries: r.entries.map((e) => ({ cmd: e.cmd, kind: e.kind, gpu: e.gpu, patchelf: e.patchelf, ok: fs.existsSync(path.join(CUSTOM_BIN, e.cmd)) })),
  })) };
}
/** 这个技能目录是不是我们给自定义组件生成的：真目录（不是软链），SKILL.md 是普通文件、开头是我们的模板 */
function customSkillOurs(sk, id) {
  try {
    if (!fs.lstatSync(sk).isDirectory()) return false;
    const f = path.join(sk, "SKILL.md"), st = fs.lstatSync(f);
    if (!st.isFile() || st.size > (1 << 20)) return false;
    const t = fs.readFileSync(f, "utf8");
    return t.startsWith(`---\nname: custom-${id}\n`) && t.includes("（cccodroid 自定义组件）");
  } catch { return false; }
}
/** 普通文件（不跟软链）的开头 n 字节；别的类型返回空串 */
function headOf(f, n) {
  try {
    if (!fs.lstatSync(f).isFile()) return "";
    const fd = fs.openSync(f, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try { const b = Buffer.alloc(n); return b.toString("utf8", 0, fs.readSync(fd, b, 0, n, 0)); } finally { fs.closeSync(fd); }
  } catch { return ""; }
}
function customRemove(id, quiet) {
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) return { ok: false, message: "bad id" };
  const dir = path.join(CUSTOM_DIR, id);
  if (!fs.existsSync(dir)) return { ok: false, message: "not installed" };
  // 只看普通文件的开头：命令目录里要是混进一个 FIFO，整读会把网关卡死（11-04 报告 六-9）
  try { for (const f of fs.readdirSync(CUSTOM_BIN)) { const w = path.join(CUSTOM_BIN, f); if (headOf(w, 400).includes("cccodroid-custom-id: " + id + "\n")) fs.rmSync(w, { force: true }); } } catch {}
  rmTree(dir);
  const sk = path.join(SKILLS_DIR, "custom-" + id);
  if (customSkillOurs(sk, id)) { const ucb = ucAppBegin(); fs.rmSync(sk, { recursive: true, force: true }); ucAppWrote([sk], ucb); }
  if (!quiet) log(`[custom] ${id} 已卸载`);
  return { ok: true };
}
/** 试运行：--version，不认就 --help，8 秒为限，只取开头几行 */
async function customTry(id, cmd) {
  const rec = customRecords().find((r) => r.id === id);
  const e = rec && rec.entries.find((x) => x.cmd === cmd);
  if (!e) return { ok: false, message: "not found" };
  const w = path.join(CUSTOM_BIN, cmd);
  let last;
  for (const arg of ["--version", "--help"]) {
    last = await runP(w, [arg], { timeout: 8000, cwd: CFG.workspace });
    if (last.code === 0) break;
  }
  const text = (last.out + (last.out && last.err ? "\n" : "") + last.err).split("\n").slice(0, 14).join("\n").slice(0, 1500);
  // 不认 --version / --help 的程序会以非 0 退出，但打出了用法也算「跑起来了」；装载失败才算没跑起来
  const broken = /error while loading shared libraries|Exec format error|Bad system call|cannot execute|version `GLIBC_|symbol lookup error/.test(text) || last.code === 126 || last.code === 127 || last.code === "ETIMEDOUT" && !text;
  return { ok: !broken && (last.code === 0 || !!text.trim()), code: last.code, output: text };
}

async function handleCustom(req, res, p, u) {
  if (req.method === "GET" && p === "/api/custom") return sendJson(res, 200, customList());
  if (req.method !== "POST") return sendJson(res, 405, { error: "method" });
  if (p === "/api/custom/upload") {
    // 程序可能很大（几百 MB）：流式落盘到暂存目录，不走 /api/upload 的 64 MB 内存缓冲
    if (!PREFIX) return sendJson(res, 200, { ok: false, message: "only available in cccodroid" });
    const name = path.basename(u.searchParams.get("name") || "program").replace(/[^\w.+-]/g, "_").slice(0, 120) || "program";
    const up = path.join(CUSTOM_DIR, ".uploads"); fs.mkdirSync(up, { recursive: true });
    try { for (const f of fs.readdirSync(up)) if (Date.now() - fs.statSync(path.join(up, f)).mtimeMs > 3600000) fs.rmSync(path.join(up, f), { force: true }); } catch {}
    const out = path.join(up, crypto.randomBytes(4).toString("hex") + "-" + name);
    // 边收边数：超过上限就断开、删掉半截，别把私有空间写满（审查 中7；其他上传口都有上限，只这里漏了）
    const MAX = 2 * 1024 ** 3;
    if (+req.headers["content-length"] > MAX) return sendJson(res, 413, { ok: false, message: "file too large (max 2 GB)" });
    try {
      await new Promise((resolve, reject) => {
        const w = fs.createWriteStream(out); let n = 0;
        req.on("data", (c) => { n += c.length; if (n > MAX) { req.unpipe(w); w.destroy(); req.destroy(); reject(Object.assign(new Error("file too large (max 2 GB)"), { big: true })); } });
        req.pipe(w); w.on("finish", resolve); w.on("error", reject); req.on("error", reject);
      });
    } catch (e) { fs.rmSync(out, { force: true }); return sendJson(res, e.big ? 413 : 500, { ok: false, message: e.message }); }
    const r = await customAnalyze(out);
    fs.rmSync(out, { force: true });
    if (r.ok) r.source = r.source.replace(/^[0-9a-f]{8}-/, "");
    return sendJson(res, 200, r);
  }
  let body = {}; try { body = JSON.parse((await readBody(req)) || "{}"); } catch {}
  if (p === "/api/custom/analyze") return sendJson(res, 200, await customAnalyze(body.path));
  if (p === "/api/custom/install") return sendJson(res, 200, await customInstall(body));
  if (p === "/api/custom/discard") { const s = CUSTOM_STAGES.get(String(body.stage || "")); if (s) { rmTree(s.dir); CUSTOM_STAGES.delete(body.stage); } return sendJson(res, 200, { ok: true }); }
  if (p === "/api/custom/remove") return sendJson(res, 200, customRemove(String(body.id || "")));
  if (p === "/api/custom/try") return sendJson(res, 200, await customTry(String(body.id || ""), String(body.cmd || "")));
  return sendJson(res, 404, { error: "not found" });
}

// ── 路由：/api/custom ──
export async function routeCustom(req, res, u, p) {
  if (p === "/api/custom" || p.startsWith("/api/custom/")) return handleCustom(req, res, p, u);
  return NEXT;
}
