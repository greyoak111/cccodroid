// 第二份稳定性报告 i 组：BUG-G02（终端回放超过环形缓冲时重置历史，没有缺口标记；
// 首次连接只剩尾段也要说明）。跑的是 18-terminal.js 里真正的 termAttach。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const read = (f) => fs.readFileSync(new URL("../web/app/" + f, import.meta.url), "utf8");
const take = (src, start, end) => { const a = src.indexOf(start), b = src.indexOf(end, a); assert.ok(a >= 0 && b > a, start); return src.slice(a, b); };

function replayBox() {
  const calls = [];
  const box = {
    Map, Set, JSON, console,
    TERM: { list: [{ id: "T", alive: true, title: "bash T" }] },
    renderTermTabs() {},
    t: (k) => k,
  };
  const term = read("18-terminal.js");
  vm.runInNewContext(take(term, "  function termAttach(a) {", "  /** 粘住的 Ctrl") +
    "\nglobalThis.termAttach = termAttach;", box);
  return { box, calls };
}
function attach(box, calls) {
  const inst = {
    id: "T",
    es: null,
    xt: { reset: () => calls.push("reset"), write: (s) => calls.push("write:" + s) },
  };
  const made = [];
  class FakeES {
    constructor(url) { this.url = url; this.listeners = new Map(); made.push(this); }
    addEventListener(ev, fn) { this.listeners.set(ev, fn); }
    close() { this.closed = true; }
    fire(ev, payload) { const fn = this.listeners.get(ev); if (fn) fn({ data: JSON.stringify(payload) }); }
  }
  FakeES.CLOSED = 2;
  box.EventSource = FakeES;
  box.termAttach(inst);
  return { inst, es: made[0] };
}
const writes = (calls) => calls.filter((c) => c.startsWith("write:")).map((c) => c.slice(6));
const MARK = "…（已截断）";

test("BUG-G02：首次连接只剩尾段（total 比回放数据多）时写明截断", () => {
  const { box, calls } = replayBox();
  const { es } = attach(box, calls);
  es.fire("replay", { data: "TAIL", total: 500000 });
  assert.equal(calls[0], "reset");
  assert.ok(writes(calls).some((s) => s.includes(MARK)), "首次连接只有尾段，却没有任何缺口提示：" + JSON.stringify(calls));
  assert.equal(writes(calls).at(-1), "TAIL");
});

test("BUG-G02：首次连接、回放就是全部时不加截断标记", () => {
  const { box, calls } = replayBox();
  const { es } = attach(box, calls);
  es.fire("replay", { data: "full", total: 4 });
  assert.equal(calls[0], "reset");
  assert.equal(writes(calls).some((s) => s.includes(MARK)), false, JSON.stringify(calls));
  assert.equal(writes(calls).at(-1), "full");
});

test("BUG-G02：断线后缺口超过环形缓冲（seen 已知）仍然只提示一次截断", () => {
  const { box, calls } = replayBox();
  const { es, inst } = attach(box, calls);
  inst.seen = 5;
  es.fire("replay", { data: "TAIL", total: 500000 });
  assert.equal(calls[0], "reset");
  assert.ok(writes(calls).some((s) => s.includes(MARK)), JSON.stringify(calls));
  assert.equal(inst.seen, 500000);
});

test("BUG-G02：缺口在环内时只补新增的一段，不重置不提示", () => {
  const { box, calls } = replayBox();
  const { es, inst } = attach(box, calls);
  inst.seen = 5;
  es.fire("replay", { data: "abc", total: 8 });
  assert.deepEqual(calls, ["write:abc"]);
  assert.equal(inst.seen, 8);
});
