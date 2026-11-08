// 0.6.9 审计 200-14-01：网关执行的 web/lang-*.js 只用核过的字节（部署时由 appfiles.mjs 挂读法）
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { HERE, setLangReader, tr } from "../gw/config.mjs";

test("词典读法：核不过（给 null）就回退中文；给的字节照用；不再直接读盘", () => {
  setLangReader(() => null);
  assert.equal(tr("ja", "会话"), "会话", "核不过：不用这份词典");
  const real = fs.readFileSync(path.join(HERE, "web", "lang-ja.js"));
  const seen = [];
  setLangReader((rel) => { seen.push(rel); return real; });
  assert.equal(tr("ja", "会话"), "セッション");
  assert.deepEqual(seen, ["web/lang-ja.js"]);
  setLangReader(() => Buffer.from("while(true){}"));
  assert.equal(tr("ko", "会话"), "会话", "死循环的词典：超时放弃，网关不卡死");
  setLangReader(null);
  assert.equal(tr("ja", "会话"), "セッション", "开发时（没有清单）照旧读仓库");
});
