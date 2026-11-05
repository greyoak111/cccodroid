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
let cache = { fp: "", res: null };
const sealed = new Set();          // 这个进程里核过的版本目录
// 部署出来的那份（files/app，有 FILES 清单）才核；仓库里直接跑的开发布局不核。
// 不 import appfiles.mjs：终端里的 bin/claude 经 guard/cc-seal.mjs 也要核，那边不该再起一份文件守护
const DEPLOYED = fs.existsSync(path.join(HERE, "FILES"));
let askRecheck = null;
/** 定时补核那边挂进来（devside.mjs）：没清单时叫它尽快去取 */
export const onSealUnknown = (fn) => { askRecheck = fn; };
/** 起进程之后再看一眼：核过之后、真正执行之前程序被换掉了（来回替换卡时间窗），这一轮要停掉 */
export const sealStillValid = (bin0 = PATHS.claude) => {
  if (!cache.res || cache.res.ok !== true) return true;
  try { return fpFor(fs.realpathSync(bin0)) === cache.fp; } catch { return false; }
};

const fpFor = (bin) => { const d = path.dirname(bin); return fpOf(bin, path.join(d, "manifest.json"), path.join(d, "manifest.json.sig"), path.join(d, ".mismatch")); };
function fpOf(...files) {
  return files.map((f) => { try { const s = fs.statSync(f); return `${f}:${s.size}:${s.mtimeMs}:${s.ctimeMs}:${s.ino}`; } catch { return f + ":-"; } }).join("|");
}
function sha256(f) {
  const h = crypto.createHash("sha256"), fd = fs.openSync(f, "r"), b = Buffer.alloc(4 << 20);
  try { let n; while ((n = fs.readSync(fd, b, 0, b.length)) > 0) h.update(b.subarray(0, n)); } finally { fs.closeSync(fd); }
  return h.digest("hex");
}

/**
 * { ok: true } 核过 / { ok: false, why } 对不上（别起）/ { ok: null, why } 核不了（开发版照常起）。
 * 发行版没有签名清单时是 { ok: false, why, pending: true }：不算篡改，补核取到清单后自动放行
 */
export async function claudeSeal(bin0 = PATHS.claude, { force = false, home = CFG.home } = {}) {
  if (!DEPLOYED && !force) return { ok: null, why: "dev" };   // 开发布局（仓库里直接跑）不核
  let bin;
  try { bin = fs.realpathSync(bin0); } catch { return { ok: null, why: "missing" }; }
  const dir = path.dirname(bin), mf = path.join(dir, "manifest.json"), sf = mf + ".sig";
  const fp = fpFor(bin);
  if (cache.fp === fp && cache.res) return cache.res;
  let res;
  const ROOT = path.join(home, ".local", "share", "cccodroid", "claude");
  let m = null, sig = null, root = ROOT;
  try { root = fs.realpathSync(ROOT); } catch {}
  try { m = fs.readFileSync(mf); sig = fs.readFileSync(sf, "utf8"); } catch {}
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
      else if (sha256(bin) !== p.checksum) res = { ok: false, why: "binary does not match the signed manifest" };
      else { res = { ok: true, version: j.version }; sealed.add(dir); }
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
  cache = { fp, res };
  return res;
}
