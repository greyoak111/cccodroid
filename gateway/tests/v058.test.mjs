// v0.5.7 独立审查的网关一侧：组件技能名、响应体上限、回退补救写哪
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs 就在这里拦下
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { CFG } from "../gw/config.mjs";

test("组件技能名：只认一层的正常名字，.. 、带斜杠、绝对路径都不给（M1）", async () => {
  const { skillDst } = await import("../gw/components.mjs");
  const { SKILLS_DIR } = await import("../gw/extensions.mjs");
  assert.equal(skillDst("blender"), path.join(SKILLS_DIR, "blender"));
  assert.equal(skillDst("my_skill-1.2"), path.join(SKILLS_DIR, "my_skill-1.2"));
  for (const bad of ["..", ".", "../x", "a/b", "/etc", "", "a".repeat(65), null, 3]) assert.equal(skillDst(bad), null, String(bad));
});

test("读响应体有上限：声明超长、实际超长都断开；正常的照读（L5）", async () => {
  const { fetchText } = await import("../gw/http.mjs");
  const srv = http.createServer((req, res) => {
    if (req.url === "/ok") return res.end('{"data":[]}');
    if (req.url === "/big-declared") { res.writeHead(200, { "content-length": String(64 << 20) }); return res.end(); }
    res.writeHead(200);                    // 不报长度，一块块推
    const chunk = Buffer.alloc(1 << 20, 97); let n = 0;
    const push = () => { while (n < 20 && res.write(chunk)) n++; if (n < 20) res.once("drain", () => { n++; push(); }); else res.end(); };
    push();
  });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  after(() => srv.close());
  const u = (p) => `http://127.0.0.1:${srv.address().port}${p}`;
  assert.equal(await fetchText(await fetch(u("/ok"))), '{"data":[]}');
  await assert.rejects(fetchText(await fetch(u("/big-declared"))), /too large/);
  await assert.rejects(fetchText(await fetch(u("/stream")), 4 << 20), /too large/);
});

test("回退补救：只许写工作区或会话记录过的项目目录（L6）", async () => {
  const { rewindTargetOk } = await import("../gw/sessionops.mjs");
  fs.mkdirSync(CFG.workspace, { recursive: true });
  assert.equal(rewindTargetOk(path.join(CFG.workspace, "proj", "a.js")), true);
  assert.equal(rewindTargetOk(path.join(CFG.home, ".bashrc")), false);
  assert.equal(rewindTargetOk(path.join(CFG.home, ".claude", "settings.json")), false);
  assert.equal(rewindTargetOk(CFG.workspace), false, "工作区本身不是文件");
  assert.equal(rewindTargetOk("/sdcard/Documents/proj/a.js"), false, "没记录过 cwd 的外部路径不许");
  assert.equal(rewindTargetOk("/sdcard/Documents/proj/a.js", ["/sdcard/Documents/proj"]), true);
  assert.equal(rewindTargetOk("relative/a.js"), false);
  // 11-03 审查 M-7：files 之外的私有数据（shared_prefs、databases…）也不许
  assert.equal(rewindTargetOk(path.join(path.dirname(path.dirname(CFG.home)), "shared_prefs", "consent.xml")), false);
  // 工作区里一个软链指回 home：按真实路径判，拦下
  const link = path.join(CFG.workspace, "sneaky");
  try { fs.symlinkSync(CFG.home, link); } catch {}
  if (fs.existsSync(link)) {
    assert.equal(rewindTargetOk(path.join(link, ".bashrc")), false);
    fs.unlinkSync(link);
  }
});
