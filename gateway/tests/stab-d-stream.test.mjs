// FIND-022：message.content 不是数组（坏记录 / 桥给的字符串、null、数字）时，translate 不能抛错把整条事件丢掉
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { translate } from "../gw/stream.mjs";

function run(ev) {
  const out = [], flags = {};
  assert.doesNotThrow(() => translate(ev, { sse: (e) => out.push(e), flags, onInit() {}, onResult() {}, onReplay() {}, provider: {} }));
  return out;
}

test("assistant 的 content 不是数组时不抛错，正常块照常转出", () => {
  assert.deepEqual(run({ type: "assistant", message: { role: "assistant", content: 42 } }), []);
  assert.deepEqual(run({ type: "assistant", message: { role: "assistant", content: "纯文本" } }).map((e) => e.text), ["纯文本"]);
  assert.deepEqual(run({ type: "assistant", message: { role: "assistant", content: [null, { type: "text", text: "还活着" }] } }).map((e) => e.text), ["还活着"]);
  assert.deepEqual(run({ type: "assistant", parent_tool_use_id: "t1", message: { role: "assistant", content: 42 } }), []);
});

test("user 的 content 不是数组时不抛错，坏元素只丢自己", () => {
  assert.deepEqual(run({ type: "user", message: { role: "user", content: 42 } }), []);
  const out = run({ type: "user", message: { role: "user", content: [null, { type: "tool_result", tool_use_id: "t1", content: [null, { type: "text", text: "结果" }] }] } });
  assert.equal(out.length, 1);
  assert.equal(out[0].type, "tool_result");
  assert.equal(out[0].text, "[?]\n结果");
});
