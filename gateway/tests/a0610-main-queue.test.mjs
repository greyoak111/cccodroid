// 队列里属于已删会话的消息（gw/queue.mjs，0.6.9 审计 195-W.1）
import { PATHS } from "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as Q from "../gw/queue.mjs";
import { TRASH_HOOKS, RUNS } from "../gw/runs.mjs";

const SID = "11111111-2222-4333-8444-555555555555", SID2 = "11111111-2222-4333-8444-666666666666";
const pdir = path.join(PATHS.projects, "-a0610-q");
after(() => { Q.QUEUE.length = 0; fs.rmSync(pdir, { recursive: true, force: true }); });
const item = (id, sessionId) => ({ id, message: "排着", sessionId, follow: null, at: 1 });

test("会话进了回收站 → 它排着的消息一起丢掉，别的会话的不动", () => {
  Q.QUEUE.length = 0;
  Q.QUEUE.push({ ...item("a", SID), held: true }, { ...item("b", SID2), held: true });
  for (const h of TRASH_HOOKS) h(SID);
  assert.deepEqual(Q.QUEUE.map((q) => q.id), ["b"]);
});

test("会话文件不在了 → pump 不拿它去 --resume；会话目录整个读不了时不算删了", () => {
  Q.QUEUE.length = 0;
  fs.mkdirSync(pdir, { recursive: true });
  // 目录读得了、文件不在：丢掉
  Q.QUEUE.push(item("c", SID));
  Q.pump();
  assert.deepEqual(Q.QUEUE.map((q) => q.id), [], "已删会话的消息不该被拿去起跑");
  assert.equal(RUNS.has("c"), false);
  // 会话目录读不了：不算删了（存储出错不是删除）
  const keep = PATHS.projects;
  PATHS.projects = path.join(pdir, "nope", "x");
  try { assert.equal(Q.sessionGone(SID), false); } finally { PATHS.projects = keep; }
  assert.equal(Q.sessionGone(SID), true);
});
