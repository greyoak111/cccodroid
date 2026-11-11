// 稳定性报告 FIND-012：输入域其余候选里的三条能在 JS 层修的 ——
// 输入法拼字时按回车把拼音发出去、图文混合粘贴丢文字、/rename 连点重复请求。
// 键盘遮挡与发送后焦点属于交互取舍，不在本测试里。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const src = fs.readFileSync(new URL("../web/app/05-composer.js", import.meta.url), "utf8");

test("FIND-012 输入法拼字时的回车不发消息、不选补全项", () => {
  const m = src.match(/const imeBusy = \(e\) => [^;]+;/);
  assert.ok(m, "找不到 imeBusy");
  const imeBusy = vm.runInNewContext(m[0] + "\nimeBusy");
  assert.equal(imeBusy({ isComposing: true, keyCode: 13 }), true, "isComposing 时要算拼字中");
  assert.equal(imeBusy({ isComposing: false, keyCode: 229 }), true, "安卓 WebView 的 keyCode 229 也要算拼字中");
  assert.equal(imeBusy({ isComposing: false, keyCode: 13 }), false, "普通回车照常发送");
  // 补全浮层的回车与发送的回车都要走这个判断
  assert.equal((src.match(/!imeBusy\(e\)/g) || []).length, 2, "两处回车判断都要拦拼字中的情况");
});

function pasteHarness() {
  const handlers = {};
  const calls = { uploads: 0, files: [] };
  const box = {
    inputEl: { addEventListener: (type, fn) => { handlers[type] = fn; } },
    uploadFiles: async (files) => { calls.uploads++; calls.files = files.map((f) => f.name); },
  };
  vm.createContext(box);
  const a = src.indexOf('inputEl.addEventListener("paste"');
  const b = src.indexOf('popupList.addEventListener("click"', a);
  assert.ok(a > 0 && b > a, "找不到 paste 监听");
  vm.runInContext(src.slice(a, b), box);
  return { paste: handlers.paste, calls };
}

const pasteEvent = ({ text = "", file = null } = {}) => {
  const ev = {
    prevented: false,
    preventDefault() { ev.prevented = true; },
    clipboardData: {
      items: file ? [{ kind: "file", getAsFile: () => file }] : text ? [{ kind: "string", type: "text/plain" }] : [],
      getData: (type) => (type === "text/plain" ? text : ""),
    },
  };
  return ev;
};

test("FIND-012 图文混合粘贴：文字走浏览器默认粘贴，图片照常收进附件", async () => {
  const h = pasteHarness();
  const ev = pasteEvent({ text: "这段文字不能丢", file: { name: "图.png" } });
  await h.paste(ev);
  assert.equal(ev.prevented, false, "有文字时不能 preventDefault，否则文字被吞");
  assert.equal(h.calls.files.join(","), "图.png", "图片仍要上传");
});

test("FIND-012 只复制图片时照旧拦下默认粘贴；纯文字不碰", async () => {
  const h = pasteHarness();
  const img = pasteEvent({ file: { name: "a.png" } });
  await h.paste(img);
  assert.equal(img.prevented, true, "只有图片时要拦默认粘贴");
  assert.equal(h.calls.uploads, 1);
  const txt = pasteEvent({ text: "只有文字" });
  await h.paste(txt);
  assert.equal(txt.prevented, false);
  assert.equal(h.calls.uploads, 1, "纯文字粘贴不触发上传");
});

test("FIND-012 /rename 连点两次只发一条请求，上一次回来后才允许重试", async () => {
  const a = src.indexOf('if (typed.startsWith("/rename ")) {');
  const b = src.indexOf("const cid = newCid();", a);
  assert.ok(a > 0 && b > a, "找不到 /rename 分支");
  const releases = [];
  let apiCalls = 0;
  const box = {
    view: { sessionId: "s1", gen: 1 },
    toast: () => {},
    t: (s) => s,
    api: () => { apiCalls++; return new Promise((ok) => releases.push(ok)); },
    inputEl: { value: "/rename 新标题" },
    autoGrow: () => {},
    loadSessions: () => {},
    renameBusy: "",
  };
  vm.createContext(box);
  const go = vm.runInContext(`(async function (typed, fromInput) {\n${src.slice(a, b)}\n})`, box);
  const p1 = go("/rename 新标题", true);
  const p2 = go("/rename 新标题", true);
  assert.equal(apiCalls, 1, "第二条同文重命名不应该再发");
  releases.forEach((ok) => ok({}));
  await Promise.all([p1, p2]);
  assert.equal(box.renameBusy, "", "回执回来后要清掉在途标记，允许再改");
  box.inputEl.value = "/rename 新标题";
  const p3 = go("/rename 新标题", true);
  assert.equal(apiCalls, 2, "上一次结束后再点要能发出去");
  releases[1]({});
  await p3;
});
