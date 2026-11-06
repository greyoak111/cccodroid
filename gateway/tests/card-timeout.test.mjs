// 起进程前的确认卡（gw/run.mjs askCard）没人答时超时收尾（#171）
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { CARD, askCard } from "../gw/run.mjs";
import { INTERRUPTED, setInterrupted } from "../gw/queue.mjs";

const keep = CARD.timeout;
after(() => { CARD.timeout = keep; setInterrupted([]); });
const fakeRun = (id, sessionId = null) => ({ id, sessionId, text: "推荐一款手机可用的 Harness", startedAt: Date.now() - 1000, perms: null });
const ask = (run, evs) => askCard(run, (e) => evs.push(e), { key: "uc", tool: "UserConfig", input: {}, guard: { cat: "userconf", what: "~/.claude" }, what: "测试卡", yes: "✓", no: "✗" });

test("没人答：超时按停止收尾，卡片收起，记一条 why: card 的中断记录（没建会话的也有，界面在新对话页给「重发」）", async () => {
  CARD.timeout = 50;
  setInterrupted([]);
  const run = fakeRun("t171-a"), evs = [];
  const v = await ask(run, evs);
  assert.equal(v, null);
  assert.equal(run.aborted, true, "调用方据此 endRun");
  assert.equal(run.laneHeld, true, "这一页后面排着的消息挂起，不自己发出去");
  assert.equal(run.perms.size, 0);
  assert.equal(run.answerPerm, null);
  assert.ok(evs.some((e) => e.type === "perm_request"));
  assert.ok(evs.some((e) => e.type === "perm_resolved" && e.behavior === "cancel"));
  const rec = INTERRUPTED.find((e) => e.id === "t171-a");
  assert.ok(rec, "有中断记录");
  assert.equal(rec.why, "card");
  assert.equal(rec.sessionId, null);
  assert.equal(rec.text, "推荐一款手机可用的 Harness");
});

test("超时前答了：照常返回，不记中断、之后也不再触发", async () => {
  CARD.timeout = 80;
  setInterrupted([]);
  const run = fakeRun("t171-b", "sess-b"), evs = [];
  const p = ask(run, evs);
  assert.equal(run.answerPerm("ccapp-uc-t171-b", { behavior: "allow" }), true);
  assert.equal(await p, true);
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(!run.aborted);
  assert.ok(!INTERRUPTED.some((e) => e.id === "t171-b"));
  assert.ok(!evs.some((e) => e.type === "perm_resolved" && e.behavior === "cancel"));
});

test("超时前点了停止：按停止收尾，不记中断", async () => {
  CARD.timeout = 80;
  setInterrupted([]);
  const run = fakeRun("t171-c"), evs = [];
  const p = ask(run, evs);
  run.readyAbort.abort();
  assert.equal(await p, null);
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(!INTERRUPTED.some((e) => e.id === "t171-c"));
});
