// F8（0.6.9 审计 200-S-07）：同一个会话号出现在两个项目目录里时，给了这一轮的工作目录就取 claude 按它会读的那份
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { PATHS } from "../gw/config.mjs";
import { findSessionFile } from "../gw/sessions.mjs";

const enc = (p) => p.replace(/[^a-zA-Z0-9]/g, "-");
const sid = crypto.randomUUID();
const work = fs.mkdtempSync(path.join(os.tmpdir(), "f8-"));
const wantDir = path.join(PATHS.projects, enc(fs.realpathSync(work)));
const otherDir = path.join(PATHS.projects, "-a-f8-first");   // 排序上在前：不给 cwd 时会先取到它
after(() => { for (const d of [wantDir, otherDir, work]) fs.rmSync(d, { recursive: true, force: true }); });

test("给 cwd：取那个目录下的那份；不给：照旧按目录顺序", () => {
  fs.mkdirSync(wantDir, { recursive: true }); fs.mkdirSync(otherDir, { recursive: true });
  fs.writeFileSync(path.join(wantDir, sid + ".jsonl"), "{}\n");
  fs.writeFileSync(path.join(otherDir, sid + ".jsonl"), "{}\n");
  assert.equal(findSessionFile(sid, work).file, path.join(wantDir, sid + ".jsonl"));
  assert.ok(findSessionFile(sid));
  // 那个目录下没有：退回按目录顺序
  fs.rmSync(path.join(wantDir, sid + ".jsonl"));
  assert.equal(findSessionFile(sid, work).file, path.join(otherDir, sid + ".jsonl"));
  // 防穿越照旧
  assert.equal(findSessionFile("../x", work), null);
});

test("这一轮的核对 / 封签按 run.cwd 找；运行标记带上 cwd，重启补封签也按它找", () => {
  const run = fs.readFileSync(new URL("../gw/run.mjs", import.meta.url), "utf8");
  const queue = fs.readFileSync(new URL("../gw/queue.mjs", import.meta.url), "utf8");
  assert.ok(run.includes("findSessionFile(String(run.sessionId), run.cwd)"));
  assert.ok(queue.includes("...(r.cwd ? { cwd: r.cwd } : {})"));
  assert.ok(queue.includes('findSessionFile(String(r.sessionId), typeof r.cwd === "string" ? r.cwd : undefined)'));
});
