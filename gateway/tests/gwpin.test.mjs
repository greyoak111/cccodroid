// 网关起 claude 前按钉子核 files/gw/glibc（gw/gwpin.mjs，安全 4 第 2 层）
import { PATHS } from "../gw/config.mjs"; // scripts/test.mjs 先隔离 HOME / fake PREFIX
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const { gwGlibcBad, gwRuntimeBlocked } = await import("../gw/gwpin.mjs");
const h = (b) => crypto.createHash("sha256").update(b).digest("hex");

test("gwpin：钉子里的文件都对上才放行；改过、少了、多出来的、换成软链的都算对不上", () => {
  const dir = fs.mkdtempSync(path.join(process.env.CCAPP_WORKSPACE, "gwglibc-"));
  const prev = PATHS.claudeLib;
  PATHS.claudeLib = dir;
  try {
    fs.writeFileSync(path.join(dir, "libc.so.6"), "libc v1");
    fs.writeFileSync(path.join(dir, "ld-linux-aarch64.so.1"), "ld v1");
    const pin = { "libc.so.6": h("libc v1"), "ld-linux-aarch64.so.1": h("ld v1") };
    assert.deepEqual(gwGlibcBad({ pin, dir }), []);
    assert.deepEqual(gwGlibcBad({ pin, dir }), [], "第二遍走缓存，结论一样");
    // 改内容（同样大小也要认出来：ctime 变了就重算）
    fs.writeFileSync(path.join(dir, "libc.so.6"), "libc v2");
    assert.deepEqual(gwGlibcBad({ pin, dir }), ["libc.so.6"]);
    fs.writeFileSync(path.join(dir, "libc.so.6"), "libc v1");
    assert.deepEqual(gwGlibcBad({ pin, dir }), []);
    // 多塞一个库
    fs.writeFileSync(path.join(dir, "libnss_evil.so.2"), "x");
    assert.deepEqual(gwGlibcBad({ pin, dir }), ["libnss_evil.so.2"]);
    fs.rmSync(path.join(dir, "libnss_evil.so.2"));
    // 删掉一个
    fs.rmSync(path.join(dir, "ld-linux-aarch64.so.1"));
    assert.deepEqual(gwGlibcBad({ pin, dir }), ["ld-linux-aarch64.so.1"]);
    // 换成指向内容相同的文件的软链：也不认（应用只写普通文件）
    const elsewhere = path.join(dir, "..", "ld-copy-" + path.basename(dir));
    fs.writeFileSync(elsewhere, "ld v1");
    fs.symlinkSync(elsewhere, path.join(dir, "ld-linux-aarch64.so.1"));
    assert.deepEqual(gwGlibcBad({ pin, dir }), ["ld-linux-aarch64.so.1"]);
    fs.rmSync(elsewhere);
    // 网关没用自己那份（开发版退回 $PREFIX、开发布局）：不核
    assert.deepEqual(gwGlibcBad({ pin: null, dir }), []);
    PATHS.claudeLib = "/elsewhere";
    assert.deepEqual(gwGlibcBad({ pin, dir }), []);
  } finally { PATHS.claudeLib = prev; fs.rmSync(dir, { recursive: true, force: true }); }
});

test("gwpin：测试环境没交钉子，起 claude 前的检查放行", () => {
  assert.equal(gwRuntimeBlocked(), "");
});
