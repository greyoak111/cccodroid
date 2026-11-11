// h 组 7.2 REQ-005：带 parent_tool_use_id 或 isSidechain 的文本/思考增量不能转成主气泡的逐字 delta。
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
const think = (text, extra) => se({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: text } }, extra);
const asst = (text, extra = {}) => ({ type: "assistant", message: { model: "m", content: [{ type: "text", text }] }, ...extra });
const ofType = (out, t) => out.filter((e) => e.type === t).map((e) => e.text).join("");

test("REQ-005：子代理（parent_tool_use_id）的文本/思考增量不进主气泡，整段正文照旧挂 Agent 卡", () => {
  const out = run([
    start(), delta("主会话"),
    start({ parent_tool_use_id: "tu1" }),
    delta("子代理增量", { parent_tool_use_id: "tu1" }),
    think("子代理思考", { parent_tool_use_id: "tu1" }),
    asst("子代理整段正文", { parent_tool_use_id: "tu1" }),
  ]);
  assert.equal(ofType(out, "delta"), "主会话", "只有主会话的逐字增量");
  assert.equal(ofType(out, "thinking_delta"), "", "子代理的思考增量不转");
  assert.equal(ofType(out, "sub_text"), "子代理整段正文", "整段正文还是挂到 Agent 卡下");
});

test("REQ-005：旁链（isSidechain）的增量不进主气泡；完整消息随后由 assistant 事件发一次", () => {
  const out = run([
    start({ isSidechain: true }),
    delta("旁链增量", { isSidechain: true }),
    think("旁链思考", { isSidechain: true }),
    asst("旁链整段", { isSidechain: true }),
  ]);
  assert.equal(ofType(out, "delta"), "", "旁链增量不能画进主气泡");
  assert.equal(ofType(out, "thinking_delta"), "");
  assert.equal(ofType(out, "assistant_text"), "旁链整段", "整段不能丢，也不能因为增量被标记而吞掉");
});

test("REQ-005 对照：主会话的逐字增量照旧、assistant 整段不重复", () => {
  const out = run([start(), delta("你"), delta("好"), asst("你好")]);
  assert.equal(ofType(out, "delta"), "你好");
  assert.equal(ofType(out, "assistant_text"), "", "逐字推过的正文不再整段发一遍");
});

test("REQ-005 对照：子代理中途插进来，不影响主会话已推过的判定", () => {
  const out = run([
    start(), delta("主会话前半"),
    start({ parent_tool_use_id: "tu1" }), delta("子代理增量", { parent_tool_use_id: "tu1" }),
    asst("主会话前半"),
  ]);
  assert.equal(ofType(out, "delta"), "主会话前半");
  assert.equal(ofType(out, "assistant_text"), "", "主会话自己逐字推过，整段不再重复");
});
