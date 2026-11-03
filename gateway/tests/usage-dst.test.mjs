// 耗电分桶（#119-1）：夏令时回拨的重复小时里，小时起点按“当前这次”算，游标不倒退
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下
import { test } from "node:test";
import assert from "node:assert/strict";
import { energyHourStart } from "../gw/usage.mjs";

test("DST 回拨：第二次 02:30 的小时起点是第二次 02:00", () => {
  const old = process.env.TZ;
  try {
    process.env.TZ = "Europe/Berlin";
    const first = Date.parse("2027-10-31T00:30:00Z");    // 第一次 02:30（CEST）
    const second = Date.parse("2027-10-31T01:30:00Z");   // 回拨后第二次 02:30（CET）
    assert.equal(new Date(first).getHours(), 2);
    assert.equal(new Date(second).getHours(), 2, "测试时区没生效");
    assert.equal(energyHourStart(first), Date.parse("2027-10-31T00:00:00Z"));
    assert.equal(energyHourStart(second), Date.parse("2027-10-31T01:00:00Z"));
    assert.ok(energyHourStart(second) > energyHourStart(first), "两个 02 点必须是不同的真实小时");
  } finally {
    if (old === undefined) delete process.env.TZ; else process.env.TZ = old;
  }
});
