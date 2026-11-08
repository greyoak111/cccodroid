// 196-供应链.5：技能包导入先按目录尾记录核对条目数，几千个条目的包不等解压就拒；
// 解出来的文件逐条 await 写，长包不再整段占住事件循环；路由等导入完成再回包。
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SKILLS_DIR, _extForTest } from "../gw/extensions.mjs";

const { importSkill, zipEntryCount } = _extForTest;
const DIRS = ["z0610ok", "z0610one", "z0610loop", "z0610many"];
after(() => { for (const d of DIRS) fs.rmSync(path.join(SKILLS_DIR, d), { recursive: true, force: true }); });

// 造一个最小的 stored zip：只填 zipRead 读的那些字段
function makeZip(entries) {
  const locals = [], central = [];
  let off = 0;
  for (const { name, data } of entries) {
    const nm = Buffer.from(name, "utf8"), body = Buffer.from(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(body.length, 22); lh.writeUInt16LE(nm.length, 26);
    const l = Buffer.concat([lh, nm, body]);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(body.length, 24);
    ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(off, 42);
    central.push(Buffer.concat([ch, nm]));
    locals.push(l);
    off += l.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

test("条目数超过 4096：解压前就拒绝，不留半截技能目录", async () => {
  const entries = [{ name: "z0610many/SKILL.md", data: "---\nname: z0610many\n---\n" }];
  for (let i = 0; i < 4096; i++) entries.push({ name: `z0610many/f${i}.txt`, data: "" });
  const buf = makeZip(entries);
  assert.equal(zipEntryCount(buf), 4097);
  await assert.rejects(importSkill(buf), /文件太多/);
  assert.ok(!fs.existsSync(path.join(SKILLS_DIR, "z0610many")), "拒绝后不留目录");
});

test("正常技能包：SKILL.md 与附属文件都落位", async () => {
  const buf = makeZip([
    { name: "z0610ok/SKILL.md", data: "---\nname: z0610ok\ndescription: t\n---\n# hi\n" },
    { name: "z0610ok/scripts/run.sh", data: "echo hi\n" },
    { name: "__MACOSX/._junk", data: "x" },
  ]);
  const r = await importSkill(buf);
  assert.equal(r.ok, true);
  assert.deepEqual(r.dirs, ["z0610ok"]);
  assert.equal(fs.readFileSync(path.join(SKILLS_DIR, "z0610ok/SKILL.md"), "utf8"), "---\nname: z0610ok\ndescription: t\n---\n# hi\n");
  assert.equal(fs.readFileSync(path.join(SKILLS_DIR, "z0610ok/scripts/run.sh"), "utf8"), "echo hi\n");
});

test("单独一个 SKILL.md 也走同一条导入", async () => {
  const r = await importSkill(Buffer.from("---\nname: z0610one\n---\n# x\n"));
  assert.equal(r.ok, true);
  assert.equal(r.dir, "z0610one");
  assert.match(fs.readFileSync(path.join(SKILLS_DIR, "z0610one/SKILL.md"), "utf8"), /# x/);
});

test("导入期间事件循环能转：文件是 await 写的，不是一口气同步写完", async () => {
  const entries = [{ name: "z0610loop/SKILL.md", data: "---\nname: z0610loop\n---\n" }];
  for (let i = 0; i < 30; i++) entries.push({ name: `z0610loop/d${i}/f.txt`, data: "x" });
  let ticks = 0;
  const tick = () => { ticks++; if (ticks < 1000) setImmediate(tick); };
  setImmediate(tick);
  await importSkill(makeZip(entries));
  assert.ok(ticks > 0, "导入过程中至少要经过一次事件循环（旧的全同步写不会让出）");
});

test("路由等导入完成再回包，写文件不再用同步 API", () => {
  const src = fs.readFileSync(new URL("../gw/extensions.mjs", import.meta.url), "utf8");
  assert.match(src, /sendJson\(res, 200, await importSkill\(await readBodyBuf/);
  assert.match(src, /await fs\.promises\.writeFile\(out, f\.data\)/);
  assert.ok(!/fs\.writeFileSync\(out, f\.data\)/.test(src), "不能再同步写技能文件");
});

// F7（11-09）：技能包改在 worker 线程里解，结果、报错和同步的 zipRead 一致；解压期间主线程不被占住
import { zipRead, zipReadAsync } from "../gw/sessionops.mjs";
import zlib from "node:zlib";

test("zipReadAsync：与 zipRead 结果一致（stored + deflate），报错照样翻译", async () => {
  const big = Buffer.alloc(300000, "abc");
  const buf = makeZip([{ name: "a/SKILL.md", data: "---\nname: a\n---\n" }, { name: "a/b.txt", data: "x" }, { name: "a/big.bin", data: big }]);
  const a = zipRead(buf), b = await zipReadAsync(buf);
  assert.deepEqual(b.map((f) => f.name), a.map((f) => f.name));
  for (let i = 0; i < a.length; i++) assert.ok(Buffer.isBuffer(b[i].data) && b[i].data.equals(a[i].data), a[i].name);
  await assert.rejects(zipReadAsync(Buffer.from("not a zip at all, definitely not")), /zip/);
  await assert.rejects(zipReadAsync(buf, 1000), /太大/);
  // deflate 条目：手工造一个 method 8 的包
  const raw = Buffer.from("hello hello hello hello"), comp = zlib.deflateRawSync(raw);
  const d = makeZip([{ name: "x.txt", data: comp }]);
  d.writeUInt16LE(8, 8); const cd = d.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  d.writeUInt16LE(8, cd + 10); d.writeUInt32LE(raw.length, cd + 24);
  assert.equal((await zipReadAsync(d))[0].data.toString(), raw.toString());
});

test("zipReadAsync：解大包期间主线程的定时器照常跑", async () => {
  const blob = zlib.deflateRawSync(Buffer.alloc(150 * 1024 * 1024));
  const d = makeZip([{ name: "z.bin", data: blob }]);
  d.writeUInt16LE(8, 8); const cd = d.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  d.writeUInt16LE(8, cd + 10); d.writeUInt32LE(150 * 1024 * 1024, cd + 24);
  let ticks = 0;
  const iv = setInterval(() => ticks++, 5);
  const p = zipReadAsync(d, 200 * 1024 * 1024);
  const files = await p;
  clearInterval(iv);
  assert.equal(files[0].data.length, 150 * 1024 * 1024);
  assert.ok(ticks >= 3, `主线程定时器只跑了 ${ticks} 次`);
});
