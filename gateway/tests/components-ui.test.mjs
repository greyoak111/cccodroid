// Execute the real extension UI in a small DOM stub; no gateway, process or network access.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const WEB = new URL("../web/", import.meta.url);
const source = fs.readFileSync(new URL("app/08-extensions.js", WEB), "utf8");
const removingHint = "正在卸载，这一步不能取消，请等待完成";
const retainedError = "本地 OpenAI 桥停用失败，组件文件已保留。请检查运行状态后重试卸载。";
const english = {};
vm.runInNewContext(fs.readFileSync(new URL("lang-en.js", WEB), "utf8"), { window: english });
const dict = english.I18N_DICT.en;
const escape = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const item = (state = "ok", extra = {}) => ({
  id: "openai-bridge", name: { en: "OpenAI bridge" }, desc: "", state,
  installedVersion: "1.0", version: "1.0", available: true, verified: true,
  category: "net", bytes: 1048576, installed: 1048576, bin: [], ...extra,
});

function ui(initial = item()) {
  const nodes = new Map(), timers = new Map(), calls = [], toasts = [], confirms = [], sessionActions = [];
  let listing = { supported: true, items: [initial] }, onPage = true, timer = 0;
  const node = (id) => {
    if (["gh-auth", "llm-dl", "ext-storage"].includes(id)) return null;
    if (!nodes.has(id)) nodes.set(id, {
      innerHTML: "", textContent: "", dataset: {}, listeners: {},
      classList: { toggle() {}, contains() { return false; }, add() {}, remove() {} },
      addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    });
    return nodes.get(id);
  };
  const t = (key, vars = {}) => String(dict[key] ?? key).replace(/\{(\w+)\}/g, (m, k) => k in vars ? String(vars[k]) : m);
  const box = {
    window: { I18N: { lang: "en" } }, I18N: { lang: "en" },
    $: node, t, tk: (s) => s, esc: escape, isZh: () => false,
    document: { querySelectorAll: () => [] }, localStorage: { getItem: () => null },
    pageOn: () => onPage, setPageSub() {}, webUrl: () => false,
    newConversation: () => sessionActions.push({ action: "newConversation" }),
    closeDrawer: () => sessionActions.push({ action: "closeDrawer" }),
    pickSessModel: async (patch) => sessionActions.push({ action: "pickSessModel", patch: structuredClone(patch) }),
    confirm: (message) => { confirms.push(message); return true; },
    toast: (message, error = false) => toasts.push({ message, error }),
    api: async (url) => {
      assert.equal(url, "/api/components", "UI must only use the stub component list");
      const value = typeof listing === "function" ? await listing() : listing;
      return structuredClone(value);
    },
    post: async (url, body) => { calls.push({ url, id: body.id }); return uiState.post(url, body); },
    setTimeout: (fn, delay) => { timers.set(++timer, { fn, delay }); return timer; },
    clearTimeout: (id) => timers.delete(id),
  };
  vm.runInNewContext(source + "\nglobalThis.uiTest = { loadComponents, compRemoving };", box, { filename: "08-extensions.js" });
  const handler = node("tab-ext").listeners.click.find((fn) => fn.toString().includes('closest("button[data-c]")'));
  assert.ok(handler, "component click handler is registered");
  const uiState = {
    calls, toasts, timers, confirms, sessionActions, node, t,
    post: async () => ({ ok: true }),
    config(value) { box.window.CCBridgeConfig = value; },
    list(value) { listing = value; },
    page(on) { onPage = on; },
    load: box.uiTest.loadComponents,
    get removing() { return [...box.uiTest.compRemoving]; },
    get html() { return node("comp-list").innerHTML; },
    click(action, id = "openai-bridge") {
      const foot = { innerHTML: "" };
      const card = { querySelector: (selector) => selector === ".cc-foot" ? foot : null };
      const button = {
        dataset: { c: action, id }, disabled: false,
        closest: (selector) => selector === ".ccard" ? card : null,
      };
      const target = { classList: { contains: () => false }, closest: (selector) => selector === "button[data-c]" ? button : null };
      return { done: handler({ target }), button, foot };
    },
  };
  return uiState;
}

function assertRemoving(html, u) {
  assert.ok(html.includes(u.t("正在卸载…")), "removing is translated instead of displayed as a raw state");
  assert.ok(html.includes(u.t(removingHint)), "wait / non-cancellable hint is visible");
  assert.match(html, /role="status"/);
  assert.doesNotMatch(html, /data-c="(?:install|remove|cancel|configure)"/, "no component mutation or configuration button is available");
}

test("component UI: installed OpenAI bridge keeps its card and places configuration immediately before uninstall", async () => {
  const u = ui();
  await u.load();
  assert.match(u.html, /<b>OpenAI bridge<\/b>/);
  assert.match(u.html, /1\.0/);
  assert.ok(u.html.includes(u.t("已装")));
  assert.match(u.html, /data-c="configure"[^>]*>Config<\/button><button[^>]*data-c="remove"/);
  const pending = deferred();
  let opens = 0, options;
  u.config({ open(opts) { opens++; options = opts; return pending.promise; } });
  const click = u.click("configure");
  assert.equal(opens, 1);
  assert.equal(click.button.disabled, true);
  assert.equal(u.calls.length, 0, "configuration entry never posts a component lifecycle operation");
  assert.deepEqual(u.sessionActions, [], "opening the form does not select a provider or leave the current session");
  assert.equal(options.anchor, click.button);
  assert.equal(typeof options.useNew, "function");
  pending.resolve();
  await click.done;
  assert.equal(click.button.disabled, false);
  assert.equal(u.toasts.length, 0);
  assert.deepEqual(u.sessionActions, [], "loading configuration never runs the success-page action");
  await options.useNew({ provider: "custom-openai-bridge", model: "example-model" });
  assert.deepEqual(u.sessionActions, [
    { action: "newConversation" }, { action: "closeDrawer" },
    { action: "pickSessModel", patch: { provider: "custom-openai-bridge", model: "example-model" } },
  ], "only an explicit success-page action pins the provider after moving to a new session");
  assert.equal(u.calls.length, 0);
});

test("component UI: configuration is only offered for the installed OpenAI bridge and missing form is visible", async () => {
  for (const component of [item("ok", { id: "python" }), item("absent", { installedVersion: null }), item("installing"), item("removing"), item("configuring")]) {
    const u = ui(component);
    await u.load();
    assert.doesNotMatch(u.html, /data-c="configure"/);
  }
  const u = ui();
  await u.click("configure").done;
  assert.deepEqual(u.toasts, [{ message: u.t("配置界面尚未就绪，请刷新后重试"), error: true }]);
  assert.equal(u.calls.length, 0);
  u.config({ open: async () => { throw new Error("form failed"); } });
  const failed = u.click("configure");
  await failed.done;
  assert.equal(failed.button.disabled, false);
  assert.deepEqual(u.toasts.at(-1), { message: u.t("失败：{msg}", { msg: "form failed" }), error: true });
  assert.equal(u.calls.length, 0);
});

test("component UI: backend configuring shows a translated wait status without action buttons and keeps polling", async () => {
  const u = ui(item("configuring", { progress: null, unsupported: true, needs: { gpu: "adreno" } }));
  await u.load();
  assert.ok(u.html.includes(u.t("正在配置…请等待完成")));
  assert.doesNotMatch(u.html, />configuring</, "backend state name is not shown to users");
  assert.match(u.html, /role="status"/);
  assert.match(u.html, /class="sdot warn"/);
  assert.match(u.html, /data-tags="[^"]*inst/);
  assert.doesNotMatch(u.html, /ccard dim/);
  assert.doesNotMatch(u.html, /data-c="(?:install|remove|cancel|configure)"/);
  assert.deepEqual([...u.timers.values()].map((v) => v.delay), [1000]);
  assert.equal(u.calls.length, 0);
  u.list({ supported: true, items: [item()] });
  await u.load();
  assert.match(u.html, /data-c="configure"/);
  assert.match(u.html, /data-c="remove"/);
  assert.equal(u.timers.size, 0, "polling stops when configuration finishes");
});

test("component UI: backend removing is translated, non-cancellable and polled even without progress", async () => {
  const u = ui(item("removing", { progress: null, unsupported: true, needs: { gpu: "adreno" } }));
  await u.load();
  assertRemoving(u.html, u);
  assert.match(u.html, /data-tags="[^"]*inst/);
  assert.doesNotMatch(u.html, /ccard dim/, "GPU incompatibility must not dim the active removal notice");
  assert.deepEqual([...u.timers.values()].map((v) => v.delay), [1000]);
  u.list({ supported: true, items: [item()] });
  await u.load();
  assert.match(u.html, /data-c="remove"/);
  assert.equal(u.timers.size, 0, "polling stops when removal finishes");
  u.page(false);
  u.list({ supported: true, items: [item("removing")] });
  await u.load();
  assert.equal(u.timers.size, 0, "closed extension page does not keep polling");
});

test("component UI: pending uninstall immediately locks stale install/remove/cancel buttons until completion", async () => {
  const u = ui(), removal = deferred();
  u.post = () => removal.promise;
  await u.load();
  const click = u.click("remove");
  assert.equal(click.button.disabled, true);
  assertRemoving(click.foot.innerHTML, u);
  assert.deepEqual(u.removing, ["openai-bridge"]);
  await u.load();
  assertRemoving(u.html, u);
  for (const action of ["install", "remove", "cancel", "configure"]) await u.click(action).done;
  assert.equal(u.calls.length, 1, "only the original uninstall reaches the backend");
  u.list({ supported: true, items: [item("absent", { installedVersion: null })] });
  removal.resolve({ ok: true });
  await click.done;
  assert.deepEqual(u.removing, []);
  assert.match(u.html, /data-c="install"/);
  assert.equal(u.timers.size, 0);
  assert.deepEqual(u.toasts, [{ message: u.t("已卸载"), error: false }]);
});

test("component UI: rejected or interrupted uninstall clears only the local lock and never claims files were removed", async () => {
  for (const rejectedRequest of [false, true]) {
    const u = ui();
    u.post = async () => {
      if (rejectedRequest) throw new Error("connection lost");
      return { ok: false, message: u.t(retainedError), data: { bytes: 100, path: "~/.cccodroid/openai-bridge" } };
    };
    await u.load();
    await u.click("remove").done;
    assert.deepEqual(u.removing, []);
    assert.match(u.html, /data-c="remove"/, "installed component can be retried");
    assert.equal(u.timers.size, 0);
    assert.equal(u.toasts.length, 1);
    assert.equal(u.toasts[0].error, true);
    assert.ok(u.toasts[0].message.includes(rejectedRequest ? "connection lost" : u.t(retainedError)));
    assert.equal(u.confirms.length, 1, "failure never offers to purge runtime data");
    assert.equal(u.calls.length, 1);
  }
});

test("component UI: interrupted POST keeps waiting when the backend still reports removing", async () => {
  const u = ui();
  await u.load();
  u.post = async () => {
    u.list({ supported: true, items: [item("removing")] });
    throw new Error("connection lost");
  };
  await u.click("remove").done;
  assert.deepEqual(u.removing, [], "only the optimistic local lock is cleared");
  assertRemoving(u.html, u);
  assert.equal(u.toasts[0].error, true);
  assert.equal(u.calls.length, 1);
  assert.equal(u.timers.size, 1, "backend removal is polled until it settles");
});

test("component UI: fetching model list occupies installed card with translated non-mutating status", async () => {
  const u = ui(item("fetching-models"));
  await u.load();
  assert.ok(u.html.includes(u.t("正在读取模型清单…")));
  assert.match(u.html, /role="status"/);
  assert.match(u.html, /data-tags="[^"]*inst/);
  assert.doesNotMatch(u.html, /data-c="(?:install|remove|cancel|configure)"/);
  assert.equal(u.timers.size, 1, "model fetching is polled until the operation completes");
  u.list({ supported: true, items: [item()] });
  await u.load();
  assert.match(u.html, /data-c="configure"/);
  assert.equal(u.timers.size, 0);
});

test("component UI: stale cancel rejected by backend displays failure and reloads removing, not cancelled", async () => {
  const u = ui(item("downloading"));
  await u.load();
  assert.match(u.html, /data-c="cancel"/);
  u.post = async () => ({ ok: false, message: u.t(removingHint) });
  u.list({ supported: true, items: [item("removing")] });
  await u.click("cancel").done;
  assert.deepEqual(u.calls, [{ url: "/api/components/cancel", id: "openai-bridge" }]);
  assert.deepEqual(u.toasts, [{ message: u.t("失败：{msg}", { msg: u.t(removingHint) }), error: true }]);
  assertRemoving(u.html, u);
});

test("component UI: late removal poll cannot overwrite a newer completed-state refresh", async () => {
  const u = ui(), old = deferred();
  u.list(() => old.promise);
  const pending = u.load();
  u.list({ supported: true, items: [item("absent", { installedVersion: null })] });
  await u.load();
  old.resolve({ supported: true, items: [item("removing")] });
  await pending;
  assert.match(u.html, /data-c="install"/);
  assert.ok(!u.html.includes(u.t(removingHint)));
  assert.equal(u.timers.size, 0);
});

test("bridge form literal and conditional labels are translated in every shipped dictionary", () => {
  const form = fs.readFileSync(new URL("app/bridge-config.js", WEB), "utf8"), keys = new Set();
  // Include conditional t() branches: the general scanner cannot infer those keys.
  for (const call of form.matchAll(/(?:\bt|\blabel)\(([^)\n]*)\)/g)) {
    for (const literal of call[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
      const key = JSON.parse(literal[0]);
      if (/\p{Script=Han}/u.test(key) || key === "API Key") keys.add(key);
    }
  }
  assert.ok(keys.size >= 40, "the form's translated labels and conditional states are covered");
  const backend = fs.readFileSync(new URL("../gw/bridge-config.mjs", import.meta.url), "utf8");
  for (const literal of backend.matchAll(/\btz\(\s*("(?:[^"\\]|\\.)*")/g)) keys.add(JSON.parse(literal[1]));
  const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const code of ["en", "ar", "es", "fr", "ja", "ko", "ru", "zh-Hant", "id"]) {
    const box = { window: {} };
    vm.runInNewContext(fs.readFileSync(new URL(`lang-${code}.js`, WEB), "utf8"), box);
    for (const key of keys) {
      const value = box.window.I18N_DICT[code][key];
      assert.equal(typeof value, "string", `${code}: ${key}`);
      assert.ok(value.length > 0, `${code}: no empty translations`);
      assert.deepEqual(vars(value), vars(key), `${code}: placeholders for ${key}`);
      if (code !== "zh-Hant" && /\p{Script=Han}/u.test(key)) assert.notEqual(value, key, `${code}: no Chinese fallback`);
    }
  }
});

test("component lifecycle strings have real translations in every shipped dictionary", () => {
  for (const code of ["en", "ar", "es", "fr", "ja", "ko", "ru", "zh-Hant", "id"]) {
    const box = { window: {} };
    vm.runInNewContext(fs.readFileSync(new URL(`lang-${code}.js`, WEB), "utf8"), box);
    for (const key of ["配置界面尚未就绪，请刷新后重试", "正在配置…请等待完成", "正在读取模型清单…", "正在卸载…", removingHint, retainedError]) {
      const translated = box.window.I18N_DICT[code][key];
      assert.equal(typeof translated, "string", `${code}: ${key}`);
      assert.notEqual(translated, key, `${code} does not fall back to Simplified Chinese`);
    }
  }
});
