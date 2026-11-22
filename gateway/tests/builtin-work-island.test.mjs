// 内置工作岛（全厂商通用 Android 16+ Live Updates + 悬浮胶囊兜底 + 网关 SSE 推送）回归测试
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createWorkIsland } from "../gw/work-island-core.mjs";
import { publish, routeBus } from "../gw/bus.mjs";
import { SETTINGS } from "../gw/settings-store.mjs";
import * as WI from "../gw/work-island.mjs";

const root = process.cwd();

function makeSseRes() {
  const chunks = [];
  const res = {
    destroyed: false,
    writableLength: 0,
    writeHead() {},
    write(buf) { chunks.push(String(buf)); return true; },
    destroy() { this.destroyed = true; },
    chunks,
  };
  return res;
}

test("work-island-core: 跟踪 sessionId 与最新快照，且普通工具仍保持 extra=undefined", async () => {
  const sent = [];
  let runs = [{ id: "r1", sessionId: "sess-42", startedAt: 1000, ended: false }];
  const core = createWorkIsland({
    send: (action, title, text, since, state, extra, meta) => sent.push({ action, title, text, since, state, extra, meta }),
    runs: () => runs,
    lang: () => "zh",
    graceMs: 15,
    idleMs: 25,
    throttleMs: 0,
  });
  core.handleEvent({ type: "run_start", id: "r1", sessionId: "sess-42", startedAt: 1000 });
  assert.equal(core.snapshot().sessionId, "sess-42");
  assert.equal(sent.at(-1).meta.sessionId, "sess-42");

  core.handleEvent({ type: "tool_use", name: "Read" });
  assert.equal(sent.at(-1).extra, undefined, "普通工具不带清单 extra");
  assert.equal(core.snapshot().title, "读文件");
  assert.equal(core.snapshot().sessionId, "sess-42");

  runs = [];
  core.handleEvent({ type: "run_end", runId: "r1" });
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(core.snapshot().action, "DONE");
  assert.equal(core.snapshot().sessionId, "sess-42");
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(core.snapshot(), null, "IDLE 收起后快照归空");
});

test("work-island 内置模式：无需外部伴侣应用，仅向 ?notify=1 SSE 流推帧，不污染 WebView 客户端", async () => {
  const seam = WI._islandForTest.seam;
  const orig = { ...seam };
  const was = SETTINGS.workIsland;
  let amCalled = 0;
  seam.builtin = () => true;
  seam.android = () => false;
  seam.exec = () => { amCalled++; return null; };
  seam.execSync = () => { amCalled++; };

  const notifyReq = new EventEmitter(); notifyReq.method = "GET"; notifyReq.headers = {};
  const notifyRes = makeSseRes();
  const webReq = new EventEmitter(); webReq.method = "GET"; webReq.headers = {};
  const webRes = makeSseRes();

  try {
    SETTINGS.workIsland = true;
    WI.startWorkIsland();
    const st = WI.workIslandStatus();
    assert.equal(st.supported, true);
    assert.equal(st.builtin, true);
    assert.equal(st.started, true);
    assert.equal(st.error, null);

    await routeBus(notifyReq, notifyRes, new URL("http://x/api/events?notify=1"), "/api/events");
    await routeBus(webReq, webRes, new URL("http://x/api/events"), "/api/events");
    await new Promise((r) => setTimeout(r, 20));

    publish({ type: "run_start", id: "r-bi", sessionId: "s-bi", startedAt: Date.now() });
    await new Promise((r) => setTimeout(r, 20));

    const notifyOut = notifyRes.chunks.join("");
    const webOut = webRes.chunks.join("");
    assert.match(notifyOut, /"type":"work_island"/, "宿主通知 SSE 应收到 work_island 帧");
    assert.match(notifyOut, /"sessionId":"s-bi"/, "work_island 帧应携带 sessionId 以便点击直达会话");
    assert.ok(!webOut.includes('"type":"work_island"'), "普通 WebView SSE 不应收到 work_island 帧");
    assert.equal(amCalled, 0, "内置模式绝不应调外部 am start-foreground-service");

    // 重连的 notify 客户端应在 hello 快照中立即同步当前帧
    const reconReq = new EventEmitter(); reconReq.method = "GET"; reconReq.headers = {};
    const reconRes = makeSseRes();
    await routeBus(reconReq, reconRes, new URL("http://x/api/events?notify=1"), "/api/events");
    await new Promise((r) => setTimeout(r, 20));
    assert.match(reconRes.chunks.join(""), /"workIsland":\{/, "重连的 ?notify=1 应在 hello 中拿到当前工作岛快照");
    reconReq.emit("close");

    WI.stopWorkIsland();
    await new Promise((r) => setTimeout(r, 20));
    assert.match(notifyRes.chunks.join(""), /"action":"IDLE"/, "关闭开关时应向宿主发 IDLE 收起卡片");
  } finally {
    notifyReq.emit("close");
    webReq.emit("close");
    WI.stopWorkIsland();
    SETTINGS.workIsland = was;
    Object.assign(seam, orig);
  }
});

test("Android 宿主内置工作岛契约：标准 API 36+ Live Updates（不锁厂商）+ 悬浮胶囊触摸穿透 + 权限声明", () => {
  const manifest = fs.readFileSync(path.join(root, "android", "AndroidManifest.xml"), "utf8");
  const wiJava = fs.readFileSync(path.join(root, "android", "java", "cc", "codroid", "WorkIsland.java"), "utf8");
  const ovJava = fs.readFileSync(path.join(root, "android", "java", "cc", "codroid", "WorkIslandOverlay.java"), "utf8");
  const envJava = fs.readFileSync(path.join(root, "android", "java", "cc", "codroid", "Env.java"), "utf8");
  const devside = fs.readFileSync(path.join(root, "gateway", "gw", "devside.mjs"), "utf8");

  assert.ok(manifest.includes("android.permission.POST_PROMOTED_NOTIFICATIONS"), "Manifest 应声明 Android 16+ Live Updates 权限");
  assert.ok(manifest.includes("android.permission.SYSTEM_ALERT_WINDOW"), "Manifest 应声明可选悬浮胶囊权限");
  assert.ok(envJava.includes('"CCAPP_BUILTIN_ISLAND", "1"'), "Env.java 应告知网关启用内置工作岛");
  assert.ok(wiJava.includes("android.app.Notification$ProgressStyle"), "WorkIsland 应调用标准 ProgressStyle");
  assert.ok(wiJava.includes("setRequestPromotedOngoing") && wiJava.includes("setShortCriticalText"), "WorkIsland 应请求 Live Updates 推广并设置胶囊短文案");
  assert.ok(!/Xiaomi|miui\.focus|superx/i.test(wiJava), "内置工作岛不应硬编码厂商私有通道或锁死单一厂商");
  assert.ok(ovJava.includes("FLAG_NOT_TOUCHABLE") && ovJava.includes("getMaximumObscuringOpacityForTouch"), "悬浮胶囊必须完全触摸穿透并遵守 Android 12+ 遮挡透明度上限");
  for (const op of ["island_status", "island_set", "island_preview", "island_promo_settings", "island_overlay_settings"]) {
    assert.ok(devside.includes(`"${op}"`), `devside.mjs 应放行 ${op}`);
  }
});
