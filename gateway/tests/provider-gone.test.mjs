// 要用的接口不在了（写错、删了）：不悄悄回落到全局默认那家（本机全局常是订阅账户），当场拒 / 不起跑 / 定时任务跳过
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { CFG } from "../gw/config.mjs";
import { NEXT } from "../gw/http.mjs";

const { routeQueue, QUEUE } = await import("../gw/queue.mjs");
const { lostProvider } = await import("../gw/run.mjs");
const { setSessModel, clearSessModel, sessLostProvider } = await import("../gw/sessmodel.mjs");
const { PROVIDER } = await import("../gw/providers.mjs");
const { _schedForTest: S } = await import("../gw/sched.mjs");

const srv = http.createServer(async (req, res) => { const u = new URL(req.url, "http://x"); if ((await routeQueue(req, res, u, u.pathname)) === NEXT) res.writeHead(404).end(); });
await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
after(() => srv.close());
const chat = async (b) => { const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/chat`, { method: "POST", body: JSON.stringify(b) }); return { status: r.status, j: await r.json() }; };

const proj = path.join(CFG.home, ".claude", "projects", "-pgone");
fs.mkdirSync(proj, { recursive: true });
const session = () => {
  const sid = crypto.randomUUID();
  fs.writeFileSync(path.join(proj, sid + ".jsonl"), JSON.stringify({ type: "user", sessionId: sid, uuid: crypto.randomUUID(), message: { role: "user", content: "hi" } }) + "\n");
  return sid;
};

test("新会话 pin 了个不存在的接口（拼错）：409，不进队列", async () => {
  const n0 = QUEUE.length;
  const { status, j } = await chat({ message: "审核材料", pin: { provider: "deepsek", model: "deepseek-v4-pro" } });
  assert.equal(status, 409);
  assert.equal(j.error, "provider_gone");
  assert.match(j.message, /deepsek/);
  assert.equal(QUEUE.length, n0, "没进队列");
});

test("会话钉的那家删掉了：409；在模型面板换一家（或重置）后放行", async () => {
  const sid = session();
  setSessModel(sid, { model: "m1", provider: "zz-deleted" });
  assert.equal(sessLostProvider(sid), "zz-deleted");
  const { status, j } = await chat({ message: "接着说", sessionId: sid });
  assert.equal(status, 409);
  assert.match(j.message, /zz-deleted/);
  setSessModel(sid, { provider: PROVIDER.id });
  assert.equal(sessLostProvider(sid), "");
  assert.equal(lostProvider({ sessionId: sid }, sid, {}), "");
  clearSessModel(sid);
});

test("起跑时再挡一次：定时任务指定的 / 项目默认的那家不在了", () => {
  assert.match(lostProvider({ provider: "zz-gone" }, null, {}), /zz-gone/);
  assert.match(lostProvider({}, null, { provider: "zz-proj-gone" }), /项目默认/);
  assert.equal(lostProvider({}, null, {}), "", "什么都没指定：照常用全局");
  assert.equal(lostProvider({ pin: { provider: PROVIDER.id } }, null, {}), "");
});

test("定时任务指定的接口删了：到点跳过并通知，不换成全局默认那家跑", async () => {
  const t = { id: "pg-" + Date.now(), name: "pg", prompt: "做事", on: true, freq: { kind: "once" }, nextAt: null, busy: "run", session: "new", lastSid: null, projectId: null, perm: "read", provider: "zz-gone" };
  S.DB.tasks.push(t);
  try {
    const it = await S.fire(t, { reason: "manual" });
    assert.equal(it, undefined);
    const last = S.runlog().filter((r) => r.taskId === t.id).pop();
    assert.equal(last.st, "skip");
    assert.match(last.msg, /接口已经删掉了/);
  } finally { S.DB.tasks = S.DB.tasks.filter((x) => x !== t); }
});
