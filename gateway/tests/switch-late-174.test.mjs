// 在会话 A 发起、回执到时已经切到 B（#174）：跑界面里真正的函数，外部依赖用桩
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const read = (f) => fs.readFileSync(new URL("../web/app/" + f, import.meta.url), "utf8");
const take = (src, start, end) => { const a = src.indexOf(start), b = src.indexOf(end, a); assert.ok(a >= 0 && b > a, start); return src.slice(a, b); };
const later = () => { let ok, bad; const p = new Promise((r, j) => { ok = r; bad = j; }); return { p, ok, bad }; };
const T = (k, o) => k.replace(/\{(\w+)\}/g, (_, n) => o[n]);

test("草稿放回：追加正文、按路径去重附件", () => {
  const store = {};
  const box = { localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } }, Date };
  const c = read("05-composer.js");
  vm.runInNewContext('const DRAFTS_KEY = "cc.drafts";\n' + take(c, "  function draftsRead()", "  let draftEpoch") +
    take(c, "  function draftPutAway(", "  /** 输入框有字") + "\nglobalThis.f = { draftPutAway, draftsRead };", box);
  box.f.draftPutAway("A", "第一段", [{ path: "/x" }]);
  box.f.draftPutAway("A", "第二段", [{ path: "/x" }, { path: "/y" }]);
  const d = JSON.parse(store["cc.drafts"]).A;
  assert.equal(d.text, "第一段\n\n第二段");
  assert.deepEqual(d.att.map((a) => a.path), ["/x", "/y"]);
});

test("删消息：回执到时已切走，B 的节点一个不动，提示说在原会话删了", async () => {
  const g = later(), toasts = [];
  const bMsgs = [{ classList: { contains: (c) => c === "bot" }, dataset: {}, remove() { throw new Error("不该动 B 的节点"); } }];
  const msgEl = { dataset: {}, remove() {}, querySelector: () => null };
  const box = {
    view: { sessionId: "A", gen: 1, next: null, cursor: null }, Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    chatEl: { querySelectorAll: (q) => q === ".msg.user" ? [msgEl] : bMsgs }, userTextOf: new Map([[msgEl, "hi"]]),
    histPages: () => [], isBusy: () => false, confirm: () => true, t: T, toast() {}, toastAct: (m) => toasts.push(m),
    api: () => g.p, JSON, encodeURIComponent, Number, openSession() {},
  };
  vm.runInNewContext(take(read("03-perm-status.js"), "  async function deleteMsg(", "  // 分叉：保留到") + "\nglobalThis.f = deleteMsg;", box);
  const p = box.f(msgEl, "user");
  box.view.sessionId = "B"; box.view.gen = 2;
  g.ok({ ok: true, moved: { 0: 0 }, size: 10, undo: "u" });
  await p;
  assert.equal(bMsgs[0].dataset.orphan, undefined);
  assert.deepEqual(toasts, ["已在原来那个会话里删除"]);
});

test("回退：试算回来已切走，不弹确认框；分叉回执到时已切走，不把人拉过去", async () => {
  const src = read("03-perm-status.js");
  const g = later(), opened = [], toasts = [];
  const msgEl = { dataset: {}, compareDocumentPosition: () => 4 };
  const box = {
    view: { sessionId: "A", gen: 1 }, Node: { DOCUMENT_POSITION_FOLLOWING: 4 }, chatEl: { querySelectorAll: () => [msgEl] },
    userTextOf: new Map([[msgEl, "hi"]]), isBusy: () => false, t: T, toast: (m) => toasts.push(m), toastAct: (m) => toasts.push("act:" + m),
    api: () => g.p, JSON, encodeURIComponent, openSession: (id) => opened.push(id), loadSessions() {},
    rewindDialog: () => { throw new Error("不该弹"); },
  };
  vm.runInNewContext(take(src, "  async function forkFrom(", "  function rewindDialog(") + "\nglobalThis.f = { forkFrom, rewindTo };", box);
  let p = box.f.rewindTo(msgEl);
  box.view.sessionId = "B";
  g.ok({ canRewind: true, files: [] });
  await p;
  assert.ok(toasts.includes("已切换会话，这次回退没有执行"));
  const g2 = later(); box.api = () => g2.p; box.view.sessionId = "A";
  p = box.f.forkFrom({ ...msgEl, compareDocumentPosition: () => 0 });
  box.view.sessionId = "B";
  g2.ok({ id: "F", kept: 3 });
  await p;
  assert.deepEqual(opened, []);
  assert.ok(toasts.some((m) => m.startsWith("act:已分叉")));
});
