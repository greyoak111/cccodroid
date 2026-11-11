// h 组：BUG-R01 上游没给消息级收尾就断了，补尾保留但要把「完整性未知」报给发起的那一轮。
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { sseRepairer, startStreamFix, fixedBaseUrl, STREAMFIX, SWALLOW_HOOKS } from "../gw/streamfix.mjs";

const ev = (type, obj) => `event: ${type}\ndata: ${JSON.stringify(obj)}\n\n`;
const START = ev("message_start", { type: "message_start", message: { id: "m", usage: { input_tokens: 1, output_tokens: 0 } } });
const TEXT_START = ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
const TEXT = ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "说完了" } });
const TEXT_STOP = ev("content_block_stop", { type: "content_block_stop", index: 0 });
const MD = ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } });
const MS = ev("message_stop", { type: "message_stop" });

test("BUG-R01：块都闭合、上游没给 message_stop 就断了 → 照旧补尾，但报「truncated」", () => {
  const calls = [];
  const f = sseRepairer({ onSwallow: (msg, kind) => calls.push([msg, kind]) });
  let out = f.feed(START + TEXT_START + TEXT + TEXT_STOP);
  out += f.finish({ complete: true }) ?? "";
  assert.match(out, /"stop_reason":"end_turn"/, "兼容补尾要保留：" + out.slice(-300));
  assert.match(out, /event: message_stop/);
  assert.deepEqual(calls, [["", "truncated"]], "补出来的结尾必须带完整性未知，不能悄悄当完整");
});

test("BUG-R01 对照：正常完整流（message_delta + message_stop）不补尾、不提示", () => {
  const calls = [];
  const f = sseRepairer({ onSwallow: (msg, kind) => calls.push([msg, kind]) });
  const out = f.feed(START + TEXT_START + TEXT + TEXT_STOP + MD + MS);
  const tail = f.finish({ complete: true });
  assert.equal(tail, "", "已经正常收尾，不再补");
  assert.equal((out.match(/event: message_stop/g) || []).length, 1, "正常完整流不重复终止");
  assert.deepEqual(calls, [], "完整流不该有完整性提示");
});

test("BUG-R01 对照：块没闭合不补尾（交给 claude 自己恢复），也不报", () => {
  const calls = [];
  const f = sseRepairer({ onSwallow: (msg, kind) => calls.push([msg, kind]) });
  f.feed(START + TEXT_START + TEXT);            // 没有 content_block_stop
  assert.equal(f.finish({ complete: true }), null);
  assert.deepEqual(calls, []);
});

test("BUG-R01：说完之后来的 error 仍按 error 报，补尾只报一次（不同时报 truncated）", () => {
  const calls = [];
  const f = sseRepairer({ onSwallow: (msg, kind) => calls.push([msg, kind]) });
  f.feed(START + TEXT_START + TEXT + TEXT_STOP + ev("error", { type: "error", error: { type: "api_error", message: "boom" } }));
  f.finish({ complete: true });
  assert.deepEqual(calls, [["boom", "error"]]);
});

// 真转发路径：会话号来自请求头，钩子拿到的必须是同一条流
let route = () => {};
const up = http.createServer((req, res) => { req.resume(); route(req, res); });
await new Promise((r) => up.listen(0, "127.0.0.1", r));
startStreamFix();
while (!STREAMFIX.port) await new Promise((r) => setTimeout(r, 10));
after(() => { up.close(); STREAMFIX.server?.close(); });

test("BUG-R01：截断提示绑定发起的会话（请求头 X-Claude-Code-Session-Id）", async () => {
  const got = [];
  const h = (sid, msg, kind) => got.push([sid, msg, kind]);
  SWALLOW_HOOKS.push(h);
  try {
    route = (req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(START + TEXT_START + TEXT + TEXT_STOP);   // 上游正常收完 HTTP，但 SSE 没有消息级收尾
    };
    const base = fixedBaseUrl(`http://127.0.0.1:${up.address().port}/t`);
    const r = await fetch(base + "/v1/messages", { method: "POST", body: "{}", headers: { "X-Claude-Code-Session-Id": "sid-pad" } });
    const out = await r.text();
    assert.match(out, /event: message_stop/);
    assert.deepEqual(got, [["sid-pad", "", "truncated"]]);
  } finally { SWALLOW_HOOKS.splice(SWALLOW_HOOKS.indexOf(h), 1); }
});
