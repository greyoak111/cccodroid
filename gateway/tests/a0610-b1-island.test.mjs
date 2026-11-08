// 工作岛：并行轮次计时、打开时已有待确认、强制收起（0.6.9 审计 195-P.1/P.5）
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorkIsland } from "../gw/work-island-core.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function make(opts = {}) {
  const sent = [];
  let runs = [];
  let now = 1000;
  const core = createWorkIsland({
    send: (action, title, text, since, state, extra) => sent.push({ action, title, text, since, state, extra }),
    sendSync: (action, title, text, since, state, extra) => sent.push({ action, title, text, since, state, extra, sync: true }),
    runs: () => runs,
    lang: () => "zh",
    clock: () => now,
    graceMs: 0,
    idleMs: 30,
    throttleMs: 0,
    ...opts,
  });
  return { core, sent, setRuns: (r) => { runs = r; }, setNow: (t) => { now = t; } };
}

test("并行会话换到另一轮：用时按当前这一轮算（195-P.5）", async () => {
  const { core, sent, setRuns, setNow } = make();
  core.handleEvent({ type: "state", run: { id: "A", startedAt: 1000 } });
  setNow(5000);
  core.handleEvent({ type: "state", run: { id: "B", startedAt: 5000 } });
  setRuns([]);
  core.handleEvent({ type: "run_end" });
  await sleep(20);
  const done = sent.filter((x) => x.action === "DONE").at(-1);
  assert.ok(done, "应发 DONE");
  assert.match(done.text, /用时 0 秒/);
});

test("打开时已经有待确认的请求：显示等你确认（195-P.5）", () => {
  const { core, sent } = make();
  core.handleEvent({ type: "state", run: { id: "A", startedAt: 1000, perms: new Map([["x", {}]]) } });
  const last = sent.at(-1);
  assert.equal(last.title, "等你确认");
  assert.equal(last.state, "waiting");
});

test("state 快照里出现待确认：从正在干活改成等你确认（195-P.5）", () => {
  const { core, sent } = make();
  core.handleEvent({ type: "state", run: { id: "A", startedAt: 1000 } });
  assert.equal(sent.at(-1).state, "working");
  core.handleEvent({ type: "state", run: { id: "A", startedAt: 1000, perms: new Map([["x", {}]]) } });
  assert.equal(sent.at(-1).state, "waiting");
});

test("强制收起：这一进程里没显示过也发 IDLE（195-P.1）", () => {
  const { core, sent } = make();
  core.stop(true, true);
  assert.equal(sent.at(-1).action, "IDLE");
});
