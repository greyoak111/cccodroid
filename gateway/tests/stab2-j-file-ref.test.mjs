// 第二份稳定性报告 BUG-UIFS-001（对照第一轮 FIND-028）：@ 文件补全把「@ + 完整路径」直接拼进输入框，
// 不走 attAt，含空白 / 引号 / 反斜杠的路径不补引号；发出去 @ 提及按空白截断，只剩前半截。
// 文件面板的 insertAtCursor 也只在「有空白」时才补引号，带引号 / 反斜杠的路径同样还原不回去。
// 这里跑真代码：补全替换（replaceToken + applyPopupChoice）与光标插入（insertAtCursor），
// 再用气泡的 splitRefs 反解析，确认三个入口给出同一个能还原的引用。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const read = (p) => fs.readFileSync(new URL(`../web/${p}`, import.meta.url), "utf8");
const src02 = read("app/02-chat-view.js");
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
const draftPersistSoon = () => {};
const openFilePalette = () => {};
const openPage = () => {};
const $ = () => null;
${src05.slice(at0, at1 + atMarker.length)}
${slice(src05, "  function replaceToken(re, s) {", "  const CMD_TOKEN")}
${slice(src05, "  const CMD_TOKEN", "\n  function applyPopupChoice")}
${slice(src05, "  function applyPopupChoice(i) {", "  // ── 输入框")}
${slice(src05, "  function insertAtCursor(s) {", "  // ── 草稿找回")}
${slice(src02, "  const IMG_RE", "  function refsHtml")}
globalThis.__h = { attAt, applyPopupChoice, insertAtCursor, splitRefs, state,
  inputEl: () => inputEl, setInput: (v, caret) => { inputEl.value = v; inputEl.selectionStart = inputEl.selectionEnd = caret == null ? v.length : caret; } };
`;
  const ctx = {};
  vm.runInNewContext(code, ctx);
  return ctx.__h;
}

const parseRef = (h, s) => {
  const [body, refs] = h.splitRefs(s);
  return { body, refs };
};

test("BUG-UIFS-001 文件补全：含空白的路径补引号，splitRefs 能还原成一条", () => {
  const h = load();
  h.state.popup.mode = "file";
  h.state.popup.items = [{ raw: "季度 报告.md", dir: false }];
  h.state.fileDir = "/review-fixtures";
  h.setInput("@季度");
  h.applyPopupChoice(0);
  const v = h.inputEl().value;
  assert.ok(v.includes('@"/review-fixtures/季度 报告.md"'), "补全要补引号，实际：" + JSON.stringify(v));
  const { body, refs } = parseRef(h, "看一下 " + v.trim());
  assert.equal(body, "看一下");
  assert.equal(refs.length, 1, "整条路径要被认成一个引用，实际：" + JSON.stringify(refs));
  assert.equal(refs[0].p, "/review-fixtures/季度 报告.md");
});

test("BUG-UIFS-001 文件补全：带引号 / 反斜杠的路径同样能还原", () => {
  const h = load();
  for (const name of ['a"b.txt', "a\\b.txt", "a\nb.txt", "a\tb.txt"]) {
    h.state.popup.mode = "file";
    h.state.popup.items = [{ raw: name, dir: false }];
    h.state.fileDir = "/review-fixtures";
    h.setInput("@x");
    h.applyPopupChoice(0);
    const v = h.inputEl().value.trim();
    assert.ok(v.startsWith('@"'), "要加引号：" + JSON.stringify(name) + " → " + JSON.stringify(v));
    assert.ok(!/[\r\n\t]/.test(v), "引用里不能有真的换行 / 制表符：" + JSON.stringify(v));
    const { refs } = parseRef(h, v);
    assert.equal(refs.length, 1, "路径没还原：" + JSON.stringify(name));
    assert.equal(refs[0].p, "/review-fixtures/" + name);
  }
});

test("BUG-UIFS-001 两个插入入口规则一致：insertAtCursor 走 attAt", () => {
  const h = load();
  // 不带空白、但带引号：以前不加引号，现在要加
  h.setInput("");
  h.insertAtCursor('@/review-fixtures/a"b.txt');
  const v1 = h.inputEl().value.trim();
  assert.ok(v1.startsWith('@"'), "带引号的路径也要加引号，实际：" + JSON.stringify(v1));
  assert.equal(parseRef(h, v1).refs[0].p, '/review-fixtures/a"b.txt');
  // 普通路径不变
  h.setInput("");
  h.insertAtCursor("@/review-fixtures/a.txt");
  assert.equal(h.inputEl().value.trim(), "@/review-fixtures/a.txt");
});

test("BUG-UIFS-001 普通无空白补全照旧（回归）", () => {
  const h = load();
  h.state.popup.mode = "file";
  h.state.popup.items = [{ raw: "a.txt", dir: false }];
  h.state.fileDir = "/w/";
  h.setInput("@a");
  h.applyPopupChoice(0);
  assert.equal(h.inputEl().value.trim(), "@/w/a.txt");
});
