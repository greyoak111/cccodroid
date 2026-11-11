// BUG-P04（对照第一轮 FIND-023）：单条合法 JSON、但 message.content=[null] 的记录，
// 报告2 的复核条件：正向 / 倒向读取都不能被它阻断，同页正常消息照常返回；
// 去掉坏记录的独立对照读取结果相同，游标照常推进，读路径不改写原文件。
// 第一轮 d 组已在 transcript.mjs 逐条容错；这里补上报告2 明确要求、第一轮没断言的游标推进与原文件不变。
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { readSessionForward, readSessionPage } from "../gw/transcript.mjs";

const DIR = fs.mkdtempSync(path.join(process.env.CCAPP_TMP, "stab2-g-null-"));
const line = (o) => JSON.stringify(o) + "\n";
const msg = (type, text, uuid = crypto.randomUUID()) => line({
  type, uuid, timestamp: new Date().toISOString(),
  message: { role: type, content: type === "assistant" ? [{ type: "text", text }] : text },
});
// 合法 JSON，但内容块是 null：报告2 说的那种记录
const bad = () => line({ type: "user", uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), message: { role: "user", content: [null] } });

function fixture(withBad) {
  const rows = [
    msg("user", "一问"), msg("assistant", "一答"),
    msg("user", "二问"), msg("assistant", "二答"),
    ...(withBad ? [bad()] : []),
    msg("user", "三问"), msg("assistant", "三答"),
    msg("user", "四问"), msg("assistant", "四答"),
  ];
  const f = path.join(DIR, crypto.randomUUID() + ".jsonl");
  fs.writeFileSync(f, rows.join(""));
  return f;
}
const texts = (items) => items.map((x) => x.text).filter((t) => /^[一二三四][问答]$/.test(t));

test("倒着读：坏记录不抛错，邻记录照常成页，游标推进，原文件一个字节都不变", async () => {
  const file = fixture(true), before = fs.readFileSync(file);
  let page;
  assert.doesNotThrow(async () => { page = await readSessionPage(file, { limit: 2 }); });
  page = await readSessionPage(file, { limit: 2 });
  assert.ok(page.items.length >= 2, "页里要有正常消息");
  assert.ok(page.cursor > 0, "还能继续往前翻：游标要推进，不能停在坏记录上死循环");
  // 往前翻到底：坏记录之后（文件开头一侧）的正常消息也要读得出来
  let all = [...page.items], cursor = page.cursor;
  while (cursor > 0) {
    const p = await readSessionPage(file, { before: cursor, limit: 50 });
    all = [...p.items, ...all];
    cursor = p.cursor;
  }
  assert.deepEqual(texts(all).sort(), ["一答", "一问", "三答", "三问", "二答", "二问", "四答", "四问"].sort());
  assert.deepEqual(fs.readFileSync(file), before, "读路径不改写原文件");
});

test("正向读：坏记录不阻断，next 推进到文件末尾，独立对照（去掉坏记录）结果一致", async () => {
  const withBad = fixture(true), clean = fixture(false);
  const readAll = async (file) => {
    let after = 0, out = [], guard = 0;
    for (;;) {
      const p = await readSessionForward(file, { after, limit: 2 });
      out.push(...p.items);
      if (p.next >= p.size) break;
      assert.ok(p.next > after, "next 必须往前走");
      after = p.next;
      assert.ok(++guard < 20, "分页没有收敛");
    }
    return out;
  };
  const got = await readAll(withBad), want = await readAll(clean);
  assert.deepEqual(texts(got), texts(want), "坏记录只跳过自己，不改变正常消息的顺序与内容");
  assert.deepEqual(texts(got).sort(), ["一答", "一问", "三答", "三问", "二答", "二问", "四答", "四问"].sort());
});
