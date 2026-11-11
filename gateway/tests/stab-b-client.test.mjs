// 稳定性报告 b 组的前端断言（FIND-004/035/010/011/048）：
// 草稿层的「发送留底 / 找回 / 配额提示」跑界面里真正的函数（05-composer.js），api() 的超时跑 01-core.js 里的实现。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const comp = fs.readFileSync(new URL("../web/app/05-composer.js", import.meta.url), "utf8");
const core = fs.readFileSync(new URL("../web/app/01-core.js", import.meta.url), "utf8");
const boot = fs.readFileSync(new URL("../web/app/19-boot.js", import.meta.url), "utf8");
const take = (text, start, end) => { const a = text.indexOf(start), b = text.indexOf(end, a); assert.ok(a >= 0 && b > a, start); return text.slice(a, b); };

// ── 草稿层：真实的 draftsRead / draftsSave / lost 槽 / swap / load / persist ──
function drafts({ quota = false } = {}) {
  const store = {}, toasts = [], offers = [], offloads = [];
  const box = {
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { if (quota) throw new Error("QuotaExceededError"); store[k] = String(v); },
    },
    view: { sessionId: null },
    state: { attachments: [] },
    inputEl: { value: "", focus() {} },
    draftChip: { classList: { add() {}, remove() {} } },
    toast: (m, isErr) => toasts.push({ m, isErr }),
    t: (s, v) => String(s).replace("{n}", v && v.n),
    normAtts: (l) => (Array.isArray(l) ? l.filter((a) => a && typeof a.path === "string") : []),
    shareDone: (l, drop) => offloads.push({ l, drop }),
    renderAttachments() {}, autoGrow() {},
    draftOffer: (text, opt) => offers.push({ text, opt }),
    setTimeout, clearTimeout,
  };
  vm.runInNewContext(
    "let draftLast = '', draftStash = '', draftStashOpt = null;\n" +
    take(comp, "  const DRAFTS_KEY", "  /** 输入框有字或附件栏里有东西") +
    "\nglobalThis.f = { draftsRead, draftsSave, draftPersist, draftPersistSoon, draftLoad, draftSwap, draftAdopt, draftOwner, draftPutAway, draftKeepSent, draftSentIdem, draftDropLost, lostLive, LOST_KEEP };",
    box);
  return { f: box.f, box, store, toasts, offers, offloads, read: () => JSON.parse(store["cc.drafts"] || "{}"), write: (o) => { store["cc.drafts"] = JSON.stringify(o); } };
}

test("FIND-035：发送时留底，输入框清空后 400ms 的草稿落盘不覆盖原文", () => {
  const h = drafts();
  h.box.inputEl.value = "这句发出去还没回执";
  h.f.draftKeepSent("", "这句发出去还没回执", [{ path: "/tmp/a.txt" }], "idem_aaaaaaaa");
  h.box.inputEl.value = "";                 // 发送后清空
  h.f.draftPersist();                       // 400ms 防抖落盘
  const d = h.read()[""];
  assert.ok(d, "空草稿也要留着（里面有 lost 槽）");
  assert.equal(d.text, "");
  assert.equal(d.lost.text, "这句发出去还没回执");
  assert.equal(JSON.stringify(d.lost.att), JSON.stringify([{ path: "/tmp/a.txt" }]));
  // 没有 lost 槽的空草稿照旧删掉，别把存储撑满
  h.f.draftDropLost("", "idem_aaaaaaaa");
  h.f.draftPersist();
  assert.equal(h.read()[""], undefined);
});

test("FIND-010：重开应用时输入框空着，把没回执 / 没发出去的原文亮成「恢复」，附件一起放回", () => {
  const h = drafts();
  h.write({ s1: { text: "", att: [], at: Date.now(), lost: { text: "掉了的原文", att: [{ path: "/tmp/x.png" }], at: Date.now(), idem: "idem_bbbbbbbb" } } });
  h.f.draftLoad("s1");
  assert.equal(h.offers.length, 1);
  assert.equal(h.offers[0].text, "掉了的原文");
  assert.equal(JSON.stringify(h.offers[0].opt.att), JSON.stringify([{ path: "/tmp/x.png" }]));
  assert.equal(h.offers[0].opt.idem, "idem_bbbbbbbb");
  // 输入框里已经有字：不打扰，槽还在，下次进来再说
  const h2 = drafts();
  h2.write({ s1: { text: "", att: [], at: Date.now(), lost: { text: "掉了的原文", at: Date.now(), idem: "x" } } });
  h2.box.inputEl.value = "正在写别的";
  h2.f.draftLoad("s1");
  assert.equal(h2.offers.length, 0);
});

test("FIND-010：切走再回来还能找回；过了 7 天不再提", () => {
  const h = drafts();
  h.write({ s2: { text: "", att: [], at: Date.now(), lost: { text: "报错的那句", at: Date.now(), idem: "idem_cccccccc" } } });
  h.box.view.sessionId = "s1";
  h.f.draftSwap("s1", "s2");
  assert.equal(h.offers.length, 1, "切到 s2：空输入框，亮恢复");
  assert.ok(h.read()["s2"] && h.read()["s2"].lost, "换到眼前之后槽还留在存储里（还没确认送到）");
  h.box.inputEl.value = "";
  h.f.draftSwap("s2", "s1");
  h.f.draftSwap("s1", "s2");
  assert.equal(h.offers.length >= 2, true, "来回切仍然能找回");
  // 过期
  const old = Date.now() - h.f.LOST_KEEP - 1000;
  h.write({ s3: { text: "", att: [], at: old, lost: { text: "很旧的", at: old, idem: "idem_dddddddd" } } });
  h.f.draftLoad("s3");
  assert.equal(h.offers.length, 2, "过期的槽不再亮恢复");
});

test("FIND-048：同一条原文重发沿用原幂等键，改过字就换新键", () => {
  const h = drafts();
  h.f.draftKeepSent("s1", "重发我", [], "idem_eeeeeeee");
  assert.equal(h.f.draftSentIdem("s1", "重发我"), "idem_eeeeeeee");
  assert.equal(h.f.draftSentIdem("s1", "重发我（改过）"), null);
  assert.equal(h.f.draftSentIdem("s2", "重发我"), null);
  h.f.draftDropLost("s1", "idem_eeeeeeee");
  assert.equal(h.f.draftSentIdem("s1", "重发我"), null, "网关收下之后不再沿用");
});

test("FIND-048：发送失败回填后留底槽不删，同文重发仍沿用原键", () => {
  const h = drafts();
  h.f.draftKeepSent("s1", "没发出去的话", [], "idem_ffffffff");
  // 失败分支（原文回输入框 + 立刻落盘）不能把槽删掉：那正是要重发的这条路
  h.box.inputEl.value = "没发出去的话";
  h.f.draftPersist();
  assert.equal(h.f.draftSentIdem("s1", "没发出去的话"), "idem_ffffffff", "回填后重发仍沿用原键");
  // 已切到别的会话：原文放回原会话草稿，槽同样留着
  h.box.inputEl.value = "";
  h.f.draftPutAway("s1", "没发出去的话", []);
  assert.equal(h.f.draftSentIdem("s1", "没发出去的话"), "idem_ffffffff");
  // 只有拿到网关回执（成功路径）才删
  h.f.draftDropLost("s1", "idem_ffffffff");
  assert.equal(h.f.draftSentIdem("s1", "没发出去的话"), null);
});

test("FIND-011：localStorage 配额满了要出声，30 秒内只响一次", () => {
  const h = drafts({ quota: true });
  assert.equal(h.f.draftsSave({}), false);
  assert.equal(h.toasts.length, 1);
  assert.match(h.toasts[0].m, /草稿没能保存/);
  assert.equal(h.toasts[0].isErr, true);
  h.f.draftsSave({});
  assert.equal(h.toasts.length, 1, "同一波写失败不刷屏");
  // 不能因为写失败把内存里的东西也弄坏：返回值 false，调用方继续
  h.box.inputEl.value = "长草稿";
  assert.doesNotThrow(() => h.f.draftPersist());
});

test("FIND-048：send() 带幂等键、留底与 20 秒超时；启动 /api/status 有超时且可重试", () => {
  assert.ok(comp.includes("draftSentIdem(dk, text) || newCid()"), "重发沿用原键");
  assert.ok(comp.includes("draftKeepSent(dk, text, sentAtt, idem)"), "发出去先留底");
  assert.ok(comp.includes("timeout: 20000"), "发送不能永远等");
  assert.match(comp, /message: text,\s*idem,/);
  assert.ok(comp.includes("r.duplicate"), "重发回来的原 run 不再提示排队");
  const catchBlk = take(comp, "    } catch (e) {\n      view.cids.delete(cid);", "    } finally");
  assert.ok(!catchBlk.includes("draftDropLost"), "失败分支不能删留底槽：重发要用原键");
  assert.ok(comp.includes("if (fromInput) draftDropLost(draftOwner(ep0, key0), idem);"), "成功回执后才删槽");
  assert.ok(boot.includes("armStatusRetry"), "启动状态失败可点重试");
  assert.match(boot, /\/api\/status", \{ timeout: 10000 \}/);
});

// ── api()：真实的超时 / 不误伤长请求 ──
function apiBox({ fetchImpl }) {
  const box = {
    I18N: { lang: "zh" },
    t: (s, v) => String(s).replace("{n}", v && v.n),
    fetch: fetchImpl,
    AbortController, setTimeout, clearTimeout,
  };
  vm.runInNewContext(take(core, "  // api() 的兜底超时", "  // ── 界面定制的统一存储") + "\nglobalThis.api = api;", box);
  return box;
}
const hang = (path, opts) => new Promise((ok, bad) => {
  if (opts.signal) opts.signal.addEventListener("abort", () => bad(Object.assign(new Error("aborterror"), { name: "AbortError" })));
});

test("FIND-004：api() 超时抛可识别的错误，HTTP 错误原样保留", async () => {
  const box = apiBox({ fetchImpl: hang });
  await assert.rejects(box.api("/api/status", { timeout: 60 }), (e) => e.timeout === true && /请求超时/.test(e.message));
  // 超时之外的服务端错误不能被说成超时
  const err = apiBox({ fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({ message: "boom" }) }) });
  await assert.rejects(err.api("/x", { timeout: 60 }), (e) => e.status === 500 && e.message === "boom" && !e.timeout);
  // 正常返回
  const okBox = apiBox({ fetchImpl: async () => ({ ok: true, json: async () => ({ ok: 1 }) }) });
  assert.deepEqual(await okBox.api("/y", { timeout: 60 }), { ok: 1 });
});

test("FIND-004：timeout:0 表示不限时（长请求不误伤），默认上限是 10 分钟", async () => {
  const box = apiBox({ fetchImpl: hang });
  let settled = false;
  box.api("/long", { timeout: 0 }).then(() => { settled = true; }, () => { settled = true; });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(settled, false, "明确不限时的调用不能被默认超时掐掉");
  assert.ok(core.includes("const API_TIMEOUT = 10 * 60 * 1000"), "默认给长操作留足 10 分钟");
});
