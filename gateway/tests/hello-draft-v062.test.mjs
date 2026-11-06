// v0.6.2 审查 #120-3：首个 hello 自动跟到别的会话时，草稿要按会话交接，不能把 A 的字/附件带进 B
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

test("首次 hello 跟到另一个会话：先把 A 的草稿留在 A，再换成 B 的（#120-3）", () => {
  const { swaps, view } = hello("session-a", "session-b");
  assert.deepEqual(swaps, [["session-a", "session-b"]]);
  assert.equal(view.sessionId, "session-b");
});

test("首次 hello 跟的就是眼前这个会话：不动草稿", () => {
  const { swaps, view } = hello("session-a", "session-a");
  assert.deepEqual(swaps, []);
  assert.equal(view.sessionId, "session-a");
});

test("首次 hello 跟到还没拿到会话号的新会话：草稿交给新会话位", () => {
  const { swaps, view } = hello("session-a", null);
  assert.deepEqual(swaps, [["session-a", null]]);
  assert.equal(view.sessionId, null);
});
