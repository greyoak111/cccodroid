#!/usr/bin/env node
// Optional browser acceptance: node scripts/test-managed-ui.mjs
// Uses installed chromium-headless (or CHROMIUM_BIN) and Node's built-in WebSocket; no npm dependencies.
// All APIs/SSE are synthetic. Never starts/imports the gateway, sends /api/chat, or loads user configuration.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { startManagedUiServer, REMOVAL_ERROR, CONFIG_ERROR, FAKE_OLD_KEY, FAKE_NEW_KEY, SESSION_A, SESSION_B } from "../gateway/tests/fixtures/managed-ui-server.mjs";

// Fixed contract, independently checked against the real dispatcher and frontend source (never import gateway).
const CONFIG_ROUTE = "/api/components/openai-bridge/config";
const MODELS_ROUTE = "/api/components/openai-bridge/models";
const REPAIR_ROUTE = "/api/components/openai-bridge/repair";
const routeSource = await fs.readFile(new URL("../gateway/gw/components.mjs", import.meta.url), "utf8");
const configSource = await fs.readFile(new URL("../gateway/web/app/bridge-config.js", import.meta.url), "utf8");
assert.ok(routeSource.includes('p === "' + CONFIG_ROUTE + '"'), "real gateway dispatcher exposes the fixed configuration route");
assert.match(configSource, /const\s+API\s*=\s*"\/api\/components\/openai-bridge\/config"\s*[,;]/, "frontend must target the real gateway route, not a self-consistent mock alias");
assert.ok(routeSource.includes('p === "' + MODELS_ROUTE + '"'), "real gateway exposes the fixed model-list route");
assert.ok(configSource.includes('"' + MODELS_ROUTE + '"'), "model list must use the actual gateway route");
assert.ok(routeSource.includes('p === "' + REPAIR_ROUTE + '"') && configSource.includes('"' + REPAIR_ROUTE + '"'), "repair UI must use the fixed authenticated component route");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, timeout = 8000) {
  const end = Date.now() + timeout;
  let value;
  while (Date.now() < end) { value = await fn(); if (value) return value; await sleep(40); }
  throw new Error(`Timeout: ${label}; last value: ${JSON.stringify(value)}`);
}
class CDP {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map(); this.handlers = new Map();
    ws.addEventListener("message", ({ data }) => {
      const m = JSON.parse(data);
      if (m.id) {
        const p = this.pending.get(m.id); if (!p) return;
        this.pending.delete(m.id); clearTimeout(p.timer);
        m.error ? p.reject(new Error(`${p.method}: ${m.error.message}`)) : p.resolve(m.result);
      } else for (const fn of this.handlers.get(m.method) || []) fn(m.params);
    });
    ws.addEventListener("close", () => {
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("Chromium CDP closed")); }
      this.pending.clear();
    });
  }
  on(method, fn) { const list = this.handlers.get(method) || []; list.push(fn); this.handlers.set(method, list); }
  call(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
      this.pending.set(id, { resolve, reject, timer, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  }
}

const base = process.env.TMPDIR || path.join(os.homedir(), ".cache");
await fs.mkdir(base, { recursive: true });
const lock = path.join(base, "cccodroid-managed-ui-chromium.lock");
try { await fs.mkdir(lock); }
catch (e) { if (e.code === "EEXIST") throw new Error(`Another managed UI Chromium test holds ${lock}; run only one browser at a time.`); throw e; }
// Chromium's Unix singleton socket has a 108-byte pathname limit (Android's prefix is already long).
const tmp = await fs.mkdtemp(path.join(base, "ui-"));
let fixture, browser, cdp, launchError, stderr = "";
const errors = [], blocked = [], results = [];
const ok = (name, detail) => { results.push({ name, detail }); console.log(`PASS ${name}${detail ? " — " + detail : ""}`); };
const q = JSON.stringify;
try {
  fixture = await startManagedUiServer();
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CCAPP_")));
  const profile = path.join(tmp, "profile");
  browser = spawn(process.env.CHROMIUM_BIN || "chromium-headless", [
    "--headless=new", "--disable-gpu", "--disable-dev-shm-usage",
    "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update",
    "--disable-sync", "--disable-default-apps", "--disable-extensions", "--no-proxy-server", "--metrics-recording-only",
    "--disable-domain-reliability", "--disable-client-side-phishing-detection", "--password-store=basic", "--use-mock-keychain",
    "--disable-features=Translate,MediaRouter,OptimizationHints,OptimizationGuideModelDownloading,AutofillServerCommunication",
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1", "--renderer-process-limit=1", "--window-size=1280,900", "about:blank",
  ], { env: { ...clean, HOME: tmp, TMPDIR: tmp }, stdio: ["ignore", "ignore", "pipe"], detached: true });
  browser.on("error", (e) => { launchError = e; });
  browser.stderr.on("data", (b) => { stderr = (stderr + b).slice(-6000); });
  const portFile = path.join(profile, "DevToolsActivePort");
  const port = await until(async () => {
    if (launchError) throw launchError;
    if (browser.exitCode !== null) throw new Error(`Chromium exited (${browser.exitCode}): ${stderr}`);
    try { return Number((await fs.readFile(portFile, "utf8")).split("\n")[0]); } catch { return false; }
  }, "Chromium CDP startup", 12000);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find((t) => t.type === "page");
  assert.ok(target, "Chromium created one blank page");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await once(ws, "open");
  cdp = new CDP(ws);
  cdp.on("Runtime.exceptionThrown", ({ exceptionDetails: d }) => errors.push(d.exception?.description || d.text));
  cdp.on("Runtime.consoleAPICalled", ({ type, args }) => { if (type === "error") errors.push(args.map((a) => a.description || a.value || "").join(" ")); });
  cdp.on("Fetch.requestPaused", ({ requestId, request }) => {
    const u = new URL(request.url);
    if (u.origin === fixture.origin || ["data:", "blob:"].includes(u.protocol)) cdp.call("Fetch.continueRequest", { requestId }).catch(() => {});
    else { blocked.push(request.url); cdp.call("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }).catch(() => {}); }
  });
  cdp.on("Page.javascriptDialogOpening", () => { cdp.call("Page.handleJavaScriptDialog", { accept: true }).catch(() => {}); });
  await cdp.call("Runtime.enable");
  await cdp.call("Page.enable");
  await cdp.call("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
  await cdp.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.call("Page.addScriptToEvaluateOnNewDocument", { source: `
    window.__fixtureErrors = [];
    addEventListener('error', e => __fixtureErrors.push(e.message));
    addEventListener('unhandledrejection', e => __fixtureErrors.push(String(e.reason?.message || e.reason)));
    localStorage.setItem('ccapp.lang', 'en');
    localStorage.setItem('cc.navMore', '1');
    localStorage.setItem('cc.motion', 'auto');
  ` });
  const visible = (sel) => `(() => { const e = document.querySelector(${q(sel)}); return !!(e && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden'); })()`;
  const click = async (sel) => {
    assert.ok(await cdp.eval(`(() => { const e = document.querySelector(${q(sel)}); if (!e || !e.getClientRects().length) return false; e.scrollIntoView({ block: 'nearest', inline: 'nearest' }); return true; })()`), `Visible control exists: ${sel}`);
    let previous = null, stable = 0;
    const point = await until(async () => {
      const p = await cdp.eval(`(() => { const e = document.querySelector(${q(sel)}); if (!e || !e.getClientRects().length || e.disabled) return false; const r = e.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2, hit = document.elementFromPoint(x, y); return hit && e.contains(hit) ? { x, y } : false; })()`);
      stable = p && previous && Math.hypot(p.x - previous.x, p.y - previous.y) < 0.3 ? stable + 1 : 0;
      previous = p;
      return stable >= 3 ? p : false;
    }, `stable clickable control ${sel}`);
    await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
    await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
    await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
  };
  const key = async (name) => { const keyCode = { Backspace: 8, Tab: 9, Enter: 13, Escape: 27 }[name]; await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key: name, code: name, windowsVirtualKeyCode: keyCode }); await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", key: name, code: name, windowsVirtualKeyCode: keyCode }); };
  const fill = async (sel, value) => {
    await click(sel);
    await cdp.eval(`(() => { const e = document.querySelector(${q(sel)}); e.select(); })()`);
    if (value) await cdp.call("Input.insertText", { text: value });
    else { await key("Backspace"); }
    await cdp.eval(`document.querySelector(${q(sel)}).dispatchEvent(new Event('change', { bubbles: true }))`);
  };
  const openExt = async () => {
    await cdp.eval(`window.__cc.openPage('ext')`);
    await until(() => cdp.eval(visible("#comp-list .ccard")), "synthetic component card");
  };
  const refreshComponents = async () => {
    const n = fixture.state.requests.filter((r) => r.path === "/api/components").length;
    await click("#comp-check");
    await until(() => fixture.state.requests.filter((r) => r.path === "/api/components").length > n, "component refresh request");
    await sleep(100);
  };
  await cdp.call("Page.navigate", { url: fixture.origin + "/?lang=en" });
  await until(() => cdp.eval("!!(window.__cc && __cc.srv.connected && __cc.state.settings && __cc.state.sessions.length === 2)"), "synthetic app boot");
  ok("isolated boot", `Chromium ${await cdp.eval("navigator.userAgent.match(/Chrome\\/([\\d.]+)/)?.[1]")}; in-memory APIs/SSE only`);

  // Real controls, desktop and narrow viewport. No screenshot or repeated rendering loop.
  await click("#btn-plus");
  await until(() => cdp.eval(visible("#sheet")), "desktop plus menu");
  await key("Escape");
  await until(() => cdp.eval("document.querySelector('#sheet').classList.contains('hidden')"), "desktop plus menu closes");
  await click("#side-acct");
  await until(() => cdp.eval(visible(".pop-menu")), "account menu");
  await key("Escape");
  await sleep(250);
  assert.equal(await cdp.eval("document.querySelectorAll('.pop-menu').length"), 0, "Esc removes account menu");
  ok("desktop menus", "plus/account open and Escape close");
  await cdp.eval("__cc.openPage('settings')");
  await until(() => cdp.eval(visible("#set-ov")), "desktop settings modal");
  await click('#set-cats button[data-cat="general"]');
  await key("Tab");
  assert.ok(await cdp.eval("document.querySelector('#set-ov').contains(document.activeElement)"), "settings retains keyboard focus");
  await key("Escape");
  await until(() => cdp.eval("document.querySelector('#set-ov').classList.contains('hidden')"), "desktop settings closes");
  ok("desktop settings", "category selection; keyboard focus stays in modal; Escape closes");

  await openExt();
  fixture.resetComponent({ state: "removing" });
  await refreshComponents();
  const removing = await cdp.eval(`(() => { const c = document.querySelector('#comp-list .ccard'); return { text: c.innerText, actions: c.querySelectorAll('button[data-c]').length, badge: c.querySelector('.sdot')?.innerText }; })()`);
  assert.notEqual(removing.badge?.trim().toLowerCase(), "removing", "backend state must not leak verbatim");
  assert.match(removing.badge, /remov|uninstall|卸载/i, "removal has a human-readable badge");
  assert.match(removing.text, /cannot|can't|can’t|不可|不能/i, "removal explicitly cannot be canceled");
  assert.equal(removing.actions, 0, "removing card exposes no install/remove/cancel action");
  fixture.resetComponent({ state: "removing", unsupported: true, needs: { gpu: "adreno" } });
  await refreshComponents();
  assert.match(await cdp.eval("document.querySelector('#comp-list .ccard .cc-btns').innerText"), /cannot|can't|can’t|不可|不能/i, "unsupported capability cannot mask removal state");
  assert.equal(await cdp.eval("document.querySelector('#comp-list .ccard').classList.contains('dim')"), false);
  ok("server removing state", "localized badge; non-cancelable hint; no actions; GPU warning cannot mask removal");

  fixture.resetComponent({ unsupported: false, needs: null }); fixture.state.removalMode = "held";
  await refreshComponents();
  await click('#comp-list button[data-c="remove"]');
  await until(() => fixture.state.removeCount === 1, "held remove request");
  // A refresh returning stale 'ok' must not re-enable removal while the POST is pending.
  await refreshComponents();
  const pending = await cdp.eval(`(() => { const c = document.querySelector('#comp-list .ccard'); return { text: c.innerText, enabled: [...c.querySelectorAll('button[data-c]')].filter(b => !b.disabled).length }; })()`);
  assert.equal(pending.enabled, 0, "pending remove cannot be submitted again after stale list refresh");
  assert.match(pending.text, /cannot|can't|can’t|不可|不能/i, "pending remove explains non-cancellation");
  assert.equal(fixture.state.removeCount, 1);
  fixture.finishRemoval("failure");
  await until(() => cdp.eval(`document.querySelector('#toast').innerText.includes(${q(REMOVAL_ERROR)})`), "backend removal error toast visible");
  await until(() => cdp.eval(`document.querySelector('#comp-list').innerText.includes(${q(REMOVAL_ERROR)})`), "backend removal error visible");
  assert.equal(await cdp.eval("document.querySelector('#comp-list fixture') !== null"), false, "backend error is escaped");
  await until(() => cdp.eval(visible('#comp-list button[data-c="remove"]')), "retry available after failure");
  ok("pending removal lock and backend failure", "stale ok refresh cannot duplicate; backend message shown verbatim as text");

  fixture.resetComponent(); fixture.state.removalMode = "http-error";
  await refreshComponents();
  await cdp.eval("document.querySelector('#toast').textContent = ''");
  await click('#comp-list button[data-c="remove"]');
  await until(() => fixture.state.removeCount === 2, "HTTP failure removal");
  await until(() => cdp.eval(`document.querySelector('#toast').innerText.includes(${q(REMOVAL_ERROR)})`), "HTTP 409 backend message in toast");
  await until(() => cdp.eval(visible('#comp-list button[data-c="remove"]')), "HTTP failure releases removal lock");
  assert.equal(await cdp.eval(`document.querySelector('#comp-list').innerText.includes(${q(REMOVAL_ERROR)})`), false, "HTTP test error comes from POST, not a persisted card error");
  ok("HTTP error response", "409 POST backend message survives UI error path without a persisted list error");

  fixture.resetComponent(); fixture.state.removalMode = "held";
  await refreshComponents();
  await click('#comp-list button[data-c="remove"]');
  await until(() => fixture.state.removeCount === 3, "successful held removal");
  fixture.finishRemoval("success");
  await until(() => cdp.eval(visible('#comp-list button[data-c="install"]')), "absent after removal");
  assert.equal(await cdp.eval("!!document.querySelector('#comp-list button[data-c=remove]')"), false);
  ok("successful removal", "card becomes absent with install action");

  // DESIGN.zh-CN.md: the actual integration target is the three-field bridge configuration, not motion.
  fixture.resetComponent();
  await openExt();
  await refreshComponents();
  const configure = '#comp-list button[data-c="configure"][data-id="openai-bridge"]';
  fixture.resetComponent({ state: "absent", installedVersion: "" });
  await refreshComponents();
  assert.equal(await cdp.eval(`!!document.querySelector(${q(configure)})`), false, "absent component has no configure action");
  fixture.resetComponent();
  await refreshComponents();
  assert.ok(await cdp.eval(`(() => { const a = document.querySelector(${q(configure)}), b = document.querySelector('#comp-list button[data-c="remove"]'); return !!(a && b && a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING && a.getBoundingClientRect().x < b.getBoundingClientRect().x); })()`), "configuration entry precedes uninstall on original card");
  await cdp.eval(`__cc.openSession(${q(SESSION_A)})`);
  await until(() => cdp.eval(`__cc.view.sessionId === ${q(SESSION_A)} && __cc.view.histOk`), "existing session before configuration");
  await openExt();
  await until(() => cdp.eval("!!__cc.state.providerActive"), "provider snapshot loaded before config");
  const beforeConfig = await cdp.eval("({ session: __cc.view.sessionId, provider: __cc.state.providerActive, model: __cc.state.model, count: __cc.state.sessions.length })");
  const configOpen = async (saved = false) => {
    await click(configure);
    await until(() => cdp.eval(visible(saved ? "#bc-saved" : "#bc-form")), saved ? "saved configuration shown" : "bridge form shown");
    assert.equal(await cdp.eval("document.querySelector('#set-ov').classList.contains('hidden')"), true, "configuration does not route to Settings");
    assert.equal(await cdp.eval("document.querySelector('#tab-ext').classList.contains('hidden')"), false, "configuration remains in Extensions");
  };
  const configClose = async () => {
    await click('#bridge-config-panel [data-bc="back"]');
    await until(() => cdp.eval("!document.querySelector('#tab-ext').classList.contains('bridge-config-open')"), "return to Extensions card");
  };
  const unchanged = async () => {
    assert.deepEqual(await cdp.eval("({ session: __cc.view.sessionId, provider: __cc.state.providerActive, model: __cc.state.model, count: __cc.state.sessions.length })"), beforeConfig, "configuration does not switch existing session/provider/model");
    assert.equal(fixture.state.providerActive, "synthetic");
    assert.equal(fixture.state.sessionModelWrites.length, 0, "save does not change session selection");
    assert.equal(fixture.state.requests.filter((r) => r.path === "/api/chat" || r.path === "/api/providers/test").length, 0, "save does not test a remote or send chat");
  };
  await configOpen(true);
  await click('#bridge-config-panel [data-bc="edit"]');
  await until(() => cdp.eval(visible("#bc-form")), "edit old configuration");
  const existing = await cdp.eval("({ key: document.querySelector('#bc-key').value, type: document.querySelector('#bc-key').type, count: document.querySelectorAll('#bc-form input:not([type=checkbox])').length, active: document.activeElement?.id, hint: document.querySelector('#bc-key-hint').innerText })");
  assert.equal(existing.key, "", "old API key never returns to input");
  assert.equal(existing.type, "password");
  assert.equal(existing.count, 4, "endpoint/key/model plus per-model context input are shown");
  assert.notEqual(existing.active, "bc-key", "opening configuration does not automatically focus key input");
  assert.match(existing.hint, /blank|unchanged|留空|保持/i);
  assert.equal(fixture.state.configResponses.some((s) => s.includes(FAKE_OLD_KEY)), false, "GET response excludes old key");
  assert.equal(await cdp.eval(`document.documentElement.outerHTML.includes(${q(FAKE_OLD_KEY)})`), false, "old key not present in page DOM");
  ok("bridge config entry and existing key privacy", "original card, Configure left of Uninstall, per-model window editor in Extensions, old key absent/masked");

  // Invalid API paths/credentials/model must not reach any POST or remote inference endpoint.
  const initialSaves = fixture.state.configRequests.length;
  for (const endpoint of ["http://bad.synthetic.invalid/v1", "https://user:pass@bad.synthetic.invalid/v1", "https://bad.synthetic.invalid/v1?key=hidden", "https://bad.synthetic.invalid/responses", "https://bad.synthetic.invalid/private"]) {
    await fill("#bc-endpoint", endpoint);
    await click("#bc-save");
    assert.equal(await cdp.eval("document.querySelector('#bc-endpoint').getAttribute('aria-invalid')"), "true", `reject unsafe/ambiguous endpoint ${endpoint}`);
    assert.equal(fixture.state.configRequests.length, initialSaves, "invalid form does not POST");
  }
  await fill("#bc-endpoint", "https://changed.synthetic.invalid/v1");
  await click("#bc-save");
  assert.equal(await cdp.eval("document.querySelector('#bc-key').getAttribute('aria-invalid')"), "true", "changed origin requires a replacement key");
  await fill("#bc-key", "synthetic key with spaces");
  await click("#bc-save");
  assert.equal(await cdp.eval("document.querySelector('#bc-key').getAttribute('aria-invalid')"), "true", "key whitespace rejected");
  await fill("#bc-key", FAKE_NEW_KEY);
  await click('#bridge-config-panel [data-bc="eye"]');
  assert.equal(await cdp.eval("document.querySelector('#bc-key').type"), "text");
  await cdp.eval("dispatchEvent(new Event('blur'))");
  assert.equal(await cdp.eval("document.querySelector('#bc-key').type"), "password", "key hides on page blur");
  await fill("#bc-model", "invalid,model");
  await click("#bc-save");
  assert.equal(await cdp.eval("document.querySelector('#bc-model').getAttribute('aria-invalid')"), "true", "invalid model rejected");
  assert.equal(fixture.state.configRequests.length, initialSaves);
  await unchanged();
  ok("bridge form validation", "unsafe/ambiguous endpoints, changed-origin missing key, spaced key and comma model rejected locally");

  // Save an edit without resending a secret to the same origin, with a deliberately slow local-only response.
  await fill("#bc-endpoint", "https://old.synthetic.invalid/v1");
  await fill("#bc-key", "");
  await fill("#bc-model", "synthetic-edited-model");
  fixture.state.configDelay = 400;
  await click("#bc-save");
  await until(() => fixture.state.configRequests.length === initialSaves + 1, "synthetic configuration POST");
  assert.equal(await cdp.eval("document.querySelector('#bridge-config-panel').getAttribute('aria-busy')"), "true");
  assert.equal(await cdp.eval("[...document.querySelectorAll('#bridge-config-panel input, #bridge-config-panel button')].every(e => e.disabled)"), true, "save disables duplicate actions and navigation");
  await until(() => cdp.eval(visible("#bc-saved")), "configuration save succeeds");
  fixture.state.configDelay = 0;
  assert.equal(Object.hasOwn(fixture.state.configRequests.at(-1), "apiKey"), false, "blank key omits replacement secret");
  assert.equal(fixture.state.config.apiKey, FAKE_OLD_KEY, "same-origin blank key retains old secret only on server");
  assert.match(await cdp.eval("document.querySelector('#bc-saved').innerText"), /not (?:been )?tested|未测试|未验证/i);
  assert.equal(await cdp.eval("document.querySelector('#bc-key').value"), "");
  await unchanged();
  ok("bridge local-only save and unchanged session", "blank key retained server-side, duplicate controls disabled, remote untested, existing session unchanged");

  await click('#bridge-config-panel [data-bc="edit"]');
  await fill("#bc-model", "synthetic-not-ready-model");
  fixture.state.configMode = "not-ready";
  await click("#bc-save");
  await until(() => cdp.eval(visible("#bc-saved")), "saved but local bridge not ready");
  assert.match(await cdp.eval("document.querySelector('#bc-local-state').innerText"), /not ready|isn't ready|isn’t ready|尚未就绪/i);
  assert.equal(await cdp.eval("document.querySelector('#bc-use').disabled"), true, "local startup failure cannot create usable session");
  await unchanged();
  ok("bridge saved versus local readiness", "not-ready is explicit and new-session action disabled; remote remains untested");

  fixture.state.configMode = "success";
  fixture.state.config.localError = "RECOVERY_EXHAUSTED";
  fixture.state.config.local = { state: "ready" }; // 故意让残存服务健康，锁仍必须优先阻断。
  await configClose(); await configOpen(true);
  const recoveryNotice = await cdp.eval("document.querySelector('#bc-notice').innerText");
  assert.match(recoveryNotice, /恢复|recovery/i);
  assert.match(recoveryNotice, /修改配置不会解除|configuration.*(?:not|won't|won’t).*clear/i);
  assert.equal(await cdp.eval("document.querySelector('#bc-use').disabled"), true);
  for (let i = 0; i < 3; i++) {
    await click('#bridge-config-panel [data-bc="edit"]'); await click("#bc-save");
    await until(() => cdp.eval(visible("#bc-saved")), "recovery-locked save stays configured");
    assert.equal(await cdp.eval("document.querySelector('#bc-notice').innerText"), recoveryNotice);
    assert.equal(await cdp.eval("document.querySelector('#bc-use').disabled"), true);
    await unchanged();
  }
  delete fixture.state.config.localError;
  ok("bridge recovery fault read and repeated saves", "residual health never overrides fault; three saves keep diagnosis and disable use; no reset operation");

  for (const code of ["RECOVERY_EXHAUSTED", "PATCH_VERIFICATION_FAILED", "COMPONENT_DISABLED", "COMPONENT_UNAVAILABLE", "UPDATE_REQUIRED", "LOCAL_START_FAILED", "provider_save_failed"]) {
    await configClose(); fixture.state.configMode = "success"; await configOpen(true);
    assert.equal(await cdp.eval("document.querySelector('#bc-service-state').innerText"), await cdp.eval("I18N.t('已就绪')"));
    await click('#bridge-config-panel [data-bc="edit"]');
    fixture.state.configMode = code === "provider_save_failed" ? "provider-save-error" : "save-fault:" + code;
    const n = fixture.state.configRequests.length;
    await click("#bc-save"); await until(() => fixture.state.configRequests.length === n + 1, "failed save POST");
    await until(() => cdp.eval("document.querySelector('#bc-save').disabled === false"), "failed save unlocks");
    assert.equal(await cdp.eval("document.querySelector('#bc-service-state').innerText"), await cdp.eval("I18N.t(" + q(code === "provider_save_failed" ? "未确认" : "不可用于新会话") + ")"));
    assert.equal(await cdp.eval("document.querySelector('#bc-config-state').innerText"), await cdp.eval("I18N.t('未确认')"));
    assert.equal(await cdp.eval("document.querySelector('#bc-use').disabled"), true);
    assert.equal(await cdp.eval(visible("#bc-form")), true);
    assert.equal(await cdp.eval(`document.querySelector('#bridge-config-panel').innerText.includes(${q(CONFIG_ERROR)})`), false);
    await unchanged();
  }
  fixture.state.configMode = "success"; await configClose(); await configOpen(true);
  ok("bridge failed save invalidates old readiness", "healthy GET then six local faults/partial provider-save failure never retains ready; draft remains, no reset or new-session action");

  await click('#bridge-config-panel [data-bc="edit"]');
  await fill("#bc-model", "synthetic-retry-model");
  for (const mode of ["http-error", "busy", "field-error"]) {
    fixture.state.configMode = mode;
    const n = fixture.state.configRequests.length;
    await click("#bc-save");
    await until(() => fixture.state.configRequests.length === n + 1, `synthetic ${mode} POST`);
    await until(() => cdp.eval("document.querySelector('#bc-save').disabled === false"), `save unlock after ${mode}`);
    assert.equal(await cdp.eval(visible("#bc-form")), true, "error retains form");
    assert.equal(await cdp.eval("document.querySelector('#bc-model').value"), "synthetic-retry-model", "error retains typed model");
    assert.ok(await cdp.eval("document.querySelector('#bc-notice').innerText.length > 0"), "error explained inline");
    assert.equal(await cdp.eval(`document.querySelector('#bridge-config-panel').innerText.includes(${q(CONFIG_ERROR)})`), false, "untrusted backend diagnostics are not echoed into configuration UI");
    if (mode === "field-error") assert.equal(await cdp.eval("document.querySelector('#bc-model').getAttribute('aria-invalid')"), "true");
    await unchanged();
  }
  await configClose();
  fixture.state.configMode = "get-error";
  await click(configure);
  await until(() => cdp.eval(visible("#bc-issue")), "configuration read failure card");
  assert.equal(await cdp.eval(visible("#bc-form")), false);
  assert.equal(await cdp.eval("document.querySelector('#bc-service-state').innerText"), await cdp.eval("I18N.t('未确认')"));
  await configClose();
  ok("bridge configuration error states", "HTTP 503/409/field rejection retain form; read failure has explicit read-only retry; no secret/server diagnostic echo");

  for (const mode of ["get-conflict", "get-provider-conflict", "get-model-conflict", "get-private-check"]) {
    fixture.state.configMode = mode;
    const posts = fixture.state.configRequests.length, modelCalls = fixture.state.modelsRequests.length;
    await click(configure); await until(() => cdp.eval(visible("#bc-issue")), "specific consistency issue card");
    assert.equal(await cdp.eval(visible("#bc-form")), false);
    assert.equal(await cdp.eval(visible("#bc-notice")), false, "do not duplicate the warning in a red wall of text");
    assert.equal(await cdp.eval("document.querySelector('#bc-config-state').innerText"), await cdp.eval("I18N.t('未通过')"));
    assert.equal(await cdp.eval("document.querySelector('#bc-service-state').innerText"), await cdp.eval("I18N.t('未确认')"), "a read conflict cannot prove the service stopped");
    const code = await cdp.eval("document.querySelector('#bc-issue-code').innerText");
    assert.equal(code, "RUNTIME_CONFLICT · " + (mode === "get-provider-conflict" ? "APP_PROVIDER" : mode === "get-model-conflict" ? "MODEL_LIST" : "UNKNOWN"));
    if (mode === "get-model-conflict") assert.equal(await cdp.eval("document.querySelector('#bc-issue-detail').innerText"), await cdp.eval("I18N.t('App 保存的模型清单未通过格式或一致性检查；这不表示存在另一套桥。')"));
    assert.equal(await cdp.eval("document.querySelector('#bc-backup-help').open"), false);
    assert.equal(await cdp.eval(`document.querySelector('#bridge-config-panel').innerText.includes(${q(CONFIG_ERROR)})`), false);
    assert.equal(await cdp.eval("document.querySelector('#bc-key').value"), "");
    await click("#bc-backup-help summary");
    assert.equal(await cdp.eval("document.querySelector('#bc-backup-help').open"), true);
    const body = await cdp.eval("document.querySelector('#bc-backup-help').innerText");
    assert.match(body, /chat history|conversations|聊天记录/i);
    fixture.state.configMode = "success";
    const reads = fixture.state.requests.filter(r => r.path === CONFIG_ROUTE && r.method === "GET").length;
    await click("#bc-check-again"); await until(() => cdp.eval(visible("#bc-saved")), "read-only recheck recovers saved view");
    assert.equal(fixture.state.requests.filter(r => r.path === CONFIG_ROUTE && r.method === "GET").length, reads + 1);
    assert.equal(fixture.state.configRequests.length, posts); assert.equal(fixture.state.modelsRequests.length, modelCalls);
    assert.equal(await cdp.eval(visible("#bc-issue")), false); await unchanged(); await configClose();
  }
  ok("bridge configuration checks and read-only retry", "legacy unknown/specific App mapping/private diagnostic; states are separate, backup scoped and collapsed, one GET recheck, no writes or upstream calls");

  fixture.state.configMode = "get-model-conflict"; const repairsBefore = fixture.state.repairRequests.length;
  await click(configure); await until(() => cdp.eval(visible("#bc-repair")), "repair guidance available");
  assert.equal(fixture.state.repairRequests.length, repairsBefore, "opening never automatically checks or repairs");
  const configPostsBeforeRepair = fixture.state.configRequests.length, modelCallsBeforeRepair = fixture.state.modelsRequests.length;
  await click("#bc-repair-inspect"); await until(() => cdp.eval(visible("#bc-repair-plan")), "explicit repair inspection offers plan");
  assert.equal(fixture.state.repairRequests.length, repairsBefore + 1); assert.equal(fixture.state.repairRequests.at(-1).action, "inspect");
  assert.equal(await cdp.eval("document.querySelector('#bridge-config-panel').innerText.includes('" + "e".repeat(48) + "')"), false, "repair ticket is not rendered");
  await click("#bc-repair-cancel"); assert.equal(await cdp.eval(visible("#bc-repair-plan")), false);
  assert.equal(fixture.state.repairRequests.length, repairsBefore + 1, "cancel makes no apply request");
  await click("#bc-repair-inspect"); await until(() => cdp.eval(visible("#bc-repair-plan")), "fresh plan before apply");
  await click("#bc-repair-apply"); await until(() => cdp.eval(visible("#bc-saved")), "confirmed metadata sync rechecks status");
  assert.ok(await cdp.eval(visible("#bc-notice")), "confirmed repair success receipt stays visible after status refresh");
  assert.deepEqual(fixture.state.repairRequests.slice(repairsBefore).map(r => r.action), ["inspect", "inspect", "apply"]);
  assert.equal(fixture.state.configRequests.length, configPostsBeforeRepair); assert.equal(fixture.state.modelsRequests.length, modelCallsBeforeRepair);
  await unchanged(); await configClose();
  fixture.state.configMode = "get-model-conflict"; fixture.state.repairMode = "REPAIR_UNAVAILABLE";
  await click(configure); await until(() => cdp.eval(visible("#bc-repair")), "non-repairable guidance");
  await click("#bc-repair-inspect"); await until(() => cdp.eval("document.querySelector('#bc-repair-status').textContent.length > 0 && document.querySelector('#bc-repair-steps').open"), "manual steps instead of unsafe repair");
  assert.equal(await cdp.eval(visible("#bc-repair-plan")), false);
  assert.equal(await cdp.eval(`document.querySelector('#bridge-config-panel').innerText.includes(${q(CONFIG_ERROR)})`), false);
  await configClose(); fixture.state.repairMode = "success"; fixture.state.configMode = "success";
  ok("bridge confirmed App metadata repair", "explicit inspect/plan/cancel/confirm, one apply plus read-only status refresh; unsafe state gets steps, no inference or configuration POST");
  fixture.state.configMode = "get-model-conflict"; fixture.state.repairMode = "REPAIR_PARTIAL";
  await click(configure); await until(() => cdp.eval(visible("#bc-repair")), "partial repair setup");
  await click("#bc-repair-inspect"); await until(() => cdp.eval(visible("#bc-repair-plan")), "partial repair plan");
  const partialReads = fixture.state.requests.filter(r => r.path === CONFIG_ROUTE && r.method === "GET").length;
  await click("#bc-repair-apply"); await until(() => cdp.eval("document.querySelector('#bc-repair-steps').open && !document.querySelector('#bc-saved').classList.contains('hidden')"), "partial commit readonly status refresh");
  assert.equal(fixture.state.requests.filter(r => r.path === CONFIG_ROUTE && r.method === "GET").length, partialReads + 1);
  assert.ok(await cdp.eval(visible("#bc-repair-status")), "partial commit receipt is visible");
  assert.equal(await cdp.eval(`document.querySelector('#bc-repair-status').innerText`), await cdp.eval(`I18N.t(${q("App 接口已写入，但映射收尾未完成；已尝试只读重查，请核对当前状态。不要反复执行修复，当前会话未切换。")})`));
  assert.equal(await cdp.eval(`document.querySelector('#bridge-config-panel').innerText.includes(${q(CONFIG_ERROR)})`), false);
  await unchanged(); await configClose(); fixture.state.repairMode = "success";
  ok("bridge partial commit receipt", "provider already written is explicit; one read-only status refresh, no automatic apply retry or private error echo");

  // First-time setup: only an explicit user click may prepare a new session, never remote inference.
  fixture.state.configMode = "success";
  Object.assign(fixture.state.config, { configured: false, hasKey: false, endpoint: "", model: "", models: [], apiKey: "", local: { state: "stopped" } });
  await configOpen();
  await click("#bc-save");
  for (const field of ["endpoint", "key", "model"]) assert.equal(await cdp.eval(`document.querySelector('#bc-${field}').getAttribute('aria-invalid')`), "true", `first setup requires ${field}`);
  await fill("#bc-endpoint", "https://new.synthetic.invalid");
  await fill("#bc-key", FAKE_NEW_KEY);
  await fill("#bc-model", "synthetic-new-model");
  await sleep(800);
  assert.equal(fixture.state.modelsRequests.length, 0, "typing credentials without model-list consent does not connect remotely");
  await click("#bc-model-consent");
  await until(() => fixture.state.modelsRequests.length === 1, "opt-in automatic model discovery");
  await until(() => cdp.eval("document.querySelector('#bc-model-status').textContent.includes('2')"), "model suggestions loaded");
  assert.equal(fixture.state.modelsRequests[0].consent, true);
  assert.equal(fixture.state.modelsRequests[0].apiKey, FAKE_NEW_KEY);
  assert.equal(await cdp.eval("document.querySelector('#bc-model').value"), "synthetic-new-model", "list never chooses the first model over typed input");
  assert.equal(fixture.state.modelsResponses.some((s) => s.includes(FAKE_NEW_KEY)), false);
  await unchanged();
  ok("bridge automatic model list opt-in", "no request before consent; debounce reads actual model route, populates searchable suggestions without selecting/saving");
  fixture.state.modelsMode = "MODELS_AUTH";
  await click("#bc-model-retry");
  await until(() => fixture.state.modelsRequests.length === 2, "failed synthetic model retry");
  await until(() => cdp.eval("!document.querySelector('#bc-model-retry').disabled"), "model retry unlocks after auth error");
  assert.ok(await cdp.eval("document.querySelector('#bc-model-status').textContent.length > 0"));
  assert.equal(await cdp.eval(`document.querySelector('#bridge-config-panel').innerText.includes(${q(CONFIG_ERROR)})`), false, "remote diagnostics are never echoed");
  await fill("#bc-model", "synthetic-manual-fallback");
  await sleep(800);
  assert.equal(fixture.state.modelsRequests.length, 2, "model typing is local filtering, not another lookup");
  fixture.state.modelsMode = "success";
  await click("#bc-model-retry");
  await until(() => fixture.state.modelsRequests.length === 3, "synthetic model recovery");
  await until(() => cdp.eval("document.querySelector('#bc-model-status').textContent.includes('2') && !document.querySelector('#bc-model-retry').disabled"), "model recovery completes");
  await fill("#bc-model", "synthetic-new-model");
  await unchanged();
  ok("bridge model list error and manual fallback", "static error, explicit retry only, model editing does not refetch, no inference or provider changes");
  assert.match(await cdp.eval("document.querySelector('#bc-endpoint-preview').innerText"), /https:\/\/new\.synthetic\.invalid\/v1\/chat\/completions/);
  await click("#bc-save");
  await until(() => cdp.eval(visible("#bc-saved")), "first setup succeeds");
  assert.equal(fixture.state.config.endpoint, "https://new.synthetic.invalid/v1/chat/completions");
  assert.equal(fixture.state.configRequests.at(-1).apiKey, FAKE_NEW_KEY);
  assert.equal(await cdp.eval(`JSON.stringify([localStorage, sessionStorage]).includes(${q(FAKE_NEW_KEY)})`), false, "new key not persisted by browser storage");
  assert.equal(await cdp.eval(`document.documentElement.outerHTML.includes(${q(FAKE_NEW_KEY)})`), false, "success does not echo replacement key");
  await unchanged();
  ok("bridge first setup", "required fields and root normalization, new key only same-origin POST, no storage/DOM secret after success");

  await click('#bridge-config-panel [data-bc="edit"]');
  fixture.state.models = [{ id: "large-synthetic", context_window: 1048576 }, { id: "small-synthetic", context_window: 128000 }, { id: "unknown-synthetic" }];
  const discoveriesBeforeMulti = fixture.state.modelsRequests.length;
  await click("#bc-model-consent");
  await until(() => fixture.state.modelsRequests.length === discoveriesBeforeMulti + 1 && cdp.eval("!document.querySelector('#bc-model-retry').disabled"), "multi-model metadata loaded");
  for (const [model, window] of [["large-synthetic", "1048576"], ["small-synthetic", "128000"], ["unknown-synthetic", "200000"]]) {
    await fill("#bc-model", model);
    assert.equal(await cdp.eval("document.querySelector('#bc-ctx').value"), window);
    await click("#bc-model-add");
  }
  await click('#bc-selected [data-bc="model-default"][data-model="small-synthetic"]');
  await click('#bc-selected [data-bc="model-edit"][data-model="large-synthetic"]');
  await fill("#bc-ctx", "512k"); await click("#bc-model-add");
  await click('#bc-selected [data-bc="model-remove"][data-model="synthetic-new-model"]');
  await click("#bc-save");
  await until(() => cdp.eval(visible("#bc-saved")), "multi-model configuration saved");
  assert.deepEqual(fixture.state.configRequests.at(-1).models, [{ id: "large-synthetic", contextWindow: 512000 }, { id: "small-synthetic", contextWindow: 128000 }, { id: "unknown-synthetic", contextWindow: 200000 }]);
  assert.equal(fixture.state.configRequests.at(-1).model, "small-synthetic");
  await unchanged();
  ok("bridge multiple models and windows", "add/edit/remove/default, exact API windows, 200000 fallback and manual override; no inference");

  const persistedModels = structuredClone(fixture.state.configRequests.at(-1).models);
  await configClose(); await configOpen(true);
  await click('#bridge-config-panel [data-bc="edit"]');
  await fill("#bc-key", FAKE_NEW_KEY);
  await click("#bc-save");
  await until(() => cdp.eval(visible("#bc-saved")), "key replacement preserves saved model windows");
  assert.deepEqual(fixture.state.configRequests.at(-1).models, persistedModels);
  await click('#bridge-config-panel [data-bc="edit"]');
  const discoveriesBeforeReselect = fixture.state.modelsRequests.length;
  await click("#bc-model-consent");
  await until(async () => fixture.state.modelsRequests.length === discoveriesBeforeReselect + 1 && await cdp.eval("!document.querySelector('#bc-model-retry').disabled"), "reopened discovery metadata loaded");
  await fill("#bc-model", "small-synthetic");
  assert.equal(await cdp.eval("document.querySelector('#bc-ctx').value"), "128000");
  await fill("#bc-model", "");
  await click('#bc-model-list [data-value="large-synthetic"]');
  assert.equal(await cdp.eval("document.querySelector('#bc-ctx').value"), "512000", "suggestion selection restores this model's manual window, not the previous model's");
  await click("#bc-save");
  await until(() => cdp.eval(visible("#bc-saved")), "reselected configured model saves without changing windows");
  assert.deepEqual(fixture.state.configRequests.at(-1).models, persistedModels);
  await unchanged();
  ok("bridge persisted window and suggestion regression", "reopen, replace key, rediscover and reselect an existing manual model preserve all model windows");

  await until(() => cdp.eval("document.querySelector('#bc-use').disabled === false"), "new-session action enabled by integrated entry callback");
  const connectionsBeforeUse = fixture.state.sseConnections;
  await click("#bc-use");
  await until(() => cdp.eval("__cc.view.sessionId === null && !document.querySelector('#tab-ext').classList.contains('bridge-config-open')"), "explicit create new session");
  await until(() => fixture.state.sseConnections > connectionsBeforeUse, "new-session EventSource reconnect");
  await until(() => cdp.eval("__cc.srv.connected && !__cc.view.loading"), "new-session hello settles");
  await sleep(300); // Observe the persisted selection after hello/resetView, not its transient pre-hello value.
  const pendingModel = await cdp.eval("__cc.state.pendingModel");
  assert.equal(pendingModel?.provider, fixture.state.config.providerId, "new provider survives async SSE hello/resetView");
  assert.equal(pendingModel?.model, fixture.state.config.model, "new model survives async SSE hello/resetView");
  assert.equal(fixture.state.providerActive, "synthetic", "global provider not switched");
  assert.equal(await cdp.eval("__cc.state.sessions.length"), beforeConfig.count, "no persisted chat until user actually sends");
  assert.equal(fixture.state.requests.filter((r) => r.path === "/api/chat").length, 0);
  ok("bridge explicit new session", "only user action leaves current session and stages new provider/model; no chat or global switch");
  for (const [model, window] of [["large-synthetic", 512000], ["unknown-synthetic", 200000], ["small-synthetic", 128000]]) {
    await click("#model-chip .chip");
    await until(() => cdp.eval(`!!document.querySelector('#model-pick .mp-item[data-id="${model}"]')`), "all configured models available in conversation picker");
    await click(`#model-pick .mp-item[data-id="${model}"]`);
    await until(() => cdp.eval(`__cc.state.pendingModel?.model === ${q(model)} && __cc.state.ctxTotal === ${window}`), "model switch updates its context window");
  }
  assert.equal(fixture.state.providerActive, "synthetic");
  assert.equal(fixture.state.requests.filter((r) => r.path === "/api/chat").length, 0);
  ok("bridge conversation model switching", "three models selected back and forth with separate context windows; no chat sent");

  // One browser, two viewport sizes; exercise interrupted transitions rather than claiming device FPS.
  await cdp.eval("__cc.openPage('sessions')");
  await cdp.call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await sleep(100);
  await click("#btn-menu");
  await until(() => cdp.eval(visible("#drawer")), "narrow drawer open");
  await key("Escape");
  // Native WebView back hook is the app's drawer/page back route; Esc is for menus/settings.
  await cdp.eval("window.__ccBack()");
  await sleep(300);
  await cdp.eval(`(async () => { for (let i = 0; i < 4; i++) { __cc.openPage(i % 2 ? 'caps' : 'ext'); await new Promise(r => setTimeout(r, 30)); } __cc.openPage('sessions'); })()`);
  await sleep(900);
  assert.equal(await cdp.eval("document.querySelectorAll('.mo-ghost').length"), 0, "rapid page switches leave no ghost panels");
  assert.equal(await cdp.eval("getComputedStyle(document.querySelector('#pages')).pointerEvents"), "auto");
  ok("narrow viewport and rapid page switching", "390×844; no retained animation ghosts");
  await cdp.eval("__cc.openPage('settings')");
  await until(() => cdp.eval("document.querySelector('#tab-settings').classList.contains('set-list')"), "narrow settings category list");
  await click('#set-cats button[data-cat="general"]');
  await until(() => cdp.eval("document.querySelector('#tab-settings').classList.contains('set-one')"), "narrow settings category opens");
  await click("#set-back");
  await until(() => cdp.eval("document.querySelector('#tab-settings').classList.contains('set-list')"), "narrow settings returns to categories");
  await click("#set-back");
  await until(() => cdp.eval("document.querySelector('#set-ov').classList.contains('hidden')"), "narrow settings closes");
  ok("narrow settings", "category list → detail → categories → closed");

  await openExt();
  await configOpen(true);
  await click('#bridge-config-panel [data-bc="edit"]');
  const themeRows = [];
  for (const skin of ["native", "qiusuo", "zhuyue", "goucheng"]) for (const mode of ["light", "dark"]) {
    const pref = ({ native: "", qiusuo: "qs-", zhuyue: "zy-", goucheng: "gc-" })[skin] + mode;
    await cdp.eval(`Theme.set(${q(pref)})`);
    await sleep(40);
    await click("#bc-endpoint");
    const metrics = await cdp.eval(`(() => { const p = document.querySelector('#bridge-config-panel'), f = document.querySelector('#bc-form'), r = f.getBoundingClientRect(), root = document.documentElement; return { skin: root.dataset.skin, theme: root.dataset.theme, width: innerWidth, left: r.left, right: r.right, horizontalOverflow: f.scrollWidth - f.clientWidth, font: getComputedStyle(p).fontFamily, parentFont: getComputedStyle(p.parentElement).fontFamily, fields: [...f.querySelectorAll('input:not([type=checkbox])')].map(e => ({label: !!document.querySelector('label[for="' + e.id + '"]'), h: e.getBoundingClientRect().height, w: e.getBoundingClientRect().width})) }; })()`);
    assert.equal(metrics.skin, skin); assert.equal(metrics.theme, mode);
    assert.ok(metrics.left >= -1 && metrics.right <= metrics.width + 1, `${skin}/${mode} form stays within narrow viewport`);
    assert.ok(metrics.horizontalOverflow <= 1, `${skin}/${mode} has no horizontal form overflow`);
    assert.equal(metrics.font, metrics.parentFont, "form inherits selected UI font");
    assert.ok(metrics.fields.every((f) => f.label && f.h >= 36 && f.w > 0), "visible controls retain labels and touch area");
    themeRows.push(`${skin}/${mode}`);
  }
  await click("#bc-save");
  await until(() => cdp.eval(visible("#bc-saved")), "narrow themed form saves with blank retained key");
  assert.equal(fixture.state.requests.filter((r) => r.path === "/api/chat").length, 0);
  await configClose();
  await cdp.eval("Theme.set('light')");
  ok("bridge narrow themes", `390×844; ${themeRows.join(', ')}; labels/font/scrollable save/no horizontal overflow`);

  fixture.state.configMode = "get-provider-conflict";
  await click(configure); await until(() => cdp.eval(visible("#bc-issue")), "narrow diagnostic card");
  for (const skin of ["native", "qiusuo", "zhuyue", "goucheng"]) for (const mode of ["light", "dark"]) {
    const pref = ({ native: "", qiusuo: "qs-", zhuyue: "zy-", goucheng: "gc-" })[skin] + mode;
    await cdp.eval(`Theme.set(${q(pref)})`); await sleep(40);
    const metrics = await cdp.eval(`(() => { const e = document.querySelector('#bc-issue'), o = document.querySelector('#bc-overview'), b = document.querySelector('#bc-check-again'), r = e.getBoundingClientRect(); return { left:r.left, right:r.right, width:innerWidth, issueOverflow:e.scrollWidth-e.clientWidth, overviewOverflow:o.scrollWidth-o.clientWidth, touch:b.getBoundingClientRect().height, detail:document.querySelector('#bc-issue-detail').innerText, code:document.querySelector('#bc-issue-code').innerText }; })()`);
    assert.ok(metrics.left >= -1 && metrics.right <= metrics.width + 1, `${skin}/${mode} issue fits narrow viewport`);
    assert.ok(metrics.issueOverflow <= 1 && metrics.overviewOverflow <= 1, `${skin}/${mode} issue has no horizontal overflow`);
    assert.ok(metrics.touch >= 44); assert.ok(metrics.detail); assert.equal(metrics.code, "RUNTIME_CONFLICT · APP_PROVIDER");
  }
  await click("#bc-backup-help summary"); assert.equal(await cdp.eval("document.querySelector('#bc-backup-help').open"), true);
  ok("bridge narrow diagnostic themes", "all eight theme combinations; independent state values, scoped backup help, >=44px read-only retry, no horizontal overflow");
  await click("#bc-repair-inspect"); await until(() => cdp.eval(visible("#bc-repair-plan")), "narrow confirmed repair plan");
  for (const skin of ["native", "qiusuo", "zhuyue", "goucheng"]) for (const mode of ["light", "dark"]) {
    const pref = ({ native: "", qiusuo: "qs-", zhuyue: "zy-", goucheng: "gc-" })[skin] + mode;
    await cdp.eval(`Theme.set(${q(pref)})`); await sleep(40);
    const metrics = await cdp.eval(`(() => { const e = document.querySelector('#bc-repair'), r = e.getBoundingClientRect(); return { left:r.left, right:r.right, width:innerWidth, overflow:e.scrollWidth-e.clientWidth, touches:['#bc-repair-inspect','#bc-repair-apply','#bc-repair-cancel'].map(s=>document.querySelector(s).getBoundingClientRect().height) }; })()`);
    assert.ok(metrics.left >= -1 && metrics.right <= metrics.width + 1 && metrics.overflow <= 1, `${skin}/${mode} repair plan fits narrow viewport`);
    assert.ok(metrics.touches.every(height => height >= 44), "repair controls retain touch area");
  }
  await click("#bc-repair-cancel"); assert.equal(await cdp.eval(visible("#bc-repair-plan")), false);
  await configClose(); fixture.state.configMode = "success"; await cdp.eval("Theme.set('light')");
  ok("bridge narrow repair themes", "all eight theme combinations; scoped plan and >=44px inspection/confirm/cancel controls; no horizontal overflow");

  await cdp.call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await until(() => cdp.eval("document.documentElement.dataset.motion === 'off'"), "reduced-motion preference applied");
  await cdp.eval("__cc.openPage('ext')");
  await sleep(80);
  assert.equal(await cdp.eval("document.querySelectorAll('.mo-ghost').length"), 0);
  await cdp.eval("window.__ccBack()");
  await click("#btn-plus");
  await until(() => cdp.eval(visible("#sheet")), "reduced-motion plus menu");
  await key("Escape");
  await until(() => cdp.eval("document.querySelector('#sheet').classList.contains('hidden')"), "reduced-motion menu closes");
  ok("reduced motion", "system preference disables motion; menus stay functional");

  // Real loopback EventSource frames, including stale-history races and unrelated session events.
  fixture.state.historyDelay[SESSION_A] = 450;
  await cdp.eval(`__cc.openSession(${q(SESSION_A)})`);
  await until(() => fixture.state.requests.some((r) => r.path === "/api/session/" + SESSION_A), "delayed session A history");
  await cdp.eval(`__cc.openSession(${q(SESSION_B)})`);
  await until(() => cdp.eval(`__cc.view.sessionId === ${q(SESSION_B)} && __cc.view.histOk`), "session B history");
  await sleep(500);
  const history = await cdp.eval("document.querySelector('#hist').innerText");
  assert.match(history, /Synthetic history B/);
  assert.doesNotMatch(history, /Synthetic history A/);
  const rid = "synthetic-run-b", run = { id: rid, sessionId: SESSION_B, startedAt: Date.now(), ended: false };
  fixture.emit({ type: "state", runs: [run], queue: [] });
  fixture.emit({ type: "run_start", runId: rid, sessionId: SESSION_B, text: "Synthetic SSE prompt (not submitted)", startedAt: run.startedAt });
  fixture.emit({ type: "thinking_delta", runId: rid, text: "Synthetic thought" });
  fixture.emit({ type: "tool_use", runId: rid, id: "synthetic-tool-1", name: "Read", input: { file_path: "/synthetic/a.txt" } });
  fixture.emit({ type: "tool_result", runId: rid, id: "synthetic-tool-1", ok: true, text: "Synthetic tool result A" });
  fixture.emit({ type: "tool_use", runId: rid, id: "synthetic-tool-2", name: "Read", input: { file_path: "/synthetic/b.txt" } });
  fixture.emit({ type: "tool_result", runId: rid, id: "synthetic-tool-2", ok: true, text: "Synthetic tool result B" });
  fixture.emit({ type: "delta", runId: rid, text: "Synthetic SSE answer " });
  fixture.emit({ type: "delta", runId: rid, text: "arrived over loopback." });
  fixture.emit({ type: "delta", runId: "unrelated-run", sessionId: SESSION_A, text: "DO NOT RENDER" });
  fixture.emit({ type: "run_end", runId: rid, sessionId: SESSION_B, at: Date.now(), durationMs: 100, usage: { output_tokens: 9, context_tokens: 1234 } });
  fixture.emit({ type: "state", runs: [], queue: [] });
  await until(() => cdp.eval("document.querySelector('#live').innerText.includes('Synthetic SSE answer arrived over loopback.')"), "synthetic SSE response rendered");
  assert.doesNotMatch(await cdp.eval("document.querySelector('#live').innerText"), /DO NOT RENDER/);
  assert.equal(await cdp.eval("__cc.state.ctxUsed"), 1234);
  await click("#live .tgroup .tg-head");
  await until(() => cdp.eval("document.querySelector('#live .tgroup').classList.contains('open')"), "synthetic tool group opens");
  await click("#live .tool .tool-head");
  await until(() => cdp.eval("document.querySelector('#live .tool .tool-body').innerText.includes('Synthetic tool result A')"), "synthetic tool result lazy rendering");
  await click("#live .think summary");
  await until(() => cdp.eval("document.querySelector('#live .think-body').innerText.includes('Synthetic thought')"), "synthetic thought expands");
  await click("#live .tgroup .tg-head");
  assert.equal(await cdp.eval("!!document.querySelector('#live .tgroup .tool.open, #live .tgroup details[open]')"), false, "closing tool group also collapses its children");
  assert.equal(fixture.state.requests.filter((r) => r.path === "/api/chat").length, 0, "no chat API request");
  ok("synthetic SSE and fast session switching", "late A history ignored; B streaming renders; unrelated deltas ignored; zero chat requests");
  ok("synthetic thought and tool groups", "real pointer expansion, lazy result render, parent close collapses children");

  await sleep(200);
  errors.push(...await cdp.eval("window.__fixtureErrors || []"));
  assert.deepEqual([...new Set(errors)], [], "no console/runtime/unhandled errors");
  assert.deepEqual(blocked, [], "frontend never attempts to leave synthetic origin");
  assert.deepEqual(fixture.state.unexpected, [], "all frontend API calls covered by fixture");
  assert.equal(fixture.state.requests.filter((r) => r.method === "POST" && r.path === CONFIG_ROUTE).length, fixture.state.configRequests.length, "every configuration POST uses the real dispatch path");
  assert.ok(fixture.state.requests.some((r) => r.method === "GET" && r.path === CONFIG_ROUTE), "configuration GET uses the real dispatch path");
  assert.equal(fixture.state.requests.some((r) => r.path === "/api/bridge-config"), false, "legacy synthetic-only alias must never be requested");
  console.log(JSON.stringify({ checks: results.length, synthetic: true, configRoute: CONFIG_ROUTE, sseConnections: fixture.state.sseConnections, removeRequests: fixture.state.removeCount, configPosts: fixture.state.configRequests.length, sessionModelWrites: fixture.state.sessionModelWrites.length, chatRequests: 0, externalRequests: blocked.length, errors: 0, viewports: ["1280x900", "390x844"], sourceHashes: fixture.state.sourceHashes, note: "Headless synthetic interaction acceptance only; not real-device WebView FPS." }));
} catch (err) {
  console.error("FAIL " + err.stack);
  if (fixture) console.error("Run evidence " + JSON.stringify({ checksPassed: results.map((r) => r.name), configPosts: fixture.state.configRequests.length, sessionModelWrites: fixture.state.sessionModelWrites.length, chatRequests: fixture.state.requests.filter((r) => r.path === '/api/chat').length, externalRequests: blocked.length, sourceHashes: fixture.state.sourceHashes }));
  if (cdp) {
    try { console.error("UI state " + JSON.stringify(await cdp.eval("({ title: document.querySelector('#sub-title')?.innerText, errors: window.__fixtureErrors, comp: document.querySelector('#comp-list')?.innerText, localErrors: localStorage.getItem('cc.errLog') })"))); } catch {}
  }
  if (errors.length) console.error("Runtime errors " + JSON.stringify(errors));
  if (fixture?.state.unexpected.length) console.error("Unimplemented fixture calls " + JSON.stringify(fixture.state.unexpected));
  if (stderr) console.error("Chromium stderr " + stderr.slice(-2000));
  process.exitCode = 1;
} finally {
  if (cdp) cdp.ws.close();
  if (browser?.pid) {
    try { process.kill(-browser.pid, "SIGTERM"); } catch {}
    await Promise.race([once(browser, "exit").catch(() => {}), sleep(2000)]);
    if (browser.exitCode === null) { try { process.kill(-browser.pid, "SIGKILL"); } catch {} }
  }
  if (fixture) await fixture.close();
  await fs.rm(tmp, { recursive: true, force: true });
  await fs.rm(lock, { recursive: true, force: true });
}
