#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
//  linkd —— cccodroid 设备互联（手机 ↔ 电脑）
//
//  一个不依赖第三方包的小服务，跑在 cccodroid 旁边：
//    · 9377 本机：管理页面 + 接口（用网关的令牌鉴权）
//    · 9378 局域网：和已配对的设备交换会话（每个设备一份密钥）
//    · 9379 UDP：广播发现（只在开启互联时）
//
//  配对：一台显示 6 位码，另一台输入；双方各存一份 32 字节密钥。
//  同步：按会话号对齐 transcript，哪边新用哪边；被覆盖的一方先留备份。
//  不删对端的东西，不同步回收站，不碰正在写的会话，超过上限的大会话跳过。
//
//  用法：
//    node linkd.mjs --home <数据目录> --workspace <工作区> \
//      --gateway-port 8791 [--local-port 9377] [--lan-port 9378] [--udp-port 9379] [--name 手机]
// ─────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import dgram from "node:dgram";
import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  SID_RE, makePaths, realWorkspace, SessionIndex, trashIds, packSession, unpackSession,
  unpackArtifacts, collectArtifacts,
  zipRead, normalizedHash, makeCwdMapper, makePathMap, mapPathString, mapPathsDeep,
  listAllBackups, listBackups, restoreBackup,
  readJson, writeJson, statSafe, ensureDir, projectSlug, detectSessionPlatform, findSessionFile,
} from "./core.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERSION = 1;
// 本机是哪一类设备：安卓 → 手机，其余（Windows 桌面 / 测试用的 Linux）→ 电脑
const SELF_KIND = process.platform === "android" ? "phone" : "pc";

/** 对端自报的 process.platform → 设备类别 */
function kindOfPlatform(p) {
  const s = String(p || "").toLowerCase();
  if (s === "android") return "phone";
  if (s === "win32" || s === "windows" || s === "darwin" || s === "macos" || s === "linux") return "pc";
  return "";
}
/** transcript 环境块里的 Platform 值 → 设备类别。
 *  安卓上的 Claude Code 报的是 linux；这对设备里只有安卓会报 linux，
 *  所以在安卓和 Windows 上看到 linux 都算手机（Linux 桌面本身仍按电脑算）。 */
function kindFromEnv(plat) {
  const s = String(plat || "").toLowerCase();
  if (s === "android") return "phone";
  if (s === "linux") return process.platform === "android" || process.platform === "win32" ? "phone" : "pc";
  if (s === "win32" || s === "windows" || s === "darwin" || s === "macos") return "pc";
  return "";
}
const SKEW = 2000;                 // 两台设备的时钟差在这个范围内，按内容判断
const ALIVE_MS = 30000;            // 最近一次见到对端的时间
const DISCOVER_MS = 20000;

function arg(name, def) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
function toPort(v, def) {
  const n = Number(v);
  return Number.isInteger(n) && n > 1024 && n < 65536 ? n : def;
}

const HOME = path.resolve(arg("home", process.env.CCAPP_HOME || process.env.HOME || process.cwd()));
const WORKSPACE = path.resolve(arg("workspace", process.env.CCAPP_WORKSPACE || path.join(HOME, "workspace")));
const GATEWAY_PORT = toPort(arg("gateway-port", process.env.CCAPP_PORT), 8791);
const LOCAL_PORT = toPort(arg("local-port", process.env.CCAPP_LINK_PORT), 9377);
const LAN_PORT = toPort(arg("lan-port", process.env.CCAPP_LINK_LAN_PORT), 9378);
const UDP_PORT = toPort(arg("udp-port", process.env.CCAPP_LINK_UDP_PORT), 9379);
const PATHS = makePaths(HOME, WORKSPACE);
const START_AT = Date.now();

function defaultName() {
  const given = String(arg("name", "") || "").trim();
  if (given) return given.slice(0, 60);
  try {
    if (process.platform === "android") {
      const model = execFileSync("getprop", ["ro.product.model"], { timeout: 1500, encoding: "utf8" }).trim();
      if (model) return model.slice(0, 60);
    }
  } catch {}
  return (os.hostname() || "设备").slice(0, 60);
}

function log(...a) {
  const line = `[${new Date().toISOString().replace("T", " ").slice(0, 19)}] ${a.join(" ")}`;
  console.log(line);
  try { ensureDir(HOME); fs.appendFileSync(PATHS.log, line + "\n"); } catch {}
}

// ── 状态 ──────────────────────────────────────────────────────────────
const DEFAULTS = {
  v: 1, deviceId: "", deviceName: "",
  lan: { enabled: false },
  settings: { autoSync: true, interval: 15000, maxMB: 64, activeSec: 30, artifactMB: 24 },
  peers: [], ledger: {}, conflicts: [], pairing: null,
  origins: {},            // 会话号 → { kind:"phone"|"pc", name, dev, platform, at }
  historyRev: 0, historyAt: 0,   // 会话/名称/置顶写入本机的时间线代次；界面丢事件时靠它补拉
  // 公网中转：设备只向它出站，不需要公网 IP；url/token 由用户填
  relay: { enabled: false, url: "", token: "", name: "公网中转", id: "", lastSeen: 0, lastSync: 0, lastError: "", lastResult: null, trashSig: "" },
  // 远程执行：本机默认只在本机跑。enabled 打开后才接受别的设备的任务；
  // allow 按来源设备 id 放行（"auto" = 直接跑）。任务内容 / 输出都记在 remote/ 目录。
  remote: { enabled: false, allow: {}, maxRunning: 1, relayDevices: [] },
};
let state = { ...DEFAULTS, ...readJson(PATHS.state, {}) };
state.lan = { ...DEFAULTS.lan, ...(state.lan || {}) };
state.settings = { ...DEFAULTS.settings, ...(state.settings || {}) };
state.peers = Array.isArray(state.peers) ? state.peers : [];
state.ledger = state.ledger && typeof state.ledger === "object" ? state.ledger : {};
state.conflicts = Array.isArray(state.conflicts) ? state.conflicts : [];
state.origins = state.origins && typeof state.origins === "object" ? state.origins : {};
state.historyRev = Math.max(0, Number(state.historyRev) || 0);
state.historyAt = Math.max(0, Number(state.historyAt) || 0);
state.relay = { ...DEFAULTS.relay, ...(state.relay || {}) };
state.relay.enabled = !!state.relay.enabled;
state.relay.url = String(state.relay.url || "").trim();
state.relay.token = String(state.relay.token || "").trim();
state.relay.name = String(state.relay.name || "公网中转").slice(0, 60);
state.remote = { ...DEFAULTS.remote, ...(state.remote || {}) };
state.remote.enabled = !!state.remote.enabled;
state.remote.allow = state.remote.allow && typeof state.remote.allow === "object" ? state.remote.allow : {};
state.remote.maxRunning = Math.max(1, Math.min(4, Number(state.remote.maxRunning) || 1));
state.remote.relayDevices = Array.isArray(state.remote.relayDevices) ? state.remote.relayDevices : [];
if (!/^[A-Za-z0-9._-]{8,64}$/.test(String(state.deviceId || ""))) state.deviceId = crypto.randomUUID();
if (!state.deviceName) state.deviceName = defaultName();
state.settings.interval = Math.max(10000, Math.min(600000, Number(state.settings.interval) || 30000));
state.settings.maxMB = Math.max(1, Math.min(256, Number(state.settings.maxMB) || 64));
state.settings.activeSec = Math.max(30, Math.min(3600, Number(state.settings.activeSec) || 180));
// 0 = 不随会话同步工作区文件；上限以内按修改时间从新到旧挑
state.settings.artifactMB = Number.isFinite(Number(state.settings.artifactMB))
  ? Math.max(0, Math.min(256, Number(state.settings.artifactMB)))
  : 24;

let saveTimer = null;
function saveSoon(ms = 300) {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, ms);
}
function saveNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try { writeJson(PATHS.state, state); } catch (e) { log("状态保存失败: " + e.message); }
}

// ── 会话来源（手机 / 电脑）────────────────────────────────────────────
//  记的是会话「最初在哪台设备上建的」，跟着会话包一起走。
//  在本机打开一条来自手机的会话，仍然由本机的 claude 执行，标签只表示出处。
function selfOrigin() {
  return { kind: SELF_KIND, name: state.deviceName, dev: state.deviceId, platform: process.platform, at: Date.now() };
}
function originOf(id) {
  const o = state.origins[id];
  return o && (o.kind === "phone" || o.kind === "pc") ? o : null;
}
function cleanOrigin(o) {
  if (!o || (o.kind !== "phone" && o.kind !== "pc")) return null;
  return {
    kind: o.kind, name: String(o.name || "").slice(0, 60), dev: String(o.dev || "").slice(0, 64),
    platform: String(o.platform || "").slice(0, 20), at: Number(o.at) || Date.now(),
  };
}
/** 收到一条会话：包里带了来源就用包里的，否则按对端设备记。 */
function applyIncomingOrigin(id, meta, peer) {
  if (!SID_RE.test(String(id || ""))) return;
  const fromMeta = cleanOrigin(meta && meta.origin);
  if (fromMeta) {
    state.origins[id] = fromMeta;
    return;
  }
  if (originOf(id)) return;
  const kind = (peer && peer.kind) || kindOfPlatform(peer && peer.platform);
  if (!kind) return;
  state.origins[id] = {
    kind, name: (peer && peer.name) || "", dev: (peer && peer.id) || "",
    platform: (peer && peer.platform) || "", at: Date.now(),
  };
}
/** 启动时给老会话补来源：优先看 transcript 里的环境快照，其次看日志里「收到会话」的记录。 */
function seedOrigins() {
  // 识别规则改过就重来一遍：只清掉按环境猜出来的（src=seed），对端明确告诉我们的保留
  let reseeded = 0;
  if (state.originsV !== 2) {
    for (const [id, o] of Object.entries(state.origins)) {
      if (!o || o.src === "seed") { delete state.origins[id]; reseeded++; }
    }
    state.originsV = 2;
    if (reseeded) log(`重新识别 ${reseeded} 条会话来源`);
  }
  let list;
  try { list = new SessionIndex(PATHS).scan(true).list(5000); } catch (e) { log("来源回填跳过: " + e.message); return; }
  // 日志里收到过的会话（旧版本还没记来源）：8 位前缀 → 对端名字
  const recv = new Map();
  try {
    const st = fs.statSync(PATHS.log);
    const n = Math.min(st.size, 8 * 1024 * 1024);
    const b = Buffer.alloc(n);
    const fd = fs.openSync(PATHS.log, "r");
    try { fs.readSync(fd, b, 0, n, st.size - n); } finally { fs.closeSync(fd); }
    for (const m of b.toString("utf8").matchAll(/收到会话 ([0-9a-f]{8}) ← (.+?)（/g)) recv.set(m[1], m[2]);
  } catch {}
  const keep = new Set();
  let added = 0;
  for (const e of list) {
    keep.add(e.id);
    if (originOf(e.id)) continue;
    let kind = "";
    let platform = "";
    try { platform = detectSessionPlatform(e.file); } catch {}
    kind = kindFromEnv(platform);
    let name = "", dev = "";
    if (!kind) {
      const from = recv.get(e.id.slice(0, 8));
      const peer = from ? state.peers.find((p) => p.name === from) : null;
      kind = (peer && peer.kind) || kindOfPlatform(peer && peer.platform) || (from ? (SELF_KIND === "pc" ? "phone" : "pc") : SELF_KIND);
      name = (peer && peer.name) || from || (kind === SELF_KIND ? state.deviceName : "");
      dev = (peer && peer.id) || (kind === SELF_KIND ? state.deviceId : "");
      if (kind === SELF_KIND && !platform) platform = process.platform;
    } else if (kind === SELF_KIND) {
      name = state.deviceName; dev = state.deviceId;
      if (!platform) platform = process.platform;
    } else {
      const peer = state.peers.find((p) => (p.kind || kindOfPlatform(p.platform)) === kind);
      name = (peer && peer.name) || ""; dev = (peer && peer.id) || "";
    }
    state.origins[e.id] = { kind, name, dev, platform, at: e.mtime || Date.now(), src: "seed" };
    added++;
  }
  // 本机已经没有的会话不再保留来源；条目太多时留最近的
  for (const id of Object.keys(state.origins)) if (!keep.has(id)) delete state.origins[id];
  const ids = Object.keys(state.origins);
  if (ids.length > 6000) {
    ids.sort((a, b) => (state.origins[b].at || 0) - (state.origins[a].at || 0));
    for (const id of ids.slice(6000)) delete state.origins[id];
  }
  if (added) log(`已记录 ${added} 条会话来源`);
  if (added || reseeded) saveSoon(200);
}

// ── 本机令牌（网关的令牌 + Cookie）────────────────────────────────────
let tokCache = { at: 0, val: "" };
function gatewayToken() {
  if (Date.now() - tokCache.at < 2000) return tokCache.val;
  let t = "";
  try { t = fs.readFileSync(PATHS.token, "utf8").trim(); } catch {}
  if (!/^[0-9a-f]{64}$/.test(t)) {
    // 没有网关（单独调试时）：自己造一个，写在 .link-token，日志里给出带令牌的地址
    const f = path.join(HOME, ".link-token");
    try {
      t = fs.readFileSync(f, "utf8").trim();
      if (!/^[0-9a-f]{64}$/.test(t)) throw new Error("bad");
    } catch {
      t = crypto.randomBytes(32).toString("hex");
      try { ensureDir(HOME); fs.writeFileSync(f, t + "\n", { mode: 0o600 }); } catch {}
    }
  }
  tokCache = { at: Date.now(), val: t };
  return t;
}
function eq(a, b) {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function cookieToken(req) {
  const m = /(?:^|;\s*)cc_t_\d+=([0-9a-f]{64})(?:;|$)/.exec(req.headers.cookie || "");
  return m ? m[1] : "";
}
function localAuthed(req, u) {
  const t = gatewayToken();
  if (!t) return false;
  return eq(req.headers["x-cc-token"], t) || eq(req.headers["x-link-token"], t) ||
    eq(cookieToken(req), t) || eq(u.searchParams.get("t"), t);
}
function peerBySecret(req) {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || "");
  if (!m) return null;
  const p = state.peers.find((x) => x.secret && eq(m[1], x.secret));
  if (p) p.lastSeen = Date.now();
  return p || null;
}

// ── 网络小工具 ────────────────────────────────────────────────────────
function remoteIP(req) { return String(req.socket.remoteAddress || "").replace(/^::ffff:/, ""); }
function isLoopback(ip) { return ip === "::1" || ip === "127.0.0.1" || ip.startsWith("127."); }
function isPrivateIP(ip) {
  const s = String(ip || "").replace(/^::ffff:/, "");
  if (isLoopback(s)) return true;
  if (/^10\./.test(s) || /^192\.168\./.test(s) || /^169\.254\./.test(s)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(s)) return true;
  // 100.64.0.0/10：运营商级 NAT 保留段，Tailscale / 一些 VPN 用它做设备地址
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(s)) return true;
  if (/^fe80:/i.test(s) || /^f[cd][0-9a-f]{2}:/i.test(s)) return true;
  return false;
}
function localIPs() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === "IPv4" && !a.internal && a.address) out.push(a.address);
    }
  }
  return [...new Set(out)];
}
function hostNames() {
  const s = new Set(["127.0.0.1", "localhost", "::1", os.hostname().toLowerCase()]);
  for (const ip of localIPs()) s.add(ip.toLowerCase());
  return s;
}
function hostOK(req) {
  let h = String(req.headers.host || "").toLowerCase();
  if (!h) return false;
  if (h.startsWith("[")) h = h.slice(1, h.indexOf("]"));
  else h = h.replace(/:\d+$/, "");
  return hostNames().has(h);
}
function originOK(req) {
  const o = req.headers.origin;
  if (o === undefined) return true;
  const s = String(o).toLowerCase();
  if (s === `http://127.0.0.1:${LOCAL_PORT}` || s === `http://localhost:${LOCAL_PORT}`) return true;
  // 工作台页面（网关端口）要读会话来源，允许它跨端口访问本机接口（靠网关 Cookie 鉴权）
  if (s === `http://127.0.0.1:${GATEWAY_PORT}` || s === `http://localhost:${GATEWAY_PORT}`) return true;
  for (const ip of localIPs()) if (s === `http://${ip}:${LAN_PORT}`) return true;
  return false;
}
function hostFor(addr) {
  const a = String(addr || "");
  return a.includes(":") && !a.startsWith("[") ? `[${a}]` : a;
}
function sendJson(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": b.length });
  res.end(b);
}
function sendText(res, code, text, type = "text/plain; charset=utf-8") {
  const b = Buffer.from(text);
  res.writeHead(code, { "content-type": type, "cache-control": "no-store", "content-length": b.length });
  res.end(b);
}
function readBody(req, max = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > max) { reject(Object.assign(new Error("body too large"), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
async function jsonBody(req, max) {
  const b = await readBody(req, max);
  if (!b.length) return {};
  try { return JSON.parse(b.toString("utf8")); } catch { throw Object.assign(new Error("bad json"), { status: 400 }); }
}

// ── 局域网发现 ────────────────────────────────────────────────────────
const discovered = new Map();  // id -> {id,name,addr,port,at}
let udp = null, beaconTimer = null;

function beaconPayload() {
  return Buffer.from(JSON.stringify({ m: "cccodroid-link", v: 1, id: state.deviceId, name: state.deviceName, port: LAN_PORT, at: Date.now() }));
}
function broadcastTargets() {
  const out = new Set(["255.255.255.255"]);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== "IPv4" || a.internal || !a.netmask) continue;
      const ip = a.address.split(".").map(Number), mask = a.netmask.split(".").map(Number);
      if (ip.length !== 4 || mask.length !== 4 || ip.some((x) => !Number.isFinite(x))) continue;
      out.add(ip.map((x, i) => (x | (~mask[i] & 255)) >>> 0).join("."));
    }
  }
  return [...out];
}
function startUdp() {
  if (udp) return;
  udp = dgram.createSocket({ type: "udp4", reuseAddr: true });
  udp.on("message", (msg, rinfo) => {
    let m; try { m = JSON.parse(msg.toString("utf8")); } catch { return; }
    if (!m || m.m !== "cccodroid-link" || m.v !== 1 || m.id === state.deviceId) return;
    if (!/^[A-Za-z0-9._-]{8,64}$/.test(String(m.id || ""))) return;
    const addr = String(rinfo.address || "").replace(/^::ffff:/, "");
    if (!isPrivateIP(addr)) return;
    const port = toPort(m.port, LAN_PORT);
    const known = state.peers.find((p) => p.id === m.id);
    if (known) {
      known.lastSeen = Date.now();
      if (!known.addr || known.addr !== addr) { known.addr = addr; saveSoon(2000); }
      if (!known.port) known.port = port;
      discovered.delete(m.id);
      return;
    }
    discovered.set(m.id, { id: m.id, name: String(m.name || "设备").slice(0, 60), addr, port, at: Date.now() });
  });
  udp.on("error", (e) => log("发现端口错误: " + e.message));
  udp.bind(UDP_PORT, "0.0.0.0", () => {
    try { udp.setBroadcast(true); } catch {}
    const tick = () => {
      if (!udp) return;
      const msg = beaconPayload();
      for (const t of broadcastTargets()) {
        try { udp.send(msg, UDP_PORT, t, () => {}); } catch {}
      }
      for (const [id, d] of discovered) if (Date.now() - d.at > DISCOVER_MS * 3) discovered.delete(id);
    };
    tick();
    beaconTimer = setInterval(tick, 4000);
  });
}
function stopUdp() {
  if (beaconTimer) { clearInterval(beaconTimer); beaconTimer = null; }
  if (udp) { try { udp.close(); } catch {} udp = null; }
  discovered.clear();
}

// ── 网关（本机 claude 界面）附带的小调用 ──────────────────────────────
let gwFails = 0;
async function gwPost(p, body) {
  const tok = gatewayToken();
  if (!tok) return null;
  try {
    const r = await fetch(`http://127.0.0.1:${GATEWAY_PORT}${p}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-cc-token": tok },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(8000),
    });
    gwFails = 0;
    if (!r.ok) { log(`网关拒绝 ${p}: HTTP ${r.status}`); return false; }
    return true;
  } catch (e) {
    gwFails++;
    return null;  // 网关没在跑：可以退回直接改文件
  }
}
async function applyName(id, title) {
  const t = String(title || "").trim().slice(0, 120);
  if (!t) return;
  const r = await gwPost(`/api/session/${encodeURIComponent(id)}/rename`, { title: t });
  if (r === true) return;
  if (r === null) {
    const n = readJson(PATHS.names, {});
    if (n[id] !== t) { n[id] = t; try { writeJson(PATHS.names, n); } catch {} }
  }
}
async function applyPin(id, ts) {
  const when = Number(ts) || 0;
  if (!when) return;
  const r = await gwPost(`/api/session/${encodeURIComponent(id)}/pin`, { pin: true });
  if (r === null) {
    const p = readJson(PATHS.pins, {});
    if (!(p[id] >= when)) { p[id] = when; try { writeJson(PATHS.pins, p); } catch {} }
  }
}

// ── 公网中转 ──────────────────────────────────────────────────────────
//  设备和服务器之间只有出站 HTTPS；服务器把请求当成「一个对端」的接口来答。
function relayReady() {
  const r = state.relay;
  return !!(r && r.enabled && /^https?:\/\//i.test(r.url) && r.token);
}
function relayPeer() {
  if (!relayReady()) return null;
  const r = state.relay;
  if (!/^relay-[0-9a-f]{12}$/.test(String(r.id || ""))) {
    r.id = "relay-" + crypto.createHash("sha1").update(r.url).digest("hex").slice(0, 12);
  }
  return {
    id: r.id, name: r.name || "公网中转", relay: true, url: r.url,
    addr: "", port: 0, secret: r.token, autoSync: true,
    lastSeen: r.lastSeen || 0, lastSync: r.lastSync || 0,
    lastError: r.lastError || "", lastResult: r.lastResult || null,
  };
}
function saveRelayStats(peer) {
  if (!peer || !peer.relay) return;
  state.relay.lastSeen = peer.lastSeen || 0;
  state.relay.lastSync = peer.lastSync || 0;
  state.relay.lastError = peer.lastError || "";
  state.relay.lastResult = peer.lastResult || null;
  saveSoon(200);
}

// ── 对端 HTTP ─────────────────────────────────────────────────────────
async function peerFetch(peer, method, p, { body, headers = {}, timeout = 20000, raw = false } = {}) {
  const url = peer.relay
    ? String(peer.url).replace(/\/+$/, "") + p
    : `http://${hostFor(peer.addr)}:${peer.port}${p}`;
  const h = { authorization: `Bearer ${peer.secret}`, ...headers };
  let r;
  try {
    r = await fetch(url, { method, headers: h, body, signal: AbortSignal.timeout(timeout) });
  } catch (e) {
    const where = peer.relay ? `中转 ${peer.url}` : `${peer.addr}:${peer.port}`;
    throw Object.assign(new Error(e.name === "TimeoutError" ? "对端超时" : `连不上 ${where}`), { status: 0 });
  }
  if (raw) {
    const buf = Buffer.from(await r.arrayBuffer());
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      try { msg = JSON.parse(buf.toString("utf8")).error || msg; } catch {}
      throw Object.assign(new Error(msg), { status: r.status, data: buf });
    }
    return { buf, status: r.status, headers: r.headers };
  }
  const ct = r.headers.get("content-type") || "";
  let data;
  try { data = ct.includes("json") ? await r.json() : await r.text(); } catch { data = null; }
  if (!r.ok) {
    throw Object.assign(new Error((data && data.error) || `HTTP ${r.status}`), { status: r.status, data });
  }
  return data;
}

// ── 远程执行 ──────────────────────────────────────────────────────────
//  电脑上的会话默认在本机跑；遇到只有另一台设备才有的环境（抖音商城、安卓 App、
//  读屏点按；或者 Windows 编译），模型调 MCP 工具 remote_task，把一段自包含的
//  指令派给对端。对端由 linkd 拉起一个一次性的 claude 进程（不落会话），
//  只回传最终文本。传输走局域网或公网中转，两边都不需要公网 IP。
const REMOTE_DIR = path.join(HOME, ".cccodroid", "link", "remote");
const REMOTE_KEEP = 60;
const REMOTE_MAX_PROMPT = 64 * 1024;
const REMOTE_MAX_RESULT = 512 * 1024;
const REMOTE_MAX_TIMEOUT = 3600;
const REMOTE_TERMINAL = new Set(["done", "error", "cancelled"]);
const remoteTasks = new Map();
const remoteProcs = new Map();          // id -> { child, timer, finish }
const remoteSaveTimers = new Map();
let remotePolling = false;
let remoteDevicesAt = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function remoteExecPath() {
  const env = String(process.env.CCAPP_REMOTE_EXEC || "").trim();
  if (env) return path.resolve(env);
  for (const f of [path.join(HERE, "remote-exec.mjs"), path.join(HOME, ".cccodroid", "link", "remote-exec.mjs")]) {
    try { if (fs.existsSync(f)) return f; } catch {}
  }
  return path.join(HERE, "remote-exec.mjs");
}

// ── 点名轮次（@手机 / @电脑）：续跑同一个会话 + 镜像到本机界面 ──────────
// 和「Claude 自己用 remote_task 派活」不同：这一轮属于这段对话，要对端读到完整
// 上下文、把回复写回 transcript，并且本机界面也要实时看到它在跑。
/** 同步过来的同名会话在不在本机、它的 cwd 是什么（transcript 里最后一条 cwd） */
function localSessionInfo(id) {
  const file = findSessionFile(PATHS, id);
  if (!file) return null;
  let cwd = "", mtime = 0;
  try {
    const st = fs.statSync(file);
    mtime = st.mtimeMs;
    const start = Math.max(0, st.size - 200000);
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    const lines = buf.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      try { const o = JSON.parse(lines[i]); if (o && typeof o.cwd === "string" && o.cwd) { cwd = o.cwd; break; } } catch {}
    }
  } catch {}
  return cwd ? { file, cwd, mtime } : null;
}
function remoteMirror(t, op, extra) {
  if (!t.mirror || !t.sessionId) return;
  const token = gatewayToken();
  if (!token) return;
  const body = JSON.stringify({ op, id: t.id, sessionId: t.sessionId, from: (t.from && t.from.name) || "", ...extra });
  fetch(`http://127.0.0.1:${GATEWAY_PORT}/api/remote/mirror`, {
    method: "POST",
    headers: { "x-cc-token": token, "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(5000),
  }).catch(() => {});
}

// ── 执行端为本体 ─────────────────────────────────────────────────────
// @ 轮次不是「linkd 拉一个一次性 claude」：只要本机有这个会话，这一轮就交给本机网关
// POST /api/chat 真正跑起来 —— 和用户在这台设备上自己打字发出去的一样：写进 transcript、
// 界面里有气泡、能插话、能点停止。linkd 订阅网关的 /api/events，把这一轮的事件回传给
// 调用方；调用方只做镜像。这样「谁执行谁就是本体」，停止和插话都落到真正在跑的那一端。
function gatewayHttp() { return `http://127.0.0.1:${GATEWAY_PORT}`; }
function gatewayHeaders() { return { "x-cc-token": gatewayToken(), "content-type": "application/json" }; }
/** 本机网关已打开界面：互联写入会话后推一条事件，前端立即重取列表。 */
function notifyGatewayLink(peer, { pulled = 0, pushed = 0, meta = false } = {}) {
  if (!pulled && !meta) return;
  state.historyRev += 1;
  state.historyAt = Date.now();
  saveSoon(100);
  const token = gatewayToken();
  if (!token) return;
  fetch(gatewayHttp() + "/api/link/synced", {
    method: "POST",
    headers: { "x-cc-token": token, "content-type": "application/json" },
    body: JSON.stringify({
      at: Date.now(),
      peer: { id: peer.id, name: peer.name, via: peer.relay ? "relay" : "lan" },
      pulled, pushed, meta,
    }),
    signal: AbortSignal.timeout(4000),
  }).catch((e) => log("通知界面刷新会话失败: " + e.message));
}
/** 调用方目录 → 本机目录（收到的任务正文里可能提到对方的文件） */
function peerPathMap(from) {
  if (!from || !(from.workspace || from.home)) return [];
  return makePathMap(PATHS, { workspace: from.workspace || "", home: from.home || "" });
}
/** 本机目录 → 调用方目录（回传的事件里带的是本机路径，对方界面点了要能打开） */
function outPathMap(from) {
  if (!from || !(from.workspace || from.home)) return [];
  return makePathMap({ workspace: from.workspace || PATHS.workspace, home: from.home || PATHS.home },
    { workspace: PATHS.workspace, home: PATHS.home });
}

function gatewayRunStart(t, text) {
  const token = gatewayToken();
  if (!token) { remoteFail(t, "本机网关没有令牌，无法在执行端启动这一轮"); return; }
  const inMap = peerPathMap(t.from);
  const outMap = outPathMap(t.from);
  const out = (v) => mapPathString(String(v == null ? "" : v), outMap);
  const tmo = Math.max(10, Math.min(REMOTE_MAX_TIMEOUT, Number(t.timeout) || 600));
  let done = false;
  const ctl = new AbortController();
  // 调用方点停止 / 这一轮出错：真的去本机网关把这一轮停掉，别只把任务标成 cancelled
  const abortGw = () => {
    if (!t.gwRunId) { log(`停止 ${t.id.slice(0, 8)}：还没有网关轮次号，跳过`); return; }
    fetch(gatewayHttp() + "/api/abort", {
      method: "POST", headers: gatewayHeaders(), body: JSON.stringify({ id: t.gwRunId }),
      signal: AbortSignal.timeout(8000),
    }).then((r) => log(`停止执行端这一轮 ${t.gwRunId} → HTTP ${r.status}`))
      .catch((e) => log(`停止执行端这一轮失败：${e.message}`));
  };
  const finishOnce = (status, resultText, error) => {
    if (done) return;
    done = true;
    if (status === "cancelled" || status === "error") abortGw();
    try { ctl.abort(); } catch {}
    remoteFinish(t, status, resultText == null ? null : out(resultText), error ? out(error) : "");
  };
  const pro = { child: null, timer: null, finish: finishOnce, abort: abortGw };
  pro.timer = setTimeout(() => { finishOnce("error", null, `超时（${tmo} 秒）`); }, (tmo + 30) * 1000);
  pro.timer.unref?.();
  remoteProcs.set(t.id, pro);
  t.status = "running"; t.startedAt = Date.now(); t.gateway = true; t.resume = true;
  remoteSave(t, 0);
  log(`远程任务开始 ${t.id.slice(0, 8)}（来自 ${(t.from && t.from.name) || "?"}，由本机网关续跑会话 ${String(t.sessionId).slice(0, 8)}）`);

  (async () => {
    let runId = "", textOut = "", accS = "";
    const early = [];
    const onEv = (ev) => {
      if (!ev || typeof ev !== "object") return;
      if (ev.type === "run_end") {
        if (ev.failed) finishOnce("error", null, ev.message || "执行失败");
        else if (ev.aborted) finishOnce("cancelled", null, "已取消");
        else finishOnce("done", textOut || (ev.resultText ? String(ev.resultText) : ""), "");
        return;
      }
      if (ev.type === "error" && ev.message) { t.lastError = out(ev.message); return; }
      if (ev.type === "delta" && ev.text) { textOut += ev.text; remotePushEvent(t, { k: "delta", text: out(ev.text) }); }
      else if (ev.type === "assistant_text" && ev.text) { textOut += ev.text; remotePushEvent(t, { k: "text", text: out(ev.text) }); }
      else if (ev.type === "thinking_delta" && ev.text) remotePushEvent(t, { k: "thinking", text: out(ev.text) });
      else if (ev.type === "tool_use") remotePushEvent(t, { k: "tool_use", id: ev.id, name: ev.name || "tool", input: mapPathsDeep(ev.input || {}, outMap) });
      else if (ev.type === "tool_result") remotePushEvent(t, { k: "tool_result", id: ev.id, ok: !!ev.ok, text: out(ev.text || "") });
    };
    const consume = (chunk) => {
      accS += chunk;
      let i;
      while ((i = accS.indexOf("\n\n")) >= 0) {
        const block = accS.slice(0, i); accS = accS.slice(i + 2);
        for (const line of block.split("\n")) {
          if (!line.startsWith("data:")) continue;
          let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
          if (!ev || ev.type === "hello" || ev.type === "sync") continue;
          if (!runId) { early.push(ev); continue; }
          if (ev.runId === runId) onEv(ev);
        }
      }
    };
    try {
      // 先把事件流挂上，再发消息：run_start 和最早的增量不会漏
      const resp = await fetch(gatewayHttp() + "/api/events", { headers: gatewayHeaders(), signal: ctl.signal });
      if (!resp.ok || !resp.body) throw new Error(`订阅本机事件失败 HTTP ${resp.status}`);
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      const pump = (async () => {
        for (;;) {
          const { value, done: rd } = await reader.read();
          if (rd) break;
          consume(dec.decode(value, { stream: true }));
          if (done) break;
        }
      })().catch(() => {});
      const r = await fetch(gatewayHttp() + "/api/chat", {
        method: "POST", headers: gatewayHeaders(), signal: ctl.signal,
        body: JSON.stringify({ message: mapPathString(String(text || t.prompt || ""), inMap), sessionId: t.sessionId }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.message || j.error || `网关 HTTP ${r.status}`);
      runId = String(j.id || "");
      if (!runId) throw new Error("网关没有返回这一轮的编号");
      t.gwRunId = runId;
      remoteSave(t, 0);
      for (const ev of early) if (ev.runId === runId) onEv(ev);
      early.length = 0;
      await pump;
      if (!done) finishOnce("error", null, t.lastError || "本机网关的这一轮意外结束");
    } catch (e) {
      if (!done) finishOnce("error", null, "执行失败：" + e.message);
    }
  })();
}

function remoteTaskFile(id) { return path.join(REMOTE_DIR, id + ".json"); }
const REMOTE_EVENT_KEEP = 2000;
const REMOTE_EVENT_TEXT = 16000;
const remoteEvWaiters = new Map();      // task id -> Set<fn>

function remoteEventsInit(t) {
  if (!Array.isArray(t.events)) t.events = [];
  if (!Number.isFinite(t.evSeq)) t.evSeq = t.events.reduce((m, e) => Math.max(m, Number(e.seq) || 0), 0);
}
function remoteEvBump(id) {
  const set = remoteEvWaiters.get(id);
  if (!set) return;
  for (const fn of [...set]) { try { fn(); } catch {} }
  remoteEvWaiters.delete(id);
}
function remotePushEvent(t, ev) {
  if (!ev || typeof ev !== "object") return;
  remoteEventsInit(t);
  const clean = {};
  for (const [k, v] of Object.entries(ev)) clean[k] = typeof v === "string" ? v.slice(0, REMOTE_EVENT_TEXT) : v;
  t.events.push({ seq: ++t.evSeq, at: Date.now(), ev: clean });
  if (t.events.length > REMOTE_EVENT_KEEP) t.events.splice(0, t.events.length - REMOTE_EVENT_KEEP);
  remoteEvBump(t.id);
  remoteSave(t, 500);
  if (t.via === "relay") remoteRelayEventsSoon(t);
}
function remoteEventsSince(t, since) {
  remoteEventsInit(t);
  return t.events.filter((e) => Number(e.seq) > since);
}
function remoteMergeEvents(t, events) {
  if (!Array.isArray(events) || !events.length) return;
  remoteEventsInit(t);
  let added = false;
  for (const e of events) {
    const seq = Number(e && e.seq);
    if (!seq || seq <= t.evSeq || !e.ev) continue;
    t.events.push({ seq, at: Number(e.at) || Date.now(), ev: e.ev });
    t.evSeq = seq;
    added = true;
  }
  if (!added) return;
  if (t.events.length > REMOTE_EVENT_KEEP) t.events.splice(0, t.events.length - REMOTE_EVENT_KEEP);
  remoteEvBump(t.id);
  remoteSave(t, 400);
}
function remoteEventState(t, since) {
  remoteEventsInit(t);
  return {
    events: remoteEventsSince(t, since), next: t.evSeq,
    done: REMOTE_TERMINAL.has(t.status), status: t.status, evSeq: t.evSeq,
    result: t.result || "", error: t.error || "",
  };
}
// 中转没有长连接：把新事件攒 500ms 批量推上去，调用方那边每条任务更新都会立刻醒
function remoteRelayEventsSoon(t) {
  if (t.via !== "relay" || t._relayEvTimer) return;
  t._relayEvTimer = setTimeout(() => { t._relayEvTimer = null; remoteRelayPushEvents(t); }, 500);
  t._relayEvTimer.unref?.();
}
function remoteRelayPushEvents(t) {
  if (t.via !== "relay") return;
  const rp = relayPeer();
  if (!rp) return;
  const since = Number(t._relayEvSent) || 0;
  const events = remoteEventsSince(t, since);
  if (!events.length) return;
  t._relayEvSent = events[events.length - 1].seq;
  peerFetch(rp, "POST", `/api/relay/task/${encodeURIComponent(t.id)}`, {
    body: JSON.stringify({ status: t.status === "running" ? "running" : t.status, events: events.map((e) => ({ seq: e.seq, ev: e.ev })) }),
    timeout: 10000,
  }).catch(() => { t._relayEvSent = since; });
}

function remoteClean(t) {
  const o = {};
  for (const [k, v] of Object.entries(t)) if (!k.startsWith("_")) o[k] = v;
  if (o.result && o.result.length > REMOTE_MAX_RESULT) o.result = o.result.slice(0, REMOTE_MAX_RESULT);
  if (Array.isArray(o.events) && o.events.length > 800) o.events = o.events.slice(-800);
  return o;
}
function remoteSave(t, soon = 250) {
  const id = t.id;
  if (soon) {
    if (remoteSaveTimers.has(id)) return;
    remoteSaveTimers.set(id, setTimeout(() => { remoteSaveTimers.delete(id); remoteSave(t, 0); }, soon));
    return;
  }
  try { ensureDir(REMOTE_DIR); writeJson(remoteTaskFile(id), remoteClean(t)); } catch (e) { log("远程任务保存失败: " + e.message); }
}
function remoteLoad() {
  ensureDir(REMOTE_DIR);
  let files = [];
  try { files = fs.readdirSync(REMOTE_DIR).filter((f) => /^[A-Za-z0-9-]{8,64}\.json$/.test(f)); } catch {}
  const rows = [];
  for (const f of files) {
    try {
      const t = JSON.parse(fs.readFileSync(path.join(REMOTE_DIR, f), "utf8"));
      if (t && t.id && t.createdAt) { remoteEventsInit(t); rows.push(t); }
    } catch {}
  }
  rows.sort((a, b) => b.createdAt - a.createdAt);
  for (const t of rows.slice(0, REMOTE_KEEP)) {
    if (!REMOTE_TERMINAL.has(t.status)) { t.status = "error"; t.error = "linkd 重启，任务中断"; t.endedAt = Date.now(); remoteSave(t, 0); }
    remoteTasks.set(t.id, t);
  }
  for (const t of rows.slice(REMOTE_KEEP)) { try { fs.unlinkSync(remoteTaskFile(t.id)); } catch {} }
  for (const t of rows) if (Date.now() - t.createdAt > 7 * 864e5) { try { fs.unlinkSync(remoteTaskFile(t.id)); } catch {} }
}
function listSkills() {
  const out = [];
  for (const dir of [path.join(HOME, ".claude", "skills"), path.join(WORKSPACE, ".claude", "skills")]) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (out.length >= 48) break;
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(n) || n === "short-video-marketplace") continue;
      try { if (fs.statSync(path.join(dir, n)).isDirectory()) out.push(n); } catch {}
    }
  }
  return [...new Set(out)];
}
function selfCaps() {
  return {
    platform: process.platform, kind: SELF_KIND, host: os.hostname(),
    workspace: PATHS.workspace, skills: listSkills(), remote: !!state.remote.enabled,
  };
}
function remoteAllowed(fromId) {
  return !!state.remote.enabled && state.remote.allow[String(fromId || "")] === "auto";
}
function remoteTargets() {
  const now = Date.now();
  const out = [];
  for (const p of state.peers) {
    out.push({
      id: p.id, name: p.name, via: "lan", kind: p.kind || kindOfPlatform(p.platform) || "",
      platform: p.platform || "", online: now - (p.lastSeen || 0) < ALIVE_MS,
      caps: p.caps || {}, allowed: state.remote.allow[p.id] === "auto",
    });
  }
  for (const d of state.remote.relayDevices || []) {
    if (!d || d.id === state.deviceId) continue;
    out.push({
      id: d.id, name: d.name || d.id.slice(0, 8), via: "relay", kind: d.kind || kindOfPlatform(d.platform),
      platform: d.platform || "", online: now - (d.lastSeen || 0) < 90000,
      caps: d.caps || {}, allowed: state.remote.allow[d.id] === "auto",
    });
  }
  return out;
}
function findTarget(q) {
  const s = String(q || "").trim();
  if (!s) return null;
  const list = remoteTargets();
  let hits = list.filter((t) => t.id === s);
  if (!hits.length) hits = list.filter((t) => t.name.toLowerCase() === s.toLowerCase());
  if (!hits.length) return null;
  // 同一台设备可能同时有局域网和中转两条路：优先能连上的，局域网更快
  return hits.find((t) => t.via === "lan" && t.online) || hits.find((t) => t.via === "relay" && t.online) ||
    hits.find((t) => t.via === "relay") || hits[0];
}
function remotePublic(t) {
  const o = remoteClean(t);
  delete o.promptFile;
  delete o.events;
  remoteEventsInit(t);
  o.evSeq = t.evSeq;
  o.eventCount = t.events.length;
  return o;
}
function remoteRecent(limit = 12) {
  return [...remoteTasks.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, Math.max(1, Math.min(50, limit)))
    .map((t) => {
      const o = remotePublic(t);
      if (o.result && o.result.length > 600) o.result = o.result.slice(0, 600) + "…";
      if (o.prompt && o.prompt.length > 300) o.prompt = o.prompt.slice(0, 300) + "…";
      return o;
    });
}

function remoteKill(pid) {
  if (!pid) return;
  try {
    if (process.platform === "win32") execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { timeout: 10000, stdio: "ignore" });
    else process.kill(-pid, "SIGTERM");
  } catch {}
}

function remoteReportRelay(t) {
  if (t.via !== "relay") return;
  const rp = relayPeer();
  if (!rp) return;
  const since = Number(t._relayEvSent) || 0;
  const events = remoteEventsSince(t, since);
  if (events.length) t._relayEvSent = events[events.length - 1].seq;
  Promise.resolve()
    .then(() => peerFetch(rp, "POST", `/api/relay/task/${encodeURIComponent(t.id)}`, {
      body: JSON.stringify({ status: t.status, result: t.result || "", error: t.error || "", progress: t.progress || "", endedAt: t.endedAt || 0,
        events: events.map((e) => ({ seq: e.seq, ev: e.ev })) }),
      timeout: 15000,
    }))
    .catch((e) => log(`远程任务回报中转失败 ${t.id.slice(0, 8)}: ${e.message}`));
}

function remoteFinish(t, status, text, error) {
  const pro = remoteProcs.get(t.id);
  if (pro) {
    clearTimeout(pro.timer);
    remoteProcs.delete(t.id);
    try { if (pro.child && pro.child.exitCode === null) remoteKill(pro.child.pid); } catch {}
  }
  t.status = status;
  t.endedAt = Date.now();
  if (text !== null && text !== undefined) t.result = String(text).slice(0, REMOTE_MAX_RESULT);
  t.error = error ? String(error).slice(0, 4000) : "";
  t.progress = "";
  if (t.promptFile) { try { fs.unlinkSync(t.promptFile); } catch {} t.promptFile = ""; }
  remoteEvBump(t.id);
  remoteSave(t, 0);
  remoteReportRelay(t);
  log(`远程任务 ${status === "done" ? "完成" : status} ${t.id.slice(0, 8)}（来自 ${t.from && t.from.name || "?"}，${Math.round((t.endedAt - (t.startedAt || t.createdAt)) / 1000)} 秒）`);
  remotePump();
}
function remoteFail(t, msg) { t.status = "error"; t.error = String(msg || "失败").slice(0, 4000); t.endedAt = Date.now(); remoteSave(t, 0); remoteReportRelay(t); remotePump(); }

function remoteStart(t) {
  const script = remoteExecPath();
  if (!fs.existsSync(script)) { remoteFail(t, "找不到远程执行脚本 remote-exec.mjs"); return; }
  ensureDir(REMOTE_DIR);
  // 点名派过来的：本机有这个会话就续跑（读到完整上下文、回复写回 transcript）。
  // 会话最近 20 秒内还在写（本机正开着这一轮）就退回一次性任务，避免两个 claude 同时往一个
  // transcript 里写。
  let resumeId = "", resumeCwd = "";
  if (t.sessionId && SID_RE.test(String(t.sessionId))) {
    const info = localSessionInfo(String(t.sessionId));
    if (info && fs.existsSync(info.cwd) && Date.now() - info.mtime > 20000) {
      resumeId = String(t.sessionId); resumeCwd = info.cwd;
    }
  }
  // 续跑的这一轮由本机网关真正跑（执行端即本体），界面里本来就看得到，不再另推镜像
  t.mirror = false;
  if (resumeId) { gatewayRunStart(t, String(t.text || t.prompt || "")); return; }
  // 一次性兜底：会话还没同步过来 / 本机正开着它 —— 不写 transcript，只把文本结果带回去
  const inMap = peerPathMap(t.from);
  const pf = path.join(REMOTE_DIR, t.id + ".prompt");
  const promptText = mapPathString(String(t.prompt), inMap) +
    (t.context ? "\n\n---\n【来自另一台设备当前会话的上下文，仅供理解，不要复述】\n" + mapPathString(String(t.context).slice(-6000), inMap) : "");
  try { fs.writeFileSync(pf, promptText, { mode: 0o600 }); } catch (e) { remoteFail(t, "写任务文件失败: " + e.message); return; }
  t.promptFile = pf;
  const timeout = Math.max(10, Math.min(REMOTE_MAX_TIMEOUT, Number(t.timeout) || 600));
  const maxTurns = Math.max(1, Math.min(200, Number(t.maxTurns) || 40));
  const args = [script, "--prompt-file", pf, "--cwd", resumeId ? resumeCwd : (t.cwd || PATHS.workspace),
    "--timeout", String(timeout), "--max-turns", String(maxTurns), "--mode", t.mode || "auto",
    ...(resumeId ? ["--resume", resumeId] : [])];
  let child;
  try {
    child = spawn(process.execPath, args, {
      cwd: PATHS.workspace, env: { ...process.env, CCAPP_REMOTE_TASK: "1" },
      stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true,
    });
  } catch (e) { remoteFail(t, "拉起执行器失败: " + e.message); return; }
  t.status = "running"; t.startedAt = Date.now(); t.pid = child.pid; remoteSave(t, 0);
  log(`远程任务开始 ${t.id.slice(0, 8)}（来自 ${t.from && t.from.name || "?"}，${t.prompt.length} 字节${resumeId ? "，续跑会话 " + resumeId.slice(0, 8) : ""}）`);
  if (t.mirror) remoteMirror(t, "start", { text: String(t.text || t.prompt || "") });
  let buf = "", err = "", done = false;
  // 一次性任务也要把路径换回调用方的目录：正文、工具参数、错误里都可能带本机绝对路径
  const outMap2 = outPathMap(t.from);
  const out2 = (v) => mapPathString(String(v == null ? "" : v), outMap2);
  const finishOnce = (status, text, error) => {
    if (done) return;
    done = true;
    const t2 = text == null ? text : out2(text);
    const e2 = error ? out2(error) : error;
    if (t.mirror) remoteMirror(t, "end", {
      resultText: t2 || "", failed: status === "error", aborted: status === "cancelled",
      durationMs: Date.now() - (t.startedAt || Date.now()),
    });
    remoteFinish(t, status, t2, e2);
  };
  const timer = setTimeout(() => {
    remoteKill(child.pid);
    finishOnce("error", null, `超时（${timeout} 秒）`);
  }, (timeout + 20) * 1000);
  remoteProcs.set(t.id, { child, timer, finish: finishOnce });
  child.stdout.on("data", (d) => {
    buf += d;
    if (buf.length > 8 * 1024 * 1024) { buf = buf.slice(-1024 * 1024); }
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === "event") {
        const mev = mapPathsDeep(ev.ev || {}, outMap2);
        remotePushEvent(t, mev);
        remoteMirror(t, "event", { ev: mev });
      } else if (ev.type === "progress") {
        t.progress = String(ev.text || "").slice(-4000);
        remoteSave(t);
        if (t.via === "relay" && t.status === "running" && Date.now() - (t._progAt || 0) > 3000) {
          t._progAt = Date.now();
          const rp = relayPeer();
          if (rp) peerFetch(rp, "POST", `/api/relay/task/${encodeURIComponent(t.id)}`, {
            body: JSON.stringify({ status: "running", progress: t.progress, result: "", error: "" }), timeout: 10000,
          }).catch(() => {});
        }
      } else if (ev.type === "done") {
        finishOnce("done", String(ev.text || ""), "");
      } else if (ev.type === "error") {
        finishOnce("error", null, ev.message || "执行失败");
      }
    }
  });
  child.stderr.on("data", (d) => { err = (err + d).slice(-12000); });
  child.on("error", (e) => finishOnce("error", null, e.message));
  child.on("close", (code) => {
    if (!done) finishOnce("error", null, (err.trim() || `执行器退出 code=${code}`).slice(-4000));
  });
}

function remotePump() {
  let running = 0;
  for (const t of remoteTasks.values()) if (t.dir === "in" && t.status === "running") running++;
  if (running >= state.remote.maxRunning) return;
  const queued = [...remoteTasks.values()].filter((t) => t.dir === "in" && t.status === "queued").sort((a, b) => a.createdAt - b.createdAt);
  for (const t of queued) {
    if (running >= state.remote.maxRunning) break;
    running++;
    remoteStart(t);
  }
}

function remoteAccept(task, from) {
  const id = String(task && task.id || "");
  if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) throw Object.assign(new Error("bad task id"), { status: 400 });
  if (remoteTasks.has(id)) return remoteTasks.get(id);
  const prompt = String(task.prompt || "");
  if (!prompt.trim()) throw Object.assign(new Error("empty prompt"), { status: 400 });
  if (prompt.length > REMOTE_MAX_PROMPT) throw Object.assign(new Error("prompt too big"), { status: 413 });
  const src = from && from.id ? {
    id: String(from.id).slice(0, 64), name: String(from.name || "").slice(0, 60),
    kind: String(from.kind || "").slice(0, 12), platform: String(from.platform || "").slice(0, 20), caps: from.caps || {},
    workspace: String(from.workspace || "").slice(0, 500), home: String(from.home || "").slice(0, 500),
  } : { id: "", name: "?" };
  if (!remoteAllowed(src.id)) throw Object.assign(new Error("remote not allowed"), { status: 403 });
  const t = {
    id, dir: "in", from: src, to: { id: state.deviceId, name: state.deviceName },
    prompt, cwd: String(task.cwd || "").slice(0, 500), timeout: Number(task.timeout) || 600,
    maxTurns: Number(task.maxTurns) || 40, mode: String(task.mode || "auto").slice(0, 20),
    sessionId: String(task.sessionId || "").slice(0, 64), text: String(task.text || "").slice(0, REMOTE_MAX_PROMPT),
    context: String(task.context || "").slice(0, 12000),
    status: "queued", progress: "", result: "", error: "", createdAt: Date.now(), via: String(from && from.via || "lan"),
    events: [], evSeq: 0,
  };
  remoteTasks.set(id, t);
  remoteSave(t, 0);
  log(`收到远程任务 ${id.slice(0, 8)}（来自 ${src.name || src.id}）`);
  remotePump();
  return t;
}

async function remoteDispatch(t) {
  const target = findTarget(t.toId);
  if (!target) throw new Error("找不到目标设备");
  const from = {
    id: state.deviceId, name: state.deviceName, kind: SELF_KIND, platform: process.platform, caps: selfCaps(),
    workspace: PATHS.workspace, home: HOME, via: target.via,
  };
  const payload = {
    task: { id: t.id, prompt: t.prompt, cwd: t.cwd, timeout: t.timeout, maxTurns: t.maxTurns, mode: t.mode,
      sessionId: t.sessionId || "", text: t.text || "", context: t.context || "", createdAt: t.createdAt },
    from,
  };
  if (target.via === "lan") {
    const peer = state.peers.find((p) => p.id === target.id);
    if (!peer) throw new Error("目标设备已不在配对列表");
    t.peerId = peer.id;
    await peerFetch(peer, "POST", "/api/peer/task", { body: JSON.stringify(payload), timeout: 20000 });
  } else {
    const rp = relayPeer();
    if (!rp) throw new Error("没有配置公网中转");
    await peerFetch(rp, "POST", "/api/relay/task", { body: JSON.stringify({ ...payload, to: target.id }), timeout: 20000 });
  }
  t.status = "sent";
  remoteSave(t, 0);
  remotePollOut(t, target);
}

async function remotePollOut(t, target) {
  const deadline = Date.now() + (Math.max(10, Number(t.timeout) || 600) + 120) * 1000;
  while (!REMOTE_TERMINAL.has(t.status) && Date.now() < deadline) {
    await sleep(target.via === "lan" ? 500 : 1000);
    if (REMOTE_TERMINAL.has(t.status)) break;
    try {
      let r;
      const since = Number(t.evSeq) || 0;
      const q = since ? `?since=${since}` : "";
      if (target.via === "lan") {
        const peer = state.peers.find((p) => p.id === target.id);
        if (!peer) throw new Error("目标设备已不在配对列表");
        r = await peerFetch(peer, "GET", `/api/peer/task/${encodeURIComponent(t.id)}${q}`, { timeout: 10000 });
      } else {
        const rp = relayPeer();
        if (!rp) throw new Error("没有配置公网中转");
        r = await peerFetch(rp, "GET", `/api/relay/task/${encodeURIComponent(t.id)}${q}`, { timeout: 15000 });
      }
      if (!r || !r.id) continue;
      if (Array.isArray(r.events)) remoteMergeEvents(t, r.events);
      let changed = false;
      if (r.status && r.status !== t.status) { t.status = r.status; changed = true; }
      if (typeof r.progress === "string" && r.progress !== t.progress) { t.progress = r.progress.slice(-4000); changed = true; }
      if (r.result && r.result !== t.result) { t.result = String(r.result).slice(0, REMOTE_MAX_RESULT); changed = true; }
      if (r.error && r.error !== t.error) { t.error = String(r.error).slice(0, 4000); changed = true; }
      if (changed) {
        remoteSave(t, 100);
        if (REMOTE_TERMINAL.has(t.status)) remoteEvBump(t.id);
      }
    } catch (e) {
      t.pollError = e.message;
    }
  }
  if (!REMOTE_TERMINAL.has(t.status)) { t.status = "error"; t.error = "等待对端结果超时"; t.endedAt = Date.now(); remoteSave(t, 0); }
}

async function remoteCancelTask(t, notifyRemote = true) {
  if (REMOTE_TERMINAL.has(t.status)) return;
  if (t.dir === "in") {
    const pro = remoteProcs.get(t.id);
    if (pro) { pro.finish("cancelled", null, "已取消"); return; }
  }
  t.status = "cancelled"; t.endedAt = Date.now(); remoteEvBump(t.id); remoteSave(t, 0);
  if (notifyRemote) {
    try {
      if (t.via === "lan" && t.peerId) {
        const peer = state.peers.find((p) => p.id === t.peerId);
        if (peer) await peerFetch(peer, "POST", `/api/peer/task/${encodeURIComponent(t.id)}/cancel`, { body: "{}", timeout: 8000 });
      } else if (t.via === "relay") {
        const rp = relayPeer();
        if (rp) {
          await peerFetch(rp, "POST", `/api/relay/task/${encodeURIComponent(t.id)}/cancel`, { body: "{}", timeout: 10000 }).catch(() => {});
          // 中转只改信箱记录，对端手里真正在跑的那一轮还得靠这封控制消息停掉
          if (t.dir === "out") await postRelayControl(rp, t, "cancel").catch(() => {});
        }
      }
    } catch {}
    remoteReportRelay(t);
  }
}

/** 插话：调用方在远程轮次进行中又发了一条 —— 直接注入执行端正在跑的那一轮。
 *  只有「执行端为本体」（网关托管）的轮次能插；一次性任务只能等它结束。 */
async function remoteInjectTask(t, text) {
  const msg = mapPathString(String(text || "").trim(), peerPathMap(t && t.from));
  if (!msg) return { ok: false, error: "插话内容为空" };
  if (!t || REMOTE_TERMINAL.has(t.status)) return { ok: false, error: "这一轮已经结束了" };
  if (!t.gwRunId) return { ok: false, error: "这一轮是一次性任务，不能插话" };
  try {
    const r = await fetch(gatewayHttp() + "/api/chat", {
      method: "POST", headers: gatewayHeaders(), signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ message: msg, sessionId: t.sessionId, mode: "inject" }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: j.message || j.error || `HTTP ${r.status}` };
    return { ok: true, injected: !!j.injected, queued: !j.injected, id: j.id || "" };
  } catch (e) { return { ok: false, error: e.message }; }
}

/** 中转链路上的控制消息（插话 / 停止）：没有长连接，只能借任务信箱捎一封 */
async function postRelayControl(rp, t, action, text) {
  const id = "ctl-" + crypto.randomUUID();
  await peerFetch(rp, "POST", "/api/relay/task", {
    body: JSON.stringify({
      id, to: t.toId, kind: "control", action, targetTaskId: t.id,
      text: String(text || "").slice(0, 16000), prompt: "control", timeout: 120,
      from: { id: state.deviceId, name: state.deviceName, kind: SELF_KIND, platform: process.platform },
    }),
    timeout: 15000,
  });
}

async function remotePollRelay() {
  if (remotePolling) return;
  if (!relayReady()) return;
  const rp = relayPeer();
  if (!rp) return;
  remotePolling = true;
  try {
    if (Date.now() - remoteDevicesAt > 15000) {
      remoteDevicesAt = Date.now();
      try {
        await peerFetch(rp, "POST", "/api/relay/device", { body: JSON.stringify({ id: state.deviceId, name: state.deviceName, kind: SELF_KIND, platform: process.platform, caps: selfCaps(), at: Date.now() }), timeout: 10000 });
        const d = await peerFetch(rp, "GET", "/api/relay/devices", { timeout: 10000 });
        if (d && Array.isArray(d.devices)) { state.remote.relayDevices = d.devices.filter((x) => x && x.id); saveSoon(500); }
      } catch {}
    }
    if (!state.remote.enabled) return;
    const inbox = await peerFetch(rp, "GET", `/api/relay/tasks?to=${encodeURIComponent(state.deviceId)}&status=queued`, { timeout: 15000 });
    for (const task of (inbox && inbox.tasks) || []) {
      try {
        if (!task || remoteTasks.has(task.id)) continue;
        // 控制消息：插话 / 停止。对端在远程轮次里发来的，落到本机正在跑的那一轮上。
        if (task.kind === "control") {
          if (!remoteAllowed(task.from && task.from.id)) continue;
          const claim = await peerFetch(rp, "POST", `/api/relay/task/${encodeURIComponent(task.id)}/claim`, { body: JSON.stringify({ by: state.deviceId }), timeout: 10000 });
          if (!claim || claim.status !== "running") continue;
          const t = remoteTasks.get(String(task.targetTaskId || ""));
          let out = { ok: false, error: "找不到这一轮" };
          if (!t) out = { ok: false, error: "找不到这一轮" };
          else if (task.action === "inject") out = await remoteInjectTask(t, task.text);
          else if (task.action === "cancel") { await remoteCancelTask(t, false); out = { ok: true }; }
          await peerFetch(rp, "POST", `/api/relay/task/${encodeURIComponent(task.id)}`, {
            body: JSON.stringify({ status: out.ok ? "done" : "error", result: JSON.stringify(out), error: out.ok ? "" : out.error, progress: "" }), timeout: 10000,
          }).catch(() => {});
          continue;
        }
        if (!remoteAllowed(task.from && task.from.id)) {
          await peerFetch(rp, "POST", `/api/relay/task/${encodeURIComponent(task.id)}`, { body: JSON.stringify({ status: "error", error: "对端没有允许这台设备执行远程任务", result: "" }), timeout: 10000 });
          continue;
        }
        const claim = await peerFetch(rp, "POST", `/api/relay/task/${encodeURIComponent(task.id)}/claim`, { body: JSON.stringify({ by: state.deviceId }), timeout: 10000 });
        if (!claim || claim.status !== "running") continue;
        remoteAccept(task, { ...(task.from || {}), via: "relay" });
      } catch (e) { log("接收中转任务失败: " + e.message); }
    }
  } catch (e) {
    // 中转不可用时不刷日志
  } finally {
    remotePolling = false;
  }
}

remoteLoad();

// ── 同步 ──────────────────────────────────────────────────────────────
const syncing = new Map();

function isActive(ms, now = Date.now()) {
  return now - Number(ms || 0) < state.settings.activeSec * 1000;
}
function addConflict(peer, local, remote) {
  const c = {
    peer: peer.id, peerName: peer.name,
    id: local ? local.id : remote.id,
    title: (local && local.title) || (remote && remote.title) || "",
    localMtime: local ? local.mtime : 0,
    remoteMtime: remote ? remote.mtime : 0,
    at: Date.now(),
  };
  state.conflicts = state.conflicts.filter((x) => !(x.peer === c.peer && x.id === c.id));
  state.conflicts.push(c);
  if (state.conflicts.length > 80) state.conflicts = state.conflicts.slice(-80);
}
function clearConflict(peerId, id) {
  state.conflicts = state.conflicts.filter((x) => !(x.peer === peerId && x.id === id));
}

/** 一个会话包能带多少内容产物。同时受「产物上限」和「单个会话上限」卡着：
 *  50 MB 的 transcript 再加 24 MB 文件会把中转的 64 MB 限制撑破。 */
function packArtifacts(entrySize = 0) {
  const artMB = Number(state.settings.artifactMB) || 0;
  if (!artMB) return null;
  const room = state.settings.maxMB * 1024 * 1024 - Number(entrySize || 0);
  const maxTotal = Math.min(artMB * 1024 * 1024, Math.max(0, room));
  if (maxTotal < 64 * 1024) return null;
  return { maxTotal, maxFile: Math.min(8 * 1024 * 1024, maxTotal) };
}

/** 记下这个会话已经带着产物同步过，避免每次同步都去补拉 */
function markArtifacts(peerId, id) {
  const led = state.ledger[peerId] || (state.ledger[peerId] = {});
  led[id] = Object.assign(led[id] || {}, { art: 1 });
}

async function pullOne(peer, remote, mapCwd, idx, pathMap) {
  const { buf } = await peerFetch(peer, "GET", `/api/peer/session/${encodeURIComponent(remote.id)}`, { timeout: 60000, raw: true });
  const out = unpackSession(PATHS, buf, { mapCwd, pathMap });
  applyIncomingOrigin(out.id, out.meta, peer);
  if (out.meta && out.meta.renamed && out.meta.title) await applyName(out.id, out.meta.title);
  if (out.meta && out.meta.pinned) await applyPin(out.id, out.meta.pinned);
  markArtifacts(peer.id, out.id);
  if (out.artifacts && out.artifacts.written) log(`收到产物 ${out.id.slice(0, 8)} ← ${peer.name}（${out.artifacts.written} 个文件，${Math.round(out.artifacts.bytes / 1024)} KB）`);
  return out;
}

async function pushOne(peer, entry, { force = false } = {}) {
  const max = state.settings.maxMB * 1024 * 1024;
  if (entry.size > max) throw Object.assign(new Error("too big"), { status: 413 });
  const { buf } = packSession(PATHS, entry, { maxBytes: Math.max(max, 64 * 1024 * 1024), origin: originOf(entry.id) || selfOrigin(), artifacts: packArtifacts(entry.size) });
  if (buf.length > max * 3 + 20 * 1024 * 1024) throw Object.assign(new Error("too big"), { status: 413 });
  const q = new URLSearchParams();
  if (force) q.set("force", "1");
  if (PATHS.workspace) q.set("peerWorkspace", PATHS.workspace);
  const headers = { "content-type": "application/zip" };
  // 中转不解 zip：清单字段单独放在头里（对端仍从 zip 里的 manifest 取）
  if (peer.relay) {
    // 头只能是 ASCII：标题/路径可能是中文，整段 URI 编码再放进去
    headers["x-link-meta"] = encodeURIComponent(JSON.stringify({
      id: entry.id, title: entry.title, renamed: entry.renamed, cwd: entry.cwd,
      mtime: entry.mtime, size: entry.size, pinned: entry.pinned, created: entry.created,
      origin: originOf(entry.id) || selfOrigin(),
    }));
  }
  const r = await peerFetch(peer, "POST", `/api/peer/session/${encodeURIComponent(entry.id)}?${q}`, {
    body: buf, headers, timeout: 120000,
  });
  markArtifacts(peer.id, entry.id);
  return r;
}

async function syncPeer(peer, { manual = false } = {}) {
  if (syncing.has(peer.id)) return syncing.get(peer.id);
  const job = (async () => {
    const started = Date.now();
    const result = { peer: peer.id, peerName: peer.name, at: started, pulled: [], pushed: [], conflicts: [], skipped: [], errors: [], deferred: 0 };
    let metaChanged = false;
    const idx = new SessionIndex(PATHS).scan(true);
    const local = new Map(idx.list(5000).map((e) => [e.id, e]));
    const localTrash = trashIds(PATHS);
    let manifest;
    try {
      manifest = await peerFetch(peer, "GET", "/api/peer/manifest", { timeout: 20000 });
    } catch (e) {
      peer.lastError = e.message;
      peer.lastSeen = peer.lastSeen || 0;
      throw e;
    }
    if (!manifest || manifest.format !== "cccodroid-link-manifest") throw new Error("对端不是互联服务");
    if (manifest.device && manifest.device.platform && peer.platform !== manifest.device.platform) {
      peer.platform = String(manifest.device.platform).slice(0, 20);
      saveSoon(500);
    }
    const remoteList = Array.isArray(manifest.sessions) ? manifest.sessions : [];
    const remote = new Map(remoteList.map((s) => [s.id, s]));
    const remoteTrash = new Set(Array.isArray(manifest.trash) ? manifest.trash : []);
    const mapCwd = makeCwdMapper(PATHS, manifest.workspace);
    // 对端目录布局来自 manifest（局域网 / 直连）；经中转时 manifest 没有，会话包里的 from 兜底
    const pathMap = makePathMap(PATHS, { workspace: manifest.workspace, home: manifest.home });
    const ledger = state.ledger[peer.id] || (state.ledger[peer.id] = {});
    const max = state.settings.maxMB * 1024 * 1024;
    const now = Date.now();
    peer.lastSeen = now;

    // 对端会话：只在本地没有、或本地更旧时拉
    for (const r of remoteList) {
      if (!SID_RE.test(String(r.id || ""))) continue;
      const l = local.get(r.id);
      if (!l) {
        if (localTrash.has(r.id)) { result.skipped.push({ id: r.id, why: "trash" }); continue; }
        if (r.size > max) { result.skipped.push({ id: r.id, why: "big" }); continue; }
        if (isActive(r.mtime, now)) { result.deferred++; continue; }
        try {
          const out = await pullOne(peer, r, mapCwd, idx, pathMap);
          ledger[r.id] = { lmt: out.mtime, lsz: out.size, rmt: r.mtime, rsz: r.size, at: Date.now() };
          result.pulled.push({ id: r.id, title: out.title || r.title, size: r.size });
        } catch (e) { result.errors.push(`${r.id.slice(0, 8)}: ${e.message}`); }
        continue;
      }
      if (isActive(l.mtime, now) || isActive(r.mtime, now)) { result.deferred++; continue; }
      const base = ledger[r.id];
      if (base && base.lmt === l.mtime && base.lsz === l.size && base.rmt === r.mtime && base.rsz === r.size) continue;
      if (r.size > max) { result.skipped.push({ id: r.id, why: "big" }); continue; }

      if (l.mtime > r.mtime + SKEW) {
        // 本机更新：推过去
        try {
          const st = await pushOne(peer, l);
          ledger[r.id] = { lmt: l.mtime, lsz: l.size, rmt: st.mtime, rsz: st.size, at: Date.now() };
          result.pushed.push({ id: r.id, title: l.title, size: l.size });
        } catch (e) {
          if (e.status === 409 || (e.status === 0 && /超时/.test(e.message))) {
            // 对端刚改过 / 断在半路：重新拉一次清单里的版本，按时间判断
            try {
              const m2 = await peerFetch(peer, "GET", "/api/peer/manifest", { timeout: 15000 });
              const r2 = (m2.sessions || []).find((x) => x.id === r.id);
              if (r2 && r2.mtime > l.mtime + SKEW) {
                const out = await pullOne(peer, r2, mapCwd, idx, pathMap);
                ledger[r.id] = { lmt: out.mtime, lsz: out.size, rmt: r2.mtime, rsz: r2.size, at: Date.now() };
                result.pulled.push({ id: r.id, title: out.title || r2.title, size: r2.size });
              } else if (r2) {
                addConflict(peer, l, r2);
                result.conflicts.push({ id: r.id, title: l.title });
              }
            } catch (e2) { result.errors.push(`${r.id.slice(0, 8)}: ${e2.message}`); }
          } else if (e.status === 413) {
            result.skipped.push({ id: r.id, why: "big" });
          } else {
            result.errors.push(`${r.id.slice(0, 8)}: ${e.message}`);
          }
        }
        continue;
      }
      if (r.mtime > l.mtime + SKEW) {
        // 对端更新：拉过来（先备份本机）
        try {
          const out = await pullOne(peer, r, mapCwd, idx, pathMap);
          ledger[r.id] = { lmt: out.mtime, lsz: out.size, rmt: r.mtime, rsz: r.size, at: Date.now() };
          result.pulled.push({ id: r.id, title: out.title || r.title, size: r.size });
        } catch (e) { result.errors.push(`${r.id.slice(0, 8)}: ${e.message}`); }
        continue;
      }

      // 时间差在 2 秒内：按内容判断
      try {
        const { buf } = await peerFetch(peer, "GET", `/api/peer/session/${encodeURIComponent(r.id)}`, { timeout: 60000, raw: true });
        const files = zipRead(buf);
        const main = files.find((f) => f.name === "session.jsonl");
        if (!main) throw new Error("对端会话包缺 session.jsonl");
        // 中转对端没有 manifest 的目录信息时，从 zip 里的 from 取；哈希前按同样的规则映射路径
        let pm = pathMap;
        if (!pm.length) {
          const mf = files.find((f) => f.name === "manifest.json");
          if (mf) {
            try {
              const man = JSON.parse(mf.data.toString("utf8"));
              const from = man.from && typeof man.from === "object" ? man.from : {};
              const lc = mapCwd(r.cwd || man.session?.cwd || "");
              pm = makePathMap(PATHS, { workspace: from.workspace, home: from.home }, (r.cwd || man.session?.cwd) && lc ? [[r.cwd || man.session.cwd, lc]] : []);
            } catch {}
          }
        }
        const lh = normalizedHash(fs.readFileSync(l.file));
        const rh = normalizedHash(main.data, pm);
        if (lh === rh) {
          ledger[r.id] = { lmt: l.mtime, lsz: l.size, rmt: r.mtime, rsz: r.size, at: Date.now() };
          continue;
        }
        addConflict(peer, l, r);
        result.conflicts.push({ id: r.id, title: l.title });
      } catch (e) { result.errors.push(`${r.id.slice(0, 8)}: ${e.message}`); }
    }

    // 本机会话：对端没有、也不是以前同步过后被对端删掉的，推过去
    for (const l of local.values()) {
      if (remote.has(l.id)) continue;
      if (remoteTrash.has(l.id)) { result.skipped.push({ id: l.id, why: "remote-trash" }); continue; }
      if (ledger[l.id]) { result.skipped.push({ id: l.id, why: "deleted" }); continue; }
      if (l.size > max) { result.skipped.push({ id: l.id, why: "big" }); continue; }
      if (isActive(l.mtime, now)) { result.deferred++; continue; }
      try {
        const st = await pushOne(peer, l);
        ledger[l.id] = { lmt: l.mtime, lsz: l.size, rmt: st.mtime, rsz: st.size, at: Date.now() };
        result.pushed.push({ id: l.id, title: l.title, size: l.size });
      } catch (e) {
        if (e.status === 409) result.skipped.push({ id: l.id, why: "changed" });
        else if (e.status === 413) result.skipped.push({ id: l.id, why: "big" });
        else result.errors.push(`${l.id.slice(0, 8)}: ${e.message}`);
      }
    }

    // 内容产物补拉：升级前就同步过的会话不会再变，也就不会重新打包，工作区里
    // 的文件一直缺着（点开就是「文件不存在」）。每次同步挑一两个补一次，补完打标记。
    let artBudget = 2;
    for (const r of remoteList) {
      if (artBudget <= 0) break;
      const l = local.get(r.id);
      const led = ledger[r.id];
      if (!l || !led || led.art) continue;
      if (r.size > max || !state.settings.artifactMB) { led.art = 1; continue; }
      artBudget--;
      try {
        const { buf } = await peerFetch(peer, "GET", `/api/peer/session/${encodeURIComponent(r.id)}`, { timeout: 60000, raw: true });
        const files = zipRead(buf);
        const idxF = files.find((f) => f.name === "artifacts.json");
        const got = idxF ? unpackArtifacts(PATHS, files, idxF.data) : { written: 0, bytes: 0, total: 0 };
        led.art = 1;
        if (got.written) {
          result.artifacts = (result.artifacts || 0) + got.written;
          log(`补拉产物 ${r.id.slice(0, 8)} ← ${peer.name}（${got.written} 个文件，${Math.round(got.bytes / 1024)} KB）`);
          saveSoon(500);
        }
      } catch (e) { led.art = 1; result.errors.push(`art ${r.id.slice(0, 8)}: ${e.message}`); }
    }

    // 名称与置顶：文件时间新的那边为准
    try {
      const localNamesM = (statSafe(PATHS.names) || {}).mtimeMs || 0;
      const remoteNamesM = Number(manifest.namesMtime) || 0;
      if (remoteNamesM > localNamesM + 1000) {
        const localNames = readJson(PATHS.names, {});
        const names = manifest.names && typeof manifest.names === "object" ? manifest.names : {};
        let n = 0;
        for (const [id, title] of Object.entries(names)) {
          if (!SID_RE.test(id) || !title) continue;
          if (localNames[id] === title) continue;
          if (n++ > 200) break;
          await applyName(id, title);
          metaChanged = true;
        }
      }
      const localPinsM = (statSafe(PATHS.pins) || {}).mtimeMs || 0;
      if (remoteNamesM > localNamesM + 1000 || (Number(manifest.pinsMtime) || 0) > localPinsM + 1000) {
        const pins = manifest.pins && typeof manifest.pins === "object" ? manifest.pins : {};
        const localPins = readJson(PATHS.pins, {});
        for (const [id, ts] of Object.entries(pins)) {
          if (!SID_RE.test(id)) continue;
          if ((Number(ts) || 0) > (Number(localPins[id]) || 0) + 1000) {
            await applyPin(id, ts);
            metaChanged = true;
          }
        }
      } else if (localNamesM > remoteNamesM + 1000) {
        // 本机名字更新：推给对端（对端按同样的规则应用）
        try {
          await peerFetch(peer, "POST", "/api/peer/meta", {
            body: JSON.stringify({
              names: readJson(PATHS.names, {}),
              pins: readJson(PATHS.pins, {}),
              namesMtime: localNamesM,
              pinsMtime: localPinsM,
            }),
            headers: { "content-type": "application/json" },
            timeout: 15000,
          });
        } catch {}
      }
    } catch (e) { result.errors.push("名称/置顶: " + e.message); }

    // 中转不参与局域网清单：把本机回收站推给它，其他设备就不会把已删的会话搬回来
    if (peer.relay) {
      try {
        const trash = [...trashIds(PATHS)].slice(0, 5000);
        const sig = crypto.createHash("sha1").update(trash.join(",")).digest("hex").slice(0, 12);
        if (sig !== state.relay.trashSig) {
          await peerFetch(peer, "POST", "/api/peer/meta", {
            body: JSON.stringify({ trash }),
            headers: { "content-type": "application/json" },
            timeout: 15000,
          });
          state.relay.trashSig = sig;
        }
      } catch (e) { result.errors.push("回收站: " + e.message); }
    }

    peer.lastSeen = Date.now();
    peer.lastSync = Date.now();
    peer.lastError = result.errors.length ? result.errors[0] : "";
    const skippedWhy = {};
    for (const x of result.skipped) skippedWhy[x.why] = (skippedWhy[x.why] || 0) + 1;
    peer.lastResult = {
      at: result.at,
      pulled: result.pulled.length,
      pushed: result.pushed.length,
      conflicts: result.conflicts.length,
      skipped: result.skipped.length,
      skippedWhy,
      deferred: result.deferred,
      errors: result.errors.length,
      sample: result.pulled.slice(0, 3).concat(result.pushed.slice(0, 3)).map((x) => x.title).filter(Boolean),
    };
    result.duration = Date.now() - started;
    log(`同步 ${peer.name}: 拉 ${result.pulled.length} 推 ${result.pushed.length} 冲突 ${result.conflicts.length} 跳过 ${result.skipped.length} 延迟 ${result.deferred} 错误 ${result.errors.length}${manual ? "（手动）" : ""}`);
    if (result.errors.length) log("  错误: " + result.errors.slice(0, 3).join("; "));
    saveSoon(100);
    if (result.pulled.length || metaChanged) {
      notifyGatewayLink(peer, { pulled: result.pulled.length, pushed: result.pushed.length, meta: metaChanged });
    }
    return result;
  })();
  syncing.set(peer.id, job);
  try { return await job; }
  finally { syncing.delete(peer.id); if (peer.relay) saveRelayStats(peer); }
}

function lanPeerOnline() {
  return state.lan.enabled && state.peers.some((p) => Date.now() - (p.lastSeen || 0) < ALIVE_MS);
}
async function syncAll(manual = false) {
  const rp = relayPeer();
  if (!state.lan.enabled && !rp) return [];
  // 局域网优先：有在线局域网对端时自动同步不再走中转（手动「全部同步」仍然两边都对齐）
  const useRelay = !!rp && (manual || !lanPeerOnline());
  const list = [...(state.lan.enabled ? state.peers : []), ...(useRelay ? [rp] : [])]
    .filter((p) => manual || (p.autoSync !== false && state.settings.autoSync));
  const out = [];
  for (const p of list) {
    try { out.push(await syncPeer(p, { manual })); }
    catch (e) { p.lastError = e.message; if (p.relay) saveRelayStats(p); out.push({ peer: p.id, error: e.message }); }
  }
  return out;
}

// 中转长轮询：平时挂着一个 25 秒的请求，服务器一有变化就立刻醒。
let relayRev = 0, relayEventRunning = false, relaySyncTimer = null;
function maybeSyncRelay() {
  const rp = relayPeer();
  if (!rp || !state.settings.autoSync || lanPeerOnline() || relaySyncTimer) return;
  relaySyncTimer = setTimeout(() => {
    relaySyncTimer = null;
    syncPeer(rp).catch((e) => log("中转同步: " + e.message));
  }, 600);
}
async function relayEventsLoop() {
  if (relayEventRunning) return;
  relayEventRunning = true;
  try {
    while (relayReady()) {
      const rp = relayPeer();
      if (!rp) break;
      try {
        const r = await peerFetch(rp, "GET", `/api/relay/events?since=${relayRev}&wait=25`, { timeout: 35000 });
        if (!r) { await sleep(3000); continue; }
        if (r.kind === "reset" || Number(r.rev) < relayRev) {
          relayRev = 0;
          maybeSyncRelay();
          continue;
        }
        relayRev = Number(r.rev) || relayRev;
        if (r.kind === "task") remotePollRelay().catch(() => {});
        else if (r.kind === "sessions") maybeSyncRelay();
      } catch (e) {
        await sleep(4000);
      }
    }
  } finally {
    relayEventRunning = false;
  }
}

// 新会话 / 会话被删除：8 秒扫一次文件名，变化后 2.5 秒再同步（避开正在写的瞬间）
let sessionKnown = null, sessionSyncTimer = null;
function scanProjectFiles() {
  const out = new Set();
  try {
    for (const d of fs.readdirSync(PATHS.projects)) {
      const dir = path.join(PATHS.projects, d);
      let names = [];
      try { names = fs.readdirSync(dir); } catch { continue; }
      for (const n of names) if (n.endsWith(".jsonl")) out.add(path.join(dir, n));
    }
  } catch {}
  return out;
}
function startSessionWatch() {
  sessionKnown = scanProjectFiles();
  setInterval(() => {
    const now = scanProjectFiles();
    let changed = now.size !== sessionKnown.size;
    if (!changed) for (const f of now) if (!sessionKnown.has(f)) { changed = true; break; }
    sessionKnown = now;
    if (!changed || !state.settings.autoSync) return;
    if (sessionSyncTimer) clearTimeout(sessionSyncTimer);
    sessionSyncTimer = setTimeout(() => { sessionSyncTimer = null; syncAll(false).catch((e) => log("新会话同步: " + e.message)); }, 2500);
  }, 8000);
}

// ── 配对 ──────────────────────────────────────────────────────────────
const pairRL = new Map();
function pairAllowed(ip) {
  const now = Date.now();
  let e = pairRL.get(ip);
  if (!e || now - e.at > 60000) { e = { at: now, n: 0 }; pairRL.set(ip, e); }
  e.n++;
  return e.n <= 12;
}
function newCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}
function startCode() {
  const code = newCode();
  state.pairing = { code, exp: Date.now() + 10 * 60 * 1000, tries: 0 };
  saveSoon(50);
  return state.pairing;
}
function clearCode() { state.pairing = null; saveSoon(50); }

async function pairWith(addr, port, code) {
  const info = {
    code: String(code || "").trim(), id: state.deviceId, name: state.deviceName,
    port: LAN_PORT, platform: process.platform, kind: SELF_KIND,
  };
  const url = `http://${hostFor(addr)}:${port}/api/pair`;
  let r;
  try {
    r = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(info), signal: AbortSignal.timeout(15000),
    });
  } catch (e) { throw new Error(`连不上 ${addr}:${port}`); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) throw new Error(data.error === "bad-code" ? "配对码不对或已过期" : (data.error || `HTTP ${r.status}`));
  const peer = {
    id: data.self.id, name: data.self.name || "设备", addr, port,
    secret: data.secret, pairedAt: Date.now(), lastSeen: Date.now(),
    autoSync: true, lastSync: 0, lastError: "",
  };
  if (data.self.kind === "phone" || data.self.kind === "pc") peer.kind = data.self.kind;
  if (data.self.platform) peer.platform = String(data.self.platform);
  const old = state.peers.findIndex((p) => p.id === peer.id);
  if (old >= 0) state.peers[old] = { ...state.peers[old], ...peer };
  else state.peers.push(peer);
  saveNow();
  log(`已配对：${peer.name} @ ${addr}:${port}`);
  return peer;
}

// ── 管理接口 ──────────────────────────────────────────────────────────
function statusObj() {
  const now = Date.now();
  return {
    ok: true,
    v: VERSION,
    device: { id: state.deviceId, name: state.deviceName, platform: process.platform, kind: SELF_KIND, host: os.hostname(), workspace: PATHS.workspace, home: HOME, uptime: Math.round((now - START_AT) / 1000) },
    ports: { local: LOCAL_PORT, lan: LAN_PORT, udp: UDP_PORT, gateway: GATEWAY_PORT },
    lan: { enabled: !!state.lan.enabled, running: !!lanServer, ips: localIPs(), error: lanError },
    pairing: state.pairing && state.pairing.exp > now ? { code: state.pairing.code, expiresAt: state.pairing.exp } : null,
    discovered: [...discovered.values()].filter((d) => now - d.at < DISCOVER_MS).map((d) => ({ id: d.id, name: d.name, addr: d.addr, port: d.port, at: d.at })),
    peers: state.peers.map((p) => ({
      id: p.id, name: p.name, addr: p.addr, port: p.port,
      platform: p.platform || "", kind: p.kind || kindOfPlatform(p.platform),
      online: now - (p.lastSeen || 0) < ALIVE_MS,
      lastSeen: p.lastSeen || 0, lastSync: p.lastSync || 0, lastError: p.lastError || "",
      lastResult: p.lastResult || null, autoSync: p.autoSync !== false, pairedAt: p.pairedAt || 0,
    })),
    relay: {
      enabled: !!state.relay.enabled,
      configured: !!(state.relay.url && state.relay.token),
      url: state.relay.url, name: state.relay.name,
      online: now - (state.relay.lastSeen || 0) < ALIVE_MS,
      lastSeen: state.relay.lastSeen || 0, lastSync: state.relay.lastSync || 0,
      lastError: state.relay.lastError || "", lastResult: state.relay.lastResult || null,
    },
    remote: {
      enabled: !!state.remote.enabled, allow: state.remote.allow, maxRunning: state.remote.maxRunning,
      targets: remoteTargets(), tasks: remoteRecent(8),
    },
    settings: state.settings,
    syncRunning: [...syncing.keys()],
    conflicts: state.conflicts.slice(-30),
  };
}

function serveUi(req, res) {
  if (!hostOK(req) || !originOK(req) || !localAuthed(req, new URL(req.url, `http://127.0.0.1:${LOCAL_PORT}`))) {
    return sendText(res, 403, "forbidden");
  }
  let html = "";
  try { html = fs.readFileSync(path.join(HERE, "ui.html"), "utf8"); } catch (e) {
    return sendText(res, 500, "ui.html 不见了: " + e.message);
  }
  sendText(res, 200, html, "text/html; charset=utf-8");
}

async function handle(req, res) {
  const isLan = req.socket.localPort === LAN_PORT;
  if (!hostOK(req)) { req.resume(); return sendJson(res, 421, { error: "bad host" }); }
  if (!originOK(req)) { req.resume(); return sendJson(res, 403, { error: "bad origin" }); }
  const ip = remoteIP(req);
  if (isLan && !isPrivateIP(ip)) { req.resume(); return sendJson(res, 403, { error: "private network only" }); }

  // 本机工作台页面跨端口读接口：带上 CORS 头（只对白名单来源）
  if (!isLan && req.headers.origin && originOK(req)) {
    res.setHeader("access-control-allow-origin", String(req.headers.origin));
    res.setHeader("access-control-allow-credentials", "true");
    res.setHeader("vary", "Origin");
  }
  if (!isLan && req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": originOK(req) ? String(req.headers.origin || "") : "null",
      "access-control-allow-credentials": "true",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type, x-cc-token, x-link-token",
      "access-control-max-age": "600",
      vary: "Origin",
    });
    return res.end();
  }

  let u;
  try { u = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`); } catch { req.resume(); return sendJson(res, 400, { error: "bad request" }); }
  const p = u.pathname;

  try {
    if (req.method === "GET" && (p === "/" || p === "/ui.html")) {
      if (isLan) return sendText(res, 404, "not found");
      return serveUi(req, res);
    }
    if (req.method === "GET" && p === "/favicon.ico") { res.writeHead(204); return res.end(); }
    if (!isLan && req.method === "GET" && p === "/api/health") return sendJson(res, 200, { ok: true, name: state.deviceName, id: state.deviceId, v: VERSION });

    // ── 局域网：配对（未配对时唯一的入口）──
    if (isLan && p === "/api/pair" && req.method === "POST") {
      if (!pairAllowed(ip)) return sendJson(res, 429, { error: "too many attempts" });
      const b = await jsonBody(req, 32 * 1024);
      const code = String(b.code || "").trim();
      const id = String(b.id || "");
      if (!/^[A-Za-z0-9._-]{8,64}$/.test(id)) return sendJson(res, 400, { error: "bad id" });
      if (!state.pairing || state.pairing.exp < Date.now()) { clearCode(); return sendJson(res, 403, { error: "bad-code" }); }
      if (String(state.pairing.code) !== code) {
        state.pairing.tries = (state.pairing.tries || 0) + 1;
        if (state.pairing.tries >= 5) { log("配对码错误次数太多，已作废"); clearCode(); }
        else saveSoon(50);
        return sendJson(res, 403, { error: "bad-code" });
      }
      const name = String(b.name || "设备").trim().slice(0, 60) || "设备";
      const port = toPort(b.port, LAN_PORT);
      const secret = crypto.randomBytes(32).toString("hex");
      const np = { id, name, addr: ip, port, secret, pairedAt: Date.now(), lastSeen: Date.now(), autoSync: true, lastSync: 0, lastError: "" };
      if (b.kind === "phone" || b.kind === "pc") np.kind = b.kind;
      if (b.platform) np.platform = String(b.platform).slice(0, 20);
      const old = state.peers.findIndex((x) => x.id === id);
      if (old >= 0) state.peers[old] = { ...state.peers[old], ...np };
      else state.peers.push(np);
      clearCode(); saveNow();
      log(`配对请求来自 ${name} @ ${ip}:${port}，已接受`);
      return sendJson(res, 200, {
        ok: true, secret, peer: { id, name },
        self: {
          id: state.deviceId, name: state.deviceName, addr: req.socket.localAddress,
          port: LAN_PORT, platform: process.platform, kind: SELF_KIND,
        },
      });
    }

    // ── 本机管理接口 ──
    if (!isLan) {
      if (!localAuthed(req, u)) { req.resume(); return sendJson(res, 403, { error: "forbidden" }); }
      return await handleLocal(req, res, u, p);
    }

    // ── 局域网：已配对设备 ──
    const peer = peerBySecret(req);
    if (!peer) { req.resume(); return sendJson(res, 401, { error: "unauthorized" }); }
    return await handlePeer(req, res, u, p, peer);
  } catch (e) {
    const code = e.status && e.status >= 400 ? e.status : 500;
    if (code >= 500) log(`请求异常 ${req.method} ${p}: ${e.stack || e.message}`);
    if (!res.headersSent) sendJson(res, code, { error: e.message });
    else res.end();
  }
}

async function handleLocal(req, res, u, p) {
  if (req.method === "POST" && p === "/api/shutdown") {
    sendJson(res, 200, { ok: true });
    saveNow();
    stopLan();
    setTimeout(() => process.exit(0), 80).unref?.();
    return;
  }
  if (req.method === "GET" && p === "/api/status") return sendJson(res, 200, statusObj());

  // 工作台读这个给会话列表标「手机 / 电脑」；只返回来源，不碰会话内容
  if (req.method === "GET" && p === "/api/origins") {
    const origins = {};
    for (const [id, o] of Object.entries(state.origins)) {
      if (!o || (o.kind !== "phone" && o.kind !== "pc")) continue;
      origins[id] = { kind: o.kind, name: o.name || "", platform: o.platform || "", at: o.at || 0 };
    }
    return sendJson(res, 200, {
      ok: true,
      self: { id: state.deviceId, name: state.deviceName, kind: SELF_KIND, platform: process.platform },
      origins,
      rev: state.historyRev,
      revAt: state.historyAt,
    });
  }

  if (req.method === "GET" && p === "/api/local") {
    const idx = new SessionIndex(PATHS).scan(true);
    const list = idx.list(5000);
    let bytes = 0; for (const e of list) bytes += e.size;
    return sendJson(res, 200, { count: list.length, bytes, sessions: list.slice(0, 2100).map((e) => ({ id: e.id, title: e.title, mtime: e.mtime, size: e.size, cwd: e.cwd, renamed: e.renamed, pinned: e.pinned })) });
  }

  if (req.method === "POST" && p === "/api/lan") {
    const b = await jsonBody(req);
    state.lan.enabled = !!b.enabled;
    saveNow();
    if (state.lan.enabled) startLan(); else stopLan();
    return sendJson(res, 200, statusObj());
  }

  if (req.method === "POST" && p === "/api/settings") {
    const b = await jsonBody(req);
    if (b.deviceName !== undefined) {
      const n = String(b.deviceName || "").trim().slice(0, 60);
      if (n) state.deviceName = n;
    }
    if (b.autoSync !== undefined) state.settings.autoSync = !!b.autoSync;
    if (b.interval !== undefined) state.settings.interval = Math.max(10000, Math.min(600000, Number(b.interval) || 30000));
    if (b.maxMB !== undefined) state.settings.maxMB = Math.max(1, Math.min(256, Number(b.maxMB) || 64));
    if (b.activeSec !== undefined) state.settings.activeSec = Math.max(30, Math.min(3600, Number(b.activeSec) || 180));
    if (b.artifactMB !== undefined) state.settings.artifactMB = Math.max(0, Math.min(256, Number(b.artifactMB) || 0));
    saveNow();
    scheduleAuto();
    return sendJson(res, 200, statusObj());
  }

  // ── 公网中转：填地址 + 令牌就能用，不需要配对码、不需要开局域网 ──
  if (req.method === "POST" && p === "/api/relay") {
    const b = await jsonBody(req);
    if (b.url !== undefined) {
      const url = String(b.url || "").trim().replace(/\/+$/, "");
      if (url) {
        let uu;
        try { uu = new URL(url); } catch { return sendJson(res, 400, { error: "地址格式不对" }); }
        if (!/^https?:$/.test(uu.protocol)) return sendJson(res, 400, { error: "地址要用 http:// 或 https://" });
      }
      state.relay.url = url;
    }
    if (b.token !== undefined) {
      const token = String(b.token || "").trim();
      if (token && !/^[A-Za-z0-9._~+/=-]{16,200}$/.test(token)) return sendJson(res, 400, { error: "令牌格式不对" });
      state.relay.token = token;
    }
    if (b.name !== undefined) state.relay.name = String(b.name || "公网中转").trim().slice(0, 60) || "公网中转";
    if (b.enabled !== undefined) state.relay.enabled = !!b.enabled;
    else if (state.relay.url && state.relay.token) state.relay.enabled = true;
    if (!(state.relay.url && state.relay.token)) state.relay.enabled = false;
    state.relay.id = "";
    state.relay.lastError = "";
    state.relay.trashSig = "";
    relayRev = 0;                       // 换了服务器，事件序号从 0 重新对
    if (relaySyncTimer) { clearTimeout(relaySyncTimer); relaySyncTimer = null; }
    saveNow();
    const rp = relayPeer();
    if (rp) {
      saveSoon(100);
      syncPeer(rp, { manual: true }).catch(() => {});
      relayEventsLoop().catch(() => {});
    }
    return sendJson(res, 200, statusObj());
  }

  if (req.method === "POST" && p === "/api/relay/test") {
    const b = await jsonBody(req);
    const url = String(b.url !== undefined ? b.url : state.relay.url).trim().replace(/\/+$/, "");
    const token = String(b.token !== undefined ? b.token : state.relay.token).trim();
    if (!/^https?:\/\//i.test(url) || !token) return sendJson(res, 200, { ok: false, error: "先填地址和令牌" });
    const peer = { id: "relay-test", name: "test", relay: true, url, addr: "", port: 0, secret: token };
    try {
      const r = await peerFetch(peer, "GET", "/api/peer/ping", { timeout: 12000 });
      return sendJson(res, 200, { ok: true, relay: r });
    } catch (e) { return sendJson(res, 200, { ok: false, error: e.message }); }
  }

  if (req.method === "POST" && p === "/api/relay/off") {
    state.relay.enabled = false;
    relayRev = 0;
    if (relaySyncTimer) { clearTimeout(relaySyncTimer); relaySyncTimer = null; }
    saveNow();
    return sendJson(res, 200, statusObj());
  }

  // ── 远程执行（本机接口：管理页 / MCP 工具）──
  if (req.method === "GET" && p === "/api/remote") {
    return sendJson(res, 200, {
      ok: true, enabled: !!state.remote.enabled, allow: state.remote.allow, maxRunning: state.remote.maxRunning,
      device: { id: state.deviceId, name: state.deviceName, kind: SELF_KIND, platform: process.platform },
      caps: selfCaps(), targets: remoteTargets(), tasks: remoteRecent(20),
    });
  }
  if (req.method === "POST" && p === "/api/remote/config") {
    const b = await jsonBody(req, 64 * 1024);
    if (b.enabled !== undefined) state.remote.enabled = !!b.enabled;
    if (b.maxRunning !== undefined) state.remote.maxRunning = Math.max(1, Math.min(4, Number(b.maxRunning) || 1));
    if (b.allow && typeof b.allow === "object") {
      for (const [id, v] of Object.entries(b.allow)) {
        if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) continue;
        if (v === "auto" || v === true) state.remote.allow[id] = "auto";
        else delete state.remote.allow[id];
      }
    }
    saveNow();
    log(`远程执行：${state.remote.enabled ? "已开启" : "已关闭"}，允许 ${Object.keys(state.remote.allow).length} 台设备`);
    return sendJson(res, 200, { ok: true, enabled: state.remote.enabled, allow: state.remote.allow, maxRunning: state.remote.maxRunning, targets: remoteTargets() });
  }
  if (req.method === "POST" && p === "/api/remote/task") {
    const b = await jsonBody(req, REMOTE_MAX_PROMPT + 64 * 1024);
    const prompt = String(b.prompt || "").trim();
    if (!prompt) return sendJson(res, 400, { error: "任务不能为空" });
    if (prompt.length > REMOTE_MAX_PROMPT) return sendJson(res, 413, { error: "任务太大（上限 64 KB）" });
    const target = findTarget(b.device || b.to);
    if (!target) return sendJson(res, 404, { error: "找不到目标设备", targets: remoteTargets() });
    const id = crypto.randomUUID();
    const t = {
      id, dir: "out", toId: target.id, toName: target.name, via: target.via,
      from: { id: state.deviceId, name: state.deviceName, kind: SELF_KIND, platform: process.platform },
      prompt, cwd: String(b.cwd || "").slice(0, 500), timeout: Number(b.timeout) || 600,
      maxTurns: Number(b.maxTurns) || 40, mode: "auto", status: "queued", progress: "", result: "", error: "",
      sessionId: String(b.sessionId || "").slice(0, 64), text: String(b.text || "").slice(0, 4000),
      context: String(b.context || "").slice(0, 12000),
      createdAt: Date.now(), events: [], evSeq: 0,
    };
    remoteTasks.set(id, t);
    remoteSave(t, 0);
    remoteDispatch(t).catch((e) => { t.status = "error"; t.error = String(e.message).slice(0, 4000); t.endedAt = Date.now(); remoteEvBump(t.id); remoteSave(t, 0); });
    const wait = Math.max(0, Math.min(120, Number(b.wait) || 0));
    if (wait) {
      const end = Date.now() + wait * 1000;
      while (!REMOTE_TERMINAL.has(t.status) && Date.now() < end) await sleep(500);
    }
    return sendJson(res, 200, { ok: true, task: remotePublic(t), targets: wait ? undefined : remoteTargets() });
  }
  if (req.method === "GET" && p === "/api/remote/tasks") {
    const limit = Number(u.searchParams.get("limit")) || 20;
    return sendJson(res, 200, { ok: true, tasks: remoteRecent(limit) });
  }
  // 实时事件流：调用方网关长轮询这里，把对端 Claude 的文本 / 工具事件画进当前会话。
  // 事件先由 out 任务从对端（局域网 peer 或中转）取回来，存进本地任务。
  const rte = /^\/api\/remote\/task\/([A-Za-z0-9-]{8,64})\/events$/.exec(p);
  if (req.method === "GET" && rte) {
    const t = remoteTasks.get(rte[1]);
    if (!t) return sendJson(res, 404, { error: "not found" });
    const since = Number(u.searchParams.get("since")) || 0;
    const wait = Math.min(30, Math.max(0, Number(u.searchParams.get("wait")) || 0));
    let st = remoteEventState(t, since);
    if (st.events.length || st.done || wait <= 0) return sendJson(res, 200, { ok: true, ...st, timeout: false });
    let done = false, timer = null;
    await new Promise((resolve) => {
      const set = remoteEvWaiters.get(t.id) || new Set();
      const fn = () => {
        if (done) return;
        done = true;
        set.delete(fn);
        if (timer) clearTimeout(timer);
        resolve();
      };
      set.add(fn);
      remoteEvWaiters.set(t.id, set);
      timer = setTimeout(fn, wait * 1000);
      timer.unref?.();
      req.on("close", fn);
    });
    st = remoteEventState(t, since);
    if (res.headersSent) return;
    return sendJson(res, 200, { ok: true, ...st, timeout: !st.events.length && !st.done });
  }
  const rtm = /^\/api\/remote\/task\/([A-Za-z0-9-]{8,64})$/.exec(p);
  if (req.method === "GET" && rtm) {
    const t = remoteTasks.get(rtm[1]);
    if (!t) return sendJson(res, 404, { error: "not found" });
    return sendJson(res, 200, { ok: true, task: remotePublic(t) });
  }
  if (req.method === "POST" && p === "/api/remote/cancel") {
    const b = await jsonBody(req, 4096);
    const t = remoteTasks.get(String(b.id || ""));
    if (!t) return sendJson(res, 404, { error: "not found" });
    await remoteCancelTask(t);
    return sendJson(res, 200, { ok: true, task: remotePublic(t) });
  }
  // 插话：调用方网关在远程轮次进行中收到带 @ 的消息，转发到这里，再投给执行端正在跑的那一轮
  if (req.method === "POST" && p === "/api/remote/inject") {
    const b = await jsonBody(req, 64 * 1024);
    const t = remoteTasks.get(String(b.id || ""));
    if (!t || t.dir !== "out") return sendJson(res, 404, { error: "not found" });
    if (REMOTE_TERMINAL.has(t.status)) return sendJson(res, 409, { ok: false, error: "这一轮已经结束了" });
    try {
      let r;
      if (t.via === "lan" && t.peerId) {
        const peer = state.peers.find((x) => x.id === t.peerId);
        if (!peer) throw new Error("目标设备已不在配对列表");
        r = await peerFetch(peer, "POST", `/api/peer/task/${encodeURIComponent(t.id)}/inject`, {
          body: JSON.stringify({ text: String(b.text || "") }), timeout: 20000,
        });
      } else if (t.via === "relay") {
        const rp = relayPeer();
        if (!rp) throw new Error("没有配置公网中转");
        await postRelayControl(rp, t, "inject", b.text);
        r = { ok: true, queued: true };
      } else throw new Error("这一轮没有可用的传输");
      return sendJson(res, r && r.ok === false ? 409 : 200, r || { ok: true });
    } catch (e) { return sendJson(res, 502, { ok: false, error: e.message }); }
  }
  // 内容产物按需取：本机缺的工作区文件，向局域网里在线的对端要一份（对方执行、产物在对方机器上时用）
  if (req.method === "POST" && p === "/api/remote/fetch") {
    const b = await jsonBody(req, 4096);
    const full = path.resolve(String(b.path || ""));
    const ws = path.resolve(PATHS.workspace);
    if (full !== ws && !full.startsWith(ws + path.sep)) return sendJson(res, 400, { error: "outside workspace" });
    const rel = path.relative(ws, full).replace(/\\/g, "/");
    if (!rel || rel.startsWith("..")) return sendJson(res, 400, { error: "outside workspace" });
    const now = Date.now();
    const peers = state.peers.filter((p) => now - (p.lastSeen || 0) < ALIVE_MS);
    for (const peer of peers) {
      try {
        const got = await peerFetch(peer, "GET", `/api/peer/file?rel=${encodeURIComponent(rel)}`, { timeout: 20000, raw: true });
        const buf = got && got.buf;
        if (!Buffer.isBuffer(buf) || !buf.length) continue;
        ensureDir(path.dirname(full));
        const tmp = full + ".part-" + process.pid;
        fs.writeFileSync(tmp, buf);
        fs.renameSync(tmp, full);
        log(`取回产物 ${rel}（来自 ${peer.name}，${Math.round(buf.length / 1024)} KB）`);
        return sendJson(res, 200, { ok: true, path: full, from: peer.name, size: buf.length });
      } catch (e) { /* 换下一台 */ }
    }
    return sendJson(res, 404, { error: "对端没有这个文件，或者没有在线的局域网设备" });
  }

  if (req.method === "POST" && p === "/api/pair/code") { startCode(); return sendJson(res, 200, statusObj()); }
  if (req.method === "POST" && p === "/api/pair/cancel") { clearCode(); return sendJson(res, 200, statusObj()); }

  if (req.method === "POST" && p === "/api/pair/connect") {
    const b = await jsonBody(req);
    let addr = String(b.addr || "").trim();
    let port = Number(b.port) || 0;
    addr = addr.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
    if (/^\[.*\]:\d+$/.test(addr)) { const m = /^\[(.*)\]:(\d+)$/.exec(addr); addr = m[1]; port = Number(m[2]); }
    else if (/^[^:]+:\d+$/.test(addr)) { const i = addr.lastIndexOf(":"); port = Number(addr.slice(i + 1)); addr = addr.slice(0, i); }
    if (!addr) return sendJson(res, 400, { error: "缺少地址" });
    if (!port) port = LAN_PORT;
    const peer = await pairWith(addr, port, b.code);
    syncPeer(peer).catch(() => {});
    return sendJson(res, 200, { ok: true, peer: { id: peer.id, name: peer.name, addr: peer.addr, port: peer.port }, status: statusObj() });
  }

  if (req.method === "POST" && p === "/api/sync") {
    const b = await jsonBody(req);
    if (b.id) {
      const peer = state.peers.find((x) => x.id === b.id);
      if (!peer) return sendJson(res, 404, { error: "没有这个设备" });
      const r = await syncPeer(peer, { manual: true }).catch((e) => ({ error: e.message }));
      return sendJson(res, 200, { ok: true, result: r, status: statusObj() });
    }
    const list = await syncAll(true);
    return sendJson(res, 200, { ok: true, results: list, status: statusObj() });
  }

  if (req.method === "POST" && p === "/api/peers/auto") {
    const b = await jsonBody(req);
    const peer = state.peers.find((x) => x.id === b.id);
    if (!peer) return sendJson(res, 404, { error: "没有这个设备" });
    peer.autoSync = b.autoSync !== false;
    saveSoon(50);
    return sendJson(res, 200, statusObj());
  }

  if (req.method === "POST" && p === "/api/peers/remove") {
    const b = await jsonBody(req);
    const i = state.peers.findIndex((x) => x.id === b.id);
    if (i < 0) return sendJson(res, 404, { error: "没有这个设备" });
    const peer = state.peers[i];
    try { await peerFetch(peer, "POST", "/api/peer/unpair", { body: JSON.stringify({ id: state.deviceId }), headers: { "content-type": "application/json" }, timeout: 8000 }); } catch {}
    state.peers.splice(i, 1);
    delete state.ledger[peer.id];
    state.conflicts = state.conflicts.filter((x) => x.peer !== peer.id);
    saveNow();
    return sendJson(res, 200, statusObj());
  }

  if (req.method === "POST" && p === "/api/conflict") {
    const b = await jsonBody(req);
    const peer = state.peers.find((x) => x.id === b.peer);
    if (!peer) return sendJson(res, 404, { error: "没有这个设备" });
    const id = String(b.id || "");
    if (!SID_RE.test(id)) return sendJson(res, 400, { error: "bad id" });
    const idx = new SessionIndex(PATHS).scan(true);
    const local = idx.get(id);
    const man = await peerFetch(peer, "GET", "/api/peer/manifest", { timeout: 15000 });
    const remote = (man.sessions || []).find((x) => x.id === id);
    if (!remote) return sendJson(res, 404, { error: "对端没有这个会话" });
    const mapCwd = makeCwdMapper(PATHS, man.workspace);
    if (b.choice === "local") {
      if (!local) return sendJson(res, 404, { error: "本机没有这个会话" });
      await pushOne(peer, local, { force: true });
      state.ledger[peer.id] = Object.assign(state.ledger[peer.id] || {}, { [id]: { lmt: local.mtime, lsz: local.size, rmt: remote.mtime, rsz: remote.size, at: Date.now() } });
    } else if (b.choice === "remote") {
      const out = await pullOne(peer, remote, mapCwd, idx);
      state.ledger[peer.id] = Object.assign(state.ledger[peer.id] || {}, { [id]: { lmt: out.mtime, lsz: out.size, rmt: remote.mtime, rsz: remote.size, at: Date.now() } });
    } else if (b.choice === "both") {
      const { buf } = await peerFetch(peer, "GET", `/api/peer/session/${encodeURIComponent(id)}`, { timeout: 60000, raw: true });
      const out = unpackSession(PATHS, buf, { mapCwd, fork: true, titleSuffix: `来自 ${peer.name}` });
      applyIncomingOrigin(out.id, out.meta, peer);
      await applyName(out.id, out.title);
      state.ledger[peer.id] = Object.assign(state.ledger[peer.id] || {}, { [id]: { lmt: local ? local.mtime : 0, lsz: local ? local.size : 0, rmt: remote.mtime, rsz: remote.size, at: Date.now() } });
    } else return sendJson(res, 400, { error: "choice" });
    clearConflict(peer.id, id);
    saveSoon(50);
    return sendJson(res, 200, { ok: true, status: statusObj() });
  }

  if (req.method === "GET" && p === "/api/backups") {
    const id = u.searchParams.get("id") || "";
    return sendJson(res, 200, { backups: id ? listBackups(PATHS, id) : listAllBackups(PATHS) });
  }

  if (req.method === "POST" && p === "/api/backups/restore") {
    const b = await jsonBody(req);
    const id = String(b.id || ""), stamp = String(b.stamp || "");
    if (!SID_RE.test(id) || !/^[0-9TZ._-]+$/.test(stamp)) return sendJson(res, 400, { error: "bad backup" });
    const out = restoreBackup(PATHS, id, stamp);
    await applyName(out.id, `恢复的副本 · ${new Date().toLocaleString()}`);
    saveSoon(50);
    return sendJson(res, 200, { ok: true, id: out.id });
  }

  if (req.method === "GET" && p === "/api/log") {
    let text = "";
    try { const st = fs.statSync(PATHS.log); const fd = fs.openSync(PATHS.log, "r"); const n = Math.min(64 * 1024, st.size); const b = Buffer.alloc(n); fs.readSync(fd, b, 0, n, st.size - n); fs.closeSync(fd); text = b.toString("utf8"); } catch {}
    return sendJson(res, 200, { log: text.split("\n").slice(-200).join("\n") });
  }

  return sendJson(res, 404, { error: "not found" });
}

async function handlePeer(req, res, u, p, peer) {
  if (req.method === "GET" && p === "/api/peer/ping") {
    if (peer) { peer.kind = SELF_KIND; peer.caps = selfCaps(); peer.lastSeen = Date.now(); }
    return sendJson(res, 200, {
      ok: true, id: state.deviceId, name: state.deviceName, v: VERSION, at: Date.now(),
      kind: SELF_KIND, platform: process.platform, caps: selfCaps(),
    });
  }

  // ── 远程执行：对端派来的任务 ──
  if (req.method === "POST" && p === "/api/peer/task") {
    const b = await jsonBody(req, REMOTE_MAX_PROMPT + 64 * 1024);
    const task = b.task || {};
    const from = { ...(b.from || {}), via: "lan" };
    if (String(from.id || "") !== peer.id) return sendJson(res, 403, { error: "identity mismatch" });
    if (!remoteAllowed(peer.id)) return sendJson(res, 403, { error: "对端没有允许这台设备执行远程任务" });
    try { const t = remoteAccept(task, from); return sendJson(res, 200, { ok: true, id: t.id, status: t.status }); }
    catch (e) { return sendJson(res, e.status || 400, { error: e.message }); }
  }
  const ptm = /^\/api\/peer\/task\/([A-Za-z0-9-]{8,64})(\/cancel|\/inject)?$/.exec(p);
  if (ptm) {
    const t = remoteTasks.get(ptm[1]);
    if (!t || t.dir !== "in" || !t.from || t.from.id !== peer.id) return sendJson(res, 404, { error: "not found" });
    if (req.method === "GET") {
      const since = Number(u.searchParams.get("since")) || 0;
      const st = remoteEventState(t, since);
      return sendJson(res, 200, { ok: true, ...remotePublic(t), events: st.events, evSeq: st.evSeq, done: st.done });
    }
    if (req.method === "POST" && ptm[2] === "/inject") {
      const b = await jsonBody(req, 64 * 1024);
      const r = await remoteInjectTask(t, b.text);
      return sendJson(res, r.ok ? 200 : 409, r);
    }
    if (req.method === "POST" && ptm[2] === "/cancel") {
      await remoteCancelTask(t, false);
      return sendJson(res, 200, { ok: true, ...remotePublic(t) });
    }
  }

  // 内容产物：调用方查看器要打开一个本机有、它没有的文件，按工作区相对路径来取。
  // 只给工作区里的普通文件，单文件 ≤ 32 MB，路径不许穿越。
  if (req.method === "GET" && p === "/api/peer/file") {
    const rel = String(u.searchParams.get("rel") || "").replace(/\\/g, "/");
    if (!rel || rel.startsWith("/") || /(^|\/)\.\.(\/|$)/.test(rel)) return sendJson(res, 400, { error: "bad rel" });
    const full = path.resolve(PATHS.workspace, rel);
    const base = path.resolve(PATHS.workspace);
    if (full !== base && !full.startsWith(base + path.sep)) return sendJson(res, 400, { error: "outside workspace" });
    let st;
    try { st = fs.statSync(full); } catch { return sendJson(res, 404, { error: "not found" }); }
    if (!st.isFile()) return sendJson(res, 404, { error: "not a file" });
    if (st.size > 32 * 1024 * 1024) return sendJson(res, 413, { error: "too big" });
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": st.size, "x-rel": encodeURIComponent(rel) });
    return fs.createReadStream(full).pipe(res);
  }

  if (req.method === "GET" && p === "/api/peer/manifest") {
    const idx = new SessionIndex(PATHS).scan(true);
    const list = idx.list(5000);
    let bytes = 0; for (const e of list) bytes += e.size;
    return sendJson(res, 200, {
      format: "cccodroid-link-manifest", version: VERSION, at: Date.now(),
      device: { id: state.deviceId, name: state.deviceName, platform: process.platform },
      workspace: PATHS.workspace,
      home: PATHS.home,
      names: readJson(PATHS.names, {}),
      pins: readJson(PATHS.pins, {}),
      namesMtime: (statSafe(PATHS.names) || {}).mtimeMs || 0,
      pinsMtime: (statSafe(PATHS.pins) || {}).mtimeMs || 0,
      trash: [...trashIds(PATHS)],
      count: list.length, bytes,
      sessions: list.map((e) => ({
        id: e.id, title: e.title, renamed: e.renamed, cwd: e.cwd,
        mtime: e.mtime, size: e.size, pinned: e.pinned, created: e.created,
      })),
    });
  }

  const sm = /^\/api\/peer\/session\/([^/]+)$/.exec(p);
  if (sm) {
    const id = decodeURIComponent(sm[1]);
    if (!SID_RE.test(id)) return sendJson(res, 400, { error: "bad id" });
    if (req.method === "GET") {
      const e = new SessionIndex(PATHS).get(id);
      if (!e) return sendJson(res, 404, { error: "not found" });
      if (e.size > state.settings.maxMB * 1024 * 1024) return sendJson(res, 413, { error: "too big" });
      const { buf } = packSession(PATHS, e, {
        maxBytes: Math.max(64 * 1024 * 1024, state.settings.maxMB * 1024 * 1024),
        origin: originOf(id) || selfOrigin(),
        artifacts: packArtifacts(e.size),
      });
      res.writeHead(200, { "content-type": "application/zip", "cache-control": "no-store", "content-length": buf.length });
      return res.end(buf);
    }
    if (req.method === "POST") {
      const force = u.searchParams.get("force") === "1";
      const max = state.settings.maxMB * 3 * 1024 * 1024 + 20 * 1024 * 1024;
      const body = await readBody(req, max);
      // 先看包里是谁、多大、什么时候
      let files;
      try { files = zipRead(body); } catch (e) { return sendJson(res, 400, { error: e.message }); }
      const manFile = files.find((f) => f.name === "manifest.json");
      const main = files.find((f) => f.name === "session.jsonl");
      let man = {};
      try { man = manFile ? JSON.parse(manFile.data.toString("utf8")) : {}; } catch {}
      const s = man.session || {};
      if (!main || String(s.id) !== id || !SID_RE.test(id)) return sendJson(res, 400, { error: "bad package" });
      if (trashIds(PATHS).has(id)) return sendJson(res, 409, { error: "trashed" });
      const exists = new SessionIndex(PATHS).get(id);
      const incoming = Number(s.mtime) || 0;
      if (exists && !force && exists.mtime > incoming + SKEW) {
        return sendJson(res, 409, { error: "newer", localMtime: exists.mtime, localSize: exists.size });
      }
      const mapCwd = makeCwdMapper(PATHS, u.searchParams.get("peerWorkspace") || "");
      const out = unpackSession(PATHS, body, { mapCwd });
      applyIncomingOrigin(out.id, s, peer);
      let metaChanged = false;
      if (s.renamed && s.title) await applyName(out.id, s.title);
      if (s.renamed && s.title) metaChanged = true;
      if (s.pinned) {
        await applyPin(out.id, s.pinned);
        metaChanged = true;
      }
      peer.lastSeen = Date.now();
      log(`收到会话 ${id.slice(0, 8)} ← ${peer.name}（${Math.round(body.length / 1024)} KB${out.artifacts && out.artifacts.written ? `，产物 ${out.artifacts.written} 个` : ""}）`);
      saveSoon(200);
      notifyGatewayLink(peer, { pulled: 1, meta: metaChanged });
      return sendJson(res, 200, { ok: true, id: out.id, mtime: out.mtime, size: out.size, backup: !!out.backup, title: out.title });
    }
  }

  if (req.method === "POST" && p === "/api/peer/meta") {
    const b = await jsonBody(req, 8 * 1024 * 1024);
    const localNames = readJson(PATHS.names, {});
    const localPins = readJson(PATHS.pins, {});
    const localM = (statSafe(PATHS.names) || {}).mtimeMs || 0;
    const remoteM = Number(b.namesMtime) || 0;
    let metaChanged = false;
    if (remoteM > localM + 1000) {
      let n = 0;
      for (const [id, title] of Object.entries(b.names || {})) {
        if (!SID_RE.test(id) || !title) continue;
        if (localNames[id] === title) continue;
        if (n++ > 300) break;
        await applyName(id, title);
        metaChanged = true;
      }
    }
    const pins = b.pins && typeof b.pins === "object" ? b.pins : {};
    for (const [id, ts] of Object.entries(pins)) {
      if (!SID_RE.test(id)) continue;
      if ((Number(ts) || 0) > (Number(localPins[id]) || 0) + 1000) {
        await applyPin(id, ts);
        metaChanged = true;
      }
    }
    saveSoon(100);
    notifyGatewayLink(peer, { meta: metaChanged });
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && p === "/api/peer/unpair") {
    const i = state.peers.findIndex((x) => x.id === peer.id);
    if (i >= 0) state.peers.splice(i, 1);
    delete state.ledger[peer.id];
    state.conflicts = state.conflicts.filter((x) => x.peer !== peer.id);
    saveNow();
    log(`对端 ${peer.name} 解除了配对`);
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: "not found" });
}

// ── 监听 ──────────────────────────────────────────────────────────────
let localServer = null, lanServer = null, lanError = "";

function startLocal() {
  localServer = http.createServer(handle);
  localServer.on("error", (e) => { log("本机端口错误: " + e.message); process.exit(e.code === "EADDRINUSE" ? 0 : 1); });
  localServer.listen(LOCAL_PORT, "127.0.0.1", () => {
    log(`linkd v${VERSION} 已启动  http://127.0.0.1:${LOCAL_PORT}/`);
    log(`  设备 ${state.deviceName}（${state.deviceId.slice(0, 8)}）`);
    log(`  数据 ${PATHS.home}`);
    log(`  工作区 ${PATHS.workspace}`);
    log(`  网关 :${GATEWAY_PORT}`);
    const tok = gatewayToken();
    if (tok) log(`  管理页 http://127.0.0.1:${LOCAL_PORT}/?t=${tok.slice(0, 8)}…`);
  });
}
function startLan() {
  if (lanServer) return;
  lanError = "";
  lanServer = http.createServer(handle);
  lanServer.on("error", (e) => {
    lanError = e.message;
    log("局域网端口错误: " + e.message);
    try { lanServer.close(); } catch {}
    lanServer = null;
    stopUdp();
  });
  lanServer.listen(LAN_PORT, "0.0.0.0", () => {
    log(`局域网互联已开启 :${LAN_PORT}（${localIPs().join(", ") || "无地址"}）`);
    startUdp();
  });
}
function stopLan() {
  stopUdp();
  if (lanServer) { try { lanServer.close(); } catch {} lanServer = null; }
  log("局域网互联已关闭");
}

// ── 定时 ──────────────────────────────────────────────────────────────
let autoTimer = null;
let pingTimer = null;
function scheduleAuto() {
  if (autoTimer) clearInterval(autoTimer);
  autoTimer = setInterval(() => {
    if (state.lan.enabled || relayReady()) syncAll(false).catch((e) => log("自动同步: " + e.message));
    else saveSoon(50);
  }, state.settings.interval);
}
function startTimers() {
  scheduleAuto();
  startSessionWatch();
  // 中转上的设备登记 / 远程任务收件箱：即使远程执行关着也要登记，界面才知道对端在不在
  setInterval(() => { remotePollRelay().catch(() => {}); }, 5000);
  // 长轮询断了自己接回来（中转刚好没开 / 网络切换 / 服务器重启）
  setInterval(() => {
    if (relayReady() && !relayEventRunning) relayEventsLoop().catch(() => {});
  }, 10000);
  pingTimer = setInterval(async () => {
    if (state.lan.enabled) {
      for (const p of state.peers) {
        if (syncing.has(p.id)) continue;
        try {
          const r = await peerFetch(p, "GET", "/api/peer/ping", { timeout: 4000 });
          p.lastSeen = Date.now();
          if (r && r.kind) p.kind = String(r.kind);
          if (r && r.caps && typeof r.caps === "object") p.caps = r.caps;
          if (p.lastError === "连不上") p.lastError = "";
        } catch {}
      }
    }
    const rp = relayPeer();
    if (rp && !syncing.has(rp.id)) {
      try {
        await peerFetch(rp, "GET", "/api/peer/ping", { timeout: 5000 });
        state.relay.lastSeen = Date.now();
        if (/^连不上/.test(state.relay.lastError || "")) state.relay.lastError = "";
      } catch {}
    }
    saveSoon(1000);
  }, 15000);
}

process.on("SIGINT", () => { saveNow(); process.exit(0); });
process.on("SIGTERM", () => { saveNow(); process.exit(0); });
process.on("uncaughtException", (e) => log("未捕获异常: " + (e.stack || e.message)));
process.on("unhandledRejection", (e) => log("未处理 Promise: " + (e && (e.stack || e.message))));

ensureDir(PATHS.home);
seedOrigins();
startLocal();
if (state.lan.enabled) startLan();
startTimers();
saveNow();
