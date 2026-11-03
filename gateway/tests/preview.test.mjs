// HTML 预览（gw/preview.mjs）：凭证能读到页面目录里的资源，但以点开头的路径、私钥证书一类不交（审查 10-29 高1）
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下，下面一行都不跑
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { CFG } from "../gw/config.mjs";
import { routePreview } from "../gw/preview.mjs";

// 每次建一个新的独有目录：绕过 scripts/test.mjs 直接跑时，收尾也只删自己建的，不会碰工作区里已有的 pvtest（#49 P2-18）
fs.mkdirSync(CFG.workspace, { recursive: true });
const site = fs.mkdtempSync(path.join(CFG.workspace, "pvtest-"));
for (const [f, s] of Object.entries({ "index.html": "<p>hi</p>", "assets/app.js": "1", ".env": "KEY=1", ".git/config": "x", "certs/server.key": "k", "id_ed25519": "k", ".well-known/a.json": "{}" })) {
  fs.mkdirSync(path.dirname(path.join(site, f)), { recursive: true });
  fs.writeFileSync(path.join(site, f), s);
}
const gw = http.createServer((req, res) => routePreview(req, res, new URL(req.url, "http://x"), new URL(req.url, "http://x").pathname));
await new Promise((ok) => gw.listen(0, "127.0.0.1", ok));
after(() => { gw.close(); fs.rmSync(site, { recursive: true, force: true }); });

test("预览凭证：页面资源照常，点路径和私钥不交", async () => {
  const r = await (await fetch(`http://127.0.0.1:${gw.address().port}/api/preview`, { method: "POST", body: JSON.stringify({ path: path.join(site, "index.html") }) })).json();
  assert.match(r.url, /^http:\/\/localhost:\d+\/[0-9a-f]{24}\/index\.html$/);
  const base = r.url.replace(/index\.html$/, "");
  const code = async (rel) => (await fetch(base + rel)).status;
  assert.equal(await code("index.html"), 200);
  assert.equal((await fetch(base + "index.html")).headers.get("referrer-policy"), "same-origin", "带令牌的网址只给同源当 Referer（外站拿不到；预览服务自己靠它给站点绝对路径找凭证）");
  assert.equal((await fetch(base + "nope.html")).headers.get("referrer-policy"), "same-origin");
  assert.equal(await code("assets/app.js"), 200);
  assert.equal(await code(".well-known/a.json"), 200);
  for (const rel of [".env", ".git/config", "certs/server.key", "id_ed25519", "assets/../.env"]) assert.equal(await code(rel), 403, rel);
});

test("默认断网：带 CSP 和回报地址，拦下的外站记下来；点「联网」后不再带 CSP（审查 v0513b 中-5）", async () => {
  const api = (b) => fetch(`http://127.0.0.1:${gw.address().port}/api/preview`, { method: "POST", body: JSON.stringify(b) }).then((r) => r.json());
  const r = await api({ path: path.join(site, "index.html") });
  assert.equal(r.net, false);
  const cap = r.url.match(/\/([0-9a-f]{24})\//)[1];
  const csp = (await fetch(r.url)).headers.get("content-security-policy") || "";
  assert.match(csp, /connect-src 'self'/);
  assert.match(csp, /form-action 'self'/);
  assert.match(csp, new RegExp(`report-uri /__cc/csp/${cap}$`));
  assert.ok(!/default-src[^;]*\*/.test(csp), "default-src 不能放开");
  const origin = new URL(r.url).origin;
  const rep = await fetch(`${origin}/__cc/csp/${cap}`, { method: "POST", headers: { "content-type": "application/csp-report" }, body: JSON.stringify({ "csp-report": { "blocked-uri": "https://evil.example/x?d=1" } }) });
  assert.equal(rep.status, 204);
  // 别人的凭证、乱写的报告不出错也不记
  assert.equal((await fetch(`${origin}/__cc/csp/${"0".repeat(24)}`, { method: "POST", body: "{}" })).status, 204);
  assert.equal((await fetch(`${origin}/__cc/csp/${cap}`, { method: "POST", body: "not json" })).status, 204);
  const st = await (await fetch(`http://127.0.0.1:${gw.address().port}/api/preview/state?cap=${cap}`)).json();
  assert.deepEqual(st, { net: false, blocked: ["evil.example"] });
  // 打开联网：同一凭证、不带 CSP、拦截记录清空
  const r2 = await api({ path: path.join(site, "index.html"), net: true });
  assert.equal(r2.url, r.url);
  assert.equal(r2.net, true);
  assert.equal((await fetch(r.url)).headers.get("content-security-policy"), null);
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${gw.address().port}/api/preview/state?cap=${cap}`)).json(), { net: true, blocked: [] });
  // 不传 net 的刷新沿用上次的选择
  assert.equal((await api({ path: path.join(site, "index.html") })).net, true);
  await api({ path: path.join(site, "index.html"), net: false });
  assert.match((await fetch(r.url)).headers.get("content-security-policy") || "", /connect-src 'self'/);
});

test("联网只给点头的那个网页：同目录换一页不继承（11-03 审查 M-2）", async () => {
  const api = (b) => fetch(`http://127.0.0.1:${gw.address().port}/api/preview`, { method: "POST", body: JSON.stringify(b) }).then((r) => r.json());
  fs.writeFileSync(path.join(site, "other.html"), "<p>b</p>");
  assert.equal((await api({ path: path.join(site, "index.html"), net: true })).net, true);
  assert.equal((await api({ path: path.join(site, "other.html") })).net, false, "换了网页要重新允许");
  assert.equal((await api({ path: path.join(site, "index.html") })).net, false, "回到原来那页也不复活（凭证已被换页改成断网）");
  await api({ path: path.join(site, "index.html"), net: false });
});

test("联网的网页里点链接跳到同目录别的网页：那一页照离线处理（复核 11-03 M-2 余项）", async () => {
  const api = (b) => fetch(`http://127.0.0.1:${gw.address().port}/api/preview`, { method: "POST", body: JSON.stringify(b) }).then((r) => r.json());
  fs.writeFileSync(path.join(site, "other.html"), "<p>b</p>");
  const r = await api({ path: path.join(site, "index.html"), net: true });
  // fetch 会自己把 sec-fetch-mode 设成 cors，模拟整页导航得用 http.get
  const base = r.url.replace(/index\.html$/, "");
  const csp = (rel, mode) => new Promise((ok, no) => http.get(base + rel, { headers: { "sec-fetch-mode": mode } }, (res) => { res.resume(); ok(res.headers["content-security-policy"] || null); }).on("error", no));
  assert.equal(await csp("index.html", "navigate"), null, "点了头的那页联网");
  assert.ok(await csp("other.html", "navigate"), "跳过去的那页要带离线 CSP");
  assert.equal(await csp("assets/app.js", "no-cors"), null, "那页自己的资源照常");
  await api({ path: path.join(site, "index.html"), net: false });
});
