// 全仓「并发下载 502 / 事件循环阻塞 / 宿主拦截竞态 / 前端轮询致死 + 新工具包下中转桥生命周期」回归测试
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import vm from "node:vm";
import { CFG, PREFIX } from "../gw/config.mjs";

const root = process.cwd();

test("G-P0-6 usage.mjs: 导入 execFile 不再在 ccMem / 内存查询路径抛出 ReferenceError", async () => {
  const src = fs.readFileSync(path.join(root, "gateway", "gw", "usage.mjs"), "utf8");
  assert.match(src, /import\s*\{[^}]*\bexecFile\b[^}]*\}\s*from\s*"node:child_process"/, "usage.mjs 必须导入 execFile");
  const mod = await import("../gw/usage.mjs");
  assert.equal(typeof mod.routeUsage, "function");
});

test("G-P0-1/G-P1-1 components.mjs: recMap 缓存命中与失效、compStart 先占位再删旧暂存", () => {
  const src = fs.readFileSync(path.join(root, "gateway", "gw", "components.mjs"), "utf8");
  assert.ok(src.includes("COMP_REC_CACHE"), "compRecordInfo 应按 stat 键缓存大记录解析结果");
  assert.ok(src.includes("const recMap = new Map()"), "compList 应单趟构建 recMap 传给 compUsers 避免 O(K^2) 读盘");
  assert.ok(!/compList\([^)]*\)\s*\{[\s\S]{0,600}compHealSkills\(/.test(src), "热路径 GET compList 不应同步执行 compHealSkills()");
  const m = /async function compStart\([\s\S]{0,4000}/.exec(src);
  assert.ok(m, "找到 compStart");
  const idxSet = m[0].indexOf("COMP_JOBS.set(");
  const idxRm = m[0].indexOf("rmTreeBatched(");
  assert.ok(idxSet > 0 && idxRm > 0 && idxSet < idxRm, "compStart 必须在 await rmTreeBatched 之前先在 COMP_JOBS 占位");
});

test("G-P0-2 modules.mjs: modStart 与 modRemove 通过 modStarting 锁防并发删装踩踏", () => {
  const src = fs.readFileSync(path.join(root, "gateway", "gw", "modules.mjs"), "utf8");
  assert.ok(src.includes("modStarting"), "modules.mjs 应使用 modStarting 锁覆盖异步 rmTreeBatched 窗口");
});

test("G-P0-3/G-P1-4 archiver.mjs: extractOne 流背压 + previewEntry single-flight + 异步清理", () => {
  const src = fs.readFileSync(path.join(root, "gateway", "gw", "archiver.mjs"), "utf8");
  assert.ok(src.includes("PREV_INFLIGHT"), "previewEntry 应具备 single-flight 去重");
  assert.ok(src.includes('ws.once("drain"') || src.includes("ws.once('drain'"), "extractOne 应处理 ws.write 背压暂停/恢复");
  assert.ok(src.includes("async function sanitizeTree") && src.includes("async function collectSecretExcludes"), "大目录遍历应异步分片让出事件循环");
});

test("G-P0-4 storage.mjs: rmCheckedAsync 异步安全删除目录树且保留同步 rmChecked 导出", async () => {
  const mod = await import("../gw/storage.mjs");
  assert.equal(typeof mod.rmChecked, "function");
  assert.equal(typeof mod.rmCheckedAsync, "function");
  const base = path.join(CFG.workspace, "st-async-" + Date.now());
  const sub = path.join(base, "nested");
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, "a.txt"), "hello");
  const r = await mod.rmCheckedAsync(base, [CFG.workspace]);
  assert.equal(r.ok, true);
  assert.equal(fs.existsSync(base), false);
});

test("G-P1-5 integrity.mjs: 异步 anchor/seal/check 与同步语义一致", async () => {
  const integ = await import("../gw/integrity.mjs");
  const dir = path.join(CFG.workspace, "integ-async-" + Date.now());
  const file = path.join(dir, "s.jsonl");
  fs.mkdirSync(dir, { recursive: true });
  const sid = crypto.randomUUID();
  fs.writeFileSync(file, JSON.stringify({ type: "user", uuid: "u1", sessionId: sid, message: { role: "user", content: "hi" } }) + "\n");
  try {
    const syncA = integ.sessionAnchor(file);
    const asyncA = await integ.sessionAnchorAsync(file);
    assert.deepEqual(asyncA, syncA);
    await integ.sealSessionAsync(sid, file);
    const chk = await integ.checkSessionAsync(sid, file);
    assert.deepEqual(chk, integ.checkSession(sid, file));
    assert.equal(chk, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("G-P1-7 sessions.mjs & run.mjs: 导出 isSessionRewinding 且 run.mjs 启动前检查回退锁", async () => {
  const sess = await import("../gw/sessions.mjs");
  assert.equal(typeof sess.isSessionRewinding, "function");
  assert.equal(sess.isSessionRewinding("nonexistent-session"), false);
  const runSrc = fs.readFileSync(path.join(root, "gateway", "gw", "run.mjs"), "utf8");
  assert.ok(runSrc.includes("isSessionRewinding("), "run.mjs 应阻止对正在回退的会话发起新运行");
});

test("openai-bridge 新工具包生命周期：卸载时入口缺失不误删合法注册；重装后自动清除 component removed 故障锁", async () => {
  const mb = await import("../gw/managed-bridge.mjs");
  const srvDir = path.join(CFG.home, ".cccodroid", "services");
  const regFile = path.join(srvDir, "openai-bridge.json");
  const rtDir = path.join(CFG.home, ".local", "share", "ccr-bridge-kit-test-" + Date.now());
  const stateDir = path.join(rtDir, "runtime-home", ".claude-code-router");
  const compDir = path.join(path.dirname(PREFIX), "components");
  const compRec = path.join(compDir, "openai-bridge.json");
  const compEntry = path.join(PREFIX, "lib", "openai-bridge", "component.cjs");
  const prevReg = fs.existsSync(regFile) ? fs.readFileSync(regFile) : null;
  const prevRec = fs.existsSync(compRec) ? fs.readFileSync(compRec) : null;
  const prevEntry = fs.existsSync(compEntry) ? fs.readFileSync(compEntry) : null;
  try {
    fs.mkdirSync(srvDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(compDir, { recursive: true });
    const regObj = {
      schema: 1,
      id: "openai-bridge",
      endpoint: "http://127.0.0.1:34599",
      runtimeDir: rtDir,
      instanceId: "0123456789abcdef0123456789abcdef",
    };
    fs.writeFileSync(regFile, JSON.stringify(regObj));
    // 场景 1：升级新工具包换掉 PREFIX，component.cjs 已不在但 runtimeDir 与合法注册仍在 → retire 保留注册，避免重装后永久 RUNTIME_CONFLICT
    fs.rmSync(compEntry, { force: true });
    const retired = await mb.retireManagedBridge("openai-bridge");
    assert.equal(retired, false);
    assert.equal(fs.existsSync(regFile), true, "入口因工具包切换缺失时不应误删仍与运行目录配对的合法注册");

    // 场景 2：重装组件后，清掉 watchdog 写下的 component removed or disabled 故障锁，但不碰其它故障锁
    fs.mkdirSync(path.dirname(compEntry), { recursive: true });
    fs.writeFileSync(compEntry, "module.exports = {};\n");
    fs.writeFileSync(compRec, JSON.stringify({ id: "openai-bridge", state: "ok", files: ["lib/openai-bridge/component.cjs"] }));
    const lockFile = path.join(stateDir, "recovery.failed");
    const attFile = path.join(stateDir, "recovery.attempts");
    fs.writeFileSync(lockFile, "recovery limit reached\n");
    assert.equal(mb.clearComponentRemovedRecoveryLock(), false, "真实崩溃故障锁不应被自动清除");
    assert.equal(fs.existsSync(lockFile), true);

    fs.writeFileSync(lockFile, "component removed or disabled\n");
    fs.writeFileSync(attFile, "1\n");
    assert.equal(mb.clearComponentRemovedRecoveryLock(), true, "应清除工具包切换遗留的 component removed or disabled 故障锁");
    assert.equal(fs.existsSync(lockFile), false);
    assert.equal(fs.existsSync(attFile), false);
    assert.ok(fs.readdirSync(stateDir).some((n) => n.startsWith("recovery.failed.prev-")), "清除时应留 .prev 证据");
  } finally {
    fs.rmSync(rtDir, { recursive: true, force: true });
    if (prevReg == null) fs.rmSync(regFile, { force: true }); else fs.writeFileSync(regFile, prevReg);
    if (prevRec == null) fs.rmSync(compRec, { force: true }); else fs.writeFileSync(compRec, prevRec);
    if (prevEntry == null) fs.rmSync(compEntry, { force: true }); else fs.writeFileSync(compEntry, prevEntry);
  }
});

test("A-P0-1..5 Android 宿主: ProofFlight 纪元/单飞、fetchStatic 限时限流、PAUSE_LOCK 引用计数与异步停网关", () => {
  const envSrc = fs.readFileSync(path.join(root, "android", "java", "cc", "codroid", "Env.java"), "utf8");
  const gwSrc = fs.readFileSync(path.join(root, "android", "java", "cc", "codroid", "GatewayService.java"), "utf8");
  const mainSrc = fs.readFileSync(path.join(root, "android", "java", "cc", "codroid", "MainActivity.java"), "utf8");
  assert.ok(envSrc.includes("class ProofFlight") && envSrc.includes("bootEpoch"), "Env.java 应使用 ProofFlight + bootEpoch 防跨代单飞污染");
  assert.ok(envSrc.includes("setConnectTimeout(1000)") && envSrc.includes("setReadTimeout(5000)"), "fetchStatic 应设短超时避免拖死 WebView 线程");
  assert.ok(gwSrc.includes("PAUSE_LOCK") && gwSrc.includes("pauseCount") && gwSrc.includes("killGatewayAsync"), "GatewayService 应采用 PAUSE_LOCK 引用计数与异步停网关");
  assert.ok(gwSrc.includes("shutdownIfIdle("), "watchFreeze 应快照 startSeq 并调用 shutdownIfIdle");
  assert.ok(mainSrc.includes("DEVKIT_APPLYING") && mainSrc.includes("IK_LOCK"), "MainActivity 应具备 DEVKIT_APPLYING CAS 与 IK_LOCK");
});

test("W-P0-1/W-P0-3/W-P1-1 08-extensions.js: 模块/组件瞬时 502 不清屏且持续重试，loadComponents(true) 遇 502 仍续轮询", async () => {
  const src = fs.readFileSync(path.join(root, "gateway", "web", "app", "08-extensions.js"), "utf8");
  const nodes = new Map(), timers = [];
  const makeNode = (id) => {
    if (!nodes.has(id)) nodes.set(id, {
      id, innerHTML: "", textContent: "", dataset: {}, disabled: false, listeners: {},
      classList: {
        _s: new Set(),
        toggle(k, f) { if (f == null) this._s.has(k) ? this._s.delete(k) : this._s.add(k); else if (f) this._s.add(k); else this._s.delete(k); },
        contains(k) { return this._s.has(k); },
        add(k) { this._s.add(k); },
        remove(k) { this._s.delete(k); },
      },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    });
    return nodes.get(id);
  };
  let modFail = false, compFail = false;
  const box = {
    window: { I18N: { lang: "zh" } }, I18N: { lang: "zh" },
    pageVisit: 1, pageVisible: () => true,
    $: (id) => (["llm-dl", "ext-storage"].includes(id) ? null : makeNode(id)),
    t: (s) => s, tk: (s) => s, esc: (s) => String(s ?? ""), isZh: () => true,
    document: { querySelectorAll: () => [] }, localStorage: { getItem: () => null },
    pageOn: () => true, setPageSub() {}, webUrl: () => false, fmtSize: (n) => `${n}B`,
    extOffNow: async () => ({ comp: [], mod: [] }),
    sameGet: (url) => box.api(url),
    api: async (url) => {
      if (url === "/api/devkit/modules") {
        if (modFail) throw new Error("HTTP 502");
        return {
          supported: true, modular: true,
          items: [{ id: "py", name: { zh: "Python" }, desc: "", state: "downloading", download: 1000, installed: 2000, progress: { phase: "downloading", done: 100, total: 1000 } }],
        };
      }
      if (url.startsWith("/api/components")) {
        if (compFail) throw new Error("HTTP 502");
        return {
          supported: true,
          items: [{ id: "c1", name: { zh: "C1" }, desc: "", state: "downloading", available: true, verified: true, bytes: 1000, installed: 2000, bin: [], progress: { phase: "downloading", done: 100, total: 1000 } }],
        };
      }
      return { ok: true };
    },
    setTimeout: (fn, delay) => { timers.push({ fn, delay }); return timers.length; },
    clearTimeout() {},
  };
  vm.runInNewContext(src + "\nglobalThis.__loadModules = loadModules;\nglobalThis.__loadComponents = loadComponents;", box, { filename: "08-extensions.js" });

  await box.__loadModules();
  const modHtml = makeNode("mod-list").innerHTML;
  assert.match(modHtml, /Python/);
  timers.length = 0;
  modFail = true;
  await box.__loadModules();
  assert.equal(makeNode("mod-list").innerHTML, modHtml, "loadModules 瞬时 502 不应清空已渲染模块卡片");
  assert.ok(timers.some((x) => x.delay === 1500), "loadModules 运行中遇瞬时 502 应自动排程 1.5s 重试");

  await box.__loadComponents();
  timers.length = 0;
  compFail = true;
  await box.__loadComponents(true);
  assert.ok(timers.some((x) => x.delay === 1500), "loadComponents(true) 在下载中遇瞬时 502 不应断掉轮询链");
});

test("W-P0-4/W-P0-5 06-files.js & 18-terminal.js: 压缩任务重试瞬时错误，终端 SSE CLOSED 先探测存活", () => {
  const filesSrc = fs.readFileSync(path.join(root, "gateway", "web", "app", "06-files.js"), "utf8");
  const termSrc = fs.readFileSync(path.join(root, "gateway", "web", "app", "18-terminal.js"), "utf8");
  assert.ok(filesSrc.includes("++pollFails > 6"), "arcRunJob 应容忍瞬时网络/502 错并退避重试");
  assert.ok(filesSrc.includes("fsDeleting"), "fsDelete 应防止并发双击删除");
  assert.ok(termSrc.includes("/api/term/list") && termSrc.includes("EventSource.CLOSED"), "termAttach 在 EventSource.CLOSED 时应探测 /api/term/list 确认存活而非立即标死");
});
