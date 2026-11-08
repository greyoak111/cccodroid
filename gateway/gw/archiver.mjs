import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { CFG, log } from "./config.mjs";
import { NEXT, fileKind, readBody, sendJson } from "./http.mjs";
import { safeFilePath, safeWritePath } from "./files.mjs";
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
const RESERVE = 64 * 1024 ** 2;      // 解压前留出的余量
const PREV_DIR = () => path.join(CFG.workspace, ".cache", "archive-preview");
const PREV_KEEP = 24;

// ── 跑 7-Zip ─────────────────────────────────────────────────────────
/** 起 7zz。password 有就写进标准输入（7-Zip 要口令时从这里读），没有就关掉标准输入（要口令时它报 Break signaled 退出） */
function run7z(args, { cwd, password, stdin, onStdout, signal } = {}) {
  const bin = sevenZ();
  if (!bin) return Promise.reject(Object.assign(new Error("7-Zip not available"), { code: "NO7Z" }));
  return new Promise((resolve, reject) => {
    const c = spawn(bin, args, { cwd, stdio: [stdin ? "pipe" : password != null ? "pipe" : "ignore", "pipe", "pipe"], signal, env: { ...process.env, LANG: "C.UTF-8" } });
    let out = [], err = "", outLen = 0;
    c.stdout.on("data", (d) => { if (onStdout) onStdout(d); else if (outLen < 256 << 20) { out.push(d); outLen += d.length; } });
    c.stderr.on("data", (d) => { if (err.length < 65536) err += d; });
    if (stdin) stdin.pipe(c.stdin);
    else if (password != null) { c.stdin.on("error", () => {}); c.stdin.end(password + "\n"); }
    c.on("error", reject);
    c.on("close", (code, sig) => resolve({ code, sig, out: Buffer.concat(out).toString("utf8"), err }));
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
export async function archiveList(file, { enc = "auto", password } = {}) {
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
    const outer = spawnOuter(file);
    const inner = await run7z(["l", "-slt", "-ba", "-si", "-ttar", "-sccUTF-8"], { stdin: outer.stdout });
    const oc = await outer.done;
    if (inner.code === 0 && oc === 0) r = { kind: "tar2", type: "tar", entries: parseSlt(inner.out), encrypted: false };
  }
  if (!r) {
    const x = await run7z(["l", "-slt", "-sccUTF-8", "-y", file], { password: password ?? null });
    if (password == null && wrongPw(x)) return { kind: "7z", type: sltType(x.out), entries: [], needPassword: true, encrypted: true };
    if (password != null && wrongPw(x)) return { kind: "7z", type: sltType(x.out), entries: [], needPassword: true, wrongPassword: true, encrypted: true };
    if (x.code !== 0 && x.code !== 1) throw new Error((x.err || x.out).split("\n").filter((l) => /error|cannot|can not|unsupported|not archive/i.test(l)).slice(0, 2).join(" ") || `7-Zip exit ${x.code}`);
    const ents = parseSlt(x.out.replace(/^Enter password.*$/m, ""));
    r = { kind: "7z", type: sltType(x.out), entries: ents, encrypted: ents.some((e) => e.enc) };
    // 单流压缩（.gz、.xz…）里面恰好是一个 tar：当成 tar.* 展开（扩展名没写成 .tar.gz 的）
    if (ents.length === 1 && /\.tar$/i.test(ents[0].path) && /^(gzip|bzip2|xz|zstd|lzma|Z)$/i.test(r.type)) {
      const outer = spawnOuter(file);
      const inner = await run7z(["l", "-slt", "-ba", "-si", "-ttar", "-sccUTF-8"], { stdin: outer.stdout });
      if (inner.code === 0 && (await outer.done) === 0) r = { kind: "tar2", type: "tar", entries: parseSlt(inner.out), encrypted: false };
    }
  }
  r.total = r.entries.length;
  r.bytes = r.entries.reduce((a, e) => a + (e.size || 0), 0);
  LISTS.set(key, r);
  while (LISTS.size > 4) LISTS.delete(LISTS.keys().next().value);
  return r;
}

/** tar.* 的外层：解到标准输出 */
function spawnOuter(file) {
  const c = spawn(sevenZ(), ["x", "-so", "-y", file], { stdio: ["ignore", "pipe", "ignore"] });
  const done = new Promise((res) => { c.on("close", (code) => res(code)); c.on("error", () => res(-1)); });
  return { stdout: c.stdout, done, kill: () => { try { c.kill(); } catch {} } };
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
export async function previewEntry(file, entry, { enc, password } = {}) {
  const list = await archiveList(file, { enc, password });
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
  fs.mkdirSync(PREV_DIR(), { recursive: true });
  checkSpace(PREV_DIR(), e.size);
  const tmp = dir + ".part-" + process.pid + "-" + Date.now();
  fs.mkdirSync(tmp, { recursive: true });
  const tout = path.join(tmp, path.basename(want));
  try {
    if (list.kind === "zip" && zipNative(e)) await zipExtract(file, e, tout);
    else await extractOne(file, list, e, tout, password);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(tmp, dir);
  } catch (err) { fs.rmSync(tmp, { recursive: true, force: true }); throw err; }
  prunePreview();
  return { path: out, size: fs.statSync(out).size };
}

/** 7-Zip 解一条到 out：-so 写标准输出。条目名用清单文件交（-i@，-spd 关掉通配符），名字里的 * ? @ - 都不会被当成参数 */
async function extractOne(file, list, e, out, password) {
  const lst = out + ".list";
  fs.writeFileSync(lst, e.path + "\n");
  const ws = fs.createWriteStream(out, { flags: "wx", mode: 0o644 });
  let n = 0, over = false;
  try {
    let r;
    const onStdout = (d) => { n += d.length; if (n > e.size + 1024 && e.size > 0) over = true; if (!over) ws.write(d); };
    if (list.kind === "tar2") {
      const outer = spawnOuter(file);
      r = await run7z(["e", "-so", "-si", "-ttar", "-spd", "-scsUTF-8", "-i@" + lst], { stdin: outer.stdout, onStdout });
      outer.kill();
    } else r = await run7z(["e", "-so", "-y", "-spd", "-scsUTF-8", "-i@" + lst, file], { password: password ?? (e.enc ? "" : null), onStdout });
    await new Promise((res) => ws.end(res));
    if (over) throw new Error("entry larger than declared");
    if (wrongPw(r)) throw Object.assign(new Error("wrong password"), { status: 401, wrongPassword: true });
    if (r.code !== 0) throw new Error((r.err.trim().split("\n").pop() || `7-Zip exit ${r.code}`).slice(0, 200));
  } finally { ws.destroy(); fs.rmSync(lst, { force: true }); }
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
  if (j.ac.signal.aborted) j.state = "cancelled";
  else if (err) { j.state = "error"; j.error = err.message; if (err.wrongPassword) j.wrongPassword = true; if (err.code === "ENOSPC") j.code = "ENOSPC"; }
  else { j.state = "done"; j.pct = 100; }
}

/** 解压到 dest：先解进同级的临时目录，查过（软链不许指出去）再挪进 dest；dest 已有同名的，新解出来的自动改名，不覆盖 */
export function startExtract(file, { dest, entries, enc, password }) {
  const j = newJob("extract", { file, dest });
  (async () => {
    const list = await archiveList(file, { enc, password });
    if (list.needPassword) throw Object.assign(new Error("password required"), { wrongPassword: !!list.wrongPassword, status: 401 });
    const items = pick(list, entries);
    if (!items.length) throw new Error("nothing to extract");
    const bytes = items.reduce((a, e) => a + (e.dir ? 0 : e.size || 0), 0);
    j.total = bytes; j.files = items.filter((e) => !e.dir).length;
    const parent = path.dirname(dest);
    checkSpace(parent, bytes);
    const stage = path.join(parent, `.cc-unpack-${j.id}`);
    fs.mkdirSync(stage);
    try {
      const native = list.kind === "zip" && items.every((e) => e.dir || zipNative(e) || e.link);
      if (native) await extractZipNative(file, items, stage, j);
      else await extract7z(file, list, items, entries, stage, password, j);
      sanitizeTree(stage);
      mergeInto(stage, dest);
    } finally { fs.rmSync(stage, { recursive: true, force: true }); }
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
    if (fs.existsSync(out)) { j.skipped++; continue; }   // 包里重复的同名条目：留第一个
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
  try {
    let r;
    if (list.kind === "tar2") {
      const outer = spawnOuter(file);
      r = await run7z([...args, "-si", "-ttar"], { stdin: outer.stdout, onStdout, signal: j.ac.signal });
      outer.kill();
    } else r = await run7z([...args, file], { password: password ?? (list.encrypted ? "" : null), onStdout, signal: j.ac.signal });
    if (wrongPw(r)) throw Object.assign(new Error("wrong password"), { wrongPassword: true });
    if (r.code !== 0) throw new Error((r.err.trim().split("\n").filter(Boolean).pop() || `7-Zip exit ${r.code}`).slice(0, 300));
  } finally { if (lst) fs.rmSync(lst, { force: true }); }
}

/** 解出来的东西里：指向临时目录外面的软链删掉，特殊文件（FIFO、设备）删掉 */
function sanitizeTree(root) {
  const realRoot = fs.realpathSync(root);
  const walk = (d) => {
    for (const n of fs.readdirSync(d)) {
      const f = path.join(d, n), st = fs.lstatSync(f);
      if (st.isSymbolicLink()) {
        let t = null; try { t = fs.realpathSync(f); } catch {}
        if (!t || !(t === realRoot || t.startsWith(realRoot + path.sep))) fs.rmSync(f, { force: true });
      } else if (st.isDirectory()) walk(f);
      else if (!st.isFile()) fs.rmSync(f, { force: true });
    }
  };
  walk(root);
}

/** 临时目录里的东西挪进 dest：dest 不存在就整个改名过去；存在就逐个挪，同名的新来者改成「名字 (2)」 */
function mergeInto(stage, dest) {
  if (!fs.existsSync(dest)) { fs.renameSync(stage, dest); fs.mkdirSync(stage); return; }
  if (!fs.statSync(dest).isDirectory()) throw new Error("destination is not a folder");
  for (const n of fs.readdirSync(stage)) fs.renameSync(path.join(stage, n), uniquePath(path.join(dest, n)));
}
export function uniquePath(p) {
  if (!fs.existsSync(p)) return p;
  const dir = path.dirname(p), base = path.basename(p);
  const m = /^(.*?)((?:\.tar)?\.[^.]{1,8})?$/.exec(base), stem = m[1] || base, ext = m[2] || "";
  for (let i = 2; ; i++) { const q = path.join(dir, `${stem} (${i})${ext}`); if (!fs.existsSync(q)) return q; }
}

// ── 压缩 ────────────────────────────────────────────────────────────────
export const CREATE_FORMATS = { zip: "zip", "7z": "7z", tar: "tar", "tar.gz": "gzip", "tar.xz": "xz", "tar.bz2": "bzip2" };
/** 不打进压缩包的：凭据目录（同 files.mjs 的 SECRET_RE） */
const EXCLUDE = [".ssh", ".gnupg", ".aws"];

export function startCreate({ items, dest, format, level, password, encryptNames }) {
  const j = newJob("create", { dest });
  (async () => {
    const parent = path.dirname(items[0]);
    const tmp = path.join(path.dirname(dest), `.cc-pack-${j.id}-` + path.basename(dest));
    const lv = Math.max(0, Math.min(9, Number.isFinite(+level) ? +level : 5));
    const names = items.map((f) => "./" + path.basename(f));
    const common = ["-y", "-bsp1", "-bso0", "-spd", "-scsUTF-8", ...EXCLUDE.map((x) => "-xr!" + x)];
    const onStdout = (d) => { const m = /(\d+)%[^%]*$/.exec(d.toString()); if (m) j.pct = Math.min(99, +m[1]); };
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
        const inner = spawn(sevenZ(), ["a", "-ttar", "-so", "-an", ...common.filter((x) => x !== "-bsp1" && x !== "-bso0"), "--", ...names], { cwd: parent, stdio: ["ignore", "pipe", "ignore"], signal: j.ac.signal });
        const innerDone = new Promise((res) => { inner.on("close", res); inner.on("error", () => res(-1)); });
        r = await run7z(["a", "-t" + CREATE_FORMATS[format], "-mx=" + lv, "-y", "-bsp1", "-bso0", "-si" + path.basename(dest).replace(/\.(gz|xz|bz2)$/i, ""), tmp], { stdin: inner.stdout, onStdout, signal: j.ac.signal });
        const ic = await innerDone;
        if (ic !== 0 && r.code === 0) r = { ...r, code: ic, err: "tar stage failed" };
      }
      if (r.code !== 0 && r.code !== 1) throw new Error((r.err.trim().split("\n").filter(Boolean).pop() || `7-Zip exit ${r.code}`).slice(0, 300));
      if (fs.existsSync(dest)) throw Object.assign(new Error("exists"), { status: 409 });
      fs.renameSync(tmp, dest);
    } finally { fs.rmSync(tmp, { force: true }); }
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
    // 压缩包不能放进正要压缩的文件夹里（会把自己也打进去）
    if (items.some((it) => d.file === it || d.file.startsWith(it + path.sep))) return sendJson(res, 400, { error: "dest inside source" });
    if (!sevenZ()) return sendJson(res, 501, { error: "7-Zip not available", code: "NO7Z" });
    return sendJson(res, 200, jobView(startCreate({ items, dest: d.file, format: b.format, level: b.level, password: b.password ? String(b.password) : "", encryptNames: !!b.encryptNames })));
  }
  // 以下都针对一个压缩包
  const r = safeFilePath(b.path);
  if (r.error) return sendJson(res, r.status || 400, { error: r.error });
  const opt = { enc: String(b.enc || "auto"), password: b.password != null && b.password !== "" ? String(b.password) : undefined };
  try {
    if (p === "/api/arc/list") {
      const list = await archiveList(r.file, opt);
      const dir = cleanEntry(b.dir || "") ?? "";
      const kids = list.needPassword ? [] : childrenOf(list, dir);
      return sendJson(res, 200, {
        path: r.file, dir, kind: list.kind, type: list.type, encoding: list.encoding, legacy: !!list.legacy, encrypted: !!list.encrypted,
        needPassword: !!list.needPassword, wrongPassword: !!list.wrongPassword, total: list.total || 0, bytes: list.bytes || 0,
        entries: kids.slice(0, LIST_CHILDREN_MAX), truncated: kids.length > LIST_CHILDREN_MAX, count: kids.length,
      });
    }
    if (p === "/api/arc/preview") {
      const out = await previewEntry(r.file, String(b.entry || ""), opt);
      return sendJson(res, 200, { ...out, kind: out.path ? fileKind(out.path, false) : undefined });
    }
    if (p === "/api/arc/extract") {
      const dest = String(b.dest || "");
      if (!path.isAbsolute(dest)) return sendJson(res, 400, { error: "absolute dest required" });
      // 目标：已有的文件夹（合并进去），或者父目录里一个还不存在的名字
      const exists = fs.existsSync(dest);
      if (exists ? !fs.statSync(dest).isDirectory() || !dirAllowed(dest, { workspace: false }) : safeWritePath(dest).error) return sendJson(res, 403, { error: "forbidden" });
      // 新建文件夹时才看父目录：解到已有的文件夹（比如工作区本身）不必管它的上级是什么
      if (!exists && !dirAllowed(path.dirname(dest), { workspace: false })) return sendJson(res, 403, { error: "forbidden" });
      const entries = Array.isArray(b.entries) ? b.entries.map(String).slice(0, 100000) : null;
      return sendJson(res, 200, jobView(startExtract(r.file, { dest: exists ? fs.realpathSync(dest) : path.join(fs.realpathSync(path.dirname(dest)), path.basename(dest)), entries, ...opt })));
    }
  } catch (e) { return sendErr(res, e); }
  return NEXT;
}
