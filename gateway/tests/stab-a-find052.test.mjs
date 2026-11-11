// FIND-052：/api/settings 只回显认识的字段（旧版 / 手改 / 导入的设置文件里可能带类凭据字段）；
// 删除接口后，claude 用的密钥缓存文件（ccapp-key*）要一并清掉。
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { CFG, PATHS } from "../gw/config.mjs";
import { NEXT } from "../gw/http.mjs";

fs.mkdirSync(path.dirname(PATHS.settings), { recursive: true });
fs.writeFileSync(PATHS.settings, JSON.stringify({
  model: "m1", permissionMode: "default", permMigrated: 1, guard: true,
  apiKey: "SHOULD-NOT-ECHO", someOldField: 42,
}, null, 2));

const cache = path.join(CFG.home, ".cache");
fs.mkdirSync(cache, { recursive: true });
const keyFiles = ["ccapp-key", "ccapp-key-custom-1", "ccapp-key-term-custom-1", "ccapp-key-custom-2", "ccapp-key-term-custom-2"];
for (const f of keyFiles) fs.writeFileSync(path.join(cache, f), "KEY-" + f);

fs.writeFileSync(path.join(CFG.home, "ccapp-providers.json"), JSON.stringify({ active: "custom-1", providers: {
  "custom-1": { label: "a", baseUrl: "https://a.example", apiKey: "K1" },
  "custom-2": { label: "b", baseUrl: "https://b.example", apiKey: "K2" },
} }));

const { routeSettings } = await import("../gw/settings.mjs");
const { routeProviders, PROVIDER } = await import("../gw/providers.mjs");

after(() => {
  try { fs.rmSync(PATHS.settings, { force: true }); } catch {}
  try { fs.rmSync(path.join(CFG.home, "ccapp-providers.json"), { force: true }); } catch {}
  try { fs.rmSync(cache, { recursive: true, force: true }); } catch {}
});

async function serve(route) {
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    if ((await route(req, res, u, u.pathname)) !== NEXT) return;
    res.writeHead(404).end();
  });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  return {
    srv,
    call: async (p, body) => {
      const r = await fetch(`http://127.0.0.1:${srv.address().port}${p}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) });
      return { status: r.status, body: await r.json() };
    },
  };
}

test("GET /api/settings 不回显未知字段（含类凭据字段）", async (t) => {
  const { srv, call } = await serve(routeSettings);
  t.after(() => srv.close());
  const r = await call("/api/settings");
  assert.equal(r.status, 200);
  assert.equal(r.body.model, "m1");
  assert.equal(r.body.permissionMode, "default");
  assert.equal(r.body.apiKey, undefined, "设置接口不能把旧字段当设置回显");
  assert.equal(r.body.someOldField, undefined, "设置接口不能回显未知字段");
});

test("POST /api/settings 的 settings 回执也不带未知字段", async (t) => {
  const { srv, call } = await serve(routeSettings);
  t.after(() => srv.close());
  const r = await call("/api/settings", { effort: "low" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.settings.apiKey, undefined);
  assert.equal(r.body.settings.someOldField, undefined);
});

test("删除非当前接口：只清它自己的密钥缓存，当前那家的不动", async (t) => {
  assert.equal(PROVIDER.id, "custom-1");
  const { srv, call } = await serve(routeProviders);
  t.after(() => srv.close());
  const r = await call("/api/providers/delete", { id: "custom-2" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(!fs.existsSync(path.join(cache, "ccapp-key-custom-2")));
  assert.ok(!fs.existsSync(path.join(cache, "ccapp-key-term-custom-2")));
  assert.ok(fs.existsSync(path.join(cache, "ccapp-key")), "当前那家的密钥缓存不能被误删");
  assert.ok(fs.existsSync(path.join(cache, "ccapp-key-custom-1")));
});

test("删除当前接口：当前密钥缓存与它自己那份都清掉", async (t) => {
  const { srv, call } = await serve(routeProviders);
  t.after(() => srv.close());
  const r = await call("/api/providers/delete", { id: "custom-1" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(!fs.existsSync(path.join(cache, "ccapp-key")), "当前那家的密钥缓存要清掉");
  assert.ok(!fs.existsSync(path.join(cache, "ccapp-key-custom-1")));
  assert.ok(!fs.existsSync(path.join(cache, "ccapp-key-term-custom-1")));
});
