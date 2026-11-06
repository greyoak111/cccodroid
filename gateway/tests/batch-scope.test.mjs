// 会话页的批量动作只作用于看得见的（#176）：杂项一键清理、导出 / 删除所选；批量回收分开报「正在生成」和「已经不在了」
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import vm from "node:vm";
import { CFG } from "../gw/config.mjs";
import { NEXT } from "../gw/http.mjs";

const src = fs.readFileSync(new URL("../web/app/07-sessions.js", import.meta.url), "utf8");
const take = (start, end) => { const a = src.indexOf(start), b = src.indexOf(end, a); assert.ok(a >= 0 && b > a, start); return src.slice(a, b); };

test("已选里只算眼前看得见的：换了筛选 / 搜索，或会话已经不在了，之前勾的不参与导出、删除", () => {
  const box = { Set, sess: { sel: new Set(["a", "b", "gone"]), visible: ["b", "c"] }, state: { sessions: [] } };
  vm.runInNewContext(take("  function selShown()", "  function renderTrash(") + "\nglobalThis.f = selShown;", box);
  assert.deepEqual([...box.f()], ["b"]);
});

test("杂项「全部移到回收站」只动这一组看得见的，不连带筛选外别的项目的杂项", async () => {
  const deleted = [];
  const box = {
    Set, sess: { misc: ["m1", "m2"], keepDays: 30 }, view: { sessionId: null }, srv: { runs: [{ sessionId: "m2" }] },
    state: { sessions: [{ id: "m1", misc: true }, { id: "m2", misc: true }, { id: "m3", misc: true }, { id: "x" }] },
    confirm: (m) => { box.asked = m; return true; }, t: (k, o) => k.replace(/\{(\w+)\}/g, (_, n) => o[n]),
    api: async (u) => { deleted.push(decodeURIComponent(u.split("/").pop())); }, loadSessions() {}, newConversation() {}, toast() {},
  };
  vm.runInNewContext(take("  async function clearMisc()", "  // 搜索：输完停") + "\nglobalThis.f = clearMisc;", box);
  await box.f();
  assert.deepEqual(deleted, ["m1"], "m2 在跑跳过，m3 是筛选外的杂项不动");
  assert.match(box.asked, /1 个/);
});

test("批量回收：正在生成的进 busy，已经不在的只进 failed", async () => {
  const { routeSessions } = await import("../gw/sessions.mjs");
  const proj = path.join(CFG.home, ".claude", "projects", "-i176");
  fs.mkdirSync(proj, { recursive: true });
  const sid = crypto.randomUUID();
  fs.writeFileSync(path.join(proj, sid + ".jsonl"), JSON.stringify({ type: "user", sessionId: sid, uuid: crypto.randomUUID(), message: { role: "user", content: "hi" } }) + "\n");
  const srv = http.createServer(async (req, res) => { const u = new URL(req.url, "http://x"); if ((await routeSessions(req, res, u, u.pathname)) === NEXT) res.writeHead(404).end(); });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok)); after(() => srv.close());
  const gone = crypto.randomUUID();
  const r = await (await fetch(`http://127.0.0.1:${srv.address().port}/api/sessions/trash`, { method: "POST", body: JSON.stringify({ ids: [sid, gone] }) })).json();
  assert.deepEqual(r.done, [sid]);
  assert.deepEqual(r.failed, [gone]);
  assert.deepEqual(r.busy, []);
});
