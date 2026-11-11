import fs from "node:fs";
import path from "node:path";
import { CFG, PATHS, PERM_MODES, log, tz } from "./config.mjs";
import { API_KEY, BUILTIN_PROVIDER, PROVIDER, PROVIDERS_CFG, applyProvider } from "./providers.mjs";
import { beginBridgeSwitch, bridgeSwitching, setBridgeUpstream } from "./claude.mjs";
import { MAX_PARALLEL_CAP, RUNS, maxParallel } from "./runs.mjs";
import { NEXT, readBody, sendJson } from "./http.mjs";
import { customRefresh } from "./custom.mjs";
import { clearFollowingModels } from "./projects.mjs";
import { clearFollowingTaskModels } from "./sched.mjs";
import { idleDisarmAll, publishState, pump, setPermMode, strList } from "./queue.mjs";

export { SETTINGS, saveSettings } from "./settings-store.mjs";
import { SETTINGS, saveSettings, outputStyles } from "./settings-store.mjs";
import { clampAutoCompact } from "./stream.mjs";

// 设置回执只带认识的字段：设置文件能手改、能从旧版 / 分享的预置带过来，里面可能有类凭据字段。
// 以前直接展开 SETTINGS，GET 和保存回执会把它们原样送回界面（FIND-052）。
const VIEW_KEYS = ["model", "permissionMode", "guard", "addDirs", "outputStyle", "effort", "allowedTools", "disallowedTools",
  "autoCompactWindow", "provider", "memGuard", "autoClean", "maxParallel", "staticCompat", "idleCompaction", "workIsland",
  "localMode", "titleModel", "hiddenProviders", "permNotice", "permMigrated"];
const settingsView = () => Object.fromEntries(VIEW_KEYS.filter((k) => k in SETTINGS).map((k) => [k, SETTINGS[k]]));

// ── 路由：/api/settings ──
export async function routeSettings(req, res, u, p) {
  // 工作岛：设置页看它起没起来、没起来的原因，点「重试」重新检测（195-P.4）
  if (p === "/api/work-island" && req.method === "GET") return sendJson(res, 200, (await import("./work-island.mjs")).workIslandStatus());
  if (p === "/api/work-island/retry" && req.method === "POST") return sendJson(res, 200, (await import("./work-island.mjs")).retryWorkIsland());
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
    if (req.method === "GET") return sendJson(res, 200, { ...settingsView(), maxParallel: maxParallel(), maxParallelCap: MAX_PARALLEL_CAP, workspace: CFG.workspace, outputStyles: outputStyles() });
    if (req.method === "POST") {
      const b = JSON.parse((await readBody(req)) || "{}");
      // 先校验、再动内存（FIND-051）：未知厂商、正在生成时切厂商都要在改任何设置之前拦下。
      // 否则 model 已经写进 SETTINGS、permissionMode 还会经 setPermMode 当场落盘，最后返回 400/409 却留下半套设置。
      if ("provider" in b) {
        const want = b.provider ? String(b.provider) : null;
        const known = want && (want === BUILTIN_PROVIDER.id || (PROVIDERS_CFG && Object.hasOwn(PROVIDERS_CFG.providers, want)));   // constructor / __proto__ 别从原型上认出来（v0514 审查低-4）
        if (want && !known) return sendJson(res, 400, { error: "unknown provider", provider: want });
        if (want !== PROVIDER.id && (RUNS.size || bridgeSwitching())) {
          return sendJson(res, 409, {
            error: "busy",
            message: tz("这一轮还在生成中，等它跑完再切厂商（切换会换掉正在用的密钥与模型）。"),
          });
        }
      }
      for (const k of ["model", "outputStyle", "effort", "titleModel"]) {
        // 只收字符串：塞个对象进来会落盘，之后每一轮都在 .trim() / spawn 那里抛错，重启也好不了（审查 10-29 低7）
        // 长度也限：model 原样进 claude 的命令行，单个参数过 128 KB 就 E2BIG，每一轮都起不来（v0514 审查低-3）
        if (k in b) { if (b[k] != null && (typeof b[k] !== "string" || b[k].length > 200 || /[\x00-\x1f\x7f]/.test(b[k]))) return sendJson(res, 400, { error: `${k} must be a string (max 200)` }); }
      }
      // 输出风格只收列出来的那些（内置两种 + 用户目录里的）：直发请求也选不了工作区里别人放的文件
      if (b.outputStyle && !outputStyles().some((o) => o.id === b.outputStyle)) return sendJson(res, 400, { error: "unknown outputStyle" });
      for (const k of ["model", "outputStyle", "effort", "titleModel"]) if (k in b) SETTINGS[k] = b[k] || null;
      // 权限模式只收 claude 认的值；正在跑的那一轮也当场切过去
      // 落盘统一放到本路由末尾的一次 saveSettings()：以前 setPermMode 在这里就先写一次盘，后面任何校验失败都会留下半套设置（FIND-051）
      if ("permissionMode" in b && b.permissionMode !== SETTINGS.permissionMode) setPermMode(String(b.permissionMode || "default"), { persist: false });
      if (b.permNotice === false) SETTINGS.permNotice = false;
      // 条数、长度都有上限：每一轮都要拼进 claude 的命令行，塞几万条会 E2BIG，claude 再也起不来、重启也好不了（审查 v0513b 低-3）
      if (Array.isArray(b.addDirs)) SETTINGS.addDirs = strList(b.addDirs, 64, 4096, 16384);
      // 正在用的那家不许藏（界面已经锁了，这里再挡一道直发的请求）
      if (Array.isArray(b.hiddenProviders)) SETTINGS.hiddenProviders = strList(b.hiddenProviders, 64, 64).filter((id) => id !== PROVIDER.id);
      if (Array.isArray(b.allowedTools)) SETTINGS.allowedTools = strList(b.allowedTools, 200, 512, 8192);
      if (Array.isArray(b.disallowedTools)) SETTINGS.disallowedTools = strList(b.disallowedTools, 200, 512, 8192);
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
      // 敏感操作再确认没有关闭口子：设置接口不提供全局关掉这一层的能力，要放行走确认卡片逐次允许
      if ("idleCompaction" in b) { SETTINGS.idleCompaction = !!b.idleCompaction; if (!SETTINGS.idleCompaction) idleDisarmAll(); }
      if ("workIsland" in b) SETTINGS.workIsland = !!b.workIsland;
      // 存储的自动清理（D10）：开关 + 频次（每天 / 每周 / 每月）
      if (b.autoClean && typeof b.autoClean === "object") {
        const a = SETTINGS.autoClean || {};
        SETTINGS.autoClean = {
          enabled: "enabled" in b.autoClean ? !!b.autoClean.enabled : a.enabled !== false,
          every: ["day", "week", "month"].includes(b.autoClean.every) ? b.autoClean.every : (["day", "week", "month"].includes(a.every) ? a.every : "week"),
        };
      }

      if ("maxParallel" in b) {
        const n = Math.round(Number(b.maxParallel));
        SETTINGS.maxParallel = Number.isFinite(n) ? Math.max(1, Math.min(MAX_PARALLEL_CAP, n)) : 3;
        setImmediate(() => { publishState(); pump(); });   // 调大了马上放行排着的
      }

      // 自动压缩窗口：数字就设，空/0 就清除（交回给 claude 自己决定）
      if ("autoCompactWindow" in b) {
        const n = Number(b.autoCompactWindow);
        SETTINGS.autoCompactWindow = Number.isFinite(n) && n > 0 ? clampAutoCompact(n) : null;   // 存 claude 实际会用的值（195-O.2）
      }

      // ── 换厂商 ──
      //  正在生成时**不许切**：此刻 claude 进程肚子里还揣着上一家的密钥和模型名，
      //  它后续每一轮工具调用都要回网关 —— 桥一换上游，它就拿着 A 家的钥匙去敲 B 家的门。
      //  以前没这道闸，"连发消息 + 切厂商"叠在一起就是一场 401 暴雨。
      if ("provider" in b) {
        const want = b.provider ? String(b.provider) : null;
        // 未知厂商与「忙时不许切」在开头预校验过了，这里只剩真正要切的
        if (want !== PROVIDER.id) {
          const switched = beginBridgeSwitch();
          try {
            SETTINGS.provider = want;
            SETTINGS.model = null;          // 别把上一家的模型名带过去
            // 自动起名的型号同理：界面上还补进新清单显示选中，autotitle 却因为型号不在这一家的清单里静默不用
            // （0.6.9 审计 195-E.6）。清掉后回落到本轮模型，用户要就重新选
            SETTINGS.titleModel = null;
            // 跟着全局接口走的项目、定时任务也一样（195-E.1：以前它们留着旧厂商的型号，在新接口上回落或 400）
            const np = clearFollowingModels(), nt = clearFollowingTaskModels();
            if (np || nt) log(`换接口：清掉 ${np} 个项目、${nt} 个定时任务里旧接口的模型名`);
            applyProvider();
            // 上游热切 —— 不重启桥，也就没有断流窗口
            await setBridgeUpstream(CFG.upstream);
          } finally { switched(); }
          log(`已切换厂商 → ${PROVIDER.id}  上游 ${CFG.upstream}  ` +
              `${API_KEY ? "有密钥" : (PROVIDER.login ? "走登录态" : "无密钥")}`);
        }
      }

      // 工作岛开关不管写盘成没成功都要应用（以前排在 return 500 后面，失败时被跳过）：写盘失败时内存里已经是新值，
      // 其他开关本次运行内也都按新值走，只有它不跟着，就成了「设置里是开的、实际没开」（#122-3 复核建议 3）。
      // import 是异步的，实际在 saveSettings 之后才执行，这不影响
      if ("workIsland" in b) {
        import("./work-island.mjs")
          .then((m) => m.applyWorkIslandSetting())
          .catch((e) => log("工作岛设置应用失败: " + e.message));
      }
      if (!saveSettings())
        return sendJson(res, 500, { error: tz("设置没能写入磁盘；本次运行内可能仍按新值生效，重启后恢复旧值（详情见网关日志）") });
      log(`设置已更新 provider=${PROVIDER.id} model=${SETTINGS.model || "(默认)"} effort=${SETTINGS.effort} autoCompact=${SETTINGS.autoCompactWindow || "(默认)"} workIsland=${SETTINGS.workIsland}`);
      return sendJson(res, 200, { ok: true, settings: settingsView(), provider: PROVIDER.id, upstream: CFG.upstream });
    }
  }
  return NEXT;
}
