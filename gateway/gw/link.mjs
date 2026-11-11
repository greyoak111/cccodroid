import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { CFG, HERE, log } from "./config.mjs";
import { TOKEN } from "./access.mjs";
import { NEXT, readBodyBuf, sendJson } from "./http.mjs";

// ── 设备互联客户端 / linkd 守护 ───────────────────────────────────────
// linkd 是随 APK 安装在 files/app/link 的独立 Node 服务：
//   · 9377 只给本机界面和网关用，鉴权沿用网关令牌
//   · 9378 给已配对设备同步会话
//   · 9379/UDP 只负责局域网发现
// 网关只负责把它拉起来、提供管理页地址，并在 @ 设备轮次里转发插话 / 产物请求。

export const LINK_API = process.env.CCAPP_LINKD || "http://127.0.0.1:9377";
const LINK_SCRIPT = path.join(HERE, "link", "linkd.mjs");
const REMOTE_MCP = path.join(HERE, "link", "remote-mcp.mjs");
const LINK_UI = path.join(HERE, "link", "ui.html");
const TOKEN_FILE = path.join(CFG.home, ".gateway-token");
const LINK_PROXY = "/api/link/proxy/";

let linkChild = null;
let linkActive = false;
let linkTimer = null;
let linkStarting = null;

function timeout(ms) {
  return AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined;
}

async function healthy(ms = 1500) {
  try {
    const r = await fetch(LINK_API + "/api/health", { signal: timeout(ms) });
    if (!r.ok) return false;
    const j = await r.json().catch(() => null);
    return !!(j && j.ok && Number(j.v) === 1);
  } catch {
    return false;
  }
}

function relayLine(kind, buf) {
  const s = String(buf || "").trim();
  if (s) for (const line of s.split(/\r?\n/)) log(`[${kind}] ${line}`.slice(0, 4000));
}

/** 拉起 linkd；已经有一个健康的实例（例如网关被 SIGKILL 后重启）就直接复用。 */
export async function ensureLinkd() {
  if (await healthy()) return { ok: true, adopted: linkChild == null };
  if (linkStarting) return linkStarting;
  if (!fs.existsSync(LINK_SCRIPT)) throw new Error(`找不到互联服务：${LINK_SCRIPT}`);
  linkStarting = (async () => {
    if (linkChild && linkChild.exitCode == null) return { ok: true };
    const args = [
      LINK_SCRIPT,
      "--home", CFG.home,
      "--workspace", CFG.workspace,
      "--gateway-port", String(CFG.port),
      "--local-port", "9377",
      "--lan-port", "9378",
      "--udp-port", "9379",
    ];
    const child = spawn(process.execPath, args, {
      cwd: CFG.home,
      env: { ...process.env, CCAPP_LINKD: LINK_API },
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });
    linkChild = child;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d) => relayLine("link", d));
    child.stderr?.on("data", (d) => relayLine("link!", d));
    child.on("error", (e) => log(`互联服务进程错误：${e.message}`));
    child.on("exit", (code, signal) => {
      if (linkChild === child) linkChild = null;
      if (linkActive) log(`互联服务退出 code=${code ?? "-"} signal=${signal || "-"}`);
    });
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 200));
      if (await healthy(600)) return { ok: true };
      if (child.exitCode != null) break;
    }
    throw new Error("互联服务没有在 9377 端口就绪，请查看 gateway.log / link.log");
  })().finally(() => { linkStarting = null; });
  return linkStarting;
}

/** 网关启动后调用：先立即拉一次，之后每 10 秒补拉；退出中的网关不会反复拉起。 */
export function startLinkdSupervisor() {
  if (linkActive) return;
  linkActive = true;
  const tick = () => { if (linkActive) ensureLinkd().catch((e) => log(`互联服务：${e.message}`)); };
  tick();
  linkTimer = setInterval(tick, 10000);
  linkTimer.unref?.();
}

/** 网关正常退出时停掉实例；SIGKILL 留下的实例会被下一任网关复用。 */
export async function stopLinkd() {
  linkActive = false;
  if (linkTimer) { clearInterval(linkTimer); linkTimer = null; }
  const child = linkChild;
  linkChild = null;
  if (child && child.exitCode == null) { try { child.kill("SIGTERM"); } catch {} }
  await fetch(LINK_API + "/api/shutdown", {
    method: "POST",
    headers: { "x-link-token": TOKEN, "content-type": "application/json" },
    body: "{}",
    signal: timeout(1200),
  }).catch(() => {});
}

async function call(p, opts = {}, ms = 20000) {
  const r = await fetch(LINK_API + p, {
    ...opts,
    headers: {
      "x-link-token": TOKEN,
      "content-type": "application/json",
      ...(opts.headers || {}),
    },
    signal: timeout(ms),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(j.message || j.error || `linkd HTTP ${r.status}`);
    e.status = r.status;
    e.body = j;
    throw e;
  }
  return j;
}

export function linkGet(p, ms = 20000) { return call(p, { method: "GET" }, ms); }
export function linkPost(p, body, ms = 20000) {
  return call(p, { method: "POST", body: JSON.stringify(body || {}) }, ms);
}

/** 插话：投给正在对端执行的那一轮。 */
export function linkInject(taskId, text) {
  return linkPost("/api/remote/inject", { id: taskId, text }, 20000);
}

/** 本机缺的工作区产物，按相对路径向正在执行的局域网对端取一份。 */
export function linkFetchArtifact(p, ms = 15000) {
  return linkPost("/api/remote/fetch", { path: p }, ms);
}

/** 每次起 Claude 时随 --mcp-config 注入；不改用户自己的 .claude.json。 */
export function remoteMcpServer() {
  if (!fs.existsSync(REMOTE_MCP)) return null;
  return {
    type: "stdio",
    command: process.execPath,
    args: [REMOTE_MCP],
    env: {
      CCAPP_LINKD: LINK_API,
      CCAPP_GW_TOKEN_FILE: TOKEN_FILE,
    },
  };
}

/** linkd 的管理页跟主界面一起走同源代理，避免 Android WebView 的跨端口令牌 / Cookie 差异。 */
export function linkUiHtml() {
  return fs.readFileSync(LINK_UI, "utf8").replaceAll('"/api/', `"${LINK_PROXY}`);
}

async function proxyLink(req, res, p) {
  const sub = p.slice(LINK_PROXY.length).replace(/^\/+/, "");
  if (!sub) return sendJson(res, 400, { error: "bad link path" });
  const q = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  const body = req.method === "GET" || req.method === "HEAD"
    ? undefined
    : await readBodyBuf(req, 128 * 1024);
  const r = await fetch(LINK_API + "/api/" + sub + q, {
    method: req.method,
    headers: {
      "x-link-token": TOKEN,
      "content-type": String(req.headers["content-type"] || "application/json"),
    },
    body,
    signal: timeout(20000),
  });
  const data = Buffer.from(await r.arrayBuffer());
  res.writeHead(r.status, {
    "content-type": r.headers.get("content-type") || "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": data.length,
  });
  res.end(data);
}

export async function routeLink(req, res, u, p) {
  if (req.method === "GET" && p === "/api/link/ui") {
    try {
      const data = Buffer.from(linkUiHtml());
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-length": data.length,
      });
      return res.end(data);
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }
  if ((req.method === "GET" || req.method === "POST") && p.startsWith(LINK_PROXY)) {
    try {
      return await proxyLink(req, res, p);
    } catch (e) {
      return sendJson(res, e.status || 502, { error: e.message || "link proxy failed" });
    }
  }
  if (req.method === "GET" && p === "/api/link/origins") {
    try {
      const j = await linkGet("/api/origins", 5000);
      return sendJson(res, 200, j);
    } catch {
      return sendJson(res, 200, { ok: false, origins: {} });
    }
  }
  if (req.method === "GET" && p === "/api/link/status") {
    const up = await healthy();
    if (!up) return sendJson(res, 200, { ok: true, running: false });
    try {
      const s = await linkGet("/api/status", 4000);
      return sendJson(res, 200, {
        ok: true, running: true,
        device: s.device || null,
        lan: s.lan || null,
        relay: s.relay || null,
        peers: s.peers || [],
      });
    } catch (e) {
      return sendJson(res, 200, { ok: true, running: false, error: e.message });
    }
  }
  if (req.method === "GET" && p === "/api/link/url") {
    try {
      await ensureLinkd();
      return sendJson(res, 200, {
        ok: true,
        url: LINK_API + "/?t=" + encodeURIComponent(TOKEN),
        embed: "/api/link/ui",
      });
    } catch (e) {
      return sendJson(res, 503, { ok: false, error: e.message });
    }
  }
  if (req.method === "POST" && p === "/api/link/restart") {
    try {
      await linkPost("/api/shutdown", {}, 2000).catch(() => {});
      linkChild = null;
      await new Promise((r) => setTimeout(r, 500));
      await ensureLinkd();
      return sendJson(res, 200, { ok: true });
    } catch (e) {
      return sendJson(res, 503, { ok: false, error: e.message });
    }
  }
  return NEXT;
}
