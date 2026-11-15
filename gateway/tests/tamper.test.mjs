// All backend imports run under scripts/test.mjs's isolated home; UI uses synthetic events only.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { tamperRecord, tamperPending, tamperAck, tamperNote, tamperRetell, onTamper } from "../gw/tamper.mjs";

function reset() { tamperAck(); tamperNote(); onTamper(null); }
test("record merges pending same-source files, preserves first time and only notifies for new files", () => {
  reset(); const pushes = []; onTamper((events) => pushes.push(structuredClone(events)));
  const first = tamperRecord("runtime", ["ccapp-settings.json"]), at = first.at;
  assert.equal(tamperRecord("runtime", ["ccapp-settings.json"]), first);
  assert.equal(pushes.length, 1);
  assert.equal(tamperRecord("runtime", ["ccapp-providers.json"]), first);
  assert.equal(first.at, at);
  assert.deepEqual(first.files, ["ccapp-settings.json", "ccapp-providers.json"]);
  assert.equal(pushes.length, 2);
  const app = tamperRecord("app", ["TOOLS.md"]);
  assert.notEqual(app.id, first.id);
  tamperAck(String(first.id));
  assert.deepEqual(tamperPending().map((e) => e.id), [app.id]);
  assert.notEqual(tamperRecord("runtime", ["ccapp-settings.json"]).id, first.id);
  tamperAck(); assert.deepEqual(tamperPending(), []); onTamper(null);
});
test("ack does not silence model note; retell and added files re-enable delivery", () => {
  reset(); const ev = tamperRecord("runtime", ["ccapp-providers.json"]);
  tamperAck(ev.id); const ids = [];
  assert.match(tamperNote(ids), /POST \/api\/providers\/save/);
  assert.deepEqual(ids, [ev.id]); assert.equal(tamperNote(), "");
  tamperRetell(ids); assert.match(tamperNote(), /current settings/);
  const open = tamperRecord("runtime", ["ccapp-providers.json"]);
  tamperNote(); tamperRecord("runtime", ["ccapp-settings.json"]);
  const again = []; assert.match(tamperNote(again), /ccapp-settings.json/);
  assert.deepEqual(again, [open.id]);
});
test("model notes describe each source without claiming package restoration for runtime or claude", () => {
  reset(); tamperRecord("runtime", ["ccapp-providers.json"]);
  const runtime = tamperNote(); assert.match(runtime, /current settings/); assert.doesNotMatch(runtime, /installed package/);
  tamperRecord("claude", ["claude"]);
  const claude = tamperNote(); assert.match(claude, /Refused to start/); assert.doesNotMatch(claude, /restored|undone/);
  tamperRecord("app", ["TOOLS.md"]); assert.match(tamperNote(), /installed package/);
  tamperRecord("runtime", ["web/index.html"]); assert.match(tamperNote(), /idle restart/);
  reset(); tamperRecord("app", ["TOOLS.md"]); tamperRecord("claude", ["claude"]); tamperRecord("runtime", ["ccapp-providers.json"]);
  const mixed = tamperNote(); for (const text of [/current settings/, /installed package/, /Refused to start/]) assert.match(mixed, text);
});

const source = fs.readFileSync(new URL("../web/app/04-session-flow.js", import.meta.url), "utf8");
const fragment = source.slice(source.indexOf("  const tamperShown ="), source.indexOf("  // 恢复失败的提示"));
const translate = (s, vars = {}) => s.replace(/\{(\w+)\}/g, (_, key) => vars[key]);
function ui() {
  const notices = [], requests = [];
  const box = { t: translate, console: { warn() {} }, toastAct: (text, label, ack) => notices.push({ text, label, ack }), api: (url, options) => { requests.push({ url, options }); return Promise.resolve(); } };
  vm.createContext(box); vm.runInContext(fragment + "\nthis.show = showTamper;", box);
  return { show: box.show, notices, requests };
}
const event = (src, files, id = 1, at = 1700000000000) => ({ src, files, id, at });
test("UI separates sources and includes original time and only explicit acknowledgment sends API calls", () => {
  const u = ui(), list = [event("runtime", ["ccapp-providers.json"]), event("app", ["TOOLS.md"], 2), event("claude", ["claude"], 3)];
  u.show(list);
  const msg = u.notices[0].text;
  assert.match(msg, /当前设置写回：ccapp-providers.json/);
  assert.match(msg, /安装包还原：TOOLS.md/);
  assert.match(msg, /拒绝启动；claude/);
  assert.ok(msg.includes(new Date(list[0].at).toLocaleString()));
  assert.equal(u.requests.length, 0);
  u.notices[0].ack(); assert.equal(u.requests.length, 3);
  assert.deepEqual(u.requests.map((r) => r.url), [1, 2, 3].map((id) => "/api/tamper/ack?id=" + id));
  assert.ok(u.requests.every((r) => r.options.method === "POST"));
});
test("pending state is labeled historical after reload, repeated state deduplicates, added files and reused ids notify", () => {
  assert.match(source, /showTamper\(s.tamper, true\)/);
  assert.match(source, /case "tamper": return showTamper\(ev.tamper\)/);
  const e = event("runtime", ["ccapp-providers.json"]), u = ui();
  u.show([e], true); assert.match(u.notices[0].text, /待确认记录（非本次刷新产生）/);
  u.show([e], true); u.show([e]); assert.equal(u.notices.length, 1);
  const reload = ui(); reload.show([e], true); assert.match(reload.notices[0].text, /待确认记录/);
  u.show([{ ...e, files: [...e.files, "ccapp-settings.json"] }]); assert.equal(u.notices.length, 2); assert.match(u.notices[1].text, /新记录或新增文件/);
  u.show([{ ...e, at: e.at + 1 }]); assert.equal(u.notices.length, 3);
  u.show([{ ...e, files: ["TOOLS.md"] }]); assert.equal(u.notices.length, 4); assert.match(u.notices[3].text, /已触发保护处理/);
});
test("mixed runtime files retain config writeback and program-protection explanations", () => {
  const u = ui(); u.show([event("runtime", ["ccapp-settings.json", "web/index.html"])]);
  assert.match(u.notices[0].text, /当前设置写回：ccapp-settings.json/);
  assert.match(u.notices[0].text, /已触发保护处理：web\/index.html/);
  assert.doesNotMatch(u.notices[0].text, /安装包还原/);
});
test("new tamper translation keys exist in every registered non-source language, preserving placeholders", () => {
  const box = { window: {} };
  vm.runInNewContext(fs.readFileSync(new URL("../web/langs.js", import.meta.url), "utf8"), box);
  const keys = [...fragment.matchAll(/t\("([^"]+)"/g)].map((m) => m[1]);
  for (const { code } of box.window.I18N_LANGS) {
    if (code === "zh") continue;
    vm.runInNewContext(fs.readFileSync(new URL(`../web/lang-${code}.js`, import.meta.url), "utf8"), box);
    const dict = box.window.I18N_DICT[code];
    for (const key of keys) {
      assert.equal(typeof dict[key], "string", `${code}: ${key}`);
      assert.deepEqual(dict[key].match(/\{\w+\}/g) || [], key.match(/\{\w+\}/g) || [], `${code}: ${key}`);
    }
  }
});
