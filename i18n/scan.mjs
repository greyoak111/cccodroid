#!/usr/bin/env node
// i18n 扫描：找出界面里还没接入翻译的中文，以及词典里还缺的键。
//
//   node i18n/scan.mjs                 汇总 + 逐条列出问题
//   node i18n/scan.mjs --missing-json  只输出「缺译键」的 JSON 骨架 {"中文": ""}，方便整批翻译后贴回 lang-en.js
//   node i18n/scan.mjs --lang ja       指定词典（默认 en，对应 gateway/web/lang-<lang>.js）
//   node i18n/scan.mjs --all           按 gateway/web/langs.js 注册表，逐个语言汇总缺译数（加新语言后用）
//
// 检查四类：
//   A. app.js 里含中文、但没被 t("…") 包住的字符串字面量（注释不算）。tk("…") 也算包住：它只登记键，用的地方再 t()
//   B. index.html 里含中文、但没打 data-i18n / data-i18n-html 标记的文本；含中文却没列进 data-i18n-attr 的属性
//   C. 用到了（t() 或 HTML 标记）但词典里没有的键
//   D. 词典里有、但哪儿都没用到的键（多半是原文改了，旧键成了孤儿）
// 静态扫描是近似的（尤其 data-i18n-html 的键：浏览器序列化 innerHTML 可能和源码略有出入），
// 最终以运行时为准：界面里切到 English，控制台执行 [...I18N.missing] 应为空数组。
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB = path.join(ROOT, "gateway", "web");
const args = process.argv.slice(2);
const LANG = args.includes("--lang") ? args[args.indexOf("--lang") + 1] : "en";
const JSON_ONLY = args.includes("--missing-json");
const HAN = /\p{Script=Han}/u;

// ── JS：最小词法扫描（注释 / 字符串 / 模板 / 正则） ─────────────────────
/** 摘掉已经译好的部分（t("…") 调用与 ${…} 插值），剩下的才是"裸中文" */
function stripTranslated(raw) {
  let s = raw;
  for (let i = 0; i < 6; i++) {
    const before = s;
    s = s.replace(/tk?\(\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*(?:,\s*\{[^{}]*\})?\s*\)/g, "");
    s = s.replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g, "");
    if (s === before) break;
  }
  return s;
}

/** JS 词法扫描：记录所有字符串/模板字面量。
 *  模板字面量里的 ${…} 会**递归进去**（那里的 t("…") 也要算数，否则漏译查不出来）。 */
function scanJs(src) {
  const lits = [];   // { text, raw, kind, line, wrapped, dynamic }
  const n = src.length;
  let i = 0, lastSig = "";
  const lineAt = (p) => { let l = 1; for (let k = 0; k < p && k < n; k++) if (src.charCodeAt(k) === 10) l++; return l; };
  const unesc = (s) => s.replace(/\\(.)/g, (m, ch) => ({ n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v" }[ch] ?? ch));
  const wrappedAt = (p) => /(?:^|[^\w$.])tk?\(\s*$/.test(src.slice(Math.max(0, p - 40), p));
  const push = (s, e, kind, text, dynamic) =>
    lits.push({ text, raw: src.slice(s, e), kind, line: lineAt(s), wrapped: wrappedAt(s), dynamic });
  const stack = [{ kind: "code", brace: 0 }];   // code 帧带花括号计数，用来找 ${…} 的结尾
  while (i < n) {
    const top = stack[stack.length - 1];
    if (top.kind === "tmpl") {
      const start = top.chunk;
      let j = i;
      while (j < n) {
        const ch = src[j];
        if (ch === "\\") { j += 2; continue; }
        if (ch === "`" || (ch === "$" && src[j + 1] === "{")) break;
        j++;
      }
      if (j >= n) { i = n; break; }
      if (j > start) push(start, j, "`", unesc(src.slice(start, j)), top.dynamic);
      if (src[j] === "`") { stack.pop(); i = j + 1; lastSig = "`"; continue; }
      top.dynamic = true;
      stack.push({ kind: "code", brace: 0 });
      i = j + 2; lastSig = ""; continue;
    }
    const c = src[i], d = src[i + 1];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "/" && d === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && d === "*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? n : e + 2; continue; }
    if (stack.length > 1 && c === "{") { top.brace++; i++; lastSig = c; continue; }
    if (stack.length > 1 && c === "}") {
      if (top.brace > 0) { top.brace--; i++; lastSig = c; continue; }
      stack.pop();                       // 回到模板字面量，接着扫下一个字面段
      stack[stack.length - 1].chunk = i + 1;
      i++; lastSig = c; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === c || src[j] === "\n") break;
        j++;
      }
      const raw = src.slice(i, j + 1);
      let text;
      try { text = JSON.parse(c === '"' ? raw : '"' + raw.slice(1, -1).replace(/"/g, '\\"').replace(/\\'/g, "'") + '"'); }
      catch { text = unesc(raw.slice(1, -1)); }
      push(i, j + 1, c, text, false);
      i = j + 1; lastSig = c; continue;
    }
    if (c === "`") { stack.push({ kind: "tmpl", chunk: i + 1, dynamic: false }); i++; lastSig = "`"; continue; }
    if (c === "/" && (lastSig === "" || /[(,=:[!&|?{};+\-*%<>~^]/.test(lastSig) || /\b(return|typeof|case|in|of)$/.test(src.slice(Math.max(0, i - 8), i).trimEnd()))) {
      // 正则字面量
      let j = i + 1, cls = false;
      while (j < n) {
        const ch = src[j];
        if (ch === "\\") { j += 2; continue; }
        if (ch === "[") cls = true; else if (ch === "]") cls = false;
        else if (ch === "/" && !cls) break;
        else if (ch === "\n") break;
        j++;
      }
      i = j + 1; while (i < n && /[a-z]/i.test(src[i])) i++;
      lastSig = "/"; continue;
    }
    lastSig = c; i++;
  }
  return lits;
}

// ── HTML：够用的标签流解析 ─────────────────────────────────────────────
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const decode = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const norm = (s) => s.trim().replace(/\s+/g, " ");
function attrsOf(tag) {
  const o = {};
  for (const m of tag.matchAll(/([\w:-]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|[^\s>]+))?/g)) o[m[1].toLowerCase()] = m[3] ?? m[4] ?? m[2] ?? "";
  return o;
}
function scanHtml(src) {
  src = src.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "))
           .replace(/<(script|style|svg)\b[\s\S]*?<\/\1>/gi, (m) => m.replace(/[^\n]/g, " "));
  const lineAt = (p) => src.slice(0, p).split("\n").length;
  const keys = [], issues = [];
  const stack = [];   // { name, mode: null|"text"|"html", start, line }
  const re = /<\/?([a-zA-Z][\w-]*)([^>]*)>|([^<]+)/g;
  let m;
  while ((m = re.exec(src))) {
    if (m[3] !== undefined) {
      if (HAN.test(m[3]) && !stack.some((s) => s.mode)) issues.push({ line: lineAt(m.index), text: norm(m[3]), why: "文本没打 data-i18n 标记" });
      continue;
    }
    const name = m[1].toLowerCase(), closing = m[0][1] === "/";
    if (closing) {
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].name !== name) continue;
        const s = stack[k];
        if (s.mode === "text") keys.push({ key: norm(decode(src.slice(s.start, m.index).replace(/<[^>]*>/g, ""))), line: s.line, from: "data-i18n" });
        if (s.mode === "html") keys.push({ key: norm(src.slice(s.start, m.index)), line: s.line, from: "data-i18n-html" });
        stack.length = k; break;
      }
      continue;
    }
    const a = attrsOf(m[2]);
    const inSkip = "data-i18n-skip" in a || stack.some((s) => s.mode === "skip");
    const attrList = "data-i18n-attr" in a ? a["data-i18n-attr"].split(",").map((x) => x.trim()) : [];
    for (const at of ["placeholder", "title", "aria-label", "alt"]) {
      if (!(at in a) || !HAN.test(a[at]) || inSkip) continue;
      if (attrList.includes(at)) keys.push({ key: decode(a[at]), line: lineAt(m.index), from: `[${at}]` });
      else issues.push({ line: lineAt(m.index), text: `${at}="${a[at]}"`, why: "属性没列进 data-i18n-attr" });
    }
    if (VOID.has(name) || m[0].endsWith("/>")) continue;
    const mode = "data-i18n-skip" in a ? "skip" : "data-i18n" in a ? "text" : "data-i18n-html" in a ? "html" : null;
    stack.push({ name, mode, start: m.index + m[0].length, line: lineAt(m.index) });
  }
  return { keys, issues };
}

// ── 词典 ─────────────────────────────────────────────────────────────
function loadLangs() {
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(WEB, "langs.js"), "utf8"), sandbox);
  return sandbox.window.I18N_LANGS || [];
}
function loadDict(lang) {
  const f = path.join(WEB, `lang-${lang}.js`);
  if (!fs.existsSync(f)) return null;
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(f, "utf8"), sandbox, { filename: f });
  return (sandbox.window.I18N_DICT || {})[lang] || {};
}

// ── 汇总 ─────────────────────────────────────────────────────────────
// app.js 的源码拆在 web/app/ 下；i18n.js / langs.js 的中文是中英并列的逃生写法，不翻
// lineage/map.js 也调用 t("…")：不扫它会把正在用的键误报成孤儿，新加的键也查不出缺译
const jsFiles = [...fs.readdirSync(path.join(WEB, "app")).filter((x) => x.endsWith(".js")).sort().map((x) => "app/" + x), "layout.js", "lineage/map.js"];
const used = new Map();   // key → 出处
const A = [];
for (const f of jsFiles) {
  for (const l of scanJs(fs.readFileSync(path.join(WEB, f), "utf8"))) {
    if (!HAN.test(l.text)) continue;
    // 模板里已经用 t("…") 译过的部分不算未接入：把 t("…")/t('…') 摘掉再找中文
    if (l.wrapped && /\$\{/.test(l.raw)) continue;
    if (!HAN.test(stripTranslated(l.raw))) continue;
    if (l.wrapped && !l.dynamic) { if (!used.has(l.text)) used.set(l.text, `${f}:${l.line}`); continue; }
    A.push({ where: `${f}:${l.line}`, text: l.raw.length > 90 ? l.raw.slice(0, 87) + "…" : l.raw,
             why: l.wrapped ? "t() 里不能用 ${} 模板，改成 t(\"…{name}…\", { name })" : "没包 t()" });
  }
}
// 网关提示语：server.mjs 与 gw/*.mjs 里 tz 包着的中文原句也是键（见 gw/config.mjs「提示语的多语言」）
for (const f of ["server.mjs", ...fs.readdirSync(path.join(WEB, "..", "gw")).filter((x) => x.endsWith(".mjs")).map((x) => "gw/" + x)]) {
  const srv = fs.readFileSync(path.join(WEB, "..", f), "utf8");
  for (const m of srv.matchAll(/(?:^|[^\w$.])tz\(\s*"((?:[^"\\]|\\.)*)"/g)) {
    const k = JSON.parse('"' + m[1] + '"');
    if (!used.has(k)) used.set(k, f);
  }
}
const html = scanHtml(fs.readFileSync(path.join(WEB, "index.html"), "utf8"));
for (const k of html.keys) if (!used.has(k.key)) used.set(k.key, `index.html:${k.line} ${k.from}`);

if (args.includes("--all")) {
  console.log(`已接入的键 ${used.size} 个；未接入：app.js ${A.length} 处，index.html ${html.issues.length} 处\n`);
  for (const l of loadLangs()) {
    if (l.code === "zh") { console.log(`  zh       ${l.name}（源语言）`); continue; }
    const d = loadDict(l.code);
    if (!d) { console.log(`  ${l.code.padEnd(8)} ${l.name}  ✗ 缺 lang-${l.code}.js`); continue; }
    const miss = [...used.keys()].filter((k) => !(k in d)).length;
    const orphan = Object.keys(d).filter((k) => !used.has(k)).length;
    console.log(`  ${l.code.padEnd(8)} ${l.name}  已译 ${used.size - miss}/${used.size}${orphan ? `，孤儿键 ${orphan}` : ""}`);
  }
  process.exit(0);
}
const dict = loadDict(LANG);
if (!dict) { console.error(`没有 gateway/web/lang-${LANG}.js`); process.exit(2); }
const C = [...used].filter(([k]) => !(k in dict));
const D = Object.keys(dict).filter((k) => !used.has(k));

if (JSON_ONLY) {
  const o = {}; for (const [k] of C) o[k] = "";
  process.stdout.write(JSON.stringify(o, null, 2) + "\n");
  process.exit(0);
}
const show = (title, rows, fmt) => {
  console.log(`\n## ${title}：${rows.length}`);
  for (const r of rows.slice(0, 400)) console.log("  " + fmt(r));
  if (rows.length > 400) console.log(`  …另有 ${rows.length - 400} 条`);
};
show("A. app.js / layout.js 未接入的中文字面量", A, (r) => `${r.where}  ${r.text}  ← ${r.why}`);
show("B. index.html 未接入的中文", html.issues, (r) => `index.html:${r.line}  ${r.text}  ← ${r.why}`);
show(`C. 缺译（lang-${LANG}.js 里没有）`, C, ([k, w]) => `${w}  ${JSON.stringify(k)}`);
show("D. 孤儿键（词典有、代码没用）", D, (k) => JSON.stringify(k));
console.log(`\n已接入的键 ${used.size} 个，已译 ${used.size - C.length} 个。`);
process.exitCode = A.length + html.issues.length + C.length ? 1 : 0;
