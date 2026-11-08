// 环境实况 / 对账 / 反馈 / 封口 / 登录状态（0.6.9 审计 195-M.1/M.3/M.4/M.5/M.7/M.9、G.3、R.8）
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CFG, PREFIX } from "../gw/config.mjs";
import { COMP_DIR } from "../gw/components.mjs";
import { ENV_FACTS, devkitVersion, envFactsKey } from "../gw/envfacts.mjs";
import { reconcileNow } from "../gw/reconcile.mjs";
import { routeFeedback } from "../gw/feedback.mjs";
import { routeCaps } from "../gw/caps.mjs";
import { sealArgv } from "../gw/edition.mjs";

const FILES = path.dirname(PREFIX);
function fakeRes() {
  const r = { code: 0, body: null, writeHead(c) { r.code = c; }, end(b) { r.body = b ? JSON.parse(String(b)) : null; } };
  return r;
}
function writeComp(id, rec) {
  fs.mkdirSync(COMP_DIR, { recursive: true });
  fs.writeFileSync(path.join(COMP_DIR, id + ".json"), JSON.stringify(rec));
}

test("devkitVersion：从 .devkit-ok 的 base 里取出版本（195-M.5）", () => {
  assert.equal(devkitVersion({ base: "https://github.com/x/y/releases/download/devkit-2026.10.28/" }), "2026.10.28");
  assert.equal(devkitVersion({ base: "https://example.com/no-version/" }), "");
  assert.equal(devkitVersion({ tag: "local-1" }), "local-1");
});

test("envFactsKey：组件版本变了 key 就变，自检会重跑（195-M.1）", () => {
  fs.writeFileSync(path.join(PREFIX, ".devkit-ok"), JSON.stringify({ sha256: "abc" }));
  writeComp("keytest", { id: "keytest", state: "ok", version: "1", base: "abc" });
  const k1 = envFactsKey();
  assert.match(k1, /keytest@1/);
  writeComp("keytest", { id: "keytest", state: "ok", version: "2", base: "abc" });
  assert.notEqual(envFactsKey(), k1);
});

test("对账：主动卸载 Claude 的标记在，就不报红（195-M.7）", async () => {
  fs.writeFileSync(path.join(FILES, ".claude-uninstalled"), "");
  const r = await reconcileNow();
  assert.ok(!r.findings.some((f) => f.key === "claude" && f.level === "error"), JSON.stringify(r.findings));
  fs.rmSync(path.join(FILES, ".claude-uninstalled"), { force: true });
});

test("对账：组件依赖的共享文件被删会报出来（#185）", async () => {
  fs.writeFileSync(path.join(PREFIX, ".devkit-ok"), JSON.stringify({ sha256: "abc" }));
  writeComp("sharedgone", { id: "sharedgone", state: "ok", base: "abc", files: [], shared: ["share/missing-file"], bin: [] });
  const r = await reconcileNow();
  assert.ok(r.findings.some((f) => f.key === "comp-shared:sharedgone"), JSON.stringify(r.findings));
});

test("对账：悬空软链不再算「文件在」（真机 86 个）", async () => {
  fs.writeFileSync(path.join(PREFIX, ".devkit-ok"), JSON.stringify({ sha256: "abc" }));
  fs.mkdirSync(path.join(PREFIX, "share"), { recursive: true });
  try { fs.rmSync(path.join(PREFIX, "share/dangling"), { force: true }); } catch {}
  fs.symlinkSync(path.join(PREFIX, "share/does-not-exist"), path.join(PREFIX, "share/dangling"));
  writeComp("dangle", { id: "dangle", state: "ok", base: "abc", files: ["share/dangling"], shared: [], bin: [] });
  const r = await reconcileNow();
  assert.ok(r.findings.some((f) => f.key === "comp-files:dangle"), JSON.stringify(r.findings));
});

test("反馈：自检 JSON 缺 fail/info 不再 500（195-M.9）", async () => {
  process.env.CCAPP_PRIV_SOCK = path.join(CFG.home, "no-such-priv.sock");   // 别碰真 App 的 socket
  fs.writeFileSync(ENV_FACTS, JSON.stringify({ key: "k", pass: 3 }));
  const res = fakeRes();
  await routeFeedback({ method: "GET", headers: {} }, res, new URL("http://x/api/issue-draft"), "/api/issue-draft");
  assert.equal(res.code, 200);
  assert.match(res.body.url, /issues\/new/);
});

test("status 暴露真实登录态字段（195-G.3）", async () => {
  const res = fakeRes();
  await routeCaps({ method: "GET", headers: {} }, res, new URL("http://x/api/status"), "/api/status");
  assert.equal(res.code, 200);
  assert.ok("auth" in res.body);
});

test("claude --version 不走封口（195-M.4）", () => {
  assert.deepEqual(sealArgv(["--version"]), ["--version"]);
  // 开会话的照旧封口
  assert.ok(sealArgv(["-p", "hi"]).includes("--setting-sources"));
});
