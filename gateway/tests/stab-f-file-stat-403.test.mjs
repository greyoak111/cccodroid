// 稳定性报告 FIND-029：共享存储权限被撤回（或目录没有执行权限）时，
// /api/file/stat 以前一律回 404「文件不存在」，界面让用户去找一个其实还在的文件；
// /api/file 早已区分 403，stat 要跟它一致。
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
const root = fs.mkdtempSync(path.join(CFG.workspace, "stabf-stat-"));
after(() => { srv.close(); fs.chmodSync(path.join(root, "locked"), 0o755); fs.rmSync(root, { recursive: true, force: true }); });
const get = async (p) => { const r = await fetch(`http://127.0.0.1:${srv.address().port}${p}`); return { status: r.status, body: await r.json() }; };

test("FIND-029 没有权限的路径回 403 和权限提示，不再是 404", async () => {
  const locked = path.join(root, "locked");
  fs.mkdirSync(locked);
  const f = path.join(locked, "a.txt");
  fs.writeFileSync(f, "x");
  fs.chmodSync(locked, 0o000);
  try {
    const r = await get("/api/file/stat?path=" + encodeURIComponent(f));
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.error, "forbidden");
    assert.match(r.body.message, /权限/);
    // 同一个位置走 /api/file 也是 403（原有行为，两边要一致）
    const rd = await get("/api/file?path=" + encodeURIComponent(f));
    assert.equal(rd.status, 403);
  } finally {
    fs.chmodSync(locked, 0o755);
  }
  const ok = await get("/api/file/stat?path=" + encodeURIComponent(f));
  assert.equal(ok.status, 200, "权限恢复后照常 stat");
  const missing = await get("/api/file/stat?path=" + encodeURIComponent(path.join(root, "none.txt")));
  assert.equal(missing.status, 404, "真不存在的还是 404");
});
