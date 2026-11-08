// 启动恢复（gw/queue.mjs recoverRunMark）：运行标记是唯一来源，中断记录落了盘才删；重入按 id 去重（0.6.9 审计 #183）
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CFG } from "../gw/config.mjs";
import * as Q from "../gw/queue.mjs";

const MARK = path.join(CFG.home, "ccapp-run-mark.json"), INTR = path.join(CFG.home, "ccapp-interrupted.json");
const mark = { runs: [{ id: "x1", text: "还没建会话的提问", startedAt: 1 }], queue: [{ id: "q1", message: "排着的一条", at: 1 }] };
const reset = () => { Q.setInterrupted([]); Q.QUEUE.length = 0; fs.rmSync(INTR, { recursive: true, force: true }); fs.rmSync(MARK, { force: true }); };
after(reset);

test("中断记录写不上 → 运行标记原样留着；下次能写了再恢复，记录、排队消息都只有一份", () => {
  reset();
  fs.writeFileSync(MARK, JSON.stringify(mark));
  fs.mkdirSync(INTR);                                   // 目标是个目录：写必失败
  Q.recoverRunMark();
  assert.deepEqual(JSON.parse(fs.readFileSync(MARK, "utf8")), mark, "来源不能丢");
  // 下一次启动（内存从头来）
  fs.rmSync(INTR, { recursive: true, force: true });
  Q.setInterrupted([]); Q.QUEUE.length = 0;
  Q.recoverRunMark();
  assert.deepEqual(JSON.parse(fs.readFileSync(INTR, "utf8")).map((e) => e.id), ["x1"]);
  assert.deepEqual(Q.QUEUE.map((q) => q.id), ["q1"]);
  // 标记换成只剩排队消息的那份（挂起）
  const m2 = JSON.parse(fs.readFileSync(MARK, "utf8"));
  assert.deepEqual(m2.runs, []);
  assert.deepEqual(m2.queue.map((q) => [q.id, q.held]), [["q1", true]]);
});

test("中断记录写好了、标记没来得及换就又被结束 → 再恢复一次不重复", () => {
  reset();
  fs.writeFileSync(MARK, JSON.stringify(mark));
  Q.recoverRunMark();
  fs.writeFileSync(MARK, JSON.stringify(mark));         // 当作标记还是旧的
  Q.QUEUE.length = 0;                                   // 新进程：队列从标记来，中断记录从文件来
  Q.recoverRunMark();
  assert.deepEqual(Q.INTERRUPTED.map((e) => e.id), ["x1"]);
  assert.deepEqual(Q.QUEUE.map((q) => q.id), ["q1"]);
});

test("两条不同的未建会话中断记录互不覆盖（#149-2 同一口径）", () => {
  reset();
  fs.writeFileSync(MARK, JSON.stringify({ runs: [{ id: "a", text: "一", startedAt: 1 }], queue: [] }));
  Q.recoverRunMark();
  fs.writeFileSync(MARK, JSON.stringify({ runs: [{ id: "b", text: "二", startedAt: 2 }], queue: [] }));
  Q.recoverRunMark();
  assert.deepEqual(Q.INTERRUPTED.map((e) => e.id), ["a", "b"]);
  assert.equal(fs.existsSync(MARK), false);
});

test("标记坏了 → 留底成 .bad-*，不当没有", () => {
  reset();
  fs.writeFileSync(MARK, "{\"runs\":[");
  Q.recoverRunMark();
  assert.equal(fs.existsSync(MARK), false);
  const bads = fs.readdirSync(CFG.home).filter((n) => n.startsWith("ccapp-run-mark.json.bad-"));
  assert.ok(bads.length >= 1);
  for (const b of bads) fs.rmSync(path.join(CFG.home, b));
});
