// Claude Code 真机验证记录（gw/ccverified.mjs）：验签、落盘给 Java 读、只往新的换、按语言给原因
// 用一把测试钥匙签名（CCAPP_TEST_PUBKEY 只在 CCAPP_TEST=1 时生效），本机起服务当发布地址
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下，下面一行都不跑
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import crypto from "node:crypto";

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const other = crypto.generateKeyPairSync("ed25519").privateKey;
const S = { body: Buffer.alloc(0), sig: "" };
const publish = (d, key = privateKey) => { S.body = Buffer.from(JSON.stringify(d)); S.sig = crypto.sign(null, S.body, key).toString("base64"); };
const server = http.createServer((req, res) => {
  if (req.url === "/verified.json") return res.end(S.body);
  if (req.url === "/verified.json.sig") return res.end(S.sig);
  res.writeHead(404); res.end();
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
after(() => server.close());
process.env.CCAPP_TEST_PUBKEY = publicKey.export({ type: "spki", format: "pem" });
process.env.CCAPP_CLAUDE_VERIFIED_URL = `http://127.0.0.1:${server.address().port}/verified.json`;
const { refreshVerified, verifiedInfo, VERIFIED_CACHE } = await import("../gw/ccverified.mjs");

const rec = { at: "2026-10-24", device: "Lenovo TB320FC", android: "15", sdk: 35, targetSdk: 28, app: "0.4.2", devkit: "devkit-2026.10.22.3", sha256: "ab" };
const doc = (updated, extra = {}) => ({ v: 1, updated, versions: { "2.1.300": [rec] }, bad: { "2.1.301": { zh: "终端里粘贴会卡住", en: "Pasting in the terminal hangs", fixed: "2.1.302" } }, ...extra });

test("签名对：取到、存盘（Java 的自动更新读这份），选单拿到验证记录和按语言的原因", async () => {
  publish(doc("2026-10-24T01:00:00Z"));
  await refreshVerified(true);
  const zh = await verifiedInfo("zh"), en = await verifiedInfo("en");
  assert.equal(zh.verified["2.1.300"][0].device, "Lenovo TB320FC");
  assert.equal(zh.verified["2.1.300"][0].android, "15");
  assert.equal(zh.verified["2.1.300"][0].sha256, undefined, "选单只要显示用的字段");
  assert.deepEqual(zh.bad["2.1.301"], { text: "终端里粘贴会卡住", fixed: "2.1.302" });
  assert.equal(en.bad["2.1.301"].text, "Pasting in the terminal hangs");
  assert.equal(JSON.parse(fs.readFileSync(VERIFIED_CACHE, "utf8")).bad["2.1.301"].zh, "终端里粘贴会卡住");
  assert.equal(zh.verifiedError, "");
});

test("签名不对（别的钥匙签的）：不认，手上的和磁盘上的都不动", async () => {
  publish(doc("2026-10-25T00:00:00Z", { bad: { "2.1.300": { zh: "假的", en: "fake" } } }), other);
  await refreshVerified(true);
  const r = await verifiedInfo("zh");
  assert.equal(r.bad["2.1.300"], undefined);
  assert.match(r.verifiedError, /签名对不上/);
  assert.equal(JSON.parse(fs.readFileSync(VERIFIED_CACHE, "utf8")).updated, "2026-10-24T01:00:00Z");
});

test("取到的比手上的旧：不往回换", async () => {
  publish(doc("2026-10-23T00:00:00Z", { bad: {} }));
  await refreshVerified(true);
  assert.ok((await verifiedInfo("zh")).bad["2.1.301"]);
});

test("新的一份：换上，撤掉的「有问题」随之消失", async () => {
  publish(doc("2026-10-26T00:00:00Z", { bad: {} }));
  await refreshVerified(true);
  const r = await verifiedInfo("zh");
  assert.deepEqual(r.bad, {});
  assert.ok(r.verified["2.1.300"]);
});

test("格式不对：不认", async () => {
  publish({ v: 1, updated: "2026-10-27T00:00:00Z" });
  await refreshVerified(true);
  assert.match((await verifiedInfo("zh")).verifiedError, /格式不对/);
  assert.ok((await verifiedInfo("zh")).verified["2.1.300"]);
});

test("磁盘上那份被人改过（同 uid 能写）：重启后不认，验过签的原样那份照认（审查 11-05 安全 1）", async () => {
  publish(doc("2026-10-26T00:00:00Z"), other);          // 发布地址取不到可信的：只能靠磁盘
  const good = fs.readFileSync(VERIFIED_CACHE);
  assert.ok(fs.existsSync(VERIFIED_CACHE + ".sig"), "签名跟着存");
  const fresh = await import("../gw/ccverified.mjs?reload=1");
  assert.ok((await fresh.verifiedInfo("zh")).verified["2.1.300"], "原样的那份：认");
  const forged = JSON.parse(good.toString("utf8")); forged.updated = "2099-01-01T00:00:00Z"; forged.bad = { "2.1.300": { zh: "假的", en: "fake" } };
  fs.writeFileSync(VERIFIED_CACHE, JSON.stringify(forged));
  const again = await import("../gw/ccverified.mjs?reload=2");
  const r = await again.verifiedInfo("zh");
  assert.equal(r.bad["2.1.300"], undefined);
  assert.deepEqual(r.verified, {});
  fs.writeFileSync(VERIFIED_CACHE, good);
});
