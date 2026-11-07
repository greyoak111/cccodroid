// #179：重放收尾批量补画正文时仍走重放的滚动合并——N 块不再是 N 次同步测量。
// 计数替身沿用报告里的复现脚本（DOM / Markdown / 定时器都是计数器，不是性能测试）
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const read = (f) => fs.readFileSync(new URL("../web/app/" + f, import.meta.url), "utf8");
const take = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); assert.ok(i >= 0 && j > i, a); return src.slice(i, j); };
const scroll = take(read("01-core.js"), "  function scrollDown(force)", "  function relTime(");
const block = take(read("02-chat-view.js"), "  function TextBlock(", "  function ThinkBlock(");
const ending = take(read("04-session-flow.js"), "  function endReplay()", "  function updateCtx(");

function run(n, { touch = false } = {}) {
  return vm.runInNewContext(`(() => {
    let reads = 0, writes = 0, top = 0, timerId = 0, rafId = 0;
    const timers = new Map(), rafs = new Map(), els = [];
    const node = () => ({ children: [], innerHTML: "", isConnected: true,
      append(...c) { this.children.push(...c); }, appendChild(c) { this.children.push(c); }, querySelectorAll() { return []; }, remove() {} });
    const document = { hidden: false, createElement: node };
    const setTimeout = (fn) => { const id = ++timerId; timers.set(id, fn); return id; };
    const clearTimeout = (id) => timers.delete(id);
    const requestAnimationFrame = (fn) => { const id = ++rafId; rafs.set(id, fn); return id; };
    const cancelAnimationFrame = (id) => rafs.delete(id);
    const chatEl = { get scrollHeight() { reads++; return 1000; }, get scrollTop() { return top; }, set scrollTop(v) { writes++; top = v; } };
    const liveEl = { classList: { remove() {} } };
    const REPLAY_FLUSH = new Set();
    let busReplay = true, stick = true, touching = ${touch}, scrollRaf = 0, progTop = -1, replayCtx = null;
    const liveCtx = () => {}, safeSplit = () => -1, renderMd = (s) => s, enhanceMd = () => {}, setHtml = (el, h) => { el.innerHTML = h; };
    const STREAM_TICK = 33, STREAM_STEPS = 8;
    ${scroll}
    ${block}
    ${ending}
    for (let i = 0; i < ${n}; i++) { const b = TextBlock(node(), true); b.set("块 " + i); els.push(b.el); }
    endReplay();
    const now = reads;
    for (const [id, fn] of [...rafs]) { rafs.delete(id); fn(); }
    return { now, total: reads, writes, top, replay: busReplay, timers: timers.size, texts: els.map((e) => e.children[1].innerHTML).join("|") };
  })()`);
}

test("收尾补画 1 / 40 / 80 块正文：只同步测量一次，没有多余 rAF；正文一字不差", () => {
  for (const n of [1, 40, 80]) {
    const r = run(n);
    assert.equal(r.now, 1, n + " 块：收尾时只读一次 scrollHeight（原来是 n+1）");
    assert.equal(r.total, 1, n + " 块：补画排下的 rAF 已撤掉");
    assert.equal(r.top, 1000, "到底");
    assert.equal(r.replay, false);
    assert.equal(r.timers, 0, "正文定时器都清了");
    assert.equal(r.texts, Array.from({ length: n }, (_, i) => "块 " + i).join("|"));
  }
});

test("手指按着：收尾不把人拉到底", () => {
  const r = run(40, { touch: true });
  assert.equal(r.writes, 0);
  assert.equal(r.total, 0);
});
