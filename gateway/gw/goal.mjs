import fs from "node:fs";
import path from "node:path";
import { CFG, LIVE } from "./config.mjs";
import { findSessionFile } from "./sessions.mjs";
import { RUNS } from "./runs.mjs";
import { publish } from "./bus.mjs";

// ── /goal 目标（上游 2.1.x：设一个完成条件，Claude 跨轮一直干到满足为止）──
// -p 模式下目标状态不进事件流，只记在会话记录里：attachment.type === "goal_status"
//   设定 → {met:false, sentinel:true, condition}；没达成 → {met:false, condition, reason}；
//   达成 → {met:true, iterations, durationMs, tokens}；做不到 → {failed:true, reason}
// 「/goal clear」（stop/off/reset/none/cancel 同义）只留一条命令记录，没有 goal_status，要自己认。
const GOAL_CLEAR = new Set(["clear", "stop", "off", "reset", "none", "cancel"]);
// 以前只读最后 512KB：中间夹一个大的工具输出，目标那条就被挤出窗口，读成 null——没人清目标，界面却收到「目标没了」（0.6.9 审计 #190）。
// 现在从尾往前一块块读，读到能下结论为止（最多 GOAL_SCAN_MAX）；结果按文件记住，之后只看新追加的那段：
// 新的一段里连 goal 这个词都没有，结论不会变，直接沿用，不用每 4 秒把大文件重扫一遍
const GOAL_CHUNK = 1 << 20, GOAL_SCAN_MAX = 64 << 20, GOAL_TAIL_MAX = 4 << 20;
const GOAL_CACHE = new Map();   // 文件 → { ino, size, g }
export function goalStateOf(file) {
  let st; try { st = fs.statSync(file); } catch { return null; }
  const c = GOAL_CACHE.get(file);
  if (c && c.ino === st.ino && st.size >= c.size) {
    if (st.size === c.size) return c.g;
    if (st.size - c.size <= GOAL_TAIL_MAX) {
      const add = readRange(file, c.size, st.size - c.size);
      if (add != null && !add.includes("goal")) { c.size = st.size; return c.g; }
    }
  }
  let g = scanGoal(file, st.size);
  if (g === undefined) g = c && c.ino === st.ino ? c.g : null;   // 读满上限也没找到：有上次的结论就沿用，别读成「没有目标」
  GOAL_CACHE.delete(file); GOAL_CACHE.set(file, { ino: st.ino, size: st.size, g });
  if (GOAL_CACHE.size > 200) GOAL_CACHE.delete(GOAL_CACHE.keys().next().value);
  return g;
}
function readRange(file, pos, n) {
  try {
    const fd = fs.openSync(file, "r");
    try { const b = Buffer.alloc(n); const got = fs.readSync(fd, b, 0, n, pos); return b.subarray(0, got).toString("latin1"); } finally { fs.closeSync(fd); }
  } catch { return null; }
}
/** 从尾往前找目标状态。返回状态 / null（没有目标、或最近一次是清除）/ undefined（读满上限还没下结论） */
function scanGoal(file, size) {
  let last = null, lastAt = 0, setAt = null, checks = 0, done = false, cleared = false;
  const step = (l) => {
    if (!l.includes("goal")) return false;
    let e; try { e = JSON.parse(l); } catch { return false; }
    if (!last && e.type === "user" && typeof e.message?.content === "string") {
      const m = e.message.content.match(/<command-name>\/goal<\/command-name>[\s\S]*?<command-args>([\s\S]*?)<\/command-args>/);
      if (m && GOAL_CLEAR.has(m[1].trim().toLowerCase())) { cleared = true; return true; }   // 最近一次是清除
    }
    const a = e.type === "attachment" && e.attachment?.type === "goal_status" ? e.attachment : null;
    if (!a) return false;
    if (!last) { last = a; lastAt = Date.parse(e.timestamp) || 0; if (a.met || a.failed) return true; }
    if (a.condition !== last.condition) return true;
    if (a.sentinel) { setAt = Date.parse(e.timestamp) || null; return true; }
    if (!a.met) checks++;
    return false;
  };
  let fd; try { fd = fs.openSync(file, "r"); } catch { return null; }
  try {
    let pos = size, carry = Buffer.alloc(0), read = 0;
    while (pos > 0 && !done) {
      if (read >= GOAL_SCAN_MAX) break;
      const n = Math.min(GOAL_CHUNK, pos); pos -= n; read += n;
      const b = Buffer.alloc(n); fs.readSync(fd, b, 0, n, pos);
      const buf = carry.length ? Buffer.concat([b, carry]) : b;
      // 按字节找换行再解码：一块的开头可能切在多字节字符中间，留到下一块拼上
      let end = buf.length;
      for (let k = buf.length - 1; k >= 0 && !done; k--) {
        if (buf[k] !== 10) continue;
        if (step(buf.toString("utf8", k + 1, end))) done = true;
        end = k;
      }
      carry = buf.subarray(0, end);
    }
    if (!done && pos === 0 && carry.length && step(carry.toString("utf8"))) done = true;
    if (!done && pos > 0) return last ? result() : undefined;   // 没读到头
  } catch { return null; } finally { try { fs.closeSync(fd); } catch {} }
  return cleared || !last ? null : result();
  function result() {
    const base = { condition: String(last.condition || "").slice(0, 600), at: lastAt };
    if (last.met || last.failed) return { ...base, done: true, met: !!last.met, failed: !!last.failed, reason: String(last.reason || "").slice(0, 600),
      iterations: last.iterations ?? null, durationMs: last.durationMs ?? null, tokens: last.tokens ?? null };
    return { ...base, active: true, setAt, checks, reason: last.sentinel ? "" : String(last.reason || "").slice(0, 600) };
  }
}
// 跑着的时候每 4 秒看一眼（只看有会话号的轮），变了才推；每轮结束再补看一次（见 endRun），最后那次达成不会漏
const GOAL_SEEN = new Map();   // 会话号 → 上次推出去的 JSON
export function goalCheck(sid) {
  const f = sid && findSessionFile(sid);
  if (!f) return;
  const g = goalStateOf(f.file), j = JSON.stringify(g);
  if (GOAL_SEEN.get(sid) === j) return;
  GOAL_SEEN.set(sid, j);
  if (GOAL_SEEN.size > 200) GOAL_SEEN.delete(GOAL_SEEN.keys().next().value);
  publish({ type: "goal", sessionId: sid, goal: g });
}
if (LIVE) setInterval(() => { for (const r of RUNS.values()) { goalCheck(r.sessionId); tasksCheck(r.sessionId); } }, 4000).unref?.();

// 任务清单（TaskCreate / TaskUpdate）：claude 存在 ~/.claude/tasks/<会话号>/<编号>.json，--resume 沿用同一会话号，所以每轮换进程也接得上
const TASKS_DIR = path.join(CFG.home, ".claude", "tasks");
export function tasksOf(sid) {
  if (!sid || !/^[0-9a-f-]{36}$/.test(sid)) return null;
  const d = path.join(TASKS_DIR, sid);
  let names; try { names = fs.readdirSync(d).filter((n) => /^\d+\.json$/.test(n)); } catch { return null; }
  const list = [];
  for (const n of names) {
    try {
      const t = JSON.parse(fs.readFileSync(path.join(d, n), "utf8"));
      if (!t || t.status === "deleted") continue;
      list.push({ id: String(t.id || n.replace(".json", "")), subject: String(t.subject || "").slice(0, 200),
        status: t.status || "pending", active: t.activeForm ? String(t.activeForm).slice(0, 200) : "",
        blocked: Array.isArray(t.blockedBy) && t.blockedBy.length ? t.blockedBy.map(String) : undefined });
    } catch {}
  }
  if (!list.length) return null;
  list.sort((x, y) => (Number(x.id) || 0) - (Number(y.id) || 0));
  return list.slice(0, 60);
}
const TASKS_SEEN = new Map();
export function tasksCheck(sid) {
  if (!sid) return;
  const t = tasksOf(sid), j = JSON.stringify(t);
  if ((TASKS_SEEN.get(sid) ?? "null") === j) return;
  TASKS_SEEN.set(sid, j);
  if (TASKS_SEEN.size > 200) TASKS_SEEN.delete(TASKS_SEEN.keys().next().value);
  publish({ type: "tasks", sessionId: sid, tasks: t });
}
