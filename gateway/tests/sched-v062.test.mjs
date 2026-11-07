// v0.6.2 审查 #119：日额度独立日桶、开跑前复核预算、试跑会话隔离
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
const { _schedForTest: S, routeSched } = await import("../gw/sched.mjs");
const { QUEUE, START_GUARDS, END_HOOKS } = await import("../gw/queue.mjs");
const { RUNS, maxParallel } = await import("../gw/runs.mjs");
const srv = http.createServer(async (req, res) => { const u = new URL(req.url, "http://x"); if ((await routeSched(req, res, u, u.pathname)) === NEXT) res.writeHead(404).end(); });
await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
after(() => srv.close());
const post = async (p, b) => { const r = await fetch(`http://127.0.0.1:${srv.address().port}${p}`, { method: "POST", body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };

const dir = path.join(CFG.workspace, "v062sched");
fs.mkdirSync(dir, { recursive: true });
PROJECTS.push({ id: "v062p", name: "v062", path: dir, model: "", effort: "", perm: "", provider: "" });
// 并行占满：入队的条目只留在队列里，不会真起 claude
const fake = [];
for (let i = 0; i < maxParallel(); i++) { const id = "v062-busy" + i; fake.push(id); RUNS.set(id, { id, text: "", startedAt: Date.now(), log: [], idle: false, ended: false, lane: "x:" + i }); }
const allow0 = S.DB.allowLogin, budget0 = S.DB.dailyBudget, spent0 = { ...S.DB.spent };
const taskIds = [];
after(() => {
  S.DB.allowLogin = allow0; S.DB.dailyBudget = budget0; S.DB.spent = spent0;
  for (const id of fake) RUNS.delete(id);
  S.DB.tasks = S.DB.tasks.filter((t) => !taskIds.includes(t.id));
  const i = PROJECTS.findIndex((p) => p.id === "v062p"); if (i >= 0) PROJECTS.splice(i, 1);
});
const dayK = () => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
let n = 0;
const mk = (over = {}) => {
  const t = { id: "v062-" + (++n), name: "t" + n, prompt: "做事", on: true, freq: { kind: "once" }, nextAt: null, busy: "run", session: "same", lastSid: null, projectId: "v062p", perm: "read", ...over };
  S.DB.tasks.push(t); taskIds.push(t.id); return t;
};
const drop = (t, it) => { if (it && QUEUE.includes(it)) QUEUE.splice(QUEUE.indexOf(it), 1); const i = S.DB.tasks.indexOf(t); if (i >= 0) S.DB.tasks.splice(i, 1); };

test("日额度用独立日桶：RUNLOG 被 500 条 skip 挤满也不归零（#119-3）", () => {
  const k = dayK(), log = S.runlog(), n0 = log.length, old = S.DB.spent[k];
  try {
    S.DB.spent[k] = 2.5;
    for (let i = 0; i < 500; i++) log.push({ taskId: "v062-x", at: Date.now(), st: "skip", msg: "x" });
    assert.equal(S.costToday(), 2.5, "RUNLOG 里的 skip 不该挤掉日桶");
  } finally {
    log.length = n0;
    if (old == null) delete S.DB.spent[k]; else S.DB.spent[k] = old;
  }
});

test("排队后当天额度用完：开跑前复核拦下（#119-2）", async () => {
  const k = dayK(), spent = S.DB.spent[k];
  try {
    S.DB.allowLogin = true; S.DB.dailyBudget = 2; S.DB.spent[k] = 0;
    const t = mk();
    const it = await S.fire(t, { reason: "due" });
    assert.ok(it && QUEUE.includes(it), "先入队");
    S.DB.spent[k] = 2;   // 等待期间别的任务把额度花完
    const n0 = S.runlog().length;
    assert.equal(START_GUARDS.every((g) => g(it) !== false), false, "预算到限要拦下");
    assert.equal(S.runlog().slice(n0).find((x) => x.taskId === t.id)?.st, "skip");
    drop(t, it);
  } finally {
    if (spent == null) delete S.DB.spent[k]; else S.DB.spent[k] = spent;
    S.DB.dailyBudget = 0; S.DB.allowLogin = false;
  }
});

// 接着的会话得真有记录文件：会话不在了的任务开跑前会放下 lastSid、新开一个（#173-3）
const realSid = () => {
  const sid = crypto.randomUUID(), d = path.join(CFG.home, ".claude", "projects", "-sched-real");
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, sid + ".jsonl"), JSON.stringify({ type: "user", sessionId: sid, uuid: crypto.randomUUID(), message: { role: "user", content: "hi" } }) + "\n");
  return sid;
};
test("试跑用新会话，不续正式 lastSid；结束钩子也不写回（#119-4）", async () => {
  S.DB.allowLogin = true;
  const sid = realSid();
  const t = mk({ lastSid: sid });
  try {
    const it = await S.fire(t, { reason: "manual", trial: true });
    assert.ok(it && QUEUE.includes(it));
    assert.equal(it.sessionId, null, "试跑不该 --resume 正式会话");
    const run = { sched: it.sched, sessionId: crypto.randomUUID(), overBudget: false, timedOut: false, aborted: false, denied: [] };
    for (const h of END_HOOKS) h(run, { costRaw: 0.01, finalText: "试跑结果" });   // 不吞异常：钩子半路抛了，下面的断言会假通过
    assert.equal(t.lastSid, sid, "试跑结束不能写回 lastSid");
    drop(t, it);
    // 正式执行仍接着原会话
    const t2 = mk({ lastSid: sid });
    const it2 = await S.fire(t2, { reason: "manual" });
    assert.equal(it2.sessionId, sid);
    drop(t2, it2);
  } finally { S.DB.allowLogin = false; }
});

test("失败重试被后来的成功运行取消，不再重复跑一次", async () => {
  S.DB.allowLogin = true;
  const t = mk({ freq: { kind: "once" }, retry: 1 });
  try {
    const first = await S.fire(t, { reason: "manual" });
    assert.ok(first && first.sched, "并行槽已满：先入队");
    for (const h of END_HOOKS) h({ sched: { ...first.sched, taskId: t.id }, sessionId: null, denied: [] }, { costRaw: 0.01, failed: true, finalText: "失败" });
    assert.equal(S.hasRetry(t.id), true, "失败后排了 2 分钟重试");
    t.on = true;                                     // once 失败后可能已被关；模拟用户/下一次又跑成功了
    const second = await S.fire(t, { reason: "manual" });
    assert.ok(second && second.sched);
    for (const h of END_HOOKS) h({ sched: { ...second.sched, taskId: t.id }, sessionId: null, denied: [] }, { costRaw: 0.01, finalText: "成功" });
    assert.equal(S.hasRetry(t.id), false, "成功运行取消重试");
    drop(t, first); drop(t, second);
  } finally { S.DB.allowLogin = false; }
});

test("「跳过下一次」遇到错过的计划：消费标记，不让再下一次也被跳", () => {
  const t = mk({ freq: { kind: "daily", time: "09:30" }, nextAt: Date.now() - 20 * 60000, missed: "run", skipNext: true });
  S.tick();
  assert.equal(t.skipNext, false, "跳过的就是这次错过的计划");
  const last = S.runlog().filter((r) => r.taskId === t.id && r.st === "skip").at(-1);
  assert.ok(last && last.msg.includes("按设置跳过这一次"), "记一条跳过，而不是照跑");
  drop(t);
});

test("错过卡之后才设置的「跳过下一次」不会被补跑消费（#140 回归）", async () => {
  const t = mk({ freq: { kind: "daily", time: "09:30" }, nextAt: Date.now() - 20 * 60000, missed: "ask" });
  S.tick();
  const m = S.DB.missed.find((x) => x.taskId === t.id);
  assert.ok(m, "错过项已记录");
  t.skipNext = true; t.skipAt = Date.now() + 3600e3;
  const r = await post("/api/sched/missed", { taskId: t.id, at: m.at, act: "skip" });
  assert.equal(r.status, 200);
  assert.equal(t.skipNext, true, "下次计划的跳过不能被这次补跑/不补跑消费");
  assert.ok(t.skipAt > Date.now());
  const i = S.DB.missed.indexOf(m); if (i >= 0) S.DB.missed.splice(i, 1);
  drop(t);
});

test("错过之前设置的跳过会消费，且标记绑定到那一次计划", () => {
  const when = Date.now() - 20 * 60000;
  const t = mk({ freq: { kind: "daily", time: "09:30" }, nextAt: when, missed: "run", skipNext: true, skipAt: when });
  S.tick();
  assert.equal(t.skipNext, false, "这次错过就是被跳过的那次");
  assert.equal(t.skipAt, 0);
  drop(t);
});
