// 答完了、只剩后台任务时的输入（11-02 群友：一条 SSH 隧道开在后台，之后发的消息一直排着、后台任务也停不掉）。
// 用假 CLI（sh 脚本按 stream-json 吐事件）驱动真实 startRun，同 run0520.test.mjs
import { PATHS } from "../gw/config.mjs"; // scripts/test.mjs 先隔离 HOME / fake PREFIX
import "./fixtures/uc-baseline.mjs";   // 共用 home 里前面测试留下的 ~/.claude 改动先认下，免得真起一轮时卡在确认卡片
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";

process.env.ANTHROPIC_API_KEY = "fixture-only-do-not-forward";
process.env.ANTHROPIC_AUTH_TOKEN = "fixture-only-do-not-forward";
const home = process.env.CCAPP_HOME;
const root = fs.mkdtempSync(path.join(process.env.CCAPP_WORKSPACE, "bgseal-"));
const providerFile = path.join(home, "ccapp-providers.json");
const PID = "custom-bgseal";
fs.writeFileSync(providerFile, JSON.stringify({ active: PID, providers: {
  [PID]: { label: "Fixture", baseUrl: "https://fixture.example.invalid", apiKey: "fixture-only", authStyle: "bearer", defaultModel: "fixture-model", fallbackModels: [{ id: "fixture-model" }] },
} }));
const cli = path.join(root, "fake-cli.sh");
const sh = fs.existsSync("/system/bin/sh") ? "/system/bin/sh" : "/bin/sh";
// 假 CLI 跑在 claude 那套 PATH 里（假 PREFIX/bin、/system/bin），Linux 上找不到 sleep 会悄悄跳过等待：用绝对路径，找不到就直接失败（#113）
const SLEEP = ["/system/bin/sleep", "/bin/sleep", "/usr/bin/sleep"].find((p) => fs.existsSync(p));
if (!SLEEP) throw new Error("找不到 sleep，假 CLI 的等待会失效");
function script(steps, code = 0) {
  const body = steps.map((s) => s.sleep ? `${SLEEP} ${s.sleep}` : `printf '%s\\n' ${JSON.stringify(JSON.stringify(s)).replace(/\$/g, "\\$")}`).join("\n");
  fs.writeFileSync(cli, `#!${sh}\n${body}\nexit ${code}\n`, { mode: 0o700 });
}
const previousPaths = { claude: PATHS.claude, loader: PATHS.loader };
PATHS.claude = process.execPath;
PATHS.loader = cli;
const { startRun, routeRun } = await import("../gw/run.mjs");
const { enqueue, abortRun, routeQueue, QUEUE } = await import("../gw/queue.mjs");
const { RUNS } = await import("../gw/runs.mjs");
const { NEXT } = await import("../gw/http.mjs");
const { onPublish } = await import("../gw/bus.mjs");
const events = [];
const off = onPublish((ev) => events.push(ev));
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("fixture must not send a request"); };
const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  for (const r of [routeQueue, routeRun]) if ((await r(req, res, u, u.pathname)) !== NEXT) return;
  res.writeHead(404).end();
});
await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
const post = async (p, b) => { const r = await originalFetch(`http://127.0.0.1:${srv.address().port}${p}`, { method: "POST", body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };
after(() => {
  off();
  srv.close();
  for (const r of RUNS.values()) abortRun(r);
  QUEUE.length = 0;
  globalThis.fetch = originalFetch;
  Object.assign(PATHS, previousPaths);
  fs.rmSync(providerFile, { force: true });
  fs.rmSync(root, { recursive: true, force: true });
});
const endOf = (id) => events.find((e) => e.type === "run_end" && e.runId === id);
async function until(f, ms = 15000) { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error("等不到"); await new Promise((r) => setTimeout(r, 30)); } }

const init = (s) => ({ type: "system", subtype: "init", session_id: s, model: "fixture-model", tools: [], permissionMode: "default" });
const bg = (n, d = "fixture") => ({ type: "system", subtype: "background_tasks_changed", tasks: Array.from({ length: n }, (_, i) => ({ task_id: "t" + i, task_type: "local_bash", description: d })) });
const result = () => ({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "done", usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0 });
const mainStart = { type: "stream_event", event: { type: "message_start", message: { id: "msg-2", usage: { input_tokens: 1, output_tokens: 0 } } } };

test("后台任务自己跑完、claude 过了 7 秒才起新一轮并又开了一个后台任务：输入还开着，新消息能插进去", async () => {
  const s = crypto.randomUUID();
  // 第一条隧道断了（任务清零）→ 大上下文下 7 秒后才开口 → 重开隧道（后台）→ 答完，进程留着
  script([init(s), bg(1, "tunnel"), result(), bg(0), { sleep: 7 }, mainStart, bg(1, "Restart SSH tunnel"), result(), { sleep: 30 }]);
  await startRun({ id: "rbg-race", message: "fixture", cwd: root });
  const run = RUNS.get("rbg-race");
  await until(() => run.idle && run.bgTasks === 1 && run.bgList[0]?.desc === "Restart SSH tunnel");
  assert.equal(run.inputOpen, true, "stdin 不该在 claude 起新一轮前就关掉");
  const it = enqueue({ message: "来", sessionId: s });
  assert.equal(it.injected, true, "答完了只剩后台任务：消息直接插进去");
  abortRun(run);
  await until(() => endOf("rbg-race"));
});

test("输入已经关了（旧版留下的、或兜底超时后又起了任务）：停止按钮整轮结束；立即发送先结束它再发，排着的不挂起", async () => {
  const s = crypto.randomUUID();
  script([init(s), bg(1, "tunnel"), result(), { sleep: 30 }]);
  await startRun({ id: "rbg-seal", message: "fixture", cwd: root });
  const run = RUNS.get("rbg-seal");
  await until(() => run.idle && run.bgTasks === 1);
  run.inputOpen = false;                       // 模拟 stdin 已关
  const it = enqueue({ message: "来", sessionId: s });
  assert.equal(!!it.injected, false);
  assert.ok(QUEUE.includes(it), "插不进去就排着");
  // 立即发送：结束这一轮（连同后台任务），这条随后发出，不被挂起
  script([init(s), result()]);
  const r = await post("/api/queue/promote", { id: it.id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await until(() => endOf("rbg-seal"));
  assert.equal(endOf("rbg-seal").retired, true, "回答是完整的：标 retired，界面不报「已中断」");
  await until(() => endOf(it.id));
  assert.equal(!!endOf(it.id).failed, false, JSON.stringify(endOf(it.id)));
});

test("输入已关时点后台任务的停止：不再报「已经结束了」，整轮结束", async () => {
  const s = crypto.randomUUID();
  script([init(s), bg(1, "tunnel"), result(), { sleep: 30 }]);
  await startRun({ id: "rbg-stop", message: "fixture", cwd: root });
  const run = RUNS.get("rbg-stop");
  await until(() => run.idle && run.bgTasks === 1);
  run.inputOpen = false;
  const r = await post("/api/task/stop", { runId: "rbg-stop", taskId: "t0" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await until(() => endOf("rbg-stop"));
  assert.equal(endOf("rbg-stop").retired, true);
});

test("发过一次 stop_task、之后又起了新一轮：再空闲时不再按 6 秒关输入（DeepSeek 复核 中-1）", async () => {
  const s = crypto.randomUUID();
  script([init(s), bg(1, "a"), result(), { sleep: 2 }, mainStart, bg(1, "b"), result(), bg(0), { sleep: 30 }]);
  await startRun({ id: "rbg-sticky", message: "fixture", cwd: root });
  const run = RUNS.get("rbg-sticky");
  await until(() => run.idle && run.bgTasks === 1);
  assert.ok(run.stopTask("t0"), "空闲中能发 stop_task");
  await until(() => run.idle && run.bgTasks === 0 && run.bgList.length === 0 && events.some((e) => e.runId === "rbg-sticky" && e.type === "run_busy"));
  await new Promise((r) => setTimeout(r, 7000));
  assert.equal(run.inputOpen, true, "这次空闲是任务自己跑完的，不该 6 秒就关");
  abortRun(run);
  await until(() => endOf("rbg-sticky"));
});
