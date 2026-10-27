// 模型清单目录补全（gw/models.mjs）：models.dev 解析与按厂商/按 id 补窗口的纯逻辑，不联网
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyCatalog, buildCatalog, catalogKeys } from "../gw/models.mjs";

// 同一 id 在不同厂商目录里窗口不一样：m2 有 200000/4000 两票，128000/0 一票
const RAW = {
  p1: { models: {
    "m1": { limit: { context: 200000, output: 8000 } },
    "m2": { limit: { context: 128000 } },
    "no-ctx": {},
  } },
  p2: { models: {
    "m1": { limit: { context: 200000, output: 8000 } },
    "m2": { limit: { context: 200000, output: 4000 } },
  } },
  p3: { models: { "m2": { limit: { context: 200000, output: 4000 } } } },
};

test("buildCatalog：按厂商一张表、按 id 一张表，同 id 取多数，没有窗口的条目跳过", () => {
  const cat = buildCatalog(RAW);
  assert.deepEqual(cat.byProv.get("p1").get("m1"), { context_window: 200000, max_output_tokens: 8000 });
  assert.equal(cat.byProv.get("p1").has("no-ctx"), false);
  assert.deepEqual(cat.byId.get("m2"), { context_window: 200000, max_output_tokens: 4000 });
  assert.deepEqual(cat.byId.get("m1"), { context_window: 200000, max_output_tokens: 8000 });
  assert.equal(buildCatalog(null).byId.size, 0);
  assert.equal(buildCatalog({}).byProv.size, 0);
});

test("applyCatalog：只补完全没有窗口的条目，厂商报过窗口的整条不动", () => {
  const cat = buildCatalog(RAW);
  const list = [
    { id: "m1", context_window: 0, max_output_tokens: 0 },
    { id: "m2", context_window: 100000, max_output_tokens: 0 },
    { id: "unknown", context_window: 0, max_output_tokens: 0 },
  ];
  const out = applyCatalog(list, cat, []);
  assert.deepEqual(out[0], { id: "m1", context_window: 200000, max_output_tokens: 8000 });
  // 厂商报过窗口就不动（输出上限也不补，否则每次都要为已知窗口再拉一遍目录）
  assert.deepEqual(out[1], { id: "m2", context_window: 100000, max_output_tokens: 0 });
  assert.deepEqual(out[2], { id: "unknown", context_window: 0, max_output_tokens: 0 });
});

test("applyCatalog：厂商目录优先于全局同 id，找不到再退回全局", () => {
  const cat = buildCatalog(RAW);
  // p1 目录里 m2 是 128000；按 id 的多数票是 200000
  assert.equal(applyCatalog([{ id: "m2" }], cat, ["p1"])[0].context_window, 128000);
  // p2 里没有 m3：退回 byId
  const withM3 = buildCatalog({ ...RAW, p3: { models: { ...RAW.p3.models, m3: { limit: { context: 64000, output: 2000 } } } } });
  assert.equal(applyCatalog([{ id: "m3" }], withM3, ["p1"])[0].context_window, 64000);
});

test("applyCatalog：全都已有窗口 / 目录拉不到时原样返回", () => {
  const list = [{ id: "m1", context_window: 1000 }];
  assert.equal(applyCatalog(list, buildCatalog(RAW), []), list);
  assert.equal(applyCatalog([{ id: "m1", context_window: 0 }], null, ["p1"]).length, 1);
});

test("catalogKeys：配置里写死的排前面，域名按 api.<名>.<后缀> 猜出 <名>-go 与 <名>", () => {
  assert.deepEqual(catalogKeys({ catalog: "custom", baseUrl: "https://api.opencode.ai/v1" }), ["custom", "opencode-go", "opencode"]);
  assert.deepEqual(catalogKeys({ baseUrl: "https://example.com/v1" }), ["example-go", "example"]);
  assert.deepEqual(catalogKeys({ baseUrl: "不是网址" }), []);
});
