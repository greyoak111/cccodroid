// h 组 BUG-R02：后台第二轮已开始、没等到自己的 result 却 exit 0 时，不能沿用上一轮的成功。
import { test } from "node:test";
import assert from "node:assert/strict";
import { events, runWith, sid, init, bg, result, mainStart } from "./fixtures/stab2-h-run-harness.mjs";

test("BUG-R02：新一轮已开始、没等到自己的 result 却 exit 0 → 按失败算，不沿用上一轮成功", async () => {
  const e = await runWith("r-h-stale0", [init(sid()), bg(1), result(10, 1), mainStart], 0);
  assert.equal(e.failed, true, JSON.stringify(e));
  assert.notEqual(e.subtype, "success");
  assert.ok(events.find((ev) => ev.type === "error" && ev.runId === "r-h-stale0"), "要告诉用户这一轮没答完");
});

test("BUG-R02 对照：exit17 的异常退出照旧按失败算", async () => {
  const e = await runWith("r-h-stale17", [init(sid()), bg(1), result(10, 1), mainStart], 17);
  assert.equal(e.failed, true, JSON.stringify(e));
});

test("BUG-R02 对照：后台任务清零、没起新一轮，exit 0 照旧算成功", async () => {
  const e = await runWith("r-h-bg0", [init(sid()), bg(1), result(10, 1), bg(0)], 0);
  assert.equal(!!e.failed, false, JSON.stringify(e));
  assert.equal(e.subtype, "success");
});
