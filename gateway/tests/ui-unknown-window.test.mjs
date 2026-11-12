// 0.6.17 反馈的两处界面回归：
//  1. 自定义接口的模型窗口未知时，压缩线控件整块被藏掉 / 只剩文字，用户改不了；
//  2. 核对记录里「找不到 Claude Code 程序」的绝对路径没有空格，不折行会撑出设置弹窗。
// 这两段都依赖 WebView，按仓库惯例用源码锚点锁住行为。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(`../web/${p}`, import.meta.url), "utf8");
const caps = read("app/12-model-caps.js");
const indexHtml = read("index.html");
const css = read("style.css");

test("窗口未知时压缩线仍可改：不藏整块，换成数字框", () => {
  assert.match(indexHtml, /id="ac-num"/, "缺窗口未知时用的数字框");
  const from = caps.indexOf("function acPaint(");
  const to = caps.indexOf("function acSaveFrom(");
  assert.ok(from > 0 && to > from, "acPaint / acSaveFrom 代码块找不到");
  const block = caps.slice(from, to);
  assert.ok(block.includes('box.classList.remove("hidden")'), "窗口未知时不该再把整块藏掉");
  assert.ok(block.includes('$("ac-manual").classList.remove("hidden")'), "窗口未知时该露出数字框");
  assert.ok(block.includes('$("ac-val").textContent = acSet'), "已设的值仍要显示出来");
});

test("型号清单为空 / 当前型号不在清单里：Claude 行为页的压缩线也回填", () => {
  const fill = caps.indexOf('if (ac && (acForce || document.activeElement !== ac)) ac.value = r.autoCompactWindow || "";');
  const cur = caps.indexOf("const cur = MODELS.find((m) => m.id === curId);");
  assert.ok(fill > 0, "找不到压缩线回填语句");
  assert.ok(cur > 0, "找不到当前型号查找语句");
  assert.ok(fill < cur, "回填要在 if (cur) 之前，否则清单为空 / 型号不在清单里时不回填");
});

test("核对记录里的长路径会折行，不再撑出设置弹窗", () => {
  assert.match(css, /\.item\.ledger \.tiny\.mono\{word-break:break-all\}/);
});
