// 0.6.10 车道 b2：书签（gw/bookmarks.mjs）——projects 读不出来时不清空全部书签（195-Y.8）、写失败回 500 并回滚（195-N.1）
import "../gw/config.mjs";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { CFG, PATHS } from "../gw/config.mjs";

const BM_FILE = path.join(CFG.home, "ccapp-bookmarks.json");
const sid = crypto.randomUUID();
const item = { id: "b1", sid, uuid: crypto.randomUUID(), off: 0, para: 0, role: "assistant", excerpt: "旧", at: 1 };
fs.writeFileSync(BM_FILE, JSON.stringify([item]));
process.env.CCAPP_TEST = "1";

const { routeBookmarks, forgetBookmarks } = await import("../gw/bookmarks.mjs");

const call = async (method, url, body) => {
  const req = body === undefined ? { method } : Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method });
  const u = new URL(url, "http://x"), res = { code: 0, body: null, writeHead(c) { this.code = c; }, end(b) { this.body = JSON.parse(b.toString()); } };
  await routeBookmarks(req, res, u, u.pathname);
  return res;
};

before(() => { fs.mkdirSync(PATHS.projects, { recursive: true }); });
after(() => { try { fs.chmodSync(PATHS.projects, 0o755); } catch {} });

test("projects 目录读不出来：书签原样回、标 unreadable，不清空（195-Y.8）", async () => {
  fs.chmodSync(PATHS.projects, 0o000);
  try {
    const r = await call("GET", "/api/bookmarks");
    assert.equal(r.code, 200);
    assert.equal(r.body.unreadable, true);
    assert.equal(r.body.items.length, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(BM_FILE, "utf8")).map((x) => x.id), ["b1"], "盘上的书签不能被清掉");
  } finally { fs.chmodSync(PATHS.projects, 0o755); }
});

test("写入失败：回 500 write_failed，内存里也回滚（195-N.1）", async () => {
  // 造一个能认领到回复的会话
  const dir = path.join(PATHS.projects, "-b2-bm");
  fs.mkdirSync(dir, { recursive: true });
  const s2 = crypto.randomUUID();
  fs.writeFileSync(path.join(dir, s2 + ".jsonl"), JSON.stringify({ type: "assistant", sessionId: s2, uuid: crypto.randomUUID(), message: { role: "assistant", content: [{ type: "text", text: "hello" }] } }) + "\n");
  const old = fs.readFileSync(BM_FILE);
  fs.rmSync(BM_FILE); fs.mkdirSync(BM_FILE);   // 目标位置是目录 → 换名必失败
  try {
    const r = await call("POST", "/api/bookmarks", { session: s2, role: "assistant", head: "hello" });
    assert.equal(r.code, 500);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.error, "write_failed");
    const g = await call("GET", "/api/bookmarks?session=" + s2);
    assert.equal(g.body.items.length, 0, "失败的那条不能留在内存里");
  } finally {
    fs.rmSync(BM_FILE, { recursive: true, force: true });
    fs.writeFileSync(BM_FILE, old);
  }
});

test("彻底删除会话时清掉它的书签并落盘（195-A.7 的书签那半）", async () => {
  assert.equal(forgetBookmarks(sid), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(BM_FILE, "utf8")), []);
});
