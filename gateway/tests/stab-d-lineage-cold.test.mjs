// FIND-019：冷启动后脉络缓存停在最近一次压缩之前，会话页的压缩分隔只剩通用文案。
// 会话页应该只为这一个会话补扫新增的部分，不必等 /api/lineage 整体刷新。
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CFG, PATHS } from "../gw/config.mjs";
import { scanSession } from "../gw/lineage-core.mjs";
import { lineageCached, lineageForSession } from "../gw/lineage.mjs";
import { routeSessions } from "../gw/sessions.mjs";

const SID = "11111111-2222-3333-4444-555555555555";
const OTHER = "99999999-8888-7777-6666-555555555555";
const CACHE = path.join(CFG.home, ".cache", "ccapp-lineage-index.json");
const DIR = path.join(PATHS.projects, "proj-cold");
const FILE = path.join(DIR, SID + ".jsonl");
const OTHER_FILE = path.join(DIR, OTHER + ".jsonl");

const line = (o) => JSON.stringify(o) + "\n";
const msg = (type, uuid, text, ts) => line({ type, uuid, timestamp: new Date(ts).toISOString(), message: { role: type, content: text } });
const compact = (uuid, ts) => line({ type: "user", uuid, timestamp: new Date(ts).toISOString(), isCompactSummary: true, message: { role: "user", content: "（摘要）" } });

fs.rmSync(DIR, { recursive: true, force: true });
fs.rmSync(CACHE, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });

test("缓存落后于文件时，会话页只补扫这一个会话，压缩分隔带出章节标签", async () => {
  const t0 = Date.parse("2026-11-01T00:00:00Z");
  fs.writeFileSync(FILE, msg("user", "u1", "第一问", t0) + msg("assistant", "a1", "第一答", t0 + 1000));
  // 模拟上次退出时落盘的缓存：只有压缩之前的部分
  const rec0 = await scanSession(FILE);
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(CACHE, JSON.stringify({ v: 2, recs: [rec0] }));

  // 之后又压缩了一次，缓存还没刷新（冷启动后的样子）
  fs.appendFileSync(FILE, compact("c1", t0 + 2000) + msg("user", "u2", "第二问", t0 + 3000));
  assert.equal(lineageCached(SID).compacts.length, 0, "进路由前：缓存里还没有这次压缩");

  // 只走会话接口这一条路：压缩那条把第 2 章标出来（章首提问当题名）
  const req = { method: "GET", headers: {} };
  const res = { req, writeHead(code) { this.code = code; }, end(b) { this.body = b.toString(); } };
  await routeSessions(req, res, new URL("http://127.0.0.1/api/session/" + SID), "/api/session/" + SID);
  assert.equal(res.code, 200);
  const j = JSON.parse(res.body);
  const it = j.items.find((x) => x.compact);
  assert.ok(it, "有压缩分隔");
  assert.equal(it.chapter, 2);
  assert.equal(it.chTitle, "第二问");

  // 补扫结果已经落盘：下次冷启动不用再扫
  assert.equal(lineageCached(SID).compacts.length, 1);
  const disk = JSON.parse(fs.readFileSync(CACHE, "utf8"));
  assert.equal(disk.recs.find((r) => r.id === SID).compacts.length, 1);
});

test("没有缓存记录的会话不在这里从头扫（大户首次索引要十几秒，不能卡打开会话）", async () => {
  fs.writeFileSync(OTHER_FILE, msg("user", "u1", "你好", Date.parse("2026-11-01T01:00:00Z")));
  assert.equal(lineageCached(OTHER), null);
  assert.equal(await lineageForSession(OTHER, OTHER_FILE), null);
  assert.equal(lineageCached(OTHER), null);
});
