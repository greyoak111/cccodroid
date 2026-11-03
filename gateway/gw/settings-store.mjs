// 设置的存取单独成模块，只依赖 config.mjs：各模块都从这里拿 SETTINGS，
// 不再经 settings.mjs ↔ providers.mjs 的环（审查 10-30 v0.5.12 低5：单独导入 providers 会撞暂时性死区，重排 server.mjs 的 import 就可能启动即崩）
import fs from "node:fs";
import path from "node:path";
import { PATHS, PERM_MODES, log } from "./config.mjs";

// ── 设置（模型 / 权限模式 / 目录 …）──────────────────────────────────
export const SETTINGS = {
  // 不预填：CFG.model 是内置第三方厂商的兜底，预填进来会被带给官方账户（新装无设置文件时实测 400）
  model: null,
  // 和官方一致：逐项确认。前端的确认卡片接的是 stream-json 控制协议（见 startRun 里的 can_use_tool）
  permissionMode: "default",
  // 敏感操作再确认：碰密钥 / 凭据、读屏点按、读剪贴板、往外分享文件时，哪怕全部放行也停下来问（guard/cc-guard.mjs）
  guard: true,
  addDirs: [],
  outputStyle: null,
  effort: null,
  allowedTools: null,
  disallowedTools: null,
  // 自动压缩窗口（token）。留空 = 交给 claude 自己按模型窗口决定；填了就用你的值。
  autoCompactWindow: null,
  // 生效厂商（ccapp-providers.json 里的 id）。留空 = 用配置文件里的 active。
  provider: null,
  // 内存管家（cc-mem）：默认关。开了才允许停别的应用；白名单是用户额外保护的包名
  memGuard: { enabled: false, whitelist: [] },
  // 最多同时跑几个会话（1 = 和以前一样一次只跑一轮）
  maxParallel: 3,
  // 静态程序兼容：claude 外面套 seccomp-enosys-run -f，它拉起的整棵进程树里撞 seccomp 的静态二进制
  // （CGO_ENABLED=0 的 Go 程序之类）拿到 ENOSYS 而不是被 SIGSYS 打死。出问题时可关，回到不套的老样子
  staticCompat: true,
  // 空闲压缩：长会话闲置快一小时、1 小时提示缓存快过期时先压缩，下一条消息不用把整段历史重算一遍（见 idleArm）
  idleCompaction: true,
  // 工作岛：把 Claude 的工作状态送到 ColorOS 16 灵动岛（可选，默认关；见 gw/work-island.mjs）
  workIsland: false,
  // 端侧小模型：chat = 纯聊天（不给工具，提示只有几十 token）；custom = 用户自己的 ~/.cccodroid/local-mode.json
  localMode: "chat",
  // 自动起名用的型号（#60）：null = 跟对话同一型号；"off" = 不自动起；其他 = 全局那家清单里的某个型号（见 autotitle.mjs）
  titleModel: null,
  // 不在输入栏模型选单里显示的接口（只是不显示，配置照留；正在用的、全局默认的那家照样显示）
  hiddenProviders: [],
};

/** 字符串数组：只留字符串，条数、每条长度、总长（字）都有上限 */
export function capList(a, n, len, total = Infinity) {
  const out = [];
  let sum = 0;
  for (const x of Array.isArray(a) ? a : []) {
    if (typeof x !== "string" || x.length > len) continue;
    if (out.length >= n || sum + x.length > total) break;
    out.push(x); sum += x.length;
  }
  return out;
}
function loadSettings() {
  let had = false;
  try {
    Object.assign(SETTINGS, JSON.parse(fs.readFileSync(PATHS.settings, "utf8")));
    had = true;
  } catch {}
  // 旧版没限过：已经存进去的超长列表在这里截住，别让它每一轮把 claude 的命令行撑爆（审查 v0513b 低-3）
  // 条数、每条长度之外还要管总长：64×4096 加上工具名单能超过 ARG_MAX（128 KB），每轮 spawn 都 E2BIG（10-31 复核）
  const cap = (a, n, len, total) => (Array.isArray(a) ? capList(a, n, len, total) : a);
  SETTINGS.addDirs = cap(SETTINGS.addDirs, 64, 4096, 16384) || [];
  SETTINGS.hiddenProviders = Array.isArray(SETTINGS.hiddenProviders) ? capList(SETTINGS.hiddenProviders, 64, 64) : [];
  if (SETTINGS.allowedTools) SETTINGS.allowedTools = cap(SETTINGS.allowedTools, 200, 512, 8192);
  if (SETTINGS.disallowedTools) SETTINGS.disallowedTools = cap(SETTINGS.disallowedTools, 200, 512, 8192);
  // model 也原样进命令行：旧版存进去的超长值在这里丢掉（v0514 审查低-3）
  for (const k of ["model", "outputStyle", "effort", "titleModel"]) if (SETTINGS[k] != null && (typeof SETTINGS[k] !== "string" || SETTINGS[k].length > 200)) SETTINGS[k] = null;
  // 权限模式一次性迁移：以前界面没法点「允许」，默认只能全部放行。设置里的 bypassPermissions
  // 分不清是用户选的还是当年的默认值 —— 一律改回逐项确认，界面给一条可关的提示；之后再选回去就尊重用户。
  // manual 是旧下拉里的无效值（claude 不认），同样改掉。
  if (!SETTINGS.permMigrated) {
    if (had && (!SETTINGS.permissionMode || SETTINGS.permissionMode === "bypassPermissions" || SETTINGS.permissionMode === "manual")) {
      if (SETTINGS.permissionMode === "bypassPermissions") SETTINGS.permNotice = true;
      SETTINGS.permissionMode = "default";
    }
    SETTINGS.permMigrated = 1;
    if (had) setImmediate(saveSettings);
  }
  if (!PERM_MODES.includes(SETTINGS.permissionMode)) SETTINGS.permissionMode = "default";
  // 旧版面板存的是小写 explanatory / 不存在的 concise —— claude 只认 Explanatory、Learning 和自定义的
  if (SETTINGS.outputStyle === "explanatory") SETTINGS.outputStyle = "Explanatory";
  if (SETTINGS.outputStyle === "concise") SETTINGS.outputStyle = null;
  // 以前有个界面上没有入口、只能经接口写的 appendSystemPrompt，每轮接在系统提示后面：
  // 应用自己不留「改系统提示词」的口子（要给项目定规矩用 CLAUDE.md，那是 Claude Code 自己的机制），旧值清掉
  if ("appendSystemPrompt" in SETTINGS) { delete SETTINGS.appendSystemPrompt; setImmediate(saveSettings); }
}

/** 写盘成功返回 true；失败记日志并返回 false（调用方要如实告诉用户，别报「已保存」——#122-3） */
export function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(PATHS.settings), { recursive: true });
    // 先写临时文件再换名：写到一半被杀，下次读到半个 JSON 会回落默认，下一次保存就把密钥覆盖没了（审查 中1）
    fs.writeFileSync(PATHS.settings + ".tmp", JSON.stringify(SETTINGS, null, 2), { mode: 0o600 });
    fs.renameSync(PATHS.settings + ".tmp", PATHS.settings);
    return true;
  } catch (e) {
    try { fs.rmSync(PATHS.settings + ".tmp", { force: true }); } catch {}
    log(`保存设置失败: ${e.message}`);
    return false;
  }
}
loadSettings();
