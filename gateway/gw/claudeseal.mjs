// 每轮起 claude 前核一遍 claude 程序本身：被等长改过字符串（删掉内置的安全指令之类）的二进制不起。
// 信任锚是 Anthropic 签名的官方清单：装的时候 install-claude.mjs 把 manifest.json 和 manifest.json.sig 存进版本目录，
// 这里用钉在 app/bin/pgp.mjs 里的 Anthropic 公钥验签（files/app 有核对还原，见 appfiles.mjs），再比 sha256。
// 清单是签过名的，同 uid 改得了文件也造不出一份能过验签的；整个 290 MB 算一遍 sha256 不到半秒（骁龙 8+ 有硬件指令），
// 程序文件没动过（大小、修改时间、ctime、inode 都没变）就用上次的结论。
// 没存清单的（旧版本装的、只有 npm 签名的）核不了：马上叫补核（devside.mjs → install-claude.mjs --recheck）去取；
// 发行版在补核拿到清单之前不起（用户拍板 11-05：没有签名清单的版本不运行），开发版照常起。
// 但这几种直接不起（DeepSeek 复核必修 3）：程序不在安装目录的版本子目录里（current 软链被指到别处）、补核已经发现对不上（.mismatch）、
// 这个网关进程先前核过的版本现在清单没了（删清单再换程序）。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { CFG, PATHS, HERE, loadPgp, log } from "./config.mjs";
import { sealed as editionSealed } from "./edition.mjs";
import { tamperRecord } from "./tamper.mjs";

const PLATFORM = "linux-arm64";
const isVer = (v) => /^\d{1,6}\.\d{1,6}\.\d{1,6}(-[0-9A-Za-z.]{1,40})?$/.test(v || "");
let cache = { fp: "", res: null, bin: "", dev: null, ino: null };
const sealed = new Set();          // 这个进程里核过的版本目录
// 部署出来的那份（files/app，有 FILES 清单）才核；仓库里直接跑的开发布局不核。
// 不 import appfiles.mjs：终端里的 bin/claude 经 guard/cc-seal.mjs 也要核，那边不该再起一份文件守护
const DEPLOYED = fs.existsSync(path.join(HERE, "FILES"));
// 发行版布局（应用里的 files/app）：FILES 被删时不能退化成「开发布局、不核」
const APP_LAYOUT = /[\\/]files[\\/]app$/.test(HERE);
let askRecheck = null;
/** 定时补核那边挂进来（devside.mjs）：没清单时叫它尽快去取 */
export const onSealUnknown = (fn) => { askRecheck = fn; };

/** 将 Linux st_dev（BigInt 或 Number）转为 /proc/<pid>/maps 的十六进制 "major:minor"（两位起零填充） */
export function formatProcMapsDev(dev) {
  const d = typeof dev === "bigint" ? dev : BigInt(dev);
  const major = ((d >> 8n) & 0xfffn) | ((d >> 32n) & ~0xfffn);
  const minor = (d & 0xffn) | ((d >> 12n) & ~0xffn);
  const hex = (v) => v.toString(16).padStart(2, "0");
  return `${hex(major)}:${hex(minor)}`;
}

/** 解析 /proc/<pid>/maps，判断目标 (dev, ino) 是否已被进程映射（可选限定路径或可执行段） */
export function procMapsHasInode(mapsText, dev, ino, { execOnly = false } = {}) {
  if (!mapsText || dev == null || ino == null) return { matched: false, pathEntries: [] };
  const wantDev = formatProcMapsDev(dev);
  const wantIno = String(ino);
  let matched = false;
  const pathEntries = [];
  for (const line of String(mapsText).split("\n")) {
    if (!line) continue;
    // 格式: addr perms offset dev inode [pathname...]
    const m = /^\S+\s+(\S+)\s+\S+\s+([0-9a-fA-F]+:[0-9a-fA-F]+)\s+(\d+)(?:\s+(.*))?$/.exec(line);
    if (!m) continue;
    const [, perms, mDevRaw, mIno, rawPath = ""] = m;
    const [maj, min] = mDevRaw.toLowerCase().split(":");
    const mDev = `${maj.padStart(2, "0")}:${min.padStart(2, "0")}`;
    const p = rawPath.trim();
    if (p) pathEntries.push({ perms, dev: mDev, ino: mIno, path: p });
    if (mDev === wantDev && mIno === wantIno && (!execOnly || perms.includes("x"))) {
      matched = true;
    }
  }
  return { matched, pathEntries };
}

const LOADER_EXE_RE = /(?:^|\/)(?:ld-linux-aarch64\.so\.1|libldlinux\.so|linker64|linker|libccrun\.so|libccenosysrun\.so)(?: \(deleted\))?$/;

/** 起进程之后再看一眼：核过之后、真正执行之前程序被换掉了（含「换入→spawn→换回」双跳 TOCTOU），这一轮要停掉。
 *  防线 1（不受 PR_SET_DUMPABLE=0 / hidepid=2 影响）：核对入口链接 bin0、真实二进制 realBin 与所在版本目录的
 *    dev / ino / 纳秒级 ctimeNs（非 root 进程无法回拨 Linux 内核 ctimeNs，任何移走再移回、改软链再改回或覆写都会推进 ctimeNs）；
 *  防线 2（当 /proc/<pid> 可见时）：直跑核对 /proc/<pid>/exe 的 dev:ino，加载器模式核对 /proc/<pid>/maps 的 dev:ino 映射
 *    （strictMaps=true 如收到 init 事件时要求必命中目标 dev:ino，拦截异名文件映射）。 */
export const sealStillValid = (bin0 = PATHS.claude, seal = null, pid = 0, { strictMaps = false } = {}) => {
  const ref = (seal && seal.ok === true && seal.ino != null) ? seal : cache.res;
  if (!ref || ref.ok !== true) return true;
  let realBin = "";
  try {
    const linkSt = fs.lstatSync(bin0, { bigint: true });
    if (ref.linkCtimeNs != null && (linkSt.dev !== BigInt(ref.linkDev) || linkSt.ino !== BigInt(ref.linkIno) || linkSt.ctimeNs !== BigInt(ref.linkCtimeNs))) {
      return false;
    }
    realBin = fs.realpathSync(bin0);
    if (cache.res && cache.res.ok === true && cache.fp && fpFor(realBin) !== cache.fp) return false;
    const binSt = fs.statSync(realBin, { bigint: true });
    if (ref.dev != null && (binSt.dev !== BigInt(ref.dev) || binSt.ino !== BigInt(ref.ino))) return false;
    if (ref.size != null && binSt.size !== BigInt(ref.size)) return false;
    if (ref.ctimeNs != null && binSt.ctimeNs !== BigInt(ref.ctimeNs)) return false;
    if (ref.dirCtimeNs != null) {
      const dirSt = fs.statSync(path.dirname(realBin), { bigint: true });
      if (dirSt.dev !== BigInt(ref.dirDev) || dirSt.ino !== BigInt(ref.dirIno) || dirSt.ctimeNs !== BigInt(ref.dirCtimeNs)) return false;
    }
  } catch { return false; }

  const wantDev = ref.dev ?? cache.dev;
  const wantIno = ref.ino ?? cache.ino;
  if (!(Number.isInteger(pid) && pid > 0) || wantDev == null || wantIno == null) return true;

  const procDir = `/proc/${pid}`;
  if (!fs.existsSync(procDir)) return true;

  let exeLink = "";
  try { exeLink = fs.readlinkSync(`${procDir}/exe`); } catch (e) {
    if (["EACCES", "EPERM", "ENOENT", "ESRCH"].includes(e.code)) return true;
    return false;
  }

  const isLoader = LOADER_EXE_RE.test(exeLink);
  if (!isLoader) {
    try {
      const exeSt = fs.statSync(`${procDir}/exe`, { bigint: true });
      return exeSt.dev === BigInt(wantDev) && exeSt.ino === BigInt(wantIno);
    } catch (e) {
      if (["EACCES", "EPERM", "ENOENT", "ESRCH"].includes(e.code)) return true;
      return false;
    }
  }

  // 加载器模式（或监督器/ld.so 包装）：核对 /proc/<pid>/maps 中的映射 dev:ino
  let maps = "";
  try { maps = fs.readFileSync(`${procDir}/maps`, "utf8"); } catch (e) {
    if (["EACCES", "EPERM", "ENOENT", "ESRCH"].includes(e.code)) return true;
    return false;
  }
  const parsed = procMapsHasInode(maps, wantDev, wantIno);
  if (parsed.matched) return true;
  if (strictMaps) return false;
  // spawn 紧后可能尚未完成 exec/mmap；若已经映射了目标路径（或同名可执行段）却不是核过的 dev:ino，当场拦截
  const targetBase = path.basename(realBin || bin0);
  const mappedSameTarget = parsed.pathEntries.some((en) =>
    en.perms.includes("x") && (en.path === realBin || en.path === `${realBin} (deleted)` || path.basename(en.path.replace(/ \(deleted\)$/, "")) === targetBase)
  );
  if (mappedSameTarget) return false;
  return true;
};

const fpFor = (bin) => { const d = path.dirname(bin); return fpOf(bin, d, path.join(d, "manifest.json"), path.join(d, "manifest.json.sig"), path.join(d, ".mismatch")); };
function fpOf(...files) {
  return files.map((f) => { try { const s = fs.statSync(f, { bigint: true }); return `${f}:${s.size}:${s.mtimeNs}:${s.ctimeNs}:${s.ino}`; } catch { return f + ":-"; } }).join("|");
}
async function sha256AndStatAsync(f) {
  const h = crypto.createHash("sha256");
  const fh = await fs.promises.open(f, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const b = Buffer.alloc(2 << 20);
  try {
    const st = await fh.stat({ bigint: true });
    if (!st.isFile()) throw new Error("claude binary is not a regular file");
    let pos = 0;
    while (true) {
      const { bytesRead } = await fh.read(b, 0, b.length, pos);
      if (!bytesRead) break;
      h.update(b.subarray(0, bytesRead));
      pos += bytesRead;
    }
    const stAfter = await fh.stat({ bigint: true });
    if (st.dev !== stAfter.dev || st.ino !== stAfter.ino || st.size !== stAfter.size || st.ctimeNs !== stAfter.ctimeNs) {
      throw new Error("claude binary changed while hashing");
    }
    return { hex: h.digest("hex"), st: stAfter };
  } finally { await fh.close().catch(() => {}); }
}

const SEAL_INFLIGHT = new Map();
/**
 * { ok: true } 核过 / { ok: false, why } 对不上（别起）/ { ok: null, why } 核不了（开发版照常起）。
 * 发行版没有签名清单时是 { ok: false, why, pending: true }：不算篡改，补核取到清单后自动放行
 */
export async function claudeSeal(bin0 = PATHS.claude, { force = false, home = CFG.home } = {}) {
  // 发行版不能因为可写的 FILES 被删就退化成「开发布局、不核」：终端新起的进程会直接放行
  if (!DEPLOYED && !force) return editionSealed() && APP_LAYOUT ? { ok: false, why: "FILES missing" } : { ok: null, why: "dev" };
  let bin;
  try { bin = fs.realpathSync(bin0); } catch { return { ok: null, why: "missing" }; }
  const dir = path.dirname(bin), mf = path.join(dir, "manifest.json"), sf = mf + ".sig";
  const fp = fpFor(bin);
  // 刚改过的不信缓存：时间戳有粒度，同一刻里写两遍、大小不变，指纹就一样（gwpin.mjs 同理）
  let fresh = false;
  try { fresh = Date.now() - fs.statSync(bin).ctimeMs <= 2000; } catch {}
  if (cache.fp === fp && cache.res && !fresh) return cache.res;
  const flightKey = `${bin}|${home}|${fp}|${force ? 1 : 0}`;
  if (SEAL_INFLIGHT.has(flightKey)) return SEAL_INFLIGHT.get(flightKey);
  const run = (async () => {
    let res;
    const ROOT = path.join(home, ".local", "share", "cccodroid", "claude");
    let m = null, sig = null, root = ROOT;
    try { root = fs.realpathSync(ROOT); } catch {}
    try { m = await fs.promises.readFile(mf); sig = await fs.promises.readFile(sf, "utf8"); } catch {}
    if ((path.dirname(dir) !== root || !isVer(path.basename(dir)) || path.basename(bin) !== "claude"))
      res = { ok: false, why: "not an installed version under " + ROOT };
    else if (fs.existsSync(path.join(dir, ".mismatch"))) res = { ok: false, why: "recheck found it doesn't match the official manifest" };
    else if (!m || !sig) res = sealed.has(dir) ? { ok: false, why: "signed manifest removed after it was verified" }
      : editionSealed() ? { ok: false, why: "no signed manifest", pending: true } : { ok: null, why: "no signed manifest" };
    else {
      try {
        const { verifyDetached, ANTHROPIC_KEYS } = await loadPgp();
        verifyDetached(m, sig, ANTHROPIC_KEYS);
        const j = JSON.parse(m.toString("utf8")), p = j && j.platforms && j.platforms[PLATFORM];
        if (!p || !/^[a-f0-9]{64}$/.test(p.checksum || "")) res = { ok: false, why: "signed manifest has no " + PLATFORM + " entry" };
        else if (j.version !== path.basename(dir)) res = { ok: false, why: `manifest is for ${j.version}, directory is ${path.basename(dir)}` };
        else {
          const { hex, st } = await sha256AndStatAsync(bin);
          if (hex !== p.checksum) res = { ok: false, why: "binary does not match the signed manifest" };
          else {
            const dirSt = fs.statSync(dir, { bigint: true });
            const linkSt = fs.lstatSync(bin0, { bigint: true });
            res = {
              ok: true,
              version: j.version,
              dev: st.dev,
              ino: st.ino,
              size: st.size,
              ctimeNs: st.ctimeNs,
              dirDev: dirSt.dev,
              dirIno: dirSt.ino,
              dirCtimeNs: dirSt.ctimeNs,
              linkDev: linkSt.dev,
              linkIno: linkSt.ino,
              linkCtimeNs: linkSt.ctimeNs,
            };
            sealed.add(dir);
          }
        }
      } catch (e) {
        // 验签模块缺了（files/app 有核对还原，正常不会）：发行版照样不起
        res = /pgp\.mjs not found/.test(e.message) && !editionSealed() ? { ok: null, why: e.message } : { ok: false, why: "manifest signature: " + e.message };
      }
    }
    const again = cache.res && cache.res.ok === res.ok && cache.res.why === res.why;
    if (res.pending) { if (!again) log(`[Claude Code 核验] ${path.basename(dir)} 还没有签名清单，补核拿到之前不起`); }
    else if (res.ok === false && !(cache.res && cache.res.ok === false && cache.fp === fp)) {
      log(`⚠️ [Claude Code 核验] ${bin}：${res.why}`);
      tamperRecord("claude", [`${path.basename(dir)}/claude: ${res.why}`]);
    } else if (res.ok === null && cache.res?.ok !== null) log(`[Claude Code 核验] 核不了（${res.why}），照常起；连得上官方时会补存签名清单`);
    if (res.why === "no signed manifest") try { askRecheck?.(); } catch {}
    cache = { fp, res, bin, dev: res?.dev ?? null, ino: res?.ino ?? null };
    return res;
  })().finally(() => { if (SEAL_INFLIGHT.get(flightKey) === run) SEAL_INFLIGHT.delete(flightKey); });
  SEAL_INFLIGHT.set(flightKey, run);
  return run;
}
