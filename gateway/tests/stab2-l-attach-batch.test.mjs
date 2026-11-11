// 第二份稳定性报告 BUG-A06：大附件后台拷贝期间又开了一次选择器，迟到的那批按批次号
// 归回当初那次选择器的草稿，而不是拿「最近一次选择器」的当前快照。
// 顺带锁住 FIND-027 的回归：壳拷完大文件发 ccapp-attach-copy-done，网页必须放开发送。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const read = (p) => fs.readFileSync(new URL(`../web/${p}`, import.meta.url), "utf8");
const src05 = read("app/05-composer.js");
const java = fs.readFileSync(new URL("../../android/java/cc/codroid/MainActivity.java", import.meta.url), "utf8");

// 和 stab-f-attach-copy 同样的抽取方式：直接跑 05-composer.js 里的真代码（选择器事件块）
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
  get batchCount() { return pickBatch.size; },
};
`;
  const ctx = {};
  vm.runInNewContext(code, ctx);
  return ctx.__h;
}
const ev = (v) => ({ detail: { value: v } });
const j = (o) => JSON.stringify(o);

test("A06 迟到的拷贝按批次号归回原草稿，不按当前选择器", () => {
  const h = loadPickState();
  const A = { ep: 1, key: "s-a" }, B = { ep: 2, key: "s-b" };
  // A 打开选择器 → 壳发 pick-start 批次 11
  h.pickFrom = A;
  h.handlers["ccapp-attach-pick-start"](ev("11"));
  // 用户已经切到 B，又开了一次选择器 → 批次 12
  h.pickFrom = B;
  h.handlers["ccapp-attach-pick-start"](ev("12"));
  // A 的后台拷贝现在才完成：必须落到 A 的草稿
  h.handlers["ccapp-attach-pick"](ev(j({ id: "11", path: "/x/a-large.bin" })));
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0].from, A, "第一批迟到时应按 A 的快照归位");
  // B 选中的文件落到 B
  h.handlers["ccapp-attach-pick"](ev(j({ id: "12", path: "/x/b-large.bin" })));
  assert.deepEqual(h.calls[1].from, B);
});

test("A06 取消后一次选择器不影响还在收的前一批计数", () => {
  const h = loadPickState();
  h.pickFrom = { ep: 1, key: "s-a" };
  h.handlers["ccapp-attach-pick-start"](ev("11"));
  h.pickFrom = { ep: 2, key: "s-b" };
  h.handlers["ccapp-attach-pick-start"](ev("12"));
  h.handlers["ccapp-attach-copy-start"](ev(j({ id: "11", n: 2 })));
  assert.equal(h.pickCopy, 2);
  // 第二批取消：只作废批次 12，不能把第一批的 2 个计数清零
  h.handlers["ccapp-attach-pick-cancel"](ev(j({ id: "12", n: 0 })));
  assert.equal(h.pickCopy, 2, "取消新的一批不能放行还在收的旧一批");
  assert.equal(h.batchCount, 1, "批次 12 的草稿快照该删掉");
  h.handlers["ccapp-attach-copy-done"](ev(j({ id: "11", n: 2 })));
  assert.equal(h.pickCopy, 0);
  assert.equal(h.batchCount, 0);
});

test("FIND-027 回归：大文件收完（copy-done）也要放开发送，重复事件不减成负数", () => {
  const h = loadPickState();
  h.handlers["ccapp-attach-copy-start"](ev(j({ id: "21", n: 1 })));
  assert.equal(h.pickCopy, 1);
  h.handlers["ccapp-attach-copy-done"](ev(j({ id: "21", n: 1 })));
  assert.equal(h.pickCopy, 0, "以前只认 pick-done，大文件收完计数永远不清，发送被永久挡住");
  h.handlers["ccapp-attach-copy-done"](ev(j({ id: "21", n: 1 })));
  assert.equal(h.pickCopy, 0);
  // 发送入口确实看这个计数
  assert.ok(src05.includes("if (fromInput && pickCopy) return void toast("), "send() 里缺后台收文件的拦截");
});

test("旧格式事件（没有批次号）仍按当前选择器快照处理", () => {
  const h = loadPickState();
  const A = { ep: 5, key: "s-a" };
  h.pickFrom = A;
  h.handlers["ccapp-attach-pick"](ev("/x/legacy.pdf"));
  assert.deepEqual(h.calls[0].from, A, "界面重建后壳只能按旧格式递，仍用当前快照");
  h.handlers["ccapp-attach-pick-done"](ev("0"));
  assert.equal(h.pickFrom, null, "这一轮结束就清掉快照（FIND-034）");
  // 旧格式的取消仍然把计数全部作废（和旧版行为一致）
  h.handlers["ccapp-attach-copy-start"](ev("3"));
  h.handlers["ccapp-attach-pick-cancel"]({});
  assert.equal(h.pickCopy, 0);
});

test("安卓壳：每次选择器分配批次号，事件都带上它；没有批次号时退回旧格式", () => {
  assert.ok(java.includes("PICK_SEQ.incrementAndGet()"), "选择器没分配批次号");
  assert.ok(java.includes('toPage("ccapp-attach-pick-start", String.valueOf(pid))'), "壳没把批次号交给网页");
  assert.ok(java.includes("pickEvent(id, real)") && java.includes("pickEvent(id, out.getPath())"),
    "后台拷完的文件事件没带批次号");
  assert.ok(java.includes("pickEvent(pid, 0)") && java.includes("pickEvent(pid, big.size())"),
    "收尾 / 开始拷贝事件没带批次号");
  // 界面重建后拿不到批次号：必须退回旧格式（纯路径 / 数字），网页才知道按当前快照处理
  assert.ok(java.includes("private static String pickEvent(String id, String path) {\n        if (id == null || id.isEmpty()) return path;"),
    "没有批次号时应退回纯路径旧格式");
  assert.ok(java.includes("private static String pickEvent(String id, int n) {\n        if (id == null || id.isEmpty()) return String.valueOf(n);"),
    "没有批次号时应退回纯数字旧格式");
});
