// FIND-051：设置请求被校验拒绝 / 保存失败时不能中途落盘。
// 以前 POST /api/settings 先把 model、permissionMode 写进内存，permissionMode 还会经 setPermMode 立刻写盘；
// 之后才发现 provider 未知返回 400 —— 磁盘上已经留下 model + permissionMode（settings 路由顺序问题）。
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { PATHS } from "../gw/config.mjs";
import { NEXT } from "../gw/http.mjs";

// guard:true、permMigrated:1：导入时别触发 loadSettings 的迁移写盘，干扰“写了几次”的计数
const OLD = { model: "old-model", permissionMode: "default", permMigrated: 1, guard: true };
fs.mkdirSync(path.dirname(PATHS.settings), { recursive: true });
fs.writeFileSync(PATHS.settings, JSON.stringify(OLD, null, 2));

const { routeSettings } = await import("../gw/settings.mjs");
const { SETTINGS } = await import("../gw/settings-store.mjs");

after(() => { try { fs.rmSync(PATHS.settings, { force: true }); } catch {} });

async function serve(route) {
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    if ((await route(req, res, u, u.pathname)) !== NEXT) return;
    res.writeHead(404).end();
  });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  return {
    srv,
    call: async (p, body) => {
      const r = await fetch(`http://127.0.0.1:${srv.address().port}${p}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) });
      return { status: r.status, body: await r.json() };
    },
  };
}

test("未知厂商 400：model / permissionMode 都不得中途落盘", async (t) => {
  const before = { model: SETTINGS.model, permissionMode: SETTINGS.permissionMode };
  const { srv, call } = await serve(routeSettings);
  t.after(() => srv.close());
  const r = await call("/api/settings", { model: "stab-a-new-model", permissionMode: "plan", provider: "no-such" });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(SETTINGS.model, before.model, "被拒绝的请求不能改内存里的 model");
  assert.equal(SETTINGS.permissionMode, before.permissionMode, "被拒绝的请求不能改内存里的权限模式");
  const disk = JSON.parse(fs.readFileSync(PATHS.settings, "utf8"));
  assert.equal(disk.model, OLD.model, "磁盘上的 model 必须是旧值");
  assert.equal(disk.permissionMode, OLD.permissionMode, "磁盘上的 permissionMode 必须是旧值");
});

test("改权限模式：整次请求只在最后写一次盘，不在中途单独落盘", async (t) => {
  const { srv, call } = await serve(routeSettings);
  t.after(() => srv.close());
  const orig = fs.renameSync;
  let saves = 0;
  const m = t.mock.method(fs, "renameSync", (from, to) => {
    if (String(to) === PATHS.settings) saves++;
    return orig.call(fs, from, to);
  });
  try {
    const r = await call("/api/settings", { permissionMode: "acceptEdits" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(saves, 1, `一次设置请求写了 ${saves} 次盘；permissionMode 不能先单独落盘，最后失败时就成了半套设置`);
  } finally {
    m.mock.restore();
  }
});
