import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { CFG, HERE, PATHS, PREFIX, log } from "./config.mjs";
import { claudeEnv, ensureShell, killTree, termKeyFile } from "./claude.mjs";
import { NEXT, readBody, sendJson } from "./http.mjs";

// ── 应用内终端 ────────────────────────────────────────────────────────
// node 没有 pty：cccodroid 自带原生小程序 ptyhost（APK 原生库目录里的 libccptyhost.so，经 CCAPP_PTYHOST 交来；源码 android/native/ptyhost.c）；
// 开发端没有 lib/，退回到同一协议的 python3 pty 版。协议：
//   ptyhost <rows> <cols> <程序> [参数…]；stdin→pty，pty→stdout，fd 3 一行 "rows cols" 改窗口大小。
// 输出留一段环形缓冲：界面重开 / 断线重连时先回放，再接着推实时输出（SSE）。
const TERM_MAX = 8;
const TERM_RING = 256 * 1024;
export const TERMS = new Map();
let termSeq = 0;
const nextTermSeq = () => ++termSeq;
const PY_PTY = `import os,sys,pty,select,signal,struct,fcntl,termios,errno,time
r,c=int(sys.argv[1]),int(sys.argv[2])
try: os.fstat(3); ctl=3
except OSError: ctl=-1
pid,m=pty.fork()
if pid==0:
  if ctl>=0: os.close(ctl)
  try: os.execvp(sys.argv[3],sys.argv[3:])
  except Exception as e: sys.stderr.write("exec: %s\\r\\n"%e); os._exit(127)
def size(a,b):
  fcntl.ioctl(m,termios.TIOCSWINSZ,struct.pack("HHHH",a or 24,b or 80,0,0))
  try: os.killpg(pid,signal.SIGWINCH)
  except OSError: pass
size(r,c)
fds=[m,0]+([ctl] if ctl>=0 else []); line=b""
while True:
  try: rd,_,_=select.select(fds,[],[])
  except InterruptedError: continue
  if m in rd:
    try: d=os.read(m,16384)
    except OSError: d=b""
    if not d: break
    os.write(1,d)
  if 0 in rd:
    d=os.read(0,16384)
    if d: os.write(m,d)
    else:
      for s in (signal.SIGHUP,signal.SIGKILL):
        try: os.killpg(pid,s)
        except OSError: pass
        time.sleep(0.5)
      sys.exit(129)
  if ctl in rd:
    d=os.read(ctl,4096)
    if not d: fds.remove(ctl); continue
    line+=d
    while b"\\n" in line:
      l,line=line.split(b"\\n",1)
      try: a,b=map(int,l.split()); size(a,b)
      except ValueError: pass
_,st=os.waitpid(pid,0)
sys.exit(os.waitstatus_to_exitcode(st) if hasattr(os,"waitstatus_to_exitcode") else 0)
`;

function ptyCommand() {
  const own = process.env.CCAPP_PTYHOST || path.join(HERE, "lib", "ptyhost");
  if (fs.existsSync(own)) return [own];
  const py = [PREFIX && path.join(PREFIX, "bin", "python3"), path.join(CFG.runtime, "..", "devbin", "python3")]
    .find((p) => p && fs.existsSync(p));
  return py ? [py, "-c", PY_PTY] : null;
}

// ── 应用内终端：新开 / 读写 / 关闭 ──────────────────────────────────
export function termEnv() {
  const env = claudeEnv();
  delete env.CCAPP_NODUMP;     // 终端里的东西是机主自己的，不设不可转储（见 claude.mjs claudeEnv）
  for (const k of ["CI", "NO_COLOR", "CLAUDE_CODE_SHELL", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CCAPP_RUN"]) delete env[k];   // 终端里用户自己起的东西不算 claude 运行，网关重启时别当孤儿清
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  // C.UTF-8 是 glibc 内建的（开发端的 bash 是 glibc 版，没带 locale 数据）；不设的话 readline 把中文显示成 \344\270…
  if (!/utf-?8/i.test(env.LC_ALL || env.LANG || "")) env.LANG = "C.UTF-8";
  // …而它在哪儿找 locale 是编译期写死的：开发端的 locale 数据在工具链的 glibc 目录里，得用 LOCPATH 指过去
  const loc = path.join(PATHS.toolchain, "dshtc", "prefix", "glibc", "lib", "locale");
  if (!PREFIX && !env.LOCPATH && fs.existsSync(loc)) env.LOCPATH = loc;
  env.CCAPP_TERMINAL = "1";
  // 终端里直接敲 claude 也用应用配的这家：claudeEnv 不带密钥（防 env 泄漏），这里只给钥匙文件的路径，见 termKeyFile
  const kf = termKeyFile();
  if (kf) env.CCAPP_KEY_FILE = kf; else delete env.CCAPP_KEY_FILE;
  // 经加载器：claudeEnv 摘掉了 LD_PRELOAD（给 glibc 用的），终端这边全是 bionic，得挂回 termux-exec，ptyhost 才拉得起 shell
  if (process.env.CCAPP_BIONIC_PRELOAD) env.LD_PRELOAD = process.env.CCAPP_BIONIC_PRELOAD;
  return env;
}

function termInfo(t) {
  return { id: t.id, title: t.title, cols: t.cols, rows: t.rows, created: t.created, alive: t.alive, code: t.code };
}

function termNew({ cols, rows, login, cwd: want } = {}) {
  for (const [id, t] of TERMS) if (!t.alive) TERMS.delete(id);   // 已退出的不占名额
  // 满了先清掉已退出的（留着只是给用户看最后的输出）
  if (TERMS.size >= TERM_MAX) for (const [k, x] of TERMS) if (!x.alive && TERMS.size >= TERM_MAX) TERMS.delete(k);
  if (TERMS.size >= TERM_MAX) return { error: `too many terminals (${TERM_MAX})` };
  const pc = ptyCommand();
  if (!pc) return { error: "no pty helper (ptyhost / python3)" };
  cols = Math.max(20, Math.min(500, cols | 0 || 80));
  rows = Math.max(5, Math.min(300, rows | 0 || 24));
  const shell = ensureShell();
  // want：从项目页「在终端打开」带来的目录；不是目录就照旧落在工作区
  let cwd = typeof want === "string" && want ? want : CFG.workspace;
  try { if (!fs.statSync(cwd).isDirectory()) cwd = CFG.workspace; } catch { cwd = CFG.workspace; }
  try { if (!fs.statSync(cwd).isDirectory()) cwd = CFG.home; } catch { cwd = CFG.home; }
  // login：给手动登录用的终端。环境和账户登录一样清掉第三方厂商的地址 / 密钥 / 模型，
  // 开好后替用户敲下 claude auth login —— 授权码由用户贴给 claude 自己的提示，网关只当字节通道
  const env = termEnv();
  if (login) for (const k of Object.keys(env)) if (/^ANTHROPIC_|^CCAPP_KEY_FILE$/.test(k)) delete env[k];
  const child = spawn(pc[0], [...pc.slice(1), String(rows), String(cols), shell], {
    cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe", "pipe"],
  });
  if (login) setTimeout(() => { try { child.stdin.write("claude auth login" + (login === "console" ? " --console" : "") + "\r"); } catch {} }, 400);
  const seq = nextTermSeq();
  const id = seq.toString(36) + crypto.randomBytes(8).toString("hex");   // 别靠 Math.random 那 20 来位（审查 低20）
  const t = {
    id, title: `${path.basename(shell) === "bash" ? "bash" : "sh"} ${seq}`, cols, rows,
    created: Date.now(), alive: true, code: null, child,
    buf: "", subs: new Set(), dec: new StringDecoder("utf8"),
  };
  const out = (s) => {
    if (!s) return;
    t.buf += s;
    if (t.buf.length > TERM_RING) t.buf = t.buf.slice(t.buf.length - TERM_RING);
    for (const r of t.subs) sseSend(r, "o", s, t);
  };
  child.stdout.on("data", (d) => out(t.dec.write(d)));
  child.stderr.on("data", (d) => out(d.toString()));     // 只有 ptyhost 自己的报错走这里
  child.stdin.on("error", () => {});
  child.stdio[3]?.on("error", () => {});
  const ended = (code) => {
    if (!t.alive) return;
    out(t.dec.end());
    t.alive = false;
    t.code = code;
    for (const r of t.subs) { sseSend(r, "exit", { code: t.code }); try { r.end(); } catch {} }
    t.subs.clear();
  };
  // 起不来（ENOENT/EACCES）时只有 error 和 close、没有 exit：这里也得收尾，不然占着名额永远「活着」（审查 v0.5.3 B4）
  child.on("error", (e) => { out(`\r\n[${e.message}]\r\n`); if (child.pid == null) ended(127); });
  // exit 时管道里可能还有没读完的尾巴：等 close（stdio 都关了）再收尾，最后几行才送得到（#97 02-006）。
  // 管道万一被漏到别的进程里一直不关，1 秒后照样收尾
  child.on("exit", (code, sig) => { const c = code ?? (sig ? 128 : null); setTimeout(() => ended(c), 1000).unref?.(); child.once("close", () => ended(c)); });
  TERMS.set(id, t);
  log(`[term] ${id} 打开 ${cols}x${rows} via ${path.basename(pc[0])}`);
  return { ok: true, term: termInfo(t) };
}

// 订阅者读得太慢（WebView 在后台被冻住）而终端一直在出字：待发的超过 8MB 就断掉它，前端重连时拿回放环续上，
// 别让一个冻住的连接把网关内存撑爆（审查 v0.5.20 02-004；事件总线同一规则见 bus.mjs）
const SSE_MAX = 8 * 1024 * 1024;
function sseSend(res, ev, data, t) {
  try {
    if (res.writableLength > SSE_MAX) { if (t) t.subs.delete(res); res.destroy(); return; }
    res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {}
}

function termKill(t) {
  if (!t) return;
  if (t.alive) { try { t.child.stdin.end(); } catch {} setTimeout(() => { if (t.alive) killTree(t.child); }, 1500); }
  TERMS.delete(t.id);
  for (const r of t.subs) { try { r.end(); } catch {} }
  t.subs.clear();
}

async function handleTerm(req, res, p) {
  if (req.method === "GET" && p === "/api/term/list") {
    return sendJson(res, 200, { terms: [...TERMS.values()].map(termInfo), available: !!ptyCommand() });
  }
  if (req.method === "POST" && p === "/api/term/new") {
    let b = {};
    try { b = JSON.parse(await readBody(req) || "{}"); } catch {}
    const r = termNew(b);
    return sendJson(res, r.error ? 400 : 200, r);
  }
  const m = p.match(/^\/api\/term\/([0-9a-z]+)\/(stream|in|resize|kill|rename)$/);
  if (!m) return sendJson(res, 404, { error: "not found" });
  const t = TERMS.get(m[1]);
  if (!t) return sendJson(res, 404, { error: "no such terminal" });
  const op = m[2];
  if (req.method === "GET" && op === "stream") {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.socket?.setNoDelay?.(true);
    sseSend(res, "replay", t.buf);
    if (!t.alive) { sseSend(res, "exit", { code: t.code }); return res.end(); }
    t.subs.add(res);
    const ka = setInterval(() => { try { res.write(": k\n\n"); } catch {} }, 25000);
    req.on("close", () => { clearInterval(ka); t.subs.delete(res); });
    return;
  }
  if (req.method !== "POST") return sendJson(res, 405, { error: "method" });
  const body = await readBody(req);
  if (op === "in") {
    if (t.alive) try { t.child.stdin.write(body); } catch {}
    return sendJson(res, 200, { ok: true });
  }
  let b = {};
  try { b = JSON.parse(body || "{}"); } catch {}
  if (op === "resize") {
    t.cols = Math.max(20, Math.min(500, b.cols | 0 || t.cols));
    t.rows = Math.max(5, Math.min(300, b.rows | 0 || t.rows));
    if (t.alive) try { t.child.stdio[3].write(`${t.rows} ${t.cols}\n`); } catch {}
    return sendJson(res, 200, { ok: true });
  }
  if (op === "rename") {
    t.title = String(b.title || "").slice(0, 40) || t.title;
    return sendJson(res, 200, { ok: true });
  }
  if (op === "kill") { termKill(t); return sendJson(res, 200, { ok: true }); }
}

// ── 路由：/api/term/ ──
export async function routeTerminal(req, res, u, p) {
  // ── 应用内终端 ──
  if (p.startsWith("/api/term/")) return handleTerm(req, res, p);
  return NEXT;
}
export const _termForTest = { sseSend };   // 只给测试用
