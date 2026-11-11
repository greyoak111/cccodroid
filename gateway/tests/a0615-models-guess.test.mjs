// 自定义端口没填模型清单地址时按接口地址猜：只出同主机同端口的候选，带不走密钥
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { guessModelsUrls } from "../gw/models.mjs";
import { modelsUrlOk } from "../gw/providers.mjs";

test("猜清单地址：去掉 /anthropic、/v1 后缀，拼 /v1/models、/models，再试主机根", () => {
  assert.deepEqual(guessModelsUrls("https://opencode.ai/inference/go/anthropic"),
    ["https://opencode.ai/inference/go/v1/models", "https://opencode.ai/inference/go/models", "https://opencode.ai/v1/models"]);
  assert.deepEqual(guessModelsUrls("https://api.x.com/v1/"), ["https://api.x.com/v1/models", "https://api.x.com/models"]);
  assert.deepEqual(guessModelsUrls("https://relay.example.com"), ["https://relay.example.com/v1/models", "https://relay.example.com/models"]);
  assert.deepEqual(guessModelsUrls("https://a.com/api/anthropic/v1/messages")[0], "https://a.com/api/v1/models");
  assert.deepEqual(guessModelsUrls("not a url"), []);
});

test("候选都和接口同主机同端口，过得了 modelsUrlOk；明文 http 的外站不放行", () => {
  for (const b of ["https://opencode.ai/inference/go/anthropic", "https://relay.example.com:8443/anthropic", "http://127.0.0.1:4000/v1"])
    for (const m of guessModelsUrls(b)) assert.equal(modelsUrlOk({ baseUrl: b, modelsUrl: m }), true, m);
  for (const m of guessModelsUrls("http://relay.example.com/anthropic")) assert.equal(modelsUrlOk({ baseUrl: "http://relay.example.com/anthropic", modelsUrl: m }), false);
});

test("没填清单地址的自定义端口：猜中 /v1/models 就用上，带的是 Bearer 密钥", async () => {
  const http = await import("node:http");
  const { fetchModels } = await import("../gw/models.mjs");
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push([req.url, req.headers.authorization]);
    if (req.url === "/relay/v1/models") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "relay-m1" }, { id: "relay-m2" }] })); }
    else { res.writeHead(404); res.end("{}"); }
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const p = { id: "custom-9", custom: true, group: "custom", authStyle: "bearer", modelsAuth: "bearer", apiKey: "sk-test",
      baseUrl: `http://127.0.0.1:${srv.address().port}/relay/anthropic`, modelsUrl: "", defaultModel: "relay-m1" };
    const list = await fetchModels(true, p);
    assert.deepEqual(list.map((m) => m.id).filter((x) => x.startsWith("relay-")).sort(), ["relay-m1", "relay-m2"]);
    assert.equal(hits[0][0], "/relay/v1/models");
    assert.equal(hits[0][1], "Bearer sk-test");
  } finally { srv.close(); }
});
