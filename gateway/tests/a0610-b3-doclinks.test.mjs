// 0.6.10 车道 b3：组件文档软链悬空（196-真机.3）
// share/doc/<包>/copyright 这类软链指向包里没带的 LICENSES 时，装进去就是断链；
// 安装收尾不留在清单里，卸载 / 升级后再把已经断的扫一遍。只碰 share/doc 下的软链。
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PREFIX } from "../gw/config.mjs";
import { _compForTest } from "../gw/components.mjs";

const { compDropDanglingDocs, compSweepDanglingDocs } = _compForTest;
const DOC = path.join(PREFIX, "share/doc");
const DROP = path.join(DOC, "b3-drop"), SWEEP = path.join(DOC, "b3-sweep");
const KEEP_BIN = path.join(PREFIX, "bin/b3-doc-keep");

after(() => {
  fs.rmSync(DROP, { recursive: true, force: true });
  fs.rmSync(SWEEP, { recursive: true, force: true });
  fs.rmSync(KEEP_BIN, { force: true });
});

test("安装：指向包里没有的 LICENSES 的文档软链不留下、不记进清单", () => {
  fs.mkdirSync(DROP, { recursive: true });
  fs.writeFileSync(path.join(DROP, "target.txt"), "真东西");
  fs.symlinkSync("target.txt", path.join(DROP, "good.txt"));
  fs.symlinkSync("../../LICENSES/GPL-3.0.txt", path.join(DROP, "bad.txt"));
  fs.mkdirSync(path.join(PREFIX, "bin"), { recursive: true });
  fs.symlinkSync("b3-doc-missing", KEEP_BIN);   // 不是文档软链：不归这条管
  const rec = { id: "b3-doc", files: [
    "share/doc/b3-drop/target.txt", "share/doc/b3-drop/good.txt", "share/doc/b3-drop/bad.txt", "bin/b3-doc-keep",
  ] };
  assert.equal(compDropDanglingDocs(rec), 1);
  assert.equal(fs.existsSync(path.join(DROP, "bad.txt")), false, "断链要删掉");
  assert.equal(fs.readFileSync(path.join(DROP, "good.txt"), "utf8"), "真东西", "能到目标的软链保留");
  assert.ok(!rec.files.includes("share/doc/b3-drop/bad.txt"), "记录里不能再有它");
  assert.equal(rec.files.length, 3);
  assert.ok(fs.lstatSync(KEEP_BIN).isSymbolicLink(), "share/doc 以外的悬空软链不碰");
});

test("卸载 / 升级后：share/doc 下已经断掉的软链清掉，普通文件与非文档软链不动", () => {
  fs.mkdirSync(SWEEP, { recursive: true });
  fs.writeFileSync(path.join(SWEEP, "target.txt"), "真东西");
  fs.symlinkSync("target.txt", path.join(SWEEP, "good.txt"));
  fs.symlinkSync("../../LICENSES/Apache-2.0.txt", path.join(SWEEP, "bad.txt"));
  fs.writeFileSync(path.join(SWEEP, "plain.txt"), "普通文件");
  compSweepDanglingDocs();
  assert.equal(fs.existsSync(path.join(SWEEP, "bad.txt")), false, "断链要扫掉");
  assert.equal(fs.readFileSync(path.join(SWEEP, "good.txt"), "utf8"), "真东西");
  assert.equal(fs.readFileSync(path.join(SWEEP, "plain.txt"), "utf8"), "普通文件");
  assert.ok(fs.lstatSync(KEEP_BIN).isSymbolicLink(), "share/doc 以外的悬空软链不碰");
});
