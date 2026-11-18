// 审计 P2-5：Markdown 预览的 24KB 分段不是硬工作量上限——巨围栏 / 连续列表 / 单行超长
// 曾整块命中观察范围、一次性同步解析几百万字。修复后每个结构超过 128KB 硬上限都要切开。
// mdChunks 是纯字符串函数：从 16-viewer-git.js 里取出真函数在 vm 里跑，不复制逻辑（同 f1 车道的做法）。
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const src = fs.readFileSync(new URL("../web/app/16-viewer-git.js", import.meta.url), "utf8");
const a = src.indexOf("const MD_LAZY_MIN");
const b = src.indexOf("let mdObs", a);
assert.ok(a > 0 && b > a, "16-viewer-git.js 分段函数找不到");
const ctx = {};
vm.runInNewContext(src.slice(a, b) + "\nglobalThis.__md = { mdChunks, MD_CHUNK, MD_CHUNK_HARD };", ctx);
const { mdChunks, MD_CHUNK, MD_CHUNK_HARD } = ctx.__md;

// 真渲染器（同 a0610-f1 车道的取法）：验证切出来的每段都能独立渲染成闭合结构
const src01 = fs.readFileSync(new URL("../web/app/01-core.js", import.meta.url), "utf8");
const ra = src01.indexOf("  const fileUrl =");
const rb = src01.indexOf("  // ── 本地图片内联", ra);
assert.ok(ra > 0 && rb > ra, "01-core.js 渲染器代码块找不到");
const rctx = {};
vm.runInNewContext(`const t = (s) => s;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
${src01.slice(ra, rb)}
globalThis.__r = { renderMd };
`, rctx);
const R = rctx.__r;

test("普通长稿：空行分段、不切在列表前面（原有行为不动）", () => {
  const t = ["a".repeat(30 * 1024), "", "para2", "", "- item"].join("\n");
  const parts = mdChunks(t);
  assert.equal(parts.length, 2, "超软限在空行切，列表前不切：" + parts.length);
  assert.ok(parts[1].includes("\n\n- item"), "列表和上一段留在一起");
});

test("巨围栏（单行 300KB）：按字符切片，每段闭合合法，内容拼起来不丢", () => {
  const inner = "code line " + "x".repeat(300 * 1024);
  const t = ['```js title="t"', inner, "```"].join("\n");
  const parts = mdChunks(t);
  assert.ok(parts.length >= 2, "巨围栏要切开：" + parts.length);
  for (const p of parts) {
    assert.ok(p.length < MD_CHUNK_HARD + MD_CHUNK + 64, "每段有上限：" + p.length);
    const ls = p.split("\n");
    assert.equal(ls[0], '```js title="t"', "每段开头是原围栏行（语言/标题都在）");
    assert.equal(ls[ls.length - 1], "```", "每段结尾是补上的收尾围栏");
  }
  const joined = parts.map((p) => p.split("\n").slice(1, -1).join("\n")).join("");
  assert.equal(joined, inner, "去掉每段首尾围栏后拼回原文");
});

test("巨围栏（5000 行 300KB）：行边界切，每段闭合，内容拼起来不丢", () => {
  const inner = [];
  for (let i = 0; i < 5000; i++) inner.push(("line " + i).padEnd(60, "x"));
  const t = "```\n" + inner.join("\n") + "\n```";
  const parts = mdChunks(t);
  assert.ok(parts.length >= 3, "行边界也要切：" + parts.length);
  for (const p of parts) {
    assert.ok(p.length < MD_CHUNK_HARD + 1024, "每段有上限：" + p.length);
    const ls = p.split("\n");
    assert.equal(ls[0], "```"); assert.equal(ls[ls.length - 1], "```");
  }
  const joined = parts.map((p) => p.split("\n").slice(1, -1).join("\n")).join("\n");
  assert.equal(joined, inner.join("\n"), "拼回原文");
});

test("连续列表（无空行 300KB）：硬上限处切，条目编号原样保留", () => {
  const items = [];
  for (let i = 1; i <= 5000; i++) items.push(i + ". item " + "y".repeat(55));
  const t = items.join("\n");
  const parts = mdChunks(t);
  assert.ok(parts.length >= 2, "连续列表要切：" + parts.length);
  assert.equal(parts.join("\n"), t, "纯行边界切，不插任何行");
  let expected = 1;
  for (const p of parts) for (const l of p.split("\n")) {
    assert.equal(l.startsWith(expected + ". item "), true, "编号跨段不乱（渲染器按 start= 续号）");
    expected++;
  }
});

test("单行超长（无围栏 600KB）：按字符切片，内容不丢", () => {
  const t = "z".repeat(600 * 1024);
  const parts = mdChunks(t);
  assert.ok(parts.length >= 2, "单行超长要切：" + parts.length);
  for (const p of parts.slice(0, -1)) assert.ok(p.length <= MD_CHUNK, "中间片不超过软限：" + p.length);
  assert.equal(parts.join(""), t, "拼接不丢内容");
});

test("巨公式块：切开处补收尾、下段补回开头，内容拼起来不丢", () => {
  const inner = "m".repeat(300 * 1024);
  const t = "$$\n" + inner + "\n$$";
  const parts = mdChunks(t);
  assert.ok(parts.length >= 2, "巨公式要切：" + parts.length);
  for (const p of parts) {
    const ls = p.split("\n");
    assert.equal(ls[0], "$$"); assert.equal(ls[ls.length - 1], "$$");
  }
  const joined = parts.map((p) => p.split("\n").slice(1, -1).join("\n")).join("");
  assert.equal(joined, inner, "拼回原文");
});

test("巨围栏每段用真渲染器渲染：恰好一个闭合代码块，围栏符号不留进正文", () => {
  const inner = [];
  for (let i = 0; i < 3000; i++) inner.push(("line " + i).padEnd(60, "x"));
  const t = "```js\n" + inner.join("\n") + "\n```";
  const parts = mdChunks(t);
  assert.ok(parts.length >= 2, "要切：" + parts.length);
  for (const p of parts) {
    const html = R.renderMd(p, null);
    assert.equal((html.match(/class="code-wrap/g) || []).length, 1, "每段恰好一个代码块");
    assert.equal((html.match(/class="code-ln"/g) || []).length, 1, "行号列也在");
    assert.ok(!html.includes("```"), "围栏符号不留进正文");
    assert.ok(html.includes(">line 0<") === false || p === parts[0], "内容行只在自己那一段");
  }
  const html = parts.map((p) => R.renderMd(p, null)).join("");
  assert.ok(html.includes(("line 2999").padEnd(60, "x")), "最后一行内容渲染出来");
});

test("巨行恰是公式收尾行：分类不乱，后续行照常按正文分（复核第三轮 §5.3）", () => {
  const t = "$$\nx+y\n" + "z".repeat(300 * 1024) + "$$\nplain line";
  const parts = mdChunks(t);
  assert.ok(parts.length >= 2, "巨行要切：" + parts.length);
  const last = parts[parts.length - 1];
  assert.ok(last.endsWith("plain line"), "收尾后的正文行独立在最后一段，不被公式分类吞掉");
  assert.equal(parts.join("\n").replace(/\n/g, ""), t.replace(/\n/g, ""), "字符级不丢内容（切片引入的换行除外）");
});

test("小输入不动：围栏、公式、短稿原样返回", () => {
  // vm 里跑出来的数组原型和宿主不同，deepEqual 判不等，比字符串化结果
  const eq = (got, want) => assert.equal(JSON.stringify(got), JSON.stringify(want));
  eq(mdChunks("```js\nlet a = 1;\n```"), ["```js\nlet a = 1;\n```"]);
  eq(mdChunks("$$\nx+y\n$$"), ["$$\nx+y\n$$"]);
  eq(mdChunks("hello\nworld"), ["hello\nworld"]);
});
