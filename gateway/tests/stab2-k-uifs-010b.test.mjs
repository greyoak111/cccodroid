// 第二份稳定性报告 k 组 UIFS-010 的另一条竞态：loadSettings（GET）和保存并发时，
// 迟到的 GET 快照会把刚保存的值在 state.settings 上盖回去。VM 抽取 12-model-caps.js 的实际源码跑。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");
const sleep = () => new Promise((r) => setTimeout(r, 0));
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function load() {
  const src = read("../web/app/12-model-caps.js");
  const cut = (from, to) => {
    const a = src.indexOf(from);
    assert.ok(a >= 0, "12-model-caps.js 里找不到 " + from);
    const b = src.indexOf(to, a);
    assert.ok(b > a, "12-model-caps.js 里找不到结束标记 " + to);
    return src.slice(a, b);
  };
  const loadFn = cut("  async function loadSettings() {", "  // 附加目录的增删串行化");
  let q = src.indexOf("  let saveQ = Promise.resolve()");
  const saveFn = src.slice(q, src.indexOf("  // 没存上：控件回到真正存着的值", q));
  const code = `
const el = () => ({ value: "", checked: false, innerHTML: "", textContent: "", max: 0, classList: { toggle() {} } });
const els = {};
const $ = (id) => (els[id] ||= el());
const document = { activeElement: null };
let state = { settings: {}, model: "m" };
let gets = [], posts = [], getImpl = null, postImpl = null;
const api = (p, opts) => {
  if (opts && opts.method === "POST") { posts.push(opts); return postImpl(opts); }
  gets.push(p); return getImpl(p);
};
const t = (s) => s, esc = (s) => s;
const paintModel = () => {}, curModel = () => "", refreshSessModel = () => {}, setPermChip = () => {};
const renderPermBar = () => {}, renderDirs = () => {}, fillMem = () => {};
const loadProviders = async () => {}, loadModels = async () => true, loadWorkIsland = () => {}, loadExecMode = () => {};
const toast = () => {}, revertSet = () => {};
${saveFn}
${loadFn}
globalThis.__k = {
  state, load: () => loadSettings(), save: (p) => saveSettings(p),
  get gets() { return gets; }, get posts() { return posts; },
  set getImpl(f) { getImpl = f; }, set postImpl(f) { postImpl = f; },
};
`;
  const ctx = {};
  vm.runInNewContext(code, ctx);
  return ctx.__k;
}

test("UIFS-010b：保存在路上时 GET 迟到，旧快照不许把刚存的值盖回去", async () => {
  const h = load();
  const post = deferred(), get1 = deferred();
  let n = 0;
  h.postImpl = () => post.promise;
  h.getImpl = () => (n++ === 0 ? get1.promise : Promise.resolve({ outputStyle: "B" }));
  const ps = h.save({ outputStyle: "B" });
  const pl = h.load();
  await sleep();
  post.resolve({ settings: { outputStyle: "B" } });   // 保存先回来
  await ps;
  get1.resolve({ outputStyle: "old" });               // 服务端在保存之前就处理了的 GET，晚到
  await pl;
  assert.equal(h.state.settings.outputStyle, "B", "迟到的 GET 快照把刚保存的值盖回去了");
  assert.equal(h.gets.length, 2, "过时的快照应丢弃并在保存排完后重读");
});

test("UIFS-010b：GET 途中才点保存，同样丢掉旧快照、等保存完重读", async () => {
  const h = load();
  const get1 = deferred(), post = deferred();
  let n = 0;
  h.getImpl = () => (n++ === 0 ? get1.promise : Promise.resolve({ outputStyle: "C" }));
  h.postImpl = () => post.promise;
  const pl = h.load();
  await sleep();
  const ps = h.save({ outputStyle: "C" });
  get1.resolve({ outputStyle: "old" });
  await sleep();
  assert.notEqual(h.state.settings.outputStyle, "old", "保存还没回来就先用了旧快照");
  post.resolve({ settings: { outputStyle: "C" } });
  await ps; await pl;
  assert.equal(h.state.settings.outputStyle, "C");
  assert.equal(h.gets.length, 2);
});

test("UIFS-010b：没有保存时只读一次，照常整份替换（回归保护）", async () => {
  const h = load();
  h.getImpl = () => Promise.resolve({ outputStyle: "x", model: "m1" });
  await h.load();
  assert.equal(h.gets.length, 1);
  assert.equal(h.state.settings.outputStyle, "x");
  assert.equal(h.state.settings.model, "m1");
});

test("UIFS-010b：保存失败也不让 loadSettings 卡住", async () => {
  const h = load();
  const get1 = deferred();
  let n = 0;
  h.postImpl = () => Promise.reject(new Error("boom"));
  h.getImpl = () => (n++ === 0 ? get1.promise : Promise.resolve({ outputStyle: "disk" }));
  const ps = h.save({ outputStyle: "bad" });
  const pl = h.load();
  await ps;
  get1.resolve({ outputStyle: "stale" });
  await pl;
  assert.equal(h.state.settings.outputStyle, "disk");
});
