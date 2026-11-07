// 文件管理器的压缩包（gw/archiver.mjs、gw/zipread.mjs）：浏览、预览、解压、压缩
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { CFG } from "../gw/config.mjs";

// 用仓库里随 APK 走的那份 7-Zip；本机跑不了（不是 arm64 安卓）就跳过要 7-Zip 的用例
const SEVEN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "android", "prebuilt", "libcc7zz.so");
if (!process.env.CCAPP_7ZZ) process.env.CCAPP_7ZZ = SEVEN;
const have7z = spawnSync(process.env.CCAPP_7ZZ, ["i"], { stdio: "ignore" }).status === 0;
const { routeArc, archiveList, childrenOf, cleanEntry, uniquePath } = await import("../gw/archiver.mjs");
const { zipList } = await import("../gw/zipread.mjs");

const W = path.join(CFG.workspace, "arc-test");
fs.rmSync(W, { recursive: true, force: true });
fs.mkdirSync(W, { recursive: true });

/** 手搓一个 zip：names 是原始字节（不打 UTF-8 标记），内容 stored 或 deflate */
function makeZip(items) {
  const locals = [], central = [];
  let off = 0;
  for (const it of items) {
    const name = Buffer.isBuffer(it.name) ? it.name : Buffer.from(it.name);
    const data = Buffer.from(it.data ?? "");
    const comp = it.deflate ? zlib.deflateRawSync(data) : data;
    const crc = zlib.crc32(data) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(it.flags || 0, 6); lh.writeUInt16LE(it.deflate ? 8 : 0, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(it.madeBy ?? 20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(it.flags || 0, 8); ch.writeUInt16LE(it.deflate ? 8 : 0, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(it.ext || 0, 38); ch.writeUInt32LE(off, 42);
    central.push(ch, name);
    off += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(central), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(items.length, 8); e.writeUInt16LE(items.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, e]);
}

function fakeRes() {
  const r = { code: 0, body: null, writeHead(c) { r.code = c; }, setHeader() {}, end(b) { r.body = b ? JSON.parse(String(b)) : null; } };
  return r;
}
async function call(p, body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = "POST"; req.headers = {};
  const res = fakeRes();
  await routeArc(req, res, new URL("http://x" + p), p);
  return res;
}
async function waitJob(id) {
  for (let i = 0; i < 400; i++) {
    const req = Readable.from([]); req.method = "GET"; req.headers = {};
    const res = fakeRes(), u = new URL("http://x/api/arc/job?id=" + id);
    await routeArc(req, res, u, "/api/arc/job");
    if (res.body.state !== "running") return res.body;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("job timeout");
}

const GBK_DIR = Buffer.from([0xb1, 0xa8, 0xb8, 0xe6, 0x2f]);                       // 报告/
const GBK_FILE = Buffer.concat([GBK_DIR, Buffer.from([0xcb, 0xb5, 0xc3, 0xf7]), Buffer.from(".txt")]);   // 报告/说明.txt

test("GBK 文件名的 zip：自动认出 GBK，目录按层列出", async () => {
  const f = path.join(W, "gbk.zip");
  fs.writeFileSync(f, makeZip([{ name: GBK_DIR }, { name: GBK_FILE, data: "你好", deflate: true }]));
  const z = zipList(f);
  assert.equal(z.encoding, "gbk");
  assert.deepEqual(z.entries.map((e) => e.path), ["报告", "报告/说明.txt"]);
  const r = await call("/api/arc/list", { path: f, dir: "" });
  assert.equal(r.code, 200);
  assert.equal(r.body.legacy, true);
  assert.deepEqual(r.body.entries.map((e) => [e.name, e.dir]), [["报告", true]]);
  const r2 = await call("/api/arc/list", { path: f, dir: "报告" });
  assert.deepEqual(r2.body.entries.map((e) => e.name), ["说明.txt"]);
  // 手动切成别的编码也行
  const r3 = await call("/api/arc/list", { path: f, dir: "", enc: "big5" });
  assert.equal(r3.body.encoding, "big5");
});

test("预览单个文件：解到工作区缓存，内容对", async () => {
  const f = path.join(W, "gbk.zip");
  const r = await call("/api/arc/preview", { path: f, entry: "报告/说明.txt" });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.ok(r.body.path.startsWith(CFG.workspace));
  assert.equal(fs.readFileSync(r.body.path, "utf8"), "你好");
  assert.equal(r.body.kind, "text");
  const miss = await call("/api/arc/preview", { path: f, entry: "../x" });
  assert.equal(miss.code, 404);
});

test("条目路径带 .. 或开头的 /：不解到目标外面", async () => {
  const f = path.join(W, "evil.zip");
  fs.writeFileSync(f, makeZip([{ name: "../escape.txt", data: "x" }, { name: "/abs.txt", data: "y" }, { name: "ok/a.txt", data: "z" }]));
  const dest = path.join(W, "out-evil");
  const r = await call("/api/arc/extract", { path: f, dest });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  const j = await waitJob(r.body.id);
  assert.equal(j.state, "done", JSON.stringify(j));
  assert.ok(!fs.existsSync(path.join(W, "escape.txt")));
  assert.equal(fs.readFileSync(path.join(dest, "abs.txt"), "utf8"), "y");      // 开头的 / 去掉，落在目标里
  assert.equal(fs.readFileSync(path.join(dest, "ok", "a.txt"), "utf8"), "z");
  assert.equal(cleanEntry("a/../b"), null);
  assert.equal(cleanEntry("./a//b/"), "a/b");
});

test("zip 里的软链条目不解；解到已有文件夹时同名的改名，不覆盖", async () => {
  const f = path.join(W, "link.zip");
  fs.writeFileSync(f, makeZip([{ name: "lnk", data: "/etc/passwd", madeBy: 0x0314, ext: (0o120777 << 16) >>> 0 }, { name: "a.txt", data: "new" }]));
  const dest = path.join(W, "out-link");
  fs.mkdirSync(dest); fs.writeFileSync(path.join(dest, "a.txt"), "old");
  const j = await waitJob((await call("/api/arc/extract", { path: f, dest })).body.id);
  assert.equal(j.state, "done", JSON.stringify(j));
  assert.ok(!fs.existsSync(path.join(dest, "lnk")));
  assert.equal(fs.readFileSync(path.join(dest, "a.txt"), "utf8"), "old");
  assert.equal(fs.readFileSync(path.join(dest, "a (2).txt"), "utf8"), "new");
  assert.equal(path.basename(uniquePath(path.join(dest, "a.txt"))), "a (3).txt");
});

test("CRC 对不上：解压报错，目标里不留半截", async () => {
  const f = path.join(W, "bad.zip");
  const buf = makeZip([{ name: "b.txt", data: "hello world" }]);
  buf[30 + 5] ^= 0xff;                    // 改一个数据字节
  fs.writeFileSync(f, buf);
  const dest = path.join(W, "out-bad");
  const j = await waitJob((await call("/api/arc/extract", { path: f, dest })).body.id);
  assert.equal(j.state, "error");
  assert.match(j.error, /CRC/);
  assert.ok(!fs.existsSync(dest));
  assert.deepEqual(fs.readdirSync(W).filter((n) => n.startsWith(".cc-unpack-")), []);
});

test("目标在 home 里（工作区外）：拒绝", async () => {
  const r = await call("/api/arc/extract", { path: path.join(W, "gbk.zip"), dest: path.join(CFG.home, "x") });
  assert.equal(r.code, 403);
  const r2 = await call("/api/arc/extract", { path: path.join(W, "gbk.zip"), dest: "/" });
  assert.equal(r2.code, 403);
});

test("childrenOf：没有目录条目的包也补出目录", () => {
  const kids = childrenOf({ entries: [{ path: "a/b/c.txt", size: 1 }, { path: "a/d.txt", size: 2 }, { path: "e.txt", size: 3 }] }, "a");
  assert.deepEqual(kids.map((k) => [k.name, k.dir]), [["b", true], ["d.txt", false]]);
});

test("7-Zip：压成 7z（带口令、加密文件名）→ 不给口令要口令 → 错口令 → 对口令能列能解", { skip: !have7z && "7-Zip 跑不了" }, async () => {
  const src = path.join(W, "src");
  fs.mkdirSync(path.join(src, "sub"), { recursive: true });
  fs.writeFileSync(path.join(src, "sub", "中文.txt"), "内容");
  fs.mkdirSync(path.join(src, ".ssh")); fs.writeFileSync(path.join(src, ".ssh", "id"), "k");
  const dest = path.join(W, "p.7z");
  const c = await call("/api/arc/create", { items: [src], dest, format: "7z", password: "pw1", encryptNames: true });
  assert.equal(c.code, 200, JSON.stringify(c.body));
  const cj = await waitJob(c.body.id);
  assert.equal(cj.state, "done", JSON.stringify(cj));
  const n = await call("/api/arc/list", { path: dest });
  assert.equal(n.body.needPassword, true);
  const w = await call("/api/arc/list", { path: dest, password: "nope" });
  assert.equal(w.body.wrongPassword, true);
  const ok = await call("/api/arc/list", { path: dest, password: "pw1", dir: "src/sub" });
  assert.deepEqual(ok.body.entries.map((e) => e.name), ["中文.txt"]);
  const top = await call("/api/arc/list", { path: dest, password: "pw1", dir: "src" });
  assert.ok(!top.body.entries.some((e) => e.name === ".ssh"), "凭据目录不该打进去");
  const pv = await call("/api/arc/preview", { path: dest, password: "pw1", entry: "src/sub/中文.txt" });
  assert.equal(pv.code, 200, JSON.stringify(pv.body));
  assert.equal(fs.readFileSync(pv.body.path, "utf8"), "内容");
  const out = path.join(W, "out-7z");
  const x = await waitJob((await call("/api/arc/extract", { path: dest, dest: out, password: "pw1", entries: ["src/sub"] })).body.id);
  assert.equal(x.state, "done", JSON.stringify(x));
  assert.equal(fs.readFileSync(path.join(out, "src", "sub", "中文.txt"), "utf8"), "内容");
  const bad = await waitJob((await call("/api/arc/extract", { path: dest, dest: path.join(W, "out-7z-bad"), password: "nope" })).body.id);
  assert.equal(bad.state, "error");
});

test("7-Zip：zip 加密（AES）走 7-Zip 解；已存在的目标不覆盖；目标在来源里拒绝", { skip: !have7z && "7-Zip 跑不了" }, async () => {
  const src = path.join(W, "src");
  const dest = path.join(W, "p.zip");
  const cj = await waitJob((await call("/api/arc/create", { items: [src], dest, format: "zip", password: "zz" })).body.id);
  assert.equal(cj.state, "done", JSON.stringify(cj));
  const l = await call("/api/arc/list", { path: dest, dir: "src/sub" });
  assert.equal(l.body.kind, "zip");
  assert.equal(l.body.encrypted, true);
  assert.deepEqual(l.body.entries.map((e) => e.name), ["中文.txt"]);   // UTF-8 标记，名字对
  const pv = await call("/api/arc/preview", { path: dest, password: "zz", entry: "src/sub/中文.txt" });
  assert.equal(pv.code, 200, JSON.stringify(pv.body));
  assert.equal(fs.readFileSync(pv.body.path, "utf8"), "内容");
  assert.equal((await call("/api/arc/create", { items: [src], dest, format: "zip" })).code, 409);
  assert.equal((await call("/api/arc/create", { items: [src], dest: path.join(src, "self.zip"), format: "zip" })).code, 400);
});

test("7-Zip：tar.gz / tar.xz 两段读，能列能预览能解", { skip: !have7z && "7-Zip 跑不了" }, async () => {
  const src = path.join(W, "src");
  for (const fmt of ["tar.gz", "tar.xz", "tar"]) {
    const dest = path.join(W, "p." + fmt);
    const cj = await waitJob((await call("/api/arc/create", { items: [src], dest, format: fmt })).body.id);
    assert.equal(cj.state, "done", fmt + " " + JSON.stringify(cj));
    const l = await call("/api/arc/list", { path: dest, dir: "src/sub" });
    assert.equal(l.code, 200, JSON.stringify(l.body));
    assert.deepEqual(l.body.entries.map((e) => e.name), ["中文.txt"], fmt);
    const pv = await call("/api/arc/preview", { path: dest, entry: "src/sub/中文.txt" });
    assert.equal(fs.readFileSync(pv.body.path, "utf8"), "内容", fmt);
    const out = path.join(W, "out-" + fmt);
    const x = await waitJob((await call("/api/arc/extract", { path: dest, dest: out })).body.id);
    assert.equal(x.state, "done", fmt + " " + JSON.stringify(x));
    assert.equal(fs.readFileSync(path.join(out, "src", "sub", "中文.txt"), "utf8"), "内容", fmt);
  }
});

test("压缩来源在 home 里（工作区外）：拒绝", async () => {
  const f = path.join(CFG.home, "h.txt"); fs.writeFileSync(f, "x");
  const r = await call("/api/arc/create", { items: [f], dest: path.join(W, "h.zip"), format: "zip" });
  assert.equal(r.code, 403);
  const r2 = await call("/api/arc/create", { items: [CFG.home], dest: path.join(W, "h2.zip"), format: "zip" });
  assert.equal(r2.code, 403);
});
