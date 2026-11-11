// 第二份稳定性报告 k 组 UIFS-009 的扩展：余额查询失败时，上游报错原文作为 balanceError
// 显示在设置页的厂商卡片上。上游把认证值回显进 message 时，Key 不能跟着显示出来。
// 余额接口地址写死在官方域名上，这里只替换 fetch 对那个域名的请求，不外发。
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { CFG } from "../gw/config.mjs";

const FAKE = "cc-review-fake-key-EXAMPLE-ONLY";
const realFetch = globalThis.fetch;
let hits = 0;
globalThis.fetch = async (url, opts) => {
  const u = String(url instanceof URL ? url.href : url && url.url ? url.url : url);
  if (u.startsWith("https://api.deepseek.com/")) {
    hits++;
    return new Response(JSON.stringify({ error: { message: `Authentication Fails, Your api key: ${FAKE} is invalid` } }),
      { status: 401, headers: { "content-type": "application/json" } });
  }
  if (/^https?:\/\/127\.0\.0\.1[:/]/.test(u)) return realFetch(url, opts);
  throw new Error("测试里不外发：" + u);
};
after(() => { globalThis.fetch = realFetch; });

fs.mkdirSync(CFG.home, { recursive: true });
const providersFile = path.join(CFG.home, "ccapp-providers.json");
fs.writeFileSync(providersFile, JSON.stringify({
  active: "deepseek-t",
  providers: { "deepseek-t": { label: "t", baseUrl: "https://api.deepseek.com/anthropic", apiKey: FAKE } },
}));
after(() => { try { fs.rmSync(providersFile, { force: true }); } catch {} });
const { routeProviders } = await import("../gw/providers.mjs");
const { NEXT } = await import("../gw/http.mjs");

const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if ((await routeProviders(req, res, u, u.pathname)) === NEXT) res.writeHead(404).end();
});
await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
after(() => srv.close());

test("UIFS-009b：余额查询的上游报错回显认证值时，balanceError 里不能出现 Key", async () => {
  const r = await realFetch(`http://127.0.0.1:${srv.address().port}/api/billing?id=deepseek-t&refresh=1`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(hits >= 1, "没有走到余额查询");
  assert.equal(typeof j.balanceError, "string", "应带回余额错误");
  assert.doesNotMatch(j.balanceError, new RegExp(FAKE), "上游回显的 Key 原样进了 balanceError");
  assert.match(j.balanceError, /HTTP 401/, "脱敏后仍保留状态码");
  assert.match(j.balanceError, /Your api key: … is invalid/, "脱敏后仍保留可排查的上下文");
});
