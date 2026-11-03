import fs from "node:fs";
import path from "node:path";
import { CFG, PATHS, PERM_MODES, log, tz } from "./config.mjs";
import { API_KEY, BUILTIN_PROVIDER, PROVIDER, PROVIDERS_CFG, applyProvider } from "./providers.mjs";
import { setBridgeUpstream } from "./claude.mjs";
import { MAX_PARALLEL_CAP, RUNS, maxParallel } from "./runs.mjs";
import { NEXT, readBody, sendJson } from "./http.mjs";
import { customRefresh } from "./custom.mjs";
import { idleDisarmAll, publishState, pump, setPermMode, strList } from "./queue.mjs";

export { SETTINGS, saveSettings } from "./settings-store.mjs";
import { SETTINGS, saveSettings } from "./settings-store.mjs";

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
      for (const k of ["model", "outputStyle", "effort", "titleModel"]) {
        // 只收字符串：塞个对象进来会落盘，之后每一轮都在 .trim() / spawn 那里抛错，重启也好不了（审查 10-29 低7）
        // 长度也限：model 原样进 claude 的命令行，单个参数过 128 KB 就 E2BIG，每一轮都起不来（v0514 审查低-3）
        if (k in b) { if (b[k] != null && (typeof b[k] !== "string" || b[k].length > 200 || /[\x00-\x1f\x7f]/.test(b[k]))) return sendJson(res, 400, { error: `${k} must be a string (max 200)` }); SETTINGS[k] = b[k] || null; }
      }
      // 权限模式只收 claude 认的值；正在跑的那一轮也当场切过去
      if ("permissionMode" in b && b.permissionMode !== SETTINGS.permissionMode) setPermMode(String(b.permissionMode || "default"));
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
      if ("guard" in b) SETTINGS.guard = !!b.guard;
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
        const known = want && (want === BUILTIN_PROVIDER.id || (PROVIDERS_CFG && Object.hasOwn(PROVIDERS_CFG.providers, want)));   // constructor / __proto__ 别从原型上认出来（v0514 审查低-4）
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

      if (!saveSettings())
        return sendJson(res, 500, { error: tz("设置没能写入磁盘；本次运行内可能仍按新值生效，重启后恢复旧值（详情见网关日志）") });
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
