#!/usr/bin/env node
// 网关测试：node scripts/test.mjs [文件名片段 …]
//
// 每次在一个新建的临时目录里跑：CCAPP_HOME / HOME / CCAPP_WORKSPACE 指过去，假 $PREFIX 里放系统 curl 链接与受控 toybox兼容 flock fixture，
// CCAPP_TEST=1 让网关模块导入时不做任何启动动作（见 gw/config.mjs 的 LIVE）。所以在开发机上跑也碰不到真数据。
// 临时目录要能建软链：安卓上别放 /sdcard（没设 TMPDIR 时自动用 ~/.cache）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { installRegistryFlock } from "../gateway/tests/fixtures/registry-flock.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TESTS = path.join(ROOT, "gateway", "tests");
const want = process.argv.slice(2);
const files = fs.readdirSync(TESTS).filter((f) => f.endsWith(".test.mjs") && (!want.length || want.some((w) => f.includes(w)))).sort();
if (!files.length) { console.error("没有匹配的测试文件"); process.exit(1); }

const curl = spawnSync("sh", ["-c", "command -v curl"], { encoding: "utf8" }).stdout.trim();
if (!curl) { console.error("找不到 curl"); process.exit(1); }

// 安卓上 /tmp 应用写不进：没设 TMPDIR 又写不进系统临时目录时，用 ~/.cache
const writable = (d) => { try { fs.accessSync(d, fs.constants.W_OK); return true; } catch { return false; } };
const base = process.env.TMPDIR || (writable(os.tmpdir()) ? os.tmpdir() : path.join(os.homedir(), ".cache"));
fs.mkdirSync(base, { recursive: true });
const tmp = fs.mkdtempSync(path.join(base, "cccodroid-test-"));
const home = path.join(tmp, "home"), prefix = path.join(tmp, "usr"), workspace = path.join(tmp, "workspace");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });
fs.symlinkSync(curl, path.join(prefix, "bin", "curl"));
installRegistryFlock(prefix, home, tmp); // 只写本轮假 PREFIX；锁协议测试不依赖开发机 util-linux / toybox。

// 在 cccodroid 里跑时环境里有二十几个 CCAPP_* 指着真数据：一个不留全删，再只设测试要的（审查 L18）。
// 网关给 claude 注入的 CLAUDE_CODE_* / ANTHROPIC_*（上下文窗口、接口地址…）也会漏进被测的 claudeEnv，一并去掉（11-01 独立审查）
const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CCAPP_|CLAUDE_CODE_|ANTHROPIC_)/.test(k)));
const env = { ...clean, CCAPP_TEST: "1", CCAPP_HOME: home, HOME: home, CCAPP_WORKSPACE: workspace, CCAPP_PREFIX: prefix, CCAPP_PORT: "8799", CCAPP_LOG: path.join(tmp, "gateway.log"), CCAPP_TMP: tmp };

// 异步起：被 timeout / Ctrl-C / 关终端打断时也要删掉临时目录（以前用 spawnSync，信号一来整个进程直接没了，4 天攒下 29 个，D10）。
// 收到信号先转给测试进程，等它退出再删；SIGKILL 接不住，留给存储的自动清理（$TMPDIR 里 7 天没动的）
const child = spawn(process.execPath, ["--test", "--test-concurrency=1", ...files.map((f) => path.join(TESTS, f))], { env, stdio: "inherit", cwd: ROOT });
let stopped = null;
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { stopped = sig; try { child.kill(sig); } catch {} });
child.on("exit", (code, signal) => {
  if (!process.env.KEEP_TEST_TMP) fs.rmSync(tmp, { recursive: true, force: true });
  else console.log("临时目录留着：" + tmp);
  if (stopped) console.error(`测试被 ${stopped} 打断，临时目录已${process.env.KEEP_TEST_TMP ? "留着" : "删掉"}`);
  process.exit(code ?? (signal || stopped ? 130 : 1));
});
