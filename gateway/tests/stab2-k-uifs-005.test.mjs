// 第二份稳定性报告 k 组 BUG-UIFS-005：删除自定义接口成功后没有结束动作，落穿到下面的
// 公共保存分支——用已删的 id 再保存当前卡；若刷新后当前卡是预置卡，还会因没有 #cc-label 抛异常。
// 前端逻辑，VM 抽取实际源码跑（harness 见 fixtures/card-vm.mjs）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadCustomCard, pCustomA, customEls } from "./fixtures/card-vm.mjs";

test("UIFS-005：删除成功后手势必须结束，不许再用已删 id 走公共保存分支", async () => {
  const h = loadCustomCard();
  h.setCard(customEls());
  h.render(pCustomA());
  h.postImpl = (c) => Promise.resolve(c.p === "/api/providers/delete" ? { ok: true } : { ok: true, id: "A" });
  await h.run("del");
  assert.deepEqual(Array.from(h.postCalls, (c) => c.p), ["/api/providers/delete"], "删除后不该再发出保存请求");
  assert.equal(h.reloadLog.length, 1, "删除成功应刷新一次清单");
});

test("UIFS-005：刷新后当前卡是预置卡（没有 cc-label）也不许抛异常", async () => {
  const h = loadCustomCard();
  h.setCard(customEls());
  h.render(pCustomA());
  // 删除成功、刷新后当前卡换成预置卡：cc-label 不存在
  h.onReload = () => h.setCard({});
  h.postImpl = () => Promise.resolve({ ok: true });
  await assert.doesNotReject(h.run("del"));
  assert.deepEqual(Array.from(h.postCalls, (c) => c.p), ["/api/providers/delete"]);
});

test("UIFS-005：取消删除仍然什么都不发（回归保护）", async () => {
  const h = loadCustomCard();
  h.setCard(customEls());
  h.render(pCustomA());
  h.confirmRet = false;
  h.postImpl = () => Promise.resolve({ ok: true });
  await h.run("del");
  assert.equal(h.postCalls.length, 0);
});
