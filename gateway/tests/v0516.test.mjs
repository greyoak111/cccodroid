// v0.5.16：#66（组件环境、清单为空可选、旧入口残留）、#67（容量声明、压缩线取小）
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { componentEnv } from "../gw/component-env.mjs";
import { withConfigured, compactLineOf, cachedModels } from "../gw/models.mjs";
import { claudeEnv, currentModelInfo } from "../gw/claude.mjs";

test("组件环境：留下加载器要的变量，别的不带（#66 第 3 项）", () => {
  const src = {
    LANG: "C.UTF-8", LD_PRELOAD: "/a/lib/exec-shim-bionic.so:/u/lib/libtermux-exec-linker-ld-preload.so",
    TERMUX_APP__DATA_DIR: "/data/user/0/cc.codroid", TERMUX_APP__LEGACY_DATA_DIR: "/data/data/cc.codroid",
    TERMUX_EXEC__SYSTEM_LINKER_EXEC__MODE: "force", NODE_OPTIONS: "--require=/data/user/0/cc.codroid/files/app/lib/execpath.cjs",
    ANTHROPIC_API_KEY: "secret", CCAPP_TOKEN: "t", PATH: "/evil",
  };
  const env = componentEnv("/h", "/u", src);
  for (const k of ["TERMUX_APP__DATA_DIR", "TERMUX_APP__LEGACY_DATA_DIR", "TERMUX_EXEC__SYSTEM_LINKER_EXEC__MODE", "NODE_OPTIONS", "LD_PRELOAD", "LANG"]) assert.equal(env[k], src[k], k);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CCAPP_TOKEN, undefined);
  assert.equal(env.HOME, "/h");
  assert.equal(env.PATH, "/u/bin:/system/bin:/system/xbin");
  // 别的 NODE_OPTIONS（能让组件跑任意代码）不放
  for (const bad of ["--require=/tmp/x.cjs", "--require=/a/lib/execpath.cjs --inspect", "--inspect"]) assert.equal(componentEnv("/h", "/u", { NODE_OPTIONS: bad }).NODE_OPTIONS, undefined, bad);
});

const P = (o) => ({ id: "custom-v0516", custom: true, baseUrl: "http://127.0.0.1:1", apiKey: "fixture-only", defaultModel: "m-big", fastModel: "m-big", ...o });

test("清单为空：列出配置的默认/快速模型，可选（#66 第 5 项）", () => {
  assert.deepEqual(withConfigured([], P()).map((m) => [m.id, m.context_window, m.configured]), [["m-big", 0, true]]);
  assert.deepEqual(withConfigured([], P({ fastModel: "m-fast" })).map((m) => m.id), ["m-big", "m-fast"]);
  // 原生/登录/端侧/预置不动
  assert.deepEqual(withConfigured([], P({ custom: false })), []);
  assert.deepEqual(withConfigured([], P({ local: true })), []);
});

test("声明的窗口：只补默认/快速模型、不覆盖上游报的（#67）", () => {
  const p = P({ contextWindow: 1048576 });
  assert.equal(withConfigured([], p)[0].context_window, 1048576);
  const list = withConfigured([{ id: "m-big", context_window: 0 }, { id: "other", context_window: 0 }, { id: "m-big2", context_window: 64000 }], p);
  assert.deepEqual(list.map((m) => m.context_window), [1048576, 0, 64000]);
  assert.equal(withConfigured([{ id: "m-big", context_window: 128000 }], p)[0].context_window, 128000);
});

test("桥那种接口：声明了窗口就下发 MAX_CONTEXT_TOKENS（#67）", () => {
  const p = P({ id: "custom-v0516b", contextWindow: 1048576 });
  assert.equal(cachedModels(p).length, 1);
  assert.equal(currentModelInfo("m-big", p).context_window, 1048576);
  assert.equal(claudeEnv({ model: "m-big", provider: p }).CLAUDE_CODE_MAX_CONTEXT_TOKENS, "1048576");
  const q = P({ id: "custom-v0516c" });
  assert.equal(claudeEnv({ model: "m-big", provider: q }).CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined);
});

test("压缩线 = min(设置, 窗口)；第三方不知道窗口按 200k（#67）", () => {
  assert.equal(compactLineOf(528000, 0, P()), 200000);
  assert.equal(compactLineOf(528000, 1048576, P()), 528000);
  assert.equal(compactLineOf(100000, 0, P()), 100000);
  assert.equal(compactLineOf(528000, 0, { nativeModels: true }), 528000);
  assert.equal(compactLineOf(null, 200000, P()), null);
});

test("接口设置：上下文窗口存得上、0 清空、乱填报错不悄悄丢（#67）", async () => {
  const http = await import("node:http");
  const { routeProviders } = await import("../gw/providers.mjs");
  const srv = http.createServer(async (req, res) => { const u = new URL(req.url, "http://x"); await routeProviders(req, res, u, u.pathname); });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  const post = async (p, body) => (await fetch(`http://127.0.0.1:${srv.address().port}${p}`, { method: "POST", body: JSON.stringify(body) })).json();
  try {
    const r = await post("/api/providers/save", { label: "窗口测", baseUrl: "https://api.example.com", defaultModel: "m", contextWindow: 1048576 });
    assert.equal(r.provider.contextWindow, 1048576);
    for (const bad of [1024.5, 100, 99999999, "abc"]) {
      const e = await post("/api/providers/save", { id: r.id, contextWindow: bad });
      assert.ok(e.error, String(bad));
    }
    const r2 = await post("/api/providers/save", { id: r.id, contextWindow: 0 });
    assert.equal(r2.provider.contextWindow, 0);
    await post("/api/providers/delete", { id: r.id });
  } finally { srv.close(); }
});

test("手改配置塞的怪窗口不认", () => {
  for (const v of [99999999, 12.5, -1, "1m"]) assert.equal(withConfigured([], P({ contextWindow: v }))[0].context_window, 0, String(v));
});
