// e 组 FIND-002：abortRun 5+2 秒的强制收尾以前直接 endRun，绕过 finish（封签、账本、权限卡、未送达消息都跳过）。
// 这里验证兜底优先交给这一轮自己的 forceFinish，而 forceFinish 真的走 finish。
import { PATHS } from "../gw/config.mjs";
import "./fixtures/uc-baseline.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

process.env.ANTHROPIC_API_KEY = "fixture-only-do-not-forward";
const home = process.env.CCAPP_HOME;
const root = fs.mkdtempSync(path.join(process.env.CCAPP_WORKSPACE, "stab-e-ff-"));
const providerFile = path.join(home, "ccapp-providers.json");
const PID = "custom-stabeff";
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
fs.writeFileSync(cli, `#!${sh}\nprintf '%s\\n' '${init}'\n${SLEEP} 5\nexit 0\n`, { mode: 0o700 });
const previousPaths = { claude: PATHS.claude, loader: PATHS.loader, claudeLoader: PATHS.claudeLoader };
PATHS.claude = process.execPath;
PATHS.loader = PATHS.claudeLoader = cli;
const { startRun } = await import("../gw/run.mjs");
const { RUNS } = await import("../gw/runs.mjs");
const { onPublish } = await import("../gw/bus.mjs");
const { forceEnd } = await import("../gw/queue.mjs");
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
async function until(f, ms = 15000) { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error("等不到"); await new Promise((r) => setTimeout(r, 30)); } }

test("FIND-002：兜底收尾优先走这一轮自己的 forceFinish", () => {
  let calls = 0;
  const run = { ended: false, forceFinish() { calls++; this.ended = true; } };
  assert.equal(forceEnd(run), true);
  assert.equal(calls, 1);
  assert.equal(forceEnd(run), false, "已结束的不再收");
});

test("FIND-002：强制收尾走 finish —— 提醒放回、run_end 带用时、输入关掉", async () => {
  const id = "stab-e-ff";
  await startRun({ id, message: "fixture", cwd: root });
  await until(() => RUNS.get(id)?.child);
  const run = started = RUNS.get(id);
  assert.equal(typeof run.forceFinish, "function", "这一轮没挂 forceFinish");
  let back = 0;
  run.giveNotesBack = () => { back++; };
  const endP = new Promise((ok) => { const off = onPublish((ev) => { if (ev.type === "run_end" && ev.runId === id) { off(); ok(ev); } }); });
  run.forceFinish();
  const ev = await endP;
  assert.equal(back, 1, "finish 里的「提醒放回」没执行，说明绕过了 finish");
  assert.equal(typeof ev.durationMs, "number", "run_end 要带用时（老兜底没有）");
  assert.equal(run.inputOpen, false);
  assert.equal(run.ended, true);
});
