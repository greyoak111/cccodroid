// ccapp-sched-next 的落盘（0.6.9 审计 13-11）：写失败不能先记账，下一次保存要补写
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs 就在这里拦下
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CFG } from "../gw/config.mjs";
import { _schedForTest } from "../gw/sched.mjs";

const NEXT_FILE = path.join(CFG.home, "ccapp-sched-next");
const SCHED_FILE = path.join(CFG.home, "ccapp-sched.json");

test("写失败不记账，下一次 tick 的保存会补写", () => {
  const at = Date.now() + 3600000;
  const keep = _schedForTest.DB.tasks;
  let before = null;
  try { before = fs.readFileSync(SCHED_FILE); } catch {}
  // 只留这一个未来的任务：tick 不会去跑别的测试留下的到点任务
  _schedForTest.DB.tasks = [{ id: "t-a0610-13-11", name: "落盘重试", prompt: "x", on: true, nextAt: at, freq: { kind: "once" } }];
  fs.rmSync(NEXT_FILE, { recursive: true, force: true });
  fs.mkdirSync(NEXT_FILE);          // 同名目录：writeAtomic 的 rename 必然失败
  try {
    _schedForTest.tick();
    assert.equal(fs.statSync(NEXT_FILE).isDirectory(), true, "这拍确实没写上");
    fs.rmdirSync(NEXT_FILE);
    _schedForTest.tick();           // 再来一拍：上次没记上，这次要写进去
    assert.equal(fs.readFileSync(NEXT_FILE, "utf8").trim(), String(at));
  } finally {
    _schedForTest.DB.tasks = keep;
    if (before != null) fs.writeFileSync(SCHED_FILE, before); else fs.rmSync(SCHED_FILE, { force: true });
    fs.rmSync(NEXT_FILE, { recursive: true, force: true });
  }
});
