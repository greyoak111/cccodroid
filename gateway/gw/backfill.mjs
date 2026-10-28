// 补档（脉络规划书 §12 / G5）：改版前的旧会话没有「在场的 AI」给章起题名，由用户在脉络页点一下，网关替它补。
// 素材：每章结束时那份压缩摘要（现成的浓缩，不重读全文），取开头「主要诉求」和末尾「当前工作」两段；
//      还没压缩过的最后一章没有摘要，拿这一章里用户的提问。
// 调用：claude -p，走全局默认的接口和模型（用户 10-26 定的，不另挑便宜型号）；不留会话记录、不给工具、不起 MCP，
//      在空的私有目录里跑。一个会话的章一次问完（太多就分批），题名过 validateTitle，不合格的带着原因再问一次。
// 记 by:"backfill"——最弱的来源，AI 建档、用户改名都能盖过它；跑的时候有人刚给某章起了名就跳过那章。
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { CFG, LAST_LANG, log } from "./config.mjs";
import { NEXT, readBody, sendJson } from "./http.mjs";
import { publish } from "./bus.mjs";
import { claudeCmd, claudeEnv, currentModelInfo, ensureBridge, killTree, settingsArgs } from "./claude.mjs";
import { isLoginMode } from "./models.mjs";
import { SETTINGS } from "./settings.mjs";
import { PROVIDER } from "./providers.mjs";
import { lineageCached, lineageGraph } from "./lineage.mjs";
import { findSessionFile } from "./sessions.mjs";
import { archiveDb } from "./archive-store.mjs";
import { fileChapter } from "./archive.mjs";
import { validateTitle } from "./archive-core.mjs";

const SUM_HEAD = 1000, SUM_TAIL = 1400, OPEN_MAX = 1600, BATCH_CHARS = 48000, BATCH_N = 24;
const zh = () => /^zh/i.test(LAST_LANG);

// ── 素材 ──

/** 压缩摘要 → 喂给模型的一段：「主要诉求」开头一截 + 「当前工作」一截（摘要按 Claude Code 的固定小节写） */
export function digestSummary(text) {
  let s = String(text || "").replace(/\r/g, "");
  const k = s.search(/\bSummary:\s*\n/);
  if (k >= 0) s = s.slice(k).replace(/^Summary:\s*/, "");
  if (s.length <= SUM_HEAD + SUM_TAIL) return s.trim();
  const cw = s.search(/\n\s*\d+\.\s*(Current Work|当前工作)/i);
  const tail = cw >= 0 ? s.slice(cw, cw + SUM_TAIL) : s.slice(-SUM_TAIL);
  return (s.slice(0, SUM_HEAD) + "\n…\n" + tail).trim();
}

/** 读文件 [a, b) 一段，按行切（首尾半截行丢掉） */
async function readLines(file, a, b) {
  const fh = await fs.promises.open(file, "r");
  try {
    const buf = Buffer.alloc(Math.max(0, b - a));
    const { bytesRead } = await fh.read(buf, 0, buf.length, a);
    const lines = buf.subarray(0, bytesRead).toString("utf8").split("\n");
    if (a > 0) lines.shift();
    lines.pop();
    return lines;
  } finally { await fh.close(); }
}
const textOf = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.filter((x) => x && x.type === "text").map((x) => x.text).join("\n") : "");

/** off 处那一行（压缩摘要）的正文 */
async function summaryAt(file, off) {
  const fh = await fs.promises.open(file, "r");
  try {
    let line = Buffer.alloc(0), pos = off;
    while (line.length < 8 << 20) {
      const b = Buffer.alloc(256 << 10); const { bytesRead } = await fh.read(b, 0, b.length, pos);
      if (!bytesRead) break;
      const nl = b.subarray(0, bytesRead).indexOf(10);
      line = Buffer.concat([line, b.subarray(0, nl >= 0 ? nl : bytesRead)]);
      if (nl >= 0) break;
      pos += bytesRead;
    }
    const e = JSON.parse(line.toString("utf8"));
    return textOf(e.message && e.message.content);
  } catch { return ""; } finally { await fh.close(); }
}

/** 从 off 往后这一章里用户的提问：开头几句 + 末尾几句（大章只读头尾各 3 MB） */
async function promptsFrom(file, off) {
  const size = fs.statSync(file).size, W = 3 << 20;
  const parts = size - off > 2 * W ? [[off, off + W], [size - W, size]] : [[off, size]];
  const qs = [];
  for (const [a, b] of parts) {
    for (const s of await readLines(file, a, b)) {
      if (!s.includes('"type":"user"') || s.includes('"tool_result"') || s.includes('"isCompactSummary":true') || s.includes('"isMeta":true')) continue;
      let e; try { e = JSON.parse(s); } catch { continue; }
      if (e.type !== "user" || e.isSidechain) continue;
      const t = textOf(e.message && e.message.content).trim();
      if (!t || t.startsWith("<") || t.startsWith("Caveat:")) continue;
      qs.push(t.replace(/\s+/g, " ").slice(0, 160));
    }
  }
  const pick = qs.length > 10 ? [...qs.slice(0, 5), "…", ...qs.slice(-5)] : qs;
  let out = pick.map((q) => "- " + q).join("\n");
  if (out.length > OPEN_MAX) out = out.slice(0, OPEN_MAX) + "…";
  return out;
}

// ── 要补的 ──

/** 哪些章要补：不在回收站、不是一问一答、不是杂项 / 定时任务；没题名的章。正在跑的会话不补最后一章（在场的 AI 会起） */
export async function backfillTargets() {
  const g = await lineageGraph();
  const out = [];
  for (const n of [...g.nodes].sort((a, b) => b.lastTs - a.lastTs)) {
    if (n.trashed || n.brief || n.misc || n.sched) continue;
    const last = n.chapters.length;
    const chs = n.chapters.filter((c) => !c.title && !(c.n === last && n.running)).map((c) => c.n);
    if (chs.length) out.push({ id: n.id, title: n.title, chapters: chs, total: last });
  }
  return out;
}

/** 预估：章数、调用次数、大约多少 token（按素材上限算，宁多勿少） */
export function estimate(targets) {
  let chapters = 0, chars = 0, calls = 0;
  for (const t of targets) {
    let open = t.chapters.includes(t.total) ? 1 : 0, sum = t.chapters.length - open;
    chapters += t.chapters.length;
    const c = sum * (SUM_HEAD + SUM_TAIL + 60) + open * (OPEN_MAX + 60);
    chars += c;
    calls += Math.max(Math.ceil(t.chapters.length / BATCH_N), Math.ceil(c / BATCH_CHARS));
  }
  // 中文约 1 字 0.8 token、英文约 4 字符 1 token，摘要多是英文夹中文：按 0.45 折算；每次调用另有约 1500 的固定开销
  const tokensIn = Math.round(chars * 0.45 + calls * 1500), tokensOut = chapters * 250;   // 含思考：DeepSeek Flash 实测 5 章约 1200
  return { sessions: targets.length, chapters, calls, tokensIn, tokensOut };
}

// ── 问模型 ──

export function systemPrompt() {
  return zh()
    ? `你给编程助手 App 里的会话章节起题名。会话每压缩一次就结束一章；每章给你的是那一章结束时的压缩摘要（概括到那时为止的工作，重点看「当前工作」那段，那是这一章最后在干的事），或者（还没结束的章）这一章里用户的提问。
题名规则：说清这一章干了什么事，用动宾结构（如「补齐 9 家厂商官方接口」「排查终端密钥 401」）；不超过 20 个字；用中文，专有名词、版本号、命令名照原样；不写问候语、日期、「对话」「会话」「讨论」这类空泛词、emoji，结尾不加标点。相邻两章干的是同一件事也各起各的，体现进展。
只输出一个 JSON 对象，键是章号，值是题名，例如 {"3":"定稿脉络建档规范","4":"实现脉络页地图"}。不要别的文字。`
    : `You title chapters of sessions in a coding-assistant app. A session ends a chapter each time it is compacted. For each chapter you get the compaction summary written when it ended (it covers all work so far; the "Current Work" part is what this chapter ended on), or, for a chapter still open, the user's prompts in it.
Title rules: say what was done in this chapter as a verb phrase ("Add official endpoints for 9 vendors", "Debug terminal key 401"); at most 60 characters; write in ${LAST_LANG.startsWith("en") ? "English" : "the interface language (" + LAST_LANG + ")"}; keep product names, versions and commands as-is; no greetings, dates, vague words like "chat"/"session"/"discussion", emoji, or trailing punctuation. Adjacent chapters on the same thing still get distinct titles that show progress.
Output only one JSON object mapping chapter number to title, e.g. {"3":"Finalize the archive spec","4":"Build the lineage map"}. No other text.`;
}

export function userPrompt(sessTitle, items, fix) {
  const head = zh() ? `会话：${sessTitle || "（无题）"}\n下面是要起题名的章。` : `Session: ${sessTitle || "(untitled)"}\nChapters to title:`;
  const body = items.map((it) => {
    const label = zh() ? `【第 ${it.n} 章】` : `[Chapter ${it.n}]`;
    const prev = it.prev ? (zh() ? `上一章题名：${it.prev}\n` : `Previous chapter title: ${it.prev}\n`) : "";
    const kind = it.open ? (zh() ? "这一章用户的提问：" : "User prompts in this chapter:") : (zh() ? "结束时的压缩摘要：" : "Summary at the end:");
    const bad = fix && fix[it.n] ? (zh() ? `\n上次起的「${fix[it.n].title}」不合格：${fix[it.n].errors.join("；")}` : `\nLast attempt "${fix[it.n].title}" was rejected: ${fix[it.n].errors.join("; ")}`) : "";
    return `${label}\n${prev}${kind}\n${it.src}${bad}`;
  }).join("\n\n");
  return head + "\n\n" + body;
}

/** 模型回的文字 → { 章号: 题名 } */
export function parseTitles(text) {
  const s = String(text || ""), a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return {};
  try {
    const o = JSON.parse(s.slice(a, b + 1)), out = {};
    for (const [k, v] of Object.entries(o)) if (/^\d+$/.test(k) && typeof v === "string") out[Number(k)] = v;
    return out;
  } catch { return {}; }
}

const WORK = path.join(CFG.home, ".cache", "ccapp-backfill");
function ask(prompt) {
  return new Promise((resolve) => {
    fs.mkdirSync(WORK, { recursive: true });
    const [cmd, args] = claudeCmd([...settingsArgs(), "-p", "--no-session-persistence", "--tools", "", "--strict-mcp-config",
      "--system-prompt", systemPrompt(), "--output-format", "json"]);
    const child = spawn(cmd, args, { cwd: WORK, env: claudeEnv(), stdio: ["pipe", "pipe", "pipe"], detached: true });
    JOB.child = child;
    let out = "", err = "", done = false;
    const fin = (r) => { if (done) return; done = true; clearTimeout(timer); JOB.child = null; resolve(r); };
    const timer = setTimeout(() => { killTree(child); fin({ error: "timeout" }); }, 240000);
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => fin({ error: e.message }));
    child.on("close", () => {
      let j = null; try { j = JSON.parse(out.trim().split("\n").pop()); } catch {}
      if (!j) return fin({ error: (err || out).trim().slice(-300) || "no output" });
      if (j.is_error) return fin({ error: String(j.result || j.subtype || "error").slice(0, 300) });
      const u = j.usage || {};
      fin({ text: j.result || "", tin: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), tout: u.output_tokens || 0 });
    });
    child.stdin.end(prompt);
  });
}

// ── 任务 ──

const JOB = { running: false, stop: false, child: null, sessions: 0, total: 0, done: 0, ok: 0, skipped: 0, failed: 0, tin: 0, tout: 0, cur: "", error: "", startedAt: 0, endedAt: 0 };
const jobState = () => { const { child, stop, ...s } = JOB; return s; };
const tick = () => publish({ type: "backfill", ...jobState() });

async function runSession(t) {
  const found = findSessionFile(t.id), rec = lineageCached(t.id);
  if (!found || !rec) { JOB.skipped += t.chapters.length; JOB.done += t.chapters.length; return; }
  const entry = archiveDb().sessions[t.id] || {};
  const titleOf = (n) => entry.chapters?.[n]?.title || null;
  const items = [];
  for (const n of t.chapters) {
    const open = n === t.total;
    const src = open ? await promptsFrom(found.file, n >= 2 ? rec.compacts[n - 2].off : 0)
      : digestSummary(await summaryAt(found.file, rec.compacts[n - 1].off));
    items.push({ n, open, src: src || (zh() ? "（没有可用的内容）" : "(nothing usable)"), prev: titleOf(n - 1) });
  }
  // 分批：章数、字数都封顶
  const batches = [];
  let cur = [], chars = 0;
  for (const it of items) {
    if (cur.length && (cur.length >= BATCH_N || chars + it.src.length > BATCH_CHARS)) { batches.push(cur); cur = []; chars = 0; }
    cur.push(it); chars += it.src.length;
  }
  if (cur.length) batches.push(cur);
  for (const b of batches) {
    if (JOB.stop) return;
    let todo = b, fix = null;
    for (let round = 0; round < 2 && todo.length && !JOB.stop; round++) {
      const r = await ask(userPrompt(t.title, todo, fix));
      if (JOB.stop) return;   // 用户点了停止：掐断的这一批不算失败，也不记错误
      if (r.error) { JOB.error = r.error; log("补档调用失败：" + r.error); break; }
      JOB.tin += r.tin; JOB.tout += r.tout;
      const got = parseTitles(r.text), next = [];
      fix = {};
      for (const it of todo) {
        if (archiveDb().sessions[t.id]?.chapters?.[it.n]?.title) { JOB.skipped++; JOB.done++; continue; }   // 跑的时候有人起了名
        const v = validateTitle(got[it.n], LAST_LANG);
        if (!v.ok) { fix[it.n] = { title: got[it.n] || "", errors: v.errors }; next.push(it); continue; }
        const w = await fileChapter(t.id, { title: v.title, chapter: it.n, by: "backfill" });
        if (w.ok) JOB.ok++; else JOB.failed++;
        JOB.done++;
      }
      todo = next;
      tick();
    }
    if (JOB.stop) return;
    for (const it of todo) { JOB.failed++; JOB.done++; }
    tick();
  }
}

let starting = false;
export async function startBackfill(only) {
  if (JOB.running || starting) return { ok: false, message: "running" };
  starting = true;
  try { return await start(only); } finally { starting = false; }
}
async function start(only) {
  let targets = await backfillTargets();
  if (only) targets = targets.filter((t) => t.id === only);
  if (!targets.length) return { ok: false, message: "nothing" };
  // 和正式运行一样：全局那家（非官方登录）经本地 DNS 桥，先把桥拉起来
  if (!isLoginMode() && !(await ensureBridge())) return { ok: false, message: "bridge" };
  Object.assign(JOB, { running: true, stop: false, sessions: targets.length, total: targets.reduce((n, t) => n + t.chapters.length, 0), done: 0, ok: 0, skipped: 0, failed: 0, tin: 0, tout: 0, error: "", startedAt: Date.now(), endedAt: 0 });
  log(`补档开始：${JOB.sessions} 个会话、${JOB.total} 章（模型 ${SETTINGS.model || "默认"}）`);
  tick();
  (async () => {
    try {
      for (const t of targets) {
        if (JOB.stop) break;
        JOB.cur = t.id;
        await runSession(t);
        if (JOB.error && JOB.ok === 0 && JOB.done > 0) break;   // 一开始就调不通（没额度、接口坏了）：别把整批都撞一遍
      }
    } catch (e) { JOB.error = e.message; log("补档出错：" + e.message); }
    JOB.running = false; JOB.cur = ""; JOB.endedAt = Date.now();
    log(`补档结束：成功 ${JOB.ok}、跳过 ${JOB.skipped}、失败 ${JOB.failed}，用了 ${JOB.tin} / ${JOB.tout} token`);
    tick();
  })();
  return { ok: true, ...jobState() };
}

export function stopBackfill() {
  JOB.stop = true;
  if (JOB.child) killTree(JOB.child);
  return { ok: true };
}

// ── 路由：GET /api/lineage/backfill（预估 + 进度）· POST {action:"start"|"stop", session?} ──
export async function routeBackfill(req, res, u, p) {
  if (p !== "/api/lineage/backfill") return NEXT;
  if (req.method === "GET") {
    const targets = JOB.running ? [] : await backfillTargets();
    const m = currentModelInfo();
    return sendJson(res, 200, { job: jobState(), estimate: estimate(targets), model: SETTINGS.model || m.id || "", modelName: m.name || m.display_name || SETTINGS.model || "", provider: PROVIDER.label || PROVIDER.id });
  }
  if (req.method !== "POST") return sendJson(res, 405, { error: "method" });
  let b; try { b = JSON.parse((await readBody(req)) || "{}"); } catch { return sendJson(res, 400, { error: "bad json" }); }
  if (b.action === "stop") return sendJson(res, 200, stopBackfill());
  if (b.action === "start") return sendJson(res, 200, await startBackfill(b.session ? String(b.session) : null));
  return sendJson(res, 400, { error: "action" });
}
export { promptsFrom as _promptsFrom, summaryAt as _summaryAt };   // 测试用
