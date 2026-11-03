// v0.5.20 审查第 2 批：运行结算与统计。用假 CLI（sh 脚本按 stream-json 吐事件）驱动真实 startRun
import { PATHS, CFG } from "../gw/config.mjs"; // scripts/test.mjs 先隔离 HOME / fake PREFIX
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

process.env.ANTHROPIC_API_KEY = "fixture-only-do-not-forward";
process.env.ANTHROPIC_AUTH_TOKEN = "fixture-only-do-not-forward";
const home = process.env.CCAPP_HOME;
const root = fs.mkdtempSync(path.join(process.env.CCAPP_WORKSPACE, "run0520-"));
const providerFile = path.join(home, "ccapp-providers.json");
const PID = "custom-run0520";
fs.writeFileSync(providerFile, JSON.stringify({ active: PID, providers: {
  [PID]: { label: "Fixture", baseUrl: "https://fixture.example.invalid", apiKey: "fixture-only", authStyle: "bearer", defaultModel: "fixture-model", fallbackModels: [{ id: "fixture-model" }] },
} }));
const cli = path.join(root, "fake-cli.sh");
const sh = fs.existsSync("/system/bin/sh") ? "/system/bin/sh" : "/bin/sh";
// 假 CLI：按顺序吐事件；{sleep: 秒} 停一会儿；最后 exit code
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
const { startRun } = await import("../gw/run.mjs");
const { onPublish } = await import("../gw/bus.mjs");
const events = [];
const off = onPublish((ev) => events.push(ev));
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("fixture must not send a request"); };
after(() => {
  off();
  globalThis.fetch = originalFetch;
  Object.assign(PATHS, previousPaths);
  fs.rmSync(providerFile, { force: true });
  fs.rmSync(root, { recursive: true, force: true });
});
const endOf = (id) => events.find((e) => e.type === "run_end" && e.runId === id);
async function until(f, ms = 8000) { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error("等不到"); await new Promise((r) => setTimeout(r, 30)); } }

const sid = () => crypto.randomUUID();
const init = (s) => ({ type: "system", subtype: "init", session_id: s, model: "fixture-model", tools: [], permissionMode: "default" });
const bg = (n) => ({ type: "system", subtype: "background_tasks_changed", tasks: Array.from({ length: n }, (_, i) => ({ task_id: "t" + i, task_type: "local_bash", description: "fixture" })) });
const result = (i, o, cost = 0) => ({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "done", usage: { input_tokens: i, output_tokens: o }, total_cost_usd: cost });
const mainStart = { type: "stream_event", event: { type: "message_start", message: { id: "msg-2", usage: { input_tokens: 1, output_tokens: 0 } } } };

test("02-002 后台回报又起了一轮、没出 result 就异常退出：按失败算，不沿用上一轮的成功", async () => {
  const s = sid();
  script([init(s), bg(1), result(10, 1), mainStart], 17);
  await startRun({ id: "r0520-stale", message: "fixture", cwd: root });
  await until(() => endOf("r0520-stale"));
  const e = endOf("r0520-stale");
  assert.equal(e.failed, true, JSON.stringify(e));
  assert.notEqual(e.subtype, "success");
});

test("02-002 对照：后台任务清零、正常退出，照旧算成功", async () => {
  const s = sid();
  script([init(s), bg(1), result(10, 1), bg(0)], 0);
  await startRun({ id: "r0520-ok", message: "fixture", cwd: root });
  await until(() => endOf("r0520-ok"));
  const e = endOf("r0520-ok");
  assert.equal(!!e.failed, false, JSON.stringify(e));
  assert.equal(e.subtype, "success");
});

test("04-008 同一进程出两个 result：接口账本两份都记上", async () => {
  const bill = path.join(home, "ccapp-billing.json");
  const tok = () => { try { return (JSON.parse(fs.readFileSync(bill, "utf8"))[PID]?.tok || []).reduce((a, x) => [a[0] + x[1], a[1] + x[2]], [0, 0]); } catch { return [0, 0]; } };
  await new Promise((r) => setTimeout(r, 700));   // 前几条测试记的先落盘
  const before = tok();
  const s = sid();
  script([init(s), bg(1), result(100, 10), mainStart, result(200, 20), bg(0)], 0);
  await startRun({ id: "r0520-bill", message: "fixture", cwd: root });
  await until(() => endOf("r0520-bill"));
  await new Promise((r) => setTimeout(r, 700));   // saveBill 防抖 500ms
  const now = tok();
  assert.deepEqual([now[0] - before[0], now[1] - before[1]], [300, 30]);
});

test("03-010 单次花费上限：同一进程接着还要干时，超了当场停", async () => {
  const s = sid();
  script([init(s), bg(1), result(10, 1, 0.5), { sleep: 6 }, mainStart, result(10, 1, 0.9)], 0);
  const t0 = Date.now();
  await startRun({ id: "r0520-cost", message: "fixture", cwd: root, limitCost: 0.1 });
  await until(() => endOf("r0520-cost"));
  assert.equal(endOf("r0520-cost").aborted, true);
  assert.ok(Date.now() - t0 < 5000, "没等假 CLI 跑完就停了");
});
