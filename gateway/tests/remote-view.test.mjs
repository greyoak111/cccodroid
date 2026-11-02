// Execute the production remote page inside a small dependency-free DOM.
// Every device, request and receipt below is synthetic; never connect a real gateway or model.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createPhoneManager } from "../gw/remote/phone.mjs";
import { createFrame } from "../gw/remote/protocol.mjs";

const source = fs.readFileSync(new URL("../web/app/13s-remote-view.js", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../web/remote-view.css", import.meta.url), "utf8");
const settingsCss = fs.readFileSync(new URL("../web/remote-settings.css", import.meta.url), "utf8");
const hostCss = fs.readFileSync(new URL("../web/style.css", import.meta.url), "utf8");
const decode = (value) => String(value).replace(/&(amp|lt|gt|quot|#39);/g, (all, entity) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" }[entity]));
const clone = (value) => structuredClone(value);
const declarations = (sheet, selector) => {
  const body = sheet.split(selector + "{")[1]?.split("}")[0];
  assert.notEqual(body, undefined, `missing CSS rule ${selector}`);
  return Object.fromEntries(body.split(";").filter((entry) => entry.includes(":")).map((entry) => {
    const colon = entry.indexOf(":"); return [entry.slice(0, colon).trim(), entry.slice(colon + 1).trim()];
  }));
};
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { resolve, reject, promise }; };
const permission = (extra = {}) => ({ requestId: "request-one", requestVersion: 1, runId: "run-one", kind: "permission", state: "pending", toolName: "Bash", summary: "Run synthetic tests", detailText: JSON.stringify({ toolName: "Bash", input: { command: "npm test" }, guard: null }), detailsComplete: true, expiresAt: Date.now() + 600_000, ...extra });
const snapshot = (id = "remote-one", extra = {}) => {
  const value = { authorization: "active", canControl: true, title: "Synthetic task", deviceName: "Synthetic tablet", run: { runId: "run-one", state: "running" }, messages: [{ id: "message-one", role: "assistant", text: "Synthetic reply" }], requests: [], receipts: [], ...extra };
  return {
    revision: 1, generation: 1, deviceId: "phone-one", connection: "online", phase: "ready", verified: true, canControl: value.canControl,
    active: { remoteSessionId: id, deviceId: "tablet-one", title: value.title, deviceName: value.deviceName },
    binding: { fromDeviceId: "phone-one", toDeviceId: "tablet-one", hostInstanceId: "host-one", remoteSessionId: id, grantVersion: 1, runId: value.run.runId },
    grant: { state: value.authorization, expiresAt: Date.now() + 600_000 }, run: value.run,
    sessions: [], items: value.messages, pending: value.requests, receipts: value.receipts, streamId: "stream-one", seq: 1,
    historyCursor: extra.historyCursor || null, historyHasMore: extra.historyHasMore || false, historyBusy: false, cached: false,
    lastSyncedAt: Date.now(), error: null, cache: { bytes: 100, items: value.messages.length, truncated: false },
  };
};
const state = (data = snapshot(), extra = {}) => ({ ...data, ...extra });

function ui(initial = state(), { keyboard = false } = {}) {
  const calls = [], translations = [], violations = [], listeners = new Set();
  let current = clone(initial), list = { sessions: [] }, nextCommand = 0, settingsOpened = 0;
  const hooks = {}, document = { activeElement: null };
  const match = (node, selector) => {
    selector = selector.trim();
    const not = /:not\(([^)]+)\)/.exec(selector);
    if (not) { if (match(node, not[1])) return false; selector = selector.replace(not[0], ""); }
    const tag = /^[\w-]+/.exec(selector)?.[0];
    if (tag && tag.toUpperCase() !== node.tagName) return false;
    for (const name of selector.matchAll(/\.([\w-]+)/g)) if (!node.classList.contains(name[1])) return false;
    for (const attr of selector.matchAll(/\[([\w-]+)(?:=['"]([^'"]*)['"])?\]/g)) {
      if (!Object.hasOwn(node.attributes, attr[1])) return false;
      if (attr[2] !== undefined && node.attributes[attr[1]] !== attr[2]) return false;
    }
    return true;
  };
  class Node {
    constructor(tag = "div") {
      this.tagName = tag.toUpperCase(); this.attributes = {}; this.dataset = {}; this.children = [];
      this.listeners = {}; this.parentElement = null; this._html = ""; this._text = ""; this.disabled = false;
      this.checked = false; this.hidden = false; this.value = ""; this.open = false; this.isConnected = false;
      this.scrollTop = 0; this.scrollHeight = 300; this.clientHeight = 200; this.selectionStart = 0; this.selectionEnd = 0;
      const classes = new Set();
      this.classList = { add: (...values) => values.forEach((value) => classes.add(value)), remove: (...values) => values.forEach((value) => classes.delete(value)), contains: (value) => classes.has(value) };
    }
    set className(value) { this.setAttribute("class", value); }
    get className() { return this.attributes.class || ""; }
    setAttribute(name, value) {
      value = decode(value); this.attributes[name] = value;
      if (name === "class") this.classList.add(...value.split(/\s+/));
      if (name.startsWith("data-")) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase())] = value;
      if (["id", "type", "value", "name"].includes(name)) this[name] = value;
      if (["disabled", "checked", "open", "hidden"].includes(name)) this[name] = true;
    }
    set innerHTML(value) {
      for (const node of this.children) { node.disconnect(); node.parentElement = null; }
      this.children = []; this._text = ""; this._html = String(value);
      const stack = [this];
      for (const token of this._html.matchAll(/<\/[\w-]+\s*>|<[\w-]+\b[^>]*>|[^<]+/g)) {
        const text = token[0];
        if (text.startsWith("</")) { stack.pop(); continue; }
        if (text.startsWith("<")) {
          const tag = /^<([\w-]+)/.exec(text)[1], node = new Node(tag);
          const attributes = text.slice(tag.length + 1, -1);
          for (const attr of attributes.matchAll(/([\w-]+)(?:="([^"]*)"|='([^']*)'|=([^\s>]+))?/g)) node.setAttribute(attr[1], attr[2] ?? attr[3] ?? attr[4] ?? "");
          stack.at(-1).appendChild(node);
          if (!["input", "img", "br", "hr", "meta", "link"].includes(tag.toLowerCase()) && !text.endsWith("/>")) stack.push(node);
        } else {
          const parent = stack.at(-1), value = decode(text);
          // HTML ignores the first LF immediately after a textarea start tag.
          parent._text += parent.tagName === "TEXTAREA" && !parent._text ? value.replace(/^\n/, "") : value;
          if (parent.tagName === "TEXTAREA") parent.value = parent._text;
        }
      }
    }
    get innerHTML() { return this._html; }
    get textContent() { return this._text + this.children.map((child) => child.textContent).join(""); }
    appendChild(node) { this.children.push(node); node.parentElement = this; node.connect(this.isConnected); return node; }
    connect(value) { this.isConnected = value; for (const child of this.children) child.connect(value); }
    disconnect() { if (this.contains(document.activeElement)) document.activeElement = body; this.connect(false); }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((node) => node !== this); this.parentElement = null; this.disconnect(); }
    contains(node) { for (let value = node; value; value = value.parentElement) if (value === this) return true; return false; }
    querySelectorAll(selector) {
      const selectors = selector.split(","), found = [];
      const walk = (node) => { for (const child of node.children) { if (selectors.some((part) => match(child, part))) found.push(child); walk(child); } };
      walk(this); return found;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    closest(selector) { for (let node = this; node; node = node.parentElement) if (match(node, selector)) return node; return null; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    dispatchEvent(event) {
      event.target ||= this;
      for (const fn of this.listeners[event.type] || []) fn(event);
      if (event.bubbles && this.parentElement) this.parentElement.dispatchEvent(event);
      return true;
    }
    focus() { document.activeElement = this; }
    setSelectionRange(start, end, direction = "none") { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction; }
    scrollIntoView() { this.scrolled = true; }
  }
  const body = new Node("body"), root = new Node("section");
  body.connect(true); root.setAttribute("id", "remotePage"); body.appendChild(root);
  Object.assign(document, { body, getElementById: (id) => id === "remotePage" ? root : null, createElement: (tag) => new Node(tag) });
  let overlay = null;
  const OV = {
    open(element, options) {
      const from = document.activeElement;
      body.appendChild(element); overlay = { element, options, from };
      // Match real OV/focusInto: pointer input focuses the outer root, keyboard its first button.
      (keyboard ? element.querySelector("button") || element : element).focus();
    },
    close(element) {
      const entry = overlay?.element === element ? overlay : null;
      element.remove();
      if (entry) {
        overlay = null; entry.options.onClose?.();
        if ((element.contains(document.activeElement) || document.activeElement === body) && entry.from?.isConnected) entry.from.focus();
      }
    },
  };
  const transport = Object.fromEntries(["status", "list", "open", "accept", "decline", "close", "history", "sendText", "respond", "stop", "query"].map((method) => [method, async (...args) => {
    calls.push({ method, args: clone(args) });
    if (hooks[method]) return hooks[method](...args);
    if (method === "status") return clone(current);
    if (method === "list") return clone(list);
    if (method === "open" || method === "accept") return clone(current);
    if (method === "close") return undefined;
    if (method === "history") return clone(current);
    const commandId = method === "respond" ? args[2] : method === "sendText" ? args[1] : args[0];
    return { commandId, status: "received" };
  }]));
  transport.subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
  const forbidden = (name) => () => { const error = new Error(`forbidden local operation: ${name}`); violations.push(error); throw error; };
  const sandbox = {
    document, TextEncoder, structuredClone, OV,
    t(key, vars = {}) { translations.push(key); return String(key).replace(/\{(\w+)\}/g, (all, name) => Object.hasOwn(vars, name) ? String(vars[name]) : all); },
    remoteTransport: transport, remoteSettings: { open: () => settingsOpened++ },
    crypto: { randomUUID: () => `synthetic-command-${++nextCommand}` },
    CustomEvent: class { constructor(type, options = {}) { this.type = type; Object.assign(this, options); } },
    fetch: forbidden("fetch"), api: forbidden("api"), post: forbidden("post"), send: forbidden("send"), openViewer: forbidden("openViewer"),
    localStorage: { getItem: forbidden("read localStorage"), setItem: forbidden("write localStorage") },
    sessionStorage: { getItem: forbidden("read sessionStorage"), setItem: forbidden("write sessionStorage") },
    trapTab(element, event) { if (event.key === "Tab") event.trapped = true; },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(source, sandbox, { filename: "13s-remote-view.js" });
  const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); if (violations.length) throw violations[0]; };
  const select = (action, id, within = body) => within.querySelectorAll("button[data-rv]").find((node) => node.dataset.rv === action && (id === undefined || node.dataset.id === id));
  return {
    calls, root, body, document, hooks, translations, flush, view: sandbox.remoteView,
    get html() { return root.innerHTML; }, get modal() { return overlay?.element; }, get settingsOpened() { return settingsOpened; },
    sessions(value) { list = clone(value); },
    emit(value) { current = clone(value); for (const listener of listeners) listener(clone(current)); },
    set(value) { current = clone(value); },
    get(action, id, within = body) { return select(action, id, within); },
    useTransport(value) { sandbox.remoteTransport = value; },
    installRealTransport(options) {
      vm.runInNewContext(fs.readFileSync(new URL("../web/app/13r-remote-transport.js", import.meta.url), "utf8"), { ...sandbox, AbortController, setTimeout, clearTimeout, globalThis: sandbox }, { filename: "13r-remote-transport.js" });
      sandbox.remoteTransport = sandbox.createRemoteTransport(options);
      return sandbox.remoteTransport;
    },
    async open(id) { await sandbox.remoteView.open(id); await flush(); },
    async click(action, id, within = body) {
      const node = select(action, id, within); assert.ok(node, `missing ${action} button`);
      if (!node.disabled) node.dispatchEvent({ type: "click", bubbles: true, target: node, preventDefault() {} });
      await flush(); return node;
    },
    async input(selector, value, extra = {}) {
      const node = root.querySelector(selector); assert.ok(node, `missing input ${selector}`);
      node.value = value; Object.assign(node, extra); node.dispatchEvent({ type: "input", bubbles: true, target: node }); await flush(); return node;
    },
    async paste(selector, value) {
      const node = root.querySelector(selector); assert.ok(node, `missing paste target ${selector}`);
      // Model the native maxlength pre-truncation before the input listener.
      const maximum = node.attributes.maxlength === undefined ? Infinity : Number(node.attributes.maxlength);
      node.value = value.slice(0, maximum);
      node.dispatchEvent({ type: "input", inputType: "insertFromPaste", bubbles: true, target: node }); await flush();
      return node;
    },
    back() { const node = overlay?.element || root; node.dispatchEvent({ type: "keydown", target: node, key: "Escape", preventDefault() {}, stopPropagation() {} }); },
    controls(method) { return calls.filter((call) => call.method === method); },
    async review(id = "request-one") { await this.click("details", id); await this.click("details-read", id); },
  };
}

test("remote view: exported page API is usable without local models, only authorized list/invites appear", async () => {
  const u = ui();
  assert.deepEqual(Object.keys(u.view).sort(), ["close", "open", "refresh"]);
  u.sessions({ sessions: [
    { remoteSessionId: "invitation-one", state: "invited", title: '<img src=x onerror="bad()">', deviceName: "Synthetic tablet" },
    { remoteSessionId: "remote-one", state: "active", title: "Authorized", connection: "online", pendingCount: 1 },
    { remoteSessionId: "remote-hidden", state: "revoked", title: "Must not display" },
  ] });
  await u.open();
  assert.match(u.html, /接受并打开/); assert.match(u.html, /Authorized/); assert.doesNotMatch(u.html, /Must not display|<img/);
  assert.match(u.html, /&lt;img/); assert.equal(u.root.dataset.remoteSessionId, "");
  assert.equal(u.controls("list").length, 1);
  await u.click("settings"); assert.equal(u.settingsOpened, 1);
  await u.click("open", "remote-one"); assert.equal(u.root.dataset.remoteSessionId, "remote-one");
  assert.equal(u.controls("open").at(-1).args[0], "remote-one");
});

test("remote view: accepting/declining invitations calls explicit transport methods, never just opens", async () => {
  const u = ui(); u.sessions({ sessions: [{ remoteSessionId: "remote-one", state: "invited", title: "Invitation", deviceName: "Tablet" }] });
  const accepting = deferred(); u.hooks.accept = () => accepting.promise;
  await u.open(); await u.click("accept", "remote-one");
  assert.equal(u.controls("accept").length, 1); assert.equal(u.controls("open").length, 0);
  assert.doesNotMatch(u.html, /Synthetic reply/);
  accepting.resolve(state()); await u.flush(); assert.match(u.html, /Synthetic reply/);
  const v = ui(); v.sessions({ sessions: [{ remoteSessionId: "remote-one", state: "invited", title: "Decline me" }] });
  const declined = deferred(); v.hooks.decline = () => declined.promise;
  await v.open(); await v.click("decline", "remote-one"); assert.match(v.html, /Decline me/); assert.equal(v.get("accept").disabled, true);
  declined.resolve({ ...snapshot(), active: null, binding: null, grant: null, pending: [], items: [], sessions: [], phase: "idle", canControl: false }); await v.flush();
  assert.doesNotMatch(v.html, /Decline me/); assert.equal(v.controls("stop").length, 0);
  const native = ui(state(snapshot("remote-one", { authorization: "invited", canControl: false })));
  await native.view.open("remote-one", true);
  assert.equal(native.controls("accept").length, 0, "public/native open cannot accept an invitation even with extra arguments");
  assert.equal(native.controls("open").length, 1); assert.match(native.html, /请先接受托管邀请/);
});

test("remote view: messages, tool input/output and tablet paths are escaped inert content", async () => {
  const u = ui(state(snapshot("remote-one", {
    messages: [{ role: "user", text: '<script>bad()</script> /tablet/project/file.txt', source: "phone" }, { role: "assistant", text: "Reply [file](/api/file?path=/tablet/private)", tools: [{ tool: "Edit", input: { file_path: "/tablet/project/file.txt", new_string: '<img src="file://x">' }, output: "<svg onload=bad()>" }] }],
  })));
  await u.open("remote-one");
  assert.doesNotMatch(u.html, /<script|<img|<svg onload|href=|\/api\/models|data-path/);
  assert.match(u.html, /&lt;script&gt;/); assert.match(u.html, /来自手机/); assert.match(u.html, /rv-tool tool/);
  assert.equal(u.root.querySelectorAll("details").length, 1); assert.equal(u.root.querySelectorAll("a").length, 0);
});

test("remote view: a source-clipped message visibly discloses its limited preview", async () => {
  const u = ui(state(snapshot("remote-one", { messages: [{ id: "clipped-output", kind: "message", role: "assistant", text: "Visible prefix", truncated: true }] })));
  await u.open("remote-one");
  assert.match(u.root.querySelector("article").textContent, /Visible prefix[\s\S]*输出已限量/);
  assert.equal(u.root.querySelectorAll("a").length, 0);
});

test("remote view: labelled subagent text stays model output rather than session state", async () => {
  const u = ui(state(snapshot("remote-one", { messages: [{ id: "sub-output", kind: "message", role: "assistant", text: "[子代理输出]\n任务已经停止<script>" }] })));
  await u.open("remote-one");
  const article = u.root.querySelector("article");
  assert.equal(article.classList.contains("bot"), true); assert.equal(article.classList.contains("sys"), false);
  assert.equal(article.querySelector(".who").textContent, "CC · 在平板执行");
  assert.match(article.querySelector(".bubble").textContent, /子代理输出\n任务已经停止<script>/);
  assert.ok(u.translations.includes("子代理输出")); assert.match(u.html, /&lt;script&gt;/);
  assert.equal(u.root.querySelectorAll("script").length, 0);
});

test("remote view: incomplete permission scope cannot be allowed even after details; deny is tablet-receipted", async () => {
  const u = ui(state(snapshot("remote-one", { requests: [permission({ detailsComplete: false, input: { command: "truncated..." } })] })));
  await u.open("remote-one");
  assert.equal(u.get("approve").disabled, true); await u.click("details");
  assert.equal(u.get("details-read"), undefined); assert.match(u.modal.innerHTML, /完整审批范围不可用/);
  await u.click("modal-close"); await u.click("approve"); assert.equal(u.controls("respond").length, 0);
  await u.click("deny-toggle"); await u.input('[data-rv-field="reason"]', "Please review on tablet"); await u.click("deny");
  const call = u.controls("respond")[0];
  assert.deepEqual(call.args[1], { kind: "permission", decision: "deny", reason: "Please review on tablet" });
  assert.match(u.html, /等待处理回执/); assert.doesNotMatch(u.html, /平板已确认：已拒绝/);
  u.emit(state(snapshot("remote-one", { requests: [permission({ detailsComplete: false })], receipts: [{ commandId: call.args[2], status: "applied", result: { kind: "request", requestId: "request-one", requestVersion: 1 } }] })));
  assert.match(u.html, /平板已确认：已拒绝/); assert.equal(u.get("approve").disabled, true);
});

test("remote view: approval needs complete details and explicit review; no permanent/mode controls", async () => {
  const full = "line\n".repeat(90) + "LAST-LINE";
  const u = ui(state(snapshot("remote-one", { requests: [permission({ toolName: "Edit", detailText: JSON.stringify({ toolName: "Edit", input: { file_path: "/tablet/file", old_string: "old", new_string: full } }) })] })));
  await u.open("remote-one"); assert.equal(u.get("approve").disabled, true);
  await u.click("details"); assert.match(u.modal.innerHTML, /LAST-LINE/); assert.match(u.modal.innerHTML, /\/tablet\/file/);
  assert.equal(u.modal.attributes.role, "dialog"); assert.equal(u.modal.attributes["aria-modal"], "true");
  await u.click("details-read", "request-one"); assert.equal(u.get("approve").disabled, false);
  assert.doesNotMatch(u.html, /data-mode=|data-rv="always"|data-rv="attach"|data-rv="model"/);
  await u.click("approve"); await u.click("approve"); assert.equal(u.controls("respond").length, 1);
  assert.deepEqual(u.controls("respond")[0].args[1], { kind: "permission", decision: "allow" });
  assert.match(u.html, /平板已接收/); assert.doesNotMatch(u.html, /平板已确认：仅本次允许/);
});

test("remote view: multiple questions preserve checkbox and free answers, submit strict protocol shape", async () => {
  const question = permission({ kind: "question", toolName: "AskUserQuestion", questions: [
    { questionId: "question-one", question: "Choose checks", multiSelect: true, options: [{ optionId: "unit", label: "Unit" }, { optionId: "ui", label: "UI" }], allowText: true },
    { questionId: "question-two", question: "Anything else?", multiSelect: false, options: [], allowText: true },
  ] });
  const u = ui(state(snapshot("remote-one", { requests: [question] })));
  await u.open("remote-one"); await u.review();
  await u.input('input[value="unit"]', "unit", { checked: true }); await u.input('input[value="ui"]', "ui", { checked: true });
  await u.input('textarea[data-question="question-two"]', "Do not commit");
  u.emit(state(snapshot("remote-one", { requests: [question] })));
  assert.equal(u.root.querySelector('input[value="unit"]').checked, true); assert.equal(u.root.querySelector('textarea[data-question="question-two"]').value, "Do not commit");
  await u.click("approve");
  assert.deepEqual(u.controls("respond")[0].args[1], { kind: "question", answers: [
    { questionId: "question-one", optionIds: ["unit", "ui"] },
    { questionId: "question-two", optionIds: [], text: "Do not commit" },
  ] });
});

test("remote view: plan approval keeps per-operation checks, return has optional reason", async () => {
  const plan = permission({ kind: "plan", toolName: "ExitPlanMode", detailText: "1. Fix\n2. Test\n3. Report" });
  const u = ui(state(snapshot("remote-one", { requests: [plan] })));
  await u.open("remote-one"); assert.match(u.html, /逐项确认执行/); await u.review(); await u.click("approve");
  assert.deepEqual(u.controls("respond")[0].args[1], { kind: "plan", decision: "approve" });
  const v = ui(state(snapshot("remote-one", { requests: [plan] }))); await v.open("remote-one");
  await v.click("deny-toggle"); await v.input('[data-rv-field="reason"]', "Please reduce scope"); await v.click("deny");
  assert.deepEqual(v.controls("respond")[0].args[1], { kind: "plan", decision: "reject", reason: "Please reduce scope" });
});

test("remote view: offline allows memory-only draft, never queues controls; resync must be explicitly authorized", async () => {
  const data = snapshot("remote-one", { requests: [permission()] }), u = ui(state(data));
  await u.open("remote-one"); await u.review();
  u.emit(state(data, { connection: "offline" })); await u.input('[data-rv-field="draft"]', "Offline draft");
  assert.equal(u.get("send").disabled, true); assert.equal(u.get("approve").disabled, true); assert.equal(u.get("stop").disabled, true);
  await u.click("send"); assert.equal(u.controls("sendText").length, 0); assert.match(u.html, /缓存/);
  u.emit(state({ ...data, canControl: false }, { connection: "syncing" })); assert.equal(u.get("send").disabled, true);
  u.emit(state(data)); assert.equal(u.root.querySelector('[data-rv-field="draft"]').value, "Offline draft");
  assert.equal(u.controls("sendText").length, 0); assert.equal(u.get("send").disabled, false);
  await u.click("send"); assert.equal(u.controls("sendText").length, 1);
});

test("remote view: unknown message outcome locks re-send and only queries the original commandId", async () => {
  const u = ui(); u.hooks.sendText = async () => { throw Object.assign(new Error("synthetic disconnect"), { code: "OFFLINE" }); };
  await u.open("remote-one"); await u.input('[data-rv-field="draft"]', "/help plain text"); await u.click("send");
  const first = u.controls("sendText")[0]; assert.equal(first.args[0], "/help plain text"); assert.match(u.html, /结果待核实/);
  await u.input('[data-rv-field="draft"]', "Do not auto-retry"); await u.click("send"); assert.equal(u.controls("sendText").length, 1);
  u.hooks.query = async (id) => ({ commandId: id, status: "applied", result: { kind: "message", delivery: "queued" } });
  await u.click("query", first.args[1]);
  assert.deepEqual(u.controls("query")[0].args, [first.args[1]]); assert.equal(u.controls("sendText").length, 1);
  assert.match(u.html, /已进入原会话队列/); assert.equal(u.get("send").disabled, false);
});

test("remote view: pushed terminal receipts survive a later operation rejection", async () => {
  for (const kind of ["message", "request", "stop"]) for (const status of ["applied", "rejected"]) {
    const data = snapshot("remote-one", { requests: [permission()] }), u = ui(state(data)), operation = deferred();
    const method = kind === "message" ? "sendText" : kind === "request" ? "respond" : "stop";
    u.hooks[method] = () => operation.promise;
    await u.open("remote-one");
    if (kind === "message") { await u.input('[data-rv-field="draft"]', "First command"); await u.click("send"); }
    else if (kind === "request") { await u.review(); await u.click("approve"); }
    else { await u.click("stop"); await u.click("stop-confirm"); }
    const args = u.controls(method)[0].args, commandId = args[kind === "message" ? 1 : kind === "request" ? 2 : 0];
    const result = kind === "message" ? { kind, delivery: "accepted" } : kind === "request" ? { kind, requestId: "request-one", requestVersion: 1 } : { kind, runState: "stopped" };
    u.emit(state({ ...data, receipts: [{ commandId, status, result }] }));
    const label = status === "rejected" ? "平板已拒绝" : kind === "message" ? "平板已确认：已进入原会话" : kind === "request" ? "平板已确认：仅本次允许" : "平板已确认：当前执行已停止";
    assert.ok(u.html.includes(label));
    operation.reject(Object.assign(new Error("operation failed after pushed receipt"), { code: "OFFLINE" })); await u.flush();
    assert.ok(u.html.includes(label), `${kind}/${status} must retain its tablet result`);
    assert.doesNotMatch(u.html, /结果待核实；不会自动重发/); assert.equal(u.get("query", commandId), undefined);
    if (kind === "message") { await u.input('[data-rv-field="draft"]', "Next explicit command"); assert.equal(u.get("send").disabled, false); }
    assert.equal(u.controls(method).length, 1, "settling cannot resend any command");
    await u.view.close();
  }
});

test("remote view: verified recovery clears transient banners without losing unknown command outcomes", async () => {
  for (const code of ["OFFLINE", "RESYNC_REQUIRED"]) {
    const data = snapshot("remote-one", { requests: [permission()] }), u = ui(state(data));
    await u.open("remote-one"); await u.review();
    u.hooks.sendText = async () => { throw Object.assign(new Error("synthetic disconnect"), { code: "OFFLINE" }); };
    await u.input('[data-rv-field="draft"]', "Unknown original instruction"); await u.click("send");
    const commandId = u.controls("sendText")[0].args[1];
    u.hooks.status = async () => { throw Object.assign(new Error("synthetic refresh failure"), { code }); };
    await u.view.refresh(); await u.flush();
    assert.ok(u.root.querySelector(".rv-banner.rv-error"), `missing ${code} page banner`);
    const calls = u.calls.length;
    u.emit(state(data)); await u.flush();
    assert.equal(u.root.querySelector(".rv-banner.rv-error"), null);
    assert.match(u.root.querySelector(".rv-status").textContent, /平板在线/);
    assert.equal(u.get("approve").disabled, false);
    assert.match(u.html, /结果待核实；不会自动重发/); assert.ok(u.get("query", commandId));
    assert.equal(u.get("send").disabled, true, "recovery must not unlock an unknown original send");
    assert.equal(u.calls.length, calls, "a recovery snapshot must not trigger automatic controls or queries");
    assert.equal(u.controls("sendText").length, 1); assert.equal(u.controls("respond").length, 0); assert.equal(u.controls("stop").length, 0);
  }
});

test("remote view: incomplete recovery retains connection banners and ready snapshots retain action errors", async () => {
  const data = snapshot(), u = ui(state(data)); await u.open("remote-one");
  u.hooks.status = async () => { throw Object.assign(new Error("synthetic refresh failure"), { code: "OFFLINE" }); };
  await u.view.refresh(); await u.flush();
  for (const next of [
    { ...data, connection: "offline" }, { ...data, verified: false }, { ...data, phase: "syncing" },
    { ...data, canControl: false }, { ...data, error: "OFFLINE" },
    { ...data, grant: { ...data.grant, expiresAt: Date.now() - 1 } }, snapshot("remote-two"),
  ]) {
    u.emit(state(next)); await u.flush();
    assert.ok(u.root.querySelector(".rv-banner.rv-error"), "unverified, stale or wrong-target snapshots cannot confirm recovery");
  }
  u.emit(state(data)); await u.flush(); assert.equal(u.root.querySelector(".rv-banner.rv-error"), null);
  u.hooks.status = async () => { throw Object.assign(new Error("synthetic action limit"), { code: "LIMIT_EXCEEDED" }); };
  await u.view.refresh(); await u.flush(); u.emit(state(data)); await u.flush();
  assert.match(u.root.querySelector(".rv-banner.rv-error").textContent, /内容超过远程传输限制/);
});

test("remote view: stop remains unconfirmed until typed tablet ended/stopped receipt, never on click", async () => {
  const u = ui(); await u.open("remote-one"); await u.click("stop");
  assert.match(u.modal.innerHTML, /副作用不会自动撤销/); await u.click("stop-confirm");
  const commandId = u.controls("stop")[0].args[0]; assert.match(u.html, /等待处理回执/); assert.doesNotMatch(u.html, /平板已确认：当前执行已停止/);
  u.emit(state(snapshot("remote-one", { receipts: [{ commandId, status: "applied" }] })));
  assert.doesNotMatch(u.html, /平板已确认：当前执行已停止/);
  u.emit(state(snapshot("remote-one", { receipts: [{ commandId, status: "applied", result: { kind: "stop", runState: "stopped" } }] })));
  assert.match(u.html, /平板已确认：当前执行已停止/);
  assert.equal(u.controls("stop").length, 1);
});

test("remote view: stale open/control replies cannot repaint another session or a closed page", async () => {
  const u = ui(), old = deferred();
  u.hooks.open = (id) => id === "remote-one" ? old.promise : state(snapshot(id, { title: "Second session" }));
  const opening = u.view.open("remote-one"); await u.flush();
  await u.open("remote-two"); old.resolve(state(snapshot("remote-one", { title: "STALE TITLE" }))); await opening; await u.flush();
  assert.equal(u.root.dataset.remoteSessionId, "remote-two"); assert.match(u.html, /Second session/); assert.doesNotMatch(u.html, /STALE TITLE/);
  const command = deferred(); u.hooks.sendText = () => command.promise;
  await u.input('[data-rv-field="draft"]', "Pending message"); await u.click("send");
  await u.view.close(); command.resolve({ commandId: "synthetic-command-1", status: "applied", result: { kind: "message", delivery: "accepted" } }); await u.flush();
  assert.equal(u.html, ""); assert.equal(u.root.hidden, true); assert.equal(u.controls("stop").length, 0);
});

test("remote view: revocation clears text, pending details and draft; closing never stops tablet", async () => {
  const u = ui(state(snapshot("remote-one", { requests: [permission()], messages: [{ role: "assistant", text: "SYNTHETIC-CONTENT-TO-CLEAR" }] })));
  await u.open("remote-one"); await u.input('[data-rv-field="draft"]', "SYNTHETIC-DRAFT-TO-CLEAR"); await u.click("details");
  u.emit(state(snapshot("remote-one", { authorization: "revoked", canControl: false })));
  assert.match(u.html, /平板已收回托管/); assert.doesNotMatch(u.html, /SYNTHETIC-CONTENT|SYNTHETIC-DRAFT|data-rv="approve"|data-rv="send"/); assert.equal(u.modal, undefined);
  await u.view.close(); assert.equal(u.controls("stop").length, 0); assert.equal(u.html, "");
});

test("remote view: terminal authorization clears a composing page synchronously without stopping the run", async () => {
  for (const terminal of ["revoked", "expired", "reset"]) {
    const u = ui(state(snapshot("remote-one", { requests: [permission()] })));
    await u.open("remote-one"); await u.input('[data-rv-field="draft"]', "PRIVATE COMPOSING DRAFT");
    const draft = u.root.querySelector('[data-rv-field="draft"]');
    draft.dispatchEvent({ type: "compositionstart", bubbles: true, target: draft });
    await u.click("details");
    const next = snapshot("remote-one", { authorization: terminal, canControl: false });
    u.emit(terminal === "reset" ? { ...next, active: null, binding: null, grant: null, pending: [], items: [], phase: "idle" } : next);
    // Deliberately no flush: revocation must not wait for compositionend/timers.
    assert.doesNotMatch(u.html, /PRIVATE COMPOSING DRAFT|Synthetic reply|data-rv="approve"|data-rv="send"/);
    assert.equal(u.modal, undefined); assert.equal(u.controls("stop").length, 0);
    assert.equal(u.controls("sendText").length, 0); assert.equal(u.controls("respond").length, 0);
    await u.view.close(); assert.equal(u.controls("stop").length, 0);
  }
});

test("remote view: back first closes modal, then returns to list and clears temporary content", async () => {
  const u = ui(state(snapshot("remote-one", { requests: [permission()] })));
  await u.open("remote-one"); await u.click("details"); u.back(); await u.flush(); assert.equal(u.modal, undefined);
  assert.equal(u.root.dataset.remoteSessionId, "remote-one"); u.back(); await u.flush(); assert.equal(u.root.dataset.remoteSessionId, "");
  assert.equal(u.controls("stop").length, 0); assert.ok(u.controls("close").length > 0);
});

test("remote view: pointer and keyboard modal focus stay inside one named dialog", async () => {
  for (const keyboard of [false, true]) {
    const u = ui(state(snapshot("remote-one", { requests: [permission()] })), { keyboard });
    await u.open("remote-one"); u.get("details").focus(); await u.click("details");
    const dialog = u.modal, focus = u.document.activeElement;
    assert.equal(dialog.attributes.role, "dialog"); assert.equal(dialog.attributes["aria-modal"], "true");
    assert.equal(dialog.attributes.tabindex, "-1");
    const heading = dialog.querySelector("h2");
    assert.equal(dialog.attributes["aria-labelledby"], heading.id); assert.equal(heading.textContent, "完整审批详情");
    assert.equal(focus.closest('[role="dialog"]'), dialog);
    assert.equal(dialog.querySelectorAll('[role="dialog"]').length, 0, "do not nest another dialog inside the OV focus target");
    if (keyboard) assert.equal(focus.dataset.rv, "modal-close"); else assert.equal(focus, dialog);
    u.back(); await u.flush();
  }
});

test("remote view: modal close restores its stable opener after snapshot updates", async () => {
  for (const action of ["Escape", "modal-close", "details-read"]) {
    const data = snapshot("remote-one", { requests: [permission()] }), u = ui(state(data), { keyboard: true });
    await u.open("remote-one"); u.get("details").focus(); await u.click("details");
    u.emit(state({ ...data, items: [...data.items, { id: "while-reviewing", role: "assistant", text: "Updated while reviewing" }] }));
    assert.equal(u.modal.contains(u.document.activeElement), true, "a background snapshot must not steal dialog focus");
    if (action === "Escape") { u.back(); await u.flush(); } else await u.click(action);
    assert.equal(u.modal, undefined); assert.equal(u.document.activeElement.isConnected, true);
    assert.equal(u.document.activeElement, u.get("details", "request-one", u.root));
    if (action === "details-read") assert.equal(u.get("approve").disabled, false);
  }
});

test("remote view: a removed request restores focus to navigation, not a detached opener", async () => {
  const data = snapshot("remote-one", { requests: [permission()] }), u = ui(state(data), { keyboard: true });
  await u.open("remote-one"); u.get("details").focus(); await u.click("details");
  u.emit(state({ ...data, pending: [] })); await u.flush();
  assert.equal(u.modal, undefined); assert.equal(u.document.activeElement.isConnected, true);
  assert.equal(u.document.activeElement, u.get("back", undefined, u.root));
});

test("remote view: closing a page with a dialog does not return focus to hidden content", async () => {
  const u = ui(state(snapshot("remote-one", { requests: [permission()] })), { keyboard: true });
  await u.open("remote-one"); u.get("details").focus(); await u.click("details"); await u.view.close(); await u.flush();
  assert.equal(u.root.hidden, true); assert.equal(u.modal, undefined);
  assert.equal(u.root.contains(u.document.activeElement), false);
});

test("remote view: default-deny missing authority/full scope and expired/local-only requests", async () => {
  for (const data of [snapshot("remote-one", { canControl: undefined }), { ...snapshot(), verified: false }]) {
    const u = ui(state(data)); await u.open("remote-one"); await u.input('[data-rv-field="draft"]', "text"); assert.equal(u.get("send").disabled, true);
  }
  for (const request of [permission({ expiresAt: Date.now() - 1 }), permission({ kind: "local" }), permission({ detailsComplete: undefined }), permission({ truncated: true }), permission({ detailText: "" }), permission({ detailText: "x".repeat(24 * 1024 + 1) })]) {
    const u = ui(state(snapshot("remote-one", { requests: [request] }))); await u.open("remote-one");
    await u.click("details"); if (u.get("details-read")) await u.click("details-read"); else await u.click("modal-close");
    assert.ok(!u.get("approve") || u.get("approve").disabled); assert.equal(u.controls("respond").length, 0);
  }
});

test("remote view: unpair/reset removes cached scope, details and offline draft", async () => {
  const u = ui(state(snapshot("remote-one", { requests: [permission()], messages: [{ role: "assistant", text: "RESET-CONTENT" }] })));
  await u.open("remote-one"); await u.input('[data-rv-field="draft"]', "RESET-DRAFT"); await u.click("details");
  u.emit({ ...snapshot(), active: null, binding: null, grant: null, pending: [], items: [], phase: "idle", canControl: false });
  assert.doesNotMatch(u.html, /RESET-CONTENT|RESET-DRAFT|data-rv="approve"|data-rv="send"/); assert.equal(u.modal, undefined);
  assert.match(u.html, /远程访问已关闭/);
});

test("remote view: changed scope must be reviewed again, expiry and wrong-version receipts never unlock approval", async () => {
  const u = ui(state(snapshot("remote-one", { requests: [permission()] })));
  await u.open("remote-one"); await u.review(); assert.equal(u.get("approve").disabled, false);
  u.emit(state(snapshot("remote-one", { requests: [permission({ detailText: "CHANGED SCOPE" })] })));
  assert.equal(u.get("approve").disabled, true); await u.review();
  await u.click("approve"); const commandId = u.controls("respond")[0].args[2];
  u.emit(state(snapshot("remote-one", { requests: [permission()], receipts: [{ commandId, status: "applied", result: { kind: "request", requestId: "request-one", requestVersion: 2 } }] })));
  assert.doesNotMatch(u.html, /平板已确认：仅本次允许/);
  const v = ui(state(snapshot("remote-one", { requests: [permission({ expiresAt: Date.now() + 100_000 })] })));
  await v.open("remote-one"); await v.click("details"); v.emit(state(snapshot("remote-one", { requests: [] })));
  assert.equal(v.modal, undefined); assert.equal(v.controls("respond").length, 0);
});

test("remote view: free question text is an alternative to selected options, not an invalid mixed payload", async () => {
  const question = permission({ kind: "question", questions: [{ questionId: "q0", question: "Next step?", multiSelect: true, options: [{ optionId: "q0:o0", label: "Tests" }] }] });
  const u = ui(state(snapshot("remote-one", { requests: [question] })));
  await u.open("remote-one"); await u.review(); await u.input('input[value="q0:o0"]', "q0:o0", { checked: true });
  await u.input('textarea[data-question="q0"]', "Only inspect"); await u.click("approve");
  assert.deepEqual(u.controls("respond")[0].args[1], { kind: "question", answers: [{ questionId: "q0", optionIds: [], text: "Only inspect" }] });
});

test("remote view: streaming updates preserve composer focus, selection, draft and open tools", async () => {
  const data = snapshot("remote-one", { messages: [{ id: "tool-one", kind: "tool", toolName: "Bash", toolInputText: "npm test" }] }), u = ui(state(data));
  await u.open("remote-one"); const input = await u.input('[data-rv-field="draft"]', "Keep keyboard focus");
  input.focus(); input.setSelectionRange(4, 9); u.root.querySelector("details").open = true;
  u.emit(state({ ...data, items: [{ id: "older-tool", kind: "tool", toolName: "Read", toolInputText: "provided path" }, ...data.items, { id: "streamed-message", kind: "message", role: "assistant", text: "Updated" }] }));
  assert.equal(u.document.activeElement.dataset.rvField, "draft"); assert.equal(u.document.activeElement.value, "Keep keyboard focus");
  assert.equal(u.document.activeElement.selectionStart, 4); assert.equal(u.document.activeElement.selectionEnd, 9);
  assert.equal(u.root.querySelector('[data-tool="tool-one"]').open, true); assert.equal(u.root.querySelector('[data-tool="older-tool"]').open, false);
});

test("remote view: leading LF values survive unrelated renders in every controlled textarea", async () => {
  const question = permission({ requestId: "question-request", kind: "question", questions: [{ questionId: "q0", question: "Text?", multiSelect: false, options: [] }] });
  const data = snapshot("remote-one", { requests: [permission(), question] }), u = ui(state(data));
  await u.open("remote-one"); await u.click("deny-toggle", "request-one");
  const values = { draft: "\n\nhello <draft>&", reason: "\nreason <why>&", answer: "\nanswer <what>&" };
  for (const [field, value] of Object.entries(values)) await u.input(`[data-rv-field="${field}"]`, value);
  u.emit(state({ ...data, items: [...data.items, { id: "unrelated-lf-update", role: "assistant", text: "Unrelated update" }] }));
  for (const [field, value] of Object.entries(values)) assert.equal(u.root.querySelector(`[data-rv-field="${field}"]`).value, value, field);
  await u.click("send"); assert.equal(u.controls("sendText")[0].args[0], values.draft);
});

test("remote view: ASCII paste beyond the native character limit stays locked until edited", async () => {
  const question = permission({ requestId: "question-request", kind: "question", questions: [{ questionId: "q0", question: "Text?", multiSelect: false, options: [] }] });
  const data = snapshot("remote-one", { requests: [permission(), question] }), u = ui(state(data));
  await u.open("remote-one"); await u.click("deny-toggle", "request-one"); await u.review("question-request");
  for (const [field, maximum] of [["draft", 16384], ["reason", 4096], ["answer", 16384]]) {
    const selector = `[data-rv-field="${field}"]`;
    assert.equal(u.root.querySelector(selector).attributes.maxlength, undefined, `${field} must reach the byte limiter without native pre-clipping`);
    await u.paste(selector, "a".repeat(maximum + 1));
    const clipped = u.root.querySelector(selector); assert.equal(clipped.value, "a".repeat(maximum));
    assert.match(u.html, /内容超过远程传输限制/);
    clipped.dispatchEvent({ type: "change", bubbles: true, target: clipped }); await u.flush();
    clipped.dispatchEvent({ type: "compositionend", bubbles: true, target: clipped }); await u.flush();
    u.emit(state({ ...data, items: [...data.items, { id: "paste-" + field, role: "assistant", text: "Unrelated paste update" }] }));
    const action = field === "draft" ? "send" : field === "reason" ? "deny" : "approve", id = field === "draft" ? undefined : field === "reason" ? "request-one" : "question-request";
    await u.click(action, id); assert.equal(u.controls("sendText").length, 0); assert.equal(u.controls("respond").length, 0);
    await u.input(selector, "Reviewed " + field);
    if (field === "draft") assert.equal(u.get("send").disabled, false);
    if (field === "answer") assert.equal(u.get("approve", "question-request").disabled, false);
  }
  await u.click("deny", "request-one"); assert.equal(u.controls("respond")[0].args[1].reason, "Reviewed reason");
});

test("remote view: UTF-8 text bound blocks oversized sends, refresh keeps unknown command identity", async () => {
  const u = ui(); await u.open("remote-one"); await u.input('[data-rv-field="draft"]', "界".repeat(6000));
  assert.equal(u.get("send").disabled, true); await u.click("send"); assert.equal(u.controls("sendText").length, 0);
  u.hooks.sendText = async () => { throw Object.assign(new Error("fake"), { code: "OFFLINE" }); };
  await u.input('[data-rv-field="draft"]', "Unknown delivery"); await u.click("send"); const id = u.controls("sendText")[0].args[1];
  await u.view.refresh(); assert.equal(u.controls("open").length, 1); assert.ok(u.get("query", id));
  u.emit(state(snapshot("remote-one", { receipts: [{ commandId: id, status: "received" }] })));
  assert.match(u.html, /结果待核实/);
});

test("remote view: blur/change and compositionend cannot approve a clipped draft", async () => {
  const u = ui(); await u.open('remote-one'); await u.input('[data-rv-field="draft"]', '界'.repeat(6000));
  const draft = u.root.querySelector('[data-rv-field="draft"]');
  draft.dispatchEvent({ type: 'change', bubbles: true, target: draft }); await u.flush();
  draft.dispatchEvent({ type: 'compositionend', bubbles: true, target: draft }); await u.flush();
  assert.equal(u.get('send').disabled, true); await u.click('send'); assert.equal(u.controls('sendText').length, 0);
  await u.input('[data-rv-field="draft"]', 'Reviewed replacement');
  assert.equal(u.get('send').disabled, false);
});

test("remote view: UTF-8 limits bound local reason and question values before any submission", async () => {
  const u = ui(state(snapshot('remote-one', { requests: [permission()] })));
  await u.open('remote-one'); await u.click('deny-toggle');
  await u.input('[data-rv-field="reason"]', '界'.repeat(4000));
  const reason = u.root.querySelector('[data-rv-field="reason"]').value;
  assert.ok(Buffer.byteLength(reason) <= 4096); assert.equal(reason.endsWith('\ud800'), false);
  assert.match(u.html, /内容超过远程传输限制/); await u.click('deny'); assert.equal(u.controls('respond').length, 0);
  await u.input('[data-rv-field="reason"]', reason); await u.click('deny');
  assert.equal(u.controls('respond')[0].args[1].reason, reason);
  const question = permission({ kind: 'question', questions: [{ questionId: 'q0', question: 'Text?', multiSelect: false, options: [] }] });
  const v = ui(state(snapshot('remote-one', { requests: [question] })));
  await v.open('remote-one'); await v.review(); await v.input('[data-rv-field="answer"]', '😀'.repeat(10000));
  const answer = v.root.querySelector('[data-rv-field="answer"]').value;
  assert.ok(Buffer.byteLength(answer) <= 16384); assert.equal(answer, '😀'.repeat(4096));
  await v.click('approve'); assert.equal(v.controls('respond').length, 0);
  await v.input('[data-rv-field="answer"]', answer); v.emit(state(snapshot('remote-one', { requests: [question] }))); await v.click('approve');
  assert.equal(v.controls('respond')[0].args[1].answers[0].text, answer);
});

test("remote view: the real-browser renderer is keyed and synchronously handles terminal updates", () => {
  // Source contract only. Actual DOM/Range identities are asserted separately
  // by browser-scenarios; this small VM DOM has no live childNodes/Range model.
  assert.match(source, /function patchChildren\(parent, nextParent\)/);
  assert.match(source, /parent\.insertBefore\(current, cursor\)/);
  assert.match(source, /record:\$\{escape\(item\.id/);
  assert.match(source, /compositionend/); assert.match(source, /composing\.has\(element\)/);
  assert.match(source, /current\.replaceData\(/); assert.doesNotMatch(source, /current\.nodeValue\s*=/);
  const patch = source.slice(source.indexOf("function patchChildren("), source.indexOf("function render()"));
  assert.ok(patch.indexOf("node.remove()") < patch.indexOf("parent.insertBefore(current, cursor)"), "remove dead siblings before considering any survivor move");
  assert.match(source, /data-rv-key="pending"/); assert.match(source, /focus\.selectionDirection/);
  assert.doesNotMatch(source, /requestAnimationFrame|setTimeout/);
});

test("remote view: repeated identical snapshots do not replace already rendered nodes", async () => {
  const data = snapshot(), u = ui(state(data)); await u.open('remote-one');
  u.emit(state(data)); const input = u.root.querySelector('[data-rv-field="draft"]');
  u.emit(state(data)); assert.equal(u.root.querySelector('[data-rv-field="draft"]'), input);
});

test("remote view: real 06 browser transport + phone manager + canonical v1 receipts complete app controls", async () => {
  const u = ui(), routes = [], hostFrames = [];
  let invitation = true, declined = false, hostListener = null, revision = 0;
  const binding = { fromDeviceId: "phone-one", toDeviceId: "tablet-one", hostInstanceId: "host-one", remoteSessionId: "remote-one", grantVersion: 1, runId: "run-one" };
  const hostSnapshot = () => ({ binding, grant: { state: "active", expiresAt: Date.now() + 600_000 }, run: { runId: "run-one", state: "running" }, streamId: "stream-one", seq: ++revision,
    pending: [permission()], items: [{ id: "host-message", kind: "message", role: "assistant", text: "CANONICAL HOST REPLY" }, { id: "host-tool", kind: "tool", toolName: "Bash", toolStatus: "done", toolInputText: "npm test", toolResultText: "CANONICAL TOOL RESULT" }], historyCursor: null, historyHasMore: true });
  const receipt = (frame) => {
    hostFrames.push(frame);
    const result = frame.type === "request.respond" ? { kind: "request", requestId: frame.payload.requestId, requestVersion: frame.payload.requestVersion } : frame.type === "run.stop" ? { kind: "stop", runState: "stopped" } : { kind: "message", delivery: "queued" };
    return createFrame("control.receipt", { ...binding, fromDeviceId: binding.toDeviceId, toDeviceId: binding.fromDeviceId }, { status: "applied", result }, { commandId: frame.commandId });
  };
  const manager = createPhoneManager({ deviceId: "phone-one", transport: {
    list: async () => declined ? [] : [{ remoteSessionId: "remote-one", deviceId: "tablet-one", title: "Canonical task", deviceName: "Canonical tablet", grantVersion: 1, state: invitation ? "invited" : "active", expiresAt: Date.now() + 600_000 }],
    open: async () => hostSnapshot(), accept: async () => { invitation = false; return hostSnapshot(); },
    decline: async () => { declined = true; return { remoteSessionId: "remote-one", deviceId: "phone-one", hostDeviceId: "tablet-one", grantVersion: 1, state: "declined" }; },
    history: async () => ({ binding, streamId: "stream-one", items: [{ id: "older-message", kind: "message", role: "user", text: "CANONICAL OLDER MESSAGE" }], cursor: null, hasMore: false }),
    send: async (frame) => receipt(frame), query: async (frame) => receipt(frame), close: async () => {},
  } });
  const remote = u.installRealTransport({ eventSource() { return { addEventListener(type, listener) { if (type === "snapshot") hostListener = listener; }, close() { hostListener = null; } }; }, fetch: async (url, options) => {
    routes.push(url); const path = url.replace("/api/remote/", ""), body = options.body ? JSON.parse(options.body) : {};
    let result;
    try {
      if (path === "status") result = await manager.status();
      else if (path === "sessions") result = await manager.list();
      else if (path === "open") result = await manager.open(body.remoteSessionId);
      else if (path === "accept") result = await manager.accept(body.remoteSessionId);
      else if (path === "decline") result = await manager.decline(body.remoteSessionId);
      else if (path === "close") result = await manager.close();
      else if (path === "history") result = await manager.history(body.cursor, body);
      else if (path === "query") result = await manager.query(body.commandId, body);
      else if (path === "command") result = body.type === "message.submit" ? await manager.sendText(body.payload.text, body.commandId, body) : body.type === "request.respond" ? await manager.respond(body.payload.requestId, body.payload.response, body.commandId, body) : await manager.stop(body.commandId, body);
      else assert.fail(`unexpected route ${path}`);
      return { ok: true, headers: { get() { return null; } }, json: async () => clone(result) };
    } catch (error) { return { ok: false, status: 409, json: async () => ({ error: { code: error.code || "INTERNAL_ERROR" } }) }; }
  } });
  try {
    await u.open(); assert.match(u.html, /接受并打开/); await u.click("accept", "remote-one");
    assert.match(u.html, /CANONICAL HOST REPLY/); assert.match(u.html, /CANONICAL TOOL RESULT/);
    assert.equal(routes.filter((url) => url === "/api/remote/accept").length, 1); assert.equal(routes.filter((url) => url === "/api/remote/open").length, 0);
    await u.review(); await u.click("approve"); assert.match(u.html, /平板已确认：仅本次允许/);
    await u.input('[data-rv-field="draft"]', "/literal slash text"); await u.click("send"); assert.match(u.html, /已进入原会话队列/);
    assert.equal(hostFrames.filter((frame) => frame.type === "message.submit")[0].payload.text, "/literal slash text");
    await u.click("history"); assert.match(u.html, /CANONICAL OLDER MESSAGE/);
    await u.click("stop"); await u.click("stop-confirm"); assert.match(u.html, /平板已确认：当前执行已停止/);
    const count = routes.filter((url) => url === "/api/remote/open").length; await u.view.refresh(); assert.equal(routes.filter((url) => url === "/api/remote/open").length, count, "refresh must not reset command ledger with open()");
    assert.ok(hostFrames.every((frame) => frame.remoteSessionId === "remote-one" && frame.fromDeviceId === "phone-one"));
    assert.ok(routes.every((url) => url.startsWith("/api/remote/")));
    assert.equal(typeof hostListener, "function");
  } finally { await u.view.close(); remote.destroy(); manager.dispose(); }
});

test("remote view: transcript and composer follow the host text size without scaling navigation", () => {
  assert.equal(declarations(css, "#remotePage .bubble")["font-size"], "var(--fs-chat,14.5px)");
  assert.equal(declarations(css, "#remotePage .rv-composer textarea")["font-size"], "calc(var(--fs-chat,14.5px) + .5px)");
  assert.equal(declarations(css, "#remotePage")["font-size"], undefined);
  assert.equal(declarations(css, "#remotePage .rv-head")["font-size"], undefined);
  for (const [size, expected] of [["s", 13.5], ["l", 16], ["xl", 18]]) {
    assert.equal(declarations(hostCss, `html[data-fs="${size}"]`)["--fs-chat"], `${expected}px`);
  }
});

test("remote UI: required reading uses the host foreground rather than its decorative accent", () => {
  assert.equal(declarations(css, "#remotePage .rv-link").color, "var(--fg)");
  const pair = declarations(settingsCss, ".rs-pair-code,.rs-verification");
  assert.equal(pair.color, "var(--fg)"); assert.equal(pair.background, "var(--code-bg)");
  const nativeLight = declarations(hostCss, 'html[data-theme="light"]');
  const luminance = (value) => {
    const rgb = [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16) / 255);
    const c = rgb.map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
  };
  for (const background of ["--bg2", "--code-bg"]) {
    const [low, high] = [luminance(nativeLight["--fg"]), luminance(nativeLight[background])].sort((a, b) => a - b);
    assert.ok((high + 0.05) / (low + 0.05) >= 4.5, `${background} must retain normal-text contrast`);
  }
});

test("remote settings: switch thumb uses logical positions in both RTL and LTR", () => {
  const off = declarations(settingsCss, ".rs-switch>span");
  const on = declarations(settingsCss, '.rs-switch[aria-checked="true"]>span');
  assert.equal(off["inset-block-start"], "12px"); assert.equal(off["inset-inline-start"], "5px");
  assert.equal(on["inset-inline-start"], "27px");
  for (const properties of [off, on]) {
    for (const physical of ["inset", "left", "right", "inset-inline-end"]) assert.equal(properties[physical], undefined, `${physical} must not oppose the logical start`);
  }
  const width = 52, thumb = parseFloat(off.width), start = parseFloat(off["inset-inline-start"]), end = parseFloat(on["inset-inline-start"]);
  const ltr = [start, end], rtl = [width - start - thumb, width - end - thumb];
  assert.deepEqual(ltr, [5, 27]); assert.deepEqual(rtl, [27, 5]);
});

test("remote view: page styles inherit CC themes/fonts, remain scoped and expose keyboard/44px targets", () => {
  assert.match(css, /var\(--font-ui/); assert.match(css, /var\(--accent-btn/); assert.match(css, /var\(--bg\)/);
  assert.match(css, /min-height:44px/); assert.match(css, /focus-visible/); assert.match(css, /@media\(max-width:400px\)/); assert.match(css, /prefers-reduced-motion/);
  assert.doesNotMatch(source, /\/api\/file|renderMd\(|openViewer\(|permissionMode|localStorage|sessionStorage|fetch\(/);
});
