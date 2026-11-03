// 设置持久化（#122-3）：写盘失败要如实返回 500，不能报「已保存」
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下，下面一行都不跑
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { PATHS } from "../gw/config.mjs";
import { NEXT } from "../gw/http.mjs";

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

test("设置写盘失败：返回 500，磁盘旧值原样保留（#122-3）", async (t) => {
  const had = fs.existsSync(PATHS.settings);
  const before = had ? fs.readFileSync(PATHS.settings, "utf8") : null;
  const old = JSON.stringify({ effort: "high", permMigrated: 1 }, null, 2);
  fs.mkdirSync(path.dirname(PATHS.settings), { recursive: true });
  fs.writeFileSync(PATHS.settings, old);
  // 写完旧文件再加载：loadSettings 只在模块导入时读一次
  const { routeSettings } = await import("../gw/settings.mjs");
  const { srv, call } = await serve(routeSettings);
  t.after(() => srv.close());
  const orig = fs.renameSync;
  const m = t.mock.method(fs, "renameSync", (from, to) => {
    if (String(to) === PATHS.settings) throw Object.assign(new Error("EIO"), { code: "EIO" });
    return orig.call(fs, from, to);
  });
  try {
    const r = await call("/api/settings", { effort: "low" });
    assert.equal(r.status, 500, JSON.stringify(r.body));
    assert.match(String(r.body.error || ""), /写入磁盘/);
    assert.equal(fs.readFileSync(PATHS.settings, "utf8"), old, "失败时磁盘旧值必须原样保留");
  } finally {
    m.mock.restore();
    // 同一轮测试共用临时 HOME：把自己写进去的设置文件恢复/删掉，别影响后面的用例
    try { fs.rmSync(PATHS.settings + ".tmp", { force: true }); } catch {}
    if (had) fs.writeFileSync(PATHS.settings, before); else fs.rmSync(PATHS.settings, { force: true });
  }
});

test("输出风格的 name / description：冒号后没空格、值以 s 开头也照原样读（PR #118 第 3 条）", async (t) => {
  const { CFG } = await import("../gw/config.mjs");
  const dir = path.join(CFG.workspace, ".claude", "output-styles");
  fs.mkdirSync(dir, { recursive: true });
  const a = path.join(dir, "fmt-a.md"), b = path.join(dir, "fmt-b.md");
  fs.writeFileSync(a, "---\nname:sunny\ndescription:short and sweet\n---\nbody\n");
  fs.writeFileSync(b, "---\nname:\ndescription: x\n---\n");
  t.after(() => { fs.rmSync(a, { force: true }); fs.rmSync(b, { force: true }); });
  const { routeSettings } = await import("../gw/settings.mjs");
  const { srv, call } = await serve(routeSettings);
  t.after(() => srv.close());
  const r = await call("/api/settings");
  const st = r.body.outputStyles;
  assert.ok(st.some((o) => o.id === "sunny" && o.desc === "short and sweet"), JSON.stringify(st));
  assert.ok(!st.some((o) => o.id === "description: x"), "name 为空时不能把下一行当成名字");
});
