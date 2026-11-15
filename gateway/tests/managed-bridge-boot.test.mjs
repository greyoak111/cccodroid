import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("真实网关启动回调无需用户消息即可预热，并恢复上个进程的故障锁", async () => {
  const root = fs.mkdtempSync(path.join(process.env.CCAPP_TMP, "warm-boot-"));
  const home = path.join(root, "home"), prefix = path.join(root, "usr"), runtime = path.join(root, "bridge");
  const state = path.join(runtime, "runtime-home/.claude-code-router");
  const put = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
  const instanceId = "0123456789abcdef0123456789abcdef";
  const endpoint = "http://127.0.0.1:34591";
  put(path.join(home, ".cccodroid/services/openai-bridge.json"), JSON.stringify({ schema: 1, id: "openai-bridge", runtimeDir: runtime, instanceId, endpoint }));
  put(path.join(root, "components/openai-bridge.json"), JSON.stringify({ id: "openai-bridge", state: "ok", files: ["lib/openai-bridge/component.cjs"] }));
  put(path.join(prefix, "lib/openai-bridge/component.cjs"), `const fs=require('node:fs');
fs.writeFileSync(${JSON.stringify(path.join(runtime, "called"))},process.argv[2]);
console.log(JSON.stringify(${JSON.stringify({ schema: 1, id: "openai-bridge", ready: true, instanceId, endpoint })}));`);
  put(path.join(state, "recovery.failed"), "previous process\n");
  put(path.join(state, "recovery.attempts"), "3\n");
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const env = { ...process.env, HOME: home, CCAPP_HOME: home, CCAPP_PREFIX: prefix,
    CCAPP_WORKSPACE: path.join(root, "workspace"), CCAPP_LOG: path.join(root, "gateway.log") };
  delete env.CCAPP_TEST;
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [new URL("../server.mjs", import.meta.url).pathname, String(port)], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try {
    const deadline = Date.now() + 10000;
    while (!out.includes("托管桥已预热") && Date.now() < deadline && child.exitCode === null) await delay(50);
    assert.match(out, /托管桥已预热/);
    assert.equal(fs.readFileSync(path.join(runtime, "called"), "utf8"), "ensure");
    assert.equal(fs.existsSync(path.join(state, "recovery.failed")), false);
    assert.equal(fs.existsSync(path.join(state, "recovery.attempts")), false);
    assert.ok(fs.readdirSync(state).some((name) => name.startsWith("recovery.failed.prev-")));
  } finally {
    child.kill("SIGKILL");
    await exited;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
