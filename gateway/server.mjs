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
import { routeCaps } from "./gw/caps.mjs";
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
import { routeQueue } from "./gw/queue.mjs";
import { routeLogin } from "./gw/login.mjs";
import { routeRun } from "./gw/run.mjs";
import { routeOffice } from "./gw/office.mjs";
import { routeLocal } from "./gw/local.mjs";
import { routeUsage } from "./gw/usage.mjs";
import { routeDevside } from "./gw/devside.mjs";
import { routeFeedback } from "./gw/feedback.mjs";
import { routeExtensions } from "./gw/extensions.mjs";
import { routeNotices } from "./gw/notices.mjs";
import { routeReconcile } from "./gw/reconcile.mjs";
import { routeProjects } from "./gw/projects.mjs";
import { routeBookmarks } from "./gw/bookmarks.mjs";
import { routeSched } from "./gw/sched.mjs";
import { routeSessModel } from "./gw/sessmodel.mjs";
import { routeLineage } from "./gw/lineage.mjs";
import { routeBackfill } from "./gw/backfill.mjs";
import { routeArchive } from "./gw/archive.mjs";
import { COOKIE, TOKEN, denyLog, denyReason, tokenOk } from "./gw/access.mjs";
import { startWorkIsland, stopWorkIslandSync } from "./gw/work-island.mjs";

// 各模块的路由函数，按原来分支的先后排；返回 NEXT 表示不归它管
const ROUTES = [routeClaude, routeFeedback, routeUsage, routeCaps, routeProviders, routeSettings, routeProjects, routeBookmarks, routeSched, routeSessModel, routeBackfill, routeLineage, routeArchive, routeSessions, routeExtensions, routeModels, routeTerminal, routeComponents, routeModules, routeOrphans, routeCustom, routeGit, routeLocal, routeOffice, routeFiles, routePreview, routeBus, routeQueue, routeDevside, routeLogin, routeRun, routeNotices, routeReconcile];

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
  // 宿主 WebView 首次加载首页时带 ?t=令牌：种 Cookie，之后同源请求自动带上
  if (req.method === "GET" && (p === "/" || p === "/index.html") && tokenOk(u.searchParams.get("t") || "")) {
    res.setHeader("Set-Cookie", `${COOKIE}=${TOKEN}; Path=/; HttpOnly; SameSite=Strict`);
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

// 最后一道兜底：哪个异步分支漏了 catch，记一笔日志，别让整个网关退出。
// 不接 uncaughtException：孤儿网关往断掉的 stdout 写日志时靠 EPIPE 异常退出，接住了它就死不掉
process.on("unhandledRejection", (e) => log(`未处理的 Promise 拒绝: ${(e && e.stack) || e}`));

// ── 启动 ──────────────────────────────────────────────────────────────
try { fs.mkdirSync(CFG.workspace, { recursive: true }); } catch {}
// /sdcard 上的文件属主是系统（media_rw），git 会以 "dubious ownership" 拒绝操作那里的仓库。
// 只对前缀布局（cccodroid 自己的 HOME）做，不碰别人的 git 配置。
if (PREFIX) {
  try {
    const gc = path.join(CFG.home, ".gitconfig");
    const cur = fs.existsSync(gc) ? fs.readFileSync(gc, "utf8") : "";
    if (!/directory\s*=\s*\*/.test(cur)) fs.appendFileSync(gc, "[safe]\n\tdirectory = *\n");
  } catch {}
}
try { fs.mkdirSync(CFG.home, { recursive: true }); } catch {}
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch {}
startStreamFix();

server.listen(CFG.port, "127.0.0.1", () => {
  log(`claude-apk 网关 v3 已启动  http://127.0.0.1:${CFG.port}`);
  log(`  运行时 ${CFG.runtime}`);
  log(`  工作区 ${CFG.workspace}`);
  log(`  前端   ${PATHS.web}  存在=${fs.existsSync(PATHS.web)}`);
  log(`  密钥   ${API_KEY ? "已配置 (" + API_KEY.slice(0, 6) + "…)" : "缺失"}`);
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
});

// 启动后校验一次模型名：不在清单里就落到默认。
// 只对【第三方厂商】做 —— 它们对未知模型名可能静默回落，留着会让人以为切成功了；
// 原生厂商（claude 自己认识模型）与没有清单的厂商一律跳过，别替它改配置。
setTimeout(async () => {
  try {
    if (PROVIDER.nativeModels) return;
    const ms = await fetchModels(true);
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
process.on("SIGTERM", () => { for (const t of TERMS.values()) if (t.alive) killTree(t.child); try { bridgeProc?.kill(); } catch {} try { stopWorkIslandSync(); } catch {} process.exit(0); });
process.on("SIGINT", () => { try { bridgeProc?.kill(); } catch {} try { stopWorkIslandSync(); } catch {} process.exit(0); });
