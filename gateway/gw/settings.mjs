import fs from "node:fs";
import path from "node:path";
import { CFG, PATHS, log, tz } from "./config.mjs";
import { API_KEY, BUILTIN_PROVIDER, PERM_MODES, PROVIDER, PROVIDERS_CFG, applyProvider } from "./providers.mjs";
import { setBridgeUpstream } from "./claude.mjs";
import { MAX_PARALLEL_CAP, RUNS, maxParallel } from "./runs.mjs";
import { NEXT, readBody, sendJson } from "./http.mjs";
import { customRefresh } from "./custom.mjs";
import { idleDisarmAll, publishState, pump, setPermMode } from "./queue.mjs";

// ── 设置（模型 / 权限模式 / 目录 …）──────────────────────────────────
export const SETTINGS = {
  // 不预填：CFG.model 是内置第三方厂商的兜底，预填进来会被带给官方账户（新装无设置文件时实测 400）
  model: null,
  // 和官方一致：逐项确认。前端的确认卡片接的是 stream-json 控制协议（见 startRun 里的 can_use_tool）
  permissionMode: "default",
  addDirs: [],
  outputStyle: null,
  effort: null,
  appendSystemPrompt: null,
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
};

function loadSettings() {
  let had = false;
  try {
    Object.assign(SETTINGS, JSON.parse(fs.readFileSync(PATHS.settings, "utf8")));
    had = true;
  } catch {}
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
}

/** claude 认的输出风格：内置两种 + ~/.claude/output-styles 与工作区 .claude/output-styles 里的 .md（名字取 frontmatter 的 name） */
function outputStyles() {
  const out = [
    { id: "Explanatory", desc: "边做边解释实现取舍" },
    { id: "Learning", desc: "留 TODO 让你亲手写一部分" },
  ];
  for (const dir of [path.join(CFG.home, ".claude/output-styles"), path.join(CFG.workspace, ".claude/output-styles")]) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".md")); } catch { continue; }
    for (const f of files) {
      let name = f.slice(0, -3), desc = "";
      try {
        const head = fs.readFileSync(path.join(dir, f), "utf8").slice(0, 2000);
        const fm = head.match(/^---\n([\s\S]*?)\n---/);
        if (fm) {
          name = (fm[1].match(/^name:s*(.+)$/m) || [, name])[1].trim();
          desc = (fm[1].match(/^description:s*(.+)$/m) || [, ""])[1].trim();
        }
      } catch {}
      if (!out.some((o) => o.id === name)) out.push({ id: name, desc });
    }
  }
  return out;
}
export function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(PATHS.settings), { recursive: true });
    fs.writeFileSync(PATHS.settings, JSON.stringify(SETTINGS, null, 2), { mode: 0o600 });
  } catch (e) { log(`保存设置失败: ${e.message}`); }
}
loadSettings();

applyProvider();

// ── 路由：/api/settings ──
export async function routeSettings(req, res, u, p) {
  // ── 设置 ──
  // 执行方式（targetSdk 28 / 36 双方案）：偏好写在 files/.exec-mode，由 Env.java 读，GatewayService 每次拉起网关都重读 ——
  // 所以改完重启网关就生效。targetSdk ≥ 29 的包只能经加载器，选「直接」会被拒
  if (p === "/api/exec-mode") {
    const f = path.join(CFG.runtime, ".exec-mode");
    const sdk = Number(process.env.CCAPP_TARGET_SDK || 0), must = sdk >= 29;
    const pref = () => { try { return fs.readFileSync(f, "utf8").trim() || "auto"; } catch { return "auto"; } };
    if (req.method === "GET") {
      // 选了经加载器却没切过去，多半是 APK 里的 ld.so 和工具包里现装的不是同一份（Env.ldsoMatches）：把原因交给界面
      let ldso = "";
      if (process.env.CCAPP_NATIVE_LIB) {
        const a = path.join(process.env.CCAPP_NATIVE_LIB, "libldlinux.so"), b = path.join(PATHS.glibcLib, "ld-linux-aarch64.so.1");
        try { ldso = fs.readFileSync(a).equals(fs.readFileSync(b)) ? "same" : "differ"; } catch { ldso = "missing"; }
      }
      return sendJson(res, 200, { pref: pref(), active: process.env.CCAPP_EXEC || "direct", must, targetSdk: sdk, ldso, pid: process.pid });   // pid：界面靠它认出重启后的新网关
    }
    if (req.method === "POST") {
      const b = JSON.parse((await readBody(req)) || "{}");
      if ("mode" in b) {
        const m = String(b.mode);
        if (!["auto", "direct", "loader"].includes(m)) return sendJson(res, 400, { error: "bad mode" });
        if (must && m === "direct") return sendJson(res, 409, { error: tz("这个版本（targetSdk {n}）只能经加载器运行，不能切到直接执行", { n: sdk }) });
        if (m === "auto") fs.rmSync(f, { force: true }); else fs.writeFileSync(f, m + "\n");
        log(`执行方式偏好改为 ${m}`);
      }
      if (b.restart) {
        if (RUNS.size) return sendJson(res, 409, { error: tz("还有任务在跑，等它们结束再重启") });
        log("按设置重启网关（执行方式）");
        setTimeout(() => process.kill(process.pid, "SIGTERM"), 300);   // 走正常收尾；GatewayService 会马上再拉起
      }
      return sendJson(res, 200, { ok: true, pref: pref(), restart: !!b.restart });
    }
  }

  if (p === "/api/settings") {
    if (req.method === "GET") return sendJson(res, 200, { ...SETTINGS, maxParallel: maxParallel(), maxParallelCap: MAX_PARALLEL_CAP, workspace: CFG.workspace, outputStyles: outputStyles() });
    if (req.method === "POST") {
      const b = JSON.parse((await readBody(req)) || "{}");
      for (const k of ["model", "outputStyle", "effort", "appendSystemPrompt"]) {
        if (k in b) SETTINGS[k] = b[k] || null;
      }
      // 权限模式只收 claude 认的值；正在跑的那一轮也当场切过去
      if ("permissionMode" in b && b.permissionMode !== SETTINGS.permissionMode) setPermMode(String(b.permissionMode || "default"));
      if (b.permNotice === false) SETTINGS.permNotice = false;
      if (Array.isArray(b.addDirs)) SETTINGS.addDirs = b.addDirs.filter((d) => typeof d === "string");
      if (Array.isArray(b.allowedTools)) SETTINGS.allowedTools = b.allowedTools;
      if (Array.isArray(b.disallowedTools)) SETTINGS.disallowedTools = b.disallowedTools;
      if (b.memGuard && typeof b.memGuard === "object") {
        const g = SETTINGS.memGuard || {};
        SETTINGS.memGuard = {
          enabled: "enabled" in b.memGuard ? !!b.memGuard.enabled : !!g.enabled,
          whitelist: Array.isArray(b.memGuard.whitelist)
            ? [...new Set(b.memGuard.whitelist.map((x) => String(x).trim()).filter((x) => /^[A-Za-z][\w]*(\.[\w]+)+$/.test(x)))]
            : (g.whitelist || []),
        };
      }

      if ("staticCompat" in b) { SETTINGS.staticCompat = !!b.staticCompat; try { customRefresh(); } catch {} }   // 下一轮生效；自定义组件的入口立刻跟着改
      if ("idleCompaction" in b) { SETTINGS.idleCompaction = !!b.idleCompaction; if (!SETTINGS.idleCompaction) idleDisarmAll(); }
      if ("workIsland" in b) SETTINGS.workIsland = !!b.workIsland;

      if ("maxParallel" in b) {
        const n = Math.round(Number(b.maxParallel));
        SETTINGS.maxParallel = Number.isFinite(n) ? Math.max(1, Math.min(MAX_PARALLEL_CAP, n)) : 3;
        setImmediate(() => { publishState(); pump(); });   // 调大了马上放行排着的
      }

      // 自动压缩窗口：数字就设，空/0 就清除（交回给 claude 自己决定）
      if ("autoCompactWindow" in b) {
        const n = Number(b.autoCompactWindow);
        SETTINGS.autoCompactWindow = Number.isFinite(n) && n > 0 ? Math.round(n) : null;
      }

      // ── 换厂商 ──
      //  正在生成时**不许切**：此刻 claude 进程肚子里还揣着上一家的密钥和模型名，
      //  它后续每一轮工具调用都要回网关 —— 桥一换上游，它就拿着 A 家的钥匙去敲 B 家的门。
      //  以前没这道闸，"连发消息 + 切厂商"叠在一起就是一场 401 暴雨。
      if ("provider" in b) {
        const want = b.provider ? String(b.provider) : null;
        const known = want && (want === BUILTIN_PROVIDER.id || (PROVIDERS_CFG && PROVIDERS_CFG.providers[want]));
        if (want && !known) return sendJson(res, 400, { error: "unknown provider", provider: want });

        if (want !== PROVIDER.id) {
          if (RUNS.size) {
            return sendJson(res, 409, {
              error: "busy",
              message: tz("这一轮还在生成中，等它跑完再切厂商（切换会换掉正在用的密钥与模型）。"),
            });
          }
          SETTINGS.provider = want;
          SETTINGS.model = null;          // 别把上一家的模型名带过去
          applyProvider();
          // 上游热切 —— 不重启桥，也就没有断流窗口
          await setBridgeUpstream(CFG.upstream);
          log(`已切换厂商 → ${PROVIDER.id}  上游 ${CFG.upstream}  ` +
              `${API_KEY ? "有密钥" : (PROVIDER.login ? "走登录态" : "无密钥")}`);
        }
      }

      saveSettings();
      if ("workIsland" in b) {
        import("./work-island.mjs")
          .then((m) => m.applyWorkIslandSetting())
          .catch((e) => log("工作岛设置应用失败: " + e.message));
      }
      log(`设置已更新 provider=${PROVIDER.id} model=${SETTINGS.model || "(默认)"} effort=${SETTINGS.effort} autoCompact=${SETTINGS.autoCompactWindow || "(默认)"} workIsland=${SETTINGS.workIsland}`);
      return sendJson(res, 200, { ok: true, settings: SETTINGS, provider: PROVIDER.id, upstream: CFG.upstream });
    }
  }
  return NEXT;
}
