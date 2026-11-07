// 没建会话的草稿（#171/#172）：哪页认领、侧栏入口数什么。跑的是界面里真正的 runInView / queuedInView / draftsElsewhere
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const flow = fs.readFileSync(new URL("../web/app/04-session-flow.js", import.meta.url), "utf8");
const sess = fs.readFileSync(new URL("../web/app/07-sessions.js", import.meta.url), "utf8");
const take = (text, start, end) => { const a = text.indexOf(start), b = text.indexOf(end, a); assert.ok(a >= 0 && b > a, start); return text.slice(a, b); };
function ui({ sessionId = null, runIds = [], cids = [], runs = [], queue = [], intr = [] }) {
  const box = { Set, view: { sessionId, runIds: new Set(runIds), cids: new Set(cids) }, srv: { runs, queueAll: queue, intr } };
  vm.runInNewContext(
    take(flow, "  function runInView(r)", "  function pickViewRun(") +
    take(sess, "  function draftsElsewhere()", "  function liveSessCount()") +
    "\nglobalThis.f = { runInView, queuedInView, draftsElsewhere };", box);
  return box.f;
}

test("排队消息：跟着的那一轮已经结束的、没建会话的，放到新对话页；跟着别的草稿还在跑的不抢（#172-2）", () => {
  const runs = [{ id: "B", sessionId: null }];
  const f = ui({ runs });
  assert.equal(f.queuedInView({ id: "q1", sessionId: null, follow: "A-ended" }), true, "前面那一轮超时停了：孤儿归新对话页");
  assert.equal(f.queuedInView({ id: "q2", sessionId: null, follow: "B" }), false, "跟着别的还在跑的草稿：等认领了那一轮再跟着出来");
  assert.equal(f.queuedInView({ id: "q3", sessionId: null, intr: true }), true, "网关重启恢复的照旧");
  assert.equal(ui({ sessionId: "s1", runs }).queuedInView({ id: "q1", sessionId: null, follow: "A-ended" }), false, "有会话的页面不收");
  assert.equal(ui({ runs, runIds: ["B"] }).queuedInView({ id: "q2", sessionId: null, follow: "B" }), true, "认领了 B 之后跟着 B 的也出来");
});

test("侧栏草稿入口：数当前页看不到的在跑草稿、孤儿排队、待重发的中断记录；等确认的标出来（#172-1/3）", () => {
  const runs = [{ id: "A", sessionId: null, perms: [{ id: "p" }] }, { id: "B", sessionId: null }, { id: "C", sessionId: "s1" }];
  const queue = [{ id: "q1", sessionId: null, follow: "gone" }, { id: "q2", sessionId: null, follow: "A" }, { id: "q3", sessionId: null, follow: "C" }];
  const intr = [{ id: "i1", sessionId: null }, { id: "i2", sessionId: "s9" }];
  let d = ui({ sessionId: "s1", runs, queue, intr }).draftsElsewhere();
  // A、B 两轮 + q1（孤儿）+ i1；q2 跟着 A（认领 A 时一起出来，不重复数）、q3 跟着有会话的 C，都不算
  assert.equal(d.n, 4);
  assert.equal(d.ask, true);
  assert.equal(d.intr, true);
  // 在新对话页、已经认领了 A 和 B：剩孤儿排队（这一页就显示它，也不算）；中断记录就挂在这页，不算
  d = ui({ runs, queue, intr, runIds: ["A", "B"] }).draftsElsewhere();
  assert.equal(d.n, 0);
  // 新对话页但没认领（点「新对话」开的白纸）：A、B 还在别处
  d = ui({ runs, queue, intr }).draftsElsewhere();
  assert.equal(d.n, 2);
});
