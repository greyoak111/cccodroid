import fs from "node:fs";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import crypto from "node:crypto";
import { CFG, LIVE, LAST_LANG, PREFIX, log, tr, tz } from "./config.mjs";
import { claudeEnv, killTree } from "./claude.mjs";
import { NEXT, readBody, sendJson } from "./http.mjs";
import { termEnv } from "./terminal.mjs";
import { SKILLS_DIR, addMcp, removeMcp, skillMeta } from "./extensions.mjs";
import { modulesMissingFor } from "./modules.mjs";
import { ghProxy, pget } from "./pget.mjs";
import { retireManagedBridge } from "./managed-bridge.mjs";
import { clearBridgeConfigMapping, handleBridgeConfig, handleBridgeModels, handleBridgeRepair } from "./bridge-config.mjs";
import { archiveProblem, parseTarListing } from "./archive-check.mjs";
import { baseOwnedPaths } from "./orphans.mjs";
import { ucAppBegin, ucAppWrote } from "./userconf.mjs";
import { writeAtomic } from "./statefile.mjs";

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
/** 读普通文件（lstat + O_NOFOLLOW|O_NONBLOCK）：FIFO/设备文件直接当读不到，别把网关事件循环卡死 */
function readSmall(f, max = 1 << 20) {
  try {
    if (!fs.lstatSync(f).isFile()) return null;
    const fd = fs.openSync(f, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.size > max) return null;
      const b = Buffer.alloc(st.size);
      let off = 0;
      while (off < b.length) { const n = fs.readSync(fd, b, off, b.length - off, off); if (!n) break; off += n; }
      return b.subarray(0, off).toString("utf8");
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}
const COMP_JOBS = new Map();      // id → { phase, done, total, error, child, cancelled }
// 跨组件的文件操作串行链。COMP_JOBS 只按组件 id 独占，两个不同组件同时装 / 卸时，
// 各自都要「看别的组件还要用哪些文件」（compRemoveFiles 还会把共享文件转记到别的组件名下），
// 中间隔着下载解包、首启脚本这些 await，两段能交错；两边各读一份记录再各写回去就会丢改动。
// 会改 $PREFIX 文件清单、组件记录、技能目录的阶段都排进这条链（196-供应链.1）。
// 链上一步失败不影响后面排队的人；返回值 / 异常原样交给调用方。
let compFsTail = Promise.resolve();
export function compFsExclusive(fn) {
  const run = compFsTail.catch(() => {}).then(fn);
  compFsTail = run.catch(() => {});
  return run;
}
export let compIndexCache = { at: 0, data: null, error: "" };

export function devkitIdentity() {
  try { return JSON.parse(fs.readFileSync(path.join(PREFIX, ".devkit-ok"), "utf8")); } catch { return null; }
}
const compRecFile = (id) => path.join(COMP_DIR, id + ".json");
/** 读组件记录，返回 { rec, missing, bad }：没有记录和记录坏了不是一回事（195-Z.11）。
 *  坏记录不能当成没装——文件还在 $PREFIX 里，界面得还能列出它、还能卸。
 *  这里没有用 statefile 的 loadState：它读坏了会把原文件改名成 .bad-*，
 *  列表按 <id>.json 就再也找不到这个组件，正好落回 Z.11 的老毛病。
 *  rec 只做「是个普通对象」这层形状检查，逐字段校验仍由各调用方按自己的用途做（compRemovalRecord 等）。 */
export function compRecordInfo(id) {
  const f = compRecFile(id);
  let st;
  try { st = fs.lstatSync(f); }
  catch (e) { return { rec: null, missing: e.code === "ENOENT", bad: e.code !== "ENOENT" }; }
  if (!st.isFile()) return { rec: null, missing: false, bad: true };       // 软链 / 目录 / 设备文件
  const t = readSmall(f);
  if (t == null) return { rec: null, missing: false, bad: true };          // 超过 1 MB / 读不了
  try {
    const j = JSON.parse(t);
    if (!j || typeof j !== "object" || Array.isArray(j)) return { rec: null, missing: false, bad: true };
    return { rec: j, missing: false, bad: false };
  } catch { return { rec: null, missing: false, bad: true }; }
}
export function compRecord(id) { return compRecordInfo(id).rec; }
/** 写组件记录：临时文件 + fsync + 换名（statefile.mjs 的 writeAtomic），失败返回 false，
 *  由调用方如实回给界面——以前是直接覆盖写，掉电 / 写满就留下半截 JSON，整条记录报废（195-Z.10） */
function compWriteRecord(id, rec) {
  return writeAtomic(compRecFile(id), JSON.stringify(rec, null, 1));
}
export const _compForTest = { compWriteRecord, compRecordInfo, compRecFile, compDropDanglingDocs, compSweepDanglingDocs,
  compState, compVerCmp, compOlder, compInstall, compSwitch, compMcpSpec };   // 只给测试用

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
/** 取一份索引并验签。没签名、签名不对一律拒绝；只有网关启动时带了 CCAPP_COMPONENTS_ALLOW_UNSIGNED=1（测试用）才放行。
 *  以前看私有目录里有没有 allow-unsigned 文件，应用身份跑的任何程序（包括模型自己）touch 一下就把签名关了（审查 v0.5.9 D2） */
const allowUnsigned = () => process.env.CCAPP_COMPONENTS_ALLOW_UNSIGNED === "1";
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
  if (!ok && !allowUnsigned()) throw new Error(sig ? tz("索引签名不对，已拒绝") : tz("索引没有签名，已拒绝"));
  const parsed = JSON.parse(String(body));
  // 原始正文与签名一起带回去：磁盘缓存要按它们复核（195-V.3），不能再存一份合并后的对象当可信数据
  return { ...parsed, signed: !!ok, _raw: String(body), _sig: sig && sig.length === 64 ? sig.toString("base64") : "" };
}

/** 两个来源合并：预置（cccodroid 仓库）在前，社区（cccodroid-components）在后；id 撞了以预置为准。
 *  拉索引与读磁盘缓存都走这里，合并口径只有一份。 */
function compMerge(got) {
  const components = {};
  for (const g of got) {
    if (g.e) continue;
    for (const [id, e] of Object.entries(g.d.components || {})) if (!components[id]) components[id] = { ...e, source: g.source, signed: g.d.signed };
  }
  return components;
}

// 磁盘缓存：上回验过签的索引正文与签名按来源各存一份，重开 App 后扩展页先拿它出列表，不用等网络（群友：每次重开组件栏都要等好久）。
// 名字别以 .json 结尾——COMP_DIR 里的 *.json 都当已装记录读。
// 以前存的是合并后的对象、读回来只 JSON.parse：同 uid 改一改就能塞进「已签名」的条目、绕过整条验签链去执行包里
// 的 first-run.sh（0.6.9 审计 195-V.3）。现在读回来当场按公钥复核，`signed` 字段不再从缓存里信。
const compCacheFile = () => COMP_DIR && path.join(COMP_DIR, "index.cache");
let compIndexRaw = null;      // 这份索引可复核的原始正文与签名（source → { body, sig }），存盘用
function compLoadDiskCache() {
  if (compIndexCache.data || !compCacheFile()) return;
  try {
    const t = readSmall(compCacheFile()); if (t == null) return;
    const c = JSON.parse(t);
    const via = c && c.viaMirror && typeof c.viaMirror === "object" ? c.viaMirror : {};
    if (c && c.sources && typeof c.sources === "object") {
      const got = [], raw = {};
      let rejected = false;
      for (const source of ["preset", "community"]) {
        const v = c.sources[source];
        if (!v || typeof v.body !== "string" || !v.body) continue;
        let ok = false;
        try {
          const sig = v.sig ? Buffer.from(String(v.sig), "base64") : null;
          ok = !!(sig && sig.length === 64 && crypto.verify(null, Buffer.from(v.body), COMP_INDEX_PUBKEY, sig));
        } catch {}
        if (!ok && !allowUnsigned()) { rejected = true; continue; }
        let parsed = null;
        try { parsed = JSON.parse(v.body); } catch { rejected = true; continue; }
        if (!parsed || typeof parsed !== "object" || !parsed.components) { rejected = true; continue; }
        got.push({ source, d: { components: parsed.components, signed: ok } });
        raw[source] = { body: v.body, sig: v.sig ? String(v.sig) : "" };
      }
      if (got.length) {
        // 有来源没复核过：整份当过期，下一次 compIndex 重新拉，别让半份数据顶十分钟
        compIndexCache = { at: rejected ? 0 : c.at || 0, data: { components: compMerge(got) }, error: "" };
        compIndexRaw = raw;
        compIndexViaMirror = via;
      }
      return;
    }
    if (c && c.data && c.data.components) {
      // 旧格式缓存（0.6.10 之前写的）：没有可复核的正文和签名，只能当没验过的数据用。
      // signed 一律 false——显示、查依赖可以，装不行（compInstall 会拒）；at 置 0，联网后马上换成新格式
      const components = {};
      for (const [id, e] of Object.entries(c.data.components)) components[id] = { ...e, signed: false };
      compIndexCache = { at: 0, data: { components }, error: "" };
      compIndexRaw = null;
      compIndexViaMirror = via;
    }
  } catch {}
}
function compSaveDiskCache() {
  if (!compCacheFile() || !compIndexCache.data) return;
  try {
    fs.mkdirSync(COMP_DIR, { recursive: true });
    fs.writeFileSync(compCacheFile() + ".tmp", JSON.stringify({ at: compIndexCache.at, viaMirror: compIndexViaMirror, sources: compIndexRaw || {} }));
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
  // 共享目录里的索引只在网关启动时带了 CCAPP_COMPONENTS_USE_LOCAL_INDEX=1 才认：/sdcard 别的应用也能写，
  // 放一份 GitHub 上公开的旧索引（签名是真的）就能把组件压回旧构建（审查 10-29 中2）。
  // 以前看私有目录里的 use-local-index 文件，应用身份跑的任何程序（包括模型自己）touch 一下就能换来源；
  // 和 allow-unsigned 一样只认启动环境变量（0.6.9 审计 195-V.2）
  const local = process.env.CCAPP_COMPONENTS_USE_LOCAL_INDEX === "1" && process.env.CCAPP_SHARED && COMP_DIR &&
    path.join(process.env.CCAPP_SHARED, "components", "components.json");
  const sources = [
    { source: "preset", url: local && fs.existsSync(local) ? "file://" + local : COMP_INDEX },
    { source: "community", url: COMP_COMMUNITY_INDEX },
  ];
  const got = await Promise.all(sources.map((s) => compFetchIndex(s.url, s.url.startsWith("file://") ? null : COMP_INDEX_MIRROR[s.source]).then((d) => ({ ...s, d }), (e) => ({ ...s, e }))));
  const components = compMerge(got), errors = [];
  for (const g of got) if (g.e) errors.push(`${g.source}: ${g.e.message}`);
  // 某个来源这次没取到：沿用上次那个来源的条目，免得已装组件的状态跳成"不在索引里"
  const prev = (compIndexCache.data && compIndexCache.data.components) || {};
  for (const g of got) if (g.e) for (const [id, e] of Object.entries(prev)) if (e.source === g.source && !components[id]) components[id] = e;
  const anyOk = got.some((g) => !g.e);
  compIndexCache = anyOk || !compIndexCache.data
    ? { at: errors.length ? Date.now() - 9 * 60e3 : Date.now(), data: { components }, error: errors.join("；") }   // 有失败的一分钟后再试
    : { at: Date.now() - 9 * 60e3, data: compIndexCache.data, error: errors.join("；") };
  if (anyOk) {
    // 缓存里只存这次拿到、能复核的正文与签名；沿用来的旧条目在缓存里没有可信来源，不存
    const raw = {};
    for (const g of got) if (!g.e && g.d._raw) raw[g.source] = { body: g.d._raw, sig: g.d._sig || "" };
    compIndexRaw = raw;
    compSaveDiskCache();
  }
  return compIndexCache;
}

/** 给当前工具包挑一个构建：base 等于已装工具包 gz 的 sha256 */
function compBuildFor(entry, dk) {
  const sha = dk && dk.sha256;
  return (entry.builds || []).find((b) => sha && b.base === sha) || null;
}

// 版本号比较：数字段逐段比，缺的当 0（和 custom.mjs 的 verCmp 同一个口径）
function compVerCmp(a, b) { const x = String(a).split("."), y = String(b).split("."); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (+x[i] || 0) - (+y[i] || 0); if (d) return d; } return 0; }
// 索引里的构建是不是比已装记录旧。只有两边版本都是非空字符串、且索引确实更旧才算——
// 版本缺失（旧索引 / 旧记录）时一律当不旧，宁可照旧显示可更新，也不误拦（0.6.9 审计 195-V.1）
function compOlder(build, rec) {
  return !!(build && rec && typeof build.version === "string" && build.version &&
    typeof rec.version === "string" && rec.version && compVerCmp(build.version, rec.version) < 0);
}

function compState(id, entry, dk) {
  const job = COMP_JOBS.get(id);
  if (job && !job.finished) return job.phase;
  const { rec, bad } = compRecordInfo(id);
  if (!rec) {
    // 记录文件在、但读不出来（坏 JSON / 超上限 / 不是普通文件）：不能当成「没装」，
    // 否则界面显示未装，另一组件卸载时也会当它不存在（0.6.9 审计 195-Z.11）
    if (bad) return "damaged";
    return job && job.error ? "error" : "absent";
  }
  if (rec.state !== "ok") return "damaged";
  if (!dk || rec.base !== dk.sha256) return "outdated";          // 工具包换过：组件的文件已随旧工具包一起没了
  for (const b of rec.bin || []) if (!fs.existsSync(path.join(PREFIX, "bin", b))) return "damaged";
  // 没有命令的组件（库 / 驱动）光看 bin 会漏：记录里的包内 MANIFEST 不在了，就是文件已经被整批删掉
  const man = `libexec/devkit/components/${id}/MANIFEST`;
  if ((rec.files || []).includes(man) && !fs.existsSync(path.join(PREFIX, man))) return "damaged";
  const build = entry && compBuildFor(entry, dk);
  // 索引能是旧的（镜像晚一拍、磁盘缓存用了十分钟）：里面的构建比已装的还旧时不算「可更新」，
  // 否则界面推着用户降级（0.6.9 审计 195-V.1）
  if (build && build.sha256 !== rec.sha256 && !compOlder(build, rec)) return "update";
  return "ok";
}

// 只限某家 GPU 的组件：needs.gpu 写 "adreno"（Turnip 走 /dev/kgsl-3d0）或 "mali"（厂商驱动走 /dev/mali0），
// 别家 SoC 上没有那个节点，装了也用不了
const GPU_NODE = { adreno: "/dev/kgsl-3d0", mali: "/dev/mali0" };
const compUnsupported = (e) => { const g = e && e.needs && e.needs.gpu; return GPU_NODE[g] && !fs.existsSync(GPU_NODE[g]) ? g : ""; };
// 依赖的组件装好了没有（有新版本可更新也算装好）
const compDepOk = (rid, comps, dk) => ["ok", "update"].includes(compState(rid, comps[rid] || null, dk));
const compName = (rid, comps) => (comps[rid] && comps[rid].name) || { zh: rid, en: rid };
/** 这条记录还属于当前工具包吗：base 对不上的记录，文件已随旧工具包没了，
 *  不能再拿它认领文件 / 拦卸载 / 拦安装（0.6.9 审计 195-M.3、05-工具包重装丢组件） */
function compOnDevkit(rec, dk = devkitIdentity()) {
  return !!(rec && dk && rec.base === dk.sha256);
}
/** 已装的组件里，requires 了 id 的那些（卸载 id 会把它们弄坏）。
 *  装在旧工具包上的记录不算：它的文件已经不在，卸 id 不会再弄坏一个本来就要重装的组件 */
function compUsers(id) {
  const out = [], dk = devkitIdentity();
  try {
    for (const f of fs.readdirSync(COMP_DIR)) {
      if (!f.endsWith(".json") || f === id + ".json") continue;
      const r = compRecord(f.slice(0, -5));
      if (compOnDevkit(r, dk) && (r.requires || []).includes(id)) out.push(f.slice(0, -5));
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
  // 签名检查关着就一直挂个警示（审查 10-29 第六份 低5）
  return { supported: true, devkit: dk ? (dk.sha256 || "").slice(0, 12) : null, indexError: ix.error, refreshing: !!ix.refreshing, allowUnsigned: allowUnsigned(), items };
}

// 给了 size 且是小文件就一次读完再算：逐个开流对成千个小文件很慢（gpu-driver-glibc 末尾 5600 多个小文件，
// 平板上流式 7 秒、整读 0.4 秒，慢机上几分钟，进度看着像卡死）。整读会占住事件循环，循环里配合 breathe() 让一让
const SMALL_FILE = 1 << 20;
export function sha256File(f, job, size) {
  if (size !== undefined && size < SMALL_FILE) {
    try {
      if (job && job.cancelled) return Promise.reject(new Error("cancelled"));
      const b = fs.readFileSync(f); if (job) job.done += b.length; return Promise.resolve(crypto.createHash("sha256").update(b).digest("hex"));
    }
    catch (e) { return Promise.reject(e); }
  }
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256"), s = fs.createReadStream(f, { highWaterMark: 1 << 20 });
    // 校验中途点取消：别让整文件读完才停（0.6.9 审计 195-F.5）
    s.on("data", (c) => { h.update(c); if (job) job.done += c.length; if (job && job.cancelled) s.destroy(new Error("cancelled")); });
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

// 组件安装 / 模块下载 / 自检这些 detached 子进程，网关被 SIGKILL 后会继续写 $PREFIX（0.6.9 审计 195-T.4）。
// 起的时候落一份运行标记，正常退出删掉；新网关启动时按标记清掉上一任留下的。
const COMP_RUN_DIR = PREFIX ? path.join(COMP_DIR, ".runs") : "";
/** 落一份运行标记；office 的转换子进程也走这里（0.6.9 审计 195-T.4），别另起一套 */
export function markChild(child, cmd, args) {
  if (!COMP_RUN_DIR || !child.pid) return "";
  try {
    fs.mkdirSync(COMP_RUN_DIR, { recursive: true });
    const f = path.join(COMP_RUN_DIR, `${child.pid}-${crypto.randomBytes(4).toString("hex")}.json`);
    fs.writeFileSync(f, JSON.stringify({ pid: child.pid, gw: process.pid, cmd, args: args.map(String).join(" ").slice(0, 4000), at: Date.now() }), { mode: 0o600 });
    return f;
  } catch { return ""; }
}
export const unmarkChild = (f) => { if (f) try { fs.rmSync(f, { force: true }); } catch {} };
/** 清掉上一任网关留下的组件子进程；只在启动时调用（正常运行时标记随子进程退出删除） */
export function reapComponentRuns() {
  if (!COMP_RUN_DIR) return 0;
  let files = []; try { files = fs.readdirSync(COMP_RUN_DIR); } catch { return 0; }
  let n = 0;
  for (const f of files) {
    const p = path.join(COMP_RUN_DIR, f);
    let j = null; try { j = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
    // 标记的网关还活着（双网关重叠启动）：那是人家的子进程，别抢着杀
    if (j && Number.isInteger(j.gw) && j.gw !== process.pid) { try { process.kill(j.gw, 0); continue; } catch {} }
    let alive = false;
    if (j && Number.isInteger(j.pid) && j.pid > 0) { try { process.kill(j.pid, 0); alive = true; } catch {} }
    let mine = false;
    if (alive) { try { mine = fs.readFileSync(`/proc/${j.pid}/cmdline`, "utf8").includes(String(j.cmd || "").split("/").pop()); } catch {} }
    if (alive && mine) { try { killTree({ pid: j.pid }); n++; } catch {} }
    try { fs.rmSync(p, { force: true }); } catch {}
  }
  if (n) log(`[comp] 清掉上一任网关留下的 ${n} 个组件子进程`);
  return n;
}
if (PREFIX && LIVE) reapComponentRuns();

export function compRun(job, cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: termEnv(), stdio: ["ignore", "pipe", "pipe"], detached: true, ...opts });
    job.child = child;
    const mark = markChild(child, cmd, args);
    let err = "";
    child.stdout.on("data", () => {});
    child.stderr.on("data", (d) => { err = (err + d).slice(-2000); });
    child.on("error", (e) => { job.child = null; unmarkChild(mark); reject(e); });
    child.on("exit", (code) => { job.child = null; unmarkChild(mark); job.cancelled ? reject(new Error("cancelled")) : code === 0 ? resolve() : reject(new Error(tz("{cmd} 退出码 {code}：{err}", { cmd: path.basename(cmd), code, err: `${err.trim().split("\n").filter((l) => l.trim() && !/Exiting with failure status|Error is not recoverable/.test(l)).slice(-3).join(" · ") || err.trim().split("\n").pop() || ""}` }))); });
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

// ── 悬空的文档软链（196-真机.3）──
// Termux 的包把 share/doc/<包>/copyright 做成指向 ../../LICENSES/<协议>.txt 的软链，LICENSES 又不在包里：
// 装进 $PREFIX 就是一堆断链（真机上 86 个），界面和对账都当异常。只碰 share/doc/ 下的软链，普通文件不碰。
const DOC_PREFIX = "share/doc/";
/** 这条相对路径是不是「share/doc/ 下、目标已经断了的软链」 */
function docLinkDangling(rel) {
  if (typeof rel !== "string" || !rel.startsWith(DOC_PREFIX)) return false;
  const abs = path.join(PREFIX, rel);
  try { if (!fs.lstatSync(abs).isSymbolicLink()) return false; } catch { return false; }
  try { fs.statSync(abs); return false; }
  catch (e) { return e.code === "ENOENT" || e.code === "ENOTDIR"; }
}
/** 安装收尾：本组件放进来的文档软链，目标不在（包里没带 LICENSES 之类）就删掉、不记进清单。
 *  返回删掉的条数；rec.files 同步改，最后那条 ok 记录里就不会再有它们。 */
function compDropDanglingDocs(rec) {
  const keep = [];
  let n = 0;
  for (const r of rec.files || []) {
    if (!docLinkDangling(r)) { keep.push(r); continue; }
    try { fs.rmSync(path.join(PREFIX, r), { force: true }); n++; } catch { keep.push(r); }
  }
  if (n) { rec.files = keep; log(`[comp] ${rec.id}：${n} 个文档软链是断的（目标不在包里），没留`); }
  return n;
}
/** 卸载 / 升级后扫一遍 share/doc/，把已经断掉的软链清掉（目标可能刚被这次卸载删了，或是旧工具包留下的）。
 *  只删软链本身；返回清掉的条数。 */
function compSweepDanglingDocs() {
  const root = path.join(PREFIX, "share/doc");
  try { if (!fs.lstatSync(root).isDirectory()) return 0; } catch { return 0; }
  let n = 0;
  const walk = (rel) => {
    let list; try { list = fs.readdirSync(path.join(PREFIX, rel), { withFileTypes: true }); } catch { return; }
    for (const d of list) {
      const r = rel + "/" + d.name;
      if (d.isDirectory()) { walk(r); continue; }
      if (!d.isSymbolicLink()) continue;
      try { fs.statSync(path.join(PREFIX, r)); }
      catch (e) {
        if (e.code !== "ENOENT" && e.code !== "ENOTDIR") continue;
        try { fs.rmSync(path.join(PREFIX, r), { force: true }); n++; } catch {}
      }
    }
  };
  walk("share/doc");
  if (n) log(`[comp] 清掉 ${n} 个悬空的文档软链`);
  return n;
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
    // 只管 bin/：carryOver 只搬过 bin/ 这类目录；share/ 下的目录索引、缓存（gschemas.compiled 等）本来就不在清单里，不能动。
    // 另加组件自己的命名空间 lib/<id>/、share/<id>/：手工装过、旧版残留的同名入口没人认领，
    // 留着就成了「新包旧入口」，装完显示成功却用不了（#66 第 1 项）
    const own = selfId && (r.startsWith("lib/" + selfId + "/") || r.startsWith("share/" + selfId + "/"));
    if (!(r.startsWith("bin/") || own) || owned.has(r)) continue;
    try { const st = fs.lstatSync(path.join(PREFIX, r)); if (st.isFile() || (own && st.isSymbolicLink())) out.add(r); } catch {}
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
/** 正在装（还没结束）的组件和它们要的底座包 */
export function compJobsDeps() { return [...COMP_JOBS].filter(([, j]) => !j.finished && j.baseDeps).map(([id, j]) => ({ id, baseDeps: j.baseDeps })); }
export function compRecords() {
  const out = new Map(), dk = devkitIdentity();
  try {
    for (const f of fs.readdirSync(COMP_DIR)) if (f.endsWith(".json")) {
      const id = f.slice(0, -5), r = compRecord(id);
      // installing 也算：记录已经写下了它要用的文件，别的组件/模块卸载时不能当它不存在（0.6.9 审计 #185）
      if (r && (r.state === "ok" || r.state === "installing") && dk && r.base === dk.sha256) out.set(id, r);
      else if (!r) {
        // 记录读不出：按包内 MANIFEST 保守认领（0.6.9 审计 195-Z.11），宁可不删
        try { if (fs.existsSync(path.join(PREFIX, "libexec/devkit/components", id, "MANIFEST"))) out.set(id, { files: [], shared: [] }); } catch {}
      }
    }
  } catch {}
  return out;
}
/** 组件依赖链里由底座提供的包。先看安装记录（装的时候记下的，#104 05-001），旧记录没有就查索引里这个构建的 baseDeps ——
 *  内存里还没有索引（刚启动、离线）先读磁盘缓存；都查不到为 null（不知道） */
export function compBaseDeps(id, sha, rec) {
  if (rec && Array.isArray(rec.baseDeps)) return rec.baseDeps.filter((d) => typeof d === "string");
  compLoadDiskCache();
  const e = compIndexCache.data && compIndexCache.data.components && compIndexCache.data.components[id];
  const b = e && (e.builds || []).find((x) => x.sha256 === sha);
  return b && Array.isArray(b.baseDeps) ? b.baseDeps.map((d) => (typeof d === "string" ? d : d.name)) : null;
}

/** 删掉一个组件放进去的文件。两个组件带了同一个依赖包（浏览器和 GPU 驱动都带 mesa）时，
 *  后装的那个跳过了已存在的文件、记录里没有它们 —— 所以删之前先看别的组件要不要用：要用的留下、记到它名下，
 *  不然卸一个，另一个就悄悄坏了。keep 里的路径不删：升级时新版里还有的同名文件（已经换成新内容） */
function compRemoveFiles(id, rec, keep = null) {
  // 记录文件同 uid 可改：卸载/升级只认普通相对路径，别让 ../ 把前缀外的文件删了
  const safeRel = (r) => typeof r === "string" && r && !r.startsWith("/") && !r.split("/").includes("..");
  const files = (rec.files || []).filter(safeRel);
  const others = [];
  for (const [oid, orec] of compRecords()) if (oid !== id) others.push({ id: oid, rec: orec, needs: compNeeds(oid, orec), gained: [] });
  // 工具包升级后新底座 / 模块可能接管了同名路径，旧记录还写着它：底座认领的一律不删（审查 B23）。
  // 记录装在旧工具包上时（base 明确对不上），它列的 .list 已经不是它的了（同名路径现在是新底座的），
  // 不能再当 skip 传进去；base 缺失的老记录照旧当自己的，免得升级 / 卸载留下包文件
  const dk = devkitIdentity();
  const ownLists = rec && (!rec.base || (dk && rec.base === dk.sha256));
  const base = baseOwnedPaths(ownLists ? new Set(files) : new Set());
  let baseKept = 0;
  const dirs = new Set();
  // Python 运行时在旁边的 __pycache__ 里生成 .pyc（不在组件清单里）：删 .py 时一并删掉，不然卸载后留下几十 MB
  const pyc = new Map();
  const pycOf = (d) => { if (!pyc.has(d)) { let l = []; try { l = fs.readdirSync(path.join(PREFIX, d)); } catch {} pyc.set(d, l); } return pyc.get(d); };
  for (const r of files) {
    const keeper = others.find((o) => o.needs.has(r));
    if (keeper) { keeper.gained.push(r); continue; }
    if (keep && keep.has(r)) continue;    // 新版里还有这个路径：已经换成新内容，别删
    if (base.has(r)) { baseKept++; continue; }
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
    // 写不进去就如实记日志：文件留在原处不删（安全方向），只是没归到 o 名下，以后卸 o 会剩下
    if (compWriteRecord(o.id, o.rec)) log(`[comp] ${id}：${o.gained.length} 个文件 ${o.id} 也要用，留下归它`);
    else log(`[comp] ⚠️ ${id}：${o.gained.length} 个文件 ${o.id} 也要用，但 ${o.id} 的记录写不进去，没归到它名下`);
  }
  if (baseKept) log(`[comp] ${id}：${baseKept} 个文件现在归工具包，留下`);
  // 由深到浅删掉变空的目录（工具包自己的目录不空，自然删不掉）
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) { try { fs.rmdirSync(path.join(PREFIX, d)); } catch {} }
  const sk = rec.skill && skillDst(rec.skill);
  // 标记写着别的组件（那边接管了同名目录）就不删；没有标记的是旧版装的，照旧删
  let owner = sk ? (readSmall(path.join(sk, SKILL_OWNER), 512) || "").trim() : "";
  if (sk && (!owner || owner === id)) { const ucb = ucAppBegin(); fs.rmSync(sk, { recursive: true, force: true }); ucAppWrote([sk], ucb); }
  // 这次删掉的文件可能让别的文档软链变得悬空；旧工具包留下的断链也顺手清掉（196-真机.3）
  compSweepDanglingDocs();
}

async function compInstall(id) { const x = await compStart(id); return x.job ? x.r : x; }
/** 核对记录的「修补」（reconcile.mjs）：同版本原地重装；done 在任务结束时给出错误信息（成功是 ""），只给网关内部等 */
export async function compRepair(id) {
  const x = await compStart(id);
  return x.job ? { ...x.r, done: x.job.done.then(() => x.job.error || (x.job.cancelled ? tz("已取消") : "")) } : { ...x, done: Promise.resolve("") };
}
/** 起安装任务：起了返回 { r, job }，没起返回给界面的结果 */
async function compStart(id) {
  if (!PREFIX) return { ok: false, message: "only available in cccodroid" };
  const cur = COMP_JOBS.get(id);
  if (cur && !cur.finished) return { ok: false, message: "busy" };
  const dk = devkitIdentity();
  if (!dk || !dk.sha256) return { ok: false, message: tz("工具包还没装好（或是本地文件装的，没有版本身份），装不了组件") };
  const ix = await compIndex(true);
  // 拉索引期间可能已有配置、取清单或卸载占槽；不能覆盖它们的 job。
  const pending = COMP_JOBS.get(id);
  if (pending && !pending.finished) return { ok: false, message: "busy" };
  const entry = ix.data && ix.data.components && ix.data.components[id];
  if (!entry) return { ok: false, message: ix.error || tz("没有这个组件") };
  // 旧格式磁盘缓存里的条目没复核过签名（signed:false），拿它查到的东西不能直接执行：
  // 同 uid 改缓存正如以前能绕过整条验签链（195-V.3）。只拦安装/更新，列表和依赖查询照常
  if (!entry.signed && !allowUnsigned()) return { ok: false, message: tz("索引没有通过验签，不能安装组件") };
  const un = compUnsupported(entry);
  if (un) return { ok: false, message: un === "mali" ? tz("这个组件只能用在 ARM Mali GPU（天玑、Exynos 等）的设备上，本机用不了") : tz("这个组件只能用在高通骁龙（Adreno GPU）的设备上，本机用不了") };
  const miss = (entry.requires || []).filter((rid) => !compDepOk(rid, ix.data.components, dk));
  if (miss.length) return { ok: false, message: tz("要先装：{names}", { names: miss.map((rid) => compName(rid, ix.data.components).zh || rid).join("、") }) };
  const b0 = compBuildFor(entry, dk), b = b0 && { ...b0, source: entry.source, requires: entry.requires || [], mcp: compMcpSpec(entry) };
  if (!b) return { ok: false, message: tz("这个组件还没有对应当前工具包的版本，先更新工具包或稍后再试") };
  // 防回滚：已装好且索引里的构建版本更旧，不装。过期索引（镜像晚一拍、缓存十分钟）里常有上一版，
  // 用户点一下「更新」反而把新版换掉；损坏/装到一半的记录不拦，那是修复（0.6.9 审计 195-V.1）。
  // 只比同一个工具包上的记录：换过工具包后旧记录（outdated）不能拿旧版本号拦住新工具包的构建 ——
  // 旧构建已经装不回来了，这不是降级（05-工具包重装丢组件）
  {
    const oldRec = compRecordInfo(id).rec;
    if (oldRec && oldRec.state === "ok" && compOnDevkit(oldRec, dk) && compOlder(b, oldRec))
      return { ok: false, message: tz("索引里的版本（{v}）比已装的（{now}）旧，已拒绝降级", { v: b.version, now: oldRec.version }) };
  }
  // 模块化工具包：组件依赖的底座包所在的模块得先装上
  const needMods = modulesMissingFor(b.baseDeps);
  if (needMods.length) return { ok: false, needModules: needMods.map((m) => m.id), message: tz("要先装工具包模块：{names}（扩展页上方「工具包模块」）", { names: needMods.map((m) => m.name.zh || m.id).join("、") }) };
  // 空间：压缩包 + 解开后的大小，再留 10%。上次失败特意留下的压缩包（大小对得上）已经占着空间了，
  // 不再重复索要；上次失败留下的解包树先清掉（0.6.9 审计 #186 / 195-I.2）
  const stageRoot = path.join(COMP_DIR, ".staging"), stageTree = path.join(stageRoot, id), stageGz = path.join(stageRoot, `${id}-${b.sha256.slice(0, 12)}.tar.gz`);
  try { fs.rmSync(stageTree, { recursive: true, force: true }); } catch {}
  let reuse = 0; try { if (fs.statSync(stageGz).size === b.bytes) reuse = b.bytes; } catch {}
  try {
    const sf = fs.statfsSync(path.dirname(PREFIX));
    const need = (b.bytes - reuse + b.installed) * 1.1;
    if (sf.bavail * sf.bsize < need) return { ok: false, message: tz("存储空间不够：需要约 {n} MB", { n: Math.ceil(need / 1048576) }) };
  } catch {}
  // baseDeps 记在 job 上：下载、校验那几分钟里卸工具包模块，要知道这个在装的组件也在用（#134，见 modules.mjs modDependents）
  const job = { phase: "downloading", done: 0, total: b.bytes, error: "", child: null, cancelled: false, finished: false,
    baseDeps: (Array.isArray(b.baseDeps) ? b.baseDeps : []).map((d) => (typeof d === "string" ? d : d && d.name)).filter(Boolean) };
  COMP_JOBS.set(id, job);
  job.done = compRunInstall(id, b, job).then(
    () => { job.finished = true; log(`[comp] ${id} ${b.version} 装好了`); },
    (e) => {
      // 取消、校验失败都走这里：解包树（chromium 约 1GB）只在成功路径里清，失败就留在私有目录、没有入口再删（审查 11-05）。
      // compRunInstall 已经结束（tar 子进程已退出），这时删不会边解边删；压缩包留着，重试不用重下。下次安装开头本来也会先删这棵树
      if (/^[a-z0-9][a-z0-9-]*$/.test(id)) try { fs.rmSync(path.join(COMP_DIR, ".staging", id), { recursive: true, force: true }); } catch {}
      job.finished = true; job.error = job.cancelled ? "" : e.message; log(`[comp] ${id} 安装失败：${e.message}`);
    });
  return { r: { ok: true }, job };
}

/** MCP 组件（索引里带 mcp: { name, bin }）：装好后替用户用 claude mcp add 注册成用户级 MCP，卸载时拿掉。
 *  名字、命令都过白名单；命令只能是本组件放进 $PREFIX/bin 的程序（安装时再按记录核一遍），不收参数和环境变量 */
function compMcpSpec(entry) {
  const m = entry && entry.mcp;
  if (!m || typeof m !== "object") return null;
  const name = String(m.name || ""), bin = String(m.bin || "");
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(name) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(bin)) return null;
  return { name, bin };
}
async function compRegisterMcp(id, b, rec) {
  const m = b.mcp;
  if (!m || !(rec.files || []).includes("bin/" + m.bin)) return;
  const r = await addMcp({ name: m.name, transport: "stdio", target: path.join(PREFIX, "bin", m.bin) });
  if (!r.ok) { log(`[comp] ${id} 注册 MCP ${m.name} 失败：${r.message || "?"}`); return; }
  rec.mcp = m.name;
  if (!compWriteRecord(id, rec)) log(`[comp] ${id} 注册了 MCP ${m.name}，但安装记录没写进去`);
  else log(`[comp] ${id} 已注册 MCP ${m.name}`);
}

/** 把组件带的 skill 目录拷进 ~/.claude/skills。skill 路径相对 files/（以 usr/ 开头），PREFIX 已经是 files/usr */
// 技能目录名来自组件包里 SKILL.md 的 name：先过和手动导入一样的白名单，再确认拼出来的路径就在技能目录下一层，
// 不然 ".."、带斜杠的名字能把下面的 rmSync 引到技能目录外面去（审查 v0.5.7 M1：索引签名之外再加一道）
export const skillDst = (name) => {
  if (typeof name !== "string" || !SKILL_NAME_RE.test(name)) return null;
  const dst = path.join(SKILLS_DIR, name);
  return path.dirname(dst) === path.resolve(SKILLS_DIR) ? dst : null;
};
const SKILL_OWNER = ".cccodroid-component";
const SKILL_NAME_RE = /^(?!\.+$)[A-Za-z0-9._-]{1,64}$/;
function compInstallSkill(id, rel, rec) {
  const src = path.join(PREFIX, rel.replace(/^usr\//, ""));
  const name = (skillMeta(src) || {}).name || id;
  const dst = skillDst(name);
  if (!dst) { log(`[comp] ${id} 技能名不合法，没装：${String(name).slice(0, 80)}`); return; }
  // 同名目录已经在：用户自己的、手动导入的、别的组件的 —— 不是本组件的就不碰（#104 05-010）。
  // 本组件上一版的技能在升级/重装时已由 compRemoveFiles 按 rec.skill 删掉；空目录（v0.1.9 留下的）照旧删。
  // 目录里的 .cccodroid-component 记着是哪个组件放的：装到一半被杀、记录还没写上 skill 的，重装时认得出是自己的
  const ucb = ucAppBegin();
  try { fs.rmdirSync(dst); } catch {}
  let owner = (readSmall(path.join(dst, SKILL_OWNER), 512) || "").trim();
  if (owner === id) fs.rmSync(dst, { recursive: true, force: true });
  if (fs.existsSync(dst)) { log(`[comp] ${id} 的技能 ${name} 跟已有技能同名，没装（保留原来的）`); return; }
  try {
    fs.mkdirSync(dst, { recursive: true });
    fs.writeFileSync(path.join(dst, SKILL_OWNER), id + "\n");
    for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(dst, f));
    rec.skill = name;
    ucAppWrote([dst], ucb);    // 组件带的技能是应用装的：认下（见 userconf.mjs）
  } catch (e) { log(`[comp] ${id} 技能没装上：${e.message}`); }
}
// v0.1.9 拼错了 skill 路径（多了一层 usr/），装好的组件没有 skill：发现就补上
export function compHealSkills() {
  let fs_; try { fs_ = fs.readdirSync(COMP_DIR); } catch { return; }
  for (const f of fs_) {
    if (!f.endsWith(".json")) continue;
    const id = f.slice(0, -5), rec = compRecord(id);
    if (!rec || rec.state !== "ok" || rec.skill || (COMP_JOBS.get(id) && !COMP_JOBS.get(id).finished)) continue;
    const rel = `usr/share/cccodroid/components/${id}/skill`;
    if (!fs.existsSync(path.join(PREFIX, rel.slice(4), "SKILL.md"))) continue;
    try { fs.rmdirSync(path.join(SKILLS_DIR, id)); } catch {}     // 当时留下的空目录（只删空的）
    // 这段跑在启动定时器里（网关没装 uncaughtException 兜底）：哪一步抛了都只跳过这一个组件
    try {
      const want = skillDst((skillMeta(path.join(PREFIX, rel.slice(4))) || {}).name || id);
      if (!want) continue;                                            // 技能名不合法：安装时已记过日志
      let owner = (readSmall(path.join(want, SKILL_OWNER), 512) || "").trim();
      if (fs.existsSync(want) && owner !== id && (!fs.statSync(want).isDirectory() || fs.readdirSync(want).length)) continue;   // 同名已有别人的技能（或同名文件）：不补，也别每次刷列表都记一条日志
      compInstallSkill(id, rel, rec);
      if (rec.skill) {
        // 记录没写进去不算白干：下次启动还会再补一遍（技能目录有归属标记，会认出来重装）
        if (compWriteRecord(id, rec)) log(`[comp] ${id} 补装技能 ${rec.skill}`);
        else log(`[comp] ${id} 补装技能 ${rec.skill}，但安装记录写不进去，下次启动再补`);
      }
    } catch (e) { log(`[comp] ${id} 补装技能出错：${e.message}`); }
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
  // 解包阶段没有可靠的字节进度：别画一个永远 0% 的条（0.6.9 审计 195-I.8），解完按清单重新给总量
  job.phase = "verifying"; job.done = 0; job.total = 0;
  fs.rmSync(tree, { recursive: true, force: true });
  fs.mkdirSync(tree, { recursive: true });
  // 解包失败就把压缩包也删了：下次重试从头下载，不再拿同一份去撞
  // 解之前按目录查：MANIFEST 在包里、解完才核，经包内软链写到暂存区外面的条目那时已经落地了（v0514 审查低-2）
  try {
    const list = await new Promise((ok, no) => execFile(path.join(PREFIX, "bin", "tar"), ["-tzv", "--quoting-style=c", "-f", gz],
      { maxBuffer: 256 << 20 }, (e, out) => e ? no(e) : ok(String(out))));
    const bad = archiveProblem(parseTarListing(list));
    if (bad) throw new Error(tz("这个压缩包里有条目会写到包外面（{p}），为安全起见不解开", { p: String(bad.name).slice(0, 200) }));
    await compRun(job, path.join(PREFIX, "bin", "tar"), ["-xzf", gz, "-C", tree]);
  }
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
  // 下载、校验跨了很久：依赖的工具包模块这期间可能被卸了，搬进去之前再核一次（#134）
  // 剩下的窗口只有「核完到搬完」这几毫秒：模块和组件两个管理器之间没有锁，真要严丝合缝得加一把（DeepSeek 复核 11-04）
  const goneMods = modulesMissingFor(b.baseDeps);
  if (goneMods.length) throw new Error(tz("要先装工具包模块：{names}（扩展页上方「工具包模块」）", { names: goneMods.map((m) => m.name.zh || m.id).join("、") }));
  // 同一段时间里依赖的组件也可能被卸了：按当前状态再核一遍（0.6.9 审计 195-I.6）
  const compsNow = (compIndexCache.data && compIndexCache.data.components) || {};
  const dkNow = devkitIdentity();
  const goneReq = (b.requires || []).filter((rid) => !compDepOk(rid, compsNow, dkNow));
  if (goneReq.length) throw new Error(tz("要先装：{names}", { names: goneReq.map((rid) => compName(rid, compsNow).zh || rid).join("、") }));
  // 3) 切换：先写"安装中"的记录（被打断就是 damaged，可以重装或卸载），再逐个搬进 $PREFIX。
  // 升级时旧版同路径文件先备份、新版全部就位后才删旧版不要的，中途失败原样放回（197-9.6 F8）。
  // 这一段和别的组件「按记录删文件 / 搬文件 / 写记录」互斥（196-供应链.1）；解包、首启仍在锁外，
  // 排队的安装可以照常取消（这时 phase 还是 verifying，compCancel 放行）
  const rec = await compFsExclusive(() => {
    if (job.cancelled) throw new Error("cancelled");
    job.phase = "installing";
    return compSwitch(id, b, tree);
  });
  // 4) 首次运行配置（各包 postinst），失败不算安装失败
  const fr = path.join(PREFIX, lx, "first-run.sh");
  if (fs.existsSync(fr)) { try { await compRun(job, path.join(PREFIX, "bin", "sh"), [fr]); } catch (e) { log(`[comp] ${id} first-run：${e.message}`); } }
  // 首启脚本在锁外跑（可能几分钟）；收尾这步重新进锁：技能目录、共享文件复核、ok 记录
  // 和别的组件卸载时的删文件不能交错（196-供应链.1）
  await compFsExclusive(() => {
    // 5) 给 Claude 的技能
    if (b.skill) compInstallSkill(id, b.skill, rec);
    // 首次配置这段时间里，另一个卸载 / pkg 卸载可能把本组件依赖的共享文件删掉了：
    // 提交 ok 之前再核一次，别报「装好了」却缺依赖（0.6.9 审计 #185）
    const goneShared = (rec.shared || []).filter((r) => typeof r === "string" && !fs.existsSync(path.join(PREFIX, r)));
    if (goneShared.length) throw new Error(tz("安装期间有 {n} 个共享文件被卸载删掉了，请重新安装", { n: goneShared.length }));
    rec.state = "ok"; rec.at = Date.now();
    // 最后一次写盘失败要如实报：磁盘上还是 installing，界面按 damaged 显示，可以重装或卸掉重来
    if (!compWriteRecord(id, rec)) throw new Error(tz("文件已放进去了，但安装记录没写成（存储满了或没有权限），请重装或卸载"));
    fs.rmSync(tree, { recursive: true, force: true });
    fs.rmSync(gz, { force: true });
  });
  // 6) MCP 组件：注册成用户级 MCP（走 claude mcp add，和扩展页手动添加同一条路）。失败不算安装失败，扩展页还能手动加
  if (b.mcp) await compRegisterMcp(id, b, rec);
}

/** 安装切换（在 compFsExclusive 里跑）：把暂存树 tree/usr 里的新版放进 $PREFIX。
 *  升级 / 重装时旧版同路径文件先挪进 <tree>.old 备份（别的组件也要用、底座认领的不动），
 *  新版全部就位（提交点）后才删旧版里新版不要的文件；搬运中途失败把备份原样放回、记录退回旧版（197-9.6 F8）。
 *  返回写好的 installing 记录；首启、技能、写 ok 在锁外另一段里做 */
function compSwitch(id, b, tree) {
  // 记录文件同 uid 可改：只认普通相对路径（和 compRemoveFiles 同口径）
  const safeRel = (r) => typeof r === "string" && r && !r.startsWith("/") && !r.split("/").includes("..");
  const old = compRecord(id);
  const oldFiles = new Set(((old && old.files) || []).filter(safeRel));
  const rec = { id, source: b.source || "", version: b.version, upstream: b.upstream, base: b.base, sha256: b.sha256, bin: b.bin || [],
    requires: b.requires || [], skill: "", state: "installing", at: Date.now(), files: [], shared: [],
    // 依赖的底座包：卸工具包模块时据此判断有没有组件在用。不记的话要靠索引，刚启动 / 离线 / 索引里这个构建没了就判断不了（#104 05-001）
    ...(Array.isArray(b.baseDeps) ? { baseDeps: b.baseDeps.map((d) => (typeof d === "string" ? d : d && d.name)).filter(Boolean) } : {}) };
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
  // 升级时旧版本自己的文件还在：没人跟它抢的换成新版（先备份）；别的组件也要用、底座认领的留在原地当 shared
  const othersNeed = new Set();
  for (const [oid, orec] of compRecords()) if (oid !== id) for (const r of compNeeds(oid, orec)) othersNeed.add(r);
  const baseNow = baseOwnedPaths(new Set(list));
  const replaceable = new Set();
  for (const r of list) {
    let st = null; try { st = fs.lstatSync(path.join(PREFIX, r)); } catch {}
    if (st && (st.isFile() || st.isSymbolicLink()) && (orphans.has(r) || (oldFiles.has(r) && !othersNeed.has(r) && !baseNow.has(r))))
      replaceable.add(r);
    (st && !replaceable.has(r) ? rec.shared : rec.files).push(r);
  }
  // 记录写不进去就不能往下搬：文件搬进 $PREFIX 却没有清单，以后既卸不干净也认领不了（195-Z.10）
  if (!compWriteRecord(id, rec)) throw new Error(tz("安装记录写不进去（存储满了或没有权限），这次安装没有继续"));
  // 旧版同路径文件先挪进备份：新版没全部就位前，$PREFIX 里的旧版文件一个都不删
  const bak = path.join(path.dirname(tree), id + ".old");
  fs.rmSync(bak, { recursive: true, force: true });
  const backed = [], moved = [];
  try {
    for (const r of replaceable) {
      const to = path.join(bak, r);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(path.join(PREFIX, r), to);
      backed.push(r);
    }
    const { skipped } = compMoveIn(path.join(tree, "usr"), "", moved, [], orphans);
    if (skipped.length) log(`[comp] ${id}：${skipped.length} 个文件已经在了（工具包或别的组件放的），保留原样`);
  } catch (e) {
    // 回滚：备份原样放回、撤掉这次新放进去的文件、记录退回旧版
    let restored = true;
    for (const r of backed.reverse()) {
      try { fs.mkdirSync(path.dirname(path.join(PREFIX, r)), { recursive: true }); fs.renameSync(path.join(bak, r), path.join(PREFIX, r)); } catch { restored = false; }
    }
    for (const r of moved) if (!replaceable.has(r)) { try { fs.unlinkSync(path.join(PREFIX, r)); } catch {} }
    // 还有没放回去的备份就先留着，别把旧版文件最后一份也删了
    if (restored) try { fs.rmSync(bak, { recursive: true, force: true }); } catch {}
    else log(`[comp] ${id}：回滚时有备份没放回去，先留在 ${bak}`);
    if (old && !compWriteRecord(id, old)) log(`[comp] ${id}：回滚后旧记录没写回去，界面会显示装到一半`);
    throw e;
  }
  try { fs.rmSync(bak, { recursive: true, force: true }); } catch {}
  // 新版全部就位（提交点）：这时才删旧版里新版不要的文件，别的组件也要用的转记到它们名下，旧技能清掉
  if (old) compRemoveFiles(id, old, new Set(list));
  // 搬完再查（顺序不定，搬的时候目标可能还没就位）：目标仍然断掉的文档软链不留下（196-真机.3）
  compDropDanglingDocs(rec);
  return rec;
}

function compCancel(id) {
  const job = COMP_JOBS.get(id);
  if (!job || job.finished) return { ok: false, message: "not running" };
  if (job.phase === "installing") return { ok: false, message: tz("正在放进工具包，这一步不能中断") };
  if (job.phase === "removing") return { ok: false, message: tz("正在卸载，这一步不能取消，请等待完成") };
  if (["configuring", "fetching-models"].includes(job.phase)) return { ok: false, message: "busy" };
  job.cancelled = true;
  if (job.child) killTree(job.child);
  return { ok: true };
}

function compRemovalRecord(id) {
  let st;
  try { st = fs.lstatSync(compRecFile(id)); }
  catch (e) { if (e.code === "ENOENT") return { exists: false, rec: null }; throw e; }
  // 坏记录只能清自己的元数据；不能凭 id 猜文件，也不能跟着记录软链去信任另一份清单。
  const rec = st.isFile() && !st.isSymbolicLink() ? compRecord(id) : null;
  const safeRel = (r) => typeof r === "string" && r.length > 0 && !r.includes("\0") && !r.includes("\\") &&
    !path.isAbsolute(r) && r.split("/").every((p) => p && p !== "." && p !== "..");
  const valid = rec && typeof rec === "object" && !Array.isArray(rec) && rec.id === id &&
    Array.isArray(rec.files) && rec.files.every(safeRel) && (!rec.skill || !!skillDst(rec.skill));
  return { exists: true, rec: valid ? rec : null };
}

export async function compRemove(id) {
  if (!PREFIX) return { ok: false, message: "only available in cccodroid" };
  if (typeof id !== "string" || !/^[a-z0-9-]{1,40}$/.test(id)) return { ok: false, message: "bad id" };
  const job = COMP_JOBS.get(id);
  if (job && !job.finished) return { ok: false, message: "busy" };
  const users = compUsers(id);
  if (users.length) {
    const comps = (compIndexCache.data && compIndexCache.data.components) || {};
    return { ok: false, message: tz("{names} 要用它，先卸载那些组件", { names: users.map((rid) => compName(rid, comps).zh || rid).join("、") }) };
  }
  // 停用服务需要等待子进程，期间仍占住组件槽，避免重装和第二次卸载交错。
  const removal = { phase: "removing", finished: false };
  COMP_JOBS.set(id, removal);
  let stage = "retire-managed-bridge";
  try {
    // 退役桥 / 清映射要等子进程；这期间别的组件可能刚把共享文件转记到这个组件名下。
    // 所以记录等退役完、进锁之后再读，不拿退役前的旧快照删文件（196-供应链.1）
    const retired = await retireManagedBridge(id);
    stage = "clear-app-mapping";
    const unmapped = clearBridgeConfigMapping(id);
    let mcpName = "";
    const out = await compFsExclusive(() => {
      stage = "read-record";
      const { exists, rec } = compRemovalRecord(id);
      mcpName = rec && typeof rec.mcp === "string" && /^[a-z0-9][a-z0-9-]{0,39}$/.test(rec.mcp) ? rec.mcp : "";
      if (!exists && !retired && !unmapped) return { ok: false, message: "not installed" };
      stage = "remove-files";
      // installing / damaged 的完整记录仍有原受管文件清单，照既有管理器处理共享文件和技能。
      if (rec) compRemoveFiles(id, rec);
      else log(`[comp] ${id} 卸载恢复：安装记录缺失或损坏，未删除工具包内文件和技能`);
      stage = "remove-record";
      fs.rmSync(compRecFile(id), { force: true });
      stage = "clear-stage";
      compClearStage(id);
      log(`[comp] ${id} 已卸载（${rec ? rec.files.length : 0} 个文件）`);
      return { ok: true };
    });
    // 装的时候替用户注册的 MCP 一并拿掉（程序已经删了，留着只会每轮连不上）
    if (out.ok && mcpName) {
      const r = await removeMcp(mcpName);
      log(r.ok ? `[comp] ${id} 已移除 MCP ${mcpName}` : `[comp] ${id} 移除 MCP ${mcpName} 失败：${r.message || "?"}`);
    }
    return out;
  } catch (e) {
    if (stage === "retire-managed-bridge" && ["retire-lock", "retire-spawn", "retire-exit", "retire-timeout"].includes(e.stage)) stage = e.stage;
    log(`[comp] ${id} 卸载失败（stage=${stage}）`);
    return { ok: false, message: e.message, stage };
  } finally { if (COMP_JOBS.get(id) === removal) COMP_JOBS.delete(id); }
}

// ── 组件的运行数据：约定放在 ~/.cccodroid/<id>/（blender 的 Debian 环境、下载缓存等），卸载组件不碰它。
// 卸载后报出大小、问用户要不要一起删。目录名不一定等于 id（gpu-driver-glibc 用 gpu-driver 的目录），
// 所以只认和 id 同名的目录，还装着 <id>-xxx 组件时当作共用、不提议删
function compDataDir(id) { return path.join(CFG.home, ".cccodroid", id); }
// ~/.cccodroid 下别的子系统的目录：不是组件的运行数据，永远不许按「组件」删（11-03 审查 M-8）
const COMP_DATA_RESERVED = new Set(["custom", "bin", "services", "agents", "local-mode", "cache", "tmp", "logs"]);
/** 只有组件索引里有的 id 才算组件：清理接口只按 id 删目录，别让它删到不相干的东西 */
function compDataKnown(id) {
  if (COMP_DATA_RESERVED.has(id)) return false;
  compLoadDiskCache();
  return !!(compIndexCache.data && compIndexCache.data.components && Object.prototype.hasOwnProperty.call(compIndexCache.data.components, id));
}
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
  // 记录坏了也当还装着：不能按「没装」把它的运行数据删了（195-Z.11）
  if (!compRecordInfo(id).missing || compDataShared(id) || !compDataKnown(id)) return null;
  return { path: "~/.cccodroid/" + id, bytes: await compDuBytes(dir) };
}
/** 卸掉的组件留下的运行数据（存储页汇总用）：~/.cccodroid 下每个够格提议删的目录 */
export async function compLeftovers() {
  const out = [];
  let ns = []; try { ns = fs.readdirSync(path.join(CFG.home, ".cccodroid")); } catch {}
  for (const id of ns) { const i = await compDataInfo(id).catch(() => null); if (i) out.push({ id, ...i }); }
  return out;
}
async function compPurgeData(id) {
  if (!compRecordInfo(id).missing) return { ok: false, message: "still installed" };
  if (compDataShared(id)) return { ok: false, message: "shared" };
  if (!compDataKnown(id)) return { ok: false, message: "not a component" };
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
  if (p === "/api/components/remove") { const r = await compRemove(id); if (r.ok) r.data = await compDataInfo(id); return sendJson(res, 200, r); }
  if (p === "/api/components/purge") return sendJson(res, 200, await compPurgeData(id));
  return sendJson(res, 404, { error: "not found" });
}

// ── 路由：/api/components /api/gh/ ──
export async function routeComponents(req, res, u, p) {
  if (p === "/api/components/openai-bridge/config" || p === "/api/components/openai-bridge/models" || p === "/api/components/openai-bridge/repair") {
    const models = p === "/api/components/openai-bridge/models", repair = p === "/api/components/openai-bridge/repair";
    const handler = models ? handleBridgeModels : repair ? handleBridgeRepair : handleBridgeConfig;
    let current = COMP_JOBS.get("openai-bridge");
    // 保存优先于只读取清单：即使客户端 close 尚未到达，也先终止短命任务再接手，绝不等待活网络。
    if (!models && req.method === "POST" && current?.phase === "fetching-models" && !current.finished) {
      current.abort.abort();
      await current.completion;
      current = COMP_JOBS.get("openai-bridge");
    }
    if (current && !current.finished) return sendJson(res, 409, { ok: false, code: "BUSY", message: "busy" });
    if (req.method !== "POST") return handler(req, res);
    const job = { phase: models ? "fetching-models" : "configuring", done: 0, total: 0, finished: false };
    let complete;
    const disconnect = () => { if (!res.writableEnded) job.abort.abort(); };
    if (models) {
      job.abort = new AbortController();
      job.completion = new Promise((resolve) => { complete = resolve; });
      req.once("aborted", disconnect);
      res.once?.("close", disconnect);
      if (req.aborted || res.destroyed) disconnect();
    }
    COMP_JOBS.set("openai-bridge", job);
    try { return await handler(req, res, job.abort?.signal); }
    finally {
      if (models) { req.removeListener("aborted", disconnect); res.removeListener?.("close", disconnect); }
      if (COMP_JOBS.get("openai-bridge") === job) COMP_JOBS.delete("openai-bridge");
      complete?.();
    }
  }
  // ── 可选组件（浏览器组件等）──
  if (p === "/api/components" || p.startsWith("/api/components/")) return handleComponents(req, res, p, u);
  if (p.startsWith("/api/gh/")) return handleGh(req, res, p);
  return NEXT;
}
