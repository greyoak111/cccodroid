// BUG-PERSIST-005 第二种情况：坏缓存条目遇到文件又追加了内容（head 没变、大小变了）。
// 刷新会走增量扫描，scanSession 里的 prev.compacts.map 对 null 抛错，refresh 只记日志、保留坏记录，
// 之后图与章节继续不可用。缓存读入校验后，坏条目在进内存前就被丢掉，增量扫描从原文件整份重建。
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CFG, PATHS } from "../gw/config.mjs";
import { scanSession } from "../gw/lineage-core.mjs";
import { lineageCached, lineageGraph } from "../gw/lineage.mjs";
import { chapterView } from "../gw/archive-core.mjs";

const A = "cccccccc-1111-2222-3333-444444444444";
const DIR = path.join(PATHS.projects, "-stab2-g-cache-grow");
const FILE_A = path.join(DIR, A + ".jsonl");
const CACHE = path.join(CFG.home, ".cache", "ccapp-lineage-index.json");
const line = (o) => JSON.stringify(o) + "\n";
const msg = (type, uuid, text, ts) => line({
  type, uuid, sessionId: A, timestamp: new Date(ts).toISOString(),
  message: { role: type, content: type === "assistant" ? [{ type: "text", text }] : text },
});

const T0 = Date.parse("2026-11-02T01:00:00Z");
// 文件必须超过 4096 字节（开头哈希的长度）：报告的反证里，小文件追加会改变 head 而自愈，
// 那样测不到「纯追加、head 不变、刷新走增量扫描」这条真会持续阻断的路
const PAD = "长".repeat(3000);
fs.rmSync(DIR, { recursive: true, force: true });
fs.rmSync(CACHE, { force: true });
fs.mkdirSync(DIR, { recursive: true });
fs.writeFileSync(FILE_A,
  msg("user", "a-u1", "第一问" + PAD, T0) +
  msg("assistant", "a-a1", "第一答" + PAD, T0 + 1000) +
  msg("user", "a-u2", "第二问" + PAD, T0 + 2000));

test("坏缓存 + 文件又有追加：增量扫描不能对 compacts=null 抛错，记录要从文件重建", async () => {
  const rec = await scanSession(FILE_A);
  rec.mtime = fs.statSync(FILE_A).mtimeMs;
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(CACHE, JSON.stringify({ v: 2, recs: [{ ...rec, compacts: null }] }));

  // 缓存落盘之后会话又追加了一条（纯追加，开头哈希没变）
  fs.appendFileSync(FILE_A, msg("assistant", "a-a2", "第二答", T0 + 3000));

  const graph = await lineageGraph();   // 修前：增量扫描抛错被 refresh 吞掉，chapterView 仍读到 null
  assert.ok(graph.nodes.some((n) => n.id === A));

  const a = lineageCached(A);
  assert.ok(a, "会话不能因为一条坏缓存而消失");
  assert.ok(Array.isArray(a.compacts));
  assert.equal(a.compacts.length, 0);
  assert.equal(a.uu.length, rec.uu.length + 1, "追加的那条要被增量读进来");
  assert.equal(chapterView(a, null).chapters.length, 1, "章节视图可用");
});
