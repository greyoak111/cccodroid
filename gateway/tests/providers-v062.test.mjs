// v0.6.2 审查 #122：接口号不复用、删除写盘失败回滚、/model 等清单期间换家的竞态
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { NEXT } from "../gw/http.mjs";
import { PATHS } from "../gw/config.mjs";
import { routeProviders, providerById } from "../gw/providers.mjs";
import { routeProjects } from "../gw/projects.mjs";
import { effectiveModel, sessModel, setSessModel } from "../gw/sessmodel.mjs";
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
const go = await serve(routeProviders, routeProjects);
const post = async (p, b, method = "POST") => (await go(p, { method, body: JSON.stringify(b) })).json();
const newProvider = (tag, extra = {}) => post("/api/providers/save", { label: tag, baseUrl: `https://${tag}.example.invalid`, apiKey: "fixture-only", ...extra });

test("删掉的自定义接口号不再发给新接口（#122-1）", async () => {
  const a = await newProvider("a122");
  assert.ok(a.id, JSON.stringify(a));
  assert.equal((await post("/api/providers/delete", { id: a.id })).ok, true);
  const b = await newProvider("b122");
  assert.ok(b.id, JSON.stringify(b));
  assert.notEqual(b.id, a.id, "旧会话里记着的 id 不能落到新接口上");
  assert.ok(Number(b.id.split("-")[1]) > Number(a.id.split("-")[1]), "号只增不减");
  await post("/api/providers/delete", { id: b.id });
});

test("删除接口写盘失败：内存回滚，重删和之后保存别的接口都不会把它带死（#122-5）", async () => {
  const a = await newProvider("a122d");
  assert.ok(a.id, JSON.stringify(a));
  const orig = fs.renameSync;
  let failed = false;
  fs.renameSync = (from, to) => {
    if (!failed && String(to).endsWith("ccapp-providers.json")) { failed = true; const e = new Error("EIO: injected"); e.code = "EIO"; throw e; }
    return orig(from, to);
  };
  let r1;
  try { r1 = await post("/api/providers/delete", { id: a.id }); }
  finally { fs.renameSync = orig; }
  assert.ok(r1.error, "写盘失败要明确报错");
  assert.ok(providerById(a.id), "失败后内存里的原始表要回滚，这家还在");
  // 之后保存一个无关接口：整表落盘时不能把这次没成功的删除顺手兑现
  const c = await newProvider("c122d");
  assert.ok(c.id, JSON.stringify(c));
  const list = await (await go("/api/providers")).json();
  assert.ok(list.providers.some((p) => p.id === a.id), "失败的删除不能在下一次保存时被带提交");
  assert.equal((await post("/api/providers/delete", { id: a.id })).ok, true, "原始表已回滚，重删还能删");
  await post("/api/providers/delete", { id: c.id });
});

test("/model 等清单时项目接口换了：不把旧接口的型号写进新接口（#122-2）", async () => {
  let release, hit;
  const gotHit = new Promise((yes) => { hit = yes; });
  const models = http.createServer((req, res) => {
    release = () => res.end(JSON.stringify({ data: [{ id: "a2", context_window: 131072 }] }));
    hit();
  });
  await new Promise((ok) => models.listen(0, "127.0.0.1", ok));
  after(() => models.close());
  const base = `http://127.0.0.1:${models.address().port}`;
  const a = await newProvider("a122m", { baseUrl: base, modelsUrl: base + "/v1/models", defaultModel: "a1" });
  assert.ok(a.id, JSON.stringify(a));
  const dir = fs.mkdtempSync(path.join(process.env.CCAPP_WORKSPACE, "p122m-"));
  const proj = (await post("/api/projects", { name: "p122m", mode: "dir", path: dir })).project;
  await post("/api/projects/" + proj.id, { provider: a.id, model: "a1" }, "PATCH");
  const sid = crypto.randomUUID(), sdir = path.join(PATHS.projects, "-p122m");
  fs.mkdirSync(sdir, { recursive: true });
  fs.writeFileSync(path.join(sdir, sid + ".jsonl"), JSON.stringify({ type: "user", uuid: crypto.randomUUID(), sessionId: sid, cwd: dir, message: { role: "user", content: "hi" } }) + "\n");
  assert.equal(effectiveModel(sid).provider, a.id);
  let out = "";
  const p = handleLocalCommand("model", "a2", (t) => { out = t; }, sid);
  await gotHit;   // 命令已经拿到 A 的清单请求，正等着它回来
  assert.equal((await post("/api/providers/delete", { id: a.id })).ok, true, "等待期间接口没了");
  release();
  await p;
  assert.match(out, /没改成/);
  assert.equal(sessModel(sid), null, "不能把 A 的型号写进回落后生效的那家");
});

test("/model 等清单时同一家里型号被会话面板改了：旧命令不盖掉后来的选择（#122-2 复核）", async () => {
  let release, hit;
  const gotHit = new Promise((yes) => { hit = yes; });
  const models = http.createServer((req, res) => {
    release = () => res.end(JSON.stringify({ data: [{ id: "b2", context_window: 131072 }, { id: "b3", context_window: 131072 }] }));
    hit();
  });
  await new Promise((ok) => models.listen(0, "127.0.0.1", ok));
  after(() => models.close());
  const base = `http://127.0.0.1:${models.address().port}`;
  const b = await newProvider("b122m", { baseUrl: base, modelsUrl: base + "/v1/models", defaultModel: "b1" });
  assert.ok(b.id, JSON.stringify(b));
  const sid = crypto.randomUUID();
  setSessModel(sid, { provider: b.id, model: "b1", effort: "" });
  let out = "";
  const p = handleLocalCommand("model", "b2", (t) => { out = t; }, sid);
  await gotHit;
  setSessModel(sid, { provider: b.id, model: "b3", effort: "" });   // 用户在会话面板选了 b3
  release();
  await p;
  assert.match(out, /没改成/);
  assert.equal(sessModel(sid).model, "b3", "后来在面板选的型号要留着");
  await post("/api/providers/delete", { id: b.id });
});
