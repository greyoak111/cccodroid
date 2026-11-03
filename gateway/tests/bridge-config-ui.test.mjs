// Dependency-free UI integration: only synthetic fetch replies and a minimal DOM, never a live gateway.
// Design provenance (not the obsolete motion snapshots): openai-bridge-ui-design at base e0311e2.
// DESIGN.zh-CN.md sha256 22a8011fbbd459be1581d2ccb4db2cce012d15e8de8c5d56547a6152e07289c3
// BRIEF.zh-CN.md sha256 17e648516e42bfc376c1d3107f69c11dbdfee7e81b47f31c83ceea57e6783f4a
// preview.html sha256 255d2e2259881302bf6987b1c9aa9b7e6ee3e080d10aa3e5d1c5bd302de35e1e
// Only the three-field Extensions flow is adapted; baseline themes/fonts/layout/HMAC/capacity stay intact.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../web/app/bridge-config.js", import.meta.url), "utf8");
const sessionSource = fs.readFileSync(new URL("../web/app/04-session-flow.js", import.meta.url), "utf8");
const modelSource = fs.readFileSync(new URL("../web/app/12-model-caps.js", import.meta.url), "utf8");
const saved = (extra = {}) => ({ installed: true, configured: true, hasKey: true, endpoint: "https://api.example.com/v1", model: "synthetic-model", providerId: "synthetic-bridge", local: { state: "ready" }, ...extra });
const fresh = () => saved({ configured: false, hasKey: false, endpoint: "", model: "", providerId: "", local: { state: "stopped" } });
const deferred = () => { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; };

function ui(initial = fresh()) {
  const nodes = new Map(), listeners = new Map(), observers = [], calls = [], confirms = [], htmlWrites = [], createdTags = [], violations = [];
  const timers = new Map(); let now = 0, nextTimer = 0;
  // Production catches fetch/storage errors; retain mock contract failures so those catches cannot hide a failed assertion.
  const guard = (check) => { try { return check(); } catch (error) { violations.push(error); throw error; } };
  const verify = () => { if (violations.length) throw violations[0]; };
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); verify(); };
  class Node {
    constructor(id = "", tag = "div") {
      this.id = id; this.tagName = tag.toUpperCase(); this.value = ""; this.type = ""; this._textContent = "";
      this.attributes = {}; this.dataset = {}; this.children = []; this.listeners = {}; this.disabled = false; this.checked = false; this.scrollTop = 0; this.isConnected = true;
      const classes = new Set();
      this.classList = { add: (...a) => a.forEach((c) => classes.add(c)), remove: (...a) => a.forEach((c) => classes.delete(c)), contains: (c) => classes.has(c), toggle(c, force) { const on = force === undefined ? !classes.has(c) : force; if (on) classes.add(c); else classes.delete(c); return on; } };
    }
    set innerHTML(html) {
      this.html = String(html); this._textContent = ""; this.children = []; htmlWrites.push({ id: this.id, html: this.html });
      if (this.id) nodes.set(this.id, this);
      for (const match of this.html.matchAll(/<([\w-]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
        const el = new Node(match[3], match[1]);
        for (const attr of match[2].matchAll(/([\w-]+)="([^"]*)"/g)) el.setAttribute(attr[1], attr[2]);
        for (const attr of match[2].matchAll(/(?:^|\s)(checked|disabled|required)(?=\s|\/?$)/g)) el.setAttribute(attr[1], "");
        this.appendChild(el); nodes.set(el.id, el);
      }
      if (this.id === "bridge-config-panel") {
        const eye = new Node("bc-eye", "button"); eye.dataset.bc = "eye"; this.appendChild(eye); nodes.set("bc-eye", eye);
        for (const action of ["back", "use", "edit"]) {
          const button = new Node("bc-action-" + action, "button"); button.dataset.bc = action; this.appendChild(button); nodes.set(button.id, button);
        }
      }
    }
    get innerHTML() { return this.html || ""; }
    set textContent(value) { this._textContent = String(value); this.html = ""; this.children = []; }
    get textContent() { return this._textContent + this.children.map((el) => el.textContent).join(""); }
    appendChild(el) { this.children.push(el); el.parentElement = this; return el; }
    append(...elements) { elements.forEach((el) => this.appendChild(el)); }
    replaceChildren(...elements) { this.children = []; this._textContent = ""; this.html = ""; this.append(...elements); }
    setAttribute(name, value) {
      this.attributes[name] = String(value);
      if (name === "class") this.classList.add(...String(value).split(/\s+/).filter(Boolean));
      if (["type", "value"].includes(name)) this[name] = String(value);
      if (["checked", "disabled", "required"].includes(name)) this[name] = true;
      if (name.startsWith("data-")) this.dataset[name.slice(5)] = String(value);
    }
    getAttribute(name) { return this.attributes[name] ?? null; }
    removeAttribute(name) { delete this.attributes[name]; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    querySelector(selector) { if (selector === '[data-bc="eye"]') return nodes.get("bc-eye"); return null; }
    querySelectorAll(selector) { return selector === "input, button" ? this.children.filter((el) => ["INPUT", "BUTTON"].includes(el.tagName)) : []; }
    getClientRects() { return this.closest(".hidden") ? [] : [{}]; }
    closest(selector) { if (selector === "[data-bc]" && this.dataset.bc) return this; if (selector === "button" && this.tagName === "BUTTON") return this; if (selector === ".hidden") { for (let el = this; el; el = el.parentElement) if (el.classList.contains("hidden")) return el; } return null; }
    focus() { document.activeElement = this; }
    reset() { for (const el of nodes.values()) if (el.tagName === "INPUT") { el.value = ""; el.checked = false; } }
  }
  const get = (id) => nodes.get(id);
  for (const id of ["tab-ext", "pages", "page-body", "anchor"]) nodes.set(id, new Node(id));
  const document = {
    activeElement: get("anchor"), hidden: false, getElementById: get,
    createElement: (tag) => { createdTags.push(String(tag).toUpperCase()); return new Node("", tag); }, querySelectorAll: () => [],
    addEventListener(type, fn) { (listeners.get("doc:" + type) || listeners.set("doc:" + type, []).get("doc:" + type)).push(fn); },
  };
  let response = initial, nextGet = null, nextPost = null, nextModels = null, nextRepair = null, backCount = 0, acceptConsent = true;
  const sandbox = {
    URL, AbortController, document, MutationObserver: class { constructor(fn) { observers.push(fn); } observe() {} },
    setTimeout(fn, delay = 0) { const id = ++nextTimer; timers.set(id, { fn, at: now + Number(delay) }); return id; },
    clearTimeout(id) { timers.delete(id); },
    addEventListener(type, fn) { (listeners.get(type) || listeners.set(type, []).get(type)).push(fn); },
    __ccBack() { backCount++; return false; },
    confirm(message) { confirms.push(message); return acceptConsent; },
    localStorage: { getItem() { guard(() => assert.fail("bridge form must not read storage")); }, setItem() { guard(() => assert.fail("bridge form must not persist secrets")); } },
    sessionStorage: { getItem() { guard(() => assert.fail("bridge form must not read storage")); }, setItem() { guard(() => assert.fail("bridge form must not persist secrets")); } },
    fetch: async (url, opts) => {
      const body = opts.body ? JSON.parse(opts.body) : null;
      const call = { url, method: opts.method, body, signal: opts.signal };
      calls.push(call);
      guard(() => {
        assert.ok(["/api/components/openai-bridge/config", "/api/components/openai-bridge/models", "/api/components/openai-bridge/repair"].includes(url), "only fixed same-origin bridge routes are allowed; no provider, inference or session APIs");
        assert.equal(opts.cache, "no-store"); assert.equal(opts.credentials, "same-origin");
        if (url.endsWith("/models")) {
          assert.equal(opts.method, "POST"); assert.equal(body.consent, true, "a models request requires explicit current consent");
          assert.equal(get("bc-model-consent").checked, true, "the body flag cannot replace the visible checked opt-in");
          assert.deepEqual(Object.keys(body).sort(), (body.apiKey === undefined ? ["consent", "endpoint"] : ["apiKey", "consent", "endpoint"]), "model discovery sends no chat, selected model or provider mutation");
          assert.equal(opts.headers["Content-Type"], "application/json");
        }
      });
      if (url.endsWith("/repair")) {
        guard(() => { assert.equal(opts.method, "POST"); assert.equal(body.consent, true); assert.deepEqual(Object.keys(body).sort(), body.action === "inspect" ? ["action", "consent"] : ["action", "consent", "ticket"]); });
        return nextRepair ? nextRepair(call) : reply({ ok: false, code: "REPAIR_UNAVAILABLE" }, 409);
      }
      if (url.endsWith("/models")) return nextModels ? nextModels(call) : reply({ ok: true, models: [{ id: "synthetic-model" }], truncated: false });
      if (opts.method === "GET" && nextGet) return nextGet();
      if (opts.method === "POST" && nextPost) return nextPost();
      return { ok: true, status: 200, json: async () => structuredClone(response) };
    },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(source, sandbox, { filename: "bridge-config.js" });
  return {
    get, calls, document, confirms, htmlWrites, createdTags, flush,
    consent(value) { acceptConsent = value; },
    async open(opts = {}) { await sandbox.CCBridgeConfig.open({ anchor: get("anchor"), ...opts }); verify(); },
    close() { const closed = sandbox.CCBridgeConfig.close(); verify(); return closed; },
    response(value) { response = value; }, read(fn) { nextGet = fn; }, post(fn) { nextPost = fn; }, models(fn) { nextModels = fn; }, repair(fn) { nextRepair = fn; },
    repairCalls: () => calls.filter(call => call.url.endsWith("/repair")),
    modelCalls: () => calls.filter((call) => call.url.endsWith("/models")),
    configPosts: () => calls.filter((call) => call.url.endsWith("/config") && call.method === "POST"),
    checkbox: () => [...nodes.values()].find((el) => el.tagName === "INPUT" && el.type === "checkbox"),
    // 建议列表只在输入框有焦点时渲染：聚焦读一遍再还原（value 取自 data-value）；
    // 默认清空输入读全量，传 filtered 按当前输入过滤
    modelList: (filtered = false) => {
      const input = get("bc-model"), list = get(input.getAttribute("aria-controls")), prev = document.activeElement, typed = input.value;
      if (!list) return undefined;
      if (!filtered) input.value = "";
      document.activeElement = input; (input.listeners.focus || []).forEach((fn) => fn({}));
      const children = list.children.map((el) => ({ value: el.dataset.value, tagName: el.tagName, children: el.children, attributes: el.attributes }));
      (input.listeners.blur || []).forEach((fn) => fn({})); document.activeElement = prev; input.value = typed;
      return { tagName: list.tagName, children };
    },
    pendingTimers: () => timers.size,
    async advance(ms) {
      const target = now + ms; let count = 0;
      while (true) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at || a[0] - b[0]).find(([, timer]) => timer.at <= target);
        if (!next) break;
        assert.ok(++count < 100, "timer callbacks must not spin");
        const [id, timer] = next; now = timer.at; timers.delete(id); timer.fn(); await flush();
      }
      now = target; await flush();
    },
    async submit() { await get("bc-form").listeners.submit[0]({ preventDefault() {} }); verify(); },
    async click(action) {
      const node = action === "eye" ? get("bc-eye") : get("bc-action-" + action) || [...nodes.values()].find((el) => el.dataset.bc === action);
      assert.ok(node, `missing bridge action: ${action}`);
      if (node.disabled) { await flush(); return; }
      for (const fn of node.listeners.click || []) fn({ target: node });
      for (const fn of get("bridge-config-panel").listeners.click) fn({ target: node });
      await flush();
    },
    pointerButton(id) {
      let prevented = false;
      for (const fn of get("bridge-config-panel").listeners.mousedown || []) fn({ target: get(id), preventDefault() { prevented = true; } });
      return prevented;
    },
    async modelAction(action, id) {
      const button = get("bc-selected").children.flatMap((row) => row.children).find((el) => el.dataset.bc === action && el.dataset.model === id);
      assert.ok(button, `missing model action ${action}/${id}`);
      if (!button.disabled) for (const fn of get("bridge-config-panel").listeners.click) fn({ target: button });
      await flush();
    },
    pickModel(id) {
      const input = get("bc-model"); input.value = id; document.activeElement = input;
      for (const fn of input.listeners.focus || []) fn({});
      for (const key of ["ArrowDown", "Enter"]) for (const fn of input.listeners.keydown || []) fn({ key, isComposing: false, preventDefault() {} });
    },
    input(name, value) { const el = get("bc-" + name); el.value = value; for (const fn of el.listeners.input || []) fn({ target: el }); },
    change(id, checked) { const el = get(id); assert.ok(el, `missing bridge input: ${id}`); el.checked = checked; for (const fn of el.listeners.change || []) fn({ target: el }); },
    back: () => sandbox.__ccBack(), backCount: () => backCount,
    blur() { for (const fn of listeners.get("blur") || []) fn(); },
    pagehide() { for (const fn of listeners.get("pagehide") || []) fn(); },
    leavePage() { get("tab-ext").classList.add("hidden"); observers.forEach((fn) => fn([])); },
  };
}

const fill = (u, key = "synthetic-test-key") => { u.input("endpoint", "https://api.example.com/v1"); u.input("key", key); u.input("model", "synthetic-model"); };
const reply = (value, status = 200) => ({ ok: status < 400, status, json: async () => value });

test("bridge session handoff: real onHello preserves a new-session pin before model refresh, explicit switches still clear it", async () => {
  const take = (text, start, end) => text.slice(text.indexOf(start), text.indexOf(end));
  const nodes = () => ({ classList: { add() {}, remove() {} }, querySelector() { return null; }, childElementCount: 0, innerHTML: "" });
  const modelQueries = [], refreshes = [], state = { pendingModel: null }, view = { sessionId: "existing-session", runIds: new Set(), cids: new Set(), gen: 0 };
  const box = {
    URL, state, view, Set, Map, t: (s) => s, uiTag: "synthetic-ui", helloCount: 1, busReplay: false, welKeep: null,
    WROTE: new Map(), TOOL_CARDS: new Map(), PENDING_RESULTS: new Map(), PERMS: new Map(), runViews: new Map(),
    histEl: nodes(), liveEl: nodes(), olderEl: nodes(), statEl: nodes(),
    stripHidden: () => ({}), paintTitle() {}, renderRunStrip() {}, agReset() {}, syncWindow() {}, pickViewRun() {}, renderQueue() {}, paintProjChip() {}, syncInterject() {}, saveUiState() {},
    applyState() {}, beginReplay() {}, updateCtx() {}, renderSessions() {}, loadOlder() {}, showWelcome() {}, renderInterrupted() {}, calmStatus() {},
    paintModel() {}, chipName: () => "synthetic-model", loadCtxModel() {}, provChanged() {}, statStop() {}, statLast: {},
    api: async (url) => {
      modelQueries.push(url);
      const u = new URL(url, "https://synthetic.invalid");
      return { provider: u.searchParams.get("provider") || "global-provider", model: u.searchParams.get("model") || "global-model" };
    },
    refreshObserved() { refreshes.push(state.pendingModel && { ...state.pendingModel }); },
  };
  // Run the production query / refresh and hello / reset functions, not a reimplementation of their ordering.
  vm.runInNewContext(
    take(modelSource, "  const sidQ =", "  // 会话用的那家变了") +
    take(sessionSource, "  function resetView(", "  /** 打开某个会话") +
    take(sessionSource, "  function onHello(", "  /** 「已连接」") +
    "\nconst actualRefresh = refreshSessModel; refreshSessModel = () => { refreshObserved(); return actualRefresh(); }; globalThis.handoff = { onHello, resetView };", box,
  );
  box.handoff.resetView(null);
  const pin = { provider: "custom-openai-bridge", model: "synthetic-bridge-model", effort: "high" };
  state.pendingModel = pin; view.projectId = "synthetic-project"; view.pendingMerge = [{ session: "synthetic-source" }];
  box.handoff.onHello({ uiTag: "synthetic-ui", runs: [], run: null, resume: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.pendingModel, pin, "the selection survives the fresh SSE hello");
  assert.deepEqual(refreshes.at(-1), pin, "refresh sees the pin immediately, never the global default");
  assert.match(modelQueries.at(-1), /provider=custom-openai-bridge/);
  assert.match(modelQueries.at(-1), /model=synthetic-bridge-model/);
  assert.equal(state.sessEff.provider, "custom-openai-bridge");
  assert.equal(view.projectId, "synthetic-project");
  assert.deepEqual(view.pendingMerge, [{ session: "synthetic-source" }]);
  box.handoff.onHello({ uiTag: "synthetic-ui", runs: [], resume: false });
  await Promise.resolve();
  assert.equal(state.pendingModel, pin, "a later non-resumable reconnect also keeps the same draft selection");
  box.handoff.resetView(null);
  assert.equal(state.pendingModel, null, "explicitly opening a new conversation starts with a clean selection");
  state.pendingModel = pin;
  box.handoff.resetView("different-session", true);
  assert.equal(state.pendingModel, null, "an existing session can never inherit a new-session pin");
});

test("bridge form: card stays inside Extensions, old key is not echoed and save is not inference or session switching", async () => {
  const u = ui(saved({ apiKey: "do-not-display-synthetic-old-key" })); let used = 0;
  await u.open({ useNew: async () => { used++; } });
  assert.equal(u.get("tab-ext").classList.contains("bridge-config-open"), true);
  assert.equal(u.get("bridge-config-panel").parentElement.id, "tab-ext");
  assert.equal(u.document.activeElement.id, "bridge-config-title", "opening does not auto-open the keyboard");
  assert.equal(u.get("bc-key").value, "");
  await u.click("edit");
  assert.equal(u.get("bc-endpoint").value, "https://api.example.com/v1");
  assert.equal(u.get("bc-key").value, "");
  assert.equal(u.get("bc-key").required, false);
  await u.submit();
  assert.deepEqual(u.calls.map((c) => c.method), ["GET", "POST"]);
  assert.deepEqual(u.calls[1].body, { endpoint: "https://api.example.com/v1", model: "synthetic-model", consent: true,
    models: [{ id: "synthetic-model", contextWindow: 200000 }] });
  assert.equal(used, 0);
  assert.equal(u.get("bc-local-state").textContent, "本地已准备好");
  assert.equal(u.get("bc-remote-state").textContent, "模型推理尚未验证");
  await u.click("use");
  assert.equal(used, 1);
  assert.equal(u.get("tab-ext").classList.contains("bridge-config-open"), false);
});

test("bridge form: first save needs three fields; replacement key is sent once, cleared and never stored", async () => {
  const u = ui(); await u.open(); await u.submit();
  assert.equal(u.calls.length, 1); assert.equal(u.get("bc-endpoint").getAttribute("aria-invalid"), "true");
  fill(u); u.response(saved()); await u.submit();
  assert.equal(u.calls.length, 2);
  assert.equal(u.calls[1].body.apiKey, "synthetic-test-key");
  assert.equal(u.get("bc-key").value, "");
  assert.equal(u.get("bc-key").type, "password");
  assert.equal(u.get("bc-saved").classList.contains("hidden"), false);
});

test("bridge form: cancelled explicit data-sharing consent never posts configuration", async () => {
  const u = ui(); await u.open(); fill(u); u.consent(false); await u.submit();
  assert.equal(u.calls.length, 1);
  assert.equal(u.confirms.length, 1);
  assert.match(u.confirms[0], /https:\/\/api\.example\.com/);
  assert.match(u.confirms[0], /对话、工具结果和图片/);
  assert.match(u.confirms[0], /不调用远端模型/);
  assert.equal(u.get("bc-key").value, "synthetic-test-key");
  u.consent(true); u.response(saved()); await u.submit();
  assert.equal(u.calls[1].body.consent, true);
});

test("bridge form: a different origin or port requires a replacement key, with no request on invalid fields", async () => {
  for (const endpoint of ["https://other.example.com/v1", "https://api.example.com:444/v1"]) {
    const u = ui(saved()); await u.open(); await u.click("edit");
    u.input("endpoint", endpoint); await u.submit();
    assert.equal(u.calls.length, 1); assert.equal(u.get("bc-key").getAttribute("aria-invalid"), "true");
    assert.match(u.get("bc-key-hint").textContent, /旧密钥不会/);
    u.input("key", "replacement-synthetic-key"); u.response(saved({ endpoint })); await u.submit();
    assert.equal(u.calls[1].body.apiKey, "replacement-synthetic-key");
  }
});

test("bridge form: rejects unsafe URLs, unsupported paths and invalid model IDs without remote discovery", async () => {
  for (const endpoint of ["http://api.example.com/v1", "https://user:pass@api.example.com/v1", "https://api.example.com/v1?key=synthetic", "https://api.example.com/v1#x", "https://api.example.com/v1/responses", "https://api.example.com/private", "https://api.example.com\\\\private/chat/completions", "https://api.example.com/a b/chat/completions", "https://api.example.com/v1/cha\nt/completions", "javascript:alert(1)"]) {
    const u = ui(); await u.open(); fill(u); u.input("endpoint", endpoint); await u.submit();
    assert.equal(u.calls.length, 1, endpoint); assert.equal(u.get("bc-endpoint").getAttribute("aria-invalid"), "true");
  }
  const u = ui(); await u.open(); fill(u); u.input("model", "one,two"); await u.submit();
  assert.equal(u.calls.length, 1); assert.equal(u.get("bc-model").getAttribute("aria-invalid"), "true");
  u.input("model", "one"); u.input("key", "line\nbreak"); await u.submit();
  assert.equal(u.calls.length, 1); assert.equal(u.get("bc-key").getAttribute("aria-invalid"), "true");
});

test("bridge form: displays exact normalization only for root, v1 or full Chat Completions paths", async () => {
  const u = ui(); await u.open();
  for (const endpoint of ["https://api.example.com", "https://api.example.com/v1/", "https://api.example.com/v1/chat/completions"]) {
    u.input("endpoint", endpoint);
    assert.equal(u.get("bc-endpoint-preview").textContent, "请求地址：https://api.example.com/v1/chat/completions");
  }
  u.input("endpoint", "https://api.example.com/custom/chat/completions");
  assert.equal(u.get("bc-endpoint-preview").textContent, "请求地址：https://api.example.com/custom/chat/completions");
});

test("bridge form: local readiness is independent of saved configuration; errors retain inputs and never echo server secrets", async () => {
  const u = ui(); await u.open(); fill(u); u.response(saved({ local: { state: "error" } })); await u.submit();
  assert.equal(u.get("bc-use").disabled, true);
  assert.equal(u.get("bc-local-state").textContent, "配置已保存，但本地桥尚未就绪");
  assert.match(u.get("bc-notice").textContent, /诊断.*保存配置不会重置恢复次数/);
  await u.click("edit"); u.input("key", "synthetic-new-key");
  u.post(async () => reply({ field: "apiKey", message: "secret-token-must-not-render", apiKey: "synthetic-new-key" }, 400));
  await u.submit();
  assert.equal(u.get("bc-key").value, "synthetic-new-key");
  assert.equal(u.get("bc-key").type, "password");
  assert.equal(u.get("bc-key").getAttribute("aria-invalid"), "true");
  assert.ok(!u.get("bc-notice").textContent.includes("secret-token"));
  assert.equal(u.get("bc-form").classList.contains("hidden"), false);
});

for (const code of ["RECOVERY_EXHAUSTED", "PATCH_VERIFICATION_FAILED", "COMPONENT_DISABLED", "LOCAL_START_FAILED", "COMPONENT_UNAVAILABLE", "UPDATE_REQUIRED"]) test(`bridge local fault ${code}: read and repeated saves show diagnosis, never a ready new-session action`, async () => {
  const data = saved({ localError: code, local: { state: "ready", code } });
  const u = ui(data); let used = 0;
  await u.open({ useNew: async () => { used++; } });
  assert.equal(u.get("bc-use").disabled, true);
  const message = u.get("bc-notice").textContent;
  assert.ok(message); assert.equal(message.includes("可修改配置后重试"), false);
  if (code === "RECOVERY_EXHAUSTED") {
    assert.equal(u.get("bc-local-state").textContent, "自动恢复次数已耗尽");
    assert.match(message, /修改配置不会解除.*诊断.*明确重置恢复次数/);
  }
  for (let i = 0; i < 3; i++) {
    await u.click("edit"); u.response(data); await u.submit();
    assert.equal(u.get("bc-use").disabled, true);
    assert.equal(u.get("bc-notice").textContent, message, "save-time notice must not override the fault explanation");
  }
  await u.click("use"); assert.equal(used, 0);
  assert.equal(u.calls.some((c) => /reset|start/.test(c.url)), false);
});

for (const code of ["RECOVERY_EXHAUSTED", "PATCH_VERIFICATION_FAILED", "COMPONENT_DISABLED", "COMPONENT_UNAVAILABLE", "UPDATE_REQUIRED", "LOCAL_START_FAILED", "provider_save_failed", "unknown-private-code"]) test(`bridge failed save ${code}: a healthy GET never leaves stale ready status after POST failure`, async () => {
  const u = ui(saved()); let used = 0;
  await u.open({ useNew: async () => { used++; } });
  assert.equal(u.get("bc-service-state").textContent, "已就绪");
  await u.click("edit"); u.input("key", "synthetic-replacement-key");
  u.post(() => reply({ ok: false, saved: code === "provider_save_failed", localReady: false, code, message: "untrusted-private-save-detail" }, 400));
  await u.submit();
  assert.equal(u.get("bc-config-state").textContent, "未确认", "a failed save cannot keep the old successful check");
  assert.equal(u.get("bc-service-state").textContent, ["provider_save_failed", "unknown-private-code"].includes(code) ? "未确认" : "不可用于新会话");
  assert.equal(u.get("bc-service-state").classList.contains("bc-ready"), false);
  assert.equal(u.get("bc-use").disabled, true);
  assert.equal(u.get("bc-key").value, "synthetic-replacement-key");
  assert.equal(u.get("bc-form").classList.contains("hidden"), false);
  assert.equal(u.get("bridge-config-panel").textContent.includes("untrusted-private"), false);
  assert.equal(u.get("bridge-config-panel").textContent.includes("unknown-private-code"), false);
  await u.click("use"); assert.equal(used, 0);
  assert.equal(u.calls.some((c) => /reset|start/.test(c.url)), false);
});

test("bridge local fault: saved error response uses fixed explanation, not a misleading configuration retry", async () => {
  const u = ui(); await u.open(); fill(u);
  u.post(() => reply({ ok: false, saved: true, code: "RECOVERY_EXHAUSTED", message: "untrusted private response" }, 400));
  await u.submit();
  assert.match(u.get("bc-notice").textContent, /修改配置不会解除.*诊断.*明确重置恢复次数/);
  assert.equal(u.get("bc-notice").textContent.includes("untrusted"), false);
  assert.equal(u.configPosts().length, 1);
});

test("bridge form: absent or malformed component status never enables configuration or a new session", async () => {
  for (const data of [fresh(), { configured: true, hasKey: true }, saved({ installed: false })]) {
    const u = ui(data); await u.open();
    if (!data.installed) {
      assert.equal(u.get("bc-form").classList.contains("hidden"), true);
      assert.match(u.get("bc-issue-detail").textContent, /先安装或更新/);
      assert.equal(u.get("bc-issue").classList.contains("hidden"), false);
      assert.equal(u.get("bc-package-state").textContent, "暂不可用");
    }
    assert.equal(u.calls.length, 1);
  }
  const u = ui(saved({ providerId: "", local: { state: "ready" } })); await u.open({ useNew: async () => assert.fail("must not create without a provider") });
  assert.equal(u.get("bc-use").disabled, true);
});

test("bridge form: config GET 409 BUSY reports retry instead of installation", async () => {
  const u = ui();
  u.read(() => reply({ ok: false, code: "BUSY", message: "synthetic-private-server-detail" }, 409));
  await u.open(); await u.advance(1000);
  assert.equal(u.get("bc-issue-detail").textContent, "本地桥正在使用或卸载中，请稍后重试；当前会话保持不变。");
  assert.equal(u.get("bc-issue-title").textContent, "本地桥正在忙碌");
  assert.equal(u.get("bc-issue").classList.contains("hidden"), false);
  assert.equal(u.get("bc-notice").classList.contains("hidden"), true);
  assert.equal(u.get("bc-loading").classList.contains("hidden"), true);
  assert.equal(u.get("bc-form").classList.contains("hidden"), true);
  assert.equal(u.get("bc-saved").classList.contains("hidden"), true);
  assert.equal(u.get("bc-key").value, "");
  assert.deepEqual(u.calls.map(({ url, method }) => ({ url, method })), [{ url: "/api/components/openai-bridge/config", method: "GET" }]);
  assert.equal(u.confirms.length, 0);
  assert.equal(u.close(), true, "a failed read releases busy state so the user can leave");
});

test("bridge form: legacy conflict shows an honest unknown check card, not a backup or duplicate-install diagnosis", async () => {
  const u = ui();
  u.read(() => reply({ ok: false, code: "RUNTIME_CONFLICT", message: "synthetic-private-server-detail" }, 409));
  await u.open(); await u.advance(1000);
  assert.equal(u.get("bc-issue-title").textContent, "配置检查未通过");
  assert.match(u.get("bc-issue-detail").textContent, /只返回统一冲突码.*无法确定失败项/);
  assert.equal(u.get("bc-issue-code").textContent, "RUNTIME_CONFLICT · UNKNOWN");
  assert.equal(u.get("bc-package-state").textContent, "未确认", "old errors cannot prove a usable component entry");
  assert.equal(u.get("bc-config-state").textContent, "未通过");
  assert.equal(u.get("bc-service-state").textContent, "未确认", "a conflict is not proof the service has stopped");
  assert.equal(u.get("bc-backup-help").open, false);
  assert.equal(u.get("bc-notice").classList.contains("hidden"), true);
  assert.equal(u.get("bc-issue").classList.contains("hidden"), false);
  assert.equal(u.get("bc-loading").classList.contains("hidden"), true);
  assert.equal(u.get("bc-form").classList.contains("hidden"), true);
  assert.equal(u.get("bc-saved").classList.contains("hidden"), true);
  assert.equal(u.get("bc-key").value, "");
  assert.deepEqual(u.calls.map(({ url, method }) => ({ url, method })), [{ url: "/api/components/openai-bridge/config", method: "GET" }]);
  assert.equal(u.close(), true);
});

test("bridge form: config GET 404 or not_installed alone prompts installation; unknown 409 remains a read failure", async () => {
  for (const [status, code, expected] of [
    [404, undefined, "请先安装或更新 OpenAI API 本地协议桥组件。"],
    [409, "not_installed", "请先安装或更新 OpenAI API 本地协议桥组件。"],
    [409, "component_failed", "读取桥配置失败，请返回扩展后重试。"],
    [409, undefined, "读取桥配置失败，请返回扩展后重试。"],
  ]) {
    const u = ui(); u.read(() => reply({ ok: false, ...(code ? { code } : {}), message: "synthetic-private-server-detail" }, status));
    await u.open(); await u.advance(1000);
    assert.equal(u.get("bc-issue-detail").textContent, expected, `${status}/${code || "no-code"}`);
    assert.equal(u.get("bc-issue").classList.contains("hidden"), false);
    assert.equal(u.get("bc-form").classList.contains("hidden"), true);
    assert.equal(u.get("bc-saved").classList.contains("hidden"), true);
    assert.equal(u.get("bc-loading").classList.contains("hidden"), true);
    assert.equal(u.get("bc-key").value, "");
    assert.equal(u.calls.length, 1);
    assert.equal(u.configPosts().length, 0);
    assert.equal(u.modelCalls().length, 0);
    assert.equal(u.close(), true);
  }
});

test("bridge form: partial save failure reports saved versus readiness without losing replacement input", async () => {
  const u = ui(); await u.open(); fill(u);
  u.post(async () => reply({ ok: false, saved: true, localReady: false, code: "provider_save_failed", message: "untrusted-secret-synthetic" }, 400));
  await u.submit();
  assert.match(u.get("bc-notice").textContent, /本地桥尚未就绪.*诊断/);
  assert.equal(u.get("bc-form").classList.contains("hidden"), false);
  assert.equal(u.get("bc-key").value, "synthetic-test-key");
  assert.equal(u.get("bc-key").type, "password");
  assert.ok(!u.get("bc-notice").textContent.includes("untrusted-secret"));
});

for (const [code, expected] of [
  ["RUNTIME_CONFLICT", "当前版本只返回统一冲突码，无法确定失败项；可能涉及运行文件、安装归属或 App 接口记录。"],
  ["BUSY", "本地桥正在使用或卸载中，请稍后重试；当前会话保持不变。"],
  ["not_installed", "请先安装或更新 OpenAI API 本地协议桥组件。"],
  ["unknown-private-code", "保存配置未完成；请检查本地状态后重试，当前会话保持不变。"],
]) test(`bridge form: save 409 ${code} reports its fixed reason rather than treating every conflict as busy`, async () => {
  const u = ui(); await u.open(); fill(u);
  u.post(() => reply({ ok: false, saved: false, code, message: "untrusted-private-save-detail" }, 409));
  await u.submit();
  assert.equal(u.get(code === "unknown-private-code" ? "bc-notice" : "bc-issue-detail").textContent, expected);
  if (code !== "unknown-private-code") assert.equal(u.get("bc-issue").classList.contains("hidden"), false);
  assert.equal(u.get("bc-form").classList.contains("hidden"), false);
  assert.equal(u.get("bc-saved").classList.contains("hidden"), true);
  assert.equal(u.get("bc-key").value, "synthetic-test-key");
  assert.equal(u.configPosts().length, 1);
  assert.equal(u.get("bridge-config-panel").textContent.includes("untrusted-private-save-detail"), false);
  assert.equal(u.get("bc-notice").textContent.includes("unknown-private-code"), false);
});

test("bridge form: an ownership conflict after partial save keeps the same GET explanation", async () => {
  const expected = "当前版本只返回统一冲突码，无法确定失败项；可能涉及运行文件、安装归属或 App 接口记录。";
  const u = ui(); await u.open(); fill(u);
  u.post(() => reply({ ok: false, saved: true, localReady: false, code: "RUNTIME_CONFLICT", message: "untrusted-private-save-detail" }, 409));
  await u.submit();
  assert.equal(u.get("bc-issue-detail").textContent, expected);
  assert.match(u.get("bc-issue-hint").textContent, /已写入.*后续步骤未完成/);
  assert.equal(u.get("bc-key").value, "synthetic-test-key");
  u.close();
  u.read(() => reply({ ok: false, code: "RUNTIME_CONFLICT", message: "untrusted-private-get-detail" }, 409));
  await u.open();
  assert.equal(u.get("bc-issue-detail").textContent, expected);
  assert.match(u.get("bc-issue-hint").textContent, /只读检查未修改/);
});

for (const [check, detail] of [
  ["APP_PROVIDER", /App 接口的地址、认证设置或本地连接记录/],
  ["APP_MAPPING", /接口映射记录未通过/],
  ["MODEL_LIST", /模型清单未通过/],
  ["OWNERSHIP", /未能确认默认运行目录/],
  ["CONNECTION", /服务注册与本地连接记录/],
  ["COMPONENT", /未返回具体失败项/],
]) test(`bridge checks ${check}: static stage explains the failure without secrets or a guessed cause`, async () => {
  const u = ui();
  u.read(() => reply({ ok: false, code: "RUNTIME_CONFLICT", check, message: "untrusted-private-path-or-key", detail: "do-not-render" }, 409));
  await u.open();
  assert.match(u.get("bc-issue-detail").textContent, detail);
  assert.equal(u.get("bc-issue-code").textContent, "RUNTIME_CONFLICT · " + check);
  assert.equal(u.get("bc-package-state").textContent, "可用");
  assert.equal(u.get("bc-service-state").textContent, "未确认");
  assert.equal(u.get("bc-issue").classList.contains("hidden"), false);
  assert.equal(u.get("bridge-config-panel").textContent.includes("untrusted-private"), false);
  assert.equal(u.get("bridge-config-panel").textContent.includes("do-not-render"), false);
  assert.equal(u.configPosts().length, 0); assert.equal(u.modelCalls().length, 0);
});

test("bridge checks: unknown diagnostic text cannot become a check name or a fake installed state", async () => {
  const u = ui(); u.read(() => reply({ ok: false, code: "RUNTIME_CONFLICT", check: "private-credential-or-path", message: "private-server-text" }, 409));
  await u.open();
  assert.equal(u.get("bc-issue-code").textContent, "RUNTIME_CONFLICT · UNKNOWN");
  assert.equal(u.get("bc-package-state").textContent, "未确认");
  assert.equal(u.get("bridge-config-panel").textContent.includes("private-"), false);
});

test("bridge checks: a readable saved model mismatch still marks the configuration check as failed", async () => {
  const u = ui(saved({ providerId: "", check: "MODEL_LIST", localError: "LOCAL_START_FAILED", local: { state: "ready" } }));
  await u.open();
  assert.equal(u.get("bc-config-state").textContent, "未通过");
  assert.match(u.get("bc-notice").textContent, /App 保存的模型清单未通过/);
  assert.equal(u.get("bc-use").disabled, true);
});

test("bridge checks: App metadata details never mask an authoritative recovery fault", async () => {
  const u = ui(saved({ localError: "RECOVERY_EXHAUSTED", check: "MODEL_LIST", local: { state: "ready" } }));
  await u.open();
  assert.match(u.get("bc-notice").textContent, /自动恢复已停止.*修改配置不会解除/);
  assert.equal(u.get("bc-service-state").textContent, "不可用于新会话");
  assert.equal(u.get("bc-use").disabled, true);
});

test("bridge checks: explicit recheck is one read-only GET, then clears the issue without saves or model calls", async () => {
  const u = ui(), pending = deferred();
  u.read(() => reply({ ok: false, code: "RUNTIME_CONFLICT", check: "APP_PROVIDER" }, 409));
  await u.open();
  u.read(() => pending.promise);
  await u.click("check-again");
  assert.equal(u.get("bc-check-again").disabled, true);
  await u.click("check-again");
  assert.equal(u.calls.length, 2);
  pending.resolve(reply(saved())); await u.flush();
  assert.equal(u.get("bc-issue").classList.contains("hidden"), true);
  assert.equal(u.get("bc-saved").classList.contains("hidden"), false);
  assert.equal(u.get("bc-package-state").textContent, "可用");
  assert.equal(u.get("bc-config-state").textContent, "已核对");
  assert.equal(u.get("bc-service-state").textContent, "已就绪");
  assert.equal(u.configPosts().length, 0); assert.equal(u.modelCalls().length, 0);
  assert.equal(u.confirms.length, 0);
});

test("bridge checks: a declined recheck after a save error preserves draft input and sends no request", async () => {
  const u = ui(); await u.open(); fill(u);
  u.post(() => reply({ ok: false, code: "RUNTIME_CONFLICT", check: "APP_PROVIDER" }, 409));
  await u.submit();
  assert.equal(u.get("bc-key").value, "synthetic-test-key");
  const before = u.calls.length; u.consent(false); await u.click("check-again");
  assert.equal(u.calls.length, before); assert.equal(u.get("bc-key").value, "synthetic-test-key");
  u.consent(true); u.read(() => reply(saved())); await u.click("check-again"); await u.flush();
  assert.equal(u.calls.length, before + 1); assert.equal(u.calls.at(-1).method, "GET");
  assert.equal(u.get("bc-key").value, ""); assert.equal(u.get("bc-issue").classList.contains("hidden"), true);
});

test("bridge checks: leaving during recheck ignores late responses and never reopens the panel", async () => {
  const u = ui(), pending = deferred();
  u.read(() => reply({ ok: false, code: "RUNTIME_CONFLICT" }, 409)); await u.open();
  u.read(() => pending.promise); await u.click("check-again");
  u.leavePage(); pending.resolve(reply(saved())); await u.flush();
  assert.equal(u.get("tab-ext").classList.contains("bridge-config-open"), false);
  assert.equal(u.get("bc-saved").classList.contains("hidden"), true);
  assert.equal(u.get("bc-key").value, "");
});

const syntheticRepairPlan = () => ({ ok: true, repair: { available: true, action: "SYNC_APP_METADATA", ticket: "f".repeat(48), expiresIn: 60, changes: ["MODELS"], models: [{ id: "synthetic-model", contextWindow: 1048576 }] } });
async function conflictUi() {
  const u = ui(); u.read(() => reply({ ok: false, code: "RUNTIME_CONFLICT", check: "MODEL_LIST" }, 409)); await u.open(); return u;
}
test("bridge repair: opening and rechecking never inspects or applies automatically; explicit inspect only offers a plan", async () => {
  const u = await conflictUi(); assert.equal(u.repairCalls().length, 0);
  assert.equal(u.get("bc-repair").classList.contains("hidden"), false);
  u.repair(() => reply(syntheticRepairPlan())); await u.click("repair-inspect");
  assert.equal(u.repairCalls().length, 1); assert.equal(u.repairCalls()[0].body.action, "inspect");
  assert.equal(u.get("bc-repair-plan").classList.contains("hidden"), false);
  assert.match(u.get("bc-repair-status").textContent, /尚未修改任何配置/);
  assert.equal(u.get("bridge-config-panel").textContent.includes("f".repeat(48)), false, "ticket is never rendered");
  assert.equal(u.configPosts().length, 0); assert.equal(u.modelCalls().length, 0); assert.equal(u.confirms.length, 0);
});
test("bridge repair: cancel or decline does not apply, and fresh confirmation consumes only the planned ticket then reads status", async () => {
  const u = await conflictUi();
  u.repair(call => reply(call.body.action === "inspect" ? syntheticRepairPlan() : { ok: true, repaired: true, scope: "APP_METADATA" }));
  await u.click("repair-inspect"); u.consent(false); await u.click("repair-apply");
  assert.equal(u.repairCalls().length, 1); assert.equal(u.get("bc-repair-plan").classList.contains("hidden"), false);
  await u.click("repair-cancel"); assert.equal(u.get("bc-repair-plan").classList.contains("hidden"), true);
  await u.click("repair-apply"); assert.equal(u.repairCalls().length, 1);
  await u.click("repair-inspect"); u.consent(true); u.read(() => reply(saved()));
  await u.click("repair-apply"); await u.flush();
  assert.equal(u.repairCalls().length, 3); assert.deepEqual(u.repairCalls().at(-1).body, { action: "apply", consent: true, ticket: "f".repeat(48) });
  assert.equal(u.get("bc-saved").classList.contains("hidden"), false);
  assert.equal(u.get("bc-notice").classList.contains("hidden"), false);
  assert.match(u.get("bc-notice").textContent, /已同步/);
  assert.equal(u.configPosts().length, 0); assert.equal(u.modelCalls().length, 0);
});
test("bridge repair: successful apply followed by a failed status read keeps the diagnosis visible without claiming readiness", async () => {
  const u = await conflictUi();
  u.repair(call => reply(call.body.action === "inspect" ? syntheticRepairPlan() : { ok: true, repaired: true, scope: "APP_METADATA" }));
  await u.click("repair-inspect");
  u.read(() => reply({ ok: false, code: "RUNTIME_CONFLICT", check: "APP_PROVIDER" }, 409));
  await u.click("repair-apply"); await u.flush();
  assert.equal(u.get("bc-issue").classList.contains("hidden"), false);
  assert.equal(u.get("bc-use").disabled, true);
  assert.equal(u.get("bc-service-state").textContent, "未确认");
  assert.equal(u.get("bc-repair-status").textContent.includes("已重新读取本地状态"), false);
});

test("bridge repair: expired plan, private diagnostic and malformed plan never expose an apply action", async () => {
  const u = await conflictUi(); u.repair(() => reply(syntheticRepairPlan())); await u.click("repair-inspect");
  await u.advance(60001); await u.click("repair-apply"); assert.equal(u.repairCalls().length, 1);
  assert.match(u.get("bc-repair-status").textContent, /方案已失效/);
  u.repair(() => reply({ ok: true, repair: { ...syntheticRepairPlan().repair, changes: ["untrusted-private-operation"] } }));
  await u.click("repair-inspect"); assert.equal(u.get("bc-repair-plan").classList.contains("hidden"), true);
  assert.equal(u.get("bridge-config-panel").textContent.includes("untrusted-private"), false);
  assert.equal(u.get("bc-repair-steps").open, true);
});
test("bridge repair: delayed inspect is single-shot and leaving drops the late plan", async () => {
  const u = await conflictUi(), pending = deferred(); u.repair(() => pending.promise);
  await u.click("repair-inspect"); await u.click("repair-inspect"); assert.equal(u.repairCalls().length, 1);
  u.leavePage(); pending.resolve(reply(syntheticRepairPlan())); await u.flush();
  assert.equal(u.get("tab-ext").classList.contains("bridge-config-open"), false); assert.equal(u.get("bc-repair-plan").classList.contains("hidden"), true);
});
test("bridge repair: partial commit rechecks once and never claims no configuration was changed", async () => {
  const u = await conflictUi();
  u.repair(call => reply(call.body.action === "inspect" ? syntheticRepairPlan() : { ok: false, code: "REPAIR_PARTIAL", committed: true, scope: "APP_METADATA", message: "private-partial-state" }, call.body.action === "inspect" ? 200 : 409));
  await u.click("repair-inspect"); u.read(() => reply(saved()));
  const reads = u.calls.filter(call => call.method === "GET").length;
  await u.click("repair-apply"); await u.flush();
  assert.equal(u.calls.filter(call => call.method === "GET").length, reads + 1);
  assert.equal(u.get("bc-repair").classList.contains("hidden"), false); assert.equal(u.get("bc-repair-steps").open, true);
  assert.match(u.get("bc-repair-status").textContent, /已写入.*收尾未完成/);
  assert.equal(u.get("bc-repair-status").textContent.includes("未执行"), false);
  assert.equal(u.get("bridge-config-panel").textContent.includes("private-partial-state"), false);
  assert.equal(u.repairCalls().length, 2); assert.equal(u.configPosts().length, 0);
});
test("bridge repair: partial commit and a failed recheck preserve both partial-write warning and current diagnosis", async () => {
  const u = await conflictUi();
  u.repair(call => reply(call.body.action === "inspect" ? syntheticRepairPlan() : { ok: false, code: "REPAIR_PARTIAL" }, call.body.action === "inspect" ? 200 : 409));
  await u.click("repair-inspect");
  u.read(() => reply({ ok: false, code: "RUNTIME_CONFLICT", check: "APP_PROVIDER", message: "private-after-partial" }, 409));
  const reads = u.calls.filter(call => call.method === "GET").length;
  await u.click("repair-apply"); await u.flush();
  assert.equal(u.calls.filter(call => call.method === "GET").length, reads + 1);
  assert.equal(u.get("bc-issue").classList.contains("hidden"), false); assert.equal(u.get("bc-use").disabled, true);
  assert.equal(u.get("bc-service-state").textContent, "未确认"); assert.match(u.get("bc-repair-status").textContent, /已写入.*收尾未完成/);
  assert.equal(u.get("bridge-config-panel").textContent.includes("private-after-partial"), false);
  assert.equal(u.repairCalls().length, 2);
});

test("bridge repair: lost apply response reports uncertainty without automatic retry or asserting no changes", async () => {
  const u = await conflictUi();
  u.repair(call => call.body.action === "inspect" ? reply(syntheticRepairPlan()) : Promise.reject(new Error("private transport error")));
  await u.click("repair-inspect"); await u.click("repair-apply");
  assert.match(u.get("bc-repair-status").textContent, /无法确认.*重新检查/);
  assert.equal(u.get("bc-repair-status").textContent.includes("未执行"), false);
  assert.equal(u.get("bridge-config-panel").textContent.includes("private transport error"), false);
  assert.equal(u.get("bc-use").disabled, true); assert.equal(u.repairCalls().length, 2);
});

test("bridge repair: stale apply stays blocked and renders fixed steps without retrying or echoing server text", async () => {
  const u = await conflictUi(); u.repair(call => reply(call.body.action === "inspect" ? syntheticRepairPlan() : { ok: false, code: "REPAIR_STALE", message: "untrusted-private-state" }, call.body.action === "inspect" ? 200 : 409));
  await u.click("repair-inspect"); await u.click("repair-apply");
  assert.equal(u.repairCalls().length, 2); assert.equal(u.get("bc-repair-plan").classList.contains("hidden"), true);
  assert.equal(u.get("bc-service-state").textContent, "未确认"); assert.equal(u.get("bc-use").disabled, true);
  assert.match(u.get("bc-repair-status").textContent, /未执行本次修复/); assert.equal(u.get("bridge-config-panel").textContent.includes("untrusted-private-state"), false);
});

test("bridge form: in-flight save is single-shot; leaving clears key and late success cannot reopen the panel", async () => {
  const u = ui(), pending = deferred(); await u.open(); fill(u);
  u.post(() => pending.promise);
  const save = u.submit(); await Promise.resolve();
  await u.submit(); assert.equal(u.calls.length, 2);
  assert.equal(u.get("bc-save").disabled, true);
  assert.equal(u.close(), false, "back is held while saving");
  u.leavePage(); assert.equal(u.get("bc-key").value, "");
  pending.resolve(reply(saved())); await save;
  assert.equal(u.get("tab-ext").classList.contains("bridge-config-open"), false);
  assert.equal(u.get("bc-saved").classList.contains("hidden"), true);
});

test("bridge form: hide/show applies only to newly entered key, blur remasks it, back restores extension view", async () => {
  const u = ui(); await u.open(); u.input("key", "synthetic-key"); await u.click("eye");
  assert.equal(u.get("bc-key").type, "text"); u.blur(); assert.equal(u.get("bc-key").type, "password");
  assert.equal(u.back(), true); assert.equal(u.get("bc-key").value, "");
  assert.equal(u.get("tab-ext").classList.contains("bridge-config-open"), false);
  assert.equal(u.backCount(), 0); assert.equal(u.back(), false); assert.equal(u.backCount(), 1);
});

test("bridge models: the visible opt-in defaults off and API/key/model edits alone never query or save", async () => {
  for (const initial of [fresh(), saved({ apiKey: "never-echo-saved-synthetic-key" })]) {
    const u = ui(initial); let used = 0;
    await u.open({ useNew: async () => { used++; } });
    if (initial.configured) await u.click("edit");
    const checkbox = u.checkbox();
    assert.ok(checkbox, "the opt-in is a visible checkbox, not a confirm-only implicit grant");
    assert.equal(checkbox.checked, false);
    assert.equal(checkbox.closest(".hidden"), null);
    assert.equal(u.get("bc-key").value, "", "status replies never populate the secret input");
    assert.ok(!u.get("bridge-config-panel").innerHTML.includes("never-echo-saved-synthetic-key"));
    fill(u); u.input("model", "manual-model-without-discovery");
    assert.equal(checkbox.disabled, false, "a valid API address enables the optional visible consent");
    await u.advance(2000);
    assert.equal(u.modelCalls().length, 0);
    assert.equal(u.configPosts().length, 0);
    assert.equal(u.calls.length, 1, "no inference, provider mutation, session creation or automatic save");
    assert.equal(used, 0);
    assert.equal(u.confirms.length, 0);
    assert.equal(u.get("bc-model").disabled, false);
    assert.equal(u.get("bc-model").tagName, "INPUT", "manual model entry is never replaced with a fixed select");
    assert.equal(u.modelList()?.tagName, "UL", "the editable model field supplies in-flow search suggestions (no native datalist popup)");
    u.change(checkbox.id, false); await u.advance(2000);
    assert.equal(u.calls.length, 1, "an explicit false consent must still make zero models requests");
  }
});

test("bridge models: consent plus valid API/key debounces input for 650ms and never auto-selects, saves or creates a session", async () => {
  const u = ui(); let used = 0;
  await u.open({ useNew: async () => { used++; } });
  const checkbox = u.checkbox(); assert.ok(checkbox);
  u.input("endpoint", "https://api.example.com/v1");
  u.change(checkbox.id, true);
  await u.advance(1000);
  assert.equal(u.modelCalls().length, 0, "consent and an API address are insufficient without a key");
  u.input("key", "synthetic-partial-key");
  await u.advance(400);
  assert.equal(u.modelCalls().length, 0);
  u.input("key", "synthetic-final-key");
  await u.advance(649);
  assert.equal(u.modelCalls().length, 0, "typing resets the debounce instead of querying on every keystroke");
  await u.advance(1);
  assert.equal(u.modelCalls().length, 1);
  assert.deepEqual(u.modelCalls()[0].body, { endpoint: "https://api.example.com/v1", apiKey: "synthetic-final-key", consent: true });
  assert.equal(u.get("bc-model").value, "", "listing models does not pick the first suggestion for the user");
  assert.deepEqual(u.modelList().children.map((el) => el.value), ["synthetic-model"]);
  assert.equal(u.configPosts().length, 0);
  assert.equal(u.calls.length, 2, "only the initial configuration read and one model-list request are allowed");
  assert.equal(used, 0);
  assert.equal(u.confirms.length, 0, "models opt-in and save-time conversation consent are separate");
});

test("bridge models: opt-in never bypasses malformed endpoint/key checks or blocks manual save", async () => {
  for (const [endpoint, key] of [
    ["http://api.example.com/v1", "synthetic-key"],
    ["https://user:pass@api.example.com/v1", "synthetic-key"],
    ["https://api.example.com/v1?key=synthetic", "synthetic-key"],
    ["https://api.example.com/v1/responses", "synthetic-key"],
    ["https://api.example.com/private", "synthetic-key"],
    ["https://api.example.com/v1", ""],
    ["https://api.example.com/v1", "synthetic key"],
    ["https://api.example.com/v1", "synthetic\nkey"],
  ]) {
    const u = ui(); await u.open();
    u.input("endpoint", endpoint); u.input("key", key);
    const checkbox = u.checkbox(); assert.ok(checkbox); u.change(checkbox.id, true);
    await u.advance(2000);
    assert.equal(u.modelCalls().length, 0, `${endpoint}: only valid credentials may trigger discovery`);
    assert.equal(u.configPosts().length, 0);
    assert.equal(u.get("bc-model").disabled, false);
  }
  const u = ui(); await u.open(); fill(u); await u.advance(2000);
  u.response(saved()); await u.submit();
  assert.equal(u.modelCalls().length, 0, "the optional model-list checkbox is not required for a manual save");
  assert.equal(u.configPosts().length, 1);
  assert.equal(u.confirms.length, 1, "manual save still requires its distinct data-sharing confirmation");
  assert.equal(u.get("bc-key").value, "");
});

test("bridge models: model edits and datalist choices neither query again nor replace the user draft", async () => {
  const u = ui(); await u.open(); fill(u);
  const checkbox = u.checkbox(); assert.ok(checkbox); u.change(checkbox.id, true);
  await u.advance(650);
  assert.equal(u.modelCalls().length, 1);
  for (const model of ["s", "synthetic-model", "manual-not-in-returned-list"]) {
    u.input("model", model); await u.advance(1000);
    assert.equal(u.get("bc-model").value, model);
    assert.equal(u.modelCalls().length, 1, "model selection only changes the local editable input");
  }
  assert.equal(u.configPosts().length, 0);
  u.response(saved({ model: "manual-not-in-returned-list" })); await u.submit();
  assert.equal(u.configPosts()[0].body.model, "manual-not-in-returned-list");
  assert.equal(u.modelCalls().length, 1);
  assert.equal(u.get("bc-saved-model").textContent, "manual-not-in-returned-list");
});

test("bridge models: an old saved key is usable only through a consented same-origin request and never echoed", async () => {
  const u = ui(saved({ apiKey: "never-display-the-old-synthetic-key" })); await u.open();
  await u.advance(1000); assert.equal(u.modelCalls().length, 0, "the saved summary never silently contacts the upstream");
  await u.click("edit");
  const checkbox = u.checkbox(); assert.ok(checkbox);
  assert.equal(checkbox.checked, false);
  u.change(checkbox.id, true); await u.advance(650);
  assert.equal(u.modelCalls().length, 1);
  assert.deepEqual(u.modelCalls()[0].body, { endpoint: "https://api.example.com/v1", consent: true }, "the server resolves the saved key; the browser never reads it");
  assert.equal(u.get("bc-key").value, "");
  u.input("endpoint", "https://api.example.com/custom/chat/completions");
  assert.equal(checkbox.checked, true, "a path-only edit stays within the already-consented origin");
  await u.advance(650);
  assert.equal(u.modelCalls().length, 2);
  assert.deepEqual(u.modelCalls()[1].body, { endpoint: "https://api.example.com/custom/chat/completions", consent: true });
  assert.equal(u.get("bc-key").value, "");
  assert.ok(!u.get("bridge-config-panel").innerHTML.includes("never-display-the-old-synthetic-key"));
  assert.ok(!u.get("bridge-config-panel").textContent.includes("never-display-the-old-synthetic-key"));
  assert.equal(u.configPosts().length, 0);
});

test("bridge models: changing origin or port clears entered keys and consent before a new address can be queried", async () => {
  for (const endpoint of ["https://other.example.com/v1", "https://api.example.com:444/v1"]) {
    const u = ui(saved()); await u.open(); await u.click("edit");
    u.input("key", "do-not-send-this-previous-origin-key");
    const checkbox = u.checkbox(); assert.ok(checkbox); u.change(checkbox.id, true);
    await u.advance(400);
    u.input("endpoint", endpoint);
    assert.equal(checkbox.checked, false, "origin changes require a fresh visible opt-in");
    assert.equal(u.get("bc-key").value, "", "even an unsaved replacement key cannot follow the API origin");
    await u.advance(2000);
    assert.equal(u.modelCalls().length, 0, "an old-origin debounce cannot send either key to the new origin");
    u.change(checkbox.id, true); await u.advance(1000);
    assert.equal(u.modelCalls().length, 0, "consent alone cannot reuse a saved cross-origin key");
    u.input("key", "explicit-new-origin-synthetic-key"); await u.advance(650);
    assert.equal(u.modelCalls().length, 1);
    assert.deepEqual(u.modelCalls()[0].body, { endpoint, apiKey: "explicit-new-origin-synthetic-key", consent: true });
    assert.equal(u.configPosts().length, 0);
  }
});

test("bridge models: withdrawing consent cancels debounce or fetch and rejects late results without erasing a manual model", async () => {
  for (const inFlight of [false, true]) {
    const u = ui(), pending = deferred(); await u.open(); fill(u);
    u.models(() => pending.promise);
    const checkbox = u.checkbox(); assert.ok(checkbox); u.change(checkbox.id, true);
    await u.advance(inFlight ? 650 : 400);
    assert.equal(u.modelCalls().length, inFlight ? 1 : 0);
    const call = u.modelCalls()[0];
    u.change(checkbox.id, false);
    if (call) { assert.ok(call.signal); assert.equal(call.signal.aborted, true); }
    assert.equal(u.pendingTimers(), 0, "withdrawal removes the pending debounce instead of merely ignoring its reply");
    pending.resolve(reply({ ok: true, models: [{ id: "late-withdrawn-model" }], truncated: false }));
    await u.flush(); await u.advance(2000);
    assert.equal(u.modelCalls().length, inFlight ? 1 : 0);
    assert.deepEqual(u.modelList().children, []);
    assert.equal(u.get("bc-model").value, "synthetic-model");
    assert.equal(u.get("bc-model").disabled, false);
    assert.equal(u.get("bc-save").disabled, false);
    assert.equal(u.configPosts().length, 0);
  }
});

test("bridge models: remote IDs are untrusted text-valued option nodes, never injected HTML", async () => {
  const u = ui(); await u.open(); fill(u);
  const malicious = '\"><img src=x onerror=alert(1)>', ampersands = "vendor/<script>&\"'";
  u.models(() => reply({ ok: true, models: [{ id: malicious }, { id: ampersands }, { id: "safe-model" }], truncated: false }));
  u.input("model", "");
  const writesBefore = u.htmlWrites.length, tagsBefore = u.createdTags.length;
  const checkbox = u.checkbox(); assert.ok(checkbox); u.change(checkbox.id, true); await u.advance(650);
  const list = u.modelList();
  assert.deepEqual(list.children.map((el) => el.value).sort(), [malicious, ampersands, "safe-model"].sort());
  assert.ok(list.children.every((el) => el.tagName === "LI"));
  assert.ok(list.children.every((el) => el.children.length === 0));
  assert.ok(list.children.every((el) => !Object.keys(el.attributes).some((name) => /^on/i.test(name))));
  assert.ok(u.createdTags.slice(tagsBefore).every((tag) => tag === "LI"), "a remote model name cannot become an img/script element");
  assert.ok(!u.htmlWrites.slice(writesBefore).some(({ html }) => html.includes(malicious) || html.includes(ampersands)), "model IDs must use value/textContent rather than innerHTML");
  assert.equal(u.get("bc-model").value, "");
  assert.equal(u.configPosts().length, 0);
});

test("bridge models: close, back and page exit clear the secret, consent, timer and in-flight suggestions", async () => {
  for (const exit of ["close", "back", "pagehide", "leavePage"]) for (const inFlight of [false, true]) {
    const u = ui(), pending = deferred(); await u.open(); fill(u);
    u.models(() => pending.promise);
    const checkbox = u.checkbox(); assert.ok(checkbox); u.change(checkbox.id, true);
    await u.advance(inFlight ? 650 : 400);
    const call = u.modelCalls()[0];
    if (["close", "back"].includes(exit)) assert.equal(u[exit](), true, "model discovery must not lock the back action");
    else u[exit]();
    assert.equal(u.get("tab-ext").classList.contains("bridge-config-open"), false);
    assert.equal(u.get("bc-key").value, "", `${exit}: leaving must erase newly typed keys`);
    assert.equal(u.get("bc-key").type, "password");
    assert.equal(checkbox.checked, false);
    assert.equal(u.pendingTimers(), 0);
    if (call) { assert.ok(call.signal); assert.equal(call.signal.aborted, true); }
    pending.resolve(reply({ ok: true, models: [{ id: "late-after-leaving" }], truncated: false }));
    await u.flush(); await u.advance(2000);
    assert.equal(u.modelCalls().length, inFlight ? 1 : 0);
    assert.deepEqual(u.modelList().children, []);
    assert.equal(u.configPosts().length, 0);
    assert.equal(u.get("tab-ext").classList.contains("bridge-config-open"), false, "late replies cannot reopen the panel");
    assert.equal(u.get("bc-key").value, "");
  }
});

test("bridge models: a reopened form has neither the old key nor consent and cannot inherit an earlier response", async () => {
  const u = ui(), pending = deferred(); await u.open(); fill(u);
  u.models(() => pending.promise);
  u.change(u.checkbox().id, true); await u.advance(650); u.close();
  await u.open();
  assert.equal(u.checkbox().checked, false);
  assert.equal(u.get("bc-key").value, "");
  assert.deepEqual(u.modelList().children, []);
  u.models(() => reply({ ok: true, models: [{ id: "reopened-current-model" }], truncated: false }));
  fill(u, "synthetic-key-entered-after-reopen"); u.input("model", ""); u.change(u.checkbox().id, true); await u.advance(650);
  pending.resolve(reply({ ok: true, models: [{ id: "previous-opening-model" }], truncated: false }));
  await u.flush();
  assert.deepEqual(u.modelList().children.map((el) => el.value), ["reopened-current-model"]);
  assert.equal(u.get("bc-key").value, "synthetic-key-entered-after-reopen");
  assert.equal(u.modelCalls().length, 2);
  assert.equal(u.configPosts().length, 0);
});

test("bridge models: saving cancels outstanding discovery before posting config and late replies cannot alter saved state", async () => {
  for (const inFlight of [false, true]) {
    const u = ui(), pending = deferred(); let used = 0;
    await u.open({ useNew: async () => { used++; } }); fill(u);
    u.models(() => pending.promise);
    u.change(u.checkbox().id, true); await u.advance(inFlight ? 650 : 400);
    const call = u.modelCalls()[0];
    u.response(saved()); await u.submit();
    assert.equal(u.pendingTimers(), 0, "save must remove a queued model-list timer");
    if (call) { assert.ok(call.signal); assert.equal(call.signal.aborted, true, "save aborts a model-list request before changing panels"); }
    assert.equal(u.configPosts().length, 1);
    assert.equal(u.configPosts()[0].body.apiKey, "synthetic-test-key");
    assert.equal(u.get("bc-key").value, "");
    assert.equal(u.get("bc-saved").classList.contains("hidden"), false);
    assert.equal(u.get("bc-form").classList.contains("hidden"), true);
    pending.resolve(reply({ ok: true, models: [{ id: "late-after-save" }], truncated: false }));
    await u.flush(); await u.advance(2000);
    assert.equal(u.modelCalls().length, inFlight ? 1 : 0);
    assert.equal(u.configPosts().length, 1, "discovery never adds a second save");
    assert.equal(u.get("bc-saved-model").textContent, "synthetic-model");
    assert.deepEqual(u.modelList().children, []);
    assert.equal(used, 0, "neither discovering nor saving implicitly creates a session");
    await u.click("edit");
    assert.equal(u.checkbox().checked, false);
    assert.equal(u.get("bc-key").value, "");
    await u.advance(1000);
    assert.equal(u.modelCalls().length, inFlight ? 1 : 0, "an edited saved config must ask for model-list consent again");
  }
});

test("bridge models: list errors are nonfatal, do not expose upstream secrets, and leave manual saving available", async () => {
  for (const failure of [
    () => reply({ ok: false, code: "UPSTREAM_AUTH_FAILED", message: "never-render-upstream-secret" }, 401),
    () => reply({ ok: false, code: "MODELS_UNSUPPORTED", message: "never-render-upstream-secret" }, 404),
    () => reply({ ok: false, message: "never-render-upstream-secret" }, 429),
    () => reply({ ok: false, message: "never-render-upstream-secret" }, 502),
    () => Promise.reject(new Error("never-render-upstream-secret")),
    () => ({ ok: true, status: 200, json: async () => { throw new Error("never-render-upstream-secret"); } }),
  ]) {
    const u = ui(); await u.open(); fill(u); u.models(failure);
    u.change(u.checkbox().id, true); await u.advance(650);
    assert.equal(u.modelCalls().length, 1);
    assert.equal(u.get("bc-form").classList.contains("hidden"), false);
    assert.equal(u.get("bc-model").disabled, false);
    assert.equal(u.get("bc-save").disabled, false);
    assert.equal(u.get("bc-key").value, "synthetic-test-key");
    assert.ok(!u.get("bridge-config-panel").textContent.includes("never-render-upstream-secret"));
    assert.ok(!u.get("bridge-config-panel").innerHTML.includes("never-render-upstream-secret"));
    assert.equal(u.configPosts().length, 0);
    u.input("model", "manual-after-model-list-error");
    u.response(saved({ model: "manual-after-model-list-error" })); await u.submit();
    assert.equal(u.configPosts().length, 1);
    assert.equal(u.configPosts()[0].body.model, "manual-after-model-list-error");
    assert.equal(u.get("bc-key").value, "");
    assert.equal(u.get("bc-saved").classList.contains("hidden"), false);
  }
});

test("bridge models: explicit retry uses current credentials once, and controls prevent retry without consent", async () => {
  const u = ui(), pending = deferred(); let used = 0;
  await u.open({ useNew: async () => { used++; } }); fill(u);
  const checkbox = u.checkbox(), retry = u.get("bc-model-retry"); assert.ok(checkbox); assert.ok(retry);
  assert.equal(retry.disabled, true); await u.click("models-retry"); await u.advance(1000);
  assert.equal(u.modelCalls().length, 0);
  let attempt = 0;
  u.models(() => ++attempt === 1
    ? reply({ ok: false, code: "upstream_failed", message: "synthetic-secret-not-for-display" }, 502)
    : attempt === 2 ? pending.promise : reply({ ok: true, models: [{ id: "synthetic-retried-model" }], truncated: false }));
  u.change(checkbox.id, true);
  assert.equal(retry.disabled, true, "a queued auto-request cannot be doubled by retry");
  await u.advance(650);
  assert.equal(u.modelCalls().length, 1);
  assert.equal(retry.disabled, false);
  assert.match(u.get("bc-model-status").textContent, /重试|手填/);
  assert.ok(!u.get("bc-model-status").textContent.includes("synthetic-secret"));
  await u.click("models-retry"); await u.advance(0);
  assert.equal(u.modelCalls().length, 2);
  assert.deepEqual(u.modelCalls()[1].body, { endpoint: "https://api.example.com/v1", apiKey: "synthetic-test-key", consent: true });
  assert.equal(retry.disabled, true, "in-flight retries remain single-shot");
  await u.click("models-retry"); await u.advance(0); assert.equal(u.modelCalls().length, 2);
  pending.resolve(reply({ ok: true, models: [{ id: "synthetic-retried-model" }], truncated: false })); await u.flush();
  assert.equal(retry.disabled, false);
  assert.deepEqual(u.modelList().children.map((el) => el.value), ["synthetic-retried-model"]);
  u.input("model", "RETRIED");
  assert.deepEqual(u.modelList(true).children.map((el) => el.value), ["synthetic-retried-model"], "search filters the existing list without another request");
  u.input("model", "no-such");
  assert.deepEqual(u.modelList(true).children, [], "non-matching input hides suggestions but stays editable");
  assert.equal(u.get("bc-model").value, "no-such");
  assert.equal(u.modelCalls().length, 2);
  await u.click("models-retry"); await u.advance(0); assert.equal(u.modelCalls().length, 3);
  u.change(checkbox.id, false);
  assert.equal(retry.disabled, true); await u.click("models-retry"); await u.advance(1000);
  assert.equal(u.modelCalls().length, 3, "retry cannot bypass a revoked opt-in");
  assert.equal(u.configPosts().length, 0);
  assert.equal(u.calls.length, 4, "only configuration GET and model-list requests occur");
  assert.equal(used, 0);
  assert.equal(u.confirms.length, 0);
});

test("bridge models: empty or truncated lists retain manual entry, deduplicate IDs and bound suggestions", async () => {
  for (const data of [
    { ok: true, models: [], truncated: false },
    { ok: true, models: [{ id: "synthetic-listed-model" }], truncated: true },
    { ok: true, models: [{ id: "duplicate" }, { id: "duplicate" }, { id: "" }, null, { id: 42 }, { id: "comma,model" }, { id: "line\nbreak" }, { id: "x".repeat(201) }, { id: "also-valid" }], truncated: false },
    { ok: true, models: Array.from({ length: 505 }, (_, i) => ({ id: `synthetic-${i}` })), truncated: false },
  ]) {
    const u = ui(); await u.open(); fill(u); u.input("model", ""); u.models(() => reply(data));
    u.change(u.checkbox().id, true); await u.advance(650);
    const values = u.modelList().children.map((el) => el.value);
    assert.ok(values.length <= 500);
    assert.equal(new Set(values).size, values.length);
    assert.ok(values.every((id) => typeof id === "string" && id && id.length <= 200 && !/[,\u0000-\u001f\u007f]/.test(id)));
    if (!data.models.length) assert.match(u.get("bc-model-status").textContent, /清单为空.*手填/);
    if (data.truncated || data.models.length > 500) assert.match(u.get("bc-model-status").textContent, /500.*手填/);
    if (data.models.length === 9) assert.deepEqual(values, ["duplicate", "also-valid"]);
    assert.equal(u.get("bc-model").value, "", "empty/truncated lists never auto-select a model");
    assert.equal(u.get("bc-model").disabled, false);
    u.input("model", "manual-outside-the-list");
    u.response(saved({ model: "manual-outside-the-list" })); await u.submit();
    assert.equal(u.configPosts()[0].body.model, "manual-outside-the-list");
    assert.equal(u.modelCalls().length, 1);
    assert.equal(u.get("bc-key").value, "");
  }
});

test("bridge models: saved summary distinguishes list connectivity from model inference and never persists it across reopening", async () => {
  for (const discover of [false, true]) {
    const u = ui(); let used = 0;
    await u.open({ useNew: async () => { used++; } }); fill(u);
    if (discover) { u.change(u.checkbox().id, true); await u.advance(650); }
    assert.match(u.get("bc-save-note").textContent, /不调用远端模型.*不切换当前会话/);
    if (discover) assert.match(u.get("bc-save-note").textContent, /读取清单已连接服务.*尚未验证模型推理/);
    u.response(saved()); await u.submit();
    const status = u.get("bc-remote-state").textContent;
    assert.match(status, /(?:尚未验证模型推理|模型推理尚未验证)/);
    assert.equal(status.includes("读取清单已连接服务"), discover);
    assert.equal(u.get("bc-local-state").textContent, "本地已准备好", "local lifecycle readiness is independent of upstream inference");
    assert.equal(u.get("bc-key").value, "");
    assert.equal(u.modelCalls().length, discover ? 1 : 0);
    assert.equal(u.configPosts().length, 1);
    assert.equal(used, 0);
    assert.match(u.confirms[0], /模型推理.*尚未验证|尚未验证模型推理/);
    if (discover) assert.match(u.confirms[0], /读取清单已连接服务/);
    assert.equal(u.close(), true); await u.open({ useNew: async () => { used++; } });
    assert.equal(u.get("bc-remote-state").textContent, "模型推理尚未验证", "a past list request is not a persisted service/inference health check");
    await u.advance(1000);
    assert.equal(u.modelCalls().length, discover ? 1 : 0);
    assert.equal(used, 0);
  }
});

test("bridge models: edited key or origin aborts a previous request and late fetch/JSON cannot overwrite a newer list", async () => {
  for (const change of ["key", "origin"]) for (const lateAt of ["fetch", "json"]) {
    const u = ui(), pending = deferred(); await u.open(); fill(u);
    let attempt = 0;
    u.models(() => ++attempt === 1
      ? lateAt === "fetch" ? pending.promise : { ok: true, status: 200, json: () => pending.promise }
      : reply({ ok: true, models: [{ id: "current-only-model" }], truncated: false }));
    const checkbox = u.checkbox(); assert.ok(checkbox); u.change(checkbox.id, true);
    await u.advance(650);
    assert.equal(u.modelCalls().length, 1);
    const oldCall = u.modelCalls()[0]; assert.ok(oldCall.signal); assert.equal(oldCall.signal.aborted, false);
    if (change === "origin") {
      u.input("endpoint", "https://new-origin.example.com/v1");
      assert.equal(checkbox.checked, false); assert.equal(u.get("bc-key").value, "");
      u.input("key", "synthetic-second-key"); u.change(checkbox.id, true);
    } else u.input("key", "synthetic-second-key");
    assert.equal(oldCall.signal.aborted, true);
    u.input("model", "current-only");
    await u.advance(650);
    assert.equal(u.modelCalls().length, 2);
    assert.deepEqual(u.modelList().children.map((el) => el.value), ["current-only-model"]);
    const late = { ok: true, models: [{ id: "late-obsolete-model" }], truncated: true };
    pending.resolve(lateAt === "fetch" ? reply(late) : late);
    await u.flush(); await u.advance(1000);
    assert.deepEqual(u.modelList().children.map((el) => el.value), ["current-only-model"], `${change}/${lateAt}: stale results cannot repopulate suggestions`);
    assert.equal(u.get("bc-model").value, "current-only");
    assert.equal(u.get("bc-key").value, "synthetic-second-key");
    assert.equal(u.modelCalls().length, 2);
    assert.equal(u.configPosts().length, 0);
  }
});

test("bridge models: suggestion list supports arrow keys, Enter picks and Escape closes without submitting", async () => {
  const u = ui(); await u.open(); fill(u);
  u.models(() => reply({ ok: true, models: [{ id: "alpha-model" }, { id: "beta-model" }], truncated: false }));
  const checkbox = u.checkbox(); u.change(checkbox.id, true); await u.advance(650);
  const input = u.get("bc-model"), list = u.get("bc-model-list"), key = (k) => { let prevented = false; for (const fn of input.listeners.keydown || []) fn({ key: k, isComposing: false, preventDefault() { prevented = true; } }); return prevented; };
  input.value = ""; u.document.activeElement = input; for (const fn of input.listeners.focus || []) fn({});
  assert.deepEqual(list.children.map((el) => el.dataset.value), ["alpha-model", "beta-model"]);
  assert.equal(input.getAttribute("aria-expanded"), "true");
  assert.equal(key("Enter"), false, "Enter without a highlighted option is left to the form");
  key("ArrowDown"); key("ArrowDown");
  assert.equal(input.getAttribute("aria-activedescendant"), "bc-model-opt-1");
  assert.equal(key("Enter"), true);
  assert.equal(input.value, "beta-model");
  assert.ok(list.classList.contains("hidden"));
  for (const fn of input.listeners.focus || []) fn({});
  assert.equal(key("Escape"), true);
  assert.ok(list.classList.contains("hidden"));
  assert.equal(u.configPosts().length, 0);
});

test("bridge multiple models: add, default, edit, remove and save windows independently", async () => {
  const u = ui(); await u.open(); fill(u);
  u.models(() => reply({ ok: true, models: [{ id: "large-model", context_window: 1048576 }, { id: "small-model", context_window: 128000 }, { id: "unknown-model" }], truncated: false }));
  u.change(u.checkbox().id, true); await u.advance(650);
  u.input("model", "large-model"); assert.equal(u.get("bc-ctx").value, "1048576");
  await u.click("model-add");
  assert.equal(u.get("bc-model").value, "");
  u.input("model", "small-model"); assert.equal(u.get("bc-ctx").value, "128000");
  await u.click("model-add");
  u.input("model", "unknown-model"); assert.equal(u.get("bc-ctx").value, "200000");
  await u.click("model-add");
  assert.equal(u.get("bc-selected").children.length, 3);
  await u.modelAction("model-default", "small-model");
  await u.modelAction("model-edit", "large-model"); u.input("ctx", "512k");
  await u.click("model-add");
  assert.equal(u.get("bc-selected").children.length, 3, "editing an existing model does not duplicate it");
  await u.modelAction("model-remove", "unknown-model");
  assert.equal(u.get("bc-selected").children.length, 2);
  u.response(saved({ model: "small-model", contextWindow: 128000, models: [{ id: "large-model", contextWindow: 512000 }, { id: "small-model", contextWindow: 128000 }] }));
  await u.submit();
  assert.deepEqual(u.configPosts()[0].body.models, [{ id: "large-model", contextWindow: 512000 }, { id: "small-model", contextWindow: 128000 }]);
  assert.equal(u.configPosts()[0].body.model, "small-model");
  assert.equal(u.modelCalls().length, 1, "selection and model editing never refetch");
  assert.equal(u.get("bc-saved-models").children.length, 2);
  await u.click("edit");
  assert.equal(u.get("bc-selected").children.length, 2, "all saved models survive reopening editor");
});

test("bridge multiple models: adding keeps the loaded suggestions available while input stays focused", async () => {
  const u = ui(); await u.open(); fill(u);
  u.models(() => reply({ ok: true, models: [{ id: "first-model", context_window: 1048576 }, { id: "second-model", context_window: 128000 }], truncated: false }));
  u.change(u.checkbox().id, true); await u.advance(650);
  const input = u.get("bc-model"), list = u.get("bc-model-list");
  u.document.activeElement = input;
  const key = (value) => { for (const fn of input.listeners.keydown || []) fn({ key: value, isComposing: false, preventDefault() {} }); };
  u.input("model", "first-model"); key("ArrowDown"); key("Enter");
  assert.equal(input.value, "first-model"); assert.equal(u.get("bc-ctx").value, "1048576");
  await u.click("model-add");
  assert.equal(input.value, ""); assert.equal(u.document.activeElement, input);
  // 不用 modelList()：它会人为触发新的 focus，从而掩盖“输入框一直有焦点”的真实操作。
  assert.equal(input.getAttribute("aria-expanded"), "true");
  assert.deepEqual(list.children.map((li) => li.dataset.value), ["first-model", "second-model"]);
  key("ArrowDown"); key("ArrowDown"); key("Enter");
  assert.equal(input.value, "second-model"); assert.equal(u.get("bc-ctx").value, "128000");
  await u.click("model-add");
  assert.equal(u.get("bc-selected").children.length, 2);
  assert.equal(list.classList.contains("hidden"), false);
  assert.equal(u.modelCalls().length, 1, "continuing to pick uses the same loaded list");
});

test("bridge multiple models: clicking a focused input reopens suggestions after a pick or Escape", async () => {
  const u = ui(); await u.open(); fill(u);
  u.models(() => reply({ ok: true, models: [{ id: "first-model" }, { id: "second-model" }], truncated: false }));
  u.change(u.checkbox().id, true); await u.advance(650);
  const input = u.get("bc-model"), list = u.get("bc-model-list");
  u.pickModel("first-model");
  assert.equal(list.classList.contains("hidden"), true); assert.equal(u.document.activeElement, input);
  for (const fn of input.listeners.click || []) fn({ target: input });
  assert.equal(list.classList.contains("hidden"), false);
  for (const fn of input.listeners.keydown || []) fn({ key: "Escape", preventDefault() {} });
  assert.equal(list.classList.contains("hidden"), true);
  for (const fn of input.listeners.click || []) fn({ target: input });
  assert.equal(list.classList.contains("hidden"), false);
  assert.equal(u.modelCalls().length, 1);
});

test("bridge multiple models: buttons retain an open list's focus until their click finishes", async () => {
  const u = ui(); await u.open(); fill(u);
  u.models(() => reply({ ok: true, models: [{ id: "first-model" }, { id: "second-model" }], truncated: false }));
  u.change(u.checkbox().id, true); await u.advance(650);
  const input = u.get("bc-model");
  u.document.activeElement = input; u.input("model", "");
  for (const fn of input.listeners.focus || []) fn({});
  assert.equal(u.pointerButton("bc-action-edit"), true, "closing an open in-flow list must not move the button mid-click");
  assert.equal(u.pointerButton("bc-save"), true);
  for (const fn of input.listeners.blur || []) fn({});
  assert.equal(u.pointerButton("bc-action-edit"), false, "closed lists do not override unrelated button focus");
  assert.equal(u.pointerButton("bc-model-add"), true, "adding preserves same-input continuation even with suggestions already closed");
  u.document.activeElement = u.get("bc-ctx");
  assert.equal(u.pointerButton("bc-save"), false);
});

test("bridge windows: exact model metadata fills late, no metadata falls back to200000, manual edit wins", async () => {
  const u = ui(), pending = deferred(); await u.open(); fill(u);
  u.input("model", "large-model"); assert.equal(u.get("bc-ctx").value, "200000");
  u.models(() => pending.promise); u.change(u.checkbox().id, true); await u.advance(650);
  pending.resolve(reply({ ok: true, models: [{ id: "large-model", context_window: 1048576 }, { id: "other" }, { id: "invalid", context_window: "1000000" }], truncated: false }));
  await u.flush(); assert.equal(u.get("bc-ctx").value, "1048576");
  u.input("ctx", "256k"); await u.click("models-retry"); await u.advance(0);
  assert.equal(u.get("bc-ctx").value, "256k", "late/retried metadata must not overwrite user input");
  u.input("model", "other"); assert.equal(u.get("bc-ctx").value, "200000");
  u.input("model", "invalid"); assert.equal(u.get("bc-ctx").value, "200000");
  u.input("model", "manual-unlisted"); assert.equal(u.get("bc-ctx").value, "200000");
  u.pickModel("large-model"); assert.equal(u.get("bc-ctx").value, "1048576");
  assert.equal(u.configPosts().length, 0);
});

for (const [field, value] of [["key", "replacement-synthetic-key"], ["endpoint", "https://api.example.com/private/chat/completions"]]) test(`bridge windows: reopening and changing only ${field} preserves every saved window and default`, async () => {
  const models = [{ id: "synthetic-model", contextWindow: 512000 }, { id: "second", contextWindow: 128000 }];
  const u = ui(saved({ models, contextWindow: 512000 })); await u.open();
  for (let i = 0; i < 2; i++) {
    await u.click("edit");
    u.input(field, value);
    assert.equal(u.get("bc-ctx").value, "512000");
    u.response(saved({ models, contextWindow: 512000, endpoint: field === "endpoint" ? value : "https://api.example.com/v1" }));
    await u.submit();
    assert.deepEqual(u.configPosts()[i].body.models, models);
    assert.equal(u.configPosts()[i].body.model, "synthetic-model");
  }
  assert.equal(u.modelCalls().length, 0, "credential/path edits do not require discovery to preserve saved windows");
});

test("bridge windows: reopened explicit windows survive delayed discovery while new models still use metadata", async () => {
  const models = [{ id: "synthetic-model", contextWindow: 512000 }, { id: "second", contextWindow: 128000 }];
  const u = ui(saved({ models, contextWindow: 512000 })), pending = deferred();
  await u.open(); await u.click("edit");
  u.models(() => pending.promise); u.change(u.checkbox().id, true); await u.advance(650);
  pending.resolve(reply({ ok: true, models: [{ id: "synthetic-model", context_window: 1048576 }, { id: "second" }, { id: "new-model", context_window: 256000 }], truncated: false }));
  await u.flush();
  assert.equal(u.get("bc-ctx").value, "512000");
  u.input("model", "new-model"); assert.equal(u.get("bc-ctx").value, "256000");
  await u.click("model-add");
  const expected = [...models, { id: "new-model", contextWindow: 256000 }];
  u.response(saved({ models: expected, contextWindow: 512000 })); await u.submit();
  assert.deepEqual(u.configPosts()[0].body.models, expected);
  assert.equal(u.configPosts()[0].body.model, "synthetic-model");
});

for (const selection of ["suggestion", "typing"]) test(`bridge windows: ${selection} of an added manual model restores and preserves its own window`, async () => {
  const u = ui(); await u.open(); fill(u);
  u.models(() => reply({ ok: true, models: [{ id: "large-model", context_window: 1048576 }, { id: "small-model", context_window: 128000 }], truncated: false }));
  u.change(u.checkbox().id, true); await u.advance(650);
  u.input("model", "large-model"); u.input("ctx", "512k"); await u.click("model-add");
  u.input("model", "small-model"); assert.equal(u.get("bc-ctx").value, "128000");
  if (selection === "suggestion") u.pickModel("large-model");
  else u.input("model", "large-model");
  assert.equal(u.get("bc-model").value, "large-model");
  assert.equal(u.get("bc-ctx").value, "512000");
  await u.click("models-retry"); await u.advance(0);
  assert.equal(u.get("bc-ctx").value, "512000", "selecting an existing model must retain its manual precedence");
  const models = [{ id: "large-model", contextWindow: 512000 }];
  u.response(saved({ model: "large-model", models, contextWindow: 512000 })); await u.submit();
  assert.deepEqual(u.configPosts()[0].body.models, models);
});

test("bridge multiple models: remove default chooses a remaining model, clear-all requires another model", async () => {
  const u = ui(saved({ models: [{ id: "synthetic-model", contextWindow: 1048576 }, { id: "second", contextWindow: 200000 }] }));
  await u.open(); await u.click("edit");
  await u.modelAction("model-remove", "synthetic-model");
  assert.match(u.get("bc-selected").textContent, /second.*默认模型/);
  await u.modelAction("model-remove", "second");
  await u.submit();
  assert.equal(u.configPosts().length, 0);
  assert.equal(u.get("bc-model").getAttribute("aria-invalid"), "true");
});
