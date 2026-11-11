// 稳定性报告 FIND-028：附件路径写成 @"…" 时只转义了引号。
// 反斜杠会把后面的字吃掉（气泡里路径还原不回去），换行 / 回车 / 制表符留在引号里会把这一行拆开。
// 发送端的 attAt 与气泡解析的 splitRefs 必须一一对应，所以两边一起在 vm 里跑真代码。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const read = (p) => fs.readFileSync(new URL(`../web/${p}`, import.meta.url), "utf8");
const src02 = read("app/02-chat-view.js");
const src05 = read("app/05-composer.js");

function load() {
  const marker = '\'"\' : "@" + p);';
  const at0 = src05.indexOf("  const attAt =");
  const at1 = src05.indexOf(marker, at0);
  assert.ok(at0 > 0 && at1 > at0, "05-composer.js 里找不到 attAt");
  const a = src02.indexOf("  const IMG_RE");
  const b = src02.indexOf("  function refsHtml", a);
  assert.ok(a > 0 && b > a, "02-chat-view.js 里找不到 splitRefs");
  const code = `
${src05.slice(at0, at1 + marker.length)}
${src02.slice(a, b)}
globalThis.__h = { attAt, splitRefs };
`;
  const ctx = {};
  vm.runInNewContext(code, ctx);
  return ctx.__h;
}

const roundTrip = (h, p) => {
  const ref = h.attAt(p);
  assert.ok(!/[\r\n\t]/.test(ref), "引用本身不能带真的换行 / 制表符：" + JSON.stringify(ref));
  const [body, refs] = h.splitRefs("看一下 " + ref);
  assert.equal(body, "看一下");
  assert.equal(refs.length, 1);
  return { ref, p: refs[0].p };
};

test("FIND-028 普通路径 / 带空白路径照旧", () => {
  const h = load();
  assert.equal(h.attAt("/sdcard/a.txt"), "@/sdcard/a.txt");
  assert.equal(roundTrip(h, "/sdcard/My File.txt").p, "/sdcard/My File.txt");
});

test("FIND-028 引号、反斜杠、换行、制表符都能原样还原", () => {
  const h = load();
  for (const p of [
    '/sdcard/a"b.txt',
    "/sdcard/a\\b.txt",
    "/sdcard/a\nb.txt",
    "/sdcard/a\rb.txt",
    "/sdcard/a\tb.txt",
    String.raw`/sdcard/a\n.txt`,     // 文件名里真的是反斜杠 + n，不是换行
    String.raw`/sdcard/a\"b.txt`,    // 反斜杠 + 引号
  ]) {
    const got = roundTrip(h, p);
    assert.equal(got.p, p, "路径没还原：" + JSON.stringify(p) + " → " + JSON.stringify(got.ref));
  }
});

test("FIND-028 带反斜杠但没空白的路径也走引号形式，免得转义规则两套", () => {
  const h = load();
  const p = "/sdcard/a\\b.txt";
  const ref = h.attAt(p);
  assert.ok(ref.startsWith('@"') && ref.endsWith('"'), "带反斜杠要加引号");
  assert.ok(ref.includes("\\\\"), "反斜杠本身要转义");
});
