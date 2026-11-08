// 0.6.10 审计 f2 车道：HTML 预览安全（199-3-01 DNS 预取、200-3-06 内置脚本要走能力令牌）
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { CFG } from "../gw/config.mjs";
import { NEXT } from "../gw/http.mjs";
import { routePreview } from "../gw/preview.mjs";

const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if ((await routePreview(req, res, u, u.pathname)) !== NEXT) return;
  res.writeHead(404).end();
});
await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
after(() => srv.close());
const base = `http://127.0.0.1:${srv.address().port}`;
const W = CFG.workspace;
fs.mkdirSync(W, { recursive: true });

test("199-3-01 预览页面带 x-dns-prefetch-control:off 和 prefetch-src 'none'", async () => {
  const f = path.join(W, "prev-199.html");
  fs.writeFileSync(f, "<!doctype html><title>t</title><p>hi</p>");
  const g = await fetch(base + "/api/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: f }) });
  assert.equal(g.status, 200);
  const j = await g.json();
  assert.ok(j.url, "预览服务要返回地址");
  const r = await fetch(j.url);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("x-dns-prefetch-control"), "off");
  assert.match(String(r.headers.get("content-security-policy") || ""), /prefetch-src 'none'/);
});

test("200-3-06 预览内置脚本必须带这张凭证的令牌，别的 24 位串取不到", async () => {
  const f = path.join(W, "prev-200.html");
  fs.writeFileSync(f, "<!doctype html><title>t</title><p>hi</p>");
  const g = await fetch(base + "/api/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: f }) });
  const j = await g.json();
  const cap = new URL(j.url).pathname.split("/").filter(Boolean)[0];
  assert.match(cap, /^[0-9a-f]{24}$/);
  let r = await fetch(`http://${new URL(j.url).host}/__cc/${cap}/eruda.js`);
  assert.equal(r.status, 200);
  r = await fetch(`http://${new URL(j.url).host}/__cc/${"0".repeat(24)}/eruda.js`);
  assert.equal(r.status, 404);
});
