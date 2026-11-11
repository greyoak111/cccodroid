// 稳定性报告 FIND-030：同一秒里发起两次导出，名字选择只做了 existsSync 检查，
// 两个请求都挑到 sessions-<stamp>.zip，后完成的 rename 把前一个覆盖掉（会话原件不受损，导出产物丢了）。
// 现在先用 O_EXCL 空文件占住最终名字，第二个自动落到 -2。
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { CFG, PATHS } from "../gw/config.mjs";
import { exportSessions, reserveExportFile } from "../gw/sessionops.mjs";

const proj = path.join(PATHS.projects, "-stabf-export");
const created = [];
after(() => {
  fs.rmSync(proj, { recursive: true, force: true });
  for (const f of created) { try { fs.rmSync(f, { force: true }); } catch {} }
});

function makeSession() {
  const sid = crypto.randomUUID();
  fs.mkdirSync(proj, { recursive: true });
  const u = { type: "user", sessionId: sid, uuid: crypto.randomUUID(), parentUuid: null, cwd: CFG.workspace, timestamp: new Date().toISOString(), message: { role: "user", content: "并发导出" } };
  const a = { type: "assistant", sessionId: sid, uuid: crypto.randomUUID(), parentUuid: u.uuid, cwd: CFG.workspace, timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "好" }] } };
  fs.writeFileSync(path.join(proj, sid + ".jsonl"), [u, a].map((x) => JSON.stringify(x)).join("\n") + "\n");
  return sid;
}

test("FIND-030 同一秒占名字：第二个自动落到 -2，已占的文件不动", () => {
  const dir = fs.mkdtempSync(path.join(CFG.home, "stabf-exp-"));
  try {
    const a = reserveExportFile(dir, "20260101-120000");
    const b = reserveExportFile(dir, "20260101-120000");
    assert.equal(path.basename(a), "sessions-20260101-120000.zip");
    assert.equal(path.basename(b), "sessions-20260101-120000-2.zip");
    assert.ok(fs.existsSync(a) && fs.existsSync(b));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("FIND-030 并发导出各自落盘、都不为空，不留 .part", async () => {
  const sid = makeSession();
  const [a, b] = await Promise.all([exportSessions([sid]), exportSessions([sid])]);
  created.push(a.file, b.file);
  assert.notEqual(a.file, b.file, "两次导出不能是同一个文件");
  for (const f of [a.file, b.file]) {
    assert.ok(fs.existsSync(f), "导出文件要在：" + f);
    assert.ok(fs.statSync(f).size > 0, "不能是占位空文件：" + f);
  }
  const dir = path.dirname(a.file);
  assert.equal(fs.readdirSync(dir).some((n) => n.includes(".part-")), false, "不留半截临时文件");
});
