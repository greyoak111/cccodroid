// 会话记录的分页读取（gw/transcript.mjs）：往前翻、从某处往后读、按 uuid 找行首——脉络里点站跳到章节靠这几样
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { findLineOffset, lineHas, readSessionForward, readSessionPage } from "../gw/transcript.mjs";

const DIR = fs.mkdtempSync(path.join(process.env.CCAPP_TMP, "transcript-"));
const T0 = Date.parse("2026-10-20T00:00:00Z");
const iso = (min) => new Date(T0 + min * 60000).toISOString();

/** 30 轮问答，第 12 轮前压缩一次；返回文件路径与压缩消息的 uuid */
function build() {
  const lines = [], sid = crypto.randomUUID();
  let parent = null, compact = null;
  for (let i = 0; i < 30; i++) {
    if (i === 12) {
      compact = crypto.randomUUID();
      lines.push({ type: "user", uuid: compact, parentUuid: null, sessionId: sid, timestamp: iso(i * 2), isCompactSummary: true, message: { role: "user", content: "摘要：前面聊了很多" } });
      parent = compact;
    }
    const u = { type: "user", uuid: crypto.randomUUID(), parentUuid: parent, sessionId: sid, timestamp: iso(i * 2), message: { role: "user", content: `问题 ${i}` } };
    const a = { type: "assistant", uuid: crypto.randomUUID(), parentUuid: u.uuid, sessionId: sid, timestamp: iso(i * 2 + 1), message: { role: "assistant", content: [{ type: "text", text: `回答 ${i} ` + "长".repeat(i * 37) }] } };
    lines.push(u, a); parent = a.uuid;
  }
  const file = path.join(DIR, sid + ".jsonl");
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return { file, compact };
}
const texts = (items) => items.filter((it) => it.role === "user" || it.role === "assistant").map((it) => it.text.split(" ").slice(0, 2).join(" "));

test("按 uuid 找到行首，缓存的偏移能核对", async () => {
  const { file, compact } = build();
  const off = await findLineOffset(file, compact);
  assert.ok(off > 0);
  const buf = fs.readFileSync(file);
  assert.equal(buf[off - 1], 10, "落在行首");
  assert.ok(await lineHas(file, off, compact));
  assert.ok(!(await lineHas(file, off + 5, compact)), "偏了就对不上");
  assert.equal(await findLineOffset(file, crypto.randomUUID()), -1);
});

test("从压缩处往后一页页读到底：不漏、不重、页边界在提问前", async () => {
  const { file, compact } = build();
  const off = await findLineOffset(file, compact);
  const seen = [];
  let after = off, pages = 0, first = null;
  for (;;) {
    const p = await readSessionForward(file, { after, limit: 10 });
    if (!first) first = p;
    seen.push(...texts(p.items));
    pages++;
    assert.ok(p.next > after || p.next === p.size);
    if (p.next >= p.size) break;
    assert.ok(fs.readFileSync(file).subarray(p.next, p.next + 40).toString().includes('"type":"user"'), "下一页从提问开始");
    after = p.next;
  }
  assert.ok(pages > 1);
  const c = first.items.find((it) => it.compact);
  assert.ok(c && c.uuid === compact, "第一页带着压缩条目和它的 uuid");
  const want = Array.from({ length: 18 }, (_, k) => [`问题 ${k + 12}`, `回答 ${k + 12}`]).flat();
  assert.deepEqual(seen, want);
});

test("往后读的内容和往前翻的内容拼得上", async () => {
  const { file, compact } = build();
  const off = await findLineOffset(file, compact);
  // 往前：从 off 往上翻到头
  const back = [];
  let before = off;
  while (before > 0) {
    const p = await readSessionPage(file, { before, limit: 10 });
    back.unshift(...texts(p.items));
    if (p.cursor >= before) break;
    before = p.cursor;
  }
  const fwd = [];
  let after = off;
  for (;;) {
    const p = await readSessionForward(file, { after, limit: 10 });
    fwd.push(...texts(p.items));
    if (p.next >= p.size) break;
    after = p.next;
  }
  const all = await readSessionForward(file, { after: 0, limit: 200 });
  assert.deepEqual([...back, ...fwd], texts(all.items));
});
