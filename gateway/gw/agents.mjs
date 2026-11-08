import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { CFG, log } from "./config.mjs";
import { forEachLine } from "./bigfile.mjs";
import { neutralizeMarkers } from "./integrity.mjs";

// ── 子代理联络簿：状态外置 ───────────────────────────────────────────
// 从 claude 的事件流里摘三类事——派出（task_started）、联络（SendMessage）、结束（task_notification / Agent 结果），
// 落盘到 <项目目录>/.cccodroid/agents/<会话前 8 位>/，再给界面推一条很短的 ag 事件。
//   index.jsonl                  一行一件事（只有网关写）
//   <序号>-<名字>-<id 前 6 位>/brief.md   交代：派出时的 prompt
//                              report.md  汇报：结束时的最后一段正文
//                              msgs/…md   长消息的全文（超过 LONG 字就替它存一份）
//   summary.md                   一批子代理全部结束后的汇总
// 交代和汇报由网关写，不靠模型自觉；会话之间的消息只说「为什么事 + 文件在哪」，压缩丢掉的只是一句话。
// 界面永远不解析子代理的完整记录：卡片只靠 ag 事件和 index.jsonl。

const LONG = 300;           // 消息正文超过这么多字，替它存成文件
const WHY_MAX = 80;

/** 给子代理统一追加的规矩（--append-subagent-system-prompt，只在 -p 下生效、会传到孙代理）。
 *  实测 Agent 工具没有名字参数，按名字发消息必失败——这条最要紧 */
export const SUBAGENT_HINT = [
  "Messaging: SendMessage only reaches \"main\" (the main conversation) or an agent whose agentId you were given (it is in the result when that agent was launched); names do not work, and you cannot address your own parent unless it is main.",
  "So if you launch a sub-agent and need what it finds, launch it in the foreground and use its result, rather than asking it to message you.",
  "Always fill SendMessage summary with one short line saying what the message is about.",
  "Your final message is your report: it is saved to a file automatically, so put your findings there.",
].join(" ");
const slug = (s) => String(s || "agent").replace(/[\/\\:*?"<>|\s]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24) || "agent";
const firstLine = (s) => String(s || "").split("\n").map((x) => x.trim()).find(Boolean) || "";
const clip = (s, n) => { s = String(s || ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");

/** 某会话的落盘目录（按会话 cwd）。项目在共享存储（/sdcard）上时改放 home 私有目录：
 *  交代和汇报都是对话派生的内容，放在共享存储上任何有存储权限的应用都读得到（审查 10-29 第六份 低2） */
const SHARED = /^\/(sdcard|storage|mnt)\//;
const realCwd = (cwd) => { try { return fs.realpathSync(cwd); } catch { return path.resolve(cwd); } };
export const onShared = (cwd) => SHARED.test(realCwd(cwd) + "/");
const legacyDir = (cwd, sessionId) => path.join(cwd, ".cccodroid", "agents", String(sessionId).slice(0, 8));
/** 共享存储上的项目，联络簿的私有根目录（run 把它 --add-dir 给 claude，读汇报不用再要授权） */
export const privateAgentsBase = (cwd) => path.join(CFG.home, ".cccodroid", "agents", crypto.createHash("sha256").update(realCwd(cwd)).digest("hex").slice(0, 12));
export const agentsDir = (cwd, sessionId) => !onShared(cwd) ? legacyDir(cwd, sessionId) : path.join(privateAgentsBase(cwd), String(sessionId).slice(0, 8));

/** 读某会话的联络簿（界面翻历史用）。最多 n 行，取最后的 */
export function readAgentIndex(cwd, sessionId, n = 2000) {
  try {
    let f = path.join(agentsDir(cwd, sessionId), "index.jsonl");
    if (!fs.existsSync(f)) f = path.join(legacyDir(cwd, sessionId), "index.jsonl");      // 0.5.5 及以前落在项目目录里的
    const lines = fs.readFileSync(f, "utf8").trim().split("\n");
    return lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/** 汇总留给主会话的话：不单独叫醒它（最后一个后台子代理的结束通知已经叫醒过一次，再塞一条就要多回一轮），
 *  存在会话目录里，等用户下一条消息作为第二段带进去。取走即删；几批没取就攒在一起 */
const NOTE = "note.txt";
export function takeAgentNote(cwd, sessionId) {
  if (!cwd || !sessionId) return "";
  const f = path.join(agentsDir(cwd, sessionId), NOTE);
  try { const t = fs.readFileSync(f, "utf8").trim(); fs.unlinkSync(f); return t; } catch { return ""; }
}

/** 这一轮没送到模型：取走的汇总放回去，排在这期间新攒的前面 */
export function putAgentNote(cwd, sessionId, text) {
  if (!cwd || !sessionId || !text) return;
  const f = path.join(agentsDir(cwd, sessionId), NOTE);
  try { let cur = ""; try { cur = fs.readFileSync(f, "utf8"); } catch {} fs.writeFileSync(f, text.trim() + "\n" + cur); } catch {}
}

/** 一轮 run 的联络簿。feed(ev) 吃 claude 的原始事件；emit 推界面 */
export function agentBook(run, { emit }) {
  const byTask = new Map();     // agentId(task_id) → agent
  const byTool = new Map();     // Agent 工具调用 id → agent（子代理自己发的事件靠它认出是谁）
  const briefs = new Map();     // Agent 工具调用 id → 完整 prompt（task_started 里的可能被截）
  const sends = new Map();      // SendMessage 调用 id → 消息记录（等结果判送达）
  let dir = null, seq = 0, batch = [];

  const ensureDir = () => {
    if (dir) return dir;
    if (!run.sessionId || !run.cwd) return null;
    const d = agentsDir(run.cwd, run.sessionId);
    try {
      fs.mkdirSync(d, { recursive: true });
      // 别把这堆文件带进用户的 git 仓库
      const gi = path.join(run.cwd, ".cccodroid", ".gitignore");
      if (!onShared(run.cwd) && !fs.existsSync(gi)) fs.writeFileSync(gi, "*\n");
      seq = fs.readdirSync(d).filter((x) => /^\d+-/.test(x)).length;   // 续上之前轮次的编号
      dir = d;
    } catch (e) { log("子代理落盘目录建不了: " + e.message); }
    return dir;
  };
  const write = (f, s) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); return f; } catch { return null; } };
  const book = (o) => {
    const rec = { at: Date.now(), ...o };
    if (ensureDir()) try { fs.appendFileSync(path.join(dir, "index.jsonl"), JSON.stringify(rec) + "\n"); } catch {}
    emit({ type: "ag", ...rec });
  };
  const who = (a) => (a ? a.id : "main");
  // 收件人：main / agentId / 名字（名字发不到，但记下来界面好看懂）
  const resolve = (to) => {
    to = String(to || "").trim();
    if (!to || to === "main") return "main";
    const bare = to.replace(/\s*\[.*\]$/, "");
    if (byTask.has(bare)) return bare;
    for (const a of byTask.values()) if (a.id.startsWith(bare) || a.name === bare) return a.id;
    return to;
  };

  const spawn = (ev) => {
    if (byTask.has(ev.task_id)) return;
    ensureDir();       // 先建目录：编号要接着目录里已有的往下数
    const parentTask = ev.parent_task_id ? byTask.get(ev.parent_task_id) : null;
    const a = {
      id: String(ev.task_id), tool: String(ev.tool_use_id || ""), name: String(ev.description || ev.subagent_type || "agent").slice(0, 60),
      parent: parentTask ? parentTask.id : null, depth: Number(ev.spawn_depth) || (parentTask ? parentTask.depth + 1 : 1),
      bg: !!ev.is_backgrounded, status: "running", last: "", n: ++seq,
    };
    byTask.set(a.id, a); if (a.tool) byTool.set(a.tool, a);
    batch.push(a);
    let file = null;
    if (ensureDir()) {
      a.dir = path.join(dir, `${String(a.n).padStart(2, "0")}-${slug(a.name)}-${a.id.slice(0, 6).replace(/[^\w-]/g, "_")}`);   // task_id 来自事件流，带 ../ 就跳出目录（审查 10-30 第九份 存疑3）
      const prompt = briefs.get(a.tool) || ev.prompt || "";
      file = write(path.join(a.dir, "brief.md"), `# ${a.name}\n\n${prompt}\n`);
    }
    book({ k: "spawn", id: a.id, tool: a.tool, name: a.name, parent: a.parent, depth: a.depth, bg: a.bg, file, by: who(parentTask) });
  };

  const done = (a, status, summary) => {
    if (!a || a.status !== "running") return;
    a.status = status === "completed" ? "done" : status === "stopped" || status === "killed" ? "stopped" : "failed";
    const text = a.last || String(summary || "");
    let file = null;
    if (a.dir && text) {
      const f = path.join(a.dir, "report.md");
      try { if (fs.existsSync(f)) fs.renameSync(f, path.join(a.dir, "report.prev.md")); } catch {}   // 被叫醒又结束：上一份留着
      file = write(f, `# ${a.name}\n\n${text}\n`);
    }
    book({ k: "done", id: a.id, status: a.status, why: clip(firstLine(text), WHY_MAX), file, ...(a.steps ? { steps: a.steps } : {}) });   // 准确步数（task_progress 报的），界面自己数的可能因重连漏掉
    maybeSummary();
  };

  // 一批（≥2 个）全部结束：写汇总，给主会话留一条短话（只给状态和路径，汇报全文主会话已在通知 / 工具结果里收过）
  const maybeSummary = () => {
    if (batch.some((a) => a.status === "running")) return;
    const all = batch; batch = [];
    if (all.length < 2 || !dir) return;
    const mark = { done: "completed", stopped: "stopped", failed: "failed" };
    const rows = all.map((a) => `- ${a.name} (${a.id.slice(0, 6)}) — ${mark[a.status]}${a.dir ? ` — ${path.join(a.dir, "report.md")}` : ""}`);
    const sum = write(path.join(dir, "summary.md"), `# Sub-agent summary\n\n${rows.join("\n")}\n`);
    book({ k: "summary", ids: all.map((a) => a.id), file: sum });
    // 名字来自事件流/模型给的 description，可能带冒充系统的标签：换全角后再作为下一轮的提醒（200-S-08）
    try { fs.appendFileSync(path.join(dir, NOTE), `<cccodroid-agents>\nThe ${all.length} sub-agents of an earlier batch have finished. Their briefs and reports are saved as files; read them when you need details instead of digging through ~/.claude:\n${neutralizeMarkers(rows.join("\n"))}\nSummary: ${sum}\n</cccodroid-agents>\n`); } catch {}
  };

  const feed = (ev) => {
    if (!ev || typeof ev !== "object") return;
    if (ev.type === "system") {
      if (ev.subtype === "task_started" && ev.task_type === "local_agent" && ev.task_id) spawn(ev);
      else if (ev.subtype === "task_notification" && ev.task_id) done(byTask.get(ev.task_id), String(ev.status || ""), ev.summary);
      else if (ev.subtype === "task_progress" && ev.task_id) { const a = byTask.get(ev.task_id); if (a) a.steps = ev.usage?.tool_uses || a.steps; }
      return;
    }
    if (ev.type === "assistant") {
      const me = ev.parent_tool_use_id ? byTool.get(ev.parent_tool_use_id) : null;
      for (const c of ev.message?.content || []) {
        if (c.type === "text" && c.text && me) me.last = c.text;          // 子代理最后一段正文 = 汇报
        if (c.type !== "tool_use") continue;
        if ((c.name === "Agent" || c.name === "Task") && c.input?.prompt) briefs.set(c.id, String(c.input.prompt));
        if (c.name === "SendMessage" && c.input) {
          const body = typeof c.input.message === "string" ? c.input.message : JSON.stringify(c.input.message ?? c.input.content ?? "");
          const to = resolve(c.input.to);
          const toName = to === "main" ? "main" : byTask.get(to)?.name || to;
          let file = null;
          if (body.length > LONG && ensureDir()) {
            const base = me?.dir || dir;
            file = write(path.join(base, "msgs", `${stamp()}-${slug(me ? me.name : "main")}-to-${slug(toName)}-${slug(String(c.id).slice(-8))}.md`), body + "\n");
          }
          const m = { mid: c.id, from: who(me), to, why: clip(String(c.input.summary || "").trim() || firstLine(body), WHY_MAX), file };
          sends.set(c.id, m);
          book({ k: "msg", ...m });
        }
      }
      return;
    }
    if (ev.type === "user") {
      for (const c of ev.message?.content || []) {
        if (c.type !== "tool_result") continue;
        const m = sends.get(c.tool_use_id);
        if (m) {
          sends.delete(c.tool_use_id);
          const txt = typeof c.content === "string" ? c.content : (c.content || []).map((x) => x.text || "").join("");
          let j = null; try { j = JSON.parse(txt); } catch {}
          const ok = !c.is_error && !(j && j.success === false);
          book({ k: "msg_ok", mid: m.mid, ok, ...(ok ? {} : { err: clip(firstLine(j?.message || txt), 120) }) });
          // 给已经结束的代理发消息会把它叫醒（"Resuming agent"）：重新算「在跑」，下次结束再记一份汇报
          const back = j && j.resumedAgentId && byTask.get(String(j.resumedAgentId));
          if (back && back.status !== "running") {
            back.status = "running"; back.last = "";
            if (!batch.includes(back)) batch.push(back);
            book({ k: "resume", id: back.id });
          }
          continue;
        }
        // 前台子代理：结果就是它的汇报，不一定有 task_notification
        const a = byTool.get(c.tool_use_id);
        if (a && a.status === "running") {
          const txt = typeof c.content === "string" ? c.content : (c.content || []).map((x) => x.text || "").join("\n");
          if (/^Async agent launched/.test(txt)) continue;
          done(a, c.is_error ? "failed" : "completed", txt);
        }
      }
    }
  };
  // claude 退出了（答完、被停、被杀）：子代理都在它进程里跑，一起没了。还标着在跑的补一条「已停止」，
  // 不然联络簿里只有派出没有结束，重进会话翻历史时一直显示在跑
  const close = () => { for (const a of byTask.values()) if (a.status === "running") done(a, "stopped", ""); };
  return { feed, close, agents: byTask };
}

/** 翻历史时补齐：派出了、没有结束记录、眼下也不在跑的，按已停止算（旧版网关被停时没补记录；网关被杀时也来不及记） */
export function settleAgentRecs(recs, liveIds = new Set()) {
  const ended = new Set(), last = new Map();
  for (const r of recs) {
    if (r.k === "spawn" || r.k === "resume") { ended.delete(r.id); last.set(r.id, r.at || 0); }
    else if (r.k === "done") ended.add(r.id);
    else if (r.from && last.has(r.from)) last.set(r.from, Math.max(last.get(r.from), r.at || 0));
  }
  const add = [];
  for (const [id, at] of last) if (!ended.has(id) && !liveIds.has(id)) add.push({ at, k: "done", id, status: "stopped", why: "", file: null });
  return add.length ? [...recs, ...add] : recs;
}

/** 旧会话（没有联络簿的）：从 claude 自己的记录里推出同样格式的记录，只在内存里给界面看，不往项目里写文件。
 *  派出 = subagents/agent-*.meta.json；联络 = 主会话和各子代理记录里的 SendMessage；结束 = meta.finished + 最后一段正文 */
// 导入的 / 旧代理会话每次打开代理卡都要现推：按文件大小和改动时间记住结果，别回回全量扫（#72）
const BACKFILL_CACHE = new Map(), BACKFILL_KEEP = 16;
export function backfillAgents(sessionFile) {
  const sub = path.join(sessionFile.replace(/\.jsonl$/, ""), "subagents");
  let names; try { names = fs.readdirSync(sub).filter((n) => n.endsWith(".meta.json")); } catch { return []; }
  // 签名要含 meta 的完整路径：以前只列裸文件名，stat 不到实际 meta；只改 finished / toolUseId 不会让缓存失效（#189）
  const sig = [sessionFile, ...[...names].sort().map((n) => path.join(sub, n)), ...names.map((n) => path.join(sub, n.replace(/\.meta\.json$/, ".jsonl")))]
    .map((p) => { try { const st = fs.statSync(p); return p + ":" + st.size + ":" + st.mtimeMs; } catch { return p; } }).join("|");
  const hit = BACKFILL_CACHE.get(sessionFile);
  if (hit && hit.sig === sig) return hit.recs.map((r) => ({ ...r }));
  const recs = backfillScan(sessionFile, sub, names);
  BACKFILL_CACHE.delete(sessionFile); BACKFILL_CACHE.set(sessionFile, { sig, recs });
  while (BACKFILL_CACHE.size > BACKFILL_KEEP) BACKFILL_CACHE.delete(BACKFILL_CACHE.keys().next().value);
  return recs.map((r) => ({ ...r }));
}
function backfillScan(sessionFile, sub, names) {
  // 只解析用得上的行：发 SendMessage 的、它们的结果、首尾两行（时间）、最后一条带正文的回复；
  // 动辄几十 MB 的工具结果行只做一次字符串查找就跳过，也不留在内存里（#72）
  const lines = (f) => {
    const out = [], ids = [];
    let first = null, lastLine = "", textLine = "";
    const parse = (l) => { try { return JSON.parse(l); } catch { return null; } };
    try {
      forEachLine(f, (l) => {
        if (!l) return;
        if (first === null) first = parse(l);
        lastLine = l;
        if (l.includes('"SendMessage"')) {
          const ev = parse(l);
          if (ev) { out.push(ev); if (ev.type === "assistant") for (const c of ev.message?.content || []) if (c.type === "tool_use" && c.name === "SendMessage" && c.id) ids.push(c.id); }
        } else if (ids.length && l.includes('"tool_result"') && ids.some((id) => l.includes(id))) {
          // 子串只是初筛（别的结果正文里也可能原样带着这个 id），解析后按 tool_use_id 精确认，认不上就不留
          const ev = parse(l);
          if (ev && (ev.message?.content || []).some?.((c) => c.type === "tool_result" && ids.includes(c.tool_use_id))) out.push(ev);
        }
        // 结果正文里出现的同样字样是转义过的（\"type\"），不会误中
        if (l.includes('"type":"assistant"') && l.includes('"type":"text"')) textLine = l;
      });
    } catch {}
    const lastEv = lastLine ? parse(lastLine) : null, textEv = textLine ? parse(textLine) : null;
    let lastText = "";
    if (textEv?.type === "assistant") for (const c of textEv.message?.content || []) if (c.type === "text" && c.text) lastText = c.text;
    return { evs: out, first, last: lastEv, lastText };
  };
  const agents = [];
  for (const n of names) {
    let m; try { m = JSON.parse(fs.readFileSync(path.join(sub, n), "utf8")); } catch { continue; }
    const id = n.replace(/^agent-/, "").replace(/\.meta\.json$/, "");
    const f = path.join(sub, n.replace(/\.meta\.json$/, ".jsonl"));
    let at = 0; try { at = fs.statSync(f).birthtimeMs || fs.statSync(f).mtimeMs; } catch {}
    agents.push({ id, m, f, at });
  }
  agents.sort((a, b) => a.at - b.at);
  const ids = new Set(agents.map((a) => a.id)), recs = [];
  const sends = (evs, from, at0) => {
    const res = new Map();
    for (const ev of evs) for (const c of ev.message?.content || []) if (c.type === "tool_result") res.set(c.tool_use_id, c);
    for (const ev of evs) {
      if (ev.type !== "assistant") continue;
      for (const c of ev.message?.content || []) {
        if (c.type !== "tool_use" || c.name !== "SendMessage" || !c.input) continue;
        const body = typeof c.input.message === "string" ? c.input.message : JSON.stringify(c.input.message ?? "");
        let to = String(c.input.to || "main").replace(/\s*\[.*\]$/, "");
        if (to !== "main") { const hit = [...ids].find((x) => x.startsWith(to)) || agents.find((a) => a.m.description === to)?.id; if (hit) to = hit; }
        const at = Date.parse(ev.timestamp) || at0;
        recs.push({ at, k: "msg", mid: c.id, from, to, why: clip(String(c.input.summary || "").trim() || firstLine(body), WHY_MAX), file: null });
        const r = res.get(c.id);
        if (r) {
          const txt = typeof r.content === "string" ? r.content : (r.content || []).map((x) => x.text || "").join("");
          recs.push({ at, k: "msg_ok", mid: c.id, ok: !r.is_error && !/"success"\s*:\s*false/.test(txt) });
        }
      }
    }
  };
  sends(lines(sessionFile).evs, "main", 0);
  for (const a of agents) {
    const { evs, first, last: lastEv, lastText } = lines(a.f);
    const t0 = Date.parse(first?.timestamp) || a.at;
    recs.push({ at: t0, k: "spawn", id: a.id, tool: a.m.toolUseId || "", name: String(a.m.description || a.m.agentType || "agent").slice(0, 60),
                parent: a.m.parentAgentId || null, depth: a.m.spawnDepth || (a.m.parentAgentId ? 2 : 1), bg: a.m.requestShape === "background", file: null, by: a.m.parentAgentId || "main" });
    sends(evs, a.id, t0);
    if (a.m.finished) recs.push({ at: Date.parse(lastEv?.timestamp) || t0, k: "done", id: a.id, status: "done", why: clip(firstLine(lastText), WHY_MAX), file: null });
  }
  return recs.sort((x, y) => x.at - y.at);
}
