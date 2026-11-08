// v4pro 复核（0.6.10）次要三条：会话表有上限、克隆和面板 git 同口径、终端 --version 不为补核等十分钟（源码断言）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const G = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(G, p), "utf8");

test("200-6-05：SESSIONS 超 5000 删最旧的", () => {
  assert.match(rd("gw/run.mjs"), /SESSIONS\.set\(init\.session_id[^\n]*\n[^\n]*\n\s*if \(SESSIONS\.size > 5000\) SESSIONS\.delete\(SESSIONS\.keys\(\)\.next\(\)\.value\);/);
});

test("建项目克隆：不许 ext:: 传输、不跑 fsmonitor，地址前有 --", () => {
  assert.match(rd("gw/projects.mjs"), /spawn\("git", \["-c", "protocol\.ext\.allow=never", "-c", "core\.fsmonitor=false", "clone", "--depth", "50", "--", url, dest\]/);
});

test("195-M.4 guard 半：只打版本时不联网补核，没核过照样不起", () => {
  const s = rd("guard/cc-seal.mjs");
  assert.match(s, /const versionOnly = user\.length === 1 && \(user\[0\] === "--version" \|\| user\[0\] === "-v"\);/);
  assert.match(s, /if \(cs\.pending && !versionOnly && fs\.existsSync\(inst\)\) \{/);
  assert.ok(s.indexOf("versionOnly") < s.indexOf("if (cs.ok === false)"), "核验失败照样退出 4");
});
