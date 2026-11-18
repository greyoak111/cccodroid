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
    postMessage(data) { this.requests.push(data); }
    terminate() { this.terminated++; }
    reply(value, id = this.requests.at(-1)?.id) { this.onmessage?.({ data: { id, value } }); }
  }
  class FakeObserver {
    constructor(fn) { this.fn = fn; }
    observe() { observers.add(this); }
    disconnect() { observers.delete(this); }
  }
  const box = { innerHTML: "", querySelector() { return null; } };
  const VW = { gen: 1, path: "/synthetic.xlsx", size: 8 }, viewerEl = { classList: { contains: () => hidden } };
  const ctx = { VW, viewerEl, Worker: FakeWorker, MutationObserver: FakeObserver, AbortController, DOMException, console,
    $: () => box, t: (x, v = {}) => x.replace(/\{(\w+)\}/g, (m, k) => v[k] ?? m), esc: x => x, shareIco: () => "", vwActs() {}, VW_OFFICE_MAX: 32 * 1024 * 1024,
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
    VW, workers, jobs, observers, fetches, open: ctx.api.vwSheet, box,
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

test("invalid old load owner is terminated but never clears or stops the later session", async () => {
  const f = fixture(), old = f.open(), oldSession = f.owner(), w = f.workers[0];
  f.fetches[0].resolve(new ArrayBuffer(8)); await settle();
  const current = f.replace(), newer = f.workers[1];
  w.reply({ names: ["old"] }); await old;
  assert.equal(w.terminated, 1); assert.equal(oldSession.dead, true);
  assert.equal(f.VW.sheet, current); assert.equal(newer.terminated, 0); assert.equal(current.dead, false);
  f.close(); assert.equal(f.jobs.size, 0); assert.equal(f.observers.size, 0);
});
