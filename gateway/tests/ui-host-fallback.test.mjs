// 11-14 一加 PGP110（Android 17）：127.0.0.2 连不通，App 永远核不了网关身份，界面卡在「等待网关」。
// App 探测到后经 CCAPP_UI_HOST=127.0.0.1 让网关把界面地址换成主地址（gw/access.mjs 的 UI_HOST、server.mjs 不再另听）。
// 这里起子进程导入 access.mjs，看三件事：只认 127.0.0.1 / 127.0.0.2 两个值；回退时 Cookie 只认 127.0.0.1 上来的；
// 不回退时行为和以前一样（127.0.0.1 上来的 Cookie 不认）。
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs 就在这里拦下
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { after } from "node:test";

const ACCESS = pathToFileURL(fileURLToPath(new URL("../gw/access.mjs", import.meta.url))).href;

function probe(uiHost) {
  const script = `
    const a = await import(${JSON.stringify(ACCESS)});
    const port = ${JSON.stringify(process.env.CCAPP_PORT || "8799")};
    const ck = a.COOKIE + "=" + a.SESSION;
    const req = (host, local) => ({ url: "/api/state", method: "GET", headers: { host: host + ":" + port, cookie: ck }, socket: { localAddress: local } });
    const u = new URL("http://127.0.0.1:" + port + "/api/state");
    console.log(JSON.stringify({
      ui: a.UI_HOST,
      on1: a.denyReason(req("127.0.0.1", "::ffff:127.0.0.1"), u),
      on2: a.denyReason(req("127.0.0.2", "127.0.0.2"), u),
      fwd: a.denyReason(req("127.0.0.1", "127.0.0.2"), u),
      local: a.denyReason(req("localhost", "127.0.0.1"), u),
    }));`;
  const env = { ...process.env, CCAPP_PREFIX: process.env.CCAPP_PREFIX || "/data/data/cc.codroid/files/usr" };
  delete env.CCAPP_SPAWN_KEY;
  if (uiHost === undefined) delete env.CCAPP_UI_HOST; else env.CCAPP_UI_HOST = uiHost;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env, encoding: "utf8", timeout: 20000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split("\n").pop());
}

test("默认（没给 CCAPP_UI_HOST）：界面在 127.0.0.2，127.0.0.1 上来的 Cookie 不认", () => {
  const r = probe(undefined);
  assert.equal(r.ui, "127.0.0.2");
  assert.equal(r.on2, null);
  assert.equal(r.on1, 403);
  assert.equal(r.local, 403);
});

test("回退（CCAPP_UI_HOST=127.0.0.1）：界面在 127.0.0.1，Cookie 只认真进了 127.0.0.1 的请求", () => {
  const r = probe("127.0.0.1");
  assert.equal(r.ui, "127.0.0.1");
  assert.equal(r.on1, null, "IPv4 映射的 ::ffff:127.0.0.1 也要认");
  assert.equal(r.on2, 421, "回退后 127.0.0.2 不再是允许的 Host");
  assert.equal(r.fwd, 403, "Host 写 127.0.0.1、连接却进的别的地址：不认");
  assert.equal(r.local, 403, "localhost 不是界面地址（Cookie 按主机名分，界面只在 127.0.0.1 上种）");
});

test("CCAPP_UI_HOST 只认两个值：别的写法一律按 127.0.0.2", () => {
  for (const v of ["", "0.0.0.0", "localhost", "127.0.0.3", "127.1", " 127.0.0.1"]) assert.equal(probe(v).ui, "127.0.0.2", v);
});

// ── 整网关进程：回退时 server.mjs 只留主监听一份（127.0.0.2 上不该有人听），默认时两个地址都听 ──
const SERVER = fileURLToPath(new URL("../server.mjs", import.meta.url));
const boots = [];
after(() => { for (const g of boots) { try { g.child.kill("SIGKILL"); } catch {} try { fs.rmSync(g.home, { recursive: true, force: true }); } catch {} } });

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
const tryConnect = (host, port, ms) => new Promise((resolve) => {
  const s = net.connect({ host, port });
  s.once("connect", () => { s.destroy(); resolve(true); });
  s.once("error", () => { s.destroy(); resolve(false); });
  setTimeout(() => { s.destroy(); resolve(false); }, ms);
});
async function waitListening(host, port, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await tryConnect(host, port, 500)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}
async function bootServer(uiHost) {
  const port = await freePort();
  const home = fs.mkdtempSync(path.join(process.env.CCAPP_TMP, "uihost-"));
  const env = { ...process.env, CCAPP_HOME: home, HOME: home, CCAPP_LOG: path.join(home, "gateway.log") };
  if (uiHost === undefined) delete env.CCAPP_UI_HOST; else env.CCAPP_UI_HOST = uiHost;
  delete env.NODE_TEST_CONTEXT; delete env.CCAPP_TEST;
  const child = spawn(process.execPath, [SERVER, String(port)], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { out += d; });
  const g = { child, port, home, out: () => out };
  boots.push(g);
  return g;
}

test("回退（CCAPP_UI_HOST=127.0.0.1）：网关只起主地址一份监听，127.0.0.2 上没人听", async () => {
  const g = await bootServer("127.0.0.1");
  assert.ok(await waitListening("127.0.0.1", g.port), "回退模式主地址没起来：\n" + g.out());
  assert.equal(await tryConnect("127.0.0.2", g.port, 800), false, "回退模式不该再听 127.0.0.2：\n" + g.out());
  // 钉住 server.mjs 的「不再另听一份」分支：真要再听，会撞主监听的 EADDRINUSE、日志刷「监听失败…每 2 秒重试」（复核报告发现 #1）
  await new Promise((r) => setTimeout(r, 1500));
  assert.doesNotMatch(g.out(), /监听失败/, "回退模式不该出现界面地址监听失败的日志：\n" + g.out());
});

test("默认：主 127.0.0.1 与界面 127.0.0.2 两个地址都听", async () => {
  const g = await bootServer(undefined);
  assert.ok(await waitListening("127.0.0.1", g.port), "默认主地址没起来：\n" + g.out());
  assert.ok(await waitListening("127.0.0.2", g.port), "默认界面地址 127.0.0.2 没起来：\n" + g.out());
});
