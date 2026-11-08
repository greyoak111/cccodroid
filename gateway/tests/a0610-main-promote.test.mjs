// 0.6.9 审计 199-7-02：⚡ 插队不能把排着的定时任务 / 无人值守条目塞进别的正在跑的轮次
import "../gw/config.mjs";
import "./fixtures/uc-baseline.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { NEXT } from "../gw/http.mjs";

const { QUEUE, RUN_LANE, enqueue, routeQueue } = await import("../gw/queue.mjs");
const { execIntent } = await import("../gw/run.mjs");
const { RUNS, maxParallel } = await import("../gw/runs.mjs");
const srv = http.createServer(async (req, res) => { const u = new URL(req.url, "http://x"); if ((await routeQueue(req, res, u, u.pathname)) === NEXT) res.writeHead(404).end(); });
await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
const fake = [];
after(() => { srv.close(); for (const id of fake) { RUNS.delete(id); RUN_LANE.delete(id); } });
const post = async (p, b) => { const r = await fetch(`http://127.0.0.1:${srv.address().port}${p}`, { method: "POST", body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };

test("定时任务 / 无人值守条目 ⚡ 插队：不注入别人的轮次，照旧排着", async () => {
  let k = 0;
  while (RUNS.size < maxParallel()) { const id = "a0610p-busy" + (++k); fake.push(id); RUNS.set(id, { id, text: "", startedAt: Date.now(), log: [], idle: false, ended: false, lane: "x:" + id }); }
  const sid = crypto.randomUUID();
  const intent = execIntent({ sessionId: sid });
  let injected = 0;
  const runId = "a0610p-run";
  RUNS.set(runId, {
    id: runId, text: "", startedAt: Date.now(), log: [], sessionId: sid, idle: false, ended: false, inputOpen: true,
    lane: "s:" + sid, provider: intent.P.id, exec: { provider: intent.P.id, model: intent.model, effort: intent.effort },
    inject: () => { injected++; return true; }, pendingInject: [],
  });
  RUN_LANE.set(runId, "s:" + sid); fake.push(runId);
  for (const extra of [{ sched: { taskId: "t1", name: "x" } }, { unattended: true }]) {
    const it = enqueue({ message: "任务正文", sessionId: sid, internal: true, ...extra });
    try {
      assert.ok(QUEUE.includes(it));
      const r = await post("/api/queue/promote", { id: it.id });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(injected, 0, "不能塞进别人的轮次：" + JSON.stringify(extra));
      assert.ok(QUEUE.includes(it), "仍排着");
    } finally { const i = QUEUE.indexOf(it); if (i >= 0) QUEUE.splice(i, 1); }
  }
  // 普通消息照旧能插话
  const it = enqueue({ message: "普通插话", sessionId: sid });
  try { if (QUEUE.includes(it)) await post("/api/queue/promote", { id: it.id }); assert.equal(injected, 1, "普通消息仍可 ⚡"); }
  finally { const i = QUEUE.indexOf(it); if (i >= 0) QUEUE.splice(i, 1); }
});
