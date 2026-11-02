// Execute the production settings / local hosting GUI against a synthetic local API and DOM.
// No live gateway, credentials, session files, host bridge, network or model is accessed.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { PassThrough } from "node:stream";
import { validatePairingOffer } from "../gw/remote/pairing.mjs";

const source = fs.readFileSync(new URL("../web/app/13t-remote-settings.js", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../web/remote-settings.css", import.meta.url), "utf8");
const NOW = 2000000000000;
// Fixed synthetic bytes only: this fixture cannot identify or pair a real device.
const syntheticPin = Buffer.alloc(32, 11).toString("base64url");
const syntheticOffer = { v: 1, type: "cc-remote-pairing", offerId: "synthetic-offer", tablet: { deviceId: "dev_" + syntheticPin, spkiSha256: syntheticPin, name: "Synthetic tablet" }, secret: Buffer.alloc(32, 19).toString("base64url"), issuedAt: NOW, expiresAt: NOW + 60000 };
const syntheticCode = JSON.stringify(syntheticOffer);
const syntheticDevice = { deviceId: "synthetic-phone", name: "Synthetic phone", fingerprint: "synthetic-public-fingerprint-a" };
const saved = (extra = {}) => ({ ok: true, serverUrl: "https://relay.example.invalid", deviceName: "Synthetic tablet", hasCredential: true, connection: { state: "disconnected" }, reminders: { enabled: false, permission: "unsupported", background: "unsupported" }, ...extra });
const list = (extra = {}) => ({ ok: true, devices: [], pending: [], ...extra });
const pair = (extra = {}) => ({ pairingId: "synthetic-pair", state: "awaiting-confirmation", peer: syntheticDevice, verificationCode: "synthetic-verify-words", expiresAt: NOW + 60000, localConfirmed: false, peerConfirmed: false, ...extra });
const hosting = (id = "synthetic-local-a", extra = {}) => ({ ok: true, session: { localSessionId: id, title: "Synthetic chosen session" }, devices: [syntheticDevice], hosting: null, connection: { state: "online" }, ...extra });
const grant = (extra = {}) => ({ remoteSessionId: "synthetic-remote-handle", grantVersion: 3, deviceId: syntheticDevice.deviceId, deviceName: syntheticDevice.name, status: "invited", ...extra });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const unescape = (s) => String(s).replace(/&(?:amp|lt|gt|quot|#39);/g, (c) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" }[c]));

function ui({ settings = saved(), pairing = list(), hosted = hosting() } = {}) {
  const calls = [], events = [], errors = [], translates = [], writes = [], listeners = new Map(), timers = new Map(), overlays = [];
  let now = NOW, timerId = 0, handler = null;
  const guard = (fn) => { try { return fn(); } catch (err) { errors.push(err); throw err; } };
  const verify = () => { if (errors.length) throw errors[0]; };
  const descendants = (root) => root.children.flatMap((n) => [n, ...descendants(n)]);
  const matches = (node, selector) => {
    const parts = selector.trim().split(/\s+/), item = parts.pop();
    const id = item.match(/#([\w-]+)/)?.[1], tag = item.match(/^[a-z][\w-]*/i)?.[0];
    if ([...item.replace(/\[[^\]]*\]/g, "").matchAll(/\.([\w-]+)/g)].some(([, name]) => !node.classList.contains(name))) return false;
    const attrs = [...item.matchAll(/\[([\w-]+)(?:=['"]([^'"]*)['"])?\]/g)];
    if (id && node.id !== id) return false;
    if (tag && node.tagName !== tag.toUpperCase()) return false;
    if (attrs.some(([, key, value]) => node.getAttribute(key) === null || (value !== undefined && node.getAttribute(key) !== value))) return false;
    if (!parts.length) return true;
    for (let parent = node.parentElement; parent; parent = parent.parentElement) if (matches(parent, parts.join(" "))) return true;
    return false;
  };
  class Node {
    constructor(tag = "div") {
      this.tagName = tag.toUpperCase(); this.attributes = {}; this.dataset = {}; this.children = []; this.parentElement = null;
      this.id = ""; this.value = ""; this.checked = false; this.disabled = false; this.listeners = {}; this._text = ""; this.scrollTop = 0;
      const classes = new Set();
      this.classList = { add: (...a) => a.forEach((c) => classes.add(c)), remove: (...a) => a.forEach((c) => classes.delete(c)), contains: (c) => classes.has(c), toggle(c, on = !classes.has(c)) { if (on) classes.add(c); else classes.delete(c); return on; } };
    }
    get isConnected() { return this === body || !!this.parentElement?.isConnected; }
    setAttribute(key, value) {
      this.attributes[key] = String(value);
      if (key === "id") this.id = String(value);
      if (key === "value") this.value = unescape(value);
      if (key === "class") this.classList.add(...String(value).split(/\s+/));
      if (["disabled", "checked"].includes(key)) this[key] = true;
      if (key.startsWith("data-")) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value);
    }
    getAttribute(key) { if (key.startsWith("data-")) return this.dataset[key.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase())] ?? null; return this.attributes[key] ?? null; }
    appendChild(node) { this.children.push(node); node.parentElement = this; return node; }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((n) => n !== this); this.parentElement = null; }
    replaceChildren(...children) { this.children.forEach((n) => { n.parentElement = null; }); this.children = []; this._text = ""; this._html = ""; children.forEach((n) => this.appendChild(n)); }
    set innerHTML(html) {
      this.replaceChildren(); this._html = String(html); writes.push(String(html));
      const stack = [this], tokens = String(html).match(/<[^>]+>|[^<]+/g) || [];
      for (const token of tokens) {
        if (token.startsWith("</")) { if (stack.length > 1) stack.pop(); continue; }
        if (!token.startsWith("<")) { stack.at(-1)._text += unescape(token); continue; }
        const tag = token.match(/^<([\w-]+)/)?.[1]; if (!tag) continue;
        const el = new Node(tag);
        for (const [, key, quoted, bare] of token.slice(tag.length + 1, -1).matchAll(/([\w-]+)(?:="([^"]*)"|=([^\s>]+))?/g)) el.setAttribute(key, unescape(quoted ?? bare ?? ""));
        stack.at(-1).appendChild(el);
        if (!["input", "br", "hr", "img"].includes(tag)) stack.push(el);
      }
    }
    get innerHTML() { return this._html || ""; }
    get textContent() { return this._text + this.children.map((n) => n.textContent).join(""); }
    set textContent(value) { this.replaceChildren(); this._text = String(value); }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    querySelectorAll(selector) { return descendants(this).filter((n) => selector.split(",").some((s) => matches(n, s))); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    closest(selector) { for (let n = this; n; n = n.parentElement) if (selector.split(",").some((s) => matches(n, s))) return n; return null; }
    contains(node) { for (let n = node; n; n = n.parentElement) if (n === this) return true; return false; }
    focus() { document.activeElement = this; }
    select() { document.activeElement = this; }
    getClientRects() { for (let n = this; n; n = n.parentElement) if (n.classList.contains("hidden") || n.attributes.hidden !== undefined) return []; return this.isConnected ? [{}] : []; }
  }
  const body = new Node("body"), page = new Node(); page.setAttribute("id", "remoteSettingsPage"); body.appendChild(page);
  const anchor = new Node("button"); anchor.setAttribute("id", "synthetic-anchor"); body.appendChild(anchor);
  const add = (type, fn) => { const values = listeners.get(type) || []; values.push(fn); listeners.set(type, values); };
  const document = {
    body, hidden: false, activeElement: anchor, getElementById: (id) => body.querySelector("#" + id), createElement: (tag) => new Node(tag), addEventListener: add,
    dispatchEvent(event) { events.push(event); for (const fn of listeners.get(event.type) || []) fn(event); },
  };
  const OV = {
    open(el, opts) {
      const from = document.activeElement; body.appendChild(el); overlays.push({ el, opts, from }); el.focus();
      assert.equal(opts.kind, "modal"); assert.equal(opts.cover, true); assert.equal(opts.keep, true);
    },
    close(el) { const entry = overlays.find((o) => o.el === el); if (!entry) return; overlays.splice(overlays.indexOf(entry), 1); el.remove(); entry.opts.onClose(); if (entry.from.isConnected) entry.from.focus(); },
    back() { const entry = overlays.at(-1); if (!entry) return false; this.close(entry.el); return true; },
  };
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const box = {
    window: {}, document, OV, URL, Date: Clock, AbortController,
    CustomEvent: class { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } },
    MutationObserver: class { observe() {} },
    t: (s, values = {}) => { translates.push(s); return s.replace(/\{(\w+)\}/g, (m, k) => values[k] ?? m); },
    toast: (message) => events.push({ type: "toast", message }),
    addEventListener: add,
    setTimeout(fn, delay = 0) { timers.set(++timerId, { fn, at: now + delay }); return timerId; }, clearTimeout(id) { timers.delete(id); },
    localStorage: new Proxy({}, { get: () => guard(() => assert.fail("remote GUI must not access browser storage")) }),
    sessionStorage: new Proxy({}, { get: () => guard(() => assert.fail("remote GUI must not access browser storage")) }),
    api: async (url, options) => {
      const call = { url, method: options.method, body: options.body ? JSON.parse(options.body) : undefined, signal: options.signal };
      calls.push(call);
      guard(() => {
        assert.match(url, /^\/api\/remote\/(settings|pairing|hosting)(?:\?localSessionId=[^&]+)?$/);
        assert.equal(options.cache, "no-store"); assert.equal(options.credentials, "same-origin");
        if (call.body) assert.equal(options.headers["content-type"], "application/json");
      });
      let result;
      if (handler) result = await handler(call);
      if (result === undefined) {
        if (url === "/api/remote/settings") result = settings;
        else if (url === "/api/remote/pairing") result = pairing;
        else result = hosted;
      }
      return structuredClone(result);
    },
  };
  vm.runInNewContext(source, box, { filename: "13t-remote-settings.js" });
  const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); verify(); };
  const u = {
    calls, events, timers, translates, writes, page, OV, document,
    settings: box.window.remoteSettings, hosting: box.window.remoteHosting,
    get: (id) => document.getElementById(id), overlay: () => overlays.at(-1)?.el,
    handle(fn) { handler = fn; }, setSettings(value) { settings = value; }, setPairing(value) { pairing = value; }, setHosting(value) { hosted = value; },
    nativeCopy(fn) { box.window.CCApp = { copyText: fn }; },
    clipboard(fn) { box.navigator = { clipboard: { writeText: fn } }; },
    execCopy(fn) { document.execCommand = fn; },
    flush,
    async open() { await box.window.remoteSettings.open(); verify(); },
    input(id, value) { const el = document.getElementById(id); assert.ok(el, `missing ${id}`); el.value = value; for (const fn of page.listeners.input || []) fn({ target: el }); },
    async change(id, value) {
      const el = document.getElementById(id); assert.ok(el, `missing ${id}`);
      if (typeof value === "boolean") el.checked = value; else el.value = value;
      for (const fn of el.listeners.change || []) fn({ target: el });
      for (let parent = el.parentElement; parent; parent = parent.parentElement) for (const fn of parent.listeners.change || []) fn({ target: el });
      await flush();
    },
    async click(action, root = overlays.at(-1)?.el || page) {
      const el = root?.querySelector(`[data-rs="${action}"]`); assert.ok(el, `missing action ${action}`); if (el.disabled) return;
      for (const fn of root.listeners.click || []) fn({ target: el }); await flush();
    },
    async submit(id) { const form = document.getElementById(id); assert.ok(form, `missing form ${id}`); for (let n = form; n; n = n.parentElement) for (const fn of n.listeners.submit || []) fn({ target: form, preventDefault() {} }); await flush(); },
    async fire(type) { for (const fn of listeners.get(type) || []) fn({ type }); await flush(); },
    async advance(ms) {
      const end = now + ms; let count = 0;
      while (true) { const item = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!item) break; assert.ok(++count < 200, "timers must be bounded"); const [id, timer] = item; timers.delete(id); now = timer.at; timer.fn(); await flush(); }
      now = end;
    },
  };
  return u;
}
const posts = (u, action) => u.calls.filter((c) => c.method === "POST" && (!action || c.body.action === action));
const fill = (u, credential = "synthetic-first-connect-credential") => { u.input("rs-server", "https://relay.example.invalid/"); u.input("rs-name", "Synthetic tablet"); u.input("rs-credential", credential); };

// A real production runtime with injected synthetic identity/store/relay boundaries.
// This fixture does not open sockets; it can prove whether runtime initiates a probe.
async function runtimeFixture(t, { initialGrants = [] } = {}) {
  assert.equal(process.env.CCAPP_TEST, "1", "Use the isolated scripts/test.mjs runner");
  assert.equal(process.env.HOME, process.env.CCAPP_HOME);
  const [{ createRemoteRuntime }, { createRemoteStore }] = await Promise.all([import("../gw/remote/runtime.mjs"), import("../gw/remote/store.mjs")]);
  const root = fs.mkdtempSync(path.join(process.env.CCAPP_WORKSPACE, "remote-settings-runtime-"));
  const sealed = new Map(), probes = [], registrations = [], background = [], liveRoutes = new Map();
  const identity = { deviceId: "dev_" + syntheticPin, spkiSha256: syntheticPin, name: "Synthetic tablet" };
  const token = "synthetic-runtime-token-".repeat(3);
  const store = createRemoteStore(null, {
    async seal(value) { const key = "synthetic-vault-handle-" + sealed.size; sealed.set(key, value); return key; },
    async unseal(key) { assert.ok(sealed.has(key)); return sealed.get(key); },
  });
  store.setIdentity(identity);
  for (const grant of initialGrants) store.putGrant({ hostDeviceId: identity.deviceId, phoneDeviceId: "dev_synthetic_peer", localSessionId: "synthetic-local-a", state: "revoked", grantVersion: 1, expiresAt: NOW + 60000, ...grant });
  await store.configure({ serverUrl: "https://relay-a.example.invalid", deviceName: identity.name }, JSON.stringify({ deviceId: identity.deviceId, token }));
  let backgroundEnabled = false;
  const hostAdapter = {
    available: true, secretProtector: {},
    async status() { return { hostAvailable: true, backgroundEnabled, backgroundEffective: backgroundEnabled, systemNotifications: true, eventChannel: true }; },
    async setBackgroundEnabled(enabled, options) { background.push({ enabled, options }); backgroundEnabled = enabled; },
    async syncNotifications() {}, async clearNotifications() {}, async reportConnectionState() {},
  };
  const relayFactory = (options) => {
    const listeners = new Map(); const probe = { serverUrl: options.serverUrl, token: options.token, connects: 0, disposed: false, replaced: false }; probes.push(probe);
    let online = false;
    return {
      get online() { return online; },
      on(event, fn) { listeners.set(event, fn); return () => listeners.delete(event); },
      async connect() {
        probe.connects++; if (online) return; // Production client connect() is idempotent while already online.
        if (options.serverUrl.includes("unreachable")) throw Object.assign(new Error("synthetic unreachable"), { code: "OFFLINE" });
        // Match the production relay: a duplicate device WebSocket replaces its live route.
        const prior = liveRoutes.get(options.serverUrl); if (prior) prior.replace();
        liveRoutes.set(options.serverUrl, { probe, replace() { probe.replaced = true; online = false; listeners.get("connection")?.({ state: "offline" }); } });
        online = true; listeners.get("connection")?.({ state: "online" });
      },
      dispose() { probe.disposed = true; online = false; if (liveRoutes.get(options.serverUrl)?.probe === probe) liveRoutes.delete(options.serverUrl); },
      async registerOffer() {}, cancelOffer() {}, async confirmPair() {}, async revokePair() {}, hint() {},
    };
  };
  const sourceAdapter = { describe: async () => ({ title: "Synthetic chosen session" }), readHistory: async () => ({ entries: [], cursor: null }), current: () => null };
  const executor = { getRun: () => null, getRunOfSession: () => null, submitText: () => false, answerPerm: () => false, abortRun: () => false, onEvent: () => () => {} };
  const runtime = await createRemoteRuntime({ home: root, sourceAdapter, executor, identityBundle: { identity, credentials: { key: "synthetic-not-a-key" } }, store, hostAdapter, relayFactory, now: () => NOW,
    fetchImpl: async (url) => { registrations.push(String(url)); throw Object.assign(new Error("synthetic registration blocked"), { code: "AUTH_FAILED" }); },
  });
  t.after(async () => { try { await runtime.dispose(); } finally { fs.rmSync(root, { recursive: true, force: true }); } });
  return { runtime, store, identity, token, probes, registrations, background };
}

// Connection settings and genuine diagnostics.
test("pairing code uses the exact typed JSON offer supported by the crypto module", () => {
  const checked = validatePairingOffer(JSON.parse(syntheticCode), { now: () => NOW });
  assert.equal(checked.offerId, syntheticOffer.offerId); assert.equal(checked.tablet.spkiSha256, syntheticPin);
  assert.equal(checked.secret, syntheticOffer.secret);
});

test("remote settings exports fixed APIs without startup requests or secret storage", async () => {
  const u = ui(); assert.equal(u.calls.length, 0);
  assert.equal(typeof u.settings.open, "function"); assert.equal(typeof u.hosting.open, "function"); assert.equal(typeof u.hosting.refresh, "function");
  await u.open(); assert.deepEqual(u.calls.map((c) => c.url), ["/api/remote/settings", "/api/remote/pairing"]);
  assert.equal(u.get("rs-credential").value, ""); assert.equal(u.get("rs-credential").getAttribute("type"), "password");
  assert.equal(u.get("rs-credential").getAttribute("autocomplete"), "new-password");
  assert.match(u.page.textContent, /配对不开放任何会话/); assert.match(u.page.textContent, /仅打开 CC 时/); assert.match(u.page.textContent, /宿主尚不支持/);
});

test("backend missing or malformed snapshots remain failures, never demo success or raw credential echoes", async () => {
  const u = ui(); u.handle(() => { throw Object.assign(new Error("credential=synthetic-do-not-echo"), { status: 501 }); });
  await u.open(); assert.match(u.page.textContent, /后端尚未就绪/); assert.doesNotMatch(u.page.textContent, /synthetic-do-not-echo|配对完成|真实连接检查通过/);
  u.handle(() => ({ ok: true, token: "synthetic-long-token-not-for-ui" })); await u.open();
  assert.match(u.page.textContent, /返回状态不完整/); assert.doesNotMatch(u.page.textContent, /synthetic-long-token-not-for-ui/);
});

test("production error codes map to translated safe failure guidance instead of raw backend text", async () => {
  for (const [code, expected] of [["PAIRING_RATE_LIMIT", /操作过于频繁/], ["OFFLINE", /结果待核实/], ["GRANT_MISMATCH", /授权或设备状态已变化/], ["INVALID_PAIRING_CONFIRMATION", /设备核对信息不一致/], ["PAIRED_RELAY_CHANGE", /请先解除已有配对/]]) {
    const u = ui(); await u.open(); fill(u, "");
    u.handle((c) => { if (c.body?.action === "diagnose") throw Object.assign(new Error("synthetic-sensitive-error-not-for-display"), { body: { code } }); });
    await u.click("diagnose", u.page); assert.match(u.get("rs-settings-feedback").textContent, expected); assert.doesNotMatch(u.page.textContent, /synthetic-sensitive-error/);
  }
});

test("identity initialization exposes only fixed safe codes, never arbitrary backend details", async () => {
  for (const code of ["IDENTITY_VAULT_UNAVAILABLE", "IDENTITY_VAULT_REQUIRED", "IDENTITY_CERTIFICATE_UNAVAILABLE", "IDENTITY_CERTIFICATE_FAILED", "IDENTITY_CERTIFICATE_TIMEOUT", "IDENTITY_CERTIFICATE_LIMIT", "IDENTITY_OPERATION_FAILED", "IDENTITY_LOAD_FAILED", "IDENTITY_SAVE_FAILED", "UNSAFE_IDENTITY_DIRECTORY", "HOST_OPERATION_FAILED", "VAULT_UNAVAILABLE"]) {
    const u = ui(); await u.open(); fill(u, "");
    u.handle((c) => { if (c.body?.action === "diagnose") throw Object.assign(new Error("synthetic-private-key-not-for-display"), { body: { code } }); });
    await u.click("diagnose", u.page);
    assert.match(u.get("rs-settings-feedback").textContent, /本机安全身份初始化未完成/);
    assert.ok(u.get("rs-settings-feedback").textContent.includes(code));
    assert.doesNotMatch(u.page.textContent, /synthetic-private-key/);
  }
  const u = ui(); await u.open(); fill(u, "");
  u.handle((c) => { if (c.body?.action === "diagnose") throw Object.assign(new Error("secret"), { body: { code: "IDENTITY_FAKE_PRIVATE_CONTENT" } }); });
  await u.click("diagnose", u.page); assert.doesNotMatch(u.page.textContent, /IDENTITY_FAKE_PRIVATE_CONTENT/);
});

test("connection form rejects non-HTTPS, URL secrets, query/fragment and missing credentials without network", async () => {
  const u = ui({ settings: saved({ hasCredential: false, serverUrl: "", deviceName: "" }) }); await u.open(); fill(u);
  for (const address of ["http://relay.example.invalid", "https://user:pass@relay.example.invalid", "https://relay.example.invalid/?token=synthetic", "https://relay.example.invalid/#secret", "https://relay.example.invalid/not-a-relay-root", "not a URL"]) {
    u.input("rs-server", address); await u.submit("rs-connection-form");
    assert.match(u.get("rs-settings-feedback").textContent, /HTTPS/);
  }
  fill(u, ""); await u.click("diagnose", u.page); assert.match(u.get("rs-settings-feedback").textContent, /首次连接凭据/);
  assert.equal(posts(u).length, 0);
});

test("save submits only local config fields, clears credential immediately and does not claim online", async () => {
  const u = ui(); await u.open(); fill(u);
  const wait = deferred(); u.handle((c) => c.body?.action === "configure" ? wait.promise : undefined);
  await u.submit("rs-connection-form");
  assert.equal(u.get("rs-credential").value, ""); assert.equal(u.get("rs-server").disabled, true);
  assert.deepEqual(posts(u)[0].body, { action: "configure", serverUrl: "https://relay.example.invalid", deviceName: "Synthetic tablet", credential: "synthetic-first-connect-credential" });
  assert.doesNotMatch(u.page.textContent, /配置已保存/);
  wait.resolve(saved({ token: "synthetic-response-token-must-not-render", privateKey: "synthetic-response-private-material" })); await u.flush();
  assert.match(u.page.textContent, /配置已保存；保存不代表服务器可达/);
  assert.doesNotMatch(u.page.textContent, /真实连接检查通过|synthetic-response-token|synthetic-response-private/);
  assert.equal(u.get("rs-credential").value, ""); assert.equal(u.get("rs-server").disabled, false);
  await u.submit("rs-connection-form"); await u.flush(); assert.equal(posts(u).at(-1).body.credential, undefined, "blank retains saved credential without returning it to WebView");
});

test("diagnose requires explicit successful DNS TLS auth and relay checks, not a saved flag", async () => {
  const u = ui(); await u.open(); fill(u, "");
  u.handle((c) => c.body?.action === "diagnose" ? { ok: true, diagnostic: { state: "online", checkedAt: NOW, checks: [{ stage: "tls", status: "pass" }] } } : undefined);
  await u.click("diagnose", u.page); assert.match(u.get("rs-diagnostic").textContent, /尚未验证通过/); assert.doesNotMatch(u.page.textContent, /真实连接检查通过/);
  u.handle((c) => c.body?.action === "diagnose" ? { ok: true, diagnostic: { state: "online", checkedAt: NOW, checks: ["dns", "tls", "auth", "relay"].map((stage) => ({ stage, status: "pass" })) } } : undefined);
  await u.click("diagnose", u.page); assert.match(u.get("rs-diagnostic").textContent, /真实连接检查通过（仅代表本次测试）/);
  assert.equal(posts(u, "configure").length, 0, "diagnosis is separate from saving");
  u.input("rs-server", "https://different.example.invalid"); assert.equal(u.get("rs-diagnostic").textContent, "", "editing invalidates old diagnostic");
});

test("credential clears on blur, pagehide and explicit close, backend messages are not reflected", async () => {
  const u = ui(); await u.open(); fill(u); await u.fire("blur"); assert.equal(u.get("rs-credential").value, "");
  fill(u); u.settings.close(); assert.equal(u.get("rs-credential").value, "");
  await u.open(); fill(u);
  u.handle(() => { throw Object.assign(new Error("synthetic-token-should-not-appear"), { status: 403, body: { message: "synthetic-token-should-not-appear" } }); });
  await u.submit("rs-connection-form"); assert.doesNotMatch(u.page.textContent, /synthetic-token-should-not-appear/); assert.match(u.page.textContent, /身份校验失败/);
  fill(u); await u.fire("pagehide"); assert.equal(u.get("rs-credential").value, "");
});

test("reminder toggle waits for backend state and exposes unsupported host rather than fake background delivery", async () => {
  const u = ui(); await u.open(); const wait = deferred(); u.handle((c) => c.body?.action === "reminders" ? wait.promise : undefined);
  await u.click("reminders", u.page); assert.equal(u.get("rs-reminders").getAttribute("aria-checked"), "false"); assert.equal(u.get("rs-reminders").disabled, true);
  wait.resolve(saved({ reminders: { enabled: true, permission: "denied", background: "unsupported" } })); await u.flush();
  assert.equal(u.get("rs-reminders").getAttribute("aria-checked"), "true"); assert.match(u.page.textContent, /通知权限未开启/); assert.match(u.page.textContent, /宿主尚不支持/); assert.match(u.page.textContent, /实际设备验收/);
  assert.deepEqual(posts(u, "reminders")[0].body, { action: "reminders", enabled: true });
});

// Two-way, one-use pairing. Pairing never grants a session or approves a tool.
test("pair creation displays only backend-generated expiring high-entropy code and never auto-confirms", async () => {
  const u = ui(); await u.open(); u.handle((c) => c.body?.action === "create" ? { ok: true, offer: { pairingId: "synthetic-pair", code: syntheticCode, expiresAt: NOW + 60000 } } : undefined);
  await u.click("pair", u.page); await u.click("create-pair");
  assert.match(u.overlay().textContent, new RegExp(syntheticCode)); assert.match(u.overlay().textContent, /配对不等于会话授权/);
  assert.equal(posts(u, "confirm").length, 0); assert.equal(posts(u, "invite").length, 0);
  assert.equal(u.overlay().querySelector('[data-rs="confirm-pair"]').disabled, true);
  await u.fire("blur"); assert.doesNotMatch(u.overlay().textContent, new RegExp(syntheticCode));
  u.OV.back(); assert.equal(u.overlay(), undefined); assert.equal(u.document.activeElement.id, "synthetic-anchor");
  const before = u.calls.length; await u.advance(10000); assert.equal(u.calls.length, before, "closing stops pairing polling");
});

test("unchanged pairing polls retain the code and scroll nodes even across a transient failure", async () => {
  const offered = pair({ state: "offered", peer: null, verificationCode: "" });
  const u = ui(); await u.open();
  u.handle((c) => c.body?.action === "create" ? { ok: true, offer: { pairingId: offered.pairingId, code: syntheticCode, expiresAt: offered.expiresAt }, pairing: offered } : undefined);
  await u.click("pair", u.page); await u.click("create-pair");
  u.setPairing(list({ pending: [offered] }));
  const root = u.overlay(), code = root.querySelector("code"), body = root.querySelector(".rs-dialog-body");
  body.scrollTop = 173;
  const assertRetained = () => {
    assert.equal(root.querySelector("code"), code, "browser text selection must keep the same code node");
    assert.equal(root.querySelector(".rs-dialog-body"), body); assert.equal(body.scrollTop, 173);
    assert.equal(code.textContent, syntheticCode);
  };
  await u.advance(6000); assertRetained();
  u.handle((c) => { if (c.method === "GET" && c.url.endsWith("/pairing")) throw Object.assign(new Error("synthetic disconnect"), { code: "OFFLINE" }); });
  await u.advance(3000); assertRetained(); assert.match(root.textContent, /结果待核实/);
  u.handle(() => undefined); await u.advance(3000); assertRetained(); assert.doesNotMatch(root.textContent, /结果待核实/);
  assert.equal(posts(u, "confirm").length, 0); assert.equal(posts(u, "invite").length, 0);
  u.OV.back();
});

test("an unchanged in-flight poll does not strand a manually checked pairing confirmation", async () => {
  const u = ui({ pairing: list({ pending: [pair()] }) }); await u.open(); await u.click("review-pair", u.page);
  const root = u.overlay(), verify = u.get("rs-verify"), body = root.querySelector(".rs-dialog-body"), waiting = deferred();
  body.scrollTop = 91;
  u.handle((c) => c.method === "GET" && c.url.endsWith("/pairing") ? waiting.promise : undefined);
  await u.click("refresh-pair"); await u.change("rs-verify", true);
  assert.equal(root.querySelector('[data-rs="confirm-pair"]').disabled, true);
  waiting.resolve(list({ pending: [pair()] })); await u.flush();
  assert.equal(u.get("rs-verify"), verify); assert.equal(verify.checked, true); assert.equal(body.scrollTop, 91);
  assert.equal(root.querySelector('[data-rs="confirm-pair"]').disabled, false);
  assert.equal(posts(u, "confirm").length, 0);
  u.OV.back();
});

test("copying the complete pairing code is explicit, exact and reports only acknowledged success", async () => {
  for (const mode of ["native", "clipboard", "exec", "denied"]) {
    const u = ui(), copied = []; await u.open();
    u.handle((c) => c.body?.action === "create" ? { ok: true, offer: { pairingId: "synthetic-pair", code: syntheticCode, expiresAt: NOW + 60000 } } : undefined);
    u.nativeCopy((value) => { copied.push(["native", value]); return mode === "native"; });
    u.clipboard(async (value) => { copied.push(["clipboard", value]); if (mode !== "clipboard") throw new Error("synthetic clipboard denied"); });
    u.execCopy((command) => { assert.equal(command, "copy"); copied.push(["exec", u.document.activeElement.value]); return mode === "exec"; });
    await u.click("pair", u.page); await u.click("create-pair");
    const root = u.overlay(), code = root.querySelector("code"), body = root.querySelector(".rs-dialog-body"); body.scrollTop = 45;
    assert.equal(copied.length, 0, "displaying a code never writes the clipboard");
    await u.click("copy-pair");
    assert.ok(copied.length > 0); assert.ok(copied.every(([, value]) => value === syntheticCode), "each copy path gets the full original JSON");
    assert.equal(root.querySelector("code"), code); assert.equal(body.scrollTop, 45);
    const result = root.querySelector("#rs-pair-copy-result").textContent;
    assert.match(result, mode === "denied" ? /未能复制/ : /完整配对码已复制/);
    if (mode === "denied") assert.doesNotMatch(result, /已复制/);
    assert.equal(root.querySelector('[data-rs="copy-pair"]').disabled, false);
    assert.equal(u.document.body.querySelector("textarea"), null, "copy fallback removes its temporary secret field");
    assert.equal(posts(u, "confirm").length, 0); assert.equal(posts(u, "invite").length, 0);
    await u.fire("blur"); assert.equal(root.querySelector('[data-rs="copy-pair"]'), null); assert.ok(!root.textContent.includes(syntheticCode));
    u.OV.back();
  }
});

test("a delayed clipboard completion cannot repaint another modal or copy a hidden code again", async () => {
  const u = ui(), copying = deferred(), writes = []; await u.open();
  u.handle((c) => c.body?.action === "create" ? { ok: true, offer: { pairingId: "synthetic-pair", code: syntheticCode, expiresAt: NOW + 60000 } } : undefined);
  u.clipboard((value) => { writes.push(value); return copying.promise; });
  await u.click("pair", u.page); await u.click("create-pair"); await u.click("copy-pair");
  assert.equal(u.overlay().querySelector('[data-rs="copy-pair"]').disabled, true);
  await u.click("copy-pair"); assert.deepEqual(writes, [syntheticCode]);
  u.OV.back(); await u.hosting.open("synthetic-local-a"); const replacement = u.overlay();
  copying.resolve(); await u.flush();
  assert.equal(u.overlay(), replacement); assert.doesNotMatch(replacement.textContent, /配对码已复制|未能复制/);
  assert.equal(posts(u, "confirm").length, 0); assert.equal(posts(u, "invite").length, 0);
  u.OV.back();
});

test("pairing completion distinguishes local persistence from a confirmed peer store", async () => {
  for (const peerPersisted of [null, true]) {
    const p = pair({ state: "paired", localConfirmed: true, peerConfirmed: true, localPersisted: true, peerPersisted });
    const u = ui({ pairing: list({ pending: [pair()] }) });
    await u.open(); await u.click("review-pair", u.page);
    u.setPairing(list({ devices: [syntheticDevice], pending: [p] })); await u.click("refresh-pair");
    assert.match(u.overlay().textContent, peerPersisted ? /本机配对记录已保存，并已收到对端保存回执/ : /对端是否已保存尚未核实/);
    assert.doesNotMatch(u.overlay().textContent, /两端均已确认，设备配对完成/);
    assert.equal(posts(u, "confirm").length, 0); assert.equal(posts(u, "invite").length, 0);
    u.OV.back();
  }
});

test("finishing pairing refreshes devices without rebuilding nonsecret connection drafts", async () => {
  const u = ui({ pairing: list({ pending: [pair()] }) }); await u.open();
  u.input("rs-server", "https://unsaved.example.invalid"); u.input("rs-name", "Unsaved synthetic name"); u.input("rs-credential", "synthetic-credential-to-clear");
  const server = u.get("rs-server"), name = u.get("rs-name"), form = u.get("rs-connection-form");
  u.page.scrollTop = 120; server.focus();
  await u.click("review-pair", u.page);
  u.setPairing(list({ devices: [syntheticDevice], pending: [pair({ state: "paired", localConfirmed: true, peerConfirmed: true })] }));
  await u.click("refresh-pair"); const gets = u.calls.length, waiting = deferred();
  u.handle((c) => c.url.endsWith("/pairing") && c.method === "GET" ? waiting.promise : undefined);
  await u.click("finish-pair"); assert.equal(u.overlay(), undefined);
  assert.equal(u.document.activeElement, server); assert.equal(u.get("rs-credential").value, "");
  assert.deepEqual(u.calls.slice(gets).map((c) => c.url), ["/api/remote/pairing"]);
  const newDevice = { ...syntheticDevice, name: "Refreshed synthetic device" };
  waiting.resolve(list({ devices: [newDevice], pending: [] })); await u.flush();
  assert.equal(u.get("rs-server"), server); assert.equal(u.get("rs-name"), name); assert.equal(u.get("rs-connection-form"), form);
  assert.equal(server.value, "https://unsaved.example.invalid"); assert.equal(name.value, "Unsaved synthetic name");
  assert.equal(u.page.scrollTop, 120); assert.equal(u.document.activeElement, server);
  assert.match(u.get("rs-devices").textContent, /Refreshed synthetic device/); assert.equal(posts(u).length, 0);
});

test("a failed device refresh after pairing reports failure without clearing connection drafts", async () => {
  const u = ui({ pairing: list({ pending: [pair()] }) }); await u.open();
  u.input("rs-server", "https://draft.example.invalid"); u.input("rs-name", "Synthetic unsaved name");
  await u.click("review-pair", u.page);
  u.setPairing(list({ devices: [syntheticDevice], pending: [pair({ state: "paired", localConfirmed: true, peerConfirmed: true })] }));
  await u.click("refresh-pair");
  u.handle((c) => { if (c.method === "GET" && c.url.endsWith("/pairing")) throw Object.assign(new Error("synthetic private detail"), { code: "OFFLINE" }); });
  await u.click("finish-pair");
  assert.equal(u.get("rs-server").value, "https://draft.example.invalid"); assert.equal(u.get("rs-name").value, "Synthetic unsaved name");
  assert.match(u.get("rs-devices").textContent, /结果待核实/); assert.doesNotMatch(u.page.textContent, /synthetic private detail/);
  assert.equal(posts(u).length, 0);
});

test("a device refresh after pairing cannot write into a newly opened settings page", async () => {
  const u = ui({ pairing: list({ pending: [pair()] }) }); await u.open(); await u.click("review-pair", u.page);
  u.setPairing(list({ devices: [syntheticDevice], pending: [pair({ state: "paired", localConfirmed: true, peerConfirmed: true })] }));
  await u.click("refresh-pair"); const waiting = deferred();
  u.handle((c) => c.url.endsWith("/pairing") && c.method === "GET" ? waiting.promise : undefined);
  await u.click("finish-pair");
  u.handle(() => undefined); u.setPairing(list()); await u.open();
  waiting.resolve(list({ devices: [{ ...syntheticDevice, name: "STALE synthetic device" }], pending: [] })); await u.flush();
  assert.doesNotMatch(u.get("rs-devices").textContent, /STALE synthetic device/);
});

test("unchanged pairing polls keep the device list nodes and its scroll position", async () => {
  const u = ui({ pairing: list({ devices: [syntheticDevice], pending: [pair()] }) });
  await u.open(); await u.click("review-pair", u.page);
  const devices = u.get("rs-devices"), first = devices.children[0]; devices.scrollTop = 85;
  await u.click("refresh-pair"); await u.click("refresh-pair");
  assert.equal(devices.children[0], first); assert.equal(devices.scrollTop, 85);
});

test("tablet offer ID remains stable when the peer claim becomes a confirmation attempt", async () => {
  const u = ui(); await u.open();
  u.handle((c) => {
    if (c.body?.action === "create") return { ok: true, offer: { pairingId: "synthetic-offer", code: syntheticCode, expiresAt: NOW + 60000 } };
    if (c.body?.action === "confirm") return { ok: true, pairing: pair({ pairingId: "synthetic-offer", localConfirmed: true }) };
  });
  await u.click("pair", u.page); await u.click("create-pair");
  u.setPairing(list({ pending: [pair({ pairingId: "synthetic-offer" })] }));
  await u.click("refresh-pair"); assert.doesNotMatch(u.overlay().textContent, /已不在待办中/);
  await u.change("rs-verify", true); await u.click("confirm-pair");
  assert.equal(posts(u, "confirm")[0].body.pairingId, "synthetic-offer");
  assert.match(u.overlay().textContent, /等待另一端确认/);
});

test("short and expired pairing offers cannot masquerade as secure pairing", async () => {
  for (const offer of [{ code: "123456", expiresAt: NOW + 60000 }, { code: syntheticCode, expiresAt: NOW - 1 }]) {
    const u = ui(); await u.open(); u.handle((c) => c.body?.action === "create" ? { ok: true, offer: { pairingId: "synthetic-pair", ...offer } } : undefined);
    await u.click("pair", u.page); await u.click("create-pair");
    assert.match(u.overlay().textContent, /返回状态不完整/); assert.doesNotMatch(u.overlay().textContent, /两端均已确认|123456/);
  }
});

test("joining requires full temporary code and both explicit local verification and peer confirmation", async () => {
  const u = ui(); await u.open(); u.handle((c) => {
    if (c.body?.action === "join") return { ok: true, pairing: pair() };
    if (c.body?.action === "confirm") return { ok: true, pairing: pair({ localConfirmed: true }) };
  });
  await u.click("pair", u.page); u.input("rs-pair-input", "123456"); await u.submit("rs-pair-form"); assert.equal(posts(u, "join").length, 0);
  assert.match(u.overlay().textContent, /不能使用短数字码/);
  u.input("rs-pair-input", syntheticCode); await u.submit("rs-pair-form");
  assert.deepEqual(posts(u, "join")[0].body, { action: "join", code: syntheticCode }); assert.doesNotMatch(u.overlay().textContent, new RegExp(syntheticCode));
  await u.click("confirm-pair"); assert.equal(posts(u, "confirm").length, 0);
  await u.change("rs-verify", true); await u.click("confirm-pair");
  assert.deepEqual(posts(u, "confirm")[0].body, { action: "confirm", pairingId: "synthetic-pair", verificationCode: "synthetic-verify-words", expectedFingerprint: syntheticDevice.fingerprint });
  assert.match(u.overlay().textContent, /等待另一端确认/); assert.doesNotMatch(u.overlay().textContent, /设备配对完成/);
  u.setPairing(list({ devices: [syntheticDevice], pending: [pair({ state: "paired", localConfirmed: true, peerConfirmed: true })] }));
  await u.click("refresh-pair"); assert.match(u.overlay().textContent, /对端是否已保存尚未核实/);
  assert.match(u.overlay().textContent, /现在仍未开放任何会话/); assert.equal(posts(u, "invite").length, 0);
});

test("pairing displays full escaped fingerprint without truncation and explicitly separates relay from E2EE", async () => {
  const full = "synthetic-public-".repeat(25) + "<synthetic-fingerprint-tail>";
  const u = ui({ pairing: list({ pending: [pair({ peer: { ...syntheticDevice, fingerprint: full } })] }) });
  await u.open(); assert.match(u.page.textContent, /中转连接在线不代表端到端安全通道已就绪/);
  await u.click("review-pair", u.page); assert.ok(u.overlay().textContent.includes(full));
  assert.ok(u.writes.at(-1).includes("&lt;synthetic-fingerprint-tail&gt;"));
});

test("pair identity changes reset verification and missing detail blocks confirmation", async () => {
  const u = ui({ pairing: list({ pending: [pair()] }) }); await u.open(); await u.click("review-pair", u.page); await u.change("rs-verify", true);
  u.setPairing(list({ pending: [pair({ verificationCode: "synthetic-changed-words", peer: { ...syntheticDevice, fingerprint: "synthetic-new-fingerprint" } })] }));
  await u.click("refresh-pair"); assert.equal(u.get("rs-verify").checked, false); assert.equal(u.overlay().querySelector('[data-rs="confirm-pair"]').disabled, true);
  u.setPairing(list({ pending: [pair({ peer: { ...syntheticDevice, fingerprint: "" } })] })); await u.click("refresh-pair"); await u.change("rs-verify", true); await u.click("confirm-pair"); assert.equal(posts(u, "confirm").length, 0);
});

test("one-use offer expires, hidden pages do not poll network, and cancel is not unpair or stop", async () => {
  const u = ui(); await u.open(); u.handle((c) => c.body?.action === "create" ? { ok: true, offer: { pairingId: "synthetic-pair", code: syntheticCode, expiresAt: NOW + 6000 } } : undefined);
  await u.click("pair", u.page); await u.click("create-pair");
  u.document.hidden = true; await u.fire("visibilitychange"); const before = u.calls.length; await u.advance(6000);
  assert.equal(u.calls.length, before); assert.match(u.overlay().textContent, /配对信息已过期/); assert.doesNotMatch(u.overlay().textContent, new RegExp(syntheticCode));
  assert.equal(u.timers.size, 0);
  u.OV.back(); u.document.hidden = false; await u.click("pair", u.page); u.handle((c) => c.body?.action === "join" ? { ok: true, pairing: pair({ expiresAt: NOW + 60000 }) } : undefined);
  u.input("rs-pair-input", syntheticCode); await u.submit("rs-pair-form"); await u.click("cancel-pair");
  assert.deepEqual(posts(u, "cancel")[0].body, { action: "cancel", pairingId: "synthetic-pair" }); assert.equal(posts(u, "unpair").length, 0);
});

test("unpair requires confirmation, verifies removal and signals cache invalidation without stopping task", async () => {
  const u = ui({ pairing: list({ devices: [syntheticDevice] }) }); await u.open(); await u.click("unpair", u.page);
  assert.equal(posts(u).length, 0); assert.match(u.overlay().textContent, /不停止平板任务/); assert.match(u.overlay().textContent, /无法远程擦除/);
  u.handle((c) => { if (c.body?.action === "unpair") { u.setPairing(list()); return { ok: true }; } });
  await u.click("confirm-unpair"); assert.deepEqual(posts(u)[0].body, { action: "unpair", deviceId: syntheticDevice.deviceId });
  assert.equal(u.overlay(), undefined); assert.equal(u.events.find((e) => e.type === "cc:remote-access-changed")?.detail.reason, "unpaired");
  assert.ok(u.calls.every((c) => c.body?.action !== "stop"));
});

// Local single-session hosting; remote handles never replace the local session ID.
test("unpaired hosting sheet provides actionable connection settings guidance", async () => {
  const u = ui({ hosted: hosting("synthetic-local-a", { devices: [] }) }); await u.hosting.open("synthetic-local-a");
  assert.match(u.overlay().textContent, /先连接手机/); assert.match(u.overlay().textContent, /不会|安全检查/);
  await u.click("settings"); assert.equal(u.overlay(), undefined); assert.equal(u.events.at(-1).type, "cc:remote-settings-open"); assert.equal(posts(u).length, 0);
});

test("hosting selects a specific paired device, shows privacy scope, and waits for returned invite state", async () => {
  const u = ui(); await u.hosting.open("synthetic-local-a");
  assert.equal(u.get("rs-host-device").getAttribute("data-remote-keyboard"), "1", "opt in only the remote host device picker to keyboard listbox behavior");
  assert.equal(u.overlay().querySelector('[data-rs="invite"]').disabled, true, "do not silently select the first device");
  assert.match(u.overlay().textContent, /不开放其他会话/); assert.match(u.overlay().textContent, /代码、日志或敏感信息/); assert.match(u.overlay().textContent, /接受不等于批准/);
  await u.change("rs-host-device", syntheticDevice.deviceId); const wait = deferred(); u.handle((c) => c.body?.action === "invite" ? wait.promise : undefined);
  await u.click("invite"); assert.doesNotMatch(u.overlay().textContent, /邀请已发出/);
  assert.deepEqual(posts(u, "invite")[0].body, { action: "invite", localSessionId: "synthetic-local-a", deviceId: syntheticDevice.deviceId });
  wait.resolve(hosting("synthetic-local-a", { hosting: grant() })); await u.flush();
  assert.match(u.overlay().textContent, /邀请已发出，等待手机接受/); assert.doesNotMatch(u.overlay().textContent, /已托管给/);
  u.setHosting(hosting("synthetic-local-a", { hosting: grant({ status: "active" }) })); await u.hosting.refresh(); assert.match(u.overlay().textContent, /已托管给/);
});

test("hosting offline disables invitations, and malformed 200 responses never claim success", async () => {
  const u = ui({ hosted: hosting("synthetic-local-a", { connection: { state: "disconnected" } }) }); await u.hosting.open("synthetic-local-a"); await u.change("rs-host-device", syntheticDevice.deviceId); await u.click("invite");
  assert.equal(posts(u).length, 0); assert.match(u.overlay().textContent, /中转未连接/);
  u.setHosting(hosting()); await u.hosting.refresh(); await u.change("rs-host-device", syntheticDevice.deviceId); u.handle((c) => c.body?.action === "invite" ? { ok: true } : undefined);
  await u.click("invite"); assert.match(u.overlay().textContent, /返回状态不完整/); assert.doesNotMatch(u.overlay().textContent, /邀请已发出|已托管给/);
});

test("revoke is a separate two-step action bound to current grant and never sends stop", async () => {
  const u = ui({ hosted: hosting("synthetic-local-a", { hosting: grant({ status: "active" }) }) }); await u.hosting.open("synthetic-local-a");
  await u.click("revoke"); assert.equal(posts(u).length, 0); assert.match(u.overlay().textContent, /平板原任务仍继续/);
  u.handle((c) => c.body?.action === "revoke" ? hosting("synthetic-local-a", { hosting: grant({ status: "revoked" }) }) : undefined);
  await u.click("confirm-revoke");
  assert.deepEqual(posts(u)[0].body, { action: "revoke", localSessionId: "synthetic-local-a", remoteSessionId: "synthetic-remote-handle", grantVersion: 3 });
  assert.match(u.overlay().textContent, /已收回托管，平板任务不受影响/); assert.equal(u.events.find((e) => e.type === "cc:remote-access-changed")?.detail.reason, "revoked");
  assert.equal(u.calls.some((c) => /stop|\/api\/chat|\/api\/perm/.test(c.url) || c.body?.action === "stop"), false);
});

test("late session status or mutation cannot overwrite a newly opened hosting target", async () => {
  const u = ui(), first = deferred(); u.handle((c) => c.url.endsWith("synthetic-local-a") ? first.promise : hosting("synthetic-local-b", { session: { localSessionId: "synthetic-local-b", title: "Synthetic B only" } }));
  const loading = u.hosting.open("synthetic-local-a"); await u.flush(); await u.hosting.open("synthetic-local-b"); first.resolve(hosting()); await loading;
  assert.match(u.overlay().textContent, /Synthetic B only/); assert.doesNotMatch(u.overlay().textContent, /Synthetic chosen session/);
  await u.change("rs-host-device", syntheticDevice.deviceId); const invite = deferred(); u.handle((c) => c.body?.action === "invite" ? invite.promise : hosting("synthetic-local-c"));
  await u.click("invite"); await u.hosting.open("synthetic-local-c"); invite.resolve(hosting("synthetic-local-b", { hosting: grant() })); await u.flush();
  assert.doesNotMatch(u.overlay().textContent, /邀请已发出/); assert.equal(u.calls.at(-1).url, "/api/remote/hosting?localSessionId=synthetic-local-c");
});

test("pending mutation interrupted by pagehide never reports success or retries side effect", async () => {
  const u = ui(), wait = deferred(); await u.hosting.open("synthetic-local-a"); await u.change("rs-host-device", syntheticDevice.deviceId);
  u.handle((c) => c.body?.action === "invite" ? wait.promise : undefined); await u.click("invite"); await u.fire("pagehide");
  wait.resolve(hosting("synthetic-local-a", { hosting: grant() })); await u.flush(); assert.equal(u.overlay(), undefined);
  await u.advance(30000); assert.equal(posts(u, "invite").length, 1, "never enqueue or automatically replay an invitation");
});

test("timeout makes invitation outcome unknown, requires status refresh, and does not retry", async () => {
  const u = ui(); await u.hosting.open("synthetic-local-a"); await u.change("rs-host-device", syntheticDevice.deviceId);
  u.handle((c) => {
    if (c.body?.action === "invite") return new Promise((resolve, reject) => c.signal.addEventListener("abort", () => reject(Object.assign(new Error("synthetic abort"), { name: "AbortError" })), { once: true }));
  });
  await u.click("invite"); await u.advance(20000);
  assert.match(u.overlay().textContent, /结果待核实/); assert.doesNotMatch(u.overlay().textContent, /邀请已发出/);
  assert.equal(u.overlay().querySelector('[data-rs="invite"]').disabled, true);
  await u.click("invite"); assert.equal(posts(u, "invite").length, 1);
  u.setHosting(hosting("synthetic-local-a", { hosting: grant() })); await u.click("refresh-hosting");
  assert.match(u.overlay().textContent, /邀请已发出/); assert.equal(posts(u, "invite").length, 1);
});

test("join may not auto-confirm local trust, and confirmed identity cannot change on polling", async () => {
  const u = ui(); await u.open(); await u.click("pair", u.page);
  u.handle((c) => c.body?.action === "join" ? { ok: true, pairing: pair({ state: "paired", localConfirmed: true, peerConfirmed: true }) } : undefined);
  u.input("rs-pair-input", syntheticCode); await u.submit("rs-pair-form");
  assert.match(u.overlay().textContent, /返回状态不完整/); assert.doesNotMatch(u.overlay().textContent, /配对完成/);
  u.OV.back(); u.setPairing(list({ pending: [pair({ localConfirmed: true })] })); u.handle(() => undefined); await u.open(); await u.click("review-pair", u.page);
  u.setPairing(list({ pending: [pair({ state: "paired", localConfirmed: true, peerConfirmed: true, peer: { ...syntheticDevice, fingerprint: "synthetic-substituted-device" } })] }));
  await u.click("refresh-pair"); assert.match(u.overlay().textContent, /核对信息不一致/); assert.doesNotMatch(u.overlay().textContent, /配对完成/);
});

test("modal redraw preserves keyboard focus and keeps role on the OV focus target", async () => {
  const u = ui(); await u.open(); await u.click("pair", u.page); const root = u.overlay();
  assert.equal(root.getAttribute("role"), "dialog"); assert.equal(root.getAttribute("aria-modal"), "true");
  root.querySelector('[data-rs="create-pair"]').focus();
  u.handle((c) => c.body?.action === "create" ? { ok: true, offer: { pairingId: "synthetic-pair", code: syntheticCode, expiresAt: NOW + 60000 } } : undefined);
  await u.click("create-pair"); assert.equal(root.contains(u.document.activeElement), true, "replacement controls do not strand focus in removed nodes");
});

test("production runtime settings, reminders, offer and hosted snapshot feed the real GUI without flattening", async (t) => {
  const f = await runtimeFixture(t), u = ui();
  u.handle((c) => {
    if (c.url === "/api/remote/settings") return c.body?.action === "reminders" ? f.runtime.reminders(c.body.enabled) : f.runtime.settings();
    if (c.url === "/api/remote/pairing") return c.body?.action === "create" ? f.runtime.pairOffer() : f.runtime.pairing();
    if (c.url.startsWith("/api/remote/hosting?")) return f.runtime.hosting(new URL(c.url, "https://synthetic.invalid").searchParams.get("localSessionId"));
  });
  await u.open(); assert.equal(u.get("rs-server").value, "https://relay-a.example.invalid"); assert.equal(u.get("rs-credential").value, "");
  assert.equal(f.background.length, 0, "reading settings does not opt the user into background mode");
  await u.click("reminders", u.page); assert.equal(u.get("rs-reminders").getAttribute("aria-checked"), "true");
  assert.deepEqual(f.background, [{ enabled: true, options: { userInitiated: true } }]);
  await u.click("pair", u.page); await u.click("create-pair");
  const offered = JSON.parse(u.overlay().querySelector("code").textContent);
  assert.equal(validatePairingOffer(offered, { now: () => NOW }).tablet.spkiSha256, syntheticPin);
  assert.doesNotMatch(u.overlay().textContent, /返回状态不完整/); assert.equal(f.probes.length, 1);
  assert.doesNotMatch(u.writes.join(""), new RegExp(f.token));
  u.OV.back(); await u.hosting.open("synthetic-local-a"); assert.match(u.overlay().textContent, /先连接手机/);
});

test("actual local remote route preserves GUI action bodies and current grant bindings", async () => {
  const { createRemoteRoute } = await import("../gw/remote.mjs");
  const calls = [], runtime = new Proxy({}, { get: (_target, action) => async (body) => { calls.push({ action, body }); return { ok: true, action }; } });
  const route = createRemoteRoute(runtime);
  const invoke = async (url, data) => {
    const req = new PassThrough(); req.method = data ? "POST" : "GET"; req.ccAuthed = true;
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, writeHead(code, headers) { this.code = code; Object.assign(this.headers, headers); }, end(data) { this.value = JSON.parse(String(data)); } };
    const u = new URL(url, "http://127.0.0.1"), done = route(req, res, u, u.pathname); req.end(data ? JSON.stringify(data) : ""); await done; return res;
  };
  const confirm = { action: "confirm", pairingId: "synthetic-offer", expectedFingerprint: syntheticPin, verificationCode: "synthetic-verification" };
  const revoke = { action: "revoke", localSessionId: "synthetic-local-a", remoteSessionId: "synthetic-remote-a", grantVersion: 5 };
  assert.equal((await invoke("/api/remote/pairing", confirm)).code, 200);
  assert.deepEqual(calls.at(-1), { action: "pairConfirm", body: confirm });
  assert.equal((await invoke("/api/remote/hosting", revoke)).code, 200);
  assert.deepEqual(calls.at(-1), { action: "revoke", body: revoke });
  const get = await invoke("/api/remote/hosting?localSessionId=synthetic-local-a"); assert.equal(get.code, 200); assert.equal(get.headers["cache-control"], "no-store"); assert.deepEqual(calls.at(-1), { action: "hosting", body: "synthetic-local-a" });
});

test("production hosting returns the latest session grant tombstone rather than the first obsolete one", async (t) => {
  const f = await runtimeFixture(t, { initialGrants: [{ remoteSessionId: "synthetic-obsolete-grant" }, { remoteSessionId: "synthetic-latest-grant", grantVersion: 2 }] });
  const snapshot = await f.runtime.hosting("synthetic-local-a");
  assert.equal(snapshot.hosting.remoteSessionId, "synthetic-latest-grant", "new invite/revoke result must bind the latest grant for this session");
  assert.equal(snapshot.hosting.grantVersion, 2);
});

test("production diagnose must initiate a fresh bounded probe of the submitted endpoint", async (t) => {
  const f = await runtimeFixture(t); await f.runtime.connect(); const before = f.probes.length;
  const result = await f.runtime.diagnose({ serverUrl: "https://relay-b.example.invalid", deviceName: f.identity.name, credential: JSON.stringify({ deviceId: f.identity.deviceId, token: f.token }) });
  assert.ok(f.probes.length > before || f.registrations.some((url) => url.startsWith("https://relay-b.example.invalid/")), "new form endpoint must be contacted, not merely parsed by relayUrl");
  assert.ok(!result.diagnostic.checks.every((check) => check.status === "pass") || f.probes.at(-1).serverUrl === "https://relay-b.example.invalid", "old endpoint status cannot certify a new one");
});

test("production diagnose must not replace and drop an existing authenticated device route", async (t) => {
  const f = await runtimeFixture(t); await f.runtime.connect(); const current = f.probes[0];
  const result = await f.runtime.diagnose({ serverUrl: "https://relay-a.example.invalid", deviceName: f.identity.name });
  assert.equal(result.diagnostic.state, "online");
  assert.equal(current.replaced, false, "a diagnostic WebSocket with the same device ID kicks the original connection and its E2EE tunnels");
  assert.equal((await f.runtime.settings()).connection.state, "online", "testing connectivity must leave the active route available");
});

test("production configure may not certify a new unreachable endpoint using an old online relay", async (t) => {
  const f = await runtimeFixture(t); await f.runtime.connect(); let rejected = false;
  try { await f.runtime.configure({ serverUrl: "https://unreachable.example.invalid", deviceName: f.identity.name, credential: JSON.stringify({ deviceId: f.identity.deviceId, token: f.token }) }); } catch { rejected = true; }
  const result = await f.runtime.diagnose({ serverUrl: "https://unreachable.example.invalid", deviceName: f.identity.name });
  assert.ok(f.probes.some((probe) => probe.serverUrl === "https://unreachable.example.invalid" && probe.connects > 0), "changing endpoint must contact that endpoint");
  assert.ok(rejected || result.diagnostic.state !== "online", "unreachable endpoint may not inherit previous online success");
  assert.notEqual(result.diagnostic.state, "online");
});

test("embedded remote settings leave touch scrolling to the host pane", () => {
  const page = /#remoteSettingsPage\.rs-page\{([^}]+)\}/.exec(css)?.[1];
  assert.ok(page); assert.match(page, /(?:^|;)overflow:visible(?:;|$)/);
  assert.doesNotMatch(page, /overscroll-behavior[^:]*:(?:contain|none)/);
  assert.doesNotMatch(page, /(?:^|;)(?:max-)?height:/);
  assert.match(css, /\.rs-dialog-body\{[^}]*overflow:auto[^}]*overscroll-behavior:contain/);
});

test("remote hosting modal stays below the host selection menu and toast", () => {
  const hostCss = fs.readFileSync(new URL("../web/style.css", import.meta.url), "utf8");
  const overlay = Number(/\.rs-overlay\{[^}]*z-index:(\d+)/.exec(css)?.[1]);
  const menu = Number(/\.pop-menu\{[^}]*z-index:(\d+)/.exec(hostCss)?.[1]);
  const setting = Number(/#set-ov\{[^}]*z-index:(\d+)/.exec(hostCss)?.[1]);
  assert.ok(overlay > setting, "remote modal must cover host settings");
  assert.ok(overlay < menu, "host intercepts select clicks; its DOM menu must remain on top");
  assert.match(hostCss, /#toast\{z-index:96\}/); assert.ok(overlay < 96);
});

test("theme scoped sheets retain 44px targets, narrow wrapping and existing modal manager", () => {
  assert.match(css, /min-height:44px/); assert.match(css, /@media\(max-width:420px\)/); assert.match(css, /overflow-wrap:anywhere/);
  assert.match(css, /var\(--accent-btn/); assert.match(css, /var\(--bg\)/); assert.match(css, /var\(--fg2\)/); assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i);
  assert.match(source, /OV\.open\(el, \{ kind: "modal"/); assert.doesNotMatch(source, /\b(?:localStorage|sessionStorage|eval|fetch|confirm|prompt)\s*[.(]/);
  assert.match(source, /t\("我已核对这是本人对端设备及其完整指纹，两端校验码一致"\)/);
});
