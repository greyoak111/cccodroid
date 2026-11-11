// 稳定性报告 FIND-033：壳为同一条路径重复发事件时，attachPath 会生成两条一样的附件；
// 删掉其中一条会连壳拷进 uploads 的临时文件一起删，另一条就悬空了。
// 直接把 attachPath 抽出来，用最小桩跑真代码。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const src05 = fs.readFileSync(new URL("../web/app/05-composer.js", import.meta.url), "utf8");

function loadAttach() {
  const a = src05.indexOf("  function attachPath(p, from) {");
  const b = src05.indexOf("  let pickFrom = null;", a);
  assert.ok(a > 0 && b > a, "05-composer.js 里找不到 attachPath");
  const code = `
let draftEpoch = 0;
const view = { sessionId: "" };
const state = { attachments: [] };
const toasts = [], away = [];
const t = (s, v) => String(s).replace(/\\{(\\w+)\\}/g, (_, k) => String(v[k]));
const toast = (m) => toasts.push(m);
const renderAttachments = () => {};
const draftOwner = (ep, k) => "d" + ep + ":" + k;
const draftPutAway = (k, text, att) => { away.push({ k, att }); };
const api = () => Promise.resolve({ size: 7 });
${src05.slice(a, b)}
globalThis.__h = { attachPath, state, toasts, away, setEpoch: (n) => { draftEpoch = n; }, view };
`;
  const ctx = {};
  vm.runInNewContext(code, ctx);
  return ctx.__h;
}

test("FIND-033 同一路径重复回调只留一条附件", () => {
  const h = loadAttach();
  h.attachPath("/data/w/uploads/a.pdf", null);
  h.attachPath("/data/w/uploads/a.pdf", null);
  assert.equal(h.state.attachments.length, 1, "重复路径不该生成第二条");
  assert.equal(h.toasts.length, 1, "重复回调也不该再提示一次「已附加」");
  h.attachPath("/data/w/uploads/b.pdf", null);
  assert.equal(h.state.attachments.length, 2, "不同路径照常加");
});

test("FIND-033 归到别的会话草稿时仍由 draftPutAway 按路径去重", () => {
  const h = loadAttach();
  h.setEpoch(5);
  h.view.sessionId = "now";
  const from = { ep: 4, key: "old" };
  h.attachPath("/data/w/uploads/a.pdf", from);
  h.attachPath("/data/w/uploads/a.pdf", from);
  assert.equal(h.state.attachments.length, 0, "不在眼前这条，不该塞进当前附件栏");
  assert.equal(h.away.length, 2, "两次回调都交给 draftPutAway，去重由它负责（原有行为）");
  assert.equal(h.away[0].k, "d4:old");
});
