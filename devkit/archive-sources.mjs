#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
//  archive-sources.mjs —— GPL / LGPL 等强/弱著佐权组件的对应源码（CCS）自归档工具
//
//  背景（GPL-2.0 §3 / GPL-3.0 §6 / LGPL-2.1 §4 & §6）：
//    二进制分发方不能把「提供精确对应源码」的义务单纯委托给上游滚动镜像（Termux / GNU / Debian
//    随时会下架旧版包）。本脚本根据 devkit.lock.json（或组件 component-*.json）与 APK 内置
//    LGPL 预编译库清单，归档并核验全部对应源码包与构建配方快照，产出可上传至 GitHub Release
//    （如 `sources-archive`）或 `dl.cccodroid.net/sources/` 的 `SOURCES.lock.json` 与源码归档目录。
//
//  用法：
//    node devkit/archive-sources.mjs [--lock devkit.lock.json] [--out out/sources] [--all] [--dry-run]
//      默认只归档含 GPL / LGPL / AGPL / MPL / EPL / CDDL 等要求伴随/承诺源码的包 + APK 内置 LGPL 库；
//      传 --all 则归档锁文件内全部开源包；传 --dry-run 只解析清单与分类，不发起网络下载。
// ─────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

/** APK 随包内置的 LGPL 原生组件（固定精确版本与上游源码校验值） */
export const APK_BUNDLED_LGPL_SOURCES = [
  {
    id: "glibc-ldso",
    name: "glibc",
    version: "2.44",
    license: "LGPL-2.1-or-later",
    shippedAs: "lib/arm64-v8a/libldlinux.so",
    srcUrl: "https://ftp.gnu.org/gnu/glibc/glibc-2.44.tar.xz",
    recipeRepo: "https://github.com/termux-pacman/glibc-packages",
    localBuildNote: "devkit/devkit.mjs (ldso prefix rewrite) & third_party/glibc/README.md",
  },
  {
    id: "7zip-alone2",
    name: "7zip",
    version: "26.06",
    license: "LGPL-2.1-or-later AND BSD-3-Clause AND unRAR",
    shippedAs: "lib/arm64-v8a/libcc7zz.so",
    srcUrl: "https://github.com/ip7z/7zip/releases/download/26.06/7z2606-src.tar.xz",
    sha256: "a4e374c8f864f51df48c2cfd0e1413ec3b2ea030deae852d6a655402ebb61ac4",
    localBuildScript: "scripts/build-7zz.sh",
  },
];

/** 判断许可证表达式是否包含需要保留/提供对应源码（CCS）的 Copyleft 条款；许可证未知（"-" / 空）时按保守策略归入需归档 */
export function requiresCorrespondingSource(license) {
  const s = String(license || "").trim();
  if (!s || s === "-") return true;
  return /\b(?:A?GPL|LGPL|GFDL|MPL|EPL|CDDL|CPL|OSL|EUPL)\b/i.test(s);
}

/** 从 Termux build.sh 文本提取 TERMUX_PKG_SRCURL 与 TERMUX_PKG_SHA256（处理常见的 ${TERMUX_PKG_VERSION} 变量展开） */
export function parseTermuxRecipeSources(buildShText, pkgVersion = "") {
  const cleanVer = String(pkgVersion || "").split(":")[1] || String(pkgVersion || "");
  const baseVer = cleanVer.split("-")[0];
  const vars = new Map([
    ["TERMUX_PKG_VERSION", baseVer],
    [" _VERSION", baseVer],
  ]);
  for (const m of String(buildShText || "").matchAll(/^([A-Z0-9_]+)=["']?([^"'\n$(\s]+)["']?\s*$/gm)) {
    if (!vars.has(m[1])) vars.set(m[1], m[2]);
  }
  const expand = (raw) => String(raw || "").replace(/\$\{?([A-Za-z0-9_]+)\}?/g, (_, k) => vars.get(k) ?? "");
  const grab = (key) => {
    const m = String(buildShText || "").match(new RegExp(`^${key}=\\(([^)]+)\\)|^${key}=["']?([^"'\\n]+)["']?`, "m"));
    if (!m) return [];
    const raw = (m[1] || m[2] || "").trim();
    return raw.split(/\s+/).map((x) => expand(x.replace(/^["']|["']$/g, ""))).filter(Boolean);
  };
  const urls = grab("TERMUX_PKG_SRCURL").filter((u) => /^https?:\/\//.test(u));
  const shas = grab("TERMUX_PKG_SHA256").filter((h) => /^[0-9a-f]{64}$/i.test(h));
  return urls.map((url, i) => ({ url, sha256: shas[i] ? shas[i].toLowerCase() : "" }));
}

export function buildSourcePlan(lockObj, { includeAll = false } = {}) {
  const pkgs = Array.isArray(lockObj?.packages) ? lockObj.packages : [];
  const selected = pkgs.filter((p) => includeAll || requiresCorrespondingSource(p.license));
  return {
    release: lockObj?.release || lockObj?.snapshot || "local",
    generatedAt: new Date().toISOString(),
    policy: includeAll ? "all-packages" : "copyleft-and-unknown",
    apkBundled: APK_BUNDLED_LGPL_SOURCES,
    devkitPackages: selected.map((p) => ({
      name: p.name,
      source: p.source || p.name,
      repo: p.repo || "main",
      version: p.version,
      license: p.license || "unknown",
      binaryDebSha256: p.sha256 || "",
      recipeUrl: p.recipe || (p.repo === "glibc"
        ? `https://github.com/termux-pacman/glibc-packages/tree/main/gpkg/${p.source || p.name}`
        : `https://github.com/termux/termux-packages/tree/master/packages/${p.source || p.name}`),
    })),
  };
}

function sha256File(file) {
  const h = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(1 << 20);
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
}

function curlDownload(url, dest, expectedSha = "") {
  if (fs.existsSync(dest) && (!expectedSha || sha256File(dest) === expectedSha)) {
    return sha256File(dest);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = dest + ".part";
  execFileSync("curl", ["-fsSL", "--retry", "3", "--connect-timeout", "15", "--max-time", "600", "-o", part, url], { stdio: "inherit" });
  const got = sha256File(part);
  if (expectedSha && got !== expectedSha.toLowerCase()) {
    fs.rmSync(part, { force: true });
    throw new Error(`${url}: sha256 mismatch (expected ${expectedSha}, got ${got})`);
  }
  fs.renameSync(part, dest);
  return got;
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf("--" + k); return i >= 0 ? args[i + 1] : d; };
  const dryRun = args.includes("--dry-run");
  const includeAll = args.includes("--all");
  const lockPath = opt("lock", path.join(HERE, "out", "devkit.lock.json"));
  const outDir = path.resolve(opt("out", path.join(HERE, "out", "sources")));

  let lockObj = { release: "apk-only", packages: [] };
  if (fs.existsSync(lockPath)) {
    lockObj = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } else if (args.includes("--lock")) {
    throw new Error(`找不到锁文件: ${lockPath}`);
  }

  const plan = buildSourcePlan(lockObj, { includeAll });
  fs.mkdirSync(outDir, { recursive: true });

  if (!dryRun) {
    for (const item of plan.apkBundled) {
      const fileName = decodeURIComponent(new URL(item.srcUrl).pathname.split("/").pop());
      const dest = path.join(outDir, "apk-prebuilt", fileName);
      console.log(`▸ 归档 APK 随包 LGPL 源码: ${item.name} ${item.version} ← ${item.srcUrl}`);
      item.archivedFile = `apk-prebuilt/${fileName}`;
      item.sha256 = curlDownload(item.srcUrl, dest, item.sha256 || "");
    }
    if (fs.existsSync(path.join(ROOT, "scripts", "build-7zz.sh"))) {
      fs.mkdirSync(path.join(outDir, "apk-prebuilt"), { recursive: true });
      fs.copyFileSync(path.join(ROOT, "scripts", "build-7zz.sh"), path.join(outDir, "apk-prebuilt", "build-7zz.sh"));
    }
  }

  const manifestFile = path.join(outDir, "SOURCES.lock.json");
  fs.writeFileSync(manifestFile, JSON.stringify(plan, null, 2) + "\n");
  console.log(`✓ 已生成对应源码归档清单 ${manifestFile}（APK 内置 LGPL ${plan.apkBundled.length} 项，devkit 待归档包 ${plan.devkitPackages.length} 项${dryRun ? "，dry-run 未联网下载" : ""}）`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error("✗ " + (e?.message || e));
    process.exit(1);
  });
}
