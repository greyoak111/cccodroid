// 权限确认与后台空闲态竞态 + 前端漏收自愈回归测试：
//   1. control_request 撤掉 idleClose、主会话空闲态切回 busy、stdin 已关不建幽灵卡；
//   2. 多个后台任务中只停了一个、最后一个自行结束时不误用 6 秒短超时掐断 stdin；
//   3. 前端漏收 perm_request 时由 applyState / endReplay 按 srv.run.perms 补画，pendingPerms 认 srv.run.id，
//      同时保留 FIND-042（已收尾空壳不补画）与已答防复活。
import { PATHS } from "../gw/config.mjs";
import "./fixtures/uc-baseline.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import vm from "node:vm";

process.env.CCAPP_IDLE_CLOSE_MS = "800";
process.env.ANTHROPIC_API_KEY = "fixture-only-do-not-forward";
process.env.ANTHROPIC_AUTH_TOKEN = "fixture-only-do-not-forward";

const home = process.env.CCAPP_HOME;
const root = fs.mkdtempSync(path.join(process.env.CCAPP_WORKSPACE, "perm-sync-"));
const providerFile = path.join(home, "ccapp-providers.json");
const PID = "custom-permsync";
const hadProviders = fs.existsSync(providerFile) ? fs.readFileSync(providerFile) : null;
fs.writeFileSync(providerFile, JSON.stringify({
  active: PID,
  providers: {
    [PID]: { label: "Fixture", baseUrl: "https://fixture.example.invalid", apiKey: "fixture-only", authStyle: "bearer", defaultModel: "fixture-model", fallbackModels: [{ id: "fixture-model" }] },
  },
}));
fs.mkdirSync(path.join(home, ".claude", "projects"), { recursive: true });

const cli = path.join(root, "fake-cli.sh");
const sh = fs.existsSync("/system/bin/sh") ? "/system/bin/sh" : "/bin/sh";
const SLEEP = ["/system/bin/sleep", "/bin/sleep", "/usr/bin/sleep"].find((p) => fs.existsSync(p));
if (!SLEEP) throw new Error("找不到 sleep");
function script(steps, code = 0) {
  const body = steps.map((s) => (s.sleep ? `${SLEEP} ${s.sleep}` : `printf '%s\\n' ${JSON.stringify(JSON.stringify(s)).replace(/\$/g, "\\$")}`)).join("\n");
  fs.writeFileSync(cli, `#!${sh}\n${body}\nexit ${code}\n`, { mode: 0o700 });
}

const previousPaths = { claude: PATHS.claude, loader: PATHS.loader, claudeLoader: PATHS.claudeLoader };
PATHS.claude = process.execPath;
PATHS.loader = PATHS.claudeLoader = cli;

const { startRun } = await import("../gw/run.mjs");
const { abortRun, QUEUE } = await import("../gw/queue.mjs");
const { RUNS } = await import("../gw/runs.mjs");
const { onPublish } = await import("../gw/bus.mjs");
const { SETTINGS } = await import("../gw/settings-store.mjs");

const events = [];
const off = onPublish((ev) => events.push(ev));
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("fixture must not send a request"); };

after(() => {
  off();
  for (const r of RUNS.values()) abortRun(r);
  QUEUE.length = 0;
  globalThis.fetch = originalFetch;
  Object.assign(PATHS, previousPaths);
  if (hadProviders) fs.writeFileSync(providerFile, hadProviders); else fs.rmSync(providerFile, { force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

const endOf = (id) => events.find((e) => e.type === "run_end" && e.runId === id);
async function until(f, ms = 15000) {
  const t = Date.now();
  while (!f()) {
    if (Date.now() - t > ms) throw new Error("等不到");
    await new Promise((r) => setTimeout(r, 30));
  }
}

const init = (s) => ({ type: "system", subtype: "init", session_id: s, model: "fixture-model", tools: [], permissionMode: "default" });
const bg = (ids) => ({ type: "system", subtype: "background_tasks_changed", tasks: ids.map((id) => ({ task_id: id, task_type: "local_bash", description: id })) });
const result = () => ({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "done", usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0 });
const askReq = (id, extra = {}) => ({
  type: "control_request",
  request_id: id,
  request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: { questions: [{ question: "继续？", options: [{ label: "是" }] }] }, tool_use_id: "tu-" + id, ...extra },
});

test("空闲收尾倒计时期间收到主会话 control_request：撤掉 idleClose、切回 busy、stdin 保持打开", async () => {
  SETTINGS.permissionMode = "default";
  const s = crypto.randomUUID();
  script([init(s), bg(["t0"]), result(), bg([]), { sleep: 0.3 }, askReq("req-idle-1"), { sleep: 30 }]);
  await startRun({ id: "r-idle-ctl", message: "fixture", cwd: root, permissionMode: "default" });
  const run = RUNS.get("r-idle-ctl");
  await until(() => events.some((e) => e.type === "perm_request" && e.id === "req-idle-1"));
  assert.equal(run.idle, false, "主会话控制请求应切回忙碌");
  assert.equal(run.idleClose, null, "idleClose 必须被清除");
  assert.ok(events.some((e) => e.runId === "r-idle-ctl" && e.type === "run_busy"), "应广播 run_busy");
  // 等超过 IDLE_CLOSE_MS（800ms），stdin 仍保持打开，用户能正常回答
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(run.inputOpen, true);
  assert.equal(run.answerPerm("req-idle-1", { behavior: "allow", answers: { "继续？": "是" } }), true);
  abortRun(run);
  await until(() => endOf("r-idle-ctl"));
});

test("子代理在空闲收尾窗口发出 control_request：等待时不关 stdin，答完后恢复倒计时收尾", async () => {
  SETTINGS.permissionMode = "default";
  const s = crypto.randomUUID();
  script([init(s), bg(["t0"]), result(), bg([]), { sleep: 0.3 }, askReq("req-sub-1", { agent_id: "ag-1" }), { sleep: 30 }]);
  await startRun({ id: "r-sub-ctl", message: "fixture", cwd: root, permissionMode: "default" });
  const run = RUNS.get("r-sub-ctl");
  await until(() => events.some((e) => e.type === "perm_request" && e.id === "req-sub-1"));
  assert.equal(run.idle, true, "后台子代理不强行把主会话切回忙碌");
  assert.equal(run.idleClose, null, "等待确认期间不该留着 idleClose");
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(run.inputOpen, true, "等待确认超过 IDLE_CLOSE_MS 时 stdin 保持打开");
  assert.equal(run.answerPerm("req-sub-1", { behavior: "deny" }), true);
  // 答完后仍处于 idle 且无后台任务，idleClose 重新挂上并最终关闭 stdin
  await until(() => !run.inputOpen, 5000);
  abortRun(run);
  await until(() => endOf("r-sub-ctl"));
});

test("stdin 已关闭后收到迟到的 control_request：不挂幽灵权限卡、不广播 perm_request", async () => {
  SETTINGS.permissionMode = "default";
  const s = crypto.randomUUID();
  script([init(s), bg(["t0"]), result(), bg([]), { sleep: 1.5 }, askReq("req-closed-1"), { sleep: 30 }]);
  await startRun({ id: "r-closed-ctl", message: "fixture", cwd: root, permissionMode: "default" });
  const run = RUNS.get("r-closed-ctl");
  await until(() => !run.inputOpen, 5000);
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(run.perms.has("req-closed-1"), false, "stdin 已关不应写入 run.perms");
  assert.equal(events.some((e) => e.type === "perm_request" && e.id === "req-closed-1"), false, "stdin 已关不应广播 perm_request");
  abortRun(run);
  await until(() => endOf("r-closed-ctl"));
});

test("两个后台任务中只停了 t0，最后 t1 自行跑完：stopAsked 应为 false（不按 6 秒短超时掐断）", async () => {
  SETTINGS.permissionMode = "default";
  const s = crypto.randomUUID();
  script([init(s), bg(["t0", "t1"]), result(), { sleep: 0.4 }, bg(["t1"]), { sleep: 0.4 }, bg([]), { sleep: 30 }]);
  await startRun({ id: "r-stop-partial", message: "fixture", cwd: root, permissionMode: "default" });
  const run = RUNS.get("r-stop-partial");
  await until(() => run.idle && run.bgTasks === 2);
  assert.equal(run.stopTask("t0"), true);
  assert.equal(run.stopAsked, true);
  await until(() => run.bgTasks === 0);
  assert.equal(run.stopAsked, false, "最后一个任务 t1 是自行结束的，不能沿用 stop_task 的短超时");
  abortRun(run);
  await until(() => endOf("r-stop-partial"));
});

// ── 前端：权限卡漏收自愈与 FIND-042 守卫 ──
const src03 = fs.readFileSync(new URL("../web/app/03-perm-status.js", import.meta.url), "utf8");
const src04 = fs.readFileSync(new URL("../web/app/04-session-flow.js", import.meta.url), "utf8");
const cut = (s, a, b) => {
  const i = s.indexOf(a), j = s.indexOf(b, i);
  assert.ok(i >= 0 && j > i, `cut failed: ${a}`);
  return s.slice(i, j);
};

test("前端 syncLivePerms：漏收 perm_request 时从 srv.run.perms 补画；空壳、重放中、已答复不补画", () => {
  const got = [];
  const PERMS = new Map();
  const PERM_ANSWERED = new Set(["p-answered"]);
  const runViews = new Map();
  const srv = { run: { id: "r1", perms: [{ id: "p1", tool: "AskUserQuestion" }, { id: "p-answered", tool: "Bash" }] } };
  const box = {
    PERMS, PERM_ANSWERED, runViews, srv, busReplay: false,
    onPermRequest: (p) => { got.push(p); PERMS.set(p.id, { p, runId: p.runId, el: { isConnected: true }, done: false }); },
  };
  const fnSrc = cut(src04, "  function syncLivePerms() {", "  function applyState(s) {");
  vm.runInNewContext(fnSrc + "\nglobalThis.syncLivePerms = syncLivePerms;", box);

  // 1. runViews 里根本没有 r1（例如漏收 run_start）：照样补画并带上 runId
  box.syncLivePerms();
  assert.deepEqual(got.map((x) => [x.id, x.runId]), [["p1", "r1"]]);

  // 2. 已经在文档里连接着：不重复画
  box.syncLivePerms();
  assert.equal(got.length, 1);

  // 3. 卡片 DOM 脱离文档：重新补画
  PERMS.get("p1").el.isConnected = false;
  box.syncLivePerms();
  assert.equal(got.length, 2);

  // 4. FIND-042：已收尾空壳（有 rv 但无 av）不补画
  PERMS.clear();
  runViews.set("r1", { startedAt: 100 });
  box.syncLivePerms();
  assert.equal(got.length, 2, "空壳不得补画权限卡");

  // 5. busReplay 期间不补画（等 endReplay）
  runViews.delete("r1");
  box.busReplay = true;
  box.syncLivePerms();
  assert.equal(got.length, 2);
});

test("前端 pendingPerms 与 perm_request 路由：无 rv 但属于 srv.run 时仍能弹出与显示底栏，空壳仍拒绝", () => {
  const PERMS = new Map([
    ["p-cur", { runId: "r-cur", done: false }],
    ["p-other", { runId: "r-other", done: false }],
  ]);
  const box = { PERMS, runViews: new Map(), srv: { run: { id: "r-cur" } } };
  const pendSrc = cut(src03, "  function pendingPerms() {", "  // ── 输入框上方的状态带");
  vm.runInNewContext(pendSrc + "\nglobalThis.pendingPerms = pendingPerms;", box);
  assert.deepEqual(Array.from(box.pendingPerms(), (x) => x.runId), ["r-cur"]);

  // onBus 的 perm_request 分支
  const seen = [];
  const box2 = {
    runViews: new Map([["r-shell", { startedAt: 1 }], ["r-live", { startedAt: 2, av: {} }]]),
    srv: { run: { id: "r-cur" } },
    belongs: (ev) => ev.sessionId === "s-cur",
    onPermRequest: (ev) => seen.push(ev.id),
  };
  const caseSrc = cut(src04, '      case "perm_request": {', '      case "perm_resolved":');
  vm.runInNewContext(`globalThis.run = (ev) => { switch (ev.type) { ${caseSrc} } };`, box2);
  box2.run({ type: "perm_request", id: "1", runId: "r-shell" });
  box2.run({ type: "perm_request", id: "2", runId: "r-live" });
  box2.run({ type: "perm_request", id: "3", runId: "r-cur" });
  box2.run({ type: "perm_request", id: "4", runId: "r-belongs", sessionId: "s-cur" });
  box2.run({ type: "perm_request", id: "5", runId: "r-foreign", sessionId: "s-other" });
  assert.deepEqual(seen, ["2", "3", "4"]);
});
