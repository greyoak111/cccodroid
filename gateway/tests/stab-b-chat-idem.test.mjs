// 稳定性报告 FIND-048/036：/api/chat 请求级幂等（stab-b）
// 客户端每次发送带一把 idem 键，重试沿用同一把；网关在窗口内只入队一次，重发返回原来那条 run。
// 覆盖真实的「POST 已受理、回执丢失、用户再发一次」路径（包括新会话 follow=null 的首条）。
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { NEXT } from "../gw/http.mjs";

const { routeQueue, QUEUE, IDEM } = await import("../gw/queue.mjs");
const { RUNS, maxParallel } = await import("../gw/runs.mjs");

const srv = http.createServer(async (req, res) => { const u = new URL(req.url, "http://x"); if ((await routeQueue(req, res, u, u.pathname)) === NEXT) res.writeHead(404).end(); });
await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
after(() => srv.close());
const chat = async (b) => { const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/chat`, { method: "POST", body: JSON.stringify(b) }); return { status: r.status, j: await r.json() }; };

// 占满并行槽：入队的条目只留在队列里，pump 不会真的起 claude
const fake = [];
let n = 0;
const fill = () => {
  while (RUNS.size < maxParallel()) {
    const id = "stabb-busy" + (++n);
    fake.push(id);
    RUNS.set(id, { id, text: "", startedAt: Date.now(), log: [], idle: false, ended: false, lane: "x:" + id });
  }
};
after(() => {
  for (const id of fake) RUNS.delete(id);
  QUEUE.length = 0;
  IDEM.clear();
});

const key = () => "stabb" + crypto.randomUUID().replace(/-/g, "");
// /model 是网关本地命令，不需要配置 Key，也不会有副作用；用它是为了让 HTTP 测试不依赖凭据
const msg = "/model";

test("同一个 idem 重发：只入队一次，第二次返回原来那条 run", async () => {
  fill();
  const k = key(), b0 = QUEUE.length;
  const a = await chat({ message: msg, idem: k });
  assert.equal(a.status, 200);
  const b = await chat({ message: msg, idem: k });
  assert.equal(b.status, 200);
  assert.equal(b.j.id, a.j.id, "重发必须回原 run id");
  assert.equal(b.j.duplicate, true, "要标出这是重复请求");
  assert.equal(QUEUE.length - b0, 1, "只能多一条队列");
  assert.equal(QUEUE.filter((q) => q.id === a.j.id).length, 1);
});

test("新会话首条（follow=null）重发：不会被拆成两个会话的两条队列", async () => {
  fill();
  const k = key(), b0 = QUEUE.length;
  // 前端新会话首条就是这个形状：sessionId 为空、follow 为空
  const a = await chat({ message: msg, sessionId: null, follow: null, idem: k });
  const b = await chat({ message: msg, sessionId: null, follow: null, idem: k });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(b.j.id, a.j.id);
  assert.equal(QUEUE.length - b0, 1, "follow=null 的重发不能另起一条车道再排一条");
});

test("同一把键换了正文：409 idem_conflict，不吞掉新消息", async () => {
  fill();
  const k = key();
  const a = await chat({ message: msg, idem: k });
  const b = await chat({ message: "/models", idem: k });
  assert.equal(a.status, 200);
  assert.equal(b.status, 409);
  assert.equal(b.j.error, "idem_conflict");
  assert.equal(QUEUE.filter((q) => q.id === a.j.id).length, 1);
  assert.equal(QUEUE.some((q) => q.message === "/models"), false, "冲突的正文没进队列");
});

test("没有 idem / 键不认识 / 键不同：照旧每次入队（向后兼容）", async () => {
  fill();
  const b0 = QUEUE.length;
  const a1 = await chat({ message: msg });
  const a2 = await chat({ message: msg });
  assert.notEqual(a1.j.id, a2.j.id, "不带键的两次请求保持原行为");
  const bad = await chat({ message: msg, idem: "bad key!! 中文" });
  const bad2 = await chat({ message: msg, idem: "bad key!! 中文" });
  assert.notEqual(bad.j.id, bad2.j.id, "不合法的键当没带");
  const c1 = await chat({ message: msg, idem: key() });
  const c2 = await chat({ message: msg, idem: key() });
  assert.notEqual(c1.j.id, c2.j.id, "不同的键是两条消息");
  assert.equal(QUEUE.length - b0, 6);
});

test("超过时间窗：同一个键重新入队（窗口过期）", async () => {
  fill();
  const k = key();
  const a = await chat({ message: msg, idem: k });
  const rec = IDEM.get(k);
  assert.ok(rec, "第一次请求要登记进窗口");
  rec.at = Date.now() - 10 * 60 * 1000 - 1;   // 拨到窗口外
  const b = await chat({ message: msg, idem: k });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.notEqual(b.j.id, a.j.id, "过了窗口就是新的一次发送");
  assert.equal(b.j.duplicate, undefined);
});

test("窗口有上限：清理时不会无限吃内存", () => {
  assert.ok(IDEM.size <= 200, "IDEM 最多留 200 条");
});
