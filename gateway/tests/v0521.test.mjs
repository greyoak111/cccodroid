// v0.5.21：#89 书签 / 上次读到（正向读首屏）也带上这个会话最新的上下文用量，不借上一个会话的
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下，下面一行都不跑
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { CFG } from "../gw/config.mjs";
import { NEXT } from "../gw/http.mjs";
import { latestContextTokens } from "../gw/transcript.mjs";

const proj = path.join(CFG.home, ".claude", "projects", "-v0521");
fs.mkdirSync(proj, { recursive: true });
const usage = (n) => ({ input_tokens: 10, cache_read_input_tokens: n - 10, output_tokens: 5 });
function session(lines) {
  const sid = crypto.randomUUID();
  const L = lines.map((o) => ({ sessionId: sid, uuid: crypto.randomUUID(), ...o }));
  const file = path.join(proj, sid + ".jsonl");
  fs.writeFileSync(file, L.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return { sid, file, L };
}
const user = (text) => ({ type: "user", message: { role: "user", content: text } });
const bot = (text, n, extra = {}) => ({ type: "assistant", ...extra, message: { role: "assistant", model: "m", content: [{ type: "text", text }], ...(n ? { usage: usage(n) } : {}) } });

test("最新用量：取最后一条带用量的主会话回复，侧链、合成消息不算", async () => {
  const s = session([user("q1"), bot("a1", 12000), user("q2"), bot("a2", 30000), bot("side", 99000, { isSidechain: true }),
    { type: "assistant", message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "x" }], usage: usage(88000) } }, user("q3")]);
  assert.equal(await latestContextTokens(s.file), 30000);
});

test("最新用量：压缩边界之后没有回复时取压缩后的数，不越过边界拿旧的；没有任何用量是 null", async () => {
  const a = session([user("q"), bot("a", 150000), { type: "system", subtype: "compact_boundary", compactMetadata: { preTokens: 150000, postTokens: 16000 } }, user("q2")]);
  assert.equal(await latestContextTokens(a.file), 16000);
  const b = session([user("q"), bot("a", 150000), { type: "system", subtype: "compact_boundary", compactMetadata: {} }]);
  assert.equal(await latestContextTokens(b.file), null);
  const c = session([user("只问了一句，还没答")]);
  assert.equal(await latestContextTokens(c.file), null);
});

test("按锚点（书签 / 上次读到）打开：首屏带最新用量；往后翻页不带（#89）", async () => {
  const { routeSessions } = await import("../gw/sessions.mjs");
  const srv = http.createServer(async (req, res) => { const u = new URL(req.url, "http://x"); if ((await routeSessions(req, res, u, u.pathname)) === NEXT) res.writeHead(404).end(); });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok)); after(() => srv.close());
  const get = async (q) => (await fetch(`http://127.0.0.1:${srv.address().port}/api/session/${q}`)).json();
  const lines = [];
  for (let i = 0; i < 30; i++) lines.push(user("问 " + i), bot("答 " + i, 1000 * (i + 1)));
  const s = session(lines);
  const anchor = s.L[2].uuid;                       // 第二轮的提问：锚点附近的用量是 2000，最新的是 30000
  const first = await get(`${s.sid}?limit=4&anchor=${anchor}`);
  assert.ok(first.items.length > 0 && first.next < first.size);
  assert.equal(first.contextTokens, 30000, "首屏要报这个会话最新的用量，不是锚点附近的");
  const next = await get(`${s.sid}?limit=4&after=${first.next}`);
  assert.equal(next.contextTokens, undefined, "往后翻页不该带用量");
  const back = await get(`${s.sid}?limit=40`);
  assert.equal(back.contextTokens, 30000);           // 倒着读的首屏照旧
});
