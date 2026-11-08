// 0.6.10 审计 f2 车道：文件 / 查看器 / Office 后端（C.2/C.5/C.7/C.11/C.14/C.18、200-8-05、200-H-2/H-4、199-8-01、200-8-09）
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CFG } from "../gw/config.mjs";
import { NEXT } from "../gw/http.mjs";
import { routeFiles, UPLOAD_DIR } from "../gw/files.mjs";
import { routeOffice, _officeForTest } from "../gw/office.mjs";

async function serve(...routes) {
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    for (const r of routes) if ((await r(req, res, u, u.pathname)) !== NEXT) return;
    res.writeHead(404).end();
  });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  after(() => srv.close());
  return `http://127.0.0.1:${srv.address().port}`;
}
const base = await serve(routeFiles, routeOffice);
const W = CFG.workspace;
fs.mkdirSync(W, { recursive: true });

const raw = (p, opts) => fetch(base + p, opts);
const q = (s) => encodeURIComponent(s);

test("C.2 /api/file 支持 Range，越界回 416", async () => {
  const f = path.join(W, "range.txt");
  fs.writeFileSync(f, "0123456789");
  let r = await raw(`/api/file?path=${q(f)}`, { headers: { range: "bytes=2-5" } });
  assert.equal(r.status, 206);
  assert.equal(await r.text(), "2345");
  assert.equal(r.headers.get("content-range"), "bytes 2-5/10");
  assert.equal(r.headers.get("accept-ranges"), "bytes");
  assert.equal(r.headers.get("content-length"), "4");

  r = await raw(`/api/file?path=${q(f)}`, { headers: { range: "bytes=-3" } });
  assert.equal(r.status, 206);
  assert.equal(await r.text(), "789");

  r = await raw(`/api/file?path=${q(f)}`, { headers: { range: "bytes=20-" } });
  assert.equal(r.status, 416);
  assert.equal(r.headers.get("content-range"), "bytes */10");

  r = await raw(`/api/file?path=${q(f)}`);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "0123456789");
});

test("C.2 /api/office/pdf 也认 Range", async () => {
  const src = path.join(W, "deck.pptx");
  fs.writeFileSync(src, "pptx");
  const st = fs.statSync(src), key = _officeForTest.officeKey(src, st);
  fs.mkdirSync(_officeForTest.OFFICE_DIR, { recursive: true });
  fs.writeFileSync(path.join(_officeForTest.OFFICE_DIR, key + ".pdf"), "PDFPDFPDF");
  _officeForTest.officeDone.set(key, src);
  const r = await raw(`/api/office/pdf?path=${q(src)}&k=${key}`, { headers: { range: "bytes=3-5" } });
  assert.equal(r.status, 206);
  assert.equal(await r.text(), "PDF");
  assert.equal(r.headers.get("content-range"), "bytes 3-5/9");
});

test("C.5 目录超过 1000 项时带 truncated；搜索走网关过滤后不再被前 1000 项挡住", async () => {
  const d = path.join(W, "big-dir");
  fs.mkdirSync(d, { recursive: true });
  for (let i = 0; i < 1001; i++) fs.writeFileSync(path.join(d, `f${i}.txt`), "");
  fs.writeFileSync(path.join(d, "zzz-only.txt"), "");
  let j = await (await raw(`/api/files?path=${q(d)}`)).json();
  assert.equal(j.entries.length, 1000);
  assert.equal(j.truncated, true);
  j = await (await raw(`/api/files?path=${q(d)}&q=zzz`)).json();
  assert.equal(j.entries.length, 1);
  assert.equal(j.entries[0].name, "zzz-only.txt");
  assert.equal(j.truncated, false);
});

test("196 大小写变体的密钥文件名也不列出来", async () => {
  const d = path.join(W, "secret-case");
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "CCAPP-PROVIDERS.JSON"), "{}");
  fs.writeFileSync(path.join(d, "normal.txt"), "");
  const j = await (await raw(`/api/files?path=${q(d)}`)).json();
  assert.deepEqual(j.entries.map((x) => x.name), ["normal.txt"]);
});

test("C.14 文件名超过 255 字节给中文提示（新建 / 重命名）", async () => {
  const dir = path.join(W, "names");
  fs.mkdirSync(dir, { recursive: true });
  const long = "长".repeat(100);   // 300 字节
  let r = await raw(`/api/file/new?path=${q(path.join(dir, long))}`, { method: "POST" });
  assert.equal(r.status, 400);
  let j = await r.json();
  assert.equal(j.error, "name too long");
  assert.match(j.message, /255/);

  const f = path.join(dir, "a.txt");
  fs.writeFileSync(f, "a");
  r = await raw(`/api/file/rename?from=${q(f)}&name=${q(long)}`, { method: "POST" });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, "name too long");
});

test("200-8-05 目标就是源文件本身（同一 inode）时不当成同名冲突", async () => {
  // 本机测试盘不支持硬链接，没法造出“两个名字同一个 inode”；用同路径改名把同一 inode 这条分支走到。
  // /sdcard 上的“只改大小写”也是走到这条分支（lstat 目标看到的是源文件）
  const dir = path.join(W, "case-rename");
  fs.mkdirSync(dir, { recursive: true });
  const a = path.join(dir, "case.txt");
  fs.writeFileSync(a, "keep");
  let r = await raw(`/api/file/rename?from=${q(a)}&name=case.txt`, { method: "POST" });
  assert.equal(r.status, 200, await r.text());
  assert.equal(fs.readFileSync(a, "utf8"), "keep");

  const x = path.join(dir, "x.txt"), y = path.join(dir, "y.txt");
  fs.writeFileSync(x, "x"); fs.writeFileSync(y, "y");
  r = await raw(`/api/file/rename?from=${q(x)}&name=y.txt`, { method: "POST" });
  assert.equal(r.status, 409);   // 真·同名（不同 inode）照旧拒
});

test("C.11 .3gp / .opus 有正确的 Content-Type", async () => {
  const v = path.join(W, "clip.3gp"), a = path.join(W, "voice.opus");
  fs.writeFileSync(v, "v"); fs.writeFileSync(a, "a");
  let r = await raw(`/api/file?path=${q(v)}`);
  assert.equal(r.headers.get("content-type"), "video/3gpp");
  r = await raw(`/api/file?path=${q(a)}`);
  assert.match(r.headers.get("content-type"), /^audio\/ogg/);
});

test("200-H-2 procfs 伪文件不再按 size 发 Content-Length", async () => {
  const r = await raw(`/api/file?path=${q("/proc/cpuinfo")}`);
  assert.notEqual(r.status, 200);
});

test("C.18 0 字节文件可以上传；200-H-4 成功后不留 .part", async () => {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const r = await raw(`/api/upload?name=${q("empty.txt")}`, { method: "POST", body: "" });
  assert.equal(r.status, 200, await r.clone().text());
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.size, 0);
  assert.equal(fs.existsSync(j.path), true);
  assert.equal(fs.statSync(j.path).size, 0);
  assert.deepEqual(fs.readdirSync(UPLOAD_DIR).filter((f) => f.startsWith(".part-")), []);
});

test("199-8-01 / 200-8-09 Office 早期失败不会带走网关，并清掉 work 目录", async () => {
  fs.mkdirSync(_officeForTest.OFFICE_DIR, { recursive: true });
  const key = "abcdef0123456789abcd";
  await assert.rejects(_officeForTest.officeConvert(path.join(W, "no-such-file.docx"), key, path.join(_officeForTest.OFFICE_DIR, key + ".pdf")));
  assert.equal(fs.existsSync(path.join(_officeForTest.OFFICE_DIR, "work-" + key)), false);
});

test("前端修复的源码断言（C.4/C.6/C.9/C.10/C.13、196 预览回执、A-01/A-02）", async () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web", "app");
  const files = fs.readFileSync(path.join(dir, "06-files.js"), "utf8");
  assert.match(files, /vwDecode\(buf\)/, "文件面板文本预览没有按字节认编码");
  assert.match(files, /function fsSelect[^]*?renderFsPreview\(\);/, "点选仍在整表重画");
  assert.match(files, /只显示了前 1000 项/);
  const office = fs.readFileSync(path.join(dir, "17-office.js"), "utf8");
  assert.match(office, /maxImageSize: 16e6/);
  assert.match(office, /VW_OFFICE_MAX/);
  assert.match(office, /zipExpandsTooMuch/);
  assert.match(office, /这一页没画出来/);
  const viewer = fs.readFileSync(path.join(dir, "16-viewer-git.js"), "utf8");
  assert.match(viewer, /VW\.eol === "\\r\\n"/);
  assert.match(viewer, /allow-forms allow-popups/);
  assert.match(viewer, /文件太大（\{size\}），只能下载查看。[^]*?download/);
});
