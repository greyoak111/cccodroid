// D10 第 1 步（11-09）：会话保留期。claude 缺省 30 天就删会话（连同附属数据，不进回收站），项目设置写个小数字还会压过用户级的。
// 网关启动时给用户级设置补上永久保留（写过的不动、写坏的文件不碰、不弹配置改动卡片）；每轮 --settings 带上核过的值；
// 发行版回填不再照搬用户写的原值；终端包装脚本同口径
import { CFG } from "../gw/config.mjs";
import "./fixtures/uc-baseline.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { _setSealed } from "../gw/edition.mjs";
import { RETENTION_DAYS, sessionRetention } from "../gw/retention.mjs";
import { settingsArgs } from "../gw/claude.mjs";
import { ensureSessionRetention } from "../gw/extensions.mjs";
import { sealPrepare, sealCleanup } from "../gw/seal.mjs";
import { ucPending } from "../gw/userconf.mjs";

const F = path.join(CFG.home, ".claude", "settings.json");
const had = fs.existsSync(F) ? fs.readFileSync(F) : null;
const put = (s) => { fs.mkdirSync(path.dirname(F), { recursive: true }); fs.writeFileSync(F, s); };
const read = () => JSON.parse(fs.readFileSync(F, "utf8"));
const flagSettings = () => { const a = settingsArgs(); return JSON.parse(a[a.indexOf("--settings") + 1]); };
const pendingSettings = () => (ucPending()?.rels || []).includes(".claude/settings.json");
after(() => {
  _setSealed(true);
  if (had) fs.writeFileSync(F, had); else fs.rmSync(F, { force: true });
  fs.rmSync(F + ".bak", { force: true });
  fs.rmSync(path.join(CFG.home, "sealproj-d10"), { recursive: true, force: true });
});

test("读保留期：没写、写坏、不是正整数都按永久；合法的照用户的", () => {
  fs.rmSync(F, { force: true });
  assert.deepEqual(sessionRetention(), { days: RETENTION_DAYS, own: false });
  for (const bad of ['{"cleanupPeriodDays":0}', '{"cleanupPeriodDays":-3}', '{"cleanupPeriodDays":"90"}', '{"cleanupPeriodDays":1.5}', "{oops", "[]"]) {
    put(bad);
    assert.equal(sessionRetention().days, RETENTION_DAYS, bad);
  }
  put('{"cleanupPeriodDays":90}');
  assert.deepEqual(sessionRetention(), { days: 90, own: true });
});

test("启动补写：没有文件就新建；有别的键照留并留 .bak；用户写过的（含写坏的值）不动；整份坏了不碰", async () => {
  fs.rmSync(F, { force: true });
  let r = await ensureSessionRetention();
  assert.equal(r.changed, true);
  assert.deepEqual(read(), { cleanupPeriodDays: RETENTION_DAYS });
  assert.equal(pendingSettings(), false, "应用自己补的不弹「用户级配置改了」");

  put(JSON.stringify({ model: "x", hooks: { Stop: [] } }, null, 2));
  ucPending(); // 当前样子先让卡片看见（hooks 是要问的键），再认下，模拟用户已确认过
  const { ucKeep } = await import("../gw/userconf.mjs");
  ucKeep([".claude/settings.json"]);
  r = await ensureSessionRetention();
  assert.equal(r.changed, true);
  assert.deepEqual(read(), { model: "x", hooks: { Stop: [] }, cleanupPeriodDays: RETENTION_DAYS });
  assert.deepEqual(JSON.parse(fs.readFileSync(F + ".bak", "utf8")), { model: "x", hooks: { Stop: [] } });
  assert.equal(pendingSettings(), false);

  for (const own of ['{"cleanupPeriodDays":90}', '{"cleanupPeriodDays":0}']) {
    put(own);
    r = await ensureSessionRetention();
    assert.equal(r.changed, false, own);
    assert.equal(fs.readFileSync(F, "utf8"), own);
  }
  put("{oops");
  await assert.rejects(ensureSessionRetention());
  assert.equal(fs.readFileSync(F, "utf8"), "{oops");
});

test("每轮 --settings 带核过的保留期（项目设置压不过它）", () => {
  fs.rmSync(F, { force: true });
  assert.equal(flagSettings().cleanupPeriodDays, RETENTION_DAYS);
  put('{"cleanupPeriodDays":120}');
  assert.equal(flagSettings().cleanupPeriodDays, 120);
  put('{"cleanupPeriodDays":0}');
  assert.equal(flagSettings().cleanupPeriodDays, RETENTION_DAYS, "写坏的值不往下传");
});

test("发行版回填不再照搬用户写的 cleanupPeriodDays（由 settingsArgs 统一给）", () => {
  put('{"cleanupPeriodDays":0,"includeCoAuthoredBy":false}');
  _setSealed(true);
  fs.mkdirSync(path.join(CFG.home, "sealproj-d10"), { recursive: true });
  const p = sealPrepare({ cwd: path.join(CFG.home, "sealproj-d10"), runId: 1010 });
  assert.equal(p.block, null);
  assert.equal(p.settings.cleanupPeriodDays, undefined);
  assert.equal(p.settings.includeCoAuthoredBy, false, "别的照搬键不受影响");
  sealCleanup(1010);
});

test("终端包装脚本：照用户级的合法值带上，没写或不合法就按 36500", () => {
  const src = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "android", "assets", "bin", "claude");
  const dir = fs.mkdtempSync(path.join(process.env.CCAPP_TMP || CFG.home, "d10w-"));
  fs.mkdirSync(path.join(dir, "bin"));
  const w = path.join(dir, "bin", "claude"), fake = path.join(dir, "ld.sh");
  fs.writeFileSync(w, fs.readFileSync(src, "utf8").replace(/^SEALED=1$/m, "SEALED=0"), { mode: 0o700 });
  const sh = fs.existsSync("/system/bin/sh") ? "/system/bin/sh" : "/bin/sh";
  fs.writeFileSync(fake, `#!${sh}\nfor a in "$@"; do printf '%s\\n' "$a"; done\n`, { mode: 0o700 });
  const days = () => {
    const r = spawnSync(sh, [w, "-p", "hi"], { encoding: "utf8", env: { ...process.env, CCAPP_LD: fake, CCAPP_KEY_FILE: "", HOME: CFG.home } });
    const a = r.stdout.split("\n");
    return JSON.parse(a[a.indexOf("--settings") + 1]).cleanupPeriodDays;
  };
  try {
    fs.rmSync(F, { force: true });
    assert.equal(days(), RETENTION_DAYS);
    put(JSON.stringify({ model: "x", cleanupPeriodDays: 45 }, null, 2));
    assert.equal(days(), 45);
    put('{"cleanupPeriodDays": 0}');
    assert.equal(days(), RETENTION_DAYS);
    put('{"cleanupPeriodDays":"7"}');
    assert.equal(days(), RETENTION_DAYS);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
