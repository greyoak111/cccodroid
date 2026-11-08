// 0.6.9 审计：运行链路 P1-4（权限确认无人答）、P1-6（事件处理 / 收尾抛错）、195-T.1（子孙攥着管道 close 不来）
// 用假 CLI（sh 脚本按 stream-json 吐事件）驱动真实 startRun，写法同 run0520.test.mjs
import { PATHS } from "../gw/config.mjs";
import "./fixtures/uc-baseline.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

process.env.CCAPP_PERM_WAIT_MS = "400";      // 权限确认超时改短（run.mjs 加载时读）
process.env.CCAPP_IDLE_CLOSE_MS = "800";     // 空闲收尾改短（同上）
process.env.ANTHROPIC_API_KEY = "fixture-only-do-not-forward";
const home = process.env.CCAPP_HOME;
const root = fs.mkdtempSync(path.join(process.env.CCAPP_WORKSPACE, "a0610-run-"));
const providerFile = path.join(home, "ccapp-providers.json");
const PID = "custom-a0610run";
const hadProviders = fs.existsSync(providerFile) ? fs.readFileSync(providerFile) : null;
fs.writeFileSync(providerFile, JSON.stringify({ active: PID, providers: {
  [PID]: { label: "Fixture", baseUrl: "https://fixture.example.invalid", apiKey: "fixture-only", authStyle: "bearer", defaultModel: "fixture-model", fallbackModels: [{ id: "fixture-model" }] },
} }));
const cli = path.join(root, "fake-cli.sh");
const sh = fs.existsSync("/system/bin/sh") ? "/system/bin/sh" : "/bin/sh";
const SLEEP = ["/system/bin/sleep", "/bin/sleep", "/usr/bin/sleep"].find((p) => fs.existsSync(p));
if (!SLEEP) throw new Error("找不到 sleep");
function script(steps, code = 0) {
  const body = steps.map((s) => s.raw ? s.raw : s.sleep ? `${SLEEP} ${s.sleep}` : `printf '%s\\n' ${JSON.stringify(JSON.stringify(s)).replace(/\$/g, "\\$")}`).join("\n");
  fs.writeFileSync(cli, `#!${sh}\n${body}\nexit ${code}\n`, { mode: 0o700 });
}
const previousPaths = { claude: PATHS.claude, loader: PATHS.loader, claudeLoader: PATHS.claudeLoader };
PATHS.claude = process.execPath;
PATHS.loader = PATHS.claudeLoader = cli;
const { startRun } = await import("../gw/run.mjs");
const { RUNS } = await import("../gw/runs.mjs");
const { onPublish } = await import("../gw/bus.mjs");
const { SETTINGS } = await import("../gw/settings-store.mjs");
const events = [];
const off = onPublish((ev) => events.push(ev));
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("fixture must not send a request"); };
const prevMode = SETTINGS.permissionMode;
after(() => {
  off();
  globalThis.fetch = originalFetch;
  SETTINGS.permissionMode = prevMode;
  Object.assign(PATHS, previousPaths);
  if (hadProviders) fs.writeFileSync(providerFile, hadProviders); else fs.rmSync(providerFile, { force: true });
  fs.rmSync(root, { recursive: true, force: true });
});
const endOf = (id) => events.find((e) => e.type === "run_end" && e.runId === id);
async function until(f, ms = 15000) { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error("等不到"); await new Promise((r) => setTimeout(r, 30)); } }
const init = (s) => ({ type: "system", subtype: "init", session_id: s, model: "fixture-model", tools: [], permissionMode: "default" });
const result = { type: "result", subtype: "success", is_error: false, num_turns: 1, result: "done", usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0 };

test("P1-6：一条事件处理时抛错（null 事件）→ 只跳过这条，这一轮照常答完", async () => {
  script([init(crypto.randomUUID()), { raw: "printf 'null\\n'" }, result], 0);
  await startRun({ id: "a0610-null", message: "fixture", cwd: root });
  await until(() => endOf("a0610-null"));
  const e = endOf("a0610-null");
  assert.equal(!!e.failed, false, JSON.stringify(e));
  assert.equal(e.subtype, "success");
});

test("P1-4：权限确认一直没人答 → 到点按拒绝并停止处理，卡片收掉", async () => {
  SETTINGS.permissionMode = "default";
  const s = crypto.randomUUID();
  script([init(s), { type: "control_request", request_id: "perm-1", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "echo hi" }, tool_use_id: "tu-1" } }, { sleep: 3 }, result], 0);
  await startRun({ id: "a0610-perm", message: "fixture", cwd: root, permissionMode: "default" });
  await until(() => events.some((e) => e.type === "perm_request" && e.id === "perm-1"));
  await until(() => events.some((e) => e.type === "perm_resolved" && e.id === "perm-1"), 5000);
  const r = events.find((e) => e.type === "perm_resolved" && e.id === "perm-1");
  assert.equal(r.behavior, "deny");
  assert.equal(r.interrupt, true);
  await until(() => endOf("a0610-perm"));
});

test("195-W.3：空闲轮次收尾定时器在跑时插话 → 定时器撤掉，stdin 不被关", async () => {
  const s = crypto.randomUUID();
  const bg = (tasks) => ({ type: "system", subtype: "background_tasks_changed", tasks });
  script([init(s), bg([{ task_id: "t1", task_type: "bash", description: "x" }]), result, { sleep: 0.2 }, bg([]), { sleep: 2.5 }], 0);
  await startRun({ id: "a0610-idle", message: "fixture", cwd: root });
  await until(() => { const r = RUNS.get("a0610-idle"); return r && r.idle && r.idleClose; }, 8000);
  const r = RUNS.get("a0610-idle");
  assert.equal(r.inject({ id: "inj-1", message: "接着做", cid: null }), true);
  await new Promise((ok) => setTimeout(ok, 1200));       // 过了 800ms 的收尾点
  assert.equal(r.inputOpen, true, "插话之后 stdin 不该被收尾定时器关掉");
  await until(() => endOf("a0610-idle"), 10000);
});

// 放最后：它留下的后台 sleep 30 还活着时，后面的轮次会先弹「用户配置」确认卡
test("195-T.1：claude 退出了、后台子孙还攥着输出管道 → 5 秒后自己收尾，不永远「生成中」", async () => {
  script([init(crypto.randomUUID()), result, { raw: `${SLEEP} 30 &` }], 0);
  const t0 = Date.now();
  await startRun({ id: "a0610-held", message: "fixture", cwd: root });
  await until(() => endOf("a0610-held"), 12000);
  assert.ok(Date.now() - t0 < 12000);
  assert.equal(endOf("a0610-held").subtype, "success");
});
