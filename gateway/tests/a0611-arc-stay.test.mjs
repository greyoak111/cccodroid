// 0.6.11 真机验出：在压缩包里预览完文件、关掉查看器，会被踢回压缩包所在的目录。
// fsLoad 会清掉 state.fs.arc；压缩包模式下的刷新都得走 arcLoad。依赖 DOM，用源码锚点锁行为（同 a0610-f3-frontend）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(`../web/${p}`, import.meta.url), "utf8");
const src06 = read("app/06-files.js");
const src17 = read("app/17-office.js");

test("fsLoad 确实会清掉压缩包状态（下面几条的前提）", () => {
  assert.match(src06, /async function fsLoad[\s\S]*?state\.fs\.arc = null;/);
});

test("关查看器：在压缩包里就刷新包内这一层，不调 fsLoad", () => {
  const body = src17.slice(src17.indexOf("function closeViewer()"), src17.indexOf('$("vw-close")'));
  assert.ok(body.includes("if (state.fs.arc) arcLoad(state.fs.arc.dir, { keepSel: true });"), "压缩包模式要走 arcLoad");
  assert.ok(/else if \(state\.fs\.path\) fsLoad\(/.test(body), "普通目录照旧 fsLoad");
});

test("进压缩包时清掉 qRemote：清过滤词不会回头 fsLoad", () => {
  const body = src06.slice(src06.indexOf("async function arcOpen("), src06.indexOf("async function arcLoad("));
  assert.ok(body.includes("state.fs.qRemote = false;"));
});

test("隐藏项开关在压缩包里不触发 fsLoad", () => {
  assert.ok(src06.includes('state.fs.hidden = e.target.checked; if (!state.fs.arc) fsLoad(state.fs.path);'));
});
