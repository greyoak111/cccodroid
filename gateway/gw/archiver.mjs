import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { CFG, log } from "./config.mjs";
import { onShutdown } from "./crashguard.mjs";
import { NEXT, fileKind, readBody, sendJson } from "./http.mjs";
import { SECRET_NAMES, pathBlocked, safeFilePath, safeWritePath } from "./files.mjs";
import { holdsPrivate } from "./pathguard.mjs";
import { ZIP_ENCODINGS, zipExtract, zipList, zipNative } from "./zipread.mjs";

// ── 文件管理器的压缩包：浏览、预览单个文件、解压、压缩（对标 ZArchiver） ──
// 7-Zip 随 APK 走（lib/arm64-v8a/libcc7zz.so，应用经 CCAPP_7ZZ 交来，见 third_party/7zip）。
// zip 系（zip / jar / apk / epub…）由网关自己读目录（zipread.mjs）：文件名按原始字节解码，GBK 包不乱码；
// 加密条目、stored / deflate 以外的方法、分卷才交给 7-Zip。tar.gz / tar.xz / tar.zst… 两段：外层解压的输出直接喂给内层列 tar。
// 口令只在这一次请求里用：经 7-Zip 的标准输入交过去（不进命令行，同 uid 的进程读 /proc/<pid>/cmdline 看不到），不落盘、不写日志。

const sevenZ = () => {
  const own = process.env.CCAPP_7ZZ;
  if (own && fs.existsSync(own)) return own;
  for (const d of (process.env.PATH || "").split(":")) { const f = path.join(d, "7zz"); if (d && fs.existsSync(f)) return f; }
  return "";
};

// 外层是单流压缩、里面是 tar 的：按扩展名认（.tar.gz、.tgz…）
const TAR_OUTER = /\.(tar\.(gz|bz2|xz|zst|lzma|z)|tgz|tbz2?|txz|tzst|taz|tlz)$/i;
const ZIP_EXT = /\.(zip|zipx|jar|apk|apks|aab|xapk|aar|epub|ipa|appx|xpi|war|ear|cbz|whl|nupkg|vsix|crx|kmz)$/i;
const isZipMagic = (file) => { try { const fd = fs.openSync(file, "r"); try { const b = Buffer.alloc(4); fs.readSync(fd, b, 0, 4, 0); return b.readUInt32LE(0) === 0x04034b50 || b.readUInt32LE(0) === 0x06054b50; } finally { fs.closeSync(fd); } } catch { return false; } };

const LIST_CHILDREN_MAX = 5000;      // 一个目录一次最多回这么多条（再多标 truncated，界面提示用过滤）
const ENTRIES_MAX = 500000;
const PREVIEW_MAX = 2 * 1024 ** 3;   // 单个文件解出来预览的上限
const RESERVE = 64 * 1024 ** 2;      // 解压前与解压期留出的余量
const LIST_TIMEOUT_MS = 60 * 1000;   // /api/arc/list 7-Zip 列目录超时上限（A-03）
const RUN7Z_OUT_MAX = 256 << 20;     // run7z 默认 stdout 缓冲上限 256MB（容纳 50 万条目 -slt 输出，超限仍杀进程防 OOM，P1-B）
const PREV_DIR = () => path.join(CFG.workspace, ".cache", "archive-preview");
const PREV_KEEP = 24;

// 运行中的归档子进程登记表：网关退出时全部 SIGKILL 清理，防孤儿 7zz 残留（A-03）
const ACTIVE_PROCS = new Set();
onShutdown("压缩包进程", () => {
  for (const c of ACTIVE_PROCS) {
    try { c.kill("SIGKILL"); } catch {}
  }
  ACTIVE_PROCS.clear();
});

const lexists = (x) => { try { fs.lstatSync(x); return true; } catch { return false; } };

// ── 跑 7-Zip ─────────────────────────────────────────────────────────
/** 起 7zz。password 有就写进标准输入（7-Zip 要口令时从这里读），没有就关掉标准输入（要口令时它报 Break signaled 退出） */
function run7z(args, { cwd, password, stdin, onStdout, signal, timeoutMs = 0, maxOut = RUN7Z_OUT_MAX } = {}) {
  const bin = sevenZ();
  if (!bin) return Promise.reject(Object.assign(new Error("7-Zip not available"), { code: "NO7Z" }));
  if (signal?.aborted) return Promise.reject(Object.assign(new Error("aborted"), { code: "ABORT_ERR" }));
  return new Promise((resolve, reject) => {
    const c = spawn(bin, args, { cwd, stdio: [stdin ? "pipe" : password != null ? "pipe" : "ignore", "pipe", "pipe"], signal, env: { ...process.env, LANG: "C.UTF-8" } });
    ACTIVE_PROCS.add(c);
    let out = [], err = "", outLen = 0, overflow = false, timedOut = false, settled = false;
    let timer = null;
    const cleanup = () => {
      ACTIVE_PROCS.delete(c);
      if (timer) { clearTimeout(timer); timer = null; }
    };
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try { c.kill("SIGKILL"); } catch {}
      }, timeoutMs);
      timer.unref?.();
    }
    c.stdout.on("data", (d) => {
      if (onStdout) { onStdout(d, c); return; }
      if (overflow) return;
      if (outLen + d.length > maxOut) {
        overflow = true;
        out = [];
        try { c.kill("SIGKILL"); } catch {}
        return;
      }
      out.push(d);
      outLen += d.length;
    });
    c.stderr.on("data", (d) => { if (err.length < 65536) err += d; });
    if (stdin) stdin.pipe(c.stdin);
    else if (password != null) { c.stdin.on("error", () => {}); c.stdin.end(password + "\n"); }
    c.on("error", (e) => {
      cleanup();
      if (settled) return;
      settled = true;
      reject(e);
    });
    c.on("close", (code, sig) => {
      cleanup();
      if (settled) return;
      settled = true;
      if (timedOut) return reject(Object.assign(new Error("7-Zip timed out"), { status: 504, code: "ETIMEDOUT" }));
      if (overflow) return reject(Object.assign(new Error("7-Zip output too large"), { status: 413, code: "OVERFLOW" }));
      resolve({ code, sig, out: Buffer.concat(out).toString("utf8"), err });
    });
  });
}
const wrongPw = (r) => /Wrong password|Can not open encrypted|Break signaled|Data Error in encrypted|ERROR: .*encrypted/i.test(r.err + r.out);

/** 7-Zip 的 -slt 列表 → 条目 */
function parseSlt(text) {
  const out = [];
  const body = text.includes("\n----------\n") ? text.slice(text.indexOf("\n----------\n") + 12) : text;
  for (const block of body.split(/\n\s*\n/)) {
    const kv = {};
    for (const l of block.split("\n")) { const i = l.indexOf(" = "); if (i > 0) kv[l.slice(0, i).trim()] = l.slice(i + 3); }
    if (kv.Path == null) continue;
    const attr = kv.Attributes || "";
    const dir = kv.Folder === "+" || /^D/.test(attr) || / d[rwx-]{9}/.test(attr);
    out.push({ path: kv.Path.replace(/\\/g, "/").replace(/\/+$/, ""), dir, link: / l[rwx-]{9}/.test(attr) || !!kv["Symbolic Link"],
      size: dir ? 0 : Number(kv.Size) || 0, packed: Number(kv["Packed Size"]) || 0,
      mtime: kv.Modified ? Date.parse(kv.Modified.replace(" ", "T").replace(/(\.\d{3})\d+$/, "$1")) || 0 : 0, enc: kv.Encrypted === "+" });
    if (out.length >= ENTRIES_MAX) break;
  }
  return out;
}
const sltType = (text) => (/^Type = (.+)$/m.exec(text.split("\n----------\n")[0]) || [])[1] || "";

// ── 读目录（按「文件 + 大小 + 修改时间 + 编码 + 口令」缓存最近几份：一个大包里来回翻目录不用每次重读） ─
const LISTS = new Map();
const listKey = (file, st, enc, pw) => crypto.createHash("sha1").update(`${file}|${st.size}|${st.mtimeMs}|${st.ino}|${st.ctimeMs}|${enc}|${pw ?? ""}`).digest("hex");

/** 读整个压缩包的目录：{ kind: "zip" | "7z" | "tar2", type, entries, encoding?, legacy?, needPassword?, encrypted } */
export async function archiveList(file, { enc = "auto", password, signal, timeoutMs = LIST_TIMEOUT_MS, maxOut = RUN7Z_OUT_MAX } = {}) {
  const st = fs.statSync(file), key = listKey(file, st, enc, password);
  if (LISTS.has(key)) { const v = LISTS.get(key); LISTS.delete(key); LISTS.set(key, v); return v; }
  let r = null;
  if (ZIP_EXT.test(file) || isZipMagic(file)) {
    try {
      const z = zipList(file, ZIP_ENCODINGS.includes(enc) ? enc : "auto");
      r = { kind: "zip", type: "zip", entries: z.entries, encoding: z.encoding, legacy: z.legacy, encrypted: z.entries.some((e) => e.enc) };
    } catch { r = null; }        // 分卷、坏包、自解压的怪格式：交给 7-Zip
  }
  if (!r && TAR_OUTER.test(file)) {
    // 外层解到标准输出，直接喂给内层列 tar（不落临时文件）
    const outer = spawnOuter(file, { signal });
    try {
      const inner = await run7z(["l", "-slt", "-ba", "-si", "-ttar", "-sccUTF-8"], { stdin: outer.stdout, signal, timeoutMs, maxOut });
      const oc = await outer.done;
      if (inner.code === 0 && oc === 0) r = { kind: "tar2", type: "tar", entries: parseSlt(inner.out), encrypted: false };
    } finally { outer.kill(); }
  }
  if (!r) {
    const x = await run7z(["l", "-slt", "-sccUTF-8", "-y", file], { password: password ?? null, signal, timeoutMs, maxOut });
    if (password == null && wrongPw(x)) return { kind: "7z", type: sltType(x.out), entries: [], needPassword: true, encrypted: true };
    if (password != null && wrongPw(x)) return { kind: "7z", type: sltType(x.out), entries: [], needPassword: true, wrongPassword: true, encrypted: true };
    if (x.code !== 0 && x.code !== 1) throw new Error((x.err || x.out).split("\n").filter((l) => /error|cannot|can not|unsupported|not archive/i.test(l)).slice(0, 2).join(" ") || `7-Zip exit ${x.code}`);
    const ents = parseSlt(x.out.replace(/^Enter password.*$/m, ""));
    r = { kind: "7z", type: sltType(x.out), entries: ents, encrypted: ents.some((e) => e.enc) };
    // 单流压缩（.gz、.xz…）里面恰好是一个 tar：当成 tar.* 展开（扩展名没写成 .tar.gz 的）
    if (ents.length === 1 && /\.tar$/i.test(ents[0].path) && /^(gzip|bzip2|xz|zstd|lzma|Z)$/i.test(r.type)) {
      const outer = spawnOuter(file, { signal });
      try {
        const inner = await run7z(["l", "-slt", "-ba", "-si", "-ttar", "-sccUTF-8"], { stdin: outer.stdout, signal, timeoutMs, maxOut });
        if (inner.code === 0 && (await outer.done) === 0) r = { kind: "tar2", type: "tar", entries: parseSlt(inner.out), encrypted: false };
      } finally { outer.kill(); }
    }
  }
  r.total = r.entries.length;
  r.bytes = r.entries.reduce((a, e) => a + (e.size || 0), 0);
  LISTS.set(key, r);
  while (LISTS.size > 4) LISTS.delete(LISTS.keys().next().value);
  return r;
}

/** tar.* 的外层：解到标准输出 */
function spawnOuter(file, { signal } = {}) {
  const c = spawn(sevenZ(), ["x", "-so", "-y", file], { stdio: ["ignore", "pipe", "ignore"], signal });
  ACTIVE_PROCS.add(c);
  const done = new Promise((res) => {
    c.on("close", (code) => { ACTIVE_PROCS.delete(c); res(code); });
    c.on("error", () => { ACTIVE_PROCS.delete(c); res(-1); });
  });
  return { stdout: c.stdout, done, kill: () => { ACTIVE_PROCS.delete(c); try { c.kill(); } catch {} } };
}

/** 条目路径规整：去掉开头的 / 和 ./，. 段丢掉；有 .. 段的（想跳出解压目录）返回 null */
export function cleanEntry(p) {
  const segs = [];
  for (const s of String(p).replace(/\\/g, "/").split("/")) {
    if (!s || s === ".") continue;
    if (s === "..") return null;
    segs.push(s);
  }
  return segs.join("/");
}

/** 某个目录下的直接子项（目录按条目路径补出来：很多包不单独存目录条目） */
export function childrenOf(list, dir) {
  const pre = dir ? dir + "/" : "", seen = new Map();
  for (const e of list.entries) {
    const p = cleanEntry(e.path);
    if (!p || (pre && !p.startsWith(pre))) continue;
    const rest = p.slice(pre.length);
    if (!rest) continue;
    const i = rest.indexOf("/");
    if (i >= 0) { const n = rest.slice(0, i); const d = seen.get(n); if (!d || !d.dir) seen.set(n, { name: n, dir: true, size: 0, mtime: d?.mtime || 0 }); }
    else if (!seen.has(rest) || !seen.get(rest).dir) seen.set(rest, { name: rest, dir: !!e.dir, link: !!e.link, size: e.size, packed: e.packed, mtime: e.mtime, enc: e.enc, kind: fileKind(rest, e.dir) });
    else if (e.dir) seen.get(rest).mtime = e.mtime;
  }
  const items = [...seen.values()].map((x) => (x.dir ? { ...x, kind: "dir" } : x));
  items.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name)));
  return items;
}

/** 选中的条目（文件或目录，路径已规整）展开成要解的文件条目 */
function pick(list, sel) {
  if (!sel || !sel.length) return list.entries.filter((e) => cleanEntry(e.path) != null);
  const want = sel.map(cleanEntry).filter(Boolean);
  return list.entries.filter((e) => { const p = cleanEntry(e.path); return p != null && want.some((w) => p === w || p.startsWith(w + "/")); });
}

// ── 单个文件解到缓存（查看器直接打开） ───────────────────────────────
const PREV_INFLIGHT = new Map();
export async function previewEntry(file, entry, { enc, password } = {}) {
  const list = await archiveList(file, { enc, password, timeoutMs: 0 });
  if (list.needPassword) return { needPassword: true, wrongPassword: !!list.wrongPassword };
  const want = cleanEntry(entry);
  const e = want && list.entries.find((x) => cleanEntry(x.path) === want && !x.dir);
  if (!e) throw Object.assign(new Error("entry not found"), { status: 404 });
  if (e.link) throw Object.assign(new Error("symbolic link"), { status: 400 });
  if (e.size > PREVIEW_MAX) throw Object.assign(new Error("too large to preview"), { status: 413 });
  const st = fs.statSync(file);
  const key = crypto.createHash("sha1").update(`${file}|${st.size}|${st.mtimeMs}|${st.ino}|${st.ctimeMs}|${want}|${list.encoding || ""}`).digest("hex").slice(0, 20);
  const dir = path.join(PREV_DIR(), key), out = path.join(dir, path.basename(want));
  if (fs.existsSync(out)) { const n = new Date(); try { fs.utimesSync(dir, n, n); } catch {} return { path: out, size: fs.statSync(out).size }; }
  if (PREV_INFLIGHT.has(key)) return PREV_INFLIGHT.get(key);
  const run = (async () => {
    if (fs.existsSync(out)) { const n = new Date(); try { fs.utimesSync(dir, n, n); } catch {} return { path: out, size: fs.statSync(out).size }; }
    fs.mkdirSync(PREV_DIR(), { recursive: true });
    checkSpace(PREV_DIR(), e.size);
    const tmp = dir + ".part-" + process.pid + "-" + Date.now() + "-" + crypto.randomBytes(4).toString("hex");
    fs.mkdirSync(tmp, { recursive: true });
    const tout = path.join(tmp, path.basename(want));
    try {
      if (list.kind === "zip" && zipNative(e)) await zipExtract(file, e, tout);
      else await extractOne(file, list, e, tout, password);
      await fs.promises.rm(dir, { recursive: true, force: true });
      fs.renameSync(tmp, dir);
    } catch (err) { await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {}); throw err; }
    prunePreview();
    return { path: out, size: fs.statSync(out).size };
  })().finally(() => { if (PREV_INFLIGHT.get(key) === run) PREV_INFLIGHT.delete(key); });
  PREV_INFLIGHT.set(key, run);
  return run;
}

/** 7-Zip 解一条到 out：-so 写标准输出。条目名用清单文件交（-i@，-spd 关掉通配符），名字里的 * ? @ - 都不会被当成参数 */
async function extractOne(file, list, e, out, password) {
  const lst = out + ".list";
  fs.writeFileSync(lst, e.path + "\n");
  const ws = fs.createWriteStream(out, { flags: "wx", mode: 0o644 });
  let n = 0, over = false, outer = null, wsErr = null, curChild = null;
  ws.on("error", (er) => {
    wsErr = er;
    if (curChild) try { curChild.kill("SIGKILL"); } catch {}
    if (outer) try { outer.kill(); } catch {}
  });
  try {
    let r;
    const onStdout = (d, child) => {
      curChild = child;
      if (wsErr || over) return;
      n += d.length;
      if (n > e.size + 1024 && e.size > 0) {
        over = true;
        try { child.kill("SIGKILL"); } catch {}
        if (outer) try { outer.kill(); } catch {}
        return;
      }
      if (!ws.write(d)) {
        child.stdout.pause();
        ws.once("drain", () => { if (!child.stdout.destroyed && !over && !wsErr) child.stdout.resume(); });
      }
    };
    if (list.kind === "tar2") {
      outer = spawnOuter(file);
      r = await run7z(["e", "-so", "-si", "-ttar", "-spd", "-scsUTF-8", "-i@" + lst], { stdin: outer.stdout, onStdout });
    } else r = await run7z(["e", "-so", "-y", "-spd", "-scsUTF-8", "-i@" + lst, file], { password: password ?? (e.enc ? "" : null), onStdout });
    if (!wsErr) await new Promise((res) => { ws.once("error", () => res()); ws.end(res); });
    if (wsErr) throw wsErr;
    if (over) throw new Error("entry larger than declared");
    if (wrongPw(r)) throw Object.assign(new Error("wrong password"), { status: 401, wrongPassword: true });
    if (r.code !== 0) throw new Error((r.err.trim().split("\n").pop() || `7-Zip exit ${r.code}`).slice(0, 200));
  } finally {
    if (outer) try { outer.kill(); } catch {}
    ws.destroy();
    fs.rmSync(lst, { force: true });
  }
}

function prunePreview() {
  let ds = [];
  try { ds = fs.readdirSync(PREV_DIR()).map((n) => { const f = path.join(PREV_DIR(), n); try { return { f, t: fs.statSync(f).mtimeMs }; } catch { return null; } }).filter(Boolean); } catch { return; }
  ds.sort((a, b) => b.t - a.t);
  for (const d of ds.slice(PREV_KEEP)) fs.rmSync(d.f, { recursive: true, force: true });
}

function checkSpace(dir, need) {
  let free = Infinity;
  try { const s = fs.statfsSync(dir); free = s.bavail * s.bsize; } catch {}
  if (need + RESERVE > free) throw Object.assign(new Error("not enough space"), { status: 507, code: "ENOSPC", need, free });
}

// ── 后台任务：解压、压缩 ────────────────────────────────────────────────
const JOBS = new Map();
let jobSeq = 0;
function newJob(kind, extra) {
  const id = (++jobSeq).toString(36) + crypto.randomBytes(3).toString("hex");
  const j = { id, kind, state: "running", pct: 0, started: Date.now(), ...extra, ac: new AbortController() };
  JOBS.set(id, j);
  for (const [k, v] of JOBS) if (v.state !== "running" && Date.now() - (v.ended || 0) > 10 * 60000) JOBS.delete(k);
  return j;
}
const jobView = ({ ac, child, ...j }) => j;
function finish(j, err) {
  j.ended = Date.now();
  if (err?.code === "ENOSPC") { j.state = "error"; j.error = err.message; j.code = "ENOSPC"; }
  else if (j.ac.signal.aborted) j.state = "cancelled";
  else if (err) { j.state = "error"; j.error = err.message; if (err.wrongPassword) j.wrongPassword = true; if (err.code) j.code = err.code; }
  else { j.state = "done"; j.pct = 100; }
}

/** 解压到 dest：若 dest 已存在且是目录（如 /storage/emulated/0 根目录，其父目录不可写），在 dest 内部建暂存目录；
 *  若 dest 不存在则在 path.dirname(dest) 下建暂存目录；查过（软链不许指出去）再合并进 dest，同名不覆盖（A-03）。 */
export function startExtract(file, { dest, entries, enc, password }) {
  const j = newJob("extract", { file, dest });
  (async () => {
    const list = await archiveList(file, { enc, password, signal: j.ac.signal, timeoutMs: 0 });
    if (list.needPassword) throw Object.assign(new Error("password required"), { wrongPassword: !!list.wrongPassword, status: 401 });
    const items = pick(list, entries);
    if (!items.length) throw new Error("nothing to extract");
    const bytes = items.reduce((a, e) => a + (e.dir ? 0 : e.size || 0), 0);
    j.total = bytes; j.files = items.filter((e) => !e.dir).length;
    const destExists = lexists(dest);
    if (destExists) {
      const dstSt = fs.lstatSync(dest);
      if (dstSt.isSymbolicLink() || !dstSt.isDirectory()) throw new Error("destination is not a folder");
    }
    const stageParent = destExists ? dest : path.dirname(dest);
    checkSpace(stageParent, bytes);
    const stage = path.join(stageParent, `.cc-unpack-${j.id}`);
    fs.mkdirSync(stage);
    let spaceErr = null;
    const spaceWatch = setInterval(() => {
      try {
        const s = fs.statfsSync(stage);
        if (s.bavail * s.bsize < RESERVE) {
          spaceErr = Object.assign(new Error("not enough space"), { status: 507, code: "ENOSPC" });
          j.ac.abort();
        }
      } catch {}
    }, 1000);
    spaceWatch.unref?.();
    try {
      const native = list.kind === "zip" && items.every((e) => e.dir || zipNative(e) || e.link);
      if (native) await extractZipNative(file, items, stage, j);
      else await extract7z(file, list, items, entries, stage, password, j);
      if (spaceErr) throw spaceErr;
      await sanitizeTree(stage);
      mergeInto(stage, dest);
    } catch (err) {
      throw spaceErr || err;
    } finally {
      clearInterval(spaceWatch);
      await fs.promises.rm(stage, { recursive: true, force: true }).catch(() => {});
    }
    log(`[压缩包] 解压 ${file} → ${dest}（${j.files} 个文件）`);
  })().then(() => finish(j), (e) => finish(j, e));
  return j;
}

async function extractZipNative(file, items, stage, j) {
  let done = 0;
  j.skipped = 0;
  for (const e of items) {
    if (j.ac.signal.aborted) throw new Error("cancelled");
    const p = cleanEntry(e.path);
    if (!p) { j.skipped++; continue; }
    const out = path.join(stage, p);
    if (e.dir) { fs.mkdirSync(out, { recursive: true }); continue; }
    if (e.link) { j.skipped++; continue; }           // 软链不解（目标可能指到包外；安卓共享存储也不支持软链）
    fs.mkdirSync(path.dirname(out), { recursive: true });
    if (lexists(out)) { j.skipped++; continue; }     // 包里重复的同名条目：留第一个
    await zipExtract(file, e, out, { signal: j.ac.signal, onBytes: (k) => { done += k; j.done = done; j.pct = j.total ? Math.min(99, Math.floor(done * 100 / j.total)) : 0; } });
    try { fs.utimesSync(out, new Date(e.mtime), new Date(e.mtime)); } catch {}
  }
}

async function extract7z(file, list, items, sel, stage, password, j) {
  const args = ["x", "-y", "-aou", "-bsp1", "-bso0", "-spd", "-scsUTF-8", "-o" + stage];
  let lst = null;
  if (sel && sel.length) {
    lst = stage + ".list";
    fs.writeFileSync(lst, items.map((e) => e.path).join("\n") + "\n");
    args.push("-i@" + lst);
  }
  const onStdout = (d) => { const m = /(\d+)%[^%]*$/.exec(d.toString()); if (m) j.pct = Math.min(99, +m[1]); };
  let outer = null;
  try {
    let r;
    if (list.kind === "tar2") {
      outer = spawnOuter(file, { signal: j.ac.signal });
      r = await run7z([...args, "-si", "-ttar"], { stdin: outer.stdout, onStdout, signal: j.ac.signal });
    } else r = await run7z([...args, file], { password: password ?? (list.encrypted ? "" : null), onStdout, signal: j.ac.signal });
    if (wrongPw(r)) throw Object.assign(new Error("wrong password"), { wrongPassword: true });
    if (r.code !== 0) throw new Error((r.err.trim().split("\n").filter(Boolean).pop() || `7-Zip exit ${r.code}`).slice(0, 300));
  } finally {
    if (outer) try { outer.kill(); } catch {}
    if (lst) fs.rmSync(lst, { force: true });
  }
}

/** 解出来的东西里：指向临时目录外面的软链删掉，特殊文件（FIFO、设备）删掉（异步分批让出事件循环） */
async function sanitizeTree(root) {
  const realRoot = fs.realpathSync(root);
  let n = 0;
  const walk = async (d) => {
    let ds; try { ds = await fs.promises.readdir(d); } catch { return; }
    for (const name of ds) {
      if ((++n & 255) === 0) await new Promise((ok) => setImmediate(ok));
      const f = path.join(d, name);
      let st; try { st = await fs.promises.lstat(f); } catch { continue; }
      if (st.isSymbolicLink()) {
        let t = null; try { t = await fs.promises.realpath(f); } catch {}
        if (!t || !(t === realRoot || t.startsWith(realRoot + path.sep))) await fs.promises.rm(f, { force: true }).catch(() => {});
      } else if (st.isDirectory()) await walk(f);
      else if (!st.isFile()) await fs.promises.rm(f, { force: true }).catch(() => {});
    }
  };
  await walk(root);
}

/** 临时目录里的东西挪进 dest：dest 不存在就整个改名过去；存在就用 lstatSync 确认是真实目录（防软链 TOCTOU），
 *  再逐个挪入，同名（含悬空软链）的新来者改成「名字 (2)」（A-03） */
export function mergeInto(stage, dest) {
  if (!lexists(dest)) { fs.renameSync(stage, dest); fs.mkdirSync(stage); return; }
  const dstSt = fs.lstatSync(dest);
  if (dstSt.isSymbolicLink() || !dstSt.isDirectory()) throw new Error("destination is not a folder");
  for (const n of fs.readdirSync(stage)) fs.renameSync(path.join(stage, n), uniquePath(path.join(dest, n)));
}
export function uniquePath(p) {
  if (!lexists(p)) return p;
  const dir = path.dirname(p), base = path.basename(p);
  // 纯点文件（如 .gitignore）没有扩展名：直接按整名加序号，不要切成 ".gitignore (2).gitignore"
  let stem = base, ext = "";
  if (!(base.startsWith(".") && base.indexOf(".", 1) < 0)) {
    const m = /^(.+?)((?:\.tar)?\.[^.]{1,8})?$/.exec(base);
    stem = (m && m[1]) || base;
    ext = (m && m[2]) || "";
  }
  for (let i = 2; ; i++) { const q = path.join(dir, `${stem} (${i})${ext}`); if (!lexists(q)) return q; }
}

// ── 压缩 ────────────────────────────────────────────────────────────────
export const CREATE_FORMATS = { zip: "zip", "7z": "7z", tar: "tar", "tar.gz": "gzip", "tar.xz": "xz", "tar.bz2": "bzip2" };
/** 不打进压缩包的：凭据目录与凭据文件名（同 files.mjs 的 SECRET_RE / SECRET_NAMES） */
const EXCLUDE_DIRS = [".ssh", ".gnupg", ".aws", ".config/gcloud"];
const SECRET_DIR_RE = /(^|\/)(\.ssh|\.gnupg|\.aws|\.config\/gcloud)$/i;

/** 扫描待压缩条目里的大小写变体凭据路径与逃逸/指向凭据的软链（/sdcard 不区分大小写，7zz 默认 -xr! 区分大小写，
 *  且 7zz 打包 zip 默认跟随软链会直接把指向的私有/凭据文件内容打进压缩包；
 *  源树内部目录软链同样按受深限无环递归排查凭据，超过 maxFiles 抛错而非静默放行，A-03） */
export async function collectSecretExcludes(items, { maxFiles = 200000 } = {}) {
  const out = [];
  let seen = 0;
  const bump = () => {
    if (++seen > maxFiles) {
      throw Object.assign(new Error("too many files to scan for secrets"), { status: 413, code: "TOO_MANY_FILES" });
    }
  };
  const walk = async (abs, rel, realRoot, ancestors, linkDepth) => {
    bump();
    if ((seen & 255) === 0) await new Promise((ok) => setImmediate(ok));
    let st; try { st = await fs.promises.lstat(abs); } catch { return; }
    if (st.isSymbolicLink()) {
      let target = null;
      try { target = await fs.promises.realpath(abs); } catch {}
      const outside = !target || !realRoot || (target !== realRoot && !target.startsWith(realRoot + "/"));
      const base = target ? path.basename(target).toLowerCase() : "";
      if (outside || pathBlocked(target) || SECRET_NAMES.has(base) || SECRET_DIR_RE.test(target)) {
        out.push(rel);
        return;
      }
      // 指向源树内部的目录软链：7zz 打包 zip 会跟随软链，必须做无环受深限递归排查其中的凭据
      let tst = null; try { tst = await fs.promises.stat(target); } catch {}
      if (tst && tst.isDirectory()) {
        if (ancestors.has(target) || linkDepth >= 8) { out.push(rel); return; }
        let ds; try { ds = await fs.promises.readdir(target); } catch { return; }
        const nextAnc = new Set(ancestors);
        nextAnc.add(target);
        for (const n of ds) {
          await walk(path.join(target, n), rel + "/" + n, realRoot, nextAnc, linkDepth + 1);
        }
      }
      return;
    }
    const base = path.basename(abs).toLowerCase();
    if (SECRET_NAMES.has(base) || SECRET_DIR_RE.test(rel)) { out.push(rel); return; }
    if (!st.isDirectory()) return;
    let realDir = null; try { realDir = await fs.promises.realpath(abs); } catch {}
    const nextAnc = new Set(ancestors);
    if (realDir) nextAnc.add(realDir);
    let ds; try { ds = await fs.promises.readdir(abs); } catch { return; }
    for (const n of ds) {
      await walk(path.join(abs, n), rel + "/" + n, realRoot, nextAnc, linkDepth);
    }
  };
  for (const f of items) {
    let realRoot = null;
    try { realRoot = await fs.promises.realpath(f); } catch {}
    await walk(f, path.basename(f), realRoot, new Set(realRoot ? [realRoot] : []), 0);
  }
  return out;
}

export function startCreate({ items, dest, format, level, password, encryptNames }) {
  const j = newJob("create", { dest });
  (async () => {
    const parent = path.dirname(items[0]);
    const tmp = path.join(path.dirname(dest), `.cc-pack-${j.id}-` + path.basename(dest));
    const lv = Math.max(0, Math.min(9, Number.isFinite(+level) ? +level : 5));
    const names = items.map((f) => "./" + path.basename(f));
    const common = ["-y", "-bsp1", "-bso0", "-spd", "-scsUTF-8", ...EXCLUDE_DIRS.map((x) => "-xr!" + x), ...[...SECRET_NAMES].map((x) => "-xr!" + x)];
    const extraEx = await collectSecretExcludes(items);
    let exFile = null;
    if (extraEx.length) {
      exFile = tmp + ".ex";
      fs.writeFileSync(exFile, extraEx.join("\n") + "\n");
      common.push("-x@" + exFile);
    }
    const onStdout = (d) => { const m = /(\d+)%[^%]*$/.exec(d.toString()); if (m) j.pct = Math.min(99, +m[1]); };
    let inner = null;
    try {
      let r;
      if (format === "zip" || format === "7z" || format === "tar") {
        const a = ["a", "-t" + (format === "tar" ? "tar" : format), ...common];
        if (format !== "tar") a.push("-mx=" + lv);
        if (format === "zip") a.push("-mcu=on");                       // 文件名一律 UTF-8 并打标记
        if (password && format === "zip") a.push("-mem=AES256");       // 别用 ZipCrypto（弱）
        if (password && format === "7z" && encryptNames) a.push("-mhe=on");
        if (password && format !== "tar") a.push("-p");                 // 口令经标准输入交（下面 password）；-p 不带值 = 要口令
        r = await run7z([...a, tmp, "--", ...names], { cwd: parent, password: password && format !== "tar" ? password + "\n" + password : null, onStdout, signal: j.ac.signal });
      } else {
        // tar.gz / tar.xz / tar.bz2：内层 tar 写标准输出，外层从标准输入压
        inner = spawn(sevenZ(), ["a", "-ttar", "-so", "-an", ...common.filter((x) => x !== "-bsp1" && x !== "-bso0"), "--", ...names], { cwd: parent, stdio: ["ignore", "pipe", "ignore"], signal: j.ac.signal });
        ACTIVE_PROCS.add(inner);
        const innerDone = new Promise((res) => {
          inner.on("close", (code) => { ACTIVE_PROCS.delete(inner); res(code); });
          inner.on("error", () => { ACTIVE_PROCS.delete(inner); res(-1); });
        });
        r = await run7z(["a", "-t" + CREATE_FORMATS[format], "-mx=" + lv, "-y", "-bsp1", "-bso0", "-si" + path.basename(dest).replace(/\.(gz|xz|bz2)$/i, ""), tmp], { stdin: inner.stdout, onStdout, signal: j.ac.signal });
        const ic = await innerDone;
        if (ic !== 0 && r.code === 0) r = { ...r, code: ic, err: "tar stage failed" };
      }
      if (r.code !== 0 && r.code !== 1) throw new Error((r.err.trim().split("\n").filter(Boolean).pop() || `7-Zip exit ${r.code}`).slice(0, 300));
      if (lexists(dest)) throw Object.assign(new Error("exists"), { status: 409 });
      fs.renameSync(tmp, dest);
    } finally {
      if (inner) { ACTIVE_PROCS.delete(inner); try { inner.kill(); } catch {} }
      if (exFile) fs.rmSync(exFile, { force: true });
      fs.rmSync(tmp, { force: true });
    }
    j.size = fs.statSync(dest).size;
    log(`[压缩包] 压缩 ${items.length} 项 → ${dest}（${format}）`);
  })().then(() => finish(j), (e) => finish(j, e));
  return j;
}

// ── 路由：/api/arc/* ────────────────────────────────────────────────────
const sendErr = (res, e) => sendJson(res, e.status || (e.code === "NO7Z" ? 501 : 500), { error: e.message, code: e.code, wrongPassword: e.wrongPassword || undefined });
/** 目录类参数（解压目标、压缩来源）：同 /api/file/rename 对目录的检查 —— 目录本身得在可写区（借一个虚拟子路径过 safeWritePath），
 *  也不能是装着应用私有目录的上级（pathguard.holdsPrivate，按目录身份判，别名也认得）。
 *  压缩来源连工作区本身也不许整个打包（holdsPrivate 的约定）；解压目标可以是工作区本身（解进去是正常用法） */
function dirAllowed(d, { workspace = true } = {}) {
  if (safeWritePath(path.join(d, ".probe-" + Date.now())).error) return false;
  return !holdsPrivate(d, { workspace });
}

export async function routeArc(req, res, u, p) {
  if (!p.startsWith("/api/arc/")) return NEXT;
  if (req.method === "GET" && p === "/api/arc/info") return sendJson(res, 200, { have: !!sevenZ(), formats: Object.keys(CREATE_FORMATS), encodings: ZIP_ENCODINGS });
  if (req.method === "GET" && p === "/api/arc/job") {
    const j = JOBS.get(u.searchParams.get("id") || "");
    return j ? sendJson(res, 200, jobView(j)) : sendJson(res, 404, { error: "no such job" });
  }
  if (req.method !== "POST") return NEXT;
  let b; try { b = JSON.parse((await readBody(req)) || "{}"); } catch { return sendJson(res, 400, { error: "bad json" }); }
  if (p === "/api/arc/cancel") {
    const j = JOBS.get(String(b.id || ""));
    if (!j) return sendJson(res, 404, { error: "no such job" });
    if (j.state === "running") j.ac.abort();
    return sendJson(res, 200, { ok: true });
  }
  if (p === "/api/arc/create") {
    const items = Array.isArray(b.items) ? b.items.map(String) : [];
    if (!items.length || items.length > 10000) return sendJson(res, 400, { error: "items required" });
    if (!CREATE_FORMATS[b.format]) return sendJson(res, 400, { error: "bad format" });
    const parent = path.dirname(items[0]);
    for (const it of items) {
      if (!path.isAbsolute(it) || path.dirname(it) !== parent) return sendJson(res, 400, { error: "items must share one folder" });
      let st; try { st = fs.lstatSync(it); } catch { return sendJson(res, 404, { error: "not found", path: it }); }
      const ok = st.isDirectory() ? dirAllowed(it) : !safeFilePath(it).error;
      if (!ok) return sendJson(res, 403, { error: "forbidden", path: it });
    }
    const d = safeWritePath(String(b.dest || ""));
    if (d.error) return sendJson(res, d.status || 400, { error: d.error });
    if (!d.fresh) return sendJson(res, 409, { error: "exists" });
    // 压缩包不能放进正要压缩的文件夹里（会把自己也打进去）：d.file 已 realpathSync，源路径也先规整，
    // 否则安卓上 /sdcard/dir 与 /storage/emulated/0/dir/out.zip 别名不一致会绕过检查
    const dLow = d.file.toLowerCase();
    const realOf = (x) => { try { return fs.realpathSync(x); } catch { return x; } };
    if (items.some((it) => { const rLow = realOf(it).toLowerCase(); return dLow === rLow || dLow.startsWith(rLow + path.sep); })) {
      return sendJson(res, 400, { error: "dest inside source" });
    }
    if (!sevenZ()) return sendJson(res, 501, { error: "7-Zip not available", code: "NO7Z" });
    return sendJson(res, 200, jobView(startCreate({ items, dest: d.file, format: b.format, level: b.level, password: b.password ? String(b.password) : "", encryptNames: !!b.encryptNames })));
  }
  // 以下都针对一个压缩包
  const r = safeFilePath(b.path);
  if (r.error) return sendJson(res, r.status || 400, { error: r.error });
  const opt = { enc: String(b.enc || "auto"), password: b.password != null && b.password !== "" ? String(b.password) : undefined };
  try {
    if (p === "/api/arc/list") {
      const ac = new AbortController();
      const onClose = () => { if (!res.writableEnded) ac.abort(); };
      req.on("close", onClose);
      try {
        const list = await archiveList(r.file, { ...opt, signal: ac.signal });
        if (ac.signal.aborted || res.writableEnded) return;
        const dir = cleanEntry(b.dir || "") ?? "";
        const kids = list.needPassword ? [] : childrenOf(list, dir);
        return sendJson(res, 200, {
          path: r.file, dir, kind: list.kind, type: list.type, encoding: list.encoding, legacy: !!list.legacy, encrypted: !!list.encrypted,
          needPassword: !!list.needPassword, wrongPassword: !!list.wrongPassword, total: list.total || 0, bytes: list.bytes || 0,
          entries: kids.slice(0, LIST_CHILDREN_MAX), truncated: kids.length > LIST_CHILDREN_MAX, count: kids.length,
        });
      } catch (e) {
        if (ac.signal.aborted || res.writableEnded) return;
        throw e;
      } finally {
        req.off("close", onClose);
      }
    }
    if (p === "/api/arc/preview") {
      const out = await previewEntry(r.file, String(b.entry || ""), opt);
      return sendJson(res, 200, { ...out, kind: out.path ? fileKind(out.path, false) : undefined });
    }
    if (p === "/api/arc/extract") {
      const dest = String(b.dest || "");
      if (!path.isAbsolute(dest)) return sendJson(res, 400, { error: "absolute dest required" });
      // 目标：已有的文件夹（合并进去），或者父目录里一个还不存在的名字（悬空软链 statSync 抛 ENOENT 须平稳落 403，W2-F2a）
      const exists = lexists(dest);
      let dstSt = null;
      if (exists) { try { dstSt = fs.statSync(dest); } catch {} }
      if (exists ? !dstSt?.isDirectory() || !dirAllowed(dest, { workspace: false }) : safeWritePath(dest).error) return sendJson(res, 403, { error: "forbidden" });
      // 新建文件夹时才看父目录：解到已有的文件夹（比如工作区本身）不必管它的上级是什么
      if (!exists && !dirAllowed(path.dirname(dest), { workspace: false })) return sendJson(res, 403, { error: "forbidden" });
      const entries = Array.isArray(b.entries) ? b.entries.map(String).slice(0, 100000) : null;
      return sendJson(res, 200, jobView(startExtract(r.file, { dest: exists ? fs.realpathSync(dest) : path.join(fs.realpathSync(path.dirname(dest)), path.basename(dest)), entries, ...opt })));
    }
  } catch (e) { return sendErr(res, e); }
  return NEXT;
}
