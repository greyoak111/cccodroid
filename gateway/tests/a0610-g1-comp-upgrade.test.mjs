// 197-9.6 F8：组件升级不能先删旧版再搬新版 —— 搬一半失败时旧版文件必须还在、记录退回可用状态；
// 成功时新版覆盖同名文件、旧版独有的删掉、别的组件也在用的不覆盖并转记到它名下。
import "../gw/config.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PREFIX } from "../gw/config.mjs";
import { COMP_DIR, compRecord, _compForTest } from "../gw/components.mjs";

const { compWriteRecord, compRecFile, compSwitch } = _compForTest;
const STAGE = path.join(COMP_DIR, ".staging");
const IDS = ["up0610", "co0610", "rb0610", "fi0610"];
const LOCKED = path.join(PREFIX, "lib/locked0610");
const DKOK = path.join(PREFIX, ".devkit-ok");
const DKSAVED = fs.existsSync(DKOK) ? fs.readFileSync(DKOK, "utf8") : null;
fs.mkdirSync(COMP_DIR, { recursive: true });
fs.writeFileSync(DKOK, JSON.stringify({ sha256: "dk0610" }));   // compRecords 只认同一个工具包的记录

const put = (rel, text) => { const f = path.join(PREFIX, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const read = (rel) => fs.readFileSync(path.join(PREFIX, rel), "utf8");
const tree = (id, files) => {
  const root = path.join(STAGE, id);
  fs.rmSync(root, { recursive: true, force: true });
  for (const [rel, text] of Object.entries(files)) {
    const f = path.join(root, "usr", rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  }
  return root;
};
const BUILD = (v) => ({ source: "official", version: v, sha256: "sha-" + v, base: "dk0610", bin: [], requires: [], baseDeps: [] });

after(() => {
  try { fs.chmodSync(LOCKED, 0o755); } catch {}
  for (const id of IDS) {
    fs.rmSync(compRecFile(id), { force: true });
    fs.rmSync(path.join(STAGE, id), { recursive: true, force: true });
    fs.rmSync(path.join(STAGE, id + ".old"), { recursive: true, force: true });
  }
  for (const rel of ["bin/up-tool", "share/up0610", "bin/rb-tool", "share/rb0610", "lib/locked0610", "bin/fi-tool"])
    fs.rmSync(path.join(PREFIX, rel), { recursive: true, force: true });
  if (DKSAVED == null) fs.rmSync(DKOK, { force: true });
  else fs.writeFileSync(DKOK, DKSAVED);
});

test("升级成功：新版覆盖旧版同名文件，旧版独有的删掉，别的组件共用的保留并转记", () => {
  put("bin/up-tool", "v1");
  put("share/up0610/data.txt", "old");
  put("share/up0610/oldonly.txt", "only-in-v1");
  put("share/up0610/keep.txt", "old-keep");
  compWriteRecord("co0610", { id: "co0610", version: "1.0", state: "ok", base: "dk0610", files: ["share/up0610/keep.txt"], shared: [] });
  compWriteRecord("up0610", { id: "up0610", version: "1.0.0", state: "ok", base: "dk0610", at: 1,
    files: ["bin/up-tool", "share/up0610/data.txt", "share/up0610/oldonly.txt", "share/up0610/keep.txt"], shared: [] });
  const root = tree("up0610", {
    "bin/up-tool": "v2", "share/up0610/data.txt": "new",
    "share/up0610/keep.txt": "new-keep", "share/up0610/new.txt": "brand new",
  });
  const rec = compSwitch("up0610", BUILD("2.0.0"), root);
  assert.equal(rec.state, "installing");
  assert.equal(read("bin/up-tool"), "v2", "同路径换成新版");
  assert.equal(read("share/up0610/data.txt"), "new");
  assert.equal(read("share/up0610/keep.txt"), "old-keep", "别的组件也在用的文件不覆盖");
  assert.ok(rec.shared.includes("share/up0610/keep.txt"));
  assert.equal(read("share/up0610/new.txt"), "brand new");
  assert.ok(!fs.existsSync(path.join(PREFIX, "share/up0610/oldonly.txt")), "新版里没有的旧文件提交后删掉");
  assert.ok(compRecord("co0610").files.includes("share/up0610/keep.txt"), "共用文件仍记在别的组件名下");
  assert.ok(!fs.existsSync(path.join(STAGE, "up0610.old")), "备份目录清掉");
});

test("升级搬一半失败：旧版文件原样放回，记录退回 ok，备份清掉", () => {
  put("bin/rb-tool", "v1");
  put("share/rb0610/a.txt", "old-a");
  compWriteRecord("rb0610", { id: "rb0610", version: "1.0.0", state: "ok", base: "dk0610", at: 1,
    files: ["bin/rb-tool", "share/rb0610/a.txt"], shared: [] });
  fs.mkdirSync(LOCKED, { recursive: true });
  fs.chmodSync(LOCKED, 0o555);            // 新版有个文件要放进这里：rename 必失败
  const root = tree("rb0610", { "bin/rb-tool": "v2", "share/rb0610/a.txt": "new-a", "lib/locked0610/x.txt": "x" });
  assert.throws(() => compSwitch("rb0610", BUILD("2.0.0"), root), /EACCES|EPERM/);
  assert.equal(read("bin/rb-tool"), "v1", "旧版程序放回来了");
  assert.equal(read("share/rb0610/a.txt"), "old-a", "旧版数据放回来了");
  const rec = compRecord("rb0610");
  assert.equal(rec.state, "ok", "记录退回旧版");
  assert.equal(rec.version, "1.0.0");
  assert.ok(!fs.existsSync(path.join(STAGE, "rb0610.old")), "备份目录清掉");
  assert.ok(!fs.existsSync(path.join(LOCKED, "x.txt")), "没搬进去的新文件不留");
});

test("首次安装：没有旧版也照常落位", () => {
  const root = tree("fi0610", { "bin/fi-tool": "hello" });
  const rec = compSwitch("fi0610", BUILD("1.0"), root);
  assert.equal(rec.state, "installing");
  assert.ok(rec.files.includes("bin/fi-tool"));
  assert.equal(read("bin/fi-tool"), "hello");
  assert.ok(!fs.existsSync(path.join(STAGE, "fi0610.old")));
});
