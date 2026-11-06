// v0.5.12 之后：独立审查（中1 公共后缀、低1 列目录、低3 环境变量、低5 循环依赖）
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CFG } from "../gw/config.mjs";
import { modelsUrlOk } from "../gw/providers.mjs";
import { routeFiles } from "../gw/files.mjs";

const GW = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ok = (b, m) => modelsUrlOk({ baseUrl: b, modelsUrl: m });

test("模型清单地址：多级公共后缀、托管平台子域不算同站", () => {
  assert.equal(ok("https://relay.example.co.uk/v1", "https://telemetry.attacker.co.uk/m"), false);
  assert.equal(ok("https://api.example.com.cn/v1", "https://evil.com.cn/m"), false);
  assert.equal(ok("https://api.example.com.au/v1", "https://evil.com.au/m"), false);
  assert.equal(ok("https://relay.workers.dev", "https://evil.workers.dev/m"), false);
  assert.equal(ok("https://a.vercel.app", "https://b.vercel.app/m"), false);
  assert.equal(ok("https://api.deepseek.com/anthropic", "https://api.deepseek.com/models"), true);
  assert.equal(ok("https://open.bigmodel.cn/api/anthropic", "https://open.bigmodel.cn/api/paas/v4/models"), true);
  assert.equal(ok("https://api.example.co.uk/v1", "https://models.example.co.uk/m"), false, "不同主机一律不带密钥");
  for (const suf of ["ddns.net", "hopto.org", "blogspot.com", "azureedge.net", "surge.sh", "gitbook.io", "sch.uk", "k12.ca.us"])
    assert.equal(ok(`https://victim.${suf}/v1`, `https://evil.${suf}/m`), false, suf);
});

function fakeRes() {
  const r = { code: 0, body: null, writeHead(c) { r.code = c; }, end(b) { r.body = b ? JSON.parse(String(b)) : null; } };
  return r;
}
async function list(dir) {
  const res = fakeRes();
  await routeFiles({ method: "GET", headers: {} }, res, new URL(`http://x/api/files?path=${encodeURIComponent(dir)}&hidden=1`), "/api/files");
  return res;
}

test("列目录：home 根拒绝，工作区照常，凭据文件名不出现", async () => {
  fs.mkdirSync(CFG.workspace, { recursive: true });
  fs.writeFileSync(path.join(CFG.workspace, "a.txt"), "x");
  fs.writeFileSync(path.join(CFG.workspace, "id_ed25519"), "k");
  const h = await list(CFG.home);
  assert.equal(h.code, 403);
  assert.equal((h.body.entries || []).length, 0);
  const w = await list(CFG.workspace);
  assert.notEqual(w.code, 403);
  const names = w.body.entries.map((e) => e.name);
  assert.ok(names.includes("a.txt"));
  assert.ok(!names.includes("id_ed25519"));
  fs.rmSync(path.join(CFG.workspace, "id_ed25519"));
  fs.mkdirSync(path.join(CFG.workspace, ".ssh"), { recursive: true });
  assert.equal((await list(path.join(CFG.workspace, ".ssh"))).code, 403);
});

test("claude 子进程不继承 CLASSPATH / TEXINPUTS", () => {
  const src = fs.readFileSync(path.join(GW, "gw/claude.mjs"), "utf8");
  const re = new RegExp(/const EXTRA_ENV_DENY = (\/.*\/);/.exec(src)[1].slice(1, -1));
  for (const k of ["CLASSPATH", "TEXINPUTS", "JDK_JAVA_OPTIONS", "TEXMFHOME", "ERL_LIBS"]) assert.ok(re.test(k), k);
  assert.ok(!re.test("LANG"));
});

test("extraEnv 拒单补证书注入与登录令牌（红队 11-07 探针 18→15）", () => {
  const src = fs.readFileSync(path.join(GW, "gw/claude.mjs"), "utf8");
  const re = new RegExp(/const EXTRA_ENV_DENY = (\/.*\/);/.exec(src)[1].slice(1, -1));
  for (const k of ["REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "CLAUDE_CODE_OAUTH_TOKEN"]) assert.ok(re.test(k), k);
  // 设计放行的照旧
  for (const k of ["API_TIMEOUT_MS", "CLAUDE_CODE_MAX_RETRIES", "TZ", "HTTP_PROXY"]) assert.ok(!re.test(k), k);
});

test("各网关模块单独导入都不崩（不靠 server.mjs 的导入顺序）", async () => {
  for (const m of ["providers", "settings", "models", "queue", "run", "claude"]) {
    const r = await new Promise((done) => execFile(process.execPath, ["-e", `import(${JSON.stringify(path.join(GW, "gw", m + ".mjs"))}).then(()=>process.exit(0),e=>{console.error(e.message);process.exit(1)})`], { env: process.env, timeout: 60000 }, (e, out, err) => done({ code: e ? e.code : 0, err })));
    assert.equal(r.code, 0, m + ": " + r.err);
  }
});
