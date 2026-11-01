// v0.5.18：#77 旧清单请求不回写已清的缓存、#78 本地命令按项目接口、#82 清单外型号不借别人的窗口
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { NEXT } from "../gw/http.mjs";
import { PATHS } from "../gw/config.mjs";
import { cachedModels, dropModelCache, fetchModels, routeModels } from "../gw/models.mjs";
import { currentModelInfo } from "../gw/claude.mjs";
import { providerById, routeProviders } from "../gw/providers.mjs";
import { routeProjects } from "../gw/projects.mjs";
import { effectiveModel, setSessModel } from "../gw/sessmodel.mjs";
import { handleLocalCommand } from "../gw/modelcmd.mjs";

async function serve(...routes) {
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    for (const r of routes) if ((await r(req, res, u, u.pathname)) !== NEXT) return;
    res.writeHead(404).end();
  });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  after(() => srv.close());
  return (p, init) => fetch(`http://127.0.0.1:${srv.address().port}${p}`, init);
}
const go = await serve(routeProviders, routeProjects, routeModels);
const post = async (p, b, method = "POST") => (await go(p, { method, body: JSON.stringify(b) })).json();
const inline = (list) => "data:application/json," + encodeURIComponent(JSON.stringify({ data: list }));

test("改了接口配置后，改之前发出的清单请求回来也不写回缓存（#77）", async () => {
  let release;
  const srv = http.createServer((req, res) => { release = () => res.end(JSON.stringify({ data: [{ id: "shared-model", context_window: 1048576 }] })); });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  const p = { id: "custom-gen", custom: true, baseUrl: base, modelsUrl: base + "/v1/models", modelsAuth: "none", defaultModel: "shared-model",
    fallbackModels: [{ id: "shared-model", context_window: 131072 }] };
  const old = fetchModels(true, p);
  while (!release) await new Promise((r) => setTimeout(r, 5));
  dropModelCache();                 // 保存新配置时做的就是这个
  release();
  assert.equal((await old)[0].context_window, 1048576);   // 旧请求的调用方照常拿到它的结果
  assert.equal(cachedModels(p)[0].context_window, 131072, "旧结果不能回写进缓存");
});

test("保存前拿到的旧接口对象、保存后才去拉清单：结果不算新配置的（#77 复核 M1）", async () => {
  const oldP = { id: "custom-sig", custom: true, baseUrl: "https://example.invalid", defaultModel: "m",
    modelsUrl: inline([{ id: "m", context_window: 1048576 }]) };
  const newP = { ...oldP, modelsUrl: inline([{ id: "m", context_window: 131072 }]) };
  dropModelCache();                       // 先保存
  await fetchModels(false, oldP);         // 再拿旧对象去拉（run.mjs 等桥那几秒）
  assert.equal(cachedModels(newP)[0].context_window, 131072);
  assert.equal((await fetchModels(false, newP))[0].context_window, 131072);
  assert.equal(currentModelInfo("m", newP).context_window, 131072);
});

test("清单外型号：能力和窗口是不知道，不借默认或第一项的（#82）", async () => {
  const p = { id: "custom-82", custom: true, baseUrl: "https://example.invalid", defaultModel: "listed-large",
    fallbackModels: [{ id: "listed-large", context_window: 1048576, max_output_tokens: 32768 }] };
  assert.deepEqual(currentModelInfo("unlisted-small", p), {});
  assert.equal(currentModelInfo("", p).context_window, 1048576);                       // 没指定 = 默认型号
  assert.deepEqual(currentModelInfo("", { ...p, defaultModel: "unlisted-small" }), {});  // 默认型号不在清单里也不借第一项
  assert.equal(currentModelInfo("", { ...p, defaultModel: undefined }).context_window, 1048576);   // 没默认才是第一项

  const r = await post("/api/providers/save", { label: "清单外", baseUrl: "https://example.invalid", apiKey: "fixture-only",
    defaultModel: "listed-large", modelsUrl: inline([{ id: "listed-large", context_window: 1048576, max_output_tokens: 32768 }]) });
  assert.ok(r.ok, JSON.stringify(r));
  const m = await (await go(`/api/models?provider=${r.id}&model=unlisted-small`)).json();
  assert.equal(m.current, "unlisted-small");
  assert.equal(m.contextWindow, 0);
  assert.equal(m.maxOutputTokens, 0);
  const k = await (await go(`/api/models?provider=${r.id}&model=listed-large`)).json();
  assert.equal(k.contextWindow, 1048576);
});

test("项目指定了接口：/autocompact、/model 按项目那家，选型号也不钉回全局（#78）", async () => {
  const r = await post("/api/providers/save", { label: "项目接口", baseUrl: "https://b.example.invalid", apiKey: "fixture-only",
    defaultModel: "B-small", modelsUrl: inline([{ id: "B-small", context_window: 131072 }, { id: "B-other", context_window: 65536 }]) });
  assert.ok(r.ok, JSON.stringify(r));
  const dir = fs.mkdtempSync(path.join(process.env.CCAPP_WORKSPACE, "p78-"));
  const proj = (await post("/api/projects", { name: "p78", mode: "dir", path: dir })).project;
  await post("/api/projects/" + proj.id, { provider: r.id, model: "B-small" }, "PATCH");
  const sid = crypto.randomUUID(), sdir = path.join(PATHS.projects, "-p78");
  fs.mkdirSync(sdir, { recursive: true });
  fs.writeFileSync(path.join(sdir, sid + ".jsonl"), JSON.stringify({ type: "user", uuid: crypto.randomUUID(), sessionId: sid, cwd: dir, message: { role: "user", content: "hi" } }) + "\n");
  assert.equal(effectiveModel(sid).provider, r.id);
  assert.ok(providerById(r.id));

  let out = "";
  await handleLocalCommand("autocompact", "", (t) => { out = t; }, sid);
  assert.match(out, /当前模型窗口 131k/);
  await handleLocalCommand("model", "", (t) => { out = t; }, sid);
  assert.match(out, /B-other/);
  await handleLocalCommand("model", "B-other", (t) => { out = t; }, sid);
  const now = effectiveModel(sid);
  assert.equal(now.provider, r.id, "只改型号：接口留在项目那家");
  assert.equal(now.model, "B-other");

  // 输入栏面板只给型号时（pickSessModel 不带 provider）也一样
  const sid2 = crypto.randomUUID();
  fs.writeFileSync(path.join(sdir, sid2 + ".jsonl"), JSON.stringify({ type: "user", uuid: crypto.randomUUID(), sessionId: sid2, cwd: dir, message: { role: "user", content: "hi" } }) + "\n");
  setSessModel(sid2, { model: "B-other" });
  assert.equal(effectiveModel(sid2).provider, r.id);

  // 新会话首条记 pin 时会话文件还没落盘：按项目号定，不钉回全局（复核 M2）
  const sid3 = crypto.randomUUID();
  setSessModel(sid3, { model: "B-other" }, proj.id);
  assert.equal(effectiveModel(sid3).provider, r.id);
});
