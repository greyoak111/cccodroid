import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const web = process.env.CCAPP_TEST_WEB || fileURLToPath(new URL("../web/", import.meta.url));
const core = fs.readFileSync(path.join(web, "app/01-core.js"), "utf8");
const source = core.slice(core.indexOf("  function codeHighlightable("), core.indexOf("\n  // ── 图片查看器"));

function fixture(texts, load = () => Promise.resolve()) {
  let calls = 0, loads = 0;
  const code = text => {
    const classes = new Set();
    return {
      textContent: text, dataset: { lang: "javascript" }, innerHTML: "",
      classList: { add: k => classes.add(k), contains: k => classes.has(k) },
    };
  };
  const nodes = texts.map(code);
  const pending = () => nodes.filter(n => !n.classList.contains("hl"));
  const el = {
    contains: n => nodes.includes(n),
    querySelector: s => s.startsWith("code") ? pending()[0] : null,
    querySelectorAll: s => s.startsWith("code") ? pending() : [],
  };
  const context = vm.createContext({
    window: { hljs: {
      getLanguage: () => true,
      highlight: text => { calls++; return { value: "highlight:" + text }; },
    } },
    loadScript: () => { loads++; return load(); },
  });
  vm.runInContext(source + "\nthis.api = { codeHighlightable, enhanceMd };", context);
  return {
    api: context.api, el, nodes,
    replace: text => nodes.splice(0, nodes.length, code(text)),
    calls: () => calls, loads: () => loads,
  };
}
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

test("small code retains highlighting, repeated enhancement does not repeat work", async () => {
  const f = fixture(["const a = 1;"]);
  f.api.enhanceMd(f.el, true); await settle();
  assert.equal(f.calls(), 1);
  assert.equal(f.nodes[0].innerHTML, "highlight:const a = 1;");
  f.api.enhanceMd(f.el, true); await settle();
  assert.equal(f.calls(), 1);
});

test("streaming budget rejects by chars and lines before loading a library", async () => {
  for (const text of ["x".repeat(2001), "x\n".repeat(40)]) {
    const f = fixture([text]);
    f.api.enhanceMd(f.el, true); await settle();
    assert.equal(f.calls(), 0);
    assert.equal(f.loads(), 0);
    assert.equal(f.nodes[0].textContent, text);
  }
});

test("final medium code is eligible; very large final code stays copyable text", async () => {
  const medium = "x".repeat(3000), huge = "x".repeat(12001), long = "line\n".repeat(160), f = fixture([medium, huge, long]);
  f.api.enhanceMd(f.el); await settle();
  assert.equal(f.calls(), 1);
  // 3000 字节点真的被高亮成了库产物，不能只看调用次数（fixture 里 innerHTML 只有这里会被写）
  assert.equal(f.nodes[0].innerHTML, "highlight:" + medium);
  // 超过字数 / 行数预算的节点没有高亮产物，只被打上 .hl 标记，正文原样可复制
  assert.equal(f.nodes[1].innerHTML, "");
  assert.equal(f.nodes[2].innerHTML, "");
  assert.equal(f.nodes[1].classList.contains("hl"), true);
  assert.equal(f.nodes[2].classList.contains("hl"), true);
});

test("late script resolution rechecks streaming code that grew in place", async () => {
  let resolve;
  const f = fixture(["const a = 1;"], () => new Promise(r => resolve = r));
  f.api.enhanceMd(f.el, true);
  f.nodes[0].textContent = "line\n".repeat(100);
  resolve(); await settle();
  assert.equal(f.calls(), 0);
  assert.equal(f.nodes[0].textContent, "line\n".repeat(100));
});

test("pending streaming callback cannot suppress eligible final highlighting", async () => {
  let resolve;
  const ready = new Promise(r => resolve = r), f = fixture(["const a = 1;"], () => ready);
  f.api.enhanceMd(f.el, true);
  f.replace("x".repeat(3000));
  f.api.enhanceMd(f.el);
  resolve(); await settle();
  assert.equal(f.calls(), 1);
  assert.equal(f.nodes[0].innerHTML, "highlight:" + "x".repeat(3000));
});

test("lazy highlighting skips code removed by a later tail paint", async () => {
  let resolve;
  const ready = new Promise(r => resolve = r), f = fixture(["const a = 1;"], () => ready);
  const old = f.nodes[0];
  f.api.enhanceMd(f.el, true);
  f.replace("const b = 2;");
  resolve(); await settle();
  assert.equal(f.calls(), 0);
  assert.equal(old.innerHTML, "");
  assert.equal(f.nodes[0].innerHTML, "");
});

test("live tail invokes the streaming rather than final budget", () => {
  const chat = fs.readFileSync(path.join(web, "app/02-chat-view.js"), "utf8");
  assert.match(chat, /enhanceMd\(tail, true\)/);
  assert.ok(core.includes("window.hljs.highlight(text, { language: lang, ignoreIllegals: true })"));
});
