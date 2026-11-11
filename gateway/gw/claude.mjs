import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { CFG, GLIBC_PRELOAD, NO_BRIDGE, PATHS, PREFIX, glibcEnv, log, sleep, tz } from "./config.mjs";
import { SETTINGS, outputStyles } from "./settings-store.mjs";
import { PROVIDER, keyOf } from "./providers.mjs";
import { cachedModels, defaultCompactLine } from "./models.mjs";
import { effectiveAutoCompact } from "./stream.mjs";
import { fixedBaseUrl } from "./streamfix.mjs";
import { archiveHooks } from "./archive-core.mjs";
import { fileURLToPath } from "node:url";
import { APP } from "./appfiles.mjs";
import { sealArgv, sealEnv, sealed } from "./edition.mjs";
import { claudeSeal } from "./claudeseal.mjs";
import { gwRuntimeBlocked } from "./gwpin.mjs";
import { sessionRetention } from "./retention.mjs";

// 敏感操作再确认：PreToolUse 钩子（guard/cc-guard.mjs），碰密钥 / 读屏点按 / 往外分享时让 claude 停下来问，全部放行也一样。
// 不设全局关闭开关：整层关掉就等于没有；旧设置里存过 guard:false 也不再认。要放行就在确认卡片上逐次「允许」。
// 钩子不读盘上的文件：部署出来的网关用启动时核过、存在内存里的那份源码（appfiles.mjs），整段经 node -e 跑，
// 跑着的时候盘上那份被改了也换不掉正在挂的这一层。开发时（没有 FILES）照旧现读仓库里的。
const GUARD_CLI = fileURLToPath(new URL("../guard/cc-guard.mjs", import.meta.url));
const BREACH_SRC = fileURLToPath(new URL("./breach.mjs", import.meta.url));
// 部署出来的（有 APP）只认核过的：快照里没有（启动时就对不上）就按清单现读现核，对不上返回 BAD，不回退读盘
// （0.6.9 审计 200-14-05：以前快照缺了就读盘，核完到加载前被换的那份照样挂上）
const BAD = Symbol("bad");
function appText(app, rel, file) {
  if (app) { const b = app.code(rel); return b ? b.toString("utf8") : BAD; }
  try { return fs.readFileSync(file, "utf8"); } catch { return null; }
}
export function guardSource(app = APP) {
  const src = appText(app, "guard/cc-guard.mjs", GUARD_CLI);
  if (src === BAD) return BAD;
  if (src == null) return null;
  // 破甲特征检查拼在前面（guard 拦往配置 / 记忆里写破甲内容，见 cc-guard.mjs breachWrite）。同样用核过的那份；去掉 export 才能当脚本跑
  const br = appText(app, "gw/breach.mjs", BREACH_SRC);
  if (br === BAD) return BAD;
  return (br || "").replace(/^export /gm, "") + "\n" + src.replace(/^#!.*\n/, "") + "\nrunHook();\n";
}
export function guardHooks(app = APP) {
  const src = guardSource(app);
  if (!src) return null;
  const q = (x) => "'" + String(x).replace(/'/g, "'\\''") + "'";
  const matcher = "Bash|Read|Edit|Write|MultiEdit|NotebookEdit|Grep|Glob|mcp__device__.*";
  if (src === BAD) {
    // 核不过：这一层不能换成别的，也不能整层不挂。挂一个一律拦下的（PreToolUse 退出码 2 = 不许用），等空闲重启按安装包还原
    log("⚠️ [应用文件] guard / breach.mjs 和安装包对不上，敏感工具这一轮一律拦下");
    app?.restart("guard/cc-guard.mjs 或 gw/breach.mjs（和安装包对不上）");
    const deny = "process.stderr.write('cccodroid: the safety check could not be verified against the installed package; this tool is blocked until the app restores it.');process.exit(2)";
    return [{ matcher, hooks: [{ type: "command", command: q(process.execPath) + " -e " + q(deny), timeout: 10 }] }];
  }
  return [{ matcher, hooks: [{ type: "command", command: q(process.execPath) + " --input-type=module -e " + q(src), timeout: 10 }] }];
}
import { NEXT, readBody, sendJson } from "./http.mjs";

// ── 给 claude 造一个它认得的 shell ────────────────────────────────────
// 安卓既没有 /bin/sh 也没有 bash：claude 扫 /bin、/usr/bin 找 bash/zsh，
// 找不到就抛 "No suitable shell found"。它认 CLAUDE_CODE_SHELL 覆盖，
// 但会校验路径形态必须是 bash/zsh —— 于是造个名叫 bash 的包装转发给 mksh。
let SHELL_PATH = null;
// 非安卓环境（CI 的 Linux）没有 /system/bin/sh：包装脚本的 shebang 和最终 exec 都要回落到 /bin/sh
const SYS_SH = fs.existsSync("/system/bin/sh") ? "/system/bin/sh" : "/bin/sh";
export function ensureShell() {
  if (SHELL_PATH) return SHELL_PATH;
  // 开发端（旧布局）没有 CCAPP_SHELL：有 files/cbash/bash（glibc 版真 bash）就用它。
  // /system/bin/sh 是 mksh —— claude 的 shell 快照开头 unalias -a，会把 mksh 靠别名实现的 local 一起删掉，
  // 快照里的 grep/find/pkill 函数于是每次都报 "local: inaccessible or not found"。
  const cbash = path.join(CFG.runtime, "..", "cbash", "bash");
  const want = process.env.CCAPP_SHELL || (!PREFIX && fs.existsSync(cbash) ? cbash : "");
  const real = want && fs.existsSync(want) ? want : SYS_SH;

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
    const body = '#!' + SYS_SH + '\nunset CLAUDE_CODE_EXECPATH\n' + pre + 'exec "' + real + '" "$@"\n';
    let need = true;
    try { need = fs.readFileSync(sh, "utf8") !== body; } catch {}
    if (need) fs.writeFileSync(sh, body, { mode: 0o755 });
    fs.chmodSync(sh, 0o755);
    SHELL_PATH = sh;
  } catch (e) {
    log(`造 shell 包装失败: ${e.message}`);
    SHELL_PATH = SYS_SH;
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
// 换厂商时桥换上游的那一段（settings.mjs）：这期间 PROVIDER 已经是新的、桥可能还指着旧的。
// 新起的轮次等它换完再连；第二次换厂商直接回忙（0.6.9 审计 200-7-08：以前占槽检查在 await 之前，中间进来的轮次拿新密钥敲旧上游）
let SWITCHING = null;
export const bridgeSwitching = () => SWITCHING;
export function beginBridgeSwitch() {
  let done;
  SWITCHING = new Promise((r) => { done = r; });
  return () => { SWITCHING = null; done(); };
}
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
  // 没指定就是那家的默认型号（claudeEnv 的 ANTHROPIC_MODEL 也是这么取的），没默认才是清单第一项
  const want = id || p.defaultModel;
  if (!want) return list[0] || {};
  // 只认同名的：清单里没有这个型号就当不知道，别借第一项的窗口（128k 的型号借来 1M 会越窗，#57 #82）
  return list.find((m) => m.id === want) || {};
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
    // 最前面的 app/pre 放 pkg / apt 和 adb（服务改开私有套接字）：工具包里有同名的旧说明替身，改它会被完整性校验判成"改动"，只能靠 PATH 顺序压过去
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
    // 自带的 ripgrep 按 /proc/self/exe 找，经加载器起的 claude 那是加载器本身：Grep / Glob 不报错、一律「没找到」（2.1.311 实测）。
    // 改用 PATH 里的 rg：工具包装了「命令行增强」用它的，没装落到 app/bin/rg（经加载器以 argv0=rg 调 claude 自带的那份）
    USE_BUILTIN_RIPGREP: "0",
    CLAUDE_CODE_SHELL: ensureShell(),
    SHELL: ensureShell(),
    CI: "1",
    TERM: "dumb",
    NO_COLOR: "1",
  };

  for (const k of ["LD_LIBRARY_PATH", "ANTHROPIC_BASE_URL"]) if (!env[k]) delete env[k];
  // 发行版：claude 起来就设不可转储（预加载的 libccnodump.so 认这个变量，见 android/native/nodump.c），
  // 会话里跑的命令就不能 ptrace 它、改它的内存。终端（terminal.mjs）摘掉：那是机主自己的 claude
  if (sealed()) env.CCAPP_NODUMP = "1"; else delete env.CCAPP_NODUMP;
  sealEnv(env);   // 发行版：能让 claude 另找配置 / 记忆目录的变量清掉（见 edition.mjs）
  // 网关令牌文件的位置不交给 claude：Bash 里 cat "$CCAPP_TOKEN_FILE" 不带 .gateway-token 字样，再确认钩子认不出（11-03 审查 L-6）
  delete env.CCAPP_TOKEN_FILE;
  // 第三方接口（自定义的和预置的第三方厂商）垫一层流式补尾：回答说完了上游却没收尾，claude 会整段撤回重答、厂商记两次（见 streamfix.mjs）。
  // 以前只垫自定义接口，预置的 DeepSeek / GLM… 断流照样整段重来（0.6.9 审计 195-U.6）。官方（nativeModels）、登录态、端侧不垫。
  // 用户给 claude 配了代理就不垫：本地转发是 node 发的请求，不走那个代理
  const viaProxy = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"].some((k) => env[k]);
  if ((p.custom || p.group === "third") && !p.nativeModels && !p.login && !p.local && !viaProxy && env.ANTHROPIC_BASE_URL) env.ANTHROPIC_BASE_URL = fixedBaseUrl(env.ANTHROPIC_BASE_URL);

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

  // 第三方厂商：claude 不认识这些模型名，把真实窗口告诉它。
  // 不设窗口的话 claude 一律按 200k 算 —— 1M 的模型会被白白砍掉 80%，
  // 而且 /autocompact 也会被卡在 200k。值从 /models 动态取，不写死。
  // 不再设 CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT（11-07）：2.1.311 起它的意思是「不按窗口压缩、等接口报超长」，
  // DeepSeek 的超长报错 claude 认不出，于是永不压缩。不设它，MAX_CONTEXT_TOKENS 照认（实测 1M 型号按 1028576 算）；
  // 不知道窗口的按假定的 200k 压（约 180k 触发），总比一路涨到撞窗口强。继承来的也擦掉
  delete env.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT;
  if (!p.nativeModels) {
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
  } else {
    // 没设：第三方型号窗口已知就给默认线，否则 claude 不按阈值压（见 defaultCompactLine）。
    // 继承来的值先擦掉：网关自己可能是从一个带着这个变量的 claude 会话里起的
    delete env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    // 用户在 ~/.claude/settings.json 里自己写了 autoCompactWindow（effectiveAutoCompact 认得）就不盖它：环境变量优先级更高
    const d = !p.local && !effectiveAutoCompact() && defaultCompactLine(Number(info && info.context_window) || 0, p);
    if (d) env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(d);
  }
  // 厂商文档要求的额外变量（如 GLM 的 API_TIMEOUT_MS）。只收字符串，且不许借道改密钥/端点，
  // 也不许碰「执行什么、加载什么」的变量：自定义厂商的配置能分享导入，带着 CLAUDE_CODE_SHELL(_PREFIX)、LD_PRELOAD、
  // NODE_OPTIONS、PATH、BASH_ENV 之类就能让 claude 跑任意代码（审查 H8）。超时、重试、代理这类照常放行
  // 预置厂商都在 extraEnv 里带了 API_TIMEOUT_MS，自定义的没有：上游接了请求一个字节都不回时，claude 默认档 100 秒以上不报错，
  // 界面一直停在「连接中」（#203）。这里补一档默认（只约束等响应头，流开始后不掐），下面用户自己写的会盖掉它。
  // 不写进厂商对象：协议桥认领的条目要求 extraEnv 为空（bridge-config 的冲突判断）
  if (p.custom) { env.API_TIMEOUT_MS = "90000"; env.CLAUDE_CODE_MAX_RETRIES = "3"; }
  for (const [k, v] of Object.entries(p.extraEnv || {})) {
    if (/^[A-Z_][A-Z0-9_]*$/.test(k) && !EXTRA_ENV_DENY.test(k)) env[k] = String(v);
  }
  // extraEnv 是厂商配置里的不可信字段，最后再清一次封口变量：上面的 sealEnv() 在它之前跑，
  // 不这样这里能把 managed settings / 插件 seed 目录重新打开（审查 11-05）
  sealEnv(env);
  return glibcEnv(env);
}

const EXTRA_ENV_DENY = /^(ANTHROPIC_(BASE_URL|API_KEY|AUTH_TOKEN|MODEL|SMALL_FAST_MODEL|DEFAULT_\w+_MODEL\w*)|CLAUDE_CODE_(SUBAGENT_MODEL|MAX_CONTEXT_TOKENS|AUTO_COMPACT_WINDOW|DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT)|LD_\w*|DYLD_\w*|NODE_\w*|BUN_\w*|PYTHON\w*|PERL5?\w*|RUBY\w*|GIT_\w*|SSL_\w*|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_SHELL\w*|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_MANAGED_SETTINGS_PATH|CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD|CLAUDE_COWORK_MEMORY_PATH_OVERRIDE|CLAUDE_CODE_USE_COWORK_PLUGINS|CLAUDE_CODE_PLUGIN_SEED_DIR|CLAUDE_CODE_DISABLE_AUTO_MEMORY|CLAUDE_CODE_GIT_BASH_PATH|CLAUDE_CONFIG_DIR|PATH|HOME|SHELL|BASH_ENV|ENV|PREFIX|TMPDIR|GCONV_PATH|LOCPATH|XDG_\w*|RUST\w*|CARGO_\w*|GO(FLAGS|PROXY|PATH|ROOT|TOOLCHAIN|ENV|BIN|CACHE|MODCACHE|EXPERIMENT|DEBUG|NOSUMDB|PRIVATE|INSECURE)|MAKE\w*|CC|CXX|CPP|AR|LD|EDITOR|VISUAL|PAGER|MANPAGER|LESS\w*|SUDO_ASKPASS|SSH_\w*|GNUPG\w*|NPM_CONFIG_\w*|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|LUA_\w*|TERMUX_\w*|CCAPP_\w*|ENOSYS_\w*|PROMPT_COMMAND|PS4|IFS|CDPATH|SHELLOPTS|BASHOPTS|GCC_\w*|COMPILER_PATH|LIBRARY_PATH|CPATH|C_INCLUDE_PATH|CPLUS_INCLUDE_PATH|OBJC_INCLUDE_PATH|PKG_CONFIG\w*|MAVEN_\w*|GRADLE_\w*|ANT_\w*|SBT_\w*|DENO_\w*|ELECTRON_\w*|NPM_\w*|YARN_\w*|PNPM_\w*|PIP_\w*|UV_\w*|CONDA_\w*|MAMBA_\w*|R_LIBS\w*|RSTUDIO_\w*|JULIA_\w*|DOTNET_\w*|COREHOST_\w*|TCL\w*|TK_LIBRARY|GEM_\w*|BUNDLE_\w*|HOSTALIASES|GLIBC_TUNABLES|RES_OPTIONS|LOCALDOMAIN|MALLOC_\w*|CLASSPATH|JDK_JAVA_OPTIONS|_JAVA_OPTIONS|TEXINPUTS|TEXMF\w*|BIBINPUTS|BSTINPUTS|LUAINPUTS|KPATHSEA\w*|GUILE_\w*|EMACS\w*|PHP_INI_\w*|PHPRC|OCAML\w*|CAML_LD_LIBRARY_PATH|ERL_\w*|VIMINIT|EXINIT|MYVIMRC|VIMRUNTIME|TERMINFO|TERMINFO_DIRS|FONTCONFIG_\w*|GTK_\w*|GIO_\w*|GDK_\w*|QT_\w*|MAGICK_\w*|SQLITE_\w*|WGETRC|CURL_HOME|NETRC|INPUTRC|ZDOTDIR|HISTFILE|TAR_OPTIONS|GZIP|BZIP2?|XZ_\w*|ZSTD_\w*)$/;
// 模型、各档映射、上下文窗口、压缩线由网关按界面所选设好，配置里的不能盖掉：界面显示一个、实际跑另一个，计费和超窗都对不上（0.6.9 审计 195-U.2）
// 上面第二行起是审查 10-29 第六份 低1 补的：iconv 模块路径、git 全局配置目录、构建工具钩子、编辑器/分页器、exec 垫片与本应用自己的变量；
// GCC_ 起是 v0.5.7 独立审查 L1 补的：编译器搜索路径、各家构建工具与包管理器的选项变量（都能让后续子进程加载别处的代码）
// HOSTALIASES 起是 v0.5.9 独立审查 A5 补的：glibc 按文件改域名解析、调运行时参数
// CLASSPATH 起是 v0.5.12 独立审查 低3 补的：Java 类路径与选项、TeX 系的输入路径、Guile / Emacs / PHP / OCaml / Erlang 的加载路径
// VIMINIT 起是 v0.5.14 独立审查 低-7 补的：vim 启动命令、终端能力库、字体与图形库模块、各工具的配置文件位置

/** claude 是 glibc 程序，必须经 loader 启动 */
export function claudeArgv(extra) {
  const pre = GLIBC_PRELOAD ? ["--preload", GLIBC_PRELOAD] : [];
  return ["--library-path", PATHS.claudeLib, ...pre, PATHS.claude, ...extra];
}

/** seccomp 监督器：cccodroid 在 APK 原生库目录（libccenosysrun.so，Env.java 经 CCAPP_ENOSYS_RUN 交来），开发端在 files/devbin */
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
  // 发行版：开会话的一律加封口（--setting-sources "" 等，见 edition.mjs）。所有起 claude 的地方都经这里，别处不许自己拼
  const argv = claudeArgv(sealArgv(extra));
  const er = SETTINGS.staticCompat !== false ? enosysRun() : "";
  return er ? [er, ["-f", PATHS.claudeLoader, ...argv]] : [PATHS.claudeLoader, argv];
}

/** 连 claude 带它拉起的整棵进程树一起杀。
 *
 *  为什么不能用 child.kill()：SIGKILL 不往下传。claude 起了 bash、bash 起了
 *  sleep/blender/godot…，只杀 claude 的话那些会被 init（PID 1）收养、继续跑 ——
 *  实测按 ⏹ 中断后，巡检循环的 shell 照样在后台转，PPID 变成 1。
 *
 *  所以 spawn 时加了 detached:true，让 claude 当进程组长；这里对负 pid 下刀，
 *  一次带走整组。取不到组就退回杀单进程，别什么都不做。 */
/** 装着的 claude 版本（取自版本目录名）不低于 v：认不出版本的一律当不够 */
export function claudeAtLeast(v) {
  let cur; try { cur = path.basename(path.dirname(fs.realpathSync(PATHS.claude))); } catch { return false; }
  const a = cur.split(".").map(Number), b = v.split(".").map(Number);
  if (a.length !== 3 || a.some((x) => !Number.isInteger(x))) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

export function killTree(child) {
  if (!child || !child.pid) return;
  // 光杀组不够：claude 的 Bash 工具会给子 shell 另开进程组（setsid），实测中断后
  // `sh -c … sleep 60` 留下来被 init 收养。所以先顺着 /proc 的父子关系把整棵树
  // 摘出来（得在杀之前摘，杀完父子关系就断了），再逐个连组带进程一起杀。
  const tree = descendants(child.pid);
  // 套着监督器、claude 又不可转储时，/proc 里从监督器顺不下去：监督器报上来的 claude pid（run.mjs）单独往下摘
  if (child.claudePid > 0 && child.claudePid !== child.pid) for (const p of [child.claudePid, ...descendants(child.claudePid)]) if (!tree.includes(p)) tree.push(p);
  try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
  for (const p of tree) {
    try { process.kill(-p, "SIGKILL"); } catch {}
    try { process.kill(p, "SIGKILL"); } catch {}
  }
}

/** 进程启动时刻（开机后的滴答，/proc/<pid>/stat 第 22 项）；读不到 null */
function startTicks(pid, st) {
  try { st ??= fs.readFileSync("/proc/" + pid + "/stat", "utf8"); return +st.slice(st.lastIndexOf(")") + 2).split(" ")[19]; } catch { return null; }
}

/** 显式取消一轮时，清掉这一轮用 setsid / nohup 双 fork 脱出去、已经不在进程树里的后代（FIND-044）。
 *  killTree 顺着 /proc 的父子关系和进程组走，脱出去的被 init 收养、又另开了进程组，两头都够不着。
 *  认法：本 uid、环境里带 CCAPP_RUN_ID=<这一轮>、启动时刻不早于这一轮的 claude（编号同 uid 谁读得到 /proc 都能抄）。
 *  自己和祖先链不碰：开发端从某个 claude 会话里另起的网关，环境里也带着那轮的编号。
 *  只在显式取消这条路上调；网关重启时那一套仍是 reapOrphans（用户还没定，别动）。返回清掉的进程数。 */
export function killRunProcs(runId, sinceTicks = null) {
  if (runId == null || runId === "") return 0;
  const uid = process.getuid?.();
  if (uid == null) return 0;
  const ppidOf = (pid) => {
    try { const s = fs.readFileSync(`/proc/${pid}/stat`, "utf8"); return +s.slice(s.lastIndexOf(")") + 2).split(" ")[1]; } catch { return 0; }
  };
  const self = new Set();
  for (let p = process.pid, i = 0; p > 1 && i < 64; i++) { self.add(p); p = ppidOf(p); }
  let names = [];
  try { names = fs.readdirSync("/proc"); } catch { return 0; }
  const victims = [];
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    const pid = +n;
    if (self.has(pid)) continue;
    try {
      if (fs.statSync("/proc/" + n).uid !== uid) continue;
      const env = "\0" + fs.readFileSync(`/proc/${n}/environ`, "latin1");
      if (!env.includes("\0CCAPP_RUN_ID=" + runId + "\0")) continue;
      const st = fs.readFileSync(`/proc/${n}/stat`, "utf8");
      const t = startTicks(pid, st);
      if (sinceTicks != null && t != null && t < +sinceTicks) continue;
      victims.push(pid);
    } catch {}
  }
  for (const pid of victims) {
    // 脱出去的可能又起了自己的子孙（都带着编号，多半已在名单里；这里按父子关系再摘一遍防漏）
    const tree = descendants(pid);
    try { process.kill(pid, "SIGKILL"); } catch {}
    for (const p of tree) { try { process.kill(p, "SIGKILL"); } catch {} }
  }
  return victims.length;
}

/** 网关启动时清掉上一任留下的孤儿（v0.2.0 设计 A3）。
 *  上一任网关被杀 / 崩溃时，它拉起的 claude 和 claude 另开进程组的子 shell 会被 init 收养（PPID=1），
 *  没人读它们的输出却还在干活：推提交、跑构建、占内存。新网关接不回它们，只能清掉。
 *  认法：本 uid、PPID=1，且环境里带 CCAPP_RUN=1（claudeEnv 打的标记，子孙都继承），
 *  或命令行就是我们的 claude（打标记之前的版本留下的）。连子孙一起、按进程组杀（同 killTree）。
 *  环境里的 CCAPP_GW_PID（run.mjs）指向的网关还活着、且比它起得早的不收：那是活网关名下用 setsid 脱出去的，不是上一任留下的。
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
      if (!(env.includes("\0CCAPP_RUN=1\0") || cmd.includes(PATHS.claude))) continue;
      // 起它的网关还活着（setsid 脱出去的后台任务，或者测试里另起的网关碰上了真网关的运行）：不是孤儿，不收。
      // 那个 pid 若被别的进程复用，启动时刻会晚于它，照收
      const gw = +(/\0CCAPP_GW_PID=(\d+)\0/.exec(env) || [])[1], t0 = gw && gw !== process.pid ? startTicks(gw) : null;
      if (t0 != null && t0 <= startTicks(+n, st)) continue;
      victims.push([+n, cmd.replace(/\0/g, " ").trim().slice(0, 80)]);
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

/** pid 的直接子进程，按 /proc/<pid>/task/<tid>/children 列（看得见 pid 才读得到；列出来的子进程本身看不见也照样列） */
export function childrenOf(pid) {
  const out = [];
  let tids = [];
  try { tids = fs.readdirSync(`/proc/${pid}/task`); } catch { return out; }
  for (const t of tids) {
    try { for (const x of fs.readFileSync(`/proc/${pid}/task/${t}/children`, "utf8").split(/\s+/)) if (/^\d+$/.test(x)) out.push(+x); } catch {}
  }
  return out;
}

/** root 的全部子孙 pid（读 /proc/<pid>/stat 的第 4 列 ppid）。
 *  发行版里 claude 不可转储（libccnodump.so），/proc 里看不见它：经 children 文件补上这一环，它下面的子孙照样找得到 */
export function descendants(root) {
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
  const out = [], stack = [root], seen = new Set([root]);
  while (stack.length) {
    const p = stack.pop();
    for (const k of [...(kids.get(p) || []), ...childrenOf(p)]) if (!seen.has(k)) { seen.add(k); out.push(k); stack.push(k); }
  }
  return out;
}

/** 每次起 claude 都带的 --settings：输出风格 + 密钥读取器 + 会话保留期。
 *  apiKeyHelper 的输出 claude 会同时放进 x-api-key 与 Authorization: Bearer，两种认证风格都覆盖。 */
const KEY_FILE = path.join(CFG.home, ".cache", "ccapp-key");

/** 安全模式：配置弄坏了（钩子、插件、MCP、CLAUDE.md…）跑不起来时，用 claude 自带的 --safe-mode 起：
 *  所有自定义项一概不加载，登录、密钥、会话、模型照旧。不挪、不改任何文件，关掉就恢复原样。
 *  开关是一个标记文件 —— 界面打不开时，安卓壳的启动页也能直接写它。 */
const SAFE_FILE = path.join(CFG.home, ".ccapp-safe-mode");
export const safeMode = () => fs.existsSync(SAFE_FILE);
/** --safe-mode 下所有钩子都不跑，敏感操作再确认也跟着没了：这时不让用不问人的权限模式，退回「每次都问」 */
export const safeModePerm = (mode) => safeMode() && ["bypassPermissions", "auto", "acceptEdits"].includes(mode) ? "default" : mode;
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
  } catch (e) { if (e.code === "ENOENT") return []; throw e; }   // 还没记过账才是空；读不了要报错，别装成「没有记录」（审查 #52 D-07）
}

/** p：这一轮用的那家（缺省 = 全局生效的）。密钥文件按家分开 —— 几家同时在跑时，
 *  claude 每次要钥匙都现读文件，共用一个文件会读到别家的 */
export function settingsArgs(p = PROVIDER) {
  const st = {};
  const safe = safeMode();
  // 只认列得出来的（内置 + 用户目录）：旧设置里存着工作区那份的名字，这里不再传（输出风格目录的安全报告）
  if (SETTINGS.outputStyle && !safe && outputStyles().some((o) => o.id === SETTINGS.outputStyle)) st.outputStyle = SETTINGS.outputStyle;
  if (!p.local) {
    st.hooks = archiveHooks();   // 压缩后提醒建档（只陈述事实，规则在系统提示里，见 archive.mjs）
    const g = guardHooks();
    // 用户级、项目级设置里的 disableAllHooks:true 会连这里挂的钩子一起关掉；这里显式写 false 压过它们（2.1.311 实测）。
    // 代价是用户在设置里关掉的钩子也会跑 —— 扩展页的「关闭全部钩子」因此改成把钩子挪进暂存键（见 extensions.mjs）
    if (g) { st.hooks.PreToolUse = g; st.disableAllHooks = false; }
  }
  // 会话保留期：项目目录的 settings.json 写个小数字会压过用户级的，--settings 压得住它（D10，见 retention.mjs）
  st.cleanupPeriodDays = sessionRetention().days;
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
  if (fs.existsSync(termKeyPath(p))) termKeyFile(p);   // 开着的终端跟着换：密钥改了不用重开
  return [...(safe ? ["--safe-mode"] : []), ...(Object.keys(st).length ? ["--settings", JSON.stringify(st)] : [])];
}

/** 应用内终端里自己敲的 claude 用哪把钥匙：和网关起的一样不进环境变量，单放一个 0600 文件，
 *  终端环境里只给路径（CCAPP_KEY_FILE），bin/claude 包装见到它就照 settingsArgs 的办法挂 apiKeyHelper。
 *  不复用 settingsArgs 那份：终端的地址和型号是开终端那一刻定的，换了全局那家以后，共用文件会让旧地址拿到新钥匙 */
const termKeyPath = (p) => KEY_FILE + "-term-" + String(p.id).replace(/[^\w.-]/g, "_");
export function termKeyFile(p = PROVIDER) {
  const file = termKeyPath(p), key = keyOf(p);
  if (!key) { try { fs.unlinkSync(file); } catch {} return ""; }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, key, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    return file;
  } catch (e) { log("写终端密钥文件失败: " + e.message); return ""; }
}

/** 接口删掉后清掉它留在 .cache 里的密钥文件（FIND-052）：按 id 一份、终端一份；
 *  正在用的那家文件名不带 id，删的是当前接口时也要清（否则已删接口的 Key 一直留在盘上）。 */
export function clearKeyCache(id, active) {
  const safe = String(id).replace(/[^\w.-]/g, "_");
  const files = [KEY_FILE + "-" + safe, KEY_FILE + "-term-" + safe];
  if (active) files.push(KEY_FILE);
  for (const f of files) { try { fs.unlinkSync(f); } catch {} }
}

/** 跑一次 claude 并收集全部 stdout（用于取 CLI 状态类输出） */
/** 起 claude 之前核程序本身（claudeseal.mjs）：对不上返回给人看的原因，能起返回 ""。
 *  开会话以外的路也要核：mcp list、doctor、登录、补档、回退文件、扩展命令都会执行它（审查 11-05 第 16 组 1） */
export async function claudeBlocked() {
  const gw = gwRuntimeBlocked();
  if (gw) return gw;
  const s = await claudeSeal().catch((e) => ({ ok: false, why: e.message }));
  if (s.ok !== false) return "";
  return s.pending ? tz("这个版本的 Claude Code 还没有官方签名清单，这一轮没有启动。正在联网补核，过一两分钟再发送；一直不行就到 设置 → 更新 里重新安装。") : tz("Claude Code 程序核验没过，这次没有运行：{why}", { why: String(s.why || "") });
}

export async function runClaude(args, { cwd, timeoutMs = 60000 } = {}) {
  const blocked = await claudeBlocked();
  if (blocked) return { out: "", err: blocked, error: true };
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
