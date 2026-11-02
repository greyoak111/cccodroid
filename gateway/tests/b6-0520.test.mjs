// v0.5.20 审查第 6 批（#104）：卸工具包模块时谁在用它 —— 组件（冷缓存也要认得）、pkg 装的包
import { PREFIX } from "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { NEXT } from "../gw/http.mjs";
import { routeModules } from "../gw/modules.mjs";
import { COMP_DIR } from "../gw/components.mjs";

const DK = path.join(PREFIX, "libexec/devkit"), GFX = path.join(DK, "modules/gfx"), LIB = path.join(PREFIX, "lib/libl0520.so");
const PKG_DB = path.join(path.dirname(PREFIX), "pkg", "installed.json");
const made = [path.join(PREFIX, ".devkit-ok"), path.join(DK, "modules.json"), GFX, LIB, path.join(COMP_DIR, "c0520.json"), path.join(COMP_DIR, "index.cache"), PKG_DB];
after(() => { for (const f of made) fs.rmSync(f, { recursive: true, force: true }); });

const srv = http.createServer(async (req, res) => { const u = new URL(req.url, "http://x"); if ((await routeModules(req, res, u, u.pathname)) === NEXT) res.writeHead(404).end(); });
await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
after(() => srv.close());
const remove = async (id) => (await fetch(`http://127.0.0.1:${srv.address().port}/api/devkit/modules/remove`, { method: "POST", body: JSON.stringify({ id }) })).json();

// 每条测试前：图形模块 gfx 已装，独有底座包 libl0520（文件 lib/libl0520.so）；清掉组件记录、索引缓存、pkg 记录
beforeEach(() => {
  fs.writeFileSync(path.join(PREFIX, ".devkit-ok"), JSON.stringify({ sha256: "dk0520" }));
  fs.mkdirSync(GFX, { recursive: true });
  fs.writeFileSync(path.join(DK, "modules.json"), JSON.stringify({ modules: [
    { id: "base", kind: "base", required: true, dir: "libexec/devkit/modules/base", packages: [] },
    { id: "gfx", kind: "module", name: { zh: "图形" }, dir: "libexec/devkit/modules/gfx", packages: [{ name: "libl0520", version: "1" }] },
  ] }));
  for (const f of ["MANIFEST", ".ok"]) fs.writeFileSync(path.join(GFX, f), "x\n");
  fs.writeFileSync(path.join(GFX, "FILES"), "lib/libl0520.so\n");
  fs.mkdirSync(path.dirname(LIB), { recursive: true }); fs.writeFileSync(LIB, "elf");
  for (const f of [path.join(COMP_DIR, "c0520.json"), path.join(COMP_DIR, "index.cache"), PKG_DB]) fs.rmSync(f, { force: true });
  fs.mkdirSync(COMP_DIR, { recursive: true });
});
const comp = (extra = {}) => fs.writeFileSync(path.join(COMP_DIR, "c0520.json"), JSON.stringify({ id: "c0520", state: "ok", base: "dk0520", sha256: "s0520", files: [], shared: [], ...extra }));

test("05-001 刚启动、内存里没有索引：磁盘缓存里写着组件要用这个模块的包 → 拒绝卸载，库还在", async () => {
  comp();
  fs.writeFileSync(path.join(COMP_DIR, "index.cache"), JSON.stringify({ at: 1, data: { components: { c0520: { builds: [{ sha256: "s0520", baseDeps: ["libl0520"] }] } } } }));
  const r = await remove("gfx");
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.deepEqual(r.usedBy.components, ["c0520"]);
  assert.ok(fs.existsSync(LIB));
});

test("05-001 安装记录里记着依赖：不靠索引也拒绝", async () => {
  comp({ baseDeps: ["libl0520"] });
  const r = await remove("gfx");
  assert.equal(r.ok, false);
  assert.ok(fs.existsSync(LIB));
});

test("05-002 pkg 装的包依赖这个模块独有的包 → 拒绝，列出包名", async () => {
  fs.mkdirSync(path.dirname(PKG_DB), { recursive: true });
  fs.writeFileSync(PKG_DB, JSON.stringify({ pkgs: { p0520: { version: "1", state: "ok", deps: "libc, libl0520 (>= 1)", files: ["bin/p0520"] } } }));
  const r = await remove("gfx");
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.deepEqual(r.usedBy.pkgs, ["p0520"]);
  assert.match(r.message, /pkg p0520/);
  assert.ok(fs.existsSync(LIB));
});

test("对照：组件记录里依赖为空、pkg 不沾边 → 照常卸载，库删掉", async () => {
  comp({ baseDeps: [] });
  fs.mkdirSync(path.dirname(PKG_DB), { recursive: true });
  fs.writeFileSync(PKG_DB, JSON.stringify({ pkgs: { q0520: { version: "1", state: "ok", deps: "libc", files: [] } } }));
  const r = await remove("gfx");
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(fs.existsSync(LIB), false);
});

test("05-001 判断不了（旧记录、索引里没有这个构建）：当作在用，不删", async () => {
  comp({ sha256: "s-gone-from-index" });
  const r = await remove("gfx");
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.ok(fs.existsSync(LIB));
});
