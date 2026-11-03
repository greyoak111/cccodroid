// 「有任务」标记（home/.run-active）：外壳靠它判断最近任务里划掉时能不能停服务（0601b 复核）
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs 就在这里拦下
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CFG } from "../gw/config.mjs";

test("排着会自己发出去的消息也算有任务；挂起等 ⚡ 的不算", async () => {
  const { QUEUE, saveRunMark } = await import("../gw/queue.mjs");
  const flag = path.join(CFG.home, ".run-active"), mark = path.join(CFG.home, "ccapp-run-mark.json");
  try {
    saveRunMark();
    assert.equal(fs.existsSync(flag), false);
    QUEUE.push({ id: "q-rf-held", message: "挂起的", sessionId: "s-rf", held: true, at: Date.now() });
    saveRunMark();
    assert.equal(fs.existsSync(flag), false);
    QUEUE.push({ id: "q-rf-live", message: "排着的", sessionId: "s-rf", at: Date.now() });
    saveRunMark();
    assert.equal(fs.existsSync(flag), true);
    QUEUE.splice(QUEUE.findIndex((q) => q.id === "q-rf-live"), 1);
    saveRunMark();
    assert.equal(fs.existsSync(flag), false);
  } finally {
    for (const id of ["q-rf-held", "q-rf-live"]) { const i = QUEUE.findIndex((q) => q.id === id); if (i >= 0) QUEUE.splice(i, 1); }
    fs.rmSync(mark, { force: true }); fs.rmSync(flag, { force: true });
  }
});
