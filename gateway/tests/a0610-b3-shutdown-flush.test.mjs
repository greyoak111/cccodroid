// 0.6.10 车道 b3：SIGTERM 退出时把防抖还没落盘的用量 / 会话模型写下去（195-W.2 / 196-状态写.2）
// 以前 usage 是 5 秒防抖、sessmodel 是 300ms 防抖，server.mjs 的退出流程只调 runShutdown()，
// 这两个模块没登记退出钩子：流式期间用量整轮缺失、会话模型 pin 回落全局。
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CFG } from "../gw/config.mjs";
import { runShutdown } from "../gw/crashguard.mjs";
import { usageAdd } from "../gw/usage.mjs";
import { setSessModel } from "../gw/sessmodel.mjs";

const USAGE = path.join(CFG.home, "ccapp-usage.json");
const SESS = path.join(CFG.home, "ccapp-session-models.json");
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };

test("runShutdown：usage 的 5 秒防抖、sessmodel 的 300ms 防抖都立刻落盘", () => {
  const h = Math.floor(Date.now() / 3600e3);
  const m0 = (readJson(USAGE)?.hours?.[h]?.m) || 0;
  usageAdd({ m: 1 }, "b3-flush", "b3-model", Date.now());
  setSessModel("b3-flush", { model: "b3-model" });
  // 防抖还没到点：文件里还没有这一段
  assert.equal((readJson(USAGE)?.hours?.[h]?.m) || 0, m0, "5 秒防抖不该已经写");
  assert.equal(readJson(SESS)?.["b3-flush"], undefined, "300ms 防抖不该已经写");
  runShutdown();   // 等于 server.mjs 收到 SIGTERM 走的退出流程
  assert.equal(readJson(USAGE)?.hours?.[h]?.m, m0 + 1, "用量要写下去");
  assert.equal(readJson(SESS)?.["b3-flush"]?.model, "b3-model", "会话模型要写下去");
});
