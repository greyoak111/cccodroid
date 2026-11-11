// 稳定性报告 FIND-027 / FIND-034：
// 安卓选择器在后台收大文件期间，网页不知道有文件在路上，点发送会让附件落到下一条；
// 选择器取消 / 这一轮结束后 pickFrom 也一直留着，下一批附件按旧草稿归位。
// 安卓侧发 ccapp-attach-copy-start / -pick-done / -pick-cancel，网页按计数挡住发送、清掉快照。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const read = (p) => fs.readFileSync(new URL(`../web/${p}`, import.meta.url), "utf8");
const src05 = read("app/05-composer.js");
const java = fs.readFileSync(new URL("../../android/java/cc/codroid/MainActivity.java", import.meta.url), "utf8");

// 从 05-composer.js 里取出选择器快照与三个新事件的监听（不改一处逻辑，测试直接跑真代码）
function loadPickState() {
  const a = src05.indexOf("  let pickFrom = null;");
  const b = src05.indexOf('  window.addEventListener("ccapp-insert"', a);
  assert.ok(a > 0 && b > a, "05-composer.js 里找不到选择器事件块");
  const code = `
const handlers = {}, calls = [];
const window = { addEventListener: (k, f) => { handlers[k] = f; } };
const attachPath = (p, from) => calls.push({ p, from });
${src05.slice(a, b)}
globalThis.__h = {
  handlers, calls,
  get pickCopy() { return pickCopy; },
  get pickFrom() { return pickFrom; },
  set pickFrom(v) { pickFrom = v; },
};
`;
  const ctx = {};
  vm.runInNewContext(code, ctx);
  return ctx.__h;
}
const ev = (v) => ({ detail: { value: v } });

test("FIND-027 后台收大文件期间计数 > 0，收完清零；发送前的拦截确实在", () => {
  const h = loadPickState();
  h.handlers["ccapp-attach-copy-start"](ev("2"));
  assert.equal(h.pickCopy, 2);
  h.handlers["ccapp-attach-copy-start"](ev("1"));
  assert.equal(h.pickCopy, 3, "两批同时在收要累加");
  h.handlers["ccapp-attach-pick-done"](ev("2"));
  assert.equal(h.pickCopy, 1, "还有一批没收完");
  h.handlers["ccapp-attach-pick-done"](ev("1"));
  assert.equal(h.pickCopy, 0, "全收完了");
  // 计数超过实际也不许变成负数（少发一次 done 时不能反过来一直卡住）
  const h2 = loadPickState();
  h2.handlers["ccapp-attach-pick-done"](ev("3"));
  assert.equal(h2.pickCopy, 0);
  // 发送入口在 fromInput 的路径上看这个计数
  assert.ok(src05.includes("if (fromInput && pickCopy) return void toast("), "send() 里缺后台收文件的拦截");
});

test("FIND-034 这一轮结束（只有小文件也发 done）就清掉 pickFrom；取消清计数", () => {
  const h = loadPickState();
  const from = { ep: 3, key: "s1" };
  h.pickFrom = from;
  h.handlers["ccapp-attach-pick"](ev("/x/a.pdf"));
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].from, from, "拷贝完成前仍按打开选择器时的草稿归位");
  h.handlers["ccapp-attach-pick-done"](ev("0"));
  assert.equal(h.pickFrom, null, "done 之后不该再留着旧快照");

  const h2 = loadPickState();
  h2.pickFrom = from;
  h2.handlers["ccapp-attach-copy-start"](ev("1"));
  h2.handlers["ccapp-attach-pick-cancel"]({});
  assert.equal(h2.pickFrom, null);
  assert.equal(h2.pickCopy, 0, "取消后发送立刻恢复");
});

test("安卓侧：先发 copy-start 再 attachBig，收完发 copy-done；取消与只有小文件各有事件", () => {
  const atStart = java.indexOf('toPage("ccapp-attach-copy-start"');
  const atBig = java.indexOf("attachBig(big, true");
  assert.ok(atStart > 0 && atBig > atStart, "copy-start 要在 attachBig 之前发出");
  // BUG-A06 起事件值带上批次号（pickEvent），语义不变：收完发 copy-done
  assert.ok(java.includes('if (big) toPage("ccapp-attach-copy-done", pickEvent(id, list.size()));'), "attachBig 收完要发 copy-done");
  assert.ok(java.includes("if (big.isEmpty()) { toPage(\"ccapp-attach-pick-done\", pickEvent(pid, 0)); return; }"), "只有小文件也要收尾");
  assert.ok(java.includes('toPage("ccapp-attach-pick-cancel", pickEvent(pid, 0))'), "取消选择器要告诉网页");
});
