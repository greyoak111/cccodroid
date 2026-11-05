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
  const body = steps.map((s) => s.raw ? s.raw : s.sleep ? `${SLEEP} ${s.sleep}` : `printf '%s\\n' ${JSON.stringify(JSON.stringify(s)).replace(/\$/g, "\\$")}`).join("\n");
  fs.writeFileSync(cli, `#!${sh}\n${body}\nexit ${code}\n`, { mode: 0o700 });
}
const previousPaths = { claude: PATHS.claude, loader: PATHS.loader, claudeLoader: PATHS.claudeLoader };
PATHS.claude = process.execPath;
PATHS.loader = PATHS.claudeLoader = cli;
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

// ── 斜杠命令插话（11-05）：答完了只剩后台任务时，/compact 这类直接送进 claude，不再等后台任务全结束 ──
const stdinLog = path.join(root, "stdin.jsonl");
const tapStdin = { raw: `exec 3<&0; cat <&3 > '${stdinLog}' &` };   // 录下网关写进 stdin 的（非交互 sh 的后台任务默认 stdin 是 /dev/null，要显式重定向）
const echo = (t) => ({ type: "user", isReplay: true, message: { role: "user", content: [{ type: "text", text: t }] } });
const userText = (l) => { const c = JSON.parse(l).message.content; return typeof c === "string" ? c : c.filter((x) => x.type === "text").map((x) => x.text).join(""); };

test("斜杠命令：只剩后台任务时直接插进去，当场画出来；/compact 的回显吞掉，result 之后回到空闲", async () => {
  const s = crypto.randomUUID();
  script([tapStdin, init(s), echo("fixture"), bg(1, "server"), result(), { sleep: 2 },
    { type: "system", subtype: "status", status: "compacting" },
    init(s),
    { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 5000, post_tokens: 800 } },
    { type: "user", isReplay: true, message: { role: "user", content: "<local-command-stdout>Compacted </local-command-stdout>" } },
    { ...result(), result: "" },
    { sleep: 30 }]);
  await startRun({ id: "rslash", message: "fixture", cwd: root });
  const run = RUNS.get("rslash");
  await until(() => run.idle && run.bgTasks === 1);
  const it = enqueue({ message: "/compact", sessionId: s });
  assert.equal(it.injected, true, "空闲时斜杠命令直接插进去");
  assert.equal(QUEUE.includes(it), false);
  assert.equal(run.idle, false, "送进去就算新的一轮");
  const mine = () => events.filter((e) => e.runId === "rslash");
  const iInj = mine().findIndex((e) => e.type === "inject" && e.text === "/compact");
  assert.ok(iInj >= 0, "写进去就发 inject，不等回显");
  assert.ok(mine().findIndex((e) => e.type === "run_busy") > iInj, "先画消息再报生成中");
  await until(() => run.idle && mine().some((e) => e.type === "compacted"));
  assert.ok(mine().findIndex((e) => e.type === "compacted") > iInj, "压缩结果画在命令下面");
  assert.equal(mine().filter((e) => e.type === "inject").length, 1, "回显吞掉，不再画一遍");
  assert.equal(run.slashFlight.length, 0);
  assert.equal(run.pendingInject.length, 0);
  assert.equal(run.inputOpen, true, "后台任务还在：输入留着");
  await until(() => fs.existsSync(stdinLog) && fs.readFileSync(stdinLog, "utf8").split("\n").filter(Boolean).length >= 2);
  const lines = fs.readFileSync(stdinLog, "utf8").split("\n").filter(Boolean);
  assert.equal(userText(lines[1]), "/compact", "命令原样写进去，不带提醒和附注");
  // 回到空闲后普通消息照旧能插
  const it2 = enqueue({ message: "接着说", sessionId: s });
  assert.equal(it2.injected, true);
  abortRun(run);
  await until(() => endOf("rslash"));
});

test("斜杠命令：还在生成时照旧排队；网关自己处理的命令（/model 等）空闲时也不插", async () => {
  const s = crypto.randomUUID();
  script([init(s), mainStart, { sleep: 30 }]);
  await startRun({ id: "rslash-busy", message: "fixture", cwd: root });
  const run = RUNS.get("rslash-busy");
  await until(() => run.inputOpen && run.inject && run.sessionId === s && !run.idle);
  const a = enqueue({ message: "/compact", sessionId: s, mode: "inject" });
  assert.equal(!!a.injected, false, "生成中不插斜杠命令");
  assert.ok(QUEUE.includes(a));
  QUEUE.splice(QUEUE.indexOf(a), 1);
  abortRun(run);
  await until(() => endOf("rslash-busy"));

  const s2 = crypto.randomUUID();
  script([init(s2), bg(1, "server"), result(), { sleep: 30 }]);
  await startRun({ id: "rslash-local", message: "fixture", cwd: root });
  const run2 = RUNS.get("rslash-local");
  await until(() => run2.idle && run2.bgTasks === 1);
  for (const m of ["/model fixture-model", "/MODEL fixture-model", "/effort high", "/autocompact 50"]) {
    const b = enqueue({ message: m, sessionId: s2 });
    assert.equal(!!b.injected, false, m);
    QUEUE.splice(QUEUE.indexOf(b), 1);
  }
  run2.unattended = true;            // 定时任务那一轮：用户的命令不往里插（复核 v067b-6）
  const c = enqueue({ message: "/compact", sessionId: s2 });
  assert.equal(!!c.injected, false, "无人值守的轮次不收命令");
  QUEUE.splice(QUEUE.indexOf(c), 1);
  abortRun(run2);
  await until(() => endOf("rslash-local"));
});

test("斜杠命令：不回显的（/cost /context）靠 result 收尾，之后普通插话的回显照常对上", async () => {
  const s = crypto.randomUUID();
  script([init(s), echo("fixture"), bg(1, "server"), result(), { sleep: 2 },
    init(s), { type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text: "Total cost: $0" }] } }, result(),
    { sleep: 2 },
    init(s), echo("接着说"), result(),
    { sleep: 30 }]);
  await startRun({ id: "rslash-cost", message: "fixture", cwd: root });
  const run = RUNS.get("rslash-cost");
  await until(() => run.idle && run.bgTasks === 1);
  assert.equal(enqueue({ message: "/cost", sessionId: s }).injected, true);
  await until(() => run.idle && run.slashFlight.length === 0);
  assert.ok(events.some((e) => e.runId === "rslash-cost" && e.type === "assistant_text" && /Total cost/.test(e.text)), "命令输出照常画出来：" + JSON.stringify(events.filter((e) => e.runId === "rslash-cost").map((e) => e.type + ":" + (e.text || "").slice(0, 20))));
  assert.equal(enqueue({ message: "接着说", sessionId: s }).injected, true);
  await until(() => run.pendingInject.length === 0 && events.some((e) => e.runId === "rslash-cost" && e.type === "inject" && e.text === "接着说"));
  abortRun(run);
  await until(() => endOf("rslash-cost"));
});

test("复核 v067b-1：没有命令在途时，以 <local-command- 开头的普通插话照常算送达，不被当成命令回显吞掉", async () => {
  const s = crypto.randomUUID();
  const t = "<local-command-stdout>报错原文</local-command-stdout> 这是什么意思";
  script([init(s), echo("fixture"), mainStart, { sleep: 2 }, echo(t), result(), { sleep: 30 }]);
  await startRun({ id: "rslash-fake", message: "fixture", cwd: root });
  const run = RUNS.get("rslash-fake");
  await until(() => run.inputOpen && run.inject && run.sessionId === s && !run.idle);
  assert.equal(enqueue({ message: t, sessionId: s, mode: "inject" }).injected, true);
  await until(() => events.some((e) => e.runId === "rslash-fake" && e.type === "inject" && e.text === t));
  await until(() => !run.inputOpen);
  assert.equal(run.pendingInject.length, 0, "送达了，result 之后照常收尾");
  abortRun(run);
  await until(() => endOf("rslash-fake"));
});

test("复核 v067b-3：命令在途时后台任务先回报一轮，那个 result 不认领命令、不关输入", async () => {
  const s = crypto.randomUUID();
  script([init(s), echo("fixture"), bg(1, "server"), result(), { sleep: 2 },
    bg(0), mainStart, result(),                                  // 后台任务跑完，claude 回报一轮
    { sleep: 2 },
    { type: "system", subtype: "status", status: "compacting" },
    { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 5000, post_tokens: 800 } },
    { type: "user", isReplay: true, message: { role: "user", content: "<local-command-stdout>Compacted </local-command-stdout>" } },
    { ...result(), result: "" },
    { sleep: 30 }]);
  await startRun({ id: "rslash-bg", message: "fixture", cwd: root });
  const run = RUNS.get("rslash-bg");
  await until(() => run.idle && run.bgTasks === 1);
  assert.equal(enqueue({ message: "/compact", sessionId: s }).injected, true);
  await until(() => run.bgTasks === 0);
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(run.slashFlight.length, 1, "回报那一轮的 result 不算命令的");
  assert.equal(run.inputOpen, true, "命令还没办完，输入留着");
  await until(() => run.slashFlight.length === 0);
  await until(() => !run.inputOpen);
  abortRun(run);
  await until(() => endOf("rslash-bg"));
});

test("复核 v067b-2/5：命令在途时落盘挂起；没等到 result 进程就退了退回队首挂起；命令的 result 不把整轮画成命令卡", async () => {
  const s = crypto.randomUUID();
  script([init(s), echo("fixture"), bg(1, "server"), result(), { sleep: 2 }]);
  await startRun({ id: "rslash-lost", message: "fixture", cwd: root });
  const run = RUNS.get("rslash-lost");
  await until(() => run.idle && run.bgTasks === 1);
  const it = enqueue({ message: "/compact", sessionId: s });
  assert.equal(it.injected, true);
  const mark = JSON.parse(fs.readFileSync(path.join(home, "ccapp-run-mark.json"), "utf8"));
  assert.ok(mark.queue.some((q) => q.id === it.id && q.held), "在途的命令进了落盘快照，挂起");
  await until(() => endOf("rslash-lost"));
  const back = QUEUE.find((q) => q.id === it.id);
  assert.ok(back && back.held && !back.injected, "退回队首、挂起等用户点");
  QUEUE.splice(QUEUE.indexOf(back), 1);

  const s2 = crypto.randomUUID();
  script([init(s2), echo("fixture"), bg(1, "server"), result(), { sleep: 2 },
    bg(0), { type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text: "Total cost: $0" }] } }, { ...result(), local_command: "cost" }]);
  await startRun({ id: "rslash-lc", message: "fixture", cwd: root });
  const run2 = RUNS.get("rslash-lc");
  await until(() => run2.idle && run2.bgTasks === 1);
  assert.equal(enqueue({ message: "/cost", sessionId: s2 }).injected, true);
  await until(() => endOf("rslash-lc"));
  assert.equal(run2.slashFlight.length, 0, "后台任务变了但命令有输出：照认");
  assert.ok(!endOf("rslash-lc").localCommand, JSON.stringify(endOf("rslash-lc")));
  assert.ok(!endOf("rslash-lc").failed);
});

test("复核 v067c 中-2：没动静的命令自己起又停了后台任务，最多让一次，不会永远挂着", async () => {
  const s = crypto.randomUUID();
  script([init(s), echo("fixture"), bg(1, "server"), result(), { sleep: 2 },
    bg(2, "server"), result(),                 // 命令的轮次里又起了一个后台任务，然后答完（没回显、没输出）
    { sleep: 1 }, bg(1, "server"), mainStart, result(),   // 那个后台任务跑完，回报一轮
    { sleep: 30 }]);
  await startRun({ id: "rslash-yield", message: "fixture", cwd: root });
  const run = RUNS.get("rslash-yield");
  await until(() => run.idle && run.bgTasks === 1);
  assert.equal(enqueue({ message: "/mycmd", sessionId: s }).injected, true);
  await until(() => run.bgTasks === 2);
  await until(() => run.slashFlight.length === 0 && run.idle && run.bgTasks === 1, 8000);
  assert.equal(run.inputOpen, true);
  abortRun(run);
  await until(() => endOf("rslash-yield"));
});
