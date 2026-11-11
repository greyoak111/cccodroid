// 第二份稳定性报告 7.3 UIFS-007：保存响应已经过了 fetch 之后的 gen 检查，但 409 / 正常回执的 JSON 体
// 还要再 await 一次；这期间用户换到文件 B 的话，旧文件的冲突处理会拿 VW 当前状态去清稿 / 重新载入 B，
// 或者把旧文件的 mtime / size 写进 B。这里用可控的 json() 替身把这段窗口拉开，跑真的 vwSave。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const src16 = fs.readFileSync(new URL("../web/app/16-viewer-git.js", import.meta.url), "utf8");
const take = (src, start, end) => {
  const a = src.indexOf(start);
  assert.ok(a >= 0, "找不到 " + start);
  const b = src.indexOf(end, a);
  assert.ok(b > a, "找不到 " + end);
  return src.slice(a, b);
};

const later = () => {
  let ok, bad;
  const p = new Promise((r, j) => { ok = r; bad = j; });
  return { p, ok, bad };
};
const flush = () => new Promise((r) => setImmediate(r));

function load() {
  const code = `
const VW = { ready: true, mtime: 5, size: 100, saving: false, enc: "", path: "/w/A.txt", gen: 1,
  dirty: true, bom: false, eol: "", text: "A2" };
const toasts = [], confirms = [], clears = [], loads = [], fetchCalls = [];
const t = (s) => String(s);
const toast = (m) => toasts.push(m);
const vwText = () => VW.text;
const confirm = (m) => { confirms.push(m); return false; };
const draftClear = () => { clears.push(1); };
const vwLoadText = (m) => { loads.push(m); };
const vwInfo = () => {};
const vwRenderActs = () => {};
const vwGitCheck = () => {};
const $ = () => null;
const fetch = (u, o) => { fetchCalls.push(u); return __fetchImpl(u, o); };
${take(src16, "  async function vwSave(force) {", "  function vwImage() {")}
globalThis.__h = { vwSave, VW, toasts, confirms, clears, loads, fetchCalls,
  setFetch: (f) => { __fetchImpl = f; } };
`;
  const ctx = {};
  ctx.__fetchImpl = () => { throw new Error("没有设置 fetch 桩"); };
  vm.runInNewContext(code, ctx);
  return ctx.__h;
}

const switchToB = (h) => {
  Object.assign(h.VW, { path: "/w/B.txt", gen: 2, mtime: 7, size: 200, dirty: true, text: "B2" });
};

test("UIFS-007 正常回执的 JSON 体迟到期间换了文件：旧 mtime / size 不写到新文件上", async () => {
  const h = load();
  const late = later();
  h.setFetch(() => ({ ok: true, status: 200, json: () => late.p }));
  const p = h.vwSave(false);
  await flush();                 // fetch 已回，正在等 json()
  switchToB(h);
  late.ok({ mtime: 111, size: 222 });
  await p;
  assert.equal(h.VW.mtime, 7, "B 的 mtime 不能被 A 的回执盖掉");
  assert.equal(h.VW.size, 200, "B 的大小也不能被盖掉");
  assert.equal(h.VW.dirty, true, "A 存完了不代表 B 没有未保存改动");
  assert.ok(h.toasts.includes("已保存"), "A 确实存成功了，还是说一声");
});

test("UIFS-007 409 的 JSON 体迟到期间换了文件：不拿旧冲突去清新文件的稿 / 重新载入", async () => {
  const h = load();
  const late = later();
  h.setFetch(() => ({ ok: false, status: 409, json: () => late.p }));
  const p = h.vwSave(false);
  await flush();
  switchToB(h);
  late.ok({ error: "changed" });
  await p;
  assert.equal(h.confirms.length, 0, "旧文件的冲突框不能对着新文件弹");
  assert.equal(h.VW.dirty, true);
  assert.equal(h.loads.length, 0, "不能把 B 重新载入成 A 的内容");
  assert.equal(h.clears.length, 0, "不能清 B 的稿");
  assert.equal(h.VW.path, "/w/B.txt");
});

test("UIFS-007 没有换文件：正常回执照旧落 mtime / size、清未保存标记（回归）", async () => {
  const h = load();
  h.setFetch(() => ({ ok: true, status: 200, json: async () => ({ mtime: 111, size: 222 }) }));
  await h.vwSave(false);
  assert.equal(h.VW.mtime, 111);
  assert.equal(h.VW.size, 222);
  assert.equal(h.VW.dirty, false);
  assert.equal(h.clears.length, 1);
});

test("UIFS-007 没有换文件：409 选取消仍清稿并重新载入（回归）", async () => {
  const h = load();
  h.setFetch(() => ({ ok: false, status: 409, json: async () => ({ error: "changed" }) }));
  await h.vwSave(false);
  assert.equal(h.confirms.length, 1);
  assert.equal(h.VW.dirty, false);
  assert.equal(h.clears.length, 1);
  assert.deepEqual([...h.loads], ["edit"]);
});
