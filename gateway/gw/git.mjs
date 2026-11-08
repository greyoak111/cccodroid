import fs from "node:fs";
import { holdsPrivate, isPrivate } from "./pathguard.mjs";
import crypto from "node:crypto";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { CFG, log, tz } from "./config.mjs";
import { NEXT, readBody, sendJson } from "./http.mjs";
import { termEnv } from "./terminal.mjs";

/** 终端里的环境：与 claude 的工具子进程同一套 PATH / TMPDIR / terminfo，但它是给人用的 —— 要颜色，不要 CI 标记。 */
// ── git 可视化：改了哪些文件、逐行对比、提交历史、提交 / 撤销 ──────────────
// 只是 git 命令的薄壳，用终端同一套环境（PATH 里有 git）。仓库位置由前端给（文件面板当前目录 / 编辑器里的文件）
const GIT_MAX = 768 * 1024;
// 文件面板一进目录就自动跑 status/diff：仓库自带的配置不能借机执行命令（safe.directory=* 让本地配置一律被信任）。
// fsmonitor 全关；只读命令再把属性来源换成空树（仓库 .gitattributes 挂的 clean 过滤器 / diff 驱动不生效），diff 类关外部比较与 textconv。
// add/commit 是用户点的，不换属性来源——否则 LFS 之类的过滤器在提交时被跳过
// 光换属性来源不够：.git/info/attributes 与 core.attributesFile 不受 --attr-source 影响，照样能给文件挂上仓库配置里的
// clean 过滤器。所以只读命令还要把配置里出现的每个过滤器都覆盖成空（实测空值即不执行），子模块不递归（它的配置另算），
// 签名校验关掉（log.showSignature + gpg.program 能执行命令）
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const EMPTY_TREE_256 = "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321";
const GIT_RO = new Set(["status", "diff", "show", "log", "for-each-ref", "rev-parse", "remote", "branch"]);
const GIT_PRE = ["-c", "core.quotePath=false", "-c", "color.ui=false", "-c", "core.fsmonitor=false", "-c", "protocol.ext.allow=never"];
function gitArgs(args, tree = EMPTY_TREE) {
  if (!GIT_RO.has(args[0])) return [...GIT_PRE, ...args];
  const extra = args[0] === "diff" || args[0] === "show" || args[0] === "log" ? ["--no-ext-diff", "--no-textconv"] : [];
  if ((args[0] === "status" || args[0] === "diff") && !args.includes("--no-index")) extra.push("--ignore-submodules=all");
  return [...GIT_PRE, "-c", "log.showSignature=false", `--attr-source=${tree}`, args[0], ...extra, ...args.slice(1)];
}
/** 仓库能读到的全部配置（含 include 进来的）：{ ok, list: [{ scope, raw, key, value }], odd }。读配置本身不执行任何东西。
 *  raw 是原样的键：过滤器名（中间那段）区分大小写，[filter "Evil"] 只能用 filter.Evil.* 盖住；key 是小写的，只拿来认。
 *  --null 下键和值用第一个换行分开，名字里带换行（[filter "a\nb"]）就切错了 —— 值里有换行、键里有引号反斜杠控制字符的
 *  一律记 odd，调用方按「看不懂」处理（DeepSeek 复核 11-03）。读失败 ok=false，同样不能当成「没有配置」 */
function gitConfigList(cwd) {
  return new Promise((resolve) => {
    execFile("git", ["config", "--list", "--null", "--show-scope"], { cwd, env: { ...termEnv(), GIT_TERMINAL_PROMPT: "0", LC_ALL: "C.UTF-8" }, timeout: 10000, maxBuffer: 4 << 20, encoding: "utf8" },
      (err, out) => {
        const a = String(out || "").split("\0"), list = [];
        let odd = 0;
        for (let i = 0; i + 1 < a.length; i += 2) {
          const kv = a[i + 1], nl = kv.indexOf("\n");
          const raw = nl < 0 ? kv : kv.slice(0, nl), value = nl < 0 ? "" : kv.slice(nl + 1);
          if (/[\x00-\x1f\x7f"\\]/.test(raw) || value.includes("\n")) odd++;
          list.push({ scope: a[i], raw, key: raw.toLowerCase(), value });
        }
        // 没有任何配置时 git config --list 退出码是 1、输出为空：那是正常的「没有」
        const ok = !err || (err.code === 1 && !String(out || "").length);
        resolve({ ok, list, odd });
      });
  });
}
/** 只读命令用：把每个过滤器的命令覆盖成空。走 GIT_CONFIG_COUNT（过滤器名可以带 = 和空格，-c 拆不开）。
 *  返回 { env, tree }：tree 是这个仓库对象格式下的空树 —— sha256 仓库里拿 sha1 的空树当 --attr-source，
 *  diff / log -p 直接 fatal: bad --attr-source（11-04）。格式看仓库自己的 extensions.objectformat，认不出的不跑 */
async function gitNeutral(cwd) {
  const names = new Set(), c = await gitConfigList(cwd);
  if (!c.ok || c.odd) return null;   // 看不懂的配置：盖不准，宁可不跑
  // 只认 local / worktree：git 自己定对象格式也只看仓库的配置文件，global / system 不算，放宽了两边会对不上。
  // 万一还是选错，git 解析 --attr-source 时直接 fatal（两个方向都实测过），不会退回仓库自己的 .gitattributes
  let fmt = "sha1";
  for (const e of c.list) {
    if (e.key === "extensions.objectformat" && (e.scope === "local" || e.scope === "worktree")) fmt = e.value.trim().toLowerCase();
    const m = e.raw.match(/^filter\.(.+)\.(clean|smudge|process|required)$/i); if (m) names.add(m[1]);
  }
  const tree = fmt === "sha256" ? EMPTY_TREE_256 : fmt === "sha1" ? EMPTY_TREE : null;
  if (!tree) return null;
  const env = {}; let n = 0;
  for (const nm of names) for (const [k, v] of [["clean", ""], ["smudge", ""], ["process", ""], ["required", "false"]]) {
    env["GIT_CONFIG_KEY_" + n] = `filter.${nm}.${k}`; env["GIT_CONFIG_VALUE_" + n] = v; n++;
  }
  if (n) env.GIT_CONFIG_COUNT = String(n);
  return { env, tree };
}
// 仓库自己的配置（local / worktree，含它 include 进来的）里这些项会让提交、撤销、切分支、拉取推送执行命令。
// git-lfs 装在仓库里时写的是固定的几行，放行
const RISKY_KEY = /^(filter\..+\.(clean|smudge|process)|core\.(sshcommand|gitproxy|askpass|hookspath|alternaterefscommand)|credential\.(.+\.)?helper|gpg\.(.+\.)?program|remote\..+\.(uploadpack|receivepack)|protocol\.(.+\.)?allow|include\.path|includeif\..+\.path)$/;
const LFS_OK = new Set(["git-lfs clean -- %f", "git-lfs smudge -- %f", "git-lfs filter-process"]);
async function gitRisks(root) {
  const risks = [], fp = [], c = await gitConfigList(root);
  if (!c.ok) { risks.push("git config: ?"); fp.push("config:?"); }
  if (c.odd) { risks.push(`git config: ${c.odd} odd entries`); fp.push(`config-odd:${c.odd}`); }
  for (const e of c.list) {
    if (e.scope !== "local" && e.scope !== "worktree") continue;
    if (!RISKY_KEY.test(e.key) || LFS_OK.has(e.value.trim())) continue;
    if (/^protocol\./.test(e.key) && /^(never|user)$/i.test(e.value.trim())) continue;
    // 指纹用完整值：界面上仍只展示前 200 字，但改 200 字之后的内容也必须重新确认（审查 11-05）
    const shown = e.value.length > 200
      ? `${JSON.stringify(e.value.slice(0, 200)).slice(1, -1)}…（共 ${e.value.length} 字符，sha256 ${crypto.createHash("sha256").update(e.value).digest("hex").slice(0, 12)}）`
      : JSON.stringify(e.value).slice(1, -1);
    risks.push(`${JSON.stringify(e.raw).slice(1, -1)} = ${shown}`);
    fp.push(`cfg\0${e.key}\0${e.value}`);
  }
  // .git 可以是 gitfile：指向哪个 gitdir 也是风险的一部分（换到另一个同名钩子的 gitdir 不能沿用旧信任）
  const gd = await git(root, ["rev-parse", "--absolute-git-dir"]);
  if (!gd.code) {
    let real = gd.out.trim();
    try { real = fs.realpathSync(real); } catch {}
    if (real) fp.push(`gitdir\0${real}`);
  }
  // 钩子：core.hooksPath 已算进上面；默认目录里非 .sample 的文件
  const hp = await git(root, ["rev-parse", "--git-path", "hooks"]);
  if (!hp.code) {
    const rel = hp.out.trim();
    // core.hooksPath= 时 rev-parse 会回 "./"：不能把仓库根当钩子目录，否则会把顶层所有文件都读一遍
    if (!rel || rel === "." || rel === "./") {
      fp.push("hooks\0invalid");
      risks.push("hook: core.hooksPath 指向仓库根");
    } else {
      const dir = path.resolve(root, rel);
      let names = [];
      try { names = fs.readdirSync(dir).filter((n) => !n.endsWith(".sample") && (() => { try { return fs.statSync(path.join(dir, n)).isFile(); } catch { return false; } })()); } catch {}
      // 指纹覆盖全部钩子的内容 + 权限，且不再只取前 20 个（审查 11-05）。
      // 大钩子只记大小/时间，不整读：钩子可由仓库自带，1GB 的文件能把网关读挂
      for (const n of names) {
        let h = "";
        try {
          const p = path.join(dir, n), st = fs.statSync(p);
          h = st.size > (1 << 20)
            ? `big:${st.size}:${st.mtimeMs}:${(st.mode & 0o777).toString(8)}`
            : crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex") + ":" + (st.mode & 0o777).toString(8);
        } catch (e) { h = "unreadable:" + (e.code || e.message); }
        fp.push(`hook\0${n}\0${h}`);
      }
      for (const n of names.slice(0, 20)) risks.push(`hook: ${n}`);
      if (names.length > 20) risks.push(`hook: …（共 ${names.length} 个钩子）`);
    }
  }
  return { risks, fp: fp.join("\n") };
}
/** 用户确认过的仓库：根目录 → 当时那份风险清单的指纹。清单一变（配置被改）就重新问 */
const GIT_TRUST = new Map();
async function gitGate(root, body) {
  const { risks, fp: src } = await gitRisks(root);
  if (!risks.length) return null;
  const fp = crypto.createHash("sha256").update(root + "\0" + src).digest("hex").slice(0, 24);
  if (GIT_TRUST.get(root) === fp) return null;
  if (body && body.trust === fp) {
    GIT_TRUST.set(root, fp);
    // 打开过的仓库只增不减：最多留最近 200 个（200-6-05）
    if (GIT_TRUST.size > 200) GIT_TRUST.delete(GIT_TRUST.keys().next().value);
    log(`[git] 用户确认信任仓库配置 @ ${root}`);
    return null;
  }
  return { error: "untrusted", fp, risks, message: tz("这个仓库自己的配置会在这一步执行命令。只有信得过这个仓库时才继续。") };
}
// GIT_LITERAL_PATHSPECS：前端给的都是确切文件名，report[1].txt 不能当通配把 report1.txt 一起撤销 / 提交（审查 B03）
// 超时整组杀：提交时的钩子是 git 的子孙，只杀 git 本身它们还会接着写文件、和用户重试撞在一起（审查 B20）。
// 新开进程组（spawn 的 detached；execFile 不认这个选项），到点 kill(-pid)；等 close（stdio 全关）才返回，等于等整组收尾
async function git(cwd, args, opts = {}) {
  const ro = GIT_RO.has(args[0]) ? await gitNeutral(cwd) : { env: {}, tree: EMPTY_TREE };
  if (!ro) return { code: 1, out: "", err: tz("这个仓库的配置读不懂（名字里有换行、引号之类），为安全起见没有执行。") };
  return gitRun(cwd, args, opts, ro.env, ro.tree);
}
function gitRun(cwd, args, { input, timeout = 30000, max = GIT_MAX } = {}, extraEnv = {}, tree = EMPTY_TREE) {
  return new Promise((resolve) => {
    let timedOut = false, spawnErr = null, over = false;
    const out = [], errs = []; let outLen = 0, errLen = 0;
    const c = spawn("git", gitArgs(args, tree), { cwd, env: { ...termEnv(), GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_LITERAL_PATHSPECS: "1", LC_ALL: "C.UTF-8", ...extraEnv }, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const killGroup = () => { try { process.kill(-c.pid, "SIGKILL"); } catch { try { c.kill("SIGKILL"); } catch {} } };
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, timeout);
    c.stdout.on("data", (d) => { outLen += d.length; if (outLen > max * 2) { over = true; killGroup(); } else out.push(d); });
    c.stderr.on("data", (d) => { errLen += d.length; if (errLen <= max * 2) errs.push(d); });
    c.on("error", (e) => { spawnErr = e; });
    c.on("close", (code) => {
      clearTimeout(timer);
      const errOut = Buffer.concat(errs).toString("utf8");
      const err = timedOut ? tz("git 超时（{s} 秒），已结束它和它启动的钩子", { s: Math.round(timeout / 1000) })
        : spawnErr ? (spawnErr.code === "ENOENT" ? "找不到 git" : spawnErr.message) : over ? "输出太长" : errOut;
      resolve({ code: timedOut || spawnErr || over ? (code || 1) : (code ?? 1), out: Buffer.concat(out).toString("utf8"), err: String(err || "").trim(), over });
    });
    c.stdin.on("error", () => {});
    if (input != null) c.stdin.end(input); else c.stdin.end();
  });
}
/** 抓取 / 拉取 / 推送：联网，最长 3 分钟。
 *  https 的凭据靠 gh auth setup-git（扩展页 GitHub 登录时配好的）；ssh 用本机钥匙。
 *  绝不能停下来等人输入：GIT_TERMINAL_PROMPT=0 已在 git() 里；ssh 没配过 core.sshCommand 时加 BatchMode
 *  （配过的——比如开发端走 443 端口的包装脚本——别用环境变量盖掉它）。 */
async function gitNet(root, args) {
  const sc = await git(root, ["config", "core.sshCommand"]);
  const env = sc.out.trim() ? {} : { GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20" };
  return new Promise((resolve) => {
    // detached 让 git 当进程组长：超时 execFile 只杀 git，pre-push 钩子/ssh 还在同一个组里，
    // 由下面按 -pid 整组杀掉；不 detached 的话钩子会继续写仓库、和用户重试撞在一起
    const child = execFile("git", [...GIT_PRE, ...args],
      { cwd: root, env: { ...termEnv(), GIT_TERMINAL_PROMPT: "0", LC_ALL: "C.UTF-8", ...env }, timeout: 180000, maxBuffer: 4 << 20, encoding: "utf8", detached: true },
      (err, out, errOut) => {
        if (err && err.killed) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
        resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: out || "", err: (errOut || (err && err.killed ? "timeout" : err?.message) || "").trim() });
      });
  });
}
function gitNetHuman(err) {
  const e = String(err || "");
  if (/timeout/i.test(e) && e.length < 20) return tz("三分钟没连上，网络可能不通。");
  if (/could not read Username|Authentication failed|terminal prompts disabled|Invalid username or password|403/i.test(e))
    return tz("远端要登录。GitHub 的仓库：到「扩展 → GitHub」登录一次（会顺便配好 git 的 https 推送）；别的网站请在终端里配好凭据。");
  if (/Permission denied \(publickey\)|Host key verification failed/i.test(e))
    return tz("SSH 钥匙不被接受。把本机公钥加到远端账户，或者把远端地址换成 https 再用 GitHub 登录。");
  if (/Could not resolve host|Network is unreachable|Connection timed out|Connection refused|unable to access/i.test(e))
    return tz("连不上远端，检查一下网络或代理。");
  if (/\[rejected\]|non-fast-forward|fetch first/i.test(e)) return tz("远端有你本地没有的新提交，先「拉取」再推送。");
  if (/Not possible to fast-forward|diverging|have diverged/i.test(e))
    return tz("本地和远端各有新提交（分叉了），没法直接快进。可以让 Claude 帮你合并或变基。");
  if (/would be overwritten|Please commit your changes or stash them/i.test(e)) return tz("有没提交的改动会被覆盖。先提交或撤销那些文件再试。");
  if (/No configured push destination|does not appear to be a git repository|No such remote/i.test(e)) return tz("这个仓库还没有设置远端（remote）。");
  if (/no tracking information/i.test(e)) return tz("当前分支没有对应的远端分支，先推送一次建立关联。");
  return "";
}

/** 从任意路径（文件或目录）找到所在仓库；密钥所在的私有目录一律不碰 */
async function gitRepo(p) {
  let dir = String(p || CFG.workspace).trim();
  if (!path.isAbsolute(dir)) dir = path.join(CFG.workspace, dir);
  try { dir = fs.realpathSync(dir); } catch { return { error: tz("路径不存在") }; }
  try { if (!fs.statSync(dir).isDirectory()) dir = path.dirname(dir); } catch {}
  const r = await git(dir, ["rev-parse", "--show-toplevel"]);
  if (r.code) return { error: /not a git repository/i.test(r.err) ? "not_repo" : r.err, notRepo: /not a git repository/i.test(r.err), dir };
  const root = r.out.trim();
  if (gitPrivate(root)) return { error: "forbidden", status: 403 };
  return { root, dir };
}
/** 仓库根落在私有目录（HOME / 运行时）里就不碰；但 cccodroid 的工作区本身就在 HOME 下面，工作区里的仓库放行 */
// 私有目录按目录身份判（gw/pathguard.mjs）：别名、应用数据目录里的 shared_prefs 之类也算（0.6.9 审计 P0-1 / P2 R1）
function gitPrivate(d) {
  return isPrivate(d) || holdsPrivate(d, { workspace: false });
}
/** 仓库里的相对路径：前端给的可能是绝对路径，且 /sdcard 与 /storage/emulated/0 是同一处，按真实路径比。
 *  只解析所在目录、最后一级照字面留着：它自己是符号链接时，git 条目是链接本身，跟过去会撤销 / 删掉它指向的文件（审查 B02） */
function gitRel(root, f) {
  let a = path.isAbsolute(f) ? f : path.join(root, f);
  try { a = path.join(fs.realpathSync(path.dirname(a)), path.basename(a)); } catch {}
  const r = path.relative(root, a);
  // 按路径分量判越界：..notes.txt 是仓库里的正常文件名（#106 07-011）
  return r === ".." || r.startsWith(".." + path.sep) || path.isAbsolute(r) ? null : r;
}
/** 暂存的重命名：新路径 → 旧路径。不截断（状态列表最多 1000 项，这里要全量）；读不出来返回 null，别当成「没有重命名」 */
async function gitRenames(root) {
  const r = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=no"], { max: 64 << 20 });
  const m = new Map(); if (r.code) return null;
  const parts = r.out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const s = parts[i]; if (!s) continue;
    if (s[0] === "R" || s[0] === "C") { const orig = parts[++i]; if (s[0] === "R") m.set(s.slice(3), orig); }
  }
  return m;
}

async function gitStatus(root) {
  // 未跟踪文件很多时 status 输出会超过默认 768KB，被当成“输出太长”整块失败（196 Git 域第 2 条）。
  // 这里放宽到 16MB，解析仍然只留前 1000 项并标 truncated
  const r = await git(root, ["status", "--porcelain=v1", "-z", "-b", "--untracked-files=all"], { max: 16 << 20 });
  if (r.code) return { error: r.err };
  const parts = r.out.split("\0");
  const out = { root, branch: "", upstream: "", ahead: 0, behind: 0, files: [] };
  for (let i = 0; i < parts.length; i++) {
    const s = parts[i]; if (!s) continue;
    if (s.startsWith("## ")) {
      const m = s.slice(3).match(/^(.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/);
      if (m) {
        out.branch = m[1].replace(/^No commits yet on /, "");
        out.upstream = m[2] || "";
        const a = (m[3] || "").match(/ahead (\d+)/), b = (m[3] || "").match(/behind (\d+)/);
        out.ahead = a ? +a[1] : 0; out.behind = b ? +b[1] : 0;
      }
      continue;
    }
    const x = s[0], y = s[1], file = s.slice(3);
    const f = { path: file, x, y };
    if (x === "R" || x === "C") f.orig = parts[++i];
    f.kind = x === "?" ? "new" : (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) ? "conflict"
      : (x === "D" || y === "D") ? "deleted" : (x === "A") ? "added" : (x === "R") ? "renamed" : "modified";
    f.staged = x !== " " && x !== "?";
    out.files.push(f);
    if (out.files.length >= 1000) { out.truncated = true; break; }
  }
  // 每个文件的增删行数（工作区对 HEAD；新文件按行数算）
  const ns = await git(root, ["diff", "HEAD", "--numstat", "-z"]);
  if (!ns.code) {
    const map = new Map();
    for (const rec of ns.out.split("\0")) { const m = rec.match(/^(\d+|-)\t(\d+|-)\t(.+)$/); if (m) map.set(m[3], [m[1], m[2]]); }
    for (const f of out.files) { const n = map.get(f.path); if (n) { f.add = n[0] === "-" ? null : +n[0]; f.del = n[1] === "-" ? null : +n[1]; } }
  }
  // 未跟踪文件的行数只用于 +N 展示。给总读取量封顶，别让浏览一个含很多大文件的目录把事件循环同步卡死
  // （审查 11-05：1000 个 2MB 文件 ≈ 2GB 同步读）
  let readBudget = 8 << 20;
  for (const f of out.files) if (f.kind === "new" && f.add == null && readBudget > 0) {
    // 只数普通文件、不跟软链：未跟踪的软链指向 /dev/zero 时 stat 报 0 字节，一读就读不完（11-03 审查 L-7）
    try {
      const st = fs.lstatSync(path.join(root, f.path));
      if (st.isFile() && st.size < 2 << 20 && st.size <= readBudget) {
        readBudget -= st.size;
        const t = fs.readFileSync(path.join(root, f.path));
        f.add = t.includes(0) ? null : (t.length ? t.toString("utf8").split("\n").length - (t[t.length - 1] === 10 ? 1 : 0) : 0);
        f.del = 0; f.binary = t.includes(0);
      }
    } catch {}
  }
  return out;
}

async function handleGit(req, res, p, u) {
  const q = (k) => u.searchParams.get(k) || "";
  const body = req.method === "POST" ? JSON.parse((await readBody(req)) || "{}") : {};
  const act = p.slice("/api/git/".length);
  const repo = await gitRepo(req.method === "POST" ? body.dir : q("dir"));
  // 还不是仓库：只允许「建一个」（私有目录除外）
  if (repo.notRepo && act === "init" && req.method === "POST") {
    if (gitPrivate(repo.dir)) return sendJson(res, 403, { error: "forbidden" });
    const r = await git(repo.dir, ["init"]);
    log(`[git] 新建仓库 ${repo.dir}`);
    return sendJson(res, r.code ? 500 : 200, r.code ? { error: r.err } : { ok: true, root: repo.dir });
  }
  if (repo.error) {
    // status 照旧 200 + notRepo，面板好显示“在这里建仓库”；其它动作（推送/提交/丢弃/切换）回 409。
    // 以前一律 200，api() 当成成功，界面会提示“完成”（196 Git 域第 4 条）
    const code = repo.status || (repo.notRepo ? (act === "status" ? 200 : 409) : 400);
    return sendJson(res, code, { error: repo.error, notRepo: !!repo.notRepo, dir: repo.dir,
      message: repo.notRepo && act !== "status" ? tz("这个文件夹已经不是 git 仓库了") : undefined });
  }
  const root = repo.root;

  if (act === "status") return sendJson(res, 200, await gitStatus(root));

  if (act === "diff") {
    // file 为空 = 整个工作区；commit 有值 = 那次提交里的改动
    const commit = q("commit"), file = q("file") ? gitRel(root, q("file")) : "";
    if (q("file") && file == null) return sendJson(res, 400, { error: "outside repo" });
    let r;
    if (commit) {
      if (!/^[0-9a-f]{4,64}$/i.test(commit)) return sendJson(res, 400, { error: "bad commit" });
      r = await git(root, ["show", "--format=", "--patch", "-M", commit, ...(file ? ["--", file] : [])]);
    } else {
      const st = file ? await git(root, ["status", "--porcelain=v1", "-z", "--", file]) : null;
      if (st && st.out.startsWith("??")) r = await git(root, ["diff", "--no-index", "--", "/dev/null", file]);
      else {
        const head = await git(root, ["rev-parse", "--verify", "-q", "HEAD"]);
        // 还没有第一次提交：和空树比（看的是工作区现在的样子）。以前用 --cached 只看暂存那份，暂存后又改过的文件
        // 对比里是旧的、提交时 add -A 进去的却是新的（#146-2）。sha256 仓库的空树是另一个哈希
        let base = "HEAD";
        if (head.code) { const fmt = await git(root, ["rev-parse", "--show-object-format"]); base = fmt.out.trim() === "sha256" ? EMPTY_TREE_256 : EMPTY_TREE; }
        r = await git(root, ["diff", base, "-M", ...(file ? ["--", file] : [])]);
      }
      if (r.code === 1 && r.out) r.code = 0;            // --no-index 有差异时退出码是 1
    }
    // 输出太大被中途杀掉时，把已经拿到的部分按截断返回：以前直接 500，“只显示前一部分”的提示永远走不到（196 Git 域第 10 条）
    if (r.code && !r.over) return sendJson(res, 500, { error: r.err });
    return sendJson(res, 200, { root, file, commit, diff: r.out.slice(0, GIT_MAX), truncated: !!r.over || r.out.length > GIT_MAX });
  }

  if (act === "log") {
    const n = Math.min(200, Math.max(1, +q("n") || 50)), skip = Math.max(0, +q("skip") || 0);
    const file = q("file") ? gitRel(root, q("file")) : "";
    const r = await git(root, ["log", `-n${n}`, `--skip=${skip}`, "--format=%H%x1f%h%x1f%an%x1f%at%x1f%s%x1f%D%x1e", ...(file ? ["--follow", "--", file] : [])]);
    if (r.code) {
      // 真的是还没有提交才回空列表；仓库坏了、没权限这类失败不能画成“还没有提交记录”（196 Git 域第 3 条）
      if (/does not have any commits|no commits yet/i.test(r.err)) return sendJson(res, 200, { root, commits: [], more: false });
      return sendJson(res, 500, { error: r.err || tz("读不出提交历史") });
    }
    const commits = r.out.split("\x1e").map((s) => s.trim()).filter(Boolean).map((s) => {
      const [hash, short, author, at, subject, refs] = s.split("\x1f");
      return { hash, short, author, at: +at * 1000, subject, refs: refs || "" };
    });
    return sendJson(res, 200, { root, commits, more: commits.length === n });
  }

  if (act === "show") {
    const c = q("commit");
    if (!/^[0-9a-f]{4,64}$/i.test(c)) return sendJson(res, 400, { error: "bad commit" });
    const meta = await git(root, ["show", "-s", "--format=%H%x1f%an%x1f%ae%x1f%at%x1f%B", c]);
    if (meta.code) return sendJson(res, 404, { error: meta.err });
    const [hash, author, email, at, message] = meta.out.split("\x1f");
    // 合并提交用 show 默认只给组合 diff（常常是空的），历史详情就成了“没有文件”。
    // 有父提交就按第一父比较；普通提交这样与 show 等价（196 Git 域第 7 条）
    const par = await git(root, ["rev-parse", "-q", "--verify", c + "^1"]);
    const base = par.code ? "" : par.out.trim();
    const ns = base ? await git(root, ["diff", "--numstat", "-M", "-z", base, c])
      : await git(root, ["show", "--format=", "--numstat", "-M", "-z", c]);
    const nm = base ? await git(root, ["diff", "--name-status", "-M", "-z", base, c])
      : await git(root, ["show", "--format=", "--name-status", "-M", "-z", c]);
    // 文件列表读失败不能静默画成“没有文件”（196 Git 域第 11 条）
    if (ns.code || nm.code) return sendJson(res, 500, { error: tz("读不出这次提交的文件列表") });
    const files = [];
    const a = nm.out.split("\0").filter((x) => x !== "");
    for (let i = 0; i < a.length; i++) {
      const s = a[i][0];
      const f = { status: s, path: a[++i] };
      if (s === "R" || s === "C") { f.orig = f.path; f.path = a[++i]; }
      files.push(f);
    }
    const nums = ns.out.split("\0");
    for (const rec of nums) { const m = rec.match(/^(\d+|-)\t(\d+|-)\t(.*)$/); if (!m) continue; const f = files.find((x) => x.path === m[3]) || files.find((x) => !("add" in x)); if (f) { f.add = m[1] === "-" ? null : +m[1]; f.del = m[2] === "-" ? null : +m[2]; } }
    return sendJson(res, 200, { root, hash, author, email, at: +at * 1000, message: (message || "").trim(), files });
  }

  if (act === "branches") {
    const r = await git(root, ["for-each-ref", "--sort=-committerdate",
      "--format=%(refname)%1f%(refname:short)%1f%(upstream:short)%1f%(upstream:track)%1f%(objectname:short)%1f%(committerdate:unix)%1f%(HEAD)%1f%(contents:subject)", "refs/heads", "refs/remotes"]);
    if (r.code) return sendJson(res, 500, { error: r.err });
    const local = [], remote = [];
    for (const l of r.out.split("\n")) {
      if (!l) continue;
      const [ref, name, upstream, track, hash, at, head, subject] = l.split("\x1f");
      const b = { name, upstream, hash, at: +at * 1000, subject: (subject || "").slice(0, 120) };
      if (ref.startsWith("refs/heads/")) {
        const a = (track || "").match(/ahead (\d+)/), be = (track || "").match(/behind (\d+)/);
        local.push({ ...b, current: head === "*", ahead: a ? +a[1] : 0, behind: be ? +be[1] : 0, gone: /gone/.test(track || "") });
      } else if (!ref.endsWith("/HEAD")) remote.push(b);
    }
    // 远端分支里已经有本地对应的就不重复列
    const tracked = new Set(local.map((b) => b.upstream).filter(Boolean));
    const rem = await git(root, ["remote"]);
    return sendJson(res, 200, { root, local, remote: remote.filter((b) => !tracked.has(b.name)), remotes: rem.out.split("\n").filter(Boolean) });
  }

  if (req.method !== "POST") return sendJson(res, 404, { error: "unknown" });

  // 下面都会照仓库配置执行命令（过滤器、钩子、sshCommand…）：仓库自己配了这类东西，先让用户确认
  if (["fetch", "pull", "push", "switch", "commit", "discard"].includes(act)) {
    const g = await gitGate(root, body);
    if (g) return sendJson(res, 409, g);
  }

  if (act === "fetch" || act === "pull" || act === "push") {
    const st = await gitStatus(root);
    if (st.error) return sendJson(res, 500, { error: st.error });
    let args;
    if (act === "fetch") args = ["fetch", "--prune", "--all"];
    else if (act === "pull") {
      if (!st.upstream) return sendJson(res, 409, { error: "no_upstream", message: tz("当前分支没有对应的远端分支，先推送一次建立关联。") });
      if (st.files.some((f) => f.kind === "conflict")) return sendJson(res, 409, { error: "conflict", message: tz("还有没解决的冲突，先处理完再拉取。") });
      args = ["pull", "--ff-only"];      // 只快进：分叉了就停下说清楚，不替用户做合并
    } else {
      if (!st.branch || st.branch === "HEAD (no branch)")     /* git status -b 游离时固定这么写；header、HEAD-notes 是正常分支（#148-4） */ return sendJson(res, 409, { error: "detached", message: tz("现在不在任何分支上，先切到一个分支再推送。") });
      if (st.upstream) args = ["push"];
      else {
        const rem = (await git(root, ["remote"])).out.split("\n").filter(Boolean);
        if (!rem.length) return sendJson(res, 409, { error: "no_remote", message: tz("这个仓库还没有设置远端（remote）。") });
        const to = rem.includes("origin") ? "origin" : rem[0];
        // 远端名来自仓库配置（别人给的仓库能手写成 --receive-pack=… 这种）：只收普通名字，再用 -- 隔开参数
        if (!/^[A-Za-z0-9._/-]+$/.test(to) || to.startsWith("-") || st.branch.startsWith("-")) return sendJson(res, 409, { error: "bad_remote", message: tz("远端名不合法") });
        args = ["push", "-u", "--", to, st.branch];       // 第一次推：顺便建立关联，以后直接推/拉
      }
    }
    const t0 = Date.now();
    const r = await gitNet(root, args);
    log(`[git] ${act} ${r.code ? "失败" : "完成"}（${Date.now() - t0}ms）@ ${root}`);
    if (r.code) {
      const human = gitNetHuman(r.err + "\n" + r.out);
      const code = /Not possible to fast-forward|diverg/i.test(r.err) ? "diverged" : /\[rejected\]|non-fast-forward|fetch first/i.test(r.err) ? "rejected" : "";
      return sendJson(res, 500, { error: human || r.err.split("\n").slice(-3).join("\n") || tz("失败"), code, detail: (r.err || r.out).slice(-2000) });
    }
    const after = await gitStatus(root);
    const msg = act === "fetch" ? (after.behind ? tz("已抓取：远端有 {n} 个新提交", { n: after.behind }) : tz("已抓取：没有新提交"))
      : act === "pull" ? (/Already up to date/i.test(r.out) ? tz("已经是最新的") : tz("已拉取"))
      : (/Everything up-to-date/i.test(r.err) ? tz("没有要推送的提交") : tz("已推送"));
    return sendJson(res, 200, { ok: true, message: msg, ahead: after.ahead, behind: after.behind, upstream: after.upstream });
  }

  if (act === "switch") {
    const name = String(body.branch || "").trim();
    // 分支名照 git check-ref-format 的规矩挡一遍，免得把奇怪参数传进命令行
    if (!name || name.startsWith("-") || /[\s~^:?*\[\\]|\.\.|@\{|\/\/|\.lock$|\/$|\.$/.test(name)) return sendJson(res, 400, { error: tz("分支名不合法") });
    const create = !!body.create;
    const st = await gitStatus(root);
    // status 失败时 st.files 不存在，以前这里抛 TypeError 变成 500（196 Git 域第 9 条）
    if (st.error) return sendJson(res, 500, { error: st.error });
    if (st.files.some((f) => f.kind === "conflict")) return sendJson(res, 409, { error: tz("还有没解决的冲突，先处理完再切换。") });
    let r;
    if (create) r = await git(root, ["switch", "-c", name]);
    else {
      // 只在远端有：git switch 会自动建一个跟踪它的本地分支（origin/foo → foo）
      const local = await git(root, ["rev-parse", "--verify", "-q", "refs/heads/" + name]);
      const m = name.match(/^([^/]+)\/(.+)$/);
      if (local.code && m) {
        const isRemote = await git(root, ["rev-parse", "--verify", "-q", "refs/remotes/" + name]);
        r = isRemote.code ? await git(root, ["switch", name]) : await git(root, ["switch", "--track", name]);
      } else r = await git(root, ["switch", name]);
    }
    if (r.code) return sendJson(res, 409, { error: gitNetHuman(r.err) || r.err.split("\n").slice(0, 4).join("\n") });
    const cur = await git(root, ["branch", "--show-current"]);
    log(`[git] ${create ? "新建并切到" : "切到"} ${cur.out.trim()} @ ${root}`);
    // 没提交的改动会跟着带过去（git 允许时）——告诉用户一声
    const carried = st.files.length;
    return sendJson(res, 200, { ok: true, branch: cur.out.trim(), message: carried ? tz("已切到 {b}（{n} 个没提交的改动一起带过来了）", { b: cur.out.trim(), n: carried }) : tz("已切到 {b}", { b: cur.out.trim() }) });
  }

  if (act === "commit") {
    const msg = String(body.message || "").trim();
    if (!msg) return sendJson(res, 400, { error: tz("写一句提交说明") });
    // 不给 files（null）= 全部提交；给了就只提交这些：有一项不在仓库里、或一项都没有，都直接拒绝，
    // 不能悄悄退化成全仓提交（#106 07-011）
    let files = null, olds = [];
    if (Array.isArray(body.files)) {
      files = body.files.map((f) => gitRel(root, String(f)));
      if (!files.length) return sendJson(res, 400, { error: tz("没选要提交的文件") });
      if (files.some((f) => !f)) return sendJson(res, 400, { error: tz("要提交的文件不在这个仓库里") });
      // 选了一个暂存的重命名：旧路径的删除要一起提交，不然旧文件留在提交里、删除还挂在暂存区（#106 07-003）
      const ren = await gitRenames(root);
      if (!ren) return sendJson(res, 500, { error: tz("读不出仓库的改动列表，没有提交") });
      olds = files.filter((f) => ren.has(f)).map((f) => ren.get(f)).filter((o) => !files.includes(o));
    }
    // 冲突没解决时不能提交：以前只有 pull/switch 查这道，提交路径会把 <<<<<<< 一起提交（0.6.10 审计 195-S.2）
    const st = await gitStatus(root);
    if (st.error) return sendJson(res, 500, { error: st.error });
    if (st.files.some((f) => f.kind === "conflict")) return sendJson(res, 409, { error: "conflict", message: tz("还有没解决的冲突，先处理完再提交。") });
    // 合并进行中不能带路径提交（git 会拒绝半截提交）。全选时按无路径提交，只选一部分则直接说清楚
    const merging = !(await git(root, ["rev-parse", "-q", "--verify", "MERGE_HEAD"])).code;
    if (files && merging) {
      const sel = new Set(files);
      if (st.files.some((f) => !sel.has(f.path))) return sendJson(res, 409, { error: "merge_partial", message: tz("合并还没提交：要么把全部改动一起提交，要么先撤销不想提交的改动。") });
    }
    const who = await git(root, ["config", "user.email"]);
    if (!who.out.trim()) return sendJson(res, 409, { error: "no_identity", message: tz("还没设置 git 的名字和邮箱（提交记录里署名用）。") });
    const add = files ? await git(root, ["add", "-A", "--", ...files]) : await git(root, ["add", "-A"]);
    if (add.code) return sendJson(res, 500, { error: add.err });
    const r = await git(root, ["commit", "-F", "-", ...(files && !merging ? ["--", ...files, ...olds] : [])], { input: msg + "\n" });
    if (r.code) return sendJson(res, 500, { error: r.err || r.out.trim() });
    const h = await git(root, ["rev-parse", "--short", "HEAD"]);
    log(`[git] 提交 ${h.out.trim()} @ ${root}`);
    return sendJson(res, 200, { ok: true, hash: h.out.trim(), message: tz("已提交 {hash}", { hash: h.out.trim() }) });
  }

  if (act === "identity") {
    const name = String(body.name || "").trim(), email = String(body.email || "").trim();
    if (!name || !/^[^@\s]+@[^@\s]+$/.test(email)) return sendJson(res, 400, { error: tz("名字和邮箱都要填") });
    await git(root, ["config", "--global", "user.name", name]);
    await git(root, ["config", "--global", "user.email", email]);
    return sendJson(res, 200, { ok: true });
  }

  if (act === "discard") {
    // 撤销一个文件的改动：改回上次提交时的样子；新文件（没被 git 记录过的）直接删掉
    const file = gitRel(root, String(body.file || ""));
    if (!file) return sendJson(res, 400, { error: "file required" });
    const st = await git(root, ["status", "--porcelain=v1", "-z", "--", file]);
    // git 失败时 out 也是空的：以前当成“没有改动”假报成功（196 Git 域第 9 条）
    if (st.code) return sendJson(res, 500, { error: st.err || tz("读不出这个文件的状态") });
    if (!st.out) return sendJson(res, 200, { ok: true, message: tz("没有改动") });
    if (st.out.startsWith("??")) {
      try { fs.rmSync(path.join(root, file), { force: true }); } catch (e) { return sendJson(res, 500, { error: e.message }); }
    } else {
      // 上次提交里没有这个路径（已暂存的新文件、重命名的新名字，或还没有任何提交）：改回去就是没有它 ——
      // 取消跟踪再删掉，跟没跟踪过的新文件一样；重命名还要把旧文件从上次提交里取回来（#106 07-004）
      const inHead = !(await git(root, ["cat-file", "-e", "HEAD:" + file])).code;
      if (inHead) {
        const r = await git(root, ["checkout", "HEAD", "--", file]);
        if (r.code) return sendJson(res, 500, { error: r.err });
      } else {
        const ren = await gitRenames(root);
        if (!ren) return sendJson(res, 500, { error: tz("读不出仓库的改动列表，没有撤销") });
        const orig = ren.get(file);
        // 先把会半路失败的情形挡在动手之前：拆了一半（新名删了、旧名没回来）比不撤更糟
        let isDir = false; try { isDir = fs.lstatSync(path.join(root, file)).isDirectory(); } catch {}
        if (isDir) return sendJson(res, 400, { error: tz("一次只能撤销一个文件") });
        if (orig && fs.existsSync(path.join(root, orig))) return sendJson(res, 409, { error: tz("{f} 那里已经有个文件了，先挪开再撤销", { f: orig }) });
        const r = await git(root, ["rm", "--cached", "-f", "-q", "--", file]);
        if (r.code) return sendJson(res, 500, { error: r.err });
        try { fs.rmSync(path.join(root, file), { force: true }); } catch (e) { return sendJson(res, 500, { error: e.message }); }
        if (orig) {
          const o = await git(root, ["checkout", "HEAD", "--", orig]);
          if (o.code) return sendJson(res, 500, { error: o.err });
        }
      }
    }
    log(`[git] 撤销 ${file} @ ${root}`);
    return sendJson(res, 200, { ok: true, message: tz("已撤销") });
  }

  return sendJson(res, 404, { error: "unknown" });
}

// ── 路由：/api/git/ ──
export async function routeGit(req, res, u, p) {
  if (p.startsWith("/api/git/")) return handleGit(req, res, p, u);
  return NEXT;
}
export const _gitForTest = git;   // 只给测试用
export const _gitRisksForTest = gitRisks;
