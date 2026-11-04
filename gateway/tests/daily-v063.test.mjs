// v0.6.3 日常使用审查（#142–#147）里网关侧的几项
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { NEXT } from "../gw/http.mjs";
import { routeProviders } from "../gw/providers.mjs";
import { sessModel, setSessModel } from "../gw/sessmodel.mjs";
import { handleLocalCommand } from "../gw/modelcmd.mjs";

async function serve(...routes) {
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    try {
      for (const r of routes) if ((await r(req, res, u, u.pathname)) !== NEXT) return;
      res.writeHead(404).end();
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  after(() => srv.close());
  return (p, init) => fetch(`http://127.0.0.1:${srv.address().port}${p}`, init);
}
const go = await serve(routeProviders);
const post = async (p, b, method = "POST") => (await go(p, { method, body: JSON.stringify(b) })).json();

test("/model 等清单时点了停止：迟到的清单不再改型号（#142-1）", async () => {
  let release, hit;
  const gotHit = new Promise((yes) => { hit = yes; });
  const models = http.createServer((req, res) => {
    release = () => res.end(JSON.stringify({ data: [{ id: "s1", context_window: 131072 }, { id: "s2", context_window: 131072 }] }));
    hit();
  });
  await new Promise((ok) => models.listen(0, "127.0.0.1", ok));
  after(() => models.close());
  const base = `http://127.0.0.1:${models.address().port}`;
  const p0 = await post("/api/providers/save", { label: "s142", baseUrl: base, modelsUrl: base + "/v1/models", apiKey: "fixture-only", defaultModel: "s1" });
  assert.ok(p0.id, JSON.stringify(p0));
  const sid = crypto.randomUUID();
  setSessModel(sid, { provider: p0.id, model: "s1", effort: "" });
  let out = "", stopped = false;
  const p = handleLocalCommand("model", "s2", (t) => { out = t; }, sid, () => stopped);
  await gotHit;
  stopped = true;   // 用户点了停止
  release();
  await p;
  assert.match(out, /已停止/);
  assert.equal(sessModel(sid).model, "s1", "停止后的命令不能再落盘");
  // 没停的照常生效
  const q = handleLocalCommand("model", "s2", (t) => { out = t; }, sid, () => false);
  await q;
  assert.equal(sessModel(sid).model, "s2");
  await post("/api/providers/delete", { id: p0.id });
});
