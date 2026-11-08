// 195-V.2 / 195-V.3：
//  · 共享目录里的本地索引只认启动环境变量 CCAPP_COMPONENTS_USE_LOCAL_INDEX=1，私有目录里的文件开关不再算数；
//  · 索引磁盘缓存存原始正文与签名，读回来按公钥复核，旧格式（没复核过）的缓存不能拿来安装组件。
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下，下面一行都不跑
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { PREFIX } from "../gw/config.mjs";

const COMP_DIR = path.join(path.dirname(PREFIX), "components");
fs.mkdirSync(COMP_DIR, { recursive: true });
const CACHE = path.join(COMP_DIR, "index.cache");
const FIX = new URL("./fixtures/components-index/", import.meta.url);
const BODY = fs.readFileSync(new URL("components.json", FIX), "utf8");
const SIG = fs.readFileSync(new URL("components.json.sig", FIX), "utf8").trim();

// 共享目录：里面放一份本地索引（id 叫 shadow），老代码靠私有目录里的 use-local-index 文件就能换成它
const SHARED = fs.mkdtempSync(path.join(os.tmpdir(), "ccapp-g1-shared-"));
fs.mkdirSync(path.join(SHARED, "components"), { recursive: true });
fs.writeFileSync(path.join(SHARED, "components", "components.json"),
  JSON.stringify({ components: { shadow: { name: { zh: "shadow", en: "shadow" }, builds: [] } } }));
const ENV0 = { CCAPP_SHARED: process.env.CCAPP_SHARED };
process.env.CCAPP_SHARED = SHARED;

const hits = { p: 0, c: 0 };
const S = { preset: "", presetSig: null, community: "" };
const server = http.createServer((req, res) => {
  if (req.url === "/p.json") { hits.p++; res.writeHead(200, { "content-type": "application/json" }); return res.end(S.preset); }
  if (req.url === "/p.json.sig") { if (S.presetSig == null) { res.writeHead(404); return res.end(); } return res.end(S.presetSig); }
  if (req.url === "/c.json") { hits.c++; if (!S.community) { res.writeHead(404); return res.end(); } return res.end(S.community); }
  res.writeHead(404); res.end();
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const B = `http://127.0.0.1:${server.address().port}`;
Object.assign(process.env, {
  CCAPP_COMPONENTS_INDEX: B + "/p.json", CCAPP_COMPONENTS_INDEX_MIRROR: B + "/missing-m.json",
  CCAPP_COMPONENTS_COMMUNITY_INDEX: B + "/c.json", CCAPP_COMPONENTS_COMMUNITY_INDEX_MIRROR: B + "/missing-cm.json",
});
after(() => {
  server.close();
  fs.rmSync(CACHE, { force: true });
  fs.rmSync(path.join(COMP_DIR, "use-local-index"), { force: true });
  fs.rmSync(path.join(PREFIX, ".devkit-ok"), { force: true });
  fs.rmSync(SHARED, { recursive: true, force: true });
  for (const [k, v] of Object.entries(ENV0)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  for (const k of ["CCAPP_COMPONENTS_INDEX", "CCAPP_COMPONENTS_INDEX_MIRROR", "CCAPP_COMPONENTS_COMMUNITY_INDEX", "CCAPP_COMPONENTS_COMMUNITY_INDEX_MIRROR", "CCAPP_COMPONENTS_ALLOW_UNSIGNED", "CCAPP_COMPONENTS_USE_LOCAL_INDEX"]) delete process.env[k];
});

let n = 0;
const fresh = () => import("../gw/components.mjs?i=" + ++n);   // 新模块实例 = 重开一次 App
const zero = () => { hits.p = 0; hits.c = 0; };

test("195-V.2 私有目录的 use-local-index 文件不再换来源；启动环境变量才认本地索引", async () => {
  process.env.CCAPP_COMPONENTS_ALLOW_UNSIGNED = "1";      // 本地索引不签名
  delete process.env.CCAPP_COMPONENTS_USE_LOCAL_INDEX;
  fs.writeFileSync(path.join(COMP_DIR, "use-local-index"), "");   // 旧开关：同 uid 建个文件就能换来源
  S.preset = JSON.stringify({ components: { "server-tool": { name: { zh: "server-tool" }, builds: [] } } });
  S.community = JSON.stringify({ components: { "community-tool": { name: { zh: "community-tool" }, builds: [] } } });
  fs.rmSync(CACHE, { force: true }); zero();
  let m = await fresh();
  let r = await m.compIndex(true);
  assert.ok(r.data.components["server-tool"], "应当走官方源");
  assert.ok(!r.data.components.shadow, "私有目录里的开关文件不能再把来源换成共享目录");
  assert.ok(hits.p > 0);

  // 启动时带了环境变量：这次才认共享目录里的本地索引
  process.env.CCAPP_COMPONENTS_USE_LOCAL_INDEX = "1";
  fs.rmSync(CACHE, { force: true }); zero();
  m = await fresh();
  r = await m.compIndex(true);
  assert.ok(r.data.components.shadow, "开了环境变量才认本地索引");
  assert.equal(hits.p, 0, "本地索引不再请求官方源");
  assert.ok(r.data.components["community-tool"], "社区源照常");
  delete process.env.CCAPP_COMPONENTS_USE_LOCAL_INDEX;
  fs.rmSync(path.join(COMP_DIR, "use-local-index"), { force: true });
});

test("195-V.3 缓存存原始正文与签名：重开先复核再用，不联网", async () => {
  delete process.env.CCAPP_COMPONENTS_ALLOW_UNSIGNED;
  process.env.CCAPP_COMPONENTS_USE_LOCAL_INDEX = "0";     // 明确不认本地索引
  S.preset = BODY; S.presetSig = SIG; S.community = "";   // 社区源取不到
  fs.rmSync(CACHE, { force: true }); zero();
  let m = await fresh();
  let r = await m.compIndex(true);
  assert.equal(r.data.components.chromium.signed, true);
  const c = JSON.parse(fs.readFileSync(CACHE, "utf8"));
  assert.ok(c.sources && c.sources.preset && c.sources.preset.body, "缓存里要有可复核的原始正文");
  assert.equal(c.sources.preset.sig, Buffer.from(SIG, "base64").toString("base64"));

  zero();
  m = await fresh();
  r = await m.compIndex(false);
  assert.equal(hits.p + hits.c, 0, "新鲜的磁盘缓存不该联网");
  assert.equal(r.data.components.chromium.signed, true);
});

test("195-V.3 缓存正文被改：复核不过，丢弃并重新拉", async () => {
  const c = JSON.parse(fs.readFileSync(CACHE, "utf8"));
  const tampered = c.sources.preset.body.replace(/"version":\s*"[^"]*"/, '"version": "0.0.0-evil"');
  assert.notEqual(tampered, c.sources.preset.body);
  c.sources.preset.body = tampered;
  fs.writeFileSync(CACHE, JSON.stringify(c));
  zero();
  const m = await fresh();
  const r = await m.compIndex(false);
  assert.ok(hits.p > 0, "缓存复核不过时必须重新联网");
  assert.equal(r.data.components.chromium.signed, true);
  assert.ok(!JSON.stringify(r.data.components).includes("0.0.0-evil"));
});

test("195-V.3 旧格式缓存（没有可复核的签名）不能拿来安装组件", async () => {
  delete process.env.CCAPP_COMPONENTS_ALLOW_UNSIGNED;
  delete process.env.CCAPP_COMPONENTS_USE_LOCAL_INDEX;
  const dead = "file://" + path.join(SHARED, "nonexistent");
  Object.assign(process.env, {
    CCAPP_COMPONENTS_INDEX: dead + "/components.json", CCAPP_COMPONENTS_INDEX_MIRROR: dead + "/mirror.json",
    CCAPP_COMPONENTS_COMMUNITY_INDEX: dead + "/community.json", CCAPP_COMPONENTS_COMMUNITY_INDEX_MIRROR: dead + "/community-m.json",
  });
  fs.writeFileSync(path.join(PREFIX, ".devkit-ok"), JSON.stringify({ sha256: "dk0610" }));
  fs.rmSync(CACHE, { force: true });
  // 伪造一份 0.6.10 之前的缓存：条目自称已签名，但没有正文和签名可复核
  fs.writeFileSync(CACHE, JSON.stringify({ at: 1, data: { components: { evil0610: {
    name: { zh: "evil", en: "evil" }, source: "preset", signed: true,
    builds: [{ base: "dk0610", sha256: "evil-sha", version: "9.9.9", bytes: 10, installed: 10 }] } } } }));
  const m = await fresh();
  const r = await m._compForTest.compInstall("evil0610");
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.message, /验签/);
});
