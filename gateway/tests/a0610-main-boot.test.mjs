// 启动顺序（server.mjs）：端口拿到了才收上一任的运行标记（0.6.9 审计 195-T.2）
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";

const SERVER = new URL("../server.mjs", import.meta.url).pathname;
const home = fs.mkdtempSync(path.join(process.env.CCAPP_TMP, "boot-t2-"));
const busy = net.createServer();
after(() => { busy.close(); fs.rmSync(home, { recursive: true, force: true }); });
const sid = "0b0e0000-0000-4000-8000-000000000002";

test("端口被旧网关占着：重复拉起的这个退出，旧网关的运行标记原样不动", async () => {
  await new Promise((r) => busy.listen(0, "127.0.0.1", r));
  fs.mkdirSync(path.join(home, ".claude/projects/p"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude/projects/p", sid + ".jsonl"), "");
  const mark = path.join(home, "ccapp-run-mark.json");
  const body = JSON.stringify({ runs: [{ id: "r1", sessionId: sid, text: "一", startedAt: 1 }], queue: [{ id: "q1", sessionId: sid, message: "来" }] });
  fs.writeFileSync(mark, body);
  const env = { ...process.env, CCAPP_HOME: home, HOME: home, CCAPP_LOG: path.join(home, "gateway.log") };
  delete env.NODE_TEST_CONTEXT; delete env.CCAPP_TEST;
  const child = spawn(process.execPath, [SERVER, String(busy.address().port)], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { out += d; });
  const code = await new Promise((r) => { const t = setTimeout(() => { child.kill("SIGKILL"); r("timeout"); }, 15000); child.on("exit", (c) => { clearTimeout(t); r(c); }); });
  assert.equal(code, 1, "应当因端口被占退出：\n" + out);
  assert.match(out, /监听失败/, out);
  assert.equal(fs.existsSync(mark) ? fs.readFileSync(mark, "utf8") : null, body, "旧网关的运行标记被改了：\n" + out);
  assert.doesNotMatch(out, /已放回队列|中断记录/, out);
});
