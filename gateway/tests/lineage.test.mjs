// 脉络（gw/lineage-core.mjs + lineage.mjs）：读会话、推断亲缘、增量缓存、分叉时的显式记录
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { scanSession, inferParents } from "../gw/lineage-core.mjs";

const DIR = fs.mkdtempSync(path.join(process.env.CCAPP_TMP, "lineage-"));
const T0 = Date.parse("2026-10-20T00:00:00Z");
const iso = (min) => new Date(T0 + min * 60000).toISOString();

/** 造一条链：n 轮问答，返回行数组；msgs 的 uuid 可预先给定（模拟分叉照抄） */
function chain(sid, turns, start = 0) {
  const out = [];
  let parent = null;
  for (let i = 0; i < turns; i++) {
    const u = { type: "user", uuid: crypto.randomUUID(), parentUuid: parent, sessionId: sid, timestamp: iso(start + i * 2), message: { role: "user", content: `问题 ${start + i}` } };
    const a = { type: "assistant", uuid: crypto.randomUUID(), parentUuid: u.uuid, sessionId: sid, timestamp: iso(start + i * 2 + 1), message: { role: "assistant", content: [{ type: "text", text: "答" }] } };
    out.push(u, a); parent = a.uuid;
  }
  return out;
}
/** 照 forkSession 的做法：抄前 keep 条（只改 sessionId），再接 more 轮新内容（时间在 at 分钟之后） */
function fork(lines, nid, keep, more, at) {
  const copied = lines.slice(0, keep).map((e) => ({ ...e, sessionId: nid }));
  let parent = copied.at(-1).uuid;
  const extra = chain(nid, more, at).map((e, i) => (i === 0 ? { ...e, parentUuid: parent } : e));
  return [...copied, ...extra];
}
const write = (id, lines) => { const f = path.join(DIR, id + ".jsonl"); fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n") + "\n"); return f; };
async function recs(map) {
  const m = new Map();
  for (const [id, { lines, birth }] of Object.entries(map)) { const r = await scanSession(write(id, lines)); r.birth = birth || 0; m.set(id, r); }
  return m;
}
const id = () => crypto.randomUUID();

test("读会话：链上消息、真实提问轮数、第一句；工具结果和 <…> 注入不算提问", async () => {
  const sid = id();
  const lines = [
    ...chain(sid, 2),
    { type: "user", uuid: id(), sessionId: sid, timestamp: iso(10), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] } },
    { type: "user", uuid: id(), sessionId: sid, timestamp: iso(11), message: { role: "user", content: "<system-reminder>别算</system-reminder>" } },
    { type: "user", uuid: id(), sessionId: sid, isCompactSummary: true, timestamp: iso(12), message: { role: "user", content: "摘要" } },
    { type: "file-history-snapshot", messageId: "m" },
  ];
  const r = await scanSession(write(sid, lines));
  assert.equal(r.turns, 2);
  assert.equal(r.first, "问题 0");
  assert.equal(r.uu.length, 7);
  assert.equal(r.compacts.length, 1);
  assert.equal(r.firstTs, T0);
});

test("增量：追加的部分接着读；没写完的最后一行留到下次；开头被改写就从头再读", async () => {
  const sid = id();
  const f = write(sid, chain(sid, 2));
  const r1 = await scanSession(f);
  assert.equal(r1.uu.length, 4);
  const more = chain(sid, 1, 20);
  fs.appendFileSync(f, JSON.stringify(more[0]) + "\n" + JSON.stringify(more[1]).slice(0, 30));   // 第二行没写完
  const r2 = await scanSession(f, r1);
  assert.equal(r2.uu.length, 5);
  assert.equal(r1.uu.length, 4, "不改上一次的结果");
  fs.appendFileSync(f, JSON.stringify(more[1]).slice(30) + "\n");
  const r3 = await scanSession(f, r2);
  assert.equal(r3.uu.length, 6);
  // 删消息会原地重写：开头变了，从头读
  const all = fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
  fs.writeFileSync(f, all.slice(2).join("\n") + "\n");
  const r4 = await scanSession(f, r3);
  assert.equal(r4.uu.length, 4);
});

test("分叉三代：子、孙都挂对；孙的分叉点早于子时取最近的祖先", async () => {
  const P = id(), C = id(), G = id();
  const p = chain(P, 10);
  const c = fork(p, C, 12, 2, 100);   // 从第 6 轮分
  const g = fork(c, G, 6, 1, 200);    // 从子会话的第 3 轮分（比子会话的分叉点早）
  const m = await recs({ [P]: { lines: p, birth: 1e12 }, [C]: { lines: c, birth: 1e12 + 5000 }, [G]: { lines: g, birth: 1e12 + 9000 } });
  const par = inferParents(m);
  assert.equal(par.get(C).parent, P);
  assert.equal(par.get(C).at, p[11].uuid);
  assert.equal(par.get(G).parent, C);
  assert.equal(par.has(P), false);
});

test("没有创建时间时：分叉后谁先有新内容谁是父", async () => {
  const P = id(), C = id();
  const p = chain(P, 6);            // 父会话分叉前就已经聊到第 6 轮
  const c = fork(p, C, 4, 2, 100);  // 从第 2 轮分，新内容在很久以后
  const m = await recs({ [C]: { lines: c }, [P]: { lines: p } });
  assert.equal(inferParents(m).get(C).parent, P);
});

test("导入的会话：创建时间骗人时，另两票一致就听它们", async () => {
  const P = id(), C = id();
  const p = chain(P, 6);
  const c = fork(p, C, 4, 2, 100);
  const m = await recs({ [P]: { lines: p, birth: 2e12 }, [C]: { lines: c, birth: 1e12 } });   // 父会话是后导入的
  const par = inferParents(m, { names: { [C]: "某会话 · 分叉" } });
  assert.equal(par.get(C).parent, P);
});

test("父会话分叉后删了共有部分里的一条消息：亲缘还在，分叉点取最后一条共有的", async () => {
  const P = id(), C = id();
  const p = chain(P, 6);
  const c = fork(p, C, 8, 1, 100);
  const pDel = p.filter((_, i) => i !== 2);
  const m = await recs({ [P]: { lines: pDel, birth: 1e12 }, [C]: { lines: c, birth: 1e12 + 5000 } });
  const e = inferParents(m).get(C);
  assert.equal(e.parent, P);
  assert.equal(e.at, p[7].uuid);
});

test("回退：标题带「· 回退」记成 rewind", async () => {
  const P = id(), C = id();
  const p = chain(P, 4);
  const c = fork(p, C, 4, 1, 100);
  const m = await recs({ [P]: { lines: p, birth: 1e12 }, [C]: { lines: c, birth: 1e12 + 5000 } });
  assert.equal(inferParents(m, { names: { [C]: "x · 回退" } }).get(C).kind, "rewind");
});

test("显式记录优先于推断；互指成环的记录会被断开", async () => {
  const A = id(), B = id();
  const m = await recs({ [A]: { lines: chain(A, 2) }, [B]: { lines: chain(B, 2) } });
  const par = inferParents(m, { explicit: { [B]: { primary: { id: A, at: "u", kind: "fork" } } } });
  assert.equal(par.get(B).parent, A);
  assert.equal(par.get(B).source, "explicit");
  const loop = inferParents(m, { explicit: { [A]: { primary: { id: B } }, [B]: { primary: { id: A } } } });
  assert.ok(!(loop.has(A) && loop.has(B)), "环至少断一边");
});

test("网关：分叉时写显式记录，/api/lineage 的图里能看到（含回收站里的父会话）", async () => {
  const home = process.env.CCAPP_HOME;
  const proj = path.join(home, ".claude", "projects", "-work");
  fs.mkdirSync(proj, { recursive: true });
  const P = id();
  fs.writeFileSync(path.join(proj, P + ".jsonl"), chain(P, 3).map((l) => JSON.stringify(l)).join("\n") + "\n");
  const { forkSession, trashSession } = await import("../gw/sessionops.mjs");
  const r = forkSession(P, "问题 1", 1);
  assert.ok(r.ok, JSON.stringify(r));
  const db = JSON.parse(fs.readFileSync(path.join(home, "ccapp-lineage.json"), "utf8"));
  assert.equal(db.edges[r.id].primary.id, P);
  assert.equal(db.edges[r.id].primary.kind, "fork");
  assert.ok(db.edges[r.id].primary.at);
  trashSession(P);
  const { lineageGraph } = await import("../gw/lineage.mjs");
  const g = await lineageGraph();
  const e = g.edges.find((x) => x.child === r.id);
  assert.equal(e.parent, P);
  assert.equal(e.source, "explicit");
  assert.equal(e.missing, false);
  assert.equal(g.nodes.find((n) => n.id === P).trashed, true);
  assert.ok(fs.existsSync(path.join(home, ".cache", "ccapp-lineage-index.json")), "缓存落盘");
});

test("旧会话兼容：每章记下章首第一句提问；工具调用读过别的会话记录记成引用（每个来源只记第一次）", async () => {
  const S = id(), X = id();
  const L = chain(S, 2);
  L.push({ type: "user", uuid: id(), sessionId: S, isCompactSummary: true, timestamp: iso(10), message: { role: "user", content: "摘要" } });
  L.push(...chain(S, 1, 12));
  const read = { type: "assistant", uuid: id(), sessionId: S, timestamp: iso(15), message: { role: "assistant", content: [{ type: "tool_use", name: "Read", input: { file_path: `/x/.claude/projects/-w/${X}.jsonl` } }] } };
  L.push(read, { ...read, uuid: id(), timestamp: iso(16) });
  L.push({ type: "assistant", uuid: id(), sessionId: S, timestamp: iso(17), message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: `tail ${S}.jsonl` } }] } });
  const r = await scanSession(write(S, L));
  assert.equal(r.first, "问题 0");
  assert.equal(r.compacts[0].q, "问题 12");
  assert.equal(r.refs.length, 1, "读自己的不算");
  assert.equal(r.refs[0].id, X);
  assert.equal(r.refs[0].at, read.uuid);
  assert.equal(r.refs[0].n, 2);
  assert.equal(r.refs[0].turn, 3);
  // 增量：压缩后还没提问就断在这里，下次读到的第一句补上
  const S2 = id(), L2 = chain(S2, 1);
  L2.push({ type: "user", uuid: id(), sessionId: S2, isCompactSummary: true, timestamp: iso(5), message: { role: "user", content: "摘要" } });
  const f2 = write(S2, L2), r1 = await scanSession(f2);
  assert.equal(r1.compacts[0].q, "");
  fs.appendFileSync(f2, chain(S2, 1, 8).map((l) => JSON.stringify(l)).join("\n") + "\n");
  assert.equal((await scanSession(f2, r1)).compacts[0].q, "问题 8");
});

test("网关：图 v2 —— 章节题名（建档的 / 未建档用章首提问）、分叉后缀去掉、读记录的边、项目带", async () => {
  const home = process.env.CCAPP_HOME;
  const proj = path.join(home, ".claude", "projects", "-v2");
  fs.mkdirSync(proj, { recursive: true });
  const A = id(), B = id();
  const LA = chain(A, 2);
  LA[0].cwd = "/probe/elsewhere";   // 不在项目里、也不是工作区 → 「其他目录」带
  LA.push({ type: "user", uuid: id(), sessionId: A, isCompactSummary: true, timestamp: iso(10), message: { role: "user", content: "摘要" } });
  LA.push(...chain(A, 1, 12));
  fs.writeFileSync(path.join(proj, A + ".jsonl"), LA.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const LB = chain(B, 1, 30);
  LB.push({ type: "assistant", uuid: id(), sessionId: B, timestamp: iso(32), message: { role: "assistant", content: [{ type: "tool_use", name: "Read", input: { file_path: A + ".jsonl" } }] } });
  fs.writeFileSync(path.join(proj, B + ".jsonl"), LB.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const { NAMES } = await import("../gw/sessions.mjs");
  NAMES[B] = "接手 · 分叉";
  const { fileChapter } = await import("../gw/archive.mjs");
  assert.equal((await fileChapter(A, { title: "审 GPU 驱动组件", chapter: 1 })).ok, true);
  const { lineageGraph } = await import("../gw/lineage.mjs");
  const g = await lineageGraph();
  const a = g.nodes.find((n) => n.id === A), b = g.nodes.find((n) => n.id === B);
  assert.equal(a.chapters.length, 2);
  assert.equal(a.chapters[0].title, "审 GPU 驱动组件");
  assert.equal(a.chapters[1].title, null);
  assert.equal(a.chapters[1].q, "问题 12", "未建档的章拿章首提问顶上");
  assert.equal(a.title, "审 GPU 驱动组件");
  assert.equal(a.titleBy, "archive");
  assert.equal(b.title, "接手", "去掉老版本的「· 分叉」后缀");
  assert.equal(a.band.key, "other");
  const e = g.edges.find((x) => x.kind === "read" && x.child === B);
  assert.equal(e.parent, A);
  assert.equal(e.early, true);
  assert.ok(e.ts > 0);
  assert.equal(a.brief, false, "有亲缘的不算一问一答");
  assert.equal(b.brief, false);
  delete NAMES[B];
});

test("旧会话兼容：章首提问跳过「你好，claude」「继续」，取本章前 3 句里第一句有内容的", async () => {
  const S = id(), L = [];
  const u = (t, m) => ({ type: "user", uuid: id(), sessionId: S, timestamp: iso(m), message: { role: "user", content: t } });
  L.push(u("你好，claude", 0), u("看看这台设备的开发能力", 1), u("再看看 GPU", 2));
  L.push({ type: "user", uuid: id(), sessionId: S, isCompactSummary: true, timestamp: iso(5), message: { role: "user", content: "摘要" } });
  L.push(u("继续", 6), u("好的", 7), u("ok", 8), u("修 GPU 驱动", 9));
  const r = await scanSession(write(S, L));
  assert.equal(r.lead, "看看这台设备的开发能力");
  assert.equal(r.first, "你好，claude");
  assert.equal(r.compacts[0].q, "继续", "前 3 句都没内容就留第一句，不往后找");
});
