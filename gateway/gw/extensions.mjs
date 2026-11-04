import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { CFG, PREFIX, log, tz } from "./config.mjs";
import { claudeCmd, claudeEnv, ensureShell, killTree } from "./claude.mjs";
import { SID_RE, zipRead } from "./sessionops.mjs";
import { NEXT, readBody, readBodyBuf, sendJson } from "./http.mjs";
import { termEnv } from "./terminal.mjs";
import { COMP_DIR, compIndex, compIndexCache, compRecord } from "./components.mjs";
import { retrustProject } from "./projtrust.mjs";
import { ucAppBegin, ucAppWrote } from "./userconf.mjs";

// ── 扩展：插件 / 技能 / MCP ───────────────────────────────────────────
// 全部转给 claude 自己的命令行（claude plugin … / claude mcp …），网关不自己改它的配置文件 ——
// 格式随 claude 版本变，自己写迟早写坏。技能目录（~/.claude/skills）例外：它就是一堆文件夹，没有命令。
// 同一时刻只跑一个改配置的命令，免得两个安装同时写 settings.json。
let EXT_LOCK = Promise.resolve();
function extRun(args, timeoutMs = 180000) {
  const job = EXT_LOCK.then(() => new Promise((resolve) => {
    const [cmd0, args0] = claudeCmd(args);
    const ucb = writes ? ucAppBegin() : null;
    const child = spawn(cmd0, args0, {
      cwd: fs.existsSync(CFG.workspace) ? CFG.workspace : CFG.home,
      env: claudeEnv(), stdio: ["ignore", "pipe", "pipe"], detached: true,
    });
    let out = "", err = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");   // 按流解码：多字节字符跨块不会被拆坏
    child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (err += d));
    const t = setTimeout(() => killTree(child), timeoutMs);
    child.on("close", (code) => { clearTimeout(t); appWrote(code === 0 ? ucb : null); resolve({ code, out, err }); });
    child.on("error", (e) => { clearTimeout(t); resolve({ code: -1, out, err: err + e.message }); });
  }));
  // 装卸插件、加删 MCP 是应用替用户做的：这次命令改到的当场认下，别下一轮反过来问他（见 userconf.mjs）。命令失败的不认，下一轮照问。
  // 只认对应的地方：插件只动 plugins/ 和设置里的 enabledPlugins / extraKnownMarketplaces，MCP 只动 .claude.json
  const writes = ["plugin", "mcp"].includes(args[0]) && !args.includes("list") && !args.includes("get");
  const appWrote = (ucb) => {
    if (!writes) return;
    if (args[0] === "mcp") ucAppWrote([".claude.json"], ucb);
    else ucAppWrote([".claude/settings.json", ".claude/plugins/"], ucb, { ".claude/settings.json": ["enabledPlugins", "extraKnownMarketplaces"] });
  };
  EXT_LOCK = job.catch(() => {});
  return job;
}
const lastJson = (s) => {
  const lines = String(s).trim().split("\n").reverse();
  for (const l of lines) { try { return JSON.parse(l); } catch {} }
  try { return JSON.parse(String(s).slice(String(s).indexOf("{"))); } catch {}
  try { return JSON.parse(String(s).slice(String(s).indexOf("["))); } catch {}
  return null;
};
const cliMsg = (r) => (r.err || r.out || "").replace(/\x1b\[[0-9;]*m/g, "").trim().slice(-600);

let PLUGIN_CATALOG = null;   // 可安装清单有三千多条，缓存 10 分钟，搜索在网关这边做
async function pluginState(withAvailable) {
  const fresh = PLUGIN_CATALOG && Date.now() - PLUGIN_CATALOG.at < 600000;
  const r = await extRun(["plugin", "list", "--json", ...(withAvailable && !fresh ? ["--available"] : [])], 120000);
  const j = lastJson(r.out);
  if (!j) throw new Error(cliMsg(r) || "claude plugin list 没有输出");
  const installed = Array.isArray(j) ? j : j.installed || [];
  if (!Array.isArray(j) && j.available) PLUGIN_CATALOG = { at: Date.now(), list: j.available };
  return installed;
}

async function listPlugins(q, offset, withAvailable) {
  const installed = await pluginState(withAvailable);
  const ids = new Set(installed.map((p) => p.id));
  const res = {
    installed: installed.map((p) => ({ id: p.id, version: p.version, scope: p.scope, enabled: p.enabled !== false, installedAt: p.installedAt })),
  };
  if (withAvailable && PLUGIN_CATALOG) {
    const words = String(q || "").toLowerCase().split(/\s+/).filter(Boolean);
    const hit = PLUGIN_CATALOG.list.filter((p) => {
      if (ids.has(p.pluginId)) return false;
      const hay = (p.name + " " + (p.description || "") + " " + p.marketplaceName).toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    res.total = hit.length;
    res.available = hit.slice(offset, offset + 40).map((p) => ({
      id: p.pluginId, name: p.name, description: String(p.description || "").slice(0, 300),
      marketplace: p.marketplaceName, version: p.version || null,
    }));
  }
  return res;
}

/** 安装：有的插件要靠执行一条命令装（或拉包时要跑 headersHelper）。claude 会先把这条命令亮出来，
 *  不经人点头不装 —— 这里也一样：先不带确认跑一次，拿到命令和它的 sha256 交给界面，用户同意后再带 --accept-command 装。 */
// 界面传来的名字、地址原样进 claude 的命令行：横线开头会被当成 claude 自己的选项（11-01 独立审查低-2）
function badArg(...xs) {
  return xs.some((x) => x != null && (!x || x.length > 1024 || x.startsWith("-") || /[\x00-\x1f\x7f]/.test(x)));
}

async function installPlugin(id, accept) {
  if (badArg(id, accept)) return { ok: false, message: tz("名字格式不对") };
  const r = await extRun(["plugin", "install", id, "--json", ...(accept ? ["--accept-command", accept] : [])], 600000);
  const j = lastJson(r.out) || {};
  const shown = j.shownCommand || j.command;
  if (r.code !== 0 && shown && shown.sha256 && !accept) {
    return { ok: false, needConfirm: true, command: shown.command || shown.display || JSON.stringify(shown), sha256: shown.sha256 };
  }
  return r.code === 0 ? { ok: true } : { ok: false, message: j.error || j.message || cliMsg(r) };
}

async function pluginOp(op, id) {
  if (badArg(id)) return { ok: false, message: tz("名字格式不对") };
  const args = op === "uninstall" ? ["plugin", "uninstall", id, "--json"] : ["plugin", op, id];
  const r = await extRun(args, 120000);
  const j = lastJson(r.out) || {};
  return r.code === 0 ? { ok: true } : { ok: false, message: j.error || j.message || cliMsg(r) };
}

async function listMarketplaces() {
  const r = await extRun(["plugin", "marketplace", "list", "--json"], 60000);
  const j = lastJson(r.out);
  return Array.isArray(j) ? j.map((m) => ({ name: m.name, source: m.source?.repo || m.source?.url || m.source?.path || m.url || "" })) : [];
}

async function marketplaceOp(op, arg) {
  if (badArg(String(arg ?? ""))) return { ok: false, message: tz("名字格式不对") };
  const r = await extRun(["plugin", "marketplace", op, arg], 300000);
  if (r.code === 0) PLUGIN_CATALOG = null;
  return r.code === 0 ? { ok: true } : { ok: false, message: cliMsg(r) };
}

/** claude mcp list 只有给人看的文本：「名字: 目标 - ✔ Connected」。顺带做了连通检查，所以慢几秒 */
async function listMcp() {
  const r = await extRun(["mcp", "list"], 90000);
  const out = [];
  for (const line of r.out.replace(/\x1b\[[0-9;]*m/g, "").split("\n")) {
    const m = line.match(/^(.+?): (.+) - ([✔✗⚠!]|[^\s]+)\s*(.*)$/u);
    if (!m) continue;
    const name = m[1].trim();
    out.push({ name, target: m[2].trim(), ok: m[3] === "✔", status: (m[3] + " " + m[4]).trim().slice(0, 200), cloud: name.startsWith("claude.ai ") });
  }
  return out;
}

async function addMcp(b) {
  const name = String(b.name || "").trim();
  // 横线开头的名字会被当成 claude 的选项（11-03 审查 L-19，同 badArg）
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name) || badArg(name)) return { ok: false, message: tz("名字只能用字母、数字、点、下划线、横线") };
  const transport = ["stdio", "http", "sse"].includes(b.transport) ? b.transport : "stdio";
  const target = String(b.target || "").trim();
  if (!target) return { ok: false, message: tz("缺少命令或地址") };
  // http / sse 的地址是位置参数：只收 http(s) 网址，别的（横线开头、控制字符）不进命令行
  if (transport !== "stdio" && (badArg(target) || !/^https?:\/\/[^\s]+$/i.test(target))) return { ok: false, message: tz("地址要以 http:// 或 https:// 开头") };
  // -e / --header 是可变参数，会把后面的名字吞掉：名字放前面，选项跟在后面、用 -- 收尾
  const args = ["mcp", "add", "-s", "user", "--transport", transport, name];
  if (transport !== "stdio") args.push(target);
  for (const kv of [].concat(b.env || [])) if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(kv)) args.push("-e", kv);
  for (const h of [].concat(b.headers || [])) if (String(h).includes(":")) args.push("--header", String(h));
  if (transport === "stdio") {
    // 命令行按空白切开；带空格的参数用引号括起来
    const parts = target.match(/"[^"]*"|'[^']*'|\S+/g).map((x) => x.replace(/^(["'])(.*)\1$/, "$2"));
    args.push("--", ...parts);
  }
  const r = await extRun(args, 60000);
  return r.code === 0 ? { ok: true } : { ok: false, message: cliMsg(r) };
}

async function removeMcp(name) {
  if (badArg(String(name ?? ""))) return { ok: false, message: tz("名字格式不对") };
  const r = await extRun(["mcp", "remove", String(name)], 60000);
  return r.code === 0 ? { ok: true } : { ok: false, message: cliMsg(r) };
}

// 技能：~/.claude/skills/<名字>/SKILL.md（开头 YAML 里有 name / description）
// ── Hooks：到某个时刻自动跑的命令（claude 的 settings.json 里 "hooks" 一个键） ──
// claude 没有管 hooks 的命令行，只能直接改 settings.json：只动 hooks 一个键，其余原样保留；
// 「暂停全部」不写 disableAllHooks —— 它会连网关挂的敏感操作再确认一起关掉，网关因此每轮显式压成 false（见 claude.mjs settingsArgs），
// 改成把规则挪到旁边的 <settings>.ccapp-paused 里，恢复时挪回去；以前存的 disableAllHooks:true 头一次读写时照这个办法转过来。
// 写前留一份 .bak，和插件安装共用 EXT_LOCK，免得两边同时写。三处配置：用户级（所有项目）、项目级、项目本机级。
const HOOK_EVENTS = ["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "UserPromptSubmit", "Stop",
  "SubagentStart", "SubagentStop", "SessionStart", "SessionEnd", "Notification", "PreCompact", "PostCompact",
  "InstructionsLoaded", "ConfigChange", "TaskCompleted", "TeammateIdle", "WorktreeCreate", "Setup"];
const HOOK_SCRIPTS_DIR = path.join(CFG.home, ".claude", "hooks");
// 常用规则用到的小脚本（源码在 claude-apk/hooks/，用 hooks/embed.mjs 生成这一行）；添加规则时写进 ~/.claude/hooks/
const HOOK_SCRIPTS = {"cc-autosave.mjs":"// cccodroid 内置 hook（Claude 答完一轮时）：项目是 git 仓库、且有改动，就自动提交一次存档。只提交，不推送。\n// 用法：node cc-autosave.mjs '自动存档'   （参数是提交说明的前缀，后面自动加时间）\nimport fs from \"node:fs\";\nimport { execFileSync } from \"node:child_process\";\nlet j = {};\ntry { j = JSON.parse(fs.readFileSync(0, \"utf8\")); } catch {}\nconst cwd = j.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();\nconst git = (...a) => execFileSync(\"git\", a, { cwd, encoding: \"utf8\", stdio: [\"ignore\", \"pipe\", \"pipe\"] });\ntry { if (git(\"rev-parse\", \"--is-inside-work-tree\").trim() !== \"true\") process.exit(0); } catch { process.exit(0); }\ntry {\n  if (!git(\"status\", \"--porcelain\").trim()) process.exit(0);\n  git(\"add\", \"-A\");\n  const id = [];\n  try { git(\"config\", \"user.name\"); } catch { id.push(\"-c\", \"user.name=cccodroid\"); }\n  try { git(\"config\", \"user.email\"); } catch { id.push(\"-c\", \"user.email=autosave@cccodroid.local\"); }\n  const d = new Date(), p = (n) => String(n).padStart(2, \"0\");\n  const when = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;\n  git(...id, \"commit\", \"-q\", \"-m\", `${process.argv[2] || \"自动存档\"} ${when}`);\n} catch (e) {\n  process.stderr.write(\"自动存档失败：\" + String(e.stderr || e.message).slice(0, 300) + \"\\n\");\n}\n","cc-bash-log.mjs":"// cccodroid 内置 hook（用完工具之后，只管 Bash）：把 Claude 跑过的命令记进日志，方便事后翻看。\n// 用法：node cc-bash-log.mjs [日志文件]   默认 ~/.claude/bash-history.log\nimport fs from \"node:fs\";\nimport path from \"node:path\";\nlet j = {};\ntry { j = JSON.parse(fs.readFileSync(0, \"utf8\")); } catch {}\nconst cmd = String((j.tool_input || {}).command || \"\");\nif (!cmd) process.exit(0);\nconst file = process.argv[2] || path.join(process.env.HOME || \".\", \".claude\", \"bash-history.log\");\nconst d = new Date(), p = (n) => String(n).padStart(2, \"0\");\nconst when = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;\ntry {\n  fs.mkdirSync(path.dirname(file), { recursive: true });\n  fs.appendFileSync(file, `${when}\\t${j.cwd || \"\"}\\n  ${cmd.replace(/\\n/g, \"\\n  \")}\\n`);\n} catch {}\n","cc-format.mjs":"// cccodroid 内置 hook（用完工具之后，管改文件的工具）：Claude 改完代码文件，用本机已装的格式化工具整理一遍。\n// 按扩展名找：ruff / black、prettier、gofmt、rustfmt、clang-format、shfmt，没装就什么也不做。\n// Markdown 和纯文本不碰（写作的稿子不该被工具改排版）。\nimport fs from \"node:fs\";\nimport path from \"node:path\";\nimport { spawnSync } from \"node:child_process\";\nlet j = {};\ntry { j = JSON.parse(fs.readFileSync(0, \"utf8\")); } catch {}\nconst f = String((j.tool_input || {}).file_path || \"\");\nif (!f || !fs.existsSync(f)) process.exit(0);\nconst ext = path.extname(f).toLowerCase();\nconst T = {\n  \".py\": [[\"ruff\", \"format\", \"-q\"], [\"black\", \"-q\"]],\n  \".js\": [[\"prettier\", \"--write\", \"--log-level\", \"warn\"]], \".mjs\": 0, \".cjs\": 0, \".jsx\": 0, \".ts\": 0, \".tsx\": 0,\n  \".json\": 0, \".css\": 0, \".scss\": 0, \".html\": 0, \".vue\": 0, \".yaml\": 0, \".yml\": 0,\n  \".go\": [[\"gofmt\", \"-w\"]], \".rs\": [[\"rustfmt\", \"-q\"]],\n  \".c\": [[\"clang-format\", \"-i\"]], \".h\": 0, \".cc\": 0, \".cpp\": 0, \".hpp\": 0,\n  \".sh\": [[\"shfmt\", \"-w\"]],\n};\nlet list = T[ext];\nif (list === 0) list = [\".c\", \".h\", \".cc\", \".cpp\", \".hpp\"].includes(ext) ? T[\".c\"] : T[\".js\"];\nif (!list) process.exit(0);\nconst has = (b) => (process.env.PATH || \"\").split(\":\").some((d) => { try { fs.accessSync(path.join(d, b), fs.constants.X_OK); return true; } catch { return false; } });\nconst tool = list.find(([b]) => has(b));\nif (tool) spawnSync(tool[0], [...tool.slice(1), f], { stdio: \"ignore\", timeout: 20000 });\n","cc-guard-bash.mjs":"// cccodroid 内置 hook（用工具之前，只管 Bash）：命令里出现这些内容就拦下。\n// 用法：node cc-guard-bash.mjs 'git push --force' '/git\\s+reset\\s+--hard/'\n// 普通写法按字面查找（空白宽松匹配）；写成 /…/ 就当正则。命中退出码 2，并告诉 Claude 原因。\nimport fs from \"node:fs\";\nconst pats = process.argv.slice(2).filter(Boolean);\nlet j = {};\ntry { j = JSON.parse(fs.readFileSync(0, \"utf8\")); } catch {}\nconst cmd = String((j.tool_input || {}).command || \"\");\nif (!cmd) process.exit(0);\nconst flat = cmd.replace(/\\s+/g, \" \");\nconst hit = pats.find((p) => {\n  const m = /^\\/(.+)\\/([a-z]*)$/.exec(p);\n  if (m) { try { return new RegExp(m[1], m[2]).test(cmd); } catch { return false; } }\n  return flat.includes(p.replace(/\\s+/g, \" \"));\n});\nif (hit) {\n  process.stderr.write(`这条命令触发了禁止规则「${hit}」，已拦下：\\n${cmd.slice(0, 300)}\\n换一种更安全的做法；如果确实需要，请让用户自己执行。\\n`);\n  process.exit(2);\n}\n","cc-guard-files.mjs":"// cccodroid 内置 hook（用工具之前）：不许 Claude 改动匹配这些模式的文件。\n// 用法：node cc-guard-files.mjs '.env' '*.pem' 'secrets/**'\n// 模式不带 / 时比对文件名，带 / 时比对完整路径；* 不跨目录，** 跨目录。命中就退出码 2 拦下，并告诉 Claude 原因。\nimport fs from \"node:fs\";\nconst pats = process.argv.slice(2).filter(Boolean);\nlet j = {};\ntry { j = JSON.parse(fs.readFileSync(0, \"utf8\")); } catch {}\nconst i = j.tool_input || {};\nconst f = String(i.file_path || i.notebook_path || \"\");\nif (!f) process.exit(0);\nconst rx = (p) => new RegExp(\"^\" + p.replace(/[.+^${}()|[\\]\\\\]/g, \"\\\\$&\").replace(/\\*\\*/g, \"\\0\").replace(/\\*/g, \"[^/]*\")\n  .replace(/\\?/g, \"[^/]\").replace(/\\0/g, \".*\") + \"$\");\nconst base = f.split(\"/\").pop();\nconst hit = pats.find((p) => rx(p).test(p.includes(\"/\") ? f : base) || (p.includes(\"/\") && rx(\"**/\" + p).test(f)));\nif (hit) {\n  process.stderr.write(`这个文件受保护（规则「${hit}」），不要修改：${f}\\n如果确实需要改，请告诉用户，让用户自己处理。\\n`);\n  process.exit(2);\n}\n"};

function hookSettingsFile(scope, dir) {
  if (scope === "user") return path.join(CFG.home, ".claude", "settings.json");
  const d = path.resolve(String(dir || CFG.workspace));
  // 界面只管工作区这一份；别的目录不给读写（里面的 hooks 命令可能带密钥）
  if (d !== path.resolve(CFG.workspace)) throw new Error("only the workspace project is managed here");
  let ok = false;
  try { ok = fs.statSync(d).isDirectory(); } catch {}
  if (!ok) throw new Error("project dir not found: " + d);
  return path.join(d, ".claude", scope === "local" ? "settings.local.json" : "settings.json");
}
function readSettingsFile(file) {
  let txt;
  try { txt = fs.readFileSync(file, "utf8"); } catch (e) { if (e.code === "ENOENT") return { j: {}, exists: false }; return { error: e.message, exists: true }; }
  if (!txt.trim()) return { j: {}, exists: true };
  try {
    const j = JSON.parse(txt);
    if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("not an object");
    return { j, exists: true };
  } catch (e) { return { error: e.message, badJson: true, exists: true }; }
}
const pausedFile = (file) => file + ".ccapp-paused";
function readPaused(file) {
  try { const h = JSON.parse(fs.readFileSync(pausedFile(file), "utf8")); return h && typeof h === "object" && !Array.isArray(h) ? h : null; } catch { return null; }
}
export function listHooks(dir) {
  const scopes = [];
  for (const scope of ["user", "project", "local"]) {
    let file;
    try { file = hookSettingsFile(scope, dir); } catch (e) { scopes.push({ scope, error: e.message }); continue; }
    const r = readSettingsFile(file);
    const paused = readPaused(file);
    const h = paused || (r.j && r.j.hooks);
    // 事件名只放字母的（和保存时 cleanHooks 一个规矩）；配置文件可能来自克隆的仓库，怪名字不往界面送
    const hooks = {};
    if (h && typeof h === "object" && !Array.isArray(h)) for (const [ev, v] of Object.entries(h)) if (/^[A-Za-z]{1,40}$/.test(ev)) hooks[ev] = v;
    scopes.push({ scope, file, exists: r.exists, error: r.error, badJson: !!r.badJson,
      hooks, disableAll: !!paused || !!(r.j && r.j.disableAllHooks) });
  }
  return { scopes, events: HOOK_EVENTS, workspace: CFG.workspace, dir: path.resolve(String(dir || CFG.workspace)), scriptsDir: HOOK_SCRIPTS_DIR };
}
/** 界面送回来的整份 hooks：结构不对就拒绝；空组、空命令剔掉；不认识的字段（prompt / http 类 hook 等）原样留着 */
function cleanHooks(h) {
  if (!h || typeof h !== "object" || Array.isArray(h)) throw new Error("hooks must be an object");
  const out = {};
  for (const [ev, groups] of Object.entries(h)) {
    if (!/^[A-Za-z]+$/.test(ev)) throw new Error("bad event name: " + ev);
    if (!Array.isArray(groups)) throw new Error(ev + " must be an array");
    const gs = [];
    for (const g of groups) {
      if (!g || typeof g !== "object" || !Array.isArray(g.hooks)) throw new Error(ev + ": every entry needs a hooks array");
      const hs = g.hooks.filter((x) => x && typeof x === "object" && x.type && !(x.type === "command" && !String(x.command || "").trim()));
      if (!hs.length) continue;
      const ng = { ...g, hooks: hs };
      if (ng.matcher === "" || ng.matcher == null) delete ng.matcher;
      gs.push(ng);
    }
    if (gs.length) out[ev] = gs;
  }
  return out;
}
export function saveHooks({ scope, dir, hooks, disableAll }) {
  if (!["user", "project", "local"].includes(scope)) throw new Error("bad scope");
  const file = hookSettingsFile(scope, dir);
  const clean = hooks === undefined ? undefined : cleanHooks(hooks);
  const job = EXT_LOCK.then(() => {
    const r = readSettingsFile(file);
    if (r.error) { const e = new Error(r.error); e.code = r.badJson ? "badjson" : "read"; throw e; }
    const j = r.j;
    let paused = readPaused(file);
    if (j.disableAllHooks === true) { paused = { ...(j.hooks || {}), ...(paused || {}) }; delete j.hooks; }   // 旧的暂停办法：转过来
    delete j.disableAllHooks;
    const pause = disableAll !== undefined ? !!disableAll : !!paused;
    const want = clean !== undefined ? clean : (paused || j.hooks || {});
    const ucb = scope === "user" ? ucAppBegin() : null;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (r.exists) { try { fs.copyFileSync(file, file + ".bak"); } catch {} }
    const put = (dst, obj) => { const tmp = dst + ".tmp-" + process.pid; fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n"); fs.renameSync(tmp, dst); };
    if (pause) { put(pausedFile(file), want); delete j.hooks; }      // 先把规则存好，再从生效的配置里拿掉
    else if (Object.keys(want).length) j.hooks = want; else delete j.hooks;
    put(file, j);
    if (!pause) try { fs.unlinkSync(pausedFile(file)); } catch {}
    log(`hooks 已保存：${file}`);
    if (scope !== "user") retrustProject(path.dirname(path.dirname(file)));
    else ucAppWrote([".claude/settings.json"], ucb, { ".claude/settings.json": ["hooks"] });   // 用户在扩展页亲手改的钩子：只认 hooks 这一块（见 userconf.mjs）
    return { ok: true, file };
  });
  EXT_LOCK = job.catch(() => {});
  return job;
}
/** 网关启动时：以前用 disableAllHooks:true 暂停的，转成挪开的办法（不然网关压成 false 后它们会重新跑起来）。
 *  用户级 + 工作区的项目级、本机级（界面管的就这三份，DeepSeek 复核建议 8）；别的项目里的照旧按项目配置确认（projtrust.mjs）处理 */
export async function migrateHookPause() {
  for (const scope of ["user", "project", "local"]) {
    let file; try { file = hookSettingsFile(scope); } catch { continue; }
    const r = readSettingsFile(file);
    if (!(r.j && r.j.disableAllHooks === true)) continue;
    try { await saveHooks({ scope }); log(`hooks 的「暂停全部」已改成挪开保存：${file}`); }
    catch (e) { log(`转换 hooks 暂停失败（${file}）：${e.message}`); }
  }
}
function installHookScripts() {
  const ucb = ucAppBegin();
  fs.mkdirSync(HOOK_SCRIPTS_DIR, { recursive: true });
  for (const [name, src] of Object.entries(HOOK_SCRIPTS)) fs.writeFileSync(path.join(HOOK_SCRIPTS_DIR, name), src);
  ucAppWrote([".claude/hooks/"], ucb);
  return { ok: true, dir: HOOK_SCRIPTS_DIR };
}
/** 试运行用的 stdin：照 claude 真实传给 hook 的 JSON 造一份（工具类事件按匹配规则挑个像样的工具） */
function hookSample(ev, matcher, cwd) {
  const base = { session_id: "cccodroid-test", transcript_path: "", cwd, permission_mode: "default", hook_event_name: ev };
  const m = String(matcher || "");
  const tool = !m || m === "*" || /Bash/.test(m) ? "Bash" : /Write/.test(m) ? "Write" : /Edit/.test(m) ? "Edit" : (m.match(/[A-Za-z_]+/) || ["Bash"])[0];
  const input = tool === "Bash" ? { command: "echo hello", description: "test" }
    : tool === "Write" ? { file_path: path.join(cwd, "hook-test.txt"), content: "hello\n" }
    : tool === "Edit" ? { file_path: path.join(cwd, "hook-test.txt"), old_string: "hello", new_string: "hi" } : {};
  switch (ev) {
    case "PreToolUse": case "PermissionRequest": return { ...base, tool_name: tool, tool_input: input };
    case "PostToolUse": return { ...base, tool_name: tool, tool_input: input, tool_response: tool === "Bash" ? { stdout: "hello", stderr: "", interrupted: false } : { success: true } };
    case "PostToolUseFailure": return { ...base, tool_name: tool, tool_input: input, error: "test error" };
    case "UserPromptSubmit": return { ...base, prompt: "这是一条测试消息" };
    case "Stop": case "SubagentStop": return { ...base, stop_hook_active: false };
    case "SessionStart": return { ...base, source: m && !/[|*]/.test(m) ? m : "startup" };
    case "SessionEnd": return { ...base, reason: "other" };
    case "Notification": return { ...base, message: "Claude needs your permission to use Bash", notification_type: "permission_prompt" };
    case "PreCompact": case "PostCompact": return { ...base, trigger: "manual", custom_instructions: "" };
    default: return base;
  }
}
function testHook({ command, event, matcher, dir, input, timeout }) {
  command = String(command || "");
  if (!command.trim()) throw new Error("empty command");
  let cwd = path.resolve(String(dir || CFG.workspace));
  try { if (!fs.statSync(cwd).isDirectory()) cwd = CFG.home; } catch { cwd = CFG.home; }
  let stdin = input != null && String(input).trim() ? String(input) : JSON.stringify(hookSample(String(event || ""), matcher, cwd), null, 2);
  const ms = Math.max(1, Math.min(60, Number(timeout) || 30)) * 1000;
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(ensureShell(), ["-c", command], {
      cwd, env: { ...termEnv(), CLAUDE_PROJECT_DIR: cwd }, stdio: ["pipe", "pipe", "pipe"], detached: true,
    });
    let out = "", err = "", timedOut = false;
    const cap = (s, d) => (s.length < 64 * 1024 ? s + d : s);
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");   // 按流解码：多字节字符跨块不会被拆坏
    child.stdout.on("data", (d) => (out = cap(out, d)));
    child.stderr.on("data", (d) => (err = cap(err, d)));
    const tm = setTimeout(() => { timedOut = true; killTree(child); }, ms);
    child.on("close", (code) => { clearTimeout(tm); resolve({ ok: true, code, stdout: out, stderr: err, ms: Date.now() - t0, timedOut, input: stdin }); });
    child.on("error", (e) => { clearTimeout(tm); resolve({ ok: true, code: -1, stdout: out, stderr: err + e.message, ms: Date.now() - t0, timedOut, input: stdin }); });
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  });
}

export const SKILLS_DIR = path.join(CFG.home, ".claude", "skills");
// SKILL.md 开头的 YAML：只取顶层的单个键；支持 description: > / | 这类多行块
function fmField(md, k) {
  const fm = String(md).replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return "";
  const lines = fm[1].split("\n"), i = lines.findIndex((l) => l.startsWith(k + ":"));
  if (i < 0) return "";
  const v = lines[i].slice(k.length + 1).trim();
  if (!/^[>|][+-]?$/.test(v)) return v.replace(/^["']|["']$/g, "").trim();
  const body = [];
  for (const l of lines.slice(i + 1)) { if (l.trim() && !/^\s/.test(l)) break; body.push(l.trim()); }
  return (v[0] === ">" ? body.join(" ") : body.join("\n")).replace(/\s+$/, "").trim();
}
export function skillMeta(dir) {
  try {
    const s = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8").slice(0, 4000);
    return { name: fmField(s, "name"), description: fmField(s, "description").slice(0, 300) };
  } catch { return null; }
}
function listSkills() {
  let ents = [];
  try { ents = fs.readdirSync(SKILLS_DIR, { withFileTypes: true }); } catch { return []; }
  // 哪些是组件带来的：组件的安装记录里有 skill 名（分类索引条分「组件自带 / 自己装的」）
  const fromComp = new Map();
  try { for (const f of fs.readdirSync(COMP_DIR)) if (f.endsWith(".json")) { const r = compRecord(f.slice(0, -5)); if (r && r.skill) fromComp.set(r.skill, f.slice(0, -5)); } } catch {}
  return ents.filter((d) => d.isDirectory() || d.isSymbolicLink()).map((d) => {
    const m = skillMeta(path.join(SKILLS_DIR, d.name));
    // 组件技能的 SKILL.md 是中文写的（给 Claude 看的触发说明）：非中文界面显示组件索引里的英文简介
    const cid = fromComp.get(d.name) || "", ce = cid && compIndexCache.data && compIndexCache.data.components[cid];
    return m ? { dir: d.name, name: m.name || d.name, description: m.description, descEn: (ce && ce.desc && ce.desc.en) || "", component: cid, official: (skillSource(d.name) || {}).repo === SKILL_REPO } : null;
  }).filter(Boolean);
}
function deleteSkill(dir) {
  if (!SID_RE.test(dir)) return { ok: false, message: "bad name" };
  const p = path.join(SKILLS_DIR, dir);
  if (!fs.existsSync(path.join(p, "SKILL.md"))) return { ok: false, message: "not found" };
  const ucb = ucAppBegin();
  fs.rmSync(p, { recursive: true, force: true });
  ucAppWrote([".claude/skills/" + dir], ucb);
  return { ok: true };
}
// ── 官方目录：技能（anthropics/skills）与 MCP 注册表（registry.modelcontextprotocol.io）──
// 只读公开目录；装卸都落在用户自己的 ~/.claude：技能拷进 skills/，MCP 走 claude mcp add（见 addMcp）。
const SKILL_REPO = "anthropics/skills";
let skillCat = null;                 // { at, sha, items }：一小时内复用，GitHub 未登录的 API 一小时只给 60 次
const ghGet = async (url, json) => {
  const r = await fetch(url, { headers: { "User-Agent": "cccodroid", ...(json ? { Accept: "application/vnd.github+json" } : {}) }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return json ? r.json() : Buffer.from(await r.arrayBuffer());
};
async function skillCatalog(force) {
  if (!force && skillCat && Date.now() - skillCat.at < 3600e3) return skillCat;
  const tree = await ghGet(`https://api.github.com/repos/${SKILL_REPO}/git/trees/HEAD?recursive=1`, true);
  const blobs = (tree.tree || []).filter((e) => e.type === "blob");
  const names = [...new Set(blobs.map((e) => /^skills\/([^/]+)\/SKILL\.md$/.exec(e.path)?.[1]).filter((n) => n && SID_RE.test(n)))].sort();
  const items = await Promise.all(names.map(async (n) => {
    const files = blobs.filter((e) => e.path.startsWith(`skills/${n}/`)).map((e) => ({ path: e.path.slice(`skills/${n}/`.length), size: e.size || 0 }));
    let meta = { name: n, description: "" };
    try {
      const md = String(await ghGet(`https://raw.githubusercontent.com/${SKILL_REPO}/${tree.sha}/skills/${n}/SKILL.md`)).slice(0, 4000);
      meta = { name: fmField(md, "name") || n, description: fmField(md, "description").slice(0, 300) };
    } catch {}
    return { dir: n, ...meta, files, bytes: files.reduce((a, x) => a + x.size, 0), license: files.some((x) => /^LICENSE/i.test(x.path)) };
  }));
  return (skillCat = { at: Date.now(), sha: tree.sha, items });
}
const skillSource = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(SKILLS_DIR, dir, ".cc-source.json"), "utf8")); } catch { return null; } };
async function listSkillCatalog(force) {
  try {
    const c = await skillCatalog(force);
    return { ok: true, repo: SKILL_REPO, items: c.items.map(({ files, ...x }) => ({ ...x,
      installed: fs.existsSync(path.join(SKILLS_DIR, x.dir, "SKILL.md")), official: (skillSource(x.dir) || {}).repo === SKILL_REPO })) };
  } catch (e) { return { ok: false, message: tz("取不到官方技能目录：{err}", { err: e.message }) }; }
}
/** 装一个官方技能：按目录树逐个下载到临时目录，齐了再改名就位（不会留下半截）；超过 50 MB 不装 */
async function installCatalogSkill(dir) {
  if (!SID_RE.test(dir)) return { ok: false, message: "bad name" };
  const c = await skillCatalog().catch((e) => null);
  const it = c && c.items.find((x) => x.dir === dir);
  if (!it) return { ok: false, message: tz("官方目录里没有这个技能") };
  const dest = path.join(SKILLS_DIR, dir);
  if (fs.existsSync(dest)) return { ok: false, message: tz("已经有同名技能，先删掉再装") };
  if (it.bytes > 50 << 20) return { ok: false, message: tz("太大了（超过 50 MB）") };
  const tmp = path.join(SKILLS_DIR, `.tmp-${dir}-${process.pid}`);
  const ucb = ucAppBegin();
  fs.rmSync(tmp, { recursive: true, force: true });
  try {
    for (const f of it.files) {
      const out = path.resolve(tmp, f.path);
      if (!out.startsWith(tmp + path.sep)) throw new Error("bad path " + f.path);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, await ghGet(`https://raw.githubusercontent.com/${SKILL_REPO}/${c.sha}/skills/${dir}/${f.path.split("/").map(encodeURIComponent).join("/")}`));
    }
    fs.writeFileSync(path.join(tmp, ".cc-source.json"), JSON.stringify({ repo: SKILL_REPO, sha: c.sha, path: "skills/" + dir, at: new Date().toISOString() }) + "\n");
    fs.renameSync(tmp, dest);
    ucAppWrote([dest, tmp], ucb);
    return { ok: true };
  } catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); return { ok: false, message: e.message }; }
}

// MCP 注册表：任何人都能发布，没人审 —— 界面写明，装 npm 包前把命令亮给人看。
// 本机能直接用的两种：远程（streamable-http / sse）和 npm 包（npx 起 stdio）。pypi / docker 的标成装不了
const onPath = (bin) => String(claudeEnv().PATH || "").split(":").some((d) => d && fs.existsSync(path.join(d, bin)));
async function listMcpCatalog(q, cursor) {
  const u = new URL("https://registry.modelcontextprotocol.io/v0/servers");
  u.searchParams.set("version", "latest"); u.searchParams.set("limit", "30");
  if (q) u.searchParams.set("search", String(q).slice(0, 100));
  if (cursor) u.searchParams.set("cursor", String(cursor).slice(0, 300));
  let j;
  try { j = await ghGet(u.href, true); } catch (e) { return { ok: false, message: tz("取不到 MCP 注册表：{err}", { err: e.message }) }; }
  // 注册表谁都能发：版本号和位置参数原样拼进 npx 命令，不许夹带 --call 之类的选项（审查 10-29 第六份 低4）
  const npmArgsOk = (p) => (!p.version || /^[\w.+-]{1,64}$/.test(String(p.version))) &&
    (p.packageArguments || []).filter((a) => a.type === "positional" && (a.value || a.default))
      .every((a) => /^[\w./:@=+,-]{1,200}$/.test(String(a.value || a.default)) && !String(a.value || a.default).startsWith("-"));
  const field = (x) => ({ name: String(x.name || ""), description: String(x.description || "").slice(0, 200), required: !!x.isRequired, secret: !!x.isSecret });
  const items = (j.servers || []).map(({ server: v }) => {
    const options = [
      ...(v.remotes || []).filter((r) => ["streamable-http", "sse"].includes(r.type) && /^https:\/\//.test(r.url || "")).map((r) => ({
        kind: "remote", transport: r.type === "sse" ? "sse" : "http", target: r.url, headers: (r.headers || []).map(field) })),
      ...(v.packages || []).filter((p) => p.registryType === "npm" && (p.transport?.type || "stdio") === "stdio" && /^[@a-z0-9][\w./@-]*$/i.test(p.identifier || "") && npmArgsOk(p)).map((p) => ({
        kind: "npm", transport: "stdio", package: p.identifier, version: p.version || "",
        target: ["npx", "-y", p.identifier + (p.version ? "@" + p.version : ""),
          ...(p.packageArguments || []).filter((a) => a.type === "positional" && (a.value || a.default)).map((a) => String(a.value || a.default))].join(" "),
        env: (p.environmentVariables || []).map(field) })),
    ];
    const other = [...new Set((v.packages || []).filter((p) => p.registryType !== "npm").map((p) => p.registryType))];
    return { name: v.name, title: v.title || "", description: String(v.description || "").slice(0, 300), version: v.version || "",
      homepage: (v.repository && v.repository.url) || v.websiteUrl || "", options, other };
  });
  return { ok: true, items, next: (j.metadata && j.metadata.nextCursor) || "", npx: onPath("npx") };
}

/** 从 zip 装技能：包里找 SKILL.md，它所在的目录就是技能根（兼容「包一层文件夹」和「直接打包」两种） */
function skillDirName(text, fallback) {
  const fm = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const nm = fm && (/^name:\s*(.+?)\s*$/m.exec(fm[1]) || [])[1];
  return String(nm || fallback || "skill").trim().replace(/^["']|["']$/g, "").replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}
/** 导入技能：zip（含 .skill）里每个 SKILL.md 各算一个技能，一次全装；也接受单独一个 SKILL.md。
 *  同名已存在的跳过并说明，不覆盖 */
function importSkill(buf) {
  const isZip = buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50;
  if (!isZip) {
    const text = buf.toString("utf8");
    if (!/^\uFEFF?---\r?\n[\s\S]*?\r?\n---/.test(text)) throw new Error(tz("不是 zip，也不是带 name 的 SKILL.md"));
    const dir = skillDirName(text, "");
    if (!dir || !SID_RE.test(dir)) throw new Error(tz("技能名不合法"));
    const dst = path.join(SKILLS_DIR, dir);
    if (fs.existsSync(dst)) throw new Error(tz("已有同名技能「{name}」，先删掉旧的", { name: dir }));
    fs.mkdirSync(dst, { recursive: true });
    fs.writeFileSync(path.join(dst, "SKILL.md"), buf);
    return { ok: true, dir, dirs: [dir], skipped: [] };
  }
  const files = zipRead(buf, 200 * 1024 * 1024).filter((f) => !/(^|\/)(__MACOSX|\.git)\//.test(f.name) && !/(^|\/)\._/.test(f.name));
  // 浅的先占：一个技能目录里面再出现的 SKILL.md（示例、模板）归它自己，不另算
  const mds = files.filter((f) => /(^|\/)skill\.md$/i.test(f.name)).sort((a, b) => a.name.split("/").length - b.name.split("/").length);
  if (!mds.length) throw new Error(tz("压缩包里没有 SKILL.md"));
  const roots = [];
  for (const md of mds) {
    const root = md.name.slice(0, md.name.length - "SKILL.md".length);
    if (roots.some((r) => root.startsWith(r.root))) continue;
    roots.push({ root, md });
  }
  const dirs = [], skipped = [];
  for (const { root, md } of roots) {
    const dir = skillDirName(md.data.toString("utf8"), root.replace(/\/$/, "").split("/").pop());
    if (!dir || !SID_RE.test(dir)) { skipped.push({ name: root || md.name, why: tz("技能名不合法") }); continue; }
    const dst = path.join(SKILLS_DIR, dir);
    if (fs.existsSync(dst) || dirs.includes(dir)) { skipped.push({ name: dir, why: tz("已有同名技能") }); continue; }
    for (const f of files) {
      if (!f.name.startsWith(root)) continue;
      let rel = f.name.slice(root.length);
      if (f === md) rel = "SKILL.md";       // 统一成 Claude 认的大写文件名
      if (!rel || rel.split("/").some((x) => !x || x === "." || x === "..")) continue;
      if (rel === ".cc-source.json") continue;   // 来源记录只由官方目录安装时写：导入的包自带一份就能冒充「官方」（11-03 审查 I-13）
      const out = path.join(dst, rel);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, f.data);
    }
    dirs.push(dir);
  }
  if (!dirs.length) throw new Error(skipped.map((x) => `${x.name}：${x.why}`).join("；"));
  return { ok: true, dir: dirs.join("、"), dirs, skipped };
}

// ── 路由：/api/ext/ ──
export async function routeExtensions(req, res, u, p) {
  // ── 扩展：插件 / 市场 / MCP / 技能 ──
  if (p.startsWith("/api/ext/")) {
    const body = req.method === "POST" && p !== "/api/ext/skills/import" ? JSON.parse((await readBody(req)) || "{}") : {};
    try {
      if (req.method === "GET" && p === "/api/ext/plugins") {
        return sendJson(res, 200, await listPlugins(u.searchParams.get("q"), Number(u.searchParams.get("offset")) || 0, u.searchParams.get("available") === "1"));
      }
      if (req.method === "POST" && p === "/api/ext/plugins/install") {
        const r = await installPlugin(String(body.id || ""), body.accept ? String(body.accept) : null);
        if (r.ok) log(`装了插件 ${body.id}`);
        return sendJson(res, 200, r);
      }
      const op = p.match(/^\/api\/ext\/plugins\/(uninstall|enable|disable)$/);
      if (req.method === "POST" && op) {
        const r = await pluginOp(op[1], String(body.id || ""));
        if (r.ok) log(`插件 ${op[1]} ${body.id}`);
        return sendJson(res, 200, r);
      }
      if (req.method === "GET" && p === "/api/ext/marketplaces") return sendJson(res, 200, { items: await listMarketplaces() });
      if (req.method === "POST" && p === "/api/ext/marketplaces/add") return sendJson(res, 200, await marketplaceOp("add", String(body.source || "").trim()));
      if (req.method === "POST" && p === "/api/ext/marketplaces/remove") return sendJson(res, 200, await marketplaceOp("remove", String(body.name || "")));
      if (req.method === "GET" && p === "/api/ext/mcp") return sendJson(res, 200, { items: await listMcp() });
      if (req.method === "POST" && p === "/api/ext/mcp/add") return sendJson(res, 200, await addMcp(body));
      if (req.method === "POST" && p === "/api/ext/mcp/remove") return sendJson(res, 200, await removeMcp(body.name));
      if (req.method === "GET" && p === "/api/ext/skills") {
        if (PREFIX) await compIndex(false).catch(() => {});   // 组件技能的英文简介来自索引（有缓存，一般不联网）
        return sendJson(res, 200, { items: listSkills(), dir: SKILLS_DIR });
      }
      if (req.method === "GET" && p === "/api/ext/catalog/skills") return sendJson(res, 200, await listSkillCatalog(u.searchParams.get("refresh") === "1"));
      if (req.method === "POST" && p === "/api/ext/catalog/skills/install") return sendJson(res, 200, await installCatalogSkill(String(body.dir || "")));
      if (req.method === "GET" && p === "/api/ext/catalog/mcp") return sendJson(res, 200, await listMcpCatalog(u.searchParams.get("q"), u.searchParams.get("cursor")));
      if (req.method === "POST" && p === "/api/ext/skills/delete") return sendJson(res, 200, deleteSkill(String(body.dir || "")));
      if (req.method === "GET" && p === "/api/ext/hooks") return sendJson(res, 200, listHooks(u.searchParams.get("dir")));
      if (req.method === "POST" && p === "/api/ext/hooks/save") {
        try { return sendJson(res, 200, await saveHooks(body)); }
        catch (e) { return sendJson(res, 200, { ok: false, code: e.code, message: e.message }); }
      }
      if (req.method === "POST" && p === "/api/ext/hooks/scripts") return sendJson(res, 200, installHookScripts());
      if (req.method === "POST" && p === "/api/ext/hooks/test") return sendJson(res, 200, await testHook(body));
      if (req.method === "POST" && p === "/api/ext/skills/import") return sendJson(res, 200, importSkill(await readBodyBuf(req, 64 * 1024 * 1024)));
    } catch (e) { return sendJson(res, 200, { ok: false, message: e.message }); }
    return sendJson(res, 404, { error: "not found" });
  }
  return NEXT;
}
