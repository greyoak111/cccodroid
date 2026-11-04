// v0.6.6 的回归测试（#148–#154 等）
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { CFG } from "../gw/config.mjs";

const proj = path.join(CFG.home, ".claude", "projects", "-v066");
fs.mkdirSync(proj, { recursive: true });
function session(turns) {
  const sid = crypto.randomUUID(), L = [], ids = {};
  let parent = null;
  const add = (o) => { const uuid = crypto.randomUUID(); L.push({ sessionId: sid, parentUuid: parent, ...o, uuid }); parent = uuid; return uuid; };
  for (const [q, a] of turns) {
    ids[q] = add({ type: "user", message: { role: "user", content: q } });
    ids[a] = add({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: a }] } });
  }
  const file = path.join(proj, sid + ".jsonl");
  fs.writeFileSync(file, L.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return { sid, ids, file };
}

test("#153-1 删消息：界面交来的字节游标换算成改写后的位置，续读不跳内容", async () => {
  const { deleteMessage } = await import("../gw/sessionops.mjs");
  const { readSessionForward } = await import("../gw/transcript.mjs");
  const s = session([["U1", "A1"], ["U2", "A2"], ["U3", "A3"], ["U4", "A4"]]);
  const old = fs.readFileSync(s.file);
  const atU3 = old.indexOf('"content":"U3"'), u3 = old.lastIndexOf(10, atU3) + 1;
  const atU2 = old.lastIndexOf(10, old.indexOf('"content":"U2"')) + 1;
  // 删 U2 的回复：它后面 U3 的父链接也会被改写，偏移挪动不止被删那一行的长度
  const r = deleteMessage(s.sid, "U2", 2, "bot", s.ids.U2, s.ids.A2, [u3, atU2, old.length, 0]);
  assert.equal(r.ok, true);
  const now = fs.readFileSync(s.file);
  assert.equal(r.size, now.length);
  assert.equal(r.moved[old.length], now.length);
  assert.equal(r.moved[0], 0);
  assert.equal(r.moved[atU2], atU2);   // 删点之前的不动
  assert.notEqual(r.moved[u3], u3);
  const pg = await readSessionForward(s.file, { after: r.moved[u3], limit: 10 });
  assert.equal(pg.items[0].text ?? pg.items[0].content, "U3");
  // 拿旧偏移去读就会跳过 U3（这正是原来的毛病）
  const bad = await readSessionForward(s.file, { after: u3, limit: 10 });
  assert.notEqual(bad.items[0]?.text ?? bad.items[0]?.content, "U3");
});
