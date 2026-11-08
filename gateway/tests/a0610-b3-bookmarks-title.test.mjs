// 0.6.10 车道 b3：书签列表的标题跟会话列表同一口径（200-15-10 / #50）
// 用户改名 > 档案最新题名 > 第一句提问；以前只看 peekSession 的首问。
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { CFG, PATHS } from "../gw/config.mjs";
import { NAMES } from "../gw/sessions.mjs";
import { archiveImport, saveArchive } from "../gw/archive-store.mjs";

const BM_FILE = path.join(CFG.home, "ccapp-bookmarks.json");
const DIR = path.join(PATHS.projects, "-b3-bm");
const RENAMED = crypto.randomUUID(), ARCHIVED = crypto.randomUUID(), PLAIN = crypto.randomUUID();

function mkSession(sid, q) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, sid + ".jsonl"), JSON.stringify({
    type: "user", sessionId: sid, uuid: crypto.randomUUID(), cwd: CFG.workspace,
    timestamp: new Date().toISOString(), message: { role: "user", content: q },
  }) + "\n");
}
mkSession(RENAMED, "第一句提问甲");
mkSession(ARCHIVED, "第一句提问乙");
mkSession(PLAIN, "第一句提问丙");
fs.writeFileSync(BM_FILE, JSON.stringify([RENAMED, ARCHIVED, PLAIN].map((sid, i) => ({
  id: "b" + i, sid, uuid: crypto.randomUUID(), off: 0, para: 0, role: "user", excerpt: "", at: i,
}))));

process.env.CCAPP_TEST = "1";
const { routeBookmarks } = await import("../gw/bookmarks.mjs");

after(() => fs.rmSync(DIR, { recursive: true, force: true }));

const call = async (method, url) => {
  const u = new URL(url, "http://x"), res = { code: 0, body: null, writeHead(c) { this.code = c; }, end(b) { this.body = JSON.parse(b.toString()); } };
  await routeBookmarks({ method }, res, u, u.pathname);
  return res;
};

test("书签标题：用户改名优先，其次档案题名，最后才是第一句提问", async () => {
  NAMES[RENAMED] = "我改的名字";
  assert.equal(archiveImport(ARCHIVED, { title: "档案里的题名", chapters: { 1: { title: "档案里的题名" } } }), true);
  saveArchive();
  const r = await call("GET", "/api/bookmarks");
  assert.equal(r.code, 200);
  const title = new Map(r.body.items.map((x) => [x.sid, x.title]));
  assert.equal(title.get(RENAMED), "我改的名字", "改名要盖过首问");
  assert.equal(title.get(ARCHIVED), "档案里的题名", "档案题名要盖过首问");
  assert.equal(title.get(PLAIN), "第一句提问丙", "都没有时仍用首问");
});
