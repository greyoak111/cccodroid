// Offline correctness tests: real tool components, synthetic DOM, no browser/network/runtime config.
// This DOM models only the selectors/fold rules exercised below, not browser layout or performance.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const web = fileURLToPath(new URL("../web/", import.meta.url));
const file = path.join(web, "app/02-chat-view.js");
const source = fs.readFileSync(file, "utf8");
const begin = source.indexOf("  function summarizeTool(");
const result = source.indexOf("  function toolResult(", begin);
const end = source.indexOf("\n  }", result);
assert.ok(begin >= 0 && result > begin && end > result, "tool component extraction markers exist");
const components = source.slice(begin, end + 4);
const sourceHash = createHash("sha256").update(source).digest("hex");
console.log("Tool review source:", file, "sha256=" + sourceHash);

const decode = s => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, k) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" }[k]));
const escape = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
class Node {
  constructor(tag = "div", type = 1) {
    this.tagName = tag.toUpperCase(); this.nodeType = type; this.childNodes = []; this.parentNode = null;
    this.data = ""; this.dataset = {}; this.events = []; this.attributes = new Map(); this.classes = new Set();
    this.classList = {
      add: (...xs) => xs.forEach(x => this.classes.add(x)),
      remove: (...xs) => xs.forEach(x => this.classes.delete(x)),
      contains: x => this.classes.has(x),
      toggle: (x, force = !this.classes.has(x)) => { if (force) this.classes.add(x); else this.classes.delete(x); return force; },
    };
  }
  set className(value) { this.classes.clear(); value.split(/\s+/).filter(Boolean).forEach(x => this.classes.add(x)); }
  get className() { return [...this.classes].join(" "); }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes.at(-1) || null; }
  get nextSibling() { return this.parentNode?.childNodes[this.parentNode.childNodes.indexOf(this) + 1] || null; }
  get isConnected() { return this.connectedRoot === true || !!this.parentNode?.isConnected; }
  appendChild(node) {
    if (node.nodeType === 11) { for (const c of [...node.childNodes]) this.appendChild(c); return node; }
    node.remove(); this.childNodes.push(node); node.parentNode = this; return node;
  }
  append(...nodes) { nodes.forEach(n => this.appendChild(n)); }
  prepend(node) { this.insertBefore(node, this.firstChild); }
  insertBefore(node, ref) {
    if (node === ref) return node;
    assert.ok(ref === null || this.childNodes.includes(ref), "insertBefore reference belongs to parent");
    node.remove(); const i = ref === null ? this.childNodes.length : this.childNodes.indexOf(ref);
    this.childNodes.splice(i, 0, node); node.parentNode = this; return node;
  }
  after(node) { this.parentNode.insertBefore(node, this.nextSibling); }
  remove() {
    if (!this.parentNode) return;
    const a = this.parentNode.childNodes; a.splice(a.indexOf(this), 1); this.parentNode = null;
  }
  replaceChildren(...nodes) { for (const n of [...this.childNodes]) n.remove(); this.append(...nodes); }
  get textContent() { return this.nodeType === 3 ? this.data : this.childNodes.map(x => x.textContent).join(""); }
  set textContent(value) {
    if (this.nodeType === 3) { this.data = String(value); return; }
    this.replaceChildren(); if (value !== "") { const n = new Node("#text", 3); n.data = String(value); this.appendChild(n); }
  }
  set innerHTML(html) {
    this.replaceChildren(); const stack = [this];
    for (const token of html.match(/<[^>]*>|[^<]+/g) || []) {
      if (token.startsWith("</")) { stack.pop(); continue; }
      if (token.startsWith("<")) {
        const tag = /^<([\w-]+)/.exec(token)?.[1]; if (!tag) continue;
        const n = new Node(tag), attrs = token.slice(tag.length + 1, -1);
        for (const m of attrs.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) {
          const key = m[1], val = decode(m[2] || ""); n.attributes.set(key, val);
          if (key === "class") n.className = val;
          else if (key === "hidden") n.hidden = true;
          else if (key === "open") n.open = true;
          else if (key.startsWith("data-")) n.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = val;
        }
        stack.at(-1).appendChild(n);
        if (!["img", "br", "input", "hr"].includes(tag) && !token.endsWith("/>")) stack.push(n);
      } else { const n = new Node("#text", 3); n.data = decode(token); stack.at(-1).appendChild(n); }
    }
  }
  matches(selector) {
    if (this.nodeType !== 1) return false;
    if (selector === "*") return true;
    const not = [...selector.matchAll(/:not\(([^)]+)\)/g)];
    if (not.some(m => this.matches(m[1]))) return false;
    selector = selector.replace(/:not\([^)]+\)/g, "");
    const attrs = [...selector.matchAll(/\[([\w-]+)\]/g)];
    if (attrs.some(m => m[1] === "open" ? !this.open : !this.attributes.has(m[1]))) return false;
    selector = selector.replace(/\[[^\]]+\]/g, "");
    assert.doesNotMatch(selector, /[\s>+~:#]/, "synthetic DOM does not support this selector");
    const tag = /^[\w-]+/.exec(selector)?.[0];
    if (tag && this.tagName !== tag.toUpperCase()) return false;
    const classes = [...selector.matchAll(/\.([\w-]+)/g)].map(m => m[1]);
    return !!(tag || classes.length || attrs.length) && classes.every(x => this.classes.has(x));
  }
  querySelectorAll(selector) {
    const found = [], choices = selector.split(",").map(x => x.trim());
    const visit = (parent, depth) => {
      for (const child of parent.childNodes) {
        if (choices.some(s => s.startsWith(":scope > ") ? depth === 0 && child.matches(s.slice(9)) : child.matches(s))) found.push(child);
        visit(child, depth + 1);
      }
    };
    visit(this, 0); return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest(selector) || null; }
  addEventListener(type, fn, capture = false) { this.events.push({ type, fn, capture }); }
  dispatchEvent(event) {
    event.target ||= this; event.stopPropagation = () => { event.stopped = true; };
    const route = []; for (let n = this; n; n = n.parentNode) route.push(n);
    const invoke = (n, capture) => { for (const l of n.events) if (l.type === event.type && !!l.capture === capture) l.fn(event); };
    for (const n of [...route].reverse()) { invoke(n, true); if (event.stopped) return; }
    for (const n of event.bubbles ? route : [this]) { invoke(n, false); if (event.stopped) return; }
  }
  click() { this.dispatchEvent({ type: "click", bubbles: true }); }
  getClientRects() {
    if (!this.isConnected) return [];
    for (let n = this; n; n = n.parentNode) {
      if (n.hidden || n.classList.contains("hidden")) return [];
      if (n.classList.contains("tg-head") && n.parentNode.classList.contains("single")) return [];
      if (n.classList.contains("tg-body")) {
        const g = n.parentNode, single = g.classList.contains("single"), pending = g.querySelector(".perm:not(.done)");
        if (!single && g.classList.contains("shut") && !pending) return [];
        if (!single && !g.classList.contains("open") && !g.querySelector(".perm:not(.done), .tool.open, .tool-peek")) return [];
      }
      if (n.classList.contains("tool-body") && !n.parentNode.classList.contains("open")) return [];
      if (n.classList.contains("ts-list") && !n.parentNode.classList.contains("open") && !n.parentNode.querySelector(".perm:not(.done)")) return [];
    }
    return [{}];
  }
}

function fixture({ images = true, fold } = {}) {
  const document = { createElement: tag => new Node(tag), createDocumentFragment: () => new Node("#fragment", 11) };
  const root = document.createElement("main"); root.connectedRoot = true;
  const cards = new Map(), results = new Map(), blocks = new WeakMap(), view = { gen: 1 };
  const groups = [], created = [], folds = new Map(); let embeds = 0;
  const context = {
    document, view, TOOL_CARDS: cards, TOOL_RESULTS: results, CHAT_BLOCKS: blocks,
    AG: { byTool: new Map() }, busReplay: true, MO: { play() {} }, clearTimeout,
    t: (s, args = {}) => String(s).replace(/\{([^}]+)\}/g, (m, k) => args[k] ?? m), esc: escape,
    foldGet: key => folds.has(key) ? folds.get(key) : fold, foldSet: (key, value) => folds.set(key, value),
    trackChatBlock(block) { created.push(block); if (block.el) blocks.set(block.el, block); return block; },
    renderMd: escape, enhanceMd() {}, setHtml: (el, html) => { el.innerHTML = html; },
    rememberResult: (id, ok, text) => results.set(id, { ok, text }),
    embedLocalImages(el) {
      embeds++;
      if (!images || !/\.png\b/.test(el.textContent)) return;
      const box = document.createElement("span"), img = document.createElement("img");
      box.className = "inline-img"; img.dataset.synthetic = "1"; box.appendChild(img); el.appendChild(box);
    },
  };
  const api = new Function(...Object.keys(context), components + "\nreturn {ToolGroup, ToolBlock, LazyCard, realize, toolResult};")(...Object.values(context));
  return {
    ...api, root, view, cards, results, created, document, get embeds() { return embeds; },
    group(count = 100, live = true, agentAt = -1) {
      const group = api.ToolGroup(root); groups.push(group);
      for (let i = 0; i < count; i++) group.tool("t" + i, i === agentAt ? "Agent" : "Read", { file_path: "/synthetic/" + i }, live);
      return group;
    },
    clean() { for (const group of groups) group.dispose(); root.replaceChildren(); },
  };
}
function setup(t, options) { const f = fixture(options); t.after(() => f.clean()); return f; }
const rows = group => group.el.querySelectorAll(".tg-entry").length;
const status = group => group.el.querySelector(".tg-head").querySelector(".tool-state");
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
function deferred() { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; }

for (const image of [false, true]) test("unrealized live " + (image ? "image" : "failure") + " mounts once with correct state, summary and visibility", t => {
  const f = setup(t), group = f.group(), old = f.cards.get("t70");
  assert.equal(old.lazy, true);
  assert.doesNotThrow(() => old.result(image, image ? "/synthetic/output.png" : "Synthetic failure"));
  const card = f.cards.get("t70");
  assert.notEqual(card, old); assert.equal(old.disposed, true); assert.equal(card.lazy, undefined);
  assert.equal(f.created.filter(b => b.kind === "tool" && b.id === "t70").length, 1);
  assert.equal(card.state, image ? "ok" : "err");
  assert.ok(card.el.isConnected && card.el.getClientRects().length, "attention card is mounted and not folded by modeled CSS");
  assert.ok(rows(group) <= 41);
  if (image) assert.ok(card.el.querySelector(".tool-peek")?.querySelector(".inline-img"));
  else assert.ok(card.el.classList.contains("open") && card.el.querySelector(".tool-body").textContent.includes("Synthetic failure"));
  assert.equal(status(group).classList.contains("run"), true, "99 remaining runs keep the summary running");
  for (let i = 0; i < 100; i++) if (i !== 70) f.cards.get("t" + i).result(true, "Done");
  assert.equal(status(group).classList.contains(image ? "ok" : "err"), true, "mount did not corrupt group state counts");
  assert.equal(status(group).textContent, image ? "完成" : "有失败");
  card.result(true, "Recovered");
  assert.equal(status(group).textContent, "完成", "the final failure can leave the err count");
});

for (const image of [false, true]) test("first cached " + (image ? "image" : "failure") + " remains exposed after the group grows to 180 tools", t => {
  const f = setup(t), group = f.group(0);
  f.toolResult("pre-result", image, image ? "/synthetic/first-output.png" : "Result before invocation");
  group.tool("pre-result", "Read", { file_path: "/synthetic/first" }, true);
  const first = f.cards.get("pre-result");
  assert.equal(first.lazy, undefined, "the single first entry was already realized by add");
  assert.equal(group.el.classList.contains("open"), true, "cached attention is handed to the group after the single-entry mount");
  for (let i = 1; i < 180; i++) {
    group.tool("later-" + i, "Read", { file_path: "/synthetic/" + i }, true);
    f.toolResult("later-" + i, true, "Result " + i);
    if (i === 1) assert.ok(first.el.isConnected && first.el.getClientRects().length, "growing from one to two entries must not stash cached attention");
  }
  assert.equal(f.cards.get("pre-result"), first); assert.ok(first.el.isConnected && first.el.getClientRects().length);
  assert.equal(first.state, image ? "ok" : "err");
  if (image) assert.ok(first.el.querySelector(".tool-peek")?.querySelector(".inline-img"));
  else assert.ok(first.el.querySelector(".tool-body").textContent.includes("Result before invocation"));
  assert.equal(rows(group), 41); assert.equal(status(group).textContent, image ? "完成" : "有失败");
});

test("first cached ordinary success does not automatically expand the growing group", t => {
  const f = setup(t), group = f.group(0);
  f.toolResult("pre-result", true, "Ordinary result before invocation");
  group.tool("pre-result", "Read", {}, true);
  for (let i = 1; i < 180; i++) { group.tool("later-" + i, "Read", {}, true); f.toolResult("later-" + i, true, "Done"); }
  assert.equal(group.el.classList.contains("open"), false); assert.equal(rows(group), 0);
  assert.equal(f.cards.get("pre-result").state, "ok"); assert.equal(status(group).textContent, "完成");
});

test("cached result and nested replay preserve summary counts without recursive mounts", t => {
  const f = setup(t), group = f.group();
  f.results.set("cached", { ok: false, text: "Cached failure" });
  assert.doesNotThrow(() => group.tool("cached", "Agent", {}, true));
  const card = f.cards.get("cached"); assert.equal(card.state, "err"); assert.ok(card.el.isConnected);
  card.sub("nested", "Read", {}).result(true, "Child done"); card.subDone("failed");
  for (let i = 0; i < 100; i++) f.cards.get("t" + i).result(true, "Done");
  assert.equal(status(group).textContent, "有失败");
  card.subDone("completed"); assert.equal(status(group).textContent, "完成");
  assert.equal(f.created.filter(b => b.kind === "tool" && b.id === "cached").length, 1);
});

test("result, nested child and subDone callbacks replay atomically while preserving final counts", t => {
  const f = setup(t), group = f.group(), lazy = f.LazyCard("replayed-agent", "Agent", {}, true);
  lazy.result(false, "Earlier parent failure");
  lazy.sub("replayed-child", "Read", {}).result(false, "Nested failure");
  lazy.subDone("completed");
  group.add(lazy);
  assert.doesNotThrow(() => lazy.reveal());
  const parent = f.cards.get("replayed-agent");
  assert.equal(parent.state, "ok"); assert.equal(parent.el.querySelector(".tool-state").textContent, "完成");
  const child = f.cards.get("replayed-child").reveal();
  assert.equal(child.state, "err"); assert.ok(child.el.isConnected && child.el.getClientRects().length);
  assert.equal(f.created.filter(b => b.kind === "tool" && b.id === "replayed-agent").length, 1);
  for (let i = 0; i < 100; i++) f.cards.get("t" + i).result(true, "Done");
  assert.equal(status(group).textContent, "完成", "nested callbacks do not inflate top-level failure counts");
});

test("missing local preview does not recurse or retain an attention pin", t => {
  const f = setup(t, { images: false }), group = f.group();
  assert.doesNotThrow(() => f.cards.get("t70").result(true, "/synthetic/missing.png"));
  const card = f.cards.get("t70"); assert.equal(card.state, "ok"); assert.equal(card.el.querySelector(".tool-peek"), null);
  f.cards.get("t0").reveal(); assert.equal(card.el.isConnected, false); assert.equal(rows(group), 40);
});

test("image error releases its pin on the next draw; explicit fold still hides previews", t => {
  const f = setup(t), group = f.group(); f.cards.get("t70").result(true, "/synthetic/output.png");
  const card = f.cards.get("t70"), peek = card.el.querySelector(".tool-peek");
  f.cards.get("t0").reveal(); assert.equal(rows(group), 41); assert.equal(card.el.isConnected, true);
  peek.querySelector("img").dispatchEvent({ type: "error", bubbles: false });
  assert.equal(card.el.querySelector(".tool-peek"), null);
  f.cards.get("t0").reveal(); assert.equal(rows(group), 40); assert.equal(card.el.isConnected, false);
  card.reveal(); card.result(true, "/synthetic/output.png"); group.el.querySelector(".tg-head").click();
  assert.ok(group.el.classList.contains("shut")); assert.equal(card.el.getClientRects().length, 0);
});

for (const reject of [false, true]) test((reject ? "rejected" : "successful") + " in-flight load survives real paging away and retries on return", async t => {
  const f = setup(t), group = f.group(100, false, 5), card = f.cards.get("t5").reveal();
  const pending = deferred(); let calls = 0;
  card.subLazy(() => ++calls === 1 ? pending.promise : Promise.resolve([
    { role: "tool_use", id: "loaded", name: "Read", input: { file_path: "/synthetic/loaded" } },
    { role: "tool_result", id: "loaded", ok: true, text: "Loaded result" },
  ]));
  card.openSub(); assert.equal(calls, 1); assert.equal(card.el.querySelector(".ts-now").textContent, "加载中…");
  f.cards.get("t99").reveal(); assert.equal(card.el.isConnected, false);
  if (reject) pending.reject(new Error("Synthetic load failure")); else pending.resolve([]);
  await settle(); assert.equal(card.el.querySelector(".ts-now").textContent, ""); assert.equal(f.cards.has("loaded"), false);
  assert.equal(f.cards.get("t5").reveal(), card, "paging reuses the same real component");
  const button = card.el.querySelector(".ts-head"); button.click(); button.click(); await settle();
  assert.equal(calls, 2, "retry is available after reattaching");
  assert.equal(f.cards.get("loaded").state, "ok"); assert.ok(f.cards.get("loaded").el.isConnected);
  f.cards.get("loaded").el.querySelector(".tool-head").click();
  assert.ok(f.cards.get("loaded").el.querySelector(".tool-body").textContent.includes("Loaded result"));
  assert.ok(group.retained().nodes > 0, "off-page DOM is included in retained-node accounting");
});

for (const reject of [false, true]) test((reject ? "rejected" : "successful") + " in-flight load cannot revive a disposed group", async t => {
  const f = setup(t), group = f.group(100, false, 5), card = f.cards.get("t5").reveal(), pending = deferred(); let calls = 0;
  card.subLazy(() => { calls++; return pending.promise; }); card.openSub(); group.dispose();
  const before = f.created.length;
  if (reject) pending.reject(new Error("Synthetic late failure")); else pending.resolve([{ role: "tool_use", id: "late", name: "Read", input: {} }]);
  await settle(); card.openSub();
  assert.equal(calls, 1); assert.equal(f.created.length, before); assert.equal(f.cards.size, 0); assert.equal(rows(group), 0);
});

test("same-ID replacement keeps ownership and consumes no stale loader", async t => {
  const f = setup(t), group = f.group(100, false, 5), card = f.cards.get("t5").reveal(), pending = deferred(); let calls = 0;
  card.subLazy(() => { calls++; return pending.promise; }); card.openSub(); f.cards.get("t99").reveal();
  const replacement = f.ToolBlock(f.root, "t5", "Agent", {}, false); t.after(() => replacement.dispose());
  pending.resolve([{ role: "tool_use", id: "stale", name: "Read", input: {} }]); await settle();
  card.reveal(); const button = card.el.querySelector(".ts-head"); button.click(); button.click(); await settle();
  assert.equal(calls, 1); assert.equal(f.cards.has("stale"), false); assert.equal(f.cards.get("t5"), replacement);
  group.dispose(); assert.equal(f.cards.get("t5"), replacement, "disposing old group cannot remove replacement's index");
});

test("a generation change rejects stale child contents", async t => {
  const f = setup(t); f.group(100, false, 5); const card = f.cards.get("t5").reveal(), pending = deferred();
  card.subLazy(() => pending.promise); card.openSub(); f.cards.get("t99").reveal();
  f.view.gen++;
  pending.resolve([{ role: "tool_use", id: "wrong-generation", name: "Read", input: {} }]); await settle();
  assert.equal(f.cards.has("wrong-generation"), false);
});

test("replayed old, newly queued, live real and deep children retain reveal paths", t => {
  const f = setup(t), group = f.group(4), lazy = group.tool("parent", "Agent", {}, true);
  for (let i = 0; i < 80; i++) lazy.sub("child" + i, "Read", { file_path: "/synthetic/child" + i });
  const old = f.cards.get("child5"); old.result(true, "Child result");
  const parent = lazy.reveal(), queued = f.cards.get("child5");
  assert.notEqual(queued, old); assert.equal(old.disposed, true); assert.equal(queued.lazy, true); assert.equal(typeof queued.reveal, "function");
  const child = queued.reveal(); assert.equal(child.id, "child5"); assert.ok(child.el.isConnected && child.el.getClientRects().length); assert.equal(child.state, "ok");
  const perm = f.document.createElement("div"); perm.className = "perm"; child.el.after(perm);
  assert.equal(perm.parentNode, child.el.parentNode, "permission can mount next to the exact revealed step");
  const live = parent.sub("new-real", "Read", {}); assert.equal(live.reveal(), live); assert.ok(live.el.isConnected);
  parent.el.querySelector(".ts-head").click(); const fresh = parent.sub("new-lazy", "Read", {});
  assert.equal(fresh.lazy, true); assert.ok(fresh.reveal().el.isConnected);
  const nested = parent.sub("nested-agent", "Agent", {}); nested.sub("grandchild", "Read", {});
  const grandchild = f.cards.get("grandchild").reveal(); assert.equal(grandchild.id, "grandchild"); assert.ok(grandchild.el.isConnected);
  group.dispose(); assert.equal(f.cards.size, 0);
});

for (const depth of [1, 2]) for (const image of [false, true]) test("parked depth-" + depth + " child " + (image ? "image" : "failure") + " remounts its parent without changing top-level counts", t => {
  const f = setup(t), group = f.group(100, true, 5), parent = f.cards.get("t5").reveal();
  parent.openSub();
  let owner = parent;
  if (depth === 2) { owner = parent.sub("nested-agent", "Agent", {}); owner.openSub(); }
  const child = owner.sub("late-child", "Read", { file_path: "/synthetic/child" });
  assert.ok(child.el.isConnected && child.el.getClientRects().length);
  f.cards.get("t99").reveal(); assert.equal(parent.el.isConnected, false); assert.equal(child.el.isConnected, false);
  child.result(image, image ? "/synthetic/late-child.png" : "Late child failure");
  assert.ok(parent.el.isConnected && child.el.isConnected && child.el.getClientRects().length, "nested attention reattaches its parked entry");
  assert.equal(rows(group), 41, "only the attention entry is added outside the forty-row page");
  if (image) assert.ok(child.el.querySelector(".tool-peek")?.querySelector(".inline-img"));
  else assert.ok(child.el.querySelector(".tool-body").textContent.includes("Late child failure"));
  for (let i = 0; i < 100; i++) f.cards.get("t" + i).result(true, "Done");
  assert.equal(status(group).textContent, "完成", "nested states must not inflate top-level summary counts");
  if (image) child.el.querySelector("img").dispatchEvent({ type: "error", bubbles: false });
  else child.el.querySelector(".tool-head").click();
  f.cards.get("t99").reveal(); assert.equal(parent.el.isConnected, false); assert.equal(rows(group), 40, "dismissed attention releases its entry");
});

test("parked child ordinary success stays parked and explicit folding still hides late child errors", t => {
  const f = setup(t), group = f.group(100, true, 5), parent = f.cards.get("t5").reveal();
  parent.openSub(); const child = parent.sub("late-child", "Read", {});
  f.cards.get("t99").reveal(); child.result(true, "Ordinary success");
  assert.equal(parent.el.isConnected, false); assert.equal(rows(group), 40);
  child.result(false, "Late child failure"); assert.ok(child.el.isConnected && child.el.getClientRects().length);
  group.el.querySelector(".tg-head").click(); child.result(false, "Failure after explicit fold");
  assert.ok(group.el.classList.contains("shut")); assert.equal(child.el.getClientRects().length, 0);
});

test("400 completed reveals remain bounded; pending permission stays visible then unpins", t => {
  const f = setup(t), group = f.group(400, false);
  for (let i = 0; i < 400; i++) f.cards.get("t" + i).result(true, "Done " + i);
  for (let i = 0; i < 400; i++) f.cards.get("t" + i).reveal();
  assert.equal(rows(group), 40); assert.equal(status(group).textContent, "完成");
  const first = f.cards.get("t0").reveal(), perm = f.document.createElement("div"); perm.className = "perm"; first.el.after(perm);
  f.cards.get("t399").reveal(); assert.equal(rows(group), 41); assert.ok(perm.isConnected && perm.getClientRects().length);
  group.el.querySelector(".tg-head").click(); assert.ok(perm.isConnected && perm.getClientRects().length, "explicit fold must not hide pending permission");
  assert.equal(rows(group), 1); perm.classList.add("done");
  group.el.querySelector(".tg-head").click(); assert.equal(rows(group), 40); assert.equal(perm.isConnected, false);
  for (let i = 0; i < 110; i++) {
    const card = f.cards.get("t" + i).reveal(), p = f.document.createElement("div"); p.className = "perm"; card.el.after(p); p.classList.add("done");
  }
  group.el.querySelector(".tg-head").click(); group.el.querySelector(".tg-head").click();
  assert.equal(rows(group), 40); assert.ok(group.retained().nodes > 0); assert.ok(group.retained().chars > 0);
  group.dispose(); assert.equal(group.retained().nodes, 0); assert.equal(group.retained().chars, 0); assert.equal(f.cards.size, 0);
});
