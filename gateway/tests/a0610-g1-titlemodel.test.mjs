// 195-E.6：切厂商后 titleModel 要跟着清掉。以前只清 model，自动起名的旧厂商型号留在设置里：
// 设置页补进新清单显示选中，autotitle 却因为型号不在这一家的清单里静默改用本轮模型。
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下，下面一行都不跑
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { PATHS } from "../gw/config.mjs";
import { NEXT } from "../gw/http.mjs";
import { SETTINGS } from "../gw/settings-store.mjs";
import { PROVIDER, PROVIDERS_CFG } from "../gw/providers.mjs";

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

test("切厂商：model 和 titleModel 一起清掉，磁盘上也不留旧值", async (t) => {
  const other = Object.keys(PROVIDERS_CFG.providers).find((id) => id !== PROVIDER.id);
  assert.ok(other, "测试环境里至少要有一家别的厂商");
  const had = fs.existsSync(PATHS.settings);
  const before = had ? fs.readFileSync(PATHS.settings, "utf8") : null;
  t.after(() => {
    if (had) fs.writeFileSync(PATHS.settings, before); else fs.rmSync(PATHS.settings, { force: true });
  });
  SETTINGS.model = "old-provider-model";
  SETTINGS.titleModel = "old-provider-title-model";

  const { routeSettings } = await import("../gw/settings.mjs");
  const { srv, call } = await serve(routeSettings);
  t.after(() => srv.close());
  const r = await call("/api/settings", { provider: other });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.settings.provider, other);
  assert.equal(r.body.settings.model, null, "旧厂商的模型名不能带过去");
  assert.equal(r.body.settings.titleModel, null, "旧厂商的自动起名型号不能带过去");
  assert.equal(SETTINGS.titleModel, null);
  // 落盘的也必须是清掉后的值，重启不会又冒出来
  const disk = JSON.parse(fs.readFileSync(PATHS.settings, "utf8"));
  assert.equal(disk.titleModel, null);
  assert.equal(disk.model, null);
});
