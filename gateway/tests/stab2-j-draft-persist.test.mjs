// 第二份稳定性报告 7.4 UIFS-008：草稿平时靠 input 事件的 400ms 防抖落盘。@ 补全、文件面板插入、
// 重发、回退 / 中断恢复这些入口是程序性改 inputEl.value，不会触发 input 事件；如果随后没有附件重渲染、
// 切会话或 pagehide，进程被系统回收时这段字就没落盘。修法是每个程序性入口都排一次 draftPersistSoon。
// 这里跑真的补全 / 插入函数（断言确实排了落盘），另外三个入口用源码锚点检查同一行链路上有落盘调用。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const read = (p) => fs.readFileSync(new URL(`../web/${p}`, import.meta.url), "utf8");
const src02 = read("app/02-chat-view.js");
const src03 = read("app/03-perm-status.js");
const src04 = read("app/04-session-flow.js");
const src05 = read("app/05-composer.js");

const slice = (text, start, end) => {
  const a = text.indexOf(start);
  assert.ok(a >= 0, "找不到 " + start);
  const b = text.indexOf(end, a);
  assert.ok(b > a, "找不到 " + end);
  return text.slice(a, b);
};

function load() {
  const atMarker = '\'"\' : "@" + p);';
  const at0 = src05.indexOf("  const attAt =");
  const at1 = src05.indexOf(atMarker, at0);
  assert.ok(at0 > 0 && at1 > at0, "05-composer.js 里找不到 attAt");
  const code = `
let inputEl = { value: "", selectionStart: 0, selectionEnd: 0,
  focus() {}, setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; } };
const state = { popup: { mode: null, items: [], sel: 0 }, fileDir: "", fileParent: null };
const t = (s, v) => String(s).replace(/\\{(\\w+)\\}/g, (_, k) => String(v && v[k] !== undefined ? v[k] : ""));
const hidePopup = () => {};
const autoGrow = () => {};
const syncInterject = () => {};
let persists = 0;
const draftPersistSoon = () => { persists++; };
const openFilePalette = () => {};
const openPage = () => {};
const $ = () => null;
${src05.slice(at0, at1 + atMarker.length)}
${slice(src05, "  function replaceToken(re, s) {", "  const CMD_TOKEN")}
${slice(src05, "  const CMD_TOKEN", "\n  function applyPopupChoice")}
${slice(src05, "  function applyPopupChoice(i) {", "  // ── 输入框")}
${slice(src05, "  function insertAtCursor(s) {", "  // ── 草稿找回")}
globalThis.__h = { applyPopupChoice, insertAtCursor, state, persists: () => persists,
  inputEl: () => inputEl, setInput: (v, caret) => { inputEl.value = v; inputEl.selectionStart = inputEl.selectionEnd = caret == null ? v.length : caret; } };
`;
  const ctx = {};
  vm.runInNewContext(code, ctx);
  return ctx.__h;
}

test("UIFS-008 @ 补全改的是程序性输入：要排一次草稿落盘", () => {
  const h = load();
  h.state.popup.mode = "file";
  h.state.popup.items = [{ raw: "a.txt", dir: false }];
  h.state.fileDir = "/w";
  h.setInput("@a");
  h.applyPopupChoice(0);
  assert.equal(h.persists(), 1, "补全替换要排 draftPersistSoon");
});

test("UIFS-008 文件面板 / 查看器插入：要排一次草稿落盘", () => {
  const h = load();
  h.setInput("");
  h.insertAtCursor("@/w/a.txt");
  assert.equal(h.persists(), 1, "insertAtCursor 要排 draftPersistSoon");
});

test("UIFS-008 其它程序性入口同一行链路上有落盘调用（源码锚点）", () => {
  // 重发：消息操作菜单把原文放回输入框
  assert.match(src02, /if \(a === "resend"\) \{ inputEl\.value = text; autoGrow\(\); inputEl\.focus\(\); draftPersistSoon\(\); \}/,
    "重发入口要落盘");
  // 回退 / 撤销：300ms 后把原文回填到目标会话
  assert.match(src03, /inputEl\.value = userText; autoGrow\(\); inputEl\.focus\(\); draftPersistSoon\(\); return;/,
    "回退回填要落盘");
  // 中断卡「重发」：回填后马上把网关那条中断记录 dismiss 掉，不落盘就只剩内存里的字
  const intr = slice(src04, 'inputEl.value = it.text || "";', "api(\"/api/interrupted/dismiss\"");
  assert.match(intr, /draftPersist(Soon)?\(\);/, "中断恢复回填要落盘（紧接着 dismiss 网关记录，必须立刻存）");
  // 「恢复」按钮本来就有（FIND-010），锁住别退化
  assert.match(slice(src05, "  function draftRestore() {", "  draftChip.addEventListener"), /draftPersistSoon\(\);/,
    "恢复按钮回填要落盘");
});
