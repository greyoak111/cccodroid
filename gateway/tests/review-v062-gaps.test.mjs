// v0.6.2 审查复核补的回归测试：#122-4 命令名预留、#120-4 工具结果跨页保留、#124-1 工作岛开关交错、#123-4 屏幕工具等待时长
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { SETTINGS } from "../gw/settings-store.mjs";

test("命令名在安装途中被预留：别的组件看到 busy，自己不受影响，放掉后可用（#122-4）", async () => {
  const { _customForTest: C } = await import("../gw/custom.mjs");
  const cmd = "zz-v062-reserved";
  assert.equal(C.customCmdClash(cmd, "comp-a"), "");
  C.CMD_RESERVED.set(cmd, "comp-a");
  try {
    assert.equal(C.customCmdClash(cmd, "comp-b"), "busy", "另一个组件装同名命令要被挡住");
    assert.equal(C.customCmdClash(cmd, "comp-a"), "", "占着名字的那个组件自己继续装");
  } finally { C.CMD_RESERVED.delete(cmd); }
  assert.equal(C.customCmdClash(cmd, "comp-b"), "");
});

// 02-chat-view.js 里真实的结果表代码，单独拿出来跑
const chatSrc = fs.readFileSync(new URL("../web/app/02-chat-view.js", import.meta.url), "utf8");
const take = (text, start, end) => { const i = text.indexOf(start), j = text.indexOf(end, i); assert.ok(i >= 0 && j > i, start); return text.slice(i, j); };
function results() {
  const box = { Map, String };
  vm.runInNewContext(take(chatSrc, "  const TOOL_RESULTS = new Map();", "  /** 用户亲手收起") +
    "\nglobalThis.R = { TOOL_RESULTS, rememberResult, clearToolResults, get chars() { return resultChars; } };", box);
  return box.R;
}

test("工具结果单独存：同 id 覆盖、条数和总字数有上限、刚存的最后才丢（#120-4）", () => {
  const R = results();
  R.rememberResult("t1", false, "boom");
  R.rememberResult("t1", true, "ok!!");
  assert.deepEqual({ ...R.TOOL_RESULTS.get("t1") }, { ok: true, text: "ok!!" }, "同 id 后到的为准");
  assert.equal(R.chars, 4, "覆盖时字数不重复计");
  for (let i = 0; i < 2100; i++) R.rememberResult("n" + i, i % 2 === 0, "x");
  assert.equal(R.TOOL_RESULTS.size, 2000, "条数封顶");
  assert.ok(!R.TOOL_RESULTS.has("t1") && R.TOOL_RESULTS.has("n2099"), "先丢最早的");
  assert.equal(R.TOOL_RESULTS.get("n2098").ok, true);
  assert.equal(R.TOOL_RESULTS.get("n2099").ok, false, "失败状态留着");
  R.rememberResult("big", true, "y".repeat(8000001));
  assert.equal(R.TOOL_RESULTS.size, 1, "超总字数：只剩刚存的这一条");
  assert.ok(R.TOOL_RESULTS.has("big"));
  R.clearToolResults();
  assert.equal(R.TOOL_RESULTS.size, 0);
  assert.equal(R.chars, 0);
});

test("卡片重建时把先到的结果贴回去（#120-4）", () => {
  const src = take(chatSrc, "    if (id) {\n      TOOL_CARDS.set(id, api);", "    return api;");
  assert.match(src, /TOOL_RESULTS\.get\(id\)/);
  assert.match(src, /api\.result\(res\.ok, res\.text\)/);
});

test("工作岛：检测途中关掉又打开，旧检测回来不能再装一份（#124-1）", async () => {
  const { _islandForTest: W, startWorkIsland, stopWorkIsland } = await import("../gw/work-island.mjs");
  const pending = [];
  const orig = { ...W.seam }, was = SETTINGS.workIsland;
  W.seam.detect = (cb) => pending.push(cb);
  W.seam.android = () => true;
  SETTINGS.workIsland = true;
  try {
    startWorkIsland();                 // 第一次检测，挂着
    stopWorkIsland();
    startWorkIsland();                 // 第二次检测，挂着
    assert.equal(pending.length, 2);
    pending[1](true);                  // 新的先回来：装上
    const first = W.state().core;
    assert.ok(first && W.state().unsub);
    pending[0](true);                  // 旧的后回来：必须丢掉
    assert.equal(W.state().core, first, "不能换成第二份 core");
    stopWorkIsland();
    assert.equal(W.state().core, null);
    assert.equal(W.state().unsub, null, "关掉后不留订阅");
    startWorkIsland(); stopWorkIsland();
    pending[2](true);                  // 关掉之后才回来的检测
    assert.equal(W.state().core, null, "关着时回来的检测什么也不装");
    assert.equal(W.state().started, false);
  } finally {
    stopWorkIsland();
    Object.assign(W.seam, orig);
    SETTINGS.workIsland = was;
  }
});

test("屏幕工具和剪贴板同档等 70 秒，长于应用那头 60 秒的确认（#123-4）", () => {
  const src = fs.readFileSync(new URL("../../android/assets/bin/device-mcp.mjs", import.meta.url), "utf8");
  const call = take(src, "async function callTool(", "  if (!r.ok)");
  const ask = vm.runInNewContext("(name) => { " + call.match(/const ask = [^;]+;/)[0] + " return ask ? " + call.match(/ask \? (\d+)/)[1] + " : 0; }");
  for (const n of ["screen_read", "screen_tap", "screenshot", "clipboard_read", "clipboard_write", "open"]) assert.equal(ask(n), 70000, n);
  assert.equal(ask("device_status"), 0);
});
