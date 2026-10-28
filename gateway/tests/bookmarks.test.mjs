// 书签（gw/bookmarks.mjs）：历史条目带 uuid、从某一页起点往后找行首、刚答完的回复按正文开头从文件尾认领
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { findLineOffset, readSessionPage, transcriptItems } from "../gw/transcript.mjs";
import { claimTail } from "../gw/bookmarks.mjs";

const DIR = fs.mkdtempSync(path.join(process.env.CCAPP_TMP, "bookmarks-"));

function build(n) {
  const lines = [], ids = [];
  for (let i = 0; i < n; i++) {
    const u = { type: "user", uuid: crypto.randomUUID(), message: { role: "user", content: `问题 ${i}` } };
    const a = { type: "assistant", uuid: crypto.randomUUID(), message: { role: "assistant", content: [{ type: "text", text: `回答 ${i}\n\n第二段 ${i}` }] } };
    lines.push(u, a); ids.push([u.uuid, a.uuid]);
  }
  const file = path.join(DIR, crypto.randomUUID() + ".jsonl");
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return { file, ids, lines };
}

test("提问和回复正文都带上 uuid", () => {
  const { lines } = build(1);
  assert.equal(transcriptItems(lines[0])[0].uuid, lines[0].uuid);
  assert.equal(transcriptItems(lines[1])[0].uuid, lines[1].uuid);
});

test("findLineOffset 从给定行首往后找，结果和从头找一致；起点在目标之后就找不到", async () => {
  const { file, ids } = build(40);
  const target = ids[37][1];
  const full = await findLineOffset(file, target);
  assert.ok(full > 0);
  const page = await readSessionPage(file, { limit: 10 });
  assert.ok(page.cursor > 0 && page.cursor < full);
  assert.equal(await findLineOffset(file, target, page.cursor), full);
  assert.equal(await findLineOffset(file, ids[0][0], page.cursor), -1);
  const line = fs.readFileSync(file).subarray(full).toString("utf8").split("\n")[0];
  assert.equal(JSON.parse(line).uuid, target);
});

test("claimTail 认领最后一条开头相同的回复，角色不同不算", async () => {
  const { file, ids } = build(5);
  const r = await claimTail(file, "assistant", "回答 3");
  assert.equal(r.uuid, ids[3][1]);
  assert.equal(r.off, await findLineOffset(file, ids[3][1]));
  assert.equal(await claimTail(file, "user", "回答 3"), null);
  assert.equal((await claimTail(file, "user", "问题 4")).uuid, ids[4][0]);
  assert.equal(await claimTail(file, "assistant", ""), null);
});
