#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
//  relay.mjs —— cccodroid 公网中转（手机 ↔ 电脑，跨网络）
//
//  跑在能公网访问的服务器上（阿里云 ECS 等）。手机和电脑都只向它
//  出站连接，不需要公网 IP、不需要端口映射。设备把中转当成一个普通
//  对端：清单、会话 zip、名称 / 置顶、回收站都走和局域网一样的接口。
//
//  · GET  /api/peer/manifest            清单（不含会话内容）
//  · GET  /api/peer/session/<id>        拉一个会话 zip
//  · POST /api/peer/session/<id>        推一个会话 zip（元数据在 x-link-meta 头）
//  · POST /api/peer/meta                名称 / 置顶 / 回收站
//  · GET  /api/peer/ping                探活
//  · GET  /api/relay/info               用量与配额
//  · POST /api/relay/trim               按最旧上传时间清到配额以下
//  · GET  /api/health                   健康检查（不需要令牌）
//
//  鉴权：Authorization: Bearer <data/token 里的 64 位十六进制>
//  存储：<data>/sessions/<id>.zip + <data>/index.json
//
//  用法：
//    node relay.mjs --data /opt/cccodroid-relay/data --port 9380 \
//      [--bind 127.0.0.1] [--max-gb 8] [--max-session-mb 64] \
//      [--tls-cert fullchain.pem --tls-key privkey.pem] [--name 我的中转]
//
//  推荐放在 Caddy / nginx 后面由它做 HTTPS（见 README），本进程只听 127.0.0.1。
// ─────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";

const VERSION = 1;
const SKEW = 2000;                 // 和 linkd 一样：2 秒内按内容判断
const SID_RE = /^(?!\.+$)[A-Za-z0-9._-]{1,200}$/;
const START_AT = Date.now();

function arg(name, def) {
  const i = process.argv.indexOf("--" + name);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  const eq = process.argv.find((x) => x.startsWith(name + "="));
  return eq ? eq.slice(name.length + 1) : def;
}
function ensureDir(p) { try { fs.mkdirSync(p, { recursive: true }); } catch {} }
function readJson(p, fallback) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; } }
function writeJson(p, obj) {
  const tmp = p + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, p);
}
function eq(a, b) {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const DATA = path.resolve(arg("data", process.env.CCAPP_RELAY_DATA || "./relay-data"));
const SESSIONS = path.join(DATA, "sessions");
const INDEX = path.join(DATA, "index.json");
const LOG_FILE = path.join(DATA, "relay.log");
const TOKEN_FILE = path.resolve(arg("token-file", path.join(DATA, "token")));
const PORT = Math.max(1, Math.min(65535, Number(arg("port", process.env.CCAPP_RELAY_PORT || 9380)) || 9380));
const BIND = String(arg("bind", process.env.CCAPP_RELAY_BIND || "127.0.0.1"));
const MAX_GB = Math.max(0.1, Math.min(1024, Number(arg("max-gb", 8)) || 8));
const MAX_BYTES = Math.round(MAX_GB * 1024 * 1024 * 1024);
const MAX_SESSION_MB = Math.max(1, Math.min(256, Number(arg("max-session-mb", 64)) || 64));
const MAX_BODY = MAX_SESSION_MB * 3 * 1024 * 1024 + 20 * 1024 * 1024;
const NAME = String(arg("name", process.env.CCAPP_RELAY_NAME || "cccodroid 公网中转")).slice(0, 60);
const TLS_CERT = arg("tls-cert", "");
const TLS_KEY = arg("tls-key", "");
const TASKS = path.join(DATA, "tasks");
const DEVICES = path.join(DATA, "devices.json");
const TASK_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const TASK_KEEP_MS = 7 * 24 * 3600 * 1000;
const TASK_MAX_PROMPT = 64 * 1024;
const TASK_MAX_RESULT = 512 * 1024;

ensureDir(DATA); ensureDir(SESSIONS); ensureDir(TASKS);

function log(...a) {
  const line = `[${new Date().toISOString().replace("T", " ").slice(0, 19)}] ${a.join(" ")}`;
  console.log(line);
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 2 * 1024 * 1024) fs.writeFileSync(LOG_FILE, "");
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch {}
}

// ── 令牌 ──────────────────────────────────────────────────────────────
let TOKEN = "";
try { TOKEN = fs.readFileSync(TOKEN_FILE, "utf8").trim(); } catch {}
if (!/^[0-9a-f]{32,128}$/i.test(TOKEN)) {
  TOKEN = crypto.randomBytes(32).toString("hex");
  ensureDir(path.dirname(TOKEN_FILE));
  fs.writeFileSync(TOKEN_FILE, TOKEN + "\n", { mode: 0o600 });
  log(`已生成访问令牌：${TOKEN_FILE}（把文件内容填到设备的「公网中转」里）`);
}

const failRL = new Map();   // ip -> {at,n}，401 次数限制
function authOK(req) {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || "");
  return !!m && eq(m[1], TOKEN);
}
function authFailLimited(ip) {
  const now = Date.now();
  let e = failRL.get(ip);
  if (!e || now - e.at > 60000) { e = { at: now, n: 0 }; failRL.set(ip, e); }
  e.n++;
  if (failRL.size > 5000) failRL.clear();
  return e.n > 60;
}

// ── 索引 ──────────────────────────────────────────────────────────────
let idx = readJson(INDEX, null);
if (!idx || typeof idx !== "object") idx = {};
if (!/^[A-Za-z0-9._-]{8,64}$/.test(String(idx.id || ""))) idx.id = crypto.randomUUID();
idx.names = idx.names && typeof idx.names === "object" ? idx.names : {};
idx.pins = idx.pins && typeof idx.pins === "object" ? idx.pins : {};
idx.namesMtime = Number(idx.namesMtime) || 0;
idx.pinsMtime = Number(idx.pinsMtime) || 0;
idx.trash = Array.isArray(idx.trash) ? idx.trash.filter((x) => SID_RE.test(String(x))) : [];
idx.sessions = idx.sessions && typeof idx.sessions === "object" ? idx.sessions : {};
let trashSet = new Set(idx.trash);
let dirty = false;

// 启动时核对：索引里有、文件没了的条目删掉；文件在、索引没的（不该发生）忽略
for (const [id, m] of Object.entries(idx.sessions)) {
  if (!SID_RE.test(id) || !m || typeof m !== "object") { delete idx.sessions[id]; dirty = true; continue; }
  const f = sessionPath(id);
  let st = null;
  try { st = fs.statSync(f); } catch {}
  if (!st || !st.isFile()) { delete idx.sessions[id]; dirty = true; continue; }
  m.zipBytes = st.size;
}
if (dirty) saveIndex();

function sessionPath(id) { return path.join(SESSIONS, id + ".zip"); }
function bytesUsed() {
  let n = 0;
  for (const m of Object.values(idx.sessions)) n += Number(m.zipBytes) || 0;
  return n;
}
function saveIndex() {
  const out = {
    v: 1, id: idx.id,
    names: idx.names, pins: idx.pins, namesMtime: idx.namesMtime, pinsMtime: idx.pinsMtime,
    trash: [...trashSet].slice(0, 5000), sessions: idx.sessions,
  };
  writeJson(INDEX, out);
}
function manifestObj() {
  const list = [];
  for (const [id, m] of Object.entries(idx.sessions)) {
    if (trashSet.has(id)) continue;
    list.push({
      id, title: String(m.title || ""), renamed: !!m.renamed, cwd: String(m.cwd || ""),
      mtime: Number(m.mtime) || 0, size: Number(m.size) || 0,
      pinned: Number(m.pinned) || 0, created: Number(m.created) || 0,
    });
  }
  return {
    format: "cccodroid-link-manifest", version: VERSION, at: Date.now(),
    device: { id: idx.id, name: NAME, platform: "relay" },
    workspace: "",
    names: idx.names, pins: idx.pins,
    namesMtime: idx.namesMtime, pinsMtime: idx.pinsMtime,
    trash: [...trashSet].slice(0, 5000),
    count: list.length, bytes: bytesUsed(),
    sessions: list,
  };
}

// ── 远程执行：设备登记 + 任务信箱 ─────────────────────────────────────
//  中转只存 JSON，不执行任何东西。设备每 15 秒登记一次；任务由发起方写入，
//  目标设备按 to 轮询收件箱，claim 后执行，再把结果写回来。
let devices = readJson(DEVICES, {});
if (!devices || typeof devices !== "object") devices = {};
function saveDevices() { try { writeJson(DEVICES, devices); } catch {} }
function taskPath(id) { return path.join(TASKS, id + ".json"); }
function readTask(id) { try { return JSON.parse(fs.readFileSync(taskPath(id), "utf8")); } catch { return null; } }
function saveTask(t) { writeJson(taskPath(t.id), t); }
function listTasks(filter = {}) {
  let files = [];
  try { files = fs.readdirSync(TASKS).filter((f) => /^[A-Za-z0-9-]{8,64}\.json$/.test(f)); } catch {}
  const out = [];
  for (const f of files) {
    let t = null;
    try { t = JSON.parse(fs.readFileSync(path.join(TASKS, f), "utf8")); } catch { continue; }
    if (!t || !TASK_ID_RE.test(String(t.id || ""))) continue;
    if (filter.to && t.to !== filter.to) continue;
    if (filter.status && t.status !== filter.status) continue;
    out.push(t);
  }
  out.sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));
  return out;
}
function purgeTasks() {
  let n = 0;
  for (const t of listTasks()) {
    if (Date.now() - (Number(t.createdAt) || 0) > TASK_KEEP_MS) { try { fs.unlinkSync(taskPath(t.id)); n++; } catch {} }
  }
  return n;
}
function taskPublic(t) {
  if (!t) return null;
  const events = Array.isArray(t.events) ? t.events : [];
  return {
    id: t.id, kind: t.kind || "task", status: t.status, createdAt: t.createdAt, endedAt: t.endedAt || 0,
    from: t.from || null, to: t.to || "", prompt: t.prompt || "",
    sessionId: t.sessionId || "", text: t.text || "", context: t.context || "",
    action: t.action || "", targetTaskId: t.targetTaskId || "",
    progress: t.progress || "", result: String(t.result || "").slice(0, TASK_MAX_RESULT), error: t.error || "",
    claimedBy: t.claimedBy || "", via: "relay",
    evSeq: Number(t.evSeq) || (events.length ? events[events.length - 1].seq : 0), eventCount: events.length,
  };
}
const TASK_EVENT_KEEP = 500;
function addTaskEvents(t, list) {
  if (!Array.isArray(list) || !list.length) return false;
  if (!Array.isArray(t.events)) t.events = [];
  const have = new Set(t.events.map((e) => Number(e.seq) || 0));
  let added = false;
  for (const x of list) {
    const seq = Number(x && x.seq);
    if (!seq || have.has(seq) || !x.ev || typeof x.ev !== "object") continue;
    const ev = {};
    for (const [k, v] of Object.entries(x.ev)) ev[k] = typeof v === "string" ? v.slice(0, 8000) : v;
    t.events.push({ seq, at: Number(x.at) || Date.now(), ev });
    have.add(seq);
    added = true;
  }
  if (added) {
    if (t.events.length > TASK_EVENT_KEEP) t.events = t.events.slice(-TASK_EVENT_KEEP);
    t.evSeq = Math.max(Number(t.evSeq) || 0, ...t.events.map((e) => Number(e.seq) || 0));
  }
  return added;
}
purgeTasks();
setInterval(() => { try { purgeTasks(); } catch {} }, 3600 * 1000).unref?.();

// ── 变更事件：设备长轮询「有变化就立刻醒」，不用每 5 秒空转 ──────────
let rev = 0, revKind = "";
const eventWaiters = new Set();
function bump(kind) {
  rev++;
  revKind = kind || revKind;
  for (const w of eventWaiters) { try { w(); } catch {} }
  eventWaiters.clear();
}

// ── HTTP 小工具 ───────────────────────────────────────────────────────
function sendJson(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": b.length });
  res.end(b);
}
function readBody(req, max) {
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
async function jsonBody(req, max = 8 * 1024 * 1024) {
  const b = await readBody(req, max);
  if (!b.length) return {};
  try { return JSON.parse(b.toString("utf8")); } catch { throw Object.assign(new Error("bad json"), { status: 400 }); }
}
function remoteIP(req) { return String(req.socket.remoteAddress || "").replace(/^::ffff:/, "") || "?"; }

// ── 路由 ──────────────────────────────────────────────────────────────
async function handle(req, res) {
  let u;
  try { u = new URL(req.url, "http://relay.local"); } catch { req.resume(); return sendJson(res, 400, { error: "bad request" }); }
  const p = u.pathname;

  if (req.method === "GET" && p === "/api/health") return sendJson(res, 200, { ok: true, v: VERSION, at: Date.now() });
  if (req.method === "GET" && p === "/favicon.ico") { res.writeHead(204); return res.end(); }

  if (!authOK(req)) {
    req.resume();
    const ip = remoteIP(req);
    const limited = authFailLimited(ip);
    log(`拒绝未授权请求 ${req.method} ${p} 来自 ${ip}`);
    return sendJson(res, limited ? 429 : 401, { error: limited ? "too many attempts" : "unauthorized" });
  }

  if (req.method === "GET" && p === "/api/peer/ping") {
    return sendJson(res, 200, {
      ok: true, id: idx.id, name: NAME, v: VERSION, kind: "relay",
      at: Date.now(), count: Object.keys(idx.sessions).length, bytes: bytesUsed(),
    });
  }

  if (req.method === "GET" && p === "/api/relay/info") {
    return sendJson(res, 200, {
      ok: true, id: idx.id, name: NAME, v: VERSION,
      count: Object.keys(idx.sessions).length, bytes: bytesUsed(), maxBytes: MAX_BYTES,
      maxSessionMB: MAX_SESSION_MB, uptime: Math.round((Date.now() - START_AT) / 1000),
    });
  }

  if (req.method === "GET" && p === "/api/peer/manifest") {
    return sendJson(res, 200, manifestObj());
  }

  const sm = /^\/api\/peer\/session\/([^/]+)$/.exec(p);
  if (sm) {
    const id = decodeURIComponent(sm[1]);
    if (!SID_RE.test(id)) return sendJson(res, 400, { error: "bad id" });
    if (req.method === "GET") {
      if (trashSet.has(id)) return sendJson(res, 404, { error: "trashed" });
      const m = idx.sessions[id];
      if (!m) return sendJson(res, 404, { error: "not found" });
      if (Number(m.size) > MAX_SESSION_MB * 1024 * 1024) return sendJson(res, 413, { error: "too big" });
      const f = sessionPath(id);
      let st = null;
      try { st = fs.statSync(f); } catch {}
      if (!st) return sendJson(res, 404, { error: "not found" });
      res.writeHead(200, { "content-type": "application/zip", "cache-control": "no-store", "content-length": st.size });
      return fs.createReadStream(f).pipe(res);
    }
    if (req.method === "POST") {
      const force = u.searchParams.get("force") === "1";
      const body = await readBody(req, MAX_BODY);
      if (body.length < 100 || (body[0] !== 0x50 || body[1] !== 0x4b)) return sendJson(res, 400, { error: "not a zip" });
      let meta;
      try { meta = JSON.parse(decodeURIComponent(String(req.headers["x-link-meta"] || ""))); } catch { return sendJson(res, 400, { error: "missing meta" }); }
      if (!meta || String(meta.id) !== id || !SID_RE.test(id)) return sendJson(res, 400, { error: "bad meta" });
      const mtime = Number(meta.mtime) || 0;
      const size = Number(meta.size) || 0;
      if (!(mtime > 0) || !(size > 0)) return sendJson(res, 400, { error: "bad meta" });
      if (size > MAX_SESSION_MB * 1024 * 1024) return sendJson(res, 413, { error: "too big" });
      const cur = idx.sessions[id];
      if (cur && !force && Number(cur.mtime) > mtime + SKEW) {
        return sendJson(res, 409, { error: "newer", localMtime: Number(cur.mtime), localSize: Number(cur.size) });
      }
      const delta = body.length - (cur && cur.zipBytes ? cur.zipBytes : 0);
      if (bytesUsed() + delta > MAX_BYTES) {
        log(`配额已满：${Math.round(bytesUsed() / 1048576)} MB / ${Math.round(MAX_BYTES / 1048576)} MB，拒绝 ${id.slice(0, 8)}`);
        return sendJson(res, 507, { error: "quota", used: bytesUsed(), max: MAX_BYTES });
      }
      const f = sessionPath(id);
      const tmp = f + ".tmp-" + process.pid + "-" + Date.now();
      fs.writeFileSync(tmp, body, { mode: 0o600 });
      fs.renameSync(tmp, f);
      idx.sessions[id] = {
        id, title: String(meta.title || "").slice(0, 120), renamed: !!meta.renamed,
        cwd: String(meta.cwd || ""), mtime, size,
        pinned: Number(meta.pinned) || 0, created: Number(meta.created) || 0,
        origin: meta.origin && typeof meta.origin === "object" ? meta.origin : undefined,
        at: Date.now(), zipBytes: body.length,
      };
      trashSet.delete(id);
      saveIndex();
      bump("sessions");
      log(`收到会话 ${id.slice(0, 8)}（${Math.round(body.length / 1024)} KB，${cur ? "覆盖" : "新增"}）`);
      return sendJson(res, 200, { ok: true, id, mtime, size, title: idx.sessions[id].title });
    }
    return sendJson(res, 405, { error: "method" });
  }

  if (req.method === "POST" && p === "/api/peer/meta") {
    const b = await jsonBody(req, 8 * 1024 * 1024);
    let changed = false;
    const incomingNamesM = Number(b.namesMtime) || 0;
    if (b.names && typeof b.names === "object" && incomingNamesM > idx.namesMtime + 1000) {
      let n = 0;
      for (const [id, title] of Object.entries(b.names)) {
        if (!SID_RE.test(id) || !title) continue;
        if (String(title).slice(0, 120) === idx.names[id]) continue;
        idx.names[id] = String(title).slice(0, 120);
        if (++n > 5000) break;
      }
      idx.namesMtime = incomingNamesM;
      changed = true;
    }
    if (b.pins && typeof b.pins === "object") {
      for (const [id, ts] of Object.entries(b.pins)) {
        if (!SID_RE.test(id)) continue;
        const v = Number(ts) || 0;
        if (v > (Number(idx.pins[id]) || 0) + 1000) { idx.pins[id] = v; changed = true; }
      }
      const incomingPinsM = Number(b.pinsMtime) || 0;
      if (incomingPinsM > idx.pinsMtime) { idx.pinsMtime = incomingPinsM; changed = true; }
    }
    if (Array.isArray(b.trash)) {
      for (const id of b.trash.slice(0, 5000)) {
        if (!SID_RE.test(String(id)) || trashSet.has(id)) continue;
        trashSet.add(id); changed = true;
      }
      if (trashSet.size > 5000) trashSet = new Set([...trashSet].slice(-5000));
    }
    if (changed) { saveIndex(); bump("sessions"); }
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && p === "/api/relay/trim") {
    // 配额紧了：按上传时间删最旧的，直到降到达标线（trash 里的也一起清）
    const b = await jsonBody(req, 64 * 1024);
    let target = b.targetBytes === undefined || b.targetBytes === null ? MAX_BYTES * 0.8 : Number(b.targetBytes) || 0;
    target = Math.max(0, Math.min(MAX_BYTES, target));
    const list = Object.entries(idx.sessions).sort((a, c) => (Number(a[1].at) || 0) - (Number(c[1].at) || 0));
    let used = bytesUsed(), n = 0;
    for (const [id, m] of list) {
      if (used <= target) break;
      try { fs.rmSync(sessionPath(id), { force: true }); } catch {}
      used -= Number(m.zipBytes) || 0;
      delete idx.sessions[id];
      n++;
    }
    if (n) { saveIndex(); bump("sessions"); log(`清理了 ${n} 个旧会话，剩余 ${Math.round(used / 1048576)} MB`); }
    return sendJson(res, 200, { ok: true, removed: n, bytes: used });
  }

  if (req.method === "POST" && p === "/api/peer/unpair") {
    return sendJson(res, 200, { ok: true });
  }

  // ── 远程执行：设备登记与任务 ──
  if (req.method === "POST" && p === "/api/relay/device") {
    const b = await jsonBody(req, 64 * 1024);
    const id = String(b.id || "");
    if (!TASK_ID_RE.test(id)) return sendJson(res, 400, { error: "bad id" });
    devices[id] = {
      id, name: String(b.name || "").slice(0, 60), kind: String(b.kind || "").slice(0, 12),
      platform: String(b.platform || "").slice(0, 20), caps: b.caps && typeof b.caps === "object" ? b.caps : {},
      at: Date.now(), lastSeen: Date.now(),
    };
    for (const [k, v] of Object.entries(devices)) if (Date.now() - (Number(v.lastSeen) || 0) > TASK_KEEP_MS) delete devices[k];
    saveDevices();
    return sendJson(res, 200, { ok: true, devices: Object.values(devices) });
  }
  if (req.method === "GET" && p === "/api/relay/devices") {
    const list = Object.values(devices).sort((a, b) => (Number(b.lastSeen) || 0) - (Number(a.lastSeen) || 0));
    return sendJson(res, 200, { ok: true, devices: list });
  }
  if (req.method === "POST" && p === "/api/relay/task") {
    const b = await jsonBody(req, TASK_MAX_PROMPT + 128 * 1024);
    // 普通任务放在 task 里；控制消息为了兼容旧 linkd 也可能直接放在顶层。
    const task = b.task && typeof b.task === "object" ? b.task : b;
    const id = String(task.id || b.id || "");
    const to = String(b.to || "");
    const from = b.from && typeof b.from === "object" ? b.from : {};
    const kind = String(task.kind || b.kind || "task") === "control" ? "control" : "task";
    if (!TASK_ID_RE.test(id) || !TASK_ID_RE.test(to) || !TASK_ID_RE.test(String(from.id || ""))) return sendJson(res, 400, { error: "bad task" });
    const prompt = String(task.prompt || b.prompt || "");
    if (kind !== "control" && !prompt.trim()) return sendJson(res, 400, { error: "empty prompt" });
    if (prompt.length > TASK_MAX_PROMPT) return sendJson(res, 413, { error: "prompt too big" });
    const old = readTask(id);
    if (old) return sendJson(res, 200, { ok: true, id, status: old.status });
    const t = {
      id, to, from: { id: String(from.id), name: String(from.name || "").slice(0, 60), kind: String(from.kind || "").slice(0, 12), platform: String(from.platform || "").slice(0, 20), caps: from.caps || {} },
      kind, action: String(task.action || "").slice(0, 20), targetTaskId: String(task.targetTaskId || "").slice(0, 64),
      prompt: prompt || "control", cwd: String(task.cwd || "").slice(0, 500), timeout: Number(task.timeout) || 600,
      maxTurns: Number(task.maxTurns) || 40, mode: String(task.mode || "auto").slice(0, 20),
      sessionId: String(task.sessionId || "").slice(0, 64), text: String(task.text || "").slice(0, 4000),
      context: String(task.context || "").slice(0, 12000),
      status: "queued", progress: "", result: "", error: "", createdAt: Date.now(), claimedBy: "", claimedAt: 0,
      events: [], evSeq: 0,
    };
    saveTask(t); bump("task");
    log(`远程任务入队 ${id.slice(0, 8)}：${t.from.name || t.from.id} → ${to.slice(0, 8)}（${prompt.length} 字节）`);
    return sendJson(res, 200, { ok: true, id, status: "queued" });
  }
  if (req.method === "GET" && p === "/api/relay/tasks") {
    const to = String(u.searchParams.get("to") || "");
    const status = String(u.searchParams.get("status") || "");
    const list = listTasks({ to: TASK_ID_RE.test(to) ? to : "", status: status || "" }).slice(0, 20);
    return sendJson(res, 200, { ok: true, tasks: list.map(taskPublic) });
  }
  const tkm = /^\/api\/relay\/task\/([A-Za-z0-9-]{8,64})(\/claim|\/cancel)?$/.exec(p);
  if (tkm) {
    const id = tkm[1];
    let t = readTask(id);
    if (!t) return sendJson(res, 404, { error: "not found" });
    if (req.method === "GET") {
      const since = Number(u.searchParams.get("since")) || 0;
      const events = (Array.isArray(t.events) ? t.events : []).filter((e) => Number(e.seq) > since);
      return sendJson(res, 200, { ok: true, ...taskPublic(t), events, done: ["done", "error", "cancelled"].includes(t.status) });
    }
    if (req.method === "POST" && tkm[2] === "/claim") {
      const b = await jsonBody(req, 16 * 1024);
      const by = String(b.by || "");
      if (by !== t.to) return sendJson(res, 403, { error: "not the target" });
      if (t.status === "queued" || (t.status === "running" && Date.now() - (Number(t.claimedAt) || 0) > 15 * 60 * 1000)) {
        t.status = "running"; t.claimedBy = by; t.claimedAt = Date.now();
        saveTask(t); bump("task");
      }
      return sendJson(res, 200, { ok: true, ...taskPublic(t) });
    }
    if (req.method === "POST" && tkm[2] === "/cancel") {
      if (!["done", "error", "cancelled"].includes(t.status)) {
        t.status = "cancelled"; t.endedAt = Date.now();
        saveTask(t); bump("task");
      }
      return sendJson(res, 200, { ok: true, ...taskPublic(t) });
    }
    if (req.method === "POST") {
      const b = await jsonBody(req, TASK_MAX_RESULT + 128 * 1024);
      const st = String(b.status || "");
      if (!["running", "done", "error", "cancelled"].includes(st)) return sendJson(res, 400, { error: "bad status" });
      t.status = st;
      if (typeof b.progress === "string") t.progress = b.progress.slice(-4000);
      if (typeof b.result === "string") t.result = b.result.slice(0, TASK_MAX_RESULT);
      if (typeof b.error === "string") t.error = b.error.slice(0, 4000);
      if (["done", "error", "cancelled"].includes(st)) t.endedAt = Number(b.endedAt) || Date.now();
      addTaskEvents(t, b.events);
      saveTask(t); bump("task");
      if (["done", "error", "cancelled"].includes(st)) log(`远程任务 ${st} ${id.slice(0, 8)}（${t.from.name || t.from.id} → ${t.to.slice(0, 8)}）`);
      return sendJson(res, 200, { ok: true, ...taskPublic(t) });
    }
  }

  // 长轮询：设备挂着这个请求，有会话 / 任务变化就立刻返回，不用每 5 秒空转
  if (req.method === "GET" && p === "/api/relay/events") {
    const since = Number(u.searchParams.get("since")) || 0;
    const wait = Math.max(0, Math.min(30, Number(u.searchParams.get("wait")) || 0));
    if (since > rev) return sendJson(res, 200, { ok: true, rev, kind: "reset", timeout: false });
    if (since < rev || wait <= 0) return sendJson(res, 200, { ok: true, rev, kind: revKind, timeout: false });
    let done = false, timer = null;
    const finish = (timedOut) => {
      if (done) return;
      done = true;
      eventWaiters.delete(finish);
      if (timer) clearTimeout(timer);
      if (!res.headersSent) sendJson(res, 200, { ok: true, rev, kind: revKind, timeout: !!timedOut });
    };
    eventWaiters.add(finish);
    timer = setTimeout(() => finish(true), wait * 1000);
    req.on("close", () => { done = true; eventWaiters.delete(finish); if (timer) clearTimeout(timer); });
    return;
  }

  return sendJson(res, 404, { error: "not found" });
}

// ── 监听 ──────────────────────────────────────────────────────────────
const useTls = TLS_CERT && TLS_KEY;
let server;
try {
  if (useTls) {
    server = https.createServer({
      cert: fs.readFileSync(TLS_CERT),
      key: fs.readFileSync(TLS_KEY),
      minVersion: "TLSv1.2",
    }, wrap);
  } else {
    server = http.createServer(wrap);
  }
} catch (e) {
  log("证书读取失败：" + e.message);
  process.exit(1);
}

function wrap(req, res) {
  handle(req, res).catch((e) => {
    const code = e.status && e.status >= 400 ? e.status : 500;
    if (code >= 500) log(`请求异常 ${req.method} ${req.url}: ${e.stack || e.message}`);
    if (!res.headersSent) sendJson(res, code, { error: e.message });
    else res.end();
  });
}

server.on("error", (e) => {
  log("监听失败：" + e.message);
  process.exit(e.code === "EADDRINUSE" ? 0 : 1);
});
server.listen(PORT, BIND, () => {
  log(`cccodroid 公网中转 v${VERSION} 已启动：${useTls ? "https" : "http"}://${BIND}:${PORT}`);
  log(`  数据 ${DATA}  已存 ${Object.keys(idx.sessions).length} 个会话 / ${Math.round(bytesUsed() / 1048576)} MB（上限 ${MAX_GB} GB）`);
  log(`  令牌 ${TOKEN_FILE}`);
  if (!useTls && BIND !== "127.0.0.1" && BIND !== "::1") {
    log("⚠ 正在用明文 HTTP 对外监听：会话内容会裸奔，请放到 Caddy / nginx 后面做 HTTPS，或加 --tls-cert/--tls-key");
  }
});

process.on("SIGINT", () => { saveIndex(); process.exit(0); });
process.on("SIGTERM", () => { saveIndex(); process.exit(0); });
process.on("uncaughtException", (e) => log("未捕获异常：" + (e.stack || e.message)));
process.on("unhandledRejection", (e) => log("未处理 Promise：" + (e && (e.stack || e.message))));
