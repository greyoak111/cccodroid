// 发行版白名单回填：封口（edition.mjs）之后 claude 自己什么配置都不读，这里把用户要的那些检查过、经官方旗标交回去。
//
//   CLAUDE.md / CLAUDE.local.md / .claude/rules（用户级 + 工作目录往上各级，@ 引用展开）→ 拼成一个文件 --append-system-prompt-file
//   用户级与项目的 skill / 斜杠命令 / 子代理 / 输出风格 → 拷进私有目录合成插件「user」→ --plugin-dir（名字带 user: 前缀）
//   扩展页装的插件（user 范围、已启用）→ 拷一份、去掉钩子与设置 → --plugin-dir
//   MCP（.claude.json 全局与本项目的）→ --mcp-config；项目 .mcp.json 不回填
//   用户设置里的权限规则、几个无害键 → 并进网关那份 --settings
//   自动记忆：用 autoMemoryDirectory 钉住目录，起进程前把整个目录查一遍（claude 要往里写，没法拷副本）
//
// 进上下文的文字都过 breach.mjs，命中整轮不跑、列出文件与行，不给「保留」。
// 钩子一概不回填：钩子是任意命令，输出能直接进上下文，内容检查管不住（用户拍板 11-05：只认签名组件带的，目前组件都不带钩子）。
// 拷副本再查、claude 读副本：查完之后再改原件，这一轮也不受影响。副本在应用私有目录，按内容指纹复用，复用前核对指纹。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { CFG, log, tz } from "./config.mjs";
import { sealed } from "./edition.mjs";
import { scanText, describe } from "./breach.mjs";
import { readSmallFile } from "./saferead.mjs";
import { sameFile } from "./pathguard.mjs";

const MAX_TEXT = 256 << 10;            // 单个说明文件上限（超过的不回填，记一笔）
const MAX_CTX = 1 << 20;               // 拼出来的说明总长
const MAX_IMPORT_DEPTH = 4;
const MAX_TREE_FILES = 20000, MAX_TREE_BYTES = 64 << 20;   // 字节只算要拷的文字文件；别的硬链接过去
const TEXT_EXT = /\.(?:md|markdown|txt)$/i;
const isText = (rel) => TEXT_EXT.test(rel) || rel.endsWith(".json");
const ROOT = () => path.join(CFG.home, ".cache", "ccapp-seal");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const home = () => CFG.home;
const userClaude = () => path.join(home(), ".claude");

/** 普通文件、不太大才读；读不了 / 太大 / 软链返回 null。
 *  用 O_NOFOLLOW：仓库里的 CLAUDE.md / rules 可以是软链，不能让它指到凭据文件（审查 11-05） */
function readSmall(f, max = MAX_TEXT) { return readSmallFile(f, max); }
const realOr = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

/** cwd 往上到根的各级目录（根在前） */
function ancestors(cwd) {
  const out = [];
  let d = realOr(cwd);
  for (;;) { out.unshift(d); const up = path.dirname(d); if (up === d) break; d = up; }
  return out;
}

/** 目录底下的 .md（排好序），深度有限 */
function mdUnder(dir, depth = 3) {
  const out = [];
  const walk = (d, n) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (n < depth) walk(p, n + 1); }
      else if (/\.md$/i.test(e.name)) out.push(p);
    }
  };
  walk(dir, 0);
  return out;
}

// ── 说明文件（CLAUDE.md 一类） ──
const LABEL = {
  user: "user's private global instructions for all projects",
  project: "project instructions, checked into the codebase",
  local: "user's private project instructions, not checked in",
};
// @ 引用只展开说明文件，且不碰凭据/密钥路径：项目 CLAUDE.md 是不可信输入，
// 以前它可以写 @~/ccapp-providers.json 把 API Key 读进系统提示发给模型厂商（审查 11-05）
const IMPORT_EXT = /\.(?:md|markdown|txt)$/i;
const SECRET_PATH = /(?:^|\/)(?:\.credentials\.json|\.gateway-token|ccapp-(?:providers|config|seed)[\w.-]*\.json|id_(?:rsa|ed25519|ecdsa|dsa)|[^/]+\.(?:pem|key)|\.netrc|hosts\.ya?ml|\.npmrc|\.pypirc|\.env(?:\.[\w-]+)?)$/i;
const SECRET_DIR = /(?:^|\/)\.(?:ssh|gnupg|aws)(?:\/|$)|(?:^|\/)\.config\/gh(?:\/|$)/i;
/** @path 引用（代码块外）：相对引用它的文件，~/ 是 home。只收 .md/.txt，拒绝凭据/密钥路径 */
function imports(text, base) {
  const out = [];
  let fence = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    for (const m of line.matchAll(/(?:^|\s)@((?:~\/|\.{1,2}\/|\/)?[\w.\-\/]+\.(?:md|markdown|txt))/gi)) {
      const r = m[1];
      if (!IMPORT_EXT.test(r) || SECRET_PATH.test(r) || SECRET_DIR.test(r)) continue;
      const p = r.startsWith("~/") ? path.join(home(), r.slice(2)) : path.resolve(base, r);
      if (SECRET_PATH.test(p) || SECRET_DIR.test(p)) continue;
      out.push(p);
    }
  }
  return out;
}
/** 项目级说明 / skill 从哪几级目录读：只认「信得过的根」到工作目录这一段，不再一路往上到 /。
 *  共享存储谁都能写：/sdcard/CLAUDE.md、/sdcard/.claude/rules 能被别的应用放进去，而封口模式下不走项目信任，
 *  直接进了系统提示（0.6.9 审计 P1-14）。根：工作区（在工作区里）、登记过的项目目录（在项目里）；都不是就只认工作目录本身 */
function projectChain(cwd) {
  const all = ancestors(cwd);
  let i = all.findIndex((d) => sameFile(d, CFG.workspace));
  if (i < 0) i = all.findIndex((d) => registeredRoots().some((r) => sameFile(d, r)));   // 最外层那个登记目录
  return i >= 0 ? all.slice(i) : all.slice(-1);
}
/** 登记过的项目目录。直接读 ccapp-projects.json，不 import projects.mjs：
 *  终端里的 claude 经 guard/cc-seal.mjs 也走这里，那边不该拉起会话、终端那一整套模块 */
function registeredRoots() {
  try {
    const j = JSON.parse(readSmallFile(path.join(home(), "ccapp-projects.json"), 4 << 20) || "[]");
    return Array.isArray(j) ? j.filter((p) => p && typeof p.path === "string" && path.isAbsolute(p.path)).map((p) => p.path) : [];
  } catch { return []; }
}
function contextSources(cwd) {
  const list = [];
  const add = (file, kind) => list.push({ file, kind });
  add(path.join(userClaude(), "CLAUDE.md"), "user");
  for (const f of mdUnder(path.join(userClaude(), "rules"))) add(f, "user");
  for (const d of projectChain(cwd)) {
    add(path.join(d, "CLAUDE.md"), "project");
    add(path.join(d, ".claude", "CLAUDE.md"), "project");
    for (const f of mdUnder(path.join(d, ".claude", "rules"))) add(f, "project");
    add(path.join(d, "CLAUDE.local.md"), "local");
  }
  return list;
}
/** 读出全部说明文件（含引用），去重。返回 [{ file, kind, text, from? }] 与跳过的 */
function collectContext(cwd) {
  const seen = new Set(), out = [], skipped = [];
  // 项目级 / 本地级说明是仓库带来的、不可信：它的 @ 引用只许落在项目根以内。以前能 @~/.claude/projects/<别的项目>/memory/…
  // 把别的项目的自动记忆、home 下任意文本读进系统提示（0.6.9 审计 199 11-08）。Claude Code 原生对项目外的引用要先问，封口时没人问，就不收。
  // 用户级（自己的全局说明）照旧不限
  const root = realOr(projectChain(cwd)[0] || cwd);
  const within = (p) => { const r = realOr(p); return r === root || r.startsWith(root + path.sep); };
  const visit = (file, kind, depth, from) => {
    const rp = realOr(file);
    if (seen.has(rp)) return;
    if (from && kind !== "user" && !within(file)) { log(`[封口] 项目说明的 @ 引用在项目之外，不展开：${String(file).slice(0, 200)}`); return; }
    seen.add(rp);
    const text = readSmall(file);
    if (text == null) { if (fs.existsSync(file)) skipped.push(file); return; }
    out.push({ file, kind, text, from });
    if (depth < MAX_IMPORT_DEPTH) for (const imp of imports(text, path.dirname(file))) visit(imp, kind, depth + 1, file);
  };
  for (const s of contextSources(cwd)) visit(s.file, s.kind, 0, null);
  return { items: out, skipped };
}
function renderContext(items) {
  if (!items.length) return "";
  let s = "Codebase and user instructions are shown below. Be sure to adhere to these instructions. " +
    "IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.\n";
  // 路径里的换行/控制符会变成系统提示里的独立一行；文件名是仓库可以带的，不能让它绕过正文扫描（审查 11-05）
  const label = (p) => String(p).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").slice(0, 500);
  for (const it of items) {
    const head = `\nContents of ${label(it.file)} (${LABEL[it.kind]}${it.from ? `, imported from ${label(it.from)}` : ""}):\n\n`;
    if (s.length + head.length + it.text.length > MAX_CTX) { log(`[封口] 说明文件合计超过 ${MAX_CTX >> 10}KB，${it.file} 起没回填`); break; }
    s += head + it.text.trimEnd() + "\n";
  }
  return s;
}

// ── 合成插件「user」：skill / 命令 / 子代理 / 输出风格 ──
/** 拷进插件的文件清单：[{ src, rel }]（rel 相对插件根）。后面的同名项（离工作目录近的项目）盖前面的 */
function projectDirs(cwd) {
  return projectChain(cwd);      // 同说明文件：信得过的根到工作目录这一段（P1-14）
}
function userPluginFiles(cwd) {
  const roots = [userClaude(), ...projectDirs(cwd).map((d) => path.join(d, ".claude"))];
  const files = new Map();
  let n = 0, bytes = 0, over = false;
  let isUser = false, sub = "";
  const walk = (src, rel, depth) => {
    let ents; try { ents = fs.readdirSync(src, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (over) return;
      const s = path.join(src, e.name), r = rel + "/" + e.name;
      if (e.name === "node_modules" || e.name === ".git") continue;
      let st; try { st = fs.statSync(s); } catch { continue; }
      if (st.isDirectory()) { if (depth < 6) walk(s, r, depth + 1); continue; }
      if (!st.isFile()) continue;
      if (++n > MAX_TREE_FILES || (isText(r) && (bytes += st.size) > MAX_TREE_BYTES)) { over = true; log(`[封口] skill 等目录太大，没回填全`); return; }
      // 输出风格：用户目录里有的，项目里的同名文件不许盖（0.6.9 审计 199 11-05）。skill / 命令 / 子代理照旧离工作目录近的优先
      if (sub === "output-styles" && !isUser && files.get(r)?.user) continue;
      files.set(r, { src: s, size: st.size, mtime: st.mtimeMs, mode: st.mode & 0o777, ...(isUser ? { user: true } : {}) });
    }
  };
  const seenRoot = new Set();
  for (const root of roots) {
    const rr = realOr(root);
    if (seenRoot.has(rr)) continue;
    seenRoot.add(rr);
    isUser = root === userClaude();
    for (sub of ["skills", "commands", "agents", "output-styles"]) walk(path.join(root, sub), sub, 0);
  }
  return files;
}

/** 已启用的扩展页插件（user 范围）：[{ id, dir }] */
function enabledPlugins() {
  let set = {}, inst = {};
  try { set = JSON.parse(readSmallFile(path.join(userClaude(), "settings.json"), 4 << 20) || "{}").enabledPlugins || {}; } catch {}
  try { inst = JSON.parse(readSmallFile(path.join(userClaude(), "plugins", "installed_plugins.json"), 8 << 20) || "{}").plugins || {}; } catch {}
  const cache = realOr(path.join(userClaude(), "plugins", "cache"));
  const out = [];
  for (const [id, on] of Object.entries(set)) {
    if (on !== true) continue;
    const e = (Array.isArray(inst[id]) ? inst[id] : []).find((x) => x && x.scope === "user" && typeof x.installPath === "string");
    if (!e) continue;
    const dir = realOr(e.installPath);
    if (!dir.startsWith(cache + "/")) continue;   // 只认 cache 里的版本目录（本地目录市场官方会读源目录，我们不跟）
    out.push({ id, dir });
  }
  return out;
}
/** 插件目录里要拷的文件：钩子、设置、运行标记不要 */
function pluginFiles(dir) {
  const files = new Map();
  let n = 0, bytes = 0;
  const walk = (src, rel, depth) => {
    let ents; try { ents = fs.readdirSync(src, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const s = path.join(src, e.name), r = rel ? rel + "/" + e.name : e.name;
      if (!rel && ["hooks", "settings.json", ".in_use", ".orphaned_at", ".git", "node_modules"].includes(e.name)) continue;
      let st; try { st = fs.statSync(s); } catch { continue; }
      if (st.isDirectory()) { if (depth < 8) walk(s, r, depth + 1); continue; }
      if (!st.isFile()) continue;
      if (++n > MAX_TREE_FILES || (isText(r) && (bytes += st.size) > MAX_TREE_BYTES)) return;
      files.set(r, { src: s, size: st.size, mtime: st.mtimeMs, mode: st.mode & 0o777 });
    }
  };
  walk(dir, "", 0);
  return files;
}
/** 插件 data/*.json 是运行时数据（市场目录缓存一类），机器同步、可再生成，不进上下文：只拷不扫（误报复盘 11-06）。
 *  边界（二轮复核 11-06）：这些文件不会被自动加载进上下文，但插件里的技能可以写「去读 data/x.json」，
 *  诱导模型用 Read 工具主动把它读进来——一条不经过扫描的间接通道，性质和工作区里任意文件被读进上下文一样。 */
const isPluginData = (rel) => rel.startsWith("data/") && rel.endsWith(".json");
/** plugin.json 去掉能挂钩子、换设置的字段 */
function cleanManifest(buf) {
  let j; try { j = JSON.parse(buf.toString("utf8")); } catch { return null; }
  if (!j || typeof j !== "object") return null;
  for (const k of ["hooks", "settings"]) delete j[k];
  return Buffer.from(JSON.stringify(j, null, 2));
}

/** skill / 命令 / 子代理 .md 开头的 YAML 头里可以写 hooks:，claude 用到它时就执行里面的命令——
 *  不经任何确认，也不受封口设置里的钩子管（合成插件把它原样带进去了，0.6.9 审计 P1-18）。
 *  副本里把头里的 hooks 一节去掉，正文、name、description、allowed-tools 这些照留。
 *  头里去掉之后还像有 hooks（嵌在别的写法里、或用 YAML 合并键 << 引进来）：整个头不要，只留正文
 *  输出风格（style）另去掉 force-for-plugin：插件风格写了它就强行生效、盖过用户选的，项目带一份就能顶替（199 11-05）；
 *  原生的用户 / 项目风格本来就没有强制这一说 */
const FRONT_RE = /^(\uFEFF?---[ \t]*\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/;
const HOOKS_KEY = /^["']?hooks["']?[ \t]*:/i, STYLE_KEY = /^["']?(?:hooks|force-for-plugin)["']?[ \t]*:/i;
export function stripFrontHooks(buf, style = false) {
  const s = buf.toString("utf8"), m = FRONT_RE.exec(s), KEY = style ? STYLE_KEY : HOOKS_KEY;
  if (!m || !/hooks|<<|force-for-plugin/i.test(m[2])) return buf;
  const lines = m[2].split(/\r?\n/), keep = [];
  for (let i = 0; i < lines.length; i++) {
    if (!KEY.test(lines[i])) { keep.push(lines[i]); continue; }
    // 这一节：后面缩进的行、空行、注释行都属于它，直到下一个顶格的键；
    // 流式写法（[ / { 开头）没收口的，续行可以顶格写，数括号数到收口为止
    let depth = 0;
    const count = (l) => { for (const c of l.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, "")) depth += c === "[" || c === "{" ? 1 : c === "]" || c === "}" ? -1 : 0; };
    count(lines[i].replace(KEY, ""));
    while (i + 1 < lines.length && (depth > 0 || /^[ \t]/.test(lines[i + 1]) || /^\s*(#.*)?$/.test(lines[i + 1]))) count(lines[++i]);
  }
  let head = keep.join(m[2].includes("\r\n") ? "\r\n" : "\n");
  if (/(^|[\s{,\[])["']?hooks["']?[ \t]*:|<<[ \t]*:/im.test(head) || (style && /force-for-plugin/i.test(head))) head = null;
  const rest = s.slice(m[0].length);
  return Buffer.from(head == null ? rest : m[1] + head + m[3] + rest);
}
const isMd = (rel) => /\.md$/i.test(rel);

/**
 * 按清单拷成一个插件目录（私有、按指纹复用）。拷的时候查文字（.md 一类）；命中返回 { found }。
 * 复用前核对每个文字文件的哈希，副本被动过就重拷。
 */
/** 复用目录里每个文件都按「当前源文件」重算并核对，文字文件还要重新过破甲扫描：
 *  不能只信副本自带的 .ccapp-ok —— 它就在可写目录里，改它就能让新增的 skill/hook 蒙混过关（审查 11-05）。 */
function expectedBytes(rel, f, manifest) {
  try {
    if (rel === ".claude-plugin/plugin.json" && manifest) return Buffer.from(manifest);
    let buf = readSmallFile(f.src, 64 << 20, "");
    if (buf == null) return null;
    if (rel === ".claude-plugin/plugin.json") buf = cleanManifest(buf);
    else if (isMd(rel)) buf = stripFrontHooks(buf, rel.startsWith("output-styles/"));
    return buf;
  } catch { return null; }
}
function dirMatches(dir, files, manifest) {
  const want = new Map();
  for (const [rel, f] of files) {
    const b = expectedBytes(rel, f, manifest);
    if (!b) return false;
    if (isText(rel) && !isPluginData(rel)) {
      if (b.length > (2 << 20)) return false;                       // 大文本不扫描就不复用，走重建时会被 toolarge 拦下
      const r = scanText(b.toString("utf8"));
      if (r.blocked) return false;
    }
    want.set(rel, sha(b));
  }
  if (manifest) want.set(".claude-plugin/plugin.json", sha(Buffer.from(manifest)));
  const seen = new Set();
  const walk = (d, rel0) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return false; }
    for (const e of ents) {
      const r = rel0 ? rel0 + "/" + e.name : e.name;
      if (!rel0 && e.name === ".ccapp-ok") continue;
      if (e.isSymbolicLink()) return false;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!walk(p, r)) return false; continue; }
      if (!e.isFile()) return false;
      const h = want.get(r);
      if (!h) return false;
      try { const b = readSmallFile(p, 64 << 20, ""); if (b == null || sha(b) !== h) return false; } catch { return false; }
      seen.add(r);
    }
    return true;
  };
  return walk(dir, "") && seen.size === want.size;
}
const VERIFIED = new Map();   // 本进程里已经完整核对过的副本：目录 + 源/副本 stat 签名
const srcSig = (f) => { try { const s = fs.statSync(f); return `${s.size}:${s.mtimeMs}:${s.ctimeMs}:${s.ino}`; } catch { return "-"; } };
const copySig = (f) => { try { const s = fs.lstatSync(f); return s.isFile() ? `${s.size}:${s.mtimeMs}:${s.ctimeMs}:${s.ino}` : "bad"; } catch { return "-"; } };
function fileSig(dir, files, manifest) {
  const parts = [];
  for (const [rel, f] of files) parts.push(rel, srcSig(f.src), copySig(path.join(dir, rel)));
  if (manifest) parts.push(".claude-plugin/plugin.json", copySig(path.join(dir, ".claude-plugin/plugin.json")));
  // 副本里经过的每一层目录也记上目录项：只记清单文件就发现不了多出来的文件 / 子目录。
  // 用目录项名单而不是目录 mtime：时间戳是粗粒度的，刚建好就往里加东西，mtime 可能不变
  const dirs = new Set([""]);
  for (const rel of [...files.keys(), ...(manifest ? [".claude-plugin/plugin.json"] : [])])
    for (let d = path.dirname(rel); d !== "." && d !== ""; d = path.dirname(d)) dirs.add(d);
  for (const d of [...dirs].sort()) {
    let v = "-"; try { v = fs.readdirSync(path.join(dir, d)).sort().join("/"); } catch {}
    parts.push(d + "/", v);
  }
  return parts.join("\0");
}
function materialize(name, files, manifest) {
  const fp = sha(name + "\0" + JSON.stringify([...files].map(([r, f]) => [r, f.size, f.mtime]).sort()) + "\0" + (manifest || ""));
  const dir = path.join(ROOT(), "plug-" + name.replace(/[^\w.-]/g, "_") + "-" + fp.slice(0, 16));
  const okFile = path.join(dir, ".ccapp-ok");
  try {
    const okRaw = readSmallFile(okFile, 1 << 20);
    if (okRaw == null) throw new Error("no cache");
    const ok = JSON.parse(okRaw);
    if (ok.fp === fp) {
      const sig = fileSig(dir, files, manifest);
      if (VERIFIED.get(dir) === sig || dirMatches(dir, files, manifest)) {
        VERIFIED.set(dir, sig);
        touch(dir);
        return { dir };
      }
    }
  } catch {}
  const tmp = dir + ".tmp-" + process.pid;
  fs.rmSync(tmp, { recursive: true, force: true });
  const found = [], text = {};
  for (const [rel, f] of files) {
    const d = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(d), { recursive: true, mode: 0o700 });
    if (!isText(rel)) {
      // 脚本、图片这些不进上下文：硬链接过去省得拷（跨文件系统链不了再拷）
      try { fs.linkSync(f.src, d); } catch { try { fs.copyFileSync(f.src, d); fs.chmodSync(d, (f.mode | 0o600) & 0o700); } catch {} }
      continue;
    }
    let buf; try { buf = readSmallFile(f.src, 64 << 20, ""); } catch { buf = null; }
    if (buf == null) continue;
    // 扫描只看前 2MB，但副本写的是全文：超过扫描上限的文本直接拒绝，别只扫开头就放行（审查 11-05）
    if (buf.length > (2 << 20)) { found.push({ name: f.src, hits: [{ cat: "toolarge", strong: true, line: 0, excerpt: "" }] }); continue; }
    if (rel === ".claude-plugin/plugin.json") { buf = cleanManifest(buf); if (!buf) continue; }
    else if (isMd(rel)) buf = stripFrontHooks(buf, rel.startsWith("output-styles/"));
    if (!isPluginData(rel)) {
      const r = scanText(buf.toString("utf8"));
      if (r.blocked) found.push({ name: f.src, hits: r.hits });
    }
    text[rel] = sha(buf);
    fs.writeFileSync(d, buf, { mode: 0o600 });
  }
  if (found.length) { fs.rmSync(tmp, { recursive: true, force: true }); return { found }; }
  if (manifest) {
    fs.mkdirSync(path.join(tmp, ".claude-plugin"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(tmp, ".claude-plugin", "plugin.json"), manifest, { mode: 0o600 });
    text[".claude-plugin/plugin.json"] = sha(Buffer.from(manifest));
  }
  fs.writeFileSync(path.join(tmp, ".ccapp-ok"), JSON.stringify({ fp, text }), { mode: 0o600 });
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(tmp, dir);
  VERIFIED.set(dir, fileSig(dir, files, manifest));
  return { dir };
}

// ── MCP、设置 ──
function mcpConfig(cwd) {
  let j = {}; try { j = JSON.parse(readSmallFile(path.join(home(), ".claude.json"), 32 << 20) || "{}"); } catch {}
  const servers = { ...(j.mcpServers || {}) };
  const proj = (j.projects || {})[realOr(cwd)] || (j.projects || {})[cwd];
  Object.assign(servers, proj?.mcpServers || {});
  return Object.keys(servers).length ? { mcpServers: servers } : null;
}
// 用户设置里照搬的：权限规则 + 不会让东西跑起来、也不进上下文的几个键
const KEEP_KEYS = ["includeCoAuthoredBy", "includeGitInstructions", "cleanupPeriodDays", "alwaysThinkingEnabled", "respectGitignore", "attribution"];
function userSettings() {
  let j = {}; try { j = JSON.parse(readSmallFile(path.join(userClaude(), "settings.json"), 4 << 20) || "{}"); } catch {}
  const out = {};
  for (const k of KEEP_KEYS) if (j[k] !== undefined) out[k] = j[k];
  const p = j.permissions;
  if (p && typeof p === "object") {
    const perm = {};
    for (const k of ["allow", "deny", "ask"]) if (Array.isArray(p[k])) perm[k] = p[k].filter((x) => typeof x === "string").slice(0, 400);
    if (Object.keys(perm).length) out.permissions = perm;
  }
  // language 会被写进系统提示：只收界面语言注册表（web/langs.js）里的值，别的丢弃。
  // 以前只查字符集与长度，「ignore all previous rules」这类整句都能过（红队报告 VULN-02）
  const UI_LANGS = /^(?:zh|zh-Hant|en|fr|es|ru|ar|ja|ko|id)$/;
  if (typeof j.language === "string" && UI_LANGS.test(j.language)) out.language = j.language;
  return out;
}

// ── 自动记忆 ──
const sanitize = (p) => { const s = p.replace(/[^a-zA-Z0-9]/g, "-"); return s.length <= 200 ? s : s.slice(0, 200) + "-" + sha(p).slice(0, 8); };
export function memoryDir(cwd) { return path.join(userClaude(), "projects", sanitize(realOr(cwd)), "memory"); }
/** 记忆目录查一遍：命中返回 found；同时给出指纹（起进程紧前再比） */
export function scanMemory(dir) {
  const found = [], parts = [];
  for (const f of mdUnder(dir, 2)) {
    let st; try { st = fs.lstatSync(f); } catch { continue; }
    // 软链不读（readSmallFile 带 O_NOFOLLOW），照旧拦下，但别记成「太大」
    if (st.isSymbolicLink()) { found.push({ name: f, hits: [{ cat: "symlink", strong: true, line: 0, excerpt: "" }] }); continue; }
    if (!st.isFile()) continue;
    const t = st.size > MAX_TEXT * 4 ? null : readSmallFile(f, MAX_TEXT * 4);
    if (t == null) { found.push({ name: f, hits: [{ cat: "toolarge", strong: true, line: 0, excerpt: "" }] }); continue; }
    parts.push(f + "\0" + sha(t));
    const r = scanText(t);
    if (r.blocked) found.push({ name: f, hits: r.hits });
  }
  return { found, fp: sha(parts.join("\n")) };
}

/**
 * 起一轮前准备回填。返回 { args, settings, block, memDir, memFp, notes }
 *   block：{ found } —— 有说明文件 / skill / 记忆命中，整轮不跑
 *   args：要加给 claude 的旗标；settings：并进 --settings 的键（sealArgv 会把几份合成一份）
 */
// claude 2.1.311 自带的输出风格（名字不分大小写）
const BUILTIN_STYLES = new Set(["default", "concise", "explanatory", "learning", "proactive"]);
export function sealPrepare({ cwd, runId, outputStyle = "" }) {
  if (!sealed()) return { args: [], settings: null, block: null };
  const args = [], settings = userSettings(), notes = [];
  // 缓存根不能是软链：被换成指向 /sdcard 的链接后，别的应用也能改插件副本
  try { const st = fs.lstatSync(ROOT()); if (st.isSymbolicLink() || !st.isDirectory()) fs.rmSync(ROOT(), { recursive: true, force: true }); } catch {}
  fs.mkdirSync(ROOT(), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(ROOT(), 0o700); } catch {}
  prune();
  const found = [];

  // 说明文件
  const ctx = collectContext(cwd);
  for (const it of ctx.items) { const r = scanText(it.text); if (r.blocked) found.push({ name: it.file, hits: r.hits }); }
  // 说明文件是拼成一份系统提示交给模型的：逐份都过了，再按拼好的整份查一遍——
  // 弱特征分两类拆到 CLAUDE.md 和 rules 里，逐份看各只一类，合起来就够拦（0.6.9 审计 199 S-03）
  if (!found.length && ctx.items.length > 1) {
    const r = scanText(renderContext(ctx.items));
    if (r.blocked) found.push({ name: `说明文件合起来（${ctx.items.slice(0, 4).map((it) => it.file).join(", ")}${ctx.items.length > 4 ? " …" : ""}）`, hits: r.hits });
  }
  if (ctx.skipped.length) notes.push(`说明文件太大或读不了，没回填：${ctx.skipped.slice(0, 4).join(", ")}`);

  // skill / 命令 / 子代理 / 输出风格
  const uf = userPluginFiles(cwd);
  let userPlug = null;
  if (uf.size) {
    const m = materialize("user", uf, JSON.stringify({ name: "user", version: "1.0.0", description: "cccodroid: your skills, commands, agents and output styles (checked copy)" }));
    if (m.found) found.push(...m.found); else userPlug = m.dir;
  }
  // 扩展页装的插件
  const plugDirs = [];
  for (const p of enabledPlugins()) {
    const m = materialize(p.id, pluginFiles(p.dir));
    if (m.found) found.push(...m.found); else plugDirs.push(m.dir);
  }
  // 输出风格：用户目录里的那份在插件里叫 user:<名字>
  // 选的是内置风格：不换成插件里的同名文件——项目放一个 Explanatory.md 就能顶替内置风格（199 11-05）
  if (outputStyle && !BUILTIN_STYLES.has(String(outputStyle).toLowerCase()) && uf.has(`output-styles/${outputStyle}.md`)) settings.outputStyle = "user:" + outputStyle;

  // 自动记忆
  const memDir = memoryDir(cwd);
  const mem = scanMemory(memDir);
  found.push(...mem.found);
  settings.autoMemoryDirectory = memDir;

  if (found.length) return { args: [], settings: null, block: { found }, memDir, memFp: mem.fp, notes };

  const rid = String(runId).replace(/[^\w.-]/g, "_") + "-" + crypto.randomBytes(4).toString("hex");
  if (ctx.items.length) {
    const f = path.join(ROOT(), `ctx-${rid}.md`);
    fs.writeFileSync(f, renderContext(ctx.items), { mode: 0o600 });
    args.push("--append-system-prompt-file", f);
  }
  if (userPlug) args.push("--plugin-dir", userPlug);
  for (const d of plugDirs) args.push("--plugin-dir", d);
  const mcp = mcpConfig(cwd);
  if (mcp) {
    // MCP 配置也过破甲扫描：instructions / description / command 都在这份 JSON 里。
    // 项目 .mcp.json 是不回填，这里回填的必须同口径（红队报告 VULN-01：这是唯一没扫的通道）
    const r = scanText(JSON.stringify(mcp));
    if (r.blocked) found.push({ name: "~/.claude.json 的 mcpServers（已不加载）", hits: r.hits });
    else {
      const f = path.join(ROOT(), `mcp-${rid}.json`);
      fs.writeFileSync(f, JSON.stringify(mcp), { mode: 0o600 });
      args.push("--mcp-config", f);
    }
  }
  return { args, settings, block: null, memDir, memFp: mem.fp, notes };
}

/** 起进程紧前：记忆目录跟准备时一样就过；变了再查一遍，命中返回 found */
export function sealRecheck(prep) {
  if (!prep || !prep.memDir) return null;
  const mem = scanMemory(prep.memDir);
  if (mem.fp === prep.memFp) return null;
  return mem.found.length ? { found: mem.found } : null;
}

/** 清旧东西：一天前的单轮文件（终端起的 claude 没有「结束」可挂）、七天没用过的插件副本 */
let lastPrune = 0;
function prune() {
  const now = Date.now();
  if (now - lastPrune < 3600e3) return;
  lastPrune = now;
  let ents = []; try { ents = fs.readdirSync(ROOT()); } catch { return; }
  for (const n of ents) {
    const p = path.join(ROOT(), n);
    let st; try { st = fs.statSync(p); } catch { continue; }
    const age = now - st.mtimeMs;
    if (/^(?:ctx|mcp)-/.test(n) && age > 864e5) fs.rmSync(p, { force: true });
    else if (/^plug-/.test(n) && age > 7 * 864e5) fs.rmSync(p, { recursive: true, force: true });
  }
}
/** 复用的插件副本：摸一下，别被当成七天没用 */
function touch(dir) { try { const t = new Date(); fs.utimesSync(dir, t, t); } catch {} }

/** 一轮结束：删掉这一轮的临时文件 */
export function sealCleanup(runId) {
  const id = String(runId).replace(/[^\w.-]/g, "_");
  // 文件名带随机后缀（防同 uid 预先占名/换成软链），按前缀清这一轮的
  try { for (const n of fs.readdirSync(ROOT())) if (n === `ctx-${id}.md` || n === `mcp-${id}.json` || n.startsWith(`ctx-${id}-`) || n.startsWith(`mcp-${id}-`)) fs.rmSync(path.join(ROOT(), n), { force: true }); } catch {}
}

/** 给用户看的拒跑说明 */
export function sealBlockMessage(block) {
  return tz("这些 Claude Code 配置里有越权指令的特征（要模型无视规则、冒充系统消息这一类），cccodroid 不加载它们，这一轮没有运行。改掉或删掉下面的内容后再发：\n{list}", { list: describe(block.found, 8) });
}
