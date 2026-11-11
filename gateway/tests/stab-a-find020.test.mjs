// FIND-020：「测试接口」的错误分类。403 不一定密钥问题（地区 / 风控 / 防火墙都回 403），
// 响应体超过上限也不是「连不上」；以前分别被报成「密钥无效或与线路不匹配」和「连不上」。
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { CFG } from "../gw/config.mjs";

// 假厂商：按 mode 回不同的状态码 / 正文
let mode = "403";
const BIG = "x".repeat(9 * 1024 * 1024);   // fetchText 上限 8 MB
const srv = http.createServer((req, res) => {
  req.resume();
  res.on("error", () => {});
  if (mode === "403") { res.writeHead(403, { "content-type": "text/html" }); res.end("<html><body>blocked</body></html>"); }
  else if (mode === "401") { res.writeHead(401, { "content-type": "application/json" }); res.end('{"error":{"message":"invalid x-api-key"}}'); }
  else if (mode === "big") { res.writeHead(200, { "content-type": "application/json" }); res.end(BIG); }
  else { res.writeHead(500, { "content-type": "text/plain" }); res.end("boom"); }
});
await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
after(() => srv.close());

const base = "http://127.0.0.1:" + srv.address().port;
fs.mkdirSync(CFG.home, { recursive: true });
fs.writeFileSync(path.join(CFG.home, "ccapp-providers.json"), JSON.stringify({
  active: "custom-1", providers: { "custom-1": { label: "t", baseUrl: base, apiKey: "K" } },
}));
const P = await import("../gw/providers.mjs");
after(() => { try { fs.rmSync(path.join(CFG.home, "ccapp-providers.json"), { force: true }); } catch {} });

test("403：不能说成密钥无效（可能只是地区 / 风控 / 防火墙）", async () => {
  mode = "403";
  const r = await P.testProvider("custom-1");
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
  assert.match(r.message, /403/);
  assert.doesNotMatch(r.message, /密钥无效/);
});

test("401：仍然是密钥问题", async () => {
  mode = "401";
  const r = await P.testProvider("custom-1");
  assert.equal(r.ok, false);
  assert.match(r.message, /密钥无效/);
});

test("响应体超过上限：不能说成「连不上」", async () => {
  mode = "big";
  const r = await P.testProvider("custom-1");
  assert.equal(r.ok, false);
  assert.match(r.message, /太大|过大/);
  assert.doesNotMatch(r.message, /连不上/);
});

test("其它状态码：保留 HTTP 状态", async () => {
  mode = "500";
  const r = await P.testProvider("custom-1");
  assert.equal(r.ok, false);
  assert.match(r.message, /HTTP 500/);
});
