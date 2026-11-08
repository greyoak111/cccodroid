// 发行版封口：起 claude 开会话时，用户级 / 项目级的 Claude Code 配置一概不读，只认网关检查过、经官方旗标回填的（见 seal.mjs）。
//
// 为什么：CLAUDE.md、rules、skill、钩子、插件、输出风格每轮自动进上下文，破甲包就是往这些地方塞规则（11-05 群友 dsh-unlock-cc）。
// 卡片问「保留 / 撤销」挡不住机主自己点保留。发行版不留这个口子，机主也不例外（用户拍板 11-05）。
// 实测（claude 2.1.311，假接口）：--setting-sources "" 挡住用户级、项目级的 CLAUDE.md / rules / 钩子 / skill / 输出风格 / .claude.json 的 MCP；
// --settings 挂的 guard 照样生效；自动记忆不受它管，由 seal.mjs 指定目录并在起进程前检查。
//
// 开发版（cccodroid-dev）合并时把 SEALED 改成 false：开发者自己的 CLAUDE.md、记忆、钩子照常读，靠 userconf.mjs 的卡片把关。
// 故意不做运行时开关（环境变量、设置项、标记文件都不认）：开关在哪，机主就能拨回去。
let SEALED = true;
export const sealed = () => SEALED;
/** 只给测试用 */
export function _setSealed(v) { SEALED = !!v; }

// 不开会话的管理子命令：照常读配置（扩展页的 mcp list / plugin 管理靠它们）。
// agents 会在后台开会话，不算管理命令
const MGMT = new Set(["mcp", "plugin", "plugins", "config", "doctor", "update", "install", "auth", "setup-token", "migrate-installer", "version"]);
// 带参数的旗标（找子命令时要跳过它们的值）。不全也无妨：认不出子命令就按开会话封口，宁严勿松
const WITH_VALUE = new Set(["--model", "--resume", "-r", "--settings", "--setting-sources", "--permission-mode", "--input-format", "--output-format",
  "--append-system-prompt", "--append-system-prompt-file", "--system-prompt", "--system-prompt-file", "--mcp-config", "--add-dir", "--effort",
  "--allowedTools", "--allowed-tools", "--disallowedTools", "--disallowed-tools", "--tools", "--plugin-dir", "--agents", "--session-id",
  "--permission-prompt-tool", "--append-subagent-system-prompt", "--fallback-model", "--max-turns", "--debug"]);

function subcommand(argv) {
  // 管理子命令（mcp / plugin / config…）只认跳过了已知带值全局旗标后遇到的第一个位置参数。
  // `-p mcp`、未知旗标（如 --debug-file mcp）、`-- mcp` 都不能再被当成管理命令：以前会整层跳过封口（审查 11-05）。
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // `claude --version` 只是打版本、不开会话：别走封口去补核，自检 90 秒等不起（0.6.9 审计 195-M.4）
    if (a === "--version") return "version";
    if (a === "--") return "";
    if (a.startsWith("-")) {
      const name = a.split("=")[0];
      if (WITH_VALUE.has(name)) { if (!a.includes("=")) i++; continue; }   // --settings JSON / --settings=JSON
      return "";                                  // 未知旗标/-p：按开会话封口，宁严勿松
    }
    return a;
  }
  return "";
}

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
/** 几份 --settings 合成一份（claude 只认最后一个，后一个整个顶掉前一个）：钩子按事件拼起来，别的键后者覆盖 */
export function mergeSettings(list) {
  const out = {};
  for (const s of list) {
    for (const [k, v] of Object.entries(s || {})) {
      if (k === "hooks" && isObj(v)) {
        out.hooks = out.hooks || {};
        for (const [ev, arr] of Object.entries(v)) out.hooks[ev] = [...(out.hooks[ev] || []), ...(Array.isArray(arr) ? arr : [])];
      } else if (isObj(v) && isObj(out[k])) out[k] = { ...out[k], ...v };
      else out[k] = v;
    }
  }
  return out;
}

/**
 * 开会话的参数加上封口：--setting-sources ""、--strict-mcp-config，几份 --settings 合成一份。
 * 原有的 --setting-sources 去掉；--settings 给的不是 JSON（文件路径）就拒绝 —— 网关自己从不这样传，出现了就是哪里拼错了。
 */
export function sealArgv(argv) {
  if (!SEALED || MGMT.has(subcommand(argv))) return argv;
  const out = [], settings = [];
  let afterDD = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { afterDD = true; out.push(a); continue; }
    if (afterDD) { out.push(a); continue; }          // `--` 之后是位置参数，不能当旗标处理/合并
    if (a === "--setting-sources") { i++; continue; }
    if (a.startsWith("--setting-sources=")) continue;
    if (a === "--settings" || a.startsWith("--settings=")) {
      const v = a === "--settings" ? argv[++i] : a.slice("--settings=".length);
      let j; try { j = JSON.parse(String(v)); } catch { j = null; }
      if (!isObj(j)) throw new Error("sealed: --settings must be inline JSON");
      settings.push(j);
      continue;
    }
    if (a === "--strict-mcp-config") continue;
    out.push(a);
  }
  // 封口旗标必须插在第一个 `--` 之前，否则 claude 会把它们当位置参数（审查 11-05）
  const at = out.indexOf("--");
  const pos = at >= 0 ? at : out.length;
  out.splice(pos, 0, "--setting-sources", "", "--strict-mcp-config");
  if (settings.length) out.splice(pos + 3, 0, "--settings", JSON.stringify(mergeSettings(settings)));
  return out;
}

// 能让 claude 另找配置、另读 CLAUDE.md、换记忆目录的环境变量：网关起的进程里一概清掉
export const SEAL_ENV_DROP = ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD", "CLAUDE_COWORK_MEMORY_PATH_OVERRIDE",
  "CLAUDE_CODE_DISABLE_AUTO_MEMORY", "CLAUDE_CODE_USE_COWORK_PLUGINS", "CLAUDE_CODE_PLUGIN_SEED_DIR", "CLAUDE_CODE_MANAGED_SETTINGS_PATH"];
export function sealEnv(env) {
  if (!SEALED) return env;
  for (const k of SEAL_ENV_DROP) delete env[k];
  return env;
}
