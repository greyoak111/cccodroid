// k 组测试共用：把设置页接口卡的源码（09-settings.js / 11-usage.js）切出来放进 VM 跑。
// 只切函数体，不复制产品逻辑；这样产品代码一改，测试就跟着被测到。
import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");
export const T = (s, v) => String(s).replace(/\{(\w+)\}/g, (_, k) => String(v && k in v ? v[k] : "{" + k + "}"));
export const ESC = (s) => String(s == null ? "" : s);

export function slice(src, startMark, endMark, name) {
  const a = src.indexOf(startMark);
  assert.ok(a >= 0, `${name} 里找不到开始标记 ${startMark}`);
  const b = endMark ? src.indexOf(endMark, a) : src.length;
  assert.ok(b > a, `${name} 里找不到结束标记 ${endMark}`);
  return src.slice(a, b);
}

// ── 09-settings.js 的密钥卡：renderKeyCard ─────────────────────────────
export function loadKeyCard() {
  const src = read("../../web/app/09-settings.js");
  const fn = slice(src, "  function renderKeyCard(box, p) {", "  async function testAndShow(id) {", "09-settings.js");
  const code = `
${fn}
let state = { provView: "A", providerActive: "A", providers: [], settings: {} };
let page = { els: {}, nodes: new Set() };
const $ = (id) => (id in page.els ? page.els[id] : null);
const box = { innerHTML: "", onclick: null, contains: (el) => page.nodes.has(el) };
const t = T, esc = ESC;
const pLabel = (x) => (x && (x.label || x.id)) || "";
const pHint = () => "";
const webUrl = (u) => (u || null);
const useBtn = () => "";
const loadBill = () => {};
let toastLog = [], reloadLog = [], testLog = [], confirmRet = true;
const toast = (m, e) => toastLog.push({ m, e: !!e });
const confirm = () => confirmRet;
let postCalls = [], postImpl = null;
const post = (p, body) => { const c = { p, body }; postCalls.push(c); return postImpl(c); };
let reloadProv = (...a) => { reloadLog.push(a); };
let testAndShow = (id) => { testLog.push(id); };
let useProvider = () => {};
globalThis.__k = {
  state, box,
  render: (p) => { renderKeyCard(box, p); },
  run: (act) => box.onclick({ target: { dataset: { act } } }),
  setCard(els) { page = { els, nodes: new Set(Object.values(els)) }; },
  setView(v) { state.provView = v; },
  get toastLog() { return toastLog; },
  get reloadLog() { return reloadLog; },
  get testLog() { return testLog; },
  get postCalls() { return postCalls; },
  set postImpl(f) { postImpl = f; },
  set confirmRet(v) { confirmRet = v; },
  reset() { toastLog = []; reloadLog = []; testLog = []; postCalls = []; },
};
`;
  const ctx = { T, ESC };
  vm.runInNewContext(code, ctx);
  return ctx.__k;
}

// ── 11-usage.js 的自定义接口卡：renderCustomCard ───────────────────────
export function loadCustomCard() {
  const src = read("../../web/app/11-usage.js");
  const fn = slice(src, "  function renderCustomCard(box, p) {", null, "11-usage.js");
  const code = `
${fn}
let state = { provView: "A", providerActive: "B", providers: [], settings: {} };
let page = { els: {}, nodes: new Set() };
const $ = (id) => (id in page.els ? page.els[id] : null);
const box = { innerHTML: "", onclick: null, contains: (el) => page.nodes.has(el) };
const t = T, esc = ESC;
const pLabel = (x) => (x && (x.label || x.id)) || "";
const useBtn = () => "";
let toastLog = [], reloadLog = [], testLog = [], confirmRet = true;
const toast = (m, e) => toastLog.push({ m, e: !!e });
const confirm = () => confirmRet;
let postCalls = [], postImpl = null;
const post = (p, body) => { const c = { p, body }; postCalls.push(c); return postImpl(c); };
let onReload = null;
let reloadProv = async (...a) => { reloadLog.push(a); if (onReload) onReload(); };
let testAndShow = (id) => { testLog.push(id); };
let useProvider = () => {};
let loadModels = async () => {};
globalThis.__k = {
  state, box,
  render: (p) => { renderCustomCard(box, p); },
  run: (act) => box.onclick({ target: { dataset: { act } } }),
  setCard(els) { page = { els, nodes: new Set(Object.values(els)) }; },
  setView(v) { state.provView = v; },
  get toastLog() { return toastLog; },
  get reloadLog() { return reloadLog; },
  get postCalls() { return postCalls; },
  set postImpl(f) { postImpl = f; },
  set confirmRet(v) { confirmRet = v; },
  set onReload(f) { onReload = f; },
  reset() { toastLog = []; reloadLog = []; testLog = []; postCalls = []; },
};
`;
  const ctx = { T, ESC };
  vm.runInNewContext(code, ctx);
  return ctx.__k;
}

export const pKeyA = () => ({ id: "A", label: "A", endpoints: [{ id: "x", label: "X" }], endpoint: "x", hasKey: true, keyTail: "1234", baseUrl: "https://a.example", defaultModel: "m", keyUrl: "", endpointLost: false });
export const pCustomA = () => ({ id: "A", label: "A", custom: true, hasKey: true, keyTail: "1234", baseUrl: "https://a.example/anthropic", authStyle: "bearer", defaultModel: "m1", fastModel: "", modelsUrl: "", plainHttp: false, extraModels: [], contextWindow: 0, inlineImages: false });
export const customEls = (over = {}) => ({
  "cc-label": { value: "A" }, "cc-base": { value: "https://a.example/anthropic" }, "cc-auth": { value: "bearer" },
  "cc-model": { value: "m1" }, "cc-fast": { value: "" }, "cc-models": { value: "" }, "cc-ctx": { value: "" },
  "cc-more": { value: "" }, "pc-key": { value: "" }, "cc-inline": { checked: false }, "pc-result": {},
  ...over,
});
