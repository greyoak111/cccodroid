import fs from "node:fs";
import path from "node:path";
import { scanText } from "./breach.mjs";
import { CFG, HERE, LAST_LANG, PREFIX, tr, tz } from "./config.mjs";
import { SETTINGS } from "./settings-store.mjs";
import { isLoginMode, learnWindow } from "./models.mjs";
import { currentModelInfo } from "./claude.mjs";
import { AUTH_CACHE, authStatus } from "./login.mjs";
import { envFacts } from "./envfacts.mjs";
import { APP } from "./appfiles.mjs";
import { publish } from "./bus.mjs";

// ── 系统提示补充、claude 流事件翻译、订阅额度 ─────────────────────────
/** 给 claude 的工具说明。两种布局装的东西不一样，各说各的，别把没有的命令告诉它 */
// 第三方模型的清单提醒（见 providerEnv 里的 CLAUDE_CODE_ENABLE_TODO_TOOLS）；Claude 型号自己会用，不用提醒
// 查看器能直接预览 HTML：告诉 Claude 静态网页写好给路径就行，别动不动起 http.server（还得用户自己找端口）
export const TASKS_HINT = "When a request has 3 or more distinct steps, track them with the TaskCreate and TaskUpdate tools: create the tasks first, mark each in_progress when you start it and completed when it is done. The user sees this list as a live progress panel.";
/** 报一次「正在写工具参数」的字数（节流用） */
function toolEmit(flags, sse) {
  flags.toolTimer = null; flags.toolAt = Date.now();
  // 工具卡已经发出去（参数写完、工具在跑）就别再报：claude 有时先给整条 assistant、后给 content_block_stop，
  // 补报会把「正在写 Bash 的参数」又挂回去，命令跑多久它就跟着计多久
  if (flags.toolId && flags.toolsOut?.has(flags.toolId)) return;
  sse({ type: "phase", phase: "tool", name: flags.toolName || "", id: flags.toolId || "", chars: flags.toolChars });
}

export function toolsHint() {
  if (PREFIX) {
    // 随包的 TOOLS.md 是逐项实测过的工具清单与用法（cccodroid-selftest 验证），优先用它；后面接本机实况
    try {
      // 部署出来的那份用网关启动时读进内存的（见 appfiles.mjs）：跑着的时候文件被改了也不进系统提示
      // 快照里没有（启动时就对不上）也不回头读盘：读到的就是被改过的那份
      const t = (APP ? APP.text("TOOLS.md") ?? "" : fs.readFileSync(path.join(HERE, "TOOLS.md"), "utf8"))
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
      "只有查看类（带服务名的 dumpsys、pm list/path、settings get、getprop 等，不带变量、通配、子 shell，输出只能重定向到 /dev/null）直接执行；其余（打开界面 am start、装卸应用、改设置、截屏、input 点按、写文件、logcat、读共享存储里的文件…）会弹窗等用户点允许，cccodroid 不在前台时直接拒绝（退出码 126）——被拒就告诉用户，别换写法重试。",
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
// claude 2.1.311 只认 100k～1M 的压缩线，越界的按边界算（H3t：below_minimum → 1e5）。界面照这个显示，别按 20k 画满格（195-O.2）
export const AC_BOUNDS = [1e5, 1e6];
export const clampAutoCompact = (n) => Math.min(AC_BOUNDS[1], Math.max(AC_BOUNDS[0], Math.round(n)));
/** 上游 API 报错归个类，给一句中文的处理建议；认不出来给空串（照旧只显示原文） */
export function apiErrorHint(raw) {
  const s = String(raw || ""), code = Number((/\bAPI Error:?\s*(\d{3})\b/i.exec(s) || /\b(?:status|HTTP)\s*(\d{3})\b/i.exec(s) || [])[1]) || 0;
  if (/prompt is too long|context(?:_| )length|maximum context|too many tokens/i.test(s)) return tz("对话太长，超过了模型的上下文上限。打 /compact 压缩一下再继续，或者开个新对话。");
  if (code === 401 || code === 403 || /authentication_error|invalid (?:x-)?api[ _-]?key|permission_error|unauthori[sz]ed/i.test(s)) return tz("接口拒绝了密钥：到 设置 → 接口 检查 API Key 填得对不对、有没有过期或被停用。");
  if (code === 402 || /insufficient[_ ](?:balance|quota|credit)|余额不足|credit balance is too low|billing/i.test(s)) return tz("账户余额不足或额度用完了：到接口那边的控制台充值或查看额度。");
  if (code === 429 || /rate[_ ]limit|too many requests/i.test(s)) return tz("请求太频繁，或者用量到了上限：稍等一会儿再试。");
  if (code === 404 || /not_found_error|model[^\n]{0,40}(?:not (?:found|exist)|does not exist)/i.test(s)) return tz("接口找不到这个模型或地址：检查模型名和接口地址。");
  if (code === 529 || code >= 500 || /overloaded_error|internal server error|bad gateway|service unavailable/i.test(s)) return tz("接口那边出错或者忙不过来：稍后再试。一直这样就换个模型或接口。");
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|fetch failed|socket hang up|network error|Connection error/i.test(s)) return tz("连不上接口：检查网络，或者接口地址是不是写错了。");
  return "";
}

export function effectiveAutoCompact() {
  if (SETTINGS.autoCompactWindow) return clampAutoCompact(SETTINGS.autoCompactWindow);
  try {
    const j = JSON.parse(fs.readFileSync(path.join(CFG.home, ".claude", "settings.json"), "utf8"));
    const n = Number(j.autoCompactWindow);
    if (Number.isFinite(n) && n > 0) return clampAutoCompact(n);
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

/** 钩子注入的文本是否命中破甲特征（红队 11-07 通道 C）：命中返回文本（中止这一轮、原文亮给用户），不命中返回 "" */
export function hookBlocked(ev) {
  const text = hookContext(ev);
  return text && scanText(text).blocked ? text : "";
}
/** 钩子输出里会进模型上下文的那段：JSON 的 additionalContext；SessionStart / UserPromptSubmit 正常退出时纯文本的 stdout 也算 */
export function hookContext(ev) {
  const out = String(ev.stdout ?? ev.output ?? "").trim();
  if (!out) return "";
  let j = null;
  if (out.startsWith("{")) { try { j = JSON.parse(out); } catch {} }
  if (j && typeof j === "object") {
    const c = j.hookSpecificOutput?.additionalContext;
    return typeof c === "string" ? c.slice(0, 20000) : Array.isArray(c) ? c.join("\n").slice(0, 20000) : "";
  }
  return ["SessionStart", "UserPromptSubmit"].includes(ev.hook_event) && !ev.exit_code ? out.slice(0, 20000) : "";
}

/** 把 claude 的 stream-json 事件翻译成前端事件 */
/** 「这条消息已经逐字推过」按来路分开记：主会话用 flags 本身，子代理（parent_tool_use_id）、旁链（isSidechain）各记各的。
 *  以前共用一份：子代理一条 message_start 就把主会话的标记清掉，主会话的 assistant 整段又发一遍（重复）；
 *  旁链的增量把它置上，主会话没增量的正文反被挡住（丢字）（0.6.9 审计 195-U.1） */
const isMainLane = (ev) => !ev.parent_tool_use_id && !ev.isSidechain;
function laneFlags(flags, ev) {
  if (!flags || isMainLane(ev)) return flags;
  const k = ev.parent_tool_use_id || "sidechain";
  const m = (flags.lanes ||= new Map());
  let o = m.get(k);
  if (!o) { o = { gotDelta: false, gotThinkDelta: false }; m.set(k, o); if (m.size > 64) m.delete(m.keys().next().value); }
  return o;
}
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
      // 钩子往这一轮塞了话（SessionStart / UserPromptSubmit 的输出、additionalContext）：界面上折叠显示原文，
      // 每轮注入的东西摆在用户眼前（需要 --include-hook-events；会话记录里是 hook_additional_context，见 transcript.mjs）
      else if (ev.subtype === "hook_response") {
        const text = hookContext(ev);
        if (text) sse({ type: "hook_ctx", event: String(ev.hook_event || ev.hook_name || "").slice(0, 60), text });
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
      if (e?.type === "message_start" && flags && isMainLane(ev) && (flags.pendText || flags.pendThink)) {
        sse({ type: "discard_partial", text: flags.pendText || 0, think: flags.pendThink || 0 });
        flags.pendText = 0; flags.pendThink = 0;
      }
      if (e?.type === "message_start") {
        // 每条消息单独记「是否已逐字推过」：同一条进程里会有多轮 assistant（后台回报、插话、斜杠命令），
        // 沿用上一条的 true 会把下一条没有增量的正文吞掉（审查 11-05）
        const lf = laneFlags(flags, ev);
        if (lf) { lf.gotDelta = false; lf.gotThinkDelta = false; }
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
            flags.toolName = e.content_block.name || ""; flags.toolId = e.content_block.id || ""; flags.toolChars = 0; flags.toolAt = Date.now();
            if (flags.toolTimer) { clearTimeout(flags.toolTimer); flags.toolTimer = null; }
            sse({ type: "phase", phase: "tool", name: flags.toolName, id: flags.toolId, chars: 0 });
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
        if (flags) { laneFlags(flags, ev).gotDelta = true; if (isMainLane(ev)) flags.pendText = (flags.pendText || 0) + e.delta.text.length; }
        sse({ type: "delta", text: e.delta.text });
      } else if (e?.type === "content_block_delta" && e.delta?.type === "thinking_delta" && e.delta.thinking) {
        if (flags) { laneFlags(flags, ev).gotThinkDelta = true; if (isMainLane(ev)) flags.pendThink = (flags.pendThink || 0) + e.delta.thinking.length; }
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
      if (flags && isMainLane(ev)) for (const c of content) { if (c.type === "text") flags.pendText = 0; else if (c.type === "thinking" || c.type === "redacted_thinking") flags.pendThink = 0; }
      const lf = laneFlags(flags, ev);
      for (const c of content) {
        // 本地命令（/context /cost /compact …）的正文 claude 会发两遍：一条合成的 assistant 消息 + result。
        // 界面拿 result 画命令卡片，这里再发就重复了（以前 /context 显示两次）
        if (c.type === "text" && flags?.isCmd && ev.message?.model === "<synthetic>") continue;
        if (c.type === "text" && c.text) {
          // 逐字增量发过就不重复整段；没发过（增量没到）才补完整文本。
          // 本地命令的合成消息没有增量，且本轮前面正常回答时 gotDelta 已是 true，必须无条件发（审查 11-05）
          if (!lf || !lf.gotDelta || ev.message?.model === "<synthetic>") sse({ type: "assistant_text", text: c.text });
        } else if (c.type === "thinking" && c.thinking) {
          // 同理：思考也逐字发过了。以前这里无条件再发整段，思考块里每段都重复两遍
          if (!lf || !lf.gotThinkDelta) sse({ type: "thinking", text: c.thinking });
        } else if (c.type === "tool_use") {
          if (flags) {
            (flags.toolsOut ||= new Set()).add(c.id);
            if (flags.toolId === c.id && flags.toolTimer) { clearTimeout(flags.toolTimer); flags.toolTimer = null; }
          }
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
          // 工具结果太长时截断要留标记：以前静默截到两万字符，用户以为工具就返回了这么多（FIND-045）
          const full = String(txt);
          sse({ type: "tool_result", id: c.tool_use_id, ok: !c.is_error,
            text: full.length > 20000 ? full.slice(0, 20000) + "\n\n" + tr(LAST_LANG, tz("…（已截断）")) : full,
            ...(ev.parent_tool_use_id ? { parent: ev.parent_tool_use_id } : {}) });
        }
      }
      break;
    }

    case "result":
      onResult(ev);
      if (ev.is_error && ev.result) {
        // 上游报错原文多是英文：认得出的先给一句能照着做的话，原文放 detail（0.6.9 审计 195-R.3）
        const raw = String(ev.result).slice(0, 1500), hint = apiErrorHint(raw);
        sse(hint ? { type: "error", message: tr(LAST_LANG, hint), detail: raw } : { type: "error", message: raw });
      }
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
    // utilization 是占用比例（claude 的 schema 说明：通常 0–1，真用超了会 >1）——一律换成百分数，超额度如实显示 120%（0.6.9 审计 197-5.7）
    ? { used: Math.round(+x.utilization * 1000) / 10, resetsAt: x.resetsAt || null }
    : null;
  const now = Date.now(), email = AUTH_CACHE?.v?.email || null;
  // 分模型的周窗口（Opus / Sonnet 各自的周额度）：unifiedWindows 里没有，只在它成了当前最紧的那个窗口时，
  // 由事件顶层的 rateLimitType + utilization 报出来（同样是 0–1 比例）。报过就记着，到重置时间才丢；
  // 换了账户不沿用（用户定：只用现成事件，不为此另开网络请求）
  const prev = RATE_LIMITS && RATE_LIMITS.modelWeek && (!email || !RATE_LIMITS.email || RATE_LIMITS.email === email) ? RATE_LIMITS.modelWeek : {};
  const modelWeek = {};
  for (const [k, v] of Object.entries(prev)) if (v && (!v.resetsAt || v.resetsAt * 1000 > now)) modelWeek[k] = v;
  const mk = { seven_day_opus: "opus", seven_day_sonnet: "sonnet" }[info.rateLimitType];
  if (mk && Number.isFinite(+info.utilization)) modelWeek[mk] = { used: Math.round(+info.utilization * 1000) / 10, resetsAt: info.resetsAt || null };
  RATE_LIMITS = {
    at: now,
    email,
    status: info.status || null,
    fiveHour: win(w.five_hour), sevenDay: win(w.seven_day),
    ...(Object.keys(modelWeek).length ? { modelWeek } : {}),
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
