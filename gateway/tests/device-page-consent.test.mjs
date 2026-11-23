import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const read = (name) => fs.readFileSync(new URL("../web/app/" + name, import.meta.url), "utf8");
const menus = read("13-nav-menus.js");
const device = read("10-settings-device.js");
const selectCode = menus.slice(menus.indexOf("  const selectionChangesFromUser"), menus.indexOf("  // 捕获阶段拦住"));
const ticketCode = device.slice(device.indexOf("  function deviceConsentTicket"), device.indexOf('  $("dev-on").addEventListener'));

test("only a user-selected custom menu change can reuse page authentication", () => {
  let choose, visible = true;
  const requests = [];
  const menu = {
    style: {},
    querySelector: () => null,
    addEventListener: (_type, callback) => { choose = callback; },
  };
  class ChangeEvent {
    constructor(type) { this.type = type; this.isTrusted = false; }
  }
  const ctx = {
    document: { createElement: () => menu },
    Event: ChangeEvent,
    CHECK: "", MM_IMG: () => "", esc: (s) => s,
    OV: { open() {}, close() {} },
    getComputedStyle: () => ({ direction: "ltr" }),
    innerWidth: 400, innerHeight: 800, moOrigin() {},
    setVisible: (page) => visible && page === "device",
    window: { CCApp: {
      deviceConsentTicket: (...args) => { requests.push(args); return "issued"; },
    } },
  };
  const { selMenu, deviceConsentTicket } = vm.runInNewContext(
    selectCode + ticketCode + "\n({ selMenu, deviceConsentTicket })", ctx,
  );
  const select = {
    children: [{ tagName: "OPTION", value: "auto", textContent: "auto" }],
    getBoundingClientRect: () => ({ width: 100, left: 20, right: 120, top: 40, bottom: 80 }),
    dispatchEvent(event) {
      if (event.type === "change") deviceConsentTicket(event, "dev_set", "0:" + this.value);
    },
  };
  selMenu(select);
  const button = { closest: () => ({ dataset: { i: "0" } }) };
  choose({ isTrusted: true, target: button });
  assert.deepEqual(requests, [["dev_set", "0:auto"]]);
  choose({ isTrusted: false, target: button });
  select.dispatchEvent(new ChangeEvent("change"));
  visible = false;
  choose({ isTrusted: true, target: button });
  assert.equal(requests.length, 1);
});
