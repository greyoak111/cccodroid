// e 组 FIND-045（五小项）：工具结果截断无标记、终端 cwd 静默回落、stderr 尾部丢失、信号统一报 128、回放环溢出无提示。
import { PATHS, CFG } from "../gw/config.mjs";
import "./fixtures/uc-baseline.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const home = process.env.CCAPP_HOME;
const root = fs.mkdtempSync(path.join(process.env.CCAPP_WORKSPACE, "stab-e-out-"));
const providerFile = path.join(home, "ccapp-providers.json");
const PID = "custom-stabeout";
const hadProviders = fs.existsSync(providerFile) ? fs.readFileSync(providerFile) : null;
fs.writeFileSync(providerFile, JSON.stringify({ active: PID, providers: {
  [PID]: { label: "Fixture", baseUrl: "https://fixture.example.invalid", apiKey: "fixture-only", authStyle: "bearer", defaultModel: "fixture-model", fallbackModels: [{ id: "fixture-model" }] },
} }));
const cli = path.join(root, "fake-cli.sh");
const sh = fs.existsSync("/system/bin/sh") ? "/system/bin/sh" : "/bin/sh";
const big = "A".repeat(30000);
fs.writeFileSync(cli, `#!${sh}\nprintf '%s' '${big}' >&2\nprintf '\\nSTDERR-TAIL-MARKER-9137\\n' >&2\nexit 1\n`, { mode: 0o700 });
const previousPaths = { claude: PATHS.claude, loader: PATHS.loader, claudeLoader: PATHS.claudeLoader };
PATHS.claude = process.execPath;
PATHS.loader = PATHS.claudeLoader = cli;
process.env.ANTHROPIC_API_KEY = "fixture-only-do-not-forward";
const { translate } = await import("../gw/stream.mjs");
const { resolveTermCwd, _termForTest } = await import("../gw/terminal.mjs");
const { startRun } = await import("../gw/run.mjs");
const { onPublish } = await import("../gw/bus.mjs");
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("fixture must not send a request"); };
after(() => {
  globalThis.fetch = originalFetch;
  Object.assign(PATHS, previousPaths);
  if (hadProviders) fs.writeFileSync(providerFile, hadProviders); else fs.rmSync(providerFile, { force: true });
  fs.rmSync(root, { recursive: true, force: true });
});
const until = async (f, ms = 15000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error("等不到"); await new Promise((r) => setTimeout(r, 30)); } };

test("FIND-045：工具结果超过 20000 字符时带截断标记", () => {
  const out = [];
  const bigTxt = "b".repeat(20001);
  translate({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu-1", content: bigTxt }] } }, { sse: (e) => out.push(e) });
  assert.equal(out.length, 1);
  assert.equal(out[0].type, "tool_result");
  assert.equal(out[0].text.includes(bigTxt), false);
  assert.equal(out[0].text.endsWith("…（已截断）"), true, "截断没有标记：" + out[0].text.slice(-40));
  const small = [];
  translate({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu-2", content: "short" }] } }, { sse: (e) => small.push(e) });
  assert.equal(small[0].text, "short", "没超长的不该加标记");
});

test("FIND-045：终端带来的目录不存在时回落到工作区，并给出提示用的原目录", () => {
  const missing = path.join(root, "no-such-dir");
  const r = resolveTermCwd(missing);
  assert.equal(r.cwd, CFG.workspace);
  assert.equal(r.note, missing);
  const ok = resolveTermCwd(root);
  assert.equal(ok.cwd, root);
  assert.equal(ok.note, "");
  const none = resolveTermCwd(undefined);
  assert.equal(none.cwd, CFG.workspace);
  assert.equal(none.note, "");
});

test("FIND-045：终端被信号结束时按 128+信号号报", () => {
  assert.equal(_termForTest.exitCodeOf(null, "SIGKILL"), 128 + (os.constants.signals.SIGKILL || 0));
  assert.equal(_termForTest.exitCodeOf(null, "SIGTERM"), 143);
  assert.equal(_termForTest.exitCodeOf(7, null), 7);
  assert.equal(_termForTest.exitCodeOf(null, null), null);
});

test("FIND-045：回放环溢出时前端留一句已截断", () => {
  const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web", "app");
  const src = fs.readFileSync(path.join(APP, "18-terminal.js"), "utf8");
  assert.match(src, /const lost = typeof total === "number"/);
  assert.match(src, /if \(lost\) xt\.write\(/);
  assert.match(src, /t\("…（已截断）"\)/);
});

test("FIND-045：stderr 留最后一段，报错详情带上尾部", async () => {
  const id = "stab-e-stderr";
  const events = [];
  onPublish((ev) => { if (ev.runId === id) events.push(ev); });
  await startRun({ id, message: "fixture", cwd: root });
  await until(() => events.some((e) => e.type === "error" || e.type === "run_end"));
  const err = events.find((e) => e.type === "error");
  assert.ok(err, "没有报错事件");
  assert.match(err.detail || "", /STDERR-TAIL-MARKER-9137/, "报错详情里没有 stderr 尾部：" + String(err.detail).slice(-120));
});
