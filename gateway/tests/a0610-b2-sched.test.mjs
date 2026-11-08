// 0.6.10 车道 b2：定时任务（gw/sched.mjs）的回归：
// cron 校验、表单字段不再静默丢弃、缺省时间、once 暂停后能自动关、试跑受预算约束并记账、
// 改名不覆盖用户、saveSession=false 失败也回收、项目目录没了不回落、sids 有顶、月度统计不被 500 条截断、写失败回 500
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { CFG } from "../gw/config.mjs";
import { NEXT } from "../gw/http.mjs";

const { PROJECTS } = await import("../gw/projects.mjs");
const { _schedForTest: S, parseCron, nextAt, routeSched } = await import("../gw/sched.mjs");
const { QUEUE, END_HOOKS } = await import("../gw/queue.mjs");
const { RUNS, maxParallel } = await import("../gw/runs.mjs");
const { NAMES } = await import("../gw/sessions.mjs");
const { inTrash } = await import("../gw/sessionops.mjs");

const srv = http.createServer(async (req, res) => { const u = new URL(req.url, "http://x"); if ((await routeSched(req, res, u, u.pathname)) === NEXT) res.writeHead(404).end(); });
await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
after(() => { srv.close(); for (const id of fake) RUNS.delete(id); });

const dir = path.join(CFG.workspace, "b2sched");
fs.mkdirSync(dir, { recursive: true });
PROJECTS.push({ id: "b2p", name: "b2", path: dir, model: "", effort: "", perm: "", provider: "" });
after(() => { const i = PROJECTS.findIndex((p) => p.id === "b2p"); if (i >= 0) PROJECTS.splice(i, 1); });

// 并行槽占满：入队的条目只留在队列里，不会真起 claude
const fake = [];
for (let i = 0; i < maxParallel(); i++) { const id = "b2-busy" + i; fake.push(id); RUNS.set(id, { id, text: "", startedAt: Date.now(), log: [], idle: false, ended: false, lane: "x:" + i }); }

const allow0 = S.DB.allowLogin, budget0 = S.DB.dailyBudget, spent0 = { ...S.DB.spent };
after(() => { S.DB.allowLogin = allow0; S.DB.dailyBudget = budget0; S.DB.spent = spent0; });
const dayK = () => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
const monthK = () => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"); };
let n = 0;
const taskIds = [];
const mk = (over = {}) => {
  const t = { id: "b2-" + (++n), name: "t" + n, prompt: "做事", on: true, freq: { kind: "once" }, nextAt: null, busy: "run", session: "same", lastSid: null, projectId: "b2p", perm: "read", ...over };
  S.DB.tasks.push(t); taskIds.push(t.id); return t;
};
const drop = (t, it) => { if (it && QUEUE.includes(it)) QUEUE.splice(QUEUE.indexOf(it), 1); const i = S.DB.tasks.indexOf(t); if (i >= 0) S.DB.tasks.splice(i, 1); };
after(() => { for (const t of [...S.DB.tasks]) if (taskIds.includes(t.id)) S.DB.tasks.splice(S.DB.tasks.indexOf(t), 1); });
const lastRun = (id) => S.runlog().filter((r) => r.taskId === id).at(-1);
const hook = (it, sid, f) => { for (const h of END_HOOKS) h({ sched: { ...it.sched, taskId: it.sched.taskId }, sessionId: sid, denied: [] }, f); };

// ── 校验 / 缺省 ──
test("cron：步长 0 / 非数字、反向范围、越界都报错（中文、带字段）— 199-16-01、200-16-06", () => {
  for (const e of ["*/0 * * * *", "*/x * * * *", "5-3 * * * *", "0 25 * * *", "0 9 32 * *"]) assert.throws(() => parseCron(e), /cron 的/, e);
  assert.equal(parseCron("*/15 * * * *").min.size, 4);
});

test("clean：非法频率字段报错，不再静默丢掉或改值（200-16-04）", () => {
  const bad = [
    [{ kind: "daily", time: "99:99" }, /时间/],
    [{ kind: "weekly", days: [] }, /星期/],
    [{ kind: "weekly", days: [1.5] }, /星期/],
    [{ kind: "monthly", day: 32 }, /每月/],
    [{ kind: "every", hours: 0, from: "08:00", to: "22:00" }, /小时/],
    [{ kind: "every", hours: 2, from: "24:00", to: "22:00" }, /开始时间/],
    [{ kind: "once", date: "" }, /日期/],
    [{ kind: "cron", cron: "" }, /cron/],
  ];
  for (const [freq, re] of bad) assert.throws(() => S.clean({ name: "x", prompt: "y", freq }, {}), re, JSON.stringify(freq));
  const ok = S.clean({ name: "x", prompt: "y", freq: { kind: "monthly", day: "last", time: "09:00" } }, {});
  assert.equal(ok.freq.day, "last");
  assert.deepEqual(S.clean({ name: "x", prompt: "y", freq: { kind: "weekly", days: [7, 1, 1] } }, {}).freq.days, [1, 7]);
});

test("nextAt：once 缺省 09:00、every 缺省 00:00–23:59（与 freqText 对齐）— 200-16-07", () => {
  const base = new Date(); base.setDate(base.getDate() + 2); base.setHours(0, 0, 0, 0);
  // 用本地日期（nextAt 按本地时区解析 YYYY-MM-DD），toISOString 在 UTC+8 会退到前一天
  const date = base.getFullYear() + "-" + String(base.getMonth() + 1).padStart(2, "0") + "-" + String(base.getDate()).padStart(2, "0");
  const once = nextAt({ freq: { kind: "once", date } }, base.getTime() - 1);
  const d1 = new Date(once); assert.equal(d1.getHours(), 9); assert.equal(d1.getMinutes(), 0);
  const every = nextAt({ freq: { kind: "every", hours: 2 } }, base.getTime() - 1);
  const d2 = new Date(every); assert.equal(d2.getHours(), 0); assert.equal(d2.getMinutes(), 0);
});

test("once 暂停过（pausedUntil 留旧值）时间过了也要自动关掉（200-16-05）", () => {
  const t = mk({ freq: { kind: "once", date: "2020-01-01", time: "09:00" }, nextAt: null, pausedUntil: Date.now() - 864e5 });
  S.tick();
  assert.equal(t.on, false);
  assert.equal(t.pausedUntil, 0);
  assert.match(lastRun(t.id)?.msg || "", /只跑一次/);
  drop(t);
});

// ── 预算 / 记账 ──
test("每日预算也管试跑：超了不排队（197-5.10）", async () => {
  const k = dayK(), old = S.DB.spent[k];
  try {
    S.DB.dailyBudget = 1; S.DB.spent[k] = 2;
    const t = mk();
    const q0 = QUEUE.length;
    assert.equal(await S.fire(t, { reason: "manual", trial: true }), undefined);
    assert.equal(QUEUE.length, q0, "不该入队");
    drop(t);
  } finally { S.DB.dailyBudget = 0; if (old == null) delete S.DB.spent[k]; else S.DB.spent[k] = old; }
});

test("试跑花的钱进每日日桶（197-5.10）", async () => {
  S.DB.allowLogin = true;
  const k = dayK(), old = S.DB.spent[k];
  try {
    S.DB.spent[k] = 0;
    const t = mk();
    const it = await S.fire(t, { reason: "manual", trial: true });
    assert.ok(it && QUEUE.includes(it));
    hook(it, null, { costRaw: 0.25, finalText: "x" });
    assert.ok(S.costToday() >= 0.25);
    drop(t, it);
  } finally { S.DB.allowLogin = false; if (old == null) delete S.DB.spent[k]; else S.DB.spent[k] = old; }
});

// ── 收尾钩子 ──
test("定时任务不覆盖用户手动改的会话名（195-A.4）", async () => {
  S.DB.allowLogin = true;
  const t = mk({ session: "new" });
  try {
    const it = await S.fire(t, { reason: "manual" });
    assert.ok(it && it.sched);
    const sid = crypto.randomUUID();
    NAMES[sid] = "用户自己起的名字";
    hook(it, sid, { costRaw: 0, finalText: "答" });
    assert.equal(NAMES[sid], "用户自己起的名字");
    const sid2 = crypto.randomUUID();
    const it2 = await S.fire(t, { reason: "manual" });
    hook(it2, sid2, { costRaw: 0, finalText: "答" });
    assert.ok(NAMES[sid2].startsWith(t.name + " · "), "没改过名的仍按任务名起名");
    drop(t, it); drop(t, it2);
  } finally { S.DB.allowLogin = false; }
});

test("saveSession=false 的失败轮次也进回收站（197-2.5）", async () => {
  S.DB.allowLogin = true;
  const sid = crypto.randomUUID(), d = path.join(CFG.home, ".claude", "projects", "-b2-sched");
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, sid + ".jsonl"), JSON.stringify({ type: "user", sessionId: sid, uuid: crypto.randomUUID(), message: { role: "user", content: "hi" } }) + "\n");
  const t = mk({ saveSession: false, session: "new" });
  try {
    const it = await S.fire(t, { reason: "manual" });
    hook(it, sid, { costRaw: 0.01, failed: true, finalText: "出错了" });
    assert.equal(inTrash(sid), true, "失败轮次也要回收");
    assert.equal(lastRun(t.id)?.sid, null, "运行记录不指向已回收的会话");
    drop(t, it);
  } finally { S.DB.allowLogin = false; }
});

test("项目目录没了：任务跳过，不静默回落工作区跑（195-K.1）", async () => {
  S.DB.allowLogin = true;
  PROJECTS.push({ id: "b2-gone", name: "gone", path: path.join(CFG.workspace, "definitely-not-here"), model: "", effort: "", perm: "", provider: "" });
  const t = mk({ projectId: "b2-gone" });
  try {
    const q0 = QUEUE.length;
    assert.equal(await S.fire(t, { reason: "manual" }), undefined);
    assert.equal(QUEUE.length, q0);
    assert.match(lastRun(t.id)?.msg || "", /项目目录已经不在了/);
    drop(t);
  } finally {
    S.DB.allowLogin = false;
    const i = PROJECTS.findIndex((p) => p.id === "b2-gone"); if (i >= 0) PROJECTS.splice(i, 1);
  }
});

test("DB.sids 有上限：超过 2000 条丢最早的（200-6-05）", async () => {
  S.DB.allowLogin = true;
  const old = S.DB.sids;
  S.DB.sids = Array.from({ length: 2000 }, (_, i) => "old-" + i);
  const t = mk();
  try {
    const it = await S.fire(t, { reason: "manual" });
    const sid = crypto.randomUUID();
    hook(it, sid, { costRaw: 0, finalText: "答" });
    assert.equal(S.DB.sids.length, 2000);
    assert.equal(S.DB.sids.at(-1), sid);
    assert.equal(S.DB.sids.includes("old-0"), false);
    drop(t, it);
  } finally { S.DB.sids = old; S.DB.allowLogin = false; }
});

test("月度统计由 addRun 累加，不被 RUNLOG 的 500 条上限截断（197-5.11）", async () => {
  S.DB.allowLogin = true;
  const k = monthK(), beforeCost = S.DB.monthly[k]?.cost || 0, beforeRuns = S.DB.monthly[k]?.runs || 0;
  const t = mk();
  try {
    const it = await S.fire(t, { reason: "manual" });
    hook(it, null, { costRaw: 0.5, finalText: "答" });
    const b = S.DB.monthly[k];
    assert.ok(b);
    assert.ok(b.cost >= beforeCost + 0.5);
    assert.ok(b.runs >= beforeRuns + 1);
    drop(t, it);
  } finally { S.DB.allowLogin = false; }
});

test("保存失败：POST /api/sched 回 500 write_failed，任务不留在内存里（195-N.1）", async () => {
  const file = path.join(CFG.home, "ccapp-sched.json");
  const old = fs.readFileSync(file);
  fs.rmSync(file); fs.mkdirSync(file);
  try {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/sched`, { method: "POST", body: JSON.stringify({ name: "写不进", prompt: "x", freq: { kind: "daily", time: "09:00" } }) });
    assert.equal(r.status, 500);
    const j = await r.json();
    assert.equal(j.ok, false);
    assert.equal(j.error, "write_failed");
    assert.equal(S.DB.tasks.some((t) => t.name === "写不进"), false);
  } finally { fs.rmSync(file, { recursive: true, force: true }); fs.writeFileSync(file, old); }
});
