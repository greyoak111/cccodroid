#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
//  abi-check.mjs —— devkit base 与 Termux 滚动仓库的 ABI 漂移检查（#206）
//
//  输入：
//    · 最新（或指定）的 devkit.lock.json（缺省按 devkit-pin.json 从 Release 下载并核 sha256）
//    · 当前 Termux main / glibc 仓库索引（经 pgp.mjs 验签；--index 可给离线 JSON 测试用）
//
//  判定：
//    1. 按 devkit/abi-policy.json 区分共享库提供者（soProviders）、语言运行时 ABI（runtimeAbi）
//       与纯 CLI 包（cliOnly）：npm 11→12 判为 CLI-MAJOR，不算 ABI-MAJOR；
//       libicu 78.3→79.1、python 3.14→3.15、nodejs 26→27 等判为 ABI-MAJOR。
//    2. 若 lock 带 abi.sonames 且未传 --no-soname，可下载发生主/次版本漂移的 soProvider .deb
//       实测 ELF DT_SONAME：SONAME 未变时降级为 ABI-COMPAT，SONAME 变化时升级为 ABI-MAJOR。
//
//  用法：
//    node devkit/abi-check.mjs [--lock <devkit.lock.json>] [--pin <devkit-pin.json>]
//                              [--index <offline-index.json>] [--no-soname]
//                              [--json <out.json>] [--markdown <out.md>]
//                              [--fail-on-abi-major]
// ─────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DEFAULT_POLICY = JSON.parse(fs.readFileSync(path.join(HERE, "abi-policy.json"), "utf8"));
const DEFAULT_MAN = JSON.parse(fs.readFileSync(path.join(HERE, "devkit.json"), "utf8"));

const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

/**
 * 解析 Debian/Termux 版本串：[epoch:]upstream[-revision]
 * 例："1:78.3-1" → { epoch: 1, upstream: "78.3", rev: "1", nums: [78, 3] }
 */
export function parseVer(raw) {
  const s = String(raw || "").trim();
  const epIdx = s.indexOf(":");
  const epoch = epIdx >= 0 ? Number(s.slice(0, epIdx)) || 0 : 0;
  const rest = epIdx >= 0 ? s.slice(epIdx + 1) : s;
  const dashIdx = rest.lastIndexOf("-");
  const upstream = dashIdx > 0 ? rest.slice(0, dashIdx) : rest;
  const rev = dashIdx > 0 ? rest.slice(dashIdx + 1) : "";
  const nums = (upstream.match(/\d+/g) || []).map((x) => Number(x));
  return { raw: s, epoch, upstream, rev, nums };
}

/** 比较两个版本串的变化尺度：same | patch | minor | major */
export function versionDelta(fromRaw, toRaw) {
  if (fromRaw === toRaw) return "same";
  const a = parseVer(fromRaw), b = parseVer(toRaw);
  if (a.upstream === b.upstream) return "patch"; // 仅 debian revision 变
  const a0 = a.nums[0] ?? 0, b0 = b.nums[0] ?? 0;
  if (a0 !== b0) return "major";
  const a1 = a.nums[1] ?? 0, b1 = b.nums[1] ?? 0;
  if (a1 !== b1) return "minor";
  return "patch";
}

/**
 * 从 ELF64 小端二进制读取 DT_SONAME（tag = 14）；非 ELF 或无 SONAME 返回 null。
 * 与 devkit.mjs 的 elfNeeded 保持同一套解析方式，不依赖外部 readelf/objdump。
 */
export function elfSoname(b) {
  if (!Buffer.isBuffer(b) || b.length < 64 || b.readUInt32BE(0) !== 0x7f454c46 || b[4] !== 2 || b[5] !== 1) return null;
  const phoff = Number(b.readBigUInt64LE(32)), phsz = b.readUInt16LE(54), phn = b.readUInt16LE(56);
  if (!phsz || phoff + phsz * phn > b.length) return null;
  const loads = [];
  let dyn = null;
  for (let i = 0; i < phn; i++) {
    const o = phoff + i * phsz;
    const type = b.readUInt32LE(o);
    const off = Number(b.readBigUInt64LE(o + 8));
    const va = Number(b.readBigUInt64LE(o + 16));
    const fsz = Number(b.readBigUInt64LE(o + 32));
    if (type === 1) loads.push({ off, va, fsz });
    if (type === 2) dyn = { off, fsz };
  }
  if (!dyn || dyn.off + dyn.fsz > b.length) return null;
  const v2o = (va) => {
    const l = loads.find((x) => va >= x.va && va < x.va + x.fsz);
    return l ? va - l.va + l.off : -1;
  };
  let strtab = -1, sonameOff = -1;
  for (let o = dyn.off; o + 16 <= dyn.off + dyn.fsz; o += 16) {
    const tag = Number(b.readBigInt64LE(o));
    const val = Number(b.readBigUInt64LE(o + 8));
    if (tag === 0) break;
    if (tag === 5) strtab = v2o(val);      // DT_STRTAB
    if (tag === 14) sonameOff = val;       // DT_SONAME
  }
  if (strtab < 0 || sonameOff < 0 || strtab + sonameOff >= b.length) return null;
  const end = b.indexOf(0, strtab + sonameOff);
  if (end < 0) return null;
  return b.toString("utf8", strtab + sonameOff, end) || null;
}

/** 对比旧/新 SONAME 列表：任一旧 SONAME 消失即视为破坏性变化（老组件或新组件都会找不到库） */
export function compareSonames(oldList, newList) {
  const oldSet = new Set(oldList || []);
  const newSet = new Set(newList || []);
  const removed = [...oldSet].filter((s) => !newSet.has(s)).sort();
  const added = [...newSet].filter((s) => !oldSet.has(s)).sort();
  return { changed: removed.length > 0 || added.length > 0, breaking: removed.length > 0, removed, added };
}

/**
 * 对单个包的版本漂移做分级：
 * 返回 { level, role, reason, sonameDiff? }
 * level 取值：ABI-MAJOR | CLI-MAJOR | MINOR | PATCH | REMOVED | SAME
 */
export function classifyDrift(name, baseVersion, repoVersion, policy = DEFAULT_POLICY, sonameCheck = null) {
  if (!repoVersion) {
    const role = policy.soProviders?.[name] ? "so-provider" : policy.runtimeAbi?.[name] ? "runtime-abi" : "other";
    return { level: "REMOVED", role, reason: "仓库索引里已找不到该包" };
  }
  if (baseVersion === repoVersion) return { level: "SAME", role: "other", reason: "" };

  const delta = versionDelta(baseVersion, repoVersion);
  const soRule = policy.soProviders?.[name];
  const rtRule = policy.runtimeAbi?.[name];
  const cliSet = new Set(policy.cliOnly || []);

  // 1. 若有实测 SONAME 对比，优先生效（对 soProvider 消除误报与漏报）
  if (soRule && sonameCheck && Array.isArray(sonameCheck.oldSonames) && Array.isArray(sonameCheck.newSonames)) {
    const diff = compareSonames(sonameCheck.oldSonames, sonameCheck.newSonames);
    if (diff.breaking) {
      return {
        level: "ABI-MAJOR",
        role: "so-provider",
        reason: `SONAME 变化：移除 ${diff.removed.join(", ")}${diff.added.length ? `；新增 ${diff.added.join(", ")}` : ""}`,
        sonameDiff: diff,
      };
    }
    if (!diff.changed && delta === "major") {
      return {
        level: "MINOR",
        role: "so-provider",
        reason: "主版本变化但实测 SONAME 未变（ABI 兼容）",
        sonameDiff: diff,
      };
    }
  }

  // 2. 运行时 ABI（如 python 次版本、nodejs 主版本）
  if (rtRule) {
    const hit = rtRule.scheme === "minor" ? (delta === "major" || delta === "minor") : delta === "major";
    if (hit) return { level: "ABI-MAJOR", role: "runtime-abi", reason: rtRule.note || `运行时 ABI ${delta} 升级` };
    return { level: delta === "minor" ? "MINOR" : "PATCH", role: "runtime-abi", reason: rtRule.note || "" };
  }

  // 3. 共享库提供者（策略兜底：未做或无法做 SONAME 实测时）
  if (soRule) {
    const hit = soRule.scheme === "minor" ? (delta === "major" || delta === "minor") : delta === "major";
    if (hit) return { level: "ABI-MAJOR", role: "so-provider", reason: soRule.note || `共享库 ${delta} 升级` };
    return { level: delta === "minor" ? "MINOR" : "PATCH", role: "so-provider", reason: soRule.note || "" };
  }

  // 4. 明确标注的纯 CLI 包：主版本升不是 ABI-MAJOR
  if (cliSet.has(name)) {
    if (delta === "major") return { level: "CLI-MAJOR", role: "cli", reason: "CLI 主版本变化（非共享库 ABI）" };
    return { level: delta === "minor" ? "MINOR" : "PATCH", role: "cli", reason: "" };
  }

  // 5. 未显式列出的 lib* 包：主版本变化按保守策略标 ABI-MAJOR，避免漏掉新引入的共享库
  if (/^lib[a-z0-9]/.test(name) && delta === "major") {
    return { level: "ABI-MAJOR", role: "so-provider", reason: "共享库包主版本变化（未在白名单中，保守判为 ABI-MAJOR）" };
  }

  if (delta === "major") return { level: "CLI-MAJOR", role: "other", reason: "非共享库包主版本变化" };
  return { level: delta === "minor" ? "MINOR" : "PATCH", role: "other", reason: "" };
}

/** 对整份 devkit.lock.json 和仓库索引映射做漂移分析（纯函数，便于单测和市场复用） */
export function analyzeDrift(lock, repoPkgs, { policy = DEFAULT_POLICY, sonameChecks = new Map() } = {}) {
  const pkgMap = repoPkgs instanceof Map ? repoPkgs : new Map(Object.entries(repoPkgs));
  const drifted = [];
  let checked = 0;
  for (const p of lock.packages || []) {
    // 跳过非 Termux 仓库包（如 PyPI fetch 的 wheel）
    if (p.source === "pypi" || p.source === "upstream" || p.source === "npm") continue;
    checked++;
    const cur = pkgMap.get(p.name);
    const repoVer = typeof cur === "string" ? cur : cur?.version || null;
    if (repoVer === p.version) continue;
    const sc = sonameChecks.get(p.name) || null;
    const c = classifyDrift(p.name, p.version, repoVer, policy, sc);
    if (c.level === "SAME") continue;
    drifted.push({
      name: p.name,
      repo: p.repo || "main",
      baseVersion: p.version,
      repoVersion: repoVer || "—",
      level: c.level,
      role: c.role,
      reason: c.reason,
      ...(c.sonameDiff ? { sonameDiff: c.sonameDiff } : {}),
    });
  }
  const rank = { "ABI-MAJOR": 0, REMOVED: 1, "CLI-MAJOR": 2, MINOR: 3, PATCH: 4 };
  drifted.sort((a, b) => (rank[a.level] ?? 9) - (rank[b.level] ?? 9) || a.name.localeCompare(b.name));
  const counts = {
    totalBase: checked,
    drifted: drifted.length,
    abiMajor: drifted.filter((x) => x.level === "ABI-MAJOR").length,
    removed: drifted.filter((x) => x.level === "REMOVED").length,
    cliMajor: drifted.filter((x) => x.level === "CLI-MAJOR").length,
    minor: drifted.filter((x) => x.level === "MINOR").length,
    patch: drifted.filter((x) => x.level === "PATCH").length,
  };
  return {
    generated: new Date().toISOString(),
    release: lock.release || "",
    snapshot: lock.snapshot || "",
    counts,
    abiMajor: drifted.filter((x) => x.level === "ABI-MAJOR"),
    drifted,
  };
}

export function formatMarkdown(report) {
  const { counts, abiMajor, drifted, release, snapshot } = report;
  const lines = [
    `## devkit Base ABI 漂移报告`,
    "",
    `- 基准底座：\`${release || "未标记"}\`（快照：${snapshot || "未知"}）`,
    `- 核对时间：${report.generated}`,
    `- 统计：共 ${counts.totalBase} 个 Termux 包，**${counts.drifted} 个已漂移**（\`ABI-MAJOR\` **${counts.abiMajor}** · \`REMOVED\` ${counts.removed} · \`CLI-MAJOR\` ${counts.cliMajor} · \`MINOR\` ${counts.minor} · \`PATCH\` ${counts.patch}）`,
    "",
  ];
  if (abiMajor.length) {
    lines.push(
      `### ⚠️ 检测到 ${abiMajor.length} 项 ABI-MAJOR 漂移（建议重打 base）`,
      "",
      "| 包名 | base 版本 | 仓库版本 | 级别 | 说明 |",
      "|---|---|---|---|---|",
      ...abiMajor.map((x) => `| \`${x.name}\` | \`${x.baseVersion}\` | \`${x.repoVersion}\` | **${x.level}** | ${x.reason} |`),
      ""
    );
  } else {
    lines.push("### ✅ 未检测到共享库 / 运行时 ABI-MAJOR 漂移（无需重打 base）", "");
  }
  if (drifted.length) {
    lines.push(
      "<details>",
      `<summary>全部漂移包（${drifted.length} 个）</summary>`,
      "",
      "| 包名 | base 版本 | 仓库版本 | 级别 | 类别 | 说明 |",
      "|---|---|---|---|---|---|",
      ...drifted.map((x) => `| \`${x.name}\` | \`${x.baseVersion}\` | \`${x.repoVersion}\` | ${x.level} | ${x.role} | ${x.reason || "—"} |`),
      "",
      "</details>",
      ""
    );
  }
  return lines.join("\n");
}

// ── 在线索引与 .deb SONAME 实测（仅 CLI 执行时按需调用） ──────────────────

async function fetchBuf(url) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(120000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      if (i >= 4) throw new Error(`${url}: ${e.message}`);
      await new Promise((res) => setTimeout(res, 2000 * (i + 1)));
    }
  }
}

async function loadTermuxIndex(repos) {
  const { TERMUX_KEYS, verifyDetached } = await import("./pgp.mjs");
  const pkgs = new Map();
  for (const repo of repos) {
    const { dist, component, arch } = repo;
    let gz = null, lastErr = null;
    for (const base of [repo.base, ...(repo.mirrors || [])]) {
      try {
        const relBuf = await fetchBuf(`${base}dists/${dist}/Release`);
        const sigBuf = await fetchBuf(`${base}dists/${dist}/Release.gpg`);
        verifyDetached(relBuf, sigBuf.toString("utf8"), TERMUX_KEYS);
        const rel = relBuf.toString("utf8");
        const rp = `${component}/binary-${arch}/Packages.gz`;
        const want = rel.split("SHA256:")[1]?.split("\n").find((l) => l.trim().endsWith(" " + rp));
        if (!want) throw new Error("Release 里没有 " + rp);
        const data = await fetchBuf(`${base}dists/${dist}/${rp}`);
        if (sha256(data) !== want.trim().split(/\s+/)[0]) throw new Error("Packages.gz 哈希不符");
        gz = data;
        break;
      } catch (e) { lastErr = e; }
    }
    if (!gz) throw new Error(`${repo.name || "repo"} 索引拉取/验签失败：${lastErr?.message}`);
    for (const blk of zlib.gunzipSync(gz).toString("utf8").split("\n\n")) {
      const f = {};
      for (const l of blk.split("\n")) {
        const m = l.match(/^([\w-]+): (.*)$/);
        if (m) f[m[1]] = m[2];
      }
      if (!f.Package || pkgs.has(f.Package)) continue;
      pkgs.set(f.Package, { name: f.Package, version: f.Version, file: f.Filename, sha256: f.SHA256, repo });
    }
  }
  return pkgs;
}

function arDataMember(buf) {
  if (buf.subarray(0, 8).toString() !== "!<arch>\n") throw new Error("不是 ar 归档");
  for (let off = 8; off + 60 <= buf.length;) {
    const name = buf.subarray(off, off + 16).toString().trim().replace(/\/$/, "");
    const size = parseInt(buf.subarray(off + 48, off + 58).toString().trim(), 10);
    if (name.startsWith("data.tar")) return { name, data: buf.subarray(off + 60, off + 60 + size) };
    off += 60 + size + (size % 2);
  }
  throw new Error("deb 缺少 data.tar*");
}

function* iterTar(buf) {
  const str = (b) => { const i = b.indexOf(0); return b.subarray(0, i < 0 ? b.length : i).toString(); };
  const oct = (b) => parseInt(str(b).trim() || "0", 8);
  let longName = null, pax = {};
  for (let off = 0; off + 512 <= buf.length;) {
    const h = buf.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    const size = oct(h.subarray(124, 136));
    const type = String.fromCharCode(h[156] || 48);
    const body = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "L") { longName = str(body); continue; }
    if (type === "x") {
      pax = {};
      for (let i = 0; i < body.length;) {
        const sp = body.indexOf(0x20, i), len = parseInt(body.toString("latin1", i, sp), 10);
        if (sp < 0 || !(len > sp - i + 1) || i + len > body.length) break;
        const kv = body.toString("utf8", sp + 1, i + len - 1), eq = kv.indexOf("=");
        pax[kv.slice(0, eq)] = kv.slice(eq + 1); i += len;
      }
      continue;
    }
    if (type === "g" || type === "K") continue;
    const prefix = str(h.subarray(345, 500));
    const name = pax.path || longName || (prefix ? prefix + "/" : "") + str(h.subarray(0, 100));
    yield { name, type, data: body };
    longName = null; pax = {};
  }
}

async function extractSonamesFromDeb(pkgRec) {
  const urls = [pkgRec.repo.base, ...(pkgRec.repo.mirrors || [])].map((b) => b + pkgRec.file);
  let deb = null;
  for (const u of urls) {
    try {
      const b = await fetchBuf(u);
      if (sha256(b) === pkgRec.sha256) { deb = b; break; }
    } catch {}
  }
  if (!deb) return null;
  const mem = arDataMember(deb);
  let tar;
  if (mem.name.endsWith(".xz")) {
    try { tar = execFileSync("xz", ["-dc"], { input: mem.data, maxBuffer: 2 ** 30 }); }
    catch {
      const xzNs = await import("./vendor/xz-decompress/dist/package/xz-decompress.js");
      const xz = xzNs.default ?? xzNs;
      const rd = new xz.XzReadableStream(new Blob([mem.data]).stream()).getReader();
      const parts = [];
      for (;;) { const { done, value } = await rd.read(); if (done) break; parts.push(Buffer.from(value)); }
      tar = Buffer.concat(parts);
    }
  } else if (mem.name.endsWith(".gz")) {
    tar = zlib.gunzipSync(mem.data);
  } else {
    tar = mem.data;
  }
  const sonames = new Set();
  for (const e of iterTar(tar)) {
    if (e.type !== "0" && e.type !== "7") continue;
    const clean = e.name.replace(/^\.\//, "");
    if (!/(?:^|\/)(?:glibc\/)?lib\/[^/]+\.so(?:\.[\d.]+)?$/.test(clean)) continue;
    const sn = elfSoname(e.data);
    if (sn) sonames.add(sn);
  }
  return [...sonames].sort();
}

async function loadLock(lockArg, pinArg) {
  if (lockArg) return JSON.parse(fs.readFileSync(lockArg, "utf8"));
  const pinFile = pinArg || path.join(ROOT, "devkit-pin.json");
  const pin = JSON.parse(fs.readFileSync(pinFile, "utf8"));
  const url = pin.base + (pin.lock?.file || "devkit.lock.json");
  const buf = await fetchBuf(url);
  if (pin.lock?.sha256 && sha256(buf) !== pin.lock.sha256) {
    throw new Error(`下载的 devkit.lock.json 哈希与 ${pinFile} 不符`);
  }
  const lock = JSON.parse(buf.toString("utf8"));
  if (!lock.release && pin.tag) lock.release = pin.tag;
  return lock;
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = (k) => { const i = argv.indexOf("--" + k); return i >= 0 ? argv[i + 1] : undefined; };
  const flag = (k) => argv.includes("--" + k);

  const lock = await loadLock(opt("lock"), opt("pin"));
  const policy = opt("policy") ? JSON.parse(fs.readFileSync(opt("policy"), "utf8")) : DEFAULT_POLICY;
  const repoPkgs = opt("index")
    ? new Map(Object.entries(JSON.parse(fs.readFileSync(opt("index"), "utf8"))))
    : await loadTermuxIndex(lock.repos || DEFAULT_MAN.repos);

  // 若 lock 含 abi.sonames 且未禁用 --no-soname，对发生主/次版本漂移的 soProvider 下载 .deb 实测 DT_SONAME
  const sonameChecks = new Map();
  if (!flag("no-soname") && !opt("index") && lock.abi?.sonames) {
    for (const p of lock.packages || []) {
      const cur = repoPkgs.get(p.name);
      if (!cur || !policy.soProviders?.[p.name] || cur.version === p.version) continue;
      const d = versionDelta(p.version, cur.version);
      if (d === "patch") continue;
      const oldSonames = lock.abi.sonames[p.name];
      if (!Array.isArray(oldSonames)) continue;
      const newSonames = await extractSonamesFromDeb(cur);
      if (newSonames) sonameChecks.set(p.name, { oldSonames, newSonames });
    }
  }

  const report = analyzeDrift(lock, repoPkgs, { policy, sonameChecks });
  const md = formatMarkdown(report);
  if (opt("json")) fs.writeFileSync(opt("json"), JSON.stringify(report, null, 2) + "\n");
  if (opt("markdown")) fs.writeFileSync(opt("markdown"), md);
  process.stdout.write(md);

  if (flag("fail-on-abi-major") && report.counts.abiMajor > 0) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => { console.error("✗ abi-check 失败：" + e.message); process.exit(2); });
}
