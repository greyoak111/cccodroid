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
const PREVIEW = { server: null, port: 0, starting: null, caps: new Map() };
function previewStart() {
  if (PREVIEW.port) return Promise.resolve(PREVIEW.port);
  if (PREVIEW.starting) return PREVIEW.starting;
  PREVIEW.starting = new Promise((resolve, reject) => {
    const srv = http.createServer(previewServe);
    srv.on("error", (e) => { PREVIEW.starting = null; reject(e); });
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
async function previewGrant(p) {
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
  PREVIEW.caps.set(cap, { root, bases, only, key, exp: now + 12 * 3600e3 });
  return { url: `http://localhost:${port}/${cap}/${path.basename(r.file).split("/").map(encodeURIComponent).join("/")}`, mtime: r.mtime };
}
function previewServe(req, res) {
  const fail = (code, msg) => { res.writeHead(code, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }); res.end(msg); };
  if (req.method !== "GET" && req.method !== "HEAD") return fail(405, "read only");
  const host = String(req.headers.host || "").toLowerCase();
  if (host !== `localhost:${PREVIEW.port}` && host !== `127.0.0.1:${PREVIEW.port}`) return fail(421, "bad host");
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
  // 在 base 下找 rel：字面路径和解析过符号链接的真实路径都得在 base 里
  const lookup = (base) => {
    let full = path.resolve(base, ...rel);
    if (full !== base && !full.startsWith(base + path.sep)) return { status: 403, error: "outside preview folder" };
    try { if (fs.statSync(full).isDirectory()) full = path.join(full, "index.html"); } catch {}
    const r = safeFilePath(full);
    if (r.error) return r;
    if (r.file !== base && !r.file.startsWith(base + path.sep)) return { status: 403, error: "outside preview folder" };
    if (g.only && r.file !== g.only) return { status: 403, error: "outside preview folder" };
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
    const r = await previewGrant(b.path);
    return sendJson(res, r.error ? r.status || 404 : 200, r);
  }
  return NEXT;
}
