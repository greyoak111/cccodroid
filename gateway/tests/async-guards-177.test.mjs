// 面板 / 文件 / 仓库换了之后迟到的回执（#177）：跑界面里真正的函数，外部依赖用桩
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const read = (f) => fs.readFileSync(new URL("../web/app/" + f, import.meta.url), "utf8");
const take = (src, start, end) => { const a = src.indexOf(start), b = src.indexOf(end, a); assert.ok(a >= 0 && b > a, start); return src.slice(a, b); };
const later = () => { let ok; const p = new Promise((r) => { ok = r; }); return { p, ok }; };
const el = () => ({ classList: { add() {}, remove() {}, contains: () => false, toggle() {} }, innerHTML: "", querySelector: () => null });

test("终端：打开途中收起面板，迟到的列表回执不再建终端；收起后重开照常建", async () => {
  const term = read("18-terminal.js");
  const calls = [], gate = later();
  const box = {
    Map, Set, Promise, calls, toast() {}, t: (k) => k, MO: { cancel() {}, hide() {}, paneOut() {} }, termEl: el(), raisePane() {},
    $: () => ({ ...el(), clientWidth: 0 }), termDetach() {}, renderTermTabs() {}, showTerm: (id) => calls.push("show:" + id),
    loadXterm: async () => {},
    api: async (u) => { if (u === "/api/term/list") { await gate.p; return { available: true, terms: [] }; } calls.push("new"); return { term: { id: "T" + calls.length, alive: true } }; },
  };
  vm.runInNewContext("const TERM = { list: [], cur: null, inst: new Map(), gen: 0 };\n" +
    take(term, "  function openTerm(", "  /** 手动登录") + take(term, "  async function newTerm(", "  function renderTermTabs(") +
    "\nglobalThis.f = { openTerm, closeTerm, TERM };", box);
  const p1 = box.f.openTerm();
  box.f.closeTerm();
  gate.ok();
  await p1;
  assert.deepEqual([...calls], [], "收起后迟到的回执：不建、不连");
  await box.f.openTerm();
  assert.deepEqual([...calls], ["new", "show:T1"]);
});

test("HTML 预览：先发的那次迟到了也不挂第二个定时器，不拆后来的预览", async () => {
  const v = read("16-viewer-git.js");
  const gates = [], timers = new Set();
  let nextId = 1;
  const body = el();
  const box = {
    VW: { path: "/a.html", mode: "", pvSeq: 0 }, URL, t: (k) => k, esc: (s) => s,
    $: () => body, viewerEl: el(), vwDropEd() {}, vwRenderActs() {}, pvNative() {}, pvSrc: () => "u", document: { hidden: false },
    post: () => { const g = later(); gates.push(g); return g.p; },
    setInterval: () => { const id = nextId++; timers.add(id); return id; }, clearInterval: (id) => timers.delete(id),
  };
  vm.runInNewContext(take(v, "  async function vwHtml()", "  // 开发者工具（Eruda）") + take(v, "  function vwHtmlStop()", "  // 不联网（默认）") +
    "\nglobalThis.f = { vwHtml, vwHtmlStop };", box);
  const a = box.f.vwHtml();
  box.VW.mode = "text"; box.f.vwHtmlStop();          // 切到源码
  const b = box.f.vwHtml();                           // 再点预览
  gates[1].ok({ url: "http://x/cap/a.html", mtime: 1 }); await b;
  gates[0].ok({ url: "http://x/cap/a.html", mtime: 1 }); await a;
  assert.equal(timers.size, 1, "只有后来那次的定时器");
});

test("Git 同步：忙碌状态按仓库记，A 在推送时 B 的按钮照常可用", () => {
  const v = read("16-viewer-git.js");
  const bar = { classList: { add() {}, remove() {} }, innerHTML: "" };
  const box = { Map, GIT: { dir: "/b", status: { branch: "main", upstream: "origin/main" } }, $: () => bar, t: (k) => k, esc: (s) => s, gbdi: (s) => s };
  vm.runInNewContext(take(v, "  const GIT_BUSY = new Map();", "  $(\"git-sync\").addEventListener") + "\nglobalThis.f = { GIT_BUSY, gitSyncBar };", box);
  box.f.GIT_BUSY.set("/a", "push");
  box.f.gitSyncBar();
  assert.doesNotMatch(bar.innerHTML, /disabled/);
  box.GIT.dir = "/a"; box.f.gitSyncBar();
  assert.match(bar.innerHTML, /data-a="fetch" disabled/);
});
