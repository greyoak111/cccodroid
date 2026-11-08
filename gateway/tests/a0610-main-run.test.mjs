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
  "custom-a0610slow": { label: "Slow", baseUrl: "https://slow.example.invalid", modelsUrl: "https://slow.example.invalid/v1/models", apiKey: "fixture-only", authStyle: "bearer", defaultModel: "slow-model" },
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

test("199 11-07：敏感操作批准一次只放行同一个目标——同类别的另一个密钥照样问；读屏这类设备操作仍按类别", async () => {
  SETTINGS.permissionMode = "default";
  const s = crypto.randomUUID();
  const g = (id, cat, what, tool = "Read") => ({ type: "control_request", request_id: id, request: { subtype: "can_use_tool", tool_name: tool, input: { file_path: "/x" }, tool_use_id: "tu-" + id,
    decision_reason_type: "hook", decision_reason: `cccodroid-guard|${cat}|${what}` } });
  // 等 stdin 上的回应再发下一条（以前按 sleep 卡时间，全量跑负载高时批准还没落就发了下一条）：
  // 读到带那条请求号的回应为止
  const rd = (id) => ({ raw: `while read l; do case "$l" in *'"${id}"'*) break;; esac; done` });
  script([init(s), g("k-a", "secret:keys", "keys: a.json"), rd("k-a"), g("k-c", "secret:keys", "keys: a.json"), g("k-b", "secret:keys", "keys: b.json"), rd("k-b"),
    g("d-a", "device:screen", "screen_tap", "mcp__device__screen_tap"), rd("d-a"), g("d-b", "device:screen", "screen_read", "mcp__device__screen_read"), rd("d-b"), result], 0);
  await startRun({ id: "a0610-guardkey", message: "fixture", cwd: root, permissionMode: "default" });
  // 只看这一轮的：上一条测试插话排进队列的那轮也在跑同一个假 CLI，请求号一样
  const asked = (id) => events.some((e) => e.type === "perm_request" && e.id === id && e.runId === "a0610-guardkey");
  await until(() => asked("k-a"));
  RUNS.get("a0610-guardkey").answerPerm("k-a", { behavior: "allow" });
  await until(() => asked("d-a"), 5000);
  RUNS.get("a0610-guardkey").answerPerm("d-a", { behavior: "allow" });
  await until(() => endOf("a0610-guardkey"), 10000);
  assert.equal(asked("k-c"), false, "同一个目标不再问");
  assert.equal(asked("k-b"), true, "同类别的另一个密钥要问");
  assert.equal(asked("d-b"), false, "读屏点按一连串按类别放行");
});

test("200-S-10：提醒没送到模型（没答完就退出）放回去，下一轮再带；定时任务不取不分会话的提醒；答完才算交出去", async () => {
  const { tamperNote, tamperRecord } = await import("../gw/tamper.mjs");
  const { putPathNote, takePathNote } = await import("../gw/pathnote.mjs");
  tamperNote();                                      // 清掉别的测试留下的
  tamperRecord("runtime", ["s10-probe.json"]);
  const sid = crypto.randomUUID();
  putPathNote(sid, "Path note: s10");
  script([init(sid)], 1);                            // 起来了、没出 result 就退出
  await startRun({ id: "a0610-s10a", message: "fixture", cwd: root, sessionId: sid });
  await until(() => endOf("a0610-s10a"));
  assert.equal(endOf("a0610-s10a").failed, true);
  script([init(sid), result], 0);
  await startRun({ id: "a0610-s10b", message: "fixture", cwd: root, sessionId: sid, unattended: true });
  await until(() => endOf("a0610-s10b"));
  assert.equal(takePathNote(sid), "", "同一会话的路径提醒：定时任务那轮答完就交出去了");
  assert.match(tamperNote(), /s10-probe\.json/, "失败那轮放回来了，定时任务那轮没取");
});

test("200-7-07：起进程前的等待（这里是拉另一家的模型清单）还没回来时点停止 → 立刻收尾，不等它，也不再起进程", async () => {
  const { abortRun } = await import("../gw/queue.mjs");
  let release;
  const prev = globalThis.fetch;
  globalThis.fetch = () => new Promise((_, rej) => { release = () => rej(new Error("late")); });
  try {
    script([{ raw: `: > ${root}/ran-707` }, init(crypto.randomUUID()), result], 0);
    const p = startRun({ id: "a0610-707", message: "fixture", cwd: root, pin: { provider: "custom-a0610slow" } });
    await until(() => release);
    const t0 = Date.now();
    abortRun(RUNS.get("a0610-707"));
    await until(() => endOf("a0610-707"), 2000);
    assert.ok(Date.now() - t0 < 1000, "不等那个请求回来");
    release();
    await p;
    assert.equal(events.filter((e) => e.type === "run_end" && e.runId === "a0610-707").length, 1);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(fs.existsSync(path.join(root, "ran-707")), false, "等待回来后不再起进程");
  } finally { globalThis.fetch = prev; }
});

test("200-7-08：换厂商时桥还没换完上游 → 新起的轮次等它换完再起进程", async () => {
  const { beginBridgeSwitch } = await import("../gw/claude.mjs");
  const done = beginBridgeSwitch();
  script([{ raw: `: > ${root}/ran-708` }, init(crypto.randomUUID()), result], 0);
  const p = startRun({ id: "a0610-708", message: "fixture", cwd: root });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(fs.existsSync(path.join(root, "ran-708")), false, "换完之前不起");
  done();
  await p;
  await until(() => endOf("a0610-708"));
  assert.equal(endOf("a0610-708").subtype, "success");
});

test("195-K.1：指定的工作目录不在了 → 这一轮不跑、报出来，不悄悄换到工作区", async () => {
  script([{ raw: `: > ${root}/ran-k1` }, init(crypto.randomUUID()), result], 0);
  await startRun({ id: "a0610-k1", message: "fixture", cwd: path.join(root, "gone-dir") });
  await until(() => endOf("a0610-k1"));
  assert.equal(endOf("a0610-k1").failed, true);
  assert.ok(events.some((e) => e.type === "error" && /gone-dir/.test(e.message || "")));
  assert.equal(fs.existsSync(path.join(root, "ran-k1")), false);
});

test("195-O.1/O.4：接口账本跟着运行中的计量记——没出 result 就被结束的那轮、子代理的都记上", async () => {
  const P = await import("../gw/providers.mjs");
  const tok = () => P._billForTest.billOf(PID).tok.reduce((a, r) => [a[0] + r[1], a[1] + r[2], a[2] + r[3]], [0, 0, 0]);
  const t0 = tok();
  const se = (event, parent = null) => ({ type: "stream_event", event, parent_tool_use_id: parent, session_id: "x" });
  script([init(crypto.randomUUID()),
    se({ type: "message_start", message: { id: "mm1", usage: { input_tokens: 100, cache_read_input_tokens: 40, output_tokens: 1 } } }),
    se({ type: "message_delta", usage: { output_tokens: 30 } }),
    se({ type: "message_start", message: { id: "sub1", model: "m", usage: { input_tokens: 7, output_tokens: 5 } } }, "tu-agent")], 1);
  await startRun({ id: "a0610-o1", message: "fixture", cwd: root });
  await until(() => endOf("a0610-o1"));
  const t1 = tok();
  assert.deepEqual([t1[0] - t0[0], t1[1] - t0[1], t1[2] - t0[2]], [107, 35, 40]);
});

test("195-R.1：「继续」那轮没答出来 → 中断记录留着（卡片还在）；答出来了才撤", async () => {
  const Q = await import("../gw/queue.mjs");
  const sid = crypto.randomUUID();
  Q.setInterrupted([{ id: "r1-intr", sessionId: sid, text: "x", startedAt: 1 }]);
  script([init(sid)], 1);
  await startRun({ id: "a0610-r1a", message: "fixture", cwd: root, sessionId: sid });
  await until(() => endOf("a0610-r1a"));
  assert.ok(Q.INTERRUPTED.some((e) => e.id === "r1-intr"), "没答出来：留着");
  script([init(sid), result], 0);
  await startRun({ id: "a0610-r1b", message: "fixture", cwd: root, sessionId: sid });
  await until(() => endOf("a0610-r1b"));
  assert.ok(!Q.INTERRUPTED.some((e) => e.id === "r1-intr"), "答出来了：撤掉");
});

// 放最后：它留下的后台 sleep 30 还活着时，后面的轮次会先弹「用户配置」确认卡
test("F6：首字前分段——起进程发「启动中」，claude init 后发「连接中」(from init)，只发一次", async () => {
  const sid = crypto.randomUUID();
  const ms = { type: "stream_event", event: { type: "message_start", message: { usage: { input_tokens: 1 } } }, session_id: sid };
  script([{ sleep: "0.2" }, init(sid), ms, init(sid), result], 0);
  await startRun({ id: "a0610-phase", message: "fixture", cwd: root });
  await until(() => endOf("a0610-phase"));
  const ph = events.filter((e) => e.runId === "a0610-phase" && e.type === "phase").map((e) => e.phase + (e.from ? "@" + e.from : ""));
  assert.deepEqual(ph.slice(0, 3), ["boot", "connect@init", "wait"]);
  assert.equal(ph.filter((p) => p === "connect@init").length, 1, "第二次 init 不再发");
  const run = events.findIndex((e) => e.runId === "a0610-phase" && e.type === "run_start"), boot = events.findIndex((e) => e.runId === "a0610-phase" && e.phase === "boot");
  assert.ok(run >= 0 && boot > run, "run_start 在前，boot 在后");
});

// 放最后：它留下的后台 sleep 会让之后的轮次起进程前先弹「留下的进程」确认卡，没人答就一直等
test("195-T.1：claude 退出了、后台子孙还攥着输出管道 → 5 秒后自己收尾，不永远「生成中」", async () => {
  script([init(crypto.randomUUID()), result, { raw: `${SLEEP} 30 &` }], 0);
  const t0 = Date.now();
  await startRun({ id: "a0610-held", message: "fixture", cwd: root });
  await until(() => endOf("a0610-held"), 12000);
  assert.ok(Date.now() - t0 < 12000);
  assert.equal(endOf("a0610-held").subtype, "success");
});

