// 0.6.10 第二轮车道 f3：各车道移交过来的前端修复。
// 这些逻辑依赖 DOM / WebView，node 里整段跑不起来，用源码锚点锁行为（同 a0610-f1-frontend.test.mjs）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(`../web/${p}`, import.meta.url), "utf8");
const src03 = read("app/03-perm-status.js");
const src04 = read("app/04-session-flow.js");
const src05 = read("app/05-composer.js");
const src07 = read("app/07-sessions.js");
const src08 = read("app/08-extensions.js");
const src09 = read("app/09-settings.js");
const src11 = read("app/11-usage.js");
const src13 = read("app/13-nav-menus.js");
const src14 = read("app/14-projects-sched.js");
const src19 = read("app/19-boot.js");

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

test("A4 195-K.4：新建项目指令没写进去要提示，并留在指令框里", () => {
  assert.ok(src14.includes("r.instrSkipped ? t(\"项目已创建；目录里已有 CLAUDE.md，填的指令没写进去\")"), "instrSkipped 要提示");
  assert.ok(src14.includes("PJ.instrDraft = { id: r.project.id, text: body.instr.trim() }"), "填的指令先留着");
  assert.ok(src14.includes("if (PJ.instrDraft && PJ.instrDraft.id === id)"), "项目页把草稿并进指令框");
});

test("A4 195-N.1：改 / 删项目失败显示网关回的 message，不当成功", () => {
  assert.ok(src14.includes("catch (err) { e.target.value = p[k] || \"\"; toast(err.message, true); }"), "PATCH 失败显示 message 并回退下拉");
  assert.ok(src14.includes("catch (err) { return toast(err.message, true); }"), "DELETE 失败显示 message");
});

test("A6 195-G.3：顶栏登录态用 /api/status 的 auth，退出后立即刷新", () => {
  assert.ok(src19.includes("const auth = s.keyMode === \"login\" ? s.auth : null"), "取 /api/status 的 auth");
  assert.ok(src19.includes("auth.unknown ? t(\"官方登录态 · 问不出登录状态\")"), "问不出时不当作未登录");
  assert.ok(src19.includes("官方登录态 · 上次问到时已登录"), "沿用旧结果要标明是上次问到的");
  assert.ok(src19.includes("needLogin ? t(\"需要登录账户\")"), "真实未登录时不再显示就绪");
  assert.ok(!src19.includes("s.keyMode === \"login\" ? t(\"官方登录态\") :"), "凭据行不再只看 keyMode");
  assert.ok(src13.includes("if (s.keyMode === \"login\" && s.auth && !s.auth.unknown) acctLogged = !!s.auth.loggedIn"), "账户菜单先用 auth 定登录与否");
  assert.ok(src13.includes("if (r.ok) { acctLogged = false; acctEmail = \"\"; acctWeek = null; }"), "退出成功立即换回「登录账户」");
  assert.ok(src13.includes("if (!st.unknown) acctLogged = !!st.loggedIn"), "问不出时不动上次判断");
});

test("A7 195-G.4：登录 pending 继续轮询，晚到的授权地址补开，失败也给终端登录入口", () => {
  assert.ok(src09.includes("if (r.url) { loginUrlOpened = r.url; openExternal(r.url); }"), "启动拿到地址就打开并记下");
  assert.ok(src09.includes("if (st.url && st.url !== loginUrlOpened) {"), "轮询里补开晚到的地址，且只开一次");
  assert.ok(src09.includes("openExternal(st.url);"), "补开动作");
  assert.ok(src09.includes("paintLoginFlow(\"\", method)"), "失败分支也有流程块（终端登录入口）");
  assert.ok(src09.includes("登录还在进行，拿到授权地址后会自动打开。"), "等待地址时说明会补开");
});

test("A9 195-F.4：手动放入 / 直链下好的模型能在应用里删除", () => {
  assert.ok(src09.includes("data-del=\"${esc(m.id)}\""), "模型列表带删除按钮");
  assert.ok(src09.includes("post(\"/api/local/model\", { op: \"remove\", id })"), "调用网关的 remove");
  assert.ok(src09.includes("删掉模型「{id}」？文件会从模型目录里删除。"), "删除前确认");
});

test("A11 196-会话.6：导入中途失败也列出已导入的数量", () => {
  assert.ok(src07.includes("err.body && Array.isArray(err.body.imported)"), "读错误回执里的 imported");
  assert.ok(src07.includes("已导入 {n} 个，后面的失败：{msg}"), "已导入的如实说出来");
  assert.ok(src07.includes("const n = (r.imported || []).length"), "成功路径也防字段缺失");
});

test("A10 195-C.18：0 字节文件照传，失败原因读网关回的 message / error", () => {
  assert.ok(!src05.includes("if (!f.size)"), "不再在本地拦 0 字节文件");
  assert.ok(src05.includes("0 字节也照传：网关现在收空文件"), "写明为什么不再拦");
  assert.ok(src05.includes("j && (j.message || j.error)"), "非 2xx 读网关原因，不只报状态码");
  assert.ok(src05.includes("r.status === 507 ? t(\"存储空间不够了\")"), "网关没给原因时按状态给本地化原因");
});

test("B12 195-I.4 / 196 组件市场.1：模块装完 / 卸完后刷新组件卡", () => {
  assert.ok(src08.includes("let modTouched = false;"), "记下模块操作成功");
  assert.ok(src08.includes("else modTouched = true;"), "模块 POST 成功才置位");
  assert.ok(src08.includes("if (!moving && modTouched && pageOn(\"ext\")) { modTouched = false; loadComponents(); }"), "任务结束（没有进行中的模块）再刷组件卡");
});

test("B13 195-I.7 / 196 组件.4：无对应构建时说明原因并给「检查更新」入口", () => {
  assert.ok(src08.includes("工具包更新过，暂无适配版本"), "状态文案不再说「需要重新安装」");
  assert.ok(src08.includes("先更新工具包，或点「检查更新」重新拉一次清单。"), "卡片里说明怎么办");
  assert.ok(src08.includes("btn(\"reindex\", c.id, t(\"检查更新\"))"), "没有安装按钮时给检查更新入口");
});

test("B14 196 端侧.5：到 GitHub 反馈按钮有忙碌态，防连点", () => {
  assert.ok(src08.includes("if (b.dataset.busy) return;"), "忙碌时直接返回");
  assert.ok(src08.includes("b.dataset.busy = \"1\"; b.disabled = true;"), "取 Issue 草稿期间置忙");
  assert.ok(src08.includes("finally { delete b.dataset.busy; b.disabled = false; }"), "完成或失败都恢复");
});

test("C28 195-O.5–O.7 / 197-5.12：跨午夜 / 换时区重算，补算进度也重画，清除本月不误删邻月", () => {
  assert.ok(src11.includes("function usDayMoved()"), "记住本地日期与时区");
  assert.ok(src11.includes("Intl.DateTimeFormat().resolvedOptions().timeZone"), "按运行时区判断");
  assert.ok(src11.includes("document.addEventListener(\"visibilitychange\""), "回到前台重算");
  assert.ok(src11.includes("x.importing, x.off, x.since"), "轮询比较补算 / 开关 / 起始时间");
  assert.ok(src11.includes("const clearFrom = Math.ceil(usMonth0(y, m).getTime() / 3600e3) * 3600e3;"), "清除区间对到整点桶");
  assert.ok(src11.includes("已过重置时间，下一轮对话后刷新"), "重置时间过了不再说够用");
});
