// 0.6.10 第二轮车道移交给主会话的三处后端：额度换算（197-5.7）、中文名技能可删（195-J.5）、队列快照带 sched（197-5.4）
import "../gw/config.mjs";
import "./fixtures/uc-baseline.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { NEXT } from "../gw/http.mjs";

const stream = await import("../gw/stream.mjs");
const { SKILLS_DIR, routeExtensions } = await import("../gw/extensions.mjs");
const { QUEUE, RUN_LANE, enqueue, snapshot } = await import("../gw/queue.mjs");
const { RUNS, maxParallel } = await import("../gw/runs.mjs");

test("订阅额度：utilization 一律按比例换成百分数，超额度显示 120 而不是 1.2", () => {
  const ev = (u5, u7) => ({ type: "rate_limit_event", rate_limit_info: { status: "allowed", unifiedWindows: {
    five_hour: { utilization: u5, resetsAt: 1 }, seven_day: { utilization: u7, resetsAt: 2 } } } });
  const opts = { sse() {}, onInit() {}, onResult() {}, flags: {}, provider: { id: "anthropic", login: true } };
  stream.translate(ev(0.46, 1.2), opts);
  assert.equal(stream.RATE_LIMITS.fiveHour.used, 46);
  assert.equal(stream.RATE_LIMITS.sevenDay.used, 120);
  stream.clearRateLimits();
});

const srv = http.createServer(async (req, res) => { const u = new URL(req.url, "http://x"); if ((await routeExtensions(req, res, u, u.pathname)) === NEXT) res.writeHead(404).end(); });
await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
after(() => srv.close());
const del = async (dir) => (await fetch(`http://127.0.0.1:${srv.address().port}/api/ext/skills/delete`, { method: "POST", body: JSON.stringify({ dir }) })).json();

test("技能：中文 / 带空格的目录名能删；列表里没有的、路径穿越的不删", async () => {
  const name = "我的 技能-" + crypto.randomBytes(3).toString("hex");
  const d = path.join(SKILLS_DIR, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "SKILL.md"), `---\nname: x\ndescription: y\n---\n`);
  const outside = path.join(path.dirname(SKILLS_DIR), "keep-" + crypto.randomBytes(3).toString("hex"));
  fs.mkdirSync(outside, { recursive: true });
  try {
    assert.equal((await del("../" + path.basename(outside))).ok, false);
    assert.ok(fs.existsSync(outside));
    assert.equal((await del("不存在的技能")).ok, false);
    const r = await del(name);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(!fs.existsSync(d));
  } finally { fs.rmSync(d, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
});

test("队列快照：定时任务条目带 sched，普通消息不带", () => {
  // 并行位先占满，两条才会排着（不然 enqueue 当场就发走了）
  const fake = [];
  while (RUNS.size < maxParallel()) { const id = "a0610h-busy" + fake.length; fake.push(id); RUNS.set(id, { id, text: "", startedAt: Date.now(), log: [], idle: false, ended: false, lane: "x:" + id }); }
  const sid = crypto.randomUUID();
  const a = enqueue({ message: "任务", sessionId: sid, internal: true, sched: { taskId: "t1", name: "x" } });
  const b = enqueue({ message: "普通", sessionId: sid });
  try {
    const q = snapshot().queue;
    const qa = q.find((x) => x.id === a.id), qb = q.find((x) => x.id === b.id);
    assert.ok(qa && qb, "两条都排着");
    assert.equal(qa.sched, true);
    assert.equal(qb.sched, undefined);
  } finally {
    for (const id of fake) { RUNS.delete(id); RUN_LANE.delete(id); } for (const it of [a, b]) { const i = QUEUE.indexOf(it); if (i >= 0) QUEUE.splice(i, 1); } }
});
