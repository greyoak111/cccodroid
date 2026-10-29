import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// 测试绕过 scripts/test.mjs 直接跑（node --test / node xx.test.mjs）时环境里是真 home：
// 一导入网关模块就会读写真的会话、运行标记、定时任务。没有 CCAPP_TEST 一律不让起（#49 P2-18）
if ((process.env.NODE_TEST_CONTEXT || /\.test\.mjs$/.test(process.argv[1] || "")) && process.env.CCAPP_TEST !== "1")
  throw new Error("测试请用 node scripts/test.mjs 跑（它会建临时 home 和工作区）；直接跑会动真数据");

// 网关目录（gw/ 的上一级）：web/、bin/、TAG 等都相对它找
export const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// ── 路径与配置 ────────────────────────────────────────────────────────
export const CFG = {
  runtime: process.env.CCAPP_RUNTIME || path.join(HERE, "..", "runtime"),
  home: process.env.CCAPP_HOME || process.env.HOME || HERE,
  workspace: process.env.CCAPP_WORKSPACE || path.join(HERE, "..", "workspace"),
  port: Number(process.argv[2] || process.env.CCAPP_PORT || 8790),
  bridgePort: Number(process.env.CCAPP_BRIDGE_PORT || 8788),
  upstream: process.env.CCAPP_UPSTREAM || "https://api.deepseek.com/anthropic",
  model: process.env.CCAPP_MODEL || "deepseek-flash",
};

// 前缀布局（cccodroid）：工具链是原生 Termux 前缀，claude 是官方原版二进制，
// 由宿主 App 用环境变量告诉我们位置；没设就按旧布局（runtime/ 下）找。
export const PREFIX = process.env.CCAPP_PREFIX || "";
export const NO_BRIDGE = !!PREFIX || process.env.CCAPP_NO_BRIDGE === "1";
export const PATHS = {
  loader: process.env.CCAPP_LOADER || path.join(CFG.runtime, "glibc", "lib", "ld-linux-aarch64.so.1"),
  glibcLib: process.env.CCAPP_GLIBC_LIB || path.join(CFG.runtime, "glibc", "lib"),
  claude: process.env.CCAPP_CLAUDE || path.join(CFG.runtime, "claude"),
  // cccodroid：给 claude 预加载的小库，把被安卓 seccomp 拦下的调用改成返回 ENOSYS
  // （Android 14 拦 epoll_pwait2，claude 不挂它一启动就被 SIGSYS 打死）
  preload: process.env.CCAPP_CLAUDE_PRELOAD || "",
  node: path.join(CFG.runtime, "node", "node"),
  nodeLib: path.join(CFG.runtime, "node", "lib"),
  web: path.join(HERE, "web"),
  toolchain: process.env.CCAPP_TOOLCHAIN || path.join(CFG.home, "..", "toolchain"),
  bridge: path.join(HERE, "localbridge.mjs"),
  config: path.join(CFG.home, "ccapp-config.json"),
  settings: path.join(CFG.home, "ccapp-settings.json"),
  names: path.join(CFG.home, "ccapp-session-names.json"),
  windows: path.join(CFG.home, "ccapp-model-windows.json"),
  projects: path.join(CFG.home, ".claude", "projects"),
};

// 给 glibc 程序 --preload 的库（冒号分隔）。经加载器时 Env.java 给的是 seccomp-enosys.so + exec-shim.so
export const GLIBC_PRELOAD = process.env.CCAPP_GLIBC_PRELOAD || (PATHS.preload && fs.existsSync(PATHS.preload) ? PATHS.preload : "");
/** glibc 进程的环境：摘掉 LD_PRELOAD —— 经加载器时网关环境里挂着 termux-exec（bionic 库），glibc 的 ld.so 读到直接报 invalid ELF header */
export function glibcEnv(env = process.env) {
  const e = { ...env };
  delete e.LD_PRELOAD;
  delete e.CCAPP_SELF_EXE;      // exec-shim 用它冒充 /proc/self/exe：网关直接拉的 glibc 程序不是它记的那个
  return e;
}

// ── 测试模式 ──────────────────────────────────────────────────────────
// CCAPP_TEST=1（tests/ 里的测试设的）：模块被导入时不做任何启动动作——不恢复中断记录、不装技能、不起定时器、
// 不写 gateway.log。网关真跑起来时这个开关是关的，一切照旧。测试同时把 CCAPP_HOME 指到临时目录，双保险
export const LIVE = process.env.CCAPP_TEST !== "1";

// ── 工具函数 ──────────────────────────────────────────────────────────
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TS = () => new Date().toISOString().slice(11, 19);
// 默认落 home（私有目录），不落共享存储：脱离 App 单独跑网关时别让别的应用读到日志（审查 v0.5.4 B-L2）
const LOG_FILE = process.env.CCAPP_LOG || path.join(CFG.home, "gateway.log");
// 网址里的账号口令（http://user:pass@host）和查询串里的令牌（?key=…、&token=…）不进日志（后者审查 10-29 第六份 低3）
const noCred = (s) => s.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\/\s@]+@/gi, "$1***@")
  .replace(/([?&](?:key|api_?key|token|access_token|auth|sig|signature|password|secret)=)[^&\s"']+/gi, "$1***");
export const log = (...a) => {
  const line = noCred(`[${TS()}] ${a.join(" ")}`);
  if (!LIVE) return;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch {}
};

// ── 提示语的多语言 ────────────────────────────────────────────────────
// 源语言是中文、键就是中文原句，和界面共用 web/lang-*.js 的词典（回退：当前语言 → 英文 → 中文）。
// 要翻的提示语用 tz 包起来（第一个参数是带 {name} 占位的中文原句，第二个是变量）：它就是一个照常能拼接、能当 Error 消息的字符串，
// 同时登记「拼好的中文 → 键和变量」。所以提示语哪怕先变成 e.message、再转几手，
// sendJson 出门时（按请求头 X-CC-Lang）或推送时（按最近一次见到的语言）都还能认出来翻。
// gateway.log 不翻。新键照 i18n/HANDOFF.md 的流程进词典（scan.mjs 也扫这里 tz 包着的原句）
const TZ_SEEN = new Map();                      // 拼好的中文 → [键, 变量]，只留最近 300 条
const tzFill = (k, v) => (v ? k.replace(/\{(\w+)\}/g, (m, n) => (n in v ? String(v[n]) : m)) : k);
export function tz(k, v) {
  const s = tzFill(k, v);
  TZ_SEEN.delete(s); TZ_SEEN.set(s, [k, v || null]);
  if (TZ_SEEN.size > 300) TZ_SEEN.delete(TZ_SEEN.keys().next().value);
  return s;
}
const LANG_DICTS = new Map();
export let LAST_LANG = "zh";
function langDict(code) {
  if (!LANG_DICTS.has(code)) {
    let d = null;
    try {
      const sb = { window: {} };
      vm.runInNewContext(fs.readFileSync(path.join(HERE, "web", `lang-${code}.js`), "utf8"), sb);
      d = (sb.window.I18N_DICT || {})[code] || null;
    } catch {}
    LANG_DICTS.set(code, d);
  }
  return LANG_DICTS.get(code);
}
/** 请求带的界面语言；顺手记下来给推送和后台任务用 */
export function reqLang(req) {
  const l = String((req && req.headers && req.headers["x-cc-lang"]) || "");
  if (/^[a-z]{2}(-[A-Za-z]{2,4})?$/.test(l)) LAST_LANG = l;
  return LAST_LANG;
}
export function tr(lang, msg) {
  if (typeof msg !== "string" || !lang || lang === "zh") return msg;
  const hit = TZ_SEEN.get(msg) || [msg, null];
  for (const c of lang === "en" ? ["en"] : [lang, "en"]) {
    const d = langDict(c), x = d && d[hit[0]];
    if (x === undefined || x === null) continue;
    try { return typeof x === "function" ? String(x(hit[1] || {})) : tzFill(String(x), hit[1]); } catch {}
  }
  return msg;
}

// 钥匙隔离自测（这个 PR 会关掉）
