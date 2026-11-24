import { PATHS } from "../gw/config.mjs";
import "./fixtures/uc-baseline.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

process.env.ANTHROPIC_API_KEY = "fixture-only-do-not-forward";
process.env.ANTHROPIC_AUTH_TOKEN = "fixture-only-do-not-forward";
const home = process.env.CCAPP_HOME;
const root = fs.mkdtempSync(path.join(process.env.CCAPP_WORKSPACE, "bgobs-cc-"));
const providerFile = path.join(home, "ccapp-providers.json");
const PID = "custom-bgobs";
fs.writeFileSync(providerFile, JSON.stringify({
  active: PID,
  providers: {
    [PID]: { label: "Fixture", baseUrl: "https://fixture.example.invalid", apiKey: "fixture-only", authStyle: "bearer", defaultModel: "fixture-model", fallbackModels: [{ id: "fixture-model" }] },
  },
}));
const cli = path.join(root, "fake-cli.sh");
const sh = fs.existsSync("/system/bin/sh") ? "/system/bin/sh" : "/bin/sh";
fs.mkdirSync(path.join(home, ".claude", "projects"), { recursive: true });
const SLEEP = ["/system/bin/sleep", "/bin/sleep", "/usr/bin/sleep"].find((p) => fs.existsSync(p));
if (!SLEEP) throw new Error("找不到 sleep");

function script(steps, code = 0) {
  const body = steps.map((s) => s.sleep ? `${SLEEP} ${s.sleep}` : `printf '%s\\n' ${JSON.stringify(JSON.stringify(s)).replace(/\$/g, "\\$")}`).join("\n");
  fs.writeFileSync(cli, `#!${sh}\n${body}\nexit ${code}\n`, { mode: 0o700 });
}

const prevPaths = { claude: PATHS.claude, loader: PATHS.loader, claudeLoader: PATHS.claudeLoader };
PATHS.claude = process.execPath;
PATHS.loader = PATHS.claudeLoader = cli;
const { startRun } = await import("../gw/run.mjs");
const { abortRun, snapshot, QUEUE } = await import("../gw/queue.mjs");
const { RUNS } = await import("../gw/runs.mjs");
const { onPublish } = await import("../gw/bus.mjs");
const events = [];
const off = onPublish((ev) => events.push(ev));
const origFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("fixture must not send a request"); };

after(() => {
  off();
  for (const r of RUNS.values()) abortRun(r);
  QUEUE.length = 0;
  globalThis.fetch = origFetch;
  Object.assign(PATHS, prevPaths);
  fs.rmSync(providerFile, { force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

async function until(fn, ms = 12000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error("timeout waiting condition");
    await new Promise((r) => setTimeout(r, 30));
  }
}

test("Claude 侧后台任务：bgList 保留稳定 startedAt、task_progress 刷新 lastActiveAt 与 progress、snapshot 透传 lastEvAt", async () => {
  const s = crypto.randomUUID();
  script([
    { type: "system", subtype: "init", session_id: s, model: "fixture-model", tools: [], permissionMode: "default" },
    { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "bg-1", task_type: "local_bash", description: "npm run build" }] },
    { sleep: 1 },
    { type: "system", subtype: "task_progress", task_id: "bg-1", tool_use_id: "tu-1", description: "Compiling bundle 60%", usage: { tool_uses: 2, total_tokens: 100 } },
    { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "bg-1", task_type: "local_bash", description: "npm run build" }] },
    { type: "result", subtype: "success", is_error: false, num_turns: 1, result: "running in bg", usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0 },
    { sleep: 15 },
  ]);
  await startRun({ id: "r-bgobs-1", message: "build", cwd: root });
  const run = RUNS.get("r-bgobs-1");
  await until(() => run.idle && run.bgList[0]?.progress === "Compiling bundle 60%");
  const item = run.bgList[0];
  assert.ok(item.startedAt > 0, "bgList 条目应带 startedAt");
  assert.ok(item.lastActiveAt >= item.startedAt, "task_progress 应刷新 lastActiveAt");
  assert.equal(item.progress, "Compiling bundle 60%");
  const snap = snapshot();
  const rInfo = snap.runs.find((x) => x.id === "r-bgobs-1");
  assert.ok(rInfo && rInfo.lastEvAt > 0, "snapshot runInfo 应暴露 lastEvAt");
  assert.equal(rInfo.bgList[0]?.progress, "Compiling bundle 60%");
  abortRun(run);
  await until(() => events.some((e) => e.type === "run_end" && e.runId === "r-bgobs-1"));
});

test("Claude 侧后台任务：stop_task 后若未发 task_notification，background_tasks_changed 清零时补发 sub_done(stopped)", async () => {
  const s = crypto.randomUUID();
  script([
    { type: "system", subtype: "init", session_id: s, model: "fixture-model", tools: [], permissionMode: "default" },
    { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "bg-stop-1", task_type: "local_bash", description: "long cmd" }] },
    { type: "system", subtype: "task_progress", task_id: "bg-stop-1", tool_use_id: "tu-stop-1", description: "step 1", usage: {} },
    { sleep: 1 },
    { type: "system", subtype: "background_tasks_changed", tasks: [] },
    { type: "result", subtype: "success", is_error: false, num_turns: 1, result: "done", usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0 },
  ]);
  await startRun({ id: "r-bgobs-stop", message: "stop test", cwd: root });
  const run = RUNS.get("r-bgobs-stop");
  await until(() => run.bgTasks === 1 && run.bgList[0]?.toolId === "tu-stop-1");
  run.stopIds.add("bg-stop-1");
  await until(() => events.some((e) => e.type === "run_end" && e.runId === "r-bgobs-stop"));
  assert.equal(events.some((e) => e.type === "sub_done" && e.parent === "tu-stop-1" && e.status === "stopped"), true, "stop_task 后脱离列表应补发 sub_done(stopped)");
});

test("前端 02-chat-view.js、03-perm-status.js 与 04-session-flow.js 后台 Bash 状态、进度与跨轮收口契约完备", () => {
  const cv = fs.readFileSync(path.join(process.cwd(), "gateway/web/app/02-chat-view.js"), "utf8");
  const ps = fs.readFileSync(path.join(process.cwd(), "gateway/web/app/03-perm-status.js"), "utf8");
  const sf = fs.readFileSync(path.join(process.cwd(), "gateway/web/app/04-session-flow.js"), "utf8");
  assert.match(cv, /isBgShellResult/);
  assert.match(cv, /if \(inp && inp\.IsDaemon\) return false/);
  assert.match(cv, /bgDone = true/);
  assert.match(ps, /case "bg":/);
  assert.match(ps, /t\("等待后台任务"\)/);
  assert.match(ps, /t\("静默 \{d\}"/);
  assert.match(ps, /querySelectorAll\("\.rs-el"\)/);
  assert.match(sf, /if \(!rv0\?\.av && !belongs\(ev\)\) return;/);
});
