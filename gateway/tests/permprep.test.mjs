// 起进程之前改权限模式（审查 v0.5.20 02-001）：这一轮已经占了槽、还在准备（问设备工具、读建档提示…），
// 用户把「全部放行」改回逐项确认 —— 新进程要按改后的模式起，不能按开头读到的旧模式。用假 CLI 记下真实 argv；
// 准备阶段卡在哪儿：消息带一张要先缩的大图，假 magick 等测试放行才退出（读模式之后、起进程之前的一个真实 await）
import { PATHS } from "../gw/config.mjs";
import "./fixtures/uc-baseline.mjs";   // 共用 home 里前面测试留下的 ~/.claude 改动先认下，免得真起一轮时卡在确认卡片
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

process.env.ANTHROPIC_API_KEY = "fixture-only-do-not-forward";
process.env.ANTHROPIC_AUTH_TOKEN = "fixture-only-do-not-forward";
const home = process.env.CCAPP_HOME;
const root = fs.mkdtempSync(path.join(process.env.CCAPP_WORKSPACE, "permprep-"));
const providerFile = path.join(home, "ccapp-providers.json");
const PID = "custom-permprep";
fs.writeFileSync(providerFile, JSON.stringify({ active: PID, providers: {
  [PID]: { label: "Fixture", baseUrl: "https://fixture.example.invalid", apiKey: "fixture-only", authStyle: "bearer", defaultModel: "fixture-model", fallbackModels: [{ id: "fixture-model" }], inlineImages: true },
} }));
const cli = path.join(root, "fake-cli.sh"), argsFile = path.join(root, "args.txt");
const sh = fs.existsSync("/system/bin/sh") ? "/system/bin/sh" : "/bin/sh";
const sid = crypto.randomUUID();
const lines = [{ type: "system", subtype: "init", session_id: sid, model: "fixture-model", tools: [], permissionMode: "default" },
  { type: "result", subtype: "success", is_error: false, num_turns: 1, result: "done", usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0 }];
fs.writeFileSync(cli, `#!${sh}\nprintf '%s\\n' "$@" > ${JSON.stringify(argsFile)}\n` + lines.map((l) => `printf '%s\\n' ${JSON.stringify(JSON.stringify(l)).replace(/\$/g, "\\$")}`).join("\n") + "\nexit 0\n", { mode: 0o700 });
const started = path.join(root, "magick-started"), release = path.join(root, "magick-release");
fs.mkdirSync(path.join(process.env.CCAPP_PREFIX, "bin"), { recursive: true });
fs.writeFileSync(path.join(process.env.CCAPP_PREFIX, "bin", "magick"), `#!${sh}\n: > ${JSON.stringify(started)}\nwhile [ ! -e ${JSON.stringify(release)} ]; do sleep 0.05; done\nexit 1\n`, { mode: 0o700 });
const big = path.join(root, "big.png");
{ const b = Buffer.alloc(4 << 20); b.writeUInt32BE(0x89504e47, 0); fs.writeFileSync(big, b); }
const previousPaths = { claude: PATHS.claude, loader: PATHS.loader, claudeLoader: PATHS.claudeLoader };
PATHS.claude = process.execPath;
PATHS.loader = PATHS.claudeLoader = cli;
const { startRun } = await import("../gw/run.mjs");
const { setPermMode, abortRun } = await import("../gw/queue.mjs");
const { RUNS } = await import("../gw/runs.mjs");
const { SETTINGS } = await import("../gw/settings-store.mjs");
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("fixture must not send a request"); };
after(() => {
  for (const r of RUNS.values()) abortRun(r);
  globalThis.fetch = originalFetch;
  Object.assign(PATHS, previousPaths);
  fs.rmSync(providerFile, { force: true });
  fs.rmSync(path.join(process.env.CCAPP_PREFIX, "bin", "magick"), { force: true });
  fs.rmSync(root, { recursive: true, force: true });
});
async function until(f, ms = 15000) { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error("等不到"); await new Promise((r) => setTimeout(r, 30)); } }
const modeArg = async () => { await until(() => fs.existsSync(argsFile) && fs.readFileSync(argsFile, "utf8").includes("--permission-mode")); const a = fs.readFileSync(argsFile, "utf8").split("\n"); return a[a.indexOf("--permission-mode") + 1]; };

test("准备期间收紧：新进程按逐项确认起，这一轮记的也是逐项确认", async () => {
  SETTINGS.permissionMode = "bypassPermissions";
  fs.rmSync(argsFile, { force: true });
  const p = startRun({ id: "rpp-1", message: `看图 @${big}`, cwd: root });
  const run = RUNS.get("rpp-1");
  await until(() => fs.existsSync(started));
  assert.ok(run && !run.child, "还没起进程");
  assert.equal(setPermMode("default"), true);
  fs.writeFileSync(release, "");
  await p;
  assert.equal(await modeArg(), "default");
  assert.equal(run.permMode, "default");
});

test("对照：没人改，按设置里的模式起", async () => {
  SETTINGS.permissionMode = "acceptEdits";
  fs.rmSync(argsFile, { force: true });
  await startRun({ id: "rpp-2", message: "fixture", cwd: root });
  assert.equal(await modeArg(), "acceptEdits");
  SETTINGS.permissionMode = "default";
});
