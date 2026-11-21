// c 组（稳定性报告 Cc-stability-20261111-01）：启动、前后台与运行视图生命周期。
// 全部把前端逻辑切片进 vm 跑：不起网关、不碰真实数据，也不依赖 DOM 实现细节。
// 覆盖 FIND-003 / 005 / 006 / 007 / 008 / 017 / 018 / 037 / 042 与 OBS-002。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const app = (name) => fs.readFileSync(new URL("../web/app/" + name, import.meta.url), "utf8");
const src04 = app("04-session-flow.js");
const src03 = app("03-perm-status.js");
const src19 = app("19-boot.js");

/** 从 start 切到它**之后**的 end（indexOf 带 fromIndex，免得撞上别处更早的同名标记） */
function cut(text, start, end) {
  const a = text.indexOf(start);
  assert.ok(a >= 0, "找不到起点标记：" + start);
  const b = text.indexOf(end, a + start.length);
  assert.ok(b > a, "找不到终点标记：" + end);
  return text.slice(a, b);
}
/** 跑一段切片，并把要测的函数挂出来 */
function load(code, box, names) {
  vm.runInNewContext(code + "\nglobalThis.handoff = {" + names.join(", ") + "};", box);
  return box.handoff;
}

// ── FIND-003：启动窗口里点「新对话」/ 打开会话，不被 lastSessionId 接回覆盖 ──────────

function loadAdopt(extra = {}) {
  const swaps = [], saved = [];
  const view = { sessionId: null, userNav: false, runIds: new Set(), cids: new Set(), lastRunId: null, ...extra };
  const box = { view, draftSwap: (from, to) => swaps.push([from, to]), saveUiState: () => saved.push(1) };
  const h = load(cut(src04, "  /** 启动时把网关记着的", "  /** 打开某个会话"), box, ["adoptLastSession"]);
  return { view, swaps, saved, adopt: h.adoptLastSession };
}

test("FIND-003：启动窗口里用户已经自己导航过，就不再接回上次会话", () => {
  const { adopt, view, swaps, saved } = loadAdopt({ userNav: true });
  assert.equal(adopt("s-last"), false);
  assert.equal(view.sessionId, null);
  assert.deepEqual(swaps, []);
  assert.deepEqual(saved, []);
});

test("FIND-003：没人动过界面时照旧接回上次会话，草稿按会话交接", () => {
  const { adopt, view, swaps } = loadAdopt();
  assert.equal(adopt("s-last"), true);
  assert.equal(view.sessionId, "s-last");
  assert.deepEqual(swaps, [[null, "s-last"]]);
});

test("FIND-003：本地已有会话 / 已在跑 / 已发过消息，都不覆盖", () => {
  assert.equal(loadAdopt({ sessionId: "s-local" }).adopt("s-last"), false);
  assert.equal(loadAdopt({ runIds: new Set(["r1"]) }).adopt("s-last"), false);
  assert.equal(loadAdopt({ lastRunId: "r1" }).adopt("s-last"), false);
  assert.equal(loadAdopt().adopt(null), false);
});

test("FIND-003：点新对话 / 打开会话都会记下 userNav；新对话在空白页提前返回之前就记", () => {
  const open = cut(src04, "  function openSession(", "  function goSession(");
  assert.ok(open.includes("view.userNav = true;"), "openSession 没记 userNav");
  const nc = cut(src04, "  function newConversation(", "  function liveExclude(");
  const head = nc.split("\n").slice(0, 4).join("\n");
  assert.ok(head.includes("view.userNav = true;"), "newConversation 的第一行没记 userNav（空白新对话会提前返回）");
});

test("FIND-003：boot 接回上次会话走 adoptLastSession，旧的裸恢复不再出现", () => {
  assert.ok(src19.includes("adoptLastSession(state.serverStatus?.lastSessionId)"));
  assert.ok(!src19.includes("if (!view.sessionId && state.serverStatus?.lastSessionId)"));
});

// ── FIND-005：/api/status 启动失败时，首个 hello 不能把它盖成「已连接」 ─────────────

function loadHello({ userNav = false, serverStatus, helloCount = 0, lastSessionId = "s-gw", resume = true, run } = {}) {
  const swaps = [], statuses = [], refreshes = [];
  const view = { sessionId: null, userNav, runIds: new Set(), cids: new Set(), lastRunId: null, gen: 0 };
  const state = {};
  if (serverStatus !== undefined) state.serverStatus = serverStatus;
  const box = {
    view, state, helloCount, uiTag: "u1", Set, Map, t: (s) => s,
    draftSwap: (from, to) => swaps.push([from, to]), saveUiState() {},
    applyState() {}, beginReplay() {}, calmStatus: (x) => statuses.push(x), setStatus() {},
    refreshStatus: () => { refreshes.push(1); return Promise.resolve(); },
    resetView() {}, renderSessions() {}, loadOlder() {}, showWelcome() {}, renderInterrupted() {},
    pickViewRun() {}, intrList: () => [],
  };
  const h = load(
    cut(src04, "  /** 启动时把网关记着的", "  /** 打开某个会话") + cut(src04, "  function onHello(", "  /** 「已连接」"),
    box, ["onHello"],
  );
  h.onHello({ resume, lastSessionId, interrupted: [], ...(run ? { run } : {}) });
  return { view, swaps, statuses, refreshes, box };
}

test("FIND-005：/api/status 没拿到时，首个 hello 接回上次会话并补拉状态", () => {
  const { view, swaps, refreshes, statuses } = loadHello();
  assert.equal(view.sessionId, "s-gw");
  assert.deepEqual(swaps, [[null, "s-gw"]]);
  assert.equal(refreshes.length, 1);
  assert.deepEqual(statuses, ["已连接"]);
});

test("FIND-005：/api/status 拿到了（serverStatus 在），首个 hello 不重复接、不重复拉", () => {
  const { view, swaps, refreshes } = loadHello({ serverStatus: { ok: true } });
  assert.equal(view.sessionId, null);
  assert.deepEqual(swaps, []);
  assert.equal(refreshes.length, 0);
});

test("FIND-005：用户在启动窗口里已经点过新对话时，只好补拉状态，不接回", () => {
  const { view, swaps, refreshes } = loadHello({ userNav: true });
  assert.equal(view.sessionId, null);
  assert.deepEqual(swaps, []);
  assert.equal(refreshes.length, 1);
});

test("FIND-005：不是首个 hello 就不做这套接回", () => {
  const { view, swaps, refreshes } = loadHello({ helloCount: 1 });
  assert.equal(view.sessionId, null);
  assert.deepEqual(swaps, []);
  assert.equal(refreshes.length, 0);
});

test("FIND-003：启动窗口里用户已经点过新对话，首个 hello 也不把视图改道到正在跑的会话", () => {
  const run = { id: "r1", sessionId: "s-b", ended: false };
  const stayed = loadHello({ userNav: true, resume: false, run, lastSessionId: null });
  assert.equal(stayed.view.sessionId, null);
  assert.deepEqual(stayed.swaps, []);
  // 没动过界面时照旧跟上正在跑的那一轮（原有行为）
  const followed = loadHello({ userNav: false, resume: false, run, lastSessionId: null });
  assert.equal(followed.view.sessionId, "s-b");
  assert.deepEqual(followed.swaps, [[null, "s-b"]]);
});

// ── FIND-006：切走期间后台会话失败，网关层错误文案按会话留到下次进入 ──────────────

function loadFailNotes({ viewSid = "s-a", runs = [] } = {}) {
  const notes = [];
  const view = { sessionId: viewSid };
  const box = {
    view, runViews: new Map(), srv: { runs }, Set, Map,
    t: (s, o) => (o && o.msg != null ? s.replace("{msg}", o.msg) : s),
    addNote: (text) => notes.push(text), liveEl: {}, scrollDown() {},
  };
  const h = load(cut(src04, "  // 轮次 → 会话号：", "  function belongs("),
    box, ["recordFailNote", "showFailNote", "runSid", "failNotes", "runViews"]);
  return { notes, view, h };
}

test("FIND-006：后台会话失败的错误文案留住，回到那个会话时补一行，只补一次", () => {
  const { notes, h } = loadFailNotes();
  h.runSid.set("r1", "s-b");
  h.recordFailNote({ type: "error", runId: "r1", message: "网关起不来", detail: "spawn failed" });
  assert.equal(h.failNotes.has("s-b"), true);
  h.showFailNote("s-b");
  assert.equal(notes.length, 1);
  assert.match(notes[0], /上一轮在后台失败/);
  assert.match(notes[0], /网关起不来/);
  assert.match(notes[0], /spawn failed/);
  h.showFailNote("s-b");
  assert.equal(notes.length, 1);
});

test("FIND-006：runId → 会话号也能从在跑的轮次里补；眼前这一轮 / 当前会话不存", () => {
  const { notes, h } = loadFailNotes({ runs: [{ id: "r9", sessionId: "s-b" }] });
  h.recordFailNote({ type: "error", runId: "r9", message: "boom" });
  assert.equal(h.failNotes.has("s-b"), true);
  // 眼前正在画的这一轮：错误照旧进气泡，不进补记
  h.runViews.set("r2", { av: {} });
  h.recordFailNote({ type: "error", runId: "r2", message: "x" });
  // 本地记着会话号的和当前会话是同一个：不存（切回来时本来就在看）
  h.recordFailNote({ type: "error", runId: "r3", sessionId: "s-a", message: "y" });
  assert.equal(h.failNotes.size, 1);
  h.showFailNote("s-a");
  assert.equal(notes.length, 0);
});

test("FIND-006：onBus 先把 runId → 会话号记下来、error 事件走补记", () => {
  const head = cut(src04, "  function onBus(", "    switch (ev.type) {");
  assert.ok(head.includes("runSid.set(ev.runId, ev.sessionId)"));
  assert.ok(head.includes('if (ev.type === "error") recordFailNote(ev)'));
});

// ── FIND-042 / FIND-007 / FIND-008：轮次收尾 ─────────────────────────────────

function loadRunEnd({ runViews = new Map(), perms = new Map(), viewSid = "s-a" } = {}) {
  const calls = { permDone: [], statSave: [], finish: 0, remove: 0, timerStop: 0, status: [] };
  const view = { sessionId: viewSid, goalClearAfter: null, runIds: new Set() };
  const box = {
    view, state: { caps: { slashCommands: ["/x"] } }, Set, Map, runSid: new Map(),
    CSS: { escape: (s) => s }, PERMS: perms, runViews,
    chatEl: { querySelectorAll: () => [] },
    t: (s) => s, esc: (s) => s,
    permDone: (id, how) => { calls.permDone.push([id, how]); perms.delete(id); },
    statRun: null, statLast: {}, statEl: { textContent: "" }, statStop() {},
    statBits: () => "1.0s", statSave: (sid, st) => calls.statSave.push([sid, st]),
    liveCtx() {}, agStopAll() {}, srSay() {}, trimLive() {}, scrollDown() {},
    loadSessions() {}, loadCaps() {}, setStatus: (s, k) => calls.status.push([s, k]),
    mkMsg: () => ({ parentElement: {} }), setHtml() {}, renderMd: () => "",
    parseContextText() {}, loadSettings() {}, refreshSessModel() {}, loadModels() {},
    draftAdopt() {}, adoptPendingModel() {}, saveUiState() {},
    api: () => Promise.resolve({}), send() {}, newCid: () => "c", toast() {},
    belongs: () => false,
  };
  const h = load(cut(src04, "  function onRunEnd(", "  // ── 忙闲与排队"), box, ["onRunEnd"]);
  return { calls, view, runViews, perms, onRunEnd: h.onRunEnd };
}

test("FIND-042：一轮收尾后 runViews 只留开始时间，气泡和计时器引用都放掉", () => {
  const av = { finish() { calls.finish++; }, empty: false, remove() { calls.remove++; } };
  const calls = { finish: 0, remove: 0 };
  const runViews = new Map([["r1", { av, startedAt: 111, timer: { stop() { calls.timerStop = (calls.timerStop || 0) + 1; } }, out: 5 }]]);
  const t = loadRunEnd({ runViews });
  t.onRunEnd({ type: "run_end", runId: "r1", sessionId: "s-b" });
  const left = runViews.get("r1");
  assert.equal(left.startedAt, 111, "开始时间要留着给历史去重");
  assert.equal(left.av, undefined);
  assert.equal(left.timer, undefined);
  assert.equal(left.out, undefined);
  assert.equal(calls.finish, 1);
  assert.equal(calls.timerStop, 1);
});

test("FIND-042：收尾后的空壳不再收晚到的增量 / 插话 / 权限卡", () => {
  // 空壳（没有 av）走 onBus 公共路径时直接 return；源码里三处入口都加了 av 守卫
  const common = cut(src04, "    const rv = runViews.get(ev.runId);\n    if (!rv) return;", "    switch (ev.type) {");
  assert.ok(common.includes("if (!av) return;"));
  const inject = cut(src04, '      case "inject": {', '      case "run_idle": {');
  assert.ok(inject.includes("if (!rv || !rv.av) return;"));
  const idle = cut(src04, '      case "run_idle": {', '      case "run_busy": {');
  assert.ok(idle.includes("if (rv && rv.av && !rv.idle)"));
  const perm = cut(src04, '      case "perm_request": {', '      case "perm_resolved":');
  assert.ok(perm.includes("rv ? rv.av :"), "空壳（有 rv 但无 av）不得接收晚到的 perm_request");
});

test("FIND-007：这一轮在别的会话里跑完，权限卡记录也要收掉（哪怕本视图没有它的 run）", () => {
  const perms = new Map([["p1", { runId: "r9", done: false, el: {} }], ["p2", { runId: "r9", done: true, el: {} }]]);
  const t = loadRunEnd({ runViews: new Map(), perms });
  t.onRunEnd({ type: "run_end", runId: "r9", sessionId: "s-b" });
  assert.deepEqual(t.calls.permDone, [["p1", "stopped"]]);
});

test("FIND-007：切走后卡片已从文档里拿掉，permDone 不再抱着游离 DOM 和表单值", () => {
  const perms = new Map();
  let renders = 0;
  const el = { isConnected: false, classList: { add() {}, remove() {} }, querySelector: () => null, querySelectorAll: () => [] };
  perms.set("p1", { p: { tool: "Bash", input: { command: "ls" } }, runId: "r1", el, done: false });
  const box = { PERMS: perms, TOOL_CARDS: new Map(), t: (s) => s, esc: (s) => s, renderPermBar: () => renders++ };
  const h = load(cut(src03, "  function permDone(", "  // 卡片里已经勾的"), box, ["permDone"]);
  h.permDone("p1", "stopped");
  assert.equal(perms.has("p1"), false);
  assert.equal(renders, 1);
});

test("FIND-007：还在文档里的卡照旧收起成一行（没误删正常记录）", () => {
  const perms = new Map();
  const el = {
    isConnected: true,
    classList: { add() {}, remove() {} },
    querySelector: (sel) => (sel === ".perm-body" ? { remove() {} } : { innerHTML: "", querySelectorAll: () => [] }),
    querySelectorAll: () => [],
  };
  perms.set("p1", { p: { tool: "Bash", input: { command: "ls" } }, runId: "r1", el, done: false });
  const box = { PERMS: perms, TOOL_CARDS: new Map(), t: (s) => s, esc: (s) => s, renderPermBar() {} };
  const h = load(cut(src03, "  function permDone(", "  // 卡片里已经勾的"), box, ["permDone"]);
  h.permDone("p1", "deny");
  assert.equal(perms.get("p1").done, true);
});

test("FIND-008：收尾的统计记到这一轮自己的会话，不记到当前视图的会话", () => {
  const runViews = new Map([["r1", { av: { finish() {}, empty: false, remove() {} }, startedAt: 1, timer: { stop() {} }, out: 5 }]]);
  const t = loadRunEnd({ runViews, viewSid: "s-a" });
  t.onRunEnd({ type: "run_end", runId: "r1", sessionId: "s-b" });
  assert.deepEqual(t.calls.statSave, [["s-b", "1.0s"]]);
});

// ── FIND-037 / OBS-002 / FIND-018：事件总线 ───────────────────────────────────

function loadBus({ api = () => Promise.resolve({}), hidden = false } = {}) {
  let now = 100000, nextTimer = 1;
  const timers = new Map(), created = [], bus = [], conns = [], statuses = [];
  let apiCalls = 0;
  const srv = { foreign: false, connected: false };
  const view = { sessionId: "s-a", runIds: new Set() };
  const box = {
    view, srv, Set, Map, JSON,
    Date: { now: () => now },
    console: { error() {} },
    document: { hidden },
    window: {},
    t: (s) => s,
    api: (...a) => { apiCalls++; return api(...a); },
    onBus: (ev) => bus.push(ev),
    setConn: (ok) => { srv.connected = ok; conns.push(ok); },
    setStatus: (s, k) => statuses.push([s, k]),
    setTimeout: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms, cleared: false }); return id; },
    clearTimeout: (id) => { const t = timers.get(id); if (t) t.cleared = true; },
    EventSource: class {
      constructor(url) { this.url = url; this.readyState = 0; this.closed = false; created.push(this); }
      close() { this.closed = true; this.readyState = 2; }
    },
  };
  const h = load(cut(src04, "  let es = null, lastEventId", "  /** 回前台把界面状态和网关对一遍"),
    box, ["connectBus", "probeGateway", "busRetryDelay", "setConn"]);
  const pending = () => [...timers.entries()].filter(([, t]) => !t.cleared).pop();
  return {
    h, timers, created, bus, conns, statuses, srv,
    apiCalls: () => apiCalls,
    advance: (ms) => { now += ms; },
    fireRetry() { const p = pending(); assert.ok(p, "没有排着的重拨"); p[1].fn(); },
    pendingDelay() { const p = pending(); return p ? p[1].ms : null; },
  };
}

test("FIND-037：重拨等待 1.5 秒起翻倍、封顶 30 秒", () => {
  const b = loadBus();
  assert.equal(b.h.busRetryDelay(0), 1500);
  assert.equal(b.h.busRetryDelay(1), 3000);
  assert.equal(b.h.busRetryDelay(2), 6000);
  assert.equal(b.h.busRetryDelay(3), 12000);
  assert.equal(b.h.busRetryDelay(4), 24000);
  assert.equal(b.h.busRetryDelay(5), 30000);
  assert.equal(b.h.busRetryDelay(50), 30000);
});

test("FIND-037：每次断线都排下一次重拨（不放弃），等待逐次变长并封顶；连上后从头算", () => {
  const b = loadBus();
  b.h.connectBus(true);
  assert.equal(b.created.length, 1);
  const delays = [];
  for (let i = 0; i < 7; i++) {
    b.created[b.created.length - 1].onerror();
    delays.push(b.pendingDelay());
    b.fireRetry();
  }
  assert.deepEqual(delays, [1500, 3000, 6000, 12000, 24000, 30000, 30000]);
  // 连上了：等待复位；再断一次又从 1.5 秒起
  b.created[b.created.length - 1].onopen();
  b.created[b.created.length - 1].onerror();
  assert.equal(b.pendingDelay(), 1500);
});

test("OBS-002：换掉的旧 EventSource 上排队的事件不再派发", () => {
  const b = loadBus();
  b.h.connectBus(true);
  const first = b.created[0];
  b.h.connectBus(true);
  const second = b.created[1];
  assert.equal(first.closed, true);
  first.onmessage({ data: '{"type":"delta","text":"old"}', lastEventId: "1" });
  assert.equal(b.bus.length, 0, "旧连接的事件被派发了");
  second.onmessage({ data: '{"type":"delta","text":"new"}', lastEventId: "2" });
  assert.equal(b.bus.length, 1);
  assert.equal(b.bus[0].text, "new");
  // 旧连接的 onopen / onerror 也不再改状态、不再排重拨
  const before = b.conns.length;
  first.onopen();
  first.onerror();
  assert.equal(b.conns.length, before);
});

test("FIND-018：断线时网关问不到，状态栏改成「网关离线」而不是「生成不受影响」", async () => {
  const b = loadBus({ api: () => Promise.reject(new Error("dead")) });
  b.h.connectBus(true);
  b.created[0].onerror();
  await flush();
  assert.ok(b.statuses.some(([s, k]) => s === "网关离线" && k === "err"), JSON.stringify(b.statuses));
});

test("FIND-018：确认网关不在之后，后续重拨失败不会把文案盖回「生成不受影响」；连上就重新按原文案", async () => {
  const b = loadBus({ api: () => Promise.reject(new Error("dead")) });
  b.h.connectBus(true);
  b.created[0].onerror();
  await flush();
  assert.equal(b.statuses[b.statuses.length - 1][0], "网关离线");
  b.fireRetry();                     // 1.5 秒后自己重拨，又失败
  b.created[1].onerror();
  await flush();
  assert.equal(b.statuses[b.statuses.length - 1][0], "网关离线", "重拨失败把文案盖回去了");
  b.fireRetry();                     // 再拨一次，这回连上了
  b.created[2].onopen();
  b.created[2].onerror();            // 连上后又断：清零了，回到原文案
  await flush();
  assert.match(b.statuses[b.statuses.length - 1][0], /生成不受影响/);
});

test("FIND-018：网关还能应答（连接断在浏览器侧）就不改文案；8 秒内不重复问", async () => {
  const b = loadBus({ api: () => Promise.resolve({ ok: true }) });
  b.h.connectBus(true);
  b.created[0].onerror();
  await Promise.resolve(); await Promise.resolve();
  assert.ok(!b.statuses.some(([s]) => s === "网关离线"));
  assert.equal(b.apiCalls(), 1);
  b.fireRetry();
  b.created[1].onerror();
  await flush();
  assert.equal(b.apiCalls(), 1, "8 秒内又问了");
  b.advance(9000);
  b.fireRetry();
  b.created[2].onerror();
  await flush();
  assert.equal(b.apiCalls(), 2);
});

// ── FIND-017：回前台无条件拿状态对账，再按需重连 ────────────────────────────

function loadVisibility({ state = { runs: [] }, api = () => Promise.resolve(state) } = {}) {
  const listeners = {}, applied = [], connections = [], timers = new Map();
  let next = 0;
  const runViews = new Map();
  const box = {
    view: { sessionId: "s-a", gen: 1 }, srv: { runs: [] }, runViews, runSid: new Map(), PERMS: new Map(),
    statRun: null, statEl: { textContent: "" }, statLast: {}, statStop() {},
    api,
    record: (s) => applied.push(s),
    connectBus: (resume) => connections.push(resume),
    document: { hidden: false, addEventListener: (name, fn) => { listeners[name] = fn; } },
    es: { readyState: 1 },
    setTimeout(fn, ms) { const id = ++next; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
  };
  // Run the actual applyState through its state assignment; rendering is covered separately.
  const apply = cut(src04, "  function applyState(s) {", "    srv.intr =");
  Object.assign(box, { showTamper() {}, showRecoverWarn() {} });
  const h = load(cut(src04, "  /** 回前台把界面状态和网关对一遍", "  // ── 维护者通知") + apply + "    record(s);\n  }", box, ["applyState"]);
  return { h, listeners, applied, runViews, connections, box, timers,
    expire() { for (const [id, timer] of timers) { timers.delete(id); timer.fn(); } } };
}

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function activeView(startedAt = 100) {
  const rv = { startedAt, out: 3, finished: 0, stopped: 0 };
  rv.av = { finish() { rv.finished++; }, empty: false };
  rv.timer = { stop() { rv.stopped++; } };
  return rv;
}

test("FIND-017：先贴合网关的忙闲，等 SSE 尾帧；超时才重读历史", async () => {
  const f = loadVisibility(), rv = activeView(), newer = activeView(Date.now() + 60000);
  f.runViews.set("r1", rv); f.runViews.set("r2", newer);
  f.box.srv.runs = [{ id: "r1" }];
  f.listeners.visibilitychange();
  await flush();
  assert.equal(f.applied.length, 1);
  assert.equal(f.box.srv.runs.length, 0, "忙闲立即更新");
  assert.equal(rv.finished, 0, "不能吞掉在途正文");
  assert.equal(f.runViews.get("r1").av, rv.av);
  assert.deepEqual(f.connections, []);
  assert.equal([...f.timers.values()][0].ms, 2000);
  f.expire();
  assert.equal(rv.finished, 1);
  assert.equal(rv.stopped, 1);
  assert.equal(f.runViews.get("r1").av, undefined);
  assert.equal(f.runViews.get("r1").out, 3);
  assert.equal(newer.finished, 0);
  assert.deepEqual(f.connections, [false], "整轮重放重新读取历史");
});

test("FIND-017：等到了 run_end 则不重复收尾，也不重拨", async () => {
  const f = loadVisibility(), rv = activeView();
  f.runViews.set("r1", rv);
  f.listeners.visibilitychange();
  await flush();
  const end = loadRunEnd({ runViews: f.runViews });
  end.onRunEnd({ runId: "r1", sessionId: "s-a" });
  f.expire();
  assert.equal(rv.finished, 1);
  assert.equal(rv.stopped, 1);
  assert.deepEqual(f.connections, []);
});

test("FIND-017：超时后的迟到 run_end 仍收权限卡、记统计并认领会话", async () => {
  const f = loadVisibility();
  f.box.view.sessionId = null;
  f.runViews.set("r1", activeView());
  f.listeners.visibilitychange();
  await flush();
  f.expire();
  assert.deepEqual(f.connections, [], "没有会话号就不清掉已显示的内容");
  const perms = new Map([["p1", { runId: "r1", done: false }]]);
  const end = loadRunEnd({ runViews: f.runViews, perms, viewSid: null });
  end.view.runIds.add("r1");
  end.onRunEnd({ runId: "r1", sessionId: "s-new" });
  assert.equal(end.view.sessionId, "s-new");
  assert.deepEqual(end.calls.statSave, [["s-new", "1.0s"]]);
  assert.deepEqual(end.calls.permDone, [["p1", "stopped"]]);
});

test("FIND-017：较新的 SSE 状态不会被在途快照盖掉", async () => {
  let resolve;
  const f = loadVisibility({ api: () => new Promise((r) => { resolve = r; }) });
  const rv = activeView();
  f.runViews.set("r1", rv);
  f.listeners.visibilitychange();
  f.h.applyState({ runs: [{ id: "r1" }] });
  resolve({ runs: [] });
  await flush();
  f.expire();
  assert.equal(f.applied.length, 1);
  assert.equal(f.box.srv.runs[0].id, "r1");
  assert.equal(rv.finished, 0);
  assert.deepEqual(f.connections, []);
});

test("FIND-017：网关说还在跑的轮次不动；连接不是 OPEN 时补一次重连", async () => {
  const f = loadVisibility({ state: { runs: [{ id: "r1", sessionId: "s-a" }] } }), rv = activeView();
  f.runViews.set("r1", rv);
  f.box.es = null;
  f.listeners.visibilitychange();
  await flush();
  f.expire();
  assert.equal(rv.finished, 0);
  assert.deepEqual(f.connections, [true]);
});

test("FIND-017：切到另一会话丢弃迟到快照；隐藏时取消未到的对账", async () => {
  let resolve;
  const f = loadVisibility({ api: () => new Promise((r) => { resolve = r; }) }), rv = activeView();
  f.runViews.set("r1", rv);
  f.listeners.visibilitychange();
  f.box.view.gen++;
  resolve({ runs: [] });
  await flush();
  assert.equal(f.applied.length, 0);
  f.listeners.visibilitychange();
  resolve({ runs: [] });
  await flush();
  assert.equal(f.timers.size, 1);
  f.box.document.hidden = true;
  f.listeners.visibilitychange();
  f.expire();
  assert.equal(f.timers.size, 0);
  assert.equal(rv.finished, 0);
  assert.deepEqual(f.connections, []);
});
