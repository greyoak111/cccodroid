// modules.json 形状坏不能把网关带进崩溃循环（0.6.9 审计 198 P1-19）
// 修之前：modules 非数组 / 含 null 条目时，envFactsKey() 的定时器链抛 TypeError。
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PREFIX } from "../gw/config.mjs";
import { modulesInfo } from "../gw/modules.mjs";
import { envFactsKey } from "../gw/envfacts.mjs";

const DK = path.join(PREFIX, "libexec/devkit");
fs.mkdirSync(DK, { recursive: true });
const write = (v) => fs.writeFileSync(path.join(DK, "modules.json"), typeof v === "string" ? v : JSON.stringify(v));

test("modules 非数组 / 原语：modulesInfo 返回 null，envFactsKey 不抛", () => {
  for (const v of [{}, { modules: {} }, { modules: "x" }, { modules: 3 }, { modules: null }, [], 3, "null"]) {
    write(v);
    assert.equal(modulesInfo(), null, JSON.stringify(v));
    assert.equal(typeof envFactsKey(), "string", JSON.stringify(v));
  }
});

test("modules 数组里混坏条目：只丢坏条目，不让 null.id 进定时器", () => {
  write({ snapshot: "s1", modules: [
    { id: "base", kind: "base", dir: "libexec/devkit/modules/base" },
    null, 3, "x", {},
    { id: "no-dir", kind: "module" },
    { id: "build", kind: "module", dir: "libexec/devkit/modules/build" },
  ] });
  const mj = modulesInfo();
  assert.ok(mj);
  assert.deepEqual(mj.modules.map((m) => m.id), ["base", "build"]);
  assert.equal(typeof envFactsKey(), "string");
  assert.match(envFactsKey(), /base/);
});

test("合法模块表照旧读", () => {
  write({ snapshot: "s1", modules: [{ id: "base", kind: "base", dir: "libexec/devkit/modules/base" }] });
  const mj = modulesInfo();
  assert.equal(mj.snapshot, "s1");
  assert.equal(mj.modules.length, 1);
});

test("文件不存在 / 不是 JSON：返回 null（老行为）", () => {
  fs.rmSync(path.join(DK, "modules.json"), { force: true });
  assert.equal(modulesInfo(), null);
  write("{oops");
  assert.equal(modulesInfo(), null);
});
