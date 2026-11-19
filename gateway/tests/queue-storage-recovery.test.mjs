import { CFG, PATHS } from "../gw/config.mjs";
import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";

const sid = randomUUID(), absent = randomUUID();
const root = path.join(CFG.home, "test-presence-projects"), project = path.join(root, "project"), file = path.join(project, sid + ".jsonl");
const mark = path.join(CFG.home, "ccapp-run-mark.json"), intr = path.join(CFG.home, "ccapp-interrupted.json");
const item = (id, sessionId = sid) => ({ id, sessionId, at: 1, message: "fixture: unsent" });
const setMark = (q) => fs.writeFileSync(mark, JSON.stringify({ runs: [], queue: [q] }));
const stored = () => JSON.parse(fs.readFileSync(mark, "utf8")).queue;
function rootIO() {
  const read = fs.readdirSync;
  fs.readdirSync = function(p, ...args) { if (p === root) throw Object.assign(new Error("fixture I/O failure"), { code: "EIO" }); return read.call(this, p, ...args); };
  return () => { fs.readdirSync = read; };
}
const previous = PATHS.projects;
PATHS.projects = root;
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(file, JSON.stringify({ type: "user", message: { content: "fixture" } }) + "\n");
fs.writeFileSync(intr, JSON.stringify([{ id: "fixture-interrupted", sessionId: sid }]));
// 首次导入恢复模块时也模拟目录读错；测试只操作本轮的临时目录。
const restore = rootIO();
let Q;
try { await import("../gw/providers.mjs"); Q = await import("../gw/queue.mjs"); } finally { restore(); }
const Sessions = await import("../gw/sessions.mjs");
const { RUNS, SESSIONS } = await import("../gw/runs.mjs");
const { routeRun } = await import("../gw/run.mjs");
afterEach(() => { Q.QUEUE.length = 0; RUNS.clear(); fs.rmSync(mark, { force: true }); });
after(() => { PATHS.projects = previous; fs.rmSync(intr, { force: true }); fs.rmSync(root, { recursive: true, force: true }); });

test("启动时索引读错，不丢已有的中断卡", () => {
  assert.ok(Q.INTERRUPTED.some((e) => e.id === "fixture-interrupted"));
});

// 第二次读取同一份标记不重复入队，不会在没有用户确认时开跑。
test("读不到项目根：待发正文和恢复标记保留；读通后仍只挂一条", () => {
  const q = item("recover-io"); setMark(q);
  const undo = rootIO();
  try { Q.recoverRunMark(); } finally { undo(); }
  assert.deepEqual(Q.QUEUE.map((x) => [x.id, x.message, x.held]), [[q.id, q.message, true]]);
  assert.equal(stored()[0].message, q.message);
  assert.equal(Q.snapshot().queue[0].storageHold, true);
  assert.ok(Q.RECOVER_WARNS.some((w) => w.key === "读取历史失败：{msg}"));
  Q.recoverRunMark(); Q.pump();
  assert.equal(Q.QUEUE.length, 1); assert.equal(Q.QUEUE[0].held, true); assert.equal(RUNS.size, 0);
});

test("单个项目无法探测不等于会话消失；其他项目里确实存在则胜出", () => {
  const sibling = path.join(root, "second"), other = path.join(sibling, sid + ".jsonl");
  fs.mkdirSync(sibling, { recursive: true });
  const access = fs.accessSync;
  fs.accessSync = function(p, ...args) { if (p === file) throw Object.assign(new Error("fixture permission"), { code: "EACCES" }); return access.call(this, p, ...args); };
  try {
    assert.equal(Sessions.sessionPresence(sid), "unreadable");
    const q = item("partial"); setMark(q); Q.recoverRunMark();
    assert.equal(stored()[0].id, q.id); assert.equal(Q.QUEUE[0].held, true);
    fs.writeFileSync(other, "{}\n"); assert.equal(Sessions.sessionPresence(sid), "present");
  } finally { fs.accessSync = access; fs.rmSync(sibling, { recursive: true, force: true }); }
});

test("可确认的删除仍清理；健康的历史和不带会话号的新消息正常恢复", () => {
  assert.equal(Q.sessionGone(absent), true); assert.equal(Q.sessionGone(sid), false);
  setMark(item("missing", absent)); Q.recoverRunMark();
  assert.equal(Q.QUEUE.length, 0); assert.equal(fs.existsSync(mark), false);
  fs.writeFileSync(mark, JSON.stringify({ runs: [], queue: [item("new", null), item("ok")] })); Q.recoverRunMark();
  assert.deepEqual(Q.QUEUE.map((q) => [q.id, q.held]), [["new", true], ["ok", true]]);
});

test("用户重试时存储仍不可读：重新挂起，不启动或吃掉消息", () => {
  const q = item("retry-unreadable"); Q.QUEUE.push(q);
  const undo = rootIO(); try { Q.pump(); } finally { undo(); }
  assert.equal(Q.QUEUE.length, 1); assert.equal(q.held, true); assert.equal(stored()[0].message, q.message);
  assert.equal(RUNS.has(q.id), false);
  Q.pump(); assert.equal(Q.QUEUE.length, 1, "存储恢复不等于用户要求自动发送");
});

test("本进程已经见过的会话也不能掩盖存储故障", () => {
  const q = item("known-retry"); Q.QUEUE.push(q); SESSIONS.set(sid, {});
  const undo = rootIO();
  try { Q.pump(); assert.equal(q.held, true); assert.equal(Q.QUEUE[0], q); }
  finally { undo(); SESSIONS.delete(sid); }
});

function fakeRun(id) { const r = { id, sessionId: randomUUID(), lane: "n:" + id, text: "stub", log: [], startedAt: 1 }; RUNS.set(id, r); return r; }
async function stopAt(p, body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]); req.method = "POST";
  let out; const res = { writeHead(code) { assert.equal(code, 200); }, end(data) { out = JSON.parse(data); } };
  await routeRun(req, res, new URL(p, "http://fixture.invalid"), p); return out;
}
test("本机停止和旧客户端全部停止都标出用户意图；系统中止不冒充手停", async () => {
  const one = fakeRun("local-one"), two = fakeRun("local-two");
  assert.equal((await stopAt("/api/abort", { id: one.id })).killed, true);
  assert.equal(one.userStopped, true); assert.equal(two.userStopped, undefined);
  assert.equal((await stopAt("/api/abort", {})).killed, true); assert.equal(two.userStopped, true);
  const internal = fakeRun("internal"); Q.abortRun(internal); assert.equal(internal.aborted, true); assert.notEqual(internal.userStopped, true);
});
