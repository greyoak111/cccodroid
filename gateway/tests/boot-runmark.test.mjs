// 网关启动时收上一任的运行标记：带会话的排队消息不能让网关崩（11-02 群友日志：queue.mjs 顶层就收标记，
// 撞上循环引用里还没初始化的 SID_RE，ReferenceError 退出；标记已先删掉，排着的消息跟着丢了）
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const SERVER = new URL("../server.mjs", import.meta.url).pathname;
const home = fs.mkdtempSync(path.join(process.env.CCAPP_TMP, "boot-"));
after(() => fs.rmSync(home, { recursive: true, force: true }));
const sid = "0b0e0000-0000-4000-8000-000000000001";

test("上一任排着一条带会话的消息：网关照常起来，消息放回队列", async () => {
  fs.mkdirSync(path.join(home, ".claude/projects/p"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude/projects/p", sid + ".jsonl"), "");
  fs.writeFileSync(path.join(home, "ccapp-run-mark.json"), JSON.stringify({
    runs: [{ id: "r1", sessionId: sid, text: "一", startedAt: 1 }],
    queue: [{ id: "q1", sessionId: sid, message: "来" }],
  }));
  // 要按真跑的样子起（LIVE：模块导入时就做启动动作），只是 home、日志都在临时目录，起来就杀掉
  const env = { ...process.env, CCAPP_HOME: home, HOME: home, CCAPP_LOG: path.join(home, "gateway.log") };
  delete env.NODE_TEST_CONTEXT; delete env.CCAPP_TEST;
  const child = spawn(process.execPath, [SERVER, "0"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { out += d; });
  let code = null; child.on("exit", (c) => { code = c; });
  for (let i = 0; i < 150 && code === null && !/网关 v3 已启动/.test(out); i++) await new Promise((r) => setTimeout(r, 100));
  child.kill("SIGKILL");
  assert.equal(code, null, "网关退出了：\n" + out);
  assert.match(out, /网关 v3 已启动/, out);
  assert.match(out, /排队的 1 条消息已放回队列/, out);
});
