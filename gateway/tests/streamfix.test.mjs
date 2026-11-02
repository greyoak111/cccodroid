// 流式补尾（gw/streamfix.mjs）：上游说完没收尾时补 message_delta/message_stop；块还开着就不补
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下，下面一行都不跑
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { sseRepairer, startStreamFix, fixedBaseUrl, STREAMFIX } from "../gw/streamfix.mjs";

const ev = (o) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;
const START = ev({ type: "message_start", message: { id: "m1", type: "message", role: "assistant", content: [], usage: { input_tokens: 5, output_tokens: 1 } } });
const textBlock = (i, s) => ev({ type: "content_block_start", index: i, content_block: { type: "text", text: "" } })
  + ev({ type: "content_block_delta", index: i, delta: { type: "text_delta", text: s } });
const stop = (i) => ev({ type: "content_block_stop", index: i });
const types = (s) => [...s.matchAll(/^data: (.*)$/gm)].map((m) => JSON.parse(m[1]).type);

test("正文说完、上游没发 message_delta 就断：补 end_turn + message_stop", () => {
  const f = sseRepairer();
  let out = f.feed(START + textBlock(0, "说完了") + stop(0));
  const t = f.finish();
  assert.notEqual(t, null);
  out += t;
  assert.deepEqual(types(out).slice(-2), ["message_delta", "message_stop"]);
  assert.match(out, /"stop_reason":"end_turn"/);
});

test("有工具调用：补的是 tool_use", () => {
  const f = sseRepairer();
  f.feed(START + ev({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t", name: "Bash", input: {} } })
    + ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } }) + stop(0));
  assert.match(f.finish(), /"stop_reason":"tool_use"/);
});

test("块还开着（真掐在半截）：不补，返回 null", () => {
  const f = sseRepairer();
  f.feed(START + textBlock(0, "半截"));
  assert.equal(f.finish(), null);
});

test("只有思考没有正文：不补", () => {
  const f = sseRepairer();
  f.feed(START + ev({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }) + stop(0));
  assert.equal(f.finish(), null);
});

test("完整的流原样通过，[DONE] 被丢掉", () => {
  const f = sseRepairer();
  const full = START + textBlock(0, "好") + stop(0)
    + ev({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } })
    + ev({ type: "message_stop" });
  const out = f.feed(full + "data: [DONE]\n\n") + f.finish();
  assert.equal(out, full);
});

test("说完之后来个 error 事件：吞掉并收尾", () => {
  const f = sseRepairer();
  const out = f.feed(START + textBlock(0, "好") + stop(0) + `event: error\ndata: {"type":"error","error":{"type":"overloaded_error"}}\n\n`) + f.finish();
  assert.ok(!types(out).includes("error"));
  assert.deepEqual(types(out).slice(-2), ["message_delta", "message_stop"]);
});

test("stop_reason 给 null：按内容补上", () => {
  const f = sseRepairer();
  const out = f.feed(START + textBlock(0, "好") + stop(0) + ev({ type: "message_delta", delta: { stop_reason: null }, usage: { output_tokens: 3 } }) + ev({ type: "message_stop" })) + f.finish();
  assert.match(out, /"stop_reason":"end_turn"/);
});

test("CRLF 分隔、事件被拆在两个 chunk 里", () => {
  const f = sseRepairer();
  const s = (START + textBlock(0, "好") + stop(0)).replace(/\n/g, "\r\n");
  const out = f.feed(s.slice(0, 37)) + f.feed(s.slice(37)) + f.finish();
  assert.deepEqual(types(out), ["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
});

test("端到端：经本地转发，上游断线的流被补全；非流式请求原样转发", async () => {
  const up = http.createServer((req, res) => {
    if (req.url === "/api/v1/models") { res.writeHead(200, { "content-type": "application/json" }); res.end('{"data":[]}'); return; }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(START + textBlock(0, "说完了") + stop(0));
    setTimeout(() => res.socket.destroy(), 30);
  });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  startStreamFix();
  while (!STREAMFIX.port) await new Promise((r) => setTimeout(r, 10));
  const base = fixedBaseUrl(`http://127.0.0.1:${up.address().port}/api`);
  const r1 = await fetch(base + "/v1/messages", { method: "POST", body: "{}" });
  const body = await r1.text();
  assert.deepEqual(types(body).slice(-2), ["message_delta", "message_stop"]);
  const r2 = await fetch(base + "/v1/models");
  assert.equal(await r2.text(), '{"data":[]}');
  up.close(); STREAMFIX.server.close();
});

test("通道网址里不带上游地址，不认识的通道号 404，带账号密码的不经通道（审查 v0513b 低）", async () => {
  STREAMFIX.server = null; STREAMFIX.port = 0;     // 上一个测试把通道关了：重起一个
  startStreamFix();
  while (!STREAMFIX.port) await new Promise((r) => setTimeout(r, 10));
  const b = fixedBaseUrl("https://relay.example.com/anthropic");
  assert.match(b, new RegExp(`^http://127\\.0\\.0\\.1:${STREAMFIX.port}/u/[0-9a-f]{32}$`));
  assert.ok(!b.includes("relay.example.com"));
  assert.equal(fixedBaseUrl("https://relay.example.com/anthropic"), b, "同一家同一通道");
  assert.notEqual(fixedBaseUrl("https://relay.example.com/other"), b);
  assert.equal(fixedBaseUrl("https://u:p@relay.example.com/x"), "https://u:p@relay.example.com/x");
  for (const p of [`/u/${"0".repeat(32)}/v1/messages`, "/u/zz/v1/messages", "/http://evil.example/v1/messages", "/"])
    assert.equal((await fetch(`http://127.0.0.1:${STREAMFIX.port}${p}`, { method: "POST", body: "{}" })).status, 404, p);
  STREAMFIX.server.close();
});

test("取消通道请求会关闭上游，转发器仍能接受下一次请求", async () => {
  let cancelled;
  const closed = new Promise((r) => { cancelled = r; });
  const up = http.createServer((req, res) => {
    if (req.url === "/v1/models") return res.end('{"data":[]}');
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(START + textBlock(0, "持续输出"));
    const tick = setInterval(() => res.write(": heartbeat\n\n"), 20);
    res.once("close", () => { clearInterval(tick); cancelled(); });
  });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  STREAMFIX.server = null; STREAMFIX.port = 0;
  startStreamFix();
  while (!STREAMFIX.port) await new Promise((r) => setTimeout(r, 10));
  try {
    const base = fixedBaseUrl(`http://127.0.0.1:${up.address().port}`);
    const controller = new AbortController();
    const response = await fetch(base + "/v1/messages", { method: "POST", body: "{}", signal: controller.signal });
    const reader = response.body.getReader();
    assert.equal((await reader.read()).done, false);
    controller.abort();
    await assert.rejects(reader.read(), { name: "AbortError" });
    await Promise.race([closed, new Promise((_, reject) => { const t = setTimeout(() => reject(new Error("上游未取消")), 2000); t.unref(); })]);
    assert.equal(await (await fetch(base + "/v1/models")).text(), '{"data":[]}');
  } finally {
    up.closeAllConnections(); up.close();
    STREAMFIX.server.closeAllConnections(); STREAMFIX.server.close();
  }
});

test("非流式响应半路断（#102 04-007）：下游马上断，不等客户端自己超时", async () => {
  const up = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json", "content-length": "10000" });
    res.write('{"partial":');
    setTimeout(() => res.socket.destroy(), 40);
  });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  STREAMFIX.server = null; STREAMFIX.port = 0;
  startStreamFix();
  while (!STREAMFIX.port) await new Promise((r) => setTimeout(r, 10));
  try {
    const base = fixedBaseUrl(`http://127.0.0.1:${up.address().port}`);
    const t0 = Date.now();
    const r = await fetch(base + "/v1/messages", { method: "POST", body: "{}", signal: AbortSignal.timeout(3000) });
    await assert.rejects(r.text(), (e) => e.name !== "TimeoutError");
    assert.ok(Date.now() - t0 < 1500, "上游断了下游也该马上断");
  } finally {
    up.closeAllConnections(); up.close();
    STREAMFIX.server.closeAllConnections(); STREAMFIX.server.close();
  }
});
