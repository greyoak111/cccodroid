// v0.5.20 审查第 3 批：模型清单（#102 04-001 / 04-002）。fetch 换成假的，不联网
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { fetchModels, cachedModels } from "../gw/models.mjs";

const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
let catGate, catDone = false, listReply = () => json({ data: [{ id: "m1" }, { id: "m9" }] });   // m9 没窗口：让目录去载入
const catReady = new Promise((r) => { catGate = r; });
const orig = globalThis.fetch;
globalThis.fetch = async (u) => {
  const s = String(u);
  if (s.includes("models.dev")) { await catReady; catDone = true; return json({ other: { models: { m1: { limit: { context: 1048576, output: 8000 } } } } }); }
  if (s.startsWith("https://fixture.example/")) return listReply(s);
  throw new Error("fixture: unexpected fetch " + s);
};
after(() => { globalThis.fetch = orig; catGate(); });

test("04-001 用户声明的窗口优先：公共目录载入前后都是 128k，不被同名目录的 1M 盖掉", async () => {
  const p = { id: "custom-m0520a", custom: true, baseUrl: "https://fixture.example/v1", modelsUrl: "https://fixture.example/v1/models", modelsAuth: "none", contextWindow: 131072, defaultModel: "m1" };
  const a = await fetchModels(true, p);
  assert.equal(a.find((m) => m.id === "m1").context_window, 131072);
  catGate();
  const t0 = Date.now(); while (!catDone && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 10));
  assert.ok(catDone, "目录得真的载入过，这条才有意义");
  await new Promise((r) => setTimeout(r, 50));
  const b = await fetchModels(true, p);
  assert.equal(b.find((m) => m.id === "m1").context_window, 131072);
});

test("04-002 同一配置两次刷新重叠、先发的后回来：缓存留后发起的那次", async () => {
  const p = { id: "custom-m0520b", custom: true, baseUrl: "https://fixture.example/v1", modelsUrl: "https://fixture.example/v1/models", modelsAuth: "none" };
  let n = 0;
  listReply = async () => {
    const mine = ++n;
    if (mine === 1) { await new Promise((r) => setTimeout(r, 200)); return json({ data: [{ id: "m2", context_window: 1048576 }] }); }
    return json({ data: [{ id: "m2", context_window: 131072 }] });
  };
  const slow = fetchModels(true, p);
  await new Promise((r) => setTimeout(r, 20));
  const fast = await fetchModels(true, p);
  assert.equal(fast[0].context_window, 131072);
  await slow;
  assert.equal(cachedModels(p).find((m) => m.id === "m2").context_window, 131072);
});
