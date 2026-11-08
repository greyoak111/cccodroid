// 流事件翻译（gw/stream.mjs translate）：子代理 / 旁链的消息不打乱主会话的「已逐字推过」标记（0.6.9 审计 195-U.1）
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { translate } from "../gw/stream.mjs";

function run(events) {
  const out = [], flags = { gotDelta: false };
  for (const ev of events) translate(ev, { flags, sse: (e) => out.push(e), onInit() {}, onResult() {}, provider: {} });
  return out;
}
const se = (event, extra = {}) => ({ type: "stream_event", event, ...extra });
const start = (extra) => se({ type: "message_start", message: { usage: {} } }, extra);
const delta = (text, extra) => se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }, extra);
const asst = (text, extra = {}) => ({ type: "assistant", message: { model: "m", content: [{ type: "text", text }] }, ...extra });
const texts = (out) => out.filter((e) => e.type === "delta" || e.type === "assistant_text").map((e) => e.text).join("");

test("主会话逐字推过、中间子代理开了一条消息 → 主会话的整段不再重复发", () => {
  const out = run([start(), delta("你好"), start({ parent_tool_use_id: "tu1" }), asst("你好")]);
  assert.equal(texts(out), "你好");
});

test("旁链推过增量、主会话这条没增量 → 主会话整段照发，不丢", () => {
  const out = run([start({ isSidechain: true }), delta("旁", { isSidechain: true }), start(), asst("主会话正文")]);
  assert.match(texts(out), /主会话正文/);
});

test("旁链的 message_start 不删主会话已显示的半截", () => {
  const out = run([start(), delta("半截"), start({ isSidechain: true })]);
  assert.equal(out.some((e) => e.type === "discard_partial"), false);
});
