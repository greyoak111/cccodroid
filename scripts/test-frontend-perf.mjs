#!/usr/bin/env node
// Optional: node scripts/test-frontend-perf.mjs. Node built-ins + an installed Chromium only.
// Synthetic APIs and workbooks, no gateway/user config/model traffic. GPU off; not WebView/IME acceptance.
// PASS 只代表结构验收 + 一条宽松性能门槛（openMs < 5000ms），不是真机的流畅度/帧率/GPU/输入法结论。
// Synthetic APIs and workbooks, no gateway/user config/model traffic. GPU off; not WebView/IME acceptance.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { startFrontendPerfServer } from "../gateway/tests/fixtures/frontend-perf-server.mjs";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 15000) {
  const end = Date.now() + timeout; let value;
  while (Date.now() < end) { value = await fn(); if (value) return value; await sleep(40); }
  throw new Error("Timeout: " + label + "; last value=" + JSON.stringify(value));
}
class CDP {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map(); this.handlers = new Map(); this.closed = false;
    ws.addEventListener("message", ({ data }) => {
      const m = JSON.parse(data);
      if (m.id) {
        const p = this.pending.get(m.id); if (!p) return;
        this.pending.delete(m.id); clearTimeout(p.timer);
        m.error ? p.reject(new Error(p.method + ": " + m.error.message)) : p.resolve(m.result);
      } else for (const fn of this.handlers.get(m.method) || []) fn(m.params);
    });
    ws.addEventListener("close", () => this.clear());
  }
  clear() { this.closed = true; this.handlers.clear(); for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("CDP closed")); } this.pending.clear(); }
  on(type, fn) { const list = this.handlers.get(type) || []; list.push(fn); this.handlers.set(type, list); }
  call(method, params = {}) {
    if (this.closed) return Promise.reject(new Error("CDP closed"));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("CDP timeout: " + method)); }, 30000);
      this.pending.set(id, { resolve, reject, timer, method }); this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  }
}
function browserSetup() {
  localStorage.setItem("ccapp.lang", "zh"); localStorage.setItem("cc.motion", "off");
  window.__fixtureErrors = [];
  addEventListener("error", e => __fixtureErrors.push(Date.now() + ":" + e.message));
  addEventListener("unhandledrejection", e => __fixtureErrors.push(Date.now() + ":" + String(e.reason?.message || e.reason)));
  const Native = Worker;
  const stats = window.__sheetStats = { created: 0, terminated: 0, active: 0, detached: [], maxReply: 0 };
  window.Worker = class extends Native {
    constructor(url, options) { super(url, options); this.finished = false; stats.created++; stats.active++; this.addEventListener("message", e => { stats.maxReply = Math.max(stats.maxReply, JSON.stringify(e.data).length); }); }
    postMessage(data, transfer) { super.postMessage(data, transfer); if (data.op === "load") stats.detached.push(data.buffer.byteLength); }
    terminate() { if (!this.finished) { this.finished = true; stats.active--; stats.terminated++; } super.terminate(); }
  };
}

const base = process.env.TMPDIR || path.join(os.homedir(), ".cache");
await fs.mkdir(base, { recursive: true });
const lock = path.join(base, "cccodroid-managed-ui-chromium.lock");
try { await fs.mkdir(lock); } catch (e) { if (e.code === "EEXIST") throw new Error("Another optional Chromium acceptance holds " + lock); throw e; }
const tmp = await fs.mkdtemp(path.join(base, "fp-"));
let fixture, browser, cdp, stderr = "", launchError, loads = 0;
const errors = [], blocked = [], checks = [];
async function navigate(url) {
  const before = loads;
  await cdp.call("Page.navigate", { url });
  await until(() => loads > before, "fixture page load");
}
const check = (name, value, detail = {}) => { assert.ok(value, name + " " + JSON.stringify(detail)); checks.push({ name, ...detail }); console.log("PASS " + name); };
const evaluate = fn => cdp.eval("(" + fn.toString() + ")()");
const click = selector => cdp.eval("document.querySelector(" + JSON.stringify(selector) + ").click()");
async function openSession(sid, expected) {
  await cdp.eval("__cc.openSession(" + JSON.stringify(sid) + ")");
  await until(() => cdp.eval("document.querySelector('#hist .tg-head')?.textContent.includes(" + JSON.stringify(String(expected)) + ")"), "history " + sid);
}
try {
  fixture = await startFrontendPerfServer();
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CCAPP_|CLAUDE_CODE_|ANTHROPIC_)/.test(k)));
  const profile = path.join(tmp, "p");
  browser = spawn(process.env.CHROMIUM_BIN || "chromium-headless", [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-zygote",
    "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", "--user-data-dir=" + profile,
    "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update",
    "--disable-sync", "--disable-default-apps", "--disable-extensions", "--no-proxy-server", "--metrics-recording-only",
    "--disable-domain-reliability", "--disable-client-side-phishing-detection", "--password-store=basic", "--use-mock-keychain",
    "--disable-features=Translate,MediaRouter,OptimizationHints,OptimizationGuideModelDownloading,AutofillServerCommunication",
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1", "--window-size=1365,900", "about:blank",
  ], { env: { ...clean, HOME: tmp, TMPDIR: tmp }, stdio: ["ignore", "ignore", "pipe"], detached: true });
  browser.on("error", e => { launchError = e; }); browser.stderr.on("data", b => { stderr = (stderr + b).slice(-6000); });
  const port = await until(async () => {
    if (launchError) throw launchError; if (browser.exitCode !== null) throw new Error("Chromium exited: " + stderr);
    try { return Number((await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]); } catch { return false; }
  }, "Chromium startup");
  const targets = await (await fetch("http://127.0.0.1:" + port + "/json/list")).json();
  const ws = new WebSocket(targets.find(t => t.type === "page").webSocketDebuggerUrl); await once(ws, "open"); cdp = new CDP(ws);
  cdp.on("Runtime.exceptionThrown", ({ exceptionDetails: d }) => errors.push(d.exception?.description || d.text));
  cdp.on("Page.loadEventFired", () => { loads++; });
  cdp.on("Fetch.requestPaused", ({ requestId, request }) => {
    const u = new URL(request.url);
    if (u.origin === fixture.origin || ["data:", "blob:"].includes(u.protocol)) cdp.call("Fetch.continueRequest", { requestId }).catch(() => {});
    else { blocked.push(request.url); cdp.call("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }).catch(() => {}); }
  });
  cdp.on("Page.javascriptDialogOpening", () => cdp.call("Page.handleJavaScriptDialog", { accept: true }).catch(() => {}));
  await cdp.call("Runtime.enable"); await cdp.call("Page.enable"); await cdp.call("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
  await cdp.call("Emulation.setDeviceMetricsOverride", { width: 1365, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.call("Page.addScriptToEvaluateOnNewDocument", { source: "(" + browserSetup.toString() + ")();" });
  await navigate(fixture.origin + "/");
  await until(() => cdp.eval("!!(window.__cc?.srv.connected && __cc.state.sessions.length)"), "real app boot");
  const booted = await cdp.eval("!!(window.__cc?.srv.connected && __cc.state.sessions.length)");
  check("real app boots using only synthetic loopback APIs", booted && blocked.length === 0, { chromium: await cdp.eval("navigator.userAgent.match(/Chrome\\/([\\d.]+)/)?.[1]"), blocked });

  await openSession("synthetic-tools", 760);
  check("760-step folded group creates no full card tree", await cdp.eval("document.querySelectorAll('#hist .tool').length <= 1"));
  await click("#hist .tg-head");
  const history = await evaluate(() => {
    const seen = new Set(), group = document.querySelector("#hist .tgroup"); let maxCards = 0;
    for (let i = 0; i < 22; i++) {
      const rows = group.querySelectorAll(".tool"); maxCards = Math.max(maxCards, rows.length);
      rows.forEach(row => seen.add(row.querySelector(".tool-arg").textContent));
      const older = group.querySelector(".tg-page"); if (older.hidden) break; older.click();
    }
    return { reachable: seen.size, maxCards };
  });
  check("all 760 steps remain reachable with forty-card windows", history.reachable === 760 && history.maxCards === 40, history);
  const live = await evaluate(() => {
    __cc.bus({ type: "run_start", runId: "synthetic-run", sessionId: "synthetic-tools", startedAt: Date.now(), text: "Synthetic live" });
    __cc.bus({ type: "tool_result", runId: "synthetic-run", id: "pre-result", ok: false, text: "Result before invocation" });
    __cc.bus({ type: "tool_use", runId: "synthetic-run", id: "pre-result", name: "Read", input: { path: "/synthetic/first" } });
    for (let i = 0; i < 180; i++) {
      __cc.bus({ type: "tool_use", runId: "synthetic-run", id: "live-" + i, name: "Read", input: { path: "/synthetic/" + i } });
      __cc.bus({ type: "tool_result", runId: "synthetic-run", id: "live-" + i, ok: true, text: "Done" });
    }
    return [...document.querySelectorAll("#live .tool.open .tool-body")].some(el => el.textContent.includes("Result before invocation") && el.getClientRects().length);
  });
  check("result-before-invocation failure remains exposed after group growth", live);
  await evaluate(() => {
    __cc.bus({ type: "tool_use", runId: "synthetic-run", id: "parent", name: "Agent", input: { prompt: "Synthetic" } });
    for (let i = 0; i < 80; i++) __cc.bus({ type: "tool_use", runId: "synthetic-run", parent: "parent", id: "nested-" + i, name: "Read", input: { path: "/synthetic/child-" + i } });
    __cc.bus({ type: "perm_request", runId: "synthetic-run", id: "old-child-perm", toolUseId: "nested-5", tool: "Read", input: { path: "/synthetic/old-child-confirm" } });
    __cc.bus({ type: "tool_use", runId: "synthetic-run", parent: "parent", id: "new-child", name: "Read", input: { path: "/synthetic/new-child" } });
    __cc.bus({ type: "perm_request", runId: "synthetic-run", id: "new-child-perm", toolUseId: "new-child", tool: "Read", input: { path: "/synthetic/new-child-confirm" } });
  });
  const nested = await evaluate(() => [...document.querySelectorAll("#live .tool-sub .perm")].filter(el => el.getClientRects().length).length);
  check("old and newly-created nested permission cards reveal their exact steps", nested === 2, { nested });
  const lateChild = await evaluate(() => {
    __cc.bus({ type: "tool_use", runId: "synthetic-run", id: "late-parent", name: "Agent", input: { prompt: "Synthetic late child parent" } });
    __cc.bus({ type: "tool_use", runId: "synthetic-run", parent: "late-parent", id: "late-child", name: "Read", input: { path: "/synthetic/late-child" } });
    const group = document.querySelector("#live .tgroup"), newer = [...group.querySelectorAll(".tg-page")].at(-1);
    for (let i = 0; i < 10 && !newer.hidden; i++) newer.click();
    const parent = [...document.querySelectorAll("#live .tool")].find(el => el.querySelector(".tool-arg")?.textContent === "Synthetic late child parent");
    parent.querySelector(".ts-head").click();
    const child = parent.querySelector(".tool-sub .tool");
    for (let i = 0; i < 60; i++) __cc.bus({ type: "tool_use", runId: "synthetic-run", id: "after-child-" + i, name: "Read", input: { path: "/synthetic/after-child-" + i } });
    const parked = !parent.isConnected && !child.isConnected;
    __cc.bus({ type: "tool_result", runId: "synthetic-run", id: "late-child", ok: false, text: "Synthetic late child failure" });
    const visible = child.isConnected && !!child.querySelector(".tool-body").getClientRects().length && child.textContent.includes("Synthetic late child failure");
    child.querySelector(".tool-head").click();
    __cc.bus({ type: "tool_use", runId: "synthetic-run", id: "after-dismiss", name: "Read", input: {} });
    return { parked, visible, released: !parent.isConnected };
  });
  check("late nested failure remounts a parked parent and dismissing it releases the page exception", lateChild.parked && lateChild.visible && lateChild.released, lateChild);

  for (const outcome of ["success", "failure"]) {
    fixture.state.agentHold = true; fixture.state.agentFailure = outcome === "failure";
    await openSession("synthetic-loader-" + outcome, 100);
    const previousCalls = fixture.state.agentCalls;
    await evaluate(() => { const g = document.querySelector("#hist .tgroup"); if (!g.classList.contains("open")) g.querySelector(".tg-head").click(); window.__agent = g.querySelector(".tool"); __agent.querySelector(".ts-head").click(); });
    await until(() => fixture.state.agentCalls > previousCalls && cdp.eval("__agent.querySelector('.ts-now').textContent.includes('加载中')"), "agent read starts");
    const before = fixture.state.agentCalls;
    await click("#hist .tg-page");
    check(outcome + " agent card is temporarily parked while request is in flight", await cdp.eval("!__agent.isConnected"));
    fixture.releaseAgents();
    await until(() => cdp.eval("!__agent.querySelector('.ts-now').textContent.includes('加载中')"), outcome + " agent response settled");
    await click("#hist .tg-page:last-child");
    check(outcome + " paging restores the identical agent node", await cdp.eval("__agent === document.querySelector('#hist .tg-entry .tool')"));
    fixture.state.agentFailure = false;
    await evaluate(() => { const button = __agent.querySelector(".ts-head"); button.click(); button.click(); });
    await until(() => fixture.state.agentCalls === before + 1, "parked agent retry"); fixture.releaseAgents();
    await until(() => cdp.eval("[...document.querySelectorAll('#hist .tool-sub .tool-arg')].some(e => e.textContent.includes('/synthetic/loaded'))"), "agent child response");
    const retried = await cdp.eval("[...document.querySelectorAll('#hist .tool-sub .tool-arg')].some(e => e.textContent.includes('/synthetic/loaded')) && ![...document.querySelectorAll('#hist .ts-now')].some(e => e.textContent.includes('加载中'))");
    check(outcome + " parked response leaves a functioning retry loader", retried);
  }
  fixture.state.agentHold = true;
  await openSession("synthetic-loader-dispose", 100);
  const disposeCalls = fixture.state.agentCalls;
  await evaluate(() => { const g = document.querySelector("#hist .tgroup"); if (!g.classList.contains("open")) g.querySelector(".tg-head").click(); g.querySelector(".ts-head").click(); });
  await until(() => fixture.state.agentCalls > disposeCalls && cdp.eval("document.querySelector('#hist .ts-now')?.textContent.includes('加载中')"), "disposed agent request starts");
  const disposeReplies = fixture.state.agentReplies;
  await cdp.eval("__cc.openSession('synthetic-replacement')");
  await until(() => cdp.eval("__cc.view.sessionId === 'synthetic-replacement' && __cc.view.histOk === true"), "replacement session history reset");
  fixture.releaseAgents();
  await until(() => fixture.state.agentReplies > disposeReplies, "late agent response delivered");
  await evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  check("late agent response cannot revive a reset history tree", await cdp.eval("!document.querySelector('#hist .tool-sub .tool')"));
  fixture.state.agentHold = false;

  await cdp.eval("__cc.openPage('sessions')");
  await until(() => cdp.eval("document.querySelectorAll('#session-list .srow-sess').length === 150"), "visible session rows");
  const hidden = await evaluate(() => {
    __cc.openSession("synthetic-replacement");
    const list = document.getElementById("session-list"), node = list.firstElementChild;
    for (let i = 0; i < 6; i++) __cc.bus({ type: "state", runs: [], queue: [], interrupted: [] });
    return { same: node === list.firstElementChild, hidden: !list.getClientRects().length };
  });
  check("hidden session-page updates retain the original DOM", hidden.same && hidden.hidden, hidden);

  const excel = await evaluate(async () => {
    let ticks = 0; const beat = setInterval(() => ticks++, 16);
    const at = performance.now(); await __cc.openViewer("/synthetic/100k.xlsx", "sheet", 0); clearInterval(beat);
    return { ticks, openMs: performance.now() - at, cells: document.querySelectorAll(".vw-grid td").length, mainXLSX: typeof window.XLSX, stats: structuredClone(__sheetStats) };
  });
  check("100k-cell workbook parses in a real Worker without loading XLSX on the page", excel.ticks > 0 && excel.mainXLSX === "undefined" && excel.stats.detached.at(-1) === 0, excel);
  check("Excel first page and Worker reply remain bounded", excel.cells === 1200 && excel.stats.maxReply < 300 * 1024, { cells: excel.cells, reply: excel.stats.maxReply });
  await click(".vw-more"); await until(() => cdp.eval("document.querySelectorAll('.vw-grid td').length === 2400"), "Excel second page");
  await click('.vw-grid td[data-a="A13"]'); await until(() => cdp.eval("document.querySelector('.vw-cellbar').textContent.includes('Cell 12:0')"), "Excel original cell detail");
  check("Excel pagination retains original addresses and values", await cdp.eval("document.querySelector('.vw-cellbar').textContent.includes('A13')"));
  // 宽松门槛：只证明结构验收不可能带着卡死的打开通过；不是帧率结论。
  check("100k-cell workbook opens under the loose 5s structural budget", excel.openMs < 5000, { openMs: Math.round(excel.openMs) });
  await click("#vw-close"); await until(() => cdp.eval("__sheetStats.active === 0 && document.querySelector('#viewer').classList.contains('hidden')"), "Excel normal close");
  // 关闭取消下载：下载挂在服务端不放行，先证 Worker 真的建了、请求真的在途，再点关闭等 abort 事件，不靠 sleep。
  const closeBefore = await cdp.eval("({ ...__sheetStats })"), closeAborts = fixture.state.fileAborts, closeScripts = fixture.state.officeScripts;
  fixture.state.fileHold = true;
  await evaluate(() => { __cc.openViewer("/synthetic/100k.xlsx", "sheet", 0); });
  await until(() => fixture.state.held.length === 1 && fixture.state.filePending === 1, "held workbook download in flight");
  await until(() => cdp.eval("__sheetStats.created === " + (closeBefore.created + 1) + " && __sheetStats.active === 1"), "delayed workbook worker start");
  // Worker 的三个脚本全部送达才算就绪；脚本加载中被 close 截断会报 NetworkError（Worker 内 importScripts 失败）
  await until(() => fixture.state.officeScripts >= closeScripts + 3, "held workbook worker scripts delivered");
  await click("#vw-close");
  await until(() => fixture.state.fileAborts > closeAborts && fixture.state.held[0]?.aborted, "held download aborted by close");
  await until(() => cdp.eval("__sheetStats.active === 0"), "canceled workbook worker terminated");
  fixture.state.fileHold = false; fixture.state.held.length = 0;
  check("Excel close cancels a held download without retaining a Worker",
    await cdp.eval("__sheetStats.active === 0 && __sheetStats.created === " + (closeBefore.created + 1) + " && __sheetStats.terminated === " + (closeBefore.terminated + 1)));

  // 迟到响应：旧下载挂在服务端，替换文档正常完成，再放行旧响应。服务器必须观察到真实 abort，屏幕上的必须是替换文档。
  const lateBefore = await cdp.eval("({ ...__sheetStats })"), lateScripts = fixture.state.officeScripts;
  fixture.state.fileHold = true;
  await evaluate(() => { __cc.openViewer("/synthetic/100k.xlsx", "sheet", 0); });
  await until(() => fixture.state.held.length === 1 && fixture.state.filePending === 1, "old workbook download held");
  await until(() => cdp.eval("__sheetStats.created === " + (lateBefore.created + 1) + " && __sheetStats.active === 1"), "old workbook worker start");
  // 替换文档会 terminate 旧 Worker：等旧 Worker 脚本全部送达后再换，避免截断在途 importScripts
  await until(() => fixture.state.officeScripts >= lateScripts + 3, "old workbook worker scripts delivered");
  fixture.state.fileHold = false;
  await evaluate(() => { __cc.openViewer("/synthetic/replacement.xlsx", "sheet", 0); });
  await until(() => cdp.eval("document.querySelector('.vw-grid')?.textContent.includes('Replacement workbook')"), "replacement workbook");
  await until(() => fixture.state.held[0]?.aborted, "old workbook request aborted by replacement open");
  await until(() => cdp.eval("__sheetStats.active === 1 && __sheetStats.terminated === " + (lateBefore.terminated + 1)), "only replacement workbook worker remains");
  fixture.releaseFiles();
  await until(() => fixture.state.held[0]?.released, "held old response released");
  await evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  check("late workbook response never overwrites a replacement document",
    await cdp.eval("__sheetStats.active === 1 && __sheetStats.created === " + (lateBefore.created + 2) + " && document.querySelector('#vw-name').textContent === 'replacement.xlsx' && document.querySelector('.vw-grid')?.textContent.includes('Replacement workbook')"));
  fixture.state.held.length = 0;

  // 直接隐藏：先证 Worker 活着，再断言被回收（不是 0 === 0 的假通过）。
  const hideBefore = await cdp.eval("({ ...__sheetStats })");
  check("replacement workbook Worker is live before direct hiding", hideBefore.active === 1 && hideBefore.created > hideBefore.terminated, hideBefore);
  await evaluate(() => document.getElementById("viewer").classList.add("hidden"));
  await until(() => cdp.eval("__sheetStats.active === 0"), "idle hidden workbook cleanup");
  await until(() => cdp.eval("__sheetStats.terminated === " + (hideBefore.terminated + 1)), "hidden workbook worker terminated");
  check("direct viewer hiding terminates the idle parsed workbook",
    await cdp.eval("__sheetStats.active === 0 && __sheetStats.created === __sheetStats.terminated"));

  const repeatBefore = await cdp.eval("({ ...__sheetStats })");
  for (let i = 0; i < 3; i++) {
    const before = await cdp.eval("({ ...__sheetStats })");
    await evaluate(() => __cc.openViewer("/synthetic/replacement.xlsx", "sheet", 0));
    await until(() => cdp.eval("__sheetStats.created === " + (before.created + 1) + " && __sheetStats.active === 1"), "repeated workbook worker start " + i);
    // 等到 Worker 真的 postMessage(load)：脚本和 importScripts 都已加载完，close 才不会截断在途脚本加载
    await until(() => cdp.eval("__sheetStats.detached.length === " + (before.detached.length + 1)), "repeated workbook worker load posted " + i);
    await click("#vw-close");
    await until(() => cdp.eval("__sheetStats.active === 0 && document.querySelector('#viewer').classList.contains('hidden')"), "repeated Excel close " + i);
    await until(() => cdp.eval("__sheetStats.terminated === " + (before.terminated + 1)), "repeated workbook worker terminate " + i);
  }
  check("repeated workbook open/close drains every Worker",
    await cdp.eval("__sheetStats.created === __sheetStats.terminated && __sheetStats.active === 0 && __sheetStats.created === " + (repeatBefore.created + 3)));
  check("complete app has no hidden initialization or rejected-promise errors", await cdp.eval("__fixtureErrors.length === 0"));

  for (const n of [100, 1000]) {
    await navigate(fixture.origin + "/__fixture/map.html");
    await until(() => cdp.eval("!!window.CCLineageMap"), "map module"); await cdp.eval("__boot(" + n + ")");
    await evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const select = await evaluate(() => {
      const svg = document.querySelector(".lm-main svg"), before = { ...__counts };
      __map.select("s2"); __map.select("s20"); __map.select(null);
      return { same: svg === document.querySelector(".lm-main svg"), layouts: __counts.layout - before.layout, scenes: __counts.scene - before.scene };
    });
    check(n + " map selections retain SVG and cached geometry", select.same && select.layouts === 0 && select.scenes === 0, select);
    const invalidation = await evaluate(() => {
      const svg = document.querySelector(".lm-main svg"), before = __counts.layout;
      __map.set(structuredClone(__model)); const same = svg === document.querySelector(".lm-main svg") && before === __counts.layout;
      __model.sessions[2].title = "Updated synthetic title"; __map.set(__model);
      return { same, invalidated: svg !== document.querySelector(".lm-main svg") && __counts.layout === before + 1, title: document.querySelector('.lm-main [data-lineage-label="s2"]').textContent };
    });
    check(n + " map equal-value set reuses geometry and in-place changes invalidate it", invalidation.same && invalidation.invalidated && invalidation.title.includes("Updated synthetic title"), invalidation);
    const preview = await evaluate(async () => {
      __map.pick(["s2"]); const cv = document.querySelector(".lm-canvas"), path = document.querySelector('[data-lineage-id="s2"] [data-picked] path'), circle = document.querySelector('[data-lineage-id="s2"] [data-picked] circle');
      const p = path.getBoundingClientRect().width, c = circle.getBoundingClientRect().width, svg = document.querySelector(".lm-main svg"), before = { ...__counts };
      for (let i = 0; i < 30; i++) cv.dispatchEvent(new WheelEvent("wheel", { clientX: 400, deltaY: -1, ctrlKey: true, bubbles: true, cancelable: true }));
      await new Promise(resolve => requestAnimationFrame(resolve));
      const value = { same: svg === document.querySelector(".lm-main svg"), layouts: __counts.layout - before.layout, scenes: __counts.scene - before.scene, pathScale: path.getBoundingClientRect().width / p, ringScale: circle.getBoundingClientRect().width / c };
      await __waitFor(() => __counts.layout === before.layout + 1, "zoom commit"); value.committed = __counts.layout - before.layout;
      value.k = __map.state().k; __map.pick(null); return value;
    });
    check(n + " map wheel burst previews existing SVG and commits one layout", preview.same && preview.layouts === 0 && preview.scenes === 0 && preview.committed === 1, preview);
    check(n + " map picked ring and check keep their screen width", Math.abs(preview.pathScale - 1) < .02 && Math.abs(preview.ringScale - 1) < .02, preview);
    const pinch = await evaluate(async () => {
      const cv = document.querySelector(".lm-canvas"), svg = document.querySelector(".lm-main svg"), before = __counts.layout;
      const send = (type, id, x) => cv.dispatchEvent(new PointerEvent(type, { pointerId: id, clientX: x, clientY: 200, button: 0, pointerType: "touch", bubbles: true }));
      send("pointerdown", 1, 300); send("pointerdown", 2, 500);
      for (let i = 0; i < 20; i++) send("pointermove", 2, 500 + i * 3);
      await new Promise(resolve => requestAnimationFrame(resolve));
      const same = svg === document.querySelector(".lm-main svg"), previewLayouts = __counts.layout - before;
      send("pointerup", 2, 557); send("pointerup", 1, 300);
      return { same, previewLayouts, commits: __counts.layout - before };
    });
    check(n + " map pinch reuses the graph and commits once", pinch.same && pinch.previewLayouts === 0 && pinch.commits === 1, pinch);
    const home = await evaluate(async () => {
      __map.home(); await __waitFor(() => __raf.size === 0, "home animation");
      const cv = document.querySelector(".lm-canvas"), expected = __map.state().W;
      cv.dispatchEvent(new WheelEvent("wheel", { clientX: 400, deltaY: 80, ctrlKey: true, bubbles: true, cancelable: true }));
      __map.home(); await __waitFor(() => __raf.size === 0, "home animation after wheel"); const state = __map.state();
      return { state, expected, valid: state.tx >= Math.min(0, cv.clientWidth - expected) - .1 && state.tx <= .1 };
    });
    check(n + " map home exits uncommitted zoom with exact width and valid bounds", home.state.k === 1 && home.state.W === home.expected && home.valid, home);
    const snapshot = await evaluate(() => {
      const before = JSON.stringify(__map.state()), geo = __map.__geometry(), svg = __map.snapshot(), after = __map.__geometry();
      return { stable: before === JSON.stringify(__map.state()) && geo.AX === after.AX && geo.L === after.L && geo.geo === after.geo, complete: svg.svg.includes("Synthetic session 0") && svg.svg.includes("Synthetic session " + (__model.sessions.length - 1)), vars: svg.svg.includes("--lm-"), picked: svg.svg.includes("data-picked") };
    });
    check(n + " map snapshot is complete and does not contaminate live geometry", snapshot.stable && snapshot.complete && !snapshot.vars && !snapshot.picked, snapshot);
    const tree = await evaluate(async () => {
      const root = document.getElementById("map"); root.style.width = "400px";
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const row = document.querySelector('.lm-trow[data-id="s2"]');
      __map.select("s2"); __map.pick(["s2"], null, ["s4"]);
      return { mode: __map.state().mode, same: row === document.querySelector('.lm-trow[data-id="s2"]'), pick: __map.state().pick };
    });
    check(n + " narrow tree selection and pick retain existing rows", tree.mode === "tree" && tree.same && tree.pick.includes("s2"), tree);
    await evaluate(async () => { document.getElementById("map").style.width = "1200px"; __map.pick(null); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
    const dead = await evaluate(async () => {
      __map.select("s2"); document.querySelector(".lm-canvas").dispatchEvent(new WheelEvent("wheel", { clientX: 400, deltaY: -1, ctrlKey: true, bubbles: true, cancelable: true })); __map.destroy();
      const pending = { raf: __raf.size, timers: __timers.size }, counts = JSON.stringify(__counts);
      __map.set(__model); __map.select("s2"); __map.home(); __map.pick(["s2"]);
      await __waitFor(() => __raf.size === 0 && __timers.size === 0, "destroy leaves no scheduled work");
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return { pending, empty: document.getElementById("map").childElementCount === 0, stable: counts === JSON.stringify(__counts), snapshot: __map.snapshot() };
    });
    check(n + " map destroy drains work and ignores late calls", dead.pending.raf === 0 && dead.pending.timers === 0 && dead.empty && dead.stable && dead.snapshot === null, dead);
  }
  assert.deepEqual(errors, []); assert.deepEqual(blocked, []); assert.deepEqual(fixture.state.writes, []);
  check("no uncaught errors, external requests, chat calls or API writes",
    fixture.state.writes.length === 0 && !fixture.state.requests.some(r => r.path === "/api/chat") && fixture.state.requests.every(r => fixture.isAllowed(r.path)),
    { requests: fixture.state.requests, writes: fixture.state.writes });
  console.log(JSON.stringify({ scope: "Synthetic complete frontend/Worker/map; headless Chromium with GPU disabled, not Android WebView/GPU/IME or frame-rate acceptance", checks: checks.length, errors, blocked, apiWrites: fixture.state.writes, sourceHashes: fixture.state.hashes }));
} catch (e) {
  console.error(e.stack || e); console.error(JSON.stringify({ passed: checks.map(c => c.name), errors, blocked, apiWrites: fixture?.state.writes }));
  if (cdp) { try { console.error("UI " + JSON.stringify(await cdp.eval("({ errors: window.__fixtureErrors, title: document.title, history: document.querySelector('#hist')?.textContent.slice(-500), viewer: document.querySelector('#vw-body')?.textContent.slice(0,500) })"))); } catch {} }
  process.exitCode = 1;
} finally {
  if (cdp) { cdp.clear(); cdp.ws.close(); }
  if (browser?.pid) {
    try { process.kill(-browser.pid, "SIGTERM"); } catch {}
    if (browser.exitCode === null) await Promise.race([once(browser, "exit").catch(() => {}), sleep(2000)]);
    if (browser.exitCode === null) { try { process.kill(-browser.pid, "SIGKILL"); } catch {} }
  }
  if (fixture) await fixture.close();
  try { await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
  finally { await fs.rm(lock, { recursive: true, force: true }); }
}
