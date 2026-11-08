#!/usr/bin/env node
// cc-seal.mjs —— 应用内终端里敲的 claude（bin/claude 包装）在发行版下的封口与回填，和网关起的一样（见 gw/edition.mjs、gw/seal.mjs）。
// 用法：node cc-seal.mjs <工作目录> -- <包装给的参数…> -- <用户的参数…>
// 成功：stdout 一行，按 sh 单引号转义好的完整参数，包装 eval "set -- …" 后 exec；退出码 0。
// 拒绝：stderr 说明，退出码 3（命中破甲特征）、2（用了发行版不认的旗标）或 4（claude 程序没核过）。
// 包装给的参数（guard 钩子、密钥读取器的 --settings）可以带 --settings；用户自己带的那些能往上下文里塞东西的旗标一律不认。
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
// stdout 只放结果：网关模块的日志改走 stderr（先改再加载模块）
console.log = (...a) => process.stderr.write(a.join(" ") + "\n");
const { sealArgv, sealed } = await import("../gw/edition.mjs");
const { sealBlockMessage, sealPrepare } = await import("../gw/seal.mjs");
const { tr, tz, HERE } = await import("../gw/config.mjs");
const { readSmallFile } = await import("../gw/saferead.mjs");

const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
const argv = process.argv.slice(2);
const cwd = argv[0] || process.cwd();
const i1 = argv.indexOf("--", 1), i2 = argv.indexOf("--", i1 + 1);
if (i1 < 0 || i2 < 0) { process.stderr.write("cc-seal: bad arguments\n"); process.exit(2); }
const ours = argv.slice(i1 + 1, i2), user = argv.slice(i2 + 1);

// 开发版：原样交回
if (!sealed()) { process.stdout.write([...ours, ...user].map(q).join(" ") + "\n"); process.exit(0); }

// claude 程序本身：和网关起的一样（gw/claudeseal.mjs），没有 Anthropic 签名清单、或和清单对不上就不起；管理子命令也一样，跑的是同一个程序。
// 没清单的当场补核一次（install-claude.mjs --recheck，联网取官方清单），输出走 stderr，stdout 只放结果
{
  const { claudeSeal } = await import("../gw/claudeseal.mjs");
  // 和 bin/claude 最后 exec 的是同一条路径：都按 $HOME 算（CCAPP_HOME 终端里能随便改，不能让核的和跑的是两份）
  const home = process.env.HOME || "/nonexistent";
  const BIN = path.join(home, ".local", "share", "cccodroid", "claude", "current", "claude");
  const check = () => claudeSeal(BIN, { home }).catch((e) => ({ ok: false, why: e.message }));
  let cs = await check();
  const inst = path.join(HERE, "scripts", "install-claude.mjs");
  // 只是打个版本（自检就这么问）：不为它联网补核、一等十分钟；没核过照样不起，当场报（0.6.9 审计 195-M.4 guard 半，v4pro 复核）
  const versionOnly = user.length === 1 && (user[0] === "--version" || user[0] === "-v");
  if (cs.pending && !versionOnly && fs.existsSync(inst)) {
    process.stderr.write("cccodroid: 这个版本还没有官方签名清单，正在联网补核… / no signed manifest yet, fetching the official one…\n");
    spawnSync(process.execPath, [inst, "--recheck"], { stdio: ["ignore", 2, 2], timeout: 600000 });
    cs = await check();
  }
  if (cs.ok === false) {
    const m = cs.pending ? tz("这个版本的 Claude Code 还没有官方签名清单，这一轮没有启动。正在联网补核，过一两分钟再发送；一直不行就到 设置 → 更新 里重新安装。") : tz("Claude Code 程序核验没过，这次没有运行：{why}", { why: String(cs.why || "") });
    process.stderr.write("cccodroid: " + m + "\ncccodroid: " + tr("en", m) + "\n");
    process.exit(4);
  }
}

// 能往上下文 / 配置里塞东西的旗标：发行版终端不认（用户的 --settings 能挂 SessionStart 钩子注入，--system-prompt 能整个换掉系统提示）
const DENY = ["--settings", "--setting-sources", "--plugin-dir", "--plugin-url", "--append-system-prompt", "--append-system-prompt-file",
  "--system-prompt", "--system-prompt-file", "--agents", "--mcp-config", "--bare", "--safe-mode", "--append-subagent-system-prompt",
  "--append-subagent-system-prompt-file"];
// 管理子命令（mcp / plugin / config…）不开会话，照常
const probe = sealArgv(user);
const isSession = probe !== user;
if (isSession) {
  for (const a of user) {
    if (a === "--") break;
    const flag = a.split("=")[0];
    if (DENY.includes(flag)) {
      process.stderr.write(`cccodroid: ${flag} 在发行版里不能用（Claude Code 的配置由 cccodroid 检查后代为加载）。\n` +
        `cccodroid: ${flag} is not available in the release build (cccodroid loads your Claude Code config after checking it).\n`);
      process.exit(2);
    }
  }
}
let out = [...ours, ...user];
if (isSession) {
  let prep;
  let style = "";
  try { style = JSON.parse(readSmallFile(path.join(process.env.HOME || "", "ccapp-settings.json"), 1 << 20) || "{}").outputStyle || ""; } catch {}
  try { prep = sealPrepare({ cwd, runId: "term-" + process.ppid + "-" + Date.now(), outputStyle: style }); }
  catch (e) { process.stderr.write("cccodroid: " + e.message + "\n"); process.exit(3); }
  if (prep.block) { const m = sealBlockMessage(prep.block); process.stderr.write(m + "\n\n" + tr("en", m) + "\n"); process.exit(3); }
  out = [...ours, ...prep.args, ...(prep.settings && Object.keys(prep.settings).length ? ["--settings", JSON.stringify(prep.settings)] : []), ...user];
}
try { out = sealArgv(out); } catch (e) { process.stderr.write("cccodroid: " + e.message + "\n"); process.exit(2); }
process.stdout.write(out.map(q).join(" ") + "\n");
