import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { CFG, GLIBC_PRELOAD, NO_BRIDGE, PATHS, PREFIX, glibcEnv, log, sleep } from "./config.mjs";
import { SETTINGS } from "./settings.mjs";
import { PROVIDER, keyOf } from "./providers.mjs";
import { cachedModels } from "./models.mjs";
import { fixedBaseUrl } from "./streamfix.mjs";
import { archiveHooks } from "./archive-core.mjs";
import { NEXT, readBody, sendJson } from "./http.mjs";

// ── 给 claude 造一个它认得的 shell ────────────────────────────────────
// 安卓既没有 /bin/sh 也没有 bash：claude 扫 /bin、/usr/bin 找 bash/zsh，
// 找不到就抛 "No suitable shell found"。它认 CLAUDE_CODE_SHELL 覆盖，
// 但会校验路径形态必须是 bash/zsh —— 于是造个名叫 bash 的包装转发给 mksh。
let SHELL_PATH = null;
export function ensureShell() {
  if (SHELL_PATH) return SHELL_PATH;
  // 开发端（旧布局）没有 CCAPP_SHELL：有 files/cbash/bash（glibc 版真 bash）就用它。
  // /system/bin/sh 是 mksh —— claude 的 shell 快照开头 unalias -a，会把 mksh 靠别名实现的 local 一起删掉，
  // 快照里的 grep/find/pkill 函数于是每次都报 "local: inaccessible or not found"。
  const cbash = path.join(CFG.runtime, "..", "cbash", "bash");
  const want = process.env.CCAPP_SHELL || (!PREFIX && fs.existsSync(cbash) ? cbash : "");
  const real = want && fs.existsSync(want) ? want : "/system/bin/sh";

  // 包一层再交给 claude，顺手卸掉 CLAUDE_CODE_EXECPATH：
  // claude 的 shell 快照把 grep/find 换成内置 ugrep/bfs，调法是 exec -a ugrep "$CLAUDE_CODE_EXECPATH" -G …，
  // 而这个变量 claude 填的是 process.execPath —— 我们经 glibc 加载器启动它，那就是 ld-linux-aarch64.so.1。
  // 加载器把 -G 当成程序名，于是 grep/find 全挂（"-G: cannot open shared object file"），
  // 模型就会退而用 env 之类的命令乱试。变量没了，快照里的函数自己会回落到 command grep / command find。
  const dir = PREFIX ? path.join(CFG.home, ".cache", "ccapp-shell") : path.join(CFG.runtime, "bin");
  const sh = path.join(dir, "bash");
  try {
    fs.mkdirSync(dir, { recursive: true });
    // 前缀布局再加一层：termux-exec。安卓没有 /usr/bin/env、/bin/bash，
    // 凡是 #!/usr/bin/env node|python3、#!/bin/bash 的脚本（npm 装的命令行、./configure、用户自己写的）
    // 直接执行都是 bad interpreter。termux-exec 在 execve 时把这些解释器改指到 $PREFIX/bin。
    // 必须在 bash 启动前就设上 —— 已经在跑的 bash 后来再 export 也救不了它自己的 exec（实测）。
    // 代价：glibc 程序继承到它会起不来（claude 本体就是），所以 app/bin/claude 包装里会先清掉。
    // 经加载器时用 termux-exec 的 linker 版（Env.java 给的 CCAPP_BIONIC_PRELOAD）：数据目录里的程序都改成经 linker64 起
    const tx = process.env.CCAPP_BIONIC_PRELOAD || (PREFIX ? path.join(PREFIX, "lib", "libtermux-exec-ld-preload.so") : "");
    const pre = tx && fs.existsSync(tx) ? 'export LD_PRELOAD="' + tx + '"\n' : "";
    const body = '#!/system/bin/sh\nunset CLAUDE_CODE_EXECPATH\n' + pre + 'exec "' + real + '" "$@"\n';
    let need = true;
    try { need = fs.readFileSync(sh, "utf8") !== body; } catch {}
    if (need) fs.writeFileSync(sh, body, { mode: 0o755 });
    fs.chmodSync(sh, 0o755);
    SHELL_PATH = sh;
  } catch (e) {
    log(`造 shell 包装失败: ${e.message}`);
    SHELL_PATH = "/system/bin/sh";
  }
  return SHELL_PATH;
}

// ── 本地 DNS 桥 ───────────────────────────────────────────────────────
// glibc 读不到安卓的 DNS 配置，域名解析必须由 bionic node 代劳。
export let bridgeProc = null, bridgeStarting = null;    // bridgeStarting：并发拉桥时共用同一次
export function bridgeAlive() {
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port: CFG.bridgePort, path: "/__ping", method: "GET", timeout: 800 },
      () => resolve(true)
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end();
  });
}

export async function ensureBridge() {
  if (NO_BRIDGE) return true;
  if (await bridgeAlive()) return true;
  // 并发拉桥会撞端口（第二个 EADDRINUSE 起来就死，还留下个指着死进程的 bridgeProc）。
  // 一条在拉，其余的都等同一条。
  if (bridgeStarting) return bridgeStarting;
  bridgeStarting = doStartBridge().finally(() => { bridgeStarting = null; });
  return bridgeStarting;
}

async function doStartBridge() {
  if (!fs.existsSync(PATHS.bridge)) { log(`桥脚本缺失: ${PATHS.bridge}`); return false; }
  log(`拉起本地桥 127.0.0.1:${CFG.bridgePort} → ${CFG.upstream}`);
  const proc = spawn(PATHS.node, [PATHS.bridge, CFG.upstream, String(CFG.bridgePort)], {
    env: { ...process.env, LD_LIBRARY_PATH: PATHS.nodeLib },
    stdio: ["ignore", "pipe", "pipe"],
  });
  bridgeProc = proc;
  proc.stdout.on("data", (d) => log(`[bridge] ${String(d).trim()}`));
  proc.stderr.on("data", (d) => log(`[bridge!] ${String(d).trim()}`));
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    if (await bridgeAlive()) { log("桥已就绪"); return true; }
    if (proc.exitCode !== null) break;      // 起崩了（多为端口占用）就别再白等 10 秒
  }
  log("桥启动超时/崩溃");
  return false;
}

/** 谁在占着桥端口？—— 用于处理不是我们拉起来的孤儿桥 */
function findBridgePids() {
  const out = [];
  try {
    for (const d of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(d)) continue;
      let c = "";
      try { c = fs.readFileSync(`/proc/${d}/cmdline`, "utf8").replace(/\0/g, " "); } catch { continue; }
      if (c.includes("localbridge.mjs") && c.includes(String(CFG.bridgePort))) out.push(Number(d));
    }
  } catch {}
  return out;
}

/** 换上游：**优先热切**，不重启桥。
 *  桥的上游原本是启动参数，所以换厂商必须重启桥 —— 而重启会掐断正在传输的流。
 *  新版桥开了个控制面 POST /__upstream，运行中改目标，正在跑的请求各自持有旧目标跑完。
 *  老桥不认这个面，就退回"杀掉重起"的老办法。 */
export async function setBridgeUpstream(url) {
  if (!url) return false;
  const ok = await new Promise((resolve) => {
    const body = JSON.stringify({ url });
    const req = http.request({
      host: "127.0.0.1", port: CFG.bridgePort, path: "/__upstream", method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      timeout: 1500,
    }, (r) => { r.resume(); r.on("end", () => resolve(r.statusCode === 200)); });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end(body);
  });
  if (ok) { log(`桥上游已热切 → ${url}`); return true; }

  log(`桥不支持热切换（老版本），改为重启桥 → ${url}`);
  try { if (bridgeProc) bridgeProc.kill(); } catch {}
  bridgeProc = null;
  // 端口上那个可能不是我们拉起来的（上一代网关被杀时留下的孤儿桥）。
  // 不认控制面的老桥只能靠杀，从 /proc 里把它揪出来。
  for (const pid of findBridgePids()) {
    log(`杀掉端口上的旧桥 pid=${pid}`);
    try { process.kill(pid, "SIGTERM"); } catch {}
  }
  // 等端口真的腾出来再拉新的，否则新桥一碰 8788 就 EADDRINUSE 自杀
  for (let i = 0; i < 20; i++) {
    await sleep(150);
    if (!(await bridgeAlive())) break;
  }
  return ensureBridge();
}

// ── claude 进程 ───────────────────────────────────────────────────────
/** 某个模型（缺省 = 全局设置里的）在某家（缺省 = 当前生效的）那边的真实参数（窗口 / 输出上限 / effort 档位）。
 *  那家的清单没拉过就用目录里写的 fallbackModels */
export function currentModelInfo(id = SETTINGS.model, p = PROVIDER) {
  const list = cachedModels(p);
  if (!Array.isArray(list) || !list.length) return {};
  if (!id) return list[0] || {};
  return list.find((m) => m.id === id) || list[0] || {};
}

/** o.model：这一轮用的模型（会话自己的、定时任务 / 项目指定的）；不给就按全局设置。
 *  档位映射、上下文窗口都跟着它走 —— 不然子代理、窗口还是全局那个模型的。
 *  o.provider：这一轮用的那家（会话钉在别家时）；不给就是全局生效的。地址、认证方式、密钥都按它 */
export function claudeEnv(o = {}) {
  const want = o.model !== undefined ? o.model : SETTINGS.model;
  const p = o.provider || PROVIDER;
  const other = p.id !== PROVIDER.id;
  const key = keyOf(p);
  const info = currentModelInfo(want, p);
  const env = {
    ...process.env,
    HOME: CFG.home,
    // 显式钉死临时目录。安卓上 /tmp 写不进（shell 属主 + SELinux），而工具链是从
    // Termux 搬来的，很多二进制里编译期写死了 /data/data/com.termux/files/usr/tmp
    // —— 那个目录在这台设备上根本不存在，回落过去就是一句 ENOENT。
    // 之前只靠从网关继承，网关怎么起的（MainActivity 还是 gw-swap.sh）就决定了有没有，
    // 太脆；这里自己钉死，claude 及其所有工具子进程就都有可写临时目录了。
    // cccodroid：用 $PREFIX/tmp —— 等长改写后，二进制里写死的默认临时目录正好就是它
    TMPDIR: PREFIX ? (fs.mkdirSync(path.join(PREFIX, "tmp"), { recursive: true }), path.join(PREFIX, "tmp")) : CFG.home,
    // 文件检查点：-p 模式默认不记，打开后每条用户消息前给 Edit/Write 要动的文件留底，「回退到这里」靠它（见 rewindFiles）
    CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: "1",
    // 同理：把 ncurses 的 terminal database 指到我们自己的 prefix。
    // 死引用原本指向不存在的 Termux share/terminfo，TUI 程序（hx、gdb -tui…）拿不到
    // 终端能力；我们 prefix 里那份是齐的（221K），指过去就活了。
    TERMINFO_DIRS: PREFIX ? path.join(PREFIX, "share", "terminfo") : path.join(PATHS.toolchain, "dshtc", "prefix", "share", "terminfo"),
    // 工具链在前：这样 claude 调 git/gcc/rg/magick… 命中的是我们搬过来的包装脚本。
    // 最前面的 app/pre 只放 pkg / apt：工具包里有同名的旧说明替身，改它会被完整性校验判成"改动"，只能靠 PATH 顺序压过去
    PATH: PREFIX ? [process.env.CCAPP_BIN && path.join(process.env.CCAPP_BIN, "..", "pre"), path.join(PREFIX, "bin"), path.join(CFG.home, ".cccodroid", "bin"), process.env.CCAPP_BIN, "/system/bin", "/system/xbin"].filter(Boolean).join(":") : [
      path.join(PATHS.toolchain, "payload", "bin"),
      // 开发端自己加的工具（python3/pip、java/javac/d8/apksigner、strace、adb…）：放在 tc.tar 之外，启动重新部署时不会被冲掉
      path.join(CFG.runtime, "..", "devbin"),
      path.join(CFG.runtime, "node"),
      "/system/bin", "/system/xbin",
    ].join(":"),
    CCAPP_TOOLCHAIN: PATHS.toolchain,
    CCAPP_PROVIDER: p.id,
    // 标记：这棵进程树是网关拉起的 claude 运行（子孙都继承）。网关重启时据此认出上一任留下的孤儿，见 reapOrphans
    CCAPP_RUN: "1",
    LD_LIBRARY_PATH: PREFIX ? "" : PATHS.nodeLib,   // 只给 node 用；glibc 走 --library-path
    // 前缀布局下 glibc 的 resolv.conf 是齐的，不需要本地桥：直连厂商
    // 别家（会话钉的不是全局那家）也直连：桥只有一个上游，跟着全局走；claude（Bun）自己解析 DNS，用不着桥
    ANTHROPIC_BASE_URL: NO_BRIDGE || other ? (p.baseUrl || "") : `http://127.0.0.1:${CFG.bridgePort}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_SHELL: ensureShell(),
    SHELL: ensureShell(),
    CI: "1",
    TERM: "dumb",
    NO_COLOR: "1",
  };

  for (const k of ["LD_LIBRARY_PATH", "ANTHROPIC_BASE_URL"]) if (!env[k]) delete env[k];
  // 自定义接口（中转站）垫一层流式补尾：回答说完了上游却没收尾，claude 会整段撤回重答（见 streamfix.mjs）
  // 用户给 claude 配了代理就不垫：本地转发是 node 发的请求，不走那个代理
  const viaProxy = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"].some((k) => env[k]);
  if (p.custom && !p.login && !p.local && !viaProxy && env.ANTHROPIC_BASE_URL) env.ANTHROPIC_BASE_URL = fixedBaseUrl(env.ANTHROPIC_BASE_URL);

  // 认证：按厂商声明的风格选变量，别把 key 塞进对方不认的 header。
  //   bearer    → ANTHROPIC_AUTH_TOKEN（Authorization: Bearer …）
  //   x-api-key → ANTHROPIC_API_KEY  （x-api-key: …，Anthropic 官方用这个）
  // 只有在确实要注入时才清掉继承来的冲突变量；没配 key 就原样透传
  // （这样 CLAUDE_CODE_OAUTH_TOKEN / 已有登录态仍然能用）。
  //
  // ⚠️ 密钥不进环境变量：claude 的每个 Bash 子进程都继承环境，模型跑一句 env 就整个打印出来
  // （实测发生过：grep 坏了，模型退而用裸 env，DeepSeek 的 key 原样进了会话记录）。
  // 改走 claude 自己的 apiKeyHelper：它要用时执行一条命令从 0600 的私有文件里读，见 settingsArgs()。
  if (key) {
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.ANTHROPIC_API_KEY;
  } else if (p.login) {
    // 登录态直连官方：令牌不许经过我们的本地桥（条款：不得中转会话令牌）。
    // 桥本来只为 glibc 的 DNS 存在，claude（Bun）自己解析，用不着它。
    delete env.ANTHROPIC_BASE_URL;
    // 官方账户（登录态）厂商：这两个变量一个都不能留。
    // 它们优先级高于 ~/.claude/.credentials.json 里的登录凭据 —— 只要沾上一个，
    // claude 就不走订阅登录了（连接器原话：ANTHROPIC_API_KEY takes precedence
    // over your claude.ai login）。这里主动清干净，逼它去读凭据文件。
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.ANTHROPIC_API_KEY;
  }

  // 模型：原生厂商（claude 自己就认识其模型的，如 Anthropic 官方）不覆盖 ——
  // 交给 claude 自己决定默认模型；只有第三方才需要显式指定。
  const m = want || p.defaultModel;
  const TIER_VARS = ["ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL"];
  if (!p.nativeModels && m) {
    env.ANTHROPIC_MODEL = m;
    // 档位映射：claude 内部会按 opus/sonnet/haiku 叫模型（子代理 Explore 用 haiku、/model opus 之类）。
    // 不映射的话这些请求带着 claude-haiku-… 打到第三方，直接 400。
    // haiku 档给厂商的快模型（目录里的 fastModel），其余都给当前选的模型。
    const fast = p.fastModel || m;
    env.ANTHROPIC_SMALL_FAST_MODEL = fast;
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = m;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = m;
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = fast;
    delete env.CLAUDE_CODE_SUBAGENT_MODEL;   // 子代理按它自己声明的档位走上面的映射
  } else {
    for (const k of TIER_VARS) delete env[k];
    // 不由我们定模型的场合，把继承来的模型变量擦掉。
    // 跟密钥是同一个坑：网关自己要是被一个"身上带着 ANTHROPIC_MODEL"的进程拉起来
    // （比如从某个 deepseek 会话里起，或包装脚本 exports 过），这个值会一路传进
    // 官方账户的 claude —— 拿着 deepseek-flash 去敲 api.anthropic.com。
    // 实测就是这么炸的：model=<synthetic> 400 "issue with the selected model (deepseek-flash)"。
    delete env.ANTHROPIC_MODEL;
    delete env.ANTHROPIC_SMALL_FAST_MODEL;
  }

  // 第三方厂商：claude 不认识这些模型名，需放宽窗口识别，并把真实窗口告诉它。
  // 不设窗口的话 claude 一律按 200k 算 —— 1M 的模型会被白白砍掉 80%，
  // 而且 /autocompact 也会被卡在 200k。值从 /models 动态取，不写死。
  if (!p.nativeModels) {
    env.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT = "1";
    // 模型名不是 Claude 型号时，claude 默认不给清单工具（TaskCreate/TaskUpdate 一个都不挂），得显式打开；
    // 光打开还不够，第三方模型不会主动用 —— 配合 TASKS_HINT 提醒一句才用（DeepSeek 实测）
    if (!p.local) env.CLAUDE_CODE_ENABLE_TODO_TOOLS = "1";
    const ctx = Number(info && info.context_window) || 0;
    if (ctx > 0) env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(ctx);
  }
  // 注意：不注入 CLAUDE_CODE_MAX_OUTPUT_TOKENS —— 那是「单次输出上限」，
  // 不是上下文，claude 自己有合理默认，硬塞只会带来副作用。

  // 自动压缩窗口：用户设了才插，没设就让 claude 自己按窗口比例决定
  // 端侧小模型不传：窗口只有几万 token 时，claude 同时看到窗口和压缩线，每次发请求前都判定「已超线」先去压缩（实测）
  if (SETTINGS.autoCompactWindow && !p.local) {
    env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(SETTINGS.autoCompactWindow);
  }
  // 厂商文档要求的额外变量（如 GLM 的 API_TIMEOUT_MS）。只收字符串，且不许借道改密钥/端点
  for (const [k, v] of Object.entries(p.extraEnv || {})) {
    if (/^[A-Z_][A-Z0-9_]*$/.test(k) && !/^ANTHROPIC_(BASE_URL|API_KEY|AUTH_TOKEN)$/.test(k)) env[k] = String(v);
  }
  return glibcEnv(env);
}

/** claude 是 glibc 程序，必须经 loader 启动 */
export function claudeArgv(extra) {
  const pre = GLIBC_PRELOAD ? ["--preload", GLIBC_PRELOAD] : [];
  return ["--library-path", PATHS.glibcLib, ...pre, PATHS.claude, ...extra];
}

/** seccomp 监督器：cccodroid 放在 seccomp-enosys.so 旁边（app/lib），开发端在 files/devbin */
let ENOSYS_RUN;
export function enosysRun() {
  if (ENOSYS_RUN !== undefined) return ENOSYS_RUN;
  const cands = [process.env.CCAPP_ENOSYS_RUN,
    PATHS.preload && path.join(path.dirname(PATHS.preload), "seccomp-enosys-run"),
    path.join(CFG.home, "..", "devbin", "seccomp-enosys-run")].filter(Boolean);
  ENOSYS_RUN = cands.find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } }) || "";
  return ENOSYS_RUN;
}
/** 拉起 claude 的 [程序, 参数]：开着「静态程序兼容」就外面套一层监督器（跟进模式） */
export function claudeCmd(extra) {
  const argv = claudeArgv(extra);
  const er = SETTINGS.staticCompat !== false ? enosysRun() : "";
  return er ? [er, ["-f", PATHS.loader, ...argv]] : [PATHS.loader, argv];
}

/** 连 claude 带它拉起的整棵进程树一起杀。
 *
 *  为什么不能用 child.kill()：SIGKILL 不往下传。claude 起了 bash、bash 起了
 *  sleep/blender/godot…，只杀 claude 的话那些会被 init（PID 1）收养、继续跑 ——
 *  实测按 ⏹ 中断后，巡检循环的 shell 照样在后台转，PPID 变成 1。
 *
 *  所以 spawn 时加了 detached:true，让 claude 当进程组长；这里对负 pid 下刀，
 *  一次带走整组。取不到组就退回杀单进程，别什么都不做。 */
export function killTree(child) {
  if (!child || !child.pid) return;
  // 光杀组不够：claude 的 Bash 工具会给子 shell 另开进程组（setsid），实测中断后
  // `sh -c … sleep 60` 留下来被 init 收养。所以先顺着 /proc 的父子关系把整棵树
  // 摘出来（得在杀之前摘，杀完父子关系就断了），再逐个连组带进程一起杀。
  const tree = descendants(child.pid);
  try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
  for (const p of tree) {
    try { process.kill(-p, "SIGKILL"); } catch {}
    try { process.kill(p, "SIGKILL"); } catch {}
  }
}

/** 网关启动时清掉上一任留下的孤儿（v0.2.0 设计 A3）。
 *  上一任网关被杀 / 崩溃时，它拉起的 claude 和 claude 另开进程组的子 shell 会被 init 收养（PPID=1），
 *  没人读它们的输出却还在干活：推提交、跑构建、占内存。新网关接不回它们，只能清掉。
 *  认法：本 uid、PPID=1，且环境里带 CCAPP_RUN=1（claudeEnv 打的标记，子孙都继承），
 *  或命令行就是我们的 claude（打标记之前的版本留下的）。连子孙一起、按进程组杀（同 killTree）。
 *  只在 cccodroid 做：开发端换网关（gw-swap.sh）时上一任的运行还要接着用。 */
export function reapOrphans() {
  if (!PREFIX) return;
  const uid = process.getuid(), victims = [];
  let names = [];
  try { names = fs.readdirSync("/proc"); } catch { return; }
  for (const n of names) {
    if (!/^\d+$/.test(n) || +n === process.pid) continue;
    try {
      if (fs.statSync("/proc/" + n).uid !== uid) continue;
      const st = fs.readFileSync("/proc/" + n + "/stat", "utf8");
      if (+st.slice(st.lastIndexOf(")") + 2).split(" ")[1] !== 1) continue;
      const env = "\0" + fs.readFileSync("/proc/" + n + "/environ", "latin1");
      const cmd = fs.readFileSync("/proc/" + n + "/cmdline", "utf8");
      if (env.includes("\0CCAPP_RUN=1\0") || cmd.includes(PATHS.claude)) victims.push([+n, cmd.replace(/\0/g, " ").trim().slice(0, 80)]);
    } catch {}
  }
  for (const [pid, cmd] of victims) {
    const tree = descendants(pid);
    try { process.kill(-pid, "SIGKILL"); } catch {}
    try { process.kill(pid, "SIGKILL"); } catch {}
    for (const p of tree) {
      try { process.kill(-p, "SIGKILL"); } catch {}
      try { process.kill(p, "SIGKILL"); } catch {}
    }
    log(`  清掉上一任留下的孤儿 pid=${pid}（连子孙 ${tree.length} 个）：${cmd}`);
  }
}

/** root 的全部子孙 pid（读 /proc/<pid>/stat 的第 4 列 ppid） */
function descendants(root) {
  const kids = new Map();
  let names = [];
  try { names = fs.readdirSync("/proc"); } catch { return []; }
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    let st;
    try { st = fs.readFileSync(`/proc/${n}/stat`, "utf8"); } catch { continue; }
    // comm 可能含空格和括号，从最后一个 ")" 往后数
    const f = st.slice(st.lastIndexOf(")") + 2).split(" ");
    const ppid = +f[1];
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(+n);
  }
  const out = [], stack = [root];
  while (stack.length) {
    for (const k of kids.get(stack.pop()) || []) { out.push(k); stack.push(k); }
  }
  return out;
}

/** 每次起 claude 都带的 --settings：输出风格 + 密钥读取器。
 *  apiKeyHelper 的输出 claude 会同时放进 x-api-key 与 Authorization: Bearer，两种认证风格都覆盖。 */
const KEY_FILE = path.join(CFG.home, ".cache", "ccapp-key");

/** 安全模式：配置弄坏了（钩子、插件、MCP、CLAUDE.md…）跑不起来时，用 claude 自带的 --safe-mode 起：
 *  所有自定义项一概不加载，登录、密钥、会话、模型照旧。不挪、不改任何文件，关掉就恢复原样。
 *  开关是一个标记文件 —— 界面打不开时，安卓壳的启动页也能直接写它。 */
const SAFE_FILE = path.join(CFG.home, ".ccapp-safe-mode");
export const safeMode = () => fs.existsSync(SAFE_FILE);
function setSafeMode(on) {
  if (on) fs.writeFileSync(SAFE_FILE, String(Date.now()));
  else try { fs.unlinkSync(SAFE_FILE); } catch {}
  ledger("safe-mode", true, on ? "进入安全模式（界面开启）" : "退出安全模式");
  log(on ? "进入安全模式" : "退出安全模式");
}

/** 修复账本（安卓壳记安装 / 校验 / 修复，网关记安全模式），一行一条 JSON。没给路径就不记 */
export function ledger(kind, ok, msg, detail) {
  const f = process.env.CCAPP_LEDGER;
  if (!f) return;
  try { fs.appendFileSync(f, JSON.stringify({ at: Date.now(), kind, ok, msg, ...(detail ? { detail } : {}) }) + "\n"); } catch {}
}
export function readLedger(n = 100) {
  const f = process.env.CCAPP_LEDGER;
  if (!f) return null;
  try {
    return fs.readFileSync(f, "utf8").trim().split("\n").reverse().slice(0, n)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/** p：这一轮用的那家（缺省 = 全局生效的）。密钥文件按家分开 —— 几家同时在跑时，
 *  claude 每次要钥匙都现读文件，共用一个文件会读到别家的 */
export function settingsArgs(p = PROVIDER) {
  const st = {};
  const safe = safeMode();
  if (SETTINGS.outputStyle && !safe) st.outputStyle = SETTINGS.outputStyle;
  if (!p.local) st.hooks = archiveHooks();   // 压缩后提醒建档（只陈述事实，规则在系统提示里，见 archive.mjs）
  const key = keyOf(p);
  const file = p.id === PROVIDER.id ? KEY_FILE : KEY_FILE + "-" + String(p.id).replace(/[^\w.-]/g, "_");
  if (key) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, key, { mode: 0o600 });
      fs.chmodSync(file, 0o600);
      st.apiKeyHelper = "cat '" + file + "'";
    } catch (e) { log("写密钥文件失败: " + e.message); }
  } else {
    try { fs.unlinkSync(file); } catch {}
  }
  return [...(safe ? ["--safe-mode"] : []), ...(Object.keys(st).length ? ["--settings", JSON.stringify(st)] : [])];
}

/** 跑一次 claude 并收集全部 stdout（用于取 CLI 状态类输出） */
export function runClaude(args, { cwd, timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    let out = "", err = "", done = false;
    const [cmd0, args0] = claudeCmd([...settingsArgs(), ...args]);   // mcp list 之类会拉起 MCP 服务器，也要罩住
    const child = spawn(cmd0, args0, {
      cwd: cwd || (fs.existsSync(CFG.workspace) ? CFG.workspace : CFG.home),
      env: claudeEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,          // 当进程组长，中断时好整组带走（见 killTree）
    });
    const timer = setTimeout(() => {
      if (!done) { done = true; killTree(child); resolve({ out, err, timeout: true }); }
    }, timeoutMs);
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");   // 按流解码：多字节字符跨块不会被拆坏
    child.stdout.on("data", (d) => { out += d.toString("utf8"); });
    child.stderr.on("data", (d) => { err += d.toString("utf8"); });
    child.on("error", (e) => {
      if (done) return;
      done = true; clearTimeout(timer); resolve({ out, err: err + e.message, error: true });
    });
    child.on("close", (code, signal) => {
      if (done) return;
      // 被信号杀掉时 code 是 null：把信号名带出去，不然调用方只看到一片空白
      done = true; clearTimeout(timer); resolve({ out, err: err + (signal ? `（claude 被信号 ${signal} 终止）` : ""), code, signal });
    });
  });
}

// ── 路由：/api/safe-mode ──
export async function routeClaude(req, res, u, p) {
  if (req.method === "POST" && p === "/api/safe-mode") {
    const b = JSON.parse((await readBody(req)) || "{}");
    setSafeMode(!!b.on);
    return sendJson(res, 200, { ok: true, safeMode: safeMode() });
  }
  return NEXT;
}
