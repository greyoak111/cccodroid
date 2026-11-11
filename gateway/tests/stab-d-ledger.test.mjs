// FIND-039/049：有副作用的工具中断后，运行标记里留下「结果未知」的台账；恢复时带进中断记录给界面提示
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CFG } from "../gw/config.mjs";
import * as Q from "../gw/queue.mjs";
import { RUNS } from "../gw/runs.mjs";

const MARK = path.join(CFG.home, "ccapp-run-mark.json"), INTR = path.join(CFG.home, "ccapp-interrupted.json");
const reset = () => { RUNS.clear(); Q.QUEUE.length = 0; fs.rmSync(INTR, { recursive: true, force: true }); fs.rmSync(MARK, { recursive: true, force: true }); Q.setInterrupted([]); };
after(reset);

function fakeRun() {
  return { id: "r-side", sessionId: "sid-side", text: "改一下配置", startedAt: 10, ended: false, log: [], pendingInject: [] };
}
const markOf = () => JSON.parse(fs.readFileSync(MARK, "utf8"));

test("有副作用的工具调用没等到结果时记进运行标记，结果回来就销账", () => {
  reset();
  const run = fakeRun();
  RUNS.set(run.id, run);
  Q.runEmit(run, { type: "tool_use", id: "tu1", name: "Bash", input: { command: "mv a b" } });
  assert.deepEqual(markOf().runs[0].sideTools, ["Bash mv a b"]);
  Q.runEmit(run, { type: "tool_use", id: "tu2", name: "Read", input: { file_path: "/a.txt" } });
  assert.deepEqual(markOf().runs[0].sideTools, ["Bash mv a b"], "只读工具不进台账");
  Q.runEmit(run, { type: "tool_result", id: "tu1", ok: true, text: "ok" });
  assert.equal(markOf().runs[0].sideTools, undefined, "结果回来就销账");
});

test("运行标记写不上时留下可见警告（FIND-041）", () => {
  reset();
  const run = fakeRun();
  RUNS.set(run.id, run);
  fs.mkdirSync(MARK);
  fs.writeFileSync(path.join(MARK, "x"), "x");   // 目标是目录：换名必失败
  assert.equal(Q.saveRunMark(), false);
  assert.ok(Q.snapshot().recoverWarns.some((w) => w.key.includes("运行状态没保存上")));
  fs.rmSync(MARK, { recursive: true, force: true });
});

test("恢复时把没结果的副作用工具带进中断记录；坏值丢掉、条数和长度封顶", () => {
  reset();
  const many = Array.from({ length: 25 }, (_, i) => `Bash cmd-${i}`);
  fs.writeFileSync(MARK, JSON.stringify({ runs: [{ id: "x1", sessionId: null, text: "提问", startedAt: 1, sideTools: [42, "", ...many, "W".repeat(300)] }], queue: [] }));
  Q.recoverRunMark();
  const it = Q.INTERRUPTED.find((e) => e.id === "x1");
  assert.equal(it.sideTools.length, 20, "条数封顶 20");
  assert.ok(it.sideTools.every((s) => typeof s === "string" && s.length <= 200), "非字符串与超长项被处理");
  assert.equal(it.sideTools.at(-1), "W".repeat(200), "超长按 200 字截断");
});
