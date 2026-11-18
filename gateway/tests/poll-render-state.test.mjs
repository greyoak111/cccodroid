// Real frontend functions, synthetic DOM: no gateway, credentials, network or child processes.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const web = process.env.CCAPP_TEST_WEB || fileURLToPath(new URL("../web/", import.meta.url));
const read = name => fs.readFileSync(path.join(web, "app", name), "utf8");
const take = (text, start, end) => {
  const a = text.indexOf(start), b = text.indexOf(end, a);
  assert.ok(a >= 0 && b > a, start);
  return text.slice(a, b);
};
const fill = (s, v = {}) => s.replace(/\{(\w+)\}/g, (m, k) => k in v ? String(v[k]) : m);
function classes(initial = []) {
  const set = new Set(initial);
  return {
    add: k => set.add(k), remove: k => set.delete(k), contains: k => set.has(k),
    toggle: (k, on) => on ? set.add(k) : set.delete(k),
  };
}

function components() {
  const src = read("08-extensions.js"), nodes = new Map();
  let count = 0;
  const make = id => ({ id, innerHTML: "", textContent: "", dataset: {}, classList: classes(), addEventListener() {}, querySelectorAll() { return []; } });
  const node = id => {
    if (id === "gh-auth" || id === "llm-dl") return null;
    if (!nodes.has(id)) nodes.set(id, make(id));
    return nodes.get(id);
  };
  const box = node("comp-list");
  let html = "", cards = [];
  Object.defineProperty(box, "innerHTML", {
    get: () => html,
    set: s => {
      html = s; count++;
      cards = [...s.matchAll(/data-comp="([^"]+)"/g)].map(m => ({ dataset: { comp: m[1] }, classList: classes() }));
    },
  });
  box.querySelectorAll = sel => sel === ".ccard.open" ? cards.filter(c => c.classList.contains("open")) : sel === ".ccard" ? cards : [];
  const item = { id: "fixture", name: "Fixture", desc: "Synthetic", state: "downloading", available: true, bytes: 100, installed: 100, version: "1", installedVersion: "1", bin: [], requires: [], verified: true, progress: { done: 1, total: 100 } };
  const listing = { supported: true, items: [item] };
  const ctx = {
    window: {}, document: { querySelectorAll: () => [] }, localStorage: { getItem: () => null },
    $: node, t: fill, tk: x => x, esc: x => String(x ?? ""), api: async () => listing,
    extOffNow: async () => ({ comp: [] }), pickLang: x => x, webUrl: () => false, pageOn: () => true,
    setPageSub() {}, extSub() {}, paintStorage() {}, renderIdx() {}, loadGhField() {},
    setTimeout: () => 1, clearTimeout() {},
  };
  vm.runInNewContext(src + "\nthis.ui = { loadComponents };", ctx);
  return { item, box, load: ctx.ui.loadComponents, card: () => cards[0], writes: () => count };
}

test("unchanged component polls retain nodes, detail expansion and focusable buttons", async () => {
  const u = components(); await u.load();
  const card = u.card(); card.classList.add("open");
  const writes = u.writes();
  await u.load();
  assert.equal(u.writes(), writes);
  assert.equal(u.card(), card);
  assert.ok(card.classList.contains("open"));
});

test("changed progress restores expansion by component id; a removed id cannot transfer it", async () => {
  const u = components(); await u.load(); u.card().classList.add("open");
  const first = u.card(); u.item.progress.done++;
  await u.load();
  assert.notEqual(u.card(), first);
  assert.ok(u.card().classList.contains("open"));
  u.item.id = "replacement"; await u.load();
  assert.equal(u.card().classList.contains("open"), false);
});

test("component mutation invalidation permits failed or cancelled button state to refresh", async () => {
  const u = components(); await u.load();
  const before = u.writes(); u.box._html = null;
  await u.load();
  assert.equal(u.writes(), before + 1);
  const src = read("08-extensions.js");
  assert.match(src, /c === "reindex"[^\n]+_html = null/);
  assert.match(src, /cb\.disabled = true; \$\("comp-list"\)\._html = null;/);
});

function scheduler() {
  const src = read("14-projects-sched.js"), code = take(src, "  async function renderSched()", "  async function runTaskNow(");
  const page = { scrollTop: 120 }, listeners = new Map(), requests = [], toasts = [];
  let writes = 0, rows = [], pause;
  const box = {
    _taskId: null, _taskHtml: null, querySelectorAll: () => rows,
    addEventListener: (type, fn) => {
      const list = listeners.get(type) || [];
      list.push(fn); listeners.set(type, list);
    },
  };
  Object.defineProperty(box, "innerHTML", {
    set: html => {
      writes++;
      pause = { value: html.match(/<option value="([^"]+)" selected>/)?.[1] };
      rows = [...html.matchAll(/data-full="(\d+)"/g)].map(m => {
        let full = null;
        return { dataset: { full: m[1] }, querySelector: s => s === ".sc-full" ? full : { appendChild: n => full = n } };
      });
    },
  });
  const task = { id: "t", name: "Synthetic", prompt: "read only", freq: { kind: "every" }, on: true, skipNext: false, pausedUntil: 0 };
  const sc = { cur: "t", rflt: "all", detail: { task, runs: [{ at: 100, attempt: 1, st: "ok", msg: "summary", full: "first result" }], runsTotal: 1 } };
  const ctx = {
    SC: sc, $: id => id === "tab-sched" ? box : page, document: { createElement: () => ({}) },
    t: fill, esc: x => String(x ?? ""), navMo() {}, setOv() {}, setPageSub() {}, loadSched() {},
    toast: (...args) => toasts.push(args),
    jsend: async (url, body) => { requests.push({ url, body }); throw new Error("Synthetic request rejected"); },
    freqText: () => "", pjById: () => null, prettyModel: x => x, costText: () => "", whenText: () => "", durText: () => "",
    stIcon: () => "", pi: () => "", segOf: () => "", swHtml: () => "", pageHead: () => "", kebabBtn: () => "",
    renderMd: x => x, emptyRow: () => "", api: async () => sc.detail,
  };
  vm.runInNewContext(code + "\nthis.render = renderSched;", ctx);
  return {
    sc, box, page, requests, toasts, render: () => ctx.render(), rows: () => rows, writes: () => writes, pause: () => pause,
    async changePause(value) {
      const target = pause; target.value = value;
      for (const fn of listeners.get("change") || []) await fn({ target: { closest: s => s === "[data-pause]" ? target : null } });
    },
  };
}

test("identical scheduler poll retains the expanded original node", async () => {
  const u = scheduler(); await u.render();
  const row = u.rows()[0], full = { innerHTML: "first result" };
  row.querySelector(".grow").appendChild(full);
  const before = u.writes();
  await u.render();
  assert.equal(u.writes(), before);
  assert.equal(u.rows()[0], row);
  assert.equal(row.querySelector(".sc-full"), full);
});

test("failed pause selection rolls back the control without losing expanded output", async () => {
  const u = scheduler(); await u.render(); u.rows()[0].querySelector(".grow").appendChild({});
  const before = u.writes(); await u.changePause("1d");
  assert.equal(u.requests.length, 1);
  assert.equal(u.requests[0].url, "/api/sched/t/pause");
  assert.equal(u.requests[0].body.mode, "1d");
  assert.equal(u.sc.detail.task.pausedUntil, 0);
  assert.equal(u.pause().value, "none");
  assert.equal(u.writes(), before + 1);
  assert.ok(u.rows()[0].querySelector(".sc-full"));
  assert.equal(u.page.scrollTop, 120);
  assert.equal(u.toasts[0][0], "Synthetic request rejected");
  const restored = u.writes(); await u.render();
  assert.equal(u.writes(), restored);
});

test("changed scheduler status keeps only the same run expanded, never another task or changed result", async () => {
  const u = scheduler(); await u.render(); u.rows()[0].querySelector(".grow").appendChild({});
  u.sc.detail.running = true; await u.render();
  assert.ok(u.rows()[0].querySelector(".sc-full"));
  assert.equal(u.page.scrollTop, 120);
  u.sc.detail.runs[0] = { ...u.sc.detail.runs[0], full: "changed result" }; await u.render();
  assert.equal(u.rows()[0].querySelector(".sc-full"), null);
  u.rows()[0].querySelector(".grow").appendChild({});
  u.sc.cur = "other"; u.sc.detail = { ...u.sc.detail, task: { ...u.sc.detail.task, id: "other" } }; await u.render();
  assert.equal(u.rows()[0].querySelector(".sc-full"), null);
});
