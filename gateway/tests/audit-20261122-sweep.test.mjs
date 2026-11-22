// 2026-11-22 全量联动审计回归测试：
// 覆盖 work-island-core 节流/并行切换、work-island blocked 停机不补发、run.mjs 空闲插话与连续孤儿通知、
// archiver.mjs 软链凭据排除、components/modules job.done 与 modTarList close、i18n 对齐。
process.env.CCAPP_IDLE_CLOSE_MS = "400";
import { CFG, PATHS } from "../gw/config.mjs";
import "./fixtures/uc-baseline.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createWorkIsland } from "../gw/work-island-core.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const AUDIT_PID = "custom-audit-20261122";
const AUDIT_PROV_FILE = path.join(CFG.home, "ccapp-providers.json");
const HAD_PROV = fs.existsSync(AUDIT_PROV_FILE) ? fs.readFileSync(AUDIT_PROV_FILE) : null;
fs.writeFileSync(AUDIT_PROV_FILE, JSON.stringify({
  active: AUDIT_PID,
  providers: {
    [AUDIT_PID]: { label: "Fixture", baseUrl: "https://fixture.example.invalid", apiKey: "fixture-only", authStyle: "bearer", defaultModel: "fixture-model", fallbackModels: [{ id: "fixture-model" }] },
  },
}));
fs.mkdirSync(path.join(CFG.home, ".claude", "projects"), { recursive: true });
after(() => {
  if (HAD_PROV == null) fs.rmSync(AUDIT_PROV_FILE, { force: true });
  else fs.writeFileSync(AUDIT_PROV_FILE, HAD_PROV);
});

test("work-island-core: 立即发送新帧前清除排队的旧节流帧，防止旧帧倒盖新帧", async () => {
  let now = 10000;
  const sent = [];
  const wi = createWorkIsland({
    send: (action, title, text, since, state) => sent.push({ action, title, text, since, state }),
    sendSync: () => {},
    runs: () => [],
    lang: () => "zh",
    throttleMs: 30,
    clock: () => now,
  });
  wi.handleEvent({ type: "run_start", runId: "r1", sessionId: "s1", startedAt: 10000 });
  assert.equal(sent.length, 1);

  // 节流窗口内进入旧帧 A（排定时器）
  now += 5;
  wi.handleEvent({ type: "phase", runId: "r1", phase: "think" });
  assert.equal(sent.length, 1);

  // 时钟跳到节流窗口外、定时器尚未触发前直接发新帧 B
  now += 50;
  wi.handleEvent({ type: "phase", runId: "r1", phase: "text" });
  assert.equal(sent.length, 2);
  assert.equal(sent[1].state, "writing");

  // 等原节流定时器时间过去，旧帧 A 不得再倒盖
  await new Promise((ok) => setTimeout(ok, 60));
  assert.equal(sent.length, 2);
  assert.equal(wi.snapshot().state, "writing");
  wi.stop(false, false);
});

test("work-island-core: 并行会话切换立即刷新 sessionId，并忽略非当前 runId 事件", () => {
  let now = 20000;
  const sent = [];
  const wi = createWorkIsland({
    send: (action, title, text, since, state, extra, meta) => sent.push({ action, title, text, since, state, sid: meta?.sessionId || "" }),
    sendSync: () => {},
    runs: () => [{ id: "r2", sessionId: "s2", startedAt: 21000 }],
    lang: () => "zh",
    throttleMs: 0,
    clock: () => now,
  });
  wi.handleEvent({ type: "run_start", runId: "r1", sessionId: "s1", startedAt: 20000 });
  assert.equal(sent.at(-1).sid, "s1");

  // 另一个并行 runId 的事件不应串写当前岛状态
  wi.handleEvent({ type: "error", runId: "r2" });
  assert.notEqual(sent.at(-1).state, "error");

  // state 快照把活跃轮次切换到 r2：立即更新 sessionId 与 startedAt
  wi.handleEvent({ type: "state", run: { id: "r2", sessionId: "s2", startedAt: 21000, perms: [] } });
  assert.equal(sent.at(-1).sid, "s2");
  assert.equal(sent.at(-1).since, 21000);
  wi.stop(false, false);
});

test("work-island: amFailed 判定系统禁止后停机，不再多发一条必败 IDLE am 进程", async () => {
  const { SETTINGS } = await import("../gw/settings-store.mjs");
  const { startWorkIsland, stopWorkIsland, _islandForTest } = await import("../gw/work-island.mjs");
  const prevOn = SETTINGS.workIsland;
  const prevSeam = { ..._islandForTest.seam };
  const calls = [];
  try {
    SETTINGS.workIsland = true;
    _islandForTest.seam.builtin = () => false;
    _islandForTest.seam.android = () => true;
    _islandForTest.seam.detect = (cb) => cb(true);
    _islandForTest.seam.exec = (args, _t, cb) => {
      calls.push(args);
      const fake = { kill() {} };
      setImmediate(() => cb(new Error("Permission Denial: start-foreground-service"), "", "SecurityException: Permission Denial"));
      return fake;
    };
    startWorkIsland();
    _islandForTest.send("UPDATE", "t", "x", 1, "working");
    await new Promise((ok) => setTimeout(ok, 40));
    // 启动清理的 IDLE 或首个 UPDATE 触发 Permission Denial 后，amFailed 清理 core 不应再追加第二条 IDLE
    assert.equal(calls.length, 1, `blocked 停机不应再派发多余 am 调用，实际=${calls.length}`);
    assert.equal(_islandForTest.state().started, false);
  } finally {
    stopWorkIsland(false);
    Object.assign(_islandForTest.seam, prevSeam);
    SETTINGS.workIsland = prevOn;
  }
});

test("run.mjs: 非斜杠插话进 idle 轮次立即切回忙态，且连续两条孤儿 task-notification 不提前关 stdin", async () => {
  const runSrc = fs.readFileSync(path.join(ROOT, "gateway/gw/run.mjs"), "utf8");
  assert.match(runSrc, /!run\.pendingInject\.length && !run\.slashFlight\.length/, "armIdleClose 必须避让待送达插话与斜杠命令");

  const binDir = fs.mkdtempSync(path.join(CFG.home, "fake-claude-audit-"));
  const fakeCli = path.join(binDir, "fake-claude.mjs");
  const modeFile = path.join(binDir, "mode");
  const okFile = path.join(binDir, "ok");
  fs.writeFileSync(fakeCli, `#!${process.execPath}
import readline from "node:readline";
import fs from "node:fs";
const mode = fs.readFileSync(${JSON.stringify(modeFile)}, "utf8").trim();
const okFile = ${JSON.stringify(okFile)};
const rl = readline.createInterface({ input: process.stdin });
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let stdinEnded = false;
process.stdin.on("end", () => { stdinEnded = true; });

if (mode === "multi-orphan") {
  rl.once("line", (line) => {
    const msg = JSON.parse(line);
    out({ type: "system", subtype: "init", session_id: "sid-multi-orphan", model: "fixture-model" });
    // 连续两条孤儿通知，第一条带 assistant 输出，第二条紧跟其后，都在首条用户消息回显之前
    out({ type: "system", subtype: "task_notification", task_id: "t1", status: "stopped" });
    out({ type: "assistant", message: { content: [{ type: "text", text: "orphan-1" }] } });
    out({ type: "system", subtype: "task_notification", task_id: "t2", status: "stopped" });
    out({ type: "result", uuid: "res-o1", num_turns: 1, result: "orphan-1" });
    setTimeout(() => {
      out({ type: "result", uuid: "res-o2", num_turns: 1, result: "orphan-2" });
      setTimeout(() => {
        if (stdinEnded) { out({ type: "result", uuid: "res-fail", is_error: true, result: "STDIN_CLOSED_EARLY" }); process.exit(1); }
        fs.writeFileSync(okFile, "real-ok");
        out({ type: "user", isReplay: true, message: { role: "user", content: msg.message.content } });
        out({ type: "assistant", message: { content: [{ type: "text", text: "real-ok" }] } });
        out({ type: "result", uuid: "res-real", num_turns: 1, result: "real-ok" });
      }, 25);
    }, 25);
  });
} else if (mode === "idle-inject") {
  let n = 0;
  rl.on("line", (line) => {
    const msg = JSON.parse(line);
    if (msg.type === "control_request" && msg.request?.subtype === "stop_task") {
      out({ type: "system", subtype: "background_tasks_changed", tasks: [] });
      return;
    }
    n++;
    if (n === 1) {
      out({ type: "system", subtype: "init", session_id: "sid-idle-inj", model: "fixture-model" });
      out({ type: "user", isReplay: true, message: { role: "user", content: msg.message.content } });
      out({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "bg1", task_type: "local_bash", description: "srv" }] });
      out({ type: "result", uuid: "res-1", num_turns: 1, result: "first" });
    } else if (n === 2) {
      // 在发出 replay/assistant 前后台任务归零触发 armIdleClose
      out({ type: "system", subtype: "background_tasks_changed", tasks: [] });
      setTimeout(() => {
        if (stdinEnded) { out({ type: "result", uuid: "res-fail", is_error: true, result: "STDIN_CLOSED_ON_INJECT" }); process.exit(1); }
        fs.writeFileSync(okFile, "second-ok");
        out({ type: "user", isReplay: true, message: { role: "user", content: msg.message.content } });
        out({ type: "assistant", message: { content: [{ type: "text", text: "second-ok" }] } });
        out({ type: "result", uuid: "res-2", num_turns: 1, result: "second-ok" });
      }, 40);
    }
  });
}
`, { mode: 0o755 });

  const oldClaude = PATHS.claude;
  const oldLoader = PATHS.claudeLoader;
  const oldLib = PATHS.claudeLib;
  const oldFetch = globalThis.fetch;
  PATHS.claude = fakeCli;
  PATHS.claudeLoader = fakeCli;
  PATHS.claudeLib = binDir;
  globalThis.fetch = async () => { throw new Error("fixture must not fetch"); };
  try {
    const { startRun } = await import("../gw/run.mjs");
    const { RUNS } = await import("../gw/runs.mjs");
    const { onPublish } = await import("../gw/bus.mjs");

    // 1. 连续两条孤儿通知
    fs.writeFileSync(modeFile, "multi-orphan");
    fs.rmSync(okFile, { force: true });
    let err1 = null;
    const done1 = await new Promise((resolve, reject) => {
      const off = onPublish((ev) => {
        if (ev.runId !== "audit-o1") return;
        if (ev.type === "error") err1 = ev;
        if (ev.type === "run_end") { off(); resolve(ev); }
      });
      startRun({ id: "audit-o1", message: "hello", sessionId: "sid-multi-orphan", perm: "default", provider: AUDIT_PID, cwd: CFG.workspace }).catch((e) => { off(); reject(e); });
    });
    assert.equal(!!done1.failed, false, JSON.stringify({ done1, err1 }));
    assert.equal(!!done1.isError, false, JSON.stringify({ done1, err1 }));
    assert.equal(fs.existsSync(okFile) ? fs.readFileSync(okFile, "utf8") : "", "real-ok");

    // 2. 空闲轮次注入非斜杠插话立刻切回忙态
    fs.writeFileSync(modeFile, "idle-inject");
    fs.rmSync(okFile, { force: true });
    let sawBusy = false, injected = false, err2 = null;
    const done2 = await new Promise((resolve, reject) => {
      const off = onPublish((ev) => {
        if (ev.runId !== "audit-i1") return;
        try {
          if (ev.type === "error") err2 = ev;
          if (ev.type === "run_idle" && !injected) {
            const r = RUNS.get("audit-i1");
            assert.ok(r, "RUNS 中应存在 audit-i1");
            injected = true;
            assert.equal(r.idle, true);
            const ok = r.inject({ id: "inj-2", message: "follow-up", cid: "c2" });
            assert.equal(ok, true);
            assert.equal(r.idle, false, "空闲轮次注入非斜杠消息后应立刻退出 idle");
          }
          if (ev.type === "run_busy") sawBusy = true;
          if (ev.type === "run_end") { off(); resolve(ev); }
        } catch (e) { off(); reject(e); }
      });
      startRun({ id: "audit-i1", message: "first", perm: "default", provider: AUDIT_PID, cwd: CFG.workspace }).catch((e) => { off(); reject(e); });
    });
    assert.equal(sawBusy, true);
    assert.equal(!!done2.failed, false, JSON.stringify({ done2, err2 }));
    assert.equal(!!done2.isError, false, JSON.stringify({ done2, err2 }));
    assert.equal(fs.existsSync(okFile) ? fs.readFileSync(okFile, "utf8") : "", "second-ok");
  } finally {
    globalThis.fetch = oldFetch;
    PATHS.claude = oldClaude;
    PATHS.claudeLoader = oldLoader;
    PATHS.claudeLib = oldLib;
    fs.rmSync(binDir, { recursive: true, force: true });
  }
});

test("components.mjs & modules.mjs: job.done 不与 Promise 混用、modTarList 监听 close、卸载任务带 current 且不可取消", () => {
  const compSrc = fs.readFileSync(path.join(ROOT, "gateway/gw/components.mjs"), "utf8");
  const modSrc = fs.readFileSync(path.join(ROOT, "gateway/gw/modules.mjs"), "utf8");
  assert.equal(compSrc.includes("job.done = compRunInstall("), false, "components.mjs 不能用 Promise 覆盖数值字段 job.done");
  assert.equal(compSrc.includes("job.promise = compRunInstall("), true);
  assert.equal(compSrc.includes("x.job.promise.then("), true);
  assert.equal(modSrc.includes("job.done = (async"), false, "modules.mjs 不能用 Promise 覆盖数值字段 job.done");
  assert.equal(modSrc.includes("job.promise = (async"), true);
  assert.equal(modSrc.includes("job.promise.then("), true);
  const tarFn = modSrc.slice(modSrc.indexOf("function modTarList"), modSrc.indexOf("async function touchGuileGo"));
  assert.equal(tarFn.includes('child.on("close"'), true, "modTarList 必须监听 close");
  assert.equal(tarFn.includes('child.on("exit"'), false, "modTarList 不能监听 exit");
  assert.equal(modSrc.includes('phase: "removing", current: id'), true);
  assert.equal(modSrc.includes('job.phase === "installing" || job.phase === "removing"'), true);
});

test("archiver.mjs: collectSecretExcludes 排查逃逸/指向私有凭据的软链", () => {
  const arcSrc = fs.readFileSync(path.join(ROOT, "gateway/gw/archiver.mjs"), "utf8");
  const fn = arcSrc.slice(arcSrc.indexOf("async function collectSecretExcludes"), arcSrc.indexOf("export function startCreate"));
  assert.equal(fn.includes("pathBlocked(target)"), true);
  assert.equal(fn.includes("outside || pathBlocked(target)"), true);
});

test("i18n 对齐：i18n/lang-*.txt 与 gateway/web/lang-en.js 键数一致，java-*.json 覆盖全部 Tr.t/Tr.f", () => {
  const enJs = fs.readFileSync(path.join(ROOT, "gateway/web/lang-en.js"), "utf8");
  const enKeys = [...enJs.matchAll(/^  "((?:[^"\\]|\\.)*)":/gm)].length;
  for (const lang of ["ar", "es", "fr", "id", "ja", "ko", "ru", "zh-Hant"]) {
    const lines = fs.readFileSync(path.join(ROOT, `i18n/lang-${lang}.txt`), "utf8")
      .split("\n").filter((l) => l.trim() && !l.startsWith("//"));
    assert.equal(lines.length, enKeys, `i18n/lang-${lang}.txt 行数(${lines.length}) 必须与 lang-en.js(${enKeys}) 一致`);
  }
  const javaEn = JSON.parse(fs.readFileSync(path.join(ROOT, "android/assets/i18n/java-en.json"), "utf8"));
  const javaDir = path.join(ROOT, "android/java/cc/codroid");
  for (const f of fs.readdirSync(javaDir).filter((x) => x.endsWith(".java"))) {
    const src = fs.readFileSync(path.join(javaDir, f), "utf8");
    for (const m of src.matchAll(/\bTr\.[tf]\(\s*"((?:[^"\\]|\\.)*)"/g)) {
      const k = JSON.parse('"' + m[1] + '"');
      assert.ok(k in javaEn, `${f} 中的 Tr.t/Tr.f 键未收录进 java-en.json: ${k}`);
    }
  }
});
