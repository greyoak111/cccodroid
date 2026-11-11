// e 组：上游流修补（streamfix）。FIND-001 message_stop 之后追发的 error 被透传；
// FIND-021 200 + text/event-stream 但正文不是 SSE 时整段被吞；OBS-001 SSE 行缓冲没有上限。
import { test } from "node:test";
import assert from "node:assert/strict";
import { sseRepairer } from "../gw/streamfix.mjs";

const ev = (type, obj) => `event: ${type}\ndata: ${JSON.stringify(obj)}\n\n`;
const start = ev("message_start", { type: "message_start", message: { usage: { output_tokens: 1 } } });
const textStart = ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text" } });
const text = ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "好了" } });
const textStop = ev("content_block_stop", { type: "content_block_stop", index: 0 });
const md = ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } });
const ms = ev("message_stop", { type: "message_stop" });

test("FIND-001：message_stop 之后追发的 error 不透传，回答照常收尾", () => {
  const f = sseRepairer();
  let out = f.feed(start + textStart + text + textStop + md + ms);
  out += f.feed(ev("error", { type: "error", error: { type: "overloaded_error", message: "boom" } }));
  out += f.finish({ complete: true }) ?? "";
  assert.equal(/event: error/.test(out), false, "error 事件不该出现在下游：" + out.slice(-300));
  assert.match(out, /message_stop/);
});

test("FIND-021：200 + text/event-stream 但正文不是 SSE → 上游正常收完时原样转下去，不吞", () => {
  const body = '{"type":"error","error":{"type":"api_error","message":"not sse"}}';
  const f = sseRepairer();
  assert.equal(f.feed(body), "", "没有事件分隔，先攒着");
  const t = f.finish({ complete: true });
  assert.equal(typeof t, "string");
  assert.match(t, /not sse/, "正文不能被丢掉");
});
