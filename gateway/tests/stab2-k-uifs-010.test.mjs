// 第二份稳定性报告 k 组 UIFS-010：普通设置连续保存时旧整份快照晚到，
// 前端 state.settings 可能退回旧状态。VM 抽取 12-model-caps.js 的 saveSettings 实际源码跑。
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
const T = (s, v) => String(s).replace(/\{(\w+)\}/g, (_, k) => String(v && k in v ? v[k] : "{" + k + "}"));

// ── 12-model-caps.js 的 saveSettings：普通设置的并发送存与快照合并 ──────
function loadSaveSettings() {
  const src = read("../web/app/12-model-caps.js");
  // 改前是 async function saveSettings，改后是同步包装 + async saveSettingsNow：
  // 从 function 关键字起切，遇到 async 前缀要一起带上
  let a = src.indexOf("function saveSettings(patch) {");
  assert.ok(a >= 0, "12-model-caps.js 里找不到 saveSettings");
  if (src.slice(Math.max(0, a - 6), a) === "async ") a -= 6;
  // 队列变量声明在函数前一行（含 loadSettings 用的计数器），有就一起切进来
  const q = src.lastIndexOf("let saveQ = Promise.resolve()", a);
  const hasDecl = q >= 0 && a - q < 200;
  if (hasDecl) a = q;
  const b = src.indexOf("  // 没存上：控件回到真正存着的值", a);
  assert.ok(b > a, "12-model-caps.js 里找不到 saveSettings 结束标记");
  const fn = src.slice(a, b);
  const code = `
${hasDecl ? "" : "let saveQ = Promise.resolve();"}
${fn}
let state = { settings: { outputStyle: "old" }, model: "m" };
let apiCalls = [], apiImpl = null;
const api = (p, opts) => { const c = { p, opts }; apiCalls.push(c); return apiImpl(c); };
const paintModel = () => {};
const curModel = () => "";
const t = T;
const refreshSessModel = () => {};
const setPermChip = () => {};
const renderDirs = () => {};
let toastLog = [];
const toast = (m, e) => toastLog.push(m);
let revertLog = [];
const revertSet = (patch) => revertLog.push(patch);
globalThis.__k = {
  state,
  save: (patch) => saveSettings(patch),
  get apiCalls() { return apiCalls; },
  set apiImpl(f) { apiImpl = f; },
  get toastLog() { return toastLog; },
  get revertLog() { return revertLog; },
};
`;
  const ctx = { T };
  vm.runInNewContext(code, ctx);
  return ctx.__k;
}

test("UIFS-010：连点两次保存要按序发请求，第二次不等第一次的回执不发", async () => {
  const h = loadSaveSettings();
  const d1 = deferred(), d2 = deferred();
  let n = 0;
  h.apiImpl = () => (n++ === 0 ? d1.promise : d2.promise);
  const p1 = h.save({ outputStyle: "A" });
  const p2 = h.save({ outputStyle: "B" });
  await sleep();
  assert.equal(h.apiCalls.length, 1, "第二次保存和第一次并发了");
  d1.resolve({ settings: { outputStyle: "A" } });
  await p1;
  await sleep();
  assert.equal(h.apiCalls.length, 2, "第一次回执后第二次保存没发出");
  d2.resolve({ settings: { outputStyle: "B" } });
  await p2;
  assert.equal(h.state.settings.outputStyle, "B");
});

test("UIFS-010：旧整份快照晚到，不许把 state.settings 盖回旧值", async () => {
  const h = loadSaveSettings();
  const d1 = deferred(), d2 = deferred();
  let n = 0;
  h.apiImpl = () => (n++ === 0 ? d1.promise : d2.promise);
  const p1 = h.save({ outputStyle: "A" });
  const p2 = h.save({ outputStyle: "B" });
  await sleep();
  if (h.apiCalls.length === 2) {
    // 并发实现：按报告的条件让回执乱序（B 先到、含 A 的旧快照后到）
    d2.resolve({ settings: { outputStyle: "B" } });
    await sleep();
    d1.resolve({ settings: { outputStyle: "A" } });
  } else {
    // 串行实现：回执只能按序到
    d1.resolve({ settings: { outputStyle: "A" } });
    await sleep();
    d2.resolve({ settings: { outputStyle: "B" } });
  }
  await Promise.all([p1, p2]);
  assert.equal(h.state.settings.outputStyle, "B", "旧快照把新保存的结果盖回去了");
});

test("UIFS-010：一次保存失败不堵住后面的保存，失败只回滚自己这次的 patch", async () => {
  const h = loadSaveSettings();
  h.apiImpl = (c) => {
    if (String(c.opts.body).includes('"bad"')) return Promise.reject(new Error("boom"));
    return Promise.resolve({ settings: { outputStyle: "good" } });
  };
  const p1 = h.save({ outputStyle: "bad" });
  const p2 = h.save({ outputStyle: "good" });
  await p1;
  await p2;
  assert.deepEqual(Array.from(h.revertLog, (p) => ({ ...p })), [{ outputStyle: "bad" }]);
  assert.equal(h.state.settings.outputStyle, "good");
});

test("UIFS-010：单次保存照常合并服务端返回的整份设置（回归保护）", async () => {
  const h = loadSaveSettings();
  h.apiImpl = () => Promise.resolve({ settings: { outputStyle: "single", model: "m2" } });
  const r = await h.save({ outputStyle: "single" });
  assert.equal(r.settings.outputStyle, "single");
  assert.equal(h.state.settings.outputStyle, "single");
  assert.equal(h.state.settings.model, "m2");
});
