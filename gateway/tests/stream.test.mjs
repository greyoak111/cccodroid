// stream-json → 前端事件（gw/stream.mjs 的 translate）。样本是真机抓的事件流（fixtures/mkfix.mjs 精简过）：
//   stream-plain           普通一问一答
//   stream-tool-call       先说一句、调一次 Bash、再总结：两次 API 请求
//   stream-cut-in-text     第一次请求的流在正文中途被掐断，claude 补一句「接着说」重新请求（群友报的「回答输出两遍」）
//   stream-cut-in-thinking 流断在思考阶段，claude 走 api_retry 重来
// 断言照前端的画法拼出最后看到的正文 / 思考，和 claude 确认进对话的内容（assistant 事件）逐字一致
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { translate } from "../gw/stream.mjs";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const load = (name) => fs.readFileSync(path.join(FIX, name), "utf8").trim().split("\n").map((l) => JSON.parse(l));

/** 喂给 translate，按前端的方式拼：delta / assistant_text 往后接，discard_partial 从末尾删 */
function replay(evs) {
  const flags = {}, out = [];
  for (const ev of evs) translate(ev, { sse: (e) => out.push(e), flags, onInit() {}, onResult() {}, onReplay() {}, provider: {} });
  let text = "", think = "";
  for (const e of out) {
    if (e.type === "delta" || e.type === "assistant_text") text += e.text;
    else if (e.type === "thinking_delta" || e.type === "thinking") think += e.text;
    else if (e.type === "discard_partial") { text = text.slice(0, text.length - e.text); think = think.slice(0, think.length - e.think); }
  }
  return { out, text, think, discards: out.filter((e) => e.type === "discard_partial").map(({ text, think }) => ({ text, think })) };
}
/** claude 确认进了对话的：主线程 assistant 事件里的正文 / 思考，按顺序接起来 */
function committed(evs) {
  let text = "", think = "";
  for (const e of evs) if (e.type === "assistant" && !e.parent_tool_use_id) for (const c of e.message.content || []) {
    if (c.type === "text") text += c.text;
    else if (c.type === "thinking") think += c.thinking;
  }
  return { text, think };
}

for (const [name, discards] of [
  ["stream-plain.jsonl", []],
  ["stream-tool-call.jsonl", []],
  ["stream-cut-in-text.jsonl", [{ text: 54, think: 0 }]],
  ["stream-cut-in-thinking.jsonl", [{ text: 0, think: 251 }]],
]) {
  test(`${name}：界面最后的正文和思考 = 进了对话的内容`, () => {
    const evs = load(name), r = replay(evs), c = committed(evs);
    assert.deepEqual(r.discards, discards);
    assert.ok(c.text.length > 0, "样本里应有正文");
    assert.equal(r.text, c.text);
    assert.equal(r.think, c.think);
  });
}

test("带工具的多次请求：工具卡照常发出，不误删", () => {
  const r = replay(load("stream-tool-call.jsonl"));
  assert.equal(r.out.filter((e) => e.type === "tool_use").length, 1);
  assert.equal(r.out.filter((e) => e.type === "tool_result").length, 1);
});

test("逐字增量发过就不再补整段 assistant_text", () => {
  const r = replay(load("stream-plain.jsonl"));
  assert.equal(r.out.filter((e) => e.type === "assistant_text").length, 0);
  assert.ok(r.out.some((e) => e.type === "delta"));
});

test("增量没到时用 assistant 事件补整段正文", () => {
  const evs = load("stream-plain.jsonl").filter((e) => !(e.type === "stream_event" && e.event?.type === "content_block_delta"));
  const r = replay(evs), c = committed(evs);
  assert.equal(r.text, c.text);
});

test("子代理的增量不算主线程的半截", () => {
  const flags = {}, out = [];
  const sse = (e) => out.push(e);
  const ctx = { sse, flags, onInit() {}, onResult() {}, onReplay() {}, provider: {} };
  translate({ type: "stream_event", parent_tool_use_id: "toolu_x", event: { type: "content_block_delta", delta: { type: "text_delta", text: "子代理的话" } } }, ctx);
  translate({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id: "m2", usage: { input_tokens: 1 } } } }, ctx);
  assert.equal(out.filter((e) => e.type === "discard_partial").length, 0);
});

test("工具参数大块到达（官方接口）：参数写完时补报最后的字数，不停在开头那几个字", () => {
  const se = (event) => ({ type: "stream_event", event });
  const big = '"ls -la /sdcard && echo ' + "x".repeat(500) + '"}';
  const flags = {}, out = [];
  const feed = (ev) => translate(ev, { sse: (e) => out.push(e), flags, onInit() {}, onResult() {}, onReplay() {}, provider: {} });
  feed(se({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "Bash", input: {} } }));
  feed(se({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command": ' } }));
  feed(se({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: big } }));   // 同一个节流窗口里
  feed(se({ type: "content_block_stop", index: 0 }));
  const last = out.filter((e) => e.type === "phase" && e.phase === "tool").pop();
  assert.equal(last.chars, '{"command": '.length + big.length);
  clearTimeout(flags.toolTimer);
});
