// 厂商配置（gw/providers.mjs）：0.6.9 审计 P1-1 / P1-2 / P1-8 / P1-15
// 配置是模块加载时读的：每个场景在子进程里用自己的临时 home 跑，别和别的测试文件共用一份配置
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const GW = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "gw");
const ROOT = fs.mkdtempSync(path.join(process.env.CCAPP_WORKSPACE, "a0610-prov-"));
let seq = 0;

/** 在子进程里：先写好 files（相对 home），再 import providers.mjs 跑 code；code 里 console.log(JSON) 作为结果 */
function scenario(files, code) {
  const home = path.join(ROOT, "h" + ++seq);
  fs.mkdirSync(home, { recursive: true });
  for (const [f, v] of Object.entries(files)) fs.writeFileSync(path.join(home, f), typeof v === "string" ? v : JSON.stringify(v));
  const src = `const P = await import(${JSON.stringify(path.join(GW, "providers.mjs"))}); ${code}; process.exit(0);`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", src], {
    env: { ...process.env, CCAPP_HOME: home, HOME: home, CCAPP_WORKSPACE: path.join(home, "ws"), CCAPP_PREFIX: "" }, encoding: "utf8", timeout: 30000 });
  return { rc: r.status, out: r.stdout.trim().split("\n").pop(), err: r.stderr, home };
}

test("P1-15：自定义接口的 endpoints 不是数组 → 不崩，照常加载", () => {
  for (const ep of [{}, "x", 3, [null, { id: 1 }]]) {
    const r = scenario({ "ccapp-providers.json": { active: "custom-1", providers: { "custom-1": { baseUrl: "https://a.example", apiKey: "k", endpoints: ep } } } },
      `console.log(JSON.stringify({ base: P.PROVIDERS_CFG.providers["custom-1"].baseUrl }));`);
    assert.equal(r.rc, 0, r.err);
    assert.deepEqual(JSON.parse(r.out), { base: "https://a.example" });
  }
});

test("P1-1：配置文件坏了 → 原文件留底，保存不会把 Key 覆盖没", () => {
  const bad = '{"providers":{"custom-1":{"baseUrl":"https://a.example","apiKey":"SECRET-1"}}';   // 少个 }
  const r = scenario({ "ccapp-providers.json": bad },
    `const r = P.upsertProvider("", { baseUrl: "https://b.example", apiKey: "k2", label: "b" }); console.log(JSON.stringify({ ok: r.ok }));`);
  assert.equal(r.rc, 0, r.err);
  const bads = fs.readdirSync(r.home).filter((f) => f.startsWith("ccapp-providers.json.bad-"));
  assert.equal(bads.length, 1);
  assert.equal(fs.readFileSync(path.join(r.home, bads[0]), "utf8"), bad, "坏文件原样留着（Key 在里面）");
});

test("P1-2：改了端点主机又没给新 Key → 旧 Key 清掉；同主机改路径、或给了新 Key → 照旧", () => {
  const cfg = { "ccapp-providers.json": { active: "deepseek", providers: { "custom-1": { label: "a", baseUrl: "https://a.example/x", apiKey: "OLD" } } } };
  const r = scenario(cfg, `
    const a = P.upsertProvider("custom-1", { baseUrl: "https://evil.example" });
    const k1 = JSON.parse(require("fs").readFileSync(process.env.CCAPP_HOME + "/ccapp-providers.json", "utf8")).providers["custom-1"].apiKey ?? null;
    console.log(JSON.stringify({ cleared: !!a.keyCleared, k1 }));`.replace('require("fs")', "(await import('node:fs')).default"));
  assert.equal(r.rc, 0, r.err);
  assert.deepEqual(JSON.parse(r.out), { cleared: true, k1: null });

  const r2 = scenario(cfg, `
    const fs = (await import('node:fs')).default;
    const a = P.upsertProvider("custom-1", { baseUrl: "https://a.example/y" });
    const b = P.upsertProvider("custom-1", { baseUrl: "https://c.example", apiKey: "NEW" });
    const k = JSON.parse(fs.readFileSync(process.env.CCAPP_HOME + "/ccapp-providers.json", "utf8")).providers["custom-1"].apiKey;
    console.log(JSON.stringify({ a: !!a.keyCleared, b: !!b.keyCleared, k }));`);
  assert.equal(r2.rc, 0, r2.err);
  assert.deepEqual(JSON.parse(r2.out), { a: false, b: false, k: "NEW" });
});

test("P1-8：老配置没有 nextCustom、最大号被删过，但会话钉选还记着它 → 新接口不复用这个号", () => {
  const r = scenario({
    "ccapp-providers.json": { active: "deepseek", providers: { "custom-1": { baseUrl: "https://a.example", apiKey: "k" } } },
    "ccapp-session-models.json": { "sid-1": { provider: "custom-3", model: "m" } },
  }, `const a = P.upsertProvider("", { baseUrl: "https://b.example", apiKey: "k2" }); console.log(JSON.stringify({ id: a.id }));`);
  assert.equal(r.rc, 0, r.err);
  assert.deepEqual(JSON.parse(r.out), { id: "custom-4" });
});
