// 0.6.10 车道 b2：网关启动时按当前时区重排未来的 nextAt（197-5.3）
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CFG } from "../gw/config.mjs";

const old = Date.now() + 5 * 3600e3 + 12345;   // 不是 09:00:00.000
fs.writeFileSync(path.join(CFG.home, "ccapp-sched.json"), JSON.stringify({
  tasks: [{ id: "b2-start", name: "n", prompt: "p", on: true, freq: { kind: "daily", time: "09:00" }, nextAt: old }],
  dailyBudget: 0, missed: [], sids: [], lastTick: 0, allowLogin: false, spent: {}, monthly: {}, monthlySeeded: true,
}));

const { _schedForTest: S } = await import("../gw/sched.mjs");

test("盘上的旧 nextAt（旧时区算的）启动时按当前时区重算（197-5.3）", () => {
  const t = S.DB.tasks.find((x) => x.id === "b2-start");
  assert.ok(t);
  assert.notEqual(t.nextAt, old, "要重算，不能沿用旧值");
  assert.ok(t.nextAt > Date.now());
  assert.equal(new Date(t.nextAt).getHours(), 9);
  assert.equal(new Date(t.nextAt).getMinutes(), 0);
});
