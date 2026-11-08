// 上传图片按内容认格式（gw/imgfix.mjs，群友 11-08：抖音存的图名叫 .png，内容是 HEIF）
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Readable } from "node:stream";
import { routeFiles } from "../gw/files.mjs";
import { sniffImage } from "../gw/imgfix.mjs";

function call(buf, name) {
  const res = { code: 0, body: null, writeHead(c) { res.code = c; }, setHeader() {}, end(b) { res.body = b ? JSON.parse(String(b)) : null; } };
  const req = Readable.from([buf]); req.method = "POST"; req.headers = {};
  const u = new URL("http://x/api/upload?name=" + encodeURIComponent(name));
  return routeFiles(req, res, u, u.pathname).then(() => res);
}
const dir = fs.mkdtempSync(path.join(process.env.CCAPP_TMP, "imgfix-"));
const make = (fmt) => { const f = path.join(dir, "x." + fmt); try { execFileSync("magick", ["-size", "8x8", "xc:red", f], { stdio: "ignore" }); return fs.readFileSync(f); } catch { return null; } };

test("内容是 WebP / JPEG、名字叫 .png → 扩展名改成真实的；对得上的不动；不是图片的不管", async (t) => {
  const webp = make("webp"), png = make("png");
  if (!webp || !png) return t.skip("本机没有 magick 造样图");
  const a = await call(webp, "comment_1.png");
  assert.equal(a.code, 200); assert.match(a.body.name, /comment_1\.webp$/);
  const b = await call(png, "ok.png");
  assert.match(b.body.name, /ok\.png$/);
  const c = await call(Buffer.from("hello"), "notes.png");
  assert.match(c.body.name, /notes\.png$/, "认不出的不改");
  const d = await call(webp, "a.txt");
  assert.match(d.body.name, /a\.txt$/, "不是图片扩展名的不管");
  for (const r of [a, b, c, d]) fs.rmSync(r.body.path, { force: true });
});

test("内容是 HEIF / AVIF、名字叫 .png → 转成 JPEG（转不了就按真实格式命名，不再冒充 PNG）", async (t) => {
  for (const fmt of ["heic", "avif"]) {
    const src = make(fmt);
    if (!src || sniffImage(src)?.kind === "web") { t.diagnostic(`本机造不出 ${fmt}`); continue; }
    const r = await call(src, "douyin.png");
    assert.equal(r.code, 200);
    t.diagnostic(`${fmt} → ${r.body.name}`);
    if (/\.jpg$/.test(r.body.name)) assert.equal(sniffImage(fs.readFileSync(r.body.path))?.ext, ".jpg");
    else assert.match(r.body.name, new RegExp(`\\.${fmt}$`));
    assert.ok(!fs.readdirSync(path.dirname(r.body.path)).some((n) => n.startsWith(".imgfix-")), "一次性目录要收掉");
    fs.rmSync(r.body.path, { force: true });
  }
});
