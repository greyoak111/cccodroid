import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { CFG, PREFIX } from "./config.mjs";
import { NEXT, readBodyBuf, sendJson } from "./http.mjs";
import { safeFilePath, safeWritePath } from "./files.mjs";
import { ensureShell, killTree } from "./claude.mjs";
import { markChild, unmarkChild } from "./components.mjs";
import { onShutdown } from "./crashguard.mjs";

const NEED = { merge: ["qpdf"], extract: ["qpdf"], split: ["qpdf"], rotate: ["qpdf"], compress: ["pdf-shrink", "gs"], images: ["qpdf", "pdftoppm"] };
const MAX_INPUT = 256 * 1024 ** 2, MAX_OUTPUT = 512 * 1024 ** 2, MAX_PAGES = 1000;
const JOBS = new Map();
const fail = (code, status = 400) => { throw Object.assign(new Error(code), { code, status }); };
const bin = (name) => {
  if (!PREFIX) return "";
  for (const suffix of ["", ...(process.platform === "win32" ? [".exe"] : [])]) {
    const p = path.join(PREFIX, "bin", name + suffix);
    try { if (fs.statSync(p).isFile()) return p; } catch {}
  }
  return "";
};
export const pdfToolsInfo = () => ({ operations: Object.fromEntries(Object.entries(NEED).map(([op, names]) => [op, names.filter((n) => !bin(n))])), maxInput: MAX_INPUT, maxPages: MAX_PAGES, maxImagePages: 100 });

/** 不把用户输入直接拼给 qpdf：只收升序的十进制页码/范围，展开后再交给工具。 */
// 转图片是否要 -scale-to 封顶：按 pdfinfo 的页面尺寸与所选分辨率算出栅格长边，超过 2048 才封。
// poppler 的 -scale-to 是「缩放进框」（含放大），小页面会被无谓放大、低分辨率档一起失真，所以只在真超限时用。
export function pdfImageCap(infoText, dpi) {
  const m = /^Page size:\s+([\d.]+)\s*x\s*([\d.]+)/m.exec(infoText || "");
  if (!m) return true; // 解析不到就保守封顶：防巨幅位图优先
  return Math.max(Number(m[1]), Number(m[2])) * dpi / 72 > 2048;
}
export function pdfPages(text, count) {
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_PAGES) fail("page-limit");
  if (typeof text !== "string" || text.length > 4000) fail("pages");
  if (!text.trim()) return Array.from({ length: count }, (_, i) => i + 1);
  const out = [], seen = new Set();
  for (const part of text.split(",")) {
    const m = /^\s*([1-9]\d*)(?:\s*-\s*([1-9]\d*))?\s*$/.exec(part);
    if (!m) fail("pages");
    const a = Number(m[1]), b = Number(m[2] || m[1]);
    if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a > b || b > count) fail("pages");
    for (let n = a; n <= b; n++) if (!seen.has(n)) { seen.add(n); out.push(n); }
  }
  return out;
}

function jobView(j) {
  return { id: j.id, state: j.state, operation: j.operation, dest: j.dest, outputs: j.outputs, inputBytes: j.inputBytes, outputBytes: j.outputBytes || 0, code: j.code || "", warning: j.warning || false };
}
function stop(j, code = "cancelled") {
  if (j.state !== "running") return;
  j.stop = j.stop || code;
  j.abort.abort();
  if (j.child) killTree(j.child);
}
onShutdown("PDF tools", () => { for (const j of JOBS.values()) stop(j); });

// 文档解析不需要终端的账号环境，也不能触发 termKeyFile()。只保留 Env.java / exec-shim.c 实际使用的运行时变量。
function pdfEnv(work, src = process.env) {
  const env = {};
  for (const k of ["SHELL", "LD_LIBRARY_PATH", "LD_PRELOAD", "LANG", "TZ", "FONTCONFIG_FILE", "FONTCONFIG_PATH", "SystemRoot", "WINDIR",
    "CCAPP_LD", "CCAPP_SELF_EXE", "CCAPP_GLIBC_LIB", "CCAPP_GLIBC_PRELOAD", "CCAPP_BIONIC_PRELOAD", "CCAPP_EXEC", "CCAPP_BIN", "CCAPP_PREFIX",
    "TERMUX_APP__DATA_DIR", "TERMUX_APP__LEGACY_DATA_DIR", "TERMUX_EXEC__SYSTEM_LINKER_EXEC__MODE"])
    if (src[k] != null) env[k] = src[k];
  if (src.CCAPP_BIONIC_PRELOAD) env.LD_PRELOAD = src.CCAPP_BIONIC_PRELOAD;
  const dirs = [PREFIX && path.join(PREFIX, "bin"), src.CCAPP_BIN, "/system/bin", "/system/xbin"].filter(Boolean);
  return { ...env, PATH: dirs.join(path.delimiter), PREFIX, HOME: work, TMPDIR: work, TMP: work, TEMP: work, XDG_CONFIG_HOME: work, XDG_CACHE_HOME: work, LC_ALL: "C" };
}
function run(j, name, args) {
  if (j.stop) fail(j.stop);
  const cmd = bin(name);
  if (!cmd) fail("missing-tools", 501);
  return new Promise((resolve, reject) => {
    // 固定 shell 程序段；路径和参数全走 argv，文件名里的引号、$() 都只是文件名。
    const argv = process.platform === "win32" ? [cmd, ...args] : [ensureShell(), "-c", 'exec "$0" "$@"', cmd, ...args];
    const child = spawn(argv[0], argv.slice(1), { cwd: j.work, env: pdfEnv(j.work), shell: false, windowsHide: true, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    j.child = child;
    const mark = markChild(child, cmd, args);
    let out = "";
    child.stdout.on("data", (b) => { out = (out + b).slice(-8192); });
    child.stderr.resume(); // 不向前端/日志转发文档内容或工具打印的路径。
    const timer = setTimeout(() => stop(j, "timeout"), 120e3);
    const finish = () => { clearTimeout(timer); unmarkChild(mark); if (j.child === child) j.child = null; };
    child.once("error", (e) => { finish(); reject(Object.assign(e, { code: j.stop || "tool-failed" })); });
    child.once("close", (code) => {
      finish();
      if (j.stop || code !== 0) return reject(Object.assign(new Error(j.stop || "tool-failed"), { code: j.stop || "tool-failed" }));
      resolve(out);
    });
  });
}

async function snapshot(j, source, i) {
  const checked = safeFilePath(source);
  if (checked.error) fail("file-unavailable", checked.status || 400);
  const fd = fs.openSync(checked.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd), now = fs.statSync(checked.file);
    if (!st.isFile() || st.dev !== now.dev || st.ino !== now.ino || safeFilePath(checked.file).file !== checked.file) fail("file-changed");
    if (st.size > MAX_INPUT - j.inputBytes) fail("input-limit", 413);
    const header = Buffer.alloc(1024);
    const n = fs.readSync(fd, header, 0, header.length, 0);
    if (!header.subarray(0, n).includes(Buffer.from("%PDF-"))) fail("not-pdf");
    const dest = path.join(j.work, `input-${i}.pdf`);
    // fd 留到复制后再 fstat；emitClose:false 避免 pipeline 等一个由 finally 才会触发的 close。
    await pipeline(fs.createReadStream(checked.file, { fd, autoClose: false, emitClose: false, start: 0, end: st.size - 1 }), fs.createWriteStream(dest, { flags: "wx", mode: 0o600 }), { signal: j.abort.signal });
    const after = fs.fstatSync(fd);
    if (st.size !== after.size || st.mtimeMs !== after.mtimeMs || st.ctimeMs !== after.ctimeMs) fail("file-changed");
    j.inputBytes += st.size;
    if (j.stop) fail(j.stop);
    return dest;
  } finally { fs.closeSync(fd); }
}

async function processPdf(j, b) {
  const inputs = [];
  for (let i = 0; i < b.files.length; i++) inputs.push(await snapshot(j, b.files[i], i));
  let selected;
  if (j.operation !== "compress") {
    const counts = [];
    for (const file of inputs) counts.push(Number((await run(j, "qpdf", ["--warning-exit-0", "--show-npages", file])).trim()));
    if (counts.some((n) => !Number.isSafeInteger(n) || n < 1) || counts.reduce((a, n) => a + n, 0) > MAX_PAGES) fail("page-limit");
    if (j.operation !== "merge") selected = pdfPages(b.pages || "", counts[0]);
    if (j.operation === "images" && selected.length > 100) fail("image-limit");
  }
  const out = path.join(j.work, "output"); fs.mkdirSync(out);
  const result = path.join(out, "result.pdf"), q = (args) => run(j, "qpdf", ["--warning-exit-0", ...args]);
  if (j.operation === "merge") await q(["--empty", "--pages", ...inputs, "--", result]);
  if (j.operation === "extract") await q(["--empty", "--pages", inputs[0], selected.join(","), "--", result]);
  if (j.operation === "split") {
    for (const n of selected) await q(["--empty", "--pages", inputs[0], String(n), "--", path.join(out, `page-${String(n).padStart(4, "0")}.pdf`)]);
  }
  if (j.operation === "rotate") await q([inputs[0], `--rotate=+${b.angle}:${selected.join(",")}`, result]);
  if (j.operation === "compress") await run(j, "pdf-shrink", [inputs[0], result, "--quality", b.quality]);
  if (j.operation === "images") {
    const selection = path.join(j.work, "selection.pdf");
    await q(["--empty", "--pages", inputs[0], selected.join(","), "--", selection]);
    // 输出长边封顶：伪造的巨幅页面也不能让手机按全尺寸分配位图。
    // pdfinfo 与 pdftoppm 同包，这里先按所选分辨率算栅格长边，超了才加 -scale-to。
    const info = await run(j, "pdfinfo", [selection]);
    const args = ["-r", String(b.dpi)];
    if (pdfImageCap(info, b.dpi)) args.push("-scale-to", "2048");
    args.push(b.format === "jpeg" ? "-jpeg" : "-png", selection, path.join(out, "page"));
    await run(j, "pdftoppm", args);
  }
  if (j.stop) fail(j.stop);
  const names = fs.readdirSync(out).sort((a, z) => a.localeCompare(z, "en", { numeric: true }));
  if (!names.length) fail("tool-failed");
  let bytes = 0;
  for (const name of names) {
    const st = fs.lstatSync(path.join(out, name));
    if (!st.isFile() || st.isSymbolicLink() || !st.size || (bytes += st.size) > MAX_OUTPUT) fail("output-limit");
  }
  if (j.stop) fail(j.stop);
  // 最后才创建可见结果目录；mkdir 排他，不会把任何已有目录或原文档覆盖掉。
  const dest = safeWritePath(j.dest);
  if (dest.error || !dest.fresh || dest.file !== j.dest) fail("destination-exists", 409);
  fs.mkdirSync(j.dest);
  const delivered = [];
  try {
    for (const name of names) {
      if (j.stop) fail(j.stop);
      const file = path.join(j.dest, name);
      await fs.promises.copyFile(path.join(out, name), file, fs.constants.COPYFILE_EXCL);
      const st = fs.lstatSync(file);
      delivered.push({ file, st });
      j.outputs.push({ path: file, size: st.size, kind: j.operation === "images" ? "image" : "pdf" });
    }
    if (j.stop) fail(j.stop);
  } catch (e) {
    // 只删本次刚交付的文件，别递归删除用户后来放进结果目录的东西。
    for (const { file, st } of delivered) {
      try { const now = fs.lstatSync(file); if (now.isFile() && now.dev === st.dev && now.ino === st.ino && now.ctimeMs === st.ctimeMs && now.size === st.size) fs.unlinkSync(file); } catch {}
    }
    j.outputs = [];
    try { fs.rmdirSync(j.dest); } catch {}
    throw e;
  }
  j.outputBytes = bytes;
  j.warning = j.operation === "compress" && bytes >= j.inputBytes;
}

export function startPdfJob(b) {
  if (!b || typeof b.operation !== "string" || !Object.hasOwn(NEED, b.operation)) fail("operation");
  if ([...JOBS.values()].some((j) => j.state === "running")) fail("busy", 409);
  if (!Array.isArray(b.files) || b.files.length < (b.operation === "merge" ? 2 : 1) || b.files.length > (b.operation === "merge" ? 20 : 1) || b.files.some((p) => typeof p !== "string" || !p || p.length > 4096)) fail("files");
  if (b.pages != null && (typeof b.pages !== "string" || b.pages.length > 4000)) fail("pages");
  if (typeof b.dest !== "string" || b.dest.length > 4096) fail("destination");
  if (b.operation === "rotate" && ![90, 180, 270].includes(b.angle)) fail("angle");
  if (b.operation === "compress" && !["screen", "ebook", "printer"].includes(b.quality)) fail("quality");
  if (b.operation === "images" && (![72, 150].includes(b.dpi) || !["png", "jpeg"].includes(b.format))) fail("image-options");
  const d = safeWritePath(b.dest);
  if (d.error === "is a directory") fail("destination-exists", 409);
  if (d.error) fail("destination", d.status || 400);
  if (!d.fresh) fail("destination-exists", 409);
  for (const file of b.files) { const r = safeFilePath(file); if (r.error) fail("file-unavailable", r.status || 400); }
  if (pdfToolsInfo().operations[b.operation].length) fail("missing-tools", 501);
  // 手机上一次一个任务；完成记录只留 20 份，文件本身由用户在文件面板管理。
  for (const [id, old] of JOBS) if (JOBS.size >= 20 && old.state !== "running") JOBS.delete(id);
  const root = path.join(CFG.home, ".cache", "pdf-tools"); fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  // 上次进程被系统直接杀掉时 finally 跑不到。只清本工具命名、超出最长运行时间的旧工作目录。
  for (const name of fs.readdirSync(root)) {
    if (!/^work-[A-Za-z0-9]{6}$/.test(name)) continue;
    const file = path.join(root, name);
    try { const st = fs.lstatSync(file); if (st.isDirectory() && !st.isSymbolicLink() && Date.now() - st.mtimeMs > 2 * 3600e3) fs.rmSync(file, { recursive: true, force: true }); } catch {}
  }
  const j = { id: crypto.randomBytes(12).toString("hex"), operation: b.operation, dest: d.file, state: "running", outputs: [], inputBytes: 0, abort: new AbortController(), work: fs.mkdtempSync(path.join(root, "work-")) };
  JOBS.set(j.id, j);
  const deadline = setTimeout(() => stop(j, "timeout"), 5 * 60e3);
  const quota = setInterval(() => {
    try {
      let bytes = 0;
      const out = path.join(j.work, "output");
      if (fs.existsSync(out)) for (const name of fs.readdirSync(out)) bytes += fs.lstatSync(path.join(out, name)).size;
      // pdf-shrink 在 TMPDIR 里先写临时 PDF，成功后才移动到 output，不能漏算这段磁盘占用。
      for (const name of fs.readdirSync(j.work)) if (!/^input-\d+\.pdf$/.test(name) && name !== "selection.pdf" && fs.lstatSync(path.join(j.work, name)).isFile()) bytes += fs.lstatSync(path.join(j.work, name)).size;
      if (bytes > MAX_OUTPUT) stop(j, "output-limit");
      const space = fs.statfsSync(j.work);
      if (space.bavail * space.bsize < 64 * 1024 ** 2) stop(j, "ENOSPC");
    } catch { stop(j, "tool-failed"); }
  }, 1000);
  j.done = processPdf(j, b).then(() => { j.state = "done"; }, (e) => { j.code = j.stop || e.code || "tool-failed"; j.state = j.code === "cancelled" ? "cancelled" : "error"; }).finally(() => {
    clearTimeout(deadline);
    clearInterval(quota);
    try { fs.rmSync(j.work, { recursive: true, force: true }); } catch {}
  });
  return j;
}

export async function routePdfTools(req, res, u, p) {
  if (!p.startsWith("/api/pdf/")) return NEXT;
  try {
    if (req.method === "GET" && p === "/api/pdf/tools") return sendJson(res, 200, pdfToolsInfo());
    if (req.method === "GET" && p === "/api/pdf/job") {
      const j = JOBS.get(u.searchParams.get("id"));
      return sendJson(res, j ? 200 : 404, j ? jobView(j) : { error: "not-found" });
    }
    if (req.method === "POST" && p === "/api/pdf/start") return sendJson(res, 200, jobView(startPdfJob(JSON.parse((await readBodyBuf(req, 64 * 1024)).toString("utf8") || "{}"))));
    if (req.method === "POST" && p === "/api/pdf/cancel") {
      const b = JSON.parse((await readBodyBuf(req, 4096)).toString("utf8") || "{}"), j = JOBS.get(b.id);
      if (!j) return sendJson(res, 404, { error: "not-found" });
      stop(j); return sendJson(res, 200, jobView(j));
    }
  } catch (e) { return sendJson(res, e.status || 400, { error: e.code || "invalid-request" }); }
  return NEXT;
}

export const _pdfForTest = { JOBS, jobView, stop, pdfEnv };
