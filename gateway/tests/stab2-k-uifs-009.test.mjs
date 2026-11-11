// 第二份稳定性报告 k 组 UIFS-009：接口测试错误若回显认证值，原始上游 message 会进入
// 非掩码的结果文本。虚构 Key + 本机假厂商，验证错误正文里的 Key 被脱敏，正常回复不受影响。
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { CFG } from "../gw/config.mjs";

const FAKE = "cc-review-fake-key-EXAMPLE-ONLY";
let mode = "401-echo-json";
const srv = http.createServer((req, res) => {
  req.resume();
  res.on("error", () => {});
  if (mode === "401-echo-json") {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: `invalid x-api-key: ${FAKE}` } }));
  } else if (mode === "401-echo-text") {
    res.writeHead(401, { "content-type": "text/plain" });
    res.end(`bad key ${FAKE} rejected`);
  } else if (mode === "200-echo-json") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `invalid key ${FAKE}` }));
  } else if (mode === "large-echo") {
    // 超过 8 MB 的响应体：走「响应体太大」分支，不该把内容带出来
    res.writeHead(413, { "content-type": "text/plain" });
    res.end(`too big ${FAKE} `.repeat(600000));
  } else {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "message", content: [] }));
  }
});
await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
after(() => srv.close());

const base = "http://127.0.0.1:" + srv.address().port;
fs.mkdirSync(CFG.home, { recursive: true });
const providersFile = path.join(CFG.home, "ccapp-providers.json");
fs.writeFileSync(providersFile, JSON.stringify({
  active: "custom-1",
  providers: { "custom-1": { label: "t", baseUrl: base, apiKey: FAKE } },
}));
const P = await import("../gw/providers.mjs");
after(() => { try { fs.rmSync(providersFile, { force: true }); } catch {} });

test("UIFS-009：401 JSON 回显认证值时，结果文本里不能出现 Key", async () => {
  mode = "401-echo-json";
  const r = await P.testProvider("custom-1");
  assert.equal(r.ok, false);
  assert.doesNotMatch(r.message, new RegExp(FAKE), "上游回显的 Key 原样进了结果文本");
  assert.match(r.message, /密钥无效/, "原有错误分类要保持");
  assert.match(r.message, /invalid x-api-key: …/, "脱敏后仍保留可排查的上下文");
});

test("UIFS-009：401 纯文本回显认证值时同样脱敏", async () => {
  mode = "401-echo-text";
  const r = await P.testProvider("custom-1");
  assert.equal(r.ok, false);
  assert.doesNotMatch(r.message, new RegExp(FAKE));
  assert.match(r.message, /bad key … rejected/);
});

test("UIFS-009：200 包着错误 JSON 且回显认证值时同样脱敏", async () => {
  mode = "200-echo-json";
  const r = await P.testProvider("custom-1");
  assert.equal(r.ok, false);
  assert.doesNotMatch(r.message, new RegExp(FAKE));
  assert.match(r.message, /invalid key …/);
});

test("UIFS-009：超大响应体分支不带出响应正文", async () => {
  mode = "large-echo";
  const r = await P.testProvider("custom-1");
  assert.equal(r.ok, false);
  assert.doesNotMatch(r.message, new RegExp(FAKE));
  assert.match(r.message, /太大|过大/);
});

test("UIFS-009：正常回复不受脱敏影响（回归保护）", async () => {
  mode = "ok";
  const r = await P.testProvider("custom-1");
  assert.equal(r.ok, true);
  assert.match(r.message, /密钥有效/);
});

test("UIFS-009：短 Key 不做替换，避免搅乱正常文案（边界）", async () => {
  const short = "ab12";
  fs.writeFileSync(providersFile, JSON.stringify({
    active: "custom-1",
    providers: { "custom-1": { label: "t", baseUrl: base, apiKey: short } },
  }));
  const m = await import(`../gw/providers.mjs?short=${Date.now()}`);
  mode = "401-echo-text";
  const r = await m.testProvider("custom-1");
  assert.equal(r.ok, false);
  // 短 Key 不替换：它本来就不是有效的真实密钥，但长 Key 的路径已经覆盖；
  // 这里只断言函数没有把整句文案打碎到无法阅读。
  assert.match(r.message, /bad key/);
});
