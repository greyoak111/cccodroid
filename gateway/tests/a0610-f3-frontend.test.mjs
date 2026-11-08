// 0.6.10 第二轮车道 f3：各车道移交过来的前端修复。
// 这些逻辑依赖 DOM / WebView，node 里整段跑不起来，用源码锚点锁行为（同 a0610-f1-frontend.test.mjs）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(`../web/${p}`, import.meta.url), "utf8");
const src03 = read("app/03-perm-status.js");

test("A1 195-A.6 / P1-12：权限切档以网关回的 mode 为准，全局设置记 wanted", () => {
  assert.ok(src03.includes("state.settings.permissionMode = r.wanted || r.mode || mode"), "全局设置要记用户选的 wanted");
  assert.ok(src03.includes("const eff = r.mode || r.wanted || mode"), "chip 用网关回的生效值");
  assert.ok(!src03.includes("state.safeMode && [\"bypassPermissions\", \"auto\", \"acceptEdits\"].includes(r.mode)"), "不再在前端重复推导生效档");
  assert.ok(src03.includes("if (eff !== mode) toast(t(\"安全模式下不问人的几档不生效，现在是「逐项确认」\"))"), "不生效时提示实际模式");
  assert.ok(src03.includes("else if (r.saved === false) toast(t(\"设置没保存上，重启后会回到原来的权限模式\"), true)"), "保存失败要如实提示");
});
