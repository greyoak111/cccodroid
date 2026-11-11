// 稳定性报告 FIND-031：去系统设置里改完通知权限，回到应用时设置页不会重新打开，
// 状态一直显示改之前的，要关掉设置再开才刷新。回到前台且设置页开着时重拉一次。
// 依赖 WebView 的 document 事件，锁源码行为。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const src10 = fs.readFileSync(new URL("../web/app/10-settings-device.js", import.meta.url), "utf8");

test("FIND-031 从系统设置回来（visibilitychange → visible）且设置页开着时重拉通知状态", () => {
  assert.match(src10, /document\.addEventListener\("visibilitychange", \(\) => \{ if \(!document\.hidden && setOpen\) loadNotify\(\); \}\);/,
    "缺回到前台时的通知状态刷新");
  const at = src10.indexOf('document.addEventListener("visibilitychange", () => { if (!document.hidden && setOpen) loadNotify(); });');
  const near = src10.slice(Math.max(0, at - 400), at + 200);
  assert.ok(near.includes("notify_status") || near.includes("loadNotify"), "刷新要落在通知这段附近");
});
