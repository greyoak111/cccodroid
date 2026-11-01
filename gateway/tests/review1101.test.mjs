// 11-01 v0.5.18 独立审查的回归：低-1 目录探测、低-2 插件名进命令行、低-3 /api/app 字段白名单
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { CFG } from "../gw/config.mjs";
import { NEXT } from "../gw/http.mjs";
import { routeFiles } from "../gw/files.mjs";
import { routeExtensions } from "../gw/extensions.mjs";
import { routeDevside } from "../gw/devside.mjs";

const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  for (const r of [routeFiles, routeExtensions, routeDevside]) if ((await r(req, res, u, u.pathname)) !== NEXT) return;
  res.writeHead(404).end();
});
await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
after(() => srv.close());
const base = `http://127.0.0.1:${srv.address().port}`;
const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };
const post = async (p, b) => { const r = await fetch(base + p, { method: "POST", body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };

test("低-1 /api/file/stat 对私有目录也返回 403，工作区目录照常", async () => {
  fs.mkdirSync(CFG.workspace, { recursive: true });
  const h = await get("/api/file/stat?path=" + encodeURIComponent(CFG.home));
  assert.equal(h.status, 403);
  assert.equal(h.body.path, undefined);
  const w = await get("/api/file/stat?path=" + encodeURIComponent(CFG.workspace));
  assert.equal(w.status, 200);
  assert.equal(w.body.dir, true);
});

test("低-2 插件 / 市场 / MCP 的名字以横线开头直接拒，不交给 claude", async () => {
  for (const [p, b] of [["/api/ext/plugins/install", { id: "--help" }], ["/api/ext/plugins/install", { id: "x@y", accept: "-a" }],
    ["/api/ext/plugins/uninstall", { id: "-x" }], ["/api/ext/plugins/enable", { id: "a\nb" }]]) {
    const r = await post(p, b);
    assert.equal(r.body.ok, false, p);
    assert.match(r.body.message, /名字格式不对|Invalid name/);
  }
});

test("低-3 /api/app 只转认得的字段、认得的类型", async () => {
  assert.equal((await post("/api/app/upd_set", { auto: "yes" })).status, 400);
  assert.equal((await post("/api/app/share_file", { path: ["/x"] })).status, 400);
  assert.equal((await post("/api/app/dev_set", { idle: "5" })).status, 400);
});
