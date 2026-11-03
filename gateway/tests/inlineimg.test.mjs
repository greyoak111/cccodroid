// 图片随消息发（第三方兼容兜底）：认路径、认格式、开关、太大的跳过、历史不重复显示
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs 就在这里拦下
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(process.env.CCAPP_WORKSPACE, "img-"));
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);
const put = (n, b) => { const p = path.join(dir, n); fs.writeFileSync(p, b); return p; };
const ON = { id: "custom-1", inlineImages: true };

test("认消息里的 @图片路径：去重、只要存在的、标点收尾也认", async () => {
  const { imageRefs } = await import("../gw/inlineimg.mjs");
  const a = put("a.png", PNG), b = put("b.jpg", JPG);
  assert.deepEqual(imageRefs(`看看 @${a} 和 @${b}，还有 @${a}`), [a, b]);
  assert.deepEqual(imageRefs(`@${dir}/没有.png @${dir}/x.txt`), []);
});

test("按文件头认格式；没勾、端侧模型不带", async () => {
  const { inlineImagesSync, inlineImages } = await import("../gw/inlineimg.mjs");
  const real = put("photo.png", JPG);                 // 扩展名写 png，实际是 jpeg
  const fake = put("fake.jpg", Buffer.from("不是图片，只是名字像".repeat(4)));
  const msg = `这是什么 @${real} @${fake}`;
  const bl = inlineImagesSync(msg, ON);
  assert.equal(bl.length, 1);
  assert.equal(bl[0].type, "image");
  assert.equal(bl[0].source.media_type, "image/jpeg");
  assert.equal(Buffer.from(bl[0].source.data, "base64").length, JPG.length);
  assert.deepEqual(inlineImagesSync(msg, { id: "custom-1" }), []);
  assert.deepEqual(inlineImagesSync(msg, { ...ON, local: true }), []);
  assert.equal((await inlineImages(msg, ON)).length, 1);
});

test("太大的图：插话里不缩、直接不带（留给 Read）；最多 5 张", async () => {
  const { inlineImagesSync } = await import("../gw/inlineimg.mjs");
  const big = put("big.png", Buffer.concat([PNG, Buffer.alloc(4 * 1024 * 1024)]));
  assert.deepEqual(inlineImagesSync(`@${big}`, ON), []);
  const many = Array.from({ length: 7 }, (_, i) => put(`m${i}.png`, PNG));
  assert.equal(inlineImagesSync(many.map((p) => "@" + p).join(" "), ON).length, 5);
});

test("太大的图不先整读进网关内存（审查 v0.5.20 07-012）：插话直接跳过，起轮前只读文件头再交给缩图", async () => {
  const { inlineImagesSync, inlineImages } = await import("../gw/inlineimg.mjs");
  const big = put("big8.png", Buffer.concat([PNG, Buffer.alloc(8 * 1024 * 1024)]));
  const huge = put("huge.png", PNG); fs.truncateSync(huge, 80 * 1024 * 1024);   // 稀疏文件：不真占 80MB
  const orig = fs.readFileSync, seen = [];
  fs.readFileSync = function (p, ...rest) { const r = orig.call(this, p, ...rest); if (p === big || p === huge) seen.push(r.length); return r; };
  try {
    assert.deepEqual(inlineImagesSync(`@${big}`, ON), []);
    await inlineImages(`@${big} @${huge}`, ON, { tmpDir: dir });
    await inlineImages(`@${big}`, ON);
  } finally { fs.readFileSync = orig; }
  assert.deepEqual(seen, [], "超过单图上限的原图一次都不该整读");
});

test("历史：原话里已有 @图片路径就不再补一行 [图片]；没有路径的照旧补", async () => {
  const { transcriptItems } = await import("../gw/transcript.mjs");
  const img = { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } };
  const a = transcriptItems({ type: "user", uuid: "u1", message: { role: "user", content: [{ type: "text", text: `这是什么 @${dir}/a.png` }, img] } });
  assert.equal(a[0].text, `这是什么 @${dir}/a.png`);
  const b = transcriptItems({ type: "user", uuid: "u2", message: { role: "user", content: [{ type: "text", text: "这是什么" }, img] } });
  assert.equal(b[0].text, "这是什么\n[图片]");
});

test("接口设置：inlineImages 存得上、关掉就删、界面视图带出来", async () => {
  const http = await import("node:http");
  const { routeProviders } = await import("../gw/providers.mjs");
  const srv = http.createServer(async (req, res) => { const u = new URL(req.url, "http://x"); await routeProviders(req, res, u, u.pathname); });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  const post = async (p, body) => (await fetch(`http://127.0.0.1:${srv.address().port}${p}`, { method: "POST", body: JSON.stringify(body) })).json();
  try {
    const r = await post("/api/providers/save", { label: "兼容测", baseUrl: "https://api.example.com", defaultModel: "m", inlineImages: true });
    assert.equal(r.provider.inlineImages, true);
    const r2 = await post("/api/providers/save", { id: r.id, inlineImages: false });
    assert.equal(r2.provider.inlineImages, false);
    await post("/api/providers/delete", { id: r.id });
  } finally { srv.close(); }
});

test("run.mjs 接得上 inlineimg（导入不报错）", async () => {
  const m = await import("../gw/run.mjs");
  assert.equal(typeof m.startRun, "function");
});
