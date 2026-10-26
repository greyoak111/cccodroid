import fs from "node:fs";
import { spawn } from "node:child_process";
import { CFG, LAST_LANG, PATHS, log, tr, tz } from "./config.mjs";
import { SETTINGS } from "./settings.mjs";
import { PERM_MODES, PROVIDER, billAfterRun, keyOf, noteTokens, providerById } from "./providers.mjs";
import { ALIAS_SEEN, effortLevelsOf, fetchModels, isLoginMode, normEffort } from "./models.mjs";
import { claudeCmd, claudeEnv, currentModelInfo, ensureBridge, settingsArgs } from "./claude.mjs";
import { tasksCheck } from "./goal.mjs";
import { setLastInit } from "./caps.mjs";
import { RUNS, SESSIONS, rememberSession, runFlag, runList } from "./runs.mjs";
import { NEXT, readBody, sendJson } from "./http.mjs";
import { INTERRUPTED, QUEUE, RUN_LANE, RUN_SESSIONS, abortRun, endRun, idleArm, idleDisarm, laneOfItem, publishState, runEmit, saveRunMark, setInterrupted, setPermMode } from "./queue.mjs";
import { handleLocalCommand } from "./modelcmd.mjs";
import { LL, ensureLlama, localCustomActive } from "./local.mjs";
import { deviceMcpConfig, privCall, usageAdd, usageIsPrompt } from "./usage.mjs";
import { PREVIEW_HINT, TASKS_HINT, contextWindowOf, promptTokens, toolsHint, translate } from "./stream.mjs";
import { archiveHint } from "./archive.mjs";
import { findSessionFile, peekSession } from "./sessions.mjs";
import { projectById, projectDefaults, projectOfDir } from "./projects.mjs";
import { sessModel, sessProvider, setSessModel } from "./sessmodel.mjs";

// 必须由人回答的工具：全部放行也照问（问题、计划审批）
const HUMAN_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

/** 这一轮在哪个目录跑：显式指定 → 接着的会话当初的 cwd（--resume 只在同一 cwd 下找得到）→ 项目目录 → 工作区 */
const isDirSync = (d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } };
function cwdOf(item, sessionId) {
  if (item.cwd && isDirSync(item.cwd)) return item.cwd;
  if (sessionId) { const f = findSessionFile(String(sessionId)); const c = f && peekSession(f.file).cwd; if (c && isDirSync(c)) return c; }
  if (item.projectId) { const p = projectById(item.projectId); if (p && isDirSync(p.path)) return p.path; }
  return fs.existsSync(CFG.workspace) ? CFG.workspace : CFG.home;
}

// ── 跑一轮 ────────────────────────────────────────────────────────────
// 和 HTTP 请求完全脱钩：前端断了也接着跑，结果照样落进 transcript、照样广播。
export async function startRun(item) {
  // 这一轮用哪家：定时任务指定的 → 新会话首条带来的选择（pin）→ 这个会话钉的 → 项目默认 → 全局生效的。
  // 整轮都按它（地址、密钥、模型名规则）
  const sid0 = item.sessionId || (item.follow && RUN_SESSIONS.get(item.follow)) || null;
  const pdef0 = projectDefaults(item.projectId ? projectById(item.projectId) : projectOfDir(cwdOf(item, sid0)));
  const rec0 = sessModel(sid0);
  const P = (item.provider && providerById(item.provider))
    || (item.pin && item.pin.provider && providerById(item.pin.provider))
    || (rec0 && rec0.model != null ? sessProvider(sid0) : null)
    || (pdef0.provider && providerById(pdef0.provider))
    || sessProvider(sid0);
  const KEY = keyOf(P);
  const run = {
    id: item.id,
    text: item.message,
    // 跟在一个还没拿到会话号的新会话后面排队的：等前一条 init 了再接上它的会话
    sessionId: item.sessionId || (item.follow && RUN_SESSIONS.get(item.follow)) || null,
    follow: item.follow,
    cid: item.cid,
    auto: item.auto || null,           // "idle" = 网关自己发起的空闲压缩（界面画成系统提示，不发通知）
    startedAt: Date.now(),
    child: null, aborted: false, ended: false,
    provider: P.id,                    // 这一轮用的那家：记 token、删接口前查占用都看它
    log: [], pend: null, pendTimer: null,
    sched: item.sched || null,         // 定时任务跑的：{ taskId, runKey }（结束时 sched.mjs 记运行记录）
    channel: item.channel || null,     // 频道来的：{ channelId, chatKey, ... }（结束时 channels.mjs 把回复发回聊天）
    unattended: !!item.unattended,     // 没人看着：要确认的一律拒绝
  };
  run.lane = laneOfItem(item);
  RUNS.set(run.id, run);                 // 同步占槽，中间不许有 await
  RUN_LANE.set(run.id, run.lane);
  if (RUN_LANE.size > 1000) for (const k of [...RUN_LANE.keys()].slice(0, 500)) if (!RUNS.has(k)) RUN_LANE.delete(k);
  runFlag(true);
  // 在被中断的那个会话里又跑起来了（点了「继续」或者直接接着聊）：中断提示就不用再挂着了
  if (INTERRUPTED && (INTERRUPTED.sessionId ? INTERRUPTED.sessionId === run.sessionId : !run.sessionId)) setInterrupted(null);
  if (run.sessionId) { RUN_SESSIONS.set(run.id, run.sessionId); idleDisarm(run.sessionId); }
  const emit = (ev) => runEmit(run, ev);
  emit({ type: "run_start", text: run.text, sessionId: run.sessionId, follow: run.follow, cid: run.cid, startedAt: run.startedAt, ...(run.auto ? { auto: run.auto } : {}) });
  publishState();

  const message = run.text;
  const local = message.trim().match(/^\/(model|models|effort|autocompact)(?:\s+([\s\S]*))?$/);
  if (local) {
    log(`⌘ 本地命令 /${local[1]}${local[2] ? " " + local[2].trim() : ""}`);
    return handleLocalCommand(local[1], (local[2] || "").trim(),
      (text, cmd) => endRun(run, { localCommand: cmd || local[1], resultText: text, durationMs: 0, costUsd: 0 }), run.sessionId);
  }

  if (!KEY && !P.login) {
    emit({ type: "error", message: tr(LAST_LANG, tz("未配置 API 密钥。请在设置里填入 {name} 的密钥。", { name: P.label || P.id })) });
    return endRun(run, { failed: true });
  }
  // 用户在设置里卸了 Claude Code（之后自己选版本装）：说清楚，别让加载器报一句看不懂的找不到文件
  if (!fs.existsSync(PATHS.claude)) {
    emit({ type: "error", message: tr(LAST_LANG, tz("Claude Code 未安装。到 设置 → 更新 里点「安装…」选一个版本装上。")) });
    return endRun(run, { failed: true });
  }
  if (P.id === PROVIDER.id && !isLoginMode() && !(await ensureBridge())) {   // 别家直连，不经桥
    emit({ type: "error", message: tr(LAST_LANG, tz("本地 DNS 桥启动失败，无法连接 API。")) });
    return endRun(run, { failed: true });
  }
  if (run.aborted) return endRun(run, { failed: true });   // 等桥的时候就被停了

  const cwd = cwdOf(item, run.sessionId);
  run.cwd = cwd;
  const pdef = projectDefaults(item.projectId ? projectById(item.projectId) : projectOfDir(cwd));
  if (!item.permissionMode && pdef.perm) item.permissionMode = pdef.perm;
  // 模型 / 思考强度的取值顺序：本次请求指定（定时任务）→ 新会话首条带来的选择（pin）→ 这个会话单独选过的
  // → 项目默认 → 全局默认（设置页）→ 该厂商自己的默认。选过的 "" 表示「接口默认」，也算选过
  // ⚠️ 不能回落到 CFG.model：那是全局兜底（deepseek-flash），只有内置厂商能碰。
  // 首条带来的接口和会话现在的不是同一家时，会话记下的模型名不作数
  const own0 = sessModel(run.sessionId), pin = item.pin || {};
  const own = own0 && (own0.model == null || own0.provider === P.id) ? own0 : null;
  const ownM = pin.model != null ? pin.model : own && own.model != null ? own.model : null;
  const ownE = pin.effort != null ? pin.effort : own && own.effort != null ? own.effort : null;
  let effort = item.effort || (ownE != null ? ownE : pdef.effort || SETTINGS.effort) || "";
  // 项目默认的模型名是给项目那家的（没指定家就是全局那家），全局默认的是给全局那家的；对不上的不作数，走这家自己的默认
  const fallM = (P.id === (pdef.provider || PROVIDER.id) ? pdef.model : "") || (P.id === PROVIDER.id ? SETTINGS.model : "");
  let model = (item.model || (ownM != null ? ownM : fallM) || P.defaultModel || (P.explicit ? "" : CFG.model) || "").trim();
  // 原生厂商只认 claude 自家的模型名；别家的名字（切厂商前留下的）宁可不传，交给 claude 自己选
  if (P.nativeModels && model && !/^(claude-|opus|sonnet|haiku|fable|default|best)/i.test(model)) model = "";
  // 别家的清单拉一次（10 分钟缓存）：窗口、档位映射要用。思考强度是跟着全局 / 项目来的、这家模型不支持时，换成它支持的
  if (P.id !== PROVIDER.id && !P.local) await fetchModels(false, P).catch(() => {});
  if (effort && !P.local) {
    const mi = currentModelInfo(model, P);
    if (!effortLevelsOf(mi, P).includes(effort)) effort = normEffort(mi, effort, P) || "";
  }
  let permMode = String(item.permissionMode || SETTINGS.permissionMode || "default").trim();
  if (!PERM_MODES.includes(permMode)) permMode = "default";

  // 端侧小模型：先确保 llama-server 跑着、载的是这个模型（第一次要加载十几秒）
  if (P.local) {
    try {
      const m = await ensureLlama(model, (key, text) => emit({ type: "note", key, text }));
      model = m.id;
      LL.run = run;
    } catch (e) {
      emit({ type: "error", message: e.message });
      return endRun(run, { failed: true });
    }
    if (run.aborted) return endRun(run, { failed: true });
  }

  const argv = [
    "-p",
    // 流式输入：stdin 一直开着，跑到一半还能再递消息进去（插话）。
    // --replay-user-messages 让 claude 在真正吃进一条消息时回显出来 —— 我们靠它知道插话何时送达。
    "--input-format", "stream-json",
    "--replay-user-messages",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode", permMode,
    // 只是让「全部放行」可选、不默认打开：不带它，跑到一半切到全部放行会被 claude 拒绝（bypass_not_launched），
    // 界面却显示已切换 —— 群友反馈「一直全部放行还要授权」的原因之一（2.1.308 实测）
    "--allow-dangerously-skip-permissions",
    // 要确认的工具调用走 stdout 的 control_request(can_use_tool) 来问我们，前端出卡片，用户点了再回 stdin。
    // 不加这个，-p 模式下 claude 不问，直接按拒绝处理（实测：工具结果 "…needs approval"）
    "--permission-prompt-tool", "stdio",
  ];
  if (model) argv.push("--model", model);
  if (run.sessionId) argv.push("--resume", String(run.sessionId));
  // 设备工具（通知、剪贴板、打开应用、读屏点按…）：只有 cccodroid 有 Java 那一层。开关在应用里，
  // 这里只看总开关决定挂不挂；具体哪些工具出现由 device-mcp.mjs 现问应用。端侧小模型不挂（读不起）
  const devMcp = deviceMcpConfig();
  if (devMcp && !P.local && (await privCall({ op: "dev_status" }, 3000)).on) argv.push("--mcp-config", devMcp);

  // 告诉 claude 这台设备上有什么现成工具 —— 不说它就不会去用。
  // 和用户自己的追加提示合成一条：重复给同一个单值参数，解析器一般只留一个，合成一条最稳
  // 端侧：--bare 换成很短的系统提示和精简工具（见「端侧小模型」一节）；本机工具清单太长，小模型读不起，不附
  // 内置只有聊天（不给工具）；自定义模式的工具清单和提示由用户的配置文件给（见 localCustom）
  const lcust = P.local ? localCustomActive() : null;
  if (P.local) argv.push("--bare", "--tools", lcust ? lcust.tools : "");
  // 端侧只补一句身份（--bare 的提示自称 Claude，小模型会照着说），几十 token，不拖慢首字
  const localHint = !P.local ? "" : lcust && lcust.systemPrompt ? lcust.systemPrompt
    : `You are ${model}, a small open model running locally on the user's Android device through llama.cpp (not Claude). Reply in the user's language; keep answers short.`;
  // 建档（脉络）：常驻规则 + 这一轮该不该先建档（见 archive.mjs）
  const arch = P.local ? null : await archiveHint(run.sessionId).catch(() => null);
  const appendPrompt = [P.local ? localHint : toolsHint(), !P.nativeModels && !P.local ? TASKS_HINT : "", P.local ? "" : PREVIEW_HINT, arch?.rule, SETTINGS.appendSystemPrompt].filter(Boolean).join("\n\n");
  if (appendPrompt) argv.push("--append-system-prompt", appendPrompt);
  // claude 没有 --output-style 参数（传了直接 unknown option，整条消息失败）；它是 settings 里的 outputStyle。
  // 密钥读取器也在这里（见 settingsArgs）
  argv.push(...settingsArgs(P));
  if (effort) argv.push("--effort", effort);
  const allowed = [...(SETTINGS.allowedTools || []), ...(Array.isArray(item.allowedTools) ? item.allowedTools : [])];
  if (allowed.length) argv.push("--allowedTools", allowed.join(","));
  const disallowed = [...(SETTINGS.disallowedTools || []), ...(Array.isArray(item.disallowedTools) ? item.disallowedTools : [])];
  if (disallowed.length) argv.push("--disallowedTools", disallowed.join(","));

  const dirs = new Set();
  if (fs.existsSync(CFG.workspace) && cwd !== CFG.workspace) dirs.add(CFG.workspace);
  if (process.env.CCAPP_SHARED && fs.existsSync(process.env.CCAPP_SHARED)) dirs.add(process.env.CCAPP_SHARED);
  for (const d of SETTINGS.addDirs || []) if (fs.existsSync(d)) dirs.add(d);
  for (const d of item.addDirs || []) if (typeof d === "string" && fs.existsSync(d)) dirs.add(d);
  for (const d of dirs) argv.push("--add-dir", d);

  const isCmd = message.trim().startsWith("/");
  log(`▶ ${isCmd ? "命令" : "提问"} ${message.trim().slice(0, 60).replace(/\s+/g, " ")}  ${run.sessionId ? `(续 ${String(run.sessionId).slice(0, 8)})` : "(新会话)"}  [model=${model || "默认"} effort=${effort || "默认"} style=${SETTINGS.outputStyle || "默认"} perm=${permMode}]`);
  const t0 = Date.now();

  const [cmd0, args0] = claudeCmd(argv);
  const child = spawn(cmd0, args0, {
    cwd,
    // CCAPP_RUN_ID / CCAPP_GW_PORT：建档命令 cc-archive 靠它们告诉网关「这是哪一轮」
    env: { ...claudeEnv({ model, provider: P }), CCAPP_RUN_ID: String(run.id), CCAPP_GW_PORT: String(CFG.port) },
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,            // 当进程组长，中断时好整组带走（见 killTree）
  });
  run.child = child;
  if (item.timeoutMs > 0) run.limitTimer = setTimeout(() => { run.timedOut = true; log(`⏱ 超过时长上限 ${Math.round(item.timeoutMs / 60000)} 分钟，停止`); abortRun(run); }, item.timeoutMs);
  child.stdin.on("error", () => {});
  const writeUser = (content) => child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n");
  // 该建档时，提醒作为本轮消息的第二段跟进去：读用户消息的地方只认第一段、或跳过 <…> 开头的段，历史 / 搜索 / 分叉比对都看不见它。斜杠命令不带（包成两段 claude 就不认它是命令了）
  writeUser(arch?.note && !message.trim().startsWith("/") ? [{ type: "text", text: message }, { type: "text", text: `<system-reminder>\n${arch.note}\n</system-reminder>` }] : message);
  run.inputOpen = true;
  run.pendingInject = [];      // 已写进 stdin、还没被 claude 吃进去的插话
  run.bgTasks = 0;             // claude 报的后台任务数（见 feed）
  run.bgList = [];             // 后台任务明细：{ id, type, desc }（shell / 子代理 / monitor / 工作流），界面列出来、可单独停
  run.replays = 0;
  run.usageTools = new Set();   // 使用统计：本轮见过的工具调用（流式会重复报同一个）
  run.inject = (item) => {
    if (!run.inputOpen || run.ended || run.aborted) return false;
    try { writeUser(item.message); } catch { return false; }
    run.pendingInject.push(item);
    saveRunMark();     // 马上落盘：送达前 App 被强停，下次启动它还能回到队列里，不会凭空消失
    log(`↪ 插话 ${item.message.trim().slice(0, 60).replace(/\s+/g, " ")}`);   // 压成一行：诊断包按行抹掉对话内容
    return true;
  };
  // 每轮 result 之后：没有待送达的插话就关 stdin，claude 随即退出；有就留着，它会接着处理
  // ── 权限确认（stream-json 控制协议）──
  // claude 要用需确认的工具时，往 stdout 发 control_request(can_use_tool) 然后等；我们回 control_response。
  // 待答的请求存在 run.perms，同时作为 perm_request 事件发给前端（也进 run.log，断线重连能补到）。
  run.perms = new Map();
  const writeCtl = (o) => { try { child.stdin.write(JSON.stringify(o) + "\n"); return true; } catch { return false; } };
  let ctlN = 0;
  run.permMode = permMode;
  run.setMode = (mode) => { run.permMode = mode; return run.inputOpen && writeCtl({ type: "control_request", request_id: "ccapp-" + (++ctlN), request: { subtype: "set_permission_mode", mode } }); };
  // 停掉一个后台任务（stop_task 控制请求；claude 停完会再报一次 background_tasks_changed）
  run.stopTask = (taskId) => run.inputOpen && run.bgList.some((t) => t.id === taskId) &&
    writeCtl({ type: "control_request", request_id: "ccapp-" + (++ctlN), request: { subtype: "stop_task", task_id: taskId } });
  run.answerPerm = (id, a) => {
    const p = run.perms.get(id);
    if (!p || run.ended || run.aborted) return false;
    let resp;
    if (a.behavior === "allow") {
      // 参数一律用 claude 发来的原样，前端改不了命令；AskUserQuestion 只往里加 answers
      const input = p.tool === "AskUserQuestion" && a.answers && typeof a.answers === "object"
        ? { ...p.input, answers: Object.fromEntries(Object.entries(a.answers).map(([k, v]) => [String(k), String(v)])) }
        : p.input;
      resp = { behavior: "allow", updatedInput: input };
      // 「始终允许」：只认 claude 自己给的建议（规则 + 目录），前端不能塞任意规则；切模式另走 a.mode
      if (a.always) {
        const ups = (p.suggestions || []).filter((x) => x && (x.type === "addRules" || x.type === "addDirectories"));
        if (ups.length) resp.updatedPermissions = ups;
      }
    } else {
      resp = { behavior: "deny", message: String(a.message || "").trim().slice(0, 2000) || "用户拒绝了这次操作。", ...(a.interrupt ? { interrupt: true } : {}) };
    }
    if (!writeCtl({ type: "control_response", response: { subtype: "success", request_id: id, response: resp } })) return false;
    run.perms.delete(id);
    log(`${resp.behavior === "allow" ? "✓ 允许" : "✗ 拒绝"} ${p.tool}${a.always && resp.updatedPermissions ? "（始终）" : ""}${a.interrupt ? "（并停止）" : ""}`);
    emit({ type: "perm_resolved", id, behavior: resp.behavior, always: !!resp.updatedPermissions, interrupt: !!a.interrupt });
    if (a.mode && PERM_MODES.includes(a.mode)) setPermMode(a.mode);
    publishState();
    return true;
  };
  const onControl = (ev) => {
    const id = ev.request_id, r = ev.request || {};
    if (r.subtype === "can_use_tool" && id) {
      const p = {
        id, tool: String(r.tool_name || ""), input: r.input || {}, toolUseId: r.tool_use_id || null,
        suggestions: Array.isArray(r.permission_suggestions) ? r.permission_suggestions : [],
        reason: r.decision_reason || null, blockedPath: r.blocked_path || null, description: r.description || null,
        interactive: !!r.requires_user_interaction, agentId: r.agent_id || null, at: Date.now(),
        runId: run.id, sessionId: run.sessionId || null,   // 并行时通知要知道是哪个会话的
      };
      if (run.unattended) {
        log(`✗ 无人值守，自动拒绝 ${p.tool} ${String(p.input.command || p.input.file_path || p.input.url || "").slice(0, 60)}`);
        (run.denied = run.denied || []).push(p.tool);
        writeCtl({ type: "control_response", response: { subtype: "success", request_id: id, response: { behavior: "deny",
          message: "This is an unattended scheduled run: nobody can approve this action, so it is denied. Do not retry it; finish with what you can do and say what was blocked." } } });
        return;
      }
      // 全部放行时 claude 不该再来问；来了（子代理没继承到模式之类）就直接放行，必须由人回答的（AskUserQuestion 等）照问
      if (run.permMode === "bypassPermissions" && !p.interactive && !HUMAN_TOOLS.has(p.tool)) {
        log(`✓ 全部放行，自动允许 ${p.tool}${p.agentId ? "（子代理）" : ""} ${String(p.input.command || p.input.file_path || p.input.url || "").slice(0, 60)}`);
        writeCtl({ type: "control_response", response: { subtype: "success", request_id: id, response: { behavior: "allow", updatedInput: p.input } } });
        return;
      }
      run.perms.set(id, p);
      log(`⏸ 等确认 ${p.tool} ${String(p.input.command || p.input.file_path || p.input.url || "").slice(0, 60)}`);
      emit({ type: "perm_request", ...p });
      publishState();
      return;
    }
    // 别的控制请求（hook 回调、MCP elicitation…）我们不接：回错误，别让 claude 干等
    if (id) writeCtl({ type: "control_response", response: { subtype: "error", request_id: id, error: `unsupported: ${r.subtype}` } });
  };

  const closeInput = () => {
    if (!run.inputOpen || run.perms.size) return;
    run.inputOpen = false;
    try { child.stdin.end(); } catch {}
  };

  let buf = "", stderr = "", lastResult = null;
  // 开了 --include-partial-messages，正文已经逐字发过，assistant 事件别重复整段
  const flags = { gotDelta: false, isCmd };
  const onInit = (init) => {
    setLastInit(init);
    run.sessionId = init.session_id;
    run.usageModel = init.model || run.usageModel;
    // 新会话的 run_start 发出时还没有会话号：回填进日志，别的视图切过来、整轮重放时才认得出这是它的
    for (const e of run.log || []) if (e.type === "run_start" && !e.sessionId) e.sessionId = run.sessionId;
    RUN_SESSIONS.set(run.id, run.sessionId);
    if (RUN_SESSIONS.size > 500) RUN_SESSIONS.delete(RUN_SESSIONS.keys().next().value);
    rememberSession(run.sessionId);
    if (item.pin) setSessModel(run.sessionId, item.pin);   // 新会话首条带来的选择：有了会话号就记上
    saveRunMark();                       // 标记里补上会话号：被杀之后「继续」要靠它 --resume
    if (!SESSIONS.has(init.session_id)) {
      SESSIONS.set(init.session_id, { id: init.session_id, title: message.slice(0, 60), createdAt: Date.now() });
    }
    if (model && init.model && model !== init.model) ALIAS_SEEN[model] = init.model;
    emit({
      type: "init",
      sessionId: init.session_id,
      model: init.model,
      permissionMode: init.permissionMode,
      outputStyle: init.output_style,
      version: init.claude_code_version,
    });
    publishState();
  };
  const onResult = (r) => {
    lastResult = r;
    if (!isCmd && r.usage) usageAdd({ t: 1, i: promptTokens(r.usage), o: r.usage.output_tokens || 0, c: r.usage.cache_read_input_tokens || 0 }, run.sessionId, run.usageModel);
    if (run.pendingInject.length) return;
    if (!run.bgTasks) return closeInput();
    // 答完了，只是后台任务（本地服务之类）还在跑：界面上算这一轮结束，进程和 stdin 留着等任务回报
    run.idle = true;
    emit({ type: "run_idle", bg: run.bgTasks, at: Date.now() });
    publishState();
  };
  const onReplay = () => {
    // 第一条回显是本轮的原始消息；之后每条都是一条送达的插话（按写入顺序）
    const said = run.replays === 0 ? message : run.pendingInject[0] && run.pendingInject[0].message;
    if (usageIsPrompt(said)) usageAdd({ m: 1 }, run.sessionId);
    if (run.replays++ === 0) return;
    const it = run.pendingInject.shift();
    if (it) { emit({ type: "inject", text: it.message, cid: it.cid, itemId: it.id }); saveRunMark(); }
  };
  const feed = (line) => {
    let ev; try { ev = JSON.parse(line); } catch { return; }
    if (ev.type === "control_request") return onControl(ev);
    // 清单工具一出结果就推，不等 4 秒轮询
    if (ev.type === "user" && ev.tool_use_result && (ev.tool_use_result.task || ev.tool_use_result.statusChange || ev.tool_use_result.updatedFields)) setImmediate(() => tasksCheck(run.sessionId));
    // 我们发的 set_permission_mode 的回执：被拒要记下来（以前直接丢掉，切了没生效也看不出来）
    if (ev.type === "control_response") { if (ev.response && ev.response.subtype === "error") log(`⚠️ claude 拒绝了控制请求：${String(ev.response.error || ev.response.error_code || "").slice(0, 160)}`); return; }
    if (ev.type === "assistant" && Array.isArray(ev.message && ev.message.content)) {
      let n = 0;
      for (const c of ev.message.content) if (c && c.type === "tool_use" && c.id && !run.usageTools.has(c.id)) { run.usageTools.add(c.id); n++; }
      if (n) usageAdd({ tl: n }, run.sessionId);
    }
    if (ev.type === "control_cancel_request") {           // claude 自己撤回了（比如被中断）
      if (run.perms.delete(ev.request_id)) { emit({ type: "perm_resolved", id: ev.request_id, behavior: "cancel" }); publishState(); }
      return;
    }
    // 后台任务（run_in_background 的命令、后台子代理）：result 之后它们跑完，claude 会在同一进程里接着再跑一轮。
    // 那时 stdin 要还开着，否则这一轮里所有授权请求都报「Tool permission request failed: AbortError: Stream closed」。
    // claude 有任何别的动静（开始请求、回显通知…）就不替它收尾了：之后的 result 会正常关 stdin
    if (run.idleClose && !(ev.type === "system" && ev.subtype === "background_tasks_changed")) { clearTimeout(run.idleClose); run.idleClose = null; }
    if (ev.type === "system" && ev.subtype === "background_tasks_changed" && Array.isArray(ev.tasks)) {
      run.bgTasks = ev.tasks.length;
      run.bgList = ev.tasks.slice(0, 30).map((t) => ({ id: String(t.task_id || ""), type: String(t.task_type || ""), desc: String(t.description || "").slice(0, 200) }));
      if (run.idle && run.bgTasks) emit({ type: "run_idle", bg: run.bgTasks });
      publishState();                    // 明细跟着状态走（runInfo.bgList），断线重连也补得上
      // 空闲中后台任务全没了：任务自己跑完时 claude 会接着起一轮（之后的 result 会关 stdin）；
      // 被 stop_task 停掉的只排进它的队列、不起新一轮，这一轮就永远挂着。等 6 秒没动静就收尾
      clearTimeout(run.idleClose);
      if (run.idle && !run.bgTasks) run.idleClose = setTimeout(() => { if (run.idle && !run.bgTasks && !run.ended) closeInput(); }, 6000);
    }
    // 空闲中 claude 又动起来了（后台任务回报、或用户发来的新消息）：重新算「生成中」
    if (run.idle && (ev.type === "assistant" || ev.type === "stream_event" || (ev.type === "system" && ev.subtype === "init"))) {
      run.idle = false;
      emit({ type: "run_busy", startedAt: Date.now() });
      publishState();
    }
    translate(ev, { sse: emit, flags, onInit, onResult, onReplay, provider: P });
  };

  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");   // 按流解码：多字节字符跨块不会被拆坏
  child.stdout.on("data", (d) => {
    buf += d.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) feed(line);
    }
  });

  child.stderr.on("data", (d) => {
    const s = d.toString("utf8");
    if (stderr.length < 20000) stderr += s;
    if (/error|Error|failed|ENOENT|EACCES/.test(s)) log(`[claude!] ${s.trim().slice(0, 300)}`);
  });

  const finish = (code) => {
    if (buf.trim()) feed(buf.trim());
    buf = "";
    run.inputOpen = false;
    run.perms.clear();                // 卡片随 run_end 一起作废（前端按 run_end 收起）
    if (run.pendingInject.length) {
      log(`插话 ${run.pendingInject.length} 条没来得及送达，退回队首`);
      QUEUE.unshift(...run.pendingInject.map((it) => ({ ...it, injected: false, held: !!run.aborted })));
      run.pendingInject = [];
    }
    const ms = Date.now() - t0;
    if (run.aborted) {
      log(`⏹ 已中断 (${ms}ms)`);
      return endRun(run, { durationMs: ms });
    }
    if (lastResult) {
      const localCmd = lastResult.local_command || null;
      log(`✔ 完成 ${ms}ms  ${lastResult.num_turns || "?"} 轮  ` +
          `上下文=${flags.contextTokens ?? "?"} out=${lastResult.usage?.output_tokens ?? "?"}  ` +
          `$${Number(lastResult.total_cost_usd || 0).toFixed(5)}${localCmd ? "  [" + localCmd + "]" : ""}`);
      noteTokens(run.provider, lastResult.usage);
      billAfterRun(run.provider);
      if (!isCmd && !lastResult.is_error && run.sessionId) idleArm(run.sessionId, flags);
      return endRun(run, {
        durationMs: ms,
        // claude 按内置的 Anthropic 价目表算账；第三方厂商的价格差得远，报出来能高一二十倍，干脆不报
        costUsd: P.nativeModels ? Number(lastResult.total_cost_usd || 0) : 0,
        usage: lastResult.usage
          ? {
              output_tokens: lastResult.usage.output_tokens || 0,
              context_tokens: flags.contextTokens || 0,   // 真实占用（累计和不算）
              context_window: contextWindowOf(lastResult, P, model || undefined),
            }
          : null,
        subtype: lastResult.subtype,
        isError: !!lastResult.is_error,
        // 本地命令（/context /cost …）的结果正文在这里
        localCommand: localCmd,
        resultText: localCmd ? String(lastResult.result || "") : "",
        // 正文要给出去：定时任务发通知、频道回消息都用 f.finalText。
        // 以前只给 run.sched，频道拿到的永远是空串，发回去就成了「（没有回复）」
        ...(run.sched || run.channel ? { finalText: String(lastResult.result || "").slice(0, run.channel ? 8800 : 4000), costRaw: Number(lastResult.total_cost_usd || 0) } : {}),
      });
    }
    const hint = code !== 0 ? `生成失败（退出码 ${code}）` : "生成结束但没有返回结果";
    log(`✖ ${hint}${stderr ? " :: " + stderr.trim().slice(0, 300) : ""}`);
    emit({ type: "error", message: hint, detail: stderr.trim().slice(0, 1200) });
    endRun(run, { failed: true, durationMs: ms });
  };

  child.on("error", (e) => {
    log(`spawn 出错: ${e.message}`);
    emit({ type: "error", message: tr(LAST_LANG, tz("无法启动 claude：{err}", { err: e.message })) });
    endRun(run, { failed: true });
  });
  child.on("close", finish);
}

// ── 路由：/api/perm/answer /api/perm/mode /api/task/stop /api/abort ──
export async function routeRun(req, res, u, p) {
  // ── 权限确认：回答 claude 的 can_use_tool ──
  if (req.method === "POST" && p === "/api/perm/answer") {
    const b = JSON.parse((await readBody(req)) || "{}");
    // 不带 runId（通知里的「拒绝」）就按请求号找它属于哪一轮
    const run = b.runId ? RUNS.get(String(b.runId)) || null : runList().find((r) => r.perms && r.perms.has(String(b.id || ""))) || null;
    if (!run || !run.answerPerm) return sendJson(res, 409, { error: "gone", message: tz("这一轮已经结束了") });
    if (!run.answerPerm(String(b.id || ""), {
      behavior: b.behavior === "allow" ? "allow" : "deny",
      message: b.message, interrupt: !!b.interrupt, always: !!b.always,
      answers: b.answers, mode: b.mode ? String(b.mode) : null,
    })) return sendJson(res, 409, { error: "gone", message: tz("这项已经回答过了") });
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === "POST" && p === "/api/perm/mode") {
    const b = JSON.parse((await readBody(req)) || "{}");
    if (!setPermMode(String(b.mode || ""))) return sendJson(res, 400, { error: "bad mode" });
    return sendJson(res, 200, { ok: true, mode: SETTINGS.permissionMode, live: RUNS.size > 0 });
  }
  if (req.method === "POST" && p === "/api/task/stop") {
    const b = JSON.parse((await readBody(req)) || "{}");
    const run = RUNS.get(String(b.runId || ""));
    if (!run || !run.stopTask || !run.stopTask(String(b.taskId || ""))) return sendJson(res, 409, { error: "gone", message: tz("这个后台任务已经结束了") });
    log(`■ 停后台任务 ${String(b.taskId).slice(0, 12)}`);
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === "POST" && p === "/api/abort") {
    const b = JSON.parse((await readBody(req)) || "{}");
    if (b.clearQueue) QUEUE.length = 0;
    // 带 id 只停那一轮；不带 id（旧前端）停掉全部
    const killed = b.id ? abortRun(RUNS.get(String(b.id))) : runList().map(abortRun).some(Boolean);
    if (b.clearQueue) publishState();
    return sendJson(res, 200, { ok: true, killed });
  }
  return NEXT;
}
