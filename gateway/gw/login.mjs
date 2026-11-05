import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { CFG, PATHS, log, tz } from "./config.mjs";
import { isLoginMode, noteLoggedIn } from "./models.mjs";
import { claudeArgv, claudeBlocked, claudeEnv } from "./claude.mjs";
import { RUNS } from "./runs.mjs";
import { providerById } from "./providers.mjs";
import { NEXT, readBody, sendJson } from "./http.mjs";
import { toFront } from "./local.mjs";
import { RATE_LIMITS, clearRateLimits } from "./stream.mjs";

// ── 账户登录（OAuth 全程由 claude 自己完成；网关只转递地址，不碰凭据）────────
//
// 两条路，同一个进程：
//   自动：设了 BROWSER，claude 会把一个 redirect_uri=http://localhost:<端口>/callback 的地址
//         交给"浏览器"，自己在那个端口等回调。手机浏览器和 claude 在同一台机器上，
//         授权完浏览器跳回 localhost，claude 直接收到 —— 不用贴码。
//         我们的"浏览器"是个小脚本，只把地址写进文件，由界面交给系统浏览器打开。
//   手动：浏览器回不到 localhost 时（比如在别的设备上授权），页面会显示一个授权码。
//         这个码网关**不经手**：界面打开一个终端跑 claude auth login，用户把码直接贴给 claude 自己的提示
//         （终端只是通用的字节通道，和 Termux / SSH 一样）。以前的 /api/login/code 接收授权码再写进 stdin，
//         条款要求登录走 Anthropic 自己的流程、开发者不得经手凭据，所以拿掉了。
let LOGIN = null;
const LOGIN_DIR = path.join(CFG.home, ".cache", "ccapp-login");

function authEnv() {
  const env = claudeEnv();
  for (const k of ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL"]) delete env[k];
  return env;
}

async function loginStart(flag) {
  const blocked = await claudeBlocked();
  if (blocked) return { ok: false, message: blocked };
  if (LOGIN && LOGIN.child.exitCode === null) try { LOGIN.child.kill("SIGKILL"); } catch {}
  fs.mkdirSync(LOGIN_DIR, { recursive: true });
  const urlFile = path.join(LOGIN_DIR, "url");
  const browser = path.join(LOGIN_DIR, "browser.sh");
  try { fs.unlinkSync(urlFile); } catch {}
  fs.writeFileSync(browser, '#!/system/bin/sh\nprintf "%s\\n" "$1" > "' + urlFile + '"\n', { mode: 0o700 });
  const env = { ...authEnv(), BROWSER: browser };
  const child = spawn(PATHS.claudeLoader, claudeArgv(["auth", "login", flag]), { cwd: CFG.home, env, stdio: ["ignore", "pipe", "pipe"] });
  const L = LOGIN = { child, out: "", startedAt: Date.now(), done: false, ok: false, flag };
  const onData = (d) => { L.out += String(d); };
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");   // 按流解码：多字节字符跨块不会被拆坏
  child.stdout.on("data", onData); child.stderr.on("data", onData);
  // loader 起不来（缺失/无权限/EAGAIN）只发 error：不接会把整个网关带走（#102 04-005）。runAuth 早就接了，这里补上
  child.on("error", (e) => {
    if (L.done) return;
    L.done = true; L.ok = false; L.out += "\n" + (e.code || e.message);
    log("登录：没起来（" + (e.code || e.message) + "）");
  });
  child.on("close", (code) => {
    if (L.done) return;   // error 之后可能还会补一个 close，已经结过账了
    L.done = true;
    L.ok = code === 0 && /success/i.test(L.out);
    log("登录：" + (L.ok ? "成功" : "结束（退出码 " + code + "）"));
    // 浏览器授权完停在 claude 的托管成功页上，用户不知道怎么回来 —— 主动把界面叫回前台
    if (L.ok) toFront("登录成功").then((r) => log("登录：回到前台 → " + (r.via || r.message || "?")));
  });
  log("登录：已启动 claude auth login " + flag);
  return new Promise((resolve) => {
    const tick = setInterval(() => {
      let auto = "";
      try { auto = fs.readFileSync(urlFile, "utf8").trim(); } catch {}
      const manual = (L.out.match(/https:\/\/\S+/) || [""])[0];
      if ((auto && manual) || L.done || Date.now() - L.startedAt > 20000) {
        clearInterval(tick);
        resolve(auto || manual
          ? { ok: true, url: auto || manual, manualUrl: manual, auto: !!auto }
          : { ok: false, message: tz("没拿到登录地址"), output: L.out.slice(-1500) });
      }
    }, 200);
  });
}

/** 登录状态由 claude 自己报（claude auth status），网关不读凭据文件 */
async function runAuth(args, timeoutMs = 20000) {
  const blocked = await claudeBlocked();
  if (blocked) return { code: -1, out: blocked };
  return new Promise((resolve) => {
    const child = spawn(PATHS.claudeLoader, claudeArgv(["auth", ...args]), { cwd: CFG.home, env: authEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let out = "", stdout = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");   // 按流解码：多字节字符跨块不会被拆坏
    child.stdout.on("data", (d) => { out += d; stdout += d; }); child.stderr.on("data", (d) => (out += d));
    const t = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, timeoutMs);
    child.on("close", (code) => { clearTimeout(t); resolve({ code, out, stdout }); });
    child.on("error", (e) => { clearTimeout(t); resolve({ code: -1, out: e.message, stdout: "" }); });
  });
}
export let AUTH_CACHE = null;
let AUTH_GOOD = null;   // 最后一次问出结果的状态
/** 从 claude auth status 的 stdout 里找状态对象：优先「带 boolean loggedIn」的那一段，
 *  并从后往前找 —— 前面夹的 JSON 警告不能被当成 status（审查 11-05）。 */
function statusJson(text) {
  const s = String(text || ""), cands = [];
  const push = (v) => { if (v && typeof v === "object" && !Array.isArray(v)) cands.push(v); };
  try { push(JSON.parse(s.trim())); } catch {}
  for (const line of s.split("\n").reverse()) {
    const t = line.trim();
    if (!t.includes("{")) continue;
    try { push(JSON.parse(t)); } catch {}
  }
  // 兜底：整段里从第一个 { 到后面某个 } 逐个试（状态 JSON 被别的话包住时）
  const at = s.indexOf("{");
  for (let e = s.lastIndexOf("}"), n = 0; at >= 0 && e > at && n < 50; e = s.lastIndexOf("}", e - 1), n++) {
    try { push(JSON.parse(s.slice(at, e + 1))); } catch {}
  }
  return cands.find((x) => typeof x.loggedIn === "boolean") || cands[0] || null;
}
export async function authStatus(force) {
  if (!force && AUTH_CACHE && Date.now() - AUTH_CACHE.at < 30000) return AUTH_CACHE.v;
  const r = await runAuth(["status"]);
  // 状态 JSON 走 stdout；stderr 只用于没解析出 loggedIn 时的「未登录」判断和错误提示
  let j = statusJson(r.stdout) || statusJson(r.out) || {};
  // 只转出界面要显示的几项；令牌之类的东西它本来也不报
  // 问不出结果（claude 起不来、超时、输出解析不了）：不能当成「未登录」—— 有上次问出的就沿用并标明是旧的，
  // 没有就标「不知道」，把原因带给界面（#102 04-010）
  // 退出码是 0 也一样：解析不出 loggedIn 就不算知道（DeepSeek 复核 #2）；只有输出明说没登录才给确定的 false
  if (typeof j.loggedIn !== "boolean" && !/not logged in|not authenticated/i.test(r.out || "")) {
    const error = String(r.out || "").trim().split("\n").pop().slice(0, 300) || "exit " + r.code;
    const v = AUTH_GOOD ? { ...AUTH_GOOD, stale: true, error } : { loggedIn: false, authMethod: "none", email: null, org: null, plan: null, unknown: true, error };
    AUTH_CACHE = { at: Date.now(), v };
    return v;
  }
  const v = {
    loggedIn: !!j.loggedIn, authMethod: j.authMethod || "none",
    email: j.email || j.account?.email || null,
    org: j.orgName || j.organization?.name || null,
    plan: j.subscriptionType || j.plan || null,
  };
  AUTH_CACHE = { at: Date.now(), v }; AUTH_GOOD = v;
  noteLoggedIn(v.loggedIn);
  return v;
}

// ── 路由：/api/login/start /api/login/status /api/login/cancel /api/login/logout ──
export async function routeLogin(req, res, u, p) {
  if (req.method === "POST" && p === "/api/login/start") {
    const b = JSON.parse((await readBody(req)) || "{}");
    return sendJson(res, 200, await loginStart(b.method === "console" ? "--console" : "--claudeai"));
  }
  if (req.method === "GET" && p === "/api/login/status") {
    const st = await authStatus(u.searchParams.get("refresh") === "1" || (LOGIN && LOGIN.done && !LOGIN.reported));
    if (LOGIN && LOGIN.done) LOGIN.reported = true;
    return sendJson(res, 200, {
      ...st,
      pending: !!(LOGIN && !LOGIN.done),
      limits: st.loggedIn && RATE_LIMITS && (!RATE_LIMITS.email || RATE_LIMITS.email === st.email) ? RATE_LIMITS : null,
      last: LOGIN && LOGIN.done ? { ok: LOGIN.ok, output: LOGIN.ok ? "" : LOGIN.out.slice(-800) } : null,
    });
  }
  if (req.method === "POST" && p === "/api/login/cancel") {
    if (LOGIN && !LOGIN.done) try { LOGIN.child.kill("SIGKILL"); } catch {}
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === "POST" && p === "/api/login/logout") {
    // 看每一轮实际用的那家，不只看全局默认：全局是第三方、某个会话单独选了官方账户时也算（审查 B19）
    if ([...RUNS.values()].some((r) => !r.ended && isLoginMode(providerById(r.provider) || undefined))) return sendJson(res, 409, { error: "busy", message: tz("这一轮还在生成，等它跑完再退出登录。") });
    const r = await runAuth(["logout"]);
    AUTH_CACHE = null;
    if (r.code === 0) { noteLoggedIn(false); AUTH_GOOD = null; }
    clearRateLimits();
    return sendJson(res, 200, { ok: r.code === 0, output: r.out.slice(-500) });
  }
  return NEXT;
}
