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

// 请求体分两段到，中间执行 swap()
function slowBody(swap) {
  let n = 0;
  const req = new Readable({ read() {
    if (n === 0) { n++; this.push(Buffer.from("PWN")); }
    else if (n === 1) { n++; swap(); this.push(Buffer.from("ED")); this.push(null); }
  } });
  req.method = "POST"; req.headers = {};
  return req;
}

test("保存途中目标被换成悬空软链：拒绝，软链原样留着（#121-3 复核）", async () => {
  fs.mkdirSync(CFG.workspace, { recursive: true });
  const file = path.join(CFG.workspace, "dangle-me.txt"), ghost = path.join(CFG.home, "ghost-target.txt");
  fs.rmSync(ghost, { force: true }); fs.rmSync(file, { force: true });
  fs.writeFileSync(file, "old");
  const mtime = fs.statSync(file).mtimeMs;
  const res = fakeRes();
  const u = new URL(`http://x/api/file/save?path=${encodeURIComponent(file)}&mtime=${mtime}`);
  await routeFiles(slowBody(() => { fs.rmSync(file); fs.symlinkSync(ghost, file); }), res, u, "/api/file/save");
  assert.notEqual(res.code, 200, JSON.stringify(res.body));
  assert.ok(fs.lstatSync(file).isSymbolicLink(), "软链不能被悄悄换成普通文件");
  assert.ok(!fs.existsSync(ghost));
  fs.rmSync(file, { force: true });
});

test("新建文件在路由重核之后、落盘之前上级目录被换成软链：拒绝，别处不多出文件（#121-3 复核）", async (t) => {
  const sub = path.join(CFG.workspace, "swap-dir"), away = path.join(CFG.home, "away-dir");
  fs.rmSync(sub, { recursive: true, force: true }); fs.rmSync(away, { recursive: true, force: true });
  fs.mkdirSync(sub, { recursive: true }); fs.mkdirSync(away, { recursive: true });
  const file = path.join(sub, "fresh.txt");
  // 卡在打开临时文件那一刻换：路由的重核已经过了，只剩 writeNoFollow 自己的核对
  const open = fs.openSync;
  let swapped = false;
  const m = t.mock.method(fs, "openSync", (p, ...a) => {
    if (!swapped && String(p).includes(".ccsave-")) { swapped = true; fs.rmSync(sub, { recursive: true }); fs.symlinkSync(away, sub); }
    return open(p, ...a);
  });
  const req = Readable.from([Buffer.from("PWNED")]); req.method = "POST"; req.headers = {};
  const res = fakeRes();
  try {
    await routeFiles(req, res, new URL(`http://x/api/file/save?path=${encodeURIComponent(file)}`), "/api/file/save");
  } finally { m.mock.restore(); }
  assert.ok(swapped, "要真的走到写临时文件那一步");
  assert.notEqual(res.code, 200, JSON.stringify(res.body));
  assert.deepEqual(fs.readdirSync(away), [], "不能顺着换上的软链写进别的目录（临时文件也要清掉）");
  fs.rmSync(sub, { force: true }); fs.rmSync(away, { recursive: true, force: true });
});

test("打开后原文件被改名：带着打开时的 mtime 保存要 409，不按旧名悄悄新建（#145-2）", async () => {
  fs.mkdirSync(CFG.workspace, { recursive: true });
  const file = path.join(CFG.workspace, "note145.txt"), moved = path.join(CFG.workspace, "renamed145.txt");
  fs.writeFileSync(file, "old");
  const mtime = fs.statSync(file).mtimeMs;
  fs.renameSync(file, moved);
  const save = async (force) => {
    const req = Readable.from([Buffer.from("edited")]); req.method = "POST"; req.headers = {};
    const res = fakeRes();
    await routeFiles(req, res, new URL(`http://x/api/file/save?path=${encodeURIComponent(file)}&mtime=${mtime}${force ? "&force=1" : ""}`), "/api/file/save");
    return res;
  };
  const r1 = await save(false);
  assert.equal(r1.code, 409, JSON.stringify(r1.body));
  assert.equal(r1.body.error, "gone");
  assert.equal(fs.existsSync(file), false, "旧名不能被悄悄建出来");
  const r2 = await save(true);   // 用户确认按原名另存
  assert.equal(r2.code, 200, JSON.stringify(r2.body));
  assert.equal(fs.readFileSync(file, "utf8"), "edited");
  assert.equal(fs.readFileSync(moved, "utf8"), "old");
  fs.rmSync(file, { force: true }); fs.rmSync(moved, { force: true });
});

test("保存路径末尾的 /. 不能绕过密钥文件检查", async () => {
  fs.mkdirSync(CFG.workspace, { recursive: true });
  const file = path.join(CFG.workspace, "ccapp-providers.json");
  fs.writeFileSync(file, "ORIGINAL");
  const req = Readable.from([Buffer.from("PWNED")]);
  req.method = "POST"; req.headers = {};
  const res = fakeRes();
  const u = new URL(`http://x/api/file/save?path=${encodeURIComponent(file + "/.")}&force=1`);
  await routeFiles(req, res, u, "/api/file/save");
  assert.notEqual(res.code, 200, JSON.stringify(res.body));
  assert.equal(fs.readFileSync(file, "utf8"), "ORIGINAL");
  fs.rmSync(file, { force: true });
});
