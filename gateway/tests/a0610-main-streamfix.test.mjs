// 流式补尾（gw/streamfix.mjs）的边角：0.6.9 审计 199-9-01、200-9-06、200-9-08
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import { sseRepairer, startStreamFix, fixedBaseUrl, STREAMFIX } from "../gw/streamfix.mjs";

const ev = (o, name = o?.type) => `event: ${name}\ndata: ${JSON.stringify(o)}\n\n`;
const START = ev({ type: "message_start", message: { id: "m", usage: { input_tokens: 1, output_tokens: 0 } } });
let route = () => {};
const seen = [];
const up = http.createServer((req, res) => { seen.push(req.url); req.resume(); route(req, res); });
await new Promise((r) => up.listen(0, "127.0.0.1", r));
startStreamFix();
while (!STREAMFIX.port) await new Promise((r) => setTimeout(r, 10));
after(() => { up.close(); STREAMFIX.server?.close(); });

test("199-9-01：data 是 null / 数字 / 数组 → 不抛异常，原样交给下游", () => {
  const f = sseRepairer();
  for (const name of ["message_start", "content_block_start", "content_block_stop", "message_delta"]) {
    for (const d of ["null", "3", "[1]"]) assert.doesNotThrow(() => f.feed(`event: ${name}\ndata: ${d}\n\n`), `${name} ${d}`);
  }
});

test("200-9-08：baseUrl 带查询串 → /v1/messages 接在路径上，查询串保留", async () => {
  route = (req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); };
  seen.length = 0;
  const base = fixedBaseUrl(`http://127.0.0.1:${up.address().port}/api?key=abc`);
  await (await fetch(base + "/v1/messages?beta=true", { method: "POST", body: "{}" })).text();
  assert.equal(seen[0], "/api/v1/messages?key=abc&beta=true");
});

test("200-9-06：SSE 的 4xx/5xx 错误流、压缩过的 SSE → 原样转给下游，不当断线", async () => {
  const base = fixedBaseUrl(`http://127.0.0.1:${up.address().port}/e`);
  const errBody = ev({ type: "error", error: { type: "overloaded_error", message: "busy" } });
  route = (req, res) => { res.writeHead(529, { "content-type": "text/event-stream" }); res.end(errBody); };
  const r1 = await fetch(base + "/v1/messages", { method: "POST", body: "{}" });
  assert.equal(r1.status, 529); assert.equal(await r1.text(), errBody);
  const plain = START + ev({ type: "message_stop" });
  route = (req, res) => { res.writeHead(200, { "content-type": "text/event-stream", "content-encoding": "gzip" }); res.end(zlib.gzipSync(plain)); };
  const r2 = await fetch(base + "/v1/messages", { method: "POST", body: "{}" });
  assert.equal(await r2.text(), plain, "压缩流原样透传，由下游自己解");
  // 不是 Anthropic 的流（没有 message_start），上游正常收完：照常收尾，不断开
  route = (req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.end("data: {\"choices\":[]}\n\n"); };
  const r3 = await fetch(base + "/v1/messages", { method: "POST", body: "{}" });
  assert.equal(await r3.text(), "data: {\"choices\":[]}\n\n");
});
