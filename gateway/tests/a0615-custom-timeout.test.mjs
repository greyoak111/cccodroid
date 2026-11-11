// #203：自定义厂商缺省没有请求超时，上游静默挂起时整轮干等。起 claude 的环境里补一档默认，用户自己写的优先
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

test("#203 自定义厂商默认带 API_TIMEOUT_MS / 重试；extraEnv 写了的以它为准；预置厂商不受影响", async () => {
  const { claudeEnv } = await import("../gw/claude.mjs");
  const { providerById } = await import("../gw/providers.mjs");
  const base = { custom: true, group: "custom", authStyle: "bearer", baseUrl: "https://example.invalid/anthropic", apiKey: "k", defaultModel: "m" };
  const e1 = claudeEnv({ provider: base });
  assert.equal(e1.API_TIMEOUT_MS, "90000");
  assert.equal(e1.CLAUDE_CODE_MAX_RETRIES, "3");
  const e2 = claudeEnv({ provider: { ...base, extraEnv: { API_TIMEOUT_MS: "300000" } } });
  assert.equal(e2.API_TIMEOUT_MS, "300000", "用户写的盖掉默认");
  assert.equal(e2.CLAUDE_CODE_MAX_RETRIES, "3");
  assert.equal(claudeEnv({ provider: providerById("deepseek") }).API_TIMEOUT_MS, providerById("deepseek").extraEnv?.API_TIMEOUT_MS);
});
