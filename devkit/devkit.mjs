// ─────────────────────────────────────────────────────────────────────
//  devkit.mjs —— 从 Termux 官方仓库组装开发工具包（可复现、可溯源）
//
//  做的事：
//    1. 取 Release → 校验 Packages.gz 的 SHA256 → 解析索引
//    2. 按 devkit.json 的分组求依赖闭包（含 Provides 虚包、"a | b" 取第一个能满足的）
//    3. 下载 .deb，逐个核对索引里的 SHA256（缓存命中也核对）
//    4. 解 ar → data.tar.xz → 读 tar，**边读边改写**：
//         路径   ./data/data/com.termux/files/usr/x  →  usr/x
//         内容   /data/data/com.termux/  →  /data/data/<目标包名>/   （等长替换）
//         归档   zip 类（.jmod/.jar/.zip/…）还要下潜到压缩条目内部再改一遍
//                —— 等长替换在 deflate 流里找不到模式，改不到（见 rewriteZip）
//         链接   软链目标同样替换
//       写进一个新 tar —— 应用解到自己的 files/ 下即可原生运行，不需要 LD_LIBRARY_PATH。
//    5. 落 devkit.lock.json（每个包的版本/文件/哈希/配方链接）和 SBOM.tsv
//
//  为什么目标包名必须恰好 10 个字符：Termux 的前缀是编译期写死进二进制的，
//  ELF 里是定长槽。"com.termux" 是 10 个字符，换成同样长的包名就是逐字节等长替换，
//  RUNPATH、shebang、配置路径一次全对，不用打任何补丁。
//
//  用法: node devkit.mjs build --target li.dsh.dkt [--groups core,build] [--out DIR]
//        node devkit.mjs resolve [--groups ...]          只列闭包和体积
//        node devkit.mjs component <id> --target cc.codroid --base <工具包的 devkit.lock.json>
//        node devkit.mjs component --recipe <配方目录> --target cc.codroid --base <…>
//            外部配方（cccodroid-components 仓库的 recipes/<id>/recipe.json），见那边的 docs/recipe.md
//            可选组件（见 devkit.json 的 components）：只打底座里没有的包，产出 out/component-<id>-<包名>.tar.gz
// ─────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { execFileSync, execFile } from "node:child_process";
import * as xzNs from "./vendor/xz-decompress/dist/package/xz-decompress.js";
const xz = xzNs.default ?? xzNs;

const HERE = path.dirname(new URL(import.meta.url).pathname);
const MAN = JSON.parse(fs.readFileSync(path.join(HERE, "devkit.json"), "utf8"));
const args = process.argv.slice(2);
const cmd = args[0];
const opt = (k, d) => { const i = args.indexOf("--" + k); return i >= 0 ? args[i + 1] : d; };

const TERMUX = "/data/data/com.termux/";
const CACHE = opt("cache", path.join(HERE, "cache"));
const OUT = opt("out", path.join(HERE, "out"));
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const mb = (n) => (n / 1048576).toFixed(1) + "MB";

async function get(url) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(600000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      if (i >= 5) throw new Error(`${url}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));   // 网络抖动：退避重试
    }
  }
}

// 仓库外构件的下载。jsDelivr 主站对 GitHub Actions 的机器常回 503：/gh/ 地址按镜像链依次试，每个源只重试一次，
// 最后退到 raw.githubusercontent.com 的同一提交。内容随后一律按 sha256 核对，换来源不降低把关
function fetchUrl(url) {
  const curl = (u, n) => execFileSync("curl", ["-fsSL", "--retry", String(n), "--retry-all-errors", "--retry-delay", "5", "--max-time", "600", u], { maxBuffer: 2 ** 30 });
  const m = url.match(/^https:\/\/cdn\.jsdelivr\.net\/gh\/([^/]+)\/([^/@]+)@([^/]+)\/(.+)$/);
  if (!m) return curl(url, 4);
  const tail = `gh/${m[1]}/${m[2]}@${m[3]}/${m[4]}`;
  const srcs = ["cdn", "fastly", "gcore", "testingcf"].map((h) => `https://${h}.jsdelivr.net/${tail}`)
    .concat(`https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}/${m[4]}`);
  let err;
  for (const u of srcs) {
    try { const b = curl(u, 1); if (u !== url) console.log(`  jsDelivr 主站取不到，改用 ${new URL(u).host}：${m[4]}`); return b; } catch (e) { err = e; }
  }
  throw err;
}

// ── 索引 ─────────────────────────────────────────────────────────────
// 多个仓库：termux-main 优先，其次 termux-glibc（给官方 Claude Code 的 glibc 版二进制提供运行库）
const REPOS = MAN.repos || [MAN.repo];
async function loadIndex(repos = REPOS) {
  const pkgs = new Map(), provides = new Map(), dates = [];
  for (const repo of repos) {
    const one = await loadRepo(repo);
    dates.push(`${repo.name || "main"} ${one.date}`);
    for (const [k, p] of one.pkgs) if (!pkgs.has(k)) pkgs.set(k, p);
    for (const [k, v] of one.provides) if (!provides.has(k)) provides.set(k, v);
  }
  return { pkgs, provides, date: dates.join(" · ") };
}

async function loadRepo(repo) {
  const { base, dist, component, arch } = repo;
  const rel = (await get(`${base}dists/${dist}/Release`)).toString();
  const rp = `${component}/binary-${arch}/Packages.gz`;
  const want = rel.split("SHA256:")[1].split("\n").find((l) => l.trim().endsWith(" " + rp));
  if (!want) throw new Error("Release 里没有 " + rp);
  const gz = await get(`${base}dists/${dist}/${rp}`);
  if (sha256(gz) !== want.trim().split(/\s+/)[0]) throw new Error("Packages.gz 哈希与 Release 不符");
  const date = (rel.match(/^Date: (.+)$/m) || [])[1];

  const pkgs = new Map(), provides = new Map();
  for (const blk of zlib.gunzipSync(gz).toString().split("\n\n")) {
    const f = {};
    for (const l of blk.split("\n")) { const m = l.match(/^([\w-]+): (.*)$/); if (m) f[m[1]] = m[2]; }
    if (!f.Package) continue;
    const p = {
      name: f.Package, version: f.Version, file: f.Filename, sha256: f.SHA256, size: +f.Size,
      isize: +(f["Installed-Size"] || 0) * 1024, source: f.Source || f.Package, homepage: f.Homepage || "",
      deps: [f["Pre-Depends"], f.Depends].filter(Boolean).join(", "),
      repo,
    };
    pkgs.set(p.name, p);
    for (const v of (f.Provides || "").split(",")) {
      const n = v.trim().split(/[\s(]/)[0];
      if (n) { if (!provides.has(n)) provides.set(n, []); provides.get(n).push(p.name); }
    }
  }
  return { pkgs, provides, date };
}

function closure(idx, roots) {
  const out = new Set(), missing = [];
  const pick = (alt) => {
    for (const a of alt.split("|")) {
      const n = a.trim().split(/[\s(]/)[0];
      if (idx.pkgs.has(n)) return n;
      const pv = idx.provides.get(n);
      if (pv) return pv[0];
    }
    return null;
  };
  const walk = (n, from) => {
    if (out.has(n) || (MAN.exclude || []).includes(n) || ((COMP && COMP.exclude) || []).includes(n)) return;
    const p = idx.pkgs.get(n);
    if (!p) { missing.push(`${n}（${from}）`); return; }
    out.add(n);
    for (const d of p.deps.split(",")) {
      if (!d.trim()) continue;
      const k = pick(d);
      if (k) walk(k, n); else missing.push(`${d.trim()}（${n}）`);
    }
  };
  for (const r of roots) walk(pick(r) || r, "清单");
  return { names: [...out].sort(), missing };
}

function rootsFor(groups) {
  const gs = groups ? groups.split(",") : Object.keys(MAN.groups);
  return gs.flatMap((g) => { if (!MAN.groups[g]) throw new Error("没有这个分组: " + g); return MAN.groups[g]; });
}

async function fetchDeb(p) {
  fs.mkdirSync(CACHE, { recursive: true });
  const dest = path.join(CACHE, path.basename(p.file).replace(/:/g, "%3a"));   // /sdcard 不收冒号
  if (fs.existsSync(dest)) {
    const b = fs.readFileSync(dest);
    if (sha256(b) === p.sha256) return b;
  }
  // 下载走 curl：node 的 fetch 在这台机器上会间歇性 "fetch failed"。
  // 大包分块并行：单连接常被限速到 ~85KB/s，且 CDN 会静默截断或传坏一段。
  // 整包哈希不对时，换镜像重下每一块，按"两个来源一致"选块 —— 能定位坏块而不是整包重来。
  const mirrors = [p.repo.base, ...(p.repo.mirrors || [])];
  const CH = 4 << 20, n = Math.ceil(p.size / CH);
  const got = Array.from({ length: n }, () => []);          // 每块收集到的各版本
  const curlRange = (m, i) => new Promise((res) => {
    const lo = i * CH, hi = Math.min(p.size, lo + CH) - 1;
    execFile("curl", ["-fsSL", "-r", `${lo}-${hi}`, "--speed-limit", "10000", "--speed-time", "30", "--max-time", "600", mirrors[m % mirrors.length] + p.file],
      { encoding: "buffer", maxBuffer: CH * 2 }, (err, out) => res(!err && out.length === hi - lo + 1 ? out : null));
  });
  const pickAll = () => got.map((vs) => {
    if (vs.length === 1) return vs[0];
    for (let x = 0; x < vs.length; x++) for (let y = x + 1; y < vs.length; y++) if (vs[x].equals(vs[y])) return vs[x];
    return null;
  });
  for (let round = 0; round < 6; round++) {
    // 这一轮要下的块：还没有的；或（非首轮）没有两份一致的
    const need = [];
    for (let i = 0; i < n; i++) if (round === 0 ? !got[i].length : pickAll()[i] === null || got[i].length < 2) need.push(i);
    let k = 0;
    await Promise.all(Array.from({ length: Math.min(8, need.length) }, async () => {
      while (k < need.length) {
        const i = need[k++];
        for (let t = 0; t < 4; t++) { const b = await curlRange(round + t + i, i); if (b) { got[i].push(b); break; } }
      }
    }));
    const parts = pickAll();
    if (parts.every(Boolean)) {
      const b = Buffer.concat(parts);
      if (sha256(b) === p.sha256) { fs.writeFileSync(dest, b); return b; }
      if (round === 0) console.log(`\n      整包哈希不符，换镜像逐块复核…`);
    }
  }
  throw new Error(`${p.name}: 多轮下载仍拼不出与索引一致的内容`);
}

// ── 解包 ─────────────────────────────────────────────────────────────
function arMember(buf, prefix) {
  if (buf.subarray(0, 8).toString() !== "!<arch>\n") throw new Error("不是 ar 归档");
  for (let off = 8; off + 60 <= buf.length;) {
    const name = buf.subarray(off, off + 16).toString().trim().replace(/\/$/, "");
    const size = parseInt(buf.subarray(off + 48, off + 58).toString().trim(), 10);
    if (name.startsWith(prefix)) return { name, data: buf.subarray(off + 60, off + 60 + size) };
    off += 60 + size + (size % 2);
  }
  throw new Error("没有 " + prefix + "*");
}

// 原生 xz：从仓库里的 xz-utils + liblzma 自举（JS 解一次），之后大包全用它，快一个数量级。
// 放在本应用私有目录（/sdcard 是 noexec）；靠 LD_LIBRARY_PATH 找 liblzma，所以不依赖前缀改写。
let XZ = null, XZENV = process.env;
const BOOT = process.env.DEVKIT_BOOT || path.join(process.env.HOME || "/data/local/tmp", ".devkit-boot");
async function bootXz(idx) {
  // 普通 Linux（CI）上直接用系统 xz；安卓上没有，才从 Termux 仓库自举
  if (process.platform === "linux" && !fs.existsSync("/system/bin/linker64")) {
    try { execFileSync("xz", ["--version"], { stdio: "pipe" }); XZ = "xz"; return; } catch {}
  }
  const bin = path.join(BOOT, "bin/xz");
  if (!fs.existsSync(bin)) {
    fs.mkdirSync(BOOT, { recursive: true });
    for (const n of ["xz-utils", "liblzma"]) {
      const tar = await jsUnxz(arMember(await fetchDeb(idx.pkgs.get(n)), "data.tar").data);
      for (const e of readTar(tar)) {
        const rel = e.name.replace(/^\.\//, "").replace(TERMUX.slice(1) + "files/usr/", "");
        if (rel === e.name.replace(/^\.\//, "")) continue;
        const dst = path.join(BOOT, rel);
        if (e.type === "5") fs.mkdirSync(dst, { recursive: true });
        else if (e.type === "2") { fs.mkdirSync(path.dirname(dst), { recursive: true }); try { fs.unlinkSync(dst); } catch {} fs.symlinkSync(e.link, dst); }
        else if (e.type === "0") { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, e.data, { mode: e.mode }); }
      }
    }
  }
  try {
    execFileSync(bin, ["--version"], { env: { ...process.env, LD_LIBRARY_PATH: path.join(BOOT, "lib") }, stdio: "pipe" });
    XZ = bin;
    XZENV = { ...process.env, LD_LIBRARY_PATH: path.join(BOOT, "lib") };   // 只给自举的 bionic xz，别漏给系统的
  } catch (e) { console.log("  （原生 xz 起不来，退回 JS 解压：" + e.message.split("\n")[0] + "）"); }
}

async function unxz(data) {
  if (XZ) return execFileSync(XZ, ["-dc"], { input: data, maxBuffer: 2 ** 31, env: XZENV });
  return jsUnxz(data);
}

async function jsUnxz(data) {
  const rd = new xz.XzReadableStream(new Blob([data]).stream()).getReader();
  const parts = [];
  for (;;) { const { done, value } = await rd.read(); if (done) break; parts.push(Buffer.from(value)); }
  return Buffer.concat(parts);
}

async function controlScripts(deb) {
  const m = arMember(deb, "control.tar");
  const tar = m.name.endsWith(".xz") ? await unxz(m.data) : m.name.endsWith(".gz") ? zlib.gunzipSync(m.data) : m.data;
  const out = {};
  for (const e of readTar(tar)) {
    const n = e.name.replace(/^\.\//, "");
    if (["preinst", "postinst"].includes(n)) out[n] = e.data.toString();
  }
  return out;
}

/** 从 postinst 里摘出 update-alternatives 的 --install/--slave（链接、组名、目标、优先级） */
function parseAlternatives(script) {
  const flat = script.replace(/\\\n/g, " ");
  const out = [];
  for (const m of flat.matchAll(/--install\s+"([^"]+)"\s+"([^"]+)"\s+"([^"]+)"\s+(\d+)((?:\s+--slave\s+"[^"]+"\s+"[^"]+"\s+"[^"]+")*)/g)) {
    const links = [[m[1], m[3]]];
    for (const sl of m[5].matchAll(/--slave\s+"([^"]+)"\s+"([^"]+)"\s+"([^"]+)"/g)) links.push([sl[1], sl[3]]);
    out.push({ group: m[2], prio: +m[4], links });
  }
  return out;
}

async function dataTar(deb) {
  const m = arMember(deb, "data.tar");
  if (m.name.endsWith(".xz")) return unxz(m.data);
  if (m.name.endsWith(".gz")) return zlib.gunzipSync(m.data);
  if (m.name === "data.tar") return m.data;
  throw new Error("不支持的压缩: " + m.name);
}

/** 流式算哈希（工具包 1.7GB，不整个读进内存） */
function hashFile(file) {
  return new Promise((ok, bad) => {
    const h = crypto.createHash("sha256"); let bytes = 0;
    fs.createReadStream(file, { highWaterMark: 1 << 20 }).on("data", (d) => { h.update(d); bytes += d.length; })
      .on("end", () => ok({ sha256: h.digest("hex"), bytes })).on("error", bad);
  });
}
/** gzip -9 压缩并同时算压缩产物的哈希 */
function gzipFile(src, dst) {
  return new Promise((ok, bad) => {
    const h = crypto.createHash("sha256"); let bytes = 0;
    const gz = zlib.createGzip({ level: 9, memLevel: 9 });
    const out = fs.createWriteStream(dst + ".part");
    gz.on("data", (d) => { h.update(d); bytes += d.length; });
    fs.createReadStream(src, { highWaterMark: 1 << 20 }).on("error", bad).pipe(gz).on("error", bad).pipe(out).on("error", bad)
      .on("finish", () => { fs.renameSync(dst + ".part", dst); ok({ sha256: h.digest("hex"), bytes }); });
  });
}

// ── tar 读 ───────────────────────────────────────────────────────────
function* readTar(buf) {
  const str = (b) => { const i = b.indexOf(0); return b.subarray(0, i < 0 ? b.length : i).toString(); };
  const oct = (b) => parseInt(str(b).trim() || "0", 8);
  let longName = null, longLink = null, pax = {};
  for (let off = 0; off + 512 <= buf.length;) {
    const h = buf.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    const size = oct(h.subarray(124, 136));
    const type = String.fromCharCode(h[156] || 48);
    const body = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "L") { longName = str(body); continue; }
    if (type === "K") { longLink = str(body); continue; }
    if (type === "x") {
      pax = {};
      for (let s = body.toString(), i = 0; i < s.length;) {
        const sp = s.indexOf(" ", i), len = parseInt(s.slice(i, sp), 10);
        const kv = s.slice(sp + 1, i + len - 1), eq = kv.indexOf("=");
        pax[kv.slice(0, eq)] = kv.slice(eq + 1); i += len;
      }
      continue;
    }
    if (type === "g") continue;
    const prefix = str(h.subarray(345, 500));
    let name = pax.path || longName || (prefix ? prefix + "/" : "") + str(h.subarray(0, 100));
    let link = pax.linkpath || longLink || str(h.subarray(157, 257));
    yield { name, link, type, mode: oct(h.subarray(100, 108)), mtime: oct(h.subarray(136, 148)), data: body };
    longName = longLink = null; pax = {};
  }
}

// ── tar 写（ustar + pax 长名）────────────────────────────────────────
class TarWriter {
  constructor(file) { this.fd = fs.openSync(file, "w"); this.bytes = 0; }
  _w(b) { fs.writeSync(this.fd, b); this.bytes += b.length; }
  _pad(n) { const r = n % 512; if (r) this._w(Buffer.alloc(512 - r)); }
  _hdr(name, type, size, mode, mtime, link = "") {
    const h = Buffer.alloc(512);
    h.write(name.slice(0, 100), 0);
    h.write(mode.toString(8).padStart(7, "0") + "\0", 100);
    h.write("0000000\0", 108); h.write("0000000\0", 116);
    h.write(size.toString(8).padStart(11, "0") + "\0", 124);
    h.write(Math.max(0, mtime).toString(8).padStart(11, "0") + "\0", 136);
    h.write("        ", 148);
    h.write(type, 156);
    h.write(link.slice(0, 100), 157);
    h.write("ustar\0", 257); h.write("00", 263);
    let sum = 0; for (const x of h) sum += x;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    return h;
  }
  add(e) {
    const kv = [];
    if (Buffer.byteLength(e.name) > 99) kv.push(["path", e.name]);
    if (Buffer.byteLength(e.link || "") > 99) kv.push(["linkpath", e.link]);
    if (kv.length) {
      let s = "";
      for (const [k, v] of kv) {
        const body = ` ${k}=${v}\n`;
        let n = Buffer.byteLength(body) + 1;
        while (String(n).length + Buffer.byteLength(body) !== n) n = String(n).length + Buffer.byteLength(body);
        s += n + body;
      }
      const pb = Buffer.from(s);
      this._w(this._hdr("PaxHeader", "x", pb.length, 0o644, e.mtime)); this._w(pb); this._pad(pb.length);
    }
    const size = e.type === "0" ? e.data.length : 0;
    this._w(this._hdr(e.name, e.type, size, e.mode, e.mtime, e.link || ""));
    if (size) { this._w(e.data); this._pad(size); }
  }
  close() { this._w(Buffer.alloc(1024)); fs.closeSync(this.fd); }
}

// ── 前缀改写 ─────────────────────────────────────────────────────────
// 解包时丢掉的文件：Termux App 专属的脚本（给 com.termux 的组件发广播），在别的应用里只会误导
const DROP = new Set([...(MAN.drop || []), ...Object.keys(MAN.stubs || {})]);

function relocator(target) {
  const to = `/data/data/${target}/`;
  if (to.length !== TERMUX.length) throw new Error(`目标包名须恰好 ${TERMUX.length - 12} 个字符（"${target}" 是 ${target.length} 个）`);
  const A = Buffer.from(TERMUX), B = Buffer.from(to);
  const swap = (buf) => {
    let i = buf.indexOf(A);
    if (i < 0) return [buf, 0];
    const out = Buffer.from(buf); let n = 0;
    for (; i >= 0; i = out.indexOf(A, i + A.length)) { B.copy(out, i); n++; }
    return [out, n];
  };
  const pathOf = (name) => {
    const n = name.replace(/^\.\//, "");
    const pre = TERMUX.slice(1) + "files/";
    // 文件名中间也可能嵌着前缀：gdb 的 auto-load 脚本按库的绝对路径存放
    // （share/gdb/auto-load/data/data/com.termux/files/usr/lib/libarrow.so.N-gdb.py），同样等长换掉，
    // gdb 按库的真实路径去找时才对得上；不换的话 .list / MANIFEST 里残留旧前缀，组件审计判 ❌
    return n.startsWith(pre) ? n.slice(pre.length).split(TERMUX.slice(1)).join(to.slice(1)) : null;   // 前缀之外的条目（极少）丢弃
  };
  return { swap, pathOf, to };
}

// ── 压缩归档内部也要改写 ──────────────────────────────────────────────
// 上面的 swap 是等长字节替换，对 flat 文件有效：ELF 的 RUNPATH、未压缩的
// jimage（JDK 的 lib/modules）都是这么改对的。
// 但 zip 类归档（本工具包里就是 JDK 的 jmods/*.jmod）条目是 deflate 压缩的，
// 字节流里找不到那个模式，于是被整个跳过 —— 归档里仍留着 /data/data/com.termux/。
//
// 后果（实测，红魔 9 Pro / Android 14）：jlink 从 jmod 里拷出启动器和本地库，
// 把未改写的 RUNPATH 带进产出，镜像一启动就
//     CANNOT LINK EXECUTABLE: library "libz.so.1" not found
// 而 jlink 自己退出码是 0。68 个 jmod 里 31 个中招，jpackage 直接不可用。
//
// 装回时必须严格保持条目顺序与压缩方式：实测 jlink 会拒绝重排过的 jmod
// （报 "Resources tree, invalid data structure"），所以这里全程按中央目录的顺序重建。
const SIG_LOC = 0x04034b50, SIG_CEN = 0x02014b50, SIG_EOCD = 0x06054b50;
const ZIP_EXT = [".jmod", ".jar", ".zip", ".whl", ".egg", ".aar", ".apk"];
const looksLikeZip = (name) => ZIP_EXT.some((e) => name.toLowerCase().endsWith(e));

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** 有的归档（jmod）在 zip 数据前带自定义头，探测 zip 实际起点 */
function zipBase(buf) {
  if (buf.length >= 4 && buf.readUInt32LE(0) === SIG_LOC) return 0;
  for (let o = 4; o <= 8 && o + 4 <= buf.length; o += 4)
    if (buf.readUInt32LE(o) === SIG_LOC) return o;
  return -1;
}

/** 对 zip 类归档做前缀改写：条目名、以及解压后的内容各跑一遍 swap。非 zip / zip64 / 结构异常的原样返回 */
function rewriteZip(buf, swap) {
  const base = zipBase(buf);
  if (base < 0) return [buf, 0];

  let eocd = -1;                                            // 从尾部找 EOCD（注释最长 65535）
  for (let i = buf.length - 22; i >= base && i >= buf.length - 22 - 65535; i--)
    if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  if (eocd < 0) return [buf, 0];

  const nent = buf.readUInt16LE(eocd + 10);
  const cdOff = buf.readUInt32LE(eocd + 16) + base;
  if (nent === 0xffff || cdOff === 0xffffffff) return [buf, 0];   // zip64：本工具包用不到

  let hits = 0, pos = base, p = cdOff;
  const locals = [], cens = [];
  for (let i = 0; i < nent; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CEN) return [buf, 0];
    const cen = Buffer.from(buf.subarray(p, p + 46));
    const nlen = cen.readUInt16LE(28), elen = cen.readUInt16LE(30), clen = cen.readUInt16LE(32);
    const name = Buffer.from(buf.subarray(p + 46, p + 46 + nlen));
    const extra = Buffer.from(buf.subarray(p + 46 + nlen, p + 46 + nlen + elen));
    const comment = Buffer.from(buf.subarray(p + 46 + nlen + elen, p + 46 + nlen + elen + clen));
    const method = cen.readUInt16LE(10), csize = cen.readUInt32LE(20);
    const lo = cen.readUInt32LE(42) + base;
    p += 46 + nlen + elen + clen;

    if (lo + 30 > buf.length || buf.readUInt32LE(lo) !== SIG_LOC) return [buf, 0];
    const lnlen = buf.readUInt16LE(lo + 26), lelen = buf.readUInt16LE(lo + 28);
    const lhOut = Buffer.from(buf.subarray(lo, lo + 30));
    // 本地头有自己的名字与 extra（jar 首条常带 0xCAFE extra），长度未必与中央目录相同，必须原样带上
    const lname = Buffer.from(buf.subarray(lo + 30, lo + 30 + lnlen));
    const lextra = buf.subarray(lo + 30 + lnlen, lo + 30 + lnlen + lelen);

    const [nameOut, kn] = swap(name);                       // 条目名（等长，长度不变）
    const [lnameOut] = swap(lname);
    hits += kn;

    let data = Buffer.from(buf.subarray(lo + 30 + lnlen + lelen, lo + 30 + lnlen + lelen + csize));
    let usize = cen.readUInt32LE(24), crc = cen.readUInt32LE(16);
    if (method === 8) {                                     // deflate：解开 → 改 → 压回
      let raw;
      try { raw = zlib.inflateRawSync(data); } catch { return [buf, 0]; }
      const [dec, k] = swap(raw);
      if (k) {
        hits += k;
        data = zlib.deflateRawSync(dec, { level: 9 });
        usize = dec.length; crc = crc32(dec);
        cen.writeUInt32LE(data.length, 20); cen.writeUInt32LE(usize, 24); cen.writeUInt32LE(crc, 16);
      }
    } else if (method === 0) {                              // stored：明文，直接换
      const [d, k] = swap(data);
      if (k) { hits += k; data = d; crc = crc32(d); cen.writeUInt32LE(crc, 16); }
    } else {
      return [buf, 0];                                      // 不认识的压缩方式，别乱动
    }

    // 大小与 CRC 已写进本地头，数据描述符不再搬运 —— 清掉标志位 3，否则流式读取会去找它
    lhOut.writeUInt16LE(lhOut.readUInt16LE(6) & ~8, 6); cen.writeUInt16LE(cen.readUInt16LE(8) & ~8, 8);
    cen.writeUInt32LE(pos - base, 42);                      // 新的本地头偏移（与原档一样相对 zip 起点）
    lhOut.writeUInt32LE(data.length, 18); lhOut.writeUInt32LE(usize, 22); lhOut.writeUInt32LE(crc, 14);
    locals.push(lhOut, lnameOut, lextra, data);
    cens.push(cen, nameOut, extra, comment);
    pos += 30 + lnlen + lelen + data.length;
  }

  // 一处没命中就原档返回：重建会丢掉数据描述符等细节，签名过的 jar / 校验和也就不再逐字节一致
  if (!hits) return [buf, 0];
  const cdBuf = Buffer.concat(cens);
  const eocdOut = Buffer.from(buf.subarray(eocd, eocd + 22));
  eocdOut.writeUInt32LE(cdBuf.length, 12);
  eocdOut.writeUInt32LE(pos - base, 16);
  return [Buffer.concat([buf.subarray(0, base), ...locals, cdBuf, eocdOut, buf.subarray(eocd + 22)]), hits];
}

/** 读 zip（wheel 用）：[{ name, data }]，只认 stored / deflate，zip64 与结构异常直接抛错 */
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65535; i--)
    if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  if (eocd < 0) throw new Error("不是 zip");
  const nent = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (nent === 0xffff || p === 0xffffffff) throw new Error("zip64 不支持");
  const out = [];
  for (let i = 0; i < nent; i++) {
    if (buf.readUInt32LE(p) !== SIG_CEN) throw new Error("zip 中央目录坏了");
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const ext = buf.readUInt32LE(p + 38) >>> 16, lo = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString();
    p += 46 + nlen + elen + clen;
    if (buf.readUInt32LE(lo) !== SIG_LOC) throw new Error("zip 本地头坏了: " + name);
    const d0 = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
    const raw = buf.subarray(d0, d0 + csize);
    const data = method === 0 ? Buffer.from(raw) : method === 8 ? zlib.inflateRawSync(raw) : null;
    if (!data || data.length !== usize) throw new Error("zip 条目解不开: " + name);
    if (name.endsWith("/")) continue;
    out.push({ name, data, exec: (ext & 0o111) !== 0 });
  }
  return out;
}

// ── 主流程 ───────────────────────────────────────────────────────────
// 组件：底座仓库之外还可以用别的仓库（如 termux-x11），只在打组件时加载，不影响工具包本身的闭包
// 组件定义两个来源：devkit.json 的 components（预置组件，如 chromium），或 --recipe 指向的外部配方目录
// pip 的 wheel 只收 PyPI 官方文件服务器上的纯 Python 包
const PIP_URL = /^https:\/\/files\.pythonhosted\.org\/packages\/[0-9a-f/]+\/[A-Za-z0-9_.]+-[A-Za-z0-9_.+!]+-(?:py3|py2\.py3)-none-any\.whl$/;
const RECIPE_DIR = cmd === "component" && opt("recipe") ? path.resolve(opt("recipe")) : null;
const COMP = RECIPE_DIR ? loadRecipe(RECIPE_DIR) : cmd === "component" ? (MAN.components || {})[args[1]] : null;
const COMP_ID = COMP ? (RECIPE_DIR ? COMP.id : args[1]) : null;
if (cmd === "component" && !COMP) throw new Error("devkit.json 的 components 里没有: " + args[1]);
const COMP_BASE = RECIPE_DIR || HERE;          // files 的 src 相对它找

/** 外部配方：recipe.json + 可选的 skill/ 目录（自动装到 usr/share/cccodroid/components/<id>/skill/） */
function loadRecipe(dir) {
  const r = JSON.parse(fs.readFileSync(path.join(dir, "recipe.json"), "utf8"));
  if (r.schema !== 1) throw new Error("配方 schema 必须是 1");
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(r.id || "")) throw new Error("配方 id 不合法: " + r.id);
  if (!["termux", "glibc"].includes(r.kind || "termux")) throw new Error(`kind "${r.kind}" 还不支持（termux / glibc）`);
  if (!Array.isArray(r.roots) || !r.roots.length) throw new Error("roots 不能为空");
  for (const n of r.repos || []) if (!MAN.extraRepos[n]) throw new Error("不认识的仓库: " + n);
  r.files = { ...(r.files || {}) };
  for (const p of Object.keys(r.files)) if (!p.startsWith("usr/") || p.includes("..")) throw new Error("files 只能放进 usr/ 下: " + p);
  if (r.version !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(r.version)) throw new Error("version 不合法: " + r.version);
  // fetch（仓库外的上游原件）：和市场的 check-recipes 同一套规矩，这里再挡一遍，别全指望配方仓库那边
  for (const [p, f] of Object.entries(r.fetch || {})) {
    if (!p.startsWith("usr/") || p.includes("..")) throw new Error("fetch 只能放进 usr/ 下: " + p);
    if (f.link !== undefined) {
      // 软链只许指向同目录的一个文件名：绝对路径、带 / 的都不行
      if (!/^[A-Za-z0-9._+-]+$/.test(f.link) || f.link === "." || f.link === ".." || f.url || f.sha256) throw new Error("fetch 的 link 只能是同目录的文件名，且不带 url/sha256: " + p);
      continue;
    }
    if (!/^https:\/\/\S+$/.test(f.url || "")) throw new Error("fetch 的 url 必须是 https: " + p);
    if (!/^[0-9a-f]{64}$/.test(f.sha256 || "")) throw new Error("fetch 的 sha256 要写全: " + p);
    if (!f.why) throw new Error("fetch 要写 why: " + p);
    if (f.mode !== undefined && !/^[0-7]{3,4}$/.test(String(f.mode))) throw new Error("fetch 的 mode 是八进制三位/四位: " + p);
  }
  // pip（Termux 仓库没有的纯 Python 依赖）：只收 PyPI 官方文件服务器上的 *-none-any.whl，钉 sha256
  if (r.pip !== undefined) {
    if (!r.pip || !r.pip.why || !Array.isArray(r.pip.wheels) || !r.pip.wheels.length) throw new Error("pip 要写成 { why, wheels: [{ url, sha256 }] }");
    for (const w of r.pip.wheels) {
      if (!PIP_URL.test(w.url || "")) throw new Error("pip 的 wheel 只能是 files.pythonhosted.org 上的纯 Python 包（*-none-any.whl）: " + w.url);
      if (!/^[0-9a-f]{64}$/.test(w.sha256 || "")) throw new Error("pip 的 sha256 要写全: " + w.url);
    }
  }
  // npm（Termux 仓库没有、只在 npm 上发布的 Node 程序）：配方目录里要有 package.json + package-lock.json
  if (r.npm !== undefined) {
    if (!/^usr\/lib\/[a-z0-9][a-z0-9._-]*$/.test((r.npm && r.npm.dir) || "")) throw new Error("npm.dir 只能是 usr/lib/<名字>");
    if (!r.npm.why) throw new Error("npm 要写 why");
    for (const f of ["package.json", "package-lock.json"]) if (!fs.existsSync(path.join(dir, f))) throw new Error("npm 型组件缺 " + f);
  }
  const sk = path.join(dir, "skill");
  if (fs.existsSync(path.join(sk, "SKILL.md"))) {
    r.skill = `usr/share/cccodroid/components/${r.id}/skill`;
    for (const f of fs.readdirSync(sk)) r.files[`${r.skill}/${f}`] = { src: path.join("skill", f) };
  }
  return r;
}
// 发布版本：上游版本（配方可用 version 自己指定，fetch 型组件就靠它）+ 配方修订号 —— 修订号一直生效，
// 上游没变、只改了 skill 或包装脚本时加一就能发新版。预置组件（devkit.json）没有修订号。
const compVersion = (up) => (RECIPE_DIR ? `${COMP.version || up}-r${COMP.revision || 1}` : COMP.version || up);
// ldso：给 APK「经加载器」执行方式抽出 glibc 的 ld.so（build.sh 打进 lib/arm64-v8a/libldlinux.so）。
// targetSdk 36 不能 exec 数据目录里的 ld.so，只能 exec APK 原生库目录里的文件。
// 按工具包锁文件记的那个 glibc deb 取并核 sha256：ld.so 与工具包里的 libc.so.6 必须出自同一次构建，否则 GLIBC_PRIVATE 对不上
// Termux 仓库池里的旧 glibc 包会被删：--release <工具包 Release 目录 URL> 时退回那里留存的 glibc.deb（devkit.yml 传上去的，同样核 sha256）
// --vendored <目录>：源码树里随仓库存一份没改前缀的 ld.so（ld.json 记它出自哪个 glibc 包）。和锁文件对得上就直接用，构建不用联网；
// 对不上（钉了新工具包）就照常下载，并把这份替换掉，提交即可
//   node devkit.mjs ldso --lock <devkit.lock.json> [--target 包名] [--out 文件] [--release URL/] [--vendored 目录]
if (cmd === "ldso") {
  const lock = JSON.parse(fs.readFileSync(opt("lock") || (() => { throw new Error("--lock <工具包的 devkit.lock.json> 必填"); })(), "utf8"));
  const target = opt("target", lock.target);
  const rec = lock.packages.find((p) => p.name === "glibc");
  if (!rec) throw new Error("锁文件里没有 glibc");
  const vdir = opt("vendored"), vjson = vdir && path.join(vdir, "ld.json"), vso = vdir && path.join(vdir, "ld-linux-aarch64.so.1");
  const vrec = vjson && fs.existsSync(vjson) ? JSON.parse(fs.readFileSync(vjson, "utf8")) : null;
  let raw = null;
  if (vrec && vrec.version === rec.version && vrec.deb === rec.sha256 && fs.existsSync(vso)) {
    raw = fs.readFileSync(vso);
    if (sha256(raw) !== vrec.sha256) throw new Error(`${vso} 的 sha256 与 ld.json 不符`);
    console.log(`  用仓库里存的 ld.so（glibc ${rec.version}）`);
  }
  if (!raw) raw = await ldFromDeb(rec);
  if (vdir && !(vrec && vrec.version === rec.version && vrec.deb === rec.sha256)) {
    fs.mkdirSync(vdir, { recursive: true });
    fs.writeFileSync(vso, raw);
    fs.writeFileSync(vjson, JSON.stringify({ version: rec.version, deb: rec.sha256, sha256: sha256(raw) }, null, 2) + "\n");
    console.log(`  ⚠ 已把 ${vdir} 换成 glibc ${rec.version} 的 ld.so，记得提交`);
  }
  const [buf, n] = relocator(target).swap(raw);
  const out = opt("out", path.join(OUT, `ldso-${target}.so`));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, buf, { mode: 0o755 });
  console.log(`✓ ${out}  glibc ${rec.version} · ${buf.length} 字节 · 前缀改写 ${n} 处 · sha256 ${sha256(buf)}`);
  process.exit(0);
}
async function ldFromDeb(rec) {
  let deb;
  try { deb = await fetchDeb({ ...rec, repo: REPOS.find((r) => (r.name || "main") === rec.repo) || REPOS[0] }); }
  catch (e) {
    const rel = opt("release");
    if (!rel) throw e;
    console.log(`  Termux 仓库取不到 glibc ${rec.version}（${e.message}），改用 ${rel}glibc.deb`);
    deb = await new Promise((res, rej) => execFile("curl", ["-fsSL", "--retry", "3", rel + "glibc.deb"], { encoding: "buffer", maxBuffer: 64 << 20 },
      (err, out) => err ? rej(err) : res(out)));
    if (sha256(deb) !== rec.sha256) throw new Error(`Release 上的 glibc.deb sha256 ${sha256(deb)} 与锁文件 ${rec.sha256} 不符`);
  }
  const dir = TERMUX.slice(1) + "files/usr/glibc/lib/";
  const ents = [...readTar(await dataTar(deb))];
  let name = "ld-linux-aarch64.so.1", e;
  for (let hop = 0; hop < 4; hop++) {
    e = ents.find((x) => x.name.replace(/^\.\//, "") === dir + name);
    if (!e || e.type !== "2") break;
    name = path.basename(e.link);           // 软链：跟到同目录的真文件
  }
  if (!e || e.type !== "0") throw new Error("glibc 包里没找到 ld-linux-aarch64.so.1");
  return e.data;
}

const BASE = COMP ? JSON.parse(fs.readFileSync(opt("base") || (() => { throw new Error("--base <工具包的 devkit.lock.json> 必填"); })(), "utf8")) : null;
// build --plan：用划分时冻结下来的包记录，不再拉索引。同一个 Release 的整包和各块因此一定出自同一份快照
// （deb 进了缓存，后面几次打包不再联网；Termux 中途更新也不会让整包和模块对不上）
const PLAN = cmd === "build" && opt("plan") ? JSON.parse(fs.readFileSync(opt("plan"), "utf8")) : null;
const FROZEN = PLAN && PLAN.records;
const idx = FROZEN ? {
  pkgs: new Map(Object.entries(FROZEN).map(([n, r]) => [n, { name: n, ...r, repo: REPOS.find((x) => (x.name || "main") === r.repo) || REPOS[0] }])),
  provides: new Map(), date: PLAN.snapshot,
} : await loadIndex(COMP ? [...REPOS, ...(COMP.repos || []).map((n) => MAN.extraRepos[n])] : REPOS);
let baseDeps = [];          // 组件依赖链里、由底座提供的包（名字 + 底座里的版本）：市场据此判断换底座后要不要重新真机验证
// 整包按划分里的 full 取（旧划分没有这一项就是全部）；按块打时后面换成那一块的包
let { names, missing } = FROZEN ? { names: (!opt("block") && PLAN.full ? PLAN.full : Object.keys(FROZEN)).slice().sort(), missing: [] } : closure(idx, COMP ? COMP.roots : rootsFor(opt("groups")));
// 模块化：build --block <id> --plan <modules.plan.json> 只打划分里这一块的包
const BLOCK = PLAN && opt("block") ? (PLAN.blocks.find((b) => b.id === opt("block")) || (() => { throw new Error("划分里没有这一块: " + opt("block")); })()) : null;
const EXTRAS = !COMP && (!BLOCK || BLOCK.kind === "base");          // 替身、上游原件、Python 预编译只跟基础走
if (BLOCK) {
  const drift = BLOCK.packages.filter((n) => !idx.pkgs.has(n) || (PLAN.versions && idx.pkgs.get(n).version !== PLAN.versions[n]));
  if (drift.length) throw new Error(`仓库快照和划分时不一样了（${drift.slice(0, 5).join(", ")}…），重跑 modules 再打`);
  names = BLOCK.packages; missing = [];
}
if (COMP) {
  // 底座已经有的包不再打；底座里的版本和仓库现在的不一样时提醒（组件可能要求更新的库）
  const inBase = new Map(BASE.packages.map((p) => [p.name, p.version]));
  const drift = names.filter((n) => inBase.has(n) && inBase.get(n) !== idx.pkgs.get(n).version);
  if (drift.length) console.log("⚠ 底座与仓库版本不同（组件按底座的版本用）: " + drift.map((n) => `${n} ${inBase.get(n)}→${idx.pkgs.get(n).version}`).join(", "));
  baseDeps = names.filter((n) => inBase.has(n)).sort().map((n) => ({ name: n, version: inBase.get(n) }));
  names = names.filter((n) => !inBase.has(n));
}
const total = names.reduce((s, n) => s + idx.pkgs.get(n).size, 0);
const itotal = names.reduce((s, n) => s + idx.pkgs.get(n).isize, 0);
console.log(`仓库快照 ${idx.date} · ${idx.pkgs.size} 个包`);
console.log(`闭包 ${names.length} 个包 · 下载 ${mb(total)} · 解包后约 ${mb(itotal)}`);
if (missing.length) console.log("⚠ 无法满足: " + missing.join("; "));
if (missing.length && RECIPE_DIR) { console.error("✗ 配方的依赖有满足不了的，停止"); process.exit(1); }

if (cmd === "resolve" || (COMP && args.includes("--dry"))) {
  if (COMP) {          // 给 CI 用：先算出这次会打成哪个版本，已发布过就跳过
    const v = idx.pkgs.get(COMP.roots[0]).version;
    console.log("COMPONENT_VERSION=" + compVersion(v));
  }
  for (const n of names) { const p = idx.pkgs.get(n); console.log(`  ${n.padEnd(28)} ${p.version.padEnd(18)} ${mb(p.isize)}`); }
  process.exit(0);
}

// ── 模块划分（见 devkit.json 的 modules）────────────────────────────────
// 基础模块的闭包先算；其余模块只要超出基础的那部分。被两个以上模块用到、又不小于 sharedMinMB 的包
// 提成共享层（连同它自己在基础之外的依赖），模块依赖共享层而不各带一份；更小的共用包各模块各带一份
// （同一快照、内容相同，App 装卸靠共享文件计数）。
function partition() {
  const mods = MAN.modules || {}, ids = Object.keys(mods);
  const baseId = ids.find((id) => mods[id].required);
  if (!baseId) throw new Error("devkit.json 的 modules 里没有 required 的基础模块");
  const rootsOf = (id) => mods[id].groups.flatMap((g) => { if (!MAN.groups[g]) throw new Error(`${id}: 没有这个分组 ${g}`); return MAN.groups[g]; });
  const miss = [];
  const cl = (roots, who) => { const r = closure(idx, roots); miss.push(...r.missing.map((m) => `${who}: ${m}`)); return r.names; };
  const base = new Set(cl(rootsOf(baseId), baseId));
  const own = new Map(ids.filter((id) => id !== baseId).map((id) => [id, new Set(cl(rootsOf(id), id).filter((n) => !base.has(n)))]));
  const users = new Map();
  for (const [id, s] of own) for (const n of s) users.set(n, [...(users.get(n) || []), id]);
  // 共享层：大包 → 它在基础之外的闭包整块进层；用户集合相同的大包合成一层
  const big = [...users].filter(([n, u]) => u.length >= 2 && idx.pkgs.get(n).isize >= (MAN.sharedMinMB || 50) * 1048576);
  const layers = new Map();
  for (const [n, u] of big) {
    const key = u.join("+");
    if (!layers.has(key)) layers.set(key, { users: u, roots: [] });
    layers.get(key).roots.push(n);
  }
  const layerList = [...layers.values()].map((l) => ({
    id: "lib-" + l.roots.slice().sort()[0], users: l.users, roots: l.roots.sort(),
    names: new Set(cl(l.roots, "共享层").filter((n) => !base.has(n))),
  }));
  const out = { baseId, base: [...base].sort(), modules: {}, layers: layerList, missing: miss };
  for (const [id, s] of own) {
    const deps = layerList.filter((l) => l.roots.every((r) => s.has(r)));
    const inLayers = new Set(deps.flatMap((l) => [...l.names]));
    const names = [...s].filter((n) => !inLayers.has(n)).sort();
    out.modules[id] = { deps: [baseId, ...deps.map((l) => l.id)], names, dup: names.filter((n) => users.get(n).length >= 2) };
  }
  // 自检：每个分组闭包里的包都得落到某处，且全量闭包与各块并集相等
  const all = new Set(cl(rootsFor(ids.flatMap((id) => mods[id].groups).join(",")), "全部"));
  const got = new Set([...base, ...layerList.flatMap((l) => [...l.names]), ...Object.values(out.modules).flatMap((m) => m.names)]);
  const lost = [...all].filter((n) => !got.has(n)), extra = [...got].filter((n) => !all.has(n));
  if (lost.length || extra.length) throw new Error(`模块划分对不上全量闭包：缺 ${lost.join(",")} 多 ${extra.join(",")}`);
  return out;
}

function makePlan() {
  const P = partition();
  const sz = (ns) => ns.reduce((a, n) => [a[0] + idx.pkgs.get(n).size, a[1] + idx.pkgs.get(n).isize], [0, 0]);
  const row = (id, ns, deps, note = "") => { const [d, i] = sz(ns); console.log(`  ${id.padEnd(16)} ${String(ns.length).padStart(4)} 包  下载 ${mb(d).padStart(9)}  解包 ${mb(i).padStart(9)}  依赖 ${deps.join(",") || "—"}${note}`); };
  console.log("\n模块划分：");
  row(P.baseId, P.base, []);
  for (const l of P.layers) row(l.id, [...l.names], [P.baseId], `  （共享层，给 ${l.users.join("、")}）`);
  for (const [id, m] of Object.entries(P.modules)) {
    const [dd] = sz(m.dup);
    row(id, m.names, m.deps, m.dup.length ? `  （其中 ${m.dup.length} 个小包与别的模块共用，下载 ${mb(dd)}）` : "");
  }
  // 各模块共用的小包装到手机上是同一份文件（共享计数），只在下载时重复
  const [ad, ai] = sz(names), blocksDl = [P.base, ...P.layers.map((l) => [...l.names]), ...Object.values(P.modules).map((m) => m.names)].reduce((s, ns) => s + sz(ns)[0], 0);
  console.log(`  全部装上：占用 ${mb(ai)}，下载 ${mb(blocksDl)}（比整包多下 ${mb(blocksDl - ad)}，是共用小包的重复）`);
  if (P.missing.length) console.log("⚠ 无法满足: " + [...new Set(P.missing)].join("; "));
  // 整包（给只认整包的旧 App，以及从整包升上来时「装上全部模块」的那份清单）只含 full 不为 false 的模块：
  // 后加的大模块（Go、Node 生态）旧用户本来就没有，别让他们升级时平白多下几百 MB
  const fullMods = Object.keys(MAN.modules).filter((id) => MAN.modules[id].full !== false);
  const full = closure(idx, rootsFor(fullMods.flatMap((id) => MAN.modules[id].groups).join(","))).names.sort();
  const [fd, fi] = sz(full);
  console.log(`  整包（不含 ${Object.keys(MAN.modules).filter((id) => MAN.modules[id].full === false).join("、") || "—"}）：${full.length} 包，下载 ${mb(fd)}，解包 ${mb(fi)}`);
  const plan = {
    snapshot: idx.date, base: P.baseId, sharedMinMB: MAN.sharedMinMB || 50, full,
    records: Object.fromEntries(names.map((n) => { const p = idx.pkgs.get(n);
      return [n, { version: p.version, file: p.file, sha256: p.sha256, size: p.size, isize: p.isize, source: p.source, homepage: p.homepage, deps: p.deps, repo: p.repo.name || "main" }]; })),
    blocks: [
      { id: P.baseId, kind: "base", deps: [], packages: P.base },
      ...P.layers.map((l) => ({ id: l.id, kind: "shared", deps: [P.baseId], users: l.users, packages: [...l.names].sort() })),
      ...Object.entries(P.modules).map(([id, m]) => ({ id, kind: "module", deps: m.deps, packages: m.names, sharedSmall: m.dup })),
    ].map((b) => ({ ...b, download: sz(b.packages)[0], installed: sz(b.packages)[1] })),
  };
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "modules.plan.json"), JSON.stringify(plan, null, 2));
  const planFile = path.join(OUT, "modules.plan.json");
  console.log(`\n→ ${planFile}`);
  return { plan, planFile };
}

if (cmd === "modules") {
  // --plan：沿用已有的划分（CI 先出划分、按它打整包，再按同一份打各块），不重新求解
  const { plan, planFile } = opt("plan")
    ? { plan: JSON.parse(fs.readFileSync(opt("plan"), "utf8")), planFile: path.resolve(opt("plan")) }
    : makePlan();
  if (opt("plan")) console.log(`沿用划分 ${planFile}（快照 ${plan.snapshot}）`);
  if (!args.includes("--build") && !args.includes("--merge")) process.exit(0);
  const target = opt("target");
  if (!target) throw new Error("--target <10 字符包名> 必填");
  // 逐块打包：每块一个子进程（各自的 tar / MANIFEST / first-run / 锁文件），版本按 plan 核对
  if (args.includes("--build")) for (const b of plan.blocks) {
    console.log(`\n━━ ${b.id}（${b.kind}，${b.packages.length} 包）`);
    execFileSync(process.execPath, [new URL(import.meta.url).pathname, "build", "--block", b.id, "--plan", planFile,
      "--target", target, "--out", OUT, "--cache", CACHE], { stdio: "inherit" });
  }
  // 合并：跨块同一路径内容必须相同（共用小包是同一份文件）；alternatives 同组不能两块各给一个
  const owner = new Map(), alt = new Map(), bad = [];
  const locks = plan.blocks.map((b) => JSON.parse(fs.readFileSync(path.join(OUT, `module-${b.id}.lock.json`), "utf8")));
  for (const l of locks) {
    if (l.target !== target) bad.push(`${l.id} 是给 ${l.target} 打的`);
    for (const line of fs.readFileSync(path.join(OUT, `MANIFEST-${l.id}`), "utf8").split("\n")) {
      if (!line) continue;
      const i = line.indexOf(" "), h = line.slice(0, i), p = line.slice(line.indexOf(" ", i + 1) + 1);       // 路径里可能有空格
      const o = owner.get(p);
      if (o && o.h !== h) bad.push(`${p}：${o.id} 与 ${l.id} 内容不同`);
      if (!o) owner.set(p, { id: l.id, h });
    }
    for (const a of l.alternatives) {
      const o = alt.get(a.group);
      if (o && o.pkg !== a.pkg) bad.push(`alternatives ${a.group}：${o.id} 给 ${o.pkg}，${l.id} 给 ${a.pkg}`);
      if (!o) alt.set(a.group, { ...a, id: l.id });
    }
  }
  if (bad.length) { console.error("✗ 模块之间有冲突：\n  " + bad.slice(0, 30).join("\n  ")); process.exit(1); }
  const def = MAN.modules;
  const mj = {
    // format：modules.json 自身的格式版本；compat 同 devkit.lock.json（外壳接口版本）
    format: 1, compat: 1, target, snapshot: plan.snapshot, base: plan.base, built: new Date().toISOString(),
    modules: locks.map((l) => ({
      id: l.id, kind: l.kind, required: !!(def[l.id] || {}).required, deps: l.deps, users: l.users || [],
      full: (def[l.id] || {}).full !== false,   // false：整包里没有它，整包用户升级时不当成已装
      name: (def[l.id] || {}).name || { zh: "共享运行库", en: "Shared libraries" },
      desc: (def[l.id] || {}).desc || { zh: `被 ${l.users.join("、")} 共用的大库，没有模块用到时自动卸载。`, en: `Large library shared by ${l.users.join(", ")}; removed automatically when no module needs it.` },
      uses: (def[l.id] || {}).uses || [], dir: l.dir,
      gz: l.gz, tar: { bytes: l.tar.bytes, sha256: l.tar.sha256 }, installed: l.installed, files: l.files,
      commands: l.commands, key: ((def[l.id] || {}).key || []).filter((c) => l.commands.includes(c)), firstRun: l.firstRun,
      packages: l.packages.map((p) => ({ name: p.name, version: p.version, source: p.source })),
    })),
  };
  fs.writeFileSync(path.join(OUT, "modules.json"), JSON.stringify(mj, null, 2));
  console.log(`\n✓ modules.json：${mj.modules.length} 块，下载合计 ${mb(mj.modules.reduce((s, m) => s + m.gz.bytes, 0))}，共 ${owner.size} 个文件路径，跨块无冲突`);
  process.exit(0);
}

if (cmd === "build" || cmd === "component") {
  const target = opt("target");
  // 组件的私有文件放在 libexec/devkit/components/<id>/ 下，和底座的 libexec/devkit/ 分开
  const LX = COMP ? `usr/libexec/devkit/components/${COMP_ID}` : BLOCK && BLOCK.kind !== "base" ? `usr/libexec/devkit/modules/${BLOCK.id}` : "usr/libexec/devkit";
  if (!target) throw new Error("--target <10 字符包名> 必填");
  const R = relocator(target);
  await bootXz(idx);
  console.log(XZ ? "  解压：原生 xz" : "  解压：JS");
  fs.mkdirSync(OUT, { recursive: true });
  const tarFile = path.join(OUT, COMP ? `component-${COMP_ID}-${target}.tar` : BLOCK ? `devkit-${BLOCK.id}-${target}.tar` : `devkit-${target}.tar`);
  const tw = new TarWriter(tarFile + ".part");
  // 逐文件清单（libexec/devkit/MANIFEST）："sha256 大小 相对 usr/ 的路径"。App 装完拿它核对缺没缺、坏没坏。
  // 同名条目以最后写入的为准（tar 解包也是后来的覆盖前面的）；被软链盖掉的不算文件
  const manifest = new Map();
  const bins = new Set();          // usr/bin 下的命令（文件和软链都算），模块卡片上列出来
  const paths = new Set();         // 放进 usr/ 的全部非目录路径（含软链）：模块卸载按它删，MANIFEST 不记软链
  const twAdd = tw.add.bind(tw);
  tw.add = (e) => {
    const rel = e.name.startsWith("usr/") ? e.name.slice(4) : null;
    if (rel && /^bin\/[^/]+$/.test(rel)) { if (e.type === "5") bins.delete(rel.slice(4)); else bins.add(rel.slice(4)); }
    if (rel) { if (e.type === "5") paths.delete(rel.replace(/\/$/, "")); else paths.add(rel); }
    if (rel) {
      if ((e.type === "0" || e.type === "7") && e.data) manifest.set(rel, [sha256(e.data), e.data.length]);
      else if (e.type === "1") { const t = (e.link || "").replace(/^usr\//, ""); if (manifest.has(t)) manifest.set(rel, manifest.get(t)); }
      else manifest.delete(rel.replace(/\/$/, ""));
    }
    return twAdd(e);
  };
  const lock = [], seenDirs = new Set();
  const alts = new Map();          // 组名 → 优先级最高的那组链接
  const firstRun = [];             // 除 alternatives 外仍要在设备上跑的 postinst
  let patchedFiles = 0, patchedHits = 0, t0 = Date.now();
  let ensurepipVer = null;            // python 的 ensurepip 要哪一版 pip（下面 fetch 的 wheel 必须是这一版，不然 python -m venv 建不出 pip）

  for (const [i, n] of names.entries()) {
    const p = idx.pkgs.get(n);
    process.stdout.write(`  [${String(i + 1).padStart(3)}/${names.length}] ${n.padEnd(26)} ${p.version.padEnd(16)}`);
    const deb = await fetchDeb(p);
    const tar = await dataTar(deb);
    const sc = await controlScripts(deb);
    if (sc.postinst) {
      for (const a of parseAlternatives(sc.postinst)) {
        const cur = alts.get(a.group);
        if (!cur || a.prio > cur.prio) alts.set(a.group, { ...a, pkg: n });
      }
      // 只有 alternatives 的脚本不用再跑；其余的原样保留（前缀已等长改写）
      const rest = sc.postinst.replace(/# Automatically added by termux_step_create_alternatives[\s\S]*?# End automatically added section/g, "")
        .split("\n").filter((l) => l.trim() && !l.startsWith("#!") && !/^\s*exit 0\s*$/.test(l));
      if (rest.length) firstRun.push({ pkg: n, script: R.swap(Buffer.from(sc.postinst))[0].toString() });
    }
    let files = 0, hit = 0;
    const listing = [];          // dpkg 风格的文件清单，见下
    for (const e of readTar(tar)) {
      const name = R.pathOf(e.name);
      if (!name) continue;
      const clean = name.replace(/\/$/, "");
      if (!clean) continue;
      if (DROP.has(clean)) continue;
      listing.push("/" + R.to.replace(/^\//, "") + "files/" + clean);
      if (e.type === "5") {
        if (seenDirs.has(clean)) continue;
        seenDirs.add(clean);
        tw.add({ name: clean + "/", type: "5", mode: e.mode || 0o755, mtime: e.mtime });
        continue;
      }
      if (e.type === "2") { tw.add({ name: clean, type: "2", mode: 0o777, mtime: e.mtime, link: R.swap(Buffer.from(e.link))[0].toString() }); continue; }
      if (e.type === "1") { tw.add({ name: clean, type: "1", mode: e.mode, mtime: e.mtime, link: R.pathOf(e.link) || e.link }); continue; }
      if (e.type !== "0" && e.type !== "7") continue;
      // zip 类归档要下潜到压缩条目内部再改一遍，flat 替换在里面找不到模式
      const [data, k] = looksLikeZip(clean) ? rewriteZip(e.data, R.swap) : R.swap(e.data);
      if (k) { hit += k; patchedFiles++; }
      if (/\/ensurepip\/__init__\.py$/.test(clean)) ensurepipVer = (/^_PIP_VERSION = "([^"]+)"/m.exec(data.toString("utf8")) || [])[1] || null;
      tw.add({ name: clean, type: "0", mode: e.mode, mtime: e.mtime, data });
      files++;
    }
    patchedHits += hit;
    // var/lib/dpkg/info/<包>.list：我们不带 dpkg，但有的 postinst 拿它判断"某个包装没装"。
    // 实测：python 的 postinst 看不到 python-pip.list，就认定 pip 是旧版残留，把刚解出来的 pip 整个删掉。
    tw.add({ name: `usr/var/lib/dpkg/info/${n}.list`, type: "0", mode: 0o644, mtime: 0, data: Buffer.from(listing.join("\n") + "\n") });
    lock.push({
      name: n, repo: p.repo.name || "main", version: p.version, source: p.source, file: p.file, sha256: p.sha256, size: p.size,
      homepage: p.homepage,
      recipe: `https://github.com/termux/termux-packages/tree/master/packages/${p.source}`,
    });
    console.log(` ${String(files).padStart(5)} 文件  改写 ${hit}`);
  }
  // alternatives → 绝对路径软链（跟 update-alternatives 的结果一致，省掉它的数据库）
  const usrOf = (p) => R.pathOf(p.replace(/^\//, ""));
  // 模块：依赖的块（先打好了）已经给了同一组、优先级又不低于这里的，就不写 —— 和整包里按优先级选出来的一样
  // （例：基础块 pager←less 50，cli 块 pager←bat 10，整包里是 less）
  if (BLOCK) for (const d of BLOCK.deps || []) {
    let dl; try { dl = JSON.parse(fs.readFileSync(path.join(OUT, `module-${d}.lock.json`), "utf8")); } catch { throw new Error(`先打 ${d} 再打 ${BLOCK.id}（要看它的 alternatives）`); }
    for (const a of dl.alternatives || []) {
      const mine = alts.get(a.group);
      if (mine && a.prio >= mine.prio) { console.log(`  alternatives ${a.group}：${d} 已给 ${a.pkg}（${a.prio}），这里的 ${mine.pkg}（${mine.prio}）不写`); alts.delete(a.group); }
    }
  }
  for (const a of alts.values()) {
    for (const [link, target] of a.links) {
      const name = usrOf(link);
      if (name) tw.add({ name, type: "2", mode: 0o777, mtime: 0, link: R.swap(Buffer.from(target))[0].toString() });
    }
  }
  // 替身：pkg/apt 这类在这里用不了的命令，换成说明为什么、该怎么办的小脚本
  for (const [p, text] of Object.entries(EXTRAS ? MAN.stubs || {} : {})) {
    tw.add({ name: p, type: "0", mode: 0o755, mtime: 0, data: Buffer.from("#!" + R.to + "files/usr/bin/sh\n" + text.replace(/\n?$/, "\n")) });
  }
  // 仓库之外的上游原件（如 ensurepip 的 pip wheel）：下载、核对哈希、原样放进去
  // mode 可给（如 755 的可执行文件），source 只是记账用（默认 pypi），和解包体积也会算进 installed
  let fetchedBytes = 0;
  if (Object.keys((COMP ? COMP.fetch : EXTRAS ? MAN.fetch : null) || {}).length) fs.mkdirSync(CACHE, { recursive: true });
  for (const [p, f] of Object.entries((COMP ? COMP.fetch : EXTRAS ? MAN.fetch : null) || {})) {
    // link：只做一个软链（如 libOpenCL.so.1 → libOpenCL.so，库的 SONAME 是 .so.1 时要用）。
    // 目标写相对名即可（App 用真 tar 解包，同目录相对链最稳）；不进 MANIFEST，也不算体积。
    if (f.link) { tw.add({ name: p, type: "2", mode: 0o777, mtime: 0, link: f.link }); continue; }
    const ep = /\/ensurepip\/_bundled\/pip-([^-]+)-/.exec(p);
    if (ep && ensurepipVer && ep[1] !== ensurepipVer) throw new Error(`${p}: python 的 ensurepip 要 pip ${ensurepipVer}，这里给的是 ${ep[1]}（python 升级了：到 PyPI 换成 pip-${ensurepipVer}-py3-none-any.whl，填新的 url 与 sha256）`);
    const dest = path.join(CACHE, path.basename(p));
    let b = fs.existsSync(dest) ? fs.readFileSync(dest) : null;
    if (!b || sha256(b) !== f.sha256) {
      b = fetchUrl(f.url);
      if (sha256(b) !== f.sha256) throw new Error(`${p}: 哈希不符`);
      fs.writeFileSync(dest, b);
    }
    tw.add({ name: p, type: "0", mode: parseInt(f.mode || "644", 8), mtime: 0, data: b });
    lock.push({ name: path.basename(p), version: f.version || path.basename(p).split("-")[1], source: f.source || "pypi", homepage: f.url, recipe: "-", file: f.url, sha256: f.sha256, size: b.length, why: f.why });
    fetchedBytes += b.length;
  }
  // pip：纯 Python 的 wheel 照 pip 的布局解进 site-packages（dist-info 一起，INSTALLER 记成 devkit）。
  // 典型用途：matplotlib 的 postinst 会现场 `pip install matplotlib` 去 PyPI 拉 cycler / six 这些 ——
  // 不钉版本、离线就装坏、拉下来的文件也不进组件记录（卸载删不掉）。打进组件后 pip 判定已满足，不再联网。
  // console_scripts 照 pip 的样子生成入口脚本；.data/ 下只认 purelib / platlib / scripts / data。
  if (COMP && COMP.pip) {
    const pyv = (BASE.packages.find((p) => p.name === "python") || {}).version;
    if (!pyv) throw new Error("pip：底座里没有 python");
    const sp = `usr/lib/python${pyv.match(/^\d+\.\d+/)[0]}/site-packages`;
    const py = R.to + "files/usr/bin/python3";
    const dir = (p) => { const parts = p.split("/"); for (let i = 2; i < parts.length; i++) { const d = parts.slice(0, i).join("/"); if (!seenDirs.has(d)) { seenDirs.add(d); tw.add({ name: d + "/", type: "5", mode: 0o755, mtime: 0 }); } } };
    const put = (name, data, mode) => {
      if (manifest.has(name.slice(4))) throw new Error("pip：wheel 里的文件和 Termux 包的撞了: " + name);
      dir(name); tw.add({ name, type: "0", mode, mtime: 0, data }); fetchedBytes += data.length;
    };
    fs.mkdirSync(CACHE, { recursive: true });
    for (const w of COMP.pip.wheels) {
      const file = decodeURIComponent(w.url.split("/").pop());
      const dest = path.join(CACHE, file);
      let b = fs.existsSync(dest) ? fs.readFileSync(dest) : null;
      if (!b || sha256(b) !== w.sha256) {
        b = fetchUrl(w.url);
        if (sha256(b) !== w.sha256) throw new Error(`${file}: 哈希不符`);
        fs.writeFileSync(dest, b);
      }
      const [dist, ver] = file.split("-");
      const ents = unzip(b);
      const di = ents.find((e) => /^[^/]+\.dist-info\/METADATA$/.test(e.name));
      if (!di) throw new Error(file + ": 没有 dist-info/METADATA");
      const diDir = di.name.split("/")[0], dataDir = diDir.replace(/\.dist-info$/, ".data");
      let n = 0;
      for (const e of ents) {
        if (e.name.includes("..") || e.name.startsWith("/")) throw new Error(file + ": 条目路径不安全: " + e.name);
        if (e.name === diDir + "/INSTALLER") continue;
        if (e.name.startsWith(dataDir + "/")) {
          const [, kind, ...rest] = e.name.split("/");
          if (kind === "purelib" || kind === "platlib") put(`${sp}/${rest.join("/")}`, e.data, 0o644);
          else if (kind === "scripts") put(`usr/bin/${rest.join("/")}`, Buffer.from(e.data.toString().replace(/^#!python[^\n]*/, "#!" + py)), 0o755);
          else if (kind === "data") put(`usr/${rest.join("/")}`, e.data, 0o644);       // 相对 $PREFIX，如 share/man/man1/ttx.1
          else throw new Error(`${file}: .data/${kind} 不支持`);
        } else put(`${sp}/${e.name}`, e.data, 0o644);
        n++;
      }
      put(`${sp}/${diDir}/INSTALLER`, Buffer.from("cccodroid-devkit\n"), 0o644);
      // console_scripts → 入口脚本（与 pip 生成的等价）
      const ep = ents.find((e) => e.name === diDir + "/entry_points.txt");
      let sec = "";
      for (const line of ep ? ep.data.toString().split("\n") : []) {
        const t = line.trim();
        if (/^\[.*\]$/.test(t)) { sec = t.slice(1, -1); continue; }
        const m = sec === "console_scripts" && t.match(/^([A-Za-z0-9_.-]+)\s*=\s*([A-Za-z0-9_.]+):([A-Za-z0-9_.]+)/);
        if (!m) continue;
        const top = m[3].split(".")[0];
        put(`usr/bin/${m[1]}`, Buffer.from(`#!${py}\nimport re\nimport sys\nfrom ${m[2]} import ${top}\nif __name__ == "__main__":\n    sys.argv[0] = re.sub(r"(-script\\.pyw|\\.exe)?$", "", sys.argv[0])\n    sys.exit(${m[3]}())\n`), 0o755);
      }
      lock.push({ name: dist.replace(/_/g, "-").toLowerCase(), version: ver, source: "pypi", homepage: `https://pypi.org/project/${dist}/`, recipe: "-", file: w.url, sha256: w.sha256, size: b.length, why: COMP.pip.why });
      console.log(`  pip：${file}  ${n} 个文件`);
    }
  }
  // npm：按配方提交的 package-lock.json 用 npm ci 装 —— 每个包的 sha512 由 npm 逐个核对、不跑安装脚本、
  // 可选依赖只取 android/arm64 的（esbuild 这类按平台分包的）。整棵 node_modules 原样放进 npm.dir。
  // 装出来的包若声明了不支持 android / arm64（npm 太老、忽略了 --os/--cpu 时会这样），直接失败，别打出一个装不了的包
  if (COMP && COMP.npm) {
    const w = fs.mkdtempSync(path.join(OUT, "npm-"));
    for (const f of ["package.json", "package-lock.json"]) fs.copyFileSync(path.join(COMP_BASE, f), path.join(w, f));
    console.log("  npm ci（android/arm64）…");
    execFileSync("npm", ["ci", "--os=android", "--cpu=arm64", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund"], { cwd: w, stdio: "inherit" });
    const plock = JSON.parse(fs.readFileSync(path.join(w, "package-lock.json"), "utf8")).packages || {};
    const nm = path.join(w, "node_modules");
    let nfiles = 0;
    const add = (abs, rel) => {
      const st = fs.lstatSync(abs), name = `${COMP.npm.dir}/node_modules/${rel}`;
      if (st.isSymbolicLink()) {
        const t = fs.readlinkSync(abs);
        // .bin 里的入口是相对软链；指出 node_modules 的一律不要
        if (path.isAbsolute(t) || path.relative(nm, path.resolve(path.dirname(abs), t)).startsWith("..")) throw new Error("npm 软链指出了 node_modules: " + rel + " → " + t);
        tw.add({ name, type: "2", mode: 0o777, mtime: 0, link: t });
      } else if (st.isDirectory()) {
        tw.add({ name: name + "/", type: "5", mode: 0o755, mtime: 0 });
        for (const e of fs.readdirSync(abs).sort()) add(path.join(abs, e), rel + "/" + e);
      } else if (st.isFile()) {
        const data = fs.readFileSync(abs);
        tw.add({ name, type: "0", mode: st.mode & 0o111 ? 0o755 : 0o644, mtime: 0, data });
        fetchedBytes += data.length; nfiles++;
      }
    };
    tw.add({ name: `${COMP.npm.dir}/`, type: "5", mode: 0o755, mtime: 0 });
    tw.add({ name: `${COMP.npm.dir}/node_modules/`, type: "5", mode: 0o755, mtime: 0 });
    for (const e of fs.readdirSync(nm).sort()) if (e !== ".package-lock.json") add(path.join(nm, e), e);
    for (const [k, p] of Object.entries(plock)) {
      if (!k || !fs.existsSync(path.join(w, k, "package.json"))) continue;       // 别的平台的可选依赖：没装
      const pj = JSON.parse(fs.readFileSync(path.join(w, k, "package.json"), "utf8"));
      const okOs = !pj.os || pj.os.some((o) => o === "android" || (o.startsWith("!") && o !== "!android"));
      const okCpu = !pj.cpu || pj.cpu.some((c) => c === "arm64" || (c.startsWith("!") && c !== "!arm64"));
      if (!okOs || !okCpu) throw new Error(`npm 装了不支持 android/arm64 的包 ${k}（os=${pj.os} cpu=${pj.cpu}）—— npm 太老？要 10 以上`);
      lock.push({ name: k.replace(/^.*node_modules\//, ""), version: p.version, source: "npm", homepage: p.resolved, recipe: "-", file: p.resolved, sha256: p.integrity, size: 0, why: COMP.npm.why });
    }
    fs.rmSync(w, { recursive: true, force: true });
    console.log(`  npm：${lock.filter((l) => l.source === "npm").length} 个包、${nfiles} 个文件`);
  }
  // 组件自带的文件（入口包装、给 Claude 的 skill）：{{PREFIX}} 换成本应用的前缀
  for (const [p, f] of Object.entries((COMP && COMP.files) || {})) {
    const text = fs.readFileSync(path.join(COMP_BASE, f.src), "utf8").replaceAll("{{PREFIX}}", R.to + "files/usr");
    tw.add({ name: p, type: "0", mode: parseInt(f.mode || "644", 8), mtime: 0, data: Buffer.from(text) });
  }
  // 首次运行脚本：App 解包后跑一次（参数与 dpkg 一致：configure）
  const fr = ["#!" + R.to + "files/usr/bin/sh", "# devkit 首次运行：各包 postinst 里除 alternatives 外的步骤", "cd \"$HOME\" 2>/dev/null"];
  for (const f of firstRun) {
    const p = `${LX}/postinst/${f.pkg}`;
    // py3compile 要靠 termux-setup-package-manager + dpkg -L 列包内文件，我们两样都没带 ——
    // 原样跑会刷一屏 "cannot determine system package manager"。换成末尾统一 compileall。
    const script = f.script.replace(/^.*\/py3compile" -p .*$/gm, ": # py3compile → 由 first-run.sh 末尾的 compileall 统一做");
    tw.add({ name: p, type: "0", mode: 0o755, mtime: 0, data: Buffer.from(script) });
    fr.push(`echo "▸ ${f.pkg}"; "${R.to}files/${p}" configure || echo "  （${f.pkg} 的 postinst 失败，rc=$?）"`);
  }
  const py = R.to + "files/usr/bin/python3";
  if (EXTRAS) fr.push(`if [ -x "${py}" ]; then echo "▸ 预编译 Python 标准库与 site-packages"; LD_PRELOAD= "${py}" -m compileall -q -j 0 "$(LD_PRELOAD= "${py}" -c "import sysconfig; print(sysconfig.get_path(\x27stdlib\x27))")" >/dev/null 2>&1; fi`);
  tw.add({ name: `${LX}/first-run.sh`, type: "0", mode: 0o755, mtime: 0, data: Buffer.from(fr.join("\n") + "\n") });
  const manText = [...manifest].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([p, [h, n]]) => `${h} ${n} ${p}`).join("\n") + "\n";
  twAdd({ name: `${LX}/MANIFEST`, type: "0", mode: 0o644, mtime: 0, data: Buffer.from(manText) });
  if (BLOCK) {
    paths.add(`${LX.slice(4)}/MANIFEST`); paths.add(`${LX.slice(4)}/FILES`);
    twAdd({ name: `${LX}/FILES`, type: "0", mode: 0o644, mtime: 0, data: Buffer.from([...paths].sort().join("\n") + "\n") });
  }
  console.log(`  文件清单：${manifest.size} 个文件`);
  console.log(`  alternatives：${[...alts.values()].map((a) => a.group + "←" + a.pkg).join(" ")}`);
  console.log(`  首次运行脚本：${firstRun.map((f) => f.pkg).join(" ") || "无"}`);
  tw.close();
  fs.renameSync(tarFile + ".part", tarFile);
  // 发布用的压缩包：gzip —— 安卓 Java 自带解压（xz/zstd 的解压器要等工具包装好才有，先有鸡还是先有蛋）
  console.log("  压缩 → .tar.gz …");
  const tarInfo = await hashFile(tarFile);
  const gzInfo = await gzipFile(tarFile, tarFile + ".gz");

  if (COMP) {
    // 组件清单：App 据此判断能不能装（底座要对得上）、装后跑哪个 first-run、哪些是入口命令
    const pkgVer = idx.pkgs.get(COMP.roots[0]).version;
    fs.writeFileSync(path.join(OUT, `component-${COMP_ID}.json`), JSON.stringify({
      id: COMP_ID, version: compVersion(pkgVer), upstream: COMP.version || pkgVer, target, compat: 1,
      base: { snapshot: BASE.snapshot, gz: BASE.gz.sha256 },
      bin: COMP.bin || [], skill: COMP.skill || "", selftest: COMP.selftest || "", files: manifest.size,
      name: COMP.name, desc: COMP.desc, kind: COMP.kind || "termux", needs: COMP.needs || {}, license: COMP.license || "",
      tar: { file: path.basename(tarFile), ...tarInfo },
      gz: { file: path.basename(tarFile) + ".gz", ...gzInfo },
      installed: itotal + fetchedBytes, snapshot: idx.date, packages: lock, baseDeps,
    }, null, 2));
    console.log(`\n✓ ${tarFile}  ${mb(tarInfo.bytes)} → .gz ${mb(gzInfo.bytes)}  ${lock.length} 个包  用时 ${((Date.now() - t0) / 1000) | 0}s`);
    process.exit(0);
  }
  if (BLOCK) {
    // 一块的锁文件 + 逐文件清单另存一份，modules 合并时拿来查跨块冲突、出 modules.json
    fs.writeFileSync(path.join(OUT, `MANIFEST-${BLOCK.id}`), manText);
    fs.writeFileSync(path.join(OUT, `module-${BLOCK.id}.lock.json`), JSON.stringify({
      id: BLOCK.id, kind: BLOCK.kind, deps: BLOCK.deps, users: BLOCK.users,
      target, compat: 1, prefix: R.to + "files/usr", repos: REPOS, snapshot: idx.date, dir: LX.slice(4),
      tar: { file: path.basename(tarFile), ...tarInfo },
      gz: { file: path.basename(tarFile) + ".gz", ...gzInfo },
      files: manifest.size, installed: [...manifest.values()].reduce((s, [, n]) => s + n, 0),
      commands: [...bins].sort(), firstRun: firstRun.map((f) => f.pkg),
      alternatives: [...alts.values()].map((a) => ({ group: a.group, pkg: a.pkg, prio: a.prio })),
      packages: lock,
    }, null, 2));
    fs.writeFileSync(path.join(OUT, `SBOM-${BLOCK.id}.tsv`),
      "package\tversion\tsource\thomepage\trecipe\tsha256\n" +
      lock.map((l) => [l.name, l.version, l.source, l.homepage, l.recipe, l.sha256].join("\t")).join("\n") + "\n");
    console.log(`\n✓ ${BLOCK.id}：${tarFile}  ${mb(tarInfo.bytes)} → .gz ${mb(gzInfo.bytes)}  ${bins.size} 个命令  用时 ${((Date.now() - t0) / 1000) | 0}s`);
    process.exit(0);
  }
  fs.writeFileSync(path.join(OUT, "devkit.lock.json"), JSON.stringify({
    // compat：工具包与 App 外壳的接口版本。改了外壳依赖的布局（路径、first-run 约定…）就加一，旧 App 会拒装新工具包
    target, compat: 1, prefix: R.to + "files/usr", repos: REPOS, snapshot: idx.date,
    tar: { file: path.basename(tarFile), ...tarInfo },
    gz: { file: path.basename(tarFile) + ".gz", ...gzInfo },
    packages: lock,
  }, null, 2));
  fs.writeFileSync(path.join(OUT, "SBOM.tsv"),
    "package\tversion\tsource\thomepage\trecipe\tsha256\n" +
    lock.map((l) => [l.name, l.version, l.source, l.homepage, l.recipe, l.sha256].join("\t")).join("\n") + "\n");
  console.log(`\n✓ ${tarFile}  ${mb(tarInfo.bytes)} → .gz ${mb(gzInfo.bytes)}  用时 ${((Date.now() - t0) / 1000) | 0}s`);
  console.log(`  前缀改写：${patchedFiles} 个文件、${patchedHits} 处（等长，${TERMUX} → ${R.to}）`);
}
