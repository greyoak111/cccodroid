// v0.5.17：#70 正向翻页封顶、#72 旧代理会话联络簿现推只解析需要的行并缓存
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readSessionForward, readSessionPage, transcriptItems } from "../gw/transcript.mjs";
import { backfillAgents } from "../gw/agents.mjs";

const ts = (i) => new Date(Date.UTC(2026, 10, 1, 0, 0, i)).toISOString();
const J = JSON.stringify;

test("正向翻页：一轮里上千次工具调用也封顶 limit*4，且能接着翻完（#70）", async () => {
  const dir = fs.mkdtempSync(path.join(process.env.CCAPP_TMP, "fwd-")), file = path.join(dir, "s.jsonl");
  const rows = [J({ type: "user", uuid: "u0", timestamp: ts(0), message: { role: "user", content: "开始" } })];
  for (let i = 0; i < 1500; i++) {
    rows.push(J({ type: "assistant", uuid: "a" + i, timestamp: ts(1), message: { role: "assistant", content: [{ type: "tool_use", id: "t" + i, name: "Read", input: { file_path: "/x" + i } }] } }));
    rows.push(J({ type: "user", uuid: "r" + i, timestamp: ts(1), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t" + i, content: "ok" }] } }));
  }
  rows.push(J({ type: "user", uuid: "u1", timestamp: ts(2), message: { role: "user", content: "下一轮" } }));
  fs.writeFileSync(file, rows.join("\n") + "\n");
  let after = 0, pages = 0, total = 0;
  for (;;) {
    const p = await readSessionForward(file, { after, limit: 40 });
    assert.ok(p.items.length <= 40 * 4 + 2, `一页 ${p.items.length} 项`);
    total += p.items.length; pages++;
    if (p.next >= p.size) break;
    assert.ok(p.next > after); after = p.next;
  }
  assert.equal(total, 1 + 3000 + 1);
  assert.ok(pages >= 19);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("旧代理会话现推联络簿：大工具结果不解析、结果按文件缓存、改了重算（#72）", () => {
  const dir = fs.mkdtempSync(path.join(process.env.CCAPP_TMP, "bf-")), file = path.join(dir, "s.jsonl"), sub = path.join(dir, "s", "subagents");
  fs.mkdirSync(sub, { recursive: true });
  const big = (i) => J({ type: "user", timestamp: ts(i), message: { content: [{ type: "tool_result", tool_use_id: "big" + i, content: '\\"type\\":\\"assistant\\" SendMessage ' + "x".repeat(20000) }] } });
  const send = (i, id, to) => J({ type: "assistant", timestamp: ts(i), message: { content: [{ type: "tool_use", id, name: "SendMessage", input: { to, message: "进度", summary: "汇报" + i } }] } });
  const res = (i, id) => J({ type: "user", timestamp: ts(i), message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
  const text = (i, s) => J({ type: "assistant", timestamp: ts(i), message: { content: [{ type: "text", text: s }] } });
  fs.writeFileSync(file, [text(1, "开始"), big(2)].join("\n") + "\n");
  fs.writeFileSync(path.join(sub, "agent-a.meta.json"), J({ toolUseId: "tool-a", description: "worker-a", finished: true }));
  fs.writeFileSync(path.join(sub, "agent-a.jsonl"), [text(10, "收到"), big(11), send(12, "sm1", "main"), res(13, "sm1"), big(14), text(15, "结论\n细节"), big(16)].join("\n") + "\n");
  const r1 = backfillAgents(file);
  assert.deepEqual(r1.map((r) => r.k), ["spawn", "msg", "msg_ok", "done"]);
  assert.equal(r1.find((r) => r.k === "done").why, "结论");
  assert.equal(r1.find((r) => r.k === "done").at, Date.parse(ts(16)));
  r1[0].name = "被调用方改了";   // 缓存不能被调用方改坏
  assert.deepEqual(backfillAgents(file), backfillAgents(file));
  assert.equal(backfillAgents(file)[0].name, "worker-a");
  fs.appendFileSync(path.join(sub, "agent-a.jsonl"), send(20, "sm2", "main") + "\n");
  assert.equal(backfillAgents(file).filter((r) => r.k === "msg").length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("子代理过程从尾部倒读：给最近约 400 项、以最后一步收尾、标明前面还有（#71）", async () => {
  const dir = fs.mkdtempSync(path.join(process.env.CCAPP_TMP, "sub-")), file = path.join(dir, "agent-x.jsonl");
  const rows = [J({ type: "user", isSidechain: true, timestamp: ts(0), message: { role: "user", content: "主代理给的提示" } })];
  for (let i = 0; i < 700; i++) {
    rows.push(J({ type: "assistant", isSidechain: true, timestamp: ts(1), message: { role: "assistant", content: [{ type: "tool_use", id: "t" + i, name: "Read", input: { file_path: "/x" + i } }] } }));
    rows.push(J({ type: "user", isSidechain: true, timestamp: ts(1), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t" + i, content: "ok" }] } }));
  }
  rows.push(J({ type: "assistant", isSidechain: true, timestamp: ts(2), message: { role: "assistant", content: [{ type: "text", text: "汇报完毕" }] } }));
  fs.writeFileSync(file, rows.join("\n") + "\n");
  const pick = (ev) => ev.type === "user" && typeof ev.message?.content === "string" ? []
    : transcriptItems({ ...ev, isSidechain: false }).filter((it) => it.role !== "thinking" && it.role !== "user");
  const p = await readSessionPage(file, { limit: 100, pick });
  assert.ok(p.items.length >= 400 && p.items.length <= 402, String(p.items.length));
  assert.ok(p.cursor > 0);
  assert.equal(p.items.at(-1).role, "assistant");
  assert.equal(p.items.at(-2).id, "t699");
  // 默认（不给 pick）照旧丢侧链
  assert.equal((await readSessionPage(file, { limit: 100 })).items.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
