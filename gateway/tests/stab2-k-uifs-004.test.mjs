// 第二份稳定性报告 k 组 BUG-UIFS-004：接口 A 迟到的保存回执清空接口 B 未提交的密钥输入、
// 并把视图/当前卡重画回 A。前端逻辑，VM 抽取实际源码跑（harness 见 fixtures/card-vm.mjs）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadKeyCard, loadCustomCard, pKeyA, pCustomA, customEls } from "./fixtures/card-vm.mjs";

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// ── 预置厂商的密钥卡（09-settings.js）─────────────────────────────────
test("UIFS-004：A 卡保存还没回来就切到 B，A 的回执不许清掉 B 刚粘的 Key、不许重画 B", async () => {
  const h = loadKeyCard();
  const keyA = { value: "sk-A" };
  h.setCard({ "pc-key": keyA, "pc-endpoint": null, "pc-result": {} });
  h.render(pKeyA());
  const d = deferred();
  h.postImpl = () => d.promise;
  const running = h.run("save");
  // 实际切卡回调：容器 innerHTML 已换成 B 的卡，#pc-key 指向 B 的输入框
  const keyB = { value: "sk-B-未提交" };
  h.setCard({ "pc-key": keyB, "pc-endpoint": null, "pc-result": {} });
  h.setView("B");
  d.resolve({ ok: true });
  await running;
  assert.equal(h.state.provView, "B", "旧回执不许把视图切走");
  assert.equal(keyB.value, "sk-B-未提交", "B 未提交的密钥输入被 A 的旧回执清掉了");
  assert.equal(h.reloadLog.length, 0, "旧回执不许刷新/重画当前卡");
  assert.equal(h.testLog.length, 0, "旧回执不许在当前卡上跑测试");
});

test("UIFS-004：同卡提交后又敲了新内容，回执回来也不许清掉", async () => {
  const h = loadKeyCard();
  const keyA = { value: "sk-A" };
  h.setCard({ "pc-key": keyA, "pc-endpoint": null, "pc-result": {} });
  h.render(pKeyA());
  const d = deferred();
  h.postImpl = () => d.promise;
  const running = h.run("save");
  keyA.value = "sk-A2-新输入";
  d.resolve({ ok: true });
  await running;
  assert.equal(keyA.value, "sk-A2-新输入", "提交后新敲的内容被旧回执清掉了");
  assert.equal(h.reloadLog.length, 0, "有未提交的新输入时不许重画卡片");
  assert.equal(h.toastLog.length, 1);
  assert.equal(h.toastLog[0].m, "已保存");
});

test("UIFS-004：正常保存（没切卡、没新输入）仍然清空输入并刷新", async () => {
  const h = loadKeyCard();
  const keyA = { value: "sk-A" };
  h.setCard({ "pc-key": keyA, "pc-endpoint": null, "pc-result": {} });
  h.render(pKeyA());
  const d = deferred();
  h.postImpl = () => d.promise;
  const running = h.run("save");
  d.resolve({ ok: true });
  await running;
  assert.equal(keyA.value, "", "正常保存后应清空输入框");
  assert.equal(h.reloadLog.length, 1, "正常保存后应刷新接口卡");
  assert.equal(h.reloadLog[0][0], "已保存");
  assert.equal(h.reloadLog[0][1], true);
});

test("UIFS-004：清除 Key 的迟到回执也不许重画已切走的卡", async () => {
  const h = loadKeyCard();
  const keyA = { value: "" };
  h.setCard({ "pc-key": keyA, "pc-endpoint": null, "pc-result": {} });
  h.render(pKeyA());
  const d = deferred();
  h.postImpl = () => d.promise;
  const running = h.run("clear");
  const keyB = { value: "sk-B" };
  h.setCard({ "pc-key": keyB, "pc-endpoint": null, "pc-result": {} });
  h.setView("B");
  d.resolve({ ok: true });
  await running;
  assert.equal(h.reloadLog.length, 0, "A 的清除回执重画了 B");
  assert.equal(keyB.value, "sk-B");
});

// ── 自定义接口卡（11-usage.js）────────────────────────────────────────
test("BUG-UIFS-004：自定义卡保存还没回来就切走，旧回执不许把视图切回去", async () => {
  const h = loadCustomCard();
  h.setCard(customEls());
  h.render(pCustomA());
  const d = deferred();
  h.postImpl = () => d.promise;
  const running = h.run("save");
  h.setView("B");
  d.resolve({ ok: true, id: "A" });
  await running;
  assert.equal(h.state.provView, "B", "旧回执把视图切回 A 了");
  assert.equal(h.reloadLog.length, 0, "旧回执重画了当前卡");
});

test("BUG-UIFS-004：自定义卡提交后又敲了新 Key，旧回执不许重画掉", async () => {
  const h = loadCustomCard();
  const keyEl = { value: "" };
  h.setCard(customEls({ "pc-key": keyEl }));
  h.render(pCustomA());
  const d = deferred();
  h.postImpl = () => d.promise;
  const running = h.run("save");
  keyEl.value = "sk-新敲的还没提交";
  d.resolve({ ok: true, id: "A" });
  await running;
  assert.equal(keyEl.value, "sk-新敲的还没提交", "提交后新敲的 Key 被旧回执重画掉了");
  assert.equal(h.reloadLog.length, 0, "有未提交的新 Key 时不许重画卡片");
  assert.equal(h.toastLog.length, 1);
});

test("自定义卡正常保存（没切卡）仍提交并刷新（回归保护）", async () => {
  const h = loadCustomCard();
  h.setCard(customEls());
  h.render(pCustomA());
  h.postImpl = () => Promise.resolve({ ok: true, id: "A" });
  await h.run("save");
  assert.equal(h.postCalls.length, 1);
  assert.equal(h.postCalls[0].p, "/api/providers/save");
  assert.equal(h.postCalls[0].body.id, "A");
  assert.equal(h.state.provView, "A");
  assert.equal(h.reloadLog.length, 1);
});
