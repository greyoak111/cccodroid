import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.resolve(here, "../web");
const office = fs.readFileSync(path.join(web, "app/17-office.js"), "utf8");
const settle = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };
function fixture() {
  const workers = [], jobs = new Map(), observers = new Set(), fetches = [];
  let hidden = false, timerId = 0;
  class FakeWorker {
    constructor() { this.requests = []; this.terminated = 0; workers.push(this); }
    // 记录 transfer 并像结构化克隆一样真的 detach，确保断言能看到「所有权已转移」
    postMessage(data, transfer) {
      this.requests.push({ ...data, transfer });
      for (const b of transfer || []) { try { structuredClone(b, { transfer: [b] }); } catch {} }
    }
    terminate() { this.terminated++; }
    reply(value, id = this.requests.at(-1)?.id) { this.onmessage?.({ data: { id, value } }); }
  }
  class FakeObserver {
    constructor(fn) { this.fn = fn; }
    observe() { observers.add(this); }
    disconnect() { observers.delete(this); }
  }
  // 只实现 vwSheet 实际查询的几个节点：不模拟 HTML 解析，直接按类名返回可观测的假节点。
  const fake = (className = "") => {
    const classes = new Set(className.split(/\s+/).filter(Boolean)), listeners = new Map();
    return {
      className, classList: { contains: c => classes.has(c), add: c => classes.add(c), remove: c => classes.delete(c) },
      innerHTML: "", textContent: "", dataset: {}, hidden: false, disabled: false, listeners,
      addEventListener(type, fn) { const list = listeners.get(type) || []; list.push(fn); listeners.set(type, list); },
      querySelector: () => null, querySelectorAll: () => [],
    };
  };
  const box = fake(), sheetEl = fake(), tabsEl = fake(), wrapEl = fake(), cellbarEl = fake(), tbody = fake(), info = fake();
  let boxHtml = "", wrapHtml = "", moreRemoved = false;
  const more = { disabled: false, textContent: "", remove() { moreRemoved = true; } };
  Object.defineProperty(box, "innerHTML", { get: () => boxHtml, set: v => { boxHtml = v; } });
  Object.defineProperty(wrapEl, "innerHTML", { get: () => wrapHtml, set: v => { wrapHtml = v; } });
  tbody.html = ""; tbody.insertAdjacentHTML = (where, html) => { assert.equal(where, "beforeend"); tbody.html += html; };
  box.querySelector = sel => sel === ".vw-sheet" ? sheetEl : null;
  sheetEl.querySelector = sel => sel === ".vw-tabs" ? tabsEl : sel === ".vw-grid-wrap" ? wrapEl : sel === ".vw-cellbar" ? cellbarEl : null;
  wrapEl.querySelector = sel => sel === ".vw-more" ? (wrapHtml.includes("vw-more") ? more : null) : sel === ".vw-grid tbody" ? tbody : null;
  const VW = { gen: 1, path: "/synthetic.xlsx", size: 8 }, viewerEl = { classList: { contains: () => hidden } };
  const ctx = { VW, viewerEl, Worker: FakeWorker, MutationObserver: FakeObserver, AbortController, DOMException, console,
    $: id => id === "vw-body" ? box : id === "vw-info" ? info : fake(), t: (x, v = {}) => x.replace(/\{(\w+)\}/g, (m, k) => v[k] ?? m), esc: x => x, shareIco: () => "", vwActs() {}, VW_OFFICE_MAX: 32 * 1024 * 1024,
    fmtSize: n => "size:" + n,
    setTimeout: fn => { const id = ++timerId; jobs.set(id, fn); return id; }, clearTimeout: id => jobs.delete(id) };
  vm.createContext(ctx);
  const begin = office.indexOf("  // 领一个号："), sheet = office.indexOf("  // zipExpandsTooMuch"), end = office.indexOf("  // ppt / doc / …");
  const prefix = office.slice(begin, office.indexOf("  // 文档里的东西", begin));
  const code = office.slice(sheet, end);
  vm.runInContext(prefix + code + "\nthis.api = { vwSheet, closeViewerSheet, sheetSession };", ctx);
  ctx.vwFetchBuf = (_max, signal) => new Promise((resolve, reject) => {
    const item = { resolve, reject, signal }; fetches.push(item);
    signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  });
  return {
    VW, workers, jobs, observers, fetches, open: ctx.api.vwSheet, box, sheet: sheetEl, tabs: tabsEl, wrap: wrapEl, cellbar: cellbarEl, info, tbody, more,
    get moreRemoved() { return moreRemoved; },
    hide(notify = false) { hidden = true; if (notify) for (const o of [...observers]) o.fn(); },
    show() { hidden = false; },
    owner() { return VW.sheet; },
    replace() { const s = ctx.api.sheetSession(); VW.sheet = s; return s; },
    close: ctx.api.closeViewerSheet,
  };
}

test("directly hidden viewer after fetch stops owned worker instead of silently returning", async () => {
  const f = fixture(), p = f.open(), s = f.owner(), w = f.workers[0];
  assert.ok(f.fetches[0], f.box.innerHTML);
  f.hide(); f.fetches[0].resolve(new ArrayBuffer(8)); await p;
  assert.equal(w.terminated, 1); assert.equal(s.dead, true); assert.equal(f.VW.sheet, null);
  assert.equal(f.jobs.size, 0); assert.equal(w.requests.length, 0); assert.equal(f.observers.size, 0);
});

test("directly hidden viewer before delayed load reply releases workbook and has no timers", async () => {
  const f = fixture(), p = f.open(), s = f.owner(), w = f.workers[0];
  f.fetches[0].resolve(new ArrayBuffer(8)); await settle();
  assert.equal(w.requests[0].op, "load");
  f.hide(); w.reply({ names: ["Visible"] }); await p;
  assert.equal(w.terminated, 1); assert.equal(s.dead, true); assert.equal(f.VW.sheet, null);
  assert.equal(f.jobs.size, 0); assert.equal(f.observers.size, 0);
});

test("hidden viewer observer aborts fetch immediately and leaves no live worker", async () => {
  const f = fixture(), p = f.open(), s = f.owner(), w = f.workers[0];
  f.hide(true); await p;
  assert.equal(w.terminated, 1); assert.equal(s.signal.aborted, true); assert.equal(f.VW.sheet, null);
  assert.equal(f.jobs.size, 0); assert.equal(f.observers.size, 0);
});

test("hidden viewer observer rejects pending load; captured delayed reply cannot resurrect session", async () => {
  const f = fixture(), p = f.open(), s = f.owner(), w = f.workers[0];
  f.fetches[0].resolve(new ArrayBuffer(8)); await settle(); const late = w.onmessage;
  f.hide(true); await p;
  late({ data: { id: 1, value: { names: ["stale"] } } }); await settle();
  assert.equal(w.terminated, 1); assert.equal(s.dead, true); assert.equal(f.VW.sheet, null);
  assert.equal(f.jobs.size, 0); assert.equal(f.observers.size, 0);
});

test("hidden class observer also releases an idle parsed session without waiting for another response", () => {
  const f = fixture(), s = f.replace(), w = f.workers[0];
  f.hide(true);
  assert.equal(w.terminated, 1); assert.equal(s.dead, true); assert.equal(f.VW.sheet, null);
  assert.equal(f.jobs.size, 0); assert.equal(f.observers.size, 0);
});

test("表格成功加载：首屏分页、more 和单元格详情都写入页面", async () => {
  const f = fixture(), p = f.open(), s = f.owner(), w = f.workers[0];
  const ab = new ArrayBuffer(8);
  f.fetches[0].resolve(ab); await settle();
  assert.equal(w.requests[0].op, "load");
  assert.ok(w.requests[0].transfer, "load transfers the workbook buffer to the worker");
  assert.equal(w.requests[0].transfer[0], ab);
  assert.equal(ab.byteLength, 0, "the transferred buffer is detached from the page");
  w.reply({ names: ["Visible", "Other"] }); await settle();
  assert.equal(s.dead, false); assert.equal(f.VW.sheet, s);
  assert.match(f.box.innerHTML, /class="vw-sheet"/);
  assert.deepEqual([...f.VW.sheets], ["Visible", "Other"]);

  // 首屏分页：名字回来以后 vwSheet 还要等第一页；回完这页 open() 才结束
  const pageOne = '<tr data-r="0"><td data-c="0" data-a="A1">A1</td></tr>';
  assert.equal(w.requests.at(-1).op, "page"); assert.equal(w.requests.at(-1).from, null);
  w.reply({ html: pageOne, header: "<thead><tr><th>A</th></tr></thead>", next: 2, done: false, rows: 10, cols: 2, range: "A1:B10" }); await p;
  assert.match(f.wrap.innerHTML, /<table class="vw-grid">/);
  assert.match(f.wrap.innerHTML, new RegExp(pageOne.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(f.wrap.innerHTML, /class="[^"]*vw-more/, "a more-rows button exists while the sheet is not done");
  assert.equal(f.more.disabled, false);
  assert.equal(f.info.textContent, "size:8 · Visible · A1:B10");

  // 点「再显示」走生产代码注册在 .vw-grid-wrap 上的处理器：从 next 继续取，追加到 tbody
  const click = f.wrap.listeners.get("click")[0];
  assert.equal(typeof click, "function");
  await click({ target: { closest: sel => sel === ".vw-more" ? f.more : null } });
  assert.equal(w.requests.at(-1).op, "page"); assert.equal(w.requests.at(-1).from, 2);
  assert.equal(f.more.disabled, true);
  w.reply({ html: '<tr data-r="1"><td data-c="1" data-a="B2">B2</td></tr>', header: "<thead><tr><th>A</th></tr></thead>", next: 3, done: true, rows: 10, cols: 2, range: "A1:B10" }); await settle();
  assert.match(f.tbody.html, /data-a="B2"/);
  assert.equal(f.moreRemoved, true); assert.equal(f.VW.sheetMore, null);

  // 点单元格：详情写入 cellbar
  const td = { dataset: { a: "B2" }, classList: { add() {}, remove() {} }, closest: sel => sel === "td[data-c]" ? td : null };
  const cellDone = click({ target: td });
  assert.equal(w.requests.at(-1).op, "cell"); assert.equal(w.requests.at(-1).addr, "B2");
  w.reply({ addr: "B2", text: "42", formula: "40+2" }); await cellDone; await settle();
  assert.equal(f.cellbar.textContent, "B2  42   =40+2");
  assert.equal(f.jobs.size, 0);
  f.close(); assert.equal(w.terminated, 1);
});

test("saved active sheet is opened first; invalid index falls back to the first visible sheet", async () => {
  for (const [active, want] of [[1, 1], [2, 0]]) {
    const f = fixture(), p = f.open(), w = f.workers[0];
    f.fetches[0].resolve(new ArrayBuffer(8)); await settle();
    w.reply({ names: ["First", "Second"], active }); await settle();
    assert.equal(w.requests.at(-1).op, "page");
    assert.equal(w.requests.at(-1).sheet, want);
    w.reply({ empty: true }); await p;
    f.close();
  }
});

test("invalid old load owner is terminated but never clears or stops the later session", async () => {
  const f = fixture(), old = f.open(), oldSession = f.owner(), w = f.workers[0];
  f.fetches[0].resolve(new ArrayBuffer(8)); await settle();
  const current = f.replace(), newer = f.workers[1];
  w.reply({ names: ["old"] }); await old;
  assert.equal(w.terminated, 1); assert.equal(oldSession.dead, true);
  assert.equal(f.VW.sheet, current); assert.equal(newer.terminated, 0); assert.equal(current.dead, false);
  f.close(); assert.equal(f.jobs.size, 0); assert.equal(f.observers.size, 0);
});
