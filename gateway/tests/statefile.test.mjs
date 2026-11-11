// 状态文件的统一读写（gw/statefile.mjs）与最后一道兜底（gw/crashguard.mjs）：0.6.9 审计 R2/R5 家族
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CFG } from "../gw/config.mjs";
import { asArr, asObj, loadState, saveState, writeAtomic } from "../gw/statefile.mjs";

const D = path.join(CFG.home, "statefile-test");
fs.rmSync(D, { recursive: true, force: true });
fs.mkdirSync(D, { recursive: true });
const bads = (f) => fs.readdirSync(path.dirname(f)).filter((n) => n.startsWith(path.basename(f) + ".bad-"));

test("不存在：missing，用默认值，不留底", () => {
  const r = loadState(path.join(D, "none.json"), { fallback: () => ({ a: 1 }) });
  assert.deepEqual(r, { data: { a: 1 }, missing: true, bad: false, kept: true });
});

test("语法坏：原文件留底成 .bad-*，用默认值", () => {
  const f = path.join(D, "broken.json");
  fs.writeFileSync(f, "{oops");
  const r = loadState(f, { fallback: () => [] });
  assert.equal(r.bad, true);
  assert.deepEqual(r.data, []);
  assert.ok(!fs.existsSync(f));
  const b = bads(f);
  assert.equal(b.length, 1);
  assert.equal(fs.readFileSync(path.join(D, b[0]), "utf8"), "{oops");
});

test("形状不对（该是对象的是数组 / 原语 / null）：同样留底", () => {
  for (const [i, v] of ["[]", "3", "null", '"s"'].entries()) {
    const f = path.join(D, `shape${i}.json`);
    fs.writeFileSync(f, v);
    const r = loadState(f, { shape: asObj, fallback: () => ({}) });
    assert.equal(r.bad, true, v);
    assert.deepEqual(r.data, {});
  }
  const f = path.join(D, "arr.json");
  fs.writeFileSync(f, "{}");
  assert.equal(loadState(f, { shape: asArr, fallback: () => [] }).bad, true);
});

test("留底只保留最近 3 份", () => {
  const f = path.join(D, "many.json");
  for (let i = 0; i < 5; i++) { fs.writeFileSync(f, "x" + i); loadState(f); }
  assert.ok(bads(f).length <= 3);
});

test("软链 / 目录不当状态文件读", () => {
  const f = path.join(D, "link.json");
  fs.writeFileSync(path.join(D, "target.json"), "{}");
  fs.symlinkSync(path.join(D, "target.json"), f);
  assert.equal(loadState(f).bad, true);
  assert.ok(fs.existsSync(path.join(D, "target.json")), "软链指向的文件不动");
});

test("saveState：原子写；目录写不进时返回 false 而不是抛", () => {
  const f = path.join(D, "ok.json");
  assert.equal(saveState(f, { x: 1 }), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")), { x: 1 });
  assert.equal(fs.readdirSync(D).filter((n) => n.includes(".tmp-")).length, 0);
  const ro = path.join(D, "ro");
  fs.mkdirSync(ro); fs.chmodSync(ro, 0o500);
  assert.equal(writeAtomic(path.join(ro, "x.json"), "{}"), false);
  fs.chmodSync(ro, 0o700);
});

// 兜底：在子进程里试（要真装 uncaughtException）
const GUARD = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "gw", "crashguard.mjs");
function child(code) {
  return new Promise((res) => {
    const c = spawn(process.execPath, ["--input-type=module", "-e", code], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.on("close", (rc) => res({ rc, out }));
  });
}

test("定时器里抛异常：网关不退出，接着跑", async () => {
  const r = await child(`import { installCrashGuard } from ${JSON.stringify(GUARD)};
    installCrashGuard();
    setTimeout(() => { throw new TypeError("boom"); }, 10);
    setTimeout(() => { console.log("alive"); process.exit(0); }, 100);`);
  assert.equal(r.rc, 0);
  assert.match(r.out, /alive/);
});

test("一分钟内接住太多次：退出（等 App 重拉）", async () => {
  const r = await child(`import { installCrashGuard } from ${JSON.stringify(GUARD)};
    installCrashGuard();
    for (let i = 0; i < 30; i++) setTimeout(() => { throw new Error("x" + i); }, 5);
    setTimeout(() => process.exit(0), 300);`);
  assert.equal(r.rc, 1);
});

test("stdout 断了（孤儿网关）：照旧退出", async () => {
  const rc = await new Promise((res) => {
    const c = spawn(process.execPath, ["--input-type=module", "-e", `import { installCrashGuard } from ${JSON.stringify(GUARD)};
      installCrashGuard();
      setInterval(() => console.log("x".repeat(1000)), 5);
      setTimeout(() => process.exit(7), 5000);`], { env: process.env, stdio: ["ignore", "pipe", "ignore"] });
    c.stdout.once("data", () => c.stdout.destroy());
    c.on("close", res);
  });
  assert.equal(rc, 0);
});
