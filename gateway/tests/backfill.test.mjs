// 补档（gw/backfill.mjs）的纯逻辑：摘要截取、模型回话解析、预估
import { test } from "node:test";
import assert from "node:assert/strict";
import { digestSummary, estimate, parseTitles } from "../gw/backfill.mjs";

test("摘要截取：去掉套话，留「主要诉求」开头和「当前工作」", () => {
  const body = "1. Primary Request and Intent:\n" + "要做的事。".repeat(400) + "\n\n7. Pending Tasks:\n" + "待办。".repeat(300) + "\n\n8. Current Work:\n正在写脉络页的地图。\n\n9. Optional Next Step:\n下一步。";
  const d = digestSummary("This session is being continued from a previous conversation.\n\nSummary:\n" + body);
  assert.ok(d.startsWith("1. Primary Request"));
  assert.ok(d.includes("Current Work:\n正在写脉络页的地图"));
  assert.ok(!d.includes("This session is being continued"));
  assert.ok(d.length < 2600);
  assert.equal(digestSummary("Summary:\n短摘要"), "短摘要");
});

test("解析模型回话：容忍代码围栏和多余文字，只认数字键的字符串", () => {
  assert.deepEqual(parseTitles('好的：\n```json\n{"1":"补齐接口","2":"修复 401","x":"不要"}\n```'), { 1: "补齐接口", 2: "修复 401" });
  assert.deepEqual(parseTitles("没有 JSON"), {});
  assert.deepEqual(parseTitles('{"3": 5}'), {});
});

test("预估：摘要章与进行中的章分开算，大会话分批", () => {
  const e = estimate([{ id: "a", chapters: [1, 2, 3], total: 3 }, { id: "b", chapters: Array.from({ length: 50 }, (_, i) => i + 1), total: 60 }]);
  assert.equal(e.sessions, 2);
  assert.equal(e.chapters, 53);
  assert.ok(e.calls >= 1 + 3, "50 章至少分 3 批");
  assert.ok(e.tokensIn > 53 * 1000);
});
