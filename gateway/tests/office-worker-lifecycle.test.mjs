import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.resolve(here, "../web");
const office = fs.readFileSync(path.join(web, "app/17-office.js"), "utf8");
const viewer = fs.readFileSync(path.join(web, "app/16-viewer-git.js"), "utf8");
function fixture() {
  const workers = [], jobs = new Map(), fails = [];
  let seq = 0, hidden = false;
  class FakeWorker {
    constructor(url) { this.url = url; this.requests = []; this.terminated = 0; workers.push(this); }
    // 真实 Worker 会按 transfer 列表转移所有权：这里用 structuredClone 真 detach，才能断言 byteLength 归零
    postMessage(data, transfer) {
      this.requests.push({ data, transfer });
      for (const b of transfer || []) { try { structuredClone(b, { transfer: [b] }); } catch {} }
    }
    terminate() { this.terminated++; }
    reply(value, id = this.requests.at(-1).data.id) { this.onmessage?.({ data: { id, value } }); }
  }
  const VW = {};
  const viewerEl = { classList: { contains: () => hidden } };
  const ctx = { VW, Worker: FakeWorker, AbortController, DOMException, console,
    viewerEl, MutationObserver: class { observe() {} disconnect() {} },
    t: x => x, setTimeout: f => { const id = ++seq; jobs.set(id, f); return id; }, clearTimeout: id => jobs.delete(id),
    vwSheetFail: (s, e) => { fails.push(e.message); ctx.closeViewerSheet(); } };
  vm.createContext(ctx);
  const start = office.indexOf("  function closeViewerSheet("), end = office.indexOf("  async function vwSheet()", start);
  vm.runInContext(office.slice(start, end) + "\nthis.api = { closeViewerSheet, sheetSession }; this.closeViewerSheet = closeViewerSheet;", ctx);
  // vwTake 是「换文档 / 切版式」的统一入口：单独取出来在同一 context 里跑，closeViewerSheet 沿用生产实现
  const takeAt = office.indexOf("  const vwTake = () =>");
  assert.ok(takeAt >= 0, "vwTake source exists");
  vm.runInContext(office.slice(takeAt, office.indexOf("\n", takeAt)) + "\nthis.api.vwTake = vwTake;", ctx);
  const session = () => { const s = ctx.api.sheetSession(); VW.sheet = s; return s; };
  return { ctx, VW, workers, jobs, fails, viewerEl, session, close: ctx.api.closeViewerSheet, take: ctx.api.vwTake,
    hide() { hidden = true; }, show() { hidden = false; } };
}

test("terminate aborts file reading, rejects pending requests, clears all timers and ignores captured late callbacks", async () => {
  const f = fixture(), s = f.session(), w = f.workers[0];
  const pending = s.ask("load", { buffer: new ArrayBuffer(8) });
  const late = w.onmessage;
  assert.equal(f.jobs.size, 1);
  f.close();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(w.terminated, 1); assert.equal(s.signal.aborted, true); assert.equal(f.jobs.size, 0);
  assert.equal(f.VW.sheet, null); assert.equal(f.VW.sheetMore, null); assert.equal(f.VW.sheets, null);
  late({ data: { id: 1, value: { names: ["stale"] } } });
  await assert.rejects(s.ask("page", { sheet: 0 }), { name: "AbortError" });
  f.close(); assert.equal(w.terminated, 1);
});

test("load 传递的 workbook 缓冲区在页面侧已经 detach", async () => {
  const f = fixture(), s = f.session(), w = f.workers[0];
  const ab = new ArrayBuffer(8), p = s.ask("load", { buffer: ab }, [ab]);
  assert.ok(w.requests[0].transfer, "the transfer list reaches the worker");
  assert.equal(w.requests[0].transfer[0], ab);
  assert.equal(ab.byteLength, 0, "the transferred buffer is detached from the page");
  f.close();
  await assert.rejects(p, { name: "AbortError" });
  assert.equal(w.terminated, 1); assert.equal(s.dead, true); assert.equal(f.VW.sheet, null);
});

test("onmessageerror 调用保存的 handler：会话与定时器都被释放", () => {
  const f = fixture(), s = f.session(), w = f.workers[0];
  w.onmessageerror({});                       // 调生产代码保存的 handler，不是测试里另写的逻辑
  assert.equal(w.terminated, 1); assert.equal(s.dead, true); assert.equal(f.VW.sheet, null);
  assert.deepEqual(f.fails, ["读取失败"]); assert.equal(f.jobs.size, 0);
});

test("vwTake / closeViewerSheet 入口真实释放 sheet session", () => {
  const f = fixture(), s = f.session(), w = f.workers[0];
  const still = f.take();                     // 换文档 / 切版式入口
  assert.equal(w.terminated, 1); assert.equal(s.dead, true); assert.equal(f.VW.sheet, null);
  assert.equal(still(), true, "unchanged viewer keeps the new take valid");
  f.hide(); assert.equal(still(), false, "a hidden viewer invalidates the returned guard");
  f.show();
  const s2 = f.session(), w2 = f.workers[1];
  f.close(s2);                                // 关闭入口
  assert.equal(w2.terminated, 1); assert.equal(s2.dead, true); assert.equal(f.VW.sheet, null);
  assert.equal(f.jobs.size, 0);
});

test("rapid sheet and cell requests bound waiting closures and accept only the latest matching response", async () => {
  const f = fixture(), s = f.session(), w = f.workers[0];
  const loading = s.ask("load", {}); w.reply({ names: ["A", "B"] }); await loading;
  const a = s.ask("page", { sheet: 0 }), b = s.ask("page", { sheet: 1 });
  await assert.rejects(a, { name: "AbortError" }); assert.equal(f.jobs.size, 1);
  w.reply({ html: "old" }, 2); assert.equal(f.jobs.size, 1);
  w.reply({ html: "new" }, 3); assert.equal((await b).html, "new");
  const c = s.ask("cell", { sheet: 1, addr: "A1" }), d = s.ask("cell", { sheet: 1, addr: "B1" });
  await assert.rejects(c, { name: "AbortError" });
  w.reply({ text: "B" }); assert.equal((await d).text, "B"); assert.equal(f.jobs.size, 0);
  f.close();
});

test("worker failure during fetch is not mistaken for user cancellation, and idle errors discard the workbook", async () => {
  const f = fixture(), s = f.session(), w = f.workers[0];
  w.onerror({ preventDefault() {} });
  assert.equal(w.terminated, 1); assert.deepEqual(f.fails, ["读取失败"]); assert.equal(f.VW.sheet, null);
  await assert.rejects(s.ask("load", {}), /读取失败/);
});

test("stat or download timeout also aborts and releases an otherwise idle worker", () => {
  const f = fixture(), s = f.session(), w = f.workers[0];
  assert.equal(f.jobs.size, 1); [...f.jobs.values()][0]();
  assert.equal(s.signal.aborted, true); assert.equal(w.terminated, 1); assert.equal(f.VW.sheet, null);
  assert.deepEqual(f.fails, ["读取失败"]); assert.equal(f.jobs.size, 0);
});

test("request timeout tears down the worker and every pending promise", async () => {
  const f = fixture(), s = f.session(), w = f.workers[0];
  const p = s.ask("load", {});
  [...f.jobs.values()][0]();
  await assert.rejects(p, /读取失败/);
  assert.equal(w.terminated, 1); assert.equal(f.jobs.size, 0);
});

test("Worker creation failure propagates; no synchronous XLSX fallback exists", () => {
  const f = fixture(); f.ctx.Worker = class { constructor() { throw new Error("blocked by policy"); } };
  assert.throws(f.session, /blocked by policy/);
  assert.ok(!office.includes("window.XLSX"));
  assert.ok(!office.includes('loadScript("/office/xlsx.full.min.js")'));
});

test("fetch uses captured path/size and signal, and does not continue from an aborted stat into another file", async () => {
  let release; const calls = [], ctl = new AbortController();
  const ctx = { VW: { path: "/fixture/a.xlsx", size: 0 }, t: x => x, fmtSize: x => x, fileUrl: x => x, DOMException,
    api: (url, opts) => { calls.push({ url, signal: opts.signal }); return new Promise(r => release = r); },
    fetch: (url, opts) => { calls.push({ url, signal: opts.signal }); throw Error("should not fetch"); } };
  const start = office.indexOf("  async function vwFetchBuf("), end = office.indexOf("  // 领一个号：", start);
  vm.createContext(ctx); vm.runInContext(office.slice(start, end) + "\nthis.f = vwFetchBuf;", ctx);
  const p = ctx.f(100, ctl.signal); ctx.VW.path = "/fixture/b.xlsx"; ctl.abort(); release({ size: 1 });
  await assert.rejects(p, { name: "AbortError" }); assert.equal(calls.length, 1); assert.ok(calls[0].url.includes("a.xlsx"));
  assert.equal(calls[0].signal, ctl.signal);
});

test("all document/layout/close entry points dispose of the sheet session", () => {
  assert.match(office, /const vwTake = \(\) => \{ closeViewerSheet\(\);/);
  assert.match(office, /VW\.gen = \(VW\.gen \|\| 0\) \+ 1;[^\n]*\n    closeViewerSheet\(\);/);
  // openViewer 依赖整个查看器 DOM / 网络 / 布局状态，没法在只抽 sheet session 的 fixture 里直接跑；
  // 这里把它对 closeViewerSheet 的调用锚定成相邻语句，行为侧由上面的 vwTake / closeViewerSheet 用例覆盖
  assert.match(viewer, /if \(VW\.dirty\) draftClear\(\);\n    closeViewerSheet\(\);\n    closeViewerPdf\(\);/);
  // 换页换代语句必须落在 vwSheetShow 函数体内，而不是任意位置出现的同名片段
  assert.match(office, /async function vwSheetShow\(i\) \{[\s\S]{0,400}?const gen = \+\+s\.pageGen; \+\+s\.cellGen;/);
});

test("one hundred session cycles release workers and promise timers", async () => {
  const f = fixture();
  for (let n = 0; n < 100; n++) {
    const s = f.session(), p = s.ask("page", { sheet: n });
    f.close(); await assert.rejects(p, { name: "AbortError" });
  }
  assert.equal(f.workers.length, 100); assert.ok(f.workers.every(w => w.terminated === 1)); assert.equal(f.jobs.size, 0);
});
