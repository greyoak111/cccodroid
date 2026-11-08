import fs from "node:fs";
import { CFG, PATHS, PREFIX } from "./config.mjs";
import { SETTINGS } from "./settings-store.mjs";
import { API_KEY, PROVIDER, providerBrief } from "./providers.mjs";
import { bridgeAlive, runClaude, safeMode } from "./claude.mjs";
import { AUTH_CACHE } from "./login.mjs";
import { LAST_SESSION, RUNS } from "./runs.mjs";
import { NEXT, sendJson, uiTag } from "./http.mjs";
import { QUEUE } from "./queue.mjs";
import { cmdDescs } from "./commands.mjs";

// ── 能力清单 ──────────────────────────────────────────────────────────
let LAST_INIT = null;          // 最近一次 init 事件（含 tools / slash_commands / skills / agents）
export const setLastInit = (v) => { LAST_INIT = v; };

/** 各斜杠命令的分类与说明（用于 GUI 面板；未列出的按“转发给 claude”处理） */
const COMMAND_META = {
  context:   { cat: "上下文", desc: "查看上下文窗口占用与技能清单", local: true },
  compact:   { cat: "上下文", desc: "压缩对话历史，释放上下文空间", local: true },
  clear:     { cat: "上下文", desc: "清空当前会话上下文，另起一段", local: true },
  cost:      { cat: "状态",   desc: "本次会话的花费与时长", local: true },
  usage:     { cat: "状态",   desc: "订阅用量与限额", local: true },
  status:    { cat: "状态",   desc: "当前环境与配置状态", local: true },
  doctor:    { cat: "状态",   desc: "检查安装健康状况", local: true },
  model:     { cat: "配置",   desc: "查看或切换模型", local: true },
  config:    { cat: "配置",   desc: "查看或修改配置项", local: true },
  effort:    { cat: "配置",   desc: "调整思考强度", local: true },
  fast:      { cat: "配置",   desc: "切换快速模式", local: true },
  mcp:       { cat: "扩展",   desc: "管理 MCP 服务器", local: true },
  agents:    { cat: "扩展",   desc: "管理子代理", local: true },
  memory:    { cat: "上下文", desc: "编辑 CLAUDE.md 记忆文件", local: true },
  init:      { cat: "项目",   desc: "为当前项目生成 CLAUDE.md", local: false },
  review:    { cat: "项目",   desc: "审查当前改动", local: false },
  "security-review": { cat: "项目", desc: "安全审查", local: false },
  "code-review":     { cat: "项目", desc: "代码审查", local: false },
  rename:    { cat: "会话",   desc: "重命名当前会话", local: true },
  resume:    { cat: "会话",   desc: "恢复历史会话", local: true },
  recap:     { cat: "会话",   desc: "回顾本次会话要点", local: true },
  insights:  { cat: "状态",   desc: "使用洞察报告", local: true },
  goal:      { cat: "工作流", desc: "设定长期目标", local: false },
  loop:      { cat: "工作流", desc: "循环执行任务", local: false },
  batch:     { cat: "工作流", desc: "批量处理", local: false },
  verify:    { cat: "工作流", desc: "验证改动", local: false },
  debug:     { cat: "工作流", desc: "调试问题", local: false },
  simplify:  { cat: "工作流", desc: "简化代码", local: false },
  "deep-research": { cat: "工作流", desc: "深度研究", local: false },
  workflow:  { cat: "工作流", desc: "编排多代理工作流", local: false },
};

const FALLBACK_COMMANDS = Object.keys(COMMAND_META);
/** 自带命令的名字（常用指令不许和它们重名） */
export const builtinCommands = () => Object.keys(COMMAND_META);

/** 权限规则（能力页「工具」一节标允许 / 询问 / 拒绝用）：用户级 ~/.claude/settings.json 的 permissions + 本应用设置里的允许 / 禁用工具 */
function permRules() {
  const r = { allow: [], ask: [], deny: [] };
  try {
    const j = JSON.parse(fs.readFileSync((process.env.HOME || CFG.home) + "/.claude/settings.json", "utf8")).permissions || {};
    for (const k of ["allow", "ask", "deny"]) if (Array.isArray(j[k])) r[k].push(...j[k].map(String));
  } catch {}
  if (Array.isArray(SETTINGS.allowedTools)) r.allow.push(...SETTINGS.allowedTools);
  if (Array.isArray(SETTINGS.disallowedTools)) r.deny.push(...SETTINGS.disallowedTools);
  return r;
}

function capabilities() {
  const init = LAST_INIT || {};
  const cmds = (init.slash_commands || FALLBACK_COMMANDS).filter((c) => !c.startsWith("__"));
  // 常用指令（commands/*.md）：说明从文件头读；刚建好、claude 还没重新报 init 的也先列上
  const mine = cmdDescs();
  for (const n of Object.keys(mine)) if (!cmds.includes(n)) cmds.push(n);
  return {
    ready: !!LAST_INIT,
    model: SETTINGS.model,
    permissionMode: SETTINGS.permissionMode,
    tools: init.tools || [],
    slashCommands: cmds.map((c) => ({
      name: c,
      ...(COMMAND_META[c] || (mine[c] ? { cat: "常用指令", desc: mine[c].desc, hint: mine[c].hint, custom: mine[c].scope, local: false } : { cat: "其他", desc: "", local: false })),
    })),
    skills: init.skills || [],
    agents: init.agents || [],
    plugins: (init.plugins || []).map((p) => (typeof p === "string" ? p : p.name || String(p))),
    mcpServers: init.mcp_servers || [],
    outputStyle: init.output_style || "default",
    version: init.claude_code_version || "",
    rules: permRules(),
    settings: SETTINGS,
  };
}

// ── 路由：/api/status /api/capabilities /api/cli ──
export async function routeCaps(req, res, u, p) {
  if (req.method === "GET" && p === "/api/status") {
    return sendJson(res, 200, {
      app: "claude-cli",
      product: PREFIX ? "cccodroid" : "Claude CLI",   // 界面标题
      pid: process.pid,
      ready: fs.existsSync(PATHS.claude) && fs.existsSync(PATHS.loader),
      // 登录态厂商也算"就绪"：它不用密钥，用的是 claude 自己的 OAuth 登录
      hasKey: !!API_KEY || !!PROVIDER.login,
      keyMode: API_KEY ? "key" : (PROVIDER.login ? "login" : "none"),
      // 真实的 OAuth 状态（问过才有；unknown 表示问不出，不等于未登录）。界面别只看 loader 在不在（0.6.9 审计 195-G.3）
      auth: AUTH_CACHE && AUTH_CACHE.v ? {
        loggedIn: !!AUTH_CACHE.v.loggedIn, unknown: !!AUTH_CACHE.v.unknown, stale: !!AUTH_CACHE.v.stale, at: AUTH_CACHE.at,
      } : null,
      // 别家填了 Key 也算接上了：会话可以单独选那家（0.3.16 起），首屏不该再叫人去接模型
      otherKey: providerBrief().some((p) => !p.active && p.keyMode === "key" && !(SETTINGS.hiddenProviders || []).includes(p.id)),
      model: SETTINGS.model || PROVIDER.defaultModel || null,
      provider: PROVIDER.id,
      providerLabel: PROVIDER.label || PROVIDER.id,
      providerLabelEn: PROVIDER.labelEn || "",   // 界面不是中文时用（和设置里选接口那张单子同一规则）
      upstream: CFG.upstream,
      nativeModels: !!PROVIDER.nativeModels,
      workspace: CFG.workspace,
      runtime: CFG.runtime,
      bridge: await bridgeAlive(),
      uptimeMs: Math.round(process.uptime() * 1000),
      version: "3.0.0",
      busy: RUNS.size > 0,
      running: RUNS.size,
      // 挂起的（点了停止、被系统中断的）不会自己发出去，不算「有活要干」：外壳据 queued 判断能不能换工具包
      queued: QUEUE.filter((q) => !q.held).length,
      held: QUEUE.filter((q) => q.held).length,
      safeMode: safeMode(),
      hasLedger: !!process.env.CCAPP_LEDGER,
      uiTag: uiTag(),
      lastSessionId: LAST_SESSION ? LAST_SESSION.id : null,
      lastSessionAt: LAST_SESSION ? LAST_SESSION.at : null,
    });
  }
  // ── 能力清单 ──
  if (req.method === "GET" && p === "/api/capabilities") {
    return sendJson(res, 200, capabilities());
  }
  // ── 运行 CLI 子命令取状态（mcp list / agents …）──
  if (req.method === "GET" && p === "/api/cli") {
    const sub = (u.searchParams.get("cmd") || "").trim();
    const ALLOW = new Set(["mcp list", "agents", "plugin list", "plugins", "doctor", "auth status", "auto-mode"]);
    if (!ALLOW.has(sub)) return sendJson(res, 400, { error: "command not allowed", cmd: sub });
    const r = await runClaude(sub.split(/\s+/), { timeoutMs: 45000 });
    return sendJson(res, 200, {
      cmd: sub,
      out: (r.out || "").slice(0, 30000),
      err: (r.err || "").slice(0, 4000),
      code: r.code ?? null,
      signal: r.signal || null,
      timeout: !!r.timeout,
    });
  }
  return NEXT;
}
