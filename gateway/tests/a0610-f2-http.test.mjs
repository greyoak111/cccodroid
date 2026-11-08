// 0.6.10 审计 f2 车道：请求体超限（195-C.19 / 200-H-2）
// 以前超限先 req.destroy()，413 送不到界面，前端只看见 Failed to fetch；现在把余下的读掉丢掉，正常回 413。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readBody, readBodyBuf } from "../gw/http.mjs";

async function serve() {
  const srv = http.createServer(async (req, res) => {
    try {
      const b = req.url === "/buf" ? await readBodyBuf(req, 8) : await readBody(req);
      res.writeHead(200, { "content-type": "text/plain" }).end(String(b.length));
    } catch (e) {
      res.writeHead(e.status || 500, { "content-type": "text/plain" }).end(String(e.message));
    }
  });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  after(() => srv.close());
  return `http://127.0.0.1:${srv.address().port}`;
}

test("195-C.19 请求体超过 readBodyBuf 上限时回 413，且连接没被提前掐断", async () => {
  const base = await serve();
  const r = await fetch(base + "/buf", { method: "POST", body: "x".repeat(4096) });
  assert.equal(r.status, 413);
  assert.equal(await r.text(), "body too large");
  // 上限以内照常读
  const ok = await fetch(base + "/buf", { method: "POST", body: "abcd" });
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "4");
});
