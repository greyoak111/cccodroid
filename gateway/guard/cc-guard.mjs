#!/usr/bin/env node
// cc-guard.mjs —— 敏感操作再确认（PreToolUse 钩子）。网关起 claude 时经 --settings 挂上，权限模式是什么都会跑：
// 碰到密钥 / 凭据文件、要改管着提示词和安全机制的文件、或要读屏、点按、读剪贴板、往外分享文件时回 permissionDecision:"ask"。
// 「全部放行」下 claude 也会因此停下来问（实测 2.1.3xx：hook 的 ask 照样发 can_use_tool，decision_reason_type=hook），
// 网关认出 reason 里的 cccodroid-guard 前缀，出一张「敏感操作」卡片，不按全部放行自动允许。
//
// 这是兜底，不是围墙：命令写得绕一点（base64、变量拼接）就认不出来。防的是 Claude 被网页 / 文件里藏的指令带偏，
// 顺手去读密钥、操作别的应用这类「明面上」的动作。
// 自己出错（读不到、看不懂 claude 给的输入）就回 ask：静默放行等于喂它一段怪输入就能让这一层失效（11-03 自查审计）。
// judge 对各种工具输入都是按类型挑字段，正常的活走不到这里。
import fs from "node:fs";

// 密钥与凭据：按路径特征认，不依赖具体 home 在哪
const SECRETS = [
  [/\.gateway-token\b|\bCCAPP_TOKEN_FILE\b/, "gateway token"],
  // 空格 / 引号拼接改形（红队 r8 11-08）：cat ~/.gate way-token、cat ~/.gate''way-token 这类也要问
  [/\.gate[\s"']*way[\s"']*-?[\s"']*token\b/, "gateway token (split spelling)"],
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
  // 用户级的 skill、斜杠命令、插件也是每个会话都加载；改了由 gw/userconf.mjs 在下一轮前问用户，这里是第一道（第四份破甲审计）
  [/(?:(?:^|[\s"'=:])(?:~|\$\{?HOME\}?)|\/files\/home)\/\.claude\/(?:skills|commands|plugins)\//, "user-level skills, commands and plugins (loaded into every session)"],
  [/\.ccapp-userconf\b|ccapp-userconf\.json\b/, "the record of confirmed Claude Code config"],
  // 整个 files/app 都是：界面脚本、TOOLS.md（拼进系统提示）、建档规范（模型自己会去读）也在里面（群友破甲清单 V-12/V-13）
  [/(?:\/files|(?:~|\$\{?HOME\}?)\/\.\.)\/app(?=$|[\/\s"';|&)])/, "cccodroid gateway code"],
  // 网关自己的运行库（files/gw，安全 4 第 2 层）：网关的 node 和库、它起 claude 用的 glibc。改了网关会拒绝起 claude、重启后按安装包还原，这里先拦
  [/(?:\/files|(?:~|\$\{?HOME\}?)\/\.\.)\/gw(?:-stage)?(?=$|[\/\s"';|&)])/, "the gateway's own runtime"],
  [/\.cccodroid-env\.json\b/, "device facts in the system prompt"],
  // 不提文件名、经 claude 自己的命令改用户级配置：加 MCP 服务器、改设置（钩子 / disableAllHooks）、装插件（DeepSeek 复核 11-03 C-1）
  [/\bclaude\s+(?:mcp\s+(?:add|add-json|add-from-claude-desktop)|config\s+(?:set|add)|plugins?\s+(?:install|add|enable|marketplace))\b/, "Claude Code config via CLI"],
  // 能把这一层整个关掉的：安全模式（--safe-mode 连 --settings 挂的钩子一起不跑）的开关文件和接口，
  // 以及再起一个不带这一层的 claude —— 多个 --settings 后一个整个顶掉前一个，--bare / --safe-mode 不跑任何钩子（2.1.311 实测）
  [/\.ccapp-safe-mode\b|\/api\/safe-mode\b/, "safe mode (turns this check off)"],
  // 网关的控制端点：有令牌就能直调，改权限模式、换上游、存钩子、测钩子（spawn shell）、开终端都得经手确认（红队 r8 11-08）
  [/\/api\/(?:perm\/mode|providers\/save|ext\/hooks\/(?:save|test)|term\/new)\b/, "gateway control endpoint (changes global state)"],
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

// 破甲特征（gw/breach.mjs）：网关挂钩子时把核过的那份源码拼在本文件前面（见 gw/claude.mjs guardSource）；单独跑本文件时现加载
let scanTextFn = typeof scanText === "function" ? scanText : null;   // eslint-disable-line no-undef
if (!scanTextFn) try { ({ scanText: scanTextFn } = await import(new URL("../gw/breach.mjs", import.meta.url))); } catch {}

// 会进下一轮上下文的文字：CLAUDE.md、.claude 底下的说明 / skill / 命令 / 记忆。往里写破甲内容当场拒绝（不是问）：
// 发行版下一轮起进程前也会查到、整轮不跑，这里提前挡住，别让模型把自己下一轮堵死（见 gw/seal.mjs）
const CONTEXT_PATH = /(?:^|[\/\s"'=>])CLAUDE(?:\.local)?\.md\b|\.claude\/|\/memory\/[^\s"']*\.md\b/;
function written(tool, inp) {
  if (!inp || typeof inp !== "object") return [];
  if (tool === "Write") return [inp.content];
  if (tool === "Edit") return [inp.new_string];
  if (tool === "MultiEdit") return Array.isArray(inp.edits) ? inp.edits.map((e) => e && e.new_string) : [];
  if (tool === "NotebookEdit") return [inp.new_source];
  if (tool === "Bash") return [inp.command];
  return [];
}
export function breachWrite(tool, inp) {
  if (!scanTextFn || !WRITERS.has(tool) || !inp || typeof inp !== "object") return null;
  const target = tool === "Bash" ? inp.command : (inp.file_path || inp.notebook_path);
  if (typeof target !== "string" || !CONTEXT_PATH.test(target)) return null;
  for (const t of written(tool, inp)) {
    if (typeof t !== "string" || !t) continue;
    const r = scanTextFn(t);
    if (r.blocked) { const h = r.hits.find((x) => x.strong) || r.hits[0]; return { cat: "breach", what: "jailbreak-style text into Claude Code config or memory: " + (h ? h.excerpt.slice(0, 60) : "") }; }
  }
  return null;
}

function strings(tool, inp) {
  if (!inp || typeof inp !== "object") return [];
  if (tool === "Bash") return [inp.command];
  return [inp.file_path, inp.path, inp.notebook_path, inp.pattern, inp.glob];
}

// 命令归一（只给 judge 用，不落盘、不回显）：base64 段解出来是可读文本就还原；去掉 '' / "" 引号拼接与反斜杠续词；
// $(echo token) / ${HOME} 这类 shell 展开成字面——命令写得绕一点也认得（红队 r8 11-08：三条绕过里两条真能读到令牌）
const B64_RUN = /\b[A-Za-z0-9+/]{12,}={0,2}\b/g;
function normCmd(s) {
  let t = s;
  try {
    t = t.replace(B64_RUN, (m) => {
      try {
        const d = Buffer.from(m, "base64").toString("utf8").trimEnd();
        return /^[\x20-\x7e]{4,}$/.test(d) ? d : m;
      } catch { return m; }
    });
  } catch {}
  return t
    .replace(/["']{2}/g, "")
    .replace(/\\(?=[A-Za-z])/g, "")
    .replace(/\$\s*\(\s*echo\s+(?:-n\s+)?['"]?([^'")]+)['"]?\s*\)/g, "$1")
    .replace(/\$\{([A-Za-z_][\w]*)\}/g, "$1");
}

export function judge(tool, inp) {
  const m = /^mcp__device__(.+)$/.exec(String(tool || ""));
  if (m && DEVICE[m[1]]) return { cat: DEVICE[m[1]], what: m[1] };
  const list = strings(tool, inp);
  // Bash 命令：原文和归一后的两条都查（归一后能认出拼接/展开/base64 改形的密钥路径）
  const texts = list.flatMap((s) => (tool === "Bash" && typeof s === "string" && s ? [s, normCmd(s)] : [s]));
  for (const s of texts) {
    if (typeof s !== "string" || !s) continue;
    for (const [re, what] of SECRETS) {
      const hit = re.exec(s);
      if (hit) return { cat: "secret:" + what, what: what + ": " + hit[0].replace(/^[\s"'=~@<>:\/]+/, "").slice(0, 80) };
    }
  }
  if (WRITERS.has(tool)) for (const s of texts) {
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
  const ask = (r) => process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: "PreToolUse", permissionDecision: "ask",
    permissionDecisionReason: `cccodroid-guard|${r.cat}|${r.what}`,
  } }));
  let r;
  try {
    const ev = JSON.parse(fs.readFileSync(0, "utf8"));
    if (!ev || typeof ev !== "object") throw new Error("not an object");
    const b = breachWrite(ev.tool_name, ev.tool_input);
    if (b) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny",
        permissionDecisionReason: `cccodroid-guard|${b.cat}|${b.what}. cccodroid refuses to write this; it would block the next run.` } }));
      process.exit(0);
    }
    r = judge(ev.tool_name, ev.tool_input);
  } catch (e) { r = { cat: "error", what: "guard error: " + String(e && e.message || e).slice(0, 80) }; }
  try { if (r) ask(r); } catch {}
  process.exit(0);
}
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) runHook();
