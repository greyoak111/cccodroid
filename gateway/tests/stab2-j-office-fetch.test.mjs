// 第二份稳定性报告 BUG-UIFS-006（第一轮 FIND-024 只修了「打开时已知大小」这一半）：
// vwFetchBuf 原来先 fetch → arrayBuffer 把整份读进内存，再比 max；响应自己声明的 Content-Length
// 和流读取期间的累计字节都没受限。这里用响应 / reader 桩记录调用顺序，不分配大缓冲：
// 已知或声明超限要预先拒绝，流式累计超限要取消读取，等于 max 的对照照常通过。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const src17 = fs.readFileSync(new URL("../web/app/17-office.js", import.meta.url), "utf8");
const take = (src, start, end) => {
  const a = src.indexOf(start);
  assert.ok(a >= 0, "找不到 " + start);
  const b = src.indexOf(end, a);
  assert.ok(b > a, "找不到 " + end);
  return src.slice(a, b);
};

function load() {
  const code = `
const VW = { path: "/w/f.docx", size: 0 };
let apiSize = 0;
const api = () => Promise.resolve({ size: apiSize });
const t = (s, v) => String(s).replace(/\\{(\\w+)\\}/g, (_, k) => String(v && v[k] !== undefined ? v[k] : ""));
const fmtSize = (n) => n + "B";
const fileUrl = (p) => "/api/file?path=" + encodeURIComponent(p);
${take(src17, "  const VW_OFFICE_MAX = 32 * 1024 * 1024;", "  // 领一个号：")}
globalThis.__h = { vwFetchBuf, VW, fetchCalls: globalThis.fetchCalls, setApiSize: (n) => { apiSize = n; }, setFetch: (f) => { __fetchImpl = f; } };
`;
  const ctx = { fetchCalls: [] };
  ctx.__fetchImpl = () => { throw new Error("没有设置 fetch 桩"); };
  // fetch 在本段源码里按全局名调用：给 vm 一个记录调用的包装
  vm.runInNewContext(
    "const fetch = (u) => { globalThis.fetchCalls.push(u); return globalThis.__fetchImpl(u); };\n" + code,
    ctx,
  );
  return ctx.__h;
}

const readerOf = (chunks) => {
  let i = 0;
  const state = { cancelled: 0, released: 0 };
  const reader = {
    read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }),
    cancel: async () => { state.cancelled++; },
    releaseLock: () => { state.released++; },
  };
  return { reader, state };
};

const resp = ({ ok = true, status = 200, length, body, arrayBuffer } = {}) => {
  const state = { arrayBuffer: 0, bodyCancel: 0 };
  const r = {
    ok, status,
    headers: { get: (k) => (String(k).toLowerCase() === "content-length" && length != null ? String(length) : null) },
    arrayBuffer: async () => { state.arrayBuffer++; return arrayBuffer; },
  };
  if (body !== undefined) {
    r.body = body;
    if (body && typeof body.cancel === "function") {
      const orig = body.cancel.bind(body);
      body.cancel = async () => { state.bodyCancel++; return orig(); };
    }
  }
  return { r, state };
};

test("BUG-UIFS-006 打开时已知超限：不 fetch（第一轮 FIND-024 保留）", async () => {
  const h = load();
  h.VW.size = 33554433;
  await assert.rejects(() => h.vwFetchBuf(32 * 1024 * 1024), /文件太大/);
  assert.deepEqual(h.fetchCalls, []);
});

test("BUG-UIFS-006 没带大小：先 stat，超限就不 fetch", async () => {
  const h = load();
  h.VW.size = 0; h.setApiSize(33554433);
  await assert.rejects(() => h.vwFetchBuf(32 * 1024 * 1024), /文件太大/);
  assert.deepEqual(h.fetchCalls, [], "stat 已经说超了，别再去读");
});

test("BUG-UIFS-006 响应声明的 Content-Length 超限：读完之前就取消", async () => {
  const h = load();
  const body = { cancel: async () => {} };
  const { r, state } = resp({ length: 40, body });
  h.setFetch(() => Promise.resolve(r));
  await assert.rejects(() => h.vwFetchBuf(10), /文件太大/);
  assert.equal(state.arrayBuffer, 0, "不能先 arrayBuffer 再判");
  assert.equal(state.bodyCancel, 1, "超限要把响应体取消掉，别让它继续占着");
});

test("BUG-UIFS-006 流读取累计超限：中途取消，不凑满整份", async () => {
  const h = load();
  const { reader, state } = readerOf([new Uint8Array(6), new Uint8Array(6)]);
  const { r, state: rs } = resp({ body: { getReader: () => reader } });
  h.setFetch(() => Promise.resolve(r));
  await assert.rejects(() => h.vwFetchBuf(10), /文件太大/);
  assert.equal(state.cancelled, 1, "累计过线要 reader.cancel");
  assert.equal(rs.arrayBuffer, 0, "不能退回 arrayBuffer");
});

test("BUG-UIFS-006 等于上限的对照照常通过；流式拼回完整字节", async () => {
  const h = load();
  const { reader } = readerOf([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])]);
  const { r } = resp({ length: 5, body: { getReader: () => reader } });
  h.setFetch(() => Promise.resolve(r));
  const b = await h.vwFetchBuf(5);
  assert.equal(b.byteLength, 5);
  assert.deepEqual([...new Uint8Array(b)], [1, 2, 3, 4, 5]);
});

test("BUG-UIFS-006 没有流接口（老 WebView）：退回 arrayBuffer，读回来后仍兜底判大小", async () => {
  const h = load();
  const small = new Uint8Array([7, 8]).buffer;
  h.setFetch(() => Promise.resolve(resp({ arrayBuffer: small }).r));
  assert.equal((await h.vwFetchBuf(10)).byteLength, 2);
  const big = new Uint8Array(12).buffer;
  h.setFetch(() => Promise.resolve(resp({ arrayBuffer: big }).r));
  await assert.rejects(() => h.vwFetchBuf(10), /文件太大/);
});
