// 定时任务（gw/sched.mjs）：cron 解析
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下，下面一行都不跑
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCron, _schedForTest } from "../gw/sched.mjs";

test("超大范围夹到合法区间，不会空转卡死网关", () => {
  const t0 = Date.now();
  const c = parseCron("1-999999999999999999 * * * 0-99999999999");
  assert.ok(Date.now() - t0 < 200);
  assert.equal(c.min.size, 59);
  assert.equal(c.dow.size, 7);
});

test("星期 7 并进 0，1-7 不变成空集", () => {
  assert.deepEqual([...parseCron("0 9 * * 1-7").dow].sort(), [0, 1, 2, 3, 4, 5, 6]);
});

test("反向范围、越界值展开为空：报错（中文、带字段值），不存一个永远不跑的任务", () => {
  // 原断言锁定的是英文 "bad cron"；200-16-06 要求翻译并带字段定位，故改为匹配新文案
  for (const e of ["5-3 * * * *", "0 25 * * *", "0 9 32 * *"]) assert.throws(() => parseCron(e), /cron 的字段值/, e);
});

test("跨午夜的「每隔几小时」窗口保存时拒绝，不存一个永远不跑的任务", () => {
  assert.throws(() => _schedForTest.clean({ name: "night", prompt: "x", freq: { kind: "every", hours: 2, from: "22:00", to: "02:00" } }, {}), /开始时间/);
  assert.doesNotThrow(() => _schedForTest.clean({ name: "day", prompt: "x", freq: { kind: "every", hours: 2, from: "08:00", to: "22:00" } }, {}));
});
