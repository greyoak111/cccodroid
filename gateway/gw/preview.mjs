import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { MIME, NEXT, readBody, sendJson } from "./http.mjs";
import { fileRoots, safeFilePath } from "./files.mjs";
import { PATHS } from "./config.mjs";

// ── HTML 预览 ─────────────────────────────────────────────────────────
// 查看器里渲染 HTML：另起一个只读的小服务（随机端口，地址用 localhost），和界面（127.0.0.1:端口）不同站点——
// 预览页里的脚本拿不到界面的 Cookie，也过不了 /api 的 Origin 校验，Claude 写的网页随便跑也碰不到网关。
// 每次预览发一张随机凭证，只能读那个 HTML 所在目录里的东西；路径照样过 safeFilePath（密钥、私有目录照旧拦）。
// 网址形如 http://localhost:<端口>/<凭证>/index.html，相对路径自然解析；"/assets/x.js" 这种站点绝对路径按 Referer 里的凭证找回来。
// "../assets/x.css"（页面在子目录、资源在上级，生成的网站常这样）会被浏览器规整成 /assets/x.css，同样走 Referer；
// 这两种在页面目录里找不到时往上找，但能往上找到哪一层在发凭证时就定死（最多 UP_LEVELS 层），
// 而且绝不爬进「大目录」：存储根、存储根下一级（Download、DCIM…）、工作区根、文件面板的快捷入口。
// 否则 /sdcard/Download/a.html 里的脚本能借 Referer 爬到 /sdcard，把相册整个读走（10-25 安全审计 H-1）。
// 页面本身就在存储根时，凭证只认这一个文件。
const UP_LEVELS = 3;
// 凭证闲置这么久就作废；预览页一直在用（每次取资源）就顺延（原来固定 12 小时，审查 10-29 高1）
const CAP_IDLE = 3600e3;
// 预览页的脚本能读到它所在目录树里的文件，所以这些一概不交：以点开头的路径（.env、.git、.npmrc…）、私钥证书一类
const PREVIEW_DENY = /(^|\/)\.(?!well-known(\/|$))|\.(pem|key|p12|pfx|jks|keystore|kdbx|gpg|asc)$|(^|\/)id_[a-z0-9]+(\.pub)?$/i;
const PREVIEW = { server: null, port: 0, starting: null, caps: new Map() };
// 不联网（默认）：预览页能读到它所在目录树里的文件，没有外发通道这些才出不去（审查 v0513b 中-5）。
// 脚本照常跑（内联、eval 都许），资源只许从本机预览服务来；被拦的地址经 report-uri 报回来，查看器提示可以一键允许联网。
// 页面把自己跳到外站这种 CSP 管不了，由壳在原生层拦（MainActivity.pvOffline）
const PV_CSP = (cap) => "default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval'; connect-src 'self'; form-action 'self'; base-uri 'self'; "
  + `frame-src 'self' data: blob:; worker-src 'self' blob:; report-uri /__cc/csp/${cap}`;
const BLOCKED_MAX = 20;
function previewStart() {
  if (PREVIEW.port) return Promise.resolve(PREVIEW.port);
  if (PREVIEW.starting) return PREVIEW.starting;
  PREVIEW.starting = new Promise((resolve, reject) => {
    const srv = http.createServer(previewServe);
    srv.on("error", (e) => { PREVIEW.starting = null; reject(e); });
    srv.unref();   // 网关有主服务撑着；单测里别让它拖住进程
    // 预览只收 GET 和很小的 CSP 报告：请求头 20 秒、整个请求 60 秒内收完，慢连接别一直挂着
    srv.headersTimeout = 20e3; srv.requestTimeout = 60e3;
    srv.listen(0, "127.0.0.1", () => { PREVIEW.server = srv; PREVIEW.port = srv.address().port; resolve(PREVIEW.port); });
  });
  return PREVIEW.starting;
}
const STORAGE_ROOT = /^\/storage\/(emulated\/\d+|[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4})$/;
const real = (d) => { try { return fs.realpathSync(d); } catch { return d; } };
function broadDirs() {
  const out = new Set(["/", "/sdcard", "/storage", "/storage/emulated", "/storage/self", "/data", "/mnt"]);
  for (const d of fileRoots()) out.add(real(d));
  return out;
}
/** 不许当预览根、也不许往上爬进去的目录 */
function isBroad(d, set) {
  if (set.has(d) || STORAGE_ROOT.test(d) || STORAGE_ROOT.test(path.dirname(d))) return true;
  return d.split("/").filter(Boolean).length <= 1;
}
async function previewGrant(p, net) {
  const r = safeFilePath(p);
  if (r.error) return r;
  const port = await previewStart();
  const now = Date.now();
  for (const [k, v] of PREVIEW.caps) if (v.exp < now) PREVIEW.caps.delete(k);
  const root = path.dirname(r.file), broad = broadDirs();
  // 页面在存储根（或 / 这类）：只放这一个文件；其他大目录（Download、工作区根…）：只在本目录里找，不往上爬
  const only = STORAGE_ROOT.test(root) || root.split("/").filter(Boolean).length <= 1 ? r.file : "";
  const bases = [root];
  if (!isBroad(root, broad)) {
    for (let b = root, i = 0; i < UP_LEVELS; i++) {
      const up = path.dirname(b);
      if (up === b || isBroad(up, broad)) break;
      bases.push(up); b = up;
    }
  }
  const key = root + "\0" + only;
  let cap = [...PREVIEW.caps].find(([, v]) => v.key === key)?.[0];   // 同一目录复用，刷新不换网址
  if (!cap) { cap = crypto.randomBytes(12).toString("hex"); if (PREVIEW.caps.size >= 200) PREVIEW.caps.delete(PREVIEW.caps.keys().next().value); }
  const old = PREVIEW.caps.get(cap);
  const g = { root, bases, only, key, exp: now + CAP_IDLE, net: typeof net === "boolean" ? net : !!(old && old.net), blocked: (old && old.blocked) || new Set(), dt: old && old.dt };
  if (net === true) g.blocked.clear();
  PREVIEW.caps.set(cap, g);
  return { url: `http://localhost:${port}/${cap}/${path.basename(r.file).split("/").map(encodeURIComponent).join("/")}`, mtime: r.mtime, net: g.net };
}
function previewServe(req, res) {
  // 网址里带着能力令牌：页面里点外链时别把它当 Referer 带出去（审查 v0.5.7 L2）。setHeader 先放，下面各处 writeHead 都会带上。
  // same-origin 而不是 no-referrer：外站照样一个字节都拿不到，预览服务自己要靠 Referer 给 /assets/x.svg 这种站点绝对路径找回凭证（审查 B30）
  res.setHeader("referrer-policy", "same-origin");
  const fail = (code, msg) => { res.writeHead(code, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }); res.end(msg); };
  const host = String(req.headers.host || "").toLowerCase();
  if (host !== `localhost:${PREVIEW.port}` && host !== `127.0.0.1:${PREVIEW.port}`) return fail(421, "bad host");
  // CSP 违规报告：记下被拦的外网主机（只记主机名，最多 BLOCKED_MAX 个），查看器据此提示
  const rep = req.method === "POST" && /^\/__cc\/csp\/([0-9a-f]{24})$/.exec(String(req.url || "").split("?")[0]);
  if (rep) {
    const g = PREVIEW.caps.get(rep[1]);
    let n = 0, body = "";
    req.setEncoding("utf8");
    req.on("data", (c) => { n += c.length; if (n <= 16384) body += c; else req.destroy(); });
    req.on("end", () => {
      try {
        const j = JSON.parse(body), r0 = j["csp-report"] || (Array.isArray(j) ? (j[0] || {}).body : j.body) || {};
        const h = new URL(String(r0["blocked-uri"] || r0.blockedURL || "")).host;
        if (g && h && h.length <= 253 && g.blocked.size < BLOCKED_MAX) g.blocked.add(h);
      } catch {}
      res.writeHead(204); res.end();
    });
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") return fail(405, "read only");
  let pathname, query;
  try { const u = new URL(req.url, "http://localhost"); pathname = decodeURIComponent(u.pathname); query = u.searchParams; } catch { return fail(400, "bad path"); }
  // 开发者工具（Eruda，MIT，随包内置）：本体从包里吐，不走网络；凭证随机，不会和 __cc 撞
  const CC_FILES = { "/__cc/eruda.js": ["eruda", "eruda.js"], "/__cc/pick.js": ["cc-pick.js"] };
  if (CC_FILES[pathname]) {
    let buf; try { buf = fs.readFileSync(path.join(PATHS.web, "vendor", ...CC_FILES[pathname])); } catch { return fail(404, "no devtools"); }
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "max-age=86400", "content-length": buf.length });
    return res.end(req.method === "HEAD" ? undefined : buf);
  }
  const segs = pathname.split("/").filter(Boolean);
  let cap = segs[0], rel = segs.slice(1), viaRef = false;
  if (!PREVIEW.caps.has(cap)) {
    // 站点绝对路径（/assets/x.js）或规整后的 ../：从引用它的页面找回凭证
    let ref = ""; try { ref = new URL(String(req.headers.referer || "")).pathname.split("/")[1] || ""; } catch {}
    if (!PREVIEW.caps.has(ref)) return fail(404, "preview expired — reopen the file");
    cap = ref; rel = segs; viaRef = true;
  }
  const g = PREVIEW.caps.get(cap);
  if (g.exp < Date.now()) { PREVIEW.caps.delete(cap); return fail(404, "preview expired — reopen the file"); }
  g.exp = Date.now() + CAP_IDLE;
  if (!g.net) res.setHeader("content-security-policy", PV_CSP(cap));
  // 在 base 下找 rel：字面路径和解析过符号链接的真实路径都得在 base 里
  const lookup = (base) => {
    let full = path.resolve(base, ...rel);
    if (full !== base && !full.startsWith(base + path.sep)) return { status: 403, error: "outside preview folder" };
    try { if (fs.statSync(full).isDirectory()) full = path.join(full, "index.html"); } catch {}
    const r = safeFilePath(full);
    if (r.error) return r;
    if (r.file !== base && !r.file.startsWith(base + path.sep)) return { status: 403, error: "outside preview folder" };
    if (g.only && r.file !== g.only) return { status: 403, error: "outside preview folder" };
    if (PREVIEW_DENY.test(path.relative(base, full)) || PREVIEW_DENY.test(path.relative(base, r.file))) return { status: 403, error: "not served in preview" };
    return r;
  };
  // 只在发凭证时定好的那几层里找（见 previewGrant），请求里怎么写路径都爬不出去
  let r = lookup(g.root);
  for (let i = 1; viaRef && r.error && i < g.bases.length; i++) {
    const t = lookup(g.bases[i]);
    if (!t.error) r = t;
  }
  if (r.error) return fail(r.status || 404, r.error);
  // 开着开发者工具：网页本身（带 ?cc_devtools=1 的那次请求）在 <head> 最前面插上 Eruda，好让控制台从第一行脚本起就记着。
  // 只改这次吐出去的内容，磁盘上的文件不动；按字节插（latin1 来回不改任何字节），GBK 之类的网页也不会被转坏
  // 开关记在这张凭证上：之后在预览里点链接跳到的网页（地址里没有我们的参数）照样带上；
  // 关掉开关时界面会带 _r 重新载入且不带 cc_devtools，那一次清掉。只给「整页导航」插（脚本、样式、图片请求不碰）
  const isHtml = /\.html?$/i.test(r.file), nav = !req.headers["sec-fetch-mode"] || req.headers["sec-fetch-mode"] === "navigate";
  if (isHtml && nav) {
    if (query.get("cc_devtools") === "1") g.dt = { dark: query.get("cc_dark") === "1" };
    else if (query.has("_r")) g.dt = null;
  }
  if (g.dt && isHtml && nav && req.method === "GET" && r.size <= 16 * 1024 * 1024) {
    let src; try { src = fs.readFileSync(r.file).toString("latin1"); } catch { return fail(404, "read failed"); }
    const theme = g.dt.dark ? "Dark" : "Light";
    const tag = `<script src="/__cc/pick.js"></script><script src="/__cc/eruda.js"></script><script>try{eruda.init({defaults:{displaySize:50,transparency:.97,theme:"${theme}"}})}catch(e){}</script>`;
    const m = /<head\b[^>]*>/i.exec(src) || /<html\b[^>]*>/i.exec(src) || /<!doctype[^>]*>/i.exec(src);
    const at = m ? m.index + m[0].length : 0;
    const out = Buffer.from(src.slice(0, at) + tag + src.slice(at), "latin1");
    res.writeHead(200, { "content-type": MIME[path.extname(r.file).toLowerCase()] || "text/html", "cache-control": "no-store", "x-content-type-options": "nosniff", "content-length": out.length });
    return res.end(out);
  }
  const head = { "content-type": MIME[path.extname(r.file).toLowerCase()] || "application/octet-stream",
    "cache-control": "no-store", "x-content-type-options": "nosniff", "accept-ranges": "bytes" };
  // 音视频要 Range 才能拖进度
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ""));
  let start = 0, end = r.size - 1, code = 200;
  if (m && r.size) {
    start = m[1] ? +m[1] : Math.max(0, r.size - +m[2]); end = m[1] && m[2] ? Math.min(+m[2], r.size - 1) : r.size - 1;
    if (start > end || start >= r.size) { res.writeHead(416, { "content-range": `bytes */${r.size}` }); return res.end(); }
    code = 206; head["content-range"] = `bytes ${start}-${end}/${r.size}`;
  }
  head["content-length"] = r.size ? end - start + 1 : 0;
  res.writeHead(code, head);
  if (req.method === "HEAD" || !r.size) return res.end();
  const st = fs.createReadStream(r.file, { start, end });
  st.on("error", () => { try { res.destroy(); } catch {} });
  st.pipe(res);
}

// ── 路由：/api/preview ──
export async function routePreview(req, res, u, p) {
  // ── 回复里的路径被点了：先问一下是什么（文件 / 目录 / 不存在），前端再决定开查看器还是文件面板 ──
  if (req.method === "POST" && p === "/api/preview") {
    const b = JSON.parse((await readBody(req)) || "{}");
    const r = await previewGrant(b.path, typeof b.net === "boolean" ? b.net : undefined);
    return sendJson(res, r.error ? r.status || 404 : 200, r);
  }
  // 查看器问：这个预览联网没有、拦下过哪些外网主机
  if (req.method === "GET" && p === "/api/preview/state") {
    const g = PREVIEW.caps.get(String(u.searchParams.get("cap") || ""));
    return sendJson(res, 200, g ? { net: !!g.net, blocked: [...g.blocked] } : { gone: true });
  }
  return NEXT;
}
