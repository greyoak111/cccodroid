#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
//  server.mjs —— Claude CLI 的 HTTP + SSE 网关
//
//  把本机的 Claude Code CLI（走 DeepSeek API）包成完整的图形化入口：
//
//    · 会话管理   读 claude 自己的 transcript（~/.claude/projects/*.jsonl），
//                 可以列表 / 恢复 / 删除 / 重命名 —— 多上下文并存
//    · 斜杠命令   /context /cost /model /status /mcp … 在 -p 模式下能直接执行，
//                 原样转发即可拿到 CLI 的本地命令输出
//    · 能力清单   工具 / 技能 / 代理 / 斜杠命令 / MCP / 插件，全部可见
//    · 设置       模型、权限模式、附加目录、输出风格、思考强度
//
//  用法: node server.mjs [port]
//
//  代码按功能分在 gw/ 下，本文件只管路由分发与启动：
//
//    config      路径、环境、工具函数、提示语多语言     http        回 JSON、静态文件、读请求体
//    providers   厂商目录、密钥、余额与消费             access      令牌、Host/Origin 校验
//    settings    设置                                   bus         事件总线（SSE）
//    models      模型清单                               runs        正在跑的轮次、最近会话
//    claude      shell、DNS 桥、claude 进程环境         queue       排队、车道、被杀接续、空闲压缩
//    sessions    会话列表、重命名、搜索、会话接口       run         跑一轮
//    sessionops  分叉、回退、回收站、导出导入           stream      系统提示补充、流事件翻译、订阅额度
//    transcript  分页读会话记录                         modelcmd    /model /effort
//    goal        /goal 与任务清单                       login       账户登录
//    caps        能力清单、状态                         usage       耗电、使用统计、cc-mem
//    files       文件收发、截屏                         devside     开发端（更新、Shizuku、priv）
//    preview     HTML 预览                              envfacts    本机实况
//    terminal    应用内终端                             feedback    反馈（GitHub Issue 草稿）
//    git         git 可视化                             extensions  插件 / 技能 / MCP / Hooks / 官方目录
//    components  可选组件、gh 登录                      local       端侧小模型与模型下载
//    custom      自定义组件                             office      Office 文档
//    modules     模块化工具包（加装 / 卸载单个模块）
//
//  每个模块导出一个 routeXxx(req, res, u, p)：认领的请求自己回完；不归它管就返回 NEXT。
//  模块之间互相导入；ES 模块的导入是只读的，跨模块改状态走对方导出的函数（如 dropModelCache）。
// ─────────────────────────────────────────────────────────────────────

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { CFG, PATHS, PREFIX, log } from "./gw/config.mjs";
import { SETTINGS, routeSettings, saveSettings } from "./gw/settings.mjs";
import { API_KEY, PROVIDER, routeProviders } from "./gw/providers.mjs";
import { fetchModels, normEffort, routeModels } from "./gw/models.mjs";
import { listSessions, routeSessions } from "./gw/sessions.mjs";
import { bridgeProc, killTree, reapOrphans, routeClaude } from "./gw/claude.mjs";
import { expireTrash } from "./gw/sessionops.mjs";
import { routeCaps, builtinCommands } from "./gw/caps.mjs";
import { NEXT, sendJson, serveStatic } from "./gw/http.mjs";
import { UPLOAD_DIR, routeFiles } from "./gw/files.mjs";
import { routePreview } from "./gw/preview.mjs";
import { startStreamFix } from "./gw/streamfix.mjs";
import { TERMS, routeTerminal } from "./gw/terminal.mjs";
import { routeGit } from "./gw/git.mjs";
import { routeComponents } from "./gw/components.mjs";
import { routeModules } from "./gw/modules.mjs";
import { cleanOrphans, routeOrphans } from "./gw/orphans.mjs";
import { customRefresh, routeCustom } from "./gw/custom.mjs";
import { routeBus } from "./gw/bus.mjs";
import { recoverRunMark, routeQueue } from "./gw/queue.mjs";
import { routeLogin } from "./gw/login.mjs";
import { routeRun } from "./gw/run.mjs";
import { routeOffice } from "./gw/office.mjs";
import { routeLocal } from "./gw/local.mjs";
import { routeUsage } from "./gw/usage.mjs";
import { routeDevside } from "./gw/devside.mjs";
import { routeFeedback } from "./gw/feedback.mjs";
import { migrateHookPause, routeExtensions } from "./gw/extensions.mjs";
import { routeNotices } from "./gw/notices.mjs";
import { routeReconcile } from "./gw/reconcile.mjs";
import { PROJECTS, routeProjects } from "./gw/projects.mjs";
import { routeBookmarks } from "./gw/bookmarks.mjs";
import { routeFonts } from "./gw/fonts.mjs";
import { commandRoutes } from "./gw/commands.mjs";
import { routeUi } from "./gw/uistore.mjs";
import { routeSched } from "./gw/sched.mjs";
import { routeSessModel } from "./gw/sessmodel.mjs";
import { routeLineage } from "./gw/lineage.mjs";
import { routeMerge } from "./gw/merge.mjs";
import { routeProfile } from "./gw/profile.mjs";
import { routeBackfill } from "./gw/backfill.mjs";
import { routeArchive } from "./gw/archive.mjs";
import { installCrashGuard, runShutdown } from "./gw/crashguard.mjs";
import { RUNS } from "./gw/runs.mjs";
import { syncGitSafe } from "./gw/gitsafe.mjs";
import { COOKIE, SESSION, UI_HOST, cookieHostOk, denyLog, denyReason, localAddr, proofFor, tokenOk } from "./gw/access.mjs";
import { startWorkIsland, stopWorkIslandSync } from "./gw/work-island.mjs";

// 各模块的路由函数，按原来分支的先后排；返回 NEXT 表示不归它管
const ROUTES = [routeClaude, routeFeedback, routeUsage, routeCaps, routeProviders, routeSettings, routeProjects, routeBookmarks, routeFonts, commandRoutes(builtinCommands), routeUi, routeSched, routeSessModel, routeBackfill, routeMerge, routeProfile, routeLineage, routeArchive, routeSessions, routeExtensions, routeModels, routeTerminal, routeComponents, routeModules, routeOrphans, routeCustom, routeGit, routeLocal, routeOffice, routeFiles, routePreview, routeBus, routeQueue, routeDevside, routeLogin, routeRun, routeNotices, routeReconcile];

// ── 路由 ──────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // 请求目标畸形（如 "//["）时 new URL 会抛；这一步在鉴权之前，不兜住的话本机任何应用发一个请求就能让网关退出
  let u;
  try {
    if (!String(req.url || "").startsWith("/")) throw new Error("bad target");
    u = new URL(req.url, `http://127.0.0.1:${CFG.port}`);
  } catch {
    req.resume();
    return sendJson(res, 400, { error: "bad request" });
  }
  const p = u.pathname;

  const deny = denyReason(req, u);
  if (deny) {
    // 限流：别的应用能连上来狂刷，别让它把 gateway.log 撑爆
    const now = Date.now();
    if (now - denyLog.at > 10000) {
      log(`拒绝请求 ${req.method} ${p} → ${deny}（host=${req.headers.host || "-"} origin=${req.headers.origin || "-"}）` +
        (denyLog.n ? `；此前 10 秒内另有 ${denyLog.n} 次被拒` : ""));
      denyLog.at = now; denyLog.n = 0;
    } else denyLog.n++;
    req.resume();
    return sendJson(res, deny, { error: deny === 421 ? "bad host" : "forbidden" });
  }
  if (req.socket && req.ccAuthed) req.socket.__cc = 1;      // 带凭据过了鉴权：连接槽快满时不挤它（见 guardSlots）；/ 这类不要凭据的页面不算
  // App 核身份用（见 access.mjs 的 proof）：不要令牌，回的东西没有令牌算不出来
  if (req.method === "GET" && p === "/__proof") {
    const r = proofFor(u, localAddr(req));
    if (!r) return sendJson(res, 400, { error: "bad nonce" });
    res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
    return res.end(r);
  }
  // 宿主 WebView 首次加载首页时带 ?t=令牌：种 Cookie，之后同源请求自动带上
  // cccodroid 里只在界面专用地址上种（见 access.mjs 的 UI_HOST）；App 现在直接用 CookieManager 种，这条留给开发端
  if (req.method === "GET" && (p === "/" || p === "/index.html") && cookieHostOk(req) && tokenOk(u.searchParams.get("t") || "")) {
    res.setHeader("Set-Cookie", `${COOKIE}=${SESSION}; Path=/; HttpOnly; SameSite=Strict`);
  }

  try {
    for (const r of ROUTES) if ((await r(req, res, u, p)) !== NEXT) return;

    if (req.method === "GET") return serveStatic(req, res, p);

    return sendJson(res, 404, { error: "not found" });
  } catch (e) {
    log(`请求处理异常 ${p}: ${e.stack || e.message}`);
    if (!res.headersSent) sendJson(res, 500, { error: String(e.message || e) });
    else res.end();
  }
});

// 最后一道兜底：漏了 catch 的异常 / Promise 拒绝记一笔日志，别让整个网关退出；stdout 断了（孤儿网关）照旧退出（gw/crashguard.mjs）
installCrashGuard();

// ── 启动 ──────────────────────────────────────────────────────────────
try { fs.mkdirSync(CFG.workspace, { recursive: true }); } catch {}
// git 的 safe.directory：只信任登记过的项目目录（共享存储上的仓库属主是系统，不列就被 git 拒绝）；
// 以前一律 * —— 别的应用在共享存储放个恶意仓库就能借 git 执行命令（0.6.9 审计 P1-10，见 gw/gitsafe.mjs）
syncGitSafe(PROJECTS.map((p) => p.path));
try { fs.mkdirSync(CFG.home, { recursive: true }); } catch {}
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch {}
startStreamFix();

// 界面专用地址：同一个处理函数再听一份。听不上（被别的应用抢先占了）App 核身份时会发现不是真网关、不交凭据；
// 这里每 2 秒再试，对方一放手就接回来（核身份绑了监听地址，对方转发到 127.0.0.1 也过不了，见 access.mjs 的 proof）
const uiServer = http.createServer((req, res) => server.emit("request", req, res));
let uiRetryLogged = false;
uiServer.on("error", (e) => {
  if (!uiRetryLogged) log(`⚠️ 界面地址 ${UI_HOST}:${CFG.port} 监听失败：${e.code || e.message}，每 2 秒重试`);
  uiRetryLogged = true;
  setTimeout(() => uiServer.listen(CFG.port, UI_HOST), 2000).unref();
});
uiServer.on("listening", () => { if (uiRetryLogged) log(`界面地址 ${UI_HOST}:${CFG.port} 已接回`); });
// 慢速请求占着连接不放（审查 10-30 第九份 中4）：请求头 20 秒、整个请求 10 分钟内收完（上传走本机回环，够用），
// 同时最多 256 个连接。事件总线是长回应，不受 requestTimeout 管
for (const s of [server, uiServer]) { s.headersTimeout = 20e3; s.requestTimeout = 600e3; s.maxConnections = 256; }
// 槽位快满时先挤掉没过鉴权的：本机任何应用都连得上回环地址，开一堆慢连接占着，App 自己的请求就进不来（审查 v0513b 低-8）。
// 过了鉴权的连接（App、终端里的工具）不动；新来的连接挤掉最早那条还没过鉴权的
function guardSlots(srv) {
  const socks = new Set();
  srv.on("connection", (s) => {
    socks.add(s); s.on("close", () => socks.delete(s));
    if (socks.size > 200) for (const o of socks) if (!o.__cc && o !== s) { o.destroy(); break; }
  });
}
guardSlots(server); guardSlots(uiServer);
// 主地址被占（EADDRINUSE 之类）：记一笔再退出，GatewayService 会重拉；以前没挂监听，直接抛成未捕获异常、日志里什么都没有（审查 v0513b 低-9）
server.on("error", (e) => { log(`⚠️ 主地址 127.0.0.1:${CFG.port} 监听失败：${e.code || e.message}，退出等重拉`); setTimeout(() => process.exit(1), 200); });
server.listen(CFG.port, "127.0.0.1", () => {
  // 上一任留下的运行标记：等所有模块都求值完再收（放在 queue.mjs 顶层会撞循环引用——sessionops 的 SID_RE 还没初始化，带会话的排队消息一恢复网关就崩，11-02 群友日志）。
  // 端口拿到了才收：以前在 listen 之前，旧网关还在跑时重复拉起的这个先改了它的恢复记录，再因 EADDRINUSE 退出（0.6.9 审计 195-T.2）。
  // 'listening' 先于任何连接派发，界面的第一个请求照样看得到恢复出来的队列
  try { recoverRunMark(); } catch (e) { log("恢复上次的运行标记失败：" + (e.stack || e.message)); }
  uiServer.listen(CFG.port, UI_HOST);   // 界面地址也放到恢复之后：别让界面在队列恢复前先连进来
  log(`claude-apk 网关 v3 已启动  http://127.0.0.1:${CFG.port}`);
  log(`  运行时 ${CFG.runtime}`);
  log(`  工作区 ${CFG.workspace}`);
  log(`  前端   ${PATHS.web}  存在=${fs.existsSync(PATHS.web)}`);
  log(`  密钥   ${API_KEY ? "已配置" : "缺失"}`);
  log(`  模型   ${SETTINGS.model}   权限 ${SETTINGS.permissionMode}`);
  if (!fs.existsSync(PATHS.claude)) log(`  ⚠️ 未找到 claude: ${PATHS.claude}`);
  if (!fs.existsSync(PATHS.loader)) log(`  ⚠️ 未找到 glibc loader: ${PATHS.loader}`);
  if (process.env.CCAPP_EXEC === "loader") {
    // 经加载器（targetSdk 36）：APK 里的 ld.so 必须和工具包里的 libc 同版本，不同就是 APK 先升了、工具包还没跟上
    let same = false;
    try { same = fs.readFileSync(PATHS.loader).equals(fs.readFileSync(path.join(PATHS.glibcLib, "ld-linux-aarch64.so.1"))); } catch {}
    log(`  执行方式 经加载器 · ld.so ${same ? "与工具包一致" : "⚠️ 与工具包里的不一致，claude 可能起不来：更新工具包"}`);
  }
  log(`  历史会话 ${listSessions(500).length} 个`);
  try { reapOrphans(); } catch (e) { log("孤儿进程清理失败: " + e.message); }
  try { expireTrash(); } catch (e) { log("回收站清理失败: " + e.message); }
  try { customRefresh(); } catch (e) { log("自定义组件入口重写失败: " + e.message); }
  try { cleanOrphans(); } catch (e) { log("旧工具包残留清理失败: " + e.message); }
  try { startWorkIsland(); } catch (e) { log("工作岛启动失败: " + e.message); }
  migrateHookPause().catch((e) => log("转换 hooks 暂停失败: " + e.message));
});

// 启动后校验一次模型名：不在清单里就落到默认。
// 只对【第三方厂商】做 —— 它们对未知模型名可能静默回落，留着会让人以为切成功了；
// 原生厂商（claude 自己认识模型）与没有清单的厂商一律跳过，别替它改配置。
setTimeout(async () => {
  try {
    if (PROVIDER.nativeModels) return;
    // 清单要拉几秒：这期间用户切了厂商或选了别的型号，结果就作废（不能拿 A 家清单改 B 家的型号，审查 B27）
    const P0 = PROVIDER, m0 = SETTINGS.model;
    const ms = await fetchModels(true, P0);
    if (PROVIDER !== P0 || PROVIDER.id !== P0.id || SETTINGS.model !== m0) return;
    if (!ms.length || !SETTINGS.model) return;
    if (!ms.some((m) => m.id === SETTINGS.model)) {
      const old = SETTINGS.model;
      SETTINGS.model = ms[0].id;
      SETTINGS.effort = normEffort(ms[0], SETTINGS.effort);
      saveSettings();
      log(`⚠️ 模型 "${old}" 不在 [${PROVIDER.id}] 清单里，已改回 ${SETTINGS.model}`);
    }
  } catch (e) { log(`模型校验失败: ${e.message}`); }
}, 2500);

// 工作岛的收起放最后：它要同步调 am（最多 3 秒），App 等 5 秒就强杀，先把 claude 和终端收了
// 正在跑的 claude 一并带走（整个进程组）：以前只收终端，claude 成了孤儿继续写文件、继续计费（0.6.9 审计 P1-3）。
// 中断记录（run mark）是随时落盘的，重启后照常给「继续」卡
const shutdown = (sig) => {
  for (const r of RUNS.values()) if (r.child && !r.ended) { try { killTree(r.child); } catch {} }
  if (sig === "SIGTERM") for (const t of TERMS.values()) if (t.alive) { try { killTree(t.child); } catch {} }
  try { bridgeProc?.kill(); } catch {}
  runShutdown();
  try { stopWorkIslandSync(); } catch {}
  process.exit(0);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
