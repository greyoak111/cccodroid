// 05-工具包重装丢组件：换过工具包以后，旧组件记录不能再用旧版本号拦安装、也不能再拦依赖卸载；
// 文件整批没了（同版本重装丢组件 / 手动删）时，没有命令的组件也不能显示「已安装」。
// 组件记录在 files/components/<id>.json（$PREFIX 之外），devkit 身份在 $PREFIX/.devkit-ok。
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { PREFIX } from "../gw/config.mjs";

process.env.CCAPP_COMPONENTS_ALLOW_UNSIGNED = "1";
const COMP_DIR = path.join(path.dirname(PREFIX), "components");
fs.mkdirSync(COMP_DIR, { recursive: true });
const CACHE = path.join(COMP_DIR, "index.cache");
const OLD = "dk-inv05-old", NEW = "dk-inv05-new";
const IDS = ["inst05", "user05", "dep05", "dep06", "user06", "stat05", "cur05", "old05", "stale06"];
const IDX = JSON.stringify({ components: {
  inst05: { name: { zh: "测", en: "t" }, builds: [
    { base: NEW, sha256: "sha-inst", version: "1.0.0", bytes: 10, installed: 10,
      url: "http://127.0.0.1:1/never.tar.gz", asset: "never.tar.gz" }] },
} });
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
  fs.rmSync(path.join(PREFIX, "libexec/devkit/components/stat05"), { recursive: true, force: true });
  fs.rmSync(path.join(PREFIX, "share/inv05"), { recursive: true, force: true });
  fs.rmSync(path.join(PREFIX, "bin/basepkg-tool"), { force: true });
  fs.rmSync(path.join(PREFIX, "var/lib/dpkg/info/basepkg.list"), { force: true });
});
fs.writeFileSync(path.join(PREFIX, ".devkit-ok"), JSON.stringify({ sha256: NEW }));

const m = await import("../gw/components.mjs");
const { compWriteRecord, compState } = m._compForTest;
const { compRemove, compRepair } = m;
const { reconcileNow } = await import("../gw/reconcile.mjs");
const rec = (id, extra) => ({ id, state: "ok", base: NEW, sha256: "sha-" + id, version: "1.0.0", bin: [], files: [], shared: [], ...extra });

test("换过工具包：旧记录的旧版本号不再拦新工具包的构建（不算降级）", async () => {
  compWriteRecord("inst05", rec("inst05", { base: OLD, version: "9.9.9", bin: [] }));
  const r = await compRepair("inst05");
  assert.equal(r.ok, true, "装在旧工具包上的记录不该按版本拒绝安装：" + JSON.stringify({ ok: r.ok, message: r.message }));
  // 这次安装会去下载一个连不上的地址，让它自己失败并收尾；只要不是「拒绝降级」就说明走到了安装阶段
  const err = await r.done;
  assert.doesNotMatch(String(err || ""), /拒绝降级/);
});

test("换过工具包：旧记录不再拦住它依赖的组件卸载；当前工具包上的照旧拦", async () => {
  compWriteRecord("user05", rec("user05", { base: OLD, requires: ["dep05"] }));
  compWriteRecord("dep05", rec("dep05"));
  const r = await compRemove("dep05");
  assert.equal(r.ok, true, "旧组件已经用不了，不该再拦依赖卸载：" + JSON.stringify(r));

  compWriteRecord("user06", rec("user06", { requires: ["dep06"] }));
  compWriteRecord("dep06", rec("dep06"));
  const r2 = await compRemove("dep06");
  assert.equal(r2.ok, false, "当前工具包上还装着的组件仍然要拦");
  assert.match(r2.message, /user06/);
});

test("文件整批没了：没有命令的组件也显示 damaged，不再假装已安装", () => {
  compWriteRecord("stat05", rec("stat05", {
    files: ["libexec/devkit/components/stat05/MANIFEST", "share/stat05/data"], bin: [] }));
  const entry = { builds: [{ base: NEW, sha256: "sha-stat05", version: "1.0.0" }] };
  assert.equal(compState("stat05", entry, { sha256: NEW }), "damaged", "包内 MANIFEST 不在了，文件已被整批删掉");
  const man = path.join(PREFIX, "libexec/devkit/components/stat05/MANIFEST");
  fs.mkdirSync(path.dirname(man), { recursive: true });
  fs.writeFileSync(man, "");
  assert.equal(compState("stat05", entry, { sha256: NEW }), "ok", "文件还在就照旧显示已安装");
});

test("卸载旧工具包上的组件：它记录里的同名包清单不能顶掉新底座的保护", async () => {
  // 新底座有一个包 basepkg（清单在 var/lib/dpkg/info/basepkg.list）。旧组件记录里也写着这个路径
  // （它当时带过同名包）。卸载旧组件时，不能因此跳过新底座这份清单，否则它列的文件会一起删掉。
  const info = path.join(PREFIX, "var/lib/dpkg/info");
  fs.mkdirSync(info, { recursive: true });
  fs.mkdirSync(path.join(PREFIX, "bin"), { recursive: true });
  fs.writeFileSync(path.join(PREFIX, "bin/basepkg-tool"), "belongs to the current devkit");
  fs.writeFileSync(path.join(info, "basepkg.list"), "/data/data/cc.codroid/files/usr/bin/basepkg-tool\n");
  compWriteRecord("stale06", rec("stale06", { base: OLD,
    files: ["var/lib/dpkg/info/basepkg.list", "bin/basepkg-tool"] }));
  const r = await compRemove("stale06");
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(fs.existsSync(path.join(PREFIX, "bin/basepkg-tool")), "新底座的文件被旧组件卸载删掉了");
  assert.ok(fs.existsSync(path.join(info, "basepkg.list")), "新底座的包清单被旧组件卸载删掉了");
});

test("核对记录：旧工具包记录不再认领路径，断链目标没人负责就不误报", async () => {
  // 当前组件有一个指向旧组件目标的断链；旧记录说那个目标归它。旧记录已经失效，目标不归任何人，
  // 按核对记录的既有口径（谁都不负责的断链 = 打包时就断的）不该报成组件缺文件。
  const dst = path.join(PREFIX, "share/inv05");
  fs.mkdirSync(dst, { recursive: true });
  fs.symlinkSync("target-from-old-component", path.join(dst, "link"));
  compWriteRecord("cur05", rec("cur05", { files: ["share/inv05/link"] }));
  compWriteRecord("old05", rec("old05", { base: OLD, files: ["share/inv05/target-from-old-component"] }));
  const r = await reconcileNow();
  assert.ok(!r.findings.some((f) => f.key === "comp-files:cur05"),
    "旧记录认领的断链目标不该让当前组件报缺文件：" + JSON.stringify(r.findings.filter((f) => f.key.includes("cur05"))));
});
