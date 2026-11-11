// 第二份稳定性报告 BUG-UIFS-002：attachPath 先把附件对象 a 推进附件栏，renderAttachments 会用
// normAtt 的副本替换 state.attachments，之后 stat 回执再改 a 已经改不到列表里（列表仍是 size=0 / big=true），
// 小图片没有缩略图、发出去还走「大附件只给路径」。
// 这里跑真的 attachPath / attSized / attachStat：renderAttachments 用与真身一样的 normAtts 复制，
// 断言 stat 回执写到当前附件栏里的那一条、以及已经切走的草稿里那一条。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const src05 = fs.readFileSync(new URL("../web/app/05-composer.js", import.meta.url), "utf8");
const take = (src, start, end) => {
  const a = src.indexOf(start);
  assert.ok(a >= 0, "找不到 " + start);
  const b = src.indexOf(end, a);
  assert.ok(b > a, "找不到 " + end);
  return src.slice(a, b);
};

function load() {
  const code = `
let draftEpoch = 0;
const view = { sessionId: "" };
const state = { attachments: [] };
const store = {};
let apiCalls = [], renders = 0, saves = 0;
let apiResolve = null, apiReject = null;
const api = (u) => { apiCalls.push(u); return new Promise((ok, bad) => { apiResolve = ok; apiReject = bad; }); };
const t = (s, v) => String(s).replace(/\\{(\\w+)\\}/g, (_, k) => String(v && v[k] !== undefined ? v[k] : ""));
const toast = () => {};
// 与真的 renderAttachments 关键行为一致：整表换成 normAtt 的副本
const renderAttachments = () => { renders++; state.attachments = normAtts(state.attachments); };
const draftOwner = (ep, key) => key || "";
const draftPutAway = (k, text, att) => {
  const d = store[k] || (store[k] = { text: "", att: [] });
  if (text) d.text = text;
  for (const a of att || []) if (!d.att.some((x) => x && x.path === a.path)) d.att.push(a);
};
const draftsRead = () => store;
const draftsSave = () => { saves++; return true; };
${take(src05, "  function normAtt(a) {", "  try { const a = JSON.parse(sessionStorage")}
${take(src05, "  /** stat 的回执要写回真正在用的那条附件", "  let pickFrom = null;")}
globalThis.__h = { attachPath, state, view, store,
  apiCalls: () => apiCalls, renders: () => renders, saves: () => saves,
  resolveApi: (v) => apiResolve(v), rejectApi: (e) => apiReject(e),
  setEpoch: (n) => { draftEpoch = n; } };
`;
  const ctx = {};
  vm.runInNewContext(code, ctx);
  return ctx.__h;
}

const flush = () => new Promise((r) => setImmediate(r));

test("BUG-UIFS-002 当前附件栏：stat 回来要改到列表里那一条（不是被 render 换掉的旧对象）", async () => {
  const h = load();
  h.attachPath("/w/季度 报告.png", null);
  assert.equal(h.state.attachments.length, 1);
  assert.equal(h.state.attachments[0].size, 0, "刚进来大小未知");
  assert.equal(h.state.attachments[0].big, true, "大小未知时按大附件算（原行为）");
  assert.equal(h.apiCalls().length, 1, "要问一次实际大小");
  h.resolveApi({ size: 4096 });
  await flush();
  assert.equal(h.state.attachments[0].size, 4096, "stat 回执要写回附件栏里那一条");
  assert.equal(h.state.attachments[0].big, false, "知道是小文件了就别再按大附件发");
});

test("BUG-UIFS-002 已经放到别的会话草稿：stat 回执写回那份草稿里的条目", async () => {
  const h = load();
  h.setEpoch(5);
  h.view.sessionId = "now";
  h.attachPath("/w/a.png", { ep: 4, key: "old" });
  assert.equal(h.state.attachments.length, 0, "不在眼前这条，不该塞进当前附件栏");
  assert.equal(h.store.old.att[0].size, 0);
  assert.equal(h.apiCalls().length, 1, "放进原会话草稿的也要问大小");
  h.resolveApi({ size: 4096 });
  await flush();
  assert.equal(h.store.old.att[0].size, 4096);
  assert.equal(h.store.old.att[0].big, false);
  assert.equal(h.saves(), 1, "改完草稿要存回去");
});

test("BUG-UIFS-002 stat 失败仍按大附件算（原行为不变）", async () => {
  const h = load();
  h.attachPath("/w/b.png", null);
  h.rejectApi(new Error("boom"));
  await flush();
  assert.equal(h.state.attachments[0].size, 0);
  assert.equal(h.state.attachments[0].big, true);
});
