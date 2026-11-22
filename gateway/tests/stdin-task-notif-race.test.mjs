// 回归测试：防止 <task-notification> 导致 onResult() 提前关闭 stdin，引发后续 cc-guard / 权限确认报 AbortError: Stream closed
//   1. --resume 时孤儿后台任务的 <task-notification> 在首条用户消息回显前吐出 0 轮空 result：不关 stdin，后续用户轮次的 can_use_tool 正常弹出并可应答；
//   2. 孤儿 <task-notification> 若带 isReplay: true，不误消耗首条消息的 replay 计数；
//   3. 本轮进行中后台任务自然清零（bg 1→0）紧接着收到 result：不立即 closeInput()，留出空闲收尾窗口给紧随其后的 <task-notification> 跟进轮次；
//   4. 对照：无后台任务的普通轮次（含不发 isReplay 的旧版/测试 CLI）result 后照常立即关闭 stdin；用户 stopTask 主动停掉的也不多留。
import { PATHS } from "../gw/config.mjs";
import "./fixtures/uc-baseline.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

process.env.CCAPP_IDLE_CLOSE_MS = "800";
process.env.ANTHROPIC_API_KEY = "fixture-only-do-not-forward";
process.env.ANTHROPIC_AUTH_TOKEN = "fixture-only-do-not-forward";

const home = process.env.CCAPP_HOME;
const root = fs.mkdtempSync(path.join(process.env.CCAPP_WORKSPACE, "stdin-notif-"));
const providerFile = path.join(home, "ccapp-providers.json");
const PID = "custom-stdin-notif";
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

const init = (s) => ({ type: "system", subtype: "init", session_id: s, model: "fixture-model", tools: [], permissionMode: "bypassPermissions" });
const bg = (ids) => ({ type: "system", subtype: "background_tasks_changed", tasks: ids.map((id) => ({ task_id: id, task_type: "local_bash", description: id })) });
const echo = (t) => ({ type: "user", isReplay: true, message: { role: "user", content: t } });
const result = (extra = {}) => ({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "done", usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0, ...extra });
const guardReq = (id) => ({
  type: "control_request",
  request_id: id,
  request: {
    subtype: "can_use_tool",
    tool_name: "Bash",
    input: { command: "ls -la ~/.ssh/vps-keys/" },
    tool_use_id: "tu-" + id,
    decision_reason_type: "hook",
    decision_reason: "cccodroid-guard|secret:SSH keys|SSH keys: .ssh/",
  },
});

test("--resume 孤儿 <task-notification> 在首条消息前吐出 0 轮空 result：不关 stdin，后续 cc-guard 确认正常弹出", async () => {
  SETTINGS.permissionMode = "bypassPermissions";
  const s = crypto.randomUUID();
  script([
    init(s),
    { type: "user", message: { role: "user", content: "<task-notification>\n<task-id>blzbmoosj</task-id>\n<status>stopped</status>\n</task-notification>" } },
    result({ uuid: "r-orphan-1", num_turns: 0, result: "" }),
    { sleep: 0.1 },
    echo("你现在再试试"),
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "tu-ssh-1", name: "Bash", input: { command: "ls -la ~/.ssh/vps-keys/" } }] } },
    guardReq("req-orphan-ssh-1"),
    { sleep: 30 },
  ]);
  await startRun({ id: "r-orphan-1", message: "你现在再试试", cwd: root, permissionMode: "bypassPermissions" });
  const run = RUNS.get("r-orphan-1");
  await until(() => events.some((e) => e.type === "perm_request" && e.id === "req-orphan-ssh-1"));
  assert.equal(run.inputOpen, true, "孤儿通知的 0 轮 result 不得关闭 stdin");
  assert.equal(run.initReplayed, true, "真正首条消息应完成回显");
  assert.equal(run.answerPerm("req-orphan-ssh-1", { behavior: "allow" }), true, "用户应能正常允许 .ssh/ 确认卡");
  abortRun(run);
  await until(() => endOf("r-orphan-1"));
});

test("--resume 孤儿 <task-notification> 即使带 isReplay:true 也不消耗首条回显，且不提前关 stdin", async () => {
  SETTINGS.permissionMode = "bypassPermissions";
  const s = crypto.randomUUID();
  script([
    init(s),
    echo("<task-notification>\n<task-id>__orphan_summary__:shell</task-id>\n<status>stopped</status>\n</task-notification>"),
    result({ uuid: "r-orphan-2", num_turns: 0, result: "" }),
    { sleep: 0.1 },
    echo("部署重启"),
    guardReq("req-orphan-ssh-2"),
    { sleep: 30 },
  ]);
  await startRun({ id: "r-orphan-2", message: "部署重启", cwd: root, permissionMode: "bypassPermissions" });
  const run = RUNS.get("r-orphan-2");
  await until(() => events.some((e) => e.type === "perm_request" && e.id === "req-orphan-ssh-2"));
  assert.equal(run.inputOpen, true);
  assert.equal(run.replays, 1, "孤儿通知不应计入首条用户消息回显次数");
  assert.equal(run.answerPerm("req-orphan-ssh-2", { behavior: "allow" }), true);
  abortRun(run);
  await until(() => endOf("r-orphan-2"));
});

test("本轮进行中后台任务自然清零紧接 result：不立即关 stdin，紧随的跟进轮次可正常弹窗确认", async () => {
  SETTINGS.permissionMode = "bypassPermissions";
  const s = crypto.randomUUID();
  script([
    init(s),
    echo("跑完通知我"),
    bg(["b0kupf6nn"]),
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "已在后台启动。" }] } },
    bg([]),
    result({ uuid: "r-mid-1" }),
    { sleep: 0.2 },
    { type: "stream_event", event: { type: "message_start", message: { id: "msg-follow", usage: { input_tokens: 1, output_tokens: 0 } } } },
    guardReq("req-mid-ssh-1"),
    { sleep: 30 },
  ]);
  await startRun({ id: "r-mid-bg", message: "跑完通知我", cwd: root, permissionMode: "bypassPermissions" });
  const run = RUNS.get("r-mid-bg");
  await until(() => events.some((e) => e.type === "perm_request" && e.id === "req-mid-ssh-1"));
  assert.equal(run.inputOpen, true, "本轮进行中后台任务刚清零时，result 后不能立刻掐断 stdin");
  assert.equal(run.idle, false, "跟进轮次开始后应切回忙碌");
  assert.equal(run.answerPerm("req-mid-ssh-1", { behavior: "allow" }), true);
  abortRun(run);
  await until(() => endOf("r-mid-bg"));
});

test("对照：普通无后台任务轮次（不发 isReplay）result 后照常立即关闭 stdin", async () => {
  SETTINGS.permissionMode = "bypassPermissions";
  const s = crypto.randomUUID();
  script([init(s), result({ uuid: "r-plain-1" }), { sleep: 30 }]);
  await startRun({ id: "r-plain", message: "普通提问", cwd: root, permissionMode: "bypassPermissions" });
  const run = RUNS.get("r-plain");
  await until(() => !run.inputOpen, 3000);
  assert.equal(run.inputOpen, false, "普通轮次 result 后应立即关闭 stdin");
  abortRun(run);
  await until(() => endOf("r-plain"));
});

test("对照：本轮进行中后台任务是由 stopTask 主动停掉再出 result：直接关闭 stdin，不进入空闲等待", async () => {
  SETTINGS.permissionMode = "bypassPermissions";
  const s = crypto.randomUUID();
  script([
    init(s),
    echo("跑个后台"),
    bg(["t-stop-1"]),
    { sleep: 0.4 },
    bg([]),
    result({ uuid: "r-stopped-mid-1" }),
    { sleep: 30 },
  ]);
  await startRun({ id: "r-stopped-mid", message: "跑个后台", cwd: root, permissionMode: "bypassPermissions" });
  const run = RUNS.get("r-stopped-mid");
  await until(() => run.bgTasks === 1);
  assert.equal(run.stopTask("t-stop-1"), true);
  const t0 = Date.now();
  await until(() => !run.inputOpen, 3000);
  assert.equal(!!run.idle, false, "主动 stopTask 清零后出 result 不应再进入 idle 等待");
  assert.ok(Date.now() - t0 < 1500);
  abortRun(run);
  await until(() => endOf("r-stopped-mid"));
});
