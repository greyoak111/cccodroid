// 稳定性报告 FIND-026：文本查看器关掉后，行号栏的 ResizeObserver 一直盯着已经拆掉的编辑框，
// 量过的整份行文本（gutM.lines）也跟着页面挂着；预览切编辑时分段 observer 也不断。
// gutStop 的逻辑独立，抽出来在 vm 里跑；三个调用点用源码锚点锁住。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const read = (p) => fs.readFileSync(new URL(`../web/${p}`, import.meta.url), "utf8");
const src16 = read("app/16-viewer-git.js");
const src17 = read("app/17-office.js");

function loadGutStop() {
  const a = src16.indexOf("  let gutTimer = 0, gutRO = null, gutRaf = 0;");
  assert.ok(a > 0, "找不到行号栏状态");
  const f = src16.indexOf("  function gutStop() {", a);
  assert.ok(f > a, "找不到 gutStop");
  const b = src16.indexOf("\n  }\n", f) + 4;
  const code = `
let cleared = [], canceled = [];
const clearTimeout = (id) => cleared.push(id);
const setTimeout = () => 0;
const cancelAnimationFrame = (id) => canceled.push(id);
const requestAnimationFrame = () => 0;
const ResizeObserver = class { constructor() {} observe() {} disconnect() {} };
const GUT_MAX = 20000;
const $ = () => null;
${src16.slice(a, b)}
globalThis.__h = {
  gutStop,
  setRO(o) { gutRO = o; }, setM(o) { gutM = o; },
  setRaf(n) { gutRaf = n; }, setTimer(n) { gutTimer = n; },
  get gutRO() { return gutRO; }, get gutM() { return gutM; },
  get gutRaf() { return gutRaf; }, get gutTimer() { return gutTimer; },
  get cleared() { return cleared; }, get canceled() { return canceled; },
};
`;
  const ctx = {};
  vm.runInNewContext(code, ctx);
  return ctx.__h;
}

test("FIND-026 gutStop 断开 observer、撤销待画帧与定时器、放下行文本", () => {
  const h = loadGutStop();
  const ro = { on: true, disconnect() { this.on = false; } };
  h.setRO(ro); h.setM({ key: "k", lines: ["a"], hs: [], tops: [], r0: -1, r1: -1 });
  h.setRaf(7); h.setTimer(3);
  h.gutStop();
  assert.equal(ro.on, false, "ResizeObserver 要断开");
  assert.equal(h.gutRO, null);
  assert.equal(h.gutM, null, "整份行文本要放下");
  assert.equal(h.gutRaf, 0);
  assert.equal(h.gutTimer, 0);
  assert.equal(h.cleared.join(","), "3");
  assert.equal(h.canceled.join(","), "7");
});

test("FIND-026 关查看器、换文件、切版式三个入口都清理", () => {
  const close = src17.slice(src17.indexOf("function closeViewer()"), src17.indexOf('$("vw-close")'));
  assert.ok(close.includes("gutStop();"), "关查看器要清");
  const open = src16.slice(src16.indexOf("async function openViewer("), src16.indexOf("/** 顶栏右侧的按钮"));
  assert.ok(open.includes("gutStop();"), "换文件要清行号栏");
  assert.ok(open.includes("vwMdStop();"), "换文件要断分段预览 observer");
  const rt = src16.slice(src16.indexOf("function vwRenderText(mode)"), src16.indexOf("// ── Markdown 预览"));
  assert.ok(rt.includes("vwMdStop();"), "预览切编辑要断 observer");
  assert.ok(rt.includes("gutStop();"), "切版式要清行号栏，等新编辑框建好再挂");
});
