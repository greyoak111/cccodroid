// 文件接口（gw/files.mjs）：核完路径、收请求体期间被换成软链，保存不能顺着软链写到别处（审查 v0.5.4 B-L1）
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下，下面一行都不跑
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { CFG } from "../gw/config.mjs";
import { routeFiles } from "../gw/files.mjs";

function fakeRes() {
  const r = { code: 0, body: null, writeHead(c) { r.code = c; }, end(b) { r.body = b ? JSON.parse(String(b)) : null; } };
  return r;
}

test("保存途中目标被换成软链：拒绝，软链指向的文件不被改", async () => {
  fs.mkdirSync(CFG.workspace, { recursive: true });
  const target = path.join(CFG.home, "secret-victim.txt");
  const file = path.join(CFG.workspace, "edit-me.txt");
  fs.writeFileSync(target, "ORIGINAL");
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, "old");
  const mtime = fs.statSync(file).mtimeMs;
  // 请求体分两段到：第一段到了以后、请求体还没收完时把文件换成指向 home 里那个文件的软链
  let n = 0;
  const req = new Readable({ read() {
    if (n === 0) { n++; this.push(Buffer.from("PWN")); }
    else if (n === 1) { n++; fs.rmSync(file); fs.symlinkSync(target, file); this.push(Buffer.from("ED")); this.push(null); }
  } });
  req.method = "POST"; req.headers = {};
  const res = fakeRes();
  const u = new URL(`http://x/api/file/save?path=${encodeURIComponent(file)}&mtime=${mtime}`);
  await routeFiles(req, res, u, "/api/file/save");
  assert.notEqual(res.code, 200, JSON.stringify(res.body));
  assert.equal(fs.readFileSync(target, "utf8"), "ORIGINAL");
  fs.rmSync(file, { force: true }); fs.rmSync(target, { force: true });
});

test("正常保存照旧", async () => {
  fs.mkdirSync(CFG.workspace, { recursive: true });
  const file = path.join(CFG.workspace, "edit-ok.txt");
  fs.writeFileSync(file, "old");
  const req = Readable.from([Buffer.from("new")]); req.method = "POST"; req.headers = {};
  const res = fakeRes();
  const u = new URL(`http://x/api/file/save?path=${encodeURIComponent(file)}&mtime=${fs.statSync(file).mtimeMs}`);
  await routeFiles(req, res, u, "/api/file/save");
  assert.equal(res.code, 200, JSON.stringify(res.body));
  assert.equal(fs.readFileSync(file, "utf8"), "new");
  fs.rmSync(file, { force: true });
});

test("保存时写盘失败：原文件一个字节都不动（#121-3）", async (t) => {
  fs.mkdirSync(CFG.workspace, { recursive: true });
  const file = path.join(CFG.workspace, "save-disk-full.txt");
  fs.writeFileSync(file, "ORIGINAL");
  const mtime = fs.statSync(file).mtimeMs;
  const m = t.mock.method(fs, "writeFileSync", () => { throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" }); });
  try {
    const req = Readable.from([Buffer.from("NEW")]); req.method = "POST"; req.headers = {};
    const res = fakeRes();
    const u = new URL(`http://x/api/file/save?path=${encodeURIComponent(file)}&mtime=${mtime}`);
    await routeFiles(req, res, u, "/api/file/save");
    assert.equal(res.code, 500, JSON.stringify(res.body));
    assert.equal(fs.readFileSync(file, "utf8"), "ORIGINAL");
  } finally {
    m.mock.restore();
    fs.rmSync(file, { force: true });
  }
});
