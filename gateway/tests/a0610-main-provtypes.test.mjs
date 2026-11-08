// 0.6.9 审计 199-5-03：厂商配置里型号等字段类型不对（手改 / 分享导入）→ 不用它，内置条目回落目录值
import { CFG } from "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

fs.writeFileSync(path.join(CFG.home, "ccapp-providers.json"), JSON.stringify({ active: "deepseek", providers: {
  deepseek: { apiKey: "fixture", defaultModel: 5, fastModel: ["x"] },
  "custom-bad": { label: "Bad", baseUrl: "https://example.invalid", apiKey: "fixture", defaultModel: { id: "m" }, fastModel: "ok-model" },
} }));
const { providerById } = await import("../gw/providers.mjs");

test("内置条目：型号不是字符串 → 用目录里的；自定义条目：当没填，别的字段照常", () => {
  const d = providerById("deepseek");
  assert.equal(typeof d.defaultModel, "string");
  assert.equal(typeof d.fastModel, "string");
  const c = providerById("custom-bad");
  assert.equal(c.defaultModel ?? null, null);
  assert.equal(c.fastModel, "ok-model");
  assert.equal(c.baseUrl, "https://example.invalid");
});

test("195-E.11：汇率取不到 → 一分钟内不再去等；同时几个请求只发一次", async () => {
  const { usdCny } = await import("../gw/providers.mjs");
  let n = 0;
  const prev = globalThis.fetch;
  globalThis.fetch = async () => { n++; await new Promise((r) => setTimeout(r, 50)); throw new Error("offline"); };
  try {
    await Promise.all([usdCny(), usdCny(), usdCny()]);
    assert.equal(n, 1, "并发合并成一次");
    await usdCny();
    assert.equal(n, 1, "退避期内不再试");
  } finally { globalThis.fetch = prev; }
});
