// FIND-050：预置厂商在 cn / intl 等两条预置线路之间切换、Key 输入框留空保存时，
// 旧 Key 不能跟着去新线路的域名。以前只在「旧线路已被目录删除」时清（196-凭据.1），
// 正常的两条线路互切漏了。这里按子进程场景跑（厂商配置在模块加载时读）。
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const GW = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "gw");
const ROOT = fs.mkdtempSync(path.join(process.env.CCAPP_WORKSPACE, "stab-a-f050-"));
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

const cfg = { "ccapp-providers.json": { active: "deepseek", providers: { kimi: { apiKey: "OLD-KEY", endpoint: "cn" } } } };

test("cn→intl、Key 留空：旧 Key 清掉、回 keyCleared、磁盘上也不留", () => {
  const r = scenario(cfg, `
    const fs = (await import("node:fs")).default;
    const a = P.upsertProvider("kimi", { id: "kimi", apiKey: "", endpoint: "intl" });
    const disk = JSON.parse(fs.readFileSync(process.env.CCAPP_HOME + "/ccapp-providers.json", "utf8"));
    const p = P.providerById("kimi");
    console.log(JSON.stringify({ ok: !!a.ok, cleared: !!a.keyCleared, diskKey: disk.providers.kimi.apiKey ?? null, key: P.keyOf(p), ep: p.endpoint }));`);
  assert.equal(r.rc, 0, r.err);
  assert.deepEqual(JSON.parse(r.out), { ok: true, cleared: true, diskKey: null, key: null, ep: "intl" });
});

test("换线路时给了新 Key：用新的，不算清掉", () => {
  const r = scenario(cfg, `
    const a = P.upsertProvider("kimi", { id: "kimi", apiKey: "NEW-KEY", endpoint: "intl" });
    console.log(JSON.stringify({ ok: !!a.ok, cleared: !!a.keyCleared, key: P.keyOf(P.providerById("kimi")) }));`);
  assert.equal(r.rc, 0, r.err);
  assert.deepEqual(JSON.parse(r.out), { ok: true, cleared: false, key: "NEW-KEY" });
});

test("同一条线路留空 Key 保存别的字段：Key 保留", () => {
  const r = scenario(cfg, `
    const a = P.upsertProvider("kimi", { id: "kimi", apiKey: "", endpoint: "cn", defaultModel: "kimi-k3" });
    console.log(JSON.stringify({ ok: !!a.ok, cleared: !!a.keyCleared, key: P.keyOf(P.providerById("kimi")) }));`);
  assert.equal(r.rc, 0, r.err);
  assert.deepEqual(JSON.parse(r.out), { ok: true, cleared: false, key: "OLD-KEY" });
});

test("配置里没记线路（=第一条）时把第一条明确保存回去：不算换线路，Key 保留", () => {
  const r = scenario({ "ccapp-providers.json": { active: "deepseek", providers: { kimi: { apiKey: "OLD-KEY" } } } }, `
    const a = P.upsertProvider("kimi", { id: "kimi", apiKey: "", endpoint: "cn" });
    console.log(JSON.stringify({ ok: !!a.ok, cleared: !!a.keyCleared, key: P.keyOf(P.providerById("kimi")) }));`);
  assert.equal(r.rc, 0, r.err);
  assert.deepEqual(JSON.parse(r.out), { ok: true, cleared: false, key: "OLD-KEY" });
});

test("196-凭据.1 行为保留：旧线路已失配，重选线路留空 Key → 照样清", () => {
  const r = scenario({ "ccapp-providers.json": { active: "deepseek", providers: { kimi: { apiKey: "OLD-KEY", endpoint: "gone-region" } } } }, `
    const a = P.upsertProvider("kimi", { id: "kimi", apiKey: "", endpoint: "cn" });
    console.log(JSON.stringify({ ok: !!a.ok, cleared: !!a.keyCleared, key: P.keyOf(P.providerById("kimi")) }));`);
  assert.equal(r.rc, 0, r.err);
  assert.deepEqual(JSON.parse(r.out), { ok: true, cleared: true, key: null });
});

test("没有线路表的预置厂商：保存默认型号不影响 Key", () => {
  const r = scenario({ "ccapp-providers.json": { active: "deepseek", providers: { deepseek: { apiKey: "DS-KEY" } } } }, `
    const a = P.upsertProvider("deepseek", { id: "deepseek", apiKey: "", defaultModel: "deepseek-v4-pro" });
    console.log(JSON.stringify({ ok: !!a.ok, cleared: !!a.keyCleared, key: P.keyOf(P.providerById("deepseek")) }));`);
  assert.equal(r.rc, 0, r.err);
  assert.deepEqual(JSON.parse(r.out), { ok: true, cleared: false, key: "DS-KEY" });
});
