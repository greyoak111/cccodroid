// FIND-014：导入后自定义标题没保存上时，接口要如实告诉前端（以前 200 完事，重启后标题回退）
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { CFG, PATHS } from "../gw/config.mjs";
import { NAMES, saveNames } from "../gw/sessions.mjs";
import * as ops from "../gw/sessionops.mjs";

const sid = crypto.randomUUID();
const dir = path.join(PATHS.projects, "-d-import");
after(() => fs.rmSync(dir, { recursive: true, force: true }));

function makeSession() {
  fs.mkdirSync(dir, { recursive: true });
  const u = { type: "user", sessionId: sid, uuid: crypto.randomUUID(), parentUuid: null, cwd: CFG.workspace, timestamp: new Date().toISOString(), message: { role: "user", content: "导进来的会话" } };
  const a = { type: "assistant", sessionId: sid, uuid: crypto.randomUUID(), parentUuid: u.uuid, cwd: CFG.workspace, timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "回答" }] } };
  fs.writeFileSync(path.join(dir, sid + ".jsonl"), JSON.stringify(u) + "\n" + JSON.stringify(a) + "\n");
}

test("自定义标题写不进去时，导入结果带上 titleWarning", async () => {
  makeSession();
  NAMES[sid] = "我改的标题";
  saveNames();
  const out = await ops.exportSessions([sid]);
  ops.trashSession(sid);
  await ops.purgeTrash([sid]);
  // 只让改名表的换名失败，其它写盘照常
  const orig = fs.renameSync;
  fs.renameSync = (a, b) => {
    if (String(b) === PATHS.names) throw Object.assign(new Error("boom"), { code: "EIO" });
    return orig(a, b);
  };
  let r;
  try { r = await ops.importSessions(out.file); } finally { fs.renameSync = orig; }
  assert.ok(r.imported.includes(sid), "正文导进来了");
  assert.equal(r.titleWarning, true, "要告诉调用方标题没落盘");
  assert.equal(NAMES[sid], "我改的标题", "内存里的标题还在，下一次保存能补上");
});
