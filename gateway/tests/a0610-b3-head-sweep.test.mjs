// 0.6.10 车道 b3：静态资源支持 HEAD（195-C.19 后半 / 196）；回收站每天清一次且不拦着退出（195-A.9）
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";

const SERVER = new URL("../server.mjs", import.meta.url).pathname;
const PROBE = new URL("./fixtures/b3-interval-probe.mjs", import.meta.url).pathname;
const home = fs.mkdtempSync(path.join(process.env.CCAPP_TMP, "b3-head-"));
const probe = path.join(home, "probe.log");
let child = null;
after(() => { try { child?.kill("SIGKILL"); } catch {} fs.rmSync(home, { recursive: true, force: true }); });

const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.on("error", rej);
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
});

test("HEAD 静态资源：与 GET 同头、不带正文；回收站清理登记为每天一次且已 unref", async () => {
  const port = await freePort();
  const env = { ...process.env, CCAPP_HOME: home, HOME: home, CCAPP_LOG: path.join(home, "gateway.log"), CCAPP_B3_PROBE: probe };
  delete env.NODE_TEST_CONTEXT; delete env.CCAPP_TEST;
  child = spawn(process.execPath, ["--import", PROBE, SERVER, String(port)], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { out += d; });
  for (let i = 0; i < 300 && !/网关 v3 已启动/.test(out) && child.exitCode == null; i++) await new Promise((r) => setTimeout(r, 100));
  assert.match(out, /网关 v3 已启动/, "网关没起来：\n" + out);

  const base = `http://127.0.0.1:${port}`;
  const g = await fetch(base + "/index.html");
  assert.equal(g.status, 200);
  const gText = await g.text();
  const h = await fetch(base + "/index.html", { method: "HEAD" });
  assert.equal(h.status, 200, "HEAD 不能回 404");
  assert.equal(h.headers.get("content-length"), String(Buffer.byteLength(gText)), "头和 GET 一样");
  assert.equal(h.headers.get("content-type"), g.headers.get("content-type"), "头和 GET 一样");
  assert.equal(await h.text(), "", "HEAD 不带正文");

  // 让它走正常退出（SIGTERM），预载的 exit 钩子把定时器 ref 状态写下来
  await new Promise((res) => { const t = setTimeout(res, 15000); child.on("exit", () => { clearTimeout(t); res(); }); child.kill("SIGTERM"); });
  const lines = fs.readFileSync(probe, "utf8");
  assert.match(lines, /interval 86400000 ref=false/, "回收站清理应为每天一次且 unref：\n" + lines);
});
