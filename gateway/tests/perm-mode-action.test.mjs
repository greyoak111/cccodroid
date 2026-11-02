import "../gw/config.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { permModeAction } from "../gw/config.mjs";

// 批准权限请求时顺带切模式的规则（群友 11-02：批准计划把「全部放行」降了级）
test("批准带到「自动接受编辑」及以下：改全局", () => {
  assert.equal(permModeAction("allow", "default", "bypassPermissions"), "global");
  assert.equal(permModeAction("allow", "acceptEdits", "default"), "global");
});

test("宽模式只能原样保持本轮，不能借批准放宽", () => {
  assert.equal(permModeAction("allow", "bypassPermissions", "bypassPermissions"), "run");
  assert.equal(permModeAction("allow", "auto", "auto"), "run");
  assert.equal(permModeAction("allow", "bypassPermissions", "default"), "none");
  assert.equal(permModeAction("allow", "dontAsk", "plan"), "none");
});

test("拒绝、没带模式、不认识的模式：都不动", () => {
  assert.equal(permModeAction("deny", "acceptEdits", "default"), "none");
  assert.equal(permModeAction("deny", "bypassPermissions", "bypassPermissions"), "none");
  assert.equal(permModeAction("allow", null, "default"), "none");
  assert.equal(permModeAction("allow", "manual", "default"), "none");
});
