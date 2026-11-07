#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
//  ship.mjs —— App 发版一条命令：改版本号 → 更新日志 → 提交 → 打包 → 核包 →（点头后）推送 → Release → 对账 → 装机
//
//  用法:  node scripts/ship.mjs <版本> [--title "一句话"]       本地走到核包为止（改版本号、提交、打包），不碰网络
//         node scripts/ship.mjs <版本> --publish                 接着推送、建 Release、下载回来核哈希、同步官网并清 CF 直链缓存
//         node scripts/ship.mjs <版本> … --install               最后用 priv 覆盖安装到本机（会关掉正在用的 cccodroid）
//         node scripts/ship.mjs <版本> --from <步骤>             从某步重来（之前的步骤视为已完成）
//         node scripts/ship.mjs <版本> --check                   只对账：清单、包、提交、Release 逐项核一遍，不改东西
//         node scripts/ship.mjs dev [--install]                  只打包当前工作树（不改版本号、不提交），给装机自测用
//  步骤:  preflight → bump → changelog → commit → build → verify ┃ push → release → check → site ┃ install
//  状态记在 ~/.work/ship/<版本>/state.json：断了再跑同一条命令，从没做完的那步接着来。
//
//  发版前要写好 android/assets/whatsnew/v<版本>.zh.md 和 .en.md（App 里弹的、Release 正文都是它）。
//  推送和发布对外可见，所以必须显式给 --publish；按约定要先得到用户点头。
//  钥匙、令牌都在构建机私有目录，脚本只把路径交给 build.sh / release.sh，不读出来、不打印。
// ─────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const HOME = process.env.HOME;
const REPO = "greyoak111/cccodroid";
// 旧开发端（li.dsh.claudecli）的工具链目录在就用它；否则是 cccodroid 终端：aapt2 在 PATH，钥匙在 ~/.bldtools（和 build.sh 一致）
const F = "/data/user/0/li.dsh.claudecli/files", P = `${F}/toolchain/dshtc/prefix`, OLD = fs.existsSync(P);
const BLD = process.env.BLDTOOLS || (OLD ? `${F}/bldtools` : path.join(HOME, ".bldtools"));
const MANI = path.join(ROOT, "android/AndroidManifest.xml");
const WN = path.join(ROOT, "android/assets/whatsnew");
const APK = path.join(ROOT, "dist/cccodroid.apk");
// 双方案：cccodroid.apk 是 targetSdk 28（默认、兼容最好），cccodroid-36.apk 给系统不让装 28 的机器。同版本号、同钥匙，互相覆盖安装
const APK36 = path.join(ROOT, "dist/cccodroid-36.apk");
const STEPS = ["preflight", "bump", "changelog", "commit", "build", "verify", "push", "release", "check", "site", "install"];
const PUBLIC = ["push", "release", "check", "site"];
// 官网 cccodroid.net：VPS 上的 cccodroid-site.service 从 GitHub 生成静态站（含 /dl/ 直链），前面是 Cloudflare
const SITE = "https://cccodroid.net", VPS = "root@167.160.161.115", VPS_KEY = path.join(HOME, ".ssh/vps-keys/167.160.161.115-root");

const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv.splice(i, 2)[1] : undefined; };
const flag = (k) => { const i = argv.indexOf(k); return i >= 0 ? (argv.splice(i, 1), true) : false; };
const TITLE = opt("--title"), FROM = opt("--from");
const PUBLISH = flag("--publish"), INSTALL = flag("--install"), CHECK_ONLY = flag("--check");
const VER = argv[0];
const DEV = VER === "dev";
if (!DEV && !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(VER || "")) { console.error("用法: node scripts/ship.mjs <版本，如 0.3.15> [--title …] [--publish] [--install] [--from 步骤] [--check]\n      node scripts/ship.mjs dev [--install]"); process.exit(2); }
if (FROM && !STEPS.includes(FROM)) { console.error(`✗ 没有步骤 ${FROM}；可选：${STEPS.join(" ")}`); process.exit(2); }

const W = path.join(HOME, ".work/ship", VER);
fs.mkdirSync(W, { recursive: true });
const SF = path.join(W, "state.json");
const state = !DEV && fs.existsSync(SF) ? JSON.parse(fs.readFileSync(SF, "utf8")) : { ver: VER, done: {} };
const save = () => { if (!DEV) fs.writeFileSync(SF, JSON.stringify(state, null, 1) + "\n"); };

// ── 小工具 ──
const sh = (cmd, args, o = {}) => execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"], ...o }).trim();
const run = (cmd, args, o = {}) => { const r = spawnSync(cmd, args, { stdio: "inherit", ...o }); if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 3).join(" ")} … 退出码 ${r.status}`); };
const git = (...a) => sh("git", ["-c", "safe.directory=*", "-C", ROOT, ...a]);
const gitc = (...a) => sh("git", ["-c", "safe.directory=*", "-c", "user.name=greyoak111", "-c", "user.email=suny96636@gmail.com", "-C", ROOT, ...a]);
const shaFile = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const mani = () => { const s = fs.readFileSync(MANI, "utf8"); return { code: +s.match(/android:versionCode="(\d+)"/)[1], name: s.match(/android:versionName="([^"]*)"/)[1] }; };
// 版本比较：先比主版本号；相同时正式版 > 预发布，预发布之间按「字母 + 数字」逐段比（beta1 < beta2 < rc1）。
// 以前整串按 . - 切开转数字，beta1 成了 NaN 当 0，同底版本的 beta→正式、beta1→beta2 都被拦下（#136）
const cmpVer = (a, b) => {
  const [ab, ...ap] = String(a).split("-"), [bb, ...bp] = String(b).split("-");
  const x = ab.split(".").map(Number), y = bb.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; }
  const pa = ap.join("-"), pb = bp.join("-");
  if (!pa || !pb) return pa ? -1 : pb ? 1 : 0;
  const seg = (s) => s.match(/\d+|\D+/g) || [];
  const sa = seg(pa), sb = seg(pb);
  for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
    const u = sa[i], v = sb[i];
    if (u === undefined || v === undefined) return u === undefined ? -1 : 1;
    const nu = /^\d/.test(u), nv = /^\d/.test(v);
    const d = nu && nv ? +u - +v : u < v ? -1 : u > v ? 1 : 0;
    if (d) return d;
  }
  return 0;
};
const wn = (lang) => path.join(WN, `v${VER}.${lang}.md`);
// /sdcard 是 FUSE，刚写的小文件 stat 可能报旧大小：提交前逐个核 stat 与实际读到的字节数
function fuseOk(files) {
  const bad = files.filter((f) => fs.existsSync(f) && fs.statSync(f).size !== fs.readFileSync(f).length);
  if (bad.length) throw new Error("FUSE 报的大小和实际内容不一致（等几秒再跑）：\n  " + bad.join("\n  "));
}
const badging = (apk = APK) => {
  const out = OLD ? sh("env", [`LD_LIBRARY_PATH=${P}/lib`, `${P}/bin/aapt2`, "dump", "badging", apk]) : sh("aapt2", ["dump", "badging", apk]);
  const m = out.match(/versionCode='(\d+)' versionName='([^']*)'/);
  return { code: +m[1], name: m[2], pkg: (out.match(/package: name='([^']+)'/) || [])[1], sdk: +((out.match(/targetSdkVersion:'(\d+)'/) || [])[1] || 0) };
};

// ── 各步 ──
const S = {
  preflight() {
    const br = git("rev-parse", "--abbrev-ref", "HEAD");
    if (br !== "main") throw new Error(`当前分支是 ${br}，发版要在 main 上`);
    const cur = mani();
    if (cur.name !== VER && cmpVer(VER, cur.name) <= 0) throw new Error(`${VER} 不比当前 ${cur.name} 新`);
    for (const l of ["zh", "en"]) if (!fs.existsSync(wn(l)) || !fs.readFileSync(wn(l), "utf8").trim()) throw new Error(`缺更新说明 ${path.relative(ROOT, wn(l))}`);
    // 允许没提交的只有这次发版自己要提交的东西
    const allowed = (f) => f === "android/AndroidManifest.xml" || f.startsWith("android/assets/whatsnew/") || f.startsWith("gateway/web/changelog/");
    // sh() 会 trim，第一行开头的空格没了，不能按固定 3 个字符切路径
    const dirty = git("status", "--porcelain").split("\n").filter(Boolean).map((l) => l.replace(/^[ MADRCUT?!]{1,2} /, "")).filter((f) => !allowed(f));
    if (dirty.length) throw new Error("工作区还有别的没提交的改动，先提交或收起：\n  " + dirty.join("\n  "));
    for (const f of [`${BLD}/cccodroid-release.json`, `${BLD}/gh-token-cccodroid`]) if (!fs.existsSync(f)) throw new Error(`缺 ${f}`);
    run("node", [path.join(ROOT, "scripts/test.mjs")], { cwd: ROOT });      // 网关测试不过就不发
    console.log(`  当前 ${cur.name}（${cur.code}）→ ${VER}`);
  },
  bump() {
    const cur = mani();
    if (cur.name === VER) { console.log(`  已是 ${VER}（versionCode ${cur.code}）`); state.code = cur.code; return; }
    const code = cur.code + 1;
    let s = fs.readFileSync(MANI, "utf8");
    s = s.replace(/android:versionCode="\d+"/, `android:versionCode="${code}"`).replace(/android:versionName="[^"]*"/, `android:versionName="${VER}"`);
    fs.writeFileSync(MANI, s);
    state.code = code;
    console.log(`  versionCode ${cur.code} → ${code}，versionName → ${VER}`);
  },
  changelog() {
    run("node", [path.join(ROOT, "scripts/changelog.mjs")], { cwd: ROOT });
    for (const l of ["zh", "en"]) {
      const j = JSON.parse(fs.readFileSync(path.join(ROOT, `gateway/web/changelog/${l}.json`), "utf8"));
      if (!j.some((x) => x.v === VER)) throw new Error(`更新日志 ${l}.json 里没有 ${VER}`);
    }
  },
  commit() {
    const files = ["android/AndroidManifest.xml", `android/assets/whatsnew/v${VER}.zh.md`, `android/assets/whatsnew/v${VER}.en.md`, "gateway/web/changelog/zh.json", "gateway/web/changelog/en.json"];
    fuseOk(files.map((f) => path.join(ROOT, f)));
    git("add", ...files);
    if (!git("diff", "--cached", "--name-only")) { console.log("  没有要提交的（已提交过）"); state.commit = git("rev-parse", "HEAD"); return; }
    const title = TITLE || fs.readFileSync(wn("zh"), "utf8").split("\n").map((l) => l.replace(/^#+\s*/, "").trim()).find(Boolean) || "";
    gitc("commit", "-q", "-m", `v${VER}${title ? "：" + title : ""}\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`);
    state.commit = git("rev-parse", "HEAD");
    console.log("  " + git("log", "--oneline", "-1"));
  },
  build() {
    // 先出 36 的、改名放一边，再出 28 的（build.sh 的产物固定叫 cccodroid.apk）。dev 只出 28，省一半时间
    fs.rmSync(APK36, { force: true });
    if (!DEV) {
      run("sh", [path.join(ROOT, "scripts/build.sh")], { cwd: ROOT, env: { ...process.env, TARGET_SDK: "36" } });
      fs.renameSync(APK, APK36);
    }
    run("sh", [path.join(ROOT, "scripts/build.sh")], { cwd: ROOT });
  },
  verify() {
    const b = badging(), m = mani();
    if (b.pkg !== "cc.codroid") throw new Error(`包名是 ${b.pkg}`);
    if (b.code !== m.code || b.name !== m.name) throw new Error(`包里是 ${b.name}（${b.code}），清单是 ${m.name}（${m.code}）`);
    if (!DEV && b.name !== VER) throw new Error(`包里版本 ${b.name}，要发的是 ${VER}`);
    if (b.sdk !== 28) throw new Error(`cccodroid.apk 的 targetSdk 是 ${b.sdk}，应为 28`);
    state.sha = shaFile(APK); state.size = fs.statSync(APK).size;
    if (fs.readFileSync(APK).length !== state.size) throw new Error("APK 的 stat 大小和实际不一致（FUSE），等几秒重跑 verify");
    if (!DEV) {
      if (!fs.existsSync(APK36)) throw new Error("没有 dist/cccodroid-36.apk，重打：--from build");
      const c = badging(APK36);
      if (c.pkg !== b.pkg || c.code !== b.code || c.name !== b.name || c.sdk !== 36) throw new Error(`36 包不对：${c.pkg} ${c.name}（${c.code}）targetSdk ${c.sdk}`);
      state.sha36 = shaFile(APK36); state.size36 = fs.statSync(APK36).size;
      if (fs.readFileSync(APK36).length !== state.size36) throw new Error("36 包的 stat 大小和实际不一致（FUSE），等几秒重跑 verify");
      console.log(`  36 版 ${(state.size36 / 1048576).toFixed(2)} MB  sha256 ${state.sha36}`);
    }
    // 包里的前端要和工作树一致（打包后又改了代码就不算数）
    if (!DEV && git("status", "--porcelain")) throw new Error("打包后工作区又有改动，重打：--from build");
    state.head = git("rev-parse", "HEAD");
    console.log(`  ${b.name}（${b.code}） ${(state.size / 1048576).toFixed(2)} MB  sha256 ${state.sha}`);
  },
  push() {
    run("git", ["-c", "safe.directory=*", "-C", ROOT, "push", "origin", "main"]);
  },
  release() {
    run("sh", [path.join(ROOT, "scripts/release.sh")], { cwd: ROOT });
  },
  async check() {
    const tag = "v" + VER;
    const rel = JSON.parse(sh("gh", ["api", `repos/${REPO}/releases/tags/${tag}`]));
    for (const [name, size, sha] of [["cccodroid.apk", state.size, state.sha], ["cccodroid-36.apk", state.size36, state.sha36]]) {
      const a = (rel.assets || []).find((x) => x.name === name);
      if (!a) throw new Error(`Release 上没有 ${name}`);
      if (a.size !== size) throw new Error(`Release 上的 ${name} ${a.size} 字节，本地 ${size}`);
      const tmp = path.join(W, "dl.apk");
      run("curl", ["-fsSL", "--retry", "3", "-o", tmp, a.browser_download_url]);
      const got = shaFile(tmp); fs.rmSync(tmp);
      if (got !== sha) throw new Error(`下载回来的 ${name} sha256 ${got} ≠ 本地 ${sha}`);
    }
    const tagSha = sh("gh", ["api", `repos/${REPO}/commits/${tag}`, "--jq", ".sha"]);
    if (tagSha !== git("rev-parse", "HEAD")) throw new Error(`tag 指向 ${tagSha.slice(0, 7)}，不是当前 HEAD`);
    if (!rel.prerelease) {
      const latest = JSON.parse(sh("gh", ["api", `repos/${REPO}/releases/latest`])).tag_name;
      if (latest !== tag) throw new Error(`Latest 是 ${latest}，不是 ${tag}`);
    }
    state.prerelease = !!rel.prerelease;
    console.log(`  ✓ ${rel.html_url}  下载哈希一致${rel.prerelease ? "（预发布）" : "，已是 Latest"}`);
  },
  async site() {
    // 1) 让 VPS 现在就重新生成（平时靠定时器，等不及）；钥匙只交路径，不读出来
    run("ssh", ["-F", "/dev/null", "-i", path.join(VPS_KEY, "id_ed25519"), "-o", "IdentitiesOnly=yes", "-o", `UserKnownHostsFile=${path.join(VPS_KEY, "known_hosts")}`,
      "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=15", VPS, "systemctl start cccodroid-site.service"]);
    // 2) 清 CF 上直链的缓存：不清的话 /dl/cccodroid.apk 还会给旧包（0.4.11 起每次都要手动清）
    const files = ["/dl/cccodroid.apk", "/dl/cccodroid-36.apk", `/dl/v${VER}/cccodroid.apk`, `/dl/v${VER}/cccodroid-36.apk`, "/", "/known-issues"].map((f) => SITE + f);
    run("cf", ["POST", "/zones/zone:cccodroid.net/purge_cache", JSON.stringify({ files })], { env: { ...process.env, CF_WRITE: "1" }, stdio: ["ignore", "ignore", "inherit"] });
    siteVerify();
  },
};

// 官网直链给的是不是新包（先按大小等 CF 边缘换新，几秒的事、重试几次；对上了再下回来核 sha256，审查 10-29 L20）。
// 预发布不进 /dl/cccodroid.apk，只核带版本号的。--check 也用它（只读）
function siteVerify() {
  const want = [[`/dl/v${VER}/cccodroid.apk`, state.size, state.sha], [`/dl/v${VER}/cccodroid-36.apk`, state.size36, state.sha36]];
  if (!state.prerelease) want.push(["/dl/cccodroid.apk", state.size, state.sha], ["/dl/cccodroid-36.apk", state.size36, state.sha36]);
  for (const [f, size, sha] of want) {
    let got = "";
    for (let i = 0; i < 6; i++) {
      if (i) spawnSync("sleep", ["5"]);
      try { got = (sh("curl", ["-fsSI", SITE + f]).match(/^content-length:\s*(\d+)/im) || [])[1] || ""; } catch { got = "失败"; }
      if (+got === size) break;
    }
    if (+got !== size) throw new Error(`${SITE}${f} 给的是 ${got} 字节，新包 ${size}；等一会儿再跑同一条命令`);
    const tmp = path.join(W, "site.apk");
    run("curl", ["-fsSL", "--retry", "3", "-o", tmp, SITE + f]);
    const h = shaFile(tmp); fs.rmSync(tmp);
    if (h !== sha) throw new Error(`${SITE}${f} 下回来的 sha256 ${h} ≠ 新包 ${sha}`);
    console.log(`  ✓ ${f}  ${size}  sha256 对上`);
  }
}

Object.assign(S, {
  install() {
    // 本机装着哪套就装哪套：别因为发版把 36 的机器换回 28
    const cur = sh("priv", ["dumpsys package cc.codroid | grep -m1 -o 'targetSdk=[0-9]*' || true"]);
    const apk = /targetSdk=(\d+)/.test(cur) && +cur.match(/targetSdk=(\d+)/)[1] >= 29 && fs.existsSync(APK36) ? APK36 : APK;
    const size = fs.statSync(apk).size;
    console.log(`  装 ${path.basename(apk)}`);
    // 安装包从本进程经标准输入交给 priv：priv 是 shell 身份（uid 2000），读不到应用私有目录里的文件（0.6.8 发版时 cat 报 Permission denied）
    const fd = fs.openSync(apk, "r");
    try { run("priv", [`pm install -r -S ${size}`], { stdio: [fd, "inherit", "inherit"] }); } finally { fs.closeSync(fd); }
    const v = sh("priv", ["dumpsys package cc.codroid | grep -m1 versionName"]);
    console.log("  已装：" + v.trim());
    // 装完把应用打开（和应用内更新一样）：刚装完系统可能还在做安装后扫描、头一次启动会被丢掉，起不来就再拉
    for (let i = 1; i <= 3; i++) {
      spawnSync("sleep", ["2"]);
      sh("priv", ["am start -n cc.codroid/.MainActivity >/dev/null 2>&1"]);
      spawnSync("sleep", ["2"]);
      if (/ResumedActivity.*cc\.codroid\//.test(sh("priv", ["dumpsys activity activities | grep ResumedActivity"]))) { console.log("  已打开"); return; }
    }
    console.log("  没能自动打开，手动点开就好");
  },
});

// ── 主流程 ──
const plan = DEV ? ["build", "verify", ...(INSTALL ? ["install"] : [])]
  : STEPS.filter((s) => (PUBLIC.includes(s) ? PUBLISH : s === "install" ? INSTALL : true));
if (CHECK_ONLY) {
  let bad = 0;
  for (const s of ["verify", ...(state.done.release ? ["check"] : []), ...(state.done.site ? ["site"] : [])]) {
    try { await (s === "site" ? siteVerify() : S[s]()); console.log(`✓ ${s}`); } catch (e) { bad++; console.log(`✗ ${s}：${e.message}`); }
  }
  process.exit(bad ? 1 : 0);
}
if (FROM) { for (const s of STEPS.slice(0, STEPS.indexOf(FROM))) state.done[s] ||= "assumed"; for (const s of STEPS.slice(STEPS.indexOf(FROM))) delete state.done[s]; save(); }
for (const s of plan) {
  if (!DEV && state.done[s]) { console.log(`· ${s}（已完成）`); continue; }
  console.log(`▸ ${s}`);
  // --from 跳过了 verify（标成 assumed）：对外的步骤前照样核一遍包，别把没核过的产物传上去（审查 v0.5.9 D3）
  if (PUBLIC.includes(s) && state.done.verify === "assumed") {
    try { await S.verify(); state.done.verify = new Date().toISOString(); save(); }
    catch (e) { console.error(`✗ verify（${s} 之前补核）：${e.message}`); save(); process.exit(1); }
  }
  // 续跑时 verify 可能是上次的：对外之前核对提交和两个包还是验过的那份，变了就作废 verify 及之后的步骤（审查 v0.5.20 10-002）
  if (PUBLIC.includes(s) && !DEV) {
    const why = state.head !== git("rev-parse", "HEAD") ? "提交变了"
      : !fs.existsSync(APK) || shaFile(APK) !== state.sha || fs.statSync(APK).size !== state.size ? "cccodroid.apk 变了"
      : !fs.existsSync(APK36) || shaFile(APK36) !== state.sha36 || fs.statSync(APK36).size !== state.size36 ? "cccodroid-36.apk 变了"
      : git("status", "--porcelain") ? "工作区有改动" : "";
    if (why) {
      for (const k of STEPS.slice(STEPS.indexOf("verify"))) delete state.done[k];
      save();
      console.error(`✗ ${s} 之前核对：${why}，和验过的不是同一份。重跑 verify：node scripts/ship.mjs ${VER} --from verify${PUBLISH ? " --publish" : ""}`);
      process.exit(1);
    }
  }
  try { await S[s](); } catch (e) {
    console.error(`✗ ${s}：${e.message}\n  修好后再跑同一条命令，会从 ${s} 接着来`);
    save(); process.exit(1);
  }
  state.done[s] = new Date().toISOString(); save();
}
if (!DEV && !PUBLISH) console.log(`\n本地已就绪：${APK}\n点头后推送发布：node scripts/ship.mjs ${VER} --publish${INSTALL ? "" : " [--install]"}`);
else console.log("\n✓ 完成");
