import "../gw/config.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { CFG, PATHS } from "../gw/config.mjs";

test("旧整点与新刻钟共存，重复补算和清除跨月边界不重复计数", async () => {
  const since = Date.parse("2001-05-31T18:40:00Z"), hour = Math.floor(since / 3600e3);
  const slot = (iso) => Math.floor(Date.parse(iso) / 900e3);
  const file = path.join(CFG.home, "ccapp-usage.json");
  const backup = fs.existsSync(file) ? fs.readFileSync(file) : null;
  const old = { m: 4, i: 139, xi: { m: 1, i: 9 } };
  fs.mkdirSync(PATHS.projects, { recursive: true });
  const dir = fs.mkdtempSync(path.join(PATHS.projects, "quarter-test-"));
  try {
    // [hour + 1] 的 x 桶模拟「降级到旧版时点过补算」留下的旧式补算：新版 quarters 里有补算后合并视图只信 quarters
    fs.writeFileSync(file, JSON.stringify({ v: 2, since, hours: { [hour]: old, [hour + 1]: { m: 9, x: 1 } } }));
    const { routeUsage, usageAdd, flushUsage } = await import("../gw/usage.mjs");
    const api = async (suffix, body) => {
      const url = new URL("/api/usage" + suffix, "http://localhost");
      const req = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), { method: body ? "POST" : "GET" });
      let data;
      await routeUsage(req, {
        writeHead(code) { assert.equal(code, 200); },
        end(json) { data = JSON.parse(json); },
      }, url, url.pathname);
      return data;
    };
    fs.writeFileSync(path.join(dir, "sample.jsonl"), ["18:05", "18:35"].map(time => JSON.stringify({
      timestamp: "2001-05-31T" + time + ":00Z", sessionId: "sample", type: "user",
      message: { role: "user", content: "hello" },
    })).join("\n") + "\n");
    usageAdd({ m: 1, i: 5 }, "live", "demo", Date.parse("2001-05-31T18:41:00Z"));
    usageAdd({ m: 1, i: 11 }, "live", "demo", Date.parse("2001-05-31T18:45:00Z"));
    flushUsage();
    // 还没补算：quarters 里没有 x，旧式补算桶照常展示
    assert.equal((await api("")).hours[hour + 1].m, 9);
    for (let i = 0; i < 2; i++) {
      await api("/import", {});
      const { hours, quarters } = await api("?detail=quarter");
      assert.equal(hours[hour].m, 3);
      assert.equal(quarters[slot("2001-05-31T18:35Z")].m, 2);
      assert.equal(quarters[slot("2001-05-31T18:45Z")].i, 11);
      const total = (await api("")).hours[hour];
      assert.equal(total.m, 7);
      assert.equal(total.i, 146);
      // 新版补算落进 quarters 后，旧式补算桶（带 x）在两个视图里都不再并进来，防止翻倍
      assert.equal((await api("")).hours[hour + 1], undefined);
      assert.equal((await api("?detail=quarter")).hours[hour + 1], undefined);
    }
    // 尼泊尔六月从 UTC 18:15 开始。旧记录横跨边界，18:05 的刻钟全部属于五月。
    await api("/clear", { from: Date.parse("2001-05-31T18:15Z"), to: Date.parse("2001-06-30T18:15Z") });
    const { hours, quarters } = await api("?detail=quarter");
    assert.equal(hours[hour].i, 130);
    assert.equal(quarters[slot("2001-05-31T18:05Z")].m, 1);
    assert.equal(quarters[slot("2001-05-31T18:35Z")], undefined);
    assert.equal(quarters[slot("2001-05-31T18:45Z")], undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    if (backup) fs.writeFileSync(file, backup); else fs.rmSync(file, { force: true });
  }
});
