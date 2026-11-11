import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CFG, PREFIX, log, tz } from "./config.mjs";
import { SETTINGS } from "./settings-store.mjs";
import { SEED_FILE } from "./providers.mjs";
import { NEXT, fileKind, mimeOf, rangeOf, readBody, readBodyBuf, sendJson } from "./http.mjs";
import { toFront } from "./local.mjs";
import { bodyToFile } from "./bigfile.mjs";
import { fixUploadedImage } from "./imgfix.mjs";
import { holdsPrivate, zoneOf } from "./pathguard.mjs";

// ── 文件收发：读图 / 读文件 / 把东西递进来 ────────────────────────────
// /api/file   把磁盘上的文件流给界面（消息里的图片靠它显示）
// /api/upload 把界面拿到的东西（粘贴/拖放/选择）落盘成 claude 能读的路径
export const UPLOAD_DIR = path.join(CFG.workspace, "uploads");
/** 按 UTF-8 字节数截断，不切开多字节字符 */
export function clipBytes(s, max) {
  if (Buffer.byteLength(s) <= max) return s;
  let out = "", n = 0;
  for (const ch of s) { const b = Buffer.byteLength(ch); if (n + b > max) break; out += ch; n += b; }
  return out;
}
const UPLOAD_MAX = 4 * 1024 ** 3;   // 单个附件上限（流式落盘）

/** 绝不外发的路径：密钥所在的应用私有目录、运行时、以及几个具名的凭据文件。
 *  说明：这台网关本就只监听 127.0.0.1，且 /api/chat 等于本机任意命令执行 ——
 *  这一层是「别让取文件接口顺手把密钥递出去」的防呆，不是完整的鉴权边界。 */
const SECRET_NAMES = new Set([
  "ccapp-providers.json", "ccapp-config.json", "ccapp-seed.json",
  "keystore.json", "debug.keystore", "id_ed25519", "id_rsa", "id_ecdsa",
]);
const SECRET_RE = /(^|\/)(\.ssh|\.gnupg|\.aws|\.config\/gcloud)(\/|$)/;

/** 读文件和列目录共用的路径政策：应用私有目录（home、运行时、工具链、整个应用数据目录；工作区除外）、种子文件和凭据目录一律不碰。
 *  私有目录按目录身份判（gw/pathguard.mjs）：/data/data/<包名> 与 /data/user/0/<包名> 这类别名一并认得（0.6.9 审计 P0-1） */
export function pathBlocked(real) {
  if (zoneOf(real) === "private") return true;
  if (SEED_FILE) {
    let rr; try { rr = fs.realpathSync(SEED_FILE); } catch { rr = SEED_FILE; }
    if (real === rr) return true;
  }
  // /proc 底下的进程目录：同 uid 的进程（claude 子进程、网关自己）的 environ、cmdline、内存映射都读得到（审查 v0513b 低-14）
  if (/^\/proc\/(self|thread-self|\d+)(\/|$)/.test(real)) return true;
  return SECRET_RE.test(real);
}

export function safeFilePath(p) {
  if (!p) return { error: "path required" };
  // 先按原样找：「report.txt 」（末尾真有空格）和「report.txt」是两个文件，先 trim 会认成另一个（私下反馈 10-29）。
  // 原样找不到才去掉首尾空白再试（从对话里复制出来的路径常带个换行）
  const resolve = (s) => {
    let full = s;
    if (full.startsWith("file://")) { try { full = fileURLToPath(full); } catch {} }
    if (!path.isAbsolute(full)) full = path.join(CFG.workspace, full);
    return fs.realpathSync(full);
  };
  let real;
  try { real = resolve(String(p)); } catch (e) {
    const tp = String(p).trim();
    try { if (tp === String(p)) throw e; real = resolve(tp); } catch (e2) { return { error: "not found", detail: e2.message }; }
  }

  if (pathBlocked(real) || SECRET_NAMES.has(path.basename(real))) return { error: "forbidden", status: 403 };

  let st; try { st = fs.statSync(real); } catch (e) { return { error: e.message }; }
  if (st.isDirectory()) return { error: "is a directory", status: 400 };
  // 只交普通文件：/dev/zero 这类设备读不完，管道会一直挂着（/proc 里的伪文件 fstat 也报普通文件，上面按路径拦）
  if (!st.isFile()) return { error: "not a regular file", status: 400 };
  return { file: real, size: st.size, mtime: st.mtimeMs };
}

/** 写文件前的同一套防呆：已有文件走 safeFilePath；新文件看父目录 */
export function safeWritePath(p) {
  if (!p || !path.isAbsolute(String(p))) return { error: "absolute path required", status: 400 };
  const full = String(p);
  const name = path.basename(full);
  // 末尾的 /. 或 /.. 不是「新建文件」：path.join(dir, ".") 会折回 dir，之前会把普通文件当目录，
  // 让 SECRET_NAMES 去检查 "."，从而绕过对目标文件名的检查（审查 11-05）
  if (!name || name === "." || name === "..") return { error: "bad path", status: 400 };
  let dir;
  try { dir = fs.realpathSync(path.dirname(full)); } catch (e) { return { error: "no such directory", status: 400 }; }
  // 目标按「解析后的目录 + 文件名」重新算：full 里可能带 /./ 之类的段，不能拿原始字符串判断存在性
  const dst = path.join(dir, name);
  let st = null; try { st = fs.lstatSync(dst); } catch (e) { if (e.code !== "ENOENT") return { error: e.message, status: 400 }; }
  if (st) return safeFilePath(dst);          // 已有文件走只读核验：非普通文件（FIFO/设备）与软链在这里拒绝
  let ds; try { ds = fs.statSync(dir); } catch (e) { return { error: e.message, status: 400 }; }
  if (!ds.isDirectory()) return { error: "not a directory", status: 400 };
  if (zoneOf(dir) === "private") return { error: "forbidden", status: 403 };
  if (SECRET_NAMES.has(name) || SECRET_RE.test(dst)) return { error: "forbidden", status: 403 };
  return { file: dst, size: 0, mtime: 0, fresh: true };
}

/** 写文件但不跟最后一级软链（O_NOFOLLOW：是软链就报 ELOOP）。
 *  先写同目录临时文件、fsync 后再 rename 覆盖：写盘失败（ENOSPC/EIO）时原文件一个字节都不动（#121-3）。 */
export function writeNoFollow(file, buf) {
  const c = fs.constants;
  let mode = 0o644;
  // 已有文件：打开后按 /proc/self/fd 看实际打开的是哪个文件。核完路径到打开之间，上级目录也可能被换成软链（审查 10-30 第九份 后端低3），
  // O_NOFOLLOW 只管最后一级；对不上就不写。顺便沿用原权限
  // 用 lstat 不用 existsSync：悬空软链 existsSync 是 false，会被下面的 rename 悄悄换成普通文件；照旧拒绝（复核建议 2）
  let st = null; try { st = fs.lstatSync(file); } catch (e) { if (e.code !== "ENOENT") throw e; }
  if (st && st.isSymbolicLink()) throw Object.assign(new Error("symlink"), { code: "ELOOP" });
  if (st) {
    const fd = fs.openSync(file, c.O_WRONLY | c.O_NOFOLLOW);
    try {
      let real = null; try { real = fs.readlinkSync("/proc/self/fd/" + fd); } catch (e) { log(`[file] 读不到打开的实际路径，跳过核对：${e.code || e.message}`); }
      if (real && real !== file) throw Object.assign(new Error("path changed"), { code: "ELOOP" });
      mode = (fs.fstatSync(fd).mode & 0o777) || 0o644;
    } finally { fs.closeSync(fd); }
  }
  // 临时文件必须和目标同一目录（rename 不跨文件系统）；写完 fsync 再覆盖，失败只删临时文件
  // 临时名不带原名：原名本身可以长到接近 255 字节，再拼后缀就超出文件名上限、保存失败（#148-2）
  const tmp = path.join(path.dirname(file), `.ccsave-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`);
  let fd = null;
  try {
    fd = fs.openSync(tmp, c.O_WRONLY | c.O_CREAT | c.O_EXCL | c.O_NOFOLLOW, mode);
    // 临时文件实际落在哪个目录：核完路径之后上级目录被换成软链，这里就对不上，不写（新建文件也查，复核建议 2）。
    // 剩下的窗口只在这次核对到 rename 之间；node 没有 renameat，按目录 fd 提交做不到，这点残余接受
    let real = null; try { real = fs.readlinkSync("/proc/self/fd/" + fd); } catch (e) { log(`[file] 读不到临时文件的实际路径，跳过核对：${e.code || e.message}`); }
    if (real && path.dirname(real) !== path.dirname(file)) throw Object.assign(new Error("path changed"), { code: "ELOOP" });
    fs.writeFileSync(fd, buf);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = null;
    fs.renameSync(tmp, file);      // rename 替换的是路径上的条目，不跟最后一级软链
  } catch (e) {
    if (fd != null) { try { fs.closeSync(fd); } catch {} }
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
}

/** 供文件面板用的快捷入口 */
export function fileRoots() {
  const out = [];
  const seen = new Set();
  const add = (x) => {
    if (!x || seen.has(x)) return;
    seen.add(x);
    try { if (fs.statSync(x).isDirectory()) out.push(x); } catch {}
  };
  add(UPLOAD_DIR);
  add(CFG.workspace);
  add(process.env.CCAPP_SHARED);
  add("/sdcard/DeepSeekHarness");
  add("/sdcard/Pictures"); add("/sdcard/DCIM/Camera"); add("/sdcard/Download"); add("/sdcard/Documents");
  add("/sdcard");
  for (const d of SETTINGS.addDirs || []) add(d);
  return out;
}

// 上传中途被杀留下的 .part-* 隐藏临时文件：启动后第一次上传时清掉一小时前的（200-H-4）
let uploadCleanAt = 0;
function uploadCleanParts() {
  if (Date.now() - uploadCleanAt < 3600e3) return;
  uploadCleanAt = Date.now();
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(UPLOAD_DIR)) {
      if (!f.startsWith(".part-")) continue;
      const p = path.join(UPLOAD_DIR, f);
      try { if (now - fs.statSync(p).mtimeMs > 3600e3) fs.rmSync(p, { force: true }); } catch {}
    }
  } catch {}
}

// ── 截屏 ──────────────────────────────────────────────────────────────
/** 整屏截图（PNG）。cccodroid：priv 的 stdout 是干净的二进制通道，直接收；
 *  开发端的 rish 会把输出随机拆到 stdout / stderr，二进制会坏 —— 先写到共享存储再读回来 */
async function screencap(shot) {
  let last = "";
  for (let i = 0; i < 2; i++) {
    const r = await screencapOnce(shot);
    // 完整的 PNG 以 IEND 块收尾；只看开头的魔数会把截断的文件当成好的（界面上就是一张坏图）
    if (r.buf && r.buf.length > 64 && r.buf.readUInt32BE(0) === 0x89504e47 && r.buf.subarray(-8, -4).toString("latin1") === "IEND") return r.buf;
    last = `${r.buf ? r.buf.length : 0} B${r.code != null ? " rc=" + r.code : ""}${r.err ? " " + r.err : ""}`;
    log(`[screenshot] 第 ${i + 1} 次不完整：${last}`);
  }
  throw new Error(tz("截屏失败（Shizuku 可用吗？设置 → Shizuku）") + " · " + last);
}
function screencapOnce(shot) {
  return new Promise((resolve) => {
    if (PREFIX) {
      // 直接走 priv 的套接字（协议见 Priv.java / priv.mjs）：界面领来的一次性截屏码放在请求里，不进命令行和环境变量
      const out = [], err = [];
      let buf = Buffer.alloc(0), code = null, got = 0;
      const s = net.connect({ path: process.env.CCAPP_PRIV_SOCK || "/data/data/cc.codroid/files/.priv.sock" }, () => {
        s.write(JSON.stringify({ op: "exec", argv: ["/system/bin/sh", "-c", "screencap -p"], cwd: "/", shot: String(shot || "") }) + "\n");
        s.write(Buffer.from([0, 0, 0, 0, 0]));          // 没有 stdin：空帧
      });
      const t = setTimeout(() => s.destroy(), 20000);
      // 帧：1 字节类型 + 4 字节长度 + 内容。没凑齐一帧的先攒着（攒在数组里，凑够了再合并，别每来一块就整个复制一遍）
      let pend = [], pendLen = 0;
      s.on("data", (d) => {
        if ((got += d.length) > 64 << 20) { err.push(Buffer.from("too large")); return s.destroy(); }
        pend.push(d); pendLen += d.length;
        if (pendLen < 5) return;
        if (pend.length > 1) { buf = Buffer.concat(pend, pendLen); pend = [buf]; } else buf = pend[0];
        const need = buf.length >= 5 ? 5 + buf.readUInt32BE(1) : 5;
        if (buf.length < need) return;
        let off = 0;
        while (buf.length - off >= 5) {
          const type = buf[off], len = buf.readUInt32BE(off + 1);
          if (buf.length - off < 5 + len) break;
          const body = buf.subarray(off + 5, off + 5 + len);
          off += 5 + len;
          if (type === 1) out.push(body);
          else if (type === 2 || type === 4) err.push(body);
          else if (type === 3 && len === 4) code = body.readInt32BE(0);
        }
        const rest = buf.subarray(off);
        pend = rest.length ? [rest] : []; pendLen = rest.length;
      });
      s.on("error", (e) => err.push(Buffer.from(e.message)));
      s.on("close", () => { clearTimeout(t); resolve({ buf: Buffer.concat(out), code, err: Buffer.concat(err).toString().trim().slice(0, 160) }); });
      return;
    }
    const tmp = "/sdcard/Download/.ccapp-screen.png";
    execFile("priv", [`screencap -p ${tmp}`], { timeout: 20000, env: process.env }, (e) => {
      let buf = null; try { buf = fs.readFileSync(tmp); fs.rmSync(tmp, { force: true }); } catch {}
      resolve({ buf, err: e ? e.message.slice(0, 160) : "" });
    });
  });
}

// 共享存储授权被撤回时 realpath / stat 报 EACCES：要按 403 说清楚，别让界面以为文件没了（195-C.7 / FIND-029）
const deniedCode = (e) => /EACCES|EPERM/.test(String((e && e.code) || e || ""));
const deniedMsg = () => tz("没有读取这个位置的权限（共享存储需要在系统设置里允许「所有文件访问」）");

// ── 路由：/api/file /api/file/stat /api/file/save /api/file/new /api/file/rename /api/file/delete /api/upload /api/screenshot /api/files ──
export async function routeFiles(req, res, u, p) {
  // ── 取文件内容（消息里的图片、文件预览、下载都走这里）──
  if (req.method === "GET" && p === "/api/file") {
    const r = safeFilePath(u.searchParams.get("path"));
    if (r.error) {
      // 没有共享存储权限时 realpath 报 EACCES，以前一律当 404，界面以为文件没了（195-C.7）
      const denied = deniedCode(r.detail);
      return sendJson(res, denied ? 403 : r.status || 404, denied
        ? { error: "forbidden", message: deniedMsg() }
        : { error: r.error, detail: r.detail });
    }
    // procfs / sysfs 的 size 和实际能读出的字节对不上，按 size 发 Content-Length 会被浏览器判成截断（200-H-2）
    if (/^\/(proc|sys)(\/|$)/.test(r.file)) return sendJson(res, 400, { error: "not a regular file", message: tz("这类系统伪文件不能这样读") });
    // 按已核过的真实路径打开、不跟软链：核完到打开之间被换成指向别处的软链也读不到（审查 v0.5.4 B-L1）
    let fd;
    try { fd = fs.openSync(r.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); } catch (e) { return sendJson(res, 404, { error: "not found", detail: e.code || e.message }); }
    let size = r.size;
    try { const fst = fs.fstatSync(fd); if (!fst.isFile()) { fs.closeSync(fd); return sendJson(res, 400, { error: "not a file" }); } size = fst.size; }
    catch (e) { try { fs.closeSync(fd); } catch {} return sendJson(res, 500, { error: e.message }); }
    // 音视频 / PDF 拖进度要 Range；以前整份发，大文件只能从头播（195-C.2）
    const rg = rangeOf(req.headers.range, size);
    if (rg && rg.bad) { try { fs.closeSync(fd); } catch {} res.writeHead(416, { "content-range": `bytes */${size}` }); return res.end(); }
    const head = {
      "content-type": mimeOf(r.file),
      "content-length": rg ? rg.end - rg.start + 1 : size,
      "accept-ranges": "bytes",
      "cache-control": "no-store",
      "x-mtime": String(r.mtime),     // 编辑器保存时带回来做冲突检测
      // 文件内容不可信（Claude 写的、别处下的）：哪怕被整页打开，也只当不透明源、不跑脚本，碰不到网关的 Cookie 和 /api
      "content-security-policy": "sandbox",
      "x-content-type-options": "nosniff",
    };
    if (rg) head["content-range"] = `bytes ${rg.start}-${rg.end}/${size}`;
    if (u.searchParams.get("download") === "1") {
      head["content-disposition"] =
        `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(r.file))}`;
    }
    res.writeHead(rg ? 206 : 200, head);
    const st = fs.createReadStream(null, { fd, ...(rg ? { start: rg.start, end: rg.end } : {}) });
    st.on("error", () => { try { res.destroy(); } catch {} });
    // 客户端中途断开（关查看器、切文件）：pipe 只会停下，不会关源，fd 一直占着（#148-1）
    res.on("close", () => { if (!res.writableFinished) st.destroy(); });
    st.pipe(res);
    return;
  }
  if (req.method === "GET" && p === "/api/file/stat") {
    // 先按原样找：末尾真带空格的文件名先 trim 就打不开，或认成同名不带空格的另一个（#106 07-008）。
    // 原样找不到再去掉首尾空白（复制来的路径常带换行），同 safeFilePath
    const raw = String(u.searchParams.get("path") || ""), q = raw.trim();
    if (!path.isAbsolute(q)) return sendJson(res, 400, { error: "absolute path required" });
    let real, why = "";
    try { real = fs.realpathSync(path.isAbsolute(raw) ? raw : q); }
    catch (e) { real = null; why = (e && e.code) || (e && e.message) || ""; }
    if (real == null && raw !== q) { try { real = fs.realpathSync(q); } catch (e) { why = (e && e.code) || (e && e.message) || why; } }
    // 没有权限和文件真的不在，回执要分开：界面对前者要提示去开「所有文件访问」（FIND-029）
    if (real == null) return deniedCode(why)
      ? sendJson(res, 403, { error: "forbidden", path: q, message: deniedMsg() })
      : sendJson(res, 404, { error: "not found", path: q });
    let st; try { st = fs.statSync(real); }
    catch (e) {
      return deniedCode(e)
        ? sendJson(res, 403, { error: "forbidden", path: q, message: deniedMsg() })
        : sendJson(res, 404, { error: e.message });
    }
    // 目录也过同一道闸：不然私有目录、运行时目录在不在、真实路径是什么都探得出来（11-01 独立审查低-1）
    if (st.isDirectory()) return pathBlocked(real) ? sendJson(res, 403, { error: "forbidden" }) : sendJson(res, 200, { path: real, dir: true });
    const r = safeFilePath(real);
    if (r.error) return sendJson(res, r.status || 404, { error: r.error });
    return sendJson(res, 200, { path: r.file, dir: false, size: r.size, mtime: r.mtime, kind: fileKind(r.file, false) });
  }
  // ── 文件编辑器保存：带上打开时的 mtime，磁盘上的已经被别人（多半是 Claude）改过就拒绝，免得互相覆盖 ──
  if (req.method === "POST" && p === "/api/file/save") {
    const r = safeWritePath(u.searchParams.get("path"));
    if (r.error) return sendJson(res, r.status || 400, { error: r.error });
    const base = Number(u.searchParams.get("mtime") || 0);
    // 先收完请求体再比 mtime：收的过程中磁盘上的文件也可能被改
    const buf = await readBodyBuf(req, 16 * 1024 * 1024);
    let cur = null; try { cur = fs.statSync(r.file); } catch {}
    // 已有文件必须带打开时的 mtime：没带（0）说明界面还没读完就点了保存，会把它清空（私下反馈 10-29）
    if (cur && !base && u.searchParams.get("force") !== "1") return sendJson(res, 409, { error: "not loaded", mtime: cur.mtimeMs, size: cur.size });
    // 打开时文件在（带着 mtime），现在没了：被改名 / 移走 / 删了。别悄悄按旧名新建一份，让界面问一句（#145-2）
    if (!cur && base && u.searchParams.get("force") !== "1") return sendJson(res, 409, { error: "gone" });
    if (cur && base && Math.abs(cur.mtimeMs - base) > 1 && u.searchParams.get("force") !== "1") {
      return sendJson(res, 409, { error: "changed on disk", mtime: cur.mtimeMs, size: cur.size });
    }
    // 收请求体期间路径可能被换成软链（指向令牌、厂商配置）：重核一遍，结果得和开头一致；写时不跟软链（审查 v0.5.4 B-L1）
    const r2 = safeWritePath(u.searchParams.get("path"));
    if (r2.error || r2.file !== r.file) return sendJson(res, 409, { error: "path changed" });
    try { writeNoFollow(r.file, buf); } catch (e) { return sendJson(res, e.code === "ELOOP" ? 403 : 500, { error: e.code === "ELOOP" ? "forbidden" : e.message }); }
    const st = fs.statSync(r.file);
    log(`[file] 保存 ${r.file} ${buf.length}B`);
    return sendJson(res, 200, { ok: true, path: r.file, size: st.size, mtime: st.mtimeMs });
  }
  // ── 文件面板：新建文件 / 新建文件夹 / 重命名。都不覆盖已有的东西，防呆规则同保存 ──
  if (req.method === "POST" && (p === "/api/file/new" || p === "/api/file/mkdir")) {
    // 文件名上限 255 字节（不是字符）：中文一个字 3 字节，超了系统只回原始 ENAMETOOLONG（195-C.14）
    if (Buffer.byteLength(path.basename(String(u.searchParams.get("path") || ""))) > 255) {
      return sendJson(res, 400, { error: "name too long", message: tz("文件名太长（最多 255 字节，中文一个字算 3 个）") });
    }
    const r = safeWritePath(u.searchParams.get("path"));
    if (r.error) return sendJson(res, r.status || 400, { error: r.error });
    if (!r.fresh) return sendJson(res, 409, { error: "exists" });
    try {
      if (p === "/api/file/mkdir") fs.mkdirSync(r.file);
      else fs.writeFileSync(r.file, "", { flag: "wx" });
    } catch (e) { return sendJson(res, e.code === "EEXIST" ? 409 : 500, { error: e.code === "EEXIST" ? "exists" : e.message }); }
    const st = fs.statSync(r.file);
    log(`[file] 新建${p === "/api/file/mkdir" ? "目录" : ""} ${r.file}`);
    return sendJson(res, 200, { ok: true, path: r.file, dir: st.isDirectory(), size: st.size, mtime: st.mtimeMs, kind: fileKind(r.file, st.isDirectory()) });
  }
  if (req.method === "POST" && p === "/api/file/rename") {
    const from = String(u.searchParams.get("from") || "");
    const name = String(u.searchParams.get("name") || "").trim();
    if (!path.isAbsolute(from)) return sendJson(res, 400, { error: "absolute path required" });
    if (!name || name === "." || name === ".." || /[\/\0]/.test(name)) return sendJson(res, 400, { error: "bad name" });
    if (Buffer.byteLength(name) > 255) return sendJson(res, 400, { error: "name too long", message: tz("文件名太长（最多 255 字节，中文一个字算 3 个）") });
    let st; try { st = fs.lstatSync(from); } catch { return sendJson(res, 404, { error: "not found" }); }
    // 源：文件走 safeFilePath；目录借它父目录下的一个虚拟子路径过一遍 safeWritePath 的根目录检查
    const src = st.isDirectory() ? safeWritePath(path.join(from, ".probe-" + Date.now())) : safeFilePath(from);
    if (src.error) return sendJson(res, src.status || 400, { error: src.error });
    // 也别把装着应用私有目录（或工作区）的上级挪走：按目录身份判，别名也认得
    if (st.isDirectory() && holdsPrivate(from)) return sendJson(res, 403, { error: "forbidden" });
    const dst = safeWritePath(path.join(path.dirname(from), name));
    if (dst.error) return sendJson(res, dst.status || 400, { error: dst.error });
    if (!dst.fresh) {
      // /sdcard 不区分大小写：只改大小写时 lstat 看到的是原文件，不能当“同名已存在”拒掉（200-8-05）。
      // 比 dev+ino 确认是同一个文件才放行
      let a = null, b = null;
      try { a = fs.lstatSync(from); b = fs.lstatSync(dst.file); } catch {}
      if (!(a && b && a.dev === b.dev && a.ino === b.ino)) return sendJson(res, 409, { error: "exists", message: tz("已经有同名的文件或文件夹") });
    }
    try { fs.renameSync(from, dst.file); } catch (e) { return sendJson(res, 500, { error: e.message }); }
    log(`[file] 重命名 ${from} → ${dst.file}`);
    return sendJson(res, 200, { ok: true, path: dst.file, kind: fileKind(dst.file, st.isDirectory()) });
  }
  // 删除：文件页长按「删除」、多选「删除选中」逐个调这里。永久删除（不进回收站），界面先弹确认。
  // 防呆照写文件那一套：父目录按真实路径判，不能在应用私有目录里；凭据名不碰；
  // 文件夹不能是装着私有目录或工作区的上级（删工作区本身也拦）。软链只删链接本身，不跟进去
  if (req.method === "POST" && p === "/api/file/delete") {
    const raw = String(u.searchParams.get("path") || "");
    if (!path.isAbsolute(raw)) return sendJson(res, 400, { error: "absolute path required" });
    const name = path.basename(raw);
    if (!name || name === "." || name === "..") return sendJson(res, 400, { error: "bad path" });
    let dir; try { dir = fs.realpathSync(path.dirname(raw)); } catch { return sendJson(res, 404, { error: "not found" }); }
    const target = path.join(dir, name);
    let st; try { st = fs.lstatSync(target); } catch { return sendJson(res, 404, { error: "not found" }); }
    if (path.dirname(target) === target || zoneOf(dir) === "private" || SECRET_NAMES.has(name) || SECRET_RE.test(target) ||
        (!st.isSymbolicLink() && pathBlocked(target))) return sendJson(res, 403, { error: "forbidden" });
    if (st.isDirectory() && holdsPrivate(target)) return sendJson(res, 403, { error: "forbidden", message: tz("这个文件夹装着应用自己的目录或工作区，不能删") });
    try { fs.rmSync(target, { recursive: st.isDirectory(), force: false }); }
    catch (e) { return sendJson(res, e.code === "EACCES" || e.code === "EPERM" ? 403 : 500, { error: e.code || e.message, message: e.message }); }
    log(`[file] 删除${st.isDirectory() ? "目录" : ""} ${target}`);
    return sendJson(res, 200, { ok: true });
  }
  // ── 把界面拿到的东西落盘（粘贴 / 拖放 / 选择文件共用）──
  if (req.method === "POST" && p === "/api/upload") {
    const rawName = u.searchParams.get("name") || "";
    const safe = path.basename(rawName)
      .replace(/[^\w.\-()一-鿿]+/g, "_")   // 空格也换成 _：路径带空格在提示词里很难引用
      .replace(/^[.\s]+/, "")
      .slice(0, 120);
    // 流式落盘，不进内存（以前整份读进 64 MB 缓冲，大附件直接失败）。超过门限的附件 App 壳一般直接递路径、不走这里；
    // 粘贴 / 拖进来的大文件还会走这里，上限 4 GB，且先看剩余空间
    const len = Number(req.headers["content-length"] || 0);
    if (len > UPLOAD_MAX) return sendJson(res, 413, { error: "too large" });
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    try { const sf = fs.statfsSync(UPLOAD_DIR); if (len && sf.bavail * sf.bsize < len + (512 << 20)) return sendJson(res, 507, { error: "no space" }); } catch {}
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    // 同一秒同名的（一次附加两个同名文件）别互相覆盖：撞了就加 -2、-3
    // 文件名上限是 255 字节不是字符：中文一个字 3 字节，按字符截到 120 还会超（#148-3）。时间戳前缀和「-序号」另留余量
    const nm0 = safe || "upload.bin", dot0 = nm0.lastIndexOf(".");
    const ext = dot0 > 0 ? clipBytes(nm0.slice(dot0), 32) : "", stem = clipBytes(dot0 > 0 ? nm0.slice(0, dot0) : nm0, 200 - Buffer.byteLength(ext)) || "upload";
    // 先写到隐藏的 .part 临时文件，完整收完再原子挂上最终名字：上传途中网关被杀 / 客户端断开，
    // 只会留下 .part（文件列表默认不显示），不会把半截文件伪装成上传成功的附件（200-H-4）
    uploadCleanParts();
    let tmp = "";
    for (let i = 0; i < 20 && !tmp; i++) {
      const t = path.join(UPLOAD_DIR, `.part-${stamp}-${process.pid}-${Math.random().toString(16).slice(2, 10)}`);
      try { fs.writeFileSync(t, "", { flag: "wx" }); tmp = t; }
      catch (e) { if (e.code !== "EEXIST") return sendJson(res, 500, { error: e.message }); }
    }
    if (!tmp) return sendJson(res, 500, { error: "name taken" });
    let size;
    try { size = await bodyToFile(req, tmp, UPLOAD_MAX); }
    catch (e) { fs.rmSync(tmp, { force: true }); return sendJson(res, /large/.test(e.message) ? 413 : 400, { error: e.message }); }
    // 图片按内容认格式：扩展名不对的改对，HEIF / AVIF 转 JPEG（群友 11-08，抖音存的图；见 imgfix.mjs）
    let fext = ext;
    try { fext = await fixUploadedImage(tmp, ext); } catch (e) { log(`[upload] 图片格式核对失败：${e.message}`); }
    if (fext !== ext) { log(`[upload] ${safe} 实际是 ${fext.slice(1)}，按 ${fext.slice(1)} 存`); try { size = fs.statSync(tmp).size; } catch {} }
    // 0 字节也是合法文件：以前当成失败拒掉，用户附不上空文件（195-C.18）
    let out = "";
    // 查名 + rename 放在同一段同步代码里：node 单线程，两个并发上传不会插进来；目标盘不支持硬链接（本机 EACCES），
    // 不能用 link 占名，但同步段内的 exists+rename 同样不会被另一个请求插入
    for (let i = 1; i < 1000 && out === ""; i++) {
      const cand = path.join(UPLOAD_DIR, `${stamp}-${i === 1 ? stem + fext : stem + "-" + i + fext}`);
      if (fs.existsSync(cand)) continue;
      try { fs.renameSync(tmp, cand); out = cand; }
      catch (e) { fs.rmSync(tmp, { force: true }); return sendJson(res, 500, { error: e.message }); }
    }
    fs.rmSync(tmp, { force: true });
    if (!out) return sendJson(res, 500, { error: "name taken" });
    const kind = fileKind(out, false);
    log(`[upload] ${safe || "upload.bin"} ${size}B → ${out}`);
    return sendJson(res, 200, {
      ok: true, path: out, name: path.basename(out),
      size, mime: mimeOf(out), kind,
    });
  }
  // ── 截屏给 Claude：经 priv 以 shell 身份 screencap，存进 uploads 当附件。delay 秒后再截（先切到要截的应用），截完叫回前台 ──
  if (req.method === "POST" && p === "/api/screenshot") {
    let b; try { b = JSON.parse((await readBody(req)) || "{}"); } catch { return sendJson(res, 400, { error: "bad json" }); }
    const delay = Math.max(0, Math.min(30, Number(b.delay) || 0));
    if (delay) await new Promise((r) => setTimeout(r, delay * 1000));
    let png;
    try { png = await screencap(typeof b.shot === "string" ? b.shot.slice(0, 64) : ""); } catch (e) { return sendJson(res, 500, { ok: false, message: e.message }); }
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    // 同一秒截两张别互相覆盖：wx 占名
    let out = null;
    for (let k = 1; !out && k < 100; k++) {
      const f = path.join(UPLOAD_DIR, k === 1 ? `${stamp}-screen.png` : `${stamp}-screen-${k}.png`);
      try { fs.writeFileSync(f, png, { flag: "wx" }); out = f; } catch (e) { if (e.code !== "EEXIST") return sendJson(res, 500, { ok: false, message: e.message }); }
    }
    if (!out) return sendJson(res, 500, { ok: false, message: "EEXIST" });
    log(`[screenshot] ${png.length}B → ${out}`);
    if (delay) toFront(tz("截好了")).catch(() => {});
    return sendJson(res, 200, { ok: true, path: out, name: path.basename(out), size: png.length, mime: "image/png", kind: "image" });
  }
  // ── 目录浏览（@ 引用文件 + 文件面板共用）──
  if (req.method === "GET" && p === "/api/files") {
    const dir = u.searchParams.get("path") || CFG.workspace;
    const q = (u.searchParams.get("q") || "").toLowerCase();
    const showHidden = u.searchParams.get("hidden") === "1";
    const out = { path: dir, parent: path.dirname(dir), entries: [], roots: fileRoots(), truncated: false };
    try {
      const real = fs.realpathSync(dir);
      out.path = real;
      if (real !== dir) out.parent = path.dirname(real);
      // 列目录也过同一套政策：之前只有读文件把关，列目录能看见 home 下全部文件名（审查 10-30 v0.5.12 低1）
      if (pathBlocked(real)) return sendJson(res, 403, { ...out, error: "forbidden" });
      const items = fs.readdirSync(real, { withFileTypes: true });
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (!showHidden && it.name.startsWith(".")) continue;
        if (q && !it.name.toLowerCase().includes(q)) continue;
        // 共享存储（/sdcard）不区分大小写，大小写变体也能指到同一个密钥名，过滤不能只认小写（196 网关安全二轮）
        if (SECRET_NAMES.has(it.name.toLowerCase())) continue;
        let isDir = it.isDirectory(), size = 0, mtime = 0;
        try {
          const full = path.join(real, it.name), st = fs.statSync(full);
          // 软链指向被挡的地方（私有目录、令牌文件）：目标的类型、大小、时间都不报（DeepSeek 复核 低-1，旧代码就跟链取了 size/mtime）
          const hid = it.isSymbolicLink() && (() => { const t = fs.realpathSync(full); return pathBlocked(t) || SECRET_NAMES.has(path.basename(t).toLowerCase()); })();
          // 目录软链：Dirent 不跟链，按目标算，不然面板里点不进去（#106 07-007）；进去时 /api/files 照样过 realpath + pathBlocked
          if (!isDir && !hid && st.isDirectory()) isDir = true;
          if (!hid) { size = isDir ? 0 : st.size; mtime = st.mtimeMs; }
        } catch {}
        out.entries.push({ name: it.name, dir: isDir, size, mtime, kind: fileKind(it.name, isDir) });
        // 超过 1000 项：明说还有没列出来的，别让界面以为目录就这么多（195-C.5）
        if (out.entries.length >= 1000) { if (i < items.length - 1) out.truncated = true; break; }
      }
      out.entries.sort((a, b) => {
        if (a.dir !== b.dir) return a.dir ? -1 : 1;
        if (a.dir) return a.name.localeCompare(b.name);
        if (a.kind === "image" && b.kind !== "image") return -1;
        if (b.kind === "image" && a.kind !== "image") return 1;
        return b.mtime - a.mtime || a.name.localeCompare(b.name);
      });
    } catch (e) {
      // 没给「所有文件访问」时 /sdcard 的 readdir/realpath 报 EACCES：换成能照着做的提示（195-C.7）
      out.error = /EACCES|EPERM/.test(String(e.code || "")) || /EACCES|EPERM/.test(String(e.message || ""))
        ? tz("没有访问这个目录的权限（共享存储需要在系统设置里允许「所有文件访问」）")
        : e.message;
    }
    return sendJson(res, 200, out);
  }
  return NEXT;
}
