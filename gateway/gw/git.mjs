import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { CFG, log, tz } from "./config.mjs";
import { realWorkspace } from "./sessionops.mjs";
import { NEXT, readBody, sendJson } from "./http.mjs";
import { termEnv } from "./terminal.mjs";

/** 终端里的环境：与 claude 的工具子进程同一套 PATH / TMPDIR / terminfo，但它是给人用的 —— 要颜色，不要 CI 标记。 */
// ── git 可视化：改了哪些文件、逐行对比、提交历史、提交 / 撤销 ──────────────
// 只是 git 命令的薄壳，用终端同一套环境（PATH 里有 git）。仓库位置由前端给（文件面板当前目录 / 编辑器里的文件）
const GIT_MAX = 768 * 1024;
// 文件面板一进目录就自动跑 status/diff：仓库自带的配置不能借机执行命令（safe.directory=* 让本地配置一律被信任）。
// fsmonitor 全关；只读命令再把属性来源换成空树（仓库 .gitattributes 挂的 clean 过滤器 / diff 驱动不生效），diff 类关外部比较与 textconv。
// add/commit 是用户点的，不换属性来源——否则 LFS 之类的过滤器在提交时被跳过
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const GIT_RO = new Set(["status", "diff", "show", "log", "for-each-ref", "rev-parse", "remote", "branch"]);
function gitArgs(args) {
  const pre = ["-c", "core.quotePath=false", "-c", "color.ui=false", "-c", "core.fsmonitor=false"];
  if (!GIT_RO.has(args[0])) return [...pre, ...args];
  const extra = args[0] === "diff" || args[0] === "show" || args[0] === "log" ? ["--no-ext-diff", "--no-textconv"] : [];
  return [...pre, `--attr-source=${EMPTY_TREE}`, args[0], ...extra, ...args.slice(1)];
}
// GIT_LITERAL_PATHSPECS：前端给的都是确切文件名，report[1].txt 不能当通配把 report1.txt 一起撤销 / 提交（审查 B03）
// 超时整组杀：提交时的钩子是 git 的子孙，只杀 git 本身它们还会接着写文件、和用户重试撞在一起（审查 B20）。
// 新开进程组（spawn 的 detached；execFile 不认这个选项），到点 kill(-pid)；等 close（stdio 全关）才返回，等于等整组收尾
function git(cwd, args, { input, timeout = 30000, max = GIT_MAX } = {}) {
  return new Promise((resolve) => {
    let timedOut = false, spawnErr = null, over = false;
    const out = [], errs = []; let outLen = 0, errLen = 0;
    const c = spawn("git", gitArgs(args), { cwd, env: { ...termEnv(), GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_LITERAL_PATHSPECS: "1", LC_ALL: "C.UTF-8" }, detached: true, stdio: ["pipe", "pipe", "pipe"] });
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
      resolve({ code: timedOut || spawnErr || over ? (code || 1) : (code ?? 1), out: Buffer.concat(out).toString("utf8"), err: String(err || "").trim() });
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
    execFile("git", ["-c", "core.quotePath=false", "-c", "color.ui=false", "-c", "core.fsmonitor=false", ...args],
      { cwd: root, env: { ...termEnv(), GIT_TERMINAL_PROMPT: "0", LC_ALL: "C.UTF-8", ...env }, timeout: 180000, maxBuffer: 4 << 20, encoding: "utf8" },
      (err, out, errOut) => resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: out || "", err: (errOut || (err && err.killed ? "timeout" : err?.message) || "").trim() }));
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
function gitPrivate(d) {
  const under = (a, b) => { const r = path.relative(b, a); return r === "" || (!r.startsWith("..") && !path.isAbsolute(r)); };
  const real = (s) => { try { return fs.realpathSync(s); } catch { return s; } };
  const priv = [CFG.home, CFG.runtime].filter(Boolean).map(real);
  const ws = realWorkspace();
  // 在工作区里就放行；但工作区若就是 HOME（或它的上级），这条豁免作废
  if (ws && under(d, ws) && !priv.some((rr) => under(rr, ws))) return false;
  return priv.some((rr) => under(d, rr) || under(rr, d));
}
/** 仓库里的相对路径：前端给的可能是绝对路径，且 /sdcard 与 /storage/emulated/0 是同一处，按真实路径比。
 *  只解析所在目录、最后一级照字面留着：它自己是符号链接时，git 条目是链接本身，跟过去会撤销 / 删掉它指向的文件（审查 B02） */
function gitRel(root, f) {
  let a = path.isAbsolute(f) ? f : path.join(root, f);
  try { a = path.join(fs.realpathSync(path.dirname(a)), path.basename(a)); } catch {}
  const r = path.relative(root, a);
  return r.startsWith("..") || path.isAbsolute(r) ? null : r;
}

async function gitStatus(root) {
  const r = await git(root, ["status", "--porcelain=v1", "-z", "-b", "--untracked-files=all"]);
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
  for (const f of out.files) if (f.kind === "new" && f.add == null) {
    try { const st = fs.statSync(path.join(root, f.path)); if (st.size < 2 << 20) { const t = fs.readFileSync(path.join(root, f.path)); f.add = t.includes(0) ? null : (t.length ? t.toString("utf8").split("\n").length - (t[t.length - 1] === 10 ? 1 : 0) : 0); f.del = 0; f.binary = t.includes(0); } } catch {}
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
  if (repo.error) return sendJson(res, repo.status || (repo.notRepo ? 200 : 400), { error: repo.error, notRepo: !!repo.notRepo, dir: repo.dir });
  const root = repo.root;

  if (act === "status") return sendJson(res, 200, await gitStatus(root));

  if (act === "diff") {
    // file 为空 = 整个工作区；commit 有值 = 那次提交里的改动
    const commit = q("commit"), file = q("file") ? gitRel(root, q("file")) : "";
    if (q("file") && file == null) return sendJson(res, 400, { error: "outside repo" });
    let r;
    if (commit) {
      if (!/^[0-9a-f]{4,40}$/i.test(commit)) return sendJson(res, 400, { error: "bad commit" });
      r = await git(root, ["show", "--format=", "--patch", "-M", commit, ...(file ? ["--", file] : [])]);
    } else {
      const st = file ? await git(root, ["status", "--porcelain=v1", "-z", "--", file]) : null;
      if (st && st.out.startsWith("??")) r = await git(root, ["diff", "--no-index", "--", "/dev/null", file]);
      else {
        const head = await git(root, ["rev-parse", "--verify", "-q", "HEAD"]);
        r = await git(root, ["diff", ...(head.code ? ["--cached"] : ["HEAD"]), "-M", ...(file ? ["--", file] : [])]);
      }
      if (r.code === 1 && r.out) r.code = 0;            // --no-index 有差异时退出码是 1
    }
    if (r.code) return sendJson(res, 500, { error: r.err });
    return sendJson(res, 200, { root, file, commit, diff: r.out.slice(0, GIT_MAX), truncated: r.out.length > GIT_MAX });
  }

  if (act === "log") {
    const n = Math.min(200, Math.max(1, +q("n") || 50)), skip = Math.max(0, +q("skip") || 0);
    const file = q("file") ? gitRel(root, q("file")) : "";
    const r = await git(root, ["log", `-n${n}`, `--skip=${skip}`, "--format=%H%x1f%h%x1f%an%x1f%at%x1f%s%x1f%D%x1e", ...(file ? ["--follow", "--", file] : [])]);
    if (r.code) return sendJson(res, 200, { root, commits: [], error: /does not have any commits/.test(r.err) ? "" : r.err });
    const commits = r.out.split("\x1e").map((s) => s.trim()).filter(Boolean).map((s) => {
      const [hash, short, author, at, subject, refs] = s.split("\x1f");
      return { hash, short, author, at: +at * 1000, subject, refs: refs || "" };
    });
    return sendJson(res, 200, { root, commits, more: commits.length === n });
  }

  if (act === "show") {
    const c = q("commit");
    if (!/^[0-9a-f]{4,40}$/i.test(c)) return sendJson(res, 400, { error: "bad commit" });
    const meta = await git(root, ["show", "-s", "--format=%H%x1f%an%x1f%ae%x1f%at%x1f%B", c]);
    if (meta.code) return sendJson(res, 404, { error: meta.err });
    const [hash, author, email, at, message] = meta.out.split("\x1f");
    const ns = await git(root, ["show", "--format=", "--numstat", "-M", "-z", c]);
    const nm = await git(root, ["show", "--format=", "--name-status", "-M", "-z", c]);
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
      if (!st.branch || /^HEAD|no branch/i.test(st.branch)) return sendJson(res, 409, { error: "detached", message: tz("现在不在任何分支上，先切到一个分支再推送。") });
      if (st.upstream) args = ["push"];
      else {
        const rem = (await git(root, ["remote"])).out.split("\n").filter(Boolean);
        if (!rem.length) return sendJson(res, 409, { error: "no_remote", message: tz("这个仓库还没有设置远端（remote）。") });
        const to = rem.includes("origin") ? "origin" : rem[0];
        args = ["push", "-u", to, st.branch];       // 第一次推：顺便建立关联，以后直接推/拉
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
    const files = Array.isArray(body.files) ? body.files.map((f) => gitRel(root, String(f))).filter((f) => f != null) : null;
    const who = await git(root, ["config", "user.email"]);
    if (!who.out.trim()) return sendJson(res, 409, { error: "no_identity", message: tz("还没设置 git 的名字和邮箱（提交记录里署名用）。") });
    const add = files && files.length ? await git(root, ["add", "-A", "--", ...files]) : await git(root, ["add", "-A"]);
    if (add.code) return sendJson(res, 500, { error: add.err });
    const r = await git(root, ["commit", "-F", "-", ...(files && files.length ? ["--", ...files] : [])], { input: msg + "\n" });
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
    if (!st.out) return sendJson(res, 200, { ok: true, message: tz("没有改动") });
    if (st.out.startsWith("??")) {
      try { fs.rmSync(path.join(root, file), { force: true }); } catch (e) { return sendJson(res, 500, { error: e.message }); }
    } else {
      const head = await git(root, ["rev-parse", "--verify", "-q", "HEAD"]);
      const r = head.code ? await git(root, ["rm", "--cached", "-f", "-q", "--", file]) : await git(root, ["checkout", "HEAD", "--", file]);
      if (r.code) return sendJson(res, 500, { error: r.err });
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
