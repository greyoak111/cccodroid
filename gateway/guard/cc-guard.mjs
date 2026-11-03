#!/usr/bin/env node
// cc-guard.mjs —— 敏感操作再确认（PreToolUse 钩子）。网关起 claude 时经 --settings 挂上，权限模式是什么都会跑：
// 碰到密钥 / 凭据文件、要改管着提示词和安全机制的文件、或要读屏、点按、读剪贴板、往外分享文件时回 permissionDecision:"ask"。
// 「全部放行」下 claude 也会因此停下来问（实测 2.1.3xx：hook 的 ask 照样发 can_use_tool，decision_reason_type=hook），
// 网关认出 reason 里的 cccodroid-guard 前缀，出一张「敏感操作」卡片，不按全部放行自动允许。
//
// 这是兜底，不是围墙：命令写得绕一点（base64、变量拼接）就认不出来。防的是 Claude 被网页 / 文件里藏的指令带偏，
// 顺手去读密钥、操作别的应用这类「明面上」的动作。出错一律放行（不输出），别因为它把正常的活卡死。
import fs from "node:fs";

// 密钥与凭据：按路径特征认，不依赖具体 home 在哪
const SECRETS = [
  [/\.gateway-token\b|\bCCAPP_TOKEN_FILE\b/, "gateway token"],
  [/ccapp-(?:providers|config|seed)[\w.-]*\.json/, "provider API keys"],
  [/\.cache\/(?:ccapp-key|llama-api-key)/, "API key file"],
  [/(?:^|[\/\s"'=~@<>:])\.ssh(?:\/|\b)/, "SSH keys"],
  [/\bid_(?:rsa|ed25519|ecdsa|dsa)\b/, "SSH private key"],
  [/(?:^|[\/\s"'=~@<>:])\.gnupg\b/, "GPG keys"],
  [/\.aws\/credentials\b/, "AWS credentials"],
  [/\.config\/gh\/hosts\.ya?ml\b/, "GitHub CLI token"],
  [/\.git-credentials\b/, "git credentials"],
  [/(?:^|[\/\s"'=~@<>:])\.netrc\b/, ".netrc credentials"],
  [/\.claude\/\.credentials\.json\b/, "Claude login credentials"],
  [/\.(?:keystore|jks|p12|pfx)\b/, "signing keystore"],
  [/[\w-]\.(?:pem|key)(?=$|[\s"'\/;|&)])/, "private key file"],
  [/(?:^|[\/\s"'=~@<>:])\.(?:npmrc|pypirc)\b/, "package registry token"],
  [/(?:^|[\/\s"'=~@<>:])\.env(?:\.(?!example\b|sample\b|template\b|dist\b)[\w-]+)?(?=$|[\s"'\/;|&)<>])/, ".env secrets"],
];

// 管着提示词和安全机制的文件：改了能让下一轮的 Claude 换一套规矩，或者伪造「它之前说过的话」（见 gw/integrity.mjs）。
// 只拦写（写文件的工具、命令里提到）；读不拦。CLAUDE.md 不在里面：记项目约定是它的正经用途，天天要改
const PROMPT = [
  [/\.claude\/settings(?:\.local)?\.json\b/, "Claude Code settings and hooks"],
  [/\.claude\/output-styles\//, "output style"],
  // 用户级 CLAUDE.md 每个会话都加载，等于常驻系统提示（第三份破甲审计的常驻层之一）；项目里的 CLAUDE.md 照旧不问
  [/(?:(?:^|[\s"'=:])(?:~|\$\{?HOME\}?)|\/files\/home)\/\.claude\/(?:CLAUDE\.md|rules\/)/, "user-level CLAUDE.md (loaded into every session)"],
  [/\.claude\/projects\/[^\s"']*\.jsonl\b/, "conversation history"],
  [/ccapp-session-seals\.json\b/, "conversation integrity seals"],
  [/ccapp-settings\.json\b/, "app settings"],
  [/cc-guard\.mjs\b/, "this safety check"],
  // 打开项目就会自动跑的东西（见 gw/projtrust.mjs）和应用自己的代码：改了等于在下一轮塞进一个程序
  [/(?:^|[\/\s"'=~@<>:])\.mcp\.json\b/, "project MCP servers"],
  [/(?:^|[\/\s"'=~@<>:])\.claude\.json\b/, "Claude Code MCP config"],
  [/\.claude\/(?:hooks|agents)\//, "hooks and agents"],
  [/ccapp-project-trust\.json\b/, "trusted project list"],
  // 整个 files/app 都是：界面脚本、TOOLS.md（拼进系统提示）、建档规范（模型自己会去读）也在里面（群友破甲清单 V-12/V-13）
  [/(?:\/files|(?:~|\$\{?HOME\}?)\/\.\.)\/app(?=$|[\/\s"';|&)])/, "cccodroid gateway code"],
  [/\.cccodroid-env\.json\b/, "device facts in the system prompt"],
  // 不提文件名、经 claude 自己的命令改用户级配置：加 MCP 服务器、改设置（钩子 / disableAllHooks）、装插件（DeepSeek 复核 11-03 C-1）
  [/\bclaude\s+(?:mcp\s+(?:add|add-json|add-from-claude-desktop)|config\s+(?:set|add)|plugins?\s+(?:install|add|enable|marketplace))\b/, "Claude Code config via CLI"],
  // 能把这一层整个关掉的：安全模式（--safe-mode 连 --settings 挂的钩子一起不跑）的开关文件和接口，
  // 以及再起一个不带这一层的 claude —— 多个 --settings 后一个整个顶掉前一个，--bare / --safe-mode 不跑任何钩子（2.1.311 实测）
  [/\.ccapp-safe-mode\b|\/api\/safe-mode\b/, "safe mode (turns this check off)"],
  // 旗标前允许引号（claude "--bare"），--allowedTools 能不问就放行工具（DeepSeek 复核必修 4）
  [/\bclaude\b[^\n;&|]*?[\s"'](?:--settings|--setting-sources|--safe-mode|--bare|--dangerously-skip-permissions|--allow-dangerously-skip-permissions|--allowed-?[Tt]ools|--permission-mode["']?[\s=]+["']?(?:bypassPermissions|auto|dontAsk|acceptEdits))(?=$|[\s=;|&)'"])/, "Claude Code started without this check"],
  // Claude Code 程序、它的签名清单、current 软链：删了清单再换程序，起 claude 前的核验就无从比对（见 gw/claudeseal.mjs）
  [/\.local\/share\/cccodroid\/claude(?=$|[\/\s"';|&)])/, "the Claude Code program and its signed manifest"],
];
const WRITERS = new Set(["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"]);

// 设备工具（mcp 服务器名叫 device）：会读到别的应用内容、替用户操作别的应用、把文件交出去的
const DEVICE = {
  screen_read: "device:screen", screenshot: "device:screen", screen_tap: "device:screen",
  screen_swipe: "device:screen", screen_type: "device:screen", screen_key: "device:screen",
  clipboard_read: "device:clipboard", share_file: "device:share",
};

function strings(tool, inp) {
  if (!inp || typeof inp !== "object") return [];
  if (tool === "Bash") return [inp.command];
  return [inp.file_path, inp.path, inp.notebook_path, inp.pattern, inp.glob];
}

export function judge(tool, inp) {
  const m = /^mcp__device__(.+)$/.exec(String(tool || ""));
  if (m && DEVICE[m[1]]) return { cat: DEVICE[m[1]], what: m[1] };
  for (const s of strings(tool, inp)) {
    if (typeof s !== "string" || !s) continue;
    for (const [re, what] of SECRETS) {
      const hit = re.exec(s);
      if (hit) return { cat: "secret:" + what, what: what + ": " + hit[0].replace(/^[\s"'=~@<>:\/]+/, "").slice(0, 80) };
    }
  }
  if (WRITERS.has(tool)) for (const s of strings(tool, inp)) {
    if (typeof s !== "string" || !s) continue;
    for (const [re, what] of PROMPT) {
      const hit = re.exec(s);
      if (hit) return { cat: "prompt:" + what, what: what + ": " + hit[0].slice(0, 80) };
    }
  }
  return null;
}

// 当钩子跑：stdin 是 claude 给的 JSON。网关挂钩子时不读盘上这个文件，把启动时核过的源码整段经 node -e 跑，末尾补一句 runHook()（见 gw/claude.mjs）
export function runHook() {
  let raw = "";
  try { raw = fs.readFileSync(0, "utf8"); } catch {}
  try {
    const ev = JSON.parse(raw);
    const r = judge(ev.tool_name, ev.tool_input);
    if (r) process.stdout.write(JSON.stringify({ hookSpecificOutput: {
      hookEventName: "PreToolUse", permissionDecision: "ask",
      permissionDecisionReason: `cccodroid-guard|${r.cat}|${r.what}`,
    } }));
  } catch {}
  process.exit(0);
}
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) runHook();
