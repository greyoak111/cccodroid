// OBS-004：反向分页对超大单行没有上限。一行跨很多块时不能无限攒 Buffer / 拼成巨串，
// 超过上限就整条跳过（照旧推进 cursor），前后正常的行一页不少。
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CFG } from "../gw/config.mjs";
import { readSessionPage } from "../gw/transcript.mjs";

const dir = path.join(CFG.home, ".page-cap-test");
after(() => fs.rmSync(dir, { recursive: true, force: true }));
fs.mkdirSync(dir, { recursive: true });

const TS = "2026-11-01T00:00:00Z";
const line = (uuid, text) => JSON.stringify({ type: "user", uuid, timestamp: TS, message: { role: "user", content: text } }) + "\n";
const BIG = "巨".repeat(150000);   // 约 450 KB，跨块
const fileOf = (name, body) => { const f = path.join(dir, name); fs.writeFileSync(f, body); return f; };

test("中间的超大单行超上限：整条跳过，前后两行照常成一页", async () => {
  const f = fileOf("mid.jsonl", line("u1", "第一问") + line("big", BIG) + line("u3", "第三问"));
  const page = await readSessionPage(f, { limit: 10, maxLine: 1000 });
  assert.deepEqual(page.items.map((x) => x.text), ["第一问", "第三问"]);
  assert.equal(page.cursor, 0, "跳过后 cursor 仍落在下一行的开头，翻页不丢内容");
});

test("默认上限下这条行照常显示（没误伤正常的大工具结果）", async () => {
  const f = fileOf("mid2.jsonl", line("u1", "第一问") + line("big", BIG) + line("u3", "第三问"));
  const page = await readSessionPage(f, { limit: 10 });
  assert.equal(page.items.length, 3);
  assert.equal(page.items[1].text, BIG);
});

test("超上限的行在文件开头：跳过也不死循环，cursor 回到 0", async () => {
  const f = fileOf("head.jsonl", line("big", BIG) + line("u2", "第二问"));
  const page = await readSessionPage(f, { limit: 10, maxLine: 1000 });
  assert.deepEqual(page.items.map((x) => x.text), ["第二问"]);
  assert.equal(page.cursor, 0);
});
