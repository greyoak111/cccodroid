// 闹钟带计划时刻：Doze 推迟几分钟仍按到点执行（0.6.9 审计 13-04）
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs 就在这里拦下
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CFG } from "../gw/config.mjs";
import { _schedForTest } from "../gw/sched.mjs";

const SCHED_FILE = path.join(CFG.home, "ccapp-sched.json");
// provider 指向已删掉的接口：fire() 第一步就以「指定的接口已经删掉了」跳过，不会真去起 claude
const task = (id, nextAt) => ({ id, name: id, prompt: "x", on: true, nextAt, missed: "skip", provider: "gone-" + id, freq: { kind: "once" } });
const lastMsg = () => { const r = _schedForTest.runlog().at(-1); return r ? String(r.msg || "") : ""; };

test("闹钟推迟 10 分钟仍按到点执行；不带计划时刻或推迟太久才按错过", () => {
  const { DB } = _schedForTest;
  const keep = { tasks: DB.tasks, missed: DB.missed, lastTick: DB.lastTick };
  let before = null;
  try { before = fs.readFileSync(SCHED_FILE); } catch {}
  const now = Date.now(), at = now - 10 * 60000;
  try {
    // 不带计划时刻、上一次 tick 在 20 分钟前：应用没在跑，按错过
    DB.tasks = [task("t-a0610-13-04-a", at)]; DB.missed = []; DB.lastTick = now - 20 * 60000;
    _schedForTest.tick();
    assert.match(lastMsg(), /错过/);

    // 带计划时刻：同一条晚了 10 分钟的计划按到点执行（进了 fire，用「接口已删」跳过）
    DB.tasks = [task("t-a0610-13-04-b", at)]; DB.missed = []; DB.lastTick = now - 20 * 60000;
    _schedForTest.tick(at);
    assert.match(lastMsg(), /指定的接口/);

    // 推迟 40 分钟：多半是关机 / 强制停止前的旧闹钟，仍按错过
    const old = now - 40 * 60000;
    DB.tasks = [task("t-a0610-13-04-c", old)]; DB.missed = []; DB.lastTick = now - 50 * 60000;
    _schedForTest.tick(old);
    assert.match(lastMsg(), /错过/);
  } finally {
    DB.tasks = keep.tasks; DB.missed = keep.missed; DB.lastTick = keep.lastTick;
    if (before != null) fs.writeFileSync(SCHED_FILE, before); else fs.rmSync(SCHED_FILE, { force: true });
    for (const f of ["ccapp-sched-runs.json", "ccapp-sched-next"]) fs.rmSync(path.join(CFG.home, f), { force: true });
  }
});
