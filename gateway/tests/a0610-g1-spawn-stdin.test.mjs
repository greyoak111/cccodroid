// 195-G.5：应用拉起网关时经 stdin 管道交一个随机数。应用不写（或者晚写）时，阻塞的 readSync(0)
// 会让网关在 listen 之前一直等着，5 秒期限根本轮不到。这里用 FIFO 模拟应用给的阻塞管道（Node 自己的
// stdio: "pipe" 是 socketpair，/proc 重开不了，不像应用）：一个只开着不写，一个写随机数，看导入能否
// 按时结束、派生钥匙算得对不对。
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs 就在这里拦下
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ACCESS = pathToFileURL(fileURLToPath(new URL("../gw/access.mjs", import.meta.url))).href;
const TOKEN_FILE = path.join(process.env.CCAPP_HOME, ".gateway-token");
const NONCE = "a".repeat(32);
const DIR = fs.mkdtempSync(path.join(process.env.CCAPP_TMP || process.env.TMPDIR || os.tmpdir(), "g1-spawn-"));
const FIFO = path.join(DIR, "stdin");
for (const bin of ["mkfifo", "/system/bin/mkfifo"]) {
  try { execFileSync(bin, [FIFO], { stdio: "ignore" }); break; } catch {}
}
after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {} });

/** 起一个子进程导入 access.mjs，fd 0 是阻塞的 FIFO（与 App 给的管道同型）；返回子进程和写端 */
function start(script) {
  const wfd = fs.openSync(FIFO, fs.constants.O_RDWR);   // O_RDWR：同一描述符里读写两端都开着，读空时阻塞、不 EOF
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: [wfd, "pipe", "pipe"],
    env: { ...process.env, CCAPP_SPAWN_KEY: "stdin" },
  });
  return { child, wfd };
}
/** 等子进程退出；超时就杀掉并判失败（旧代码会一直挂在这里） */
function waitExit(child, ms, out) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`导入被 stdin 阻塞读挂住了（>${ms}ms）。输出：${out()}`)); }, ms);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("exit", (code) => { clearTimeout(timer); resolve(code); });
  });
}

test("应用不写随机数、管道一直开着：导入照样在 5 秒期限后结束", { timeout: 20000 }, async () => {
  const t0 = Date.now();
  let out = "";
  const script = `await import(${JSON.stringify(ACCESS)}); console.log("imported");`;
  const { child, wfd } = start(script);
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  try {
    const code = await waitExit(child, 12000, () => out);
    const dt = Date.now() - t0;
    assert.equal(code, 0, out);
    assert.match(out, /imported/);
    assert.ok(dt < 9000, `导入用了 ${dt}ms，远超 5 秒期限`);
  } finally { fs.closeSync(wfd); }
});

test("随机数照常收到：proof 用「令牌 + 启动随机数」派生的钥匙算", { timeout: 20000 }, async () => {
  const key = crypto.randomBytes(32).toString("hex");
  let out = "";
  const script = `import fs from "node:fs";
    const { proof } = await import(${JSON.stringify(ACCESS)});
    const token = fs.readFileSync(${JSON.stringify(TOKEN_FILE)}, "utf8").trim();
    console.log(JSON.stringify({ proof: proof(${JSON.stringify(NONCE)}, "127.0.0.2"), token }));
  `;
  const { child, wfd } = start(script);
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  fs.writeSync(wfd, key + "\n");     // 应用的做法：写一行随机数，管道不关
  try {
    const code = await waitExit(child, 8000, () => out);
    assert.equal(code, 0, out);
    const j = JSON.parse(out.trim().split("\n").pop());
    const [boot, got] = String(j.proof || "").split(" ");
    assert.match(boot, /^[0-9a-f]{32}$/);
    // 子进程读到的令牌应与磁盘上的一致；用它 + 随机数派生钥匙，能算出同一个 proof
    assert.equal(j.token, fs.readFileSync(TOKEN_FILE, "utf8").trim());
    const k = crypto.createHmac("sha256", j.token).update("spawn:" + key).digest("hex");
    const want = crypto.createHmac("sha256", k).update(`proof:${NONCE}:${boot}:127.0.0.2`).digest("hex");
    assert.equal(got, want, "proof 不是按启动随机数派生的钥匙算的");
  } finally { fs.closeSync(wfd); }
});

test("Node 自己起的子进程：stdin 是 socketpair，也读得到随机数", () => {
  // spawnSync 的 input 给的是 socketpair，/proc/self/fd/0 打不开（antibreach 那条测试就是这么起子进程的）。
  // 重开失败时退回阻塞读，不能把交来的随机数丢了，不然派生钥匙对不上、界面认不出网关。
  const key = crypto.randomBytes(32).toString("hex");
  const script = `import fs from "node:fs";
    const { proof } = await import(${JSON.stringify(ACCESS)});
    const token = fs.readFileSync(${JSON.stringify(TOKEN_FILE)}, "utf8").trim();
    console.log(JSON.stringify({ proof: proof(${JSON.stringify(NONCE)}, "127.0.0.2"), token }));
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, CCAPP_SPAWN_KEY: "stdin" }, input: key + "\n", encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const j = JSON.parse(r.stdout.trim().split("\n").pop());
  const [boot, got] = String(j.proof || "").split(" ");
  const k = crypto.createHmac("sha256", j.token).update("spawn:" + key).digest("hex");
  const want = crypto.createHmac("sha256", k).update(`proof:${NONCE}:${boot}:127.0.0.2`).digest("hex");
  assert.equal(got, want, "socketpair 上的随机数没读到，退回令牌了");
});
