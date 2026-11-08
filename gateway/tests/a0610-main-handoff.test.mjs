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

test("前端跟上：第三方不计花费提示、线路失配 / 明文 http 警告、定时任务排队标签", () => {
  const src = (f) => fs.readFileSync(new URL("../web/app/" + f, import.meta.url), "utf8");
  const s14 = src("14-projects-sched.js"), s09 = src("09-settings.js"), s11 = src("11-usage.js"), s04 = src("04-session-flow.js");
  assert.match(s14, /id="t-costnote"/);
  assert.match(s14, /pv\.nativeModels/, "按任务实际用的那家判断");
  assert.match(s09, /p\.endpointLost \?/);
  assert.match(s09, /else if \(p\.endpointLost\) body\.endpoint = p\.endpoint/, "只剩一条线路也要把线路存下");
  assert.match(s09, /r\.keyCleared/);
  for (const s of [s09, s11]) assert.match(s, /p\.plainHttp \?/);
  assert.match(s11, /r\.warning/);
  assert.match(s04, /it\.sched \? t\("定时任务"\)/);
});

test("分模型周额度：成为最紧窗口时记下，之后的事件不报它也留着，过了重置时间才丢", () => {
  const opts = { sse() {}, onInit() {}, onResult() {}, flags: {}, provider: { id: "anthropic", login: true } };
  const fut = Math.floor(Date.now() / 1000) + 86400, past = Math.floor(Date.now() / 1000) - 10;
  const ev = (top) => ({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", ...top, unifiedWindows: {
    five_hour: { utilization: 0.1, resetsAt: fut }, seven_day: { utilization: 0.5, resetsAt: fut } } } });
  stream.clearRateLimits();
  stream.translate(ev({ rateLimitType: "seven_day_opus", utilization: 0.92, resetsAt: fut }), opts);
  assert.deepEqual(stream.RATE_LIMITS.modelWeek, { opus: { used: 92, resetsAt: fut } });
  stream.translate(ev({ rateLimitType: "five_hour", utilization: 0.1, resetsAt: fut }), opts);
  assert.equal(stream.RATE_LIMITS.modelWeek.opus.used, 92, "不报它的事件里照样留着");
  stream.translate(ev({ rateLimitType: "seven_day_sonnet", utilization: 0.81, resetsAt: past }), opts);
  stream.translate(ev({ rateLimitType: "seven_day", utilization: 0.5, resetsAt: fut }), opts);
  assert.deepEqual(Object.keys(stream.RATE_LIMITS.modelWeek), ["opus"], "过了重置时间的丢掉");
  stream.clearRateLimits();
  stream.translate(ev({ rateLimitType: "seven_day", utilization: 0.5, resetsAt: fut }), opts);
  assert.equal(stream.RATE_LIMITS.modelWeek, undefined, "没报过就没有这个字段");
  stream.clearRateLimits();
  const s09 = fs.readFileSync(new URL("../web/app/09-settings.js", import.meta.url), "utf8");
  assert.equal((s09.match(/quotaWins\(l\)/g) || []).length, 5, "定义 + 四处额度显示都列出分模型窗口");
});
