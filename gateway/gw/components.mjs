import fs from "node:fs";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import crypto from "node:crypto";
import { CFG, LIVE, LAST_LANG, PREFIX, log, tr, tz } from "./config.mjs";
import { claudeEnv, killTree } from "./claude.mjs";
import { NEXT, readBody, sendJson } from "./http.mjs";
import { termEnv } from "./terminal.mjs";
import { SKILLS_DIR, skillMeta } from "./extensions.mjs";
import { modulesMissingFor } from "./modules.mjs";
import { ghProxy, pget } from "./pget.mjs";

/** 前端文件（web/ 下全部，含 i18n.js 与各语言词典）的最后修改时间戳。界面拿它来判断「我是不是该刷新了」——
 *  这样以后只改 web/ 也能自动生效，不用重开 App。 */
// ── 可选组件（v0.1.9 起：浏览器组件 = 无头 Chromium）───────────────────
// 照 livehime 浏览器组件的路子：
//   · 组件有自己的版本，跟工具包（devkit）走，不跟 App 走。索引里每个构建声明它要求的工具包（gz 的 sha256），
//     对不上就不装、已装的显示"需要重新安装"。
//   · 两阶段：先下载 → 核 sha256 → 解到暂存区 → 按 MANIFEST 逐文件核对；全部通过才把文件换进 $PREFIX。
//     中途任何一步失败，$PREFIX 一根毫毛不动。
//   · 已装记录在 files/components/<id>.json（$PREFIX 之外：工具包整体替换时不会把记录一起换掉）；
//     记录里列着装进去的每个文件，卸载就按它删，不会误删工具包自己的东西。
//   · 状态：absent / downloading / verifying / installing / ok / outdated（工具包变了）/ damaged / error
// 只在 cccodroid（有 Termux 前缀）上可用；开发端没有 $PREFIX，接口返回 supported:false。
const COMP_INDEX = process.env.CCAPP_COMPONENTS_INDEX ||
  "https://github.com/greyoak111/cccodroid/releases/download/components/components.json";
// 社区组件（v0.2.0 起）：greyoak111/cccodroid-components 仓库，CI 按配方打包、出签名索引
const COMP_COMMUNITY_INDEX = process.env.CCAPP_COMPONENTS_COMMUNITY_INDEX ||
  "https://github.com/greyoak111/cccodroid-components/releases/download/index/components.json";
// 索引签名公钥（ed25519）：每份索引旁边都有 <索引>.sig（对原始字节的签名，base64），验不过整份不用。
// 索引里有每个包的 sha256，所以验了索引就等于验了包。私钥只在发布机和组件仓库的 CI 密钥里。
const COMP_INDEX_PUBKEY = crypto.createPublicKey(
  "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA4u1V3UuRVZgXwqXXQaQIBaefPf2PCGqKqvsna9Pgzzs=\n-----END PUBLIC KEY-----\n");
export const COMP_DIR = PREFIX ? path.join(path.dirname(PREFIX), "components") : "";
const COMP_JOBS = new Map();      // id → { phase, done, total, error, child, cancelled }
export let compIndexCache = { at: 0, data: null, error: "" };

export function devkitIdentity() {
  try { return JSON.parse(fs.readFileSync(path.join(PREFIX, ".devkit-ok"), "utf8")); } catch { return null; }
}
const compRecFile = (id) => path.join(COMP_DIR, id + ".json");
export function compRecord(id) { try { return JSON.parse(fs.readFileSync(compRecFile(id), "utf8")); } catch { return null; } }
function compWriteRecord(id, rec) {
  fs.mkdirSync(COMP_DIR, { recursive: true });
  fs.writeFileSync(compRecFile(id) + ".tmp", JSON.stringify(rec, null, 1));
  fs.renameSync(compRecFile(id) + ".tmp", compRecFile(id));
}

function compFetch(src, quick) {
  // quick：拉索引用——连不上 8 秒就放弃、只重试一次，好尽快换镜像（GitHub 被墙时以前要干等一分多钟）
  const t = quick ? ["--connect-timeout", "8", "--max-time", "20", "--retry", "1"] : ["--max-time", "30", "--retry", "2"];
  return new Promise((resolve, reject) => {
    execFile(path.join(PREFIX, "bin", "curl"), ["-fsSL", ...t, src],
      { env: claudeEnv(), maxBuffer: 4 << 20, encoding: "buffer" },
      (e, so, se) => (e ? reject(new Error(String(se || e.message).trim().slice(0, 200))) : resolve(so)));
  });
}
// 备用源：cccodroid.net 镜像了两份索引（连同 .sig，逐字节同 GitHub）。主地址拉不到才用；照样验签，镜像不需要被信任
const COMP_INDEX_MIRROR = { preset: process.env.CCAPP_COMPONENTS_INDEX_MIRROR || "https://cccodroid.net/components/official/components.json",
  community: process.env.CCAPP_COMPONENTS_COMMUNITY_INDEX_MIRROR || "https://cccodroid.net/components/community/components.json" };   // 环境变量只给测试用
/** 取一份索引并验签。unsigned 只在私有目录里有 allow-unsigned 开关文件时才放行（/sdcard 别的应用也能写） */
// 上回主地址拉不到、靠镜像拉到的：这回先试镜像（记在磁盘缓存里，重开 App 也记得）
// 镜像地址 → 改用镜像的时刻（两份索引各记各的）；一天后重新先试主地址——镜像是定时同步的，可能比 GitHub 晚一拍
let compIndexViaMirror = {};
async function compFetchIndex(src, mirror) {
  let body;
  const preferMirror = mirror && Date.now() - (compIndexViaMirror[mirror] || 0) < 24 * 3600e3;
  const order = preferMirror ? [mirror, src] : [src, mirror].filter(Boolean);
  let first;
  for (const u of order) {
    try { body = await compFetch(u, true); src = u; break; }
    catch (e) { first = first || e; }
  }
  if (body === undefined) throw first;
  if (mirror) {
    if ((src === mirror) !== !!compIndexViaMirror[mirror]) log(src === mirror ? `组件索引改用镜像：${mirror}` : `组件索引回到主地址：${order.find((u) => u !== mirror)}`);
    if (src !== mirror) delete compIndexViaMirror[mirror];
    else if (!preferMirror) compIndexViaMirror[mirror] = Date.now();     // 刚换过来才记时刻，一直走镜像不续期
  }
  let sig = null;
  try { sig = Buffer.from(String(await compFetch(src + ".sig", true)).trim(), "base64"); } catch {}
  const ok = sig && sig.length === 64 && crypto.verify(null, body, COMP_INDEX_PUBKEY, sig);
  if (!ok && !fs.existsSync(path.join(COMP_DIR, "allow-unsigned"))) throw new Error(sig ? tz("索引签名不对，已拒绝") : tz("索引没有签名，已拒绝"));
  return { ...JSON.parse(String(body)), signed: !!ok };
}

/** 两个来源合并：预置（cccodroid 仓库）在前，社区（cccodroid-components）在后；id 撞了以预置为准。
 *  共享目录里放了 components/components.json 就代替预置来源（离线 / 测试），同样要签名。 */
// 磁盘缓存：上回验过签的合并索引存一份，重开 App 后扩展页先拿它出列表，不用等网络（群友：每次重开组件栏都要等好久）。
// 文件在私有目录（和已装记录同处、同等可信）；名字别以 .json 结尾——COMP_DIR 里的 *.json 都当已装记录读
const compCacheFile = () => COMP_DIR && path.join(COMP_DIR, "index.cache");
function compLoadDiskCache() {
  if (compIndexCache.data || !compCacheFile()) return;
  try {
    const c = JSON.parse(fs.readFileSync(compCacheFile(), "utf8"));
    if (c && c.data && c.data.components) { compIndexCache = { at: c.at || 0, data: c.data, error: "" }; compIndexViaMirror = c.viaMirror && typeof c.viaMirror === "object" ? c.viaMirror : {}; }
  } catch {}
}
function compSaveDiskCache() {
  if (!compCacheFile() || !compIndexCache.data) return;
  try {
    fs.mkdirSync(COMP_DIR, { recursive: true });
    fs.writeFileSync(compCacheFile() + ".tmp", JSON.stringify({ at: compIndexCache.at, viaMirror: compIndexViaMirror, data: compIndexCache.data }));
    fs.renameSync(compCacheFile() + ".tmp", compCacheFile());
  } catch {}
}

let compIndexInflight = null;
export async function compIndex(force) {
  // force：true = 必拉、等结果（「检查更新」）；数字 = 缓存超过这么多毫秒就该拉（打开扩展页用，刚合并的验证记录不用等 10 分钟）
  const maxAge = typeof force === "number" ? force : force ? -1 : 10 * 60e3;
  compLoadDiskCache();
  if (compIndexCache.data && Date.now() - compIndexCache.at < maxAge) return compIndexCache;
  if (!compIndexInflight) compIndexInflight = compIndexFetch().finally(() => { compIndexInflight = null; });
  // 手里有旧的、又不是「检查更新」：先拿旧的回去，后台接着拉（refreshing 告诉前端过会儿再要一次）
  if (compIndexCache.data && force !== true) { compIndexInflight.catch(() => {}); return { ...compIndexCache, refreshing: true }; }
  return compIndexInflight;
}

async function compIndexFetch() {
  const local = process.env.CCAPP_SHARED && path.join(process.env.CCAPP_SHARED, "components", "components.json");
  const sources = [
    { source: "preset", url: local && fs.existsSync(local) ? "file://" + local : COMP_INDEX },
    { source: "community", url: COMP_COMMUNITY_INDEX },
  ];
  const got = await Promise.all(sources.map((s) => compFetchIndex(s.url, s.url.startsWith("file://") ? null : COMP_INDEX_MIRROR[s.source]).then((d) => ({ ...s, d }), (e) => ({ ...s, e }))));
  const components = {}, errors = [];
  for (const g of got) {
    if (g.e) { errors.push(`${g.source}: ${g.e.message}`); continue; }
    for (const [id, e] of Object.entries(g.d.components || {})) if (!components[id]) components[id] = { ...e, source: g.source, signed: g.d.signed };
  }
  // 某个来源这次没取到：沿用上次那个来源的条目，免得已装组件的状态跳成"不在索引里"
  const prev = (compIndexCache.data && compIndexCache.data.components) || {};
  for (const g of got) if (g.e) for (const [id, e] of Object.entries(prev)) if (e.source === g.source && !components[id]) components[id] = e;
  const anyOk = got.some((g) => !g.e);
  compIndexCache = anyOk || !compIndexCache.data
    ? { at: errors.length ? Date.now() - 9 * 60e3 : Date.now(), data: { components }, error: errors.join("；") }   // 有失败的一分钟后再试
    : { at: Date.now() - 9 * 60e3, data: compIndexCache.data, error: errors.join("；") };
  if (anyOk) compSaveDiskCache();
  return compIndexCache;
}

/** 给当前工具包挑一个构建：base 等于已装工具包 gz 的 sha256 */
function compBuildFor(entry, dk) {
  const sha = dk && dk.sha256;
  return (entry.builds || []).find((b) => sha && b.base === sha) || null;
}

function compState(id, entry, dk) {
  const job = COMP_JOBS.get(id);
  if (job && !job.finished) return job.phase;
  const rec = compRecord(id);
  if (!rec) return job && job.error ? "error" : "absent";
  if (rec.state !== "ok") return "damaged";
  if (!dk || rec.base !== dk.sha256) return "outdated";          // 工具包换过：组件的文件已随旧工具包一起没了
  for (const b of rec.bin || []) if (!fs.existsSync(path.join(PREFIX, "bin", b))) return "damaged";
  const build = entry && compBuildFor(entry, dk);
  if (build && build.sha256 !== rec.sha256) return "update";
  return "ok";
}

// 只限某家 GPU 的组件：needs.gpu 写 "adreno"（Turnip 走 /dev/kgsl-3d0）或 "mali"（厂商驱动走 /dev/mali0），
// 别家 SoC 上没有那个节点，装了也用不了
const GPU_NODE = { adreno: "/dev/kgsl-3d0", mali: "/dev/mali0" };
const compUnsupported = (e) => { const g = e && e.needs && e.needs.gpu; return GPU_NODE[g] && !fs.existsSync(GPU_NODE[g]) ? g : ""; };
// 依赖的组件装好了没有（有新版本可更新也算装好）
const compDepOk = (rid, comps, dk) => ["ok", "update"].includes(compState(rid, comps[rid] || null, dk));
const compName = (rid, comps) => (comps[rid] && comps[rid].name) || { zh: rid, en: rid };
/** 已装的组件里，requires 了 id 的那些（卸载 id 会把它们弄坏） */
function compUsers(id) {
  const out = [];
  try {
    for (const f of fs.readdirSync(COMP_DIR)) {
      if (!f.endsWith(".json") || f === id + ".json") continue;
      const r = compRecord(f.slice(0, -5));
      if (r && (r.requires || []).includes(id)) out.push(f.slice(0, -5));
    }
  } catch {}
  return out;
}

async function compList(force) {
  if (!PREFIX) return { supported: false };
  const dk = devkitIdentity();
  compHealSkills();
  const ix = await compIndex(force);
  const comps = (ix.data && ix.data.components) || {};
  const ids = new Set([...Object.keys(comps)]);
  try { for (const f of fs.readdirSync(COMP_DIR)) if (f.endsWith(".json")) ids.add(f.slice(0, -5)); } catch {}
  const items = [...ids].map((id) => {
    const e = comps[id] || null, b = e && compBuildFor(e, dk), rec = compRecord(id), job = COMP_JOBS.get(id);
    return {
      id, name: e ? e.name : { zh: id, en: id }, desc: e ? e.desc : null,
      version: b ? b.version : null, bytes: b ? b.bytes : 0, installed: b ? b.installed : 0,
      available: !!b, installedVersion: rec ? rec.version : null,
      state: compState(id, e, dk),
      progress: job && !job.finished ? { phase: job.phase, done: job.done, total: job.total, via: job.phase === "downloading" ? job.via || "" : "" } : null,
      error: job && job.error ? tr(LAST_LANG, job.error) : "",
      bin: (b && b.bin) || (rec && rec.bin) || [],
      selftest: (b && b.selftest) || "",
      // 来源与可信度：预置组件由 cccodroid 发布、随版本测过；社区组件看 verified（真机验证记录）
      source: e ? e.source : (rec && rec.source) || "", signed: e ? !!e.signed : true,
      verified: e ? e.source === "preset" || !!(b && b.verified) : true,
      license: (e && e.license) || "", homepage: (e && e.homepage) || "", needs: (e && e.needs) || {},
      category: (e && e.category) || "",          // 扩展页分类索引条用（配方的 category）
      // 依赖：requires 了哪些组件、各自装好没有；谁在依赖它（卸载前要先卸那些）；本机能不能用
      requires: [
        ...((e && e.requires) || (rec && rec.requires) || []).map((rid) => ({ id: rid, name: compName(rid, comps), ok: compDepOk(rid, comps, dk) })),
        // 模块化工具包：还没装的模块也算没满足的依赖（界面同样置灰安装按钮、写明先装哪个）
        ...(b ? modulesMissingFor(b.baseDeps).map((m) => ({ id: "module:" + m.id, name: m.name, ok: false })) : []),
      ],
      usedBy: rec ? compUsers(id).map((rid) => ({ id: rid, name: compName(rid, comps) })) : [],
      unsupported: compUnsupported(e),
    };
  });
  return { supported: true, devkit: dk ? (dk.sha256 || "").slice(0, 12) : null, indexError: ix.error, refreshing: !!ix.refreshing, items };
}

// 给了 size 且是小文件就一次读完再算：逐个开流对成千个小文件很慢（gpu-driver-glibc 末尾 5600 多个小文件，
// 平板上流式 7 秒、整读 0.4 秒，慢机上几分钟，进度看着像卡死）。整读会占住事件循环，循环里配合 breathe() 让一让
const SMALL_FILE = 1 << 20;
export function sha256File(f, job, size) {
  if (size !== undefined && size < SMALL_FILE) {
    try { const b = fs.readFileSync(f); if (job) job.done += b.length; return Promise.resolve(crypto.createHash("sha256").update(b).digest("hex")); }
    catch (e) { return Promise.reject(e); }
  }
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256"), s = fs.createReadStream(f, { highWaterMark: 1 << 20 });
    s.on("data", (c) => { h.update(c); if (job) job.done += c.length; });
    s.on("end", () => resolve(h.digest("hex")));
    s.on("error", reject);
  });
}

// 长时间同步核对时隔几十毫秒让出一次事件循环，别让界面请求、SSE 干等
let lastBreath = 0;
export async function breathe() {
  if (Date.now() - lastBreath < 40) return;
  await new Promise((r) => setImmediate(r));
  lastBreath = Date.now();
}

export function compRun(job, cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: termEnv(), stdio: ["ignore", "pipe", "pipe"], detached: true, ...opts });
    job.child = child;
    let err = "";
    child.stdout.on("data", () => {});
    child.stderr.on("data", (d) => { err = (err + d).slice(-2000); });
    child.on("error", reject);
    child.on("exit", (code) => { job.child = null; job.cancelled ? reject(new Error("cancelled")) : code === 0 ? resolve() : reject(new Error(tz("{cmd} 退出码 {code}：{err}", { cmd: path.basename(cmd), code, err: `${err.trim().split("\n").filter((l) => l.trim() && !/Exiting with failure status|Error is not recoverable/.test(l)).slice(-3).join(" · ") || err.trim().split("\n").pop() || ""}` }))); });
  });
}

/** 把暂存区里的 usr/ 树逐个搬进 $PREFIX；返回搬进去的相对路径（文件与软链） */
function compMoveIn(stageUsr, rel = "", moved = [], skipped = [], orphans = new Set()) {
  for (const d of fs.readdirSync(path.join(stageUsr, rel), { withFileTypes: true })) {
    const r = rel ? rel + "/" + d.name : d.name;
    const src = path.join(stageUsr, r), dst = path.join(PREFIX, r);
    if (d.isDirectory()) {
      let st = null; try { st = fs.lstatSync(dst); } catch {}
      if (st && !st.isDirectory()) { skipped.push(r); continue; }
      if (!st) fs.mkdirSync(dst, { recursive: true });
      compMoveIn(stageUsr, r, moved, skipped, orphans);
      continue;
    }
    // 工具包已有的同名文件不覆盖（组件只带底座里没有的包，撞名多半是共用的目录索引之类）
    let exists = false; try { fs.lstatSync(dst); exists = true; } catch {}
    if (exists && !orphans.has(r)) { skipped.push(r); continue; }
    fs.renameSync(src, dst);
    moved.push(r);
  }
  return { moved, skipped };
}

const PKG_LIST = /^var\/lib\/dpkg\/info\/(.+)\.list$/;

/** 没人认领的文件：不在任何包的清单（工具包 + 已装组件带进来的 .list）里，也没有已装组件在用。
 *  0.3.9 及以前升级工具包时 carryOver 认错了路径，把旧工具包 / 旧组件 bin/ 下的东西当成用户自己装的搬了过来
 *  （10.18 带的 poppler 的 pdfinfo 就这样留下，配上组件新带的 libpoppler 链接失败）。装组件撞上这种文件就覆盖 */
function compOrphans(list, selfId) {
  const owned = new Set();
  try {
    for (const f of fs.readdirSync(path.join(PREFIX, "var/lib/dpkg/info")))
      if (f.endsWith(".list")) for (const r of compPkgFiles(f.slice(0, -5))) owned.add(r);
  } catch {}
  for (const [id, rec] of compRecords()) if (id !== selfId) for (const r of compNeeds(id, rec)) owned.add(r);
  const out = new Set();
  for (const r of list) {
    // 只管 bin/：carryOver 只搬过 bin/ 这类目录；share/ 下的目录索引、缓存（gschemas.compiled 等）本来就不在清单里，不能动
    if (!r.startsWith("bin/") || owned.has(r)) continue;
    try { if (fs.lstatSync(path.join(PREFIX, r)).isFile()) out.add(r); } catch {}
  }
  return out;
}
/** 磁盘上某个包现在的文件清单（devkit 给每个包写的 var/lib/dpkg/info/<包>.list，绝对路径 → 相对 $PREFIX） */
function compPkgFiles(pkg) {
  const out = [];
  try {
    for (const l of fs.readFileSync(path.join(PREFIX, "var/lib/dpkg/info", pkg + ".list"), "utf8").split("\n")) {
      const i = l.indexOf("/files/usr/");
      if (i >= 0 && l.length > i + 11) out.push(l.slice(i + 11));
    }
  } catch {}
  return out;
}

/** 已装组件要用的全部文件：
 *  · 自己放进去的（files）+ 装的时候已经在、没放的（shared）；0.1.10 及以前的记录没有 shared，拿包内 MANIFEST 补；
 *  · 再加上它带的每个包「磁盘上现在那一版」的整份文件清单。两个组件带了同一个包、版本却不同时
 *    （浏览器带 mesa 26.2.4、GPU 驱动带 26.2.5），后装的跳过了同名文件、用的是先装那版 —— 而那版还有
 *    文件名带版本号的库（libgallium-26.2.4.so），光按路径比对会把它删掉，留下的同名文件就找不到它了 */
export function compNeeds(id, rec) {
  const s = new Set([...(rec.files || []), ...(rec.shared || [])]);
  if (!rec.shared) {
    try {
      for (const line of fs.readFileSync(path.join(PREFIX, "libexec/devkit/components", id, "MANIFEST"), "utf8").split("\n")) {
        const rel = line.split(" ").slice(2).join(" ");
        if (rel) s.add(rel);
      }
    } catch {}
  }
  for (const r of [...s]) { const m = PKG_LIST.exec(r); if (m) for (const f of compPkgFiles(m[1])) s.add(f); }
  return s;
}

/** 已装、且装在当前工具包上的组件记录（id → rec）：判断「谁还在用这些文件 / 底座包」都用它。
 *  工具包换过之后，旧组件的记录还在（界面显示「需要更新」），文件却已随旧 usr 一起没了 —— 不能再算它认领：
 *  不然 10.22 装的 pdf-tools 认领着 gnupg，卸 libreoffice 时它新装的 1038 个 gnupg 文件全留下（10-22 真机验证查出） */
export function compRecords() {
  const out = new Map(), dk = devkitIdentity();
  try {
    for (const f of fs.readdirSync(COMP_DIR)) if (f.endsWith(".json")) {
      const r = compRecord(f.slice(0, -5));
      if (r && r.state === "ok" && dk && r.base === dk.sha256) out.set(f.slice(0, -5), r);
    }
  } catch {}
  return out;
}
/** 组件依赖链里由底座提供的包（索引里这个构建的 baseDeps）；索引没给时为 null（不知道） */
export function compBaseDeps(id, sha) {
  const e = compIndexCache.data && compIndexCache.data.components && compIndexCache.data.components[id];
  const b = e && (e.builds || []).find((x) => x.sha256 === sha);
  return b && Array.isArray(b.baseDeps) ? b.baseDeps.map((d) => (typeof d === "string" ? d : d.name)) : null;
}

/** 删掉一个组件放进去的文件。两个组件带了同一个依赖包（浏览器和 GPU 驱动都带 mesa）时，
 *  后装的那个跳过了已存在的文件、记录里没有它们 —— 所以删之前先看别的组件要不要用：要用的留下、记到它名下，
 *  不然卸一个，另一个就悄悄坏了 */
function compRemoveFiles(id, rec) {
  const others = [];
  for (const [oid, orec] of compRecords()) if (oid !== id) others.push({ id: oid, rec: orec, needs: compNeeds(oid, orec), gained: [] });
  const dirs = new Set();
  // Python 运行时在旁边的 __pycache__ 里生成 .pyc（不在组件清单里）：删 .py 时一并删掉，不然卸载后留下几十 MB
  const pyc = new Map();
  const pycOf = (d) => { if (!pyc.has(d)) { let l = []; try { l = fs.readdirSync(path.join(PREFIX, d)); } catch {} pyc.set(d, l); } return pyc.get(d); };
  for (const r of rec.files || []) {
    const keeper = others.find((o) => o.needs.has(r));
    if (keeper) { keeper.gained.push(r); continue; }
    try { fs.unlinkSync(path.join(PREFIX, r)); } catch {}
    for (let d = path.dirname(r); d && d !== "."; d = path.dirname(d)) dirs.add(d);
    if (r.endsWith(".py")) {
      const pc = path.join(path.dirname(r), "__pycache__"), stem = path.basename(r, ".py") + ".";
      for (const f of pycOf(pc)) if (f.startsWith(stem) && f.endsWith(".pyc")) try { fs.unlinkSync(path.join(PREFIX, pc, f)); } catch {}
      dirs.add(pc);
    }
  }
  for (const o of others) {
    if (!o.gained.length) continue;
    o.rec.files = [...new Set([...(o.rec.files || []), ...o.gained])];
    compWriteRecord(o.id, o.rec);
    log(`[comp] ${id}：${o.gained.length} 个文件 ${o.id} 也要用，留下归它`);
  }
  // 由深到浅删掉变空的目录（工具包自己的目录不空，自然删不掉）
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) { try { fs.rmdirSync(path.join(PREFIX, d)); } catch {} }
  if (rec.skill) fs.rmSync(path.join(SKILLS_DIR, rec.skill), { recursive: true, force: true });
}

async function compInstall(id) {
  if (!PREFIX) return { ok: false, message: "only available in cccodroid" };
  const cur = COMP_JOBS.get(id);
  if (cur && !cur.finished) return { ok: false, message: "busy" };
  const dk = devkitIdentity();
  if (!dk || !dk.sha256) return { ok: false, message: tz("工具包还没装好（或是本地文件装的，没有版本身份），装不了组件") };
  const ix = await compIndex(true);
  const entry = ix.data && ix.data.components && ix.data.components[id];
  if (!entry) return { ok: false, message: ix.error || tz("没有这个组件") };
  const un = compUnsupported(entry);
  if (un) return { ok: false, message: un === "mali" ? tz("这个组件只能用在 ARM Mali GPU（天玑、Exynos 等）的设备上，本机用不了") : tz("这个组件只能用在高通骁龙（Adreno GPU）的设备上，本机用不了") };
  const miss = (entry.requires || []).filter((rid) => !compDepOk(rid, ix.data.components, dk));
  if (miss.length) return { ok: false, message: tz("要先装：{names}", { names: miss.map((rid) => compName(rid, ix.data.components).zh || rid).join("、") }) };
  const b0 = compBuildFor(entry, dk), b = b0 && { ...b0, source: entry.source, requires: entry.requires || [] };
  if (!b) return { ok: false, message: tz("这个组件还没有对应当前工具包的版本，先更新工具包或稍后再试") };
  // 模块化工具包：组件依赖的底座包所在的模块得先装上
  const needMods = modulesMissingFor(b.baseDeps);
  if (needMods.length) return { ok: false, needModules: needMods.map((m) => m.id), message: tz("要先装工具包模块：{names}（扩展页上方「工具包模块」）", { names: needMods.map((m) => m.name.zh || m.id).join("、") }) };
  // 空间：压缩包 + 解开后的大小，再留 10%
  try {
    const sf = fs.statfsSync(path.dirname(PREFIX));
    const need = (b.bytes + b.installed) * 1.1;
    if (sf.bavail * sf.bsize < need) return { ok: false, message: tz("存储空间不够：需要约 {n} MB", { n: Math.ceil(need / 1048576) }) };
  } catch {}
  const job = { phase: "downloading", done: 0, total: b.bytes, error: "", child: null, cancelled: false, finished: false };
  COMP_JOBS.set(id, job);
  compRunInstall(id, b, job).then(
    () => { job.finished = true; log(`[comp] ${id} ${b.version} 装好了`); },
    (e) => { job.finished = true; job.error = job.cancelled ? "" : e.message; log(`[comp] ${id} 安装失败：${e.message}`); });
  return { ok: true };
}

/** 把组件带的 skill 目录拷进 ~/.claude/skills。skill 路径相对 files/（以 usr/ 开头），PREFIX 已经是 files/usr */
function compInstallSkill(id, rel, rec) {
  const src = path.join(PREFIX, rel.replace(/^usr\//, ""));
  const name = (skillMeta(src) || {}).name || id;
  const dst = path.join(SKILLS_DIR, name);
  try {
    fs.rmSync(dst, { recursive: true, force: true });
    fs.mkdirSync(dst, { recursive: true });
    for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(dst, f));
    rec.skill = name;
  } catch (e) { log(`[comp] ${id} 技能没装上：${e.message}`); }
}
// v0.1.9 拼错了 skill 路径（多了一层 usr/），装好的组件没有 skill：发现就补上
function compHealSkills() {
  let fs_; try { fs_ = fs.readdirSync(COMP_DIR); } catch { return; }
  for (const f of fs_) {
    if (!f.endsWith(".json")) continue;
    const id = f.slice(0, -5), rec = compRecord(id);
    if (!rec || rec.state !== "ok" || rec.skill || (COMP_JOBS.get(id) && !COMP_JOBS.get(id).finished)) continue;
    const rel = `usr/share/cccodroid/components/${id}/skill`;
    if (!fs.existsSync(path.join(PREFIX, rel.slice(4), "SKILL.md"))) continue;
    try { fs.rmdirSync(path.join(SKILLS_DIR, id)); } catch {}     // 当时留下的空目录（只删空的）
    compInstallSkill(id, rel, rec);
    if (rec.skill) { compWriteRecord(id, rec); log(`[comp] ${id} 补装技能 ${rec.skill}`); }
  }
}

// 启动后预取一次索引：首次打开「扩展」页时不用干等两份索引下载验签
if (PREFIX && LIVE) setTimeout(() => { compHealSkills(); compIndex(false).catch(() => {}); }, 8000).unref?.();

// 暂存区是所有组件共用的：只清这一个组件自己的东西（<id>-<sha12>.tar.gz[.part] 和解包目录 <id>）。
// 以前卸载时整个 .staging 一起删，别的组件正在下载的 .part 就被连带删掉 —— curl 写完退出、校验时报 ENOENT
function compClearStage(id) {
  const stage = path.join(COMP_DIR, ".staging");
  let list = []; try { list = fs.readdirSync(stage); } catch { return; }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return;   // 组件 id 只有小写字母、数字、连字符
  const mine = new RegExp("^" + id + "-[0-9a-f]{12}\\.tar\\.gz(\\.part(\\.seg)?)?$");
  for (const n of list) if (n === id || mine.test(n)) fs.rmSync(path.join(stage, n), { recursive: true, force: true });
}

// 组件包的镜像地址：官网生成器把两份签名索引里的包同步到 dl.cccodroid.net/components/<official|community>/<文件名>
let compMirrorFirst = false;
function compMirrorUrl(b) {
  const asset = b.asset || String(b.url || "").split("/").pop();
  if (!/^https:\/\/github\.com\//.test(b.url || "") || !/^[\w.+-]+$/.test(asset)) return "";
  return `https://dl.cccodroid.net/components/${b.source === "community" ? "community" : "official"}/${asset}`;
}

async function compRunInstall(id, b, job) {
  const stage = path.join(COMP_DIR, ".staging"), gz = path.join(stage, `${id}-${b.sha256.slice(0, 12)}.tar.gz`), tree = path.join(stage, id);
  fs.mkdirSync(stage, { recursive: true });
  // 上回留下的压缩包也要先核对：以前只看存不存在，一份写坏的（被并发清理打断过）会被反复拿去解包，怎么重试都失败
  if (fs.existsSync(gz)) {
    job.phase = "verifying"; job.done = 0; job.total = b.bytes;
    if ((await sha256File(gz, job)) !== b.sha256) { log(`[comp] ${id} 暂存的压缩包校验不符，删掉重下`); fs.rmSync(gz, { force: true }); }
  }
  // 1) 下载（断点续传：.part 的名字带着 sha，换了版本不会接错）
  if (!fs.existsSync(gz)) {
    const part = gz + ".part";
    {
      // 几个来源轮流试：GitHub 与 dl.cccodroid.net 镜像（逐字节同一份，内容一律按签名索引里的 sha256 把关，镜像不需要被信任）。
      // 同一个 .part 接着续传；哪边成功了下回先试哪边。gh-proxy 只排最后兜底。分段并行下载见 pget.mjs
      const urls = (compMirrorFirst ? [compMirrorUrl(b), b.url] : [b.url, compMirrorUrl(b)]).concat(ghProxy(b.url));
      const srcs = urls.filter(Boolean);
      let lastErr;
      for (let i = 0; i < 4 && !job.cancelled; i++) {
        const url = srcs[i % srcs.length];
        job.via = url === b.url ? "GitHub" : url.startsWith("https://gh-proxy.com/") ? "gh-proxy.com" : "dl.cccodroid.net";
        const err = await pget({ curl: path.join(PREFIX, "bin", "curl"), url, file: part, total: b.bytes,
          onProgress: (d) => { job.done = d; }, cancelled: () => !!job.cancelled });
        if (!err) { lastErr = null; if (url === b.url || url === compMirrorUrl(b)) compMirrorFirst = url !== b.url; break; }
        lastErr = new Error(err); if (job.cancelled) break; log(`[comp] ${id} 从 ${job.via} 下载中断：${err}`);
      }
      if (job.cancelled) throw new Error("cancelled");
      // 上回已经下全、没来得及改名就被打断：续传会得到 416，直接去校验
      let have = 0; try { have = fs.statSync(part).size; } catch {}
      // 分段下载的 .part 一开始就占满总大小，还有 .seg 就说明没下完
      if (lastErr && (have !== b.bytes || fs.existsSync(part + ".seg"))) throw lastErr;
    }
    job.phase = "verifying"; job.done = 0; job.total = b.bytes;
    const got = await sha256File(part, job);
    if (got !== b.sha256) { fs.rmSync(part, { force: true }); fs.rmSync(part + ".seg", { force: true }); throw new Error(tz("下载的文件校验不符（已删除，重试会重新下载）")); }
    fs.renameSync(part, gz);
  }
  if (job.cancelled) throw new Error("cancelled");
  // 2) 解到暂存区，按包内 MANIFEST 逐个核对
  job.phase = "verifying"; job.done = 0; job.total = b.installed || 0;
  fs.rmSync(tree, { recursive: true, force: true });
  fs.mkdirSync(tree, { recursive: true });
  // 解包失败就把压缩包也删了：下次重试从头下载，不再拿同一份去撞
  try { await compRun(job, path.join(PREFIX, "bin", "tar"), ["-xzf", gz, "-C", tree]); }
  catch (e) { if (!job.cancelled) fs.rmSync(gz, { force: true }); throw e; }
  const lx = `libexec/devkit/components/${id}`;
  const man = fs.readFileSync(path.join(tree, "usr", lx, "MANIFEST"), "utf8").trim().split("\n");
  // 进度按清单里的字节算：索引的 installed 是装好后的总占用（含链接等），按它算永远到不了头，看着像卡住
  job.total = man.reduce((a, l) => a + (Number(l.split(" ")[1]) || 0), 0);
  for (const line of man) {
    await breathe();
    if (job.cancelled) throw new Error("cancelled");
    const [h, n, ...rest] = line.split(" "), rel = rest.join(" ");
    const f = path.join(tree, "usr", rel);
    let st; try { st = fs.statSync(f); } catch { throw new Error(tz("组件包缺文件：{file}", { file: rel })); }
    if (st.size !== Number(n) || (await sha256File(f, null, st.size)) !== h) throw new Error(tz("组件包里的文件校验不符：{file}", { file: rel }));
    job.done += st.size;
  }
  // 3) 切换：先写"安装中"的记录（被打断就是 damaged，可以重装或卸载），再逐个搬进 $PREFIX
  job.phase = "installing";
  const old = compRecord(id);
  if (old) compRemoveFiles(id, old);                // 升级 / 重装：先清掉上一版（别的组件也要用的留下）
  const rec = { id, source: b.source || "", version: b.version, upstream: b.upstream, base: b.base, sha256: b.sha256, bin: b.bin || [],
    requires: b.requires || [], skill: "", state: "installing", at: Date.now(), files: [], shared: [] };
  // 先按包内文件清单记下"将要放进去的文件"：搬到一半被杀也能按它卸干净
  const list = [];
  (function walk(rel) {
    for (const d of fs.readdirSync(path.join(tree, "usr", rel), { withFileTypes: true })) {
      const r = rel ? rel + "/" + d.name : d.name;
      if (d.isDirectory()) walk(r); else list.push(r);
    }
  })("");
  // 已经在的（工具包自带，或别的组件放进去的）不覆盖、不归我们，但记进 shared：那个组件卸载时要知道我们也在用
  const orphans = compOrphans(list, id);
  if (orphans.size) log(`[comp] ${id}：${orphans.size} 个没人认领的旧文件被新包覆盖（${[...orphans].slice(0, 5).join(", ")}）`);
  for (const r of list) { let have = false; try { fs.lstatSync(path.join(PREFIX, r)); have = true; } catch {} (have && !orphans.has(r) ? rec.shared : rec.files).push(r); }
  compWriteRecord(id, rec);
  const { skipped } = compMoveIn(path.join(tree, "usr"), "", [], [], orphans);
  if (skipped.length) log(`[comp] ${id}：${skipped.length} 个文件已经在了（工具包或别的组件放的），保留原样`);
  // 4) 首次运行配置（各包 postinst），失败不算安装失败
  const fr = path.join(PREFIX, lx, "first-run.sh");
  if (fs.existsSync(fr)) { try { await compRun(job, path.join(PREFIX, "bin", "sh"), [fr]); } catch (e) { log(`[comp] ${id} first-run：${e.message}`); } }
  // 5) 给 Claude 的技能
  if (b.skill) compInstallSkill(id, b.skill, rec);
  rec.state = "ok"; rec.at = Date.now();
  compWriteRecord(id, rec);
  fs.rmSync(tree, { recursive: true, force: true });
  fs.rmSync(gz, { force: true });
}

function compCancel(id) {
  const job = COMP_JOBS.get(id);
  if (!job || job.finished) return { ok: false, message: "not running" };
  if (job.phase === "installing") return { ok: false, message: tz("正在放进工具包，这一步不能中断") };
  job.cancelled = true;
  if (job.child) killTree(job.child);
  return { ok: true };
}

function compRemove(id) {
  if (!PREFIX) return { ok: false, message: "only available in cccodroid" };
  const job = COMP_JOBS.get(id);
  if (job && !job.finished) return { ok: false, message: "busy" };
  const rec = compRecord(id);
  if (!rec) return { ok: false, message: "not installed" };
  const users = compUsers(id);
  if (users.length) {
    const comps = (compIndexCache.data && compIndexCache.data.components) || {};
    return { ok: false, message: tz("{names} 要用它，先卸载那些组件", { names: users.map((rid) => compName(rid, comps).zh || rid).join("、") }) };
  }
  compRemoveFiles(id, rec);
  fs.rmSync(compRecFile(id), { force: true });
  compClearStage(id);
  COMP_JOBS.delete(id);
  log(`[comp] ${id} 已卸载（${(rec.files || []).length} 个文件）`);
  return { ok: true };
}

// ── 组件的运行数据：约定放在 ~/.cccodroid/<id>/（blender 的 Debian 环境、下载缓存等），卸载组件不碰它。
// 卸载后报出大小、问用户要不要一起删。目录名不一定等于 id（gpu-driver-glibc 用 gpu-driver 的目录），
// 所以只认和 id 同名的目录，还装着 <id>-xxx 组件时当作共用、不提议删
function compDataDir(id) { return path.join(CFG.home, ".cccodroid", id); }
function compDataShared(id) {
  try { return fs.readdirSync(COMP_DIR).some((f) => f.endsWith(".json") && f.startsWith(id + "-")); } catch { return false; }
}
async function compDuBytes(dir) {
  let n = 0;
  const walk = async (d) => {
    let es; try { es = await fs.promises.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else { try { n += (await fs.promises.lstat(p)).size; } catch {} }
    }
  };
  await walk(dir);
  return n;
}
async function compDataInfo(id) {
  const dir = compDataDir(id);
  try { if (!fs.lstatSync(dir).isDirectory()) return null; } catch { return null; }
  if (compRecord(id) || compDataShared(id)) return null;
  return { path: "~/.cccodroid/" + id, bytes: await compDuBytes(dir) };
}
async function compPurgeData(id) {
  if (compRecord(id)) return { ok: false, message: "still installed" };
  if (compDataShared(id)) return { ok: false, message: "shared" };
  const dir = compDataDir(id);
  try { if (!fs.lstatSync(dir).isDirectory()) return { ok: true }; } catch { return { ok: true }; }
  const rm = () => fs.promises.rm(dir, { recursive: true, force: true });
  try { await rm(); }
  catch {
    // 解开的 Debian 包里有只读目录：先把目录都改成可写再删
    const fix = async (d) => {
      try { await fs.promises.chmod(d, 0o700); } catch {}
      let es; try { es = await fs.promises.readdir(d, { withFileTypes: true }); } catch { return; }
      for (const e of es) if (e.isDirectory()) await fix(path.join(d, e.name));
    };
    await fix(dir);
    try { await rm(); } catch (e) { return { ok: false, message: e.message }; }
  }
  log(`[comp] ${id} 的运行数据已删除`);
  return { ok: true };
}

// ── gh 登录卡：设备码流程（显示一次性码 → 用户在浏览器里授权 → gh 自己轮询到完成）──
// 令牌只由 gh 自己存（~/.config/gh/hosts.yml）：网关不读那个文件、不转发、不记 gh 的输出，
// 对外只给账号名与状态。登录成功后跑 gh auth setup-git，git 走 https 推送就能用
const GH = { job: null };
// cccodroid：gh 组件装在 $PREFIX/bin；开发端没有组件这一层，用终端 PATH 里的 gh（devbin/gh）
function ghBin() {
  if (PREFIX) return path.join(PREFIX, "bin", "gh");
  for (const d of String(termEnv().PATH || "").split(":")) if (d && fs.existsSync(path.join(d, "gh"))) return path.join(d, "gh");
  return "";
}
const GH_USER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
function ghExec(args, timeout = 20000) {
  return new Promise((resolve) => execFile(ghBin(), args, { env: termEnv(), timeout },
    (e, out, err) => resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out: String(out || ""), err: String(err || "") })));
}
function ghKill(job) {
  if (!job.child) return;
  try { process.kill(-job.child.pid, "SIGKILL"); } catch { try { job.child.kill("SIGKILL"); } catch {} }
}
async function ghStatus() {
  const bin = ghBin();
  if (!bin || !fs.existsSync(bin)) return { installed: false };
  // 没登录时也是退出码 0、输出 {"hosts":{}}；令牌失效的账号 state 不是 success
  const r = await ghExec(["auth", "status", "--json", "hosts", "-h", "github.com"]);
  let accounts = [];
  try { accounts = (JSON.parse(r.out).hosts["github.com"] || []).map((a) => ({ login: String(a.login || ""), active: !!a.active, ok: a.state === "success" })); } catch {}
  const j = GH.job;
  return { installed: true, accounts, job: j ? { state: j.state, code: j.code, url: j.url, error: j.error, git: j.git } : null };
}
function ghLogin() {
  const bin = ghBin();
  if (!bin || !fs.existsSync(bin)) return { ok: false, message: tz("gh 没装") };
  if (GH.job && ["starting", "waiting"].includes(GH.job.state)) return { ok: true };
  // 没有终端时 gh 不等回车、不开浏览器，只把一次性码和网址打到 stderr；-s workflow 让推 .github/workflows 也行
  const child = spawn(bin, ["auth", "login", "--web", "-h", "github.com", "-p", "https", "-s", "workflow"],
    { env: termEnv(), stdio: ["ignore", "pipe", "pipe"], detached: true });
  const job = (GH.job = { state: "starting", code: "", url: "", error: "", git: null, child });
  let buf = "";
  const onData = (d) => {
    buf = (buf + d).slice(-4000);
    const m = buf.match(/one-time code: ([A-Z0-9]{4}-[A-Z0-9]{4})/);
    if (m && !job.code) { job.code = m[1]; job.state = "waiting"; }
    const u = buf.match(/https:\/\/github\.com\/login\/device\b/);
    if (u) job.url = u[0];
  };
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");   // 按流解码：多字节字符跨块不会被拆坏
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("error", (e) => { job.state = "error"; job.error = e.message; });
  // 设备码 15 分钟过期，过了还没授权就收掉
  const timer = setTimeout(() => { if (job.child) { job.state = "error"; job.error = "timeout"; ghKill(job); } }, 16 * 60000);
  child.on("exit", async (code) => {
    clearTimeout(timer);
    job.child = null;
    if (job.state === "cancelled" || job.error === "timeout") return;
    if (code !== 0) {
      // 只取最后一行报错给界面（剪贴板那两行提示是 gh 自己复制失败，不算错）
      const last = buf.split("\n").map((l) => l.trim()).filter((l) => l && !/clipboard|xsel|one-time code|Open this URL/i.test(l)).pop();
      job.state = "error"; job.error = (last || tz("gh 退出码 {code}", { code })).slice(0, 300);
      return;
    }
    const s = await ghExec(["auth", "setup-git", "-h", "github.com"]);
    job.git = s.code === 0;
    job.state = "done";
    log(`[gh] 登录完成${job.git ? "，已配好 git 凭据" : "，setup-git 失败"}`);
  });
  return { ok: true };
}
async function handleGh(req, res, p) {
  if (req.method === "GET" && p === "/api/gh/auth") return sendJson(res, 200, await ghStatus());
  if (req.method !== "POST") return sendJson(res, 405, { error: "method" });
  let body = {}; try { body = JSON.parse((await readBody(req)) || "{}"); } catch {}
  if (p === "/api/gh/login") return sendJson(res, 200, ghLogin());
  if (p === "/api/gh/cancel") {
    const j = GH.job;
    if (j && j.child) { j.state = "cancelled"; ghKill(j); }
    GH.job = null;
    return sendJson(res, 200, { ok: true });
  }
  const user = String(body.user || "");
  if (!GH_USER.test(user)) return sendJson(res, 400, { ok: false, message: "bad user" });
  const args = { "/api/gh/logout": ["auth", "logout", "-h", "github.com", "-u", user], "/api/gh/switch": ["auth", "switch", "-h", "github.com", "-u", user] }[p];
  if (!args) return sendJson(res, 404, { error: "not found" });
  if (GH.job && GH.job.state !== "starting" && GH.job.state !== "waiting") GH.job = null;
  const r = await ghExec(args);
  return sendJson(res, 200, r.code === 0 ? { ok: true } : { ok: false, message: (r.err.trim().split("\n").pop() || "").slice(0, 300) });
}

// ── 组件的路由 ──────────────────────────────────────────────────────
async function handleComponents(req, res, p, u) {
  if (req.method === "GET" && p === "/api/components") return sendJson(res, 200, await compList(((r) => r === "1" ? true : /^\d+$/.test(r || "") ? Number(r) * 1000 : false)(u.searchParams.get("refresh"))));
  if (req.method !== "POST") return sendJson(res, 405, { error: "method" });
  let body = {}; try { body = JSON.parse((await readBody(req)) || "{}"); } catch {}
  const id = String(body.id || "");
  if (!/^[a-z0-9-]{1,40}$/.test(id)) return sendJson(res, 400, { ok: false, message: "bad id" });
  if (p === "/api/components/install") return sendJson(res, 200, await compInstall(id));
  if (p === "/api/components/cancel") return sendJson(res, 200, compCancel(id));
  if (p === "/api/components/remove") { const r = compRemove(id); if (r.ok) r.data = await compDataInfo(id); return sendJson(res, 200, r); }
  if (p === "/api/components/purge") return sendJson(res, 200, await compPurgeData(id));
  return sendJson(res, 404, { error: "not found" });
}

// ── 路由：/api/components /api/gh/ ──
export async function routeComponents(req, res, u, p) {
  // ── 可选组件（浏览器组件等）──
  if (p === "/api/components" || p.startsWith("/api/components/")) return handleComponents(req, res, p, u);
  if (p.startsWith("/api/gh/")) return handleGh(req, res, p);
  return NEXT;
}
