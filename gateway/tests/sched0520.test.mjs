// 定时任务的订阅许可门禁（审查 v0.5.20 03-013）：门禁和真跑必须认同一家。
// 项目默认是 API 接口、接着的那个会话钉在官方账户（订阅）时，没打开「允许用订阅账户跑」就不能跑
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { CFG } from "../gw/config.mjs";

const { routeProviders, providerById } = await import("../gw/providers.mjs");
const { PROJECTS } = await import("../gw/projects.mjs");
const { setSessModel } = await import("../gw/sessmodel.mjs");
const { isLoginMode } = await import("../gw/models.mjs");
const { _schedForTest: S } = await import("../gw/sched.mjs");
const { QUEUE, START_GUARDS } = await import("../gw/queue.mjs");
const { RUNS, maxParallel } = await import("../gw/runs.mjs");

const srv = http.createServer(async (req, res) => { const u = new URL(req.url, "http://x"); await routeProviders(req, res, u, u.pathname); });
await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
const api = await (await fetch(`http://127.0.0.1:${srv.address().port}/api/providers/save`, { method: "POST", body: JSON.stringify({ label: "S0520", baseUrl: "https://s0520.invalid", apiKey: "k-fixture", defaultModel: "m" }) })).json();
const dir = path.join(CFG.workspace, "s0520proj"); fs.mkdirSync(dir, { recursive: true });
PROJECTS.push({ id: "s0520p", name: "s0520", path: dir, model: "", effort: "", perm: "", provider: api.id });
// 并行占满：入队的条目只留在队列里，不会真起 claude
const fake = [];
for (let i = 0; i < maxParallel(); i++) { const id = "s0520-busy" + i; fake.push(id); RUNS.set(id, { id, text: "", startedAt: Date.now(), log: [], idle: false, ended: false, lane: "x:" + i }); }
const allow0 = S.DB.allowLogin;
after(() => {
  S.DB.allowLogin = allow0;
  for (const id of fake) RUNS.delete(id);
  PROJECTS.splice(PROJECTS.findIndex((p) => p.id === "s0520p"), 1);
  srv.close();
});
const mk = (id, sid) => { const t = { id, name: id, prompt: "做事", on: true, freq: { kind: "once" }, nextAt: null, busy: "run", session: "same", lastSid: sid, projectId: "s0520p", perm: "read" }; S.DB.tasks.push(t); return t; };
const drop = (t, it) => { if (it && QUEUE.includes(it)) QUEUE.splice(QUEUE.indexOf(it), 1); S.DB.tasks.splice(S.DB.tasks.indexOf(t), 1); };

test("前提：官方账户没填 Key 是订阅登录，项目默认那家不是", () => {
  assert.equal(isLoginMode(providerById("anthropic")), true);
  assert.equal(isLoginMode(providerById(api.id)), false);
});

test("会话钉了官方账户、项目默认 API：没许可就跳过，许可了才入队", async () => {
  const sid = crypto.randomUUID();
  setSessModel(sid, { provider: "anthropic" });
  S.DB.allowLogin = false;
  const t = mk("s0520-a", sid);
  const it = await S.fire(t, { reason: "due" });
  assert.ok(!it || !QUEUE.includes(it), "没许可不该入队");
  assert.equal(S.runlog().filter((r) => r.taskId === t.id).at(-1)?.st, "skip");
  S.DB.allowLogin = true;
  const it2 = await S.fire(t, { reason: "manual" });
  assert.ok(it2 && QUEUE.includes(it2), "许可了照常入队");
  drop(t, it2);
});

test("入队后会话被改钉到官方账户：开跑前再核一次，拦下", async () => {
  const sid = crypto.randomUUID();
  S.DB.allowLogin = false;
  const t = mk("s0520-b", sid);
  const it = await S.fire(t, { reason: "due" });
  assert.ok(it && QUEUE.includes(it), "走项目默认的 API：照常入队");
  assert.equal(START_GUARDS.every((g) => g(it) !== false), true, "没改钉：放行");
  setSessModel(sid, { provider: "anthropic" });
  assert.equal(START_GUARDS.every((g) => g(it) !== false), false, "改钉成订阅：拦下");
  drop(t, it);
});
