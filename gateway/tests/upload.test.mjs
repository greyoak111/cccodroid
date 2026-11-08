// 附件上传（gw/files.mjs /api/upload）：流式落盘，不再受 64 MB 内存缓冲限制；0 字节文件照收
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Readable } from "node:stream";
import { routeFiles } from "../gw/files.mjs";

function call(chunks, name, headers = {}) {
  const res = { code: 0, body: null, writeHead(c) { res.code = c; }, setHeader() {}, end(b) { res.body = b ? JSON.parse(String(b)) : null; } };
  const req = Readable.from(chunks); req.method = "POST"; req.headers = headers;
  const u = new URL("http://x/api/upload?name=" + encodeURIComponent(name));
  return routeFiles(req, res, u, u.pathname).then(() => res);
}

test("大附件流式落盘：70 MB 照收、大小对得上", async () => {
  const MB = Buffer.alloc(1 << 20, 7);
  const r = await call(function* () { for (let i = 0; i < 70; i++) yield MB; }(), "big file.bin");
  assert.equal(r.code, 200);
  assert.equal(r.body.size, 70 << 20);
  assert.equal(fs.statSync(r.body.path).size, 70 << 20);
  assert.match(r.body.name, /big_file\.bin$/);
  fs.rmSync(r.body.path);
});

test("0 字节文件照收、不留临时文件；声明超过上限直接 413", async () => {
  // 195-C.18：0 字节文件也是合法附件，原来空体一律 400 导致这类文件永远传不上去。
  const r = await call([], "e.txt");
  assert.equal(r.code, 200);
  assert.equal(r.body.size, 0);
  assert.equal(fs.statSync(r.body.path).size, 0);
  fs.rmSync(r.body.path);
  const big = await call([Buffer.from("x")], "x.bin", { "content-length": String(5 * 1024 ** 3) });
  assert.equal(big.code, 413);
});
