// FIND-013：上次会话指针改成原子替换，写到一半被杀不会留下半截 JSON
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CFG } from "../gw/config.mjs";
import { LAST_SESSION, forgetSession, rememberSession } from "../gw/runs.mjs";

const FILE = path.join(CFG.home, "ccapp-last-session.json");

test("换名失败时旧指针原样保留，目标文件不会出现半截", () => {
  fs.writeFileSync(FILE, JSON.stringify({ id: "old", at: 1 }));
  const orig = fs.renameSync;
  fs.renameSync = () => { throw new Error("boom"); };
  try { rememberSession("new"); } finally { fs.renameSync = orig; }
  assert.equal(JSON.parse(fs.readFileSync(FILE, "utf8")).id, "old", "旧文件没被就地截断");
  assert.equal(LAST_SESSION.id, "new", "内存里的指针照常更新");
});

test("正常写入后指针是合法 JSON，读得回来", () => {
  rememberSession("sid-1");
  assert.equal(JSON.parse(fs.readFileSync(FILE, "utf8")).id, "sid-1");
  forgetSession();
  assert.equal(fs.existsSync(FILE), false);
  assert.equal(LAST_SESSION, null);
});
