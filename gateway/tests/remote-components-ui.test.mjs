// Remote-session extension cards in a tiny DOM. No gateway or real user data.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../web/app/08-extensions.js", import.meta.url), "utf8");
const escape = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const deferred = () => { let resolve; const promise = new Promise((yes) => resolve = yes); return { promise, resolve }; };
const feature = (state = "disabled", extra = {}) => ({ ok: true, id: "remote-session", hostApi: 1, state, installed: true, enabled: state === "active", version: "1.0", assetVersion: "a".repeat(64), error: null, ...extra });
const item = (state = "ok", extra = {}) => ({ id: "remote-session", name: "Remote session", desc: "Optional remote UI", state, installedVersion: "1.0", version: "1.0", available: true, verified: true, category: "net", bytes: 1024, installed: 1024, bin: [], hostApi: { remoteSession: 1 }, hostCompatible: true, feature: feature(), ...extra });
function ui(initial = item()) {
  const nodes = new Map(), timers = new Map(), calls = [], toasts = [], confirms = [], opens = [], hostCalls = [];
  let listing = { supported: true, items: [initial] }, timer = 0, enabled = initial.feature?.state === "active", onPage = true;
  const node = (id) => {
    if (["gh-auth", "llm-dl", "ext-storage"].includes(id)) return null;
    if (!nodes.has(id)) nodes.set(id, { innerHTML: "", textContent: "", listeners: {}, classList: { toggle() {}, contains() { return false; }, add() {}, remove() {} }, addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); } });
    return nodes.get(id);
  };
  const host = { refresh: async () => { hostCalls.push("refresh"); return enabled; }, enabled: () => enabled,
    enable: async () => { hostCalls.push("enable"); enabled = true; }, disable: async () => { hostCalls.push("disable"); enabled = false; }, retiring: () => { hostCalls.push("retiring"); enabled = false; } };
  const box = { window: { I18N: { lang: "zh" } }, I18N: { lang: "zh" }, $: node, t: (s, vars = {}) => String(s).replace(/\{(\w+)\}/g, (m, k) => k in vars ? vars[k] : m), tk: (s) => s, esc: escape, isZh: () => true,
    document: { querySelectorAll: () => [] }, localStorage: { getItem: () => null }, pageOn: () => onPage, setPageSub() {}, webUrl: () => false,
    remoteComponent: host, openPage: (...args) => opens.push(args), newConversation: () => assert.fail("must not change local session"),
    confirm: (message) => { confirms.push(message); return state.confirm; }, toast: (text, error = false) => toasts.push({ text, error }),
    api: async (url) => { assert.match(url, /^\/api\/components(?:\?|$)/); return structuredClone(listing); },
    post: async (url, body) => { calls.push({ url, body }); return state.post(url, body); },
    setTimeout: (fn, delay) => { timers.set(++timer, { fn, delay }); return timer; }, clearTimeout: (id) => timers.delete(id) };
  vm.createContext(box); vm.runInContext(source + "\nglobalThis.testUI = { loadComponents };", box);
  const handler = node("tab-ext").listeners.click.find((fn) => fn.toString().includes('closest("button[data-c]")'));
  const state = { calls, toasts, confirms, opens, hostCalls, timers, host, confirm: true, post: async () => ({ ok: true }),
    load: box.testUI.loadComponents, list(value) { listing = { supported: true, items: [value] }; }, page(on) { onPage = on; },
    get html() { return node("comp-list").innerHTML; },
    click(action, id = "remote-session") {
      const foot = { innerHTML: "" }, card = { querySelector: () => foot }, button = { dataset: { c: action, id }, disabled: false, closest: (s) => s === ".ccard" ? card : null };
      const target = { classList: { contains: () => false }, closest: (s) => s === "button[data-c]" ? button : null };
      return { done: handler({ target }), button, foot };
    },
  };
  return state;
}

test("remote card: installed/update compatible host exposes configuration and explicit enable/disable, never pseudo-online", async () => {
  for (const componentState of ["ok", "update"]) {
    for (const state of ["disabled", "active", "error"]) {
      const u = ui(item(componentState, { feature: feature(state) })); await u.load();
      assert.match(u.html, /data-c="configure"/); assert.match(u.html, new RegExp(`data-c="${state === "active" ? "disable" : "enable"}"`));
      assert.match(u.html, state === "active" ? /已启用/ : state === "error" ? /远程组件不可用/ : /已停用/);
      if (state !== "active") assert.doesNotMatch(u.html, /class="sdot ok"|在线/);
      if (componentState === "update") assert.match(u.html, /data-c="install"/);
      assert.match(u.html, /data-c="remove"/);
    }
  }
});

test("remote card: missing/old host API has no operations and is not a toolpack compatibility error", async () => {
  for (const fields of [{ hostApi: undefined }, { hostApi: { remoteSession: 2 } }, { hostCompatible: undefined }, { hostCompatible: false }]) {
    const u = ui(item("ok", fields)); await u.load();
    assert.doesNotMatch(u.html, /data-c="(?:configure|enable|disable|install|remove|cancel)"/);
    assert.match(u.html, /remoteSession hostApi 1/); assert.doesNotMatch(u.html, /需要重新安装|需要骁龙|暂无适配当前工具包/);
    for (const action of ["configure", "enable", "disable", "install", "remove", "cancel"]) await u.click(action).done;
    assert.equal(u.calls.length, 0); assert.equal(u.hostCalls.filter((x) => x !== "refresh").length, 0);
  }
});

test("remote card: missing feature status exposes no lifecycle toggle, retiring suppresses stale controls", async () => {
  const u = ui(item("ok", { feature: undefined })); await u.load(); assert.match(u.html, /远程组件状态尚未读取/); assert.doesNotMatch(u.html, /data-c="(?:enable|disable)"/);
  u.list(item("ok", { feature: feature("retiring") })); await u.load(); assert.doesNotMatch(u.html, /data-c="(?:configure|enable|disable|remove)"/);
});

test("remote card: configure is non-mutating; enable/disable uses host lifecycle and explicit revoke/continue confirmation", async () => {
  const u = ui(); await u.load(); await u.click("configure").done;
  assert.equal(u.opens.length, 0); assert.match(u.toasts.at(-1).text, /请先启用/); assert.equal(u.calls.length, 0);
  await u.click("enable").done; assert.ok(u.hostCalls.includes("enable")); assert.equal(u.calls.length, 0);
  u.list(item("ok", { feature: feature("active") })); await u.load(); await u.click("configure").done;
  assert.deepEqual(u.opens.at(-1), ["settings", "remote"]);
  const pending = deferred(); u.host.disable = async () => { u.hostCalls.push("disable"); return pending.promise; };
  const first = u.click("disable"); assert.equal(first.button.disabled, true);
  for (const action of ["disable", "remove", "install", "configure"]) await u.click(action).done;
  assert.equal(u.hostCalls.filter((x) => x === "disable").length, 1); assert.equal(u.calls.length, 0);
  assert.match(u.confirms.at(-1), /撤销现有托管/); assert.match(u.confirms.at(-1), /清理本机远程缓存/); assert.match(u.confirms.at(-1), /原会话和任务继续执行，不会停止/);
  pending.resolve(); await first.done;
});

test("remote card: cancelled disable does nothing; failed lifecycle visibly recovers card controls", async () => {
  const u = ui(item("ok", { feature: feature("active") })); await u.load(); u.confirm = false; await u.click("disable").done;
  assert.ok(!u.hostCalls.includes("disable"));
  u.confirm = true; u.host.disable = async () => { throw new Error("retain component"); };
  const click = u.click("disable"); await click.done; assert.equal(click.button.disabled, false); assert.match(u.toasts.at(-1).text, /retain component/); assert.equal(u.toasts.at(-1).error, true);
  assert.match(u.html, /data-c="disable"/);
});

test("remote card: uninstall uses remote revoke/cache confirmation and does not change OpenAI bridge wording", async () => {
  const u = ui(); await u.load(); await u.click("remove").done;
  assert.match(u.confirms[0], /卸载远程托管组件/); assert.match(u.confirms[0], /撤销现有托管/); assert.match(u.confirms[0], /原会话和任务继续执行/);
  assert.ok(u.hostCalls.includes("retiring")); assert.equal(u.calls[0].url, "/api/components/remove");
  const bridge = ui(item("ok", { id: "openai-bridge" })); await bridge.load(); await bridge.click("remove", "openai-bridge").done;
  assert.match(bridge.confirms[0], /会删掉它装进工具包的文件/); assert.doesNotMatch(bridge.confirms[0], /撤销现有托管/);
});

test("remote card: asynchronous install polls to completion and refreshes host even when extensions closes", async () => {
  const u = ui(item("absent", { installedVersion: null, feature: feature("absent", { installed: false }) })); await u.load();
  u.post = async () => { u.list(item("installing", { installedVersion: null, feature: feature("absent", { installed: false }) })); return { ok: true }; };
  u.page(false); await u.click("install").done;
  const pending = [...u.timers].find(([, timer]) => timer.delay === 1200); assert.ok(pending, "install watcher is independent of current page");
  const before = u.hostCalls.length; u.list(item("ok", { feature: feature("active") })); u.timers.delete(pending[0]); await pending[1].fn();
  assert.ok(u.hostCalls.length > before); assert.ok(u.hostCalls.slice(before).includes("refresh")); assert.equal(u.timers.size, 0);
});
