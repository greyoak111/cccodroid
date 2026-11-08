// 0.6.10 第二轮车道 f3：各车道移交过来的前端修复。
// 这些逻辑依赖 DOM / WebView，node 里整段跑不起来，用源码锚点锁行为（同 a0610-f1-frontend.test.mjs）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(`../web/${p}`, import.meta.url), "utf8");
const src03 = read("app/03-perm-status.js");
const src04 = read("app/04-session-flow.js");
const src09 = read("app/09-settings.js");
const src11 = read("app/11-usage.js");

test("A1 195-A.6 / P1-12：权限切档以网关回的 mode 为准，全局设置记 wanted", () => {
  assert.ok(src03.includes("state.settings.permissionMode = r.wanted || r.mode || mode"), "全局设置要记用户选的 wanted");
  assert.ok(src03.includes("const eff = r.mode || r.wanted || mode"), "chip 用网关回的生效值");
  assert.ok(!src03.includes("state.safeMode && [\"bypassPermissions\", \"auto\", \"acceptEdits\"].includes(r.mode)"), "不再在前端重复推导生效档");
  assert.ok(src03.includes("if (eff !== mode) toast(t(\"安全模式下不问人的几档不生效，现在是「逐项确认」\"))"), "不生效时提示实际模式");
  assert.ok(src03.includes("else if (r.saved === false) toast(t(\"设置没保存上，重启后会回到原来的权限模式\"), true)"), "保存失败要如实提示");
});

test("A2 195-AA.5：中断卡片重发按 req 还原项目 / 钉选 / 汇合来源，截断要提示", () => {
  assert.ok(src04.includes("const req = it.req || {}"), "读运行标记里的 req");
  assert.ok(src04.includes("if (!view.sessionId) {"), "只对新会话视图还原");
  assert.ok(src04.includes("view.projectId = req.projectId; paintProjChip()"), "复用项目面板的设置函数");
  assert.ok(src04.includes("state.pendingModel = req.pin; refreshSessModel()"), "复用模型面板的暂存函数");
  assert.ok(src04.includes("view.pendingMerge = req.mergeFrom"), "汇合来源也要还原");
  assert.ok(src04.includes("if (it.textCut) toast(t(\"原消息太长，只恢复了前 6.5 万字\"))"), "截断要说明");
});

test("A5 195-G.2：登录状态 unknown / stale 当「还不知道」，首屏不收起输入框", () => {
  assert.ok(src04.includes("if (st && (st.unknown || st.stale)) return null;"), "问不出结果时返回 null，不当作未登录");
  assert.ok(src04.includes("catch { return null; }"), "查询失败也不当作未登录");
});

test("A8 195-R.8：安全通知取不到 / 还在取时都有提示", () => {
  assert.ok(src04.includes("r.error") && src04.includes("toast(t(\"暂时取不到安全通知\"), true)"), "error 非空要提示");
  assert.ok(src04.includes("r.fetching") && src04.includes("toast(t(\"正在获取安全通知…\"))"), "fetching 时显示加载");
});

test("A3 P1-2：接口卡换了主机会提示旧 Key 被清掉", () => {
  assert.ok(src11.includes("r.keyCleared ? t(\"换了主机，旧 Key 已清掉，请重新填\")"), "keyCleared 要提示重新填");
});

test("C25 197-5.7：额度超过 100% 时数字如实显示，只把条子画满", () => {
  assert.ok(src11.includes("const pct = Math.round(Math.max(0, +q.used || 0)), barPct = Math.min(100, pct)"), "11-usage 的数值不夹到 100");
  assert.ok(src11.includes("style=\"width:${barPct}%\""), "11-usage 的进度条画满即可");
  assert.ok(src09.includes("const pct = Math.round(Math.max(0, +w.used || 0)), bar = Math.min(100, pct)"), "设置页的用量行 / 额度块同样处理");
  assert.ok(!src09.includes("Math.min(100, w.used)"), "不再把显示值夹到 100");
});

test("C27 195-L.10：改强调色后重画月报", () => {
  assert.ok(src11.includes("getElementById(\"user-accent\")"), "盯住 theme.js 写强调色的那段 style");
  assert.ok(src11.includes("new MutationObserver(usRepaint).observe(el"), "style 内容变了就重画");
});

test("C28 195-O.5–O.7 / 197-5.12：跨午夜 / 换时区重算，补算进度也重画，清除本月不误删邻月", () => {
  assert.ok(src11.includes("function usDayMoved()"), "记住本地日期与时区");
  assert.ok(src11.includes("Intl.DateTimeFormat().resolvedOptions().timeZone"), "按运行时区判断");
  assert.ok(src11.includes("document.addEventListener(\"visibilitychange\""), "回到前台重算");
  assert.ok(src11.includes("x.importing, x.off, x.since"), "轮询比较补算 / 开关 / 起始时间");
  assert.ok(src11.includes("const clearFrom = Math.ceil(usMonth0(y, m).getTime() / 3600e3) * 3600e3;"), "清除区间对到整点桶");
  assert.ok(src11.includes("已过重置时间，下一轮对话后刷新"), "重置时间过了不再说够用");
});
