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
