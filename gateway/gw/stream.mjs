import fs from "node:fs";
import path from "node:path";
import { CFG, HERE, PREFIX } from "./config.mjs";
import { SETTINGS } from "./settings.mjs";
import { isLoginMode, learnWindow } from "./models.mjs";
import { currentModelInfo } from "./claude.mjs";
import { AUTH_CACHE, authStatus } from "./login.mjs";
import { envFacts } from "./envfacts.mjs";
import { publish } from "./bus.mjs";

// ── 系统提示补充、claude 流事件翻译、订阅额度 ─────────────────────────
/** 给 claude 的工具说明。两种布局装的东西不一样，各说各的，别把没有的命令告诉它 */
// 第三方模型的清单提醒（见 providerEnv 里的 CLAUDE_CODE_ENABLE_TODO_TOOLS）；Claude 型号自己会用，不用提醒
// 查看器能直接预览 HTML：告诉 Claude 静态网页写好给路径就行，别动不动起 http.server（还得用户自己找端口）
export const PREVIEW_HINT = "In this app, file paths you mention in a reply are tappable and open in a file viewer, where .html files render as a live preview (relative CSS, JS and images load, and it reloads when the file changes). For a static web page or browser game, write the file and give the user its full path instead of starting a local web server; start a server only when the page needs a backend.";
export const TASKS_HINT = "When a request has 3 or more distinct steps, track them with the TaskCreate and TaskUpdate tools: create the tasks first, mark each in_progress when you start it and completed when it is done. The user sees this list as a live progress panel.";
/** 报一次「正在写工具参数」的字数（节流用） */
function toolEmit(flags, sse) {
  flags.toolTimer = null; flags.toolAt = Date.now();
  sse({ type: "phase", phase: "tool", name: flags.toolName || "", chars: flags.toolChars });
}

export function toolsHint() {
  if (PREFIX) {
    // 随包的 TOOLS.md 是逐项实测过的工具清单与用法（cccodroid-selftest 验证），优先用它；后面接本机实况
    try {
      const t = fs.readFileSync(path.join(HERE, "TOOLS.md"), "utf8")
        .replaceAll("{{WORKSPACE}}", CFG.workspace).replaceAll("{{SHARED}}", process.env.CCAPP_SHARED || "（无存储权限，不可用）");
      if (t.trim()) return [t.trim(), envFacts()].filter(Boolean).join("\n\n");
    } catch {}
    return [
      "这是一台安卓设备，原生运行（不是 chroot/proot/虚拟机）。开发工具包已在 PATH 中（前缀 $PREFIX，来自 Termux 官方仓库）：",
      "clang/clang++/lld、make、cmake、ninja、pkg-config、gdb、strace、patchelf；git、ssh；python、node、npm；",
      "openjdk-21(java/javac)、aapt2、d8、apksigner；rg、fd、bat、delta、hx、yq、jq、sqlite3、typst、duckdb、ImageMagick(magick)；",
      "以及 curl、zip/unzip、xz、zstd 等常用命令。cc/c++ 即 clang。",
      "/tmp 不可用，临时文件写 $TMPDIR；/sdcard 不支持符号链接、不可执行。",
      "需要系统权限（pm/am/settings/dumpsys/screencap/logcat 等）时用 priv '<命令>'，经 Shizuku 以 shell 身份执行；priv --status 看是否可用。",
      "工具链出问题先跑 cccodroid-selftest（逐项检查编译器、Python、Node、Java、Git 等是否可用）。",
    ].join(" ");
  }
  // 开发端：TOOLS-dev.md 是按本机实测写的工具清单与用法（比公开版多 Blender/Godot/Wine/priv 等）
  try {
    const t = fs.readFileSync(path.join(HERE, "TOOLS-dev.md"), "utf8").replaceAll("{{WORKSPACE}}", CFG.workspace);
    if (t.trim()) return t.trim();
  } catch {}
  return [
    "本机（安卓）已接入一套命令行工具链，已加入 PATH：",
    "git/ssh、gcc(cc4)/g++(cxx4)/make(mk4)、rg/fd/bat/yq/typst、",
    "ImageMagick(magick/identify)、duckdb、delta、hx、gdb、sqlite3、",
    "node，以及 blender / godot / wine(wp) / aapt2 / mkapk 等启动器。",
    "直接调用命令名即可；工具链根目录在 $CCAPP_TOOLCHAIN。",
  ].join(" ");
}

/** result 事件里带了各模型的上下文窗口，取来给前端的用量条用。
 *  claude 报不出来时回落到 DeepSeek /models 给的真实窗口 —— 绝不写死数值。 */
export function contextWindowOf(result, p, model) {
  learnWindow(result, p);
  try {
    const mu = result.modelUsage || {};
    for (const k of Object.keys(mu)) {
      if (mu[k] && mu[k].contextWindow) return mu[k].contextWindow;
    }
  } catch {}
  return Number(currentModelInfo(model, p).context_window) || 0;
}

/** 生效的自动压缩窗口。
 *  设这个值有两条路：网关设置面板（进 SETTINGS，靠环境变量下发），
 *  或者在对话里打 `/autocompact 400k`（那条命令写进的是 Claude Code 自己的
 *  ~/.claude/settings.json，网关这边看不见）。两条都要认，否则界面上的刻度会失真。 */
export function effectiveAutoCompact() {
  if (SETTINGS.autoCompactWindow) return SETTINGS.autoCompactWindow;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(CFG.home, ".claude", "settings.json"), "utf8"));
    const n = Number(j.autoCompactWindow);
    if (Number.isFinite(n) && n > 0) return Math.round(n);
  } catch {}
  return null;
}

/** 一次 API 调用的【提示词总量】= 那一刻的上下文占用。
 *  三部分相加才是完整提示词：未命中缓存的 + 命中缓存的 + 本次写入缓存的。
 *  ⚠️ 千万不要拿 result 事件里的 usage 当上下文用 —— 那是整轮所有调用的累计和，
 *  一轮里几十次工具调用加起来能报出比窗口还大好几倍的数字。 */
export const promptTokens = (u) => u
  ? (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
  : 0;

/** 兼容桥往往到流末尾才知道输入用量；开头的 0 只是占位，不能清掉上次的真实值。 */
function contextUsage(u, flags, sse) {
  const n = promptTokens(u);
  if (!Number.isFinite(n) || n <= 0) return;
  if (flags) {
    const changed = flags.contextTokens !== n;
    flags.contextTokens = n; flags.mainCtx = n;
    flags.promptUsage = { ...u };
    const cc = u.cache_creation;
    if (cc?.ephemeral_1h_input_tokens > 0) flags.cache1h = true;
    if (cc?.ephemeral_5m_input_tokens > 0) flags.cache5m = true;
    if (!changed) return;
  }
  sse({ type: "usage", contextTokens: n, outputTokens: u.output_tokens || 0 });
}

/** 把 claude 的 stream-json 事件翻译成前端事件 */
export function translate(ev, { sse, onInit, onResult, onReplay, flags, provider }) {
  if (!ev || typeof ev !== "object") return;
  switch (ev.type) {
    case "system":
      if (ev.subtype === "init") onInit(ev);
      else if (ev.subtype === "status" && ev.status === "compacting") sse({ type: "compacting" });
      // 请求失败、claude 自己在退避重试：界面据此说「连接出错，重试 3/10」，而不是一直转圈让人猜
      else if (ev.subtype === "api_retry" && !ev.parent_tool_use_id) {
        sse({ type: "phase", phase: "retry", attempt: ev.attempt || 0, max: ev.max_retries || 0,
              status: ev.error_status ?? null, error: String(ev.error || "").slice(0, 200), delayMs: ev.retry_delay_ms || 0 });
      }
      // 子代理进度：在干什么（Reading a.txt）、用了多少 token / 几次工具；跑完（含后台子代理）报一次结果
      else if (ev.subtype === "task_progress" && ev.tool_use_id) {
        const u = ev.usage || {};
        sse({ type: "sub_progress", parent: ev.tool_use_id, desc: String(ev.description || "").slice(0, 200),
              tokens: u.total_tokens || 0, tools: u.tool_uses || 0 });
      }
      else if (ev.subtype === "task_notification" && ev.tool_use_id) {
        sse({ type: "sub_done", parent: ev.tool_use_id, status: String(ev.status || "") });
      }
      else if (ev.subtype === "compact_boundary") {
        // 压缩（手动 /compact 或自动）完成。以前不认这条：界面显示「无输出」，上下文条要等下一轮才变
        const m = ev.compact_metadata || ev.compactMetadata || {};
        const pre = m.pre_tokens ?? m.preTokens, post = m.post_tokens ?? m.postTokens;
        if (flags && post != null) flags.contextTokens = post;
        sse({ type: "compacted", trigger: m.trigger || "", pre: pre ?? null, post: post ?? null });
      }
      break;

    case "stream_event": {
      // --include-partial-messages：逐字增量
      const e = ev.event;
      // 原生接口在 message_start 给输入用量；兼容桥可能在 message_delta 才补齐。
      // delta 的 usage 可能只有输出字段，只合并同一次请求，绝不能跨请求累加。
      // 流在中途断了（厂商掐线、网络抖），claude 会自己补一句「接着说」再请求一次。断掉那次已逐字推出去、
      // 但没等到 assistant 事件的半截正文 / 思考不会进对话记录 —— 界面上也得删掉，否则两遍回答拼在一个气泡里（群友截图）
      if (e?.type === "message_start" && flags && !ev.parent_tool_use_id && (flags.pendText || flags.pendThink)) {
        sse({ type: "discard_partial", text: flags.pendText || 0, think: flags.pendThink || 0 });
        flags.pendText = 0; flags.pendThink = 0;
      }
      if (e?.type === "message_start") {
        if (!ev.parent_tool_use_id && !ev.isSidechain) {
          if (flags) flags.promptUsage = { ...e.message?.usage };
          contextUsage(e.message?.usage, flags, sse);
          sse({ type: "phase", phase: "wait" });   // 请求已被接住，模型还没出第一个字
        }
        break;
      }
      if (e?.type === "message_delta" && e.usage && !ev.parent_tool_use_id && !ev.isSidechain) {
        const u = { ...flags?.promptUsage, ...e.usage };
        if (flags) flags.promptUsage = u;
        contextUsage(u, flags, sse);
      }
      // 进行到哪一步（界面回复末尾的小字）：思考块、工具参数、正文各自开始时报一声。
      // 思考块不管有没有吐原文都会有 content_block_start，所以「思考中」不依赖能不能看到思考内容。
      // 工具参数（比如 Write 一个大文件）可能流几十秒，只报字数、节流到 0.4 秒一次。子代理的不报。
      if (!ev.parent_tool_use_id && flags) {
        if (e?.type === "content_block_start") {
          const k = e.content_block?.type;
          if (k === "thinking" || k === "redacted_thinking") sse({ type: "phase", phase: "think" });
          else if (k === "tool_use" || k === "server_tool_use") {
            flags.toolName = e.content_block.name || ""; flags.toolChars = 0; flags.toolAt = Date.now();
            sse({ type: "phase", phase: "tool", name: flags.toolName, chars: 0 });
          } else if (k === "text") sse({ type: "phase", phase: "text" });
        } else if (e?.type === "content_block_delta" && e.delta?.type === "input_json_delta") {
          flags.toolChars = (flags.toolChars || 0) + String(e.delta.partial_json || "").length;
          if (Date.now() - (flags.toolAt || 0) >= 400) toolEmit(flags, sse);
          else if (!flags.toolTimer) flags.toolTimer = setTimeout(() => toolEmit(flags, sse), 400 - (Date.now() - (flags.toolAt || 0)));   // 节流期间的最后一个数也要报出去
        } else if (e?.type === "content_block_stop" && flags.toolTimer) {
          // 参数写完时还有没报的数：补报，别丢。官方接口的参数是大块来的（一小块开头 + 一大块正文），
          // 以前这里直接清掉计时器，界面就停在开头那几个字上（比如「7 字」），DeepSeek 逐字流才看着正常
          clearTimeout(flags.toolTimer); toolEmit(flags, sse);
        }
      }
      if (e?.type === "content_block_delta" && e.delta?.type === "text_delta" && e.delta.text) {
        if (flags) { flags.gotDelta = true; if (!ev.parent_tool_use_id) flags.pendText = (flags.pendText || 0) + e.delta.text.length; }
        sse({ type: "delta", text: e.delta.text });
      } else if (e?.type === "content_block_delta" && e.delta?.type === "thinking_delta" && e.delta.thinking) {
        if (flags) { flags.gotThinkDelta = true; if (!ev.parent_tool_use_id) flags.pendThink = (flags.pendThink || 0) + e.delta.thinking.length; }
        sse({ type: "thinking_delta", text: e.delta.thinking });
      }
      break;
    }

    case "assistant": {
      // 子代理的消息（parent_tool_use_id = 主流程里那张 Agent 卡的 id）：工具调用和最后的汇报挂到那张卡下面，
      // 不混进主流程；子代理没有逐字增量，思考不转
      if (ev.parent_tool_use_id) {
        for (const c of ev.message?.content || []) {
          if (c.type === "tool_use") sse({ type: "tool_use", id: c.id, name: c.name, input: c.input, parent: ev.parent_tool_use_id });
          else if (c.type === "text" && c.text) sse({ type: "sub_text", parent: ev.parent_tool_use_id, text: String(c.text).slice(0, 20000) });
        }
        break;
      }
      // 没有逐字事件、或桥把最终用量补在 assistant 上时，仍能更新上下文。
      if (!ev.isSidechain && !ev.isMeta && !ev.isApiErrorMessage && ev.message?.model !== "<synthetic>") contextUsage(ev.message?.usage, flags, sse);
      // 逐字增量已发过就别重复整段文本
      const content = ev.message?.content || [];
      // 这一块已确认进了对话：逐字推过的不再算「半截」
      if (flags) for (const c of content) { if (c.type === "text") flags.pendText = 0; else if (c.type === "thinking" || c.type === "redacted_thinking") flags.pendThink = 0; }
      for (const c of content) {
        // 本地命令（/context /cost /compact …）的正文 claude 会发两遍：一条合成的 assistant 消息 + result。
        // 界面拿 result 画命令卡片，这里再发就重复了（以前 /context 显示两次）
        if (c.type === "text" && flags?.isCmd && ev.message?.model === "<synthetic>") continue;
        if (c.type === "text" && c.text) {
          // 逐字增量发过就不重复整段；没发过（增量没到）才补完整文本
          if (!flags || !flags.gotDelta) sse({ type: "assistant_text", text: c.text });
        } else if (c.type === "thinking" && c.thinking) {
          // 同理：思考也逐字发过了。以前这里无条件再发整段，思考块里每段都重复两遍
          if (!flags || !flags.gotThinkDelta) sse({ type: "thinking", text: c.thinking });
        } else if (c.type === "tool_use") {
          sse({ type: "tool_use", id: c.id, name: c.name, input: c.input });
        }
      }
      break;
    }

    case "user": {
      if (ev.isReplay) { if (onReplay) onReplay(ev); break; }
      for (const c of ev.message?.content || []) {
        if (c.type === "tool_result") {
          let txt = "";
          if (typeof c.content === "string") txt = c.content;
          else if (Array.isArray(c.content)) {
            txt = c.content.map((x) => (x.type === "text" ? x.text : `[${x.type}]`)).join("\n");
          }
          sse({ type: "tool_result", id: c.tool_use_id, ok: !c.is_error, text: String(txt).slice(0, 20000), ...(ev.parent_tool_use_id ? { parent: ev.parent_tool_use_id } : {}) });
        }
      }
      break;
    }

    case "result":
      onResult(ev);
      if (ev.is_error && ev.result) sse({ type: "error", message: String(ev.result).slice(0, 1500) });
      break;

    case "rate_limit_event":
      noteRateLimit(ev.rate_limit_info, provider);
      break;

    default:
      break;
  }
}

/** 订阅额度（5 小时 / 每周）。
 *  claude 每轮都会在 stream-json 里报一条 rate_limit_event，unifiedWindows 里就是两个窗口的占用比例和重置时间。
 *  网关只是记下 claude 自己吐出来的这条 —— 不拿令牌去查任何接口。
 *  所以额度要「发过一条消息」之后才有，之后每轮刷新；记下当时的账户，换账户就不显示旧数。 */
const RL_FILE = path.join(CFG.home, ".cache", "ccapp-ratelimits.json");
export let RATE_LIMITS = (() => { try { return JSON.parse(fs.readFileSync(RL_FILE, "utf8")); } catch { return null; } })();
export function clearRateLimits() { RATE_LIMITS = null; try { fs.unlinkSync(RL_FILE); } catch {} }
function noteRateLimit(info, p) {
  const w = info && info.unifiedWindows;
  if (!w || !isLoginMode(p)) return;    // 这一轮用的是登录态那家才记（全局可能是别家）
  const win = (x) => x && Number.isFinite(+x.utilization)
    ? { used: +x.utilization <= 1 ? Math.round(+x.utilization * 1000) / 10 : +x.utilization, resetsAt: x.resetsAt || null }
    : null;
  RATE_LIMITS = {
    at: Date.now(),
    email: AUTH_CACHE?.v?.email || null,
    status: info.status || null,
    fiveHour: win(w.five_hour), sevenDay: win(w.seven_day),
  };
  saveRateLimits();
  publish({ type: "quota" });       // 前端看得见额度的地方即时重画，不用切页面
  // 账户缓存是冷的就补查一次，把这份额度钉到账户上（换账户后不显示旧数）
  if (!RATE_LIMITS.email) authStatus().then((v) => { if (RATE_LIMITS && v.email) { RATE_LIMITS.email = v.email; saveRateLimits(); } }).catch(() => {});
}
function saveRateLimits() {
  try {
    fs.mkdirSync(path.dirname(RL_FILE), { recursive: true });
    fs.writeFileSync(RL_FILE, JSON.stringify(RATE_LIMITS));
  } catch {}
}
