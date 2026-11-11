// e 组 FIND-043（部分）：权限卡 30 分钟没人答，以前和用户点「拒绝」呈现得一模一样；control_response 的错误日志说成「拒绝」。
import { PATHS } from "../gw/config.mjs";
import "./fixtures/uc-baseline.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

process.env.CCAPP_PERM_WAIT_MS = "400";
const home = process.env.CCAPP_HOME;
const root = fs.mkdtempSync(path.join(process.env.CCAPP_WORKSPACE, "stab-e-perm-"));
const providerFile = path.join(home, "ccapp-providers.json");
const PID = "custom-stabeperm";
const hadProviders = fs.existsSync(providerFile) ? fs.readFileSync(providerFile) : null;
fs.writeFileSync(providerFile, JSON.stringify({ active: PID, providers: {
  [PID]: { label: "Fixture", baseUrl: "https://fixture.example.invalid", apiKey: "fixture-only", authStyle: "bearer", defaultModel: "fixture-model", fallbackModels: [{ id: "fixture-model" }] },
} }));
const cli = path.join(root, "fake-cli.sh");
const sh = fs.existsSync("/system/bin/sh") ? "/system/bin/sh" : "/bin/sh";
const SLEEP = ["/system/bin/sleep", "/bin/sleep", "/usr/bin/sleep"].find((p) => fs.existsSync(p));
if (!SLEEP) throw new Error("找不到 sleep");
const sid = crypto.randomUUID();
const init = JSON.stringify({ type: "system", subtype: "init", session_id: sid, model: "fixture-model", tools: [], permissionMode: "default" });
const req = JSON.stringify({ type: "control_request", request_id: "perm-e1", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "echo hi" }, tool_use_id: "tu-e1" } });
const result = JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "done", usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0 });
fs.writeFileSync(cli, `#!${sh}\nprintf '%s\\n' '${init}'\nprintf '%s\\n' '${req}'\n${SLEEP} 2\nprintf '%s\\n' '${result}'\nexit 0\n`, { mode: 0o700 });
const previousPaths = { claude: PATHS.claude, loader: PATHS.loader, claudeLoader: PATHS.claudeLoader };
PATHS.claude = process.execPath;
PATHS.loader = PATHS.claudeLoader = cli;
process.env.ANTHROPIC_API_KEY = "fixture-only-do-not-forward";
const { startRun } = await import("../gw/run.mjs");
const { RUNS } = await import("../gw/runs.mjs");
const { onPublish } = await import("../gw/bus.mjs");
const { SETTINGS } = await import("../gw/settings-store.mjs");
const events = [];
onPublish((ev) => events.push(ev));
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("fixture must not send a request"); };
let started = null;
after(() => {
  globalThis.fetch = originalFetch;
  Object.assign(PATHS, previousPaths);
  if (hadProviders) fs.writeFileSync(providerFile, hadProviders); else fs.rmSync(providerFile, { force: true });
  try { if (started?.child) process.kill(-started.child.pid, "SIGKILL"); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
});
const until = async (f, ms = 15000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error("等不到"); await new Promise((r) => setTimeout(r, 30)); } };

test("FIND-043：权限卡超时在 perm_resolved 里标 expired，不冒充用户拒绝", async () => {
  SETTINGS.permissionMode = "default";
  await startRun({ id: "stab-e-perm", message: "fixture", cwd: root, permissionMode: "default" });
  started = RUNS.get("stab-e-perm");
  await until(() => events.some((e) => e.type === "perm_request" && e.id === "perm-e1"));
  await until(() => events.some((e) => e.type === "perm_resolved" && e.id === "perm-e1"), 5000);
  const r = events.find((e) => e.type === "perm_resolved" && e.id === "perm-e1");
  assert.equal(r.behavior, "deny");
  assert.equal(r.interrupt, true);
  assert.equal(r.expired, true, "超时没有标出来，界面会显示成用户拒绝");
  await until(() => events.some((e) => e.type === "run_end" && e.runId === "stab-e-perm"));
});

test("FIND-043：界面按 expired 显示「超时」，控制请求的错误日志不再说成拒绝", () => {
  const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web", "app");
  const permSrc = fs.readFileSync(path.join(APP, "03-perm-status.js"), "utf8");
  assert.match(permSrc, /o\.expired \? t\("超时"\)/, "界面没有区分超时");
  const runSrc = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "gw", "run.mjs"), "utf8");
  assert.match(runSrc, /expired: true/);
  assert.match(runSrc, /控制请求回了错误/);
  const codeOnly = runSrc.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.equal(/claude 拒绝了控制请求/.test(codeOnly), false, "日志还在把错误说成拒绝");
});
