// 0.6.10 第二轮车道 f3：各车道移交过来的前端修复。
// 这些逻辑依赖 DOM / WebView，node 里整段跑不起来，用源码锚点锁行为（同 a0610-f1-frontend.test.mjs）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(`../web/${p}`, import.meta.url), "utf8");
const src03 = read("app/03-perm-status.js");
const src04 = read("app/04-session-flow.js");

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
