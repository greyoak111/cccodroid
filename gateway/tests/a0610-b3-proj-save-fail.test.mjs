// 0.6.10 车道 b3：项目修改写盘失败要如实报错（195-N.1）
// 不能回 200 / 带 ok，前端按 { ok:false, error:"save_failed", message } 提示。
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";

const FILE = path.join(process.env.CCAPP_HOME, "ccapp-projects.json");

// 起一个只挂某个路由的小服务，测完关掉
async function serve(route) {
  const srv = http.createServer(async (req, res) => { const u = new URL(req.url, "http://x"); await route(req, res, u, u.pathname); });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  after(() => srv.close());
  return (p, init) => fetch(`http://127.0.0.1:${srv.address().port}${p}`, init);
}

test("项目修改写盘失败：500 + { ok:false, error:'save_failed', message }", async () => {
  const { routeProjects } = await import("../gw/projects.mjs");
  const go = await serve(routeProjects);
  const dir = fs.mkdtempSync(path.join(process.env.CCAPP_WORKSPACE, "b3-proj-"));
  const made = await go("/api/projects", { method: "POST", body: JSON.stringify({ name: "写盘测", mode: "dir", path: dir }) });
  assert.equal(made.status, 200, await made.clone().text());
  const id = (await made.json()).project.id;

  // 用非空目录挡住项目清单文件：writeAtomic 的换名必失败，不需要 root / 权限
  const before = fs.existsSync(FILE) ? fs.readFileSync(FILE) : null;
  try {
    if (fs.existsSync(FILE)) fs.rmSync(FILE);
    fs.mkdirSync(FILE);
    fs.writeFileSync(path.join(FILE, "block"), "x");
    const r = await go(`/api/projects/${id}`, { method: "PATCH", body: JSON.stringify({ name: "改了" }) });
    assert.equal(r.status, 500);
    const j = await r.json();
    assert.equal(j.ok, false, "不能回 ok");
    assert.equal(j.error, "save_failed");
    assert.equal(typeof j.message, "string");
    assert.ok(j.message.length > 0);
  } finally {
    fs.rmSync(FILE, { recursive: true, force: true });
    if (before != null) fs.writeFileSync(FILE, before);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
