// 用户级配置留痕：~/.claude 下那些「每次对话都会交给模型、或者打开就会运行」的配置，变了就要人点头。
//
// 为什么不靠 guard：guard 看的是命令文本，拆字符串、拼变量就绕过去；模型之外的写入者（终端、后台进程、别的程序）它也看不见。
// 这里改成看文件状态：每轮起 claude 前核一遍，和上次确认时的指纹不一样就出卡片问「保留 / 撤销」；
// 每轮结束再核一遍，记下哪些是那一轮运行期间改的。撤销按确认时留的副本还原，多出来的挪进隔离目录（不删）。
// 只在前后各比一次看不见「改了又改回」（趁 claude 读配置那几秒塞进去、读完再换回），所以另外常驻监视这些目录（inotify），
// 和确认过的不一样就记一笔，改回去了也照样问。起进程紧前再核一次，确认之后又被改了就不起。
// 管的是「悄悄改」和「被注入驱动着改」：用户自己改的点一下「保留」就过，以后不再问。
// 同 uid 的程序能连指纹记录和副本一起改，这一层防不住（和会话封签同一个前提）。
//
// 应用自己写的（扩展页装钩子 / 插件 / MCP、组件带的 skill、常用指令…）：写之前 ucAppBegin 拍一份，写完 ucAppWrote 只认这次真改了、
// 而且改之前是干净（已确认）的那几项 —— 不能顺手把之前埋在那儿、还没确认的东西一起认下。
// 定时任务等没人看着的：有没确认的改动就不跑，并通知（run.mjs）。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { CFG, log } from "./config.mjs";
import { SAFE_KEYS } from "./projtrust.mjs";

// 单个文件；JSON 的几个只看会让东西跑起来的那部分（claude 自己常写的统计、提示次数之类不算）
const FILES = [".claude/CLAUDE.md", ".claude/settings.json", ".claude/settings.local.json", ".claude.json",
  ".claude/plugins/installed_plugins.json", ".claude/plugins/known_marketplaces.json"];
// 整个目录：规则、输出风格、skill、子代理、斜杠命令、钩子脚本、插件本体（打开就运行，2.1.311 实测在 plugins/cache/<市场>/<插件>/<版本>）
const TREES = [".claude/rules", ".claude/output-styles", ".claude/skills", ".claude/agents", ".claude/commands", ".claude/hooks",
  ".claude/plugins/cache", ".claude/plugins/marketplaces", ".claude/plugins/repos"];
const MAX_FILES = 3000, MAX_DEPTH = 8;
const BIG = 4 << 20;            // 超过的不读内容，指纹按大小 + 修改时间 + ctime
const COPY_MAX = 256 << 10, COPY_TOTAL = 16 << 20;
const STORE = () => path.join(CFG.home, ".ccapp-userconf");
const RECORD = () => path.join(CFG.home, "ccapp-userconf.json");
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const keyName = (rel) => sha(rel).slice(0, 24);

const canon = (v) => Array.isArray(v) ? "[" + v.map(canon).join(",") + "]"
  : v && typeof v === "object" ? "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}"
  : JSON.stringify(v ?? null);

/** JSON 里要管的那一块：设置文件去掉不让东西跑起来的键；.claude.json 只看 MCP 服务器（全局和各项目的） */
function riskyPart(rel, j) {
  if (!j || typeof j !== "object" || Array.isArray(j)) return null;
  if (rel === ".claude.json") {
    const out = {};
    if (j.mcpServers && Object.keys(j.mcpServers).length) out.mcpServers = j.mcpServers;
    const pr = {};
    for (const [k, v] of Object.entries(j.projects || {})) if (v && v.mcpServers && Object.keys(v.mcpServers).length) pr[k] = v.mcpServers;
    if (Object.keys(pr).length) out.projects = pr;
    return out;
  }
  if (rel.endsWith("/settings.json") || rel.endsWith("/settings.local.json")) {
    const out = {};
    for (const [k, v] of Object.entries(j)) if (!SAFE_KEYS.has(k)) out[k] = v;
    return out;
  }
  return null;
}
const isJsonPart = (rel) => rel === ".claude.json" || /\/settings(\.local)?\.json$/.test(rel);

/** 一个文件的指纹：{ h, text?（能存副本的内容）, big? } */
function fingerprint(rel, abs) {
  let st; try { st = fs.statSync(abs); } catch { return null; }
  if (!st.isFile()) return null;
  let link = ""; try { if (fs.lstatSync(abs).isSymbolicLink()) link = "link:" + fs.readlinkSync(abs) + "\0"; } catch {}
  if (st.size > (rel === ".claude.json" ? 32 << 20 : BIG)) return { h: sha(link + `big:${st.size}:${st.mtimeMs}:${st.ctimeMs}`), big: true, size: st.size };
  // 按字节读：副本要存原样（技能目录里的图片这类不是 UTF-8，按文本存会被换成 U+FFFD，#151-1）。
  // 指纹 h 的算法不变（合法 UTF-8 的文件按文本、按字节算出来一样），不然升级后已认下的全都会被报成改过
  let bytes; try { bytes = fs.readFileSync(abs); } catch { return null; }
  const raw = bytes.toString("utf8");
  if (isJsonPart(rel)) {
    let j; try { j = JSON.parse(raw); } catch { j = undefined; }
    if (j !== undefined) {
      const part = riskyPart(rel, j) || {};
      if (!Object.keys(part).length) return { h: sha(link + "json:{}"), text: "{}", part, size: st.size };
      const c = canon(part);
      return { h: sha(link + "json:" + c), text: c, part, size: st.size };
    }
  }
  return { h: sha(link + raw), text: raw, bytes: bytes.length <= COPY_MAX ? bytes : undefined, mode: st.mode & 0o7777, size: st.size };   // 超过副本上限的本来也不存副本
}

/** 一个目录往下的文件指纹，放进 out。cnt：{ n } 共用的计数（防目录太大） */
function walkTree(out, dir, rel, depth, cnt) {
  if (depth > MAX_DEPTH || cnt.n > MAX_FILES) return;
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (++cnt.n > MAX_FILES) { out.set(rel + "/…", { h: "overflow", big: true }); return; }
    const a = path.join(dir, e.name), r = rel + "/" + e.name;
    if (e.isDirectory()) { if (e.name !== "node_modules" && e.name !== ".git") walkTree(out, a, r, depth + 1, cnt); }
    else { const f = fingerprint(r, a); if (f) out.set(r, f); }
  }
}

/** 现在盘上的状态：rel → 指纹 */
export function ucScan() {
  const home = CFG.home, out = new Map();
  for (const rel of FILES) { const f = fingerprint(rel, path.join(home, rel)); if (f && !(isJsonPart(rel) && f.text === "{}")) out.set(rel, f); }
  const cnt = { n: 0 };
  for (const t of TREES) walkTree(out, path.join(home, t), t, 0, cnt);
  return out;
}

// ── 确认记录与副本 ──
let REC = null;           // { files: { rel: h }, modes: { rel: 权限位 } }，没有记录文件时 null
function loadRec() {
  if (REC) return REC;
  try { const j = JSON.parse(fs.readFileSync(RECORD(), "utf8")); if (j && j.files && typeof j.files === "object") REC = { files: Object.assign(Object.create(null), j.files), modes: Object.assign(Object.create(null), j.modes && typeof j.modes === "object" ? j.modes : {}) }; } catch {}
  return REC;
}
function saveRec() {
  try {
    const tmp = RECORD() + ".tmp-" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, at: Date.now(), files: REC.files, modes: REC.modes }), { mode: 0o600 });
    fs.renameSync(tmp, RECORD());
  } catch (e) { log(`[用户配置] 记不下确认记录：${e.message}`); }
}
function putCopy(rel, f) {
  const p = path.join(STORE(), keyName(rel));
  const data = f.bytes || f.text;
  if (f.big || data == null || Buffer.byteLength(data) > COPY_MAX) { try { fs.rmSync(p, { force: true }); } catch {} return; }
  try { fs.mkdirSync(STORE(), { recursive: true, mode: 0o700 }); fs.writeFileSync(p + ".tmp", data, { mode: 0o600 }); fs.renameSync(p + ".tmp", p); } catch {}
}
function getCopy(rel) {
  try { return fs.readFileSync(path.join(STORE(), keyName(rel)), "utf8"); } catch { return null; }
}
function getCopyBytes(rel) {
  try { return fs.readFileSync(path.join(STORE(), keyName(rel))); } catch { return null; }
}
/** 副本总量超了：从最大的开始不留（还原时那几个就只能报「没法还原」） */
function trimCopies() {
  let ents; try { ents = fs.readdirSync(STORE()).filter((n) => /^[0-9a-f]{24}$/.test(n)).map((n) => { const p = path.join(STORE(), n); return { p, s: fs.statSync(p).size }; }); } catch { return; }
  let tot = ents.reduce((a, e) => a + e.s, 0);
  for (const e of ents.sort((a, b) => b.s - a.s)) { if (tot <= COPY_TOTAL) break; try { fs.rmSync(e.p); tot -= e.s; } catch {} }
}

/** 认下：filter 不给就是全部 */
function accept(cur, filter) {
  if (!REC) REC = { files: Object.create(null), modes: Object.create(null) };
  const keys = new Set([...Object.keys(REC.files), ...cur.keys(), ...SEEN.keys()]);
  for (const rel of keys) {
    if (filter && !filter(rel)) continue;
    const f = cur.get(rel);
    if (f) { REC.files[rel] = f.h; if (f.mode != null) REC.modes[rel] = f.mode; else delete REC.modes[rel]; putCopy(rel, f); }
    else { delete REC.files[rel]; delete REC.modes[rel]; try { fs.rmSync(path.join(STORE(), keyName(rel)), { force: true }); } catch {} }
    ATTR.delete(rel); SEEN.delete(rel);
  }
  trimCopies();
  saveRec();
}

// ── 常驻监视：改了又改回也要看见 ──
// 盯 home（.claude.json）、~/.claude、~/.claude/plugins 这三层（不递归，按名字筛）和 TREES 里存在的目录（递归）。
// 有动静 30 毫秒后读一遍，和确认记录不一样的记进 SEEN（只留第一次看见的样子：后面多半是在改回去）。
const WATCH = new Map();      // 绝对路径 → { w, ino }
const SEEN = new Map();       // rel → { f, sid, at }
const PEND = new Set();
let pendT = null;
const ACTIVE = new Map();     // 正在跑的轮次 runId → sessionId（记是哪一轮期间改的）
const FILE_SET = new Set(FILES), TREE_SET = new Set(TREES);
const PARENTS = ["", ".claude", ".claude/plugins"];

function onParent(prel, name) {
  // 没有名字（监视出错后的重扫，或者平台没给文件名）：这一层底下要盯的全部过一遍（DeepSeek 复核 11-04 建议）
  if (!name) { for (const x of [...FILES, ...TREES]) if (!prel || x.startsWith(prel + "/")) mark(x); return; }
  const rel = prel ? prel + "/" + name : name;
  if (FILE_SET.has(rel)) mark(rel);
  if (TREE_SET.has(rel)) { ensureWatch(); mark(rel); }
  // 上一层目录这才出现：底下的可能在挂上监视之前就写好了，全部过一遍
  if (PARENTS.includes(rel)) { ensureWatch(); for (const x of [...FILES, ...TREES]) if (x.startsWith(rel + "/")) mark(x); }
}
function mark(rel) {
  PEND.add(rel);
  if (!pendT) { pendT = setTimeout(flushSeen, 30); pendT.unref?.(); }
}
function watchOne(abs, recursive, cb) {
  let ino = null; try { const st = fs.statSync(abs); if (!st.isDirectory()) return; ino = st.ino; } catch { return; }
  const old = WATCH.get(abs);
  if (old && old.ino === ino) return;
  if (old) { try { old.w.close(); } catch {} WATCH.delete(abs); }
  try {
    const w = fs.watch(abs, { recursive, persistent: false }, (_ev, name) => cb(name == null ? "" : String(name)));
    // 出错（目录被换掉等）：这段时间可能漏了动静，整个重扫一遍；过一会儿重新挂上（下次核对时也会补挂）
    w.on("error", () => {
      try { w.close(); } catch {}
      if (WATCH.get(abs)?.w === w) WATCH.delete(abs);
      cb("");
      const t = setTimeout(() => { try { ensureWatch(); } catch {} }, 1000); t.unref?.();
    });
    WATCH.set(abs, { w, ino });
  } catch (e) { log(`[用户配置] 盯不了 ${abs}：${e.message}`); }
}
function ensureWatch() {
  const home = CFG.home;
  for (const p of PARENTS) watchOne(p ? path.join(home, p) : home, false, (n) => onParent(p, n));
  for (const t of TREES) watchOne(path.join(home, t), true, (n) => mark(n ? t + "/" + n : t));
}
/** 把攒着的动静读一遍（异步定时到了，或者要判断之前同步调一次） */
function flushSeen() {
  if (pendT) { clearTimeout(pendT); pendT = null; }
  const rels = [...PEND]; PEND.clear();
  if (!rels.length || !loadRec()) return;
  const home = CFG.home, cur = new Map(), under = [];
  for (const rel of rels) {
    const abs = path.join(home, rel);
    let st = null; try { st = fs.statSync(abs); } catch {}
    if (st && st.isDirectory()) walkTree(cur, abs, rel, rel.split("/").length - 2, { n: 0 });
    else if (st) { const f = fingerprint(rel, abs); if (f && !(isJsonPart(rel) && f.text === "{}")) cur.set(rel, f); }
    under.push(rel);
  }
  // 删掉的：记录里在这些路径底下、现在没了的
  const cand = new Set(cur.keys());
  for (const k of Object.keys(REC.files)) if (under.some((u) => k === u || k.startsWith(u + "/"))) cand.add(k);
  const sid = [...ACTIVE.values()].pop() ?? null;
  for (const rel of cand) {
    if (SEEN.has(rel)) continue;
    const f = cur.get(rel);
    if ((REC.files[rel] || undefined) === f?.h) continue;
    SEEN.set(rel, { f: f || null, sid: ACTIVE.size ? sid || true : null, at: Date.now() });
    log(`⚠️ [用户配置] 看见改动：${rel}${ACTIVE.size ? "（有一轮正在运行）" : ""}`);
  }
}

/** 应用要动用户级配置之前：拍一份（给 ucAppWrote 比对） */
export function ucAppBegin() {
  if (!loadRec()) return null;
  try { return { at: Date.now(), m: ucScan() }; } catch { return null; }
}
/** 应用刚写过这些地方（相对 home 的路径或目录前缀）：只认这次真改了、改之前是干净的那几项。
 *  keys：{ rel: [键…] } —— 设置类 JSON 只许这几个键变（装插件只动 enabledPlugins，存钩子只动 hooks），别的键变了留给卡片 */
export function ucAppWrote(prefixes, before, keys) {
  const list = (Array.isArray(prefixes) ? prefixes : [prefixes]).filter(Boolean).map((p) => path.isAbsolute(p) ? path.relative(CFG.home, p) : p).filter((p) => p && !p.startsWith(".."));
  if (!list.length || !loadRec()) return;
  if (!before || !before.m) { log("[用户配置] 应用写入没带写之前的快照，不认（留给卡片）"); return; }
  const inside = (rel) => list.some((p) => rel === p || rel.startsWith(p.endsWith("/") ? p : p + "/"));
  try {
    flushSeen();
    const cur = ucScan(), refused = [];
    accept(cur, (rel) => {
      if (!inside(rel)) return false;
      const b = before.m.get(rel), a = cur.get(rel), s = SEEN.get(rel);
      // 写之前就看见过它被改：不是这次写的
      if (s && s.at < before.at) { refused.push(rel); return false; }
      // 这次没动它：只把写的过程中冒出来又没了的临时文件之类的记号清掉。
      // 原本就在、被改了又改回的不清：那是别人改了又改回的证据，留给卡片
      if (b?.h === a?.h) return !!s && !b && !a && REC.files[rel] === undefined;
      if ((REC.files[rel] || undefined) !== b?.h) { refused.push(rel); return false; }   // 写之前就有没确认的改动
      const ks = keys && keys[rel];
      if (ks) {
        if ((b && !b.part) || (a && !a.part)) { refused.push(rel); return false; }
        const strip = (part) => { const o = { ...(part || {}) }; for (const k of ks) delete o[k]; return canon(o); };
        if (strip(b?.part) !== strip(a?.part)) { refused.push(rel); return false; }
      }
      return true;
    });
    if (refused.length) log(`⚠️ [用户配置] 应用写入时这几项有别的改动，没认（下一轮问）：${refused.slice(0, 8).join(", ")}`);
  } catch (e) { log(`[用户配置] 应用写入后认下失败：${e.message}`); }
}

// 第一次检查（升级上来、还没有记录）：这些直接进每次对话、或者会自己运行的（插件本体带钩子、MCP），先给用户看一眼；其余的（skill、命令…）直接认下
const STRONG = (rel) => rel === ".claude/CLAUDE.md" || rel.startsWith(".claude/rules/") || rel.startsWith(".claude/output-styles/") || rel.startsWith(".claude/plugins/") || isJsonPart(rel);

// ── 归因：哪一轮运行期间改的 ──
const SNAP = new Map();      // runId → Map(rel → h)
const ATTR = new Map();      // rel → { sid, at }
const AGAIN = new Map();     // rel → 撤销过几次又被改回来
/** 起进程紧前调：和确认记录对不上（卡片之后又被改了、或者看见过改了又改回）返回这些 rel，这一轮就别起了 */
export function ucBeforeRun(run) {
  try {
    ensureWatch(); flushSeen();
    const cur = ucScan(), drift = [];
    if (loadRec()) for (const rel of new Set([...Object.keys(REC.files), ...cur.keys(), ...SEEN.keys()])) {
      if (SEEN.has(rel) || (REC.files[rel] || undefined) !== cur.get(rel)?.h) drift.push(rel);
    }
    if (drift.length) { log(`⚠️ [用户配置] 确认之后又被改了：${drift.slice(0, 8).join(", ")}`); return drift; }
    const m = new Map(); for (const [k, f] of cur) m.set(k, f.h);
    SNAP.set(run.id, m); ACTIVE.set(run.id, run.sessionId || null);
  } catch {}
  return [];
}
export function ucAfterRun(run) {
  ACTIVE.delete(run.id);
  const before = SNAP.get(run.id); SNAP.delete(run.id);
  if (!before) return;
  let cur; try { flushSeen(); cur = ucScan(); } catch { return; }
  const touched = [];
  for (const rel of new Set([...before.keys(), ...cur.keys()])) {
    if (before.get(rel) === cur.get(rel)?.h) continue;
    ATTR.set(rel, { sid: run.sessionId || null, at: Date.now() });
    touched.push(rel);
  }
  if (touched.length) log(`⚠️ [用户配置] 这一轮运行期间有改动：${touched.slice(0, 8).join(", ")}${touched.length > 8 ? " …" : ""}`);
}

// ── 给卡片看的摘要 ──
const mask = (s) => String(s).replace(/((?:api[_-]?key|token|secret|passw(?:or)?d|authorization)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, "$1***");
function hookLines(part) {
  const out = [];
  for (const [ev, groups] of Object.entries(part?.hooks || {})) {
    for (const g of Array.isArray(groups) ? groups : []) for (const h of Array.isArray(g?.hooks) ? g.hooks : []) {
      out.push(`hooks.${ev}${g.matcher ? `(${g.matcher})` : ""}: ${String(h.command || h.url || h.type || "").slice(0, 200)}`);
    }
  }
  return out;
}
function preview(rel, f, oldText) {
  if (!f) return "";
  if (f.big) return `(${f.size || "?"} bytes)`;
  if (f.part) {
    let old = {}; try { old = oldText ? JSON.parse(oldText) : {}; } catch {}
    const lines = [];
    const keys = new Set([...Object.keys(f.part), ...Object.keys(old || {})]);
    for (const k of keys) {
      if (canon(f.part[k]) === canon(old?.[k])) continue;
      if (k === "hooks") { lines.push(...hookLines(f.part)); continue; }
      if (k === "mcpServers") { lines.push("mcpServers: " + Object.keys(f.part.mcpServers || {}).join(", ")); continue; }
      if (k === "projects") { lines.push("projects.*.mcpServers: " + Object.values(f.part.projects || {}).flatMap((s) => Object.keys(s)).slice(0, 10).join(", ")); continue; }
      lines.push(`${k}: ${JSON.stringify(f.part[k] ?? null).slice(0, 160)}`);
    }
    return mask(lines.slice(0, 16).join("\n"));
  }
  const ls = String(f.text || "").split("\n");
  return mask(ls.slice(0, 15).join("\n").slice(0, 900) + (ls.length > 15 ? `\n… (${ls.length})` : ""));
}

/** 起一轮前：有没有没确认的改动。没有返回 null */
export function ucPending() {
  ensureWatch();
  let cur; try { flushSeen(); cur = ucScan(); } catch (e) { log(`[用户配置] 核不了：${e.message}`); return null; }
  let first = false;
  if (!loadRec()) {
    // 第一次：不强的直接认；强的留着问一次
    first = true;
    REC = { files: Object.create(null), modes: Object.create(null) };
    accept(cur, (rel) => !STRONG(rel));
  }
  const changes = [];
  for (const rel of new Set([...Object.keys(REC.files), ...cur.keys(), ...SEEN.keys()])) {
    const was = REC.files[rel], f = cur.get(rel), s = SEEN.get(rel);
    const a = ATTR.get(rel), during = s?.sid || (a ? a.sid || true : null);
    if (was === f?.h) {
      // 现在和确认的一样，但中间被改过：看见的那个样子给用户看
      if (s) changes.push({ rel, kind: "transient", during, again: AGAIN.get(rel) || 0, preview: s.f ? preview(rel, s.f, was ? getCopy(rel) : null) : "" });
      continue;
    }
    const kind = !was ? "added" : !f ? "removed" : "changed";
    changes.push({ rel, kind, during, again: AGAIN.get(rel) || 0, preview: kind === "removed" ? "" : preview(rel, f, was ? getCopy(rel) : null) });
  }
  if (!changes.length) return null;
  changes.sort((a, b) => (STRONG(b.rel) - STRONG(a.rel)) || (a.rel < b.rel ? -1 : 1));
  // 卡片只展开前 30 项，剩下的也列出名字：撤销会动到全部，不能有没看见的
  const shown = changes.length > 30 ? [...changes.slice(0, 30), { rel: `… +${changes.length - 30}`, kind: "more", preview: (() => { const t = changes.slice(30).map((c) => "~/" + c.rel).join("\n"); return t.length > 4000 ? t.slice(0, 4000) + "\n…" : t; })() }] : changes;
  return { first, changes: shown, rels: changes.map((c) => c.rel) };
}

/** 用户点了「保留」 */
export function ucKeep(rels) {
  const set = new Set(rels || []);
  try { accept(ucScan(), (rel) => set.has(rel)); } catch (e) { log(`[用户配置] 认下失败：${e.message}`); }
  log(`[用户配置] 用户保留了改动：${[...set].slice(0, 8).join(", ")}`);
}

function writeAtomic(abs, data, mode = 0o600) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = abs + ".ccapp-" + crypto.randomBytes(4).toString("hex");
  fs.writeFileSync(tmp, data, { mode });
  if (mode !== 0o600) fs.chmodSync(tmp, mode);     // umask 会吃掉建文件时给的位，可执行脚本还原后得能照样执行（#151-1）
  fs.renameSync(tmp, abs);
}
/** 把现在的样子先拷一份进隔离目录（还原会覆盖掉的、看不懂的） */
function stash(qdir, rel, abs) {
  try { if (!fs.existsSync(abs)) return; const dst = path.join(qdir, rel); fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(abs, dst); } catch {}
}
/** JSON 文件只换回要管的那一块，claude 自己记的其余内容照留。现在的文件不是合法 JSON：先拷进隔离目录，只写回那一块 */
function restorePart(rel, abs, copyText, qdir) {
  let curJ = null; try { curJ = JSON.parse(fs.readFileSync(abs, "utf8")); } catch {}
  if (!curJ || typeof curJ !== "object" || Array.isArray(curJ)) { stash(qdir, rel, abs); curJ = {}; }
  const old = JSON.parse(copyText || "{}");
  if (rel === ".claude.json") {
    if (old.mcpServers) curJ.mcpServers = old.mcpServers; else delete curJ.mcpServers;
    for (const [k, v] of Object.entries(curJ.projects || {})) if (v && typeof v === "object") { if (old.projects?.[k]) v.mcpServers = old.projects[k]; else delete v.mcpServers; }
  } else {
    for (const k of Object.keys(curJ)) if (!SAFE_KEYS.has(k)) delete curJ[k];
    Object.assign(curJ, old);
  }
  writeAtomic(abs, JSON.stringify(curJ, null, 2) + "\n");
}
/** 挪进隔离目录（不删：万一是用户要的，还找得回来） */
function moveAway(qdir, rel, abs) {
  if (!fs.existsSync(abs)) return false;
  const dst = path.join(qdir, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try { fs.renameSync(abs, dst); } catch { fs.copyFileSync(abs, dst); fs.rmSync(abs, { force: true }); }
  return true;
}

/** 用户点了「撤销」：按确认时的副本还原，多出来的挪进隔离目录。
 *  还原不了的（没留副本、副本也被改了）：现在的样子挪进隔离目录，设置类 JSON 清掉要管的那一块 —— 不留在原地接着跑。返回这些 */
export function ucRevert(rels) {
  flushSeen();
  const cur = ucScan(), failed = [], moved = [], exact = new Map();
  const qdir = path.join(STORE(), "quarantine", new Date().toISOString().replace(/[:.]/g, "-"));
  for (const rel of rels || []) {
    const was = REC?.files[rel], abs = path.join(CFG.home, rel);
    if (!abs.startsWith(CFG.home + "/") || rel.includes("..")) { failed.push(rel); continue; }
    if ((was || undefined) === cur.get(rel)?.h) continue;    // 改了又改回：已经是确认时的样子
    try {
      // 设置类 JSON：不管是新出现的还是改了的，都只换回要管的那一块（新出现的就是清掉那一块），其余键照留
      if (isJsonPart(rel)) {
        const copy = was ? getCopy(rel) : "{}";
        let ok = false; try { ok = copy != null && !!JSON.parse(copy) && copy.startsWith("{"); } catch {}
        if (ok) { restorePart(rel, abs, copy, qdir); continue; }
        if (copy == null) { failed.push(rel); continue; }
        stash(qdir, rel, abs);
        writeAtomic(abs, copy);    // 确认时本来就不是合法 JSON：原样写回
        continue;
      }
      if (!was) { if (moveAway(qdir, rel, abs)) moved.push(rel); continue; }
      const copy = getCopyBytes(rel);
      if (copy == null) { failed.push(rel); continue; }
      stash(qdir, rel, abs);
      const mode = Number.isInteger(REC?.modes?.[rel]) ? REC.modes[rel] & 0o7777 : 0o600;   // 旧记录没存权限：照以前的 0600
      writeAtomic(abs, copy, mode);
      exact.set(rel, { copy, mode: Number.isInteger(REC?.modes?.[rel]) ? mode : null });
    } catch (e) { log(`[用户配置] 还原 ${rel} 失败：${e.message}`); failed.push(rel); }
  }
  // 再核一遍：副本自己被改过的、还原后还对不上的，都算没还原成
  const after = ucScan();
  for (const rel of rels || []) {
    if (failed.includes(rel)) continue;
    // 按副本还原的再逐字节、按权限核一遍：指纹按文本算，二进制文件改坏了、执行位丢了它都看不出来（#151-1）
    const ex = exact.get(rel);
    let same = true;
    if (ex) try { const abs = path.join(CFG.home, rel); same = fs.readFileSync(abs).equals(ex.copy) && (ex.mode == null || (fs.statSync(abs).mode & 0o7777) === ex.mode); } catch { same = false; }
    if (!same || (REC?.files[rel] || undefined) !== after.get(rel)?.h) failed.push(rel);
    else { AGAIN.set(rel, (AGAIN.get(rel) || 0) + 1); ATTR.delete(rel); SEEN.delete(rel); }
  }
  // 还原不成的不留在原地：挪走（设置类只清掉要管的那块）
  for (const rel of failed) {
    const abs = path.join(CFG.home, rel);
    if (!abs.startsWith(CFG.home + "/") || rel.includes("..")) continue;
    try {
      if (isJsonPart(rel)) { stash(qdir, rel, abs); if (fs.existsSync(abs)) restorePart(rel, abs, "{}", qdir); }
      else if (moveAway(qdir, rel, abs)) moved.push(rel);
    } catch (e) { log(`[用户配置] 挪走 ${rel} 失败：${e.message}`); }
  }
  log(`[用户配置] 撤销改动：还原 ${(rels || []).length - failed.length} 项${moved.length ? `（挪进 ${qdir}：${moved.length} 项）` : ""}${failed.length ? `，没法还原：${failed.join(", ")}` : ""}`);
  return { failed, quarantine: moved.length || failed.length ? qdir : null };
}

/** 撤销之后，下一轮随用户消息告诉模型（只说一次） */
let REVERT_NOTE = "";
export function ucSetRevertNote(rels, procs) {
  const files = (rels || []).filter((r) => !r.startsWith("…")).slice(0, 12).map((r) => "~/" + r.replace(/[^\w.\/ -]/g, "_")).join(", ");
  const parts = [];
  if (files) parts.push(`reverted changes to Claude Code configuration that is loaded into every conversation (${files})`);
  if (procs) parts.push(`stopped ${procs} background process(es) left running by an earlier turn`);
  REVERT_NOTE = parts.length ? "App note: before this turn the user " + parts.join(" and ") + ". Don't recreate them or work around this check; if you made them, tell the user plainly." : "";
}
export function ucTakeNote() { const n = REVERT_NOTE; REVERT_NOTE = ""; return n; }

/** 测试用：清掉内存里的状态 */
export function _ucReset() {
  REC = null; SNAP.clear(); ATTR.clear(); AGAIN.clear(); SEEN.clear(); ACTIVE.clear(); PEND.clear(); REVERT_NOTE = "";
  if (pendT) { clearTimeout(pendT); pendT = null; }
  for (const { w } of WATCH.values()) try { w.close(); } catch {}
  WATCH.clear();
}
/** 测试用：把攒着的动静马上读掉 */
export const _ucFlush = flushSeen;
