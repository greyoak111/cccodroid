// 第二份稳定性报告 i 组：BUG-G01（页面重建后从项目 B 打开终端，却只显示目录 A 的旧终端）。
// 跑 web/app 里真正的 openTerm / newTerm / openTermAt，外部依赖用桩。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const read = (f) => fs.readFileSync(new URL("../web/app/" + f, import.meta.url), "utf8");
const take = (src, start, end) => { const a = src.indexOf(start), b = src.indexOf(end, a); assert.ok(a >= 0 && b > a, start); return src.slice(a, b); };
const el = () => ({
  classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
  innerHTML: "", textContent: "", clientWidth: 0, clientHeight: 0,
  appendChild() {}, querySelector: () => null, querySelectorAll: () => [],
});

function termBox(serverTerms) {
  const calls = [];
  const box = {
    Map, Set, Promise, JSON, console,
    TERM: { list: [], cur: null, inst: new Map(), gen: 0, font: 13 },
    MO: { cancel() {}, hide() {}, paneOut() {} },
    termEl: el(),
    raisePane() {},
    $: () => el(),
    loadXterm: async () => {},
    toast() {},
    t: (k) => k,
    renderTermTabs() {},
    showTerm: (id) => calls.push("show:" + id),
    termDetach() {},
    calls,
    api: async (u, o) => {
      if (u === "/api/term/list") return { available: true, terms: serverTerms.map((x) => ({ ...x })) };
      calls.push({ url: u, body: o && o.body ? JSON.parse(o.body) : null });
      return { term: { id: "B", alive: true, title: "bash B" } };
    },
  };
  const term = read("18-terminal.js"), proj = read("14-projects-sched.js");
  vm.runInNewContext(
    take(term, "  function openTerm(", "  /** 手动登录") +
    take(term, "  async function newTerm(", "  function renderTermTabs(") +
    take(proj, "  async function openTermAt(", "  // ── 弹层") +
    "\nglobalThis.f = { openTerm, openTerm0, newTerm, openTermAt, TERM };", box);
  return box;
}
const newCalls = (calls) => calls.filter((c) => c && c.url === "/api/term/new");

test("BUG-G01：页面重建后从项目 B 打开终端，必须在同步之后兑现目录 B（不能只显示 A）", async () => {
  const box = termBox([{ id: "A", alive: true, title: "bash A" }]);
  await box.f.openTermAt("/proj/b");
  const created = newCalls(box.calls);
  assert.equal(created.length, 1, "没有按显式目录新建终端：" + JSON.stringify(box.calls));
  assert.equal(created[0].body.cwd, "/proj/b");
  assert.equal(box.TERM.cur, "B");
  assert.ok(box.calls.includes("show:B"));
});

test("BUG-G01：本地列表准确（已有 A 的终端）时，从项目 B 打开仍在 B 新建一个", async () => {
  const box = termBox([{ id: "A", alive: true, title: "bash A" }]);
  box.TERM.list = [{ id: "A", alive: true, title: "bash A" }];
  await box.f.openTermAt("/proj/b");
  const created = newCalls(box.calls);
  assert.equal(created.length, 1, "已有活终端时没有另开目录 B：" + JSON.stringify(box.calls));
  assert.equal(created[0].body.cwd, "/proj/b");
});

test("BUG-G01：服务端一个终端都没有时，第一个直接开在目标目录（195-H.6 不变）", async () => {
  const box = termBox([]);
  await box.f.openTermAt("/proj/b");
  const created = newCalls(box.calls);
  assert.equal(created.length, 1);
  assert.equal(created[0].body.cwd, "/proj/b");
});

test("BUG-G01：顶栏入口不带目录时仍只显示已有终端，不新建", async () => {
  const box = termBox([{ id: "A", alive: true, title: "bash A" }]);
  await box.f.openTerm();
  assert.equal(newCalls(box.calls).length, 0, JSON.stringify(box.calls));
  assert.deepEqual(box.calls, ["show:A"]);
});
