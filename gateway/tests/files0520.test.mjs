// v0.5.20 审查 #106 07-007（目录软链在列表里被当成普通文件）、07-008（stat 先 trim，末尾带空格的真文件打不开）
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { CFG } from "../gw/config.mjs";
import { NEXT } from "../gw/http.mjs";
import { routeFiles } from "../gw/files.mjs";

const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if ((await routeFiles(req, res, u, u.pathname)) !== NEXT) return;
  res.writeHead(404).end();
});
await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
fs.mkdirSync(CFG.workspace, { recursive: true });
const root = fs.mkdtempSync(path.join(CFG.workspace, "files0520-"));
after(() => { srv.close(); fs.rmSync(root, { recursive: true, force: true }); });
const get = async (p) => { const r = await fetch(`http://127.0.0.1:${srv.address().port}${p}`); return { status: r.status, body: await r.json() }; };

test("07-007 目录软链按目录列出（能点进去），文件软链、悬空链接、指向私有目录的照旧不算目录", async () => {
  fs.mkdirSync(path.join(root, "target-dir"));
  fs.writeFileSync(path.join(root, "target-dir", "a.txt"), "a");
  fs.writeFileSync(path.join(root, "f.txt"), "f");
  fs.symlinkSync(path.join(root, "target-dir"), path.join(root, "dir-link"));
  fs.symlinkSync(path.join(root, "f.txt"), path.join(root, "file-link"));
  fs.symlinkSync(path.join(root, "nowhere"), path.join(root, "dangling"));
  fs.symlinkSync(CFG.home, path.join(root, "home-link"));
  const r = await get("/api/files?path=" + encodeURIComponent(root));
  assert.equal(r.status, 200);
  const e = Object.fromEntries(r.body.entries.map((x) => [x.name, x]));
  assert.equal(e["dir-link"].dir, true, "目录软链要能进");
  assert.equal(e["dir-link"].kind, "dir");
  assert.equal(e["file-link"].dir, false);
  assert.equal(e["file-link"].size, 1);
  assert.equal(e["dangling"].dir, false);
  assert.equal(e["home-link"].dir, false, "指向私有目录的不当目录列（点进去也是 403）");
  assert.equal(e["home-link"].mtime, 0, "也不报目标的时间");
  const inside = await get("/api/files?path=" + encodeURIComponent(path.join(root, "dir-link")));
  assert.deepEqual(inside.body.entries.map((x) => x.name), ["a.txt"]);
});

test("07-008 stat 先按原样找：末尾带空格的真文件、和同名不带空格的并存时各认各的；复制来带换行的照样去空白", async () => {
  const sp = path.join(root, "report.txt "), plain = path.join(root, "report.txt");
  fs.writeFileSync(sp, "with space");
  let r = await get("/api/file/stat?path=" + encodeURIComponent(sp));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.path, sp);
  fs.writeFileSync(plain, "plain!");
  r = await get("/api/file/stat?path=" + encodeURIComponent(sp));
  assert.equal(r.body.path, sp, "两个都在：认带空格的那个");
  assert.equal(r.body.size, 10);
  r = await get("/api/file/stat?path=" + encodeURIComponent(plain + "\n"));
  assert.equal(r.status, 200);
  assert.equal(r.body.path, plain, "原样找不到才去空白");
  r = await get("/api/file/stat?path=" + encodeURIComponent(path.join(root, "none.txt")));
  assert.equal(r.status, 404);
  r = await get("/api/file/stat?path=" + encodeURIComponent(" rel.txt"));
  assert.equal(r.status, 400);
});
