// 0.6.10 审计 f2 车道：终端（H.1/H.4/H.5/H.6/H.7/H.8、200-4.04）
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { NEXT } from "../gw/http.mjs";
import { routeTerminal, TERMS, _termForTest } from "../gw/terminal.mjs";

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
const base = await serve(routeTerminal);
const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web", "app");

function fake(id, extra = {}) {
  const t = { id, title: id, cols: 80, rows: 24, created: 1, alive: true, code: null, buf: "你好abc", total: 5, subs: new Set(), ...extra };
  TERMS.set(id, t);
  return t;
}

test("H.1 回放带累计字符数，界面可按增量续接", async () => {
  fake("treplay");
  const r = await fetch(base + "/api/term/treplay/stream");
  const rd = r.body.getReader();
  const { value } = await rd.read();
  const s = new TextDecoder().decode(value);
  assert.match(s, /event: replay/);
  assert.match(s, /"total":5/);
  assert.match(s, /"data":"你好abc"/);
  await rd.cancel().catch(() => {});
});

test("H.5 进程退出后输入返回 409，不再假报已送达", async () => {
  fake("tdead", { alive: false, code: 0 });
  const r = await fetch(base + "/api/term/tdead/in", { method: "POST", body: "ls\r" });
  assert.equal(r.status, 409);
  const j = await r.json();
  assert.equal(j.error, "exited");
  assert.match(j.message, /已经退出/);
});

test("H.4 网关不认识这个终端时，输出流以 exit 收尾（前端会标成已退出）", async () => {
  fake("tgone", { alive: false, code: 7, buf: "", total: 0 });
  const r = await fetch(base + "/api/term/tgone/stream");
  const s = await r.text();
  assert.match(s, /event: exit/);
  assert.match(s, /"code":7/);
});

test("200-4.04 关闭终端时能按环境标记找到 setsid 跑掉的子孙", async () => {
  const id = "zz-f2-" + Date.now().toString(36);
  // setsid 的替代：spawn 时 detached 即新进程组 / 会话
  const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore", env: { ...process.env, CCAPP_TERM_ID: id } });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(_termForTest.killTermProcs(id) >= 1, true);
  await new Promise((r) => setTimeout(r, 150));
  let alive = true;
  try { process.kill(child.pid, 0); } catch { alive = false; }
  assert.equal(alive, false);
  try { child.kill("SIGKILL"); } catch {}
});

test("H.2/H.3/H.6/H.7/H.8 前端行为（源码断言）", () => {
  const src = fs.readFileSync(path.join(APP, "18-terminal.js"), "utf8");
  assert.match(src, /5\$\{m\[2\]\}/, "Ctrl+方向键没有补成 xterm 的修饰序列");
  assert.match(src, /Ctrl\+退格/);
  assert.match(src, /\\x1b\\\[20\[01\]~/, "粘贴没有去掉括号粘贴结束标记");
  assert.match(src, /TERM\.tvCut/);
  assert.match(src, /total - a\.seen <= data\.length/, "回放没有按累计数续接");
  assert.match(src, /opts\.cwd \? \{ cwd: opts\.cwd \}/);
  assert.match(src, /const gen = opts\.gen != null \? opts\.gen : TERM\.gen/);
  assert.match(src, /cell\.getChars\(\)/, "网址定位没有按格子算列");
  const proj = fs.readFileSync(path.join(APP, "14-projects-sched.js"), "utf8");
  assert.match(proj, /openTerm\(had \? \{\} : \{ cwd: dir \}\)/);
});
