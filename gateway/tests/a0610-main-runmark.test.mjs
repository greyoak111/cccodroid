// 启动恢复（gw/queue.mjs recoverRunMark）：运行标记是唯一来源，中断记录落了盘才删；重入按 id 去重（0.6.9 审计 #183）
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CFG } from "../gw/config.mjs";
import * as Q from "../gw/queue.mjs";

const MARK = path.join(CFG.home, "ccapp-run-mark.json"), INTR = path.join(CFG.home, "ccapp-interrupted.json");
const mark = { runs: [{ id: "x1", text: "还没建会话的提问", startedAt: 1 }], queue: [{ id: "q1", message: "排着的一条", at: 1 }] };
const reset = () => { Q.setInterrupted([]); Q.QUEUE.length = 0; fs.rmSync(INTR, { recursive: true, force: true }); fs.rmSync(MARK, { force: true }); };
after(reset);

test("中断记录写不上 → 运行标记原样留着；下次能写了再恢复，记录、排队消息都只有一份", () => {
  reset();
  fs.writeFileSync(MARK, JSON.stringify(mark));
  fs.mkdirSync(INTR);                                   // 目标是个目录：写必失败
  Q.recoverRunMark();
  assert.deepEqual(JSON.parse(fs.readFileSync(MARK, "utf8")), mark, "来源不能丢");
  // 下一次启动（内存从头来）
  fs.rmSync(INTR, { recursive: true, force: true });
  Q.setInterrupted([]); Q.QUEUE.length = 0;
  Q.recoverRunMark();
  assert.deepEqual(JSON.parse(fs.readFileSync(INTR, "utf8")).map((e) => e.id), ["x1"]);
  assert.deepEqual(Q.QUEUE.map((q) => q.id), ["q1"]);
  // 标记换成只剩排队消息的那份（挂起）
  const m2 = JSON.parse(fs.readFileSync(MARK, "utf8"));
  assert.deepEqual(m2.runs, []);
  assert.deepEqual(m2.queue.map((q) => [q.id, q.held]), [["q1", true]]);
});

test("中断记录写好了、标记没来得及换就又被结束 → 再恢复一次不重复", () => {
  reset();
  fs.writeFileSync(MARK, JSON.stringify(mark));
  Q.recoverRunMark();
  fs.writeFileSync(MARK, JSON.stringify(mark));         // 当作标记还是旧的
  Q.QUEUE.length = 0;                                   // 新进程：队列从标记来，中断记录从文件来
  Q.recoverRunMark();
  assert.deepEqual(Q.INTERRUPTED.map((e) => e.id), ["x1"]);
  assert.deepEqual(Q.QUEUE.map((q) => q.id), ["q1"]);
});

test("两条不同的未建会话中断记录互不覆盖（#149-2 同一口径）", () => {
  reset();
  fs.writeFileSync(MARK, JSON.stringify({ runs: [{ id: "a", text: "一", startedAt: 1 }], queue: [] }));
  Q.recoverRunMark();
  fs.writeFileSync(MARK, JSON.stringify({ runs: [{ id: "b", text: "二", startedAt: 2 }], queue: [] }));
  Q.recoverRunMark();
  assert.deepEqual(Q.INTERRUPTED.map((e) => e.id), ["a", "b"]);
  assert.equal(fs.existsSync(MARK), false);
});

test("标记坏了 → 留底成 .bad-*，不当没有", () => {
  reset();
  fs.writeFileSync(MARK, "{\"runs\":[");
  Q.recoverRunMark();
  assert.equal(fs.existsSync(MARK), false);
  const bads = fs.readdirSync(CFG.home).filter((n) => n.startsWith("ccapp-run-mark.json.bad-"));
  assert.ok(bads.length >= 1);
  for (const b of bads) fs.rmSync(path.join(CFG.home, b));
});

test("195-AA.5：运行标记带上重发要用的参数和定时任务身份；长提问存到 64K 并标出截断", async () => {
  reset();
  const { RUNS } = await import("../gw/runs.mjs");
  const long = "长".repeat((64 << 10) + 10);
  RUNS.set("rm-aa5", { id: "rm-aa5", sessionId: null, text: long, startedAt: 5, req: { projectId: "p1", pin: { model: "m" }, permissionMode: "plan" }, sched: { taskId: "t1", runKey: "k" } });
  try {
    assert.equal(Q.saveRunMark(), true);
    const r = JSON.parse(fs.readFileSync(MARK, "utf8")).runs.find((x) => x.id === "rm-aa5");
    assert.equal(r.text.length, 64 << 10); assert.equal(r.textCut, true);
    assert.deepEqual(r.req, { projectId: "p1", pin: { model: "m" }, permissionMode: "plan" });
    assert.deepEqual(r.sched, { taskId: "t1", runKey: "k" });
    RUNS.delete("rm-aa5");
    Q.recoverRunMark();
    const e = Q.INTERRUPTED.find((x) => x.id === "rm-aa5");
    assert.equal(e.req.projectId, "p1"); assert.equal(e.textCut, true); assert.equal(e.sched.taskId, "t1");
  } finally { RUNS.delete("rm-aa5"); }
});

test("195-AA.3：被系统结束的定时任务轮次 → 补记一次失败，接着的对话写回 lastSid；再恢复一次不重复记", async () => {
  reset();
  const { _schedForTest: S } = await import("../gw/sched.mjs");
  const id = "aa3-" + Date.now().toString(36);
  const task = { id, name: "AA3", prompt: "做事", on: true, freq: { kind: "once" }, nextAt: null, busy: "run", session: "same", perm: "read" };
  S.DB.tasks.push(task);
  try {
    const sid = "11111111-2222-4333-8444-555555555555";
    const m = { runs: [{ id: "r-aa3", sessionId: sid, text: "做事", startedAt: 1000, sched: { taskId: id, key: "k1" } },
      { id: "r-trial", text: "试跑", startedAt: 1001, sched: { taskId: id, key: "k2", trial: true } }], queue: [] };
    fs.writeFileSync(MARK, JSON.stringify(m));
    Q.recoverRunMark();
    const mine = () => S.runlog().filter((x) => x.taskId === id);
    assert.equal(mine().length, 1, "试跑不记");
    assert.equal(mine()[0].st, "err");
    assert.equal(mine()[0].runId, "r-aa3");
    assert.equal(mine()[0].at, 1000);
    assert.equal(task.lastSid, sid);
    fs.writeFileSync(MARK, JSON.stringify(m));
    Q.recoverRunMark();
    assert.equal(mine().length, 1, "同一轮不重复记");
  } finally { const i = S.DB.tasks.indexOf(task); if (i >= 0) S.DB.tasks.splice(i, 1); }
});

test("195-A.8：被结束的那轮按标记里拍的底重新封签——只往后追加的照常干净，前面被改的标 edited", async () => {
  reset();
  const { sealSession, checkSession, sessionAnchor } = await import("../gw/integrity.mjs");
  const { PATHS } = await import("../gw/config.mjs");
  const crypto = await import("node:crypto");
  const dir = path.join(PATHS.projects, "-a8"); fs.mkdirSync(dir, { recursive: true });
  const mk = () => { const sid = crypto.randomUUID(), f = path.join(dir, sid + ".jsonl"); fs.writeFileSync(f, JSON.stringify({ type: "user", sessionId: sid, message: { role: "user", content: "一" } }) + "\n"); sealSession(sid, f); return { sid, f, base: sessionAnchor(f) }; };
  const a = mk(), b = mk();
  fs.appendFileSync(a.f, "{\"type\":\"assistant\"}\n");                       // claude 跑到一半写的
  fs.writeFileSync(b.f, fs.readFileSync(b.f, "utf8").replace("一", "壹") + "{\"type\":\"assistant\"}\n");
  fs.writeFileSync(MARK, JSON.stringify({ runs: [{ id: "a8a", sessionId: a.sid, text: "x", startedAt: 1, sealBase: a.base }, { id: "a8b", sessionId: b.sid, text: "y", startedAt: 2, sealBase: b.base }], queue: [] }));
  Q.recoverRunMark();
  assert.equal(checkSession(a.sid, a.f), null, "只追加：不提醒模型");
  assert.equal(checkSession(b.sid, b.f), "edited");
});

test("195-A.11：正常收到 SIGTERM 退出的记 stop，下次启动中断记录带 cause；没打招呼就没了的不带", () => {
  reset();
  fs.writeFileSync(MARK, JSON.stringify({ stop: true, runs: [{ id: "a11a", text: "x", startedAt: 1 }], queue: [] }));
  Q.recoverRunMark();
  assert.equal(Q.INTERRUPTED.find((e) => e.id === "a11a").cause, "stop");
  reset();
  fs.writeFileSync(MARK, JSON.stringify({ runs: [{ id: "a11b", text: "x", startedAt: 1 }], queue: [] }));
  Q.recoverRunMark();
  assert.equal(Q.INTERRUPTED.find((e) => e.id === "a11b").cause, undefined);
});

test("195-B.4：待批的写文件请求内容很大 → 给界面的只带前 64K、记下原来的行数；命令不截；小的原样", () => {
  const big = "a\n".repeat(1 << 20);
  const v = Q.permView({ id: "p", tool: "Write", input: { file_path: "/x", content: big } });
  assert.ok(JSON.stringify(v).length < 100 << 10);
  assert.equal(v.inputCut.content.lines, (1 << 20) + 1);
  const cmd = "echo " + "b".repeat(200 << 10);
  assert.equal(Q.permView({ tool: "Bash", input: { command: cmd } }).input.command, cmd, "命令要看全");
  const small = { tool: "Write", input: { file_path: "/y", content: "hi" } };
  assert.equal(Q.permView(small), small);
});

test("195-P.3：还没起进程就被结束的那轮 → 中断记录标 unstarted（界面给「重发」不给「继续」）", () => {
  reset();
  fs.writeFileSync(MARK, JSON.stringify({ runs: [{ id: "p3", sessionId: "s-p3", text: "x", startedAt: 1, unstarted: true }], queue: [] }));
  Q.recoverRunMark();
  assert.equal(Q.INTERRUPTED.find((e) => e.id === "p3").why, "unstarted");
  const src = fs.readFileSync(new URL("../web/app/04-session-flow.js", import.meta.url), "utf8");
  assert.match(src, /cont = !!it\.sessionId && !card && !unstarted/);
});

test("195-P.9：后台任务清零后状态栏不再显示「在跑（0 个）」", () => {
  const src = fs.readFileSync(new URL("../web/app/04-session-flow.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /后台任务在跑（\{n\} 个）", \{ n: (ev|srv\.run)\.bg \|\| 0 \}/);
  assert.match(src, /function idleStatus\(n\) \{ return n > 0 \?/);
});
