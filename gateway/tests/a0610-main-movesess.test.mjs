// 0.6.9 审计 200-8-06：搬会话时原记录删不掉 → 整个退回去，不留两份
import { CFG, PATHS } from "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

test("原记录所在目录只读、删不掉：报错，新位置的记录删掉", async (t) => {
  if (process.getuid?.() === 0) return t.skip("root 下只读目录挡不住删除");
  const { moveSession, projectSlug } = await import("../gw/projects.mjs");
  const { findSessionFile } = await import("../gw/sessions.mjs");
  const odd = path.join(CFG.workspace, "mv-src"); fs.mkdirSync(odd, { recursive: true });
  const srcDir = path.join(PATHS.projects, projectSlug(fs.realpathSync(odd)));
  fs.mkdirSync(srcDir, { recursive: true });
  const sid = crypto.randomUUID(), f = path.join(srcDir, sid + ".jsonl");
  fs.writeFileSync(f, JSON.stringify({ type: "user", uuid: crypto.randomUUID(), sessionId: sid, cwd: odd, message: { role: "user", content: "hi" } }) + "\n");
  fs.chmodSync(srcDir, 0o555);
  try {
    assert.throws(() => moveSession(sid, null), /删不掉/);
  } finally { fs.chmodSync(srcDir, 0o755); }
  assert.equal(findSessionFile(sid).file, f, "会话留在原处");
  const dstDir = path.join(PATHS.projects, projectSlug(fs.realpathSync(CFG.workspace)));
  assert.equal(fs.existsSync(path.join(dstDir, sid + ".jsonl")), false, "新位置不留第二份");
});
