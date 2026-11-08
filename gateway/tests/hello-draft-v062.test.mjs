// v0.6.2 审查 #120-3：首个 hello 自动跟到别的会话时，草稿要按会话交接，不能把 A 的字/附件带进 B。
// 0.6.9 审计 195-P.7 改了前半句：本地已经记着会话时不再跟到别的轮次（否则覆盖最后查看的会话）；
// 只有本地没有会话号（新对话 / 刚装）时才跟。原「本地有 A、run 在 B 也切过去」的断言随之更新。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const sessionSource = fs.readFileSync(new URL("../web/app/04-session-flow.js", import.meta.url), "utf8");
const take = (text, start, end) => text.slice(text.indexOf(start), text.indexOf(end));
const nodes = () => ({ classList: { add() {}, remove() {} }, querySelector() { return null; }, childElementCount: 0, innerHTML: "" });

/** 跑一次真实的 resetView + onHello（只给它们要用的环境） */
function hello(viewSid, runSid) {
  const swaps = [];
  const view = { sessionId: viewSid, gen: 0, runIds: new Set(), cids: new Set(), next: null, anchor: "", cursor: null, title: "", pendingMerge: null };
  const state = { pendingModel: null };
  const box = {
    view, state, Set, Map, t: (s) => s, uiTag: "synthetic-ui", helloCount: 0,
    WROTE: new Map(), TOOL_CARDS: new Map(), TOOL_RESULTS: new Map(), clearToolResults() {}, PERMS: new Map(), runViews: new Map(),
    histEl: nodes(), liveEl: nodes(), olderEl: nodes(), statEl: nodes(), statLast: {}, statStop() {},
    stripHidden: () => ({}), paintTitle() {}, renderRunStrip() {}, renderPermBar() {}, agReset() {}, syncWindow() {}, pickViewRun() {}, renderQueue() {}, paintProjChip() {}, syncInterject() {}, saveUiState() {},
    applyState() {}, beginReplay() {}, updateCtx() {}, renderSessions() {}, loadOlder() {}, showWelcome() {}, renderInterrupted() {}, calmStatus() {}, refreshSessModel() {},
    isBusy: () => false, setStatus() {}, intrList: () => [],
    draftSwap: (from, to) => swaps.push([from, to]),
  };
  vm.runInNewContext(
    take(sessionSource, "  function resetView(", "  /** 打开某个会话") +
    take(sessionSource, "  function onHello(", "  /** 「已连接」") +
    "\nglobalThis.handoff = { onHello };",
    box,
  );
  box.handoff.onHello({ uiTag: "synthetic-ui", resume: false, interrupted: [], run: { id: "r1", sessionId: runSid, ended: false } });
  return { swaps, view };
}

test("本地记着会话时首次 hello 不跟别的轮次（0.6.9 审计 195-P.7）", () => {
  const { swaps, view } = hello("session-a", "session-b");
  assert.deepEqual(swaps, []);
  assert.equal(view.sessionId, "session-a");
});

test("首次 hello 跟的就是眼前这个会话：不动草稿", () => {
  const { swaps, view } = hello("session-a", "session-a");
  assert.deepEqual(swaps, []);
  assert.equal(view.sessionId, "session-a");
});

test("本地没有会话号时首次 hello 才跟：跟到另一个会话，草稿按会话交接（#120-3）", () => {
  const { swaps, view } = hello(null, "session-b");
  assert.deepEqual(swaps, [[null, "session-b"]]);
  assert.equal(view.sessionId, "session-b");
});

test("本地没有会话号、在跑的轮次也还没拿到会话号：留在新对话页，草稿不用搬", () => {
  const { swaps, view } = hello(null, null);
  assert.deepEqual(swaps, []);
  assert.equal(view.sessionId, null);
});
