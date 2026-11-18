import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const web = process.env.CCAPP_TEST_WEB || fileURLToPath(new URL("../web/", import.meta.url));
const sessionsJs = fs.readFileSync(path.join(web, "app/07-sessions.js"), "utf8");
const pagesJs = fs.readFileSync(path.join(web, "app/14-projects-sched.js"), "utf8");
const openPageJs = pagesJs.slice(pagesJs.indexOf("  function openPage(name, cat) {"), pagesJs.indexOf("  function closePage() {"));
assert.ok(openPageJs.startsWith("  function openPage(name, cat) {"));

function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, bad) => { resolve = ok; reject = bad; });
  return { promise, resolve, reject };
}

function fixture() {
  const elements = new Map(), storage = new Map(), timers = new Map(), counts = { recent: 0, nav: 0 };
  let timerId = 0, apiHandler = async () => ({ sessions: [], total: 0 });
  class Element {
    constructor(id) {
      this.id = id; this.writes = 0; this.listeners = new Map(); this.html = ""; this.text = ""; this.children = [];
      const classes = new Set();
      this.classList = {
        contains: c => classes.has(c),
        add: (...cs) => cs.forEach(c => classes.add(c)),
        remove: (...cs) => cs.forEach(c => classes.delete(c)),
        toggle: (c, on) => {
          const add = on === undefined ? !classes.has(c) : on;
          if (add) classes.add(c); else classes.delete(c);
          return add;
        },
      };
    }
    set innerHTML(value) { this.html = value; this.writes++; this.children = Array.from({ length: (value.match(/<button\b/g) || []).length }); }
    get innerHTML() { return this.html; }
    set textContent(value) { this.text = value; this.writes++; }
    get textContent() { return this.text; }
    addEventListener(type, fn) { const list = this.listeners.get(type) || []; list.push(fn); this.listeners.set(type, list); }
    dispatchEvent(event) { event.target = this; for (const fn of this.listeners.get(event.type) || []) fn(event); return true; }
  }
  const $ = id => { if (!elements.has(id)) elements.set(id, new Element(id)); return elements.get(id); };
  $("pages").classList.add("hidden");
  const tokens = new Map();
  const context = vm.createContext({
    $, console, Event: class { constructor(type) { this.type = type; } },
    document: { documentElement: $("html"), querySelectorAll: () => [$("tab-sessions"), $("tab-ext")] },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    state: { sessions: [], sessTotal: 0, sessErr: "" }, view: { sessionId: null }, srv: { runs: [], intr: [], queueAll: [] },
    PJ: { list: [], cur: null }, SC: { cur: null }, PAGES: { sessions: {}, ext: {} }, SUBNAVS: {}, LIN: {},
    curPage: null, pageSub: "", pageTitleOv: "", innerWidth: 412,
    pageOn: name => context.curPage === name && !$("pages").classList.contains("hidden"),
    renderSideRecent: () => counts.recent++, renderSideNav: () => counts.nav++,
    latest: key => { const n = (tokens.get(key) || 0) + 1; tokens.set(key, n); return () => tokens.get(key) === n; },
    api: (...args) => apiHandler(...args), lineageDirty() {},
    setTimeout: fn => { const id = ++timerId; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id),
    t: (text, vars) => text.replace(/\{(\w+)\}/g, (m, key) => vars && key in vars ? String(vars[key]) : m),
    esc: value => String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
    fmtSize: n => String(n), relTime: n => String(n), pi: () => "", SM: { pin: "", trash: "" },
    schedSids: () => new Set(), pjOfCwd: () => null, pjMark: () => "", setPageSub() {},
    canSaveAs: () => false, canShare: () => false,
    OV: { closeAll() {} }, MO: { cancel() {}, play() {}, ghost() {} },
    closeTour() {}, paintTitle() {}, closeDrawer() {}, refreshStatus() {}, schedPollSet() {}, loadExt() {},
  });
  vm.runInContext(sessionsJs + "\nglobalThis.sessionTest = { sess, renderSessions, loadSessions, loadTrash, selShown };\n" + openPageJs, context);
  return {
    context, ...context.sessionTest, $, counts, timers,
    api(fn) { apiHandler = fn; },
    show() { context.curPage = "sessions"; $("pages").classList.remove("hidden"); },
    hide() { context.curPage = null; $("pages").classList.add("hidden"); },
    input(value) { $("sess-q").value = value; $("sess-q").dispatchEvent(new context.Event("input")); },
    runTimer() { const [id, fn] = timers.entries().next().value; timers.delete(id); return fn(); },
    async clickBar(action) { for (const fn of $("sess-bar").listeners.get("click") || []) await fn({ target: { closest: () => ({ dataset: { b: action } }) } }); },
  };
}

function row(id, extra = {}) {
  return { id, title: "Session " + id, mtime: Date.now(), created: Date.now(), sizeKb: 1, cwd: "", ...extra };
}
const ids = list => Array.from(list);
const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

test("hidden session page skips all list work but still updates sidebar and navigation", () => {
  const f = fixture();
  f.context.state.sessions = Array.from({ length: 1500 }, (_, i) => row(String(i)));
  f.sess.mode = "select"; f.sess.visible = ["preserved"]; f.sess.sel.add("preserved");
  f.$("session-list").innerHTML = "old nodes";
  const writes = f.$("session-list").writes;
  for (let i = 0; i < 10; i++) f.renderSessions();
  assert.equal(f.$("session-list").writes, writes);
  assert.equal(f.$("session-list").innerHTML, "old nodes");
  assert.equal(f.$("sess-bar").writes, 0);
  assert.equal(f.$("sess-flt").writes, 0);
  assert.equal(f.counts.recent, 10); assert.equal(f.counts.nav, 10);
  assert.deepEqual(ids(f.sess.visible), ["preserved"]);
  assert.deepEqual(ids(f.sess.sel), ["preserved"]);
});

test("a hidden pages container or another page also skips the session list", () => {
  const f = fixture(); f.context.state.sessions = [row("one")];
  f.context.curPage = "sessions"; f.renderSessions();
  assert.equal(f.$("session-list").writes, 0);
  f.$("pages").classList.remove("hidden"); f.context.curPage = "ext"; f.renderSessions();
  assert.equal(f.$("session-list").writes, 0);
  assert.equal(f.counts.recent, 2); assert.equal(f.counts.nav, 2);
});

test("opening sessions renders current memory immediately, then accepts only latest refresh", async () => {
  const f = fixture(), older = deferred(), fresh = deferred();
  let calls = 0;
  f.api(() => ++calls === 1 ? older.promise : fresh.promise);
  f.context.state.sessions = [row("cached", { title: "Memory is current" })];
  const pending = f.loadSessions();
  f.context.openPage("sessions");
  assert.match(f.$("session-list").innerHTML, /Memory is current/);
  assert.equal(calls, 2);
  fresh.resolve({ sessions: [row("fresh", { title: "Newest response" })], total: 1 });
  await settle();
  assert.match(f.$("session-list").innerHTML, /Newest response/);
  older.resolve({ sessions: [row("stale", { title: "Stale response" })], total: 1 });
  await pending;
  assert.match(f.$("session-list").innerHTML, /Newest response/);
  assert.doesNotMatch(f.$("session-list").innerHTML, /Stale response/);
});

test("a refresh that finishes after leaving updates memory without touching hidden list", async () => {
  const f = fixture(), response = deferred(); f.show();
  f.context.state.sessions = [row("before")]; f.renderSessions();
  f.api(() => response.promise); const pending = f.loadSessions(); f.hide();
  const writes = f.$("session-list").writes;
  response.resolve({ sessions: [row("after")], total: 1 }); await pending;
  assert.equal(f.context.state.sessions[0].id, "after");
  assert.equal(f.$("session-list").writes, writes);
  f.show(); f.renderSessions();
  assert.deepEqual(ids(f.sess.visible), ["after"]);
});

test("search filters use local metadata when available and hit metadata outside the recent window", () => {
  const f = fixture(); f.show();
  f.context.state.sessions = [row("local-pin", { pinned: true }), row("local-plain", { pinned: false })];
  f.context.state.sessions.find = () => { throw new Error("per-hit full session scans are forbidden"); };
  f.sess.q = "search"; f.sess.flt = "pin";
  f.sess.hits = [
    row("local-pin", { title: "Server title", pinned: false, snippet: "Matched body", count: 2 }),
    row("local-plain", { pinned: true }),
    row("outside-pin", { pinned: true }), row("outside-plain", { pinned: false }),
  ];
  f.sess.mode = "select";
  ["local-pin", "local-plain", "outside-pin", "outside-plain", "removed"].forEach(id => f.sess.sel.add(id));
  f.renderSessions();
  assert.deepEqual(ids(f.sess.visible), ["local-pin", "outside-pin"]);
  assert.deepEqual(ids(f.selShown()), ["local-pin", "outside-pin"]);
  assert.deepEqual(ids(f.sess.sel), ["local-pin", "outside-pin"]);
  assert.match(f.$("session-list").innerHTML, /Server title/);
  assert.match(f.$("session-list").innerHTML, /Matched body/);
});

test("local title fallback remains case insensitive, project filters apply to remote hits", () => {
  const f = fixture(); f.show();
  f.context.state.sessions = [row("local", { title: "Alpha NEEDLE", cwd: "/project" }), row("other", { title: "No match" })];
  f.sess.q = "needle"; f.renderSessions();
  assert.deepEqual(ids(f.sess.visible), ["local"]);
  assert.match(f.$("session-list").innerHTML, /<mark>NEEDLE<\/mark>/);
  f.context.PJ.list = [{ id: "project", name: "Project" }];
  f.context.pjOfCwd = cwd => cwd === "/project" ? { id: "project" } : null;
  f.sess.flt = "p:project";
  f.sess.hits = [row("outside-in", { cwd: "/project" }), row("outside-out", { cwd: "/elsewhere" })];
  f.renderSessions();
  assert.deepEqual(ids(f.sess.visible), ["outside-in"]);
});

test("duplicate IDs preserve first local metadata precedence for search filters", () => {
  const f = fixture(); f.show();
  f.context.PJ.list = [{ id: "project", name: "Project" }];
  f.context.pjOfCwd = cwd => cwd === "/project" ? { id: "project" } : null;
  f.context.state.sessions = [
    row("duplicate", { cwd: "/project", pinned: true, mtime: 200 }),
    row("duplicate", { cwd: "/elsewhere", pinned: false, mtime: 100 }),
  ];
  f.context.state.sessions.find = () => { throw new Error("per-hit full session scans are forbidden"); };
  f.sess.q = "needle";
  f.sess.hits = [row("duplicate", { cwd: "/elsewhere", pinned: false, snippet: "needle" })];
  for (const filter of ["p:project", "pin"]) {
    f.sess.flt = filter; f.renderSessions();
    assert.deepEqual(ids(f.sess.visible), ["duplicate"]);
  }
});

test("visible folded groups and multi-select operate only on rendered rows", async () => {
  const f = fixture(); f.show();
  f.context.state.sessions = [row("one"), row("two"), row("misc", { misc: true })];
  f.context.view.sessionId = "one"; f.sess.mode = "select"; f.sess.fold.today = true;
  f.sess.sel.add("one"); f.sess.sel.add("two");
  f.renderSessions();
  assert.deepEqual(ids(f.sess.visible), ["one", "misc"]);
  assert.deepEqual(ids(f.sess.sel), ["one"]);
  assert.deepEqual(ids(f.sess.misc), ["misc"]);
  await f.clickBar("all");
  assert.deepEqual(ids(f.selShown()), ["one", "misc"]);
  await f.clickBar("all");
  assert.deepEqual(ids(f.selShown()), []);
});

test("trash data and errors refresh while hidden and render on re-entry", async () => {
  const f = fixture(); f.sess.mode = "trash";
  f.api(async () => ({ items: [row("trash", { deletedAt: Date.now(), size: 2048 })], keepDays: 7 }));
  await f.loadTrash();
  assert.equal(f.$("session-list").writes, 0);
  f.show(); f.renderSessions();
  assert.match(f.$("session-list").innerHTML, /Session trash/);
  assert.match(f.$("sess-bar").innerHTML, /7/);
  f.hide(); const writes = f.$("session-list").writes;
  f.api(async () => { throw new Error("synthetic offline"); }); await f.loadTrash();
  assert.equal(f.$("session-list").writes, writes);
  f.show(); f.renderSessions();
  assert.match(f.$("session-list").innerHTML, /synthetic offline/);
  assert.match(f.$("session-list").innerHTML, /Session trash/);
});

test("re-entering trash paints cached rows before requesting fresh trash data", async () => {
  const f = fixture(), sessions = deferred(), trash = deferred();
  f.sess.mode = "trash"; f.sess.trash = [row("cached-trash", { deletedAt: Date.now() })];
  f.api(url => url === "/api/trash" ? trash.promise : sessions.promise);
  f.context.openPage("sessions");
  assert.match(f.$("session-list").innerHTML, /Session cached-trash/);
  trash.resolve({ items: [row("fresh-trash", { deletedAt: Date.now() })], keepDays: 10 }); await settle();
  assert.match(f.$("session-list").innerHTML, /Session fresh-trash/);
  sessions.resolve({ sessions: [], total: 0 }); await settle();
  assert.match(f.$("session-list").innerHTML, /Session fresh-trash/);
});

test("late search replies do not replace newer results or rebuild after leaving", async () => {
  const f = fixture(), first = deferred(), second = deferred(), hidden = deferred(); f.show();
  f.context.state.sessions = [row("local")];
  let calls = 0; f.api(() => [first.promise, second.promise, hidden.promise][calls++]);
  f.input("first"); const oldRequest = f.runTimer();
  f.input("second"); const newRequest = f.runTimer();
  second.resolve({ results: [row("second")], total: 1 }); await newRequest;
  assert.deepEqual(ids(f.sess.visible), ["second"]);
  first.resolve({ results: [row("first")], total: 1 }); await oldRequest;
  assert.deepEqual(ids(f.sess.visible), ["second"]);
  f.input("hidden"); const hiddenRequest = f.runTimer(); f.hide();
  const writes = f.$("session-list").writes;
  hidden.resolve({ results: [row("hidden")], total: 1 }); await hiddenRequest;
  assert.equal(f.$("session-list").writes, writes);
  f.show(); f.renderSessions();
  assert.deepEqual(ids(f.sess.visible), ["hidden"]);
});
