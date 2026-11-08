// 0.6.11 真机：「修补」把修复工具包交给应用后，网关马上再核，核出的还是旧结果；界面打 ✓、提示「修补结束」，
// 几秒后换回旧列表，看着像「修完还是坏的」。交给应用的要真起原生应用，这里用源码锚点锁行为（同 a0611-arc-stay）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const gw = fs.readFileSync(new URL("../gw/reconcile.mjs", import.meta.url), "utf8");
const ui = fs.readFileSync(new URL("../web/app/08-extensions.js", import.meta.url), "utf8");

test("有交给应用的步骤时网关不马上再核", () => {
  assert.ok(gw.includes('if (!steps.some((s) => s.state === "handed")) await reconcileRun();'));
});
test("界面：交给应用的不打勾、不说修补结束、不换回旧结果", () => {
  assert.ok(ui.includes('uiI(s.state === "ok" ? "check"'), "只有 ok 打勾");
  const end = ui.slice(ui.indexOf("async function followFix"), ui.indexOf('$("reconcile-box").addEventListener'));
  const i = end.indexOf('j.steps.some((s) => s.state === "handed")'), k = end.indexOf('t("修补结束")');
  assert.ok(i > 0 && k > i, "先判断交给应用的，再说修补结束");
  assert.match(end.slice(i, k), /return toast\(/, "交给应用的直接返回，不走后面换回旧结果");
});
