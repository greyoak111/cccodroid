// 第二份稳定性报告 BUG-R04（对照第一轮 FIND-048）：POST 已经被网关受理、回执在路上丢了的时候，
// send() 的 catch 原来一律按「没发出去」处理：原文退回输入框、提示重发，用户再发一次就多一条请求
// （b 组的幂等键兜住了重复执行，但提示仍然是错的）。修法：
//   - catch 里先按 cid 对账（run_start 记下的 cidRuns、状态快照的 runs / queueAll 都带 cid）；
//     有受理证据就按送到收尾，留底槽一起收掉；
//   - 只有服务端明确回了 status 才说「没发出去」；已经发出 POST 但没有回执（断网 / 超时）说「不确定」；
//   - 还没发 POST 的本地错误（切会话 / 上一条没送到）照旧说原因，不能报成结果未知。
// 这里把界面里真正的 send() 抽出来，api / 草稿函数 / DOM 都用桩。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const src05 = fs.readFileSync(new URL("../web/app/05-composer.js", import.meta.url), "utf8");
const take = (src, start, end) => {
  const a = src.indexOf(start);
  assert.ok(a >= 0, "找不到 " + start);
  const b = src.indexOf(end, a);
  assert.ok(b > a, "找不到 " + end);
  return src.slice(a, b);
};

function load() {
  const code = `
const state = { attachments: [], pendingModel: null };
const inputEl = { value: "", focus() {}, setSelectionRange() {} };
const view = { sessionId: "S1", gen: 1, projectId: null, pendingMerge: null, lastRunId: null, firstSend: null,
  cids: new Set(), cidRuns: new Map(), runIds: new Set() };
const srv = { run: null, runs: [], queueAll: [], max: 3 };
let draftEpoch = 0, draftLast = "", lastSendAt = 0, renameBusy = "", pickCopy = 0;
const setTimeout = () => 0;   // send 里给「等上一条」挂的 15 秒兜底：本测试不需要它触发
const t = (s, v) => String(s).replace(/\\{(\\w+)\\}/g, (_, k) => String(v && v[k] !== undefined ? v[k] : ""));
const fmtSize = (n) => n + "B";
const toasts = [], acts = [], kept = [], dropped = [];
const toast = (m, isErr) => toasts.push({ m, isErr: !!isErr });
const toastAct = (m, a, cb) => acts.push({ m, a, cb });
const hidePopup = () => {};
const backToLatest = () => {};
const newConversation = () => {};
const openExternal = () => {};
const addSysMsg = () => ({ querySelectorAll: () => [] });
const loadSessions = () => {};
const openDrawer = () => {};
const atCap = () => false;
const renderAttachments = () => {};
const syncInterject = () => {};
const autoGrow = () => {};
const clearAttachments = () => { state.attachments = []; };
const draftPersist = () => {};
const draftOwner = (ep, key) => key || "";
const draftKeepSent = (k, text, att, idem) => { kept.push({ k, text, idem }); return true; };
const draftSentIdem = () => null;
const draftDropLost = (k, idem) => { dropped.push({ k, idem }); };
let apiImpl = () => Promise.resolve({ id: "R0", started: true });
const api = (...a) => apiImpl(...a);
${take(src05, "  const BIG_ATT = 20 << 20;", "  let lastSendAt = 0;")}
globalThis.__h = { send, view, srv, state, inputEl, toasts, acts, kept, dropped,
  setApi: (f) => { apiImpl = f; }, defer: () => { let ok; const p = new Promise((r) => { ok = r; }); return { p, ok }; } };
`;
  const ctx = {};
  vm.runInNewContext(code, ctx);
  return ctx.__h;
}

test("BUG-R04 网关已受理、POST 回执丢失：按送到收尾，不再退回原文让人重发", async () => {
  const h = load();
  h.inputEl.value = "你好";
  h.setApi((url, opt) => {
    // 受理后 run_start 先到（带 cid），紧接着 POST 的响应丢了
    const cid = JSON.parse(opt.body).cid;
    h.view.cidRuns.set(cid, "R1");
    return Promise.reject(new TypeError("Failed to fetch"));
  });
  await h.send();
  assert.equal(h.toasts.length, 1);
  assert.match(h.toasts[0].m, /网关已经收下这条/);
  assert.equal(h.inputEl.value, "", "不要退回原文");
  assert.equal(h.dropped.length, 1, "有受理证据：留底槽和幂等键一起收掉");
  assert.equal(h.view.lastRunId, "R1");
  assert.ok(h.view.runIds.has("R1"));
});

test("BUG-R04 受理证据来自状态快照（runs / queueAll 里的 cid）", async () => {
  const h = load();
  h.inputEl.value = "走快照";
  h.setApi((url, opt) => {
    const cid = JSON.parse(opt.body).cid;
    h.srv.runs = [{ id: "R2", cid }];
    return Promise.reject(new TypeError("network"));
  });
  await h.send();
  assert.match(h.toasts[0].m, /网关已经收下这条/);
  assert.equal(h.view.lastRunId, "R2");
});

test("BUG-R04 结果未知（断网 / 超时）：说「不确定」，留底槽和 cid 都留着", async () => {
  const h = load();
  h.inputEl.value = "重要的话";
  h.setApi(() => Promise.reject(Object.assign(new Error("请求超时：网关没有响应（20 秒）"), { timeout: true })));
  await h.send();
  assert.match(h.toasts[0].m, /不确定发出去没有/);
  assert.equal(h.inputEl.value, "重要的话", "结果未知也要把原文还给用户");
  assert.equal(h.dropped.length, 0, "结果未知不能吃留底槽：重发要沿用幂等键");
  assert.equal(h.view.cids.size, 1, "cid 留着，run_start 晚到还认得出");
});

test("BUG-R04 服务端明确拒绝（带 status）：说「没发出去」，清 cid", async () => {
  const h = load();
  h.inputEl.value = "被拒";
  h.setApi(() => Promise.reject(Object.assign(new Error("服务器错误"), { status: 500 })));
  await h.send();
  assert.match(h.toasts[0].m, /^没发出去：服务器错误$/);
  assert.equal(h.view.cids.size, 0);
  assert.equal(h.dropped.length, 0);
});

test("BUG-R04 还没发 POST 的本地错误不算「结果未知」：照旧说原因", async () => {
  const h = load();
  h.inputEl.value = "切走了";
  h.view.sessionId = "";                    // 新会话：要等上一条的 run 号
  const prior = h.defer();
  h.view.firstSend = prior.p;
  const p = h.send();
  h.view.gen = 2;                           // 等上一条时切了会话
  prior.ok();
  await p;
  assert.equal(h.acts.length, 1, "没发出去的原文给「找回」");
  assert.equal(h.acts[0].m, "没发出去：会话已切换，这条没发", "本地错误不能被说成结果未知");
  assert.equal(h.dropped.length, 0);
  assert.equal(h.view.cids.size, 0, "根本没发，cid 清掉");
});

test("BUG-R04 正常回执（回归）：删留底槽、记 run 号", async () => {
  const h = load();
  h.inputEl.value = "正常";
  h.setApi(() => Promise.resolve({ id: "R9", started: true }));
  await h.send();
  assert.equal(h.dropped.length, 1);
  assert.equal(h.view.lastRunId, "R9");
  assert.equal(h.inputEl.value, "");
  assert.equal(h.toasts.length, 0);
});
