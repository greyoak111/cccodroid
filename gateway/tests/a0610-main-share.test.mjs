// 199-1-05：别的应用分享文件进来，先问再拷；拷进来的记清单，附件栏移除 / 草稿丢弃时删，发出去就划掉（源码断言，壳侧要真机验）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const MA = rd("android/java/cc/codroid/MainActivity.java");
const body = (src, head) => { const i = src.indexOf(head); assert.ok(i >= 0, head); return src.slice(i, src.indexOf("\n    }\n", i)); };

test("有文件时先弹过 guard 的确认框，点「收下」才拷；只有文字不问", () => {
  const rs = body(MA, "private void receiveShare(Intent i)");
  const ask = rs.indexOf("收下分享的文件？"), copy = rs.lastIndexOf("copyShares(uris, text)");
  assert.ok(ask > 0 && copy > ask, "确认框要在拷贝之前");
  assert.match(rs, /setPositiveButton\(Tr\.t\("收下"\), \(x, w\) -> copyShares\(uris, text\)\)/);
  assert.match(rs, /guard\(d, android\.content\.DialogInterface\.BUTTON_POSITIVE\)/);
  assert.match(rs, /if \(uris\.isEmpty\(\)\) \{[\s\S]*?copyShares\(uris, text\);\s*return;/);
  assert.doesNotMatch(rs, /new Thread\(/, "拷贝不能在问之前就起线程");
});

test("拷成功才记清单；删只删清单里、uploads/ 下的普通文件；桥方法要口令", () => {
  const cp = body(MA, "private void copyShares(");
  assert.match(cp, /copyIn\(in, o, dir\);\s*n\+\+;\s*shareMade\(out\.getPath\(\)\);/);
  const done = body(MA, "private void shareDone(String path, boolean drop)");
  assert.ok(done.indexOf("made.remove(path)") < done.indexOf("f.delete()"), "不在清单里的不删");
  assert.match(done, /getCanonicalPath\(\)\.equals\(f\.getParentFile\(\)\.getCanonicalPath\(\)\)/);
  assert.match(done, /NOFOLLOW_LINKS/);
  assert.match(MA, /public void shareDone\(String k, String path, boolean drop\) \{ if \(!Env\.bridgeOk\(k\)\) return;/);
  assert.match(rd("gateway/web/theme.js"), /const KEYED = \[[^\]]*"shareDone"\]/);
});

test("界面：移除附件、/clear、草稿被挤掉时删；正常发出只划掉", () => {
  const c = rd("gateway/web/app/05-composer.js");
  assert.match(body(c, "function removeAttachment(a)"), /shareDone\(\[a\], true\)/);
  assert.match(c, /typed === "\/new"\) \{\s*if \(fromInput\) \{[^}]*clearAttachments\(true\)/);
  assert.match(c, /keys\.slice\(30\)\) \{ shareDone\(all\[k\]\.att, true\);/);
  assert.match(c, /const mine = [^\n]*\n\s*if \(fromInput\) \{ inputEl\.value = ""; autoGrow\(\); clearAttachments\(\); \}/);
  assert.match(body(c, "function clearAttachments(drop)"), /shareDone\(state\.attachments, drop\)/);
});

test("新文案都有 9 种译文", () => {
  for (const l of ["ar", "en", "es", "fr", "id", "ja", "ko", "ru", "zh-Hant"]) {
    const o = JSON.parse(rd(`android/assets/i18n/java-${l}.json`));
    for (const k of ["来源不明的应用", "收下分享的文件？", "收下", "不收"]) assert.ok(o[k], `${l} 缺 ${k}`);
    assert.ok(Object.keys(o).some((k) => k.startsWith("「{0}」要放 {1} 个文件进工作区的 uploads/")), l);
  }
});
