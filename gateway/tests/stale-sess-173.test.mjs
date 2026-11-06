// 会话进了回收站之后各处的旧引用（#173）+ 定时任务剩余项（#178-7/8）
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { CFG } from "../gw/config.mjs";
import { NEXT } from "../gw/http.mjs";

const { PROJECTS } = await import("../gw/projects.mjs");
const { _schedForTest: S, routeSched } = await import("../gw/sched.mjs");
const { QUEUE, END_HOOKS, INTERRUPTED, setInterrupted } = await import("../gw/queue.mjs");
const { RUNS, maxParallel } = await import("../gw/runs.mjs");
const { trashSession } = await import("../gw/sessionops.mjs");
const { routeSessions } = await import("../gw/sessions.mjs");
const bus = await import("../gw/bus.mjs");

const route = (fn) => http.createServer(async (req, res) => { const u = new URL(req.url, "http://x"); if ((await fn(req, res, u, u.pathname)) === NEXT) res.writeHead(404).end(); });
const srvS = route(routeSched), srvH = route(routeSessions);
for (const s of [srvS, srvH]) await new Promise((ok) => s.listen(0, "127.0.0.1", ok));
after(() => { srvS.close(); srvH.close(); });
const url = (s, p) => `http://127.0.0.1:${s.address().port}${p}`;

const proj = path.join(CFG.home, ".claude", "projects", "-i173");
fs.mkdirSync(proj, { recursive: true });
const session = () => {
  const sid = crypto.randomUUID();
  fs.writeFileSync(path.join(proj, sid + ".jsonl"), JSON.stringify({ type: "user", sessionId: sid, uuid: crypto.randomUUID(), message: { role: "user", content: "hi" } }) + "\n");
  return sid;
};
const dir = path.join(CFG.workspace, "i173");
fs.mkdirSync(dir, { recursive: true });
PROJECTS.push({ id: "i173p", name: "i173", path: dir, model: "", effort: "", perm: "", provider: "" });
const fake = [];
for (let i = 0; i < maxParallel(); i++) { const id = "i173-busy" + i; fake.push(id); RUNS.set(id, { id, text: "", startedAt: Date.now(), log: [], idle: false, ended: false, lane: "y:" + i }); }
const allow0 = S.DB.allowLogin; S.DB.allowLogin = true;
const taskIds = [];
after(() => {
  S.DB.allowLogin = allow0;
  for (const id of fake) RUNS.delete(id);
  S.DB.tasks = S.DB.tasks.filter((t) => !taskIds.includes(t.id));
  const i = PROJECTS.findIndex((p) => p.id === "i173p"); if (i >= 0) PROJECTS.splice(i, 1);
  setInterrupted([]);
});
let n = 0;
const mk = (over = {}) => {
  const t = { id: "i173-" + (++n), name: "t" + n, prompt: "做事", on: true, freq: { kind: "once" }, nextAt: null, busy: "run", session: "new", lastSid: null, projectId: "i173p", perm: "read", ...over };
  S.DB.tasks.push(t); taskIds.push(t.id); return t;
};
const unqueue = (it) => { if (it && QUEUE.includes(it)) QUEUE.splice(QUEUE.indexOf(it), 1); };

test("回收会话：清掉它的中断记录、广播 session_gone；打开它回 404 并说在回收站", async () => {
  const sid = session(), keep = session();
  setInterrupted([{ id: "r1", sessionId: sid, text: "x", at: 1 }, { id: "r2", sessionId: keep, text: "y", at: 2 }, { id: "r3", sessionId: null, text: "z", at: 3 }]);
  const seen = [];
  const off = bus.onPublish((e) => seen.push(e));
  assert.equal(trashSession(sid).ok, true);
  off();
  assert.ok(seen.some((e) => e.type === "session_gone" && e.id === sid), "界面要收到 session_gone");
  const { INTERRUPTED: now } = await import("../gw/queue.mjs");
  assert.deepEqual(now.map((e) => e.id), ["r2", "r3"]);
  const r = await fetch(url(srvH, "/api/session/" + sid));
  assert.equal(r.status, 404);
  assert.equal((await r.json()).trashed, true);
  const r2 = await (await fetch(url(srvH, "/api/session/" + crypto.randomUUID()))).json();
  assert.equal(r2.trashed, false);
});

test("接着同一个对话、那个对话被回收了：任务放下 lastSid 标出来，下次新开，不再 --resume 失败（#173-3）", async () => {
  const sid = session();
  const t = mk({ session: "same", lastSid: sid });
  trashSession(sid);
  assert.equal(t.lastSid, null);
  assert.equal(t.lostSid, sid);
  const it = await S.fire(t, { reason: "manual" });
  assert.equal(it.sessionId, null);
  unqueue(it);
  // 文件没了但钩子没走到（比如手动删的）：开跑前也会查
  const t2 = mk({ session: "same", lastSid: crypto.randomUUID() });
  const it2 = await S.fire(t2, { reason: "manual" });
  assert.equal(it2.sessionId, null);
  assert.ok(t2.lostSid);
  unqueue(it2);
});

test("不存成对话：运行记录和通知不再指向回收掉的会话，完整结果从详情接口拿得到（#173-1/2）；接着同一个对话的不回收", async () => {
  const sid = session();
  const t = mk({ saveSession: false });
  const it = await S.fire(t, { reason: "manual" });
  unqueue(it);
  const text = "第一行\n第二行\n第三行";
  for (const h of END_HOOKS) h({ sched: it.sched, sessionId: sid, denied: [] }, { costRaw: 0, finalText: text });
  const d = await (await fetch(url(srvS, "/api/sched/" + t.id))).json();
  assert.equal(d.runs[0].sid, null);
  assert.equal(d.runs[0].full, text);
  assert.ok(!fs.existsSync(path.join(proj, sid + ".jsonl")), "会话照样进了回收站");
  const sid2 = session();
  const t2 = mk({ saveSession: false, session: "same" });
  const it2 = await S.fire(t2, { reason: "manual" });
  unqueue(it2);
  for (const h of END_HOOKS) h({ sched: it2.sched, sessionId: sid2, denied: [] }, { costRaw: 0, finalText: "ok" });
  assert.ok(fs.existsSync(path.join(proj, sid2 + ".jsonl")), "接着同一个对话的留着，下次还要接");
  assert.equal(t2.lastSid, sid2);
});

test("项目删了：任务到点跳过并说明，不退回工作区跑（#178-7）；正在跑的任务不让删（#178-8）", async () => {
  const t = mk({ projectId: "i173-gone", perm: "proj" });
  const it = await S.fire(t, { reason: "manual" });
  assert.equal(it, undefined);
  const last = S.runlog().filter((r) => r.taskId === t.id).pop();
  assert.equal(last.st, "skip");
  assert.match(last.msg, /项目已经删掉了/);
  const t2 = mk();
  const it2 = await S.fire(t2, { reason: "manual" });
  const r = await fetch(url(srvS, "/api/sched/" + t2.id), { method: "DELETE" });
  assert.equal(r.status, 409);
  unqueue(it2);
});
