// 0.6.10 车道 b2：会话记录分页（195-Q.2 / Q.10）与会话搜索（195-Q.3、200-15-03/04/06/08/12、200-6-05 的 PEEK_CACHE）
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { CFG, PATHS } from "../gw/config.mjs";

// 小文件也走流式分支，才能在同一次导入里同时覆盖「建索引」和「流式扫」两条路
process.env.CCAPP_SEARCH_STREAM_SIZE = String(8 << 10);
const { readSessionPage } = await import("../gw/transcript.mjs");
const { searchSessions, listSessions } = await import("../gw/sessions.mjs");

const PROJ = path.join(PATHS.projects, "-b2-search");
fs.mkdirSync(PROJ, { recursive: true });
const line = (o) => JSON.stringify(o);
const userLine = (sid, text, extra = {}) => line({ type: "user", sessionId: sid, uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), message: { role: "user", content: text }, ...extra });
const botLine = (sid, text, extra = {}) => line({ type: "assistant", sessionId: sid, uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text }] }, ...extra });
const mkFile = (lines, tailNl = true) => { const f = path.join(PROJ, crypto.randomUUID() + ".jsonl"); fs.writeFileSync(f, lines.join("\n") + (tailNl ? "\n" : "")); return f; };

test("倒读遇到跨块的单行：拼回来不丢字、不错位（195-Q.2）", async () => {
  const big = "长".repeat(1_200_000);          // 1.2 MB，跨好几个 256 KB 块
  const sid = crypto.randomUUID();
  const f = mkFile([
    userLine(sid, "第一问"), botLine(sid, "第一答"),
    userLine(sid, big), botLine(sid, "第二答"),
    userLine(sid, "最后一问"), botLine(sid, "最后一答"),
  ]);
  const p = await readSessionPage(f, { limit: 6 });
  const got = p.items.filter((x) => x.role === "user").map((x) => x.text);
  assert.ok(got.includes(big), "大段提问要原样拼回");
  assert.ok(p.items.some((x) => x.text === "最后一答"));
});

test("末行不带换行也能读到；assistant 单条正文有上限并标出截断（195-Q.10）", async () => {
  const sid = crypto.randomUUID();
  const huge = "答".repeat(250_000);
  const f = mkFile([userLine(sid, "问"), botLine(sid, huge)], false);
  const p = await readSessionPage(f, { limit: 5 });
  const a = p.items.find((x) => x.role === "assistant");
  assert.ok(a, "末行没换行也要读出来");
  assert.equal(a.truncated, true);
  assert.ok(a.text.startsWith("答".repeat(200_000)));
  assert.match(a.text, /只显示前 200000 字/);
});

test("搜索：NFKC + 小写归一；侧链 / 压缩摘要不进人看的搜索；末行无换行也收进索引（200-15-03/04/06）", async () => {
  const sid = crypto.randomUUID();
  mkFile([
    userLine(sid, "前文 ＡＢＣ 结束"),
    botLine(sid, "回答里有 abc 这个词"),
    line({ type: "user", sessionId: sid, isSidechain: true, message: { role: "user", content: "只有侧链才有的隐藏词" } }),
    line({ type: "user", sessionId: sid, isCompactSummary: true, message: { role: "user", content: "压缩摘要里的摘要词" } }),
    botLine(sid, "最后一行末行词"),
  ], false);
  const abc = await searchSessions("abc");
  assert.ok(abc.results.length >= 1);
  assert.ok(abc.results[0].count >= 2, "全角 ＡＢＣ 也要命中");
  assert.equal((await searchSessions("隐藏词")).results.length, 0);
  assert.equal((await searchSessions("摘要词")).results.length, 0);
  assert.ok((await searchSessions("末行词")).results.length >= 1);
});

test("大文件走流式扫描：不建索引也能搜到（195-Q.3）", async () => {
  const sid = crypto.randomUUID();
  const lines = [userLine(sid, "开头的词")];
  for (let i = 0; i < 400; i++) lines.push(botLine(sid, `填充 ${i} ` + "x".repeat(60)));
  lines.push(botLine(sid, "深处埋着流式命中词"));
  const f = mkFile(lines);
  assert.ok(fs.statSync(f).size > (8 << 10));
  const r = await searchSessions("流式命中词");
  assert.ok(r.results.some((x) => x.count >= 1));
});

test("查询按码点截 200：不会切在代理对中间；200 个 a + emoji 只按 200 个 a 查（200-15-12）", async () => {
  const sid = crypto.randomUUID();
  mkFile([userLine(sid, "a".repeat(200) + "尾")]);
  const q = "a".repeat(200) + "😀";
  const r = await searchSessions(q);
  assert.ok(r.results.length >= 1, "截断后 200 个 a 应命中");
});

test("列表缓存带 mtime/size：同尺寸改写（mtime 变了）能看见新标题（200-15-08）", () => {
  const sid = crypto.randomUUID();
  const f = path.join(PROJ, sid + ".jsonl");
  const t1 = "旧标题旧标题旧标题", t2 = "新标题新标题新标题";   // 同字节长度
  fs.writeFileSync(f, JSON.stringify({ type: "user", sessionId: sid, uuid: crypto.randomUUID(), message: { role: "user", content: t1 } }) + "\n");
  const a = listSessions(5000).find((s) => s.id === sid);
  assert.equal(a.title, t1);
  fs.writeFileSync(f, JSON.stringify({ type: "user", sessionId: sid, uuid: crypto.randomUUID(), message: { role: "user", content: t2 } }) + "\n");
  const future = new Date(Date.now() + 5000); fs.utimesSync(f, future, future);
  const b = listSessions(5000).find((s) => s.id === sid);
  assert.equal(b.title, t2);
});
