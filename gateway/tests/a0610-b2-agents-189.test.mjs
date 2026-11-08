// 0.6.10 车道 b2：#189 代理历史回填缓存——meta.json 只改 finished / toolUseId 时缓存也要失效
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { CFG } from "../gw/config.mjs";
import { backfillAgents } from "../gw/agents.mjs";

after(() => fs.rmSync(path.join(CFG.home, ".claude", "projects", "-b2-agents"), { recursive: true, force: true }));

test("改 meta.json 的 finished：第二次回填不能拿旧缓存（#189）", () => {
  const sid = crypto.randomUUID();
  const dir = path.join(CFG.home, ".claude", "projects", "-b2-agents");
  const file = path.join(dir, sid + ".jsonl");
  const sub = path.join(dir, sid, "subagents");
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ type: "user", sessionId: sid, uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), message: { role: "user", content: "hi" } }) + "\n");
  const meta = path.join(sub, "agent-a.meta.json");
  fs.writeFileSync(meta, JSON.stringify({ toolUseId: "t1", description: "侦察", finished: false }));
  fs.writeFileSync(path.join(sub, "agent-a.jsonl"), JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "在查" }] } }) + "\n");

  const first = backfillAgents(file);
  assert.ok(first.some((r) => r.k === "spawn"));
  assert.equal(first.some((r) => r.k === "done"), false);

  // 只改 meta（文件大小和 mtime 都会变）：以前签名只列裸文件名，stat 不到，仍然返回旧结果
  fs.writeFileSync(meta, JSON.stringify({ toolUseId: "t1", description: "侦察", finished: true }));
  const later = new Date(Date.now() + 3000); fs.utimesSync(meta, later, later);
  const second = backfillAgents(file);
  assert.ok(second.some((r) => r.k === "done"), "finished 改了要重新回填");
});
