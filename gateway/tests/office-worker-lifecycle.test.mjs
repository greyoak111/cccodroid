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
  let seq = 0;
  class FakeWorker {
    constructor(url) { this.url = url; this.requests = []; this.terminated = 0; workers.push(this); }
    postMessage(data, transfer) { this.requests.push({ data, transfer }); }
    terminate() { this.terminated++; }
    reply(value, id = this.requests.at(-1).data.id) { this.onmessage?.({ data: { id, value } }); }
  }
  const VW = {};
  const ctx = { VW, Worker: FakeWorker, AbortController, DOMException, console,
    viewerEl: { classList: { contains: () => false } }, MutationObserver: class { observe() {} disconnect() {} },
    t: x => x, setTimeout: f => { const id = ++seq; jobs.set(id, f); return id; }, clearTimeout: id => jobs.delete(id),
    vwSheetFail: (s, e) => { fails.push(e.message); ctx.closeViewerSheet(); } };
  vm.createContext(ctx);
  const start = office.indexOf("  function closeViewerSheet("), end = office.indexOf("  async function vwSheet()", start);
  vm.runInContext(office.slice(start, end) + "\nthis.api = { closeViewerSheet, sheetSession }; this.closeViewerSheet = closeViewerSheet;", ctx);
  const session = () => { const s = ctx.api.sheetSession(); VW.sheet = s; return s; };
  return { ctx, VW, workers, jobs, fails, session, close: ctx.api.closeViewerSheet };
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
  assert.match(viewer, /if \(VW\.dirty\) draftClear\(\);\n    closeViewerSheet\(\);\n    closeViewerPdf\(\);/);
  assert.ok(office.includes('const gen = ++s.pageGen; ++s.cellGen;'));
});

test("one hundred session cycles release workers and promise timers", async () => {
  const f = fixture();
  for (let n = 0; n < 100; n++) {
    const s = f.session(), p = s.ask("page", { sheet: n });
    f.close(); await assert.rejects(p, { name: "AbortError" });
  }
  assert.equal(f.workers.length, 100); assert.ok(f.workers.every(w => w.terminated === 1)); assert.equal(f.jobs.size, 0);
});
