// Small DOM/VM tests only. No real gateway, relay, credentials, sessions or WebView.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const WEB = new URL("../web/", import.meta.url);
const source = fs.readFileSync(new URL("app/13q-remote-component-host.js", WEB), "utf8");
const versionA = "a".repeat(64), versionB = "b".repeat(64);
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const feature = (state = "active", extra = {}) => ({ ok: true, id: "remote-session", hostApi: 1, installed: state !== "absent", enabled: state === "active", state, version: state === "absent" ? null : "1.0", assetVersion: state === "absent" ? null : versionA, activationId: state === "active" ? "11111111-1111-4111-8111-111111111111" : null, error: null, ...extra });

class Target {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, fn, options) {
    const capture = typeof options === "boolean" ? options : !!options?.capture;
    const listeners = this.listeners.get(type) || [];
    if (!listeners.some((x) => x.fn === fn && x.capture === capture)) listeners.push({ fn, capture });
    this.listeners.set(type, listeners);
  }
  removeEventListener(type, fn, options) {
    const capture = typeof options === "boolean" ? options : !!options?.capture;
    this.listeners.set(type, (this.listeners.get(type) || []).filter((x) => x.fn !== fn || x.capture !== capture));
  }
  dispatchEvent(event) { for (const { fn } of [...(this.listeners.get(event.type) || [])]) typeof fn === "function" ? fn.call(this, event) : fn.handleEvent(event); return true; }
}
class Node extends Target {
  constructor(tag, document) { super(); this.nodeType = 1; this.tagName = tag.toUpperCase(); this.document = document; this.id = ""; this.dataset = {}; this.children = []; this.parentNode = null; this.hidden = false; this._html = ""; this._text = ""; this.classes = new Set(); this.attributes = {}; this.value = "";
    this.classList = { add: (...v) => v.forEach((x) => this.classes.add(x)), remove: (...v) => v.forEach((x) => this.classes.delete(x)), contains: (v) => this.classes.has(v), toggle: (v, on) => { on = on === undefined ? !this.classes.has(v) : on; if (on) this.classes.add(v); else this.classes.delete(v); return on; } };
  }
  get className() { return [...this.classes].join(" "); } set className(v) { this.classes = new Set(v.split(/\s+/).filter(Boolean)); }
  get innerHTML() { return this._html; } set innerHTML(v) { this._html = v; this.children.forEach((n) => { n.parentNode = null; }); this.children = []; }
  get textContent() { return this._text; } set textContent(v) { this._text = v; this.innerHTML = ""; }
  get isConnected() { return this === this.document.documentElement || !!this.parentNode?.isConnected; }
  appendChild(n) { n.remove(); this.children.push(n); n.parentNode = this; return n; }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((x) => x !== this); this.parentNode = null; }
  replaceChildren(...nodes) { this.innerHTML = ""; nodes.forEach((n) => this.appendChild(n)); }
  replaceWith(n) { const parent = this.parentNode; if (!parent) return; parent.children.splice(parent.children.indexOf(this), 1, n); n.parentNode = parent; this.parentNode = null; }
  contains(n) { for (; n; n = n.parentNode) if (n === this) return true; return false; }
  setAttribute(k, v) { this.attributes[k] = String(v); } getAttribute(k) { return this.attributes[k] ?? null; }
  getClientRects() { return this.isConnected && !this.hidden && !this.classList.contains("hidden") ? [{}] : []; }
  querySelector() { return null; } querySelectorAll() { return []; }
}
function host(initial = feature("absent")) {
  const document = new Target(), box = new Target(), timers = new Map(), calls = [], observers = [], toasts = [], opens = [], overlays = new Set();
  let timer = 0, listing = initial, handler = null, navRenders = 0, settingsPaints = 0, closedPages = 0;
  document.documentElement = new Node("html", document); document.head = new Node("head", document); document.body = new Node("body", document);
  document.documentElement.appendChild(document.head); document.documentElement.appendChild(document.body); document.hidden = false; document.currentScript = null;
  document.createElement = (tag) => new Node(tag, document);
  const descend = (root) => [root, ...root.children.flatMap(descend)];
  document.getElementById = (id) => descend(document.documentElement).find((x) => x.id === id) || null;
  const node = (id, parent = document.body) => { const n = document.createElement("div"); n.id = id; parent.appendChild(n); return n; };
  const tab = node("tab-remote"), root = node("remotePage", tab), cat = node("remote-category"), settings = node("remoteSettingsPage", cat), button = node("remote-category-button");
  root.hidden = settings.hidden = button.hidden = true; root.className = settings.className = button.className = "hidden"; cat.dataset.cat = button.dataset.cat = "remote";
  document.querySelector = (query) => query.startsWith("#set-cats") ? button : query.startsWith('.set-cat[data-cat="remote"]') ? cat : null;
  document.querySelectorAll = () => [];
  box.window = box; box.document = document; box.globalThis = box; box.EventTarget = Target;
  box.t = (s, vars = {}) => String(s).replace(/\{(\w+)\}/g, (m, k) => k in vars ? vars[k] : m);
  box.AbortController = AbortController; box.TextEncoder = TextEncoder; box.URL = URL; box.crypto = globalThis.crypto; box.console = console;
  box.CustomEvent = class { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } };
  box.EventSource = class { constructor(url) { calls.push({ stream: url }); } close() { calls.push({ closed: true }); } addEventListener() {} };
  box.MutationObserver = class { constructor(fn) { this.fn = fn; this.disconnected = false; observers.push(this); } observe(target, options) { this.target = target; this.options = options; } disconnect() { this.disconnected = true; } };
  box.setTimeout = (fn, delay) => { timers.set(++timer, { fn, delay }); return timer; }; box.clearTimeout = (id) => timers.delete(id);
  box.fetch = async (url) => { calls.push({ fetch: url }); return { ok: false, status: 503, headers: { get: () => null }, json: async () => ({ error: { code: "OFFLINE" } }) }; };
  box.api = async (url, opts = {}) => {
    calls.push({ url, opts }); if (handler) return handler(url, opts);
    if (url.endsWith("/status")) return typeof listing === "function" ? listing() : structuredClone(listing);
    if (url.endsWith("/enable") || url.endsWith("/disable")) return { ok: true, component: structuredClone(listing) };
    if (url === "/api/remote/settings") return { ok: true, serverUrl: "", deviceName: "test", hasCredential: false, connection: { state: "unconfigured", checkedAt: 0 }, reminders: { enabled: false, permission: "unsupported", background: "unsupported" } };
    if (url === "/api/remote/pairing") return { ok: true, devices: [], pending: [] };
    throw new Error("Unexpected API " + url);
  };
  box.OV = {
    open(el, opts = {}) { overlays.add(el); el._options = opts; document.body.appendChild(el); return el; },
    close(el) { if (overlays.delete(el)) el._options?.onClose?.(); el.remove(); },
    closeAll(kind) { if (kind === "menu") return; for (const el of [...overlays]) this.close(el); },
  };
  box.curPage = null; box.remotePendingCount = 0; box.setOpen = false; box.setCatOpen = null;
  box.openPage = (page, catName) => { opens.push([page, catName]); if (page === "settings") { box.setOpen = true; box.setCatOpen = catName; } else box.curPage = page; };
  box.closePage = () => { closedPages++; box.curPage = null; }; box.closeSettings = () => { box.setOpen = false; };
  box.renderSideNav = () => navRenders++; box.paintSetCats = () => settingsPaints++; box.toast = (text, error) => toasts.push({ text, error });
  // Test-only counts of the host's strong registries, not heap/GC measurement.
  // Keep this hook out of the shipped API and return no retained DOM references.
  const returnHost = "    return { remoteComponent: component, remoteView: view, remoteSettings: settings, remoteHosting: hosting, remoteTransport: transport };";
  const inspected = source.replace(returnHost, "    globalThis.testRemoteResources = () => runtime && ({ listeners: runtime.listeners.length, overlays: runtime.overlays.size, observers: runtime.observers.size });\n" + returnHost);
  assert.notEqual(inspected, source, "resource-count fixture must instrument the actual host closure");
  vm.createContext(box); vm.runInContext(inspected + "\nglobalThis.testHost = { remoteComponent, remoteView, remoteSettings, remoteHosting, remoteTransport };", box);
  const { remoteComponent: component, ...proxies } = box.testHost;
  function fakeRoles() {
    const activity = [], listeners = new Set(); let draft = "", dead = false;
    const transport = {};
    for (const method of ["status", "list", "open", "accept", "decline", "close", "history", "sendText", "respond", "stop", "query"]) transport[method] = async (...args) => { activity.push(["transport", method, ...args]); if (dead) throw new Error("destroyed"); return method === "list" ? [] : { method }; };
    transport.subscribe = (fn) => { activity.push(["transport", "subscribe"]); listeners.add(fn); fn({ sessions: [] }); return () => { listeners.delete(fn); activity.push(["transport", "unsubscribe"]); }; };
    transport.setDraft = (text) => draft = text; transport.getDraft = () => draft; transport.destroy = () => { dead = true; draft = ""; activity.push(["transport", "destroy"]); };
    const roles = { transport };
    for (const role of ["view", "settings", "hosting"]) roles[role] = Object.fromEntries(["open", "close", "refresh"].map((method) => [method, async (...args) => { activity.push([role, method, ...args]); return method; }]));
    return { roles, activity, listeners, emit(value) { for (const fn of listeners) fn(value); } };
  }
  return { component, proxies, box, calls, timers, observers, toasts, opens, document, button, cat, overlays, fakeRoles,
    get closedPages() { return closedPages; }, get navRenders() { return navRenders; }, get settingsPaints() { return settingsPaints; },
    list(value) { listing = value; }, api(fn) { handler = fn; },
    resources() { const value = box.testRemoteResources(); return value && { ...value }; },
    flushMutations(records = []) { for (const observer of [...observers]) if (!observer.disconnected) observer.fn(records, observer); },
    script() { return document.head.children.findLast((x) => x.tagName === "SCRIPT"); }, css() { return document.head.children.findLast((x) => x.tagName === "LINK"); },
    execute(script, fn) { document.currentScript = script; try { return fn(); } finally { document.currentScript = null; } },
    mount(script, roles, extra = {}) { return this.execute(script, () => { const context = box.CCRemoteComponentHost.context; return { context, mounted: box.CCRemoteComponentHost.mount({ ...roles, ...extra }) }; }); },
    async finish(script = this.script(), css = this.css()) { css.onload(); script.onload(); await tick(); },
    async poll() { const entry = [...timers].find(([, x]) => x.delay === 4000); assert.ok(entry, "light status polling exists"); timers.delete(entry[0]); entry[1].fn(); await tick(); },
  };
}

test("remote host: absent/disabled/incompatible never load a bundle or contact remote status", async () => {
  for (const state of ["absent", "disabled", "incompatible", "error", "retiring"]) {
    const h = host(feature(state));
    await h.component.boot();
    assert.equal(h.component.enabled(), false); assert.equal(h.script(), undefined); assert.equal(h.css(), undefined);
    assert.equal(h.button.hidden, true); assert.equal(h.document.getElementById("remoteSettingsPage").hidden, true);
    assert.deepEqual(h.calls.map((c) => c.url), ["/api/components/remote-session/status"]);
    assert.equal(h.timers.size, 0, "never-opened inactive component is not polled");
    await assert.rejects(h.proxies.remoteTransport.accept("invite"), { code: "NOT_CONFIGURED" });
    assert.equal(h.proxies.remoteTransport.getDraft(), "");
    assert.equal(h.box.createRemoteTransport, undefined);
    assert.throws(() => h.box.CCRemoteComponentHost.context, { code: "NOT_CONFIGURED" });
    assert.equal(h.box.CCRemoteComponentHost.mount({ plugin: {} }), false);
  }
});

test("remote host: active loads only pinned same-origin assets, waits for CSS and forwards stable roles", async () => {
  const h = host(), references = { ...h.proxies }, f = h.fakeRoles();
  await h.component.boot(); h.list(feature()); const pending = h.component.refresh(); await tick();
  const script = h.script(), css = h.css();
  assert.equal(script.src, "/api/components/remote-session/ui.js?version=" + versionA);
  assert.equal(css.href, "/api/components/remote-session/ui.css?version=" + versionA);
  const { context, mounted } = h.mount(script, f.roles, { assetVersion: versionA });
  assert.equal(mounted, true); assert.deepEqual(Object.keys(context).sort(), ["OV", "activationId", "api", "t"]); assert.equal(context.activationId, feature().activationId); assert.ok(Object.isFrozen(context));
  script.onload(); await tick(); assert.equal(h.component.enabled(), false, "JS alone cannot expose entries");
  css.onload(); assert.equal(await pending, true); assert.equal(await h.component.ready, true);
  assert.equal(h.component.enabled(), true); assert.equal(h.button.hidden, false);
  await h.proxies.remoteView.open("remote-only"); await h.proxies.remoteHosting.open("local-id");
  assert.ok(f.activity.some((a) => a[0] === "view" && a[1] === "open" && a[2] === "remote-only"));
  assert.ok(f.activity.some((a) => a[0] === "hosting" && a[1] === "open" && a[2] === "local-id"));
  h.box.remoteTransport = f.roles.transport; assert.equal(h.box.remoteTransport, references.remoteTransport);
  let snapshot; const off = h.proxies.remoteTransport.subscribe((v) => snapshot = v);
  f.emit({ sessions: [{ state: "invited" }, { state: "active", pendingCount: 2 }] });
  assert.equal(h.box.remotePendingCount, 3); assert.equal(snapshot.sessions.length, 2); off();
  await context.api("/api/remote/settings", { headers: { "x-cc-remote-activation": "stale" } });
  assert.equal(h.calls.at(-1).opts.headers["x-cc-remote-activation"], context.activationId);
  await assert.rejects(context.api("/api/settings"), { code: "NOT_CONFIGURED" });
  await assert.rejects(context.api("https://other.invalid/api/remote/settings"), { code: "NOT_CONFIGURED" });
  await h.proxies.remoteSettings.open(); assert.deepEqual(h.opens.at(-1), ["settings", "remote"]);
});

test("remote host: disable closes UI, destroys transport, cancels captured observers/listeners and clears drafts", async () => {
  const h = host(feature()), f = h.fakeRoles(); const pending = h.component.boot(); await tick();
  const originalAdd = h.box.addEventListener, originalObserver = h.box.MutationObserver;
  let context, events = 0, transportCalls = 0;
  h.execute(h.script(), () => {
    context = h.box.CCRemoteComponentHost.context;
    h.box.countComponentEvent = () => events++;
    vm.runInContext('window.addEventListener("blur", countComponentEvent); document.addEventListener("component-global", countComponentEvent);', h.box);
    new h.box.MutationObserver(() => {}).observe(h.document.body, { subtree: true });
    assert.equal(h.box.CCRemoteComponentHost.mount(f.roles), true);
  });
  assert.equal(h.box.addEventListener, originalAdd); assert.equal(h.box.MutationObserver, originalObserver);
  await h.finish(); await pending;
  h.box.dispatchEvent({ type: "blur" }); h.document.dispatchEvent({ type: "component-global" }); assert.equal(events, 2);
  h.proxies.remoteTransport.setDraft("private remote draft");
  const root = h.document.getElementById("remotePage"), settings = h.document.getElementById("remoteSettingsPage");
  root.innerHTML = "private remote content"; root.hidden = false; settings.innerHTML = "private config draft"; settings.hidden = false; settings.dataset.rsReady = "1";
  h.box.curPage = "remote"; h.box.setOpen = true; h.box.setCatOpen = "remote";
  h.box.localSessionId = "unchanged-local-session";
  const overlay = h.document.createElement("div"); overlay.className = "rs-overlay"; let closed = false;
  context.OV.open(overlay, { onClose: () => closed = true });
  const current = h.component.disable();
  assert.equal(h.component.enabled(), false, "disable hides immediately, before response");
  assert.equal(h.proxies.remoteTransport.getDraft(), ""); assert.equal(h.button.hidden, true); assert.equal(h.closedPages, 1);
  assert.equal(h.box.localSessionId, "unchanged-local-session");
  h.list(feature("disabled")); await current;
  assert.equal(h.document.getElementById("remotePage").innerHTML, ""); assert.notEqual(h.document.getElementById("remotePage"), root);
  assert.equal(h.document.getElementById("remoteSettingsPage").innerHTML, ""); assert.equal(h.document.getElementById("remoteSettingsPage").dataset.rsReady, undefined);
  assert.equal(h.document.head.children.length, 0); assert.ok(h.observers.every((o) => o.disconnected)); assert.equal(h.overlays.size, 0); assert.equal(closed, true);
  h.box.dispatchEvent({ type: "blur" }); h.document.dispatchEvent({ type: "component-global" }); assert.equal(events, 2);
  assert.ok(f.activity.some((a) => a[0] === "transport" && a[1] === "destroy"));
  assert.equal(f.listeners.size, 0); assert.ok(!f.activity.some((a) => a[1] === "stop"));
  await assert.rejects(context.api("/api/remote/settings"), { code: "NOT_CONFIGURED" });
  assert.ok(!h.calls.some((c) => c.url?.includes("/api/remote/") || c.fetch));
});

test("remote host: root events capture later modal listeners/observers without owning unrelated core listeners", async () => {
  const h = host(feature()), f = h.fakeRoles(), pending = h.component.boot(); await tick();
  let context, events = 0, coreEvents = 0;
  const root = h.document.getElementById("remotePage"), core = h.document.createElement("button"); h.document.body.appendChild(core);
  h.box.countRemoteEvent = () => events++; h.box.countCoreEvent = () => coreEvents++; h.box.remoteTestRoot = root;
  h.execute(h.script(), () => {
    context = h.box.CCRemoteComponentHost.context;
    vm.runInContext('remoteTestRoot.addEventListener("open-modal", () => { window.addEventListener("modal-global", countRemoteEvent); document.body.children[document.body.children.length - 1].addEventListener("core-action", countCoreEvent); new MutationObserver(() => {}).observe(document.body, {subtree:true}); });', h.box);
    h.box.CCRemoteComponentHost.mount(f.roles);
  });
  await h.finish(); await pending;
  root.dispatchEvent({ type: "open-modal" }); h.box.dispatchEvent({ type: "modal-global" }); core.dispatchEvent({ type: "core-action" });
  assert.equal(events, 1); assert.equal(coreEvents, 1); assert.ok(h.observers.length >= 1);
  h.list(feature("disabled")); await h.component.refresh();
  h.box.dispatchEvent({ type: "modal-global" }); core.dispatchEvent({ type: "core-action" });
  assert.equal(events, 1, "late global component listener was released"); assert.equal(coreEvents, 2, "unrelated core listener remains live"); assert.ok(h.observers.every((o) => o.disconnected));
});

test("remote host: 100 same-activation overlay cycles plateau captured listener registries, not heap", async () => {
  const h = host(feature()), f = h.fakeRoles(), pending = h.component.boot(); await tick();
  let context, events = 0, globals = 0;
  h.execute(h.script(), () => {
    context = h.box.CCRemoteComponentHost.context;
    h.box.countCleanupGlobal = () => globals++;
    vm.runInContext('window.addEventListener("cleanup-global", countCleanupGlobal); document.addEventListener("cleanup-global", countCleanupGlobal);', h.box);
    h.box.CCRemoteComponentHost.mount(f.roles);
  });
  f.roles.view.open = (kind) => {
    const modal = h.document.createElement("div"), child = h.document.createElement("button"); modal.className = kind;
    const types = kind === "rv-modal" ? ["modal-probe", "keydown"] : ["modal-probe", "change", "submit", "click"];
    for (const type of types) modal.addEventListener(type, () => events++);
    modal.appendChild(child); context.OV.open(modal);
    child.addEventListener("child-probe", () => events++);
    return { modal, child, count: types.length + 1 };
  };
  await h.finish(); await pending;
  const baseline = h.resources(), activation = h.component.status().activationId, script = h.script();
  for (let i = 0; i < 100; i++) {
    const { modal, child, count } = await h.proxies.remoteView.open(i % 2 ? "rs-overlay" : "rv-modal");
    assert.equal(h.resources().listeners, baseline.listeners + count);
    assert.equal(h.resources().overlays, baseline.overlays + 1);
    assert.equal(h.resources().observers, baseline.observers, "one shared cleanup observer, not one per close");
    modal.dispatchEvent({ type: "modal-probe" }); child.dispatchEvent({ type: "child-probe" });
    const handled = events;
    context.OV.close(modal);
    h.flushMutations([{ removedNodes: [modal] }]);
    assert.deepEqual(h.resources(), baseline, "detached sheet and descendant registrations return to baseline");
    assert.equal(h.overlays.size, 0);
    assert.equal((modal.listeners.get("modal-probe") || []).length, 0);
    assert.equal((child.listeners.get("child-probe") || []).length, 0);
    modal.dispatchEvent({ type: "modal-probe" }); child.dispatchEvent({ type: "child-probe" });
    assert.equal(events, handled, "registry removal also detaches the actual wrapped handlers");
    h.box.dispatchEvent({ type: "cleanup-global" }); h.document.dispatchEvent({ type: "cleanup-global" });
    assert.equal(globals, (i + 1) * 2, "window/document subscriptions stay live");
  }
  assert.equal(h.component.enabled(), true); assert.equal(h.component.status().activationId, activation); assert.equal(h.script(), script);
  h.list(feature("disabled")); await h.component.refresh();
  h.box.dispatchEvent({ type: "cleanup-global" }); h.document.dispatchEvent({ type: "cleanup-global" });
  assert.equal(globals, 200, "retirement still removes the remaining globals");
});

test("remote host: closing sheets keep listeners through exit animation and release after detach", async () => {
  const h = host(feature()), f = h.fakeRoles(), pending = h.component.boot(); await tick();
  const { context } = h.mount(h.script(), f.roles); let events = 0, closes = 0;
  f.roles.view.open = () => {
    const modal = h.document.createElement("div"), child = h.document.createElement("button"); modal.className = "rv-modal";
    modal.addEventListener("modal-probe", () => events++); modal.appendChild(child);
    context.OV.open(modal, { onClose: () => closes++ }); child.addEventListener("child-probe", () => events++);
    return { modal, child };
  };
  await h.finish(); await pending;
  const baseline = h.resources();
  h.box.OV.close = (el) => { if (h.overlays.delete(el)) el._options?.onClose?.(); }; // Fade has not detached it yet.
  const { modal, child } = await h.proxies.remoteView.open();
  context.OV.close(modal); h.flushMutations([]);
  assert.equal(closes, 1); assert.equal(modal.isConnected, true);
  assert.equal(h.resources().listeners, baseline.listeners + 2); assert.equal(h.resources().overlays, baseline.overlays + 1);
  modal.dispatchEvent({ type: "modal-probe" }); child.dispatchEvent({ type: "child-probe" }); assert.equal(events, 2);
  // Moving a still-connected/reopened sheet must not look like disposal just
  // because MutationObserver reports its earlier removal in the same batch.
  h.document.body.appendChild(modal); h.flushMutations([{ removedNodes: [modal] }]);
  assert.equal(h.resources().listeners, baseline.listeners + 2);
  modal.remove(); h.flushMutations([{ removedNodes: [modal] }]);
  assert.deepEqual(h.resources(), baseline);
  modal.dispatchEvent({ type: "modal-probe" }); child.dispatchEvent({ type: "child-probe" }); assert.equal(events, 2);
  // Direct DOM removal (without OV.onClose) must release the same ownership.
  const next = await h.proxies.remoteView.open(); next.modal.remove();
  h.flushMutations([{ removedNodes: [next.modal] }]);
  assert.deepEqual(h.resources(), baseline); assert.equal(closes, 1);
  h.box.OV.close = (el) => { if (h.overlays.delete(el)) el._options?.onClose?.(); el.remove(); };
  f.roles.view.refresh = () => {
    const transient = h.document.createElement("div"); transient.className = "rv-modal";
    transient.addEventListener("modal-probe", () => events++);
    context.OV.open(transient); context.OV.close(transient); return transient;
  };
  const transient = await h.proxies.remoteView.refresh();
  assert.deepEqual(h.resources(), baseline, "open witnesses connection even when outer capture also closes it");
  assert.equal((transient.listeners.get("modal-probe") || []).length, 0);
  h.list(feature("disabled")); await h.component.refresh(); assert.ok(h.observers.every((o) => o.disconnected));
});

test("remote host: 100 synchronous control replacements reclaim old listeners but keep prepared nodes", async () => {
  const h = host(feature()), f = h.fakeRoles(), pending = h.component.boot(); await tick();
  let context, field, prepared, events = 0, preparedEvents = 0;
  const root = h.document.getElementById("remotePage");
  h.execute(h.script(), () => {
    context = h.box.CCRemoteComponentHost.context;
    prepared = h.document.createElement("div"); prepared.className = "rs-overlay";
    prepared.addEventListener("prepared-probe", () => preparedEvents++); // Intentionally never mounted yet.
    root.addEventListener("root-probe", () => events++);
    h.box.CCRemoteComponentHost.mount(f.roles);
  });
  f.roles.view.refresh = () => {
    const old = field; field = h.document.createElement("select");
    root.replaceChildren(field); field.addEventListener("control-probe", () => events++); return old;
  };
  await h.finish(); await pending;
  await h.proxies.remoteView.refresh(); const baseline = h.resources();
  for (let i = 0; i < 100; i++) {
    const old = await h.proxies.remoteView.refresh();
    assert.equal(old.isConnected, false); assert.equal((old.listeners.get("control-probe") || []).length, 0);
    assert.deepEqual(h.resources(), baseline, "capture end reclaims sync renders without waiting for another event");
    const before = events; old.dispatchEvent({ type: "control-probe" }); assert.equal(events, before);
    field.dispatchEvent({ type: "control-probe" }); assert.equal(events, before + 1);
    h.flushMutations([{ removedNodes: [old] }]); assert.deepEqual(h.resources(), baseline);
    prepared.dispatchEvent({ type: "prepared-probe" }); assert.equal(preparedEvents, i + 1);
  }
  assert.equal(prepared.isConnected, false, "unmounted listeners are not mistaken for detached controls");
  f.roles.view.refresh = () => { field.remove(); root.appendChild(field); };
  await h.proxies.remoteView.refresh(); assert.deepEqual(h.resources(), baseline, "same-turn reparenting preserves listeners");
  // A later mount becomes eligible for cleanup, but only after it leaves DOM.
  context.OV.open(prepared); h.flushMutations([]);
  assert.equal((prepared.listeners.get("prepared-probe") || []).length, 1);
  context.OV.close(prepared); h.flushMutations([{ removedNodes: [prepared] }]);
  assert.equal(h.resources().listeners, baseline.listeners - 1);
  root.dispatchEvent({ type: "root-probe" });
  h.list(feature("disabled")); await h.component.refresh();
  assert.equal((root.listeners.get("root-probe") || []).length, 0);
});

test("remote host: async removals reclaim witnessed mounts without pruning never-mounted descendants", async () => {
  const h = host(feature()), f = h.fakeRoles(), pending = h.component.boot(); await tick();
  const { context } = h.mount(h.script(), f.roles); let events = 0;
  f.roles.view.open = () => {
    const node = h.document.createElement("div"); node.className = "rv-modal";
    node.addEventListener("async-probe", () => events++); return node;
  };
  await h.finish(); await pending;
  const baseline = h.resources(), parent = h.document.createElement("section");
  h.document.body.appendChild(parent);
  const removed = await h.proxies.remoteView.open(), prepared = await h.proxies.remoteView.open();
  h.flushMutations([]); assert.equal(h.resources().listeners, baseline.listeners + 2);
  // An async continuation mounts outside capture; the shared observer first
  // witnesses connection. Even a later removed subtree can include a child
  // added only AFTER detachment, which must not be treated as ever mounted.
  parent.appendChild(removed); h.flushMutations([]);
  parent.remove(); parent.appendChild(prepared); h.flushMutations([{ removedNodes: [parent] }]);
  assert.equal(h.resources().listeners, baseline.listeners + 1);
  removed.dispatchEvent({ type: "async-probe" }); prepared.dispatchEvent({ type: "async-probe" }); assert.equal(events, 1);
  assert.equal((removed.listeners.get("async-probe") || []).length, 0);
  assert.equal((prepared.listeners.get("async-probe") || []).length, 1);
  context.OV.open(prepared); h.flushMutations([]); prepared.remove(); h.flushMutations([{ removedNodes: [prepared] }]);
  assert.deepEqual(h.resources(), baseline);
  h.list(feature("disabled")); await h.component.refresh(); assert.ok(h.observers.every((o) => o.disconnected));
});

test("remote host: upgrade/disable cannot be resurrected by a delayed old script or mount version", async () => {
  const h = host(feature()); const first = h.component.boot(); await tick(); const old = h.script();
  h.list(feature("disabled")); await h.component.refresh(); assert.equal(await first, false);
  assert.throws(() => h.execute(old, () => h.box.CCRemoteComponentHost.context), { code: "NOT_CONFIGURED" });
  assert.equal(h.execute(old, () => h.box.CCRemoteComponentHost.mount(h.fakeRoles().roles)), false);
  old.onload(); assert.equal(h.component.enabled(), false);
  h.list(feature("active", { assetVersion: versionB, version: "2.0" })); const next = h.component.refresh(); await tick();
  const script = h.script(), f = h.fakeRoles();
  h.execute(script, () => {
    void h.box.CCRemoteComponentHost.context;
    assert.equal(h.box.CCRemoteComponentHost.mount({ ...f.roles, assetVersion: versionA }), false);
    assert.equal(h.box.CCRemoteComponentHost.mount({ ...f.roles, arbitraryPlugin: {} }), false);
    assert.equal(h.box.CCRemoteComponentHost.mount({ ...f.roles, assetVersion: versionB }), true);
  });
  await h.finish(); assert.equal(await next, true); assert.equal(h.component.enabled(), true);
  assert.equal(h.box.remoteTransport, h.proxies.remoteTransport);
  assert.equal(h.execute(old, () => h.box.CCRemoteComponentHost.mount(f.roles)), false);
});

test("remote host: bundle missing mount still destroys only approved partial window exports", async () => {
  const h = host(feature()), f = h.fakeRoles(), pending = h.component.boot(); await tick();
  h.execute(h.script(), () => {
    void h.box.CCRemoteComponentHost.context;
    h.box.remoteTransport = f.roles.transport; h.box.remoteView = f.roles.view; h.box.remoteSettings = f.roles.settings; h.box.remoteHosting = f.roles.hosting;
  });
  await h.finish(); assert.equal(await pending, false);
  assert.equal(h.component.status().state, "error"); assert.ok(f.activity.some((x) => x[0] === "transport" && x[1] === "destroy"));
  assert.equal(h.box.remoteTransport, h.proxies.remoteTransport); assert.equal(h.document.head.children.length, 0);
});

test("remote host: failed assets and host-version mismatch fail closed", async () => {
  for (const type of ["script", "css", "timeout"]) {
    const h = host(feature()), f = h.fakeRoles(); const pending = h.component.boot(); await tick(); h.mount(h.script(), f.roles);
    if (type === "timeout") [...h.timers.values()].find((x) => x.delay === 20000).fn(); else h[type]().onerror();
    assert.equal(await pending, false); assert.equal(h.component.enabled(), false); assert.equal(h.component.status().state, "error");
    assert.equal(h.document.head.children.length, 0); assert.equal(h.button.hidden, true);
  }
  const h = host(feature("active", { hostApi: 2 })); await h.component.boot(); assert.equal(h.component.status().state, "incompatible"); assert.equal(h.script(), undefined);
});

test("remote host: cross-WebView poll retires remotely disabled UI; stale status cannot overwrite", async () => {
  const h = host(feature()), f = h.fakeRoles(); const boot = h.component.boot(); await tick(); h.mount(h.script(), f.roles); await h.finish(); await boot;
  h.list(feature("disabled")); await h.poll(); assert.equal(h.component.enabled(), false); assert.equal(h.component.status().state, "disabled");
  const late = deferred(); h.list(() => late.promise); const old = h.component.refresh(); await tick();
  h.list(feature("absent")); await h.component.refresh(); late.resolve(feature()); await old;
  assert.equal(h.component.status().state, "absent"); assert.equal(h.script(), undefined);
});

test("remote host: same-content activation change clears stale content and draft even when poll misses stop/start", async () => {
  const h = host(feature()), old = h.fakeRoles(); const boot = h.component.boot(); await tick();
  const oldScript = h.script(); h.mount(oldScript, old.roles); await h.finish(); await boot;
  h.proxies.remoteTransport.setDraft("private old draft");
  const root = h.document.getElementById("remotePage"); root.innerHTML = "private old transcript"; root.hidden = false;
  old.emit({ revision: 100, generation: 5, items: [{ text: "private old transcript" }], sessions: [] });
  const nextFeature = feature("active", { activationId: "22222222-2222-4222-8222-222222222222" });
  h.list(nextFeature); const reloading = h.component.refresh(); await tick();
  assert.equal(h.proxies.remoteTransport.getDraft(), ""); assert.equal(h.document.getElementById("remotePage").innerHTML, "");
  assert.notEqual(h.script(), oldScript); assert.ok(old.activity.some((x) => x[1] === "destroy"));
  assert.equal(old.listeners.size, 0); assert.equal(h.component.enabled(), false);
  const next = h.fakeRoles(); h.mount(h.script(), next.roles); await h.finish(); await reloading;
  let received; const off = h.proxies.remoteTransport.subscribe((snapshot) => { received = snapshot; });
  next.emit({ revision: 0, generation: 0, sessions: [], items: [], active: null });
  assert.equal(received.revision, 0); assert.equal(received.active, null); assert.equal(h.component.enabled(), true);
  const currentScript = h.script(); await h.component.refresh(); assert.equal(h.script(), currentScript, "unchanged activation does not reload");
  off();
});

test("remote host: retiring scrubs an overlay still present during OV exit animation", async () => {
  const h = host(feature()), f = h.fakeRoles(); const boot = h.component.boot(); await tick();
  const { context } = h.mount(h.script(), f.roles); await h.finish(); await boot;
  const closing = [];
  h.box.OV.close = (el) => { if (h.overlays.delete(el)) el._options?.onClose?.(); closing.push(el); };
  const modal = h.document.createElement("div"); modal.className = "rv-modal"; modal.innerHTML = "private permission scope";
  let calls = 0; context.OV.open(modal, { onClose() { calls++; } }); context.OV.close(modal);
  assert.equal(calls, 1); assert.equal(modal.isConnected, true, "real OV calls onClose before its fade ends");
  h.list(feature("disabled")); await h.component.refresh();
  assert.equal(modal.isConnected, false); assert.equal(modal.innerHTML, ""); assert.equal(calls, 1);
  assert.ok(h.observers.every((observer) => observer.disconnected)); assert.ok(closing.includes(modal));
});

test("remote host: active status without runtime activation identity fails closed", async () => {
  const h = host(feature("active", { activationId: null })); await h.component.boot();
  assert.equal(h.component.enabled(), false); assert.equal(h.script(), undefined); assert.equal(h.component.status().state, "error");
});

test("remote host: enable/disable success requires confirmed status and uses empty lifecycle request bodies", async () => {
  const h = host(feature("disabled")); await h.component.boot();
  h.api(async (url, options) => {
    if (url.endsWith("/disable")) { assert.equal(options.body, "{}"); return { ok: true, component: feature("disabled") }; }
    return feature();
  });
  const disabling = h.component.disable(); await tick(); const f = h.fakeRoles(); h.mount(h.script(), f.roles); await h.finish();
  await assert.rejects(disabling, /尚未确认/);
  assert.equal(h.component.status().state, "active", "does not falsely claim backend disabled when it remains active");
  const disabled = host(feature("disabled")); await disabled.component.boot();
  disabled.api(async (url, options) => {
    if (url.endsWith("/enable")) { assert.equal(options.body, "{}"); return { ok: true, component: feature() }; }
    return feature("disabled");
  });
  await assert.rejects(disabled.component.enable(), /尚未确认/); assert.equal(disabled.component.enabled(), false);
});

test("remote host: original wrapper executes with only t/api/OV and can release all its global resources", async () => {
  const h = host(feature()); const pending = h.component.boot(); await tick();
  const wrapper = '(()=>{ "use strict"; const {t,api,OV,activationId:remoteActivationId}=window.CCRemoteComponentHost.context;\n' + ["13r-remote-transport.js", "13s-remote-view.js", "13t-remote-settings.js"].map((name) => fs.readFileSync(new URL("app/" + name, WEB), "utf8")).join("\n") + "\nwindow.CCRemoteComponentHost.mount({view:remoteView,transport:remoteTransport,settings:remoteSettings,hosting:remoteHosting}); })();";
  h.execute(h.script(), () => vm.runInContext(wrapper, h.box, { filename: "remote-component-ui.js" }));
  await h.finish(); assert.equal(await pending, true);
  assert.equal(h.box.remoteTransport, h.proxies.remoteTransport);
  assert.equal((h.box.listeners.get("blur") || []).length, 1);
  await h.proxies.remoteSettings.open();
  assert.equal(h.document.getElementById("remoteSettingsPage").hidden, false);
  assert.deepEqual(h.opens.at(-1), ["settings", "remote"]);
  assert.ok(h.observers.length >= 1, "original settings body observer captured");
  h.list(feature("disabled")); await h.component.refresh();
  assert.equal((h.box.listeners.get("blur") || []).length, 0);
  assert.ok(h.observers.every((observer) => observer.disconnected));
  assert.equal(h.document.getElementById("remoteSettingsPage").innerHTML, "");
});

test("remote host: real transport accepts reset counters after a missed same-version restart and rejects old callbacks", async () => {
  const h = host(feature()); const boot = h.component.boot(); await tick();
  const streams = [];
  let backend = { revision: 100, generation: 5, deviceId: "phone", connection: "online", phase: "idle", verified: false, canControl: false, cached: false,
    sessions: [{ remoteSessionId: "remote-old", deviceId: "tablet" }], active: null, binding: null, grant: null, run: null, pending: [],
    items: [{ id: "old", text: "private old transcript" }], receipts: [], streamId: null, seq: 0, historyCursor: null, historyHasMore: false, historyBusy: false, lastSyncedAt: null, error: null };
  h.box.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => structuredClone({ snapshot: backend }) });
  h.box.EventSource = class { constructor() { this.closed = false; streams.push(this); } addEventListener(name, fn) { this[name] = fn; } close() { this.closed = true; } };
  const wrapper = '(()=>{const {t,api,OV,activationId:remoteActivationId}=window.CCRemoteComponentHost.context;\n' + ["13r-remote-transport.js", "13s-remote-view.js", "13t-remote-settings.js"].map((n) => fs.readFileSync(new URL("app/" + n, WEB), "utf8")).join("\n") + '\nwindow.CCRemoteComponentHost.mount({view:remoteView,transport:remoteTransport,settings:remoteSettings,hosting:remoteHosting});})();';
  const execute = () => h.execute(h.script(), () => vm.runInContext(wrapper, h.box));
  execute(); await h.finish(); await boot;
  assert.equal((await h.proxies.remoteTransport.status()).revision, 100);
  h.proxies.remoteTransport.setDraft("private old draft");
  const stream = streams.at(-1); stream.onerror(); assert.equal(stream.closed, true);
  backend = { ...backend, revision: 0, generation: 0, sessions: [], items: [] };
  h.list(feature("active", { activationId: "33333333-3333-4333-8333-333333333333" }));
  const restart = h.component.refresh(); await tick();
  assert.equal(h.proxies.remoteTransport.getDraft(), "");
  execute(); await h.finish(); await restart;
  const state = await h.proxies.remoteTransport.status();
  assert.equal(state.revision, 0); assert.equal(state.generation, 0); assert.equal(state.items.length, 0); assert.equal(state.sessions.length, 0);
  stream.snapshot({ data: JSON.stringify({ ...backend, revision: 101, items: [{ id: "late", text: "must not return" }] }) });
  assert.equal((await h.proxies.remoteTransport.status()).items.length, 0);
  h.list(feature("disabled")); await h.component.refresh();
});

test("remote core: navigation and session menu filter all remote entries without rewriting saved pins", async () => {
  const h = host(feature("absent")); await h.component.boot();
  const nodes = new Map(), storage = new Map(), stored = ["sessions", "remote", "projects"], writes = [];
  let menu = [];
  h.box.$ = (id) => { if (!nodes.has(id)) nodes.set(id, h.document.createElement("div")); return nodes.get(id); };
  h.box.tk = (s) => s; h.box.esc = (s) => String(s); h.box.uiGet = () => stored;
  h.box.uiSet = (key, value) => writes.push([key, [...value]]);
  h.box.localStorage = { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) };
  h.box.srv = { runs: [] }; h.box.state = { sessions: [{ id: "local-session", title: "local" }] }; h.box.sess = {}; h.box.SM = {};
  h.box.popMenu = (anchor, items) => menu = items;
  const nav = fs.readFileSync(new URL("app/13-nav-menus.js", WEB), "utf8");
  vm.runInContext(nav.slice(nav.indexOf("  const PAGES = {"), nav.indexOf("  // ── 头像与昵称")) + nav.slice(nav.indexOf("  function sessMenu("), nav.indexOf("  // 脉络弹层")) + "\nglobalThis.navTest = { navPins, savedNavPins, renderSideNav, sessMenu };", h.box);
  storage.set("cc.navMore", "1"); vm.runInContext("navEdit = true; renderSideNav();", h.box);
  assert.doesNotMatch(h.box.$("side-nav").innerHTML, /data-(?:page|pin)="remote"/);
  assert.deepEqual([...h.box.navTest.navPins()], ["sessions", "projects"]);
  h.box.navTest.sessMenu("local-session", {}); assert.ok(!menu.some((x) => x?.label?.includes("托管到手机")));
  h.box.$("side-nav").dispatchEvent({ type: "change", target: { dataset: { pin: "projects" }, checked: false } });
  assert.deepEqual(writes, [["navPins", ["sessions", "remote"]]], "editing visible pins retains hidden remote choice");
  h.list(feature()); const pending = h.component.refresh(); await tick(); h.mount(h.script(), h.fakeRoles().roles); await h.finish(); await pending;
  h.box.navTest.renderSideNav(); assert.match(h.box.$("side-nav").innerHTML, /data-pin="remote"/);
  h.box.navTest.sessMenu("local-session", {}); assert.ok(menu.some((x) => x?.label?.includes("托管到手机")));
  h.list(feature("disabled")); await h.component.refresh(); h.box.navTest.renderSideNav(); assert.doesNotMatch(h.box.$("side-nav").innerHTML, /data-(?:page|pin)="remote"/);
  assert.deepEqual(stored, ["sessions", "remote", "projects"]);
});

test("remote core: paintSetCats never reopens disabled/empty remote category and active category opens once", () => {
  const h = host(), nodes = new Map(); let on = false, opens = 0, closes = 0;
  const category = h.document.createElement("div"), button = h.document.createElement("button"), general = h.document.createElement("div"), generalButton = h.document.createElement("button");
  category.dataset.cat = button.dataset.cat = "remote"; general.dataset.cat = generalButton.dataset.cat = "general"; button.hidden = true; button.classList.add("hidden");
  h.box.$ = (id) => { if (!nodes.has(id)) nodes.set(id, h.document.createElement("div")); return nodes.get(id); };
  h.document.querySelectorAll = (selector) => selector === "#set-cats [data-cat]" ? [generalButton, button] : selector === ".set-cat:not(.mo-ghost)" ? [general, category] : [general];
  h.document.querySelector = () => null;
  h.box.testComponent = { enabled: () => on, settingsOpening: () => false }; h.box.testSettings = { open: async () => { opens++; }, close: async () => { closes++; } };
  h.box.paintSetUsage = () => {}; h.box.pagesNarrow = () => false; h.box.MO = { play() {}, ghost() {} }; h.box.updOnOpen = () => {};
  h.box.requestAnimationFrame = (fn) => fn(); h.box.setCatShown = "-"; h.box.setCatOpen = "remote"; h.box.setOpen = true;
  const pages = fs.readFileSync(new URL("app/15-pages.js", WEB), "utf8");
  vm.runInContext('(() => { const remoteComponent = testComponent, remoteSettings = testSettings; ' + pages.slice(pages.indexOf("  function paintSetCats() {"), pages.indexOf('  $("set-cats").addEventListener')) + "\nglobalThis.paintCatsTest = paintSetCats; })();", h.box);
  h.box.paintCatsTest(); assert.equal(button.hidden, true); assert.equal(button.classList.contains("hidden"), true); assert.equal(category.classList.contains("hidden"), true); assert.equal(h.box.setCatOpen, "general"); assert.equal(opens, 0);
  on = true; h.box.setCatOpen = "remote"; h.box.paintCatsTest(); assert.equal(button.hidden, false); assert.equal(category.classList.contains("hidden"), false); assert.equal(opens, 1);
  h.box.paintCatsTest(); assert.equal(opens, 1, "repaint does not reopen remote settings");
  on = false; h.box.paintCatsTest(); assert.equal(button.hidden, true); assert.equal(category.classList.contains("hidden"), true); assert.equal(closes, 1);
});

test("remote core: opening unavailable remote routes goes to extensions without file/terminal/session actions", () => {
  const h = host(); const pages = fs.readFileSync(new URL("app/14-projects-sched.js", WEB), "utf8");
  h.box.remoteComponent = { enabled: () => false, refresh: async () => false };
  h.box.PAGES = { ext: {}, remote: {}, sessions: {}, settings: {} }; h.box.MO = { cancel() {}, play() {} }; h.box.innerWidth = 1000;
  h.box.closeTour = () => {}; h.box.closeDrawer = () => {}; h.box.paintTitle = () => {}; h.box.renderSideNav = () => {}; h.box.refreshStatus = () => {}; h.box.loadExt = () => {};
  h.box.SUBNAVS = {}; h.box.$ = (id) => h.document.getElementById(id) || (() => { const n = h.document.createElement("div"); n.id = id; h.document.body.appendChild(n); return n; })();
  h.box.openSettings = () => assert.fail("inactive remote must not open settings"); h.box.openFiles = h.box.openTerm = h.box.openSession = () => assert.fail("must not change local context");
  h.box.view = { sessionId: "local-stays-selected" };
  vm.runInContext(pages.slice(pages.indexOf("  function openPage(name, cat) {"), pages.indexOf("  function closePage() {")) + "\nglobalThis.openPageTest = openPage;", h.box);
  h.box.openPageTest("remote"); assert.equal(h.box.curPage, "ext"); assert.equal(h.box.view.sessionId, "local-stays-selected"); assert.match(h.toasts.at(-1).text, /安装并启用/);
  h.box.openPageTest("settings", "remote"); assert.equal(h.box.curPage, "ext"); assert.equal(h.box.view.sessionId, "local-stays-selected");
});

test("remote host: index ships no business CSS and settings/category start hidden", () => {
  const html = fs.readFileSync(new URL("index.html", WEB), "utf8");
  assert.doesNotMatch(html, /href="\/remote-(?:view|settings)\.css"/);
  assert.match(html, /<button data-cat="remote"[^>]*\bhidden/);
  assert.match(html, /<div[^>]*id="remoteSettingsPage"[^>]*\bhidden/);
  assert.match(html, /<div[^>]*id="remotePage"[^>]*\bhidden/);
  const boot = fs.readFileSync(new URL("app/19-boot.js", WEB), "utf8");
  assert.doesNotMatch(boot, /remoteTransport\.subscribe\(/);
  assert.match(boot, /await remoteComponent\.ready/);
  assert.match(boot, /serial !== remoteRouteSerial/);
});

function notificationRouteFixture() {
  const ready = deferred(), listings = [], opens = [], notices = [], events = new Map();
  let on = false, activationId = "current-activation", list = async () => [];
  const box = { window: { addEventListener(type, handler) { events.set(type, handler); } },
    notificationHost: { ready: ready.promise, enabled: () => on, status: () => ({ activationId }) },
    notificationTransport: { async list() { listings.push(true); return list(); } },
    openPage: (...args) => opens.push(args), toast: (message) => notices.push(message), t: (value) => value };
  const boot = fs.readFileSync(new URL("app/19-boot.js", WEB), "utf8");
  const segment = boot.slice(boot.indexOf("  let remoteRouteSerial = 0;"), boot.indexOf("  window.__cc.remote ="));
  vm.runInNewContext("(()=>{const remoteComponent=notificationHost,remoteTransport=notificationTransport;" + segment + "})();", box);
  return { ready, listings, opens, notices, open: (detail) => events.get("cc:remote-open")({ detail }),
    enable() { on = true; ready.resolve(true); }, disable() { on = false; ready.resolve(false); },
    listing(fn) { list = fn; }, rotate() { activationId = "new-activation"; } };
}
const notificationRoute = (id = "remote-one") => ({ remoteSessionId: id, fromDeviceId: "tablet", hostInstanceId: "host-boot", grantVersion: 1 });

test("notification route waits for cold component readiness without accepting invitations", async () => {
  const h = notificationRouteFixture();
  h.listing(async () => [{ remoteSessionId: "remote-one", deviceId: "tablet", grantVersion: 1, state: "invited" }]);
  const open = h.open(notificationRoute()); await tick();
  assert.equal(h.listings.length, 0); assert.deepEqual(h.opens, []);
  h.enable(); await open;
  assert.equal(h.listings.length, 1); assert.deepEqual(h.opens, [["remote", undefined]]);
});

test("notification route preserves latest click and never enables a disabled component", async () => {
  const h = notificationRouteFixture();
  h.listing(async () => ["remote-one", "remote-two"].map((remoteSessionId) => ({ remoteSessionId, deviceId: "tablet", grantVersion: 1, state: "active" })));
  const first = h.open(notificationRoute()), second = h.open(notificationRoute("remote-two"));
  h.enable(); await Promise.all([first, second]);
  assert.equal(h.listings.length, 1); assert.deepEqual(h.opens, [["remote", "remote-two"]]);
  const disabled = notificationRouteFixture(), ignored = disabled.open(notificationRoute());
  disabled.disable(); await ignored;
  assert.deepEqual(disabled.opens, [["ext"]]); assert.equal(disabled.listings.length, 0);
});

test("notification route discards list replies after lifecycle activation changes", async () => {
  const h = notificationRouteFixture(), reply = deferred(); h.listing(() => reply.promise); h.enable();
  const open = h.open(notificationRoute()); await tick(); h.rotate();
  reply.resolve([{ remoteSessionId: "remote-one", deviceId: "tablet", grantVersion: 1, state: "active" }]);
  await open; assert.deepEqual(h.opens, []);
});
