// 组件索引（gw/components.mjs 的 compIndex）：磁盘缓存、先出旧列表后台再拉、换镜像与一天后回主地址。
// 本机起一个服务当四个地址（官方 / 社区 × 主地址 / 镜像）；索引不签名，靠 CCAPP_COMPONENTS_ALLOW_UNSIGNED=1 放行
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下，下面一行都不跑
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";

const COMP_DIR = path.join(path.dirname(process.env.CCAPP_PREFIX), "components");
const CACHE = path.join(COMP_DIR, "index.cache");
fs.mkdirSync(COMP_DIR, { recursive: true });
fs.rmSync(CACHE, { force: true });   // 「第一次」要从空缓存开始：同一进程里前面的测试可能留过一份
process.env.CCAPP_COMPONENTS_ALLOW_UNSIGNED = "1";

const hits = { preset: 0, presetMirror: 0, community: 0, communityMirror: 0 };
const S = { presetDown: false, ver: 1 };
const idx = (id) => JSON.stringify({ components: { [id]: { name: { zh: id, en: id }, builds: [], v: S.ver } } });
const server = http.createServer((req, res) => {
  const k = { "/preset.json": "preset", "/preset-m.json": "presetMirror", "/community.json": "community", "/community-m.json": "communityMirror" }[req.url];
  if (!k) { res.writeHead(404); return res.end(); }             // .sig 一律没有
  hits[k]++;
  if (k === "preset" && S.presetDown) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(idx(k.startsWith("preset") ? "browser" : "community-tool"));
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const B = `http://127.0.0.1:${server.address().port}`;
Object.assign(process.env, {
  CCAPP_COMPONENTS_INDEX: B + "/preset.json", CCAPP_COMPONENTS_INDEX_MIRROR: B + "/preset-m.json",
  CCAPP_COMPONENTS_COMMUNITY_INDEX: B + "/community.json", CCAPP_COMPONENTS_COMMUNITY_INDEX_MIRROR: B + "/community-m.json",
});
let n = 0;
const fresh = () => import("../gw/components.mjs?i=" + ++n);   // 新的模块实例 = 重开一次 App（内存缓存是空的）
const zero = () => { for (const k in hits) hits[k] = 0; };
const until = async (f, ms = 5000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error("等不到"); await new Promise((r) => setTimeout(r, 50)); } };
after(() => server.close());

test("第一次：两份索引都拉、合并，并存一份磁盘缓存", async () => {
  const { compIndex } = await fresh();
  const r = await compIndex(false);
  assert.deepEqual(Object.keys(r.data.components).sort(), ["browser", "community-tool"]);
  assert.equal(r.refreshing, undefined);
  assert.equal(hits.preset, 1); assert.equal(hits.community, 1);
  assert.ok(fs.existsSync(CACHE));
});

test("缓存还新：不联网", async () => {
  const { compIndex } = await fresh();
  zero();
  const r = await compIndex(false);
  assert.ok(r.data.components.browser);
  assert.equal(hits.preset + hits.community, 0);
});

test("缓存过期：先返回旧的（refreshing），后台拉完再要就是新的", async () => {
  const { compIndex } = await fresh();
  zero(); S.ver = 2;
  const r1 = await compIndex(1);                                 // 超过 1 毫秒就算旧
  assert.equal(r1.refreshing, true);
  assert.equal(r1.data.components.browser.v, 1);
  await until(() => hits.preset && hits.community);
  await new Promise((r) => setTimeout(r, 200));
  const r2 = await compIndex(false);
  assert.equal(r2.refreshing, undefined);
  assert.equal(r2.data.components.browser.v, 2);
});

test("「检查更新」（force=true）等拉完才返回", async () => {
  const { compIndex } = await fresh();
  zero(); S.ver = 3;
  const r = await compIndex(true);
  assert.equal(r.refreshing, undefined);
  assert.equal(r.data.components.browser.v, 3);
});

test("主地址拉不到：换镜像，并记在磁盘缓存里（只记那一份）", async () => {
  const { compIndex } = await fresh();
  zero(); S.presetDown = true;
  const r = await compIndex(true);
  assert.ok(r.data.components.browser);
  assert.equal(hits.presetMirror, 1);
  assert.equal(hits.communityMirror, 0);
  const via = JSON.parse(fs.readFileSync(CACHE, "utf8")).viaMirror;
  assert.deepEqual(Object.keys(via), [B + "/preset-m.json"]);
});

test("重开后先试镜像，主地址不碰", async () => {
  const { compIndex } = await fresh();
  zero(); S.presetDown = false;
  await compIndex(true);
  assert.equal(hits.presetMirror, 1);
  assert.equal(hits.preset, 0);
  assert.equal(hits.community, 1);
});

test("改用镜像满一天：重新先试主地址，通了就清掉记号", async () => {
  const c = JSON.parse(fs.readFileSync(CACHE, "utf8"));
  for (const k in c.viaMirror) c.viaMirror[k] -= 25 * 3600e3;
  fs.writeFileSync(CACHE, JSON.stringify(c));
  const { compIndex } = await fresh();
  zero();
  await compIndex(true);
  assert.equal(hits.preset, 1);
  assert.equal(hits.presetMirror, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(CACHE, "utf8")).viaMirror, {});
});

test("磁盘缓存坏了：当没有，照常联网", async () => {
  fs.writeFileSync(CACHE, "{坏的");
  const { compIndex } = await fresh();
  zero();
  const r = await compIndex(false);
  assert.ok(r.data.components.browser);
  assert.equal(hits.preset, 1);
});

test("缓存文件名不以 .json 结尾（组件目录里的 *.json 都当已装记录）", () => {
  assert.ok(!CACHE.endsWith(".json"));
  assert.ok(!fs.readdirSync(COMP_DIR).some((f) => f.endsWith(".json")));
});
