// 脉络 · 纯逻辑（不碰网关配置，方便单测）：读会话记录、推断会话之间的亲缘。
// 规划见 claude-workspace/session-lineage-plan.md §2–§3。
//
// 亲缘从哪儿来：分叉 / 回退（sessionops.forkSession）逐行照抄原会话、只改写 sessionId，
// 每条消息的 uuid 原样保留。所以两个会话有共同 uuid 就有亲缘；子会话里最后一条和父会话共有的消息就是分叉点。
// 判方向（谁是父）：抄过去的时间戳也一样，光看内容分不出。三个信号投票：
//   birth —— 文件创建时间（分叉那一刻才建子会话的文件）；真机实测 4/4 与事实一致，主信号
//   after —— 分叉点之后谁先有新内容（子会话的新内容只能在分叉之后）；父会话分叉后没再聊时弃权
//   name  —— 标题带「· 分叉 / · 回退」后缀的是子
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const CHAIN = new Set(["user", "assistant", "system"]);
const HEAD = 4096;   // 开头这么多字节的哈希：变了说明文件被整个改写过（删消息、回退修正），要重扫

function headHash(fd, size) {
  const n = Math.min(HEAD, size), buf = Buffer.alloc(n);
  if (n) fs.readSync(fd, buf, 0, n, 0);
  return crypto.createHash("sha1").update(buf).digest("hex").slice(0, 16);
}

/** 一行记录里的用户提问原文（不是工具结果、不是 <…> 包着的系统注入）；不是就返回 "" */
function userText(e) {
  if (e.type !== "user" || e.isMeta || e.isCompactSummary) return "";
  const c = e.message?.content;
  if (Array.isArray(c) && c.some((b) => b?.type === "tool_result")) return "";
  const t = typeof c === "string" ? c : Array.isArray(c) ? (c.find((b) => b?.type === "text")?.text || "") : "";
  return t && !t.startsWith("<") ? t : "";
}

export function emptyRecord(id) {
  return { id, size: 0, off: 0, head: "", birth: 0, uu: [], ts: [], compacts: [], refs: [], turns: 0, first: "", firstTs: 0, lastTs: 0, cwd: "", lead: "", qN: 0 };
}

/**
 * 读一个会话记录，按字节偏移增量：prev 是上次的结果（同一文件），只读新追加的部分。
 * 文件变短、或开头被改写过（删消息会原地重写），就从头再读。
 * 只留推断要用的：链上消息的 uuid 与时间戳、压缩摘要的位置、真实提问的轮数与第一句。
 */
export async function scanSession(file, prev) {
  const id = path.basename(file, ".jsonl");
  const st = fs.statSync(file);
  const fd = fs.openSync(file, "r");
  try {
    const head = headHash(fd, st.size);
    let r = prev && prev.id === id && st.size >= prev.off && prev.head === head ? prev : emptyRecord(id);
    if (r === prev) r = { ...prev, uu: prev.uu.slice(), ts: prev.ts.slice(), compacts: prev.compacts.map((c) => ({ ...c })), refs: (prev.refs || []).map((x) => ({ ...x })) };
    r.head = head; r.size = st.size; r.birth = st.birthtimeMs || r.birth || 0;
    let pos = r.off, rest = Buffer.alloc(0);
    const CH = 4 << 20;
    while (pos < st.size) {
      const buf = Buffer.alloc(Math.min(CH, st.size - pos));
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (!n) break;
      let data = rest.length ? Buffer.concat([rest, buf.subarray(0, n)]) : buf.subarray(0, n);
      const base = pos - rest.length;
      pos += n;
      let start = 0;
      for (let i = data.indexOf(10); i !== -1; i = data.indexOf(10, start)) {
        line(data.subarray(start, i), base + start);
        start = i + 1;
      }
      rest = Buffer.from(data.subarray(start));
      if (rest.length > 64 << 20) rest = Buffer.alloc(0);   // 单行超长（巨型工具结果）：不要它，免得吃光内存
    }
    // 最后一行没换行：可能还在写，下次从它开头再读
    r.off = pos - rest.length;
    return r;

    function line(b, at) {
      if (b.length > 8e6) return;
      const s = b.toString("utf8");
      if (!s.includes('"uuid"')) return;
      let e; try { e = JSON.parse(s); } catch { return; }
      if (e.cwd && !r.cwd) r.cwd = e.cwd;
      if (!e.uuid || e.isSidechain || !CHAIN.has(e.type)) return;
      const ts = Date.parse(e.timestamp || "") || 0;
      r.uu.push(e.uuid); r.ts.push(ts);
      if (ts) { if (!r.firstTs) r.firstTs = ts; r.lastTs = ts; }
      if (e.isCompactSummary) { r.compacts.push({ uuid: e.uuid, ts, off: at, q: "" }); r.qN = 0; return; }
      if (e.type === "assistant" && s.includes(".jsonl")) refsIn(e, ts);
      const t = userText(e);
      if (!t) return;
      const q = t.replace(/\s+/g, " ").trim().slice(0, 80);
      r.turns++;
      if (!r.first) r.first = q;
      // 旧章没有题名时拿章首提问顶上（规划书 §12）：看本章前 3 句，「你好，claude」「继续」这种让给后面有内容的那句
      if (r.qN < 3) {
        const c = r.compacts[r.compacts.length - 1], had = c ? c.q : r.lead;
        if (!had || (weakPrompt(had) && !weakPrompt(q))) { if (c) c.q = q; else r.lead = q; }
        r.qN++;
      }
    }
    // 工具调用里读过别的会话记录（<id>.jsonl）：改版前「去读隔壁会话接手」的唯一痕迹。每个来源只记第一次
    function refsIn(e, ts) {
      for (const b of Array.isArray(e.message?.content) ? e.message.content : []) {
        if (b?.type !== "tool_use") continue;
        for (const m of JSON.stringify(b.input || {}).matchAll(REF)) {
          const x = r.refs.find((y) => y.id === m[1]);
          if (m[1] === id) continue;
          if (x) x.n++; else r.refs.push({ id: m[1], at: e.uuid, ts, turn: r.turns, n: 1 });
        }
      }
    }
  } finally { fs.closeSync(fd); }
}
const REF = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl/g;

/** 当不了题名的提问：问候、「继续」「好的」、太短 */
export const weakPrompt = (q) => q.length < 4 || /^(你好|您好|嗨|哈喽|在吗|hi|hello|hey)[\s，,。.!！~]*(claude|克劳德)?[\s，,。.!！~]*$/i.test(q) || /^(继续|接着|接着来|go on|continue|ok|好的?|嗯|行|开始吧?)[\s，,。.!！~]*$/i.test(q);

const FORK_SUFFIX = /· (分叉|回退|分岔|Fork|Rewind|Branch)/i;

/** a、b 的共有关系：共有几条、分叉点（a 里最后一条共有消息）、各自分叉点之后第一条新消息的时间 */
export function relate(a, b) {
  const setB = new Set(b.uu);
  let shared = 0, lastA = -1;
  for (let i = 0; i < a.uu.length; i++) if (setB.has(a.uu[i])) { shared++; lastA = i; }
  const at = lastA >= 0 ? a.uu[lastA] : null;
  const lastB = at ? b.uu.indexOf(at) : -1;
  const afterA = a.ts.slice(lastA + 1).find(Boolean) || 0;
  const afterB = b.ts.slice(lastB + 1).find(Boolean) || 0;
  return { shared, at, lastA, lastB, afterA, afterB };
}

/** 判方向：{ parent, child, votes }。票数相同或都弃权时，取开始得早的当父 */
export function direction(a, b, r, names = {}) {
  const votes = {};
  if (a.birth && b.birth && Math.abs(a.birth - b.birth) > 1000) votes.birth = a.birth < b.birth ? a.id : b.id;
  if (r.afterA && r.afterB) votes.after = r.afterA < r.afterB ? a.id : b.id;
  const sa = FORK_SUFFIX.test(names[a.id] || ""), sb = FORK_SUFFIX.test(names[b.id] || "");
  if (sa !== sb) votes.name = sa ? b.id : a.id;
  // birth 是主信号：它投了票就按它；没有再看其余两票。
  // 例外：导入的会话文件创建时间是导入那一刻，会骗人 —— 另外两票一致反对它时，听那两票
  let parent = votes.birth;
  if (parent && votes.after && votes.after === votes.name && votes.after !== parent) parent = votes.after;
  if (!parent) {
    const tally = {};
    for (const v of [votes.after, votes.name]) if (v) tally[v] = (tally[v] || 0) + 1;
    parent = Object.entries(tally).sort((x, y) => y[1] - x[1])[0]?.[0] || (a.firstTs <= b.firstTs ? a.id : b.id);
  }
  return { parent, child: parent === a.id ? b.id : a.id, votes };
}

/**
 * 推断主父：每个会话在和它共享开头消息的会话里，找「判为它的父」且共有条数最多的那个（最近的祖先）。
 * 共有条数一样（孙会话的分叉点早于子会话的分叉点，和父、祖父共有的一样多）时取两者里更年轻的那个。
 * explicit：显式记录（今后的分叉 / 回退直接记），有就以它为准、不推断。
 * 返回 Map 子会话 id → { parent, at, kind, source, shared, votes }
 */
export function inferParents(records, { names = {}, explicit = {} } = {}) {
  const where = new Map();
  for (const r of records.values()) {
    const seen = new Set();
    for (const u of r.uu.slice(0, 3)) {
      if (seen.has(u)) continue; seen.add(u);
      const a = where.get(u); if (a) a.push(r.id); else where.set(u, [r.id]);
    }
  }
  const out = new Map();
  for (const r of records.values()) {
    const ex = explicit[r.id]?.primary;
    if (ex && ex.id) { out.set(r.id, { parent: ex.id, at: ex.at || null, kind: ex.kind || "fork", source: "explicit" }); continue; }
    if (!r.uu.length) continue;
    const cands = new Set();
    for (const u of r.uu.slice(0, 3)) for (const id of where.get(u) || []) if (id !== r.id) cands.add(id);
    let best = null;
    for (const id of cands) {
      const o = records.get(id); if (!o) continue;
      const rel = relate(r, o);
      if (!rel.shared) continue;
      const d = direction(r, o, rel, names);
      if (d.child !== r.id) continue;
      if (!best || rel.shared > best.rel.shared) best = { id, rel, d };
      else if (rel.shared === best.rel.shared) {
        const x = records.get(best.id), rr = relate(x, o);
        if (rr.shared && direction(x, o, rr, names).child === id) best = { id, rel, d };
      }
    }
    if (best) {
      const kind = /· (回退|Rewind)/i.test(names[r.id] || "") ? "rewind" : "fork";
      out.set(r.id, { parent: best.id, at: best.rel.at, kind, source: "inferred", shared: best.rel.shared, votes: best.d.votes });
    }
  }
  // 防环（显式记录写错、或推断在极端数据上互指）：沿主父往上走，撞到自己就断开这条
  for (const id of out.keys()) {
    const seen = new Set([id]);
    for (let p = out.get(id)?.parent; p; p = out.get(p)?.parent) {
      if (seen.has(p)) { out.delete(id); break; }
      seen.add(p);
    }
  }
  return out;
}
