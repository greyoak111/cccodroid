// 199 H-1：一条连接流水线堆一大串静态请求、不读回应，不能把网关的内存撑起来
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { serveStatic, _staticForTest } from "../gw/http.mjs";

let ok200 = 0, handled = 0;
const srv = http.createServer((req, res) => {
  handled++;
  const wh = res.writeHead; res.writeHead = function (c, ...a) { if (c === 200) ok200++; return wh.call(this, c, ...a); };
  serveStatic(req, res, new URL(req.url, "http://x").pathname);
});
await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
after(() => srv.close());
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));

test("流水线 300 个 2MB 字体请求、一个字节不读：只排得进单连接上限那么多，连接断开后记账归零；正常请求照常", async () => {
  const s = net.connect(srv.address().port, "127.0.0.1");
  s.pause();                                   // 不读回应
  await new Promise((ok) => s.on("connect", ok));
  s.write("GET /fonts/song-600.woff2 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n".repeat(300));
  for (let i = 0; i < 100 && handled < 300; i++) await wait(50);
  await wait(300);
  assert.ok(ok200 > 0 && ok200 <= 16, "单连接最多排 32MB：" + ok200);
  for (let i = 0; i < 50 && _staticForTest.pending() > 0; i++) await wait(100);
  assert.equal(_staticForTest.pending(), 0, "断开后排队字节全部归还");
  s.destroy();
  const r = await fetch(`http://127.0.0.1:${srv.address().port}/fonts/song-600.woff2`);
  assert.equal(r.status, 200);
  assert.equal((await r.arrayBuffer()).byteLength, 2138828);
  assert.equal(_staticForTest.pending(), 0, "正常发完也归还");
});
