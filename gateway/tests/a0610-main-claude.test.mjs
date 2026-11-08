// 起 claude 的环境（gw/claude.mjs）：厂商配置的 extraEnv 不能盖掉网关按界面设好的模型 / 窗口（0.6.9 审计 195-U.2）
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GW = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
test("extraEnv 拒模型、各档映射、上下文窗口、压缩线；超时、输出上限这类照旧放行", () => {
  const src = fs.readFileSync(path.join(GW, "gw/claude.mjs"), "utf8");
  const re = new RegExp(/const EXTRA_ENV_DENY = (\/.*\/);/.exec(src)[1].slice(1, -1));
  for (const k of ["ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
    "CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_CODE_MAX_CONTEXT_TOKENS", "CLAUDE_CODE_AUTO_COMPACT_WINDOW", "CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT"]) assert.ok(re.test(k), k);
  for (const k of ["API_TIMEOUT_MS", "CLAUDE_CODE_MAX_OUTPUT_TOKENS", "ENABLE_TOOL_SEARCH", "CLAUDE_CODE_MAX_RETRIES"]) assert.ok(!re.test(k), k);
});

test("U.6：预置第三方厂商也走流式补尾；官方 API Key、端侧不走", async () => {
  const { startStreamFix, STREAMFIX } = await import("../gw/streamfix.mjs");
  const { claudeEnv } = await import("../gw/claude.mjs");
  const { providerById } = await import("../gw/providers.mjs");
  startStreamFix();
  for (let i = 0; i < 100 && !STREAMFIX.port; i++) await new Promise((r) => setTimeout(r, 20));
  const via = (id) => String(claudeEnv({ provider: providerById(id) }).ANTHROPIC_BASE_URL || "").startsWith(`http://127.0.0.1:${STREAMFIX.port}/u/`);
  try {
    assert.equal(via("deepseek"), true, "DeepSeek 预置");
    assert.equal(via("anthropic-key"), false, "官方 API Key 不经本地转发");
  } finally { STREAMFIX.server?.close(); }
});
