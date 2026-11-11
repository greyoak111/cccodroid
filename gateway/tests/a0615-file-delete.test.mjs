// 文件页删除（/api/file/delete）：工作区里的文件、文件夹、软链能删；私有目录、凭据名、工作区本身与它的上级不能删
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CFG } from "../gw/config.mjs";
import { routeFiles } from "../gw/files.mjs";

function fakeRes() {
  const r = { code: 0, body: null, writeHead(c) { r.code = c; }, end(b) { r.body = b ? JSON.parse(String(b)) : null; } };
  return r;
}
async function del(p) {
  const res = fakeRes();
  await routeFiles({ method: "POST", headers: {} }, res, new URL(`http://x/api/file/delete?path=${encodeURIComponent(p)}`), "/api/file/delete");
  return res;
}

test("删除：文件、整个文件夹、软链（只删链接）", async () => {
  const W = path.join(CFG.workspace, "deltest");
  fs.mkdirSync(path.join(W, "dir/sub"), { recursive: true });
  fs.writeFileSync(path.join(W, "a.txt"), "x");
  fs.writeFileSync(path.join(W, "dir/sub/b.txt"), "y");
  fs.writeFileSync(path.join(W, "keep.txt"), "k");
  fs.symlinkSync(path.join(W, "keep.txt"), path.join(W, "ln"));
  assert.equal((await del(path.join(W, "a.txt"))).code, 200);
  assert.equal(fs.existsSync(path.join(W, "a.txt")), false);
  assert.equal((await del(path.join(W, "dir"))).code, 200);
  assert.equal(fs.existsSync(path.join(W, "dir")), false);
  assert.equal((await del(path.join(W, "ln"))).code, 200);
  assert.equal(fs.existsSync(path.join(W, "ln")), false);
  assert.equal(fs.readFileSync(path.join(W, "keep.txt"), "utf8"), "k", "软链指向的文件不动");
  assert.equal((await del(path.join(W, "nope"))).code, 404);
  assert.equal((await del("relative.txt")).code, 400);
});

test("删除：凭据名、工作区本身与上级、私有目录里的都拒绝", async () => {
  fs.mkdirSync(CFG.workspace, { recursive: true });
  fs.writeFileSync(path.join(CFG.workspace, "id_ed25519"), "k");
  assert.equal((await del(path.join(CFG.workspace, "id_ed25519"))).code, 403);
  assert.equal(fs.existsSync(path.join(CFG.workspace, "id_ed25519")), true);
  assert.equal((await del(CFG.workspace)).code, 403);
  assert.equal((await del(path.dirname(CFG.workspace))).code, 403);
  const priv = path.join(CFG.home, "victim.txt");
  fs.writeFileSync(priv, "v");
  assert.equal((await del(priv)).code, 403, "应用 home 里的文件");
  assert.equal(fs.existsSync(priv), true);
  assert.equal((await del("/")).code, 400);
});
