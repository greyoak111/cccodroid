// 196-供应链.3：pkg 的 installed.json、模块的 modules.json / FILES 都是同 uid 可改的，
// 卸载时不能按里面的 "../"、绝对路径去删 $PREFIX 外面的文件。
import "../gw/config.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PREFIX } from "../gw/config.mjs";
import { modulesInfo, _modForTest } from "../gw/modules.mjs";

const DK = path.join(PREFIX, "libexec/devkit");
fs.mkdirSync(DK, { recursive: true });
const MODDIR = path.join(DK, "modules/modok");
const OK = path.join(PREFIX, ".devkit-ok");
const saved = fs.existsSync(OK) ? fs.readFileSync(OK, "utf8") : null;
const ABS = path.join(os.tmpdir(), "abs0610-" + process.pid);
const ESC = path.join(path.dirname(PREFIX), "escape0610");
const REL = path.join(path.dirname(PREFIX), "b0610");

after(() => {
  fs.rmSync(path.join(DK, "modules.json"), { force: true });
  fs.rmSync(MODDIR, { recursive: true, force: true });
  fs.rmSync(path.join(PREFIX, "bin", "safe0610"), { force: true });
  for (const f of [ABS, ESC, REL]) fs.rmSync(f, { force: true });
  if (saved == null) fs.rmSync(OK, { force: true });
  else fs.writeFileSync(OK, saved);
});

test("modules.json 里的 dir 必须是 $PREFIX 内的普通相对路径，坏的条目整条丢掉", () => {
  fs.writeFileSync(path.join(DK, "modules.json"), JSON.stringify({ modules: [
    { id: "base", kind: "base", dir: "libexec/devkit/modules/base" },
    { id: "modok", kind: "module", dir: "libexec/devkit/modules/modok" },
    { id: "modabs", kind: "module", dir: "/tmp/evil0610" },
    { id: "moddot", kind: "module", dir: "libexec/devkit/modules/../../../evil0610" },
    { id: "modroot", kind: "module", dir: "." },
    { id: "modempty", kind: "module", dir: "" },
  ] }));
  assert.deepEqual(modulesInfo().modules.map((m) => m.id), ["base", "modok"]);
});

test("modRemove 只删 FILES 里安全的相对路径，../ 与绝对路径不碰", () => {
  fs.writeFileSync(OK, JSON.stringify({ sha256: "dk0610" }));
  fs.mkdirSync(path.join(MODDIR), { recursive: true });
  fs.writeFileSync(path.join(MODDIR, "MANIFEST"), "h 1 bin/safe0610\n");
  fs.writeFileSync(path.join(MODDIR, ".ok"), "{}\n");
  fs.writeFileSync(path.join(PREFIX, "bin", "safe0610"), "x");
  fs.writeFileSync(ABS, "x");
  fs.writeFileSync(ESC, "x");
  fs.writeFileSync(REL, "x");
  fs.writeFileSync(path.join(MODDIR, "FILES"), [
    "bin/safe0610",
    "../escape0610",
    ABS,
    "a/../../b0610",
  ].join("\n") + "\n");

  const r = _modForTest.modRemove("modok");
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(!fs.existsSync(path.join(PREFIX, "bin", "safe0610")), "安全路径照常删");
  assert.ok(!fs.existsSync(MODDIR), "模块目录照常删");
  assert.ok(fs.existsSync(ESC), "../ 指到前缀外面的不能删");
  assert.ok(fs.existsSync(ABS), "绝对路径不能删");
  assert.ok(fs.existsSync(REL), "穿越路径不能删");
});

test("pkg 的 removeFiles 用同一个 safeRel 口径", () => {
  const src = fs.readFileSync(new URL("../../android/assets/bin/pkg.mjs", import.meta.url), "utf8");
  assert.match(src, /\.filter\(safeRel\)/, "removeFiles 要按 safeRel 过滤记录里的路径");
  const m = src.match(/const safeRel = (\(r\) =>[\s\S]*?);\n\/\*\* 删掉 rec 里/);
  assert.ok(m, "没找到 pkg 的 safeRel 定义");
  const safeRel = new Function("path", "return " + m[1])(path);
  for (const r of ["/etc/passwd", "../x", "a/../../b", "", ".", "a//b", "a/./b", "a\\b", null, 42])
    assert.equal(safeRel(r), false, JSON.stringify(r));
  for (const r of ["bin/sh", "var/lib/dpkg/info/x.list", "libexec/devkit/components/x/MANIFEST"])
    assert.equal(safeRel(r), true, r);
});
