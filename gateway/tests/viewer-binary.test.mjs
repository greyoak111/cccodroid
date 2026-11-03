// 查看器「当作文本打开」：二进制文件不进编辑器（11MB 的 APK 解成一千多万字把界面卡死，群反馈 11-03）
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs 就在这里拦下
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync(new URL("../web/app/16-viewer-git.js", import.meta.url), "utf8");
const grab = (name) => { const a = src.indexOf(`function ${name}(`), b = src.indexOf("\n  }\n", a) + 4; return src.slice(a, b); };
const looksBinary = new Function(grab("vwLooksBinary") + "\nreturn vwLooksBinary;")();
const BIN_EXT = new Function("return " + src.match(/const VW_BIN_EXT = (\/.*\/i);/)[1])();

test("嗅探：ZIP/APK 头、NUL、控制字符扎堆算二进制；中文、带 BOM 的 UTF-16、带颜色的日志不算", () => {
  const apk = new Uint8Array(8192); apk.set([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0]);
  assert.equal(looksBinary(apk), true);
  assert.equal(looksBinary(new TextEncoder().encode("中文正文\n第二行\tTab")), false);
  const u16 = new Uint8Array([0xff, 0xfe, 0x2d, 0x4e, 0x87, 0x65, 0x0a, 0x00]);
  assert.equal(looksBinary(u16), false);
  assert.equal(looksBinary(new TextEncoder().encode("\x1b[31m错误\x1b[0m 一些说明文字 ".repeat(50))), false);
  assert.equal(looksBinary(new Uint8Array(Array.from({ length: 1000 }, (_, i) => (i % 5 ? 0x41 : 0x01)))), true);
  assert.equal(looksBinary(new Uint8Array(0)), false);
});

test("扩展名：APK、压缩包、库、音视频不给入口；没扩展名的、.log 照给", () => {
  for (const p of ["/sdcard/a.apk", "/x/b.ZIP", "/x/libc.so", "/x/v.mp4", "/x/s.flac", "/x/d.sqlite3"]) assert.equal(BIN_EXT.test(p), true, p);
  for (const p of ["/x/README", "/x/run.log", "/x/conf.ini", "/x/a.so.txt"]) assert.equal(BIN_EXT.test(p), false, p);
});

test("读进来先嗅再解码", () => {
  const body = grab("vwLoadText");
  assert.ok(body.indexOf("vwLooksBinary(bytes)") > 0 && body.indexOf("vwLooksBinary(bytes)") < body.indexOf("vwDecode(bytes)"));
});
