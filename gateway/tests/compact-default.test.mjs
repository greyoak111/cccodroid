// 第三方型号没设压缩线时网关给默认线（11-07 群友：deepseek-flash 涨到 1M 也不自动压缩，撞窗口后手动 /compact 也 400）
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { defaultCompactLine, cachedModels } from "../gw/models.mjs";
import { claudeEnv } from "../gw/claude.mjs";
import { SETTINGS } from "../gw/settings-store.mjs";

const P = (o) => ({ id: "custom-cdef", custom: true, baseUrl: "http://127.0.0.1:1", apiKey: "fixture-only", defaultModel: "m-big", fastModel: "m-big", ...o });
const saved = SETTINGS.autoCompactWindow, inherited = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
after(() => {
  SETTINGS.autoCompactWindow = saved;
  if (inherited === undefined) delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW; else process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = inherited;
});

test("默认线：窗口八成、给总结留 40k、夹在 claude 认的 100k–1M 里", () => {
  assert.equal(defaultCompactLine(1048576, P()), 838000);
  assert.equal(defaultCompactLine(200000, P()), 160000);
  assert.equal(defaultCompactLine(160000, P()), 120000);       // 留 40k 比八成更紧
  assert.equal(defaultCompactLine(128000, P()), null);          // 88k 够不着 100k
  assert.equal(defaultCompactLine(2000000, P()), 1000000);      // 大了 claude 按 1M 算
  assert.equal(defaultCompactLine(0, P()), null);               // 不知道窗口：不瞎编
  assert.equal(defaultCompactLine(1048576, { nativeModels: true }), null);   // claude 认得的型号自己会算
  assert.equal(defaultCompactLine(1048576, P({ local: true })), null);       // 端侧小模型不传（见 claudeEnv）
});

test("claudeEnv：没设就下发默认线；设了用设的；继承来的值不漏过去", () => {
  const p = P({ id: "custom-cdef-a", contextWindow: 1048576 });
  assert.equal(cachedModels(p).length, 1);
  process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = "400000";     // 网关从别的 claude 会话里起时会带着
  SETTINGS.autoCompactWindow = null;
  assert.equal(claudeEnv({ model: "m-big", provider: p }).CLAUDE_CODE_AUTO_COMPACT_WINDOW, "838000");
  SETTINGS.autoCompactWindow = 500000;
  assert.equal(claudeEnv({ model: "m-big", provider: p }).CLAUDE_CODE_AUTO_COMPACT_WINDOW, "500000");
  SETTINGS.autoCompactWindow = null;
  const q = P({ id: "custom-cdef-b" });                          // 窗口不知道
  assert.equal(claudeEnv({ model: "m-big", provider: q }).CLAUDE_CODE_AUTO_COMPACT_WINDOW, undefined);
});
