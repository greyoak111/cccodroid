// 跑 18-terminal.js 的回放、遮挡缓冲与退订路径；SSE 和 xterm 写入皆为内存桩。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const read = (f) => fs.readFileSync(new URL("../web/app/" + f, import.meta.url), "utf8");
const take = (src, start, end) => { const a = src.indexOf(start), b = src.indexOf(end, a); assert.ok(a >= 0 && b > a, start); return src.slice(a, b); };

const term = read("18-terminal.js");
function replayBox() {
  let covered = false, timerId = 0;
  const writes = [], timers = new Map();
  const inst = { id: "T", es: null, pendingOut: "", outTimer: 0, xt: { write: (s) => writes.push(s) } };
  const document = new EventTarget();
  document.documentElement = { classList: { contains: (cls) => covered && cls === "term-under" } };
  class FakeES extends EventTarget {
    static CLOSED = 2;
    close() { this.readyState = FakeES.CLOSED; }
    fire(ev, payload) { this.dispatchEvent(new MessageEvent(ev, { data: JSON.stringify(payload) })); }
  }
  const box = {
    document, EventSource: FakeES, termEl: { classList: { contains: () => false } },
    TERM: { cur: "T", inst: new Map([["T", inst]]), list: [{ id: "T", alive: true }] },
    renderTermTabs() {}, t: (k) => k,
    setTimeout: (f, ms) => { assert.ok(ms > 0 && ms <= 100); timers.set(++timerId, f); return timerId; },
    clearTimeout: (id) => timers.delete(id),
  };
  vm.runInNewContext(take(term, "  const termCovered", "  // 首次加载 xterm") +
    take(term, "  const TERM_OUT_LIMIT", "  /** 粘住的 Ctrl") +
    "\nglobalThis.f = { termAttach, termDetach };", box);
  box.f.termAttach(inst);
  return {
    inst, es: inst.es, writes, timers,
    cover: () => { covered = true; },
    uncover: () => { covered = false; document.dispatchEvent(new Event("cc:term-uncovered")); },
    detach: () => box.f.termDetach(inst), attach: () => { box.f.termAttach(inst); return inst.es; },
  };
}
const RESET = "\x18\x1bc", MARK = "\x1b[2m…（已截断）\x1b[0m\r\n";

test("BUG-G02：首次回放只剩尾段时提示；收到全部时不提示", () => {
  for (const [total, prefix] of [[500000, MARK], [4, ""]]) {
    const { es, writes } = replayBox();
    es.fire("replay", { data: "TAIL", total });
    assert.deepEqual(writes, [RESET + prefix + "TAIL"]);
  }
});

test("BUG-G02：断线缺口超出回放环时，重置必须排在先前收到的输出之后", () => {
  const h = replayBox();
  h.es.fire("replay", { data: "HEAD", total: 4 });
  h.cover();
  h.es.fire("o", "旧尾段\x1b[");
  h.es.fire("replay", { data: "TAIL", total: 500000 });
  assert.deepEqual(h.writes, [RESET + "HEAD", "旧尾段\x1b[", RESET + MARK + "TAIL"]);
  assert.equal(h.inst.seen, 500000);
  assert.equal(h.timers.size, 0);
});

test("BUG-G02：缺口在环内时只补新增的一段，已暂存的中文和 emoji 不重复", () => {
  const h = replayBox();
  const head = "开头\r\n", pending = "🧪\r\n", suffix = "新增🌿";
  h.es.fire("replay", { data: head, total: head.length });
  h.cover();
  h.es.fire("o", pending);
  h.es.fire("replay", { data: pending + suffix, total: (head + pending + suffix).length });
  assert.deepEqual(h.writes, [RESET + head, pending, suffix]);
  assert.equal(h.inst.seen, (head + pending + suffix).length);
});

test("盖住时只保留有界尾段，按揭开或定时到期依序交给同一实例", () => {
  const h = replayBox();
  h.cover();
  const blocks = ["中🧪".repeat(20000), "\x1b[3", "2m末尾\x1b[0m", "x".repeat(65537), "再一段", "\r\n"];
  for (const block of blocks) {
    h.es.fire("o", block);
    assert.ok(h.inst.pendingOut.length <= 65536);
    assert.ok(h.timers.size <= 1);
  }
  assert.deepEqual(h.writes, [blocks.slice(0, 3).join(""), blocks[3]]);
  h.uncover();
  assert.deepEqual(h.writes, [blocks.slice(0, 3).join(""), blocks[3], blocks.slice(4).join("")]);
  assert.equal(h.timers.size, 0);
  h.cover(); h.es.fire("o", "低流量");
  [...h.timers.values()][0]();
  assert.equal(h.writes.at(-1), "低流量");
  assert.equal(h.timers.size, 0);
});

test("切标签 / 关闭刷新尾段；旧连接与重复退出事件不再写入", () => {
  const h = replayBox();
  h.es.fire("replay", { data: "", total: 0 });
  h.cover(); h.es.fire("o", "旧标签尾段");
  h.detach();
  assert.equal(h.timers.size, 0);
  assert.equal(h.es.readyState, 2);
  const next = h.attach();
  h.es.fire("o", "迟到的输出");
  h.es.fire("replay", { data: "迟到的回放", total: 200 });
  h.es.fire("exit", { code: 1 });
  h.es.onerror();
  next.fire("replay", { data: "尾段新字符", total: "旧标签尾段新字符".length });
  next.fire("o", "最后一行");
  next.fire("exit", { code: 0 });
  next.fire("exit", { code: 0 });
  assert.equal(next.readyState, 2);
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.writes.slice(1, -1), ["旧标签尾段", "新字符", "最后一行"]);
  assert.match(h.writes.at(-1), /进程已退出/);
});
