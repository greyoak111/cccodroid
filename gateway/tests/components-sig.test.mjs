// 组件索引验签的负向回归（11-04 报告 六-10）：components.test.mjs 靠 ALLOW_UNSIGNED 放行，这里不放行。
// 正向用发布出去的真索引和 .sig（fixtures/components-index，官方公钥能验过）；反向逐项改坏，主地址和镜像都要拒。
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下
import test, { after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";

delete process.env.CCAPP_COMPONENTS_ALLOW_UNSIGNED;
const COMP_DIR = path.join(path.dirname(process.env.CCAPP_PREFIX), "components");
fs.mkdirSync(COMP_DIR, { recursive: true });
const FIX = new URL("./fixtures/components-index/", import.meta.url);
const BODY = fs.readFileSync(new URL("components.json", FIX));
const SIG = fs.readFileSync(new URL("components.json.sig", FIX), "utf8");

// 主地址 / 镜像各自给什么：{ body, sig }，sig 为 null 就 404
const S = { main: null, mirror: null };
const ENV0 = {};
const server = http.createServer((req, res) => {
  const which = req.url.startsWith("/main") ? "main" : req.url.startsWith("/mirror") ? "mirror" : "";
  const v = which && S[which];
  if (!v) { res.writeHead(404); return res.end(); }
  if (req.url.endsWith(".sig")) { if (v.sig == null) { res.writeHead(404); return res.end(); } return res.end(v.sig); }
  res.end(v.body);
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const B = `http://127.0.0.1:${server.address().port}`;
for (const k of ["CCAPP_COMPONENTS_INDEX", "CCAPP_COMPONENTS_INDEX_MIRROR", "CCAPP_COMPONENTS_COMMUNITY_INDEX", "CCAPP_COMPONENTS_COMMUNITY_INDEX_MIRROR"]) ENV0[k] = process.env[k];
Object.assign(process.env, {
  CCAPP_COMPONENTS_INDEX: B + "/main/components.json", CCAPP_COMPONENTS_INDEX_MIRROR: B + "/mirror/components.json",
  CCAPP_COMPONENTS_COMMUNITY_INDEX: B + "/none/c.json", CCAPP_COMPONENTS_COMMUNITY_INDEX_MIRROR: B + "/none/cm.json",
});
// 收尾：别把真索引的缓存和改过的地址留给同一进程里后面的测试（components.test 一开头就读磁盘缓存）
after(() => {
  server.close();
  fs.rmSync(path.join(COMP_DIR, "index.cache"), { force: true });
  for (const k of ["CCAPP_COMPONENTS_INDEX", "CCAPP_COMPONENTS_INDEX_MIRROR", "CCAPP_COMPONENTS_COMMUNITY_INDEX", "CCAPP_COMPONENTS_COMMUNITY_INDEX_MIRROR"]) if (ENV0[k] === undefined) delete process.env[k]; else process.env[k] = ENV0[k];
});

let n = 0;
async function pull() {
  fs.rmSync(path.join(COMP_DIR, "index.cache"), { force: true });
  const { compIndex } = await import("../gw/components.mjs?sig=" + ++n);
  const r = await compIndex(true);
  return { ids: Object.keys(r.data.components), preset: r.error.split("；").find((e) => e.startsWith("preset:")) || "" };
}
const other = crypto.generateKeyPairSync("ed25519").privateKey;
const flip = () => { const b = Buffer.from(BODY); const i = b.indexOf("156.0.8078.47"); b[i] = "7".charCodeAt(0); return b; };

test("真索引 + 真签名：认，标 signed", async () => {
  S.main = { body: BODY, sig: SIG }; S.mirror = null;
  const r = await pull();
  assert.deepEqual(r.ids, ["chromium"]);
  assert.equal(r.preset, "");
  const { compIndex } = await import("../gw/components.mjs?sig=" + n);
  assert.equal((await compIndex(false)).data.components.chromium.signed, true);
});

test("签名缺失 / 乱码 / 长度不对 / 别的钥匙签的 / 正文改了一个字：都拒", async () => {
  const cases = {
    "没有 .sig": [{ body: BODY, sig: null }, /索引没有签名/],
    "乱码": [{ body: BODY, sig: "not base64 at all" }, /索引签名不对/],
    "63 字节": [{ body: BODY, sig: Buffer.from(SIG.trim(), "base64").subarray(0, 63).toString("base64") }, /索引签名不对/],
    "别的钥匙签的": [{ body: BODY, sig: crypto.sign(null, BODY, other).toString("base64") }, /索引签名不对/],
    "正文改了版本号": [{ body: flip(), sig: SIG }, /索引签名不对/],
    "签名的一位翻了": [{ body: BODY, sig: (() => { const s = Buffer.from(SIG.trim(), "base64"); s[10] ^= 1; return s.toString("base64"); })() }, /索引签名不对/],
  };
  for (const [name, [v, re]] of Object.entries(cases)) {
    S.main = v; S.mirror = null;
    const r = await pull();
    assert.deepEqual(r.ids, [], name + "：不该出列表");
    assert.match(r.preset, re, name);
  }
});

test("主地址拉不到、镜像给的是改过的：镜像不被信任，照样拒", async () => {
  S.main = null; S.mirror = { body: flip(), sig: SIG };
  let r = await pull();
  assert.deepEqual(r.ids, []);
  assert.match(r.preset, /索引签名不对/);
  S.mirror = { body: BODY, sig: SIG };
  r = await pull();
  assert.deepEqual(r.ids, ["chromium"], "镜像给的是原样的就认");
});
