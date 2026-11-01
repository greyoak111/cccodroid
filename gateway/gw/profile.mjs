// 脉络 · 剖面（规划书 §4 阶段 3）：钻进一个会话看它是怎么一轮轮跑下来的。
//   GET /api/lineage/profile?id=&ch=n     第 n 章的每一轮：起止、工具调用数、子代理数、出错数；这一轮里长出去的分叉 / 回退 / 汇合
//   POST /api/lineage/export { name, data }  导出（阶段 4）：前端画好的 SVG / PNG / 单文件网页落到导出目录，再交给「保存到」/ 分享
//   GET /api/lineage/turn?id=&from=&to=   一轮的细节（from/to 是上一个接口给的字节位置）：主会话每次工具调用的起止，
//                                         子代理各自的起止与里面的工具调用（subagents/agent-*.jsonl，套娃的也带上）
// 章有字节位置（扫描时记下的压缩摘要 off），按章分段读，不从头翻；巨型工具结果那种超长行不解析，只摘时间戳和出错标记。
// 会话记录一个字节都不改。
import fs from "node:fs";
import path from "node:path";
import { CFG } from "./config.mjs";
import { NEXT, readBodyBuf, sendJson } from "./http.mjs";
import { lineageFile, lineageGraph, lineageRecord } from "./lineage.mjs";
import { agentFilesOf } from "./transcript.mjs";
import { isInjected } from "./integrity.mjs";

const SID = /^[0-9a-f-]{36}$/i;
const BIG_LINE = 2 << 20;          // 超过这么长的行（大段工具结果）不 JSON.parse，正则摘要点
const TURN_MAX = 3000, STEP_MAX = 800, AGENT_MAX = 60, AGENT_STEPS = 300;
const RANGE_MAX = 512 << 20;       // 一轮最多读这么多字节

/** 读 [from, to) 里的完整行，每 1 MB 让一下事件循环（几百 MB 的章读起来要几秒，别把网关冻住） */
async function rangeLines(file, from, to, fn) {
  const fd = fs.openSync(file, "r");
  try {
    let pos = from, rest = Buffer.alloc(0);
    const CH = 1 << 20;
    while (pos < to) {
      if (pos > from) await new Promise((ok) => setImmediate(ok));
      const buf = Buffer.alloc(Math.min(CH, to - pos));
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (!n) break;
      const data = rest.length ? Buffer.concat([rest, buf.subarray(0, n)]) : buf.subarray(0, n);
      const base = pos - rest.length;
      pos += n;
      let start = 0;
      for (let i = data.indexOf(10); i !== -1; i = data.indexOf(10, start)) { fn(data.subarray(start, i), base + start); start = i + 1; }
      rest = Buffer.from(data.subarray(start));
      if (rest.length > 64 << 20) rest = Buffer.alloc(0);
    }
    if (rest.length) fn(rest, pos - rest.length);
  } finally { fs.closeSync(fd); }
}

const tsOf = (s) => { const m = /"timestamp":"([^"]+)"/.exec(s); return m ? Date.parse(m[1]) || 0 : 0; };
/** 一行 → 事件；超长行只认出「是工具结果、出没出错」 */
function parse(b) {
  if (b.length > BIG_LINE) {
    const head = b.subarray(0, 4096).toString("utf8"), tail = b.subarray(b.length - 4096).toString("utf8");
    // 助手发的超长工具调用（Write 一个大文件）：只认出调了什么工具
    if (/"type":"assistant"/.test(head + tail)) { const m = /"type":"tool_use","id":"([^"]+)","name":"([^"]+)"/.exec(head); return { big: true, type: "assistant", isSidechain: /"isSidechain":true/.test(head), ts: tsOf(tail) || tsOf(head), uuid: (/"uuid":"([^"]+)"/.exec(tail) || [])[1] || "", call: m ? { id: m[1], name: m[2] } : null }; }
    if (!/"type":"user"/.test(head + tail)) return null;
    const ids = [...head.matchAll(/"tool_use_id":"([^"]+)"/g)].map((m) => m[1]);
    return { big: true, type: "user", isSidechain: /"isSidechain":true/.test(head), timestamp: null, ts: tsOf(tail) || tsOf(head), ids, err: /"is_error":true/.test(head) };
  }
  const s = b.toString("utf8");
  if (!s.includes('"uuid"')) return null;
  try { const e = JSON.parse(s); e.ts = Date.parse(e.timestamp || "") || 0; return e; } catch { return null; }
}
const content = (e) => (Array.isArray(e.message?.content) ? e.message.content : []);
const textOf = (c) => typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n") : "";
/** 用户提问原文（和 lineage-core 的 userText 同一口径） */
function promptOf(e) {
  if (e.big || e.type !== "user" || e.isMeta || e.isCompactSummary || e.isSidechain) return "";
  const c = e.message && e.message.content;
  if (Array.isArray(c) && c.some((b) => b && b.type === "tool_result")) return "";
  const t = textOf(c);
  return t && !isInjected(t) ? t : "";
}
/** 工具调用的一句话说明：文件路径 / 命令 / 描述，取最像人话的那个 */
function labelOf(name, input) {
  const x = input || {};
  const v = x.description || x.file_path || x.path || x.command || x.pattern || x.url || x.query || x.prompt || x.skill || x.subject || "";
  return String(typeof v === "string" ? v : JSON.stringify(v)).replace(/\s+/g, " ").trim().slice(0, 90);
}
const isAgentTool = (n) => n === "Agent" || n === "Task";
const one = (q) => q.replace(/\s+/g, " ").trim().slice(0, 140);

// 同一章同一段字节读过就记住（翻来翻去不重读）；最新那一章还在长，to 变了键就变了
const CACHE = new Map();
function remember(k, v) { CACHE.delete(k); CACHE.set(k, v); while (CACHE.size > 24) CACHE.delete(CACHE.keys().next().value); return v; }

/** 第 n 章的轮。返回 { n, chapters, from, to, turns, kids } 或 { error } */
export async function chapterProfile(id, n) {
  const rec = await lineageRecord(id), file = lineageFile(id);
  if (!rec || !file) return { error: "not_found" };
  const C = rec.compacts.length;
  if (!(n >= 1 && n <= C + 1)) return { error: "no_chapter" };
  const from = n >= 2 ? rec.compacts[n - 2].off : 0, to = n <= C ? rec.compacts[n - 1].off : rec.off;
  const key = `${id}:${n}:${from}:${to}`;
  if (CACHE.has(key)) return remember(key, CACHE.get(key));

  // 这一章里长出去的子会话：边的 at 是父会话里的一条消息 uuid，落在哪一轮就挂在哪一轮
  const g = await lineageGraph();
  const names = new Map(g.nodes.map((x) => [x.id, x]));
  const kidsAt = new Map(), tailKids = [];
  for (const e of g.edges) {
    if (e.parent !== id || e.kind === "read" || !names.has(e.child)) continue;
    const k = { id: e.child, kind: e.kind, title: names.get(e.child).title || "", trashed: !!names.get(e.child).trashed };
    if (e.at) (kidsAt.get(e.at) || kidsAt.set(e.at, []).get(e.at)).push(k);
    else if (n === C + 1) tailKids.push(k);   // 汇合取的是进行中的章（摘录）：画在最后一轮
  }

  const turns = [];
  let cur = null, truncated = false;
  const open = new Map();   // 工具调用 id → 所在的轮（等结果回来记出错）
  const start = (q, uuid, ts, off, cont) => {
    if (cur) cur.end = off;
    if (turns.length >= TURN_MAX) { truncated = true; cur = null; return; }
    cur = { off, end: to, q: one(q), cont: !!cont, uuid, t0: ts, t1: ts, tools: 0, agents: 0, errs: 0, steps: 0, chars: 0, top: {}, kids: [] };
    turns.push(cur);
  };
  await rangeLines(file, from, to, (b, at) => {
    const e = parse(b);
    if (!e || e.isSidechain) return;
    if (e.isCompactSummary) return;
    const q = promptOf(e);
    if (q) { start(q, e.uuid, e.ts, at); }
    else if (!cur && !truncated && (e.type === "assistant" || e.big)) start("", e.uuid || "", e.ts, at, true);   // 自动压缩落在一轮中间：这一章开头接着上一章那一轮
    if (!cur) return;
    if (e.ts) { if (!cur.t0) cur.t0 = e.ts; cur.t1 = Math.max(cur.t1, e.ts); }
    if (e.uuid && kidsAt.has(e.uuid)) cur.kids.push(...kidsAt.get(e.uuid));
    if (e.big && e.call) { cur.steps++; cur.tools++; cur.top[e.call.name] = (cur.top[e.call.name] || 0) + 1; open.set(e.call.id, cur); return; }
    if (e.big) { for (const i of e.ids || []) if (e.err && open.get(i) === cur) cur.errs++; return; }
    if (e.type === "assistant") {
      cur.steps++;
      for (const c of content(e)) {
        if (c?.type === "text" && c.text) cur.chars += c.text.length;
        if (c?.type !== "tool_use") continue;
        cur.tools++; cur.top[c.name] = (cur.top[c.name] || 0) + 1;
        if (isAgentTool(c.name)) cur.agents++;
        open.set(c.id, cur);
      }
    } else if (e.type === "user") {
      for (const c of content(e)) if (c?.type === "tool_result" && c.is_error && open.get(c.tool_use_id) === cur) cur.errs++;
    }
  });
  if (cur) cur.end = to;
  if (tailKids.length && turns.length) turns[turns.length - 1].kids.push(...tailKids);
  for (const t of turns) t.top = Object.entries(t.top).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const out = { id, n, chapters: C + 1, open: n === C + 1, from, to, turns, truncated };
  return remember(key, out);
}

/** 每次调用前模型想了多久：从上一次调用（并行的取最晚收尾那个）结束到这次发起，记成 p0 */
function lead(steps, t0) {
  let end = t0;
  for (const s of steps) { s.p0 = Math.min(s.t0, end || s.t0); end = Math.max(end, s.t1); }
}

/** 读一个子代理的记录：起止、工具调用、它自己又派了谁 */
async function readAgent(file, meta) {
  const steps = [], open = new Map(), spawned = [];
  let t0 = 0, t1 = 0, tools = 0, errs = 0, last = "";
  await rangeLines(file, 0, fs.statSync(file).size, (b) => {
    const e = parse(b);
    if (!e) return;
    if (e.ts) { if (!t0) t0 = e.ts; t1 = Math.max(t1, e.ts); }
    if (e.big && e.call) { tools++; if (steps.length < AGENT_STEPS) { const s = { name: e.call.name, label: "", t0: e.ts, t1: 0, err: false }; steps.push(s); open.set(e.call.id, s); } return; }
    if (e.big) { for (const i of e.ids || []) { const s = open.get(i); if (s) { s.t1 = e.ts || s.t0; if (e.err) { s.err = true; errs++; } } } return; }
    for (const c of content(e)) {
      if (e.type === "assistant" && c?.type === "text" && c.text) last = c.text;
      if (e.type === "assistant" && c?.type === "tool_use") {
        tools++;
        if (isAgentTool(c.name)) spawned.push(c.id);
        if (steps.length < AGENT_STEPS) { const s = { name: c.name, label: labelOf(c.name, c.input), t0: e.ts, t1: 0, err: false }; steps.push(s); open.set(c.id, s); }
      }
      if (e.type === "user" && c?.type === "tool_result") { const s = open.get(c.tool_use_id); if (s) { s.t1 = e.ts || s.t0; if (c.is_error) { s.err = true; errs++; } } }
    }
  });
  for (const s of steps) if (!s.t1) s.t1 = s.t0;
  lead(steps, t0);
  const why = last.split("\n").map((x) => x.trim()).find(Boolean) || "";
  return { t0, t1, tools, errs, steps, spawned, done: !!meta.finished, why: why.slice(0, 120) };
}

/** 一轮的细节。from/to 必须是 chapterProfile 给过的行首位置 */
export async function turnDetail(id, from, to) {
  const rec = await lineageRecord(id), file = lineageFile(id);
  if (!rec || !file) return { error: "not_found" };
  const size = fs.statSync(file).size;
  if (!(Number.isInteger(from) && Number.isInteger(to) && from >= 0 && to > from && to <= size && to - from <= RANGE_MAX)) return { error: "bad_range" };
  if (from > 0) {
    const fd = fs.openSync(file, "r"), b = Buffer.alloc(1);
    try { fs.readSync(fd, b, 0, 1, from - 1); } finally { fs.closeSync(fd); }
    if (b[0] !== 10) return { error: "bad_range" };
  }
  // 只读剖面列过的轮（审查 v0.5.13 低5）：from 必须是某一轮的开头，to 不超过那一轮的结尾（进行中的章会往后长，旧的结尾仍算数）。
  // 那一章的剖面多半在缓存里，不在就现算一遍（本来也要先看剖面才点得到这一轮）
  const n = 1 + rec.compacts.filter((c) => c.off <= from).length;
  const ch = await chapterProfile(id, n);
  if (ch.error || !ch.turns.some((u) => u.off === from && to <= u.end)) return { error: "bad_range" };
  const key = `t:${id}:${from}:${to}`;
  if (CACHE.has(key)) return remember(key, CACHE.get(key));
  // 没缓存的大轮一次只读一个：一轮最多 RANGE_MAX，几个请求同时来就是几倍的读盘和解析（审查 v0513b 低-30）
  const prev = TD_LOCK;
  let release; TD_LOCK = new Promise((r) => (release = r));
  try {
    await prev;
    if (CACHE.has(key)) return remember(key, CACHE.get(key));
    return await turnDetailRead(id, file, from, to, key);
  } finally { release(); }
}
let TD_LOCK = Promise.resolve();
async function turnDetailRead(id, file, from, to, key) {
  const main = [], open = new Map(), agentCalls = [];
  let t0 = 0, t1 = 0, q = "", more = 0;
  await rangeLines(file, from, to, (b) => {
    const e = parse(b);
    if (!e || e.isSidechain || e.isCompactSummary) return;
    if (e.ts) { if (!t0) t0 = e.ts; t1 = Math.max(t1, e.ts); }
    if (!q) q = promptOf(e);
    if (e.big && e.call) { if (main.length < STEP_MAX) { const s = { name: e.call.name, label: "", t0: e.ts, t1: 0, err: false, agent: null }; main.push(s); open.set(e.call.id, s); } else more++; return; }
    if (e.big) { for (const i of e.ids || []) { const s = open.get(i); if (s) { s.t1 = e.ts || s.t0; if (e.err) s.err = true; } } return; }
    for (const c of content(e)) {
      if (e.type === "assistant" && c?.type === "tool_use") {
        if (isAgentTool(c.name)) agentCalls.push({ id: c.id, ts: e.ts, bg: !!c.input?.run_in_background, desc: String(c.input?.description || "").slice(0, 80) });
        if (main.length >= STEP_MAX) { more++; continue; }
        const s = { name: c.name, label: labelOf(c.name, c.input), t0: e.ts, t1: 0, err: false, agent: isAgentTool(c.name) ? c.id : null };
        main.push(s); open.set(c.id, s);
      }
      if (e.type === "user" && c?.type === "tool_result") { const s = open.get(c.tool_use_id); if (s) { s.t1 = e.ts || s.t0; if (c.is_error) s.err = true; } }
    }
  });
  for (const s of main) if (!s.t1) s.t1 = s.t0;
  lead(main, t0);

  // 子代理：工具调用 id → subagents/agent-*.jsonl；它自己派出的（套娃）按同样的 id 接着找，最多三层
  const files = agentFilesOf(file), metas = new Map();
  for (const [tool, f] of files) { try { metas.set(tool, JSON.parse(fs.readFileSync(f.replace(/\.jsonl$/, ".meta.json"), "utf8"))); } catch { metas.set(tool, {}); } }
  const agents = [];
  const visit = async (calls, depth, parent) => {
    for (const c of calls) {
      if (agents.length >= AGENT_MAX) return;
      const f = files.get(c.id); if (!f) continue;
      const m = metas.get(c.id) || {};
      let a; try { a = await readAgent(f, m); } catch { continue; }
      const me = { tool: c.id, parent, depth, name: String(m.description || c.desc || m.agentType || "agent").slice(0, 80), type: m.agentType || "", bg: m.requestShape === "background" || !!c.bg, ...a };
      delete me.spawned;
      agents.push(me);
      if (depth < 3 && a.spawned.length) await visit(a.spawned.map((id) => ({ id })), depth + 1, c.id);
      t1 = Math.max(t1, a.t1);   // 后台子代理比这一轮回答收尾得晚
    }
  };
  await visit(agentCalls, 1, null);
  return remember(key, { id, from, to, q: one(q), t0, t1, main, more, agents });
}

/** 导出文件落盘：和用量月报同一个导出目录（共享存储有就放那儿，用户在文件管理里找得到） */
const EXPORT_MAX = 48 << 20;
export function saveExport(name, data) {
  const m = /^cccodroid-lineage-[\w.-]{1,80}\.(svg|png|html)$/.exec(String(name || ""));
  if (!m || name.includes("..")) return { error: "bad_name" };
  let buf;
  if (m[1] === "png") {
    buf = Buffer.from(String(data || ""), "base64");
    if (buf.length < 100 || buf.readUInt32BE(0) !== 0x89504e47) return { error: "bad_png" };
  } else {
    const t = String(data || "");
    if (m[1] === "svg" ? !t.startsWith("<svg") : !/^<!doctype html>/i.test(t)) return { error: "bad_" + m[1] };
    buf = Buffer.from(t, "utf8");
  }
  if (buf.length > EXPORT_MAX) return { error: "too_big" };
  const base = process.env.CCAPP_SHARED && fs.existsSync(process.env.CCAPP_SHARED) ? process.env.CCAPP_SHARED : CFG.home;
  const dir = path.join(base, "exports");
  fs.mkdirSync(dir, { recursive: true });
  if (fs.lstatSync(dir).isSymbolicLink()) return { error: "bad_dir" };
  const file = path.join(dir, name);
  // 不跟软链接：导出目录里有人放了同名链接，也写不到别处去
  const C = fs.constants;
  try { fs.writeFileSync(file, buf, { flag: C.O_WRONLY | C.O_CREAT | C.O_TRUNC | (C.O_NOFOLLOW || 0) }); } catch (e) { return { error: e.code === "ELOOP" ? "bad_target" : "write_failed" }; }
  return { ok: true, file };
}

export async function routeProfile(req, res, u, p) {
  if (p === "/api/lineage/export") {
    if (req.method !== "POST") return sendJson(res, 405, { error: "method" });
    let b; try { b = JSON.parse((await readBodyBuf(req, Math.ceil(EXPORT_MAX * 1.4) + 4096)).toString("utf8") || "{}"); } catch { return sendJson(res, 400, { error: "bad_json" }); }
    const r = saveExport(b.name, b.data);
    return sendJson(res, r.error ? 400 : 200, r);
  }
  if (p !== "/api/lineage/profile" && p !== "/api/lineage/turn") return NEXT;
  if (req.method !== "GET") return sendJson(res, 405, { error: "method" });
  const id = u.searchParams.get("id") || "";
  if (!SID.test(id)) return sendJson(res, 400, { error: "bad_id" });
  try {
    const r = p === "/api/lineage/profile"
      ? await chapterProfile(id, Number(u.searchParams.get("ch")))
      : await turnDetail(id, Number(u.searchParams.get("from")), Number(u.searchParams.get("to")));
    return sendJson(res, r.error ? (r.error === "not_found" ? 404 : 400) : 200, r);
  } catch (e) { return sendJson(res, 500, { error: e.message }); }
}
