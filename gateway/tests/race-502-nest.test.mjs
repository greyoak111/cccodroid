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
  // 多个回退请求同时到达时，不能都在 await idleRetired 期间通过「没人在回退」的检查
  const sessSrc = fs.readFileSync(path.join(root, "gateway", "gw", "sessions.mjs"), "utf8");
  const rewindAt = sessSrc.indexOf('action === "rewind"');
  const addAt = sessSrc.indexOf("REWIND_BUSY.add(id);", rewindAt);
  const idleAt = sessSrc.indexOf("await idleRetired(id)", rewindAt);
  assert.ok(rewindAt > 0 && addAt > rewindAt && idleAt > rewindAt && addAt < idleAt, "rewind 必须先同步占 REWIND_BUSY 再 await idleRetired");
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

test("fonts.mjs: 满额时先认重再判断数量，避免并发导入把已有字体的文件删掉", () => {
  const src = fs.readFileSync(path.join(root, "gateway", "gw", "fonts.mjs"), "utf8");
  const dupAt = src.indexOf("const dup = list.find((f) => f.sha === sha);");
  const limitAt = src.indexOf("if (list.length >= FONT_COUNT) { try { fs.unlinkSync(target);");
  assert.ok(dupAt > 0 && limitAt > 0, "找到字体去重与满额清理分支");
  assert.ok(dupAt < limitAt, "重复字体必须先返回 dup，不能落进满额时 unlink(target) 的分支");
});

test("A-P0-1..5 Android 宿主: ProofFlight 纪元/单飞、fetchStatic 限时限流、PAUSE_LOCK 引用计数与异步停网关", () => {
  const envSrc = fs.readFileSync(path.join(root, "android", "java", "cc", "codroid", "Env.java"), "utf8");
  const gwSrc = fs.readFileSync(path.join(root, "android", "java", "cc", "codroid", "GatewayService.java"), "utf8");
  const mainSrc = fs.readFileSync(path.join(root, "android", "java", "cc", "codroid", "MainActivity.java"), "utf8");
  assert.ok(envSrc.includes("class ProofFlight") && envSrc.includes("bootEpoch"), "Env.java 应使用 ProofFlight + bootEpoch 防跨代单飞污染");
  assert.ok(envSrc.includes("setConnectTimeout(1000)") && envSrc.includes("setReadTimeout(5000)"), "fetchStatic 应设短超时避免拖死 WebView 线程");
  assert.ok(gwSrc.includes("PAUSE_LOCK") && gwSrc.includes("pauseCount") && gwSrc.includes("killGatewayAsync"), "GatewayService 应采用 PAUSE_LOCK 引用计数与异步停网关");
  assert.ok(gwSrc.includes("shutdownIfIdle("), "watchFreeze 应快照 startSeq 并调用 shutdownIfIdle");
  assert.ok(/killGatewayAsync\(\(\) -> \{[\s\S]{0,400}?shouldFinishStop\(stopping, mySeq, startSeq\)/.test(gwSrc),
    "异步停机的收尾必须在杀完网关后复核 startSeq，用户重开界面时不能继续停");
  assert.ok(mainSrc.includes("DEVKIT_APPLYING") && mainSrc.includes("IK_LOCK"), "MainActivity 应具备 DEVKIT_APPLYING CAS 与 IK_LOCK");
  // pause 已改成引用计数：暂停窗口内想再踢一次网关，必须用不计数 pauseKick，
  // 否则「pause(true) 两次 + pause(false) 一次」会漏掉一次计数，放行后网关永远起不来
  const frSrc = fs.readFileSync(path.join(root, "android", "java", "cc", "codroid", "FactoryReset.java"), "utf8");
  assert.ok(gwSrc.includes("static void pauseKick()"), "GatewayService 应提供不改变引用计数的 pauseKick");
  assert.ok(mainSrc.includes("GatewayService.pauseKick();"), "deployAssets 的 finally 应用 pauseKick 补刀");
  assert.ok(frSrc.includes("GatewayService.pauseKick();"), "FactoryReset 的 finally 应用 pauseKick 补刀");
  // onBoot 异常隔离与主线程 Looper 投递：无 Looper 后台线程（ui-prove / WebView IO 线程）直接调 3 参 CookieManager.setCookie
  // 会抛 IllegalStateException；必须投递到主线程 Looper 调用且在 Env.invokeOnBoot 独立捕获，避免打翻 proveBootOnce 触发 61ms 死循环
  assert.ok(envSrc.includes("static void invokeOnBoot(") && /invokeOnBoot\([\s\S]{0,400}?catch \(Throwable /.test(envSrc),
    "Env.java 应通过 invokeOnBoot 独立隔离 onBoot 回调异常");
  assert.ok(envSrc.includes("fetchStatic 失败 ") && envSrc.includes("\" HTTP \" + code"),
    "Env.fetchStatic 应记录非 200 与异常日志而非静默吞错");
  assert.ok(/writeGatewayCookie\([\s\S]{0,1200}?main\.post\(\(\) -> \{[\s\S]{0,500}?cm\.setCookie\(mainUrl,\s*mainCookie,\s*ok -> latch\.countDown\(\)\)/.test(mainSrc),
    "MainActivity.writeGatewayCookie 必须在主线程 Looper 上调用带回调的 CookieManager.setCookie");
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

test("Shizuku & 静默自更新 502 防护：Priv 不用标准带参 waitFor/isAlive，Updater 前台静默装不提前杀网关，设置页遇 502 不藏卡片且自动重试自愈", async () => {
  const privSrc = fs.readFileSync(path.join(root, "android", "java", "cc", "codroid", "Priv.java"), "utf8");
  const updSrc = fs.readFileSync(path.join(root, "android", "java", "cc", "codroid", "Updater.java"), "utf8");
  assert.ok(!privSrc.includes(".waitFor(timeoutMs"), "Priv.java 严禁对 ShizukuRemoteProcess 调用未重写的 Process.waitFor(long, TimeUnit)");
  assert.ok(!privSrc.includes("p.isAlive()"), "Priv.java 严禁对 ShizukuRemoteProcess 调用未重写的 Process.isAlive()");
  assert.ok(privSrc.includes("waitProcess(p, timeoutMs)") && privSrc.includes("processAlive(p)"), "Priv.java 应统一通过 waitProcess / processAlive 处理远端进程");
  assert.ok(privSrc.includes("stageLog = \"/data/local/tmp/upd-\""), "Priv.pipeInstall 应使用每次调用独占的日志路径防跨应用与残留污染");
  assert.ok(!updSrc.includes("Priv.granted() && !gatewayBusy()"), "Updater.java 静默安装前必须以实测 Priv.verified() 为准");
  assert.ok(/boolean fg = MainActivity\.appForeground\(\);\s*if \(!fg\) GatewayService\.pause\(true\);/.test(updSrc),
    "Updater.installApp 在界面处于前台时不应提前 pause(true) 杀掉网关导致全界面连环 502");

  const devSetSrc = fs.readFileSync(path.join(root, "gateway", "web", "app", "10-settings-device.js"), "utf8");
  const nodes = new Map(), timers = [];
  const makeNode = (id) => {
    if (!nodes.has(id)) {
      const initHidden = ["priv-field", "ntf-field", "ntf-err-block", "dev-field", "dev-err-block"].includes(id);
      nodes.set(id, {
        id, innerHTML: "", textContent: "", className: "", value: "1440", checked: false, disabled: false,
        dataset: {}, style: {}, listeners: {}, children: [],
        classList: {
          _s: new Set(initHidden ? ["hidden"] : []),
          toggle(k, f) { if (f == null) this._s.has(k) ? this._s.delete(k) : this._s.add(k); else if (f) this._s.add(k); else this._s.delete(k); },
          contains(k) { return this._s.has(k); },
          add(k) { this._s.add(k); },
          remove(k) { this._s.delete(k); },
        },
        insertAdjacentHTML(pos, html) { this.innerHTML = pos === "afterbegin" ? html + this.innerHTML : this.innerHTML + html; },
        setAttribute() {},
        replaceChildren(... xs) { this.children = xs; },
        appendChild(x) { this.children.push(x); },
        querySelector() { return { textContent: "" }; },
        querySelectorAll() { return []; },
        addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
      });
    }
    return nodes.get(id);
  };
  let gwDown = true;
  const box = {
    window: { I18N: { lang: "zh" }, CCApp: {} }, I18N: { lang: "zh" },
    Option: class { constructor(t, v) { this.text = t; this.value = v; } },
    setVisit: 1, setCatOpen: "device", setOpen: true,
    setVisible: (cat, v = 1) => cat === "device" && v === 1,
    setDiscovery() {},
    selectionChangesFromUser: new WeakSet(),
    state: { settings: {} },
    $: makeNode,
    t: (s, p) => p ? s.replace(/\{(\w+)\}/g, (_, k) => p[k] ?? "") : s,
    tk: (s) => s,
    esc: (s) => String(s ?? ""),
    fmtSize: (n) => `${n}B`,
    fmtDur: (n) => `${n}ms`,
    toast() {},
    confirm: () => true,
    alert() {},
    viewRead: (_k, _r, _ok, fn) => fn(),
    localStorage: { getItem: () => null, setItem() {} },
    document: {
      hidden: false, activeElement: null,
      addEventListener() {},
      createElement: () => ({ className: "", style: {}, set innerHTML(_) {}, firstChild: { addEventListener() {} } }),
    },
    post: (url) => box.api(url),
    api: async (url) => {
      if (gwDown) throw new Error("HTTP 502");
      if (url === "/api/priv/status") return { state: "ok", uid: 2000, version: 13, paired: true, noaskDurations: [{ minutes: 60, label: "1h" }] };
      if (url === "/api/app/notify_status") return { ok: true, done: true, ask: true, system: true, chAsk: true, chDone: true };
      if (url === "/api/app/dev_status") return { ok: true, on: true, tools: [{ name: "notify", enabled: true }], a11y: { mode: "off" } };
      return { ok: true };
    },
    setTimeout: (fn, delay) => { timers.push({ fn, delay }); return timers.length; },
    clearTimeout() {},
  };
  vm.runInNewContext(
    devSetSrc + "\nglobalThis.__loadPriv = loadPriv;\nglobalThis.__loadNotify = loadNotify;\nglobalThis.__loadDev = loadDev;",
    box,
    { filename: "10-settings-device.js" },
  );

  await Promise.all([box.__loadPriv(), box.__loadNotify(), box.__loadDev()]);
  assert.equal(makeNode("priv-field").classList.contains("hidden"), false, "首读 502 时不应把 Shizuku 卡片留在 hidden");
  assert.match(makeNode("priv-state").textContent, /连不上应用的后台服务（HTTP 502）/);
  assert.match(makeNode("priv-actions").innerHTML, /data-act="refresh"/);
  assert.equal(timers.filter((x) => x.delay === 2000).length, 3, "Shizuku / 通知 / 设备工具 首读 502 均应安排 2s 自动重拉");

  // 网关恢复后触发已排程的 2s 重试：三张卡片全部自愈为正常状态
  gwDown = false;
  const due = timers.splice(0);
  for (const x of due) await x.fn();
  await new Promise((r) => setImmediate(r));
  assert.match(makeNode("priv-state").textContent, /已就绪 · 以 shell 身份执行/);
  assert.equal(makeNode("ntf-err-block").classList.contains("hidden"), true);
  assert.equal(makeNode("dev-err-block").classList.contains("hidden"), true);

  // 已画出正常状态后再遇瞬时 502：保留已渲染卡片不闪红，并安排 2s 重拉
  gwDown = true;
  timers.length = 0;
  await box.__loadPriv();
  assert.match(makeNode("priv-state").textContent, /已就绪 · 以 shell 身份执行/, "已显示的 Shizuku 卡片遇瞬时 502 应保持原状");
  assert.ok(timers.some((x) => x.delay === 2000), "瞬时 502 应在后台 2s 重拉");

  // ShizukuSetup 激活回前台用动态包名（兼容开发版 cc.codrdev），且无线 ADB 保活首轮延迟 15s 不抢占 reactivateAsync
  const shzSrc = fs.readFileSync(path.join(root, "android", "java", "cc", "codroid", "ShizukuSetup.java"), "utf8");
  assert.ok(!shzSrc.includes("-n cc.codroid/.MainActivity"), "ShizukuSetup 不应写死 cc.codroid 包名，以免开发版 cc.codrdev 切回错包");
  assert.ok(shzSrc.includes("ctx.getPackageName() + \"/\" + MainActivity.class.getName()"), "ShizukuSetup 应按当前应用包名切回前台");
  assert.ok(shzSrc.includes("scheduleWithFixedDelay(() -> keepaliveTick(worker), 15, 15, TimeUnit.SECONDS)"),
    "startKeepaliveWatch 首轮应延迟 15s，避免 0ms 抢占 busy 把开机/起服务的 reactivateAsync 顶掉");
});
