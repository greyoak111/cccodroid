import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PATHS, log, reqLang, tr } from "./config.mjs";
import { localAddr, staticMac } from "./access.mjs";
import { APP } from "./appfiles.mjs";

// ── HTTP ──────────────────────────────────────────────────────────────
export const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".webmanifest": "application/manifest+json", ".woff": "font/woff", ".woff2": "font/woff2",
  // 读图 / 读文件要用的类型
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".bmp": "image/bmp", ".avif": "image/avif", ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mkv": "video/x-matroska", ".3gp": "video/3gpp",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".m4a": "audio/mp4", ".flac": "audio/flac",
  ".opus": "audio/ogg",
  ".txt": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8",
  ".log": "text/plain; charset=utf-8", ".csv": "text/csv; charset=utf-8",
  ".yaml": "text/yaml; charset=utf-8", ".yml": "text/yaml; charset=utf-8",
  ".apk": "application/vnd.android.package-archive", ".zip": "application/zip",
  ".wasm": "application/wasm",
  // HTML 预览里网页会引用的
  ".htm": "text/html; charset=utf-8", ".xml": "application/xml; charset=utf-8", ".map": "application/json; charset=utf-8",
  ".ttf": "font/ttf", ".otf": "font/otf", ".gltf": "model/gltf+json", ".glb": "model/gltf-binary",
};

const EXT_KIND = {
  image: [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".avif", ".ico", ".heic"],
  video: [".mp4", ".webm", ".mkv", ".mov", ".3gp"],
  audio: [".mp3", ".wav", ".ogg", ".m4a", ".flac", ".opus"],
  // Office：docx、表格在前端渲染；其余交给 LibreOffice 转 PDF
  docx:  [".docx", ".docm", ".dotx"],
  sheet: [".xlsx", ".xlsm", ".xlsb", ".xls", ".ods"],
  office: [".pptx", ".ppt", ".ppsx", ".pps", ".potx", ".odp", ".doc", ".dot", ".odt", ".rtf", ".wps", ".dps", ".et", ".key", ".pages", ".numbers"],
  archive: [".zip", ".7z", ".rar", ".tar", ".gz", ".tgz", ".bz2", ".tbz", ".tbz2", ".xz", ".txz", ".zst", ".tzst", ".lzma", ".lz", ".lz4", ".cab", ".iso",
            ".jar", ".apk", ".apks", ".xapk", ".aab", ".epub", ".cbz", ".cbr", ".cpio", ".rpm", ".deb", ".arj", ".lzh", ".wim", ".dmg", ".z", ".001", ".whl", ".zipx"],
  text:  [".txt", ".md", ".log", ".csv", ".json", ".yaml", ".yml", ".xml", ".html", ".htm", ".js", ".mjs",
          ".css", ".c", ".h", ".cpp", ".py", ".sh", ".java", ".kt", ".rs", ".go", ".ts", ".sql",
          ".toml", ".ini", ".conf", ".cfg", ".properties", ".gradle", ".kts", ".tsx", ".jsx", ".cjs",
          ".vue", ".svelte", ".scss", ".less", ".hpp", ".cc", ".cxx", ".rb", ".php", ".lua", ".pl",
          ".swift", ".dart", ".cs", ".zig", ".r", ".tex", ".typ", ".gd", ".tscn", ".tres", ".diff",
          ".patch", ".bash", ".zsh", ".fish", ".bat", ".ps1", ".rst", ".org", ".tsv", ".jsonl", ".svg"],
};
const KIND_OF = new Map();
for (const [k, list] of Object.entries(EXT_KIND)) for (const e of list) KIND_OF.set(e, k);

export function fileKind(name, isDir) {
  if (isDir) return "dir";
  const e = path.extname(name).toLowerCase();
  if (e === ".pdf") return "pdf";
  return KIND_OF.get(e) || "other";
}
export const mimeOf = (f) => MIME[path.extname(f).toLowerCase()] || "application/octet-stream";

/** 解析单段 Range（bytes=a-b / bytes=a- / bytes=-n）。看不清的按没有 Range 处理（回 200 全量，HTTP 允许）；
 *  范围越界返回 { bad:true }，调用方回 416。preview.mjs 的音视频出流一直用这套语义。 */
export function rangeOf(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || ""));
  if (!m || !size) return null;
  let start, end;
  if (!m[1]) {
    const n = Number(m[2]);
    if (!(n > 0)) return { bad: true };
    start = Math.max(0, size - n); end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return { bad: true };
  return { start, end };
}

/** 二进制安全的体读取（readBody 走 utf8，会把图片读坏） */
/** 读 fetch 的响应体，超过 max 字节就断开报错：厂商端点出问题、或配置指到奇怪的地址时，别一口气读进几百 MB（审查 v0.5.7 L5） */
export async function fetchText(r, max = 8 * 1024 * 1024) {
  const len = Number(r.headers.get("content-length") || 0);
  if (len > max) { try { await r.body?.cancel(); } catch {} throw new Error(`response too large (${len} bytes)`); }
  if (!r.body) return "";
  const parts = [];
  let n = 0;
  for await (const c of r.body) {
    n += c.length;
    if (n > max) { try { await r.body.cancel(); } catch {} throw new Error(`response too large (> ${max} bytes)`); }
    parts.push(c);
  }
  return Buffer.concat(parts).toString("utf8");
}
export const fetchJsonCapped = async (r, max) => JSON.parse(await fetchText(r, max));

// App 按次签名的请求：签名里带了请求体的 sha256（access.mjs 的 sigOk），读完核对，冒牌的转发时改了体就不认
const bodySigOk = (req, b) => !req.ccBodySha || crypto.createHash("sha256").update(b).digest("hex") === req.ccBodySha;
const bodyTooLarge = () => Object.assign(new Error("body too large"), { status: 413 });
export function readBodyBuf(req, max = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on("data", (c) => {
      n += c.length;
      // 超限后别 destroy：socket 一起没了，413/500 根本送不到界面（200-H-2）。把剩下的读掉丢掉，
      // 让路由的 catch / 全局处理把回执发出去
      if (n > max) { if (chunks.length) chunks.length = 0; reject(bodyTooLarge()); return; }
      chunks.push(c);
    });
    req.on("end", () => { const b = Buffer.concat(chunks); bodySigOk(req, b) ? resolve(b) : reject(new Error("body does not match signature")); });
    req.on("error", reject);
  });
}

// ── HTTP 小工具：回 JSON、静态文件、读请求体 ───────────────────────────
export function uiTag() {
  let t = 0;
  let files = [];
  try { files = fs.readdirSync(PATHS.web); } catch {}
  files = files.concat(appParts().map((f) => "app/" + f));   // app.js 的分段改了也算
  for (const f of files) {
    try { t = Math.max(t, fs.statSync(path.join(PATHS.web, f)).mtimeMs); } catch {}
  }
  return Math.round(t);
}

// app.js 的源码按功能拆在 web/app/ 下（文件名带序号），这里按文件名顺序原样拼成一个文件下发：
// 浏览器拿到的仍是同一个闭包，和拆之前逐字节相同。报错里的 app.js 行号用 node scripts/appjs.mjs --line N 对回分段
export function appParts() {
  try { return fs.readdirSync(path.join(PATHS.web, "app")).filter((f) => f.endsWith(".js")).sort(); } catch { return []; }
}
let appCache = { key: "", data: null };
export function appJs() {
  const dir = path.join(PATHS.web, "app"), parts = appParts();
  if (!parts.length) return null;
  // 部署出来的那份：分段集合也要和清单一样 —— 删掉权限卡片那一段，剩下的每段哈希都对，界面就再也不出确认卡片
  if (APP && parts.join("/") !== APP.list("web/app/").filter((f) => f.endsWith(".js")).join("/")) { APP.restart("web/app/（分段增删）"); return null; }
  const st = parts.map((f) => fs.statSync(path.join(dir, f)));
  const key = parts.map((f, i) => `${f}:${st[i].mtimeMs}:${st[i].size}`).join("|");
  if (appCache.key !== key) {
    const bufs = parts.map((f) => fs.readFileSync(path.join(dir, f)));
    // 部署出来的那份：每段都得和安装包对得上（见 appfiles.mjs），有一段不对整个不发
    if (APP && !parts.every((f, i) => APP.served(path.relative(path.dirname(PATHS.web), path.join(dir, f)), bufs[i], st[i]))) return null;
    appCache = { key, data: Buffer.concat(bufs) };
  }
  return appCache.data;
}

export function sendJson(res, code, obj) {
  if (obj && typeof obj.message === "string" && res.req) obj = { ...obj, message: tr(reqLang(res.req), obj.message) };
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": b.length });
  res.end(b);
}

// 界面自己的静态文件：不许别的站点把它套进 frame（界面内部的 iframe 同源，不受影响），不让浏览器猜类型。
// CSP 只管脚本（审查 H1）：界面所有脚本都是同源文件、没有内联脚本和内联事件，所以 script-src 'self' 不碍事，
// 而 XSS 要用的 <img onerror>、javascript: 链接、内联 <script> 全被拦 —— 万一哪天转义漏了一处，也到不了「调网关跑命令」那一步。
// 留着 unsafe-eval：打开 docx 的 mammoth 里有 new Function（它不吃页面内容，留着不削弱上面那条）；wasm-unsafe-eval 给 pdf.js 的解码器。
// 图片、样式、iframe 不收紧：外链图、预览窗格（另一个端口）都要用，收紧了容易误伤，换来的防护不大。
// 连接和表单只许同源（审查 10-30 第九份 中2）：界面的 fetch / EventSource 全是网关自己的路径，data: / blob: 留给截图转文件；
// 这样哪怕有一处转义漏了，脚本也没法把会话内容 fetch 到外面去
// Referrer-Policy：首屏 URL 带着 t= / k=，别经 Referer 漏给任何地方（审查 中8）
const STATIC_SAFE = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "frame-ancestors 'none'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'self' data: blob:; form-action 'self'; object-src 'none'; base-uri 'none'",
};
const macHdr = (req, data) => {
  const m = staticMac(req.headers["x-cc-nonce"], String(req.url || ""), data, localAddr(req));
  return m ? { "x-cc-mac": m } : {};
};
const miss404 = { at: 0, n: 0 };
// 静态回应整份读进内存再发：一条连接上流水线堆一大串请求、却不读回应，没发出去的回应全积在内存里，
// 不要凭据就能把网关撑到 OOM（0.6.9 审计 199 H-1）。按连接、按全局记「排着还没发完」的字节数，超了就不再接
const STATIC_SOCK_MAX = 32 << 20, STATIC_ALL_MAX = 128 << 20;
const staticPending = new WeakMap();   // socket → { n, rel: Set<release> }
let staticAll = 0;
function staticBudget(req, res, n) {
  const s = req.socket;
  let st = s && staticPending.get(s);
  if (s && !st) {
    st = { n: 0, rel: new Set() }; staticPending.set(s, st);
    // 排着还没轮到的回应，连接断了既不 finish 也不 close：额度在这里一并收回，不然被打几次全局额度就永远占满
    s.once("close", () => { for (const r of [...st.rel]) r(); });
  }
  if (st && st.n + n > STATIC_SOCK_MAX) { s.destroy(); return false; }
  if (staticAll + n > STATIC_ALL_MAX) { sendJson(res, 503, { error: "busy" }); return false; }
  staticAll += n; if (st) st.n += n;
  const release = () => { if (st && !st.rel.delete(release)) return; if (!st && release.done) return; release.done = true; staticAll -= n; if (st) st.n -= n; };
  if (st) st.rel.add(release);
  res.on("finish", release); res.on("close", release);
  return true;
}
export const _staticForTest = { pending: () => staticAll };
export function serveStatic(req, res, urlPath) {
  let rel = urlPath === "/" ? "/index.html" : urlPath;
  rel = rel.replace(/^\/+/, "");
  if (rel.includes("..")) return sendJson(res, 403, { error: "forbidden" });
  if (rel === "app.js") {
    const data = appJs();
    if (!data && APP?.restartWanted) return sendJson(res, 503, { error: "app files modified" });
    if (data) {
      if (!staticBudget(req, res, data.length)) return;
      res.writeHead(200, { "content-type": MIME[".js"], "content-length": data.length, "cache-control": "no-store", ...STATIC_SAFE, ...macHdr(req, data) });
      return res.end(data);
    }
  }
  const full = path.join(PATHS.web, rel);
  if (!full.startsWith(PATHS.web + path.sep) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    const r = path.relative(path.dirname(PATHS.web), full);
    if (APP && APP.has(r)) { APP.restart(`${r}（被删了）`); return sendJson(res, 503, { error: "app files modified" }); }
    // 404 不逐条记（审查 10-30 第九份 高3）：10 秒里只记第一条，其余的计数并进下一条
    const now = Date.now();
    if (now - miss404.at > 10e3) { log(`404 ${rel.slice(0, 200)}${miss404.n ? `（此前 10 秒内另有 ${miss404.n} 次 404）` : ""}`); miss404.at = now; miss404.n = 0; }
    else miss404.n++;
    return sendJson(res, 404, { error: "not found", path: rel });
  }
  // 先按大小占额度，再读：超了连文件都不读
  if (!staticBudget(req, res, fs.statSync(full).size)) return;
  const data = fs.readFileSync(full);
  if (APP && !APP.served(path.relative(path.dirname(PATHS.web), full), data, fs.statSync(full))) return sendJson(res, 503, { error: "app files modified" });
  res.writeHead(200, {
    "content-type": MIME[path.extname(full).toLowerCase()] || "application/octet-stream",
    "content-length": data.length,
    "cache-control": "no-store",
    ...STATIC_SAFE,
    ...macHdr(req, data),
  });
  res.end(data);
}

export function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > 16 * 1024 * 1024) { if (chunks.length) chunks.length = 0; reject(bodyTooLarge()); return; }
      chunks.push(c);
    });
    req.on("end", () => { const b = Buffer.concat(chunks); bodySigOk(req, b) ? resolve(b.toString("utf8")) : reject(new Error("body does not match signature")); });
    req.on("error", reject);
  });
}

// 路由函数没认领这个请求时返回它，交给下一个
export const NEXT = Symbol("next");
/** 解网址里的一段：畸形的 %xx 返回空串（不抛 URIError 成 500，审查 v0513b 低-6） */
export const dec = (s) => { try { return decodeURIComponent(s); } catch { return ""; } };

// 流式响应（事件流、streamfix 代理）往外写一律写 Buffer，不写字符串：自带的 Node 26 在 HTTP/1.1 分块响应里连续写多字节（中文）字符串，
// 写满返回 false 后 drain 可能再也不来（响应、套接字都已没有待写字节，响应却一直 needDrain），
// 等它的那一路就停在半路（事件流的补发发不出 sync、代理暂停了上游就再也不续）；同样的字节换成 Buffer 写就正常（0.6.9 审计 #187，本机复现过）
/** 写一条；写满了就等对端收走再回来。drain 万一不来，待写字节清空也算（同上，多一道保险），连接断了直接回 */
export function writePaced(res, chunk) {
  if (res.write(typeof chunk === "string" ? Buffer.from(chunk) : chunk)) return null;
  return new Promise((r) => {
    const go = () => { clearInterval(t); res.off("drain", go); res.off("close", go); r(); };
    const t = setInterval(() => { if (res.destroyed || res.writableLength === 0) go(); }, 200);
    res.once("drain", go); res.once("close", go);
  });
}
