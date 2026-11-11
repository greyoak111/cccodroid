// BUG-PERSIST-005：脉络缓存里一条记录的 compacts 被写成 null 时，会盖掉 emptyRecord 的默认数组；
// 元信息（size/off/mtime/head）与文件一致时刷新直接跳过重扫，随后 chapterView / lastQ 访问 length 抛错，
// 整张脉络图和章节视图都打不开。缓存读入时要校验数组字段与增量扫描输入，坏条目丢掉、按会话文件重建，
// 邻会话的记录与图不受影响。本文件覆盖「文件没变、刷新会跳过重扫」这条路（冷进程里写合成缓存）。
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CFG, PATHS } from "../gw/config.mjs";
import { scanSession } from "../gw/lineage-core.mjs";
import { lineageCached, lineageGraph } from "../gw/lineage.mjs";
import { chapterView } from "../gw/archive-core.mjs";

const A = "aaaaaaaa-1111-2222-3333-444444444444";
const B = "bbbbbbbb-1111-2222-3333-444444444444";
const DIR = path.join(PATHS.projects, "-stab2-g-cache");
const FILE_A = path.join(DIR, A + ".jsonl");
const FILE_B = path.join(DIR, B + ".jsonl");
const CACHE = path.join(CFG.home, ".cache", "ccapp-lineage-index.json");
const line = (o) => JSON.stringify(o) + "\n";
const msg = (sid, type, uuid, text, ts) => line({
  type, uuid, sessionId: sid, timestamp: new Date(ts).toISOString(),
  message: { role: type, content: type === "assistant" ? [{ type: "text", text }] : text },
});
const compact = (sid, uuid, ts) => line({ type: "user", uuid, sessionId: sid, isCompactSummary: true, timestamp: new Date(ts).toISOString(), message: { role: "user", content: "（摘要）" } });

const T0 = Date.parse("2026-11-02T00:00:00Z");
fs.rmSync(DIR, { recursive: true, force: true });
fs.rmSync(CACHE, { force: true });
fs.mkdirSync(DIR, { recursive: true });
fs.writeFileSync(FILE_A,
  msg(A, "user", "a-u1", "第一问", T0) +
  msg(A, "assistant", "a-a1", "第一答", T0 + 1000) +
  compact(A, "a-c1", T0 + 2000) +
  msg(A, "user", "a-u2", "第二问", T0 + 3000) +
  msg(A, "assistant", "a-a2", "第二答", T0 + 4000));
fs.writeFileSync(FILE_B,
  msg(B, "user", "b-u1", "邻会话提问", T0) +
  msg(B, "assistant", "b-a1", "邻会话回答", T0 + 1000));

test("缓存条目 compacts=null、元信息又完全匹配（刷新会跳过重扫）：坏条目按原文件重建，邻会话照旧", async () => {
  const recA = await scanSession(FILE_A), recB = await scanSession(FILE_B);
  recA.mtime = fs.statSync(FILE_A).mtimeMs;
  recB.mtime = fs.statSync(FILE_B).mtimeMs;
  recB.lead = "缓存里的邻会话标记";   // 邻会话如果被整份重扫，这个标记就没了
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(CACHE, JSON.stringify({ v: 2, recs: [{ ...recA, compacts: null }, recB] }));

  // 修前：refresh 认为 A 没变、跳过重扫，lineageGraph 里的 chapterView 读到 null 直接抛错
  const graph = await lineageGraph();
  const ids = graph.nodes.map((n) => n.id);
  assert.ok(ids.includes(A) && ids.includes(B), "两个会话都要在图上");

  const a = lineageCached(A);
  assert.ok(a, "坏条目不能把这条会话整个丢掉");
  assert.ok(Array.isArray(a.compacts), "compacts 要被重建成数组");
  assert.equal(a.compacts.length, 1, "压缩摘要要从原记录重建回来");
  assert.equal(a.turns, recA.turns);
  assert.equal(chapterView(a, null).chapters.length, 2, "章节视图可用：压缩一次就是两章");
  assert.equal(graph.nodes.find((n) => n.id === A).chapters.length, 2);

  // 邻会话按原缓存用，不被牵连重扫
  assert.equal(lineageCached(B).lead, "缓存里的邻会话标记");
});
