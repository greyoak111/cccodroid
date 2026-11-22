// 两个新加的状态出口：本机自检（195-M.1）、工作岛（195-P.4）
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import os from "node:os";
import vm from "node:vm";
import { NEXT } from "../gw/http.mjs";
import { SETTINGS } from "../gw/settings-store.mjs";

const { routeFeedback } = await import("../gw/feedback.mjs");
const { routeSettings } = await import("../gw/settings.mjs");
const W = await import("../gw/work-island.mjs");
const srv = http.createServer(async (req, res) => { const u = new URL(req.url, "http://x");
  for (const r of [routeFeedback, routeSettings]) if ((await r(req, res, u, u.pathname)) !== NEXT) return;
  res.writeHead(404).end(); });
await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
const bin = fs.mkdtempSync(path.join(os.tmpdir(), "st-")), oldBin = process.env.CCAPP_BIN;
after(() => { srv.close(); process.env.CCAPP_BIN = oldBin; fs.rmSync(bin, { recursive: true, force: true }); });
const call = async (p, post) => { const r = await fetch(`http://127.0.0.1:${srv.address().port}${p}`, post ? { method: "POST", body: "{}" } : {}); return { status: r.status, body: await r.json() }; };

test("本机自检：没有结果时如实说；点重新自检就跑，跑完能看到通过 / 失败项；跑着时不另起", async () => {
  fs.writeFileSync(path.join(bin, "cccodroid-selftest"), "#!/bin/sh\nsleep 0.5\necho 'PASS cc'\necho 'PASS git'\necho 'FAIL zig: not found'\necho 'INFO hw h264'\n", { mode: 0o755 });
  process.env.CCAPP_BIN = bin;
  const a = (await call("/api/env-facts")).body;
  assert.equal(a.supported, true);
  const r1 = (await call("/api/env-facts/rerun", true)).body;
  assert.equal(r1.running, true);
  const r2 = (await call("/api/env-facts/rerun", true)).body;
  assert.equal(r2.startedAt, r1.startedAt, "已经在跑就不另起");
  let s;
  for (let i = 0; i < 100; i++) { s = (await call("/api/env-facts")).body; if (!s.running) break; await new Promise((ok) => setTimeout(ok, 100)); }
  assert.equal(s.running, false);
  assert.equal(s.pass, 2);
  assert.deepEqual(s.fail, ["zig: not found"]);
  assert.equal(s.stale, false);
  assert.equal(s.error, null);
});

test("本机自检：没跑出结果 → error 写明原因，旧结果不被冲掉", async () => {
  fs.writeFileSync(path.join(bin, "cccodroid-selftest"), "#!/bin/sh\necho nothing\n", { mode: 0o755 });
  await call("/api/env-facts/rerun", true);
  let s;
  for (let i = 0; i < 100; i++) { s = (await call("/api/env-facts")).body; if (!s.running) break; await new Promise((ok) => setTimeout(ok, 100)); }
  assert.equal(s.error, "empty");
  assert.equal(s.pass, 2, "上一份结果还在");
});

test("工作岛：系统不许起服务 / 没装应用 → 状态带原因；重试会重新检测", async () => {
  const seam = W._islandForTest.seam, orig = { ...seam };
  const was = SETTINGS.workIsland;
  let n = 0, why = "blocked";
  seam.android = () => true;
  seam.detect = (cb) => { n++; cb(false, why, "Error: Can't start from invalid source"); };
  try {
    SETTINGS.workIsland = true;
    W.startWorkIsland();
    const s1 = (await call("/api/work-island")).body;
    assert.equal(s1.wanted, true);
    assert.equal(s1.started, false);
    assert.equal(s1.error.code, "blocked");
    assert.match(s1.error.detail, /invalid source/);
    why = "not_installed";
    const s2 = (await call("/api/work-island/retry", true)).body;
    assert.equal(n, 2, "重试重新检测了");
    assert.equal(s2.error.code, "not_installed");
  } finally { W.stopWorkIsland(); SETTINGS.workIsland = was; Object.assign(seam, orig); }
});

test("特权免确认的设置页与续期框使用 Android 宿主提供的固定时长", () => {
  const src = (f) => fs.readFileSync(new URL(f, import.meta.url), "utf8");
  assert.match(src("../gw/devside.mjs"), /Number\.isSafeInteger\(b\.minutes\)/);
  assert.match(src("../web/app/10-settings-device.js"), /st\.noaskDurations\.map/);
  const java = src("../../android/java/cc/codroid/Priv.java");
  assert.match(java, /NoAskDuration\.options\(\)/);
  assert.match(java, /NoAskDuration\.supports\(minutes\)/);
  assert.match(java, /NOASK_MAX = 7L \* 24 \* 3600 \* 1000/);
  const dialog = src("../../android/java/cc/codroid/MainActivity.java");
  assert.match(dialog, /NoAskDuration\.options\(\)/);
  assert.match(dialog, /labels\[0\] = Tr\.t\("关闭"\)/);
  assert.match(dialog, /duration\.setSelection\(0\)/);
  assert.match(dialog, /if \(position <= 0\) \{\s*allow\.run\(\);\s*d\.dismiss\(\);\s*return;\s*\}/);
  assert.match(dialog, /Priv\.renewAndAllow\(this, id, durations\[position - 1\]/);
  assert.match(src("../../android/java/cc/codroid/NoAskDuration.java"), /INCLUDE_TEST_DURATION = false/);
});

test("设置页显示实际授权时长，关闭时保留尚未生效的选择", () => {
  const source = fs.readFileSync(new URL("../web/app/10-settings-device.js", import.meta.url), "utf8");
  const start = source.indexOf('    const duration = $("priv-na-hours");');
  const end = source.indexOf("    // 免确认限时", start);
  const script = new vm.Script(source.slice(start, end));
  const options = [{ minutes: 2, label: "2 分钟" }, { minutes: 1440, label: "1 天" }, { minutes: 4320, label: "3 天" }];
  function render(current, status) {
    const select = {
      value: current, disabled: false,
      replaceChildren(...items) { this.items = items; },
      add(item) { this.items.push(item); },
    };
    script.runInNewContext({
      $: () => select,
      st: { state: "ok", noaskDurations: options, ...status },
      Option: class { constructor(label, value) { this.label = label; this.value = value; } },
      t: (label) => label,
    });
    return select;
  }
  const renewed = render("1440", { noask: true, noaskMinutes: 2 });
  assert.equal(renewed.value, "2");
  assert.equal(renewed.disabled, true);
  const off = render("4320", { noask: false });
  assert.equal(off.value, "4320");
  assert.equal(off.disabled, false);
  const legacy = render("1440", { noask: true });
  assert.equal(legacy.value, "");
  assert.equal(legacy.items.at(-1).label, "未知");
});
