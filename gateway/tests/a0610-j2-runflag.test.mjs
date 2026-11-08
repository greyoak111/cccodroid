// `.run-active` 的写入与清理（0.6.9 审计 13-03）：写失败要重试；另一个还活着的网关写的标记不许删
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs 就在这里拦下
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { CFG } from "../gw/config.mjs";

const FLAG = path.join(CFG.home, ".run-active");
const waitFor = async (fn, ms = 6000) => {
  const t0 = Date.now();
  for (;;) {
    if (fn()) return true;
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
};
const flagPid = () => { try { return fs.readFileSync(FLAG, "utf8").trim(); } catch { return null; } };
const sleeper = () => spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { stdio: "ignore" });
let n = 0;
// 每次拿一个新的模块实例：模块加载时会清一次标记（和网关重启时一样）
const fresh = () => import(`../gw/runs.mjs?t=${Date.now()}-${n++}`);

test("启动时清掉死掉的残留，另一个还活着的网关写的留着", async () => {
  const child = sleeper();
  try {
    await once(child, "spawn");
    fs.writeFileSync(FLAG, String(child.pid));
    await fresh();
    assert.equal(flagPid(), String(child.pid), "主人还活着，不能删");
  } finally {
    child.kill();
    await once(child, "exit");
  }
  fs.writeFileSync(FLAG, String(child.pid));   // 同一个 pid，进程已经不在了
  await fresh();
  assert.equal(fs.existsSync(FLAG), false, "残留要清掉");
});

test("标记写不上会重试，障碍去掉后自己写上", async () => {
  const m = await fresh();
  fs.rmSync(FLAG, { force: true });
  fs.mkdirSync(FLAG);          // 同名目录挡着，writeAtomic 的 rename 必然失败
  m.runFlag(true);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(fs.statSync(FLAG).isDirectory(), true, "这会儿确实还没写上");
  fs.rmdirSync(FLAG);
  assert.equal(await waitFor(() => flagPid() === String(process.pid)), true, "退避重试后要写上");
  m.runFlag(false);
  assert.equal(await waitFor(() => !fs.existsSync(FLAG)), true);
});

test("关掉时只删自己的：另一个活网关的标记不碰", async () => {
  const m = await fresh();
  const child = sleeper();
  try {
    await once(child, "spawn");
    m.runFlag(true);
    assert.equal(await waitFor(() => flagPid() === String(process.pid)), true);
    fs.writeFileSync(FLAG, String(child.pid));   // 交接间隙：另一个还活着的网关写的
    m.runFlag(false);
    assert.equal(flagPid(), String(child.pid), "别人的标记不能删");
  } finally {
    child.kill();
    await once(child, "exit");
    fs.rmSync(FLAG, { force: true });
  }
});
