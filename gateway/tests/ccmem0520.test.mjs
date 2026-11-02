// 内存管家 cc-mem（android/assets/bin/cc-mem.mjs）· v0.5.20 审查 #107：09-002 / 09-003 / 09-011 / 09-012。
// 把脚本拷进临时目录，旁边放一个假的 priv.mjs（cc-mem 优先用同目录的）：按命令回放 dumpsys、模拟 stop-app 成败，命令记进日志
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const SRC = new URL("../../android/assets/bin/cc-mem.mjs", import.meta.url);
const dir = fs.mkdtempSync(path.join(process.env.CCAPP_TMP, "ccmem-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
fs.copyFileSync(SRC, path.join(dir, "cc-mem.mjs"));
const LOG = path.join(dir, "priv.log"), FIX = path.join(dir, "fix.json");
fs.writeFileSync(path.join(dir, "priv.mjs"), `
import fs from "node:fs";
const cmd = process.argv[process.argv.length - 1], fx = JSON.parse(fs.readFileSync(${JSON.stringify(FIX)}, "utf8"));
fs.appendFileSync(${JSON.stringify(LOG)}, cmd.replace(/\\n/g, " ") + "\\n");
let out = "";
if (cmd.includes("dumpsys activity lru")) out = "@LRU\\n" + fx.lru + "\\n@PROC\\n" + fx.procs;
else if (cmd.includes("dumpsys meminfo")) out = fx.meminfo || "";
else if (cmd.includes("get-bg-restriction-level")) out = "adaptive_bucket";
else for (const m of cmd.matchAll(/am (?:force-stop|stop-app) '([^']+)' && echo @ok '[^']+' \\|\\| echo @fail '[^']+'/g)) out += ((fx.fail || []).includes(m[1]) ? "@fail " : "@ok ") + m[1] + "\\n";
process.stdout.write(out);
`);
const settings = (enabled, whitelist = []) => fs.writeFileSync(path.join(dir, "ccapp-settings.json"), JSON.stringify({ memGuard: { enabled, whitelist } }));
const fixture = (o) => fs.writeFileSync(FIX, JSON.stringify(o));
const env = { ...process.env, CCAPP_HOME: dir, HOME: dir };
const run = (...a) => spawnSync(process.execPath, [path.join(dir, "cc-mem.mjs"), ...a], { env, encoding: "utf8", timeout: 30000 });
const log = () => { try { return fs.readFileSync(LOG, "utf8"); } catch { return ""; } };
const lru = (rows) => rows.map(([pid, pkg, cls = "cch+75"], i) => `  #${i}: ${cls} CEM  ---- ${pid}:${pkg}/u0a${100 + i}`).join("\n");
const procs = (rows) => rows.map(([pid, list]) => `  *APP* UID 10100 ProcessRecord{abc ${pid}:${list[0]}/u0a100}\n    packageList={${list.join(", ")}}`).join("\n");

test("09-003 有一个包没停下：只报真停了的，没停下的单独列出", () => {
  settings(true); fs.rmSync(LOG, { force: true });
  fixture({ lru: lru([[101, "com.ex.a"], [102, "com.ex.b"]]), procs: procs([[101, ["com.ex.a"]], [102, ["com.ex.b"]]]), fail: ["com.ex.a"] });
  const r = run("clear", "--json");
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.deepEqual(j.stopped, ["com.ex.b"]);
  assert.deepEqual(j.failed, ["com.ex.a"]);
});

test("09-011 白名单包和别的包同一个进程：两个都不停", () => {
  settings(true, ["com.ex.kept"]); fs.rmSync(LOG, { force: true });
  // 两个包都在 LRU 里（同一个 pid）：只有一行时 apps 里只有白名单包，旧逻辑也停不到谁，判别不出（DeepSeek 复核 低-8）
  fixture({ lru: lru([[201, "com.ex.kept"], [201, "com.ex.component"]]), procs: procs([[201, ["com.ex.kept", "com.ex.component"]]]) });
  const r = run("clear", "--json");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).stopped, []);
  assert.doesNotMatch(log(), /stop-app|force-stop/);
});

test("09-012 一个进程加载两个包：合计占用只算一份", () => {
  settings(true); fs.rmSync(LOG, { force: true });
  fixture({ lru: lru([[301, "com.ex.x"]]), procs: procs([[301, ["com.ex.x", "com.ex.y"]]]),
    meminfo: "Total PSS by process:\n    1,024K: com.ex.x (pid 301)\n\n" });
  const r = run("status", "--json");
  assert.equal(r.status, 0, r.stderr);
  const apps = JSON.parse(r.stdout).apps;
  assert.equal(apps.length, 2);
  assert.equal(apps.reduce((s, a) => s + a.pss, 0), 1024 * 1024);
});

test("09-002 cc-mem run 跑着时关掉内存管家：之后的巡检不再停应用", async () => {
  settings(true); fs.rmSync(LOG, { force: true });
  fixture({ lru: lru([[401, "com.ex.r"]]), procs: procs([[401, ["com.ex.r"]]]) });
  // 被包的命令睡 7 秒：开跑清一次；关掉开关后巡检（每 2 秒）不该再停
  const child = spawn(process.execPath, [path.join(dir, "cc-mem.mjs"), "run", "--", "sleep", "7"], { env, stdio: ["ignore", "ignore", "pipe"] });
  let err = ""; child.stderr.on("data", (d) => { err += d; });
  for (let i = 0; i < 100 && !/开始执行/.test(err); i++) await new Promise((r) => setTimeout(r, 100));
  settings(false);
  const n0 = (log().match(/force-stop/g) || []).length;
  const code = await new Promise((r) => child.on("exit", r));
  assert.equal(code, 0, err);
  assert.equal(n0, 1, "开跑清了一次");
  assert.equal((log().match(/force-stop/g) || []).length, 1, "关掉之后没再停：" + log());
  assert.match(err, /内存管家关掉了/);
});
