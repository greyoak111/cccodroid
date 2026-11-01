// 并行时一次断好几轮：每个会话都要有自己的中断记录与「继续」卡（群友 Yhaizg 11-01：升级时三个会话在跑，只提示了一个）
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { CFG } from "../gw/config.mjs";
import { NEXT } from "../gw/http.mjs";
import * as Q from "../gw/queue.mjs";

const MARK = path.join(CFG.home, "ccapp-run-mark.json"), INTR = path.join(CFG.home, "ccapp-interrupted.json");
const sid = (n) => `0000000${n}-0000-4000-8000-000000000000`;

test("三轮同时被结束：三条中断记录各归各的会话，没建会话的那轮也留着", () => {
  Q.setInterrupted([]);
  fs.writeFileSync(MARK, JSON.stringify({ runs: [
    { id: "r1", sessionId: sid(1), text: "一", startedAt: 1 },
    { id: "r3", sessionId: sid(3), text: "三", startedAt: 3 },
    { id: "r2", sessionId: sid(2), text: "二", startedAt: 2 },
    { id: "r4", text: "还没建会话", startedAt: 4 },
    { id: "r5", sessionId: sid(5), text: "答完了只等后台", startedAt: 5, done: true },
  ], queue: [] }));
  Q.recoverRunMark();
  assert.deepEqual(Q.INTERRUPTED.map((e) => e.id), ["r1", "r2", "r3", "r4"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(INTR, "utf8")).map((e) => e.id), ["r1", "r2", "r3", "r4"]);
  assert.deepEqual(Q.snapshot().interrupted.map((e) => e.sessionId || ""), [sid(1), sid(2), sid(3), ""]);
  assert.equal(fs.existsSync(MARK), false);
});

test("再断一次：上次没处理的留着，同一会话以新的为准", () => {
  fs.writeFileSync(MARK, JSON.stringify({ runs: [{ id: "r2b", sessionId: sid(2), text: "二又断", startedAt: 9 }], queue: [] }));
  Q.recoverRunMark();
  assert.deepEqual(Q.INTERRUPTED.map((e) => e.id), ["r1", "r3", "r4", "r2b"]);
});

test("某个会话接着跑起来只清它自己的；忽略按 id 只去一条，不带 id 全清（旧界面）", async () => {
  Q.clearInterrupted(sid(1));
  assert.deepEqual(Q.INTERRUPTED.map((e) => e.id), ["r3", "r4", "r2b"]);
  Q.clearInterrupted(undefined);            // 新开一个还没会话的轮次：清掉没建会话的那条（与旧行为一致）
  assert.deepEqual(Q.INTERRUPTED.map((e) => e.id), ["r3", "r2b"]);

  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    if ((await Q.routeQueue(req, res, u, u.pathname)) === NEXT) res.writeHead(404).end();
  });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  after(() => srv.close());
  const post = (body) => fetch(`http://127.0.0.1:${srv.address().port}/api/interrupted/dismiss`, { method: "POST", body });
  assert.equal((await post(JSON.stringify({ id: "r3" }))).status, 200);
  assert.deepEqual(Q.INTERRUPTED.map((e) => e.id), ["r2b"]);
  assert.equal((await post("")).status, 200);
  assert.deepEqual(Q.INTERRUPTED, []);
  assert.equal(fs.existsSync(INTR), false);
});

test("旧版本留下的单条中断记录照样认", () => {
  Q.setInterrupted({ id: "old", sessionId: sid(7), text: "旧格式", at: 1 });
  assert.deepEqual(Q.INTERRUPTED.map((e) => e.id), ["old"]);
  Q.setInterrupted(null);
  assert.deepEqual(Q.INTERRUPTED, []);
});

test("忽略请求体坏了回 400，不当成全清；最多留 20 条", async () => {
  Q.setInterrupted(Array.from({ length: 25 }, (_, i) => ({ id: "x" + i, sessionId: sid(1).replace("00000001", String(10000000 + i)) })));
  assert.equal(Q.INTERRUPTED.length, 20);
  assert.equal(Q.INTERRUPTED[0].id, "x5");
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    if ((await Q.routeQueue(req, res, u, u.pathname)) === NEXT) res.writeHead(404).end();
  });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  after(() => srv.close());
  const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/interrupted/dismiss`, { method: "POST", body: "{坏" });
  assert.equal(r.status, 400);
  assert.equal(Q.INTERRUPTED.length, 20);
  Q.setInterrupted([]);
});
