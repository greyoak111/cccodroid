// 工作岛核心：状态映射、换轮不误报、中止、确认、节流、中英文
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下，下面一行都不跑
import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorkIsland } from "../gw/work-island-core.mjs";
import { _islandForTest } from "../gw/work-island.mjs";
import { EventEmitter } from "node:events";
import { BOOT, previewWorkIsland, publishWorkIsland, routeBus } from "../gw/bus.mjs";

test("原生工作岛：重连使用当前帧，试播不重放，收起清空快照", async () => {
  async function connect(lastId) {
    const req = Object.assign(new EventEmitter(), { method: "GET", headers: { "last-event-id": lastId } });
    const lines = [];
    await routeBus(req, { writeHead() {}, write(buf) { lines.push(String(buf)); return true; } }, new URL("http://localhost/api/events"), "/api/events");
    const frames = () => lines.flatMap(s => s.split("\n")).filter(s => s.startsWith("data: ")).map(s => JSON.parse(s.slice(6)));
    return { frames, close: () => req.emit("close") };
  }
  const frame = _islandForTest.nativeFrame("UPDATE", "整理清单", "清单 2/5", 1000, "planning", { todoDone: 2, todoTotal: 5, sessionId: "sessionA", confirmation: "plan" }, 2000);
  assert.equal(frame.expires, 1000 + 12 * 3600e3);
  assert.equal(_islandForTest.nativeFrame("DONE", "完成", "", 0, "done", undefined, 2000), null);
  const first = await connect(`${BOOT}.0`);
  try {
    publishWorkIsland(frame);
    previewWorkIsland();
    assert.deepEqual(first.frames().slice(-2), [{ type: "work_island", frame }, { type: "work_island_preview" }]);
    const next = await connect(`${BOOT}.0`);
    try {
      assert.deepEqual(next.frames().at(-1), { type: "sync", workIsland: frame, workIslandMode: false });
      assert.ok(!next.frames().some(e => e.type === "work_island_preview"));
      publishWorkIsland(_islandForTest.nativeFrame("IDLE"));
      assert.deepEqual(next.frames().at(-1), { type: "work_island", frame: null });
    } finally { next.close(); }
  } finally { first.close(); publishWorkIsland(null); }
});

test("ColorOS 仍用原来的前台服务", () => {
  const { amArgs } = _islandForTest;
  assert.deepEqual(amArgs("IDLE", undefined, undefined, undefined, undefined, undefined, "com.dafeiyu.workisland"), [
    "start-foreground-service", "--user", "0", "-n", "com.dafeiyu.workisland/.IslandService",
    "-a", "com.dafeiyu.workisland.IDLE",
  ]);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function make(opts = {}) {
  const sent = [];
  let runs = [];
  const core = createWorkIsland({
    send: (action, title, text, since, state, extra) => sent.push({ action, title, text, since, state, extra }),
    runs: () => runs,
    lang: () => "zh",
    graceMs: 20,
    idleMs: 30,
    throttleMs: 0,
    ...opts,
  });
  return { core, sent, setRuns: (r) => { runs = r; } };
}

test("开始与工具：先「正在干活」，再跟着 tool_use 变", () => {
  const { core, sent } = make();
  core.handleEvent({ type: "run_start", startedAt: Date.now() });
  assert.equal(sent.at(-1).action, "UPDATE");
  assert.equal(sent.at(-1).title, "正在干活");
  assert.equal(sent.at(-1).text, "正在处理…");
  core.handleEvent({ type: "tool_use", name: "Read" });
  assert.equal(sent.at(-1).title, "读文件");
  assert.equal(sent.at(-1).text, "用 读文件…");
  assert.equal(sent.at(-1).state, "reading");
});

test("清单：TodoWrite 显示已完成/总数", () => {
  const { core, sent } = make();
  core.handleEvent({ type: "run_start", startedAt: Date.now() });
  core.handleEvent({
    type: "tool_use",
    name: "TodoWrite",
    input: {
      todos: [
        { status: "completed" },
        { status: "completed" },
        { status: "pending" },
        { status: "in_progress" },
        { status: "pending" },
      ],
    },
  });
  assert.equal(sent.at(-1).title, "整理清单");
  assert.equal(sent.at(-1).text, "清单 2/5");
  assert.equal(sent.at(-1).state, "planning");
  assert.deepEqual(sent.at(-1).extra, { todoDone: 2, todoTotal: 5 });
});

test("完成：任务完成 + 用时，8 秒后收起", async () => {
  const { core, sent, setRuns } = make();
  core.handleEvent({ type: "run_start", startedAt: Date.now() });
  setRuns([]);
  core.handleEvent({ type: "run_end" });
  await sleep(40);
  const done = sent.find((x) => x.action === "DONE");
  assert.ok(done, "应发 DONE");
  assert.equal(done.title, "任务完成");
  assert.equal(done.state, "done");
  assert.match(done.text, /^用时 /);
  await sleep(50);
  assert.ok(sent.some((x) => x.action === "IDLE"), "应发 IDLE");
});

test("换轮：另一个轮次还在跑，不报完成", async () => {
  const { core, sent, setRuns } = make();
  core.handleEvent({ type: "run_start", startedAt: Date.now() });
  setRuns([{ id: "r2", startedAt: Date.now() }]);
  core.handleEvent({ type: "run_end", runId: "r1" });
  await sleep(40);
  assert.ok(!sent.some((x) => x.action === "DONE"));
});

test("宽限期内来了新的一轮：取消完成", async () => {
  const { core, sent, setRuns } = make();
  core.handleEvent({ type: "run_start", startedAt: Date.now() });
  setRuns([]);
  core.handleEvent({ type: "run_end" });
  await sleep(5);
  core.handleEvent({ type: "run_start", startedAt: Date.now() });
  await sleep(50);
  assert.ok(!sent.some((x) => x.action === "DONE"));
});

test("中止：完成文案带「已中止」", async () => {
  const { core, sent, setRuns } = make();
  core.handleEvent({ type: "run_start", startedAt: Date.now() });
  setRuns([]);
  core.handleEvent({ type: "run_end", aborted: true });
  await sleep(40);
  assert.match(sent.find((x) => x.action === "DONE").text, /已中止/);
});

test("等确认：标题变「等你确认」，文案带工具名", () => {
  const { core, sent } = make();
  core.handleEvent({ type: "run_start", startedAt: Date.now() });
  core.handleEvent({ type: "perm_request", tool: "Bash" });
  assert.equal(sent.at(-1).title, "等你确认");
  assert.match(sent.at(-1).text, /执行命令/);
});

test("错误：标题「出错了」，正文固定一句，不转发 message", () => {
  const { core, sent } = make();
  core.handleEvent({ type: "run_start", startedAt: Date.now() });
  core.handleEvent({ type: "error", message: "/secret/path token=abc" });
  assert.equal(sent.at(-1).title, "出错了");
  assert.equal(sent.at(-1).text, "这一轮出错了");
  assert.equal(sent.at(-1).state, "error");
  assert.ok(!JSON.stringify(sent.at(-1)).includes("secret"));
});

test("清单：tasks 事件只数已完成/总数，不带 subject 原文", () => {
  const { core, sent } = make();
  core.handleEvent({ type: "run_start", startedAt: Date.now() });
  core.handleEvent({
    type: "tasks",
    tasks: [
      { status: "completed", subject: "SECRET A", active: "doing secret" },
      { status: "completed", subject: "SECRET B" },
      { status: "in_progress", subject: "SECRET C" },
    ],
  });
  assert.equal(sent.at(-1).title, "整理清单");
  assert.equal(sent.at(-1).text, "清单 2/3");
  assert.equal(sent.at(-1).state, "planning");
  assert.deepEqual(sent.at(-1).extra, { todoDone: 2, todoTotal: 3 });
  assert.ok(!JSON.stringify(sent.at(-1)).includes("SECRET"));
});

test("普通工具更新不带清单 extras", () => {
  const { core, sent } = make();
  core.handleEvent({ type: "run_start", startedAt: Date.now() });
  core.handleEvent({ type: "tool_use", name: "Read" });
  assert.equal(sent.at(-1).extra, undefined);
});

test("清单清空：tasks 为 null 时不报错也不改岛", () => {
  const { core, sent } = make();
  core.handleEvent({ type: "run_start", startedAt: Date.now() });
  const before = sent.length;
  core.handleEvent({ type: "tasks", tasks: null });
  assert.equal(sent.length, before);
});

test("TaskUpdate：归到整理清单 / planning", () => {
  const { core, sent } = make();
  core.handleEvent({ type: "run_start", startedAt: Date.now() });
  core.handleEvent({ type: "tool_use", name: "TaskUpdate" });
  assert.equal(sent.at(-1).title, "整理清单");
  assert.equal(sent.at(-1).state, "planning");
});

test("MCP 长工具名：不原样上岛，显示「调用工具」", () => {
  const { core, sent } = make();
  core.handleEvent({ type: "run_start", startedAt: Date.now() });
  core.handleEvent({ type: "tool_use", name: "mcp__device__notify" });
  assert.equal(sent.at(-1).title, "调用工具");
  assert.equal(sent.at(-1).text, "调用工具…");
  assert.equal(sent.at(-1).state, "working");
});

test("英文：认不出的工具显示 Using a tool", () => {
  const { core, sent } = make({ lang: () => "en" });
  core.handleEvent({ type: "run_start", startedAt: Date.now() });
  core.handleEvent({ type: "tool_use", name: "mcp__device__notify" });
  assert.equal(sent.at(-1).title, "Using a tool");
  assert.equal(sent.at(-1).text, "Using a tool…");
});

test("英文：Working / Using a command…", () => {
  const { core, sent } = make({ lang: () => "en" });
  core.handleEvent({ type: "run_start", startedAt: Date.now() });
  assert.equal(sent.at(-1).title, "Working");
  core.handleEvent({ type: "tool_use", name: "Bash" });
  assert.equal(sent.at(-1).title, "Running");
  assert.equal(sent.at(-1).text, "Using a command…");
  assert.equal(sent.at(-1).state, "running");
});

test("节流：一秒半内只发一条，补发最后那条", async () => {
  const { core, sent } = make({ throttleMs: 50 });
  core.handleEvent({ type: "run_start", startedAt: Date.now() });
  sent.length = 0;                       // 忽略 start 那一条
  core.handleEvent({ type: "phase", phase: "think" });
  core.handleEvent({ type: "phase", phase: "text" });
  assert.equal(sent.length, 0, "节流窗口内不应发");
  await sleep(70);
  assert.equal(sent.length, 1, "应补发一条");
  assert.equal(sent[0].text, "正在写回复…", "补发的是最后那条");
});

test("关掉开关：有活动时发一次 IDLE", () => {
  const { core, sent } = make();
  core.handleEvent({ type: "run_start", startedAt: Date.now() });
  sent.length = 0;
  core.stop();
  assert.equal(sent.at(-1).action, "IDLE");
});

test("关掉开关：没有活动时不发", () => {
  const { core, sent } = make();
  core.stop();
  assert.equal(sent.length, 0);
});

test("关掉开关：「任务完成」还挂着（没到收起时间）也发 IDLE，收起后不再发", async () => {
  const { core, sent, setRuns } = make({ idleMs: 200 });
  core.handleEvent({ type: "run_start", startedAt: Date.now() });
  setRuns([]);
  core.handleEvent({ type: "run_end" });
  await sleep(40);
  assert.equal(sent.at(-1).action, "DONE");
  core.stop();
  assert.equal(sent.at(-1).action, "IDLE", "DONE 还在岛上时关掉应收起");
  sent.length = 0;
  core.stop();
  assert.equal(sent.length, 0, "已经收起就不重复发");
});

test("子任务：不转发描述原文", () => {
  const { core, sent } = make();
  core.handleEvent({ type: "run_start", startedAt: Date.now() });
  core.handleEvent({ type: "sub_progress", desc: "读 /sdcard/私密/日记.md" });
  assert.equal(sent.at(-1).text, "子任务…");
  assert.ok(!sent.some((x) => String(x.text).includes("日记")));
});


test("原生工作岛：并行确认不串会话，保留真实清单，完成立即撤岛", () => {
  const { core, sent, setRuns } = make({ rich: true });
  const a = { id: "a", sessionId: "sA", perms: new Map() };
  const b = { id: "b", sessionId: "sB", perms: new Map() };
  setRuns([a, b]);
  core.handleEvent({ type: "run_start", runId: a.id, sessionId: a.sessionId });
  core.handleEvent({ type: "tasks", sessionId: a.sessionId, tasks: [{ status: "completed" }, { status: "pending" }] });
  core.handleEvent({ type: "phase", runId: a.id, phase: "text" });
  assert.equal(sent.at(-1).extra.todoDone, 1);
  assert.equal(sent.at(-1).extra.todoTotal, 2);
  b.perms.set("p", { tool: "ExitPlanMode", sessionId: b.sessionId, input: { plan: "private" } });
  core.handleEvent({ type: "perm_request", runId: b.id, sessionId: b.sessionId, tool: "ExitPlanMode" });
  assert.equal(sent.at(-1).extra.sessionId, b.sessionId);
  assert.equal(sent.at(-1).extra.confirmation, "plan");
  assert.equal(sent.at(-1).extra.todoTotal, undefined);
  assert.ok(!JSON.stringify(sent.at(-1)).includes("private"));
  b.perms.clear();
  core.handleEvent({ type: "perm_resolved", runId: b.id });
  assert.equal(sent.at(-1).extra.sessionId, a.sessionId);
  assert.equal(sent.at(-1).extra.todoTotal, 2);
  core.handleEvent({ type: "tasks", sessionId: a.sessionId, tasks: null });
  core.handleEvent({ type: "phase", runId: a.id, phase: "text" });
  assert.equal(sent.at(-1).extra.todoTotal, undefined);
  setRuns([b]);
  core.handleEvent({ type: "run_end", runId: a.id });
  assert.equal(sent.at(-1).extra.sessionId, b.sessionId);
  setRuns([]);
  core.handleEvent({ type: "run_end", runId: b.id });
  assert.equal(sent.at(-1).action, "IDLE");
});
