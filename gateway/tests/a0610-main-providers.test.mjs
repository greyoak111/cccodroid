// 厂商配置（gw/providers.mjs）：0.6.9 审计 P1-1 / P1-2 / P1-8 / P1-15
// 配置是模块加载时读的：每个场景在子进程里用自己的临时 home 跑，别和别的测试文件共用一份配置
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const GW = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "gw");
const ROOT = fs.mkdtempSync(path.join(process.env.CCAPP_WORKSPACE, "a0610-prov-"));
let seq = 0;

/** 在子进程里：先写好 files（相对 home），再 import providers.mjs 跑 code；code 里 console.log(JSON) 作为结果 */
function scenario(files, code) {
  const home = path.join(ROOT, "h" + ++seq);
  fs.mkdirSync(home, { recursive: true });
  for (const [f, v] of Object.entries(files)) fs.writeFileSync(path.join(home, f), typeof v === "string" ? v : JSON.stringify(v));
  const src = `const P = await import(${JSON.stringify(path.join(GW, "providers.mjs"))}); ${code}; process.exit(0);`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", src], {
    env: { ...process.env, CCAPP_HOME: home, HOME: home, CCAPP_WORKSPACE: path.join(home, "ws"), CCAPP_PREFIX: "" }, encoding: "utf8", timeout: 30000 });
  return { rc: r.status, out: r.stdout.trim().split("\n").pop(), err: r.stderr, home };
}

test("P1-15：自定义接口的 endpoints 不是数组 → 不崩，照常加载", () => {
  for (const ep of [{}, "x", 3, [null, { id: 1 }]]) {
    const r = scenario({ "ccapp-providers.json": { active: "custom-1", providers: { "custom-1": { baseUrl: "https://a.example", apiKey: "k", endpoints: ep } } } },
      `console.log(JSON.stringify({ base: P.PROVIDERS_CFG.providers["custom-1"].baseUrl }));`);
    assert.equal(r.rc, 0, r.err);
    assert.deepEqual(JSON.parse(r.out), { base: "https://a.example" });
  }
});

test("P1-1：配置文件坏了 → 原文件留底，保存不会把 Key 覆盖没", () => {
  const bad = '{"providers":{"custom-1":{"baseUrl":"https://a.example","apiKey":"SECRET-1"}}';   // 少个 }
  const r = scenario({ "ccapp-providers.json": bad },
    `const r = P.upsertProvider("", { baseUrl: "https://b.example", apiKey: "k2", label: "b" }); console.log(JSON.stringify({ ok: r.ok }));`);
  assert.equal(r.rc, 0, r.err);
  const bads = fs.readdirSync(r.home).filter((f) => f.startsWith("ccapp-providers.json.bad-"));
  assert.equal(bads.length, 1);
  assert.equal(fs.readFileSync(path.join(r.home, bads[0]), "utf8"), bad, "坏文件原样留着（Key 在里面）");
});

test("P1-2：改了端点主机又没给新 Key → 旧 Key 清掉；同主机改路径、或给了新 Key → 照旧", () => {
  const cfg = { "ccapp-providers.json": { active: "deepseek", providers: { "custom-1": { label: "a", baseUrl: "https://a.example/x", apiKey: "OLD" } } } };
  const r = scenario(cfg, `
    const a = P.upsertProvider("custom-1", { baseUrl: "https://evil.example" });
    const k1 = JSON.parse(require("fs").readFileSync(process.env.CCAPP_HOME + "/ccapp-providers.json", "utf8")).providers["custom-1"].apiKey ?? null;
    console.log(JSON.stringify({ cleared: !!a.keyCleared, k1 }));`.replace('require("fs")', "(await import('node:fs')).default"));
  assert.equal(r.rc, 0, r.err);
  assert.deepEqual(JSON.parse(r.out), { cleared: true, k1: null });

  const r2 = scenario(cfg, `
    const fs = (await import('node:fs')).default;
    const a = P.upsertProvider("custom-1", { baseUrl: "https://a.example/y" });
    const b = P.upsertProvider("custom-1", { baseUrl: "https://c.example", apiKey: "NEW" });
    const k = JSON.parse(fs.readFileSync(process.env.CCAPP_HOME + "/ccapp-providers.json", "utf8")).providers["custom-1"].apiKey;
    console.log(JSON.stringify({ a: !!a.keyCleared, b: !!b.keyCleared, k }));`);
  assert.equal(r2.rc, 0, r2.err);
  assert.deepEqual(JSON.parse(r2.out), { a: false, b: false, k: "NEW" });
});

test("P1-8：老配置没有 nextCustom、最大号被删过，但会话钉选还记着它 → 新接口不复用这个号", () => {
  const r = scenario({
    "ccapp-providers.json": { active: "deepseek", providers: { "custom-1": { baseUrl: "https://a.example", apiKey: "k" } } },
    "ccapp-session-models.json": { "sid-1": { provider: "custom-3", model: "m" } },
  }, `const a = P.upsertProvider("", { baseUrl: "https://b.example", apiKey: "k2" }); console.log(JSON.stringify({ id: a.id }));`);
  assert.equal(r.rc, 0, r.err);
  assert.deepEqual(JSON.parse(r.out), { id: "custom-4" });
});

test("195-Z.5：账本语法坏了 → 留底，不当空账本整份写回", () => {
  const bad = '{"deepseek":{"since":1,"spends":[[1,2]]';
  const r = scenario({ "ccapp-billing.json": bad }, `P._billForTest.noteTokens?.("deepseek", { input_tokens: 1, output_tokens: 1 }); await new Promise((r) => setTimeout(r, 800)); console.log("{}");`);
  assert.equal(r.rc, 0, r.err);
  const bads = fs.readdirSync(r.home).filter((f) => f.startsWith("ccapp-billing.json.bad-"));
  assert.equal(bads.length, 1);
  assert.equal(fs.readFileSync(path.join(r.home, bads[0]), "utf8"), bad);
});

test("195-Z.1：设置文件坏了 → 留底；之后保存写的是新文件，坏的那份还在", () => {
  const bad = '{"model":"keep-me","addDirs":["/x"]';
  const r = scenario({ "ccapp-settings.json": bad }, `const S = await import(${JSON.stringify(path.join(GW, "settings-store.mjs"))}); console.log(JSON.stringify({ saved: S.saveSettings(), model: S.SETTINGS.model ?? null }));`);
  assert.equal(r.rc, 0, r.err);
  assert.deepEqual(JSON.parse(r.out), { saved: true, model: null });
  const bads = fs.readdirSync(r.home).filter((f) => f.startsWith("ccapp-settings.json.bad-"));
  assert.equal(bads.length, 1);
  assert.equal(fs.readFileSync(path.join(r.home, bads[0]), "utf8"), bad);
});

// 本机回环上起一个假厂商：路径 → [状态码, 正文, 头]；记下收到的请求头
const fakeVendor = (routes) => `
  const http = await import("node:http");
  const ROUTES = ${JSON.stringify(routes)}; const seen = [];
  const srv = http.createServer((q, s) => { seen.push({ url: q.url, auth: q.headers.authorization || null, xkey: q.headers["x-api-key"] || null });
    const k = Object.keys(ROUTES).find((p) => q.url.startsWith(p)); const [st, body] = k ? ROUTES[k] : [404, "nope"];
    q.resume(); s.writeHead(st, { "content-type": "application/json" }); s.end(body); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + srv.address().port;`;
const custom = (extra) => ({ "ccapp-providers.json": { active: "custom-1", providers: { "custom-1": { baseUrl: "http://127.0.0.1:1", apiKey: "K1", label: "f", ...extra } } } });
/** 在子进程里把 custom-1 的地址改成假厂商，再测密钥 */
function keyTest(routes, extra) {
  return scenario(custom(extra), `${fakeVendor(routes)}
    const v = P.PROVIDERS_CFG.providers["custom-1"]; v.baseUrl = base; if (v.modelsUrl) v.modelsUrl = base + v.modelsUrl;
    const r = await P.testProvider("custom-1"); console.log(JSON.stringify({ ok: r.ok, message: r.message, seen }));`);
}

test("U.5：清单接口回 200 但不是清单（HTML / 空体 / 包着错误）→ 不报密钥有效", () => {
  for (const body of ["<html>login</html>", "", '{"success":false,"msg":"invalid key"}', '{"error":{"message":"bad key"}}']) {
    const r = keyTest({ "/v1/models": [200, body] }, { modelsUrl: "/v1/models" });
    assert.equal(r.rc, 0, r.err);
    const j = JSON.parse(r.out);
    assert.equal(j.ok, false, `正文 ${JSON.stringify(body)} 被当成有效：${j.message}`);
  }
  const ok = JSON.parse(keyTest({ "/v1/models": [200, '{"data":[{"id":"m1"}]}'] }, { modelsUrl: "/v1/models" }).out);
  assert.equal(ok.ok, true, ok.message);
});

test("U.5：试发也认回复的形状；清单请求按 modelsAuth 带头，none 的改成试发", () => {
  const bad = JSON.parse(keyTest({ "/v1/messages": [200, "<html></html>"] }, {}).out);
  assert.equal(bad.ok, false, bad.message);
  const good = JSON.parse(keyTest({ "/v1/messages": [200, '{"type":"message","content":[]}'] }, {}).out);
  assert.equal(good.ok, true, good.message);
  // 主请求 bearer、清单 x-api-key：清单那一下要带 x-api-key
  const x = JSON.parse(keyTest({ "/v1/models": [200, '{"data":[{"id":"m1"}]}'] }, { modelsUrl: "/v1/models", authStyle: "bearer", modelsAuth: "x-api-key" }).out);
  assert.equal(x.ok, true, x.message);
  assert.deepEqual([x.seen[0].xkey, x.seen[0].auth], ["K1", null]);
  // 清单不带密钥：拉到了也证明不了密钥，走试发
  const none = JSON.parse(keyTest({ "/v1/models": [200, '{"data":[{"id":"m1"}]}'], "/v1/messages": [401, '{"error":{"message":"bad"}}'] }, { modelsUrl: "/v1/models", modelsAuth: "none" }).out);
  assert.equal(none.ok, false, none.message);
  assert.equal(none.seen[0].url, "/v1/messages");
});

test("U.7：清单分页（has_more / last_id）顺着 after_id 拉完", () => {
  const page = (ids, more) => JSON.stringify({ data: ids.map((id) => ({ id, type: "model" })), has_more: more, last_id: ids[ids.length - 1] });
  const r = scenario(custom({ modelsUrl: "/v1/models" }), `${fakeVendor({ "/v1/models?after_id=m2": [200, page(["m3", "m4"], true)], "/v1/models?after_id=m4": [200, page(["m5"], false)], "/v1/models": [200, page(["m1", "m2"], true)] })}
    const v = P.PROVIDERS_CFG.providers["custom-1"]; v.baseUrl = base; v.modelsUrl = base + v.modelsUrl;
    const M = await import(${JSON.stringify(path.join(GW, "models.mjs"))});
    const list = await M.fetchModels(true, v); console.log(JSON.stringify({ ids: list.map((m) => m.id), seen }));`);
  assert.equal(r.rc, 0, r.err);
  const j = JSON.parse(r.out);
  for (const id of ["m1", "m2", "m3", "m4", "m5"]) assert.ok(j.ids.includes(id), `少了 ${id}：${j.ids}`);
  assert.equal(j.seen.length, 3);
});
