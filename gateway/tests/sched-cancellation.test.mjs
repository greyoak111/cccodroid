// 只在 scripts/test.mjs 的临时 home 下跑；独立子目录隔离任务、运行记录和队列标记。
import { test, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

if (process.env.CCAPP_TEST !== "1" || !process.env.CCAPP_HOME) throw new Error("请用隔离测试 runner");
const home = fs.mkdtempSync(path.join(process.env.CCAPP_HOME, "sched-cancel-"));
process.env.CCAPP_HOME = process.env.HOME = home;
after(() => fs.rmSync(home, { recursive: true, force: true }));
const { _schedForTest: S, routeSched } = await import("../gw/sched.mjs");
const { QUEUE, START_GUARDS, END_HOOKS, holdLane, routeQueue } = await import("../gw/queue.mjs");
const { RUNS, maxParallel } = await import("../gw/runs.mjs");

let seq = 0;
const mk = (over = {}) => {
  const task = { id: `bs-${++seq}`, name: "取消回归", prompt: "合成任务", freq: { kind: "daily" },
    on: true, nextAt: null, busy: "run", retry: 1, session: "new", notify: "none", ...over };
  S.DB.tasks.push(task); return task;
};
beforeEach((t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  S.DB.allowLogin = true;
  // 基线即便错误地放行也没有空槽触发 startRun；不连模型、设备或其他服务。
  for (let i = 0; i < maxParallel(); i++) {
    const id = "bs-slot-" + i;
    RUNS.set(id, { id, text: "fixture", startedAt: Date.now(), log: [], lane: "x:" + i });
  }
});
afterEach(() => {
  QUEUE.length = 0; RUNS.clear(); S.DB.tasks.length = 0; S.DB.missed.length = 0;
  S.running(); // 清掉已移出队列、也没跑收尾的测试上下文
});

// 直接走真的路由和 JSON 体解析，不开 HTTP 监听、也不动真实队列。
async function call(route, method, p, body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]); req.method = method; req.headers = {};
  let code, result;
  const res = { writeHead: (c) => { code = c; }, end: (b) => { result = JSON.parse(b); } };
  await route(req, res, new URL(p, "http://fixture.invalid"), p);
  assert.equal(code, 200); assert.equal(result.ok, true);
  return result;
}
const pause = (task, mode) => call(routeSched, "POST", `/api/sched/${task.id}/pause`, { mode });
const toggle = (task, on) => call(routeSched, "PATCH", `/api/sched/${task.id}`, { on });
const items = (task) => QUEUE.filter((q) => q.sched?.taskId === task.id);
const allowed = (q) => START_GUARDS.every((g) => g(q) !== false);
const last = (task) => S.runlog().filter((r) => r.taskId === task.id).at(-1);
async function queued(task, opts) {
  const q = await S.fire(task, opts);
  assert.ok(q && items(task).includes(q), "前提：条目只在队列里");
  return q;
}
// 模拟 pump 在守卫通过后把条目交给 run，以及之后 END_HOOKS 收尾；不调用真实 startRun。
function start(q) {
  assert.ok(QUEUE.includes(q)); assert.ok(allowed(q));
  QUEUE.splice(QUEUE.indexOf(q), 1);
  const run = { id: q.id, sched: q.sched, text: q.message, startedAt: Date.now(), log: [], denied: [] };
  RUNS.set(run.id, run); return run;
}
function finish(run, fields = { failed: true, finalText: "合成网络故障" }) {
  for (const hook of END_HOOKS) hook(run, fields);
  RUNS.delete(run.id);
}

for (const mode of ["1d", "1w"]) {
  test(`到点忙等后暂停 ${mode}：下次轮询记跳过，不入队`, async (t) => {
    const task = mk({ busy: "queue" });
    const going = S.fire(task);
    assert.ok(S.running().some((r) => r.taskId === task.id && r.waiting));
    await pause(task, mode);
    t.mock.timers.tick(30_000);
    await new Promise((r) => setImmediate(r)); // 醒来的 fireNow 和 fire 的 finally 都走完，不依赖微任务层数
    assert.ok(!S.running().some((r) => r.taskId === task.id), "不能在暂停后继续等到下一个轮询");
    assert.equal(await going, undefined); assert.equal(items(task).length, 0); assert.equal(last(task)?.st, "skip");
  });
  test(`已入队的到点项遇到暂停 ${mode}：起跑守卫拒绝`, async () => {
    const task = mk(), q = await queued(task);
    await pause(task, mode);
    assert.equal(allowed(q), false); assert.equal(last(task)?.st, "skip");
  });
}
for (const [label, cancel, resume] of [
  ["关闭再打开", (task) => toggle(task, false), (task) => toggle(task, true)],
  ["暂停再解除", (task) => pause(task, "1d"), (task) => pause(task, "none")],
]) {
  test(`${label}：不复活未送达的旧到点项，也不误伤新到点项`, async () => {
    const task = mk(), old = await queued(task);
    await cancel(task); await resume(task);
    assert.equal(task.on, true); assert.ok(!task.pausedUntil);
    assert.equal(allowed(old), false); assert.equal(last(task)?.st, "skip");
    assert.equal(allowed(await queued(task)), true);
  });
  test(`运行中${label}：旧轮收尾仍记账，不给它重试`, async () => {
    const task = mk(), run = start(await queued(task));
    await cancel(task); await resume(task);
    finish(run, { failed: true, costRaw: 0.125, finalText: "合成故障" });
    assert.equal(task.runsDone, 1); assert.equal(last(task)?.cost, 0.125); assert.equal(last(task)?.st, "err");
    assert.equal(S.hasRetry(task.id), false);
  });
}

test("暂停时手动试跑、关闭时立刻跑：保留单次投递，不偷偷变成自动重试", async () => {
  for (const trial of [true, false]) {
    const task = mk();
    if (trial) await pause(task, "1w"); else await toggle(task, false);
    const r = await call(routeSched, "POST", `/api/sched/${task.id}/run`, { trial });
    const q = items(task).find((it) => it.id === r.id); assert.ok(q);
    finish(start(q));
    assert.equal(task.runsDone || 0, trial ? 0 : 1); assert.equal(S.hasRetry(task.id), false);
  }
});

test("重启后挂起的旧队列项：人选择放行可跑，任务关着不续自动重试", async () => {
  const task = mk(); await toggle(task, false);
  // restoreQueue 的形状；故意没有本进程的 RUNNING 上下文。
  const q = { id: "bs-restored", message: task.prompt, held: true, intr: true, sched: { taskId: task.id, key: "bs-restored-key" } };
  QUEUE.push(q);
  await call(routeQueue, "POST", "/api/queue/promote", { id: q.id });
  assert.equal(q.held, false);
  finish(start(q));
  assert.equal(task.runsDone, 1); assert.equal(S.hasRetry(task.id), false);
});

test("同一进程的挂起项：明确解除挂起可跑，普通提到队首不复活旧到点项", async () => {
  for (const held of [false, true]) {
    const task = mk(), q = await queued(task);
    if (held) { holdLane({ lane: q.lane }); assert.equal(q.held, true); }
    await pause(task, "1w");
    await call(routeQueue, "POST", "/api/queue/promote", { id: q.id });
    assert.equal(q.held, false);
    assert.equal(allowed(q), held);
  }
});

test("自动补跑遇暂停要拦，人选择错过卡片补跑仍可投递", async () => {
  const task = mk(), old = await queued(task, { reason: "missed" });
  await pause(task, "1d");
  assert.equal(allowed(old), false); QUEUE.splice(QUEUE.indexOf(old), 1);
  const at = Date.now() - 3600e3; S.DB.missed.push({ taskId: task.id, at });
  await call(routeSched, "POST", "/api/sched/missed", { taskId: task.id, at, act: "run" });
  const [chosen] = items(task); assert.ok(chosen); assert.equal(allowed(chosen), true);
});

test("用户主动停止：不因 aborted 重排，也撤销同任务尚未投递的重试定时器", async (t) => {
  const task = mk(); finish(start(await queued(task)));
  assert.equal(S.hasRetry(task.id), true, "前提：普通故障先排了一次重试");
  const run = start(await queued(task)); run.aborted = true; run.userStopped = true;
  finish(run, {});
  assert.equal(last(task)?.st, "err"); assert.equal(S.hasRetry(task.id), false);
  t.mock.timers.tick(120_000); assert.equal(items(task).length, 0);
});

test("手动停止时，已经在队列里的同任务重试也不抢跑", async (t) => {
  const task = mk();
  finish(start(await queued(task)));
  const run = start(await queued(task, { reason: "manual" }));
  t.mock.timers.tick(120_000); await Promise.resolve();
  const [retry] = items(task); assert.ok(retry);
  run.userStopped = true;
  finish(run, {});
  assert.equal(allowed(retry), false);
  assert.equal(S.hasRetry(task.id), false);
  assert.equal(allowed(await queued(task)), true, "下一次正常计划不受影响");
});

test("仅时长 / 内部 aborted，不是主动停止：仍按原设置重试", async () => {
  for (const flags of [{ aborted: true, timedOut: true }, { aborted: true }]) {
    const task = mk(), run = start(await queued(task)); Object.assign(run, flags);
    finish(run, {});
    assert.equal(last(task)?.st, "err"); assert.equal(S.hasRetry(task.id), true);
    await toggle(task, false); assert.equal(S.hasRetry(task.id), false);
  }
});

for (const [label, over] of [["once", { freq: { kind: "once" } }], ["count", { until: { kind: "count", count: 1 } }]]) {
  test(`${label} 因本轮收尾自动关闭：普通故障的两次重试都可投递，随后封顶`, async (t) => {
    const task = mk({ ...over, retry: 2 }); finish(start(await queued(task)));
    for (let n = 1; n <= 2; n++) {
      assert.equal(task.on, false); assert.equal(S.hasRetry(task.id), true);
      t.mock.timers.tick(120_000); await Promise.resolve();
      const qs = items(task); assert.equal(qs.length, 1);
      finish(start(qs[0])); assert.equal(last(task)?.attempt, n);
    }
    assert.equal(S.hasRetry(task.id), false);
  });
}

test("续同一会话：目录短时读错则保留原会话，确认缺失才允许新开", async () => {
  const { PATHS } = await import("../gw/config.mjs");
  const folder = path.join(PATHS.projects, "test-sched-same"); fs.mkdirSync(folder, { recursive: true });
  const sid = "01234567-9876-4321-abcd-123456789abc", file = path.join(folder, sid + ".jsonl");
  fs.writeFileSync(file, "{}\n");
  const task = mk({ session: "same", lastSid: sid });
  const readdir = fs.readdirSync;
  try {
    fs.readdirSync = function(p, ...args) { if (p === PATHS.projects) throw Object.assign(new Error("fixture read unavailable"), { code: "EIO" }); return readdir.call(this, p, ...args); };
    assert.equal(await S.fire(task), undefined); assert.equal(items(task).length, 0); assert.equal(task.lastSid, sid); assert.equal(last(task)?.st, "skip");
  } finally { fs.readdirSync = readdir; }
  const recovered = await queued(task); assert.equal(recovered.sessionId, sid);
  fs.unlinkSync(file);
  const without = mk({ session: "same", lastSid: sid });
  assert.equal((await queued(without)).sessionId, null); assert.equal(without.lostSid, sid);
});

test("重试 timer 已投递但还没拿到槽：关闭再开启也不能让旧 retry 起跑", async (t) => {
  const task = mk(); finish(start(await queued(task)));
  t.mock.timers.tick(120_000); await Promise.resolve();
  const [retry] = items(task); assert.ok(retry); assert.equal(S.hasRetry(task.id), false);
  await toggle(task, false); await toggle(task, true);
  assert.equal(allowed(retry), false); assert.equal(last(task)?.st, "skip");
});
