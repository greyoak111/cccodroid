// 分段并行下载（gw/pget.mjs）：本机起一个 HTTP 服务，模拟认 / 不认 Range、连接中途断、被打断后续传
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下，下面一行都不跑
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { pget, ghProxy } from "../gw/pget.mjs";
import { writeAll } from "../gw/bigfile.mjs";

const CURL = path.join(process.env.CCAPP_PREFIX, "bin", "curl");
const DIR = fs.mkdtempSync(path.join(process.env.CCAPP_TMP, "pget-"));
const DATA = crypto.randomBytes(20 << 20);            // 20 MB：够切 2 段（每段至少 8 MB）
const SHA = crypto.createHash("sha256").update(DATA).digest("hex");
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

// 服务端行为由 mode 决定；ranges 记下收到的 Range 头
const S = { mode: "range", ranges: [], breakOnce: new Set() };
const server = http.createServer((req, res) => {
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || "");
  if (m) S.ranges.push(m[0]);
  if (S.mode === "norange" || !m) { res.writeHead(200, { "content-length": DATA.length }); return res.end(DATA); }
  const a = +m[1], b = m[2] ? +m[2] : DATA.length - 1;
  res.writeHead(206, { "content-length": b - a + 1, "content-range": `bytes ${a}-${b}/${DATA.length}` });
  // flaky：前两个分段请求只给 1 MB 就断（探测请求 0-0 除外）；续传的请求照常给
  if (S.mode === "flaky" && b > a && S.breakOnce.size < 2) { S.breakOnce.add(a); res.write(DATA.subarray(a, a + (1 << 20))); return setTimeout(() => res.destroy(), 50); }
  res.end(DATA.subarray(a, b + 1));
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const URL_ = `http://127.0.0.1:${server.address().port}/f.bin`;
after(() => server.close());

const reset = (mode) => { S.mode = mode; S.ranges = []; S.breakOnce = new Set(); };
const fresh = (name) => { const f = path.join(DIR, name); fs.rmSync(f, { force: true }); fs.rmSync(f + ".seg", { force: true }); return f; };

test("认 Range：切段并行下，结果逐字节一致，.seg 用完删掉", async () => {
  reset("range");
  const f = fresh("a.part");
  assert.equal(await pget({ curl: CURL, url: URL_, file: f, total: DATA.length }), "");
  assert.equal(sha(f), SHA);
  assert.equal(fs.existsSync(f + ".seg"), false);
  assert.ok(S.ranges.filter((r) => r !== "bytes=0-0").length >= 2, "应该至少分成两段：" + S.ranges.join(" "));
});

test("不认 Range：退回单连接，照样下完", async () => {
  reset("norange");
  const f = fresh("b.part");
  assert.equal(await pget({ curl: CURL, url: URL_, file: f, total: DATA.length }), "");
  assert.equal(sha(f), SHA);
});

test("文件小于两段：不切，单连接", async () => {
  reset("range");
  const f = fresh("c.part");
  assert.equal(await pget({ curl: CURL, url: URL_, file: f, total: 10 << 20 }), "");   // 声称 10 MB：不到 2×8 MB
  assert.ok(!S.ranges.some((r) => r !== "bytes=0-0" && !r.startsWith("bytes=0-")), S.ranges.join(" "));
});

test("连接中途断：每段自己重试接着下，结果一致", async () => {
  reset("flaky");
  const f = fresh("d.part");
  assert.equal(await pget({ curl: CURL, url: URL_, file: f, total: DATA.length }), "");
  assert.equal(sha(f), SHA);
  assert.equal(S.breakOnce.size, 2, "两段都该断过一次");
  assert.ok(S.ranges.some((r) => /^bytes=(\d+)-/.test(r) && !S.breakOnce.has(+/^bytes=(\d+)-/.exec(r)[1]) && r !== "bytes=0-0"), "应该有从断点续传的请求");
});

test("被打断后续传：只要还没下的部分", async () => {
  reset("range");
  const f = fresh("e.part");
  // 模拟上回下到一半：两段各下了 3 MB，.part 占满到总大小，已下的部分是真数据
  const half = DATA.length / 2, done = 3 << 20;
  const buf = Buffer.alloc(DATA.length);
  DATA.copy(buf, 0, 0, done); DATA.copy(buf, half, half, half + done);
  fs.writeFileSync(f, buf);
  fs.writeFileSync(f + ".seg", JSON.stringify({ total: DATA.length, segs: [[0, half - 1, done], [half, DATA.length - 1, done]] }));
  assert.equal(await pget({ curl: CURL, url: URL_, file: f, total: DATA.length }), "");
  assert.equal(sha(f), SHA);
  const asked = S.ranges.filter((r) => r !== "bytes=0-0").sort();
  assert.deepEqual(asked, [`bytes=${done}-${half - 1}`, `bytes=${half + done}-${DATA.length - 1}`].sort());
});

test(".seg 和 .part 对不上（.part 被删了）：两个都作废重来", async () => {
  reset("range");
  const f = fresh("f.part");
  fs.writeFileSync(f + ".seg", JSON.stringify({ total: DATA.length, segs: [[0, DATA.length - 1, 5 << 20]] }));
  assert.equal(await pget({ curl: CURL, url: URL_, file: f, total: DATA.length }), "");
  assert.equal(sha(f), SHA);
});

test("上回已经下全、没来得及改名：直接算完成，不再请求", async () => {
  reset("range");
  const f = fresh("g.part");
  fs.writeFileSync(f, DATA);
  assert.equal(await pget({ curl: CURL, url: URL_, file: f, total: DATA.length }), "");
  assert.equal(S.ranges.length, 0);
});

test("取消：返回非空错误，.part 和 .seg 留着好续传", async () => {
  reset("range");
  const f = fresh("h.part");
  let n = 0;
  const err = await pget({ curl: CURL, url: URL_, file: f, total: DATA.length, cancelled: () => ++n > 1 });
  assert.notEqual(err, "");
  assert.equal(fs.existsSync(f + ".seg"), true);
});

test("ghProxy：只改写 github.com 的地址", () => {
  assert.equal(ghProxy("https://github.com/a/b/releases/download/x/y.tgz"), "https://gh-proxy.com/github.com/a/b/releases/download/x/y.tgz");
  assert.equal(ghProxy("https://dl.cccodroid.net/x"), "");
  assert.equal(ghProxy(""), "");
});

test("curl 起不来：返回错误，不留未处理的 error 把网关带走（#102 04-006）", async () => {
  const f = fresh("nocurl.part");
  const err = await pget({ curl: path.join(DIR, "no-such-curl"), url: URL_, file: f, total: DATA.length });
  assert.match(err, /ENOENT/);
});

test("写盘失败：返回错误，别把网关带走（#121-2）", async (t) => {
  reset("range");
  const f = fresh("diskerr.part");
  const orig = fs.writeSync;
  const m = t.mock.method(fs, "writeSync", function (fd, b, off, len, pos) {
    if (typeof pos === "number") throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
    return orig.call(fs, fd, b, off, len, pos);
  });
  try {
    const err = await pget({ curl: CURL, url: URL_, file: f, total: DATA.length });
    assert.match(err, /ENOSPC|写盘/);
  } finally { m.mock.restore(); }
});

test("writeAll 写满为止：底层短写不会把半截当成写完", () => {
  const f = path.join(DIR, "short-write.bin");
  const fd = fs.openSync(f, "w+");
  const orig = fs.writeSync;
  try {
    fs.writeSync = (d, b, off, len, pos) => orig(d, b, off, Math.min(3, len), pos);
    writeAll(fd, Buffer.from("0123456789"), 0);
  } finally { fs.writeSync = orig; fs.closeSync(fd); }
  assert.equal(fs.readFileSync(f, "utf8"), "0123456789");
  fs.rmSync(f, { force: true });
});
