// FIND-040：中断卡被忽略 / 清掉后，半截回复也要有持久的「没跑完」标记
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CFG } from "../gw/config.mjs";
import { clearIncomplete, incompleteItem, incompleteOf, markIncomplete } from "../gw/incomplete.mjs";
import * as Q from "../gw/queue.mjs";
import { RUNS, TRASH_HOOKS } from "../gw/runs.mjs";

const MARK = path.join(CFG.home, "ccapp-run-mark.json"), INTR = path.join(CFG.home, "ccapp-interrupted.json");
const FILE = path.join(CFG.home, "ccapp-incomplete.json");
const reset = () => { RUNS.clear(); Q.QUEUE.length = 0; fs.rmSync(INTR, { recursive: true, force: true }); fs.rmSync(MARK, { recursive: true, force: true }); clearIncomplete("sid-a"); clearIncomplete("sid-b"); };
after(reset);

test("标记会落盘，清掉后不再出现", () => {
  reset();
  assert.equal(incompleteOf("sid-a"), null);
  markIncomplete("sid-a", "r1");
  assert.ok(incompleteOf("sid-a"), "标记在");
  const saved = JSON.parse(fs.readFileSync(FILE, "utf8"));
  assert.equal(saved["sid-a"].runId, "r1", "落盘了");
  clearIncomplete("sid-a");
  assert.equal(incompleteOf("sid-a"), null);
  assert.equal(JSON.parse(fs.readFileSync(FILE, "utf8"))["sid-a"], undefined, "从文件里也删了");
});

test("历史末尾的提示只在这一页读到末尾、且没有正在生成的轮次时挂", () => {
  reset();
  markIncomplete("sid-a", "r1");
  assert.equal(incompleteItem("sid-a", { atEnd: false }), null, "不是末尾不挂");
  assert.equal(incompleteItem("sid-a", { atEnd: true, live: true }), null, "正在生成不挂");
  const it = incompleteItem("sid-a", { atEnd: true });
  assert.equal(it.role, "note");
  assert.equal(it.incomplete, true);
  assert.match(it.text, /没有正常结束/);
  assert.equal(incompleteItem("sid-a", { atEnd: true, live: false })?.incomplete, true);
  clearIncomplete("sid-a");
  assert.equal(incompleteItem("sid-a", { atEnd: true }), null, "清掉后不挂");
});

test("恢复上次的运行标记时，中断的会话补上持久标记（不依赖中断卡还在不在）", () => {
  reset();
  fs.writeFileSync(MARK, JSON.stringify({ runs: [{ id: "x9", sessionId: "sid-b", text: "提问", startedAt: 1 }], queue: [] }));
  Q.recoverRunMark();
  assert.ok(incompleteOf("sid-b"), "恢复后标记在");
  assert.equal(incompleteOf("sid-b").runId, "x9");
});

test("会话进回收站时标记跟着清掉", () => {
  reset();
  markIncomplete("sid-a", "r1");
  for (const h of TRASH_HOOKS) h("sid-a");
  assert.equal(incompleteOf("sid-a"), null);
});
