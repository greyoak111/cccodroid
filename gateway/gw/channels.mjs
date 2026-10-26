// ── 频道 ──────────────────────────────────────────────────────────────
// 从聊天软件直接找本机的 Claude 说话：消息进来 → 交给同一条队列跑 → 结果回到那个聊天里。
//
// 抽象照 OpenClaw 的频道插件来（不是照搬代码）：一个频道 = 平台账号 + 路由 + 访问门。
//   · 适配器（TYPES[type]）只管三件事：连上平台、把事件归一化成 Inbound、把文本发出去。
//     连接、心跳、重连、令牌刷新都在适配器里；会话绑定、权限、排队、分段、投递在网关这边，
//     以后加 Telegram / 飞书，只需要再写一个适配器。
//   · 路由：聊天 → Claude 会话。默认「一个聊天一个会话」，接着上下文；也能改成每条新开。
//   · 访问门：配对码 / 任何人 / 白名单。陌生人和没批准的群先进「待批准」，不会直接跑。
//
// 第一个适配器是 QQ 官方机器人：AppID + AppSecret 换 access_token，WebSocket 长连接收事件，
// 开放平台 HTTP API 发消息（被动回复带 msg_id，5 分钟内有效）。
// 存储：home/ccapp-channels.json（频道 + 聊天绑定 + 待批准；密钥只存在本机）。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { CFG, LIVE, log, tz } from "./config.mjs";
import { NEXT, readBody, sendJson } from "./http.mjs";
import { END_HOOKS, abortRun, enqueue } from "./queue.mjs";
import { RUNS } from "./runs.mjs";
import { publish } from "./bus.mjs";
import { NAMES, saveNames } from "./sessions.mjs";
import { projectById } from "./projects.mjs";

const FILE = path.join(CFG.home, "ccapp-channels.json");
// 消息索引：msg_idx(REFIDX…) → 正文摘要。QQ 引用只给索引，不给正文，得自己记
const REF_FILE = path.join(CFG.home, "ccapp-channels-ref.json");
const REF_MAX = 2000;
let REFS = {};
try { REFS = JSON.parse(fs.readFileSync(REF_FILE, "utf8")) || {}; } catch {}
let refTimer = 0;
function refPut(k, v) {
  if (!k) return;
  REFS[k] = v;
  const keys = Object.keys(REFS);
  if (keys.length > REF_MAX) for (const k2 of keys.slice(0, keys.length - REF_MAX)) delete REFS[k2];
  if (refTimer) return;
  refTimer = setTimeout(() => {
    refTimer = 0;
    try { fs.writeFileSync(REF_FILE, JSON.stringify(REFS)); } catch {}
  }, 1500);
  refTimer.unref?.();
}
const refGet = (k) => (k && REFS[k]) || null;
const DB = { channels: [], bindings: {}, pending: [] };
try { Object.assign(DB, JSON.parse(fs.readFileSync(FILE, "utf8"))); } catch {}
if (!Array.isArray(DB.channels)) DB.channels = [];
if (!DB.bindings || typeof DB.bindings !== "object") DB.bindings = {};
if (!Array.isArray(DB.pending)) DB.pending = [];

const save = () => {
  try {
    fs.writeFileSync(FILE + ".tmp", JSON.stringify(DB, null, 1));
    fs.renameSync(FILE + ".tmp", FILE);
  } catch (e) { log("频道保存失败: " + e.message); }
};
const byId = (id) => DB.channels.find((c) => c.id === id) || null;
const now = () => Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 运行时：连接状态、最近消息、统计（不落盘）────────────────────────
const RUNTIME = new Map();
function runtime(id) {
  let r = RUNTIME.get(id);
  if (!r) {
    r = { state: "off", error: null, since: 0, lastEventAt: 0, attempts: 0, stats: { in: 0, out: 0, err: 0 }, events: [] };
    RUNTIME.set(id, r);
  }
  return r;
}
function pushEvent(id, dir, text, extra) {
  const r = runtime(id);
  r.events.push({ at: now(), dir, text: String(text || "").slice(0, 500), ...(extra || {}) });
  if (r.events.length > 60) r.events.splice(0, r.events.length - 60);
  r.lastEventAt = now();
  publish({ type: "channel", id, op: dir, text: String(text || "").slice(0, 300), ...(extra || {}) });
}
function setState(id, state, error) {
  const r = runtime(id);
  if (r.state !== state) { r.state = state; r.since = now(); }
  r.error = error || null;
  if (state === "online") r.attempts = 0;
  publish({ type: "channel", id, op: "status", state, error: error || null });
}

// ── 频道类型：适配器注册表 ───────────────────────────────────────────
// 契约（和 OpenClaw 的 channel plugin 对应）：
//   create(ch, ctx) → { start(), stop(), send(target, text, opts), info() }
//   ctx = { inbound(msg), event(text), status(state, error) }
//   Inbound = { kind:"user"|"group", chatId, senderId, text, messageId, eventId, at }
const TYPES = {};

/** 按码点切分，不切断代理对；QQ 文本单条约 2000 字，留余量 */
export function chunkText(text, max = 1800) {
  const s = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!s) return [];
  const out = [];
  let buf = "";
  for (const line of s.split("\n")) {
    const piece = line + "\n";
    if (buf && buf.length + piece.length > max) { out.push(buf.replace(/\n$/, "")); buf = ""; }
    if (piece.length > max) {
      let rest = piece;
      while (rest.length > max) { out.push(rest.slice(0, max)); rest = rest.slice(max); }
      buf = rest;
    } else buf += piece;
  }
  if (buf.trim()) out.push(buf.replace(/\n$/, ""));
  return out.filter((x) => x.trim().length > 0);
}

// ── QQ 官方机器人适配器 ──────────────────────────────────────────────
// 令牌：POST bots.qq.com/app/getAppAccessToken（有效期约 2 小时，提前 5 分钟换）
// 网关：GET {apiBase}/gateway → wss 地址；Hello(op10) → Identify(op2) / Resume(op6)
// 事件：C2C_MESSAGE_CREATE（私聊）、GROUP_AT_MESSAGE_CREATE（群里 @ 机器人）
// 发送：POST /v2/users/{openid}/messages、/v2/groups/{group_openid}/messages
const QQ_TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";
const QQ_INTENTS = 1 << 25;   // GROUP_AND_C2C_EVENT
const QQ_API = (cfg) => (cfg.sandbox ? "https://sandbox.api.sgroup.qq.com" : "https://api.sgroup.qq.com");
const TOKENS = new Map();       // appId → { token, exp }
const TOKEN_WAIT = new Map();   // appId → Promise

async function qqToken(cfg, force = false) {
  const key = String(cfg.appId);
  const c = TOKENS.get(key);
  if (!force && c && c.exp > now()) return c.token;
  if (TOKEN_WAIT.has(key)) return TOKEN_WAIT.get(key);
  const p = (async () => {
    const res = await fetch(QQ_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId: key, clientSecret: String(cfg.appSecret) }),
      signal: AbortSignal.timeout(15000),
    });
    const j = await res.json().catch(() => null);
    if (!res.ok || !j || !j.access_token) {
      const why = j && (j.message || j.err_code || j.code) || res.status;
      throw new Error(tz("换 QQ 令牌失败（{e}），检查 AppID / AppSecret", { e: why }));
    }
    const ttl = Math.max(60, (+j.expires_in || 7200) - 300);
    TOKENS.set(key, { token: j.access_token, exp: now() + ttl * 1000 });
    return j.access_token;
  })().finally(() => TOKEN_WAIT.delete(key));
  TOKEN_WAIT.set(key, p);
  return p;
}

async function qqApi(cfg, method, p, body, retry = true) {
  const token = await qqToken(cfg);
  const res = await fetch(QQ_API(cfg) + p, {
    method,
    headers: { authorization: "QQBot " + token, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let j = null;
  try { j = text ? JSON.parse(text) : null; } catch {}
  if (res.status === 401 && retry) { TOKENS.delete(String(cfg.appId)); return qqApi(cfg, method, p, body, false); }
  if (!res.ok) {
    const e = new Error((j && (j.message || j.err_code || j.code)) || `HTTP ${res.status}`);
    e.status = res.status;
    e.body = text;
    throw e;
  }
  return j || {};
}

/** 把 QQ 的 dispatch 归一化。返回 null 表示不关心（别的频道 / 空消息） */
export function normalizeQQDispatch(type, d, eventId) {
  if (!d || typeof d !== "object") return null;
  const text = stripMentions(String(d.content || ""));
  const id = d.id ? String(d.id) : "";
  const at = +(d.timestamp || 0) || now();
  if (type === "C2C_MESSAGE_CREATE") {
    const senderId = d.author && d.author.user_openid ? String(d.author.user_openid) : "";
    if (!id || !senderId) return null;
    return { kind: "user", chatId: senderId, senderId, text: text.trim(), messageId: id, eventId: eventId || "", at,
      attachments: attachmentsOf(d), ...sceneRefs(d), quoted: elementQuote(d) };
  }
  if (type === "GROUP_AT_MESSAGE_CREATE") {
    const chatId = d.group_openid ? String(d.group_openid) : "";
    const senderId = d.author && d.author.member_openid ? String(d.author.member_openid) : "";
    if (!id || !chatId || !senderId) return null;
    return { kind: "group", chatId, senderId, text: text.trim(), messageId: id, eventId: eventId || "", at,
      attachments: attachmentsOf(d), ...sceneRefs(d), quoted: elementQuote(d) };
  }
  return null;
}

/** 引用：QQ 的入站事件不直接给被引用消息的正文，只给一个索引
 *  （message_scene.ext 里的 ref_msg_idx=REFIDX_…），要靠本地记下每条消息的 msg_idx 回查。
 *  有 msg_elements 时那个更全（带正文和附件），优先用它。 */
function sceneRefs(d) {
  const ext = d && d.message_scene && Array.isArray(d.message_scene.ext) ? d.message_scene.ext : [];
  let refIdx = "", msgIdx = "";
  for (const item of ext) {
    if (typeof item !== "string") continue;
    const eq = item.indexOf("=");
    if (eq < 0) continue;
    const k = item.slice(0, eq).trim(), v = item.slice(eq + 1).trim();
    if (!v) continue;
    if (k === "msg_idx") msgIdx = v;
    else if (k === "ref_msg_idx") refIdx = v;
  }
  if (d && Number(d.message_type) === 103 && Array.isArray(d.msg_elements)) {
    const el = d.msg_elements.find((x) => x && x.msg_idx);
    if (el) refIdx = el.msg_idx;
  }
  return { refIdx, msgIdx };
}

/** msg_elements 里被引用那条的正文/附件描述 */
function elementQuote(d) {
  const el = d && Array.isArray(d.msg_elements) ? d.msg_elements[0] : null;
  if (!el) return null;
  const parts = [];
  const text = String(el.content || "").trim();
  if (text) parts.push(text);
  for (const a of (Array.isArray(el.attachments) ? el.attachments : [])) {
    const ct = String(a && a.content_type || "").toLowerCase();
    const nm = a && a.filename ? "：" + a.filename : "";
    parts.push(ct.startsWith("image/") ? "[图片" + nm + "]" : ct.startsWith("audio/") ? "[语音]" : "[文件" + nm + "]");
  }
  const body = parts.join("\n").trim();
  return body ? { text: body } : null;
}

/** 消息里带的图片/文件。QQ 给的是 CDN 直链，自己下到本机再交给 Claude。 */
function attachmentsOf(d) {
  return (Array.isArray(d && d.attachments) ? d.attachments : [])
    .map((a) => ({
      url: String((a && (a.url || a.file_url || a.download_url || a.media_url)) || ""),
      filename: String((a && a.filename) || ""),
      contentType: String((a && a.content_type) || ""),
      size: Number(a && a.size) || 0,
    }))
    .filter((a) => a.url);
}

/** 群消息里 @机器人 会留下 <@!123> / <@123>，去掉 */
export function stripMentions(s) {
  return String(s || "").replace(/<@!?\d+>/g, " ").replace(/[ \t]{2,}/g, " ").trim();
}

const shortId = (id) => String(id || "").slice(-6) || "?";

/** QQ 的 markdown 子集挑语法：反引号 ``` 围栏渲染是乱的，波浪线 ~~~ 围栏正常；
 *  表格不支持，竖线留着会解析错。发之前先归一化。 */
function qqMd(s) {
  return String(s || "")
    .replace(/```[^\n]*\n([\s\S]*?)```/g, (m, code) => "~~~\n" + code.replace(/\n+$/, "") + "\n~~~")
    .replace(/^\s*\|?[\s:|-]*-{3,}[\s:|-]*\|?\s*$/gm, "")
    .replace(/^\|(.+)\|$/gm, (m, row) => row.split("|").map((c) => c.trim()).join(" ｜ "))
    .replace(/\n{3,}/g, "\n\n");
}

function createQQAdapter(ch, ctx) {
  const cfg = ch.config || {};
  let stopped = false, socket = null, hbTimer = null, ackTimer = null, reTimer = null;
  let seq = null, sessionId = null, attempt = 0, lastAck = 0;
  const seqs = new Map();   // msg_id → 已用的 msg_seq

  const base = () => QQ_API(cfg);

  function cleanup() {
    if (socket) { try { socket.close(); } catch {} socket = null; }
    if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
    if (ackTimer) { clearInterval(ackTimer); ackTimer = null; }
  }

  function schedule(reason) {
    if (stopped || reTimer) return;
    const delays = [1000, 2000, 5000, 10000, 20000, 30000];
    const delay = delays[Math.min(attempt, delays.length - 1)];
    attempt++;
    ctx.status("connecting", reason || null);
    log(`🔌 频道「${ch.name}」重连（${reason || "断开"}），${Math.round(delay / 1000)} 秒后第 ${attempt} 次`);
    reTimer = setTimeout(() => { reTimer = null; connect().catch(() => {}); }, delay);
    reTimer.unref?.();
  }

  // 同一条 msg_id 最多回 5 次，msg_seq 必须逐条加一
  function nextSeq(id) {
    const n = (seqs.get(id) || 0) + 1;
    seqs.set(id, n);
    if (seqs.size > 300) seqs.delete(seqs.keys().next().value);
    return n;
  }

  async function send(target, text, opts = {}) {
    const kind = target.kind === "group" ? "group" : "user";
    const p = kind === "group" ? `/v2/groups/${encodeURIComponent(target.id)}/messages` : `/v2/users/${encodeURIComponent(target.id)}/messages`;
    // QQ 的 markdown 消息不是「msg_type 2 + content」：正文要放进 markdown.content 对象里，
    // 放 content 里会被当纯文本，客户端就只显示原始的 ** 和 #。
    const md = !!cfg.markdown;
    const body = md ? { msg_type: 2, markdown: { content: qqMd(text) } } : { content: text, msg_type: 0 };
    const passive = !!opts.replyTo;
    if (passive) {
      body.msg_id = String(opts.replyTo);
      body.msg_seq = nextSeq(body.msg_id);
    }
    // 官方 SDK 只在非 markdown 时带 message_reference；markdown 模式下照带走会被拒
    if (opts.quoteId && !md) body.message_reference = { message_id: String(opts.quoteId), ignore_get_message_error: true };
    const post = () => qqApi(cfg, "POST", p, body);
    try {
      return await post();
    } catch (e) {
      if (body.message_reference && (e.status === 400 || e.status === 403)) {
        log(`📤 带引用的消息被拒（${e.message}），去掉引用重发`);
        delete body.message_reference;
        try { return await post(); } catch (e4) { e = e4; }
      }
      // 没开 markdown 权限 / 内容里有 markdown 不认：退回纯文本再发一次
      if (md && (e.status === 400 || e.status === 403)) {
        log(`📤 markdown 发不出去（${e.message}），退回纯文本`);
        body.msg_type = 0; body.content = text; delete body.markdown;
        try { return await post(); } catch (e2) { e = e2; }
      }
      // 被动回复只在一个 msg_id 的 5 分钟内有效；Claude 跑得久就过期了。
      // 退回主动消息（不带 msg_id）：机器人有主动推送权限才发得出去，没有就只好如实报错。
      if (passive && (e.status === 400 || e.status === 403 || e.status === 404)) {
        log(`📤 频道被动回复过期，改发主动消息`);
        delete body.msg_id; delete body.msg_seq;
        return post();
      }
      throw e;
    }
  }

  /** 发本机文件：先上传拿 file_info，再发一条富媒体消息（msg_type 7）。
   *  file = { buf, name, type } */
  async function sendFile(target, file, opts = {}) {
    const kind = target.kind === "group" ? "group" : "user";
    const base = kind === "group" ? `/v2/groups/${encodeURIComponent(target.id)}` : `/v2/users/${encodeURIComponent(target.id)}`;
    const ft = /^image\//.test(file.type) ? 1 : /^video\//.test(file.type) ? 2 : /^audio\//.test(file.type) ? 3 : 4;
    const up = await qqApi(cfg, "POST", base + "/files", {
      file_type: ft, file_data: file.buf.toString("base64"), srv_send_msg: false,
      ...(ft === 4 ? { file_name: file.name } : {}),   // 只有「文件」类型认 file_name
    });
    const fi = (up && (up.file_info || up.file_uuid)) || "";
    if (!fi) throw new Error(tz("上传没有返回 file_info"));
    const body = { msg_type: 7, media: { file_info: fi } };
    if (opts.replyTo) { body.msg_id = String(opts.replyTo); body.msg_seq = nextSeq(body.msg_id); }
    return qqApi(cfg, "POST", base + "/messages", body);
  }

  async function identify(token) {
    if (!socket || socket.readyState !== 1) return;
    const d = { token: "QQBot " + token, intents: QQ_INTENTS, shard: [0, 1], properties: { $os: "android", $browser: "cccodroid", $device: "cccodroid" } };
    socket.send(JSON.stringify(sessionId != null && seq != null ? { op: 6, d: { token: d.token, session_id: sessionId, seq } } : { op: 2, d }));
  }

  async function onMessage(raw) {
    let pl;
    try { pl = JSON.parse(typeof raw === "string" ? raw : String(raw)); } catch { return; }
    if (typeof pl.s === "number") seq = pl.s;
    if (pl.op === 10) {
      const interval = Math.max(5000, +(pl.d && pl.d.heartbeat_interval) || 30000);
      const token = await qqToken(cfg);
      await identify(token);
      if (hbTimer) clearInterval(hbTimer);
      hbTimer = setInterval(() => {
        if (!socket || socket.readyState !== 1) return;
        try { socket.send(JSON.stringify({ op: 1, d: seq })); } catch {}
      }, interval);
      // 两个心跳周期没有任何回音：当成死连接，重连
      if (ackTimer) clearInterval(ackTimer);
      lastAck = now();
      ackTimer = setInterval(() => {
        if (now() - lastAck > interval * 2.5) { cleanup(); schedule("心跳超时"); }
      }, Math.max(5000, interval));
      return;
    }
    if (pl.op === 11) { lastAck = now(); return; }
    if (pl.op === 7) { cleanup(); schedule("服务器要求重连"); return; }
    if (pl.op === 9) {
      sessionId = null; seq = null;
      TOKENS.delete(String(cfg.appId));
      cleanup(); schedule("会话失效");
      return;
    }
    if (pl.op !== 0) return;
    const t = pl.t || "";
    if (t === "READY") {
      sessionId = (pl.d && pl.d.session_id) || null;
      attempt = 0;
      ctx.status("online", null);
      ctx.event(tz("已连上 QQ"));
      log(`🔌 频道「${ch.name}」已连上 QQ`);
      return;
    }
    if (t === "RESUMED") { attempt = 0; ctx.status("online", null); ctx.event(tz("连接已恢复")); return; }
    // QQ 的附件字段各家版本不太一样（url / file_url …），先把原始消息记下来：
    // 图片收不到时，日志里能直接看到它到底给了什么字段
    const dd = pl.d || {};
    if (Array.isArray(dd.attachments) || !String(dd.content || "").trim()) {
      try { log(`📥 QQ 原始消息：${JSON.stringify(dd).slice(0, 1200)}`); } catch {}
    }
    const msg = normalizeQQDispatch(t, pl.d, pl.id);
    if (msg) ctx.inbound(msg);
  }

  async function connect() {
    if (stopped) return;
    cleanup();
    ctx.status("connecting", null);
    const token = await qqToken(cfg);
    const gw = await qqApi(cfg, "GET", "/gateway");
    if (!gw || !gw.url) throw new Error(tz("没拿到 WebSocket 地址"));
    if (typeof WebSocket !== "function") throw new Error(tz("这个 Node 不支持 WebSocket"));
    const ws = new WebSocket(gw.url);
    socket = ws;
    ws.addEventListener("open", () => { if (!stopped) log(`🔌 频道「${ch.name}」WebSocket 已打开`); });
    ws.addEventListener("message", (ev) => { onMessage(ev.data).catch((e) => log(`频道「${ch.name}」事件出错: ${e.message}`)); });
    ws.addEventListener("close", (ev) => {
      if (stopped || socket !== ws) return;
      cleanup();
      schedule(`连接关闭 ${ev.code || ""}`.trim());
    });
    ws.addEventListener("error", () => {
      if (stopped || socket !== ws) return;
      schedule("连接出错");
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(tz("连接超时"))), 20000);
      ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error(tz("连接失败"))); }, { once: true });
    });
  }

  return {
    async start() {
      try { await connect(); }
      catch (e) { ctx.status("error", e.message); schedule(e.message); }
    },
    async stop() {
      stopped = true;
      if (reTimer) { clearTimeout(reTimer); reTimer = null; }
      cleanup();
      ctx.status("off", null);
    },
    send,
    sendFile,
    async probe() {
      const token = await qqToken(cfg);
      const gw = await qqApi(cfg, "GET", "/gateway");
      return { token: token.slice(0, 6) + "…", gateway: !!gw.url, sandbox: !!cfg.sandbox };
    },
  };
}

// ── 扫码绑定（QQ 官方机器人）────────────────────────────────────────
// 腾讯的「扫码连接」接口，OpenClaw 的 @tencent-connect/qqbot-connector 走的也是这三个 POST：
//   /lite/create_bind_task  {key}      → task_id（key 是本地随机 32 字节，base64）
//   手机 QQ 扫 q.qq.com/qqbot/openclaw/connect.html?task_id=…
//   /lite/poll_bind_result  {task_id}  → status 0/1 等、2 完成、3 过期；
//                                        完成时带 bot_appid 和加密的 bot_encrypt_secret
// 密文 = base64(IV 12 | 密文 | tag 16)，用 create 时的 key 做 AES-256-GCM 解。
const QQ_BIND_PAGE = "https://q.qq.com/qqbot/openclaw/connect.html";
const QQ_BIND_STATE = ["pending", "pending", "ok", "expired"];
const BINDS = new Map();   // taskId → { key, at }；只放内存，重启网关就作废

export function qqBindUrl(taskId, source = "cccodroid") {
  return `${QQ_BIND_PAGE}?task_id=${encodeURIComponent(taskId)}&source=${encodeURIComponent(source)}&_wv=2`;
}

/** base64(key) + base64(IV 12 | 密文 | tag 16) → 明文 */
export function qqDecryptSecret(keyB64, encB64) {
  const key = Buffer.from(String(keyB64), "base64");
  const buf = Buffer.from(String(encB64), "base64");
  if (key.length !== 32 || buf.length < 29) throw new Error(tz("绑定回来的密文格式不对"));
  const d = crypto.createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(buf.length - 16));
  return Buffer.concat([d.update(buf.subarray(12, buf.length - 16)), d.final()]).toString("utf8");
}

async function qqBindPost(p, body) {
  const res = await fetch("https://q.qq.com" + p, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j || j.retcode !== 0) {
    const why = (j && (j.msg || j.retcode)) || res.status;
    throw new Error(tz("扫码接口出错（{e}）", { e: why }));
  }
  return j.data || {};
}

async function qqBindStart() {
  const key = crypto.randomBytes(32).toString("base64");
  const d = await qqBindPost("/lite/create_bind_task", { key });
  const taskId = String(d.task_id || "");
  if (!taskId) throw new Error(tz("扫码接口没给任务号"));
  for (const [k, v] of BINDS) if (v.at < now() - 15 * 60000) BINDS.delete(k);   // 没人扫的旧任务清掉
  BINDS.set(taskId, { key, at: now() });
  return { taskId, url: qqBindUrl(taskId) };
}

async function qqBindPoll(taskId) {
  const s = BINDS.get(taskId);
  if (!s) return { status: "expired" };
  const d = await qqBindPost("/lite/poll_bind_result", { task_id: taskId });
  const status = QQ_BIND_STATE[Number(d.status)] || "pending";
  if (status !== "ok") {
    if (status === "expired") BINDS.delete(taskId);
    return { status };
  }
  BINDS.delete(taskId);
  return {
    status: "ok",
    appId: String(d.bot_appid || ""),
    appSecret: qqDecryptSecret(s.key, String(d.bot_encrypt_secret || "")),
    userOpenid: d.user_openid || null,
  };
}

TYPES.qqbot = {
  id: "qqbot",
  label: "QQ 官方机器人",
  hint: tz("QQ 开放平台建的机器人。填 AppID / AppSecret，机器人上线后私聊它，或在群里 @ 它。"),
  required: ["appId", "appSecret"],
  fields: [
    { key: "appId", label: tz("AppID"), type: "text", mono: true, required: true },
    { key: "appSecret", label: tz("AppSecret"), type: "password", required: true, secret: true },
    { key: "sandbox", label: tz("用沙箱环境"), type: "bool" },
    { key: "markdown", label: tz("发 markdown 消息（需要机器人有权限，失败会自动退回纯文本）"), type: "bool" },
  ],
  capabilities: { direct: true, group: true, media: false },
  create: createQQAdapter,
};

// ── 访问门 ────────────────────────────────────────────────────────────
export const accessKey = (msg) => (msg.kind === "group" ? "g:" : "u:") + msg.chatId;

/** 陌生人 / 没批准的群：pair 模式先要配对码（私聊），群里只能等主人在应用里批准 */
export function accessDecision(ch, msg) {
  const mode = (ch.access && ch.access.mode) || "pair";
  const allow = (ch.access && Array.isArray(ch.access.allow)) ? ch.access.allow : [];
  const key = accessKey(msg);
  if (mode === "open") return { ok: true, key };
  if (mode === "allow") return allow.includes(key) ? { ok: true, key } : { ok: false, key, why: "not-allowed" };
  if (allow.includes(key)) return { ok: true, key };
  if (msg.kind === "user" && msg.text.trim() === String(ch.pairCode || "")) return { ok: true, key, pair: true };
  return { ok: false, key, why: msg.kind === "group" ? "group-pending" : "unpaired" };
}

function addPending(ch, msg) {
  if (msg.kind === "group") return;
  const key = accessKey(msg);
  let p = DB.pending.find((x) => x.channelId === ch.id && x.key === key);
  if (p) { p.lastAt = now(); }
  else { DB.pending.push({ channelId: ch.id, key, kind: msg.kind, id: msg.chatId, firstAt: now(), lastAt: now() }); save(); }
}
function dropPending(ch, key) {
  const n = DB.pending.length;
  DB.pending = DB.pending.filter((x) => !(x.channelId === ch.id && x.key === key));
  if (DB.pending.length !== n) { save(); publish({ type: "channel", id: ch.id, op: "pending" }); }
}

// ── 会话绑定 ──────────────────────────────────────────────────────────
const bkey = (cid, chatKey) => cid + "\u0000" + chatKey;
const bindingOf = (cid, chatKey) => DB.bindings[bkey(cid, chatKey)] || null;
function setBinding(cid, chatKey, sessionId, title) {
  const k = bkey(cid, chatKey);
  if (!sessionId) { if (DB.bindings[k]) { delete DB.bindings[k]; save(); } return; }
  const old = DB.bindings[k];
  DB.bindings[k] = { sessionId, title: title || (old && old.title) || "", at: now() };
  save();
}

const chatLabel = (msg) => (msg.kind === "group" ? tz("QQ 群 · {id}", { id: shortId(msg.chatId) }) : tz("QQ · {id}", { id: shortId(msg.chatId) }));

// ── 入站 → 队列 ───────────────────────────────────────────────────────
const SEEN = new Set();
const SEEN_Q = [];
const RATE = new Map();
// 每个频道会话都带上：Claude 得知道用什么写法才能把本机文件发回 QQ
const FILE_TIP = () => tz("（这是 QQ 频道会话。要把本机文件发给对方：在回复里单独占一行写 [[file:/绝对路径]]，最多 3 个，每个不超过 10MB；正文照常写。）");

const HELP = () => [
  tz("直接发消息就是在和本机的 Claude 说话。"),
  "",
  "/new " + tz("换一个新会话（原来的上下文不带上）"),
  "/stop " + tz("停下正在跑的这一轮"),
  "/status " + tz("看绑定的会话和状态"),
  "/help " + tz("这份说明"),
].join("\n");

function remember(id) {
  if (SEEN.has(id)) return false;
  SEEN.add(id); SEEN_Q.push(id);
  if (SEEN_Q.length > 500) SEEN.delete(SEEN_Q.shift());
  return true;
}

const MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json",
  ".zip": "application/zip", ".mp4": "video/mp4", ".mp3": "audio/mpeg",
};
const fmtSize = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");
const safeName = (name, type, i) => {
  const base = String(name || "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 80);
  if (base) return base;
  const ext = Object.entries(MIME).find(([, v]) => v === type);
  return "file-" + i + (ext ? ext[0] : "");
};

/** 对方发来的图片/文件存到本机，把路径写进提示词 —— Claude 用普通读文件的工具就能看 */
async function saveAttachments(ch, msg) {
  const dir = path.join(CFG.home, "channel-files", String(msg.messageId || Date.now()).replace(/[^\w.-]/g, "").slice(0, 60));
  const rows = [];
  let i = 0;
  for (const a of msg.attachments) {
    i++;
    const name = safeName(a.filename, a.contentType, i);
    try {
      const r = await fetch(a.url, { signal: AbortSignal.timeout(60000) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length) throw new Error("空文件");
      if (buf.length > 30 * 1024 * 1024) throw new Error("超过 30MB");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, name);
      fs.writeFileSync(file, buf);
      rows.push(`${file}（${a.contentType || "未知类型"}，${fmtSize(buf.length)}）`);
    } catch (e) {
      rows.push(`${name}（下载失败：${e.message}）`);
      log(`📥 频道「${ch.name}」附件下载失败: ${e.message}`);
    }
  }
  return rows.length ? "\n\n（对方发来 " + rows.length + " 个文件，已存在本机：\n" + rows.join("\n") + "）" : "";
}

/** 这次消息引用了哪条：优先 msg_elements（带正文附件），否则查本地索引 */
function quoteOf(msg) {
  if (!msg.refIdx) return "";
  if (msg.quoted && msg.quoted.text) return msg.quoted.text;
  const e = refGet(msg.refIdx);
  if (!e) return "";
  return (e.sender ? e.sender + "：" : "") + (e.text || tz("[空消息]"));
}

/** 把本机文件发给对方（deliver 里解析 [[file:...]] 用） */
async function sendLocalFile(ch, ctx, p) {
  const adapter = ACTIVE.get(ch.id);
  if (!adapter || !adapter.sendFile) throw new Error(tz("这个频道不能发文件"));
  const abs = path.resolve(String(p || "").replace(/^~/, CFG.home));
  const st = fs.statSync(abs);
  if (!st.isFile()) throw new Error(tz("不是文件：{p}", { p: abs }));
  if (st.size > 10 * 1024 * 1024) throw new Error(tz("文件超过 10MB：{p}", { p: abs }));
  const type = MIME[path.extname(abs).toLowerCase()] || "application/octet-stream";
  await adapter.sendFile({ kind: ctx.kind === "group" ? "group" : "user", id: ctx.chatId },
    { buf: fs.readFileSync(abs), name: path.basename(abs), type }, { replyTo: ctx.messageId });
  return path.basename(abs);
}

// 回复里的 [[file:/绝对路径]]：单独一行，最多 3 个
const FILE_MARK = /^[ \t]*\[\[file:([^\]\n]+)\]\][ \t]*$/gm;
function takeFiles(text) {
  const paths = [];
  const clean = String(text || "").replace(FILE_MARK, (m, p2) => { paths.push(p2.trim()); return ""; })
    .replace(/\n{3,}/g, "\n\n").trim();
  return { clean, paths: paths.slice(0, 3) };
}

async function replyTo(ch, msg, text, opts) {
  const adapter = ACTIVE.get(ch.id);
  if (!adapter) { pushEvent(ch.id, "err", tz("频道没在运行，回复没发出去")); return false; }
  const target = { kind: msg.kind === "group" ? "group" : "user", id: msg.chatId };
  const parts = chunkText(text);
  try {
    for (const part of parts) {
      // QQ 只认被动回复：msg_id 必须是刚收到那条消息的 id，配 msg_seq 递增，5 分钟内有效。
      // 以前这里只有 opts.passive 为真才带 msg_id，而没有任何调用方传它，于是全走 event_id ——
      // QQ 对 event_id 回的是「对应事件不能回复消息」，等于一条都发不出去。
      await adapter.send(target, part, { replyTo: msg.messageId, quoteId: msg.messageId });
      await sleep(250);
    }
    const r = runtime(ch.id);
    r.stats.out++;
    pushEvent(ch.id, "out", text);
    return true;
  } catch (e) {
    const r = runtime(ch.id);
    r.stats.err++;
    pushEvent(ch.id, "err", tz("发不出去：{e}", { e: e.message }));
    log(`📤 频道「${ch.name}」发送失败: ${e.message}`);
    return false;
  }
}

async function handleInbound(ch, msg) {
  if (!ch.on) return;
  if (!remember(msg.messageId)) return;                    // 断线重连会重放事件
  // 限流只为挡住刷屏：同一句话 1.2 秒内重复才丢。以前按「这个人」算，
  // 连发「看看图片」+ 一张图时，第二个事件直接被吞掉，图就永远收不到
  const rateKey = ch.id + "\u0000" + accessKey(msg) + "\u0000" + String(msg.text || "").slice(0, 40);
  const last = RATE.get(rateKey) || 0;
  if (!(msg.attachments && msg.attachments.length) && now() - last < 1200) return;
  RATE.set(rateKey, now());
  if (RATE.size > 500) RATE.delete(RATE.keys().next().value);

  runtime(ch.id).stats.in++;
  // 每条消息都记一笔，别人引用它时才有东西可回查
  refPut(msg.msgIdx || msg.messageId, { text: String(msg.text || "").slice(0, 200), sender: shortId(msg.senderId), at: now() });
  pushEvent(ch.id, "in", (msg.kind === "group" ? tz("[群]") + " " : "") + (msg.text || (msg.attachments && msg.attachments.length ? tz("[附件]") : "")), { sender: shortId(msg.senderId), sessionId: null });

  const dec = accessDecision(ch, msg);
  if (!dec.ok) {
    addPending(ch, msg);
    if (dec.why === "unpaired") {
      await replyTo(ch, msg, tz("这个机器人还没和任何人配对。在应用里打开 设置 → 频道，把配对码发给它（配对码是 {c}）。", { c: ch.pairCode }));
    } else if (dec.why === "group-pending") {
      await replyTo(ch, msg, tz("这个群还没被允许。请机器人的主人在应用 → 频道里点「允许」。"));
    } else {
      await replyTo(ch, msg, tz("你不在白名单里。"));
    }
    return;
  }
  if (dec.pair) {
    ch.access.allow = [...new Set([...(ch.access.allow || []), dec.key])].slice(0, 200);
    ch.updatedAt = now();
    save();
    dropPending(ch, dec.key);
    await replyTo(ch, msg, tz("配对成功。以后直接发消息就行；发 /help 看命令。"));
    return;
  }
  // 纯图片/文件也是一条消息：content 是空的，但 attachments 有东西，照样要跑一轮
  const hasAtt = !!(msg.attachments && msg.attachments.length);
  if (!msg.text && !hasAtt) return;

  const cmd = msg.text.match(/^\/(\w+)(?:\s+([\s\S]*))?$/);
  if (cmd) {
    const name = cmd[1].toLowerCase();
    const chatKey = accessKey(msg);
    const bound = bindingOf(ch.id, chatKey);
    if (name === "help") return replyTo(ch, msg, HELP());
    if (name === "new") {
      setBinding(ch.id, chatKey, null);
      return replyTo(ch, msg, tz("好，下一步开始一个新会话。"));
    }
    if (name === "status") {
      const live = bound && [...RUNS.values()].find((r) => r.sessionId === bound.sessionId && !r.ended);
      return replyTo(ch, msg, [
        tz("频道：{n}（{s}）", { n: ch.name, s: stateText(runtime(ch.id).state) }),
        bound ? tz("会话：{id}", { id: bound.sessionId.slice(0, 8) }) : tz("会话：还没开始"),
        live ? tz("状态：正在跑") : tz("状态：空闲"),
      ].join("\n"));
    }
    if (name === "stop") {
      const run = bound && [...RUNS.values()].find((r) => r.sessionId === bound.sessionId && !r.ended);
      if (!run) return replyTo(ch, msg, tz("现在没有在跑的。"));
      abortRun(run);
      return replyTo(ch, msg, tz("正在停。"));
    }
    return replyTo(ch, msg, tz("不认识的命令。发 /help 看看。"));
  }

  const route = ch.route || {};
  const chatKey = accessKey(msg);
  const prev = route.session === "new" ? null : bindingOf(ch.id, chatKey);
  let sessionId = prev ? prev.sessionId : null;

  // 权限：空 = 跟随全局（run.mjs 用 SETTINGS.permissionMode）；两个档位才单独收紧
  const perm = route.perm === "proj"
    ? { permissionMode: "acceptEdits" }
    : route.perm === "ro"
      ? { permissionMode: "default", disallowedTools: ["Edit", "Write", "MultiEdit", "NotebookEdit"] }
      : {};
  const atts = hasAtt ? await saveAttachments(ch, msg) : "";
  const said = msg.text || (hasAtt ? tz("（对方发来附件，没有写文字）") : "");
  const quoted = quoteOf(msg);
  const prompt = (msg.kind === "group" ? tz("（来自 QQ 群，发送者 {s}）", { s: shortId(msg.senderId) }) + "\n" : "") +
    (quoted ? "[被引用的消息]\n" + quoted + "\n\n[当前消息]\n" : "") +
    said + atts + "\n\n" + FILE_TIP();
  const item = enqueue({
    internal: true, message: prompt,
    projectId: route.projectId || null,
    sessionId,
    model: route.model || null, effort: route.effort || null, provider: route.provider || null,
    ...perm,
    unattended: true,
    timeoutMs: Math.max(1, +route.timeoutMin || 30) * 60000,
    channel: { channelId: ch.id, chatKey, kind: msg.kind, chatId: msg.chatId, senderId: msg.senderId, messageId: msg.messageId, eventId: msg.eventId, label: chatLabel(msg) },
  });
  log(`📥 频道「${ch.name}」收到消息，已入队（${item.id}）`);
}

// ── 出站：一轮跑完把结果发回去 ────────────────────────────────────────
function errorText(run, f) {
  const text = String((f && f.finalText) || "").trim();
  if (run.timedOut) return tz("（超过时长上限，已经停了）") + (text ? "\n\n" + text : "");
  if (run.aborted) return tz("（已停止）") + (text ? "\n\n" + text : "");
  if (f && (f.failed || f.isError)) return tz("⚠️ 出错了") + (text ? "：" + text : "");
  return text;
}

END_HOOKS.push((run, f) => {
  if (!run.channel) return;
  deliver(run, f).catch((e) => log("频道回复失败: " + e.message));
});

async function deliver(run, f) {
  const ctx = run.channel;
  const ch = byId(ctx.channelId);
  if (!ch) return;
  const raw = errorText(run, f) || tz("（没有回复）");
  // 回复里的 [[file:...]]：先把文件传上去，正文里把标记去掉
  const { clean, paths } = takeFiles(raw);
  let filesOk = 0, filesErr = 0;
  for (const p of paths) {
    try { await sendLocalFile(ch, ctx, p); filesOk++; }
    catch (e) {
      filesErr++;
      log(`📤 频道「${ch.name}」发文件失败: ${e.message}`);
      pushEvent(ch.id, "err", tz("发文件失败：{e}", { e: e.message }));
    }
  }
  const text = clean || (filesOk ? tz("（文件已发送）") : filesErr ? tz("（文件没发出去）") : tz("（没有回复）"));
  const ok = await replyTo(ch, ctx, text);
  const sid = run.sessionId || null;
  if (sid) {
    const isNew = !bindingOf(ch.id, ctx.chatKey) || (bindingOf(ch.id, ctx.chatKey) || {}).sessionId !== sid;
    if (ch.route && ch.route.session !== "new") setBinding(ch.id, ctx.chatKey, sid);
    if (!NAMES[sid]) { NAMES[sid] = ctx.label || chatLabel(ctx); saveNames(); }
    if (isNew) publish({ type: "channel", id: ch.id, op: "bound", sessionId: sid, chatKey: ctx.chatKey });
  }
  pushEvent(ch.id, ok ? "sys" : "err", ok ? tz("回复已发送（{n} 段）", { n: chunkText(text).length }) : tz("回复没发出去"), { sessionId: sid });
}

// ── 适配器生命周期 ───────────────────────────────────────────────────
const ACTIVE = new Map();

export function startChannel(ch) {
  if (!LIVE) return;
  stopChannel(ch.id, true);
  const type = TYPES[ch.type];
  if (!type) { setState(ch.id, "error", tz("不支持的频道类型：{t}", { t: ch.type })); return; }
  if (!ch.on) { setState(ch.id, "off", null); return; }
  const missing = (type.required || []).filter((k) => !(ch.config && String(ch.config[k] || "").trim()));
  if (missing.length) { setState(ch.id, "error", tz("还缺 {list}", { list: missing.join("、") })); return; }
  const rt = runtime(ch.id);
  setState(ch.id, "connecting", null);
  rt.since = now();
  const adapter = type.create(ch, {
    inbound: (msg) => { handleInbound(ch, msg).catch((e) => log(`频道「${ch.name}」处理消息出错: ${e.stack || e.message}`)); },
    event: (text) => pushEvent(ch.id, "sys", text),
    status: (state, error) => setState(ch.id, state, error),
  });
  ACTIVE.set(ch.id, adapter);
  Promise.resolve(adapter.start()).catch((e) => {
    setState(ch.id, "error", e.message);
    log(`频道「${ch.name}」启动失败: ${e.message}`);
  });
}

export function stopChannel(id, quiet) {
  const a = ACTIVE.get(id);
  ACTIVE.delete(id);
  if (a) { try { Promise.resolve(a.stop()).catch(() => {}); } catch {} }
  if (!quiet) setState(id, "off", null);
}

export function startChannels() {
  if (!LIVE) return;
  let delay = 800;
  for (const ch of DB.channels) {
    if (!ch.on) continue;
    const d = delay; delay += 1200;
    setTimeout(() => { try { startChannel(ch); } catch (e) { log("频道启动失败: " + e.message); } }, d).unref?.();
  }
}

export function stopChannels() {
  for (const id of [...ACTIVE.keys()]) stopChannel(id, true);
}

// ── 数据整理与视图 ───────────────────────────────────────────────────
const stateText = (s) => ({ off: tz("没开"), connecting: tz("连接中"), online: tz("在线"), error: tz("出错") }[s] || s);

function cleanConfig(type, input, old = {}) {
  const out = { ...old };
  if (!input || typeof input !== "object") return out;
  const s = (k, n) => { if (typeof input[k] === "string") out[k] = input[k].trim().slice(0, n); };
  s("appId", 64); s("appSecret", 200);
  for (const k of ["sandbox", "markdown"]) if (typeof input[k] === "boolean") out[k] = input[k];
  return out;
}

function cleanChannel(b, old) {
  const ch = old ? { ...old } : null;
  const type = old ? old.type : (b.type === "qqbot" ? "qqbot" : "qqbot");
  const out = ch || {
    id: "ch_" + crypto.randomBytes(5).toString("hex"),
    type, on: false, config: {}, route: { projectId: null, model: "", effort: "", provider: "", perm: "", session: "chat", timeoutMin: 30 },
    access: { mode: "pair", allow: [] }, pairCode: String(Math.floor(100000 + Math.random() * 900000)),
    createdAt: now(), updatedAt: now(),
  };
  if (typeof b.name === "string") out.name = b.name.trim().slice(0, 40);
  if (!out.name) out.name = "QQ 机器人";
  if ("on" in b) out.on = !!b.on;
  if ("config" in b) out.config = cleanConfig(out.type, b.config, out.config);
  if ("route" in b && b.route && typeof b.route === "object") {
    const r = b.route, o = { ...out.route };
    if ("projectId" in r) o.projectId = r.projectId && projectById(r.projectId) ? r.projectId : null;
    for (const k of ["model", "effort", "provider"]) if (typeof r[k] === "string") o[k] = r[k].trim().slice(0, 120);
    if (["", "ro", "proj"].includes(r.perm)) o.perm = r.perm;
    if (["chat", "new"].includes(r.session)) o.session = r.session;
    if ("timeoutMin" in r) o.timeoutMin = Math.max(1, Math.min(180, +r.timeoutMin || 30));
    out.route = o;
  }
  if ("access" in b && b.access && typeof b.access === "object") {
    const a = { ...(out.access || { mode: "pair", allow: [] }) };
    if (["pair", "open", "allow"].includes(b.access.mode)) a.mode = b.access.mode;
    if (Array.isArray(b.access.allow)) a.allow = [...new Set(b.access.allow.filter((x) => /^[ug]:[\w.:-]{1,100}$/.test(String(x))))].slice(0, 200);
    out.access = a;
  }
  if (typeof b.pairCode === "string" && /^\d{6}$/.test(b.pairCode)) out.pairCode = b.pairCode;
  out.updatedAt = now();
  return out;
}

function viewChannel(ch) {
  const rt = runtime(ch.id);
  const cfg = { ...(ch.config || {}) };
  const secretSet = !!cfg.appSecret;
  delete cfg.appSecret;
  const bindings = Object.entries(DB.bindings)
    .filter(([k]) => k.startsWith(ch.id + "\u0000"))
    .map(([k, v]) => ({ chatKey: k.slice(ch.id.length + 1), sessionId: v.sessionId, title: v.title || "", at: v.at }));
  const pending = DB.pending.filter((p) => p.channelId === ch.id);
  return {
    id: ch.id, type: ch.type, name: ch.name, on: !!ch.on, config: cfg, secretSet,
    route: ch.route, access: ch.access, pairCode: ch.pairCode, createdAt: ch.createdAt, updatedAt: ch.updatedAt,
    status: { state: rt.state, error: rt.error, since: rt.since, lastEventAt: rt.lastEventAt, stats: { ...rt.stats } },
    events: rt.events.slice(-30), bindings, pending,
  };
}

function viewAll() {
  return {
    channels: DB.channels.map(viewChannel),
    types: Object.values(TYPES).map((t) => ({ id: t.id, label: t.label, hint: t.hint, fields: t.fields, capabilities: t.capabilities })),
  };
}

// ── 路由 ──────────────────────────────────────────────────────────────
export async function routeChannels(req, res, u, p) {
  if (!p.startsWith("/api/channels")) return NEXT;
  const m = p.match(/^\/api\/channels(?:\/([^/]+))?(?:\/([^/]+))?$/);
  if (!m) return NEXT;
  const id = m[1] ? decodeURIComponent(m[1]) : null;
  const act = m[2] || null;
  const body = async () => { try { return JSON.parse((await readBody(req)) || "{}"); } catch { return null; } };

  // 扫码绑定：/api/channels/qr/start、/api/channels/qr/poll（先于按 id 查频道）
  if (id === "qr") {
    if (req.method !== "POST") return NEXT;
    try {
      if (act === "start") return sendJson(res, 200, await qqBindStart());
      if (act === "poll") {
        const b = await body();
        if (!b || !b.taskId) return sendJson(res, 400, { error: "missing taskId" });
        return sendJson(res, 200, await qqBindPoll(String(b.taskId)));
      }
    } catch (e) { return sendJson(res, 400, { error: e.message }); }
    return NEXT;
  }

  if (!id) {
    if (req.method === "GET") return sendJson(res, 200, viewAll());
    if (req.method === "POST") {
      const b = await body();
      if (!b) return sendJson(res, 400, { error: "bad json" });
      if (b.type && !TYPES[b.type]) return sendJson(res, 400, { error: "unknown type" });
      const ch = cleanChannel(b, null);
      DB.channels.push(ch);
      save();
      setState(ch.id, ch.on ? "connecting" : "off", null);
      if (ch.on) startChannel(ch);
      publish({ type: "channel", id: ch.id, op: "created" });
      return sendJson(res, 200, { channel: viewChannel(ch) });
    }
    return NEXT;
  }

  const ch = byId(id);
  if (!ch) return sendJson(res, 404, { error: "not found" });

  if (!act) {
    if (req.method === "GET") return sendJson(res, 200, { channel: viewChannel(ch) });
    if (req.method === "PATCH") {
      const b = await body();
      if (!b) return sendJson(res, 400, { error: "bad json" });
      const before = JSON.stringify({ c: ch.config, t: ch.type });
      Object.assign(ch, cleanChannel(b, ch));
      save();
      const after = JSON.stringify({ c: ch.config, t: ch.type });
      if (ch.on && (before !== after || "on" in b)) startChannel(ch);
      else if (!ch.on) stopChannel(ch.id);
      publish({ type: "channel", id: ch.id, op: "updated" });
      return sendJson(res, 200, { channel: viewChannel(ch) });
    }
    if (req.method === "DELETE") {
      stopChannel(ch.id);
      DB.channels = DB.channels.filter((x) => x.id !== ch.id);
      for (const k of Object.keys(DB.bindings)) if (k.startsWith(ch.id + "\u0000")) delete DB.bindings[k];
      DB.pending = DB.pending.filter((x) => x.channelId !== ch.id);
      RUNTIME.delete(ch.id);
      save();
      publish({ type: "channel", id: ch.id, op: "deleted" });
      return sendJson(res, 200, { ok: true });
    }
    return NEXT;
  }

  if (req.method !== "POST") return NEXT;

  if (act === "restart") {
    startChannel(ch);
    return sendJson(res, 200, { channel: viewChannel(ch) });
  }
  if (act === "test") {
    const type = TYPES[ch.type];
    if (!type) return sendJson(res, 400, { error: "unknown type" });
    const missing = (type.required || []).filter((k) => !(ch.config && String(ch.config[k] || "").trim()));
    if (missing.length) return sendJson(res, 400, { error: tz("还缺 {list}", { list: missing.join("、") }) });
    if (ch.type === "qqbot") {
      try {
        const token = await qqToken(ch.config);
        const gw = await qqApi(ch.config, "GET", "/gateway");
        return sendJson(res, 200, { ok: true, message: tz("凭据有效：令牌 {t}…，WebSocket 地址{ok}", { t: token.slice(0, 6), ok: gw && gw.url ? tz("拿到了") : tz("没拿到") }) });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }
    return sendJson(res, 200, { ok: true, message: tz("没有可测的项") });
  }
  if (act === "pair-code") {
    ch.pairCode = String(Math.floor(100000 + Math.random() * 900000));
    ch.updatedAt = now();
    save();
    return sendJson(res, 200, { pairCode: ch.pairCode });
  }
  if (act === "approve" || act === "reject") {
    const b = await body();
    if (!b || !b.key) return sendJson(res, 400, { error: "missing key" });
    const key = String(b.key);
    if (act === "approve") {
      ch.access.allow = [...new Set([...(ch.access.allow || []), key])].slice(0, 200);
      ch.updatedAt = now();
      save();
    }
    dropPending(ch, key);
    return sendJson(res, 200, { channel: viewChannel(ch) });
  }
  if (act === "test-send") {
    const b = await body();
    if (!b || !b.kind || !b.id || !String(b.text || "").trim()) return sendJson(res, 400, { error: "missing fields" });
    const adapter = ACTIVE.get(ch.id);
    if (!adapter) return sendJson(res, 400, { error: tz("频道没在运行") });
    try {
      await adapter.send({ kind: b.kind, id: String(b.id) }, String(b.text).slice(0, 1800), {});
      pushEvent(ch.id, "out", b.text);
      return sendJson(res, 200, { ok: true });
    } catch (e) { return sendJson(res, 400, { error: e.message }); }
  }
  if (act === "unbind") {
    const b = await body();
    if (!b || !b.chatKey) return sendJson(res, 400, { error: "missing chatKey" });
    setBinding(ch.id, String(b.chatKey), null);
    return sendJson(res, 200, { channel: viewChannel(ch) });
  }
  return NEXT;
}
