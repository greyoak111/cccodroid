#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
//  appjs.mjs —— 前端 app.js 的分段工具。源码在 gateway/web/app/ 下按文件名顺序拼成一个文件（网关下发时拼，见 gw/http.mjs appJs）
//
//  用法:  node scripts/appjs.mjs                 语法检查拼好的 app.js，并列出各段行数
//         node scripts/appjs.mjs --line 4321     报错里的 app.js:4321 是哪个分段的第几行
//         node scripts/appjs.mjs --out <文件>     拼好写出来（给别的工具用）
//  新增一段：文件名取两个序号之间（如 08b-xxx.js）放在该在的位置；段与段之间别切开函数或语句，
//  从顶层的分节注释（"  // ── …"）处切。
// ─────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DIR = path.join(ROOT, "gateway/web/app");
const parts = fs.readdirSync(DIR).filter((f) => f.endsWith(".js")).sort();
const texts = parts.map((f) => fs.readFileSync(path.join(DIR, f), "utf8"));
const all = texts.join("");
const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };

const lineArg = opt("--line");
if (lineArg) {
  let n = +lineArg;
  for (let i = 0; i < parts.length; i++) {
    const c = texts[i].split("\n").length - (texts[i].endsWith("\n") ? 1 : 0);
    if (n <= c) { console.log(`gateway/web/app/${parts[i]}:${n}`); process.exit(0); }
    n -= c;
  }
  console.error("超出范围"); process.exit(1);
}
const out = opt("--out");
if (out) { fs.writeFileSync(out, all); process.exit(0); }

// 各段共用一个作用域：顶层同名函数后一个会静默盖掉前一个（0.5.4 前权限卡 diffHtml、loadScript 都栽在这）
const seen = new Map(), dups = [];
parts.forEach((p, i) => texts[i].split("\n").forEach((l, j) => {
  const m = /^  (?:async )?function\s+([A-Za-z0-9_$]+)\s*\(/.exec(l); if (!m) return;
  if (seen.has(m[1])) dups.push(`${m[1]}: ${seen.get(m[1])} 与 ${p}:${j + 1}`); else seen.set(m[1], `${p}:${j + 1}`);
}));
if (dups.length) { console.error("✗ 顶层函数重名（后一个会盖掉前一个）：\n  " + dups.join("\n  ")); process.exit(1); }
const r = spawnSync(process.execPath, ["--check", "-"], { input: all, encoding: "utf8" });
let at = 1;
for (let i = 0; i < parts.length; i++) {
  const c = texts[i].split("\n").length - (texts[i].endsWith("\n") ? 1 : 0);
  console.log(`  ${String(at).padStart(5)}–${String(at + c - 1).padEnd(5)} ${parts[i]}`);
  at += c;
}
if (r.status) { console.error(r.stderr.replace(/\[stdin\]:(\d+)/g, (m, n) => m + "（" + n + "）")); console.error("✗ 语法错误（行号用 --line 对回分段）"); process.exit(1); }
console.log(`✓ ${parts.length} 段，${at - 1} 行，语法通过`);

// pr-guard 自测（这个 PR 会关掉）
