// 第二份稳定性报告 i 组：BUG-UIFS-003（流式切段的围栏判据与 renderMd 不一致，
// 冻结后最终代码排版不能自愈）。跑 web/app 里的 safeSplit 与 renderMdLines 本尊。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const read = (f) => fs.readFileSync(new URL("../web/app/" + f, import.meta.url), "utf8");
const take = (src, start, end) => { const a = src.indexOf(start), b = src.indexOf(end, a); assert.ok(a >= 0 && b > a, start); return src.slice(a, b); };

function splitFn() {
  const chat = read("02-chat-view.js");
  const box = { console };
  vm.runInNewContext(take(chat, "  function safeSplit(s, from)", "  // 匀速吐字") + "\nglobalThis.safeSplit = safeSplit;", box);
  return box.safeSplit;
}
function renderFn() {
  const core = read("01-core.js");
  const box = {
    console,
    esc: (s) => String(s),
    inlineMd: (s) => s,
    codeBlock: (lang, buf) => `[CODE:${lang}]\n${buf.join("\n")}\n[/CODE]`,
    mathBlock: (tex) => `[MATH:${tex}]`,
    t: (k) => k,
  };
  vm.runInNewContext(take(core, "  function renderMdLines(text)", "  // ── 本地图片内联") + "\nglobalThis.renderMdLines = renderMdLines;", box);
  return box.renderMdLines;
}

const safeSplit = splitFn();
const renderMdLines = renderFn();

// 流式时 paint() 的做法：从 fz 往后找一个代码块外的空行冻结前面，收尾时再画尾段。
// 最终 DOM 必须和同一原文一次性渲染一致。
function incrementalHtml(text, cuts) {
  let fz = 0, vis = "", html = "";
  for (const n of [...cuts, text.length]) {
    vis = text.slice(0, n);
    const idx = safeSplit(vis, fz);
    if (idx > fz) { html += renderMdLines(vis.slice(fz, idx)); fz = idx; }
  }
  return html + renderMdLines(text.slice(fz));
}

test("BUG-UIFS-003：代码块里带 info 的 ```js 不是收尾行，不能在它后面的空行切段", () => {
  const s = "```text\ncode\n```js\n\nmore\n```\n\ntail\n";
  const idx = safeSplit(s, 0);
  assert.equal(idx, s.indexOf("```\n\n") + 3, "在代码块中间切了段：" + JSON.stringify(s.slice(0, idx)));
});

test("BUG-UIFS-003：分片流过带 info 内层行的代码块，最终排版与一次性渲染一致", () => {
  const s = "```text\ncode\n```js\n\nmore\n```\n\ntail\n";
  const full = renderMdLines(s);
  const chunked = incrementalHtml(s, [15, 22, 27]);   // 分别停在 ```js 后、空行后、真收尾后
  assert.equal(chunked, full);
});

test("BUG-UIFS-003：代码块正常闭合后，空行处仍可切段，尾段照常渲染", () => {
  const s = "```js\nconst a = 1;\n```\n\ntail\n";
  assert.equal(safeSplit(s, 0), s.indexOf("```\n\n") + 3);
  assert.equal(incrementalHtml(s, [5, 20]), renderMdLines(s));
});

test("BUG-UIFS-003：未闭合的代码块不切段（流式中途保持整块）", () => {
  const s = "前文\n```js\nlet a = 1;\n\nlet b = 2;\n";
  assert.equal(safeSplit(s, 0), -1);
});

test("BUG-UIFS-003：四反引号行不是 renderMd 认的围栏，也不能让切段器进代码状态", () => {
  const s = "````\n\n正文\n";
  assert.equal(safeSplit(s, 0), s.indexOf("\n\n") );
});

test("BUG-UIFS-003：已经冻结过一段后，从冻结处继续扫也要按同一判据（from > 0）", () => {
  const s = "```\na\n```\n\nmid\n\n```text\nb\n```js\n\nc\n```\n\ntail\n";
  const full = renderMdLines(s);
  const chunked = incrementalHtml(s, [16]);
  assert.equal(chunked, full);
});
