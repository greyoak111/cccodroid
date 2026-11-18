import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const web = process.env.CCAPP_TEST_WEB || fileURLToPath(new URL("../web/", import.meta.url));
const chat = fs.readFileSync(path.join(web, "app/02-chat-view.js"), "utf8");
// 只取生产 dropCards：CHAT_BLOCKS / TOOL_CARDS / AG 都由测试注入，避免把逻辑抄进测试
const start = chat.indexOf("  function dropCards(root) {");
const end = chat.indexOf("\n  }", start) + 4;
assert.ok(start >= 0 && end > start, "dropCards source markers exist");
const source = chat.slice(start, end);
assert.match(source, /if \(!root\) return;/);
assert.match(source, /CHAT_BLOCKS\.get\(el\)\?\.dispose\(\)/);

function node(label, cls) {
  const classes = new Set([cls]);
  return { label, classList: { contains: c => classes.has(c) } };
}
function block(label) {
  return { label, disposed: 0, dispose() { this.disposed++; } };
}
// 页面只模拟 dropCards 用到的两个能力：按类抓块、判断节点是否在本页
function page(name) {
  const members = ["txt", "think", "tool", "tgroup"].map(cls => node(name + "-" + cls, cls));
  const root = node(name, "page");
  root.querySelectorAll = selector => {
    assert.equal(selector, ".txt, .think, .tool, .tgroup");
    return members;
  };
  const all = new Set([root, ...members]);
  root.contains = target => all.has(target);
  return { root, members };
}
function fixture() {
  const inside = page("inside"), outside = page("outside");
  const blocks = new Map(), cards = new Map(), agentCards = new Map(), dirty = new Set(), cleared = [];
  for (const member of inside.members) blocks.set(member, block(member.label));
  blocks.set(inside.root, block("page-root"));               // root 自己也在 CHAT_BLOCKS 的查询范围里

  const insideCard = block("inside-card"); insideCard.el = inside.members[2];
  const hostCard = block("host-card"); hostCard.host = inside.members[3];   // 懒卡只有 host，没有 el
  const outsideCard = block("outside-card"); outsideCard.el = outside.root;
  cards.set("inside", insideCard); cards.set("host", hostCard); cards.set("outside", outsideCard);

  const insideAgent = block("inside-agent"); insideAgent.el = inside.members[1]; insideAgent.tick = 17;
  const outsideAgent = block("outside-agent"); outsideAgent.el = outside.root; outsideAgent.tick = 18;
  agentCards.set("inside", insideAgent); agentCards.set("outside", outsideAgent);
  dirty.add(insideAgent); dirty.add(outsideAgent);

  const ctx = vm.createContext({ CHAT_BLOCKS: blocks, TOOL_CARDS: cards, AG: { cards: agentCards, dirty }, clearTimeout: id => cleared.push(id) });
  vm.runInContext(source + "\nthis.dropCards = dropCards;", ctx);
  return { drop: ctx.dropCards, inside, blocks, cards, agentCards, dirty, cleared, insideCard, hostCard, outsideCard, insideAgent, outsideAgent };
}

test("dropCards 只释放本页的块、工具卡和代理卡", () => {
  const f = fixture();
  f.drop(f.inside.root);
  // CHAT_BLOCKS：root 自身和四个块都释放，页外节点不参与
  assert.equal(f.blocks.get(f.inside.root).disposed, 1, "root itself is checked");
  for (const member of f.inside.members) assert.equal(f.blocks.get(member).disposed, 1, member.label);
  // TOOL_CARDS：el 在页内、只有 host 在页内的都 dispose 并摘索引；页外的不受影响
  assert.equal(f.insideCard.disposed, 1); assert.equal(f.cards.has("inside"), false);
  assert.equal(f.hostCard.disposed, 1); assert.equal(f.cards.has("host"), false);
  assert.equal(f.outsideCard.disposed, 0); assert.equal(f.cards.get("outside"), f.outsideCard);
  // AG.cards：只删本页的卡、只清本页卡的定时器，dirty 集合同步
  assert.equal(f.agentCards.has("inside"), false);
  assert.equal(f.dirty.has(f.insideAgent), false);
  assert.deepEqual(f.cleared, [17]);
  assert.equal(f.agentCards.get("outside"), f.outsideAgent);
  assert.equal(f.dirty.has(f.outsideAgent), true);
  assert.equal(f.outsideAgent.tick, 18);
});

test("dropCards 对空 root 直接返回，不触碰任何索引", () => {
  const f = fixture();
  assert.doesNotThrow(() => f.drop(null));
  assert.equal(f.blocks.get(f.inside.root).disposed, 0);
  assert.ok(f.inside.members.every(member => f.blocks.get(member).disposed === 0));
  assert.equal(f.cards.size, 3); assert.equal(f.agentCards.size, 2);
  assert.equal(f.dirty.size, 2); assert.deepEqual(f.cleared, []);
});
