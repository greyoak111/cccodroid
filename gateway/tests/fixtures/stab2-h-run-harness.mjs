// stab2-h 运行级用例共用的装配：假 CLI（sh 脚本按 stream-json 吐事件）驱动真实 startRun。
// 三个 test 文件各用各的进程（node --test 逐文件跑），这里只管把它们共用的准备和工具放一份。
import { PATHS } from "../../gw/config.mjs"; // scripts/test.mjs 先隔离 HOME / fake PREFIX
import "./uc-baseline.mjs";                   // 共用 home 里前面测试留下的 ~/.claude 改动先认下，免得真起一轮时卡在确认卡片
import { after } from "node:test";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

process.env.ANTHROPIC_API_KEY = "fixture-only-do-not-forward";
process.env.ANTHROPIC_AUTH_TOKEN = "fixture-only-do-not-forward";
process.env.CCAPP_IDLE_CLOSE_MS = "200";   // 空闲收尾定时器别把测试进程拖住 2 分钟（只给测试用的开关）
export const home = process.env.CCAPP_HOME;
export const root = fs.mkdtempSync(path.join(process.env.CCAPP_WORKSPACE, "stab2h-"));
const providerFile = path.join(home, "ccapp-providers.json");
const PID = "custom-stab2h";
fs.writeFileSync(providerFile, JSON.stringify({ active: PID, providers: {
  [PID]: { label: "Fixture", baseUrl: "https://fixture.example.invalid", apiKey: "fixture-only", authStyle: "bearer", defaultModel: "fixture-model", fallbackModels: [{ id: "fixture-model" }] },
} }));
const cli = path.join(root, "fake-cli.sh");
const sh = fs.existsSync("/system/bin/sh") ? "/system/bin/sh" : "/bin/sh";
const SLEEP = ["/system/bin/sleep", "/bin/sleep", "/usr/bin/sleep"].find((p) => fs.existsSync(p));
if (!SLEEP) throw new Error("找不到 sleep，假 CLI 的等待会失效");
/** 假 CLI：按顺序吐事件；{sleep: 秒} 停一会儿；最后 exit code */
export function script(steps, code = 0) {
  const body = steps.map((s) => s.sleep ? `${SLEEP} ${s.sleep}` : `printf '%s\\n' ${JSON.stringify(JSON.stringify(s)).replace(/\$/g, "\\$")}`).join("\n");
  fs.writeFileSync(cli, `#!${sh}\n${body}\nexit ${code}\n`, { mode: 0o700 });
}
const previousPaths = { claude: PATHS.claude, loader: PATHS.loader, claudeLoader: PATHS.claudeLoader };
PATHS.claude = process.execPath;
PATHS.loader = PATHS.claudeLoader = cli;
const { startRun } = await import("../../gw/run.mjs");
const { onPublish } = await import("../../gw/bus.mjs");
const { flushUsage } = await import("../../gw/usage.mjs");
export { startRun, flushUsage };

export const events = [];
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

export const endOf = (id) => events.find((e) => e.type === "run_end" && e.runId === id);
export async function until(f, ms = 8000) { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error("等不到"); await new Promise((r) => setTimeout(r, 30)); } }

export const sid = () => crypto.randomUUID();
export const init = (s) => ({ type: "system", subtype: "init", session_id: s, model: "fixture-model", tools: [], permissionMode: "default" });
export const bg = (n) => ({ type: "system", subtype: "background_tasks_changed", tasks: Array.from({ length: n }, (_, i) => ({ task_id: "t" + i, task_type: "local_bash", description: "fixture" })) });
export const result = (i, o, extra = {}) => ({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "done", usage: { input_tokens: i, output_tokens: o }, total_cost_usd: 0, ...extra });
export const mainStart = { type: "stream_event", event: { type: "message_start", message: { id: "msg-2", usage: { input_tokens: 1, output_tokens: 0 } } } };

/** 起一轮、等它结束，返回 run_end 事件 */
export async function runWith(id, steps, code = 0) {
  script(steps, code);
  await startRun({ id, message: "fixture", cwd: root });
  await until(() => endOf(id));
  return endOf(id);
}
/** 使用统计里当前累计（按小时桶求和）：先 flushUsage 立即落盘再读 */
export const usageTotals = () => {
  const j = JSON.parse(fs.readFileSync(path.join(home, "ccapp-usage.json"), "utf8"));
  const sum = { t: 0, i: 0, o: 0 };
  for (const b of Object.values(j.hours || {})) { sum.t += b.t || 0; sum.i += b.i || 0; sum.o += b.o || 0; }
  return sum;
};
