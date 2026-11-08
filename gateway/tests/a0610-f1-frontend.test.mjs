// 0.6.10 审计车道 f1 的回归测试：Markdown 路径 / 围栏用真渲染器跑，
// 其余是网页端修复的源码锚点（这些逻辑依赖 DOM / WebView，无法在 node 里整段跑）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const read = (p) => fs.readFileSync(new URL(`../web/${p}`, import.meta.url), "utf8");
const src01 = read("app/01-core.js");
const src02 = read("app/02-chat-view.js");
const src03 = read("app/03-perm-status.js");
const src04 = read("app/04-session-flow.js");
const src05 = read("app/05-composer.js");
const src07 = read("app/07-sessions.js");
const src13 = read("app/13-nav-menus.js");
const src18d = read("app/18d-bookmarks.js");
const src19 = read("app/19-boot.js");
const indexHtml = read("index.html");
const theme = read("theme.js");
const css = read("style.css");

// 从 01-core.js 里取出真正的渲染器（inlineMd / renderMd / renderMdLines），
// 只补 esc 和 t 两个外部依赖，避免把逻辑复制到测试里、改一处漏一处
function loadRenderer() {
  const a = src01.indexOf("  const fileUrl =");
  const b = src01.indexOf("  // ── 本地图片内联", a);
  assert.ok(a > 0 && b > a, "01-core.js 渲染器代码块找不到");
  const code = `
const t = (s) => s;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
${src01.slice(a, b)}
globalThis.__r = { inlineMd, renderMd };
`;
  const ctx = {};
  vm.runInNewContext(code, ctx);
  return ctx.__r;
}
const R = loadRenderer();

test("C.1 裸路径：空格、#、?、emoji 不再截断，整条进 data-path", () => {
  const h = R.inlineMd("打开 /storage/emulated/0/Download/报告 终稿.pdf 看看");
  assert.match(h, /data-path="\/storage\/emulated\/0\/Download\/报告 终稿\.pdf"/);
  assert.match(h, /<\/a> 看看/);
  const q = R.inlineMd("见 /sdcard/a#b?c=1.txt 完");
  assert.match(q, /data-path="\/sdcard\/a#b\?c=1\.txt"/);
  const e = R.inlineMd("emoji /sdcard/📁 文件夹/a😀.png 结束");
  assert.match(e, /data-path="\/sdcard\/📁 文件夹\/a😀\.png"/);
});

test("C.1/C.25 Markdown 链接：括号配平、尖括号路径、%xx 解码", () => {
  const h = R.inlineMd("[文件](/sdcard/My%20Files/a.pdf) 和 [括号](/sdcard/x(1).pdf)");
  assert.match(h, /data-path="\/sdcard\/My Files\/a\.pdf"[^>]*>文件<\/a>/);
  assert.match(h, /data-path="\/sdcard\/x\(1\)\.pdf"[^>]*>括号<\/a>/);
  const ang = R.inlineMd("[尖括号](</sdcard/My Files/a.pdf>)");
  assert.match(ang, /data-path="\/sdcard\/My Files\/a\.pdf"[^>]*>尖括号<\/a>/);
  const web = R.inlineMd("[网页](https://example.com/a_(b))");
  assert.match(web, /href="https:\/\/example\.com\/a_\(b\)"/);
});

test("C.1 代码片段里的带空格路径也能点", () => {
  const h = R.inlineMd("代码段 `/data/a b/c.txt` 结束");
  assert.match(h, /<code><a class="fpath" data-path="\/data\/a b\/c\.txt"/);
});

test("196-聊天.6 围栏带 info string：后面的正文不会被吞进代码块", () => {
  const h = R.renderMd('```js title="x"\nconst a = 1;\n```\n后面的正文');
  assert.match(h, /data-lang="js"/);
  assert.match(h, /<p>后面的正文<\/p>/);
  // 代码块里以 ``` 开头、带语言的行是内容，只有裸围栏才收尾
  const h2 = R.renderMd("```\n```js\nstill code\n```\n出了吗");
  assert.match(h2, /still code/);
  assert.match(h2, /<p>出了吗<\/p>/);
});

test("前端注入：图片地址白名单、同源接口不带 Cookie、项目颜色校验", () => {
  assert.match(src01, /const SAFE_IMG_DATA = \/\^data:image\\\//);
  assert.match(src01, /function safeImgSrc/);
  assert.ok(src01.includes("k === \"data\" && SAFE_IMG_DATA.test(s)"));
  assert.ok(src01.includes("url.origin === location.origin"));
  assert.match(src01, /api\\\/file/);
  assert.match(src13, /function pjMark\(p\)/);
  assert.ok(src13.includes('const c = /^#[0-9a-f]{6}$/i.test(p.color || "") ? p.color : "var(--accent)";'));
});

test("权限卡：缺 input 不再卡死；生效模式以网关回的 mode 为准；全屏层能弹提示", () => {
  assert.ok(src03.includes('if (!ev.input || typeof ev.input !== "object" || Array.isArray(ev.input)) ev = Object.assign({}, ev, { input: {} });'));
  assert.ok(src03.includes("const COVER_IDS"));
  assert.ok(src03.includes("function revealChat()"));
  // 0.6.10 第二轮 f3（A1）：网关回的是实际生效的 mode，前端不再按 safeMode 自己推导；断言跟着改成新行为
  assert.ok(src03.includes("const eff = r.mode || r.wanted || mode"));
  assert.ok(src03.includes("simple = (it) => !it.p.guard"));
});

test("复制失败不再假报成功（三处调用点都看返回值）", () => {
  assert.ok(src02.includes('copyText(body.trim() || text).then((ok) => toast(ok ? t("已复制") : t("复制失败"), !ok))'));
  assert.ok(src03.includes('copyText(text).then((ok) => toast(ok ? t("已复制") : t("复制失败"), !ok))'));
  assert.ok(src03.includes('t("复制失败"), !ok));'));
});

test("C.17 查看器里点目录：先关查看器，文件页才不会被压在底下", () => {
  assert.ok(src01.includes("if (vw && !vw.classList.contains(\"hidden\")) {"));
  assert.ok(src01.includes("closeViewer();"));
  assert.ok(src01.includes("if (VW.dirty) return;"));
});

test("N.3 启动时设置接口失败会补拉；R.7 整页盖着时先退回对话再开命令面板", () => {
  assert.ok(src19.includes("const ensureSettings = (left) => setTimeout"));
  assert.ok(src19.includes("ensureSettings(3)"));
  assert.ok(src19.includes('$("btn-palette").addEventListener("click", () => { if (curPage) closePage(); openCmdPalette(""); inputEl.focus(); });'));
});

test("批量上传/附件：未完成不发、0 字节照传、失败合并且不砍掉成功的", () => {
  assert.ok(src05.includes("const uploading = new Set()"));
  assert.ok(src05.includes("if (fromInput && uploading.size)"));
  // 0.6.10 第二轮 f3（A10）：网关已收空文件，前端放行 0 字节；第一轮「本地跳过」的断言作废
  assert.ok(!src05.includes("if (!f.size)"));
  assert.ok(src05.includes("0 字节也照传：网关现在收空文件"));
  assert.ok(src05.includes("已附加 {n} 个，{m} 个失败"));
  assert.ok(src05.includes("function normAtt"));
  assert.ok(src05.includes("selectionStart"));
  assert.ok(src05.includes("draftPersistSoon"));
});

test("聊天流式：cid 认轮次、失败卡收尾、长代码块少重排、live 有上限", () => {
  assert.ok(src02.includes("cidRuns: new Map()"));
  assert.ok(src04.includes("view.cidRuns = new Map()"));
  assert.ok(src02.includes("ToolBlock.fail") || src02.includes("fail()"));
  assert.ok(src02.includes("hlAt"));
  assert.ok(src04.includes("const LIVE_MAX = 80"));
  assert.ok(src04.includes("function trimLive()"));
  assert.ok(src04.includes("view.pendNav"));
  assert.ok(src04.includes("function detachRun"));
  assert.ok(src04.includes("keepCidRuns"));
  assert.ok(src04.includes("clearTimeout(busWatch)"));
  assert.ok(src04.includes("bootRestart"));
  assert.ok(src04.includes("(helloCount === 1 || bootRestart)"));
});

test("会话/书签：搜索失败可重试、删除失败合并提示、恢复防连点、多段正文按摊平序号落点", () => {
  assert.ok(src07.includes("hitsErr"));
  assert.ok(src07.includes("没有删成"));
  assert.ok(src07.includes("if (b.disabled) return;"));
  assert.ok(src07.includes("b.disabled = true;"));
  assert.ok(src18d.includes("function paraIndex(msg, box, para)"));
  assert.ok(src18d.includes("para: paraIndex(msg, tg.box, tg.para)"));
  assert.ok(src18d.includes("querySelectorAll(`[data-uuid="));
  assert.ok(src18d.includes("flatMap((x) => paraList("));
  assert.ok(src18d.includes("if (m[sid]) { delete m[sid];"));
});

test("L.5/L.7/L.8 无障碍与繁体：aria-pressed、聊天区不再是 live region、每周不叠「週」", () => {
  assert.ok(theme.includes("b.setAttribute(\"aria-pressed\", String(on))"));
  assert.ok(!indexHtml.includes('<main id="chat" aria-live'));
  assert.ok(indexHtml.includes('id="sr-status"'));
  assert.ok(src13.includes("n.replace(/^(周|週|星期)/, \"\")"));
  assert.ok(src04.includes("srSay("));
});

test("L.2/L.3/L.4/L.6/L.9/L.11/12-10：样式修补都在 0.6.10 f1 追加块里", () => {
  assert.ok(css.includes("/* ── 0.6.10 f1 ──"));
  for (const s of [
    "#lightbox-cap{color:#e9e4d8}",
    'html[dir="rtl"] #set-back svg',
    'html[dir="rtl"] #perm-menu button{text-align:right}',
    "#chat pre code{font-size:calc(var(--fs-chat)*.862)}",
    ":root{--fg3:#8a857a}",
    "#ctxbar::after",
    'html[dir="rtl"] #ctxbar:is(.warn,.danger) #ctxtxt',
    ".sr-only",
  ]) assert.ok(css.includes(s), "缺少样式：" + s);
});

test("移动端：从输入区按钮起手不算抽屉手势", () => {
  assert.ok(src19.includes('#composer button,#composer .att,#composer .chip,#composer [role=button]'));
});

test("app.js 加载失败时静态壳给重试提示（#182 S-02 网页端半）", () => {
  assert.ok(indexHtml.includes("界面脚本没能加载，点这里重试"));
  assert.ok(indexHtml.includes("if (window.__cc) return;"));
  assert.ok(indexHtml.includes("location.reload()"));
});

test("i18n-f1.json：新增文案九种语言齐全", () => {
  const j = JSON.parse(fs.readFileSync(new URL("../../i18n-f1.json", import.meta.url), "utf8"));
  assert.ok(Array.isArray(j), "i18n-f1.json 应当是数组");
  const need = ["回复完成", "回复出错", "界面脚本没能加载，点这里重试"];
  for (const k of need) {
    const row = j.find((x) => x.zh === k);
    assert.ok(row, "缺少词条：" + k);
    for (const lang of ["zh", "en", "ja", "ko", "zh-Hant", "es", "fr", "ru", "id", "ar"]) {
      assert.ok(row[lang], `${k} 缺 ${lang}`);
    }
  }
});
