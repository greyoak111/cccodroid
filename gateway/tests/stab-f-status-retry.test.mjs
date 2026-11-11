// 稳定性报告 FIND-032：notify / dev 状态第一次没读到时（网关刚起、断网）整块隐藏，
// 和「这个版本没有这项」长得一模一样，用户既不知道原因也没法重试。
// 现在失败时显示原因和「重试」，成功后再把原来的块放出来。依赖 DOM，用源码锚点锁行为。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(`../web/${p}`, import.meta.url), "utf8");
const src10 = read("app/10-settings-device.js");
const index = read("index.html");

test("FIND-032 通知状态读取失败：给原因和重试，不静默隐藏", () => {
  const a = src10.indexOf("async function loadNotify()");
  const b = src10.indexOf("for (const k of [\"done\", \"ask\"])", a);
  assert.ok(a > 0 && b > a, "找不到 loadNotify");
  const body = src10.slice(a, b);
  assert.ok(body.includes('$("ntf-err-block").classList.remove("hidden")'), "失败时要露出说明块");
  assert.ok(body.includes('$("ntf-err").textContent = t("读取失败")'), "要写出失败原因");
  assert.ok(src10.includes('$("ntf-retry").addEventListener("click", () => loadNotify())'), "重试按钮要接上");
  assert.ok(index.includes('id="ntf-err-block"') && index.includes('id="ntf-retry"'), "index.html 里要有说明块和重试按钮");
});

test("FIND-032 设备工具状态读取失败：同样给原因和重试", () => {
  const a = src10.indexOf("async function loadDev()");
  const b = src10.indexOf('$("dev-on").addEventListener', a);
  assert.ok(a > 0 && b > a, "找不到 loadDev");
  const body = src10.slice(a, b);
  assert.ok(body.includes('$("dev-err-block").classList.remove("hidden")'));
  assert.ok(body.includes('$("dev-err").textContent = t("读取失败")'));
  assert.ok(src10.includes('$("dev-retry").addEventListener("click", () => loadDev())'));
  assert.ok(index.includes('id="dev-err-block"') && index.includes('id="dev-retry"'));
  // 开发端 / 旧版回的是 { ok:false }，不是网络错误：那种情况照旧不显示（没有这项），不当失败
  assert.ok(body.includes("if (!st.ok) return false;"));
});
