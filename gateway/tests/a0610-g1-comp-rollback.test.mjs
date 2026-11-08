// 195-V.1：组件索引防回滚。索引（镜像晚一拍、磁盘缓存十分钟）里的构建比已装的还旧时，
// 不能显示「有新版本」，也不能真把它装上去。
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下，下面一行都不跑
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { PREFIX } from "../gw/config.mjs";

// 这条测试要真走到 compInstall 里（索引不签名，靠测试开关放行）
process.env.CCAPP_COMPONENTS_ALLOW_UNSIGNED = "1";
const COMP_DIR = path.join(path.dirname(PREFIX), "components");
fs.mkdirSync(COMP_DIR, { recursive: true });
const CACHE = path.join(COMP_DIR, "index.cache");
const DK = { sha256: "dk0610" };
const IDS = ["st0610-old", "st0610-new", "st0610-eq", "st0610-nover", "st0610-same", "inst0610"];

// 索引里只有 inst0610，构建版本 1.0.0（比已装的 2.0.0 旧）
const IDX = JSON.stringify({ components: { inst0610: { name: { zh: "测", en: "t" },
  builds: [{ base: DK.sha256, sha256: "sha-old", version: "1.0.0", bytes: 1024, installed: 1024 }] } } });
const server = http.createServer((req, res) => {
  if (req.url === "/i.json") { res.writeHead(200, { "content-type": "application/json" }); return res.end(IDX); }
  res.writeHead(404); res.end();      // .sig 与社区索引都没有：靠 ALLOW_UNSIGNED 放行
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const B = `http://127.0.0.1:${server.address().port}`;
Object.assign(process.env, {
  CCAPP_COMPONENTS_INDEX: B + "/i.json", CCAPP_COMPONENTS_INDEX_MIRROR: B + "/missing-m.json",
  CCAPP_COMPONENTS_COMMUNITY_INDEX: B + "/missing-c.json", CCAPP_COMPONENTS_COMMUNITY_INDEX_MIRROR: B + "/missing-cm.json",
});
after(() => {
  server.close();
  for (const id of IDS) fs.rmSync(path.join(COMP_DIR, id + ".json"), { force: true });
  fs.rmSync(CACHE, { force: true });
  fs.rmSync(path.join(PREFIX, ".devkit-ok"), { force: true });
});

const m = await import("../gw/components.mjs");
const { compState, compVerCmp, compOlder, compWriteRecord, compInstall } = m._compForTest;

test("版本比较：数字段逐段比，缺段当 0；版本缺失一律不当旧", () => {
  assert.ok(compVerCmp("2.0.0", "1.9.9") > 0);
  assert.ok(compVerCmp("1.2.10", "1.2.9") > 0, "10 比 9 新，不能按字符串比");
  assert.equal(compVerCmp("1.0", "1.0.0"), 0);
  const rec = { version: "2.0.0" };
  assert.equal(compOlder({ version: "1.9.0" }, rec), true);
  assert.equal(compOlder({ version: "2.0.0" }, rec), false);
  assert.equal(compOlder({ version: "2.1.0" }, rec), false);
  assert.equal(compOlder({}, rec), false, "索引没写版本：照旧当可更新，不误拦");
  assert.equal(compOlder({ version: "" }, rec), false);
  assert.equal(compOlder({ version: "1.0.0" }, { version: null }), false, "旧记录没版本：不当旧");
});

test("compState：索引构建比已装的旧不算「可更新」，同版本不同 sha 仍算", () => {
  const mk = (id, rec, builds) => {
    assert.ok(compWriteRecord(id, { id, state: "ok", base: DK.sha256, sha256: "sha-cur", version: "2.0.0", bin: [], ...rec }));
    return compState(id, { builds }, DK);
  };
  assert.equal(mk("st0610-old", {}, [{ base: DK.sha256, sha256: "sha-old", version: "1.0.0" }]), "ok", "旧构建不能显示成可更新");
  assert.equal(mk("st0610-new", {}, [{ base: DK.sha256, sha256: "sha-new", version: "2.1.0" }]), "update");
  assert.equal(mk("st0610-eq", {}, [{ base: DK.sha256, sha256: "sha-new", version: "2.0.0" }]), "update", "同版本换了构建（重打包）照常可更新");
  assert.equal(mk("st0610-nover", {}, [{ base: DK.sha256, sha256: "sha-new" }]), "update", "版本缺失不当旧");
  assert.equal(mk("st0610-same", {}, [{ base: DK.sha256, sha256: "sha-cur", version: "2.0.0" }]), "ok");
});

test("compInstall：已装 2.0.0、索引只给 1.0.0 → 拒绝降级，记录不动", async () => {
  fs.writeFileSync(path.join(PREFIX, ".devkit-ok"), JSON.stringify({ sha256: DK.sha256 }));
  assert.ok(compWriteRecord("inst0610", { id: "inst0610", state: "ok", base: DK.sha256,
    sha256: "sha-cur", version: "2.0.0", bin: [], files: [] }));
  const r = await compInstall("inst0610");
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.message, /拒绝降级/);
  const rec = m._compForTest.compRecordInfo("inst0610").rec;
  assert.equal(rec.version, "2.0.0");
  assert.equal(rec.sha256, "sha-cur");
});
