// 第 4 波（收官波）三仓共性 P2 竞态与对称收官专项测试（A-06..A-10 + bridge-config ctimeNs）
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CFG, PATHS } from "../gw/config.mjs";
import { imageRefs } from "../gw/inlineimg.mjs";
import { transcriptItems } from "../gw/transcript.mjs";
import { goalStateOf, goalStateOfAsync, goalCheckAsync } from "../gw/goal.mjs";
import { routeUsage } from "../gw/usage.mjs";
import { laneOfItem } from "../gw/queue.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const readRepo = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");

test("A-06 & A-09: Java 宿主剥离 CCAPP_TOKEN_FILE、.gateway.pid 收割、AppFiles.ensureSynced、Env.proc 与 bin/claude 延迟 unset", () => {
  const share = readRepo("android/java/cc/codroid/Share.java");
  assert.ok(share.includes('pb.environment().remove("CCAPP_TOKEN_FILE")'));
  assert.ok(share.includes("env.proc("));

  const ins = readRepo("android/java/cc/codroid/Installer.java");
  assert.ok(ins.includes('pb.environment().remove("CCAPP_TOKEN_FILE")'));
  assert.ok(ins.includes("env.proc(cmd)"));

  const shz = readRepo("android/java/cc/codroid/ShizukuSetup.java");
  assert.ok(shz.includes('pb.environment().remove("CCAPP_TOKEN_FILE")'));
  assert.ok(shz.includes("env.proc("));

  const gw = readRepo("android/java/cc/codroid/GatewayService.java");
  assert.ok(gw.includes('GW_PID_FILE = ".gateway.pid"'));
  assert.ok(gw.includes("writeGatewayPid(env.files, gpid, gst)"));
  assert.ok(gw.includes("readGatewayPid(env.files)"));
  assert.ok(gw.includes("AppFiles.ensureSynced("));

  const appf = readRepo("android/java/cc/codroid/AppFiles.java");
  assert.ok(appf.includes("static synchronized SyncResult ensureSynced("));

  const main = readRepo("android/java/cc/codroid/MainActivity.java");
  assert.ok(main.includes("AppFiles.ensureSynced("));

  const envJava = readRepo("android/java/cc/codroid/Env.java");
  assert.ok(envJava.includes("ProcessBuilder proc(String... argv)"));
  assert.ok(envJava.includes('e.put("TERMUX_EXEC__PROC_SELF_EXE", cmd.get(1))'));

  const claudeSh = readRepo("android/assets/bin/claude");
  const idxSed = claudeSh.lastIndexOf("sed -n");
  const idxSeal = claudeSh.lastIndexOf('node "$SEAL"');
  const idxUnset = claudeSh.lastIndexOf("unset LD_PRELOAD");
  const idxExec = claudeSh.lastIndexOf('exec "${CCAPP_LD');
  assert.ok(idxSed > 0 && idxSeal > idxSed && idxUnset > idxSeal && idxExec > idxUnset,
    `unset LD_PRELOAD 必须在 sed/node 之后、exec 紧前 (sed=${idxSed}, seal=${idxSeal}, unset=${idxUnset}, exec=${idxExec})`);
});

test("A-07: 新会话独立车道隔离且 sched fireNow 忙等计入未挂起队列项", () => {
  const a = { id: "r_new_a", sessionId: null, follow: null };
  const b = { id: "r_new_b", sessionId: null, follow: null };
  assert.equal(laneOfItem(a), "n:r_new_a");
  assert.equal(laneOfItem(b), "n:r_new_b");
  assert.notEqual(laneOfItem(a), laneOfItem(b));

  const qSrc = readRepo("gateway/gw/queue.mjs");
  assert.ok(qSrc.includes("!!item.follow && (item.follow === run.id || laneOfItem(item) === run.lane)"));

  const scSrc = readRepo("gateway/gw/sched.mjs");
  assert.ok(scSrc.includes("const busySlots = () => RUNS.size + runnableQueueCount();"));
  assert.ok(scSrc.includes("while (busySlots() >= maxParallel())"));
});

test("A-08: inlineimg imageRefs 与 transcriptItems 支持带空格引号路径 @\"/path/with space.png\"", () => {
  const dir = path.join(CFG.workspace, "wave4-img dir");
  fs.mkdirSync(dir, { recursive: true });
  const imgFile = path.join(dir, "my screen shot.png");
  const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
  fs.writeFileSync(imgFile, pngHeader);
  try {
    const refs = imageRefs(`请看这张图 @"${imgFile}" 谢谢`);
    assert.deepEqual(refs, [imgFile]);

    const items = transcriptItems({
      type: "user",
      uuid: "u-img-space",
      message: {
        role: "user",
        content: [
          { type: "text", text: `请看这张图 @"${imgFile}"` },
          { type: "image", source: { type: "base64", media_type: "image/png", data: pngHeader.toString("base64") } },
        ],
      },
    });
    assert.equal(items.length, 1);
    assert.ok(!items[0].text.includes("[图片]"), `已有 @\"...\" 路径不应多出 [图片]: ${items[0].text}`);

    const plainItems = transcriptItems({
      type: "user",
      uuid: "u-img-plain",
      message: {
        role: "user",
        content: [
          { type: "text", text: "没有路径的纯图消息" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: pngHeader.toString("base64") } },
        ],
      },
    });
    assert.ok(plainItems[0].text.includes("[图片]"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("A-10: goalStateOfAsync 缓存一致性、usageImport 单文件容错、bridge-config ctimeNs 豁免与前端生命周期", async () => {
  const bc = readRepo("gateway/gw/bridge-config.mjs");
  assert.ok(!bc.includes('"ctimeNs"'), "bridge-config.mjs 不应比对 overlayfs 会自发漂移的 ctimeNs");

  const dir = path.join(CFG.workspace, "wave4-goal-cache");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "big-goal.jsonl");
  try {
    const pad = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "x".repeat(2000) }] } }) + "\n";
    const chunk = pad.repeat(600);
    const g1 = JSON.stringify({ type: "attachment", timestamp: "2026-11-24T01:00:00Z", attachment: { type: "goal_status", met: false, sentinel: true, condition: "ALPHA_COND" } }) + "\n";
    fs.writeFileSync(file, chunk + g1);

    const a1 = await goalStateOfAsync(file);
    assert.equal(a1?.condition, "ALPHA_COND");
    assert.equal(goalStateOf(file)?.condition, "ALPHA_COND");

    const st0 = fs.statSync(file);
    const g2 = JSON.stringify({ type: "attachment", timestamp: "2026-11-24T01:00:00Z", attachment: { type: "goal_status", met: false, sentinel: true, condition: "BRAVO_COND" } }) + "\n";
    assert.equal(Buffer.byteLength(g1), Buffer.byteLength(g2));
    fs.writeFileSync(file, chunk + g2);
    fs.utimesSync(file, st0.atime, st0.mtime);

    const a2 = await goalStateOfAsync(file);
    assert.equal(a2?.condition, "BRAVO_COND");
    assert.equal(typeof goalCheckAsync, "function");
    assert.ok(readRepo("gateway/gw/queue.mjs").includes("goalCheckAsync(run.sessionId).catch("));
    assert.ok(readRepo("gateway/gw/sessions.mjs").includes("await goalStateOfAsync(found.file)"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // usageImport 容错
  const projDir = path.join(PATHS.projects, "wave4-usage-resilience");
  fs.mkdirSync(projDir, { recursive: true });
  fs.mkdirSync(path.join(projDir, "bad-dir.jsonl"), { recursive: true });
  const goodSid = "99999999-aaaa-4bbb-8ccc-eeeeeeeeeeee";
  const oldTs = new Date(Date.now() - 48 * 3600e3).toISOString();
  fs.writeFileSync(path.join(projDir, `${goodSid}.jsonl`), [
    JSON.stringify({ type: "user", uuid: "u-w4-1", sessionId: goodSid, timestamp: oldTs, message: { role: "user", content: "hello usage resilience" } }),
    JSON.stringify({ type: "assistant", uuid: "a-w4-1", sessionId: goodSid, timestamp: oldTs, message: { id: "msg-w4-1", role: "assistant", model: "claude-sonnet-4-6", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 10, output_tokens: 5 } } }),
  ].join("\n") + "\n");
  try {
    let status = 0, body = null;
    const { Readable } = await import("node:stream");
    const req = Object.assign(Readable.from([Buffer.from("{}")]), { method: "POST", headers: {} });
    const res = {
      writeHead(code) { status = code; },
      end(chunk) { body = JSON.parse(String(chunk || "{}")); },
    };
    await routeUsage(req, res, new URL("http://localhost/api/usage/import"), "/api/usage/import");
    assert.equal(status, 200);
    assert.equal(body?.ok, true);
    assert.ok(body.prompts >= 1);
  } finally {
    fs.rmSync(projDir, { recursive: true, force: true });
  }

  // 前端生命周期
  const ps = readRepo("gateway/web/app/14-projects-sched.js");
  assert.match(ps, /else if \(setOpen\) \{ setBaseRead = refreshSettings\(false\); enterSetCat\(setCatOpen, true\); \}/);
  assert.ok(ps.includes('if (name === "trash") loadTrash();'));
  assert.ok(ps.includes('if (name === "bookmarks") loadBookmarks();'));
  assert.match(readRepo("gateway/web/app/15-pages.js"), /setBaseRead = Promise\.resolve\(\)/);
  assert.match(readRepo("gateway/web/app/03b-agents.js"), /if \(view\.sessionId !== sid \|\| view\.gen !== gen\) return;/);
  assert.match(readRepo("gateway/web/app/10b-storage.js"), /if \(!setVisible\("storage", visit\)\) return;\s*\n\s*stLater\(800, visit\);/);
  assert.match(readRepo("gateway/web/app/18-pdf-tools.js"), /PT\.errs >= 10/);
});
