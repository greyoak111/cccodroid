// v0.6.2 审查 #120：撤销 follow 链中间项后仍续原会话；空闲进程复用前核对执行配置
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CFG } from "../gw/config.mjs";

const { QUEUE, RUN_LANE, RUN_SESSIONS, enqueue, saveRunMark, sidForItem } = await import("../gw/queue.mjs");
const { pickProvider, execIntent } = await import("../gw/run.mjs");
const { RUNS, maxParallel } = await import("../gw/runs.mjs");
const { setSessModel, clearSessModel } = await import("../gw/sessmodel.mjs");

const RUN_MARK = path.join(CFG.home, "ccapp-run-mark.json");
const fake = [];
let n = 0;
// 占满并行槽：入队的条目只留在队列里，pump 不会真的起 claude
const fill = () => {
  while (RUNS.size < maxParallel()) {
    const id = "v062q-busy" + (++n);
    fake.push(id);
    RUNS.set(id, { id, text: "", startedAt: Date.now(), log: [], idle: false, ended: false, lane: "x:" + id });
  }
};
after(() => {
  for (const id of fake) { RUNS.delete(id); RUN_LANE.delete(id); }
  try { fs.rmSync(RUN_MARK, { force: true }); } catch {}
});
const dropQ = (it) => { const i = QUEUE.indexOf(it); if (i >= 0) QUEUE.splice(i, 1); };

test("撤销 follow 链中间的排队项：后面的消息仍续首条跑出来的会话（#120-1）", () => {
  fill();
  const S = crypto.randomUUID();
  const rA = "v062q-rA";
  RUNS.set(rA, { id: rA, text: "", startedAt: Date.now(), log: [], sessionId: S, idle: false, ended: false, lane: "n:" + rA });
  RUN_LANE.set(rA, "n:" + rA);
  RUN_SESSIONS.set(rA, S);
  let B, C;
  try {
    B = enqueue({ message: "B", follow: rA });
    assert.ok(QUEUE.includes(B), "A 还在跑，B 留在队列里");
    assert.equal(B.lane, "n:" + rA);
    C = enqueue({ message: "C", follow: B.id });
    assert.equal(C.lane, "n:" + rA, "C 经由 B 认到首条的车道");
    // 用户撤掉 B：B 从没启动，RUN_SESSIONS 里没有它
    dropQ(B);
    assert.equal(RUN_SESSIONS.get(B.id), undefined);
    assert.equal(sidForItem(C), S, "车道里还记着首条跑出来的会话");
    assert.equal(pickProvider(C).sid0, S, "选接口/模型时也按这个会话算");
    // 落盘时补实会话号：重启后接得上
    saveRunMark();
    const m = JSON.parse(fs.readFileSync(RUN_MARK, "utf8"));
    assert.equal(m.queue.find((q) => q.id === C.id)?.sessionId, S);
  } finally {
    if (B) dropQ(B);
    if (C) dropQ(C);
    RUNS.delete(rA); RUN_LANE.delete(rA); RUN_SESSIONS.delete(rA);
  }
});

test("空闲进程复用前核对执行配置：换了模型就不再自动塞进旧进程（#120-2）", () => {
  fill();
  const sid = crypto.randomUUID();
  // 用 claude- 开头的名字：原生接口会把别家的名字滤掉，那样换没换模型看起来都一样
  setSessModel(sid, { model: "claude-v062-a" });
  const intent = execIntent({ sessionId: sid });
  let injected = 0;
  const runId = "v062q-idle";
  RUNS.set(runId, {
    id: runId, text: "", startedAt: Date.now(), log: [], sessionId: sid, idle: true, ended: false, inputOpen: true,
    lane: "s:" + sid, provider: intent.P.id, exec: { provider: intent.P.id, model: intent.model, effort: intent.effort },
    inject: () => { injected++; return true; }, pendingInject: [],
  });
  RUN_LANE.set(runId, "s:" + sid);
  let B, C;
  try {
    B = enqueue({ message: "照旧", sessionId: sid });
    assert.equal(B.injected, true, "配置没变：按原样插进空闲的后台轮次");
    assert.equal(injected, 1);
    // 面板里换模型并保存成功：下一条必须按新配置走，不能悄悄交给旧进程
    setSessModel(sid, { model: "claude-v062-b" });
    C = enqueue({ message: "换过的", sessionId: sid });
    assert.equal(!!C.injected, false);
    assert.equal(injected, 1, "旧进程没有收到新消息");
    assert.ok(QUEUE.includes(C), "照常排队，等这一轮结束按新配置起进程");
  } finally {
    if (B) dropQ(B);
    if (C) dropQ(C);
    RUNS.delete(runId); RUN_LANE.delete(runId);
    clearSessModel(sid);
  }
});

test("没记下执行配置的轮次不自动复用（#120-2）", () => {
  fill();
  const sid = crypto.randomUUID();
  let injected = 0;
  const runId = "v062q-old";
  RUNS.set(runId, {
    id: runId, text: "", startedAt: Date.now(), log: [], sessionId: sid, idle: true, ended: false, inputOpen: true,
    lane: "s:" + sid, provider: "x", inject: () => { injected++; return true; }, pendingInject: [],
  });
  RUN_LANE.set(runId, "s:" + sid);
  let it;
  try {
    it = enqueue({ message: "普通消息", sessionId: sid });
    assert.equal(!!it.injected, false);
    assert.equal(injected, 0);
    assert.ok(QUEUE.includes(it));
  } finally {
    if (it) dropQ(it);
    RUNS.delete(runId); RUN_LANE.delete(runId);
  }
});

test("显式插话也核对执行配置：换了模型就不再塞进旧进程（#120-2）", () => {
  fill();
  const sid = crypto.randomUUID();
  setSessModel(sid, { model: "claude-v062-c" });
  const intent = execIntent({ sessionId: sid });
  let injected = 0;
  const runId = "v062q-inject";
  RUNS.set(runId, {
    id: runId, text: "", startedAt: Date.now(), log: [], sessionId: sid, idle: true, ended: false, inputOpen: true,
    lane: "s:" + sid, provider: intent.P.id, exec: { provider: intent.P.id, model: intent.model, effort: intent.effort },
    inject: () => { injected++; return true; }, pendingInject: [],
  });
  RUN_LANE.set(runId, "s:" + sid);
  let B, C;
  try {
    B = enqueue({ message: "插话", sessionId: sid, mode: "inject" });
    assert.equal(B.injected, true, "配置没变：照常插进当前轮次");
    assert.equal(injected, 1);
    setSessModel(sid, { model: "claude-v062-d" });
    C = enqueue({ message: "换过模型再插话", sessionId: sid, mode: "inject" });
    assert.equal(!!C.injected, false, "配置变了：不能塞进旧进程");
    assert.equal(injected, 1);
    assert.ok(QUEUE.includes(C), "排到队首，等这一轮结束按新配置起进程");
  } finally {
    if (B) dropQ(B);
    if (C) dropQ(C);
    RUNS.delete(runId); RUN_LANE.delete(runId);
    clearSessModel(sid);
  }
});
