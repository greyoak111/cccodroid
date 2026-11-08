import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { CFG, GLIBC_PRELOAD, PATHS, PREFIX, glibcEnv, loadPgp, log, tz } from "./config.mjs";
import { verifiedInfo } from "./ccverified.mjs";
import { ledger } from "./claude.mjs";
import { onSealUnknown } from "./claudeseal.mjs";
import { NEXT, readBody, sendJson } from "./http.mjs";
import { termEnv } from "./terminal.mjs";
import { ccMem, privCall } from "./usage.mjs";

// ── 开发端（非 cccodroid 布局）：没有 Java 那一层，更新和 Shizuku 状态由网关自己做 ──────────
// cccodroid 里这些在 App 进程（Updater / ShizukuSetup）；开发端只有一个 runtime/claude 二进制，priv 走 rish。

const DEV_UPD_FILE = path.join(CFG.home, "ccapp-update.json");
const CC_BASE = "https://downloads.claude.ai/claude-code-releases";
const devUpd = {
  auto: true, channel: "stable", lastCheck: 0, checking: false, error: "",
  claude: { id: "claude", name: "Claude Code", current: "", latest: "", state: "unknown", message: "", done: 0, total: 0 },
};
try { Object.assign(devUpd, JSON.parse(fs.readFileSync(DEV_UPD_FILE, "utf8")), { checking: false, error: "" }); devUpd.claude.state = devUpd.claude.state === "installing" ? "unknown" : devUpd.claude.state; } catch {}
const devUpdSave = () => { try { fs.writeFileSync(DEV_UPD_FILE, JSON.stringify(devUpd)); } catch {} };
const cmpVer = (a, b) => {
  const x = String(a).split(/[^0-9]+/).map(Number), y = String(b).split(/[^0-9]+/).map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d < 0 ? -1 : 1; }
  return 0;
};

/** 跑某个 claude 二进制的 --version（新下载的那个在换上去之前先这样试跑一次） */
function claudeVersionOf(bin) {
  return new Promise((ok) => {
    const pre = GLIBC_PRELOAD ? ["--preload", GLIBC_PRELOAD] : [];
    execFile(PATHS.claudeLoader, ["--library-path", PATHS.claudeLib, ...pre, bin, "--version"], { timeout: 30000, env: glibcEnv() }, (e, out) => {
      const m = String(out || "").match(/\d+\.\d+\.\d+/);
      ok(m ? m[0] : "");
    });
  });
}

// 检查途中换了渠道：这次的结果是旧渠道的，不能记到新渠道名下；结束后按新渠道再查一次（#136）
let devUpdAgain = false;
async function devUpdCheck() {
  if (devUpd.checking) { devUpdAgain = true; return; }
  devUpd.checking = true; devUpd.error = "";
  const c = devUpd.claude, ch = devUpd.channel;
  try {
    if (!c.current || c.state !== "installing") c.current = await claudeVersionOf(PATHS.claude);
    const r = await fetch(`${CC_BASE}/${ch}`, { signal: AbortSignal.timeout(20000) });
    const v = (await r.text()).trim();
    if (devUpd.channel !== ch) { devUpdAgain = true; return; }
    if (!/^\d+\.\d+\.\d+/.test(v)) throw new Error(tz("版本号不对：{v}", { v: v.slice(0, 40) }));
    c.latest = v; c.latestCh = ch;
    // 已装版本要和所选渠道「一致」：从 latest 切回 stable 时版本号变小，以前判成「已是最新」就一直停在 latest 上
    if (c.state !== "installing") {
      const d = cmpVer(v, c.current);
      c.state = d === 0 ? "uptodate" : "available";
      c.message = d < 0 && c.current ? `切回 ${devUpd.channel} 渠道：将换成 ${v}（比当前的 ${c.current} 旧）` : devUpd.channel === "latest" ? "latest 渠道" : "";
    }
    devUpd.lastCheck = Date.now();
  } catch (e) { devUpd.error = tz("连不上 downloads.claude.ai：{err}", { err: e.message }); }
  finally {
    devUpd.checking = false; devUpdSave();
    if (devUpdAgain) { devUpdAgain = false; setImmediate(devUpdCheck); }
  }
}

/**
 * 换新版：下到 claude.part（断点续传）→ 按官方清单核 sha256 → 试跑 --version → 旧的改名 claude.prev（留一版可回退）→ 新的换上。
 * 正在跑的 claude 已经映射了旧文件，换名不影响它；下一轮对话起用新版。
 */
async function devUpdInstall() {
  const c = devUpd.claude;
  if (c.state === "installing" || !c.latest) return;
  if (c.latestCh && c.latestCh !== devUpd.channel) return;   // 查到的是换渠道之前那个渠道的版本
  c.state = "installing"; c.message = ""; c.done = 0; c.total = 0;
  const want = c.latest;   // 开装时定死：装的途中换渠道会改 c.latest，清单、程序、试跑核对要是同一个版本（DeepSeek 复核 11-04）
  const part = PATHS.claude + ".part", tag = PATHS.claude + ".part.sha256";
  try {
    // 清单要过 Anthropic 的 PGP 签名（同 install-claude.mjs）：只靠 TLS 的话，装了别的根证书的代理能连清单带程序一起换掉（11-03 审查 L-11）
    const get = async (u) => { const r = await fetch(u, { signal: AbortSignal.timeout(20000) }); if (!r.ok) throw new Error("HTTP " + r.status + " " + u); return Buffer.from(await r.arrayBuffer()); };
    const manBuf = await get(`${CC_BASE}/${want}/manifest.json`);
    const { ANTHROPIC_KEYS, verifyDetached } = await loadPgp();
    try { verifyDetached(manBuf, (await get(`${CC_BASE}/${want}/manifest.json.sig`)).toString("utf8"), ANTHROPIC_KEYS); }
    catch (e) { throw new Error(tz("官方清单的签名验不过：{msg}", { msg: e.message })); }
    const man = JSON.parse(manBuf.toString("utf8"));
    if (man.version && man.version !== want) throw new Error(tz("清单内容不对"));
    const plat = man.platforms && man.platforms["linux-arm64"];
    if (!plat || !/^[a-f0-9]{64}$/.test(plat.checksum)) throw new Error(tz("清单里没有 linux-arm64"));
    c.total = plat.size;
    let have = 0;
    try { if (fs.readFileSync(tag, "utf8").trim() === plat.checksum) have = fs.statSync(part).size; } catch {}
    if (!have) { fs.rmSync(part, { force: true }); fs.writeFileSync(tag, plat.checksum); }
    for (let attempt = 1; have < plat.size; attempt++) {
      try {
        const r = await fetch(`${CC_BASE}/${want}/linux-arm64/claude`, { headers: have ? { range: `bytes=${have}-` } : {} });
        if (r.status !== 200 && r.status !== 206) throw new Error("HTTP " + r.status);
        if (r.status === 200) { have = 0; fs.rmSync(part, { force: true }); }
        const out = fs.openSync(part, "a");
        try { for await (const chunk of r.body) { fs.writeSync(out, chunk); have += chunk.length; c.done = have; } }
        finally { fs.closeSync(out); }
      } catch (e) {
        if (attempt >= 8) throw e;
        c.message = `网络中断（${e.message}），${attempt * 3} 秒后续传…`;
        await new Promise((ok) => setTimeout(ok, attempt * 3000));
        have = fs.existsSync(part) ? fs.statSync(part).size : 0;
      }
    }
    c.message = "校验 sha256…";
    const h = crypto.createHash("sha256");
    for await (const b of fs.createReadStream(part)) h.update(b);
    const got = h.digest("hex");
    if (got !== plat.checksum) { fs.rmSync(part, { force: true }); throw new Error(tz("sha256 不符（期望 {want}…，实得 {got}…）", { want: plat.checksum.slice(0, 12), got: got.slice(0, 12) })); }
    fs.chmodSync(part, 0o755);
    const v = await claudeVersionOf(part);
    if (v !== want) throw new Error(tz("新版试跑失败（--version 得到「{v}」）", { v }));
    fs.rmSync(PATHS.claude + ".prev", { force: true });
    fs.renameSync(PATHS.claude, PATHS.claude + ".prev");
    fs.renameSync(part, PATHS.claude);
    fs.rmSync(tag, { force: true });
    log(`Claude Code 已更新 ${c.current} → ${v}`);
    c.current = v; c.state = "uptodate"; c.message = `已更新到 ${v}（下一轮对话起生效；旧版留在 claude.prev）`;
  } catch (e) {
    c.state = "error"; c.message = e.message;
  } finally { devUpdSave(); }
}

function devUpdStatus() {
  const { claude, ...rest } = devUpd;
  return { ok: true, ...rest, items: [claude] };
}

// 自动：启动 1 分钟后、之后每 30 分钟看一眼，距上次检查超过 6 小时就查；有新版且开着自动就装
if (!PREFIX) {
  const tick = async () => {
    if (!devUpd.auto || Date.now() - devUpd.lastCheck < 6 * 3600_000) return;
    await devUpdCheck();
    if (devUpd.auto && devUpd.claude.state === "available") devUpdInstall();
  };
  setTimeout(tick, 60_000);
  setInterval(tick, 30 * 60_000);
}

// cccodroid：Claude Code 若是官方清单拿不到时靠 npm 签名装上的（版本目录里有 .npm-only），或者版本目录里还没存签过名的清单
// （0.6.3 以前装的；网关每轮起 claude 前靠它核程序，见 claudeseal.mjs），连得上官方清单时补核一次 sha256、存下清单
// （install-claude.mjs --recheck）。启动 2 分钟后、之后每 6 小时看一眼
if (PREFIX && process.env.CCAPP_BIN) {
  const dest = path.join(CFG.home, ".local", "share", "cccodroid", "claude");
  const script = path.join(process.env.CCAPP_BIN, "..", "scripts", "install-claude.mjs");
  const recheck = () => {
    let pending = false;
    try { pending = fs.readdirSync(dest).some((d) => /^\d/.test(d) && fs.existsSync(path.join(dest, d, "claude")) && (fs.existsSync(path.join(dest, d, ".npm-only")) || fs.existsSync(path.join(dest, d, ".mismatch")) || !fs.existsSync(path.join(dest, d, "manifest.json.sig")))); } catch {}
    if (!pending || !fs.existsSync(script)) return;
    execFile(path.join(PREFIX, "bin", "node"), [script, "--recheck"], { env: termEnv(), timeout: 600000 }, (e, out) => {
      const msg = String(out || "").trim();
      if (msg) log("[claude 补核] " + msg.replace(/\n/g, "；"));
      if (e && e.code === 3) ledger("verify", false, "Claude Code 与官方清单不符（npm 来源）", msg);
      else if (/^✓/m.test(msg)) ledger("verify", true, "Claude Code 已按官方清单补核", msg);
    });
  };
  setTimeout(recheck, 120_000);
  setInterval(recheck, 6 * 3600_000);
  // 起 claude 前发现版本目录里没有签名清单（claudeseal.mjs）：别等 6 小时。发行版补核拿到清单之前不起，用户在等，一分钟内最多补核一次
  let lastAsk = 0;
  onSealUnknown(() => { if (Date.now() - lastAsk < 60_000) return; lastAsk = Date.now(); setTimeout(recheck, 1000); });
}

/** 开发端的 priv 状态：真跑一次 priv 'id -u'（rish → Shizuku），拿到 2000/0 才算就绪 */
export function devPrivStatus() {
  return new Promise((ok) => {
    execFile("priv", ["id -u"], { timeout: 8000, env: process.env }, (e, out, err) => {
      const uid = String(out || "").trim();
      if (uid === "2000" || uid === "0") return ok({ state: "ok", installed: true, running: true, granted: true, uid: +uid, wireless: false, paired: true, dev: true });
      const msg = String(err || out || (e && e.message) || "").trim();
      ok({ state: /not running|binder|没在运行|isn't running/i.test(msg) ? "not_running" : "no_permission", installed: true, running: false, granted: false,
        wireless: false, paired: true, dev: true, message: msg.slice(0, 200) });
    });
  });
}

async function devApp(op, b) {
  if (op === "upd_status") {
    if (!devUpd.lastCheck && !devUpd.checking) devUpdCheck();
    else if (!devUpd.claude.current) devUpd.claude.current = await claudeVersionOf(PATHS.claude);
    return devUpdStatus();
  }
  if (op === "upd_check") { devUpdCheck(); await new Promise((r) => setTimeout(r, 200)); return devUpdStatus(); }
  if (op === "upd_set") {
    if (b.channel === "pinned") return { ok: false, message: tz("开发端不支持固定版本（只跟随 stable / latest）") };
    if (typeof b.auto === "boolean") devUpd.auto = b.auto;
    // 换渠道 = 明说要那个渠道的版本：查完对不上就直接换（自动更新关着也换）
    if ((b.channel === "stable" || b.channel === "latest") && b.channel !== devUpd.channel) {
      const want = devUpd.channel = b.channel, c = devUpd.claude;
      // 等到按新渠道查完再换：旧渠道的检查可能还在途，它的结果不算（#136）
      (async () => {
        for (let i = 0; i < 30 && c.latestCh !== want && devUpd.channel === want; i++) {
          await devUpdCheck();
          if (c.latestCh !== want) await new Promise((r) => setTimeout(r, 1000));
        }
        if (devUpd.channel === want && c.latestCh === want && c.state === "available") devUpdInstall();
      })().catch(() => {});
    }
    devUpdSave();
    return devUpdStatus();
  }
  if (op === "upd_apply") {
    if (b.item !== "claude") return { ok: false, message: tz("开发端只管 Claude Code（应用本体由你在本机构建安装）") };
    if (devUpd.claude.state !== "available" && devUpd.claude.state !== "error") return { ok: false, message: tz("没有可装的新版，先检查更新") };
    devUpdInstall();
    return { ok: true, message: tz("开始更新 Claude Code") };
  }
  return { ok: false, message: tz("开发端不支持：{op}", { op }) };
}

// ── Claude Code 版本选单：有哪些版本 + 官方 stable / latest 各是哪一版 ─────────────────────────
// 版本列表取 npm 镜像（Anthropic 每一版都发到 npm）；stable / latest 以官方为准（含 cccodroid.net 对官方的镜像），
// 官方和两个镜像都取不到时留空，不拿 npm 的 dist-tags 顶（两边是否始终同步没核实过）。
// 装哪一版都由 install-claude.mjs 按官方清单 / PGP / npm 签名把关
let ccVersions = { at: 0, data: null };
async function claudeVersions(force) {
  if (!force && ccVersions.data && Date.now() - ccVersions.at < 600e3) return ccVersions.data;
  const get = async (u, ms = 12000) => { const r = await fetch(u, { signal: AbortSignal.timeout(ms), headers: { Accept: "application/vnd.npm.install-v1+json" } }); if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); };
  const channel = async (ch) => {
    for (const b of ["https://downloads.claude.ai/claude-code-releases", "https://cccodroid.net/claude-code", "https://dl.cccodroid.net/claude-code"]) {
      try { const v = (await get(`${b}/${ch}`, 8000)).trim(); if (/^\d+\.\d+\.\d+/.test(v)) return v; } catch {}
    }
    return "";
  };
  let versions = [], err = "";
  for (const reg of ["https://registry.npmmirror.com", "https://registry.npmjs.org"]) {
    try {
      const j = JSON.parse(await get(`${reg}/@anthropic-ai%2fclaude-code-linux-arm64`, 20000));
      versions = Object.keys(j.versions || {}).filter((v) => /^\d+\.\d+\.\d+$/.test(v));
      if (versions.length) break;
    } catch (e) { err = e.message; }
  }
  versions.sort((a, b) => cmpVer(b, a));
  const [stable, latest] = await Promise.all([channel("stable"), channel("latest")]);
  const data = { ok: versions.length > 0 || !!stable, versions, stable, latest, message: versions.length ? "" : tz("取不到版本列表：{err}", { err }) };
  if (data.ok) ccVersions = { at: Date.now(), data };
  return data;
}

// /api/app/* 各操作收哪些字段（对照 Priv.java、Updater.set、Notify.set、DeviceTools.set）
const APP_FIELDS = {
  upd_apply: { item: "string", version: "string" },
  upd_set: { auto: "boolean", channel: "string", version: "string", flavor: "string" },
  upd_verify: { full: "boolean" }, upd_repair: { full: "boolean" },
  share_file: { path: "string", mime: "string" },
  shz_pair: { code: "string" }, shz_autostart: { enable: "boolean" },
  notify_set: { done: "boolean", ask: "boolean" },
  dev_set: { on: "boolean", tool: "string", enabled: "boolean", a11y: "string", idle: "number" },
};

// ── 路由：/api/mem/status /api/mem/clear /api/priv/status /api/priv/request /api/priv/open /api/priv/audit /api/priv/keepalive /api/app/ ──
export async function routeDevside(req, res, u, p) {
  if (req.method === "GET" && p === "/api/claude/versions") {
    const [vs, vi] = await Promise.all([claudeVersions(u.searchParams.get("refresh") === "1"), verifiedInfo((u.searchParams.get("lang") || "zh").startsWith("zh") ? "zh" : "en")]);
    return sendJson(res, 200, { ...vs, ...vi });
  }
  if (req.method === "GET" && p === "/api/mem/status") return sendJson(res, 200, await ccMem(["status", "--json"]));
  if (req.method === "POST" && p === "/api/mem/clear") {
    const b = JSON.parse((await readBody(req)) || "{}");
    return sendJson(res, 200, await ccMem(["clear", "--json", ...(b.hard ? ["--hard"] : []), ...(b.dryRun ? ["--dry-run"] : [])]));
  }
  if (req.method === "GET" && p === "/api/priv/status") return sendJson(res, 200, await privCall({ op: "status" }));
  if (req.method === "POST" && p === "/api/priv/request") return sendJson(res, 200, await privCall({ op: "request" }));
  if (req.method === "POST" && p === "/api/priv/open") return sendJson(res, 200, await privCall({ op: "open_manager" }));
  // 特权命令记录：cccodroid 的 Priv.java 每执行一条就往 home/priv-audit.jsonl 记一行。最新的在前
  if (req.method === "GET" && p === "/api/priv/audit") {
    const f = path.join(CFG.home, "priv-audit.jsonl"), items = [];
    for (const ff of [f, f + ".1"]) {
      let txt = ""; try { txt = fs.readFileSync(ff, "utf8"); } catch {}
      for (const l of txt.split("\n").reverse()) { if (items.length >= 300) break; try { if (l) items.push(JSON.parse(l)); } catch {} }
      if (items.length >= 300) break;
    }
    return sendJson(res, 200, { ok: true, supported: !!PREFIX, items });
  }
  if (req.method === "POST" && p === "/api/priv/noask") {
    let b; try { b = JSON.parse((await readBody(req)) || "{}"); } catch { return sendJson(res, 400, { error: "bad json" }); }
    // 时长只认固定几档（应用侧同样只认这几档，别的按 24 小时），最长一周（11-08 用户定）
    const hours = [1, 4, 24, 72, 168].includes(+b.hours) ? +b.hours : 24;
    return sendJson(res, 200, await privCall({ op: "noask", enable: b.enable === true, hours }, 90000));
  }
  if (req.method === "POST" && p === "/api/priv/keepalive") {
    const b = JSON.parse((await readBody(req)) || "{}");
    return sendJson(res, 200, await privCall({ op: "keepalive", enable: b.enable !== false }, 60000));
  }
  // 更新（APK / 工具包 / Claude Code）与 Shizuku 一键安装激活：都在应用进程里做，这里只转话
  if (p.startsWith("/api/app/")) {
    const op = p.slice(9);
    const OPS = ["upd_status", "upd_check", "upd_apply", "upd_set", "upd_verify", "upd_repair", "share_logs", "factory_reset", "share_file", "shz_install", "shz_activate", "shz_pair", "shz_autostart", "shz_repair", "open_app_settings", "freeze_ack", "notify_status", "notify_set", "notify_settings", "dev_status", "dev_set", "a11y_settings"];
    if (!OPS.includes(op)) return sendJson(res, 404, { ok: false, message: tz("未知操作") });
    const raw = req.method === "POST" ? JSON.parse((await readBody(req)) || "{}") : {};
    // 只转各操作认的字段、认的类型：应用那头也逐项校验，这里再挡一道（11-01 独立审查低-3）
    const b = {};
    for (const [k, ty] of Object.entries(APP_FIELDS[op] || {})) {
      const v = raw && raw[k];
      if (v === undefined) continue;
      if (typeof v !== ty || (ty === "string" && v.length > 4096) || (ty === "number" && !Number.isFinite(v))) return sendJson(res, 400, { ok: false, message: tz("请求参数不对") });
      b[k] = v;
    }
    if (!PREFIX) return sendJson(res, 200, await devApp(op, b));
    // 激活 / 打开自动激活要等用户在原生对话框里点（最多 60 秒），和 keepalive 一样放长
    return sendJson(res, 200, await privCall({ ...b, op }, op === "shz_activate" || op === "shz_autostart" ? 65000 : undefined));
  }
  return NEXT;
}
