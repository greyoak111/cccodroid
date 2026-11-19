import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.resolve(here, "../web");
const context = { console, Uint8Array, ArrayBuffer, DataView, TextDecoder, TextEncoder };
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(web, "office/xlsx.full.min.js"), "utf8"), context);
vm.runInContext(fs.readFileSync(path.join(web, "office/sheet-model.js"), "utf8"), context);
const X = context.XLSX, M = context.SheetPreview;
function workbook(rows = 10, cols = 10) {
  const wb = X.utils.book_new(), data = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => `R${r}C${c}`));
  X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(data), "Visible");
  return wb;
}
function worker() {
  const w = new Worker(new URL("./fixtures/office-worker-node.mjs", import.meta.url), { workerData: { web } });
  let seq = 0;
  const pending = new Map();
  w.on("message", msg => { const p = pending.get(msg.id); if (!p) return; pending.delete(msg.id); msg.error ? p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code })) : p.resolve(msg.value); });
  w.on("error", e => { for (const p of pending.values()) p.reject(e); pending.clear(); });
  return { w, ask(op, args = {}, transfer = []) { const id = ++seq; return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); w.postMessage({ id, op, ...args }, transfer); }); } };
}
const asArrayBuffer = wb => { const out = X.write(wb, { type: "array", bookType: "xlsx", compression: true }); return Uint8Array.from(new Uint8Array(out)).buffer; };
// worker 线程卡死时不能让测试或 CI 一直等：基于 setTimeout 的拒绝超时
function within(promise, ms, label) {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + " timed out after " + ms + "ms")), ms); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

test("pages are bounded by cells, rows and HTML, while all requested visible content stays available", () => {
  const wb = workbook(100, 200), m = M.create(wb, X);
  let from = null, pages = 0, rows = 0;
  do {
    const p = m.page(0, from); pages++;
    assert.ok((p.html.match(/<td /g) || []).length <= 1200);
    assert.ok(p.html.length <= 256 * 1024);
    rows += (p.html.match(/<tr /g) || []).length;
    from = p.next; if (p.done) break;
  } while (pages < 100);
  assert.equal(rows, 100);
  assert.ok(pages > 1);
  const narrow = M.create(workbook(5000, 1), X).page(0, null);
  assert.equal((narrow.html.match(/<tr /g) || []).length, 120);
});

test("hidden sheets, hidden merge anchors, hidden rows/columns, widths, and formulas retain their semantics", () => {
  const wb = workbook(4, 4), ws = wb.Sheets.Visible;
  X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([["secret"]]), "Hidden");
  wb.Workbook = { Sheets: [{ Hidden: 0 }, { Hidden: 1 }] };
  ws.A1 = { t: "s", v: "<merge>&" }; ws.B2 = { t: "n", v: 2, f: "1+1" };
  ws["!rows"] = [{ hidden: true }]; ws["!cols"] = [{ hidden: true }, { wpx: 99 }];
  ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 1, c: 1 } }];
  const m = M.create(wb, X), p = m.page(0, null);
  assert.deepEqual([...m.names], ["Visible"]);
  assert.ok(!p.header.includes("<th>A</th>")); assert.ok(p.header.includes("width:99px"));
  assert.ok(!p.html.includes('data-r="0"')); assert.ok(p.html.includes('data-a="A1" rowspan="1" colspan="1"'));
  assert.ok(p.html.includes("&lt;merge&gt;&amp;"));
  assert.equal(m.cell(0, "B2").formula, "1+1");
  assert.equal(m.cell(0, "A1").text, "<merge>&");
});

test("sheet indexes refer to visible tabs, with the original all-hidden fallback", () => {
  const wb = workbook(1, 1);
  X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([["second value"]]), "Second");
  wb.Workbook = { Sheets: [{ Hidden: 1 }, { Hidden: 0 }] };
  let m = M.create(wb, X);
  assert.deepEqual([...m.names], ["Second"]);
  assert.equal(m.cell(0, "A1").text, "second value");
  wb.Workbook.Sheets[1].Hidden = 2;
  m = M.create(wb, X);
  assert.deepEqual([...m.names], ["Visible", "Second"]);
  assert.equal(m.cell(1, "A1").text, "second value");
});

test("text-heavy pages obey the HTML budget and preserve every value across continuation", () => {
  const wb = workbook(10, 1), text = "&".repeat(12000);
  for (let r = 1; r <= 10; r++) wb.Sheets.Visible["A" + r] = { t: "s", v: text };
  const m = M.create(wb, X);
  let from = null, rows = 0, characters = 0, pages = 0;
  for (;;) {
    const p = m.page(0, from);
    assert.ok(p.html.length <= 256 * 1024);
    rows += (p.html.match(/<tr /g) || []).length;
    characters += (p.html.match(/&amp;/g) || []).length;
    pages++;
    if (p.done) break;
    assert.ok(p.next > (from ?? -1)); from = p.next;
    assert.ok(pages < 20);
  }
  assert.ok(pages > 1);
  assert.equal(rows, 10); assert.equal(characters, 120000);
  assert.equal(m.cell(0, "A10").text, text);
});

test("empty and malformed sheets report status without leaking a decoder exception", () => {
  const wb = workbook(1, 1);
  delete wb.Sheets.Visible["!ref"];
  assert.equal(M.create(wb, X).page(0, null).empty, true);
  wb.Sheets.Visible["!ref"] = "A1:B2";
  const decoder = { ...X, utils: { ...X.utils, decode_range() { throw new Error("invalid range"); } } };
  assert.equal(M.create(wb, decoder).page(0, null).badRange, true);
  assert.throws(() => M.create(wb, decoder).cell(0, "A1"), /sheet cell/);
});

test("sheet names and individual formula details cannot create unbounded responses", () => {
  const wb = workbook(1, 1);
  wb.Sheets.Visible.A1.f = "x".repeat(256 * 1024);
  assert.throws(() => M.create(wb, X).cell(0, "A1"), e => e.code === "tooBig");
  assert.throws(() => M.create({ SheetNames: Array.from({ length: 1001 }, (_, n) => "s" + n), Sheets: {} }, X), e => e.code === "tooBig");
  assert.throws(() => M.create({ SheetNames: ["s".repeat(65537)], Sheets: {} }, X), e => e.code === "tooBig");
});

test("1904 dates and time normalization match original formatting without truncating formulas", () => {
  const wb = workbook(1, 2); wb.Workbook = { WBProps: { date1904: true } };
  wb.Sheets.Visible.A1 = { t: "n", v: 0, w: "1/1/04", z: "m/d/yy" };
  wb.Sheets.Visible.B1 = { t: "n", v: 1.5, w: "1/2/04 12:00", z: "m/d/yy h:mm", f: "SUM(A1,1.5)" };
  const m = M.create(wb, X);
  assert.equal(m.cell(0, "A1").text, "1904-01-01");
  assert.equal(m.cell(0, "B1").text, "1904-01-02 12:00");
  assert.equal(m.cell(0, "B1").formula, "SUM(A1,1.5)");
});

test("sparse oversized ranges and hostile merges stay in the original 5000 by 200 display window", () => {
  const wb = X.utils.book_new(), ws = { A1: { t: "s", v: "first" }, XFD1048576: { t: "s", v: "last" }, "!ref": "A1:XFD1048576", "!merges": [{ s: { r: 0, c: 0 }, e: { r: 1048575, c: 16383 } }] };
  X.utils.book_append_sheet(wb, ws, "Sparse");
  const m = M.create(wb, X), p = m.page(0, null);
  assert.equal(p.rows, 5000); assert.equal(p.cols, 200); assert.equal(p.cut, true);
  assert.ok(p.html.length <= 512 * 1024); assert.equal(p.done, false);
  assert.ok(p.html.includes('rowspan="5000" colspan="200"'));
  assert.throws(() => m.cell(0, "XFD1048576"), /range/);
  ws["!ref"] = "XFD1048576:A1";
  assert.equal(M.create(wb, X).page(0, null).badRange, true);
});

test("oversized text is refused rather than silently truncating it", () => {
  const wb = workbook(1, 1); wb.Sheets.Visible.A1.v = "x".repeat(512 * 1024 + 1);
  assert.throws(() => M.create(wb, X).page(0, null), e => e.code === "tooBig");
});

test("real XLSX library stays in worker and replies only with names/page/cell, for 20k and 100k cells", async () => {
  for (const cells of [20000, 100000]) {
    const wb = workbook(cells / 100, 100), ab = asArrayBuffer(wb), w = worker();
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1), start = performance.now();
    try {
      const loaded = await w.ask("load", { buffer: ab }, [ab]); clearInterval(timer);
      assert.equal(ab.byteLength, 0, "input transfers ownership");
      assert.deepEqual(Object.keys(loaded), ["names", "active"]); assert.deepEqual(loaded.names, ["Visible"]); assert.equal(loaded.active, 0);
      const p = await w.ask("page", { sheet: 0, from: null });
      assert.ok(p.html.includes("R0C0")); assert.ok((p.html.match(/<td /g) || []).length <= 1200);
      const cell = await w.ask("cell", { sheet: 0, addr: "CV200" });
      assert.equal(cell.text, "R199C99");
      assert.ok(ticks > 0, "main event loop runs while worker parses");
      console.log(JSON.stringify({ cells, workerLoadMs: performance.now() - start, mainTimerTicks: ticks, firstPageChars: p.html.length }));
    } finally { clearInterval(timer); await w.w.terminate(); }
  }
});

test("worker invalid input errors do not clone workbooks or expose arbitrary operations", async () => {
  const w = worker();
  try {
    await assert.rejects(w.ask("page", { sheet: 0 }), /ready/);
    await assert.rejects(w.ask("load", { buffer: new ArrayBuffer(33 * 1024 * 1024) }), /input/);
    const brokenZip = new Uint8Array(24); brokenZip.set([0x50, 0x4b, 1]);
    await assert.rejects(w.ask("load", { buffer: brokenZip.buffer }), e => e.code === "tooBig");
    await w.ask("load", { buffer: asArrayBuffer(workbook()) });
    await assert.rejects(w.ask("execute", { source: "arbitrary" }), /operation/);
    await assert.rejects(w.ask("page", { sheet: -1 }), /index/);
  } finally { await w.w.terminate(); }
});

test("ZIP budget rejects truncation, oversized entries, cumulative expansion and ZIP64 declarations", () => {
  assert.equal(M.zipExpandsTooMuch(new Uint8Array([0x50, 0x4b, 1]).buffer), true);
  const central = sizes => {
    const ab = new ArrayBuffer(sizes.length * 46 + 22), dv = new DataView(ab);
    for (let n = 0; n < sizes.length; n++) { dv.setUint32(n * 46, 0x02014b50, true); dv.setUint32(n * 46 + 24, sizes[n], true); }
    const end = sizes.length * 46; dv.setUint32(end, 0x06054b50, true); dv.setUint16(end + 10, sizes.length, true); dv.setUint32(end + 16, 0, true);
    new Uint8Array(ab).set([0x50, 0x4b]);
    return ab;
  };
  assert.equal(M.zipExpandsTooMuch(central([128 * 1024 * 1024 + 1])), true);
  assert.equal(M.zipExpandsTooMuch(central([128 * 1024 * 1024, 128 * 1024 * 1024, 1])), true);
  const zip64 = central([]), dv = new DataView(zip64); dv.setUint16(10, 0xffff, true);
  assert.equal(M.zipExpandsTooMuch(zip64), true);
});

test("二十次 load/terminate 循环后没有活着的 worker", async () => {
  for (let i = 0; i < 20; i++) {
    const w = worker();
    try {
      await within(w.ask("load", { buffer: asArrayBuffer(workbook(1, 1)) }), 10000, "load " + i);
      assert.equal(await within(w.w.terminate(), 10000, "terminate " + i), 1);
    } finally {
      await w.w.terminate().catch(() => {});   // 断言失败 / 超时也要收掉这一轮的 worker
    }
  }
});
