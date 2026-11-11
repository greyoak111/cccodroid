import fs from "node:fs";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { CFG, LAST_LANG, PATHS, log, tr, tz, permModeAction } from "./config.mjs";
import { SETTINGS, capList, settingsDiskCheck } from "./settings-store.mjs";
import { PERM_MODES, PROVIDER, billAfterRun, keyOf, noteTokenDelta, providerById, providersDiskCheck } from "./providers.mjs";
import { ALIAS_SEEN, effortLevelsOf, fetchModels, isLoginMode, modelsCached, normEffort } from "./models.mjs";
import { bridgeSwitching, claudeAtLeast, claudeCmd, claudeEnv, currentModelInfo, ensureBridge, safeModePerm, settingsArgs } from "./claude.mjs";
import { tasksCheck } from "./goal.mjs";
import { setLastInit } from "./caps.mjs";
import { RUNS, SESSIONS, rememberSession, runFlag, runList } from "./runs.mjs";
import { SWALLOW_HOOKS } from "./streamfix.mjs";
import { NEXT, readBody, sendJson } from "./http.mjs";
import { clearIncomplete, markIncomplete } from "./incomplete.mjs";
import { END_HOOKS, INTERRUPTED, QUEUE, RUN_LANE, RUN_SESSIONS, abortRun, clearInterrupted, endRun, holdLane, idleArm, idleDisarm, laneOfItem, permView, publishState, runEmit, runTag, saveRunMark, setInterrupted, setPermMode, sidForItem } from "./queue.mjs";
import { LOCAL_CMD_RE, handleLocalCommand } from "./modelcmd.mjs";
import { ensureLlama, localCustomActive, localRunAttach } from "./local.mjs";
import { deviceMcpConfig, privCall, usageAdd, usageIsPrompt, usageMeter } from "./usage.mjs";
import { TASKS_HINT, contextWindowOf, toolsHint, translate, hookBlocked } from "./stream.mjs";
import { archiveHint } from "./archive.mjs";
import { autoTitle } from "./autotitle.mjs";
import { SUBAGENT_HINT, agentBook, takeAgentNote, putAgentNote, onShared, privateAgentsBase } from "./agents.mjs";
import { findSessionFile, peekSession } from "./sessions.mjs";
import { projectById, projectDefaults, projectOfDir } from "./projects.mjs";
import { sessLostProvider, sessModel, sessProvider, setSessModel } from "./sessmodel.mjs";
import { inlineImages, inlineImagesSync, wantsInline } from "./inlineimg.mjs";
import { pathWatch, previewHint, putPathNote, settlePathNote, takePathNote } from "./pathnote.mjs";
import { claudeSeal, sealStillValid } from "./claudeseal.mjs";
import { gwRuntimeBlocked } from "./gwpin.mjs";
import { tamperNote, tamperRecord, tamperRetell } from "./tamper.mjs";
import { SPOOF_NOTE, checkSession, integrityHint, integrityNote, neutralizeMarkers, sealSession, sessionAnchor } from "./integrity.mjs";
import { ruleblockHint } from "./ruleblock.mjs";
import { recordExtra } from "./lineage-store.mjs";
import { refNote, refNoteSync } from "./merge.mjs";
import { ensureManagedBridge } from "./managed-bridge.mjs";
import { projectRisks, projectTrusted, trustProject } from "./projtrust.mjs";
import { checkAppFiles } from "./appfiles.mjs";
import { pathBlocked } from "./files.mjs";
import { holdsPrivate } from "./pathguard.mjs";
import { guarded } from "./crashguard.mjs";
// 权限确认等多久没人答就按拒绝收掉（0.6.9 审计 P1-4）。测试可用 CCAPP_PERM_WAIT_MS 改短
const PERM_WAIT_MS = Number(process.env.CCAPP_PERM_WAIT_MS) > 0 ? Number(process.env.CCAPP_PERM_WAIT_MS) : 30 * 60e3;
import { UC_SEALED, ucAfterRun, ucBeforeRun, ucKeep, ucPending, ucPutNote, ucRevert, ucSetRevertNote, ucTakeNote } from "./userconf.mjs";
import { keepProcs, killProcs, leftoverProcs, nowTicks, procStart } from "./leftover.mjs";
import { localAddr, witnessMac } from "./access.mjs";
import { sealed } from "./edition.mjs";
import { runPromptFile, sealBlockMessage, sealCleanup, sealPrepare, sealRecheck } from "./seal.mjs";

// 必须由人回答的工具：全部放行也照问（问题、计划审批）
// 敏感操作「这一轮已允许」的范围：读屏、点按、剪贴板这类设备操作一连串连着做，按类别记；
// 密钥、会自动执行的文件、破甲这些，批准一次只放行同一个工具对同一个目标，不能一把解锁同类所有文件（0.6.9 审计 199 11-07）
const guardKey = (p) => (/^device:/.test(p.guard.cat) ? p.guard.cat : `${p.tool}\0${p.guard.cat}\0${p.guard.what}`);
const HUMAN_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);
// 空闲中后台任务自己跑完、claude 却一直没起新一轮：这么久没动静才关 stdin 收尾（我们发过 stop_task 的 6 秒）。环境变量只给测试用
const IDLE_CLOSE_MS = Number(process.env.CCAPP_IDLE_CLOSE_MS) || 120000;

/** 这一轮在哪个目录跑：显式指定 → 接着的会话当初的 cwd（--resume 只在同一 cwd 下找得到）→ 项目目录 → 工作区 */
const isDirSync = (d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } };
// 指定了目录（请求带的、会话记着的、项目的）却不在了（被删、改名、存储卡拔了）：返回 lost，这一轮不跑。
// 以前悄悄换到工作区去跑，项目的权限 / 型号照套，读的却是工作区的 CLAUDE.md（0.6.9 审计 195-K.1）
function cwdOf(item, sessionId) {
  if (item.cwd) return isDirSync(item.cwd) ? item.cwd : { lost: item.cwd };
  if (sessionId) { const f = findSessionFile(String(sessionId)); const c = f && peekSession(f.file).cwd; if (c) return isDirSync(c) ? c : { lost: c }; }
  if (item.projectId) { const p = projectById(item.projectId); if (p) return isDirSync(p.path) ? p.path : { lost: p.path }; }
  return fs.existsSync(CFG.workspace) ? CFG.workspace : CFG.home;
}
const cwdPath = (c) => (typeof c === "string" ? c : null);

// ── 跑一轮 ────────────────────────────────────────────────────────────
// 和 HTTP 请求完全脱钩：前端断了也接着跑，结果照样落进 transcript、照样广播。
// 这一轮用哪家：定时任务指定的 → 新会话首条带来的选择（pin）→ 这个会话钉的 → 项目默认 → 全局生效的。
// 整轮都按它（地址、密钥、模型名规则）。/api/chat 入口查 Key 也用它，两边才不会各认一家（审查 #49 P2-4）
// 特权命令「这个会话都允许」：每个会话一个随机口令，经环境变量 CCAPP_PRIV_SESS 跟着这个会话的每一轮 claude 走，
// 应用在确认框里勾了「本会话都允许」就记下它（只在内存里，应用或网关重启即失效）。无人值守（定时任务）的轮次不带，
// 用户点头时没看着的任务不该沾光
const PRIV_TOK = new Map();
function privToken(run) {
  if (run.unattended) return "";
  const tok = (run.sessionId && PRIV_TOK.get(run.sessionId)) || crypto.randomBytes(16).toString("hex");
  if (run.sessionId) PRIV_TOK.set(run.sessionId, tok);
  if (PRIV_TOK.size > 500) PRIV_TOK.delete(PRIV_TOK.keys().next().value);
  return tok;
}

/**
 * 给应用作证（Priv.java chainToken）：发起特权请求的进程往上数，碰到一个看不见的祖先 anc（不可转储的 claude 或网关自己，
 * 见 android/native/nodump.c），它下面那个看得见的是 top。应用读不了它们的环境，来问网关：这是不是我起的哪一轮 claude、口令是什么。
 *   anc 是网关自己：top 得是某一轮的直接子进程（claude 本身，或套在外面的 seccomp 监督器）
 *   anc 是别的：得是某一轮的 claude（直接子进程，或监督器下面那个）
 */
export function privWitness(anc, top) {
  for (const run of RUNS.values()) {
    const c = run.child;
    if (!c || !c.pid || !run.privTok || c.exitCode !== null || c.signalCode !== null) continue;
    if (anc === process.pid ? top === c.pid : anc === c.pid || (run.claudePid > 0 && anc === run.claudePid)) return run.privTok;
  }
  return "";
}

// 工具确认进日志只记参数多长，不记原文：命令、路径、网址可能带着用户的业务内容，诊断包里不该有（审查 v0.5.20 08-001）
const argLen = (inp) => { const v = String(inp?.command || inp?.file_path || inp?.url || ""); return v ? `(${v.length} 字)` : ""; };

export function pickProvider(item) {
  // 跟的那条被撤销了也照样接上车道上首条跑出来的会话（#120-1），不然会另起一个会话
  const sid0 = sidForItem(item);
  const pdef0 = projectDefaults(item.projectId ? projectById(item.projectId) : projectOfDir(cwdPath(cwdOf(item, sid0))));
  const rec0 = sessModel(sid0);
  return { sid0, pdef0, P: (item.provider && providerById(item.provider))
    || (item.pin && item.pin.provider && providerById(item.pin.provider))
    || (rec0 && rec0.model != null ? sessProvider(sid0) : null)
    || (pdef0.provider && providerById(pdef0.provider))
    || sessProvider(sid0) };
}

/** 这条消息按现在的设置新起一轮会用哪家、哪个模型、哪个思考强度（startRun 里取值那段的同步副本）。
 *  空闲的后台进程要被自动复用时，队列拿它和那一轮起跑时的取值比对（#120-2）：用户刚在面板里换了接口/模型，
 *  下一条普通消息就不能再悄悄交给旧进程。清单还没拉过时档位可能算得比真跑时保守，不一致只会让它照常排队，不会错塞。 */
export function execIntent(item, ctx) {
  const { sid0, pdef0, P } = ctx || pickProvider(item);
  // 模型 / 思考强度的取值顺序：本次请求指定（定时任务）→ 新会话首条带来的选择（pin）→ 这个会话单独选过的
  // → 项目默认 → 全局默认（设置页）→ 该厂商自己的默认。选过的 "" 表示「接口默认」，也算选过
  // ⚠️ 不能回落到 CFG.model：那是全局兜底（deepseek-flash），只有内置厂商能碰。
  // 首条带来的接口和会话现在的不是同一家时，会话记下的模型名不作数
  const own0 = sessModel(sid0), pin = item.pin || {};
  const own = own0 && (own0.model == null || own0.provider === P.id) ? own0 : null;
  const ownM = pin.model != null ? pin.model : own && own.model != null ? own.model : null;
  const ownE = pin.effort != null ? pin.effort : own && own.effort != null ? own.effort : null;
  let effort = item.effort || (ownE != null ? ownE : pdef0.effort || SETTINGS.effort) || "";
  // 项目默认的模型名是给项目那家的（没指定家就是全局那家），全局默认的是给全局那家的；对不上的不作数，走这家自己的默认
  const fallM = (P.id === (pdef0.provider || PROVIDER.id) ? pdef0.model : "") || (P.id === PROVIDER.id ? SETTINGS.model : "");
  let model = (item.model || (ownM != null ? ownM : fallM) || P.defaultModel || (P.explicit ? "" : CFG.model) || "").trim();
  // 原生厂商只认 claude 自家的模型名；别家的名字（切厂商前留下的）宁可不传，交给 claude 自己选
  if (P.nativeModels && model && !/^(claude-|opus|sonnet|haiku|fable|default|best)/i.test(model)) model = "";
  model = model.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 200);
  if (!["low", "medium", "high", "xhigh", "max"].includes(effort)) effort = "";
  if (effort && !P.local) {
    const mi = currentModelInfo(model, P);
    if (!effortLevelsOf(mi, P).includes(effort)) effort = normEffort(mi, effort, P) || "";
  }
  return { sid0, pdef0, P, model, effort };
}

/** 起进程前的确认卡多久没人答就停下（#171）：没人答时这一轮一直占着 RUNS，挡住「重启网关」，切走的新对话还找不回来。
 *  测试里改小 */
export const CARD = { timeout: 10 * 60e3 };
/** 起进程前要用户点头的卡片（项目配置、用户级配置）：借用敏感操作卡（guard），答复走同一个 /api/perm/answer。
 *  允许 → true；拒绝 → false（「拒绝并停止」同时停掉这一轮）；这期间点了停止、或超时 → null。
 *  超时：按停止收尾，记一条中断记录（why: card），界面在那个会话（没建会话的在新对话页）给「重发」 */
export function askCard(run, emit, { key, tool, input, guard, what, yes, no }) {
  return new Promise((resolve) => {
    const id = `ccapp-${key}-` + run.id;
    const p = { id, tool, input, suggestions: [], at: Date.now(), runId: run.id, sessionId: run.sessionId || null, guard };
    const timer = setTimeout(() => {
      if (!run.perms?.has(id)) return;
      log(`${runTag(run)} ⏹ ${what}：${Math.round(CARD.timeout / 60e3)} 分钟没人确认，这一轮停下`);
      holdLane(run); run.aborted = true;
      setInterrupted([...INTERRUPTED.filter((e) => e.id !== run.id),
        { id: run.id, sessionId: run.sessionId || null, text: String(run.text || "").slice(0, 64 << 10), ...(String(run.text || "").length > 64 << 10 ? { textCut: true } : {}),
          ...(run.req && Object.keys(run.req).length ? { req: run.req } : {}), startedAt: run.startedAt, at: Date.now(), why: "card" }]);   // 同运行标记（195-AA.5）
      emit({ type: "perm_resolved", id, behavior: "cancel" });
      done(null);
    }, CARD.timeout);
    timer.unref?.();
    const done = (v) => {
      if (!run.perms?.delete(id)) return;
      clearTimeout(timer);
      run.readyAbort = null; run.answerPerm = null;
      publishState();
      resolve(v);
    };
    run.perms = new Map([[id, p]]);
    run.readyAbort = new AbortController();
    run.readyAbort.signal.addEventListener("abort", () => { emit({ type: "perm_resolved", id, behavior: "cancel" }); done(null); });
    run.answerPerm = (pid, a) => {
      if (pid !== id || !run.perms?.has(id)) return false;
      const allow = a.behavior === "allow";
      log(`${allow ? yes : no} ${what}${a.interrupt ? "（并停止）" : ""}`);
      emit({ type: "perm_resolved", id, behavior: allow ? "allow" : "deny", interrupt: !!a.interrupt });
      if (a.interrupt) { holdLane(run); run.aborted = true; }
      done(allow);
      return true;
    };
    log(`⏸ 等确认 ${what}`);
    emit({ type: "perm_request", ...p });
    publishState();
  });
}
// 一轮结束：比一比运行期间改了哪些用户级配置（见 userconf.mjs）。头一轮开跑时才挂：queue.mjs 和这里互相引用，模块加载时它还没初始化
let ucHooked = false;

const askProjectTrust = (run, cwd, proj, emit) => askCard(run, emit, { key: "proj", tool: "ProjectConfig", input: { dir: cwd, risks: proj.risks },
  guard: { cat: "project", what: cwd }, what: `项目配置 ${proj.risks.length} 项`, yes: "✓ 允许", no: "✗ 不加载" });

/** 日志里怎么称呼一条用户消息：诊断包承诺不含消息内容，提问只记字数，斜杠命令只记命令名（FIND-046）。
 *  以前记前 60 字，原生打包虽然会抹掉整行，但日志文件本身已经把正文写进去了。 */
export function promptLogLine(message, isCmd) {
  const s = String(message || "").trim();
  return isCmd ? `命令 ${s.split(/\s+/)[0].slice(0, 24)}` : `提问（${s.length} 字）`;
}

// claude 异常退出时给用户的一句话。143 / 137（SIGTERM / SIGKILL）是被别的程序结束的：系统回收内存、别的应用、终端里 kill……
// 不是模型或接口的问题，说清楚，别让人以为要换模型（11-04 用户反馈）
function exitHint(code, signal) {
  if (signal === "SIGTERM" || signal === "SIGKILL" || code === 143 || code === 137)
    return tz("Claude Code 被别的程序结束了（{why}），不是模型或接口的问题", { why: signal || code });
  return signal ? tz("生成中断（{sig}）", { sig: signal }) : tz("生成失败（退出码 {code}）", { code });
}
// 错误详情里不放 claude 的「[claude-code:unrecognized_model]」提示行：第三方型号名它都不认识，每次都有，
// 跟这次为什么失败无关，反而让人去怀疑模型（日志里照留）
// 保留的是最后一段 stderr，这里也取末尾：报错原因通常在最后（FIND-045）
const exitDetail = (stderr) => String(stderr || "").split("\n").filter((l) => !/^\[claude-code:unrecognized_model\]/.test(l.trim())).join("\n").trim().slice(-1200);

/** 这一轮本该用的那家已经不在了：返回说明（不在就不跑），否则 ""。
 *  pickProvider 找不到指定的那家会一路退到全局默认——全局可能是订阅账户，会话内容、交给它的材料就换了一家发出去。
 *  顺序同 pickProvider：定时任务指定的 → 新会话首条带来的 → 会话钉的 → 项目默认 */
export function lostProvider(item, sid0, pdef0) {
  const gone = (id) => typeof id === "string" && id && !providerById(id);
  if (item.provider) return gone(item.provider) ? tz("指定的接口「{id}」不存在，这一轮没有发出去。", { id: item.provider }) : "";
  if (item.pin && item.pin.provider) return gone(item.pin.provider) ? tz("指定的接口「{id}」不存在，这一轮没有发出去。", { id: item.pin.provider }) : "";
  const s = sessLostProvider(sid0);
  if (s) return tz("这个会话原来用的接口「{id}」已经删掉了，这一轮没有发出去。在模型面板里换一家再发。", { id: s });
  if (sessModel(sid0)) return "";
  if (pdef0 && gone(pdef0.provider)) return tz("项目默认的接口「{id}」已经删掉了，这一轮没有发出去。到项目设置里重新选个接口。", { id: pdef0.provider });
  return "";
}

// streamfix 人工补尾时按请求头里的会话号找到那一轮，留一句提示：回答真被截断时用户看得见、能让它继续。
// kind = "error"：说完之后才来的报错被吞掉（195-U.4）；"truncated"：上游没给消息级收尾就断了，尾巴是我们补的（BUG-R01）
SWALLOW_HOOKS.push((sid, msg, kind) => {
  const run = sid && runList().find((r) => r.sessionId === sid && !r.ended);
  if (!run) return;
  if (kind === "truncated")
    runEmit(run, { type: "note", key: "sfx-pad", text: tz("上游没发结束标记就断开了，回答已按说完处理；这条是否完整无法确认，如果没说完，发一句「继续」") });
  else
    runEmit(run, { type: "note", key: "sfx-swallow", text: tz("上游在回答结尾报了错（{msg}），已按说完处理；如果回答不完整，发一句「继续」", { msg }) });
});

export async function startRun(item) {
  const { sid0, pdef0, P } = pickProvider(item);
  const KEY = keyOf(P);
  const run = {
    id: item.id,
    text: item.message,
    // 跟在一个还没拿到会话号的新会话后面排队的：等前一条 init 了再接上它的会话；
    // 跟的那条中途被撤销、从没启动时，按车道找回首条已经跑出来的会话（#120-1）
    sessionId: sidForItem(item),
    follow: item.follow,
    cid: item.cid,
    auto: item.auto || null,           // "idle" = 网关自己发起的空闲压缩（界面画成系统提示，不发通知）
    startedAt: Date.now(),
    child: null, aborted: false, ended: false, preSpawn: true,
    provider: P.id,                    // 这一轮用的那家：记 token、删接口前查占用都看它
    log: [], pend: null, pendTimer: null,
    sched: item.sched || null,         // 定时任务跑的：{ taskId, runKey }（结束时 sched.mjs 记运行记录）
    unattended: !!item.unattended,     // 没人看着：要确认的一律拒绝
    // 被系统结束后「重发」要按原样发：项目、钉的模型、权限模式、附加目录、汇合来源都记进运行标记（0.6.9 审计 195-AA.5）
    req: Object.fromEntries(Object.entries({ projectId: item.projectId, pin: item.pin, model: item.model, permissionMode: item.permissionMode,
      addDirs: item.addDirs && item.addDirs.length ? item.addDirs : null, mergeFrom: item.mergeFrom }).filter(([, v]) => v != null)),
  };
  // 进程起来之前（拉模型、问设备工具、读建档提示都要等）用户改权限模式：先记下来，起进程时按最新的那个启动；
  // 起来后由下面真的 setMode 接手（审查 v0.5.20 02-001：以前这段时间收紧会被开头读的旧模式盖掉，新进程照样全部放行）
  run.setMode = (mode) => { mode = safeModePerm(mode); run.permMode = mode; return true; };
  run.lane = laneOfItem(item);
  RUNS.set(run.id, run);                 // 同步占槽，中间不许有 await
  RUN_LANE.set(run.id, run.lane);
  if (RUN_LANE.size > 1000) for (const k of [...RUN_LANE.keys()].slice(0, 500)) if (!RUNS.has(k)) RUN_LANE.delete(k);
  runFlag(true);
  // 在被中断的那个会话里又跑起来了（点了「继续」或者直接接着聊）：等这一轮真答出来再撤中断提示。
  // 以前一开跑就撤，「继续」起不来、空完成时卡片已经没了，用户不知道没跑（0.6.9 审计 195-R.1）。跑着时界面本来就不显示这张卡
  run.intrPending = !!run.sessionId && INTERRUPTED.some((e) => e.sessionId === run.sessionId);
  if (run.sessionId) { RUN_SESSIONS.set(run.id, run.sessionId); idleDisarm(run.sessionId); }
  if (run.sessionId) markIncomplete(run.sessionId, run.id);   // 这一轮开跑：先记上，拿到结果再清（FIND-040）
  const emit = (ev) => runEmit(run, ev);
  emit({ type: "run_start", text: run.text, sessionId: run.sessionId, follow: run.follow, cid: run.cid, startedAt: run.startedAt, ...(run.auto ? { auto: run.auto } : {}) });
  publishState();

  const message = run.text;
  const local = message.trim().match(LOCAL_CMD_RE);
  if (local) {
    local[1] = local[1].toLowerCase();   // /MODEL 也是网关的（复核 v067b-4）
    log(`⌘ 本地命令 /${local[1]}`);   // 参数不记：诊断包说了不含消息内容（审查 v0.5.20 08-001）
    return handleLocalCommand(local[1], (local[2] || "").trim(),
      (text, cmd) => endRun(run, { localCommand: cmd || local[1], resultText: text, durationMs: 0, costUsd: 0 }), run.sessionId, () => run.aborted);
  }

  const lost = lostProvider(item, sid0, pdef0);
  if (lost) {
    log(`${runTag(run)} ⛔ 这一轮要用的接口不在了，没有启动（不退回全局默认）`);
    emit({ type: "error", message: tr(LAST_LANG, lost) });
    return endRun(run, { failed: true });
  }
  if (P.endpointLost) {
    emit({ type: "error", message: tr(LAST_LANG, tz("{name} 原来选的线路「{ep}」已经不在了。请到设置里重选线路，并重新填这条线路的密钥。", { name: P.label || P.id, ep: P.endpointLost })) });
    return endRun(run, { failed: true });
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
  if (run.aborted) return endRun(run, {});
  // 正在换厂商、桥还没换完上游：等它换完再连（200-7-08）
  const sw = bridgeSwitching();
  if (sw) { await sw; if (run.aborted || run.ended) return endRun(run, {}); }
  run.readyAbort = new AbortController();
  try {
    await ensureManagedBridge(P, { signal: run.readyAbort.signal });
  } catch (e) {
    if (!run.aborted) emit({ type: "error", message: tr(LAST_LANG, e.message) });
    return endRun(run, { failed: !run.aborted });
  } finally { run.readyAbort = null; }
  if (run.aborted) return endRun(run, {});
  if (P.id === PROVIDER.id && !isLoginMode() && !(await ensureBridge())) {   // 别家直连，不经桥
    emit({ type: "error", message: tr(LAST_LANG, tz("本地 DNS 桥启动失败，无法连接 API。")) });
    return endRun(run, { failed: true });
  }
  if (run.aborted) return endRun(run, { failed: true });   // 等桥的时候就被停了

  const cwd0 = cwdOf(item, run.sessionId);
  if (typeof cwd0 !== "string") {
    const msg = tz("工作目录 {dir} 不在了（被删、改名或存储卡拔出了），这一轮没有运行。把目录放回去，或者到项目设置里改路径后再发。", { dir: cwd0.lost });
    log(`${runTag(run)} ⛔ 工作目录不在了：${cwd0.lost}`);
    emit({ type: "error", message: tr(LAST_LANG, msg) });
    return endRun(run, { failed: true, finalText: msg });
  }
  const cwd = cwd0;
  run.cwd = cwd;
  const pdef = projectDefaults(item.projectId ? projectById(item.projectId) : projectOfDir(cwd));
  if (!item.permissionMode && pdef.perm) item.permissionMode = pdef.perm;
  // 模型 / 思考强度的取值顺序见 execIntent（这里的取值和队列判断能否复用空闲进程时用的是同一份）
  let { model, effort } = execIntent(item, { sid0, pdef0: pdef, P });
  // 别家的清单拉一次（10 分钟缓存）：窗口、档位映射要用。思考强度是跟着全局 / 项目来的、这家模型不支持时，换成它支持的
  // 全局那家也一样：没打开过设置 / 型号清单时冷缓存里没有窗口，claude 只能按 200k 跑（#57）。拉过的就后台刷新，不让这一轮干等
  if (!P.local) {
    // 已经知道这个型号的窗口（拉过清单、或配置里的内嵌清单 / fallbackModels 写了）就不等：离线时首轮别干等 15 秒（v0514 复核）
    const known = modelsCached(P) || Number(currentModelInfo(model, P).context_window) > 0;
    if (P.id !== PROVIDER.id || !known) await fetchModels(false, P).catch(() => {});
    else fetchModels(false, P).catch(() => {});
    // 清单可能刚拉到 / 刚刷新：档位按最新的表再校准一次（和以前一样，以取完清单为准）
    if (effort) {
      const mi = currentModelInfo(model, P);
      if (!effortLevelsOf(mi, P).includes(effort)) effort = normEffort(mi, effort, P) || "";
    }
  }
  // 这一轮起跑时的执行配置：后台轮次还留着进程时，队列据此判断下一条消息能不能自动塞进来（#120-2）
  run.exec = { provider: P.id, model: model || "", effort: effort || "" };
  let permMode = String(run.permMode || item.permissionMode || SETTINGS.permissionMode || "default").trim();
  if (!PERM_MODES.includes(permMode)) permMode = "default";
  // 安全模式下钩子全不跑（敏感操作再确认也没了），不问人的几档退回 default
  if (safeModePerm(permMode) !== permMode) { log(`安全模式：权限模式 ${permMode} → default`); permMode = safeModePerm(permMode); }
  run.permMode = permMode;

  // 端侧小模型：先确保 llama-server 跑着、载的是这个模型（第一次要加载十几秒）
  if (P.local) {
    try {
      const m = await ensureLlama(model, (key, text) => emit({ type: "note", key, text }));
      model = m.id;
      localRunAttach(run);
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
    // 钩子注入的原文给界面看（见 stream.mjs 的 hookContext）。旧版 claude 不认这个旗标会直接起不来，只给核实过的版本加
    ...(claudeAtLeast("2.1.311") ? ["--include-hook-events"] : []),
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
  const appendPrompt = [P.local ? localHint : toolsHint(), !P.nativeModels && !P.local ? TASKS_HINT : "", P.local ? "" : previewHint(cwd), P.local ? "" : integrityHint(), P.local ? "" : ruleblockHint(), arch?.rule].filter(Boolean).join("\n\n");
  // 子代理（连孙代理）统一的联络规矩：用 agentId 发消息、summary 写事由、长内容落文件只发路径（见 agents.mjs）
  const subPrompt = !P.local && !message.trim().startsWith("/") ? SUBAGENT_HINT + "\n\n" + integrityHint() + "\n\n" + ruleblockHint() : "";
  // 这两段在起进程紧前写成文件再交（见 promptFiles）
  // claude 没有 --output-style 参数（传了直接 unknown option，整条消息失败）；它是 settings 里的 outputStyle。
  // 密钥读取器也在这里（见 settingsArgs）
  argv.push(...settingsArgs(P));
  if (effort) argv.push("--effort", effort);
  // 设置和这一条各自有上限，合起来再按总长截一次（10-31 复核：两边都顶满能超 ARG_MAX，这一轮 spawn 直接 E2BIG）
  const allowed = capList([...(SETTINGS.allowedTools || []), ...(Array.isArray(item.allowedTools) ? item.allowedTools : [])], 400, 512, 8192);
  if (allowed.length) argv.push("--allowedTools", allowed.join(","));
  const disallowed = capList([...(SETTINGS.disallowedTools || []), ...(Array.isArray(item.disallowedTools) ? item.disallowedTools : [])], 400, 512, 8192);
  if (disallowed.length) argv.push("--disallowedTools", disallowed.join(","));

  const dirs = new Set();
  if (fs.existsSync(CFG.workspace) && cwd !== CFG.workspace) dirs.add(CFG.workspace);
  if (process.env.CCAPP_SHARED && fs.existsSync(process.env.CCAPP_SHARED)) dirs.add(process.env.CCAPP_SHARED);
  // 附加目录同样不许是应用私有目录、或装着它的上级（按目录身份判，别名也认得；0.6.9 审计 P0-1）
  const addOk = (d) => { try { const r = fs.realpathSync(d); return !pathBlocked(r) && !holdsPrivate(r, { workspace: false }); } catch { return false; } };
  for (const d of SETTINGS.addDirs || []) if (addOk(d)) dirs.add(d); else if (d) log(`附加目录 ${d} 不存在或在应用私有目录里，没加`);
  for (const d of item.addDirs || []) if (typeof d === "string" && addOk(d)) dirs.add(d);
  if (!P.local && onShared(cwd)) { const b = privateAgentsBase(cwd); try { fs.mkdirSync(b, { recursive: true }); dirs.add(b); } catch {} }
  let dirLen = 0;
  for (const d of dirs) { if ((dirLen += d.length) > 24576) { log(`--add-dir 太多，从 ${d} 起没加`); break; } argv.push("--add-dir", d); }

  const isCmd = message.trim().startsWith("/");
  log(`▶ ${promptLogLine(message, isCmd)}  ${run.sessionId ? `(续 ${String(run.sessionId).slice(0, 8)})` : "(新会话)"}  [model=${model || "默认"} effort=${effort || "默认"} style=${SETTINGS.outputStyle || "默认"} perm=${permMode}]`);
  const t0 = Date.now();

  // 接口勾了「图片随消息发」：消息里提到的图片再各带一份 image 块（太大的先缩，要等，所以放在起进程前）
  let imgs0 = [];
  if (!isCmd && wantsInline(P)) { const env = claudeEnv({ model, provider: P }); imgs0 = await inlineImages(message, P, { tmpDir: env.TMPDIR, env }); }
  // 会话封签（见 integrity.mjs）：上一轮之后记录在应用外被改过、或是导入的，这一轮告诉模型别把那段历史当成自己说过的。
  // 起进程前核对：claude --resume 一起来就可能往文件里写
  const sfile = () => run.sessionId ? findSessionFile(String(run.sessionId), run.cwd)?.file : null;   // 按这一轮的目录找（F8）
  let integ = checkSession(run.sessionId, sfile());
  let integNote = isCmd || P.local ? "" : integrityNote(integ);
  // 消息里提到档号（0ab2·61）：附上那一章的压缩摘要（见 merge.mjs refNote）。读不出来就算了，不挡这一轮
  const refN = isCmd || P.local ? "" : await refNote(message, run.sessionId).catch((e) => { log("档号引用失败: " + e.message); return ""; });
  // 上面拉模型清单、问设备工具、读建档提示都要等：这期间点了停止（还没有进程可杀）就别再起了（安全通告 GHSA-g35m）
  if (run.aborted) { log("⏹ 起进程前已停止"); return endRun(run, { durationMs: 0 }); }
  // 用户级配置（~/.claude）有没确认的改动、之前的对话留下了后台进程（见 userconf.mjs / leftover.mjs）：先问。
  // 没人看着的（定时任务、空闲压缩）不跑：定时任务按失败记、照任务设置通知。发行版只问回填进来的 MCP 与权限（UC_SEALED）
  const ucp = ucPending(sealed() ? UC_SEALED : null), procs = leftoverProcs(new Map([...RUNS].filter(([k]) => k !== run.id).map(([k, r]) => [String(k), r.childStart ?? null])));
  if (ucp || procs.length) {
    if (run.unattended || run.auto) {
      const msg = tz("Claude Code 的用户级配置有改动还没确认，或者之前的对话留下了后台进程，这次没有运行。打开 cccodroid 发一条消息，在弹出的卡片里确认后再试。");
      log(`⏭ 用户级配置 / 留下的进程没确认，${run.auto ? "空闲压缩" : "无人值守的这一轮"}不跑`);
      if (!run.auto) emit({ type: "error", message: tr(LAST_LANG, msg) });
      return endRun(run, run.auto ? { durationMs: 0 } : { failed: true, finalText: msg });
    }
    const ok = await askCard(run, emit, { key: "uc", tool: "UserConfig", input: { first: !!ucp?.first, changes: ucp?.changes || [], procs },
      guard: { cat: "userconf", what: "~/.claude" }, what: `用户级配置 ${ucp?.rels.length || 0} 项、留下的进程 ${procs.length} 个`, yes: "✓ 保留", no: "✗ 撤销" });
    if (ok) {
      // 只认卡片上那一版（GHSA-q9wp）：等用户点的时候又被改了，这一轮不起，下一条消息再出卡片给用户看新的
      const stale = ucp ? ucKeep(ucp.rels, ucp.ticket) : [];
      keepProcs(procs);
      if (stale.length) {
        emit({ type: "error", message: tr(LAST_LANG, tz("用户级配置在确认之后又被改了，这一轮没有启动：{list}。再发一条消息，在弹出的卡片里确认。", { list: stale.slice(0, 6).join(", ") })) });
        return endRun(run, { failed: true });
      }
    }
    else if (ok === false) {
      const r = ucp ? ucRevert(ucp.rels) : { failed: [] };
      if (procs.length) killProcs(procs);
      ucSetRevertNote(ucp?.rels, procs.length);
      if (r.failed.length && !run.aborted) {
        emit({ type: "error", message: tr(LAST_LANG, tz("有 {n} 项没法还原（确认时没留副本，或者副本也被改了），这一轮没有运行：{list}", { n: r.failed.length, list: r.failed.slice(0, 6).join(", ") })) });
        return endRun(run, { failed: true });
      }
    }
    if (run.aborted) { log("⏹ 等用户级配置确认时停止"); return endRun(run, { durationMs: 0 }); }
  }
  // 项目自带会自动运行的配置（钩子、.mcp.json…，见 projtrust.mjs）、又没被认过：先问；不同意就不加载项目级配置，这一轮照常
  // 发行版：项目级配置一概不读（edition.mjs），不用问
  const proj = sealed() || P.local ? null : projectRisks(cwd);
  if (proj && !projectTrusted(cwd, proj.fp)) {
    const ok = run.unattended || run.auto ? false : await askProjectTrust(run, cwd, proj, emit);
    if (run.aborted) { log("⏹ 等项目配置确认时停止"); return endRun(run, { durationMs: 0 }); }
    if (ok) trustProject(cwd, proj.fp);
    else { argv.push("--setting-sources", "user"); log(`项目级配置不加载（${run.unattended || run.auto ? "无人值守" : "用户没同意"}）：${proj.risks.length} 项`); }
  }
  const pmAt = argv.indexOf("--permission-mode");
  if (run.permMode !== permMode && PERM_MODES.includes(run.permMode) && pmAt >= 0) {
    run.permMode = safeModePerm(run.permMode);
    log(`权限模式在起进程前改了：${permMode} → ${run.permMode}`);
    argv[pmAt + 1] = permMode = run.permMode;
  }
  // 建档规范、bin/claude、guard、预加载的库这些被改了先写回（见 appfiles.mjs）。放在起进程紧前：上面等项目配置确认可能等很久
  checkAppFiles();
  // 设置、厂商配置网关跑着时只有网关自己写：被别人改了按内存写回，留痕（换了接口地址就能把密钥送出去）
  for (const [f, chk] of [["ccapp-settings.json", settingsDiskCheck], ["ccapp-providers.json", providersDiskCheck]]) if (chk()) tamperRecord("runtime", [f]);
  // claude 程序本身：和版本目录里存的 Anthropic 签名清单对不上就不起（被改过字符串的二进制，见 claudeseal.mjs）
  if (!P.local) {
    const gwBad = gwRuntimeBlocked();
    if (gwBad) { emit({ type: "error", message: tr(LAST_LANG, gwBad) }); return endRun(run, { failed: true }); }
    const seal = await claudeSeal();
    if (seal.ok === false) {
      emit({ type: "error", message: tr(LAST_LANG, seal.pending ? "这个版本的 Claude Code 还没有官方签名清单，这一轮没有启动。正在联网补核，过一两分钟再发送；一直不行就到 设置 → 更新 里重新安装。" : "Claude Code 程序和官方签名清单对不上，可能被改过，这一轮没有启动。到 设置 → 更新 里重新安装后再试。") });
      return endRun(run, { failed: true });
    }
    if (run.aborted) { log("⏹ 核验 Claude Code 时停止"); return endRun(run, { durationMs: 0 }); }
  }
  // 用户级配置起进程紧前再核一次：点完卡片之后（等项目配置确认、核验程序都要时间）又被改了、或者看见过改了又改回，就不起。
  // 同时开始记这一轮运行期间的改动（结束时 ucAfterRun 比对）
  if (!ucHooked) { ucHooked = true; END_HOOKS.push((r) => ucAfterRun(r)); END_HOOKS.push((r) => sealCleanup(r.id)); }
  // 发行版白名单回填（seal.mjs）：说明文件、skill、插件、MCP、记忆检查过才交给 claude；命中破甲特征整轮不跑。端侧小模型走 --bare，不回填
  let prep = null;
  if (sealed() && !P.local) {
    try { prep = sealPrepare({ cwd, runId: run.id, outputStyle: SETTINGS.outputStyle || "" }); }
    catch (e) { log(`[封口] 准备回填失败：${e.message}`); prep = { block: { found: [{ name: "(cccodroid)", hits: [{ line: 0, excerpt: e.message }] }] } }; }
    if (prep.block) {
      log(`${runTag(run)} ⛔ [封口] 命中破甲特征，不跑：${prep.block.found.slice(0, 4).map((f) => f.name).join(", ")}`);
      const msg = tr(LAST_LANG, sealBlockMessage(prep.block));
      emit({ type: "error", message: msg });
      return endRun(run, { failed: true, finalText: msg });
    }
    for (const n of prep.notes || []) log(`[封口] ${n}`);
    argv.push(...prep.args);
    if (prep.settings && Object.keys(prep.settings).length) argv.push("--settings", JSON.stringify(prep.settings));
  }
  const drift = ucBeforeRun(run, sealed() ? UC_SEALED : null);
  if (drift.length) {
    emit({ type: "error", message: tr(LAST_LANG, tz("用户级配置在确认之后又被改了，这一轮没有启动：{list}。再发一条消息，在弹出的卡片里确认。", { list: drift.slice(0, 6).join(", ") })) });
    return endRun(run, { failed: true });
  }
  // 记忆目录 claude 自己读、没法拷副本：起进程紧前再比一次，准备之后被改了就重查（见 seal.mjs）
  const late = prep ? sealRecheck(prep) : null;
  if (late) {
    log(`${runTag(run)} ⛔ [封口] 起进程前记忆被改、命中破甲特征：${late.found.slice(0, 4).map((f) => f.name).join(", ")}`);
    const msg = tr(LAST_LANG, sealBlockMessage(late));
    emit({ type: "error", message: msg });
    return endRun(run, { failed: true, finalText: msg });
  }
  // 会话封签起进程紧前再核一次：上面等卡片、核程序可能等很久，这期间记录被改了，这一轮就该带提醒（199-S-04）。
  // 同时拍底，收尾时核这一轮只是往后追加
  if (!integ) { integ = checkSession(run.sessionId, sfile()); if (integ) integNote = isCmd || P.local ? "" : integrityNote(integ); }
  run.sealBase = run.sessionId ? { sid: run.sessionId, ...sessionAnchor(sfile()) } : null;
  if (run.sealBase) saveRunMark();     // 底要进运行标记：这一轮被系统结束时，下次启动凭它重新封签（195-A.8）
  if (run.aborted || run.ended) { log("⏹ 起进程前已停止"); return endRun(run, { durationMs: 0 }); }
  try { promptFiles(argv, run.id, appendPrompt, subPrompt); }
  catch (e) { emit({ type: "error", message: tr(LAST_LANG, tz("系统提示没写成文件，这一轮没有启动：{msg}", { msg: e.message })) }); return endRun(run, { failed: true }); }
  const [cmd0, args0] = claudeCmd(argv);
  // 外面套着 seccomp 监督器时，claude 是监督器的子进程：监督器把它的 pid 从 fd 3 报上来（不可转储的 claude 在 /proc 里看不见，作证要用，见 privWitness）
  const wrapped = cmd0 !== PATHS.claudeLoader;
  const child = spawn(cmd0, args0, {
    cwd,
    // CCAPP_RUN_ID / CCAPP_GW_PORT：建档命令 cc-archive 靠它们告诉网关「这是哪一轮」；CCAPP_GW_PID 给 leftover.mjs 认是不是本网关起的
    env: { ...claudeEnv({ model, provider: P }), CCAPP_RUN_ID: String(run.id), CCAPP_GW_PORT: String(CFG.port), CCAPP_GW_PID: String(process.pid), ...((run.privTok = privToken(run)) ? { CCAPP_PRIV_SESS: run.privTok } : {}), ...(wrapped ? { ENOSYS_RUN_PIDFD: "3" } : {}) },
    stdio: wrapped ? ["pipe", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
    detached: true,            // 当进程组长，中断时好整组带走（见 killTree）
  });
  run.child = child; run.preSpawn = false;
  // 首字前分段（F6）：准备（起进程前那些等待）→ 启动并连工具（到 claude 的 init）→ 等端口（到第一条 message_start）
  run.tBoot = Date.now();
  emit({ type: "phase", phase: "boot" });
  run.claudePid = wrapped ? 0 : child.pid;
  if (wrapped && child.stdio[3]) {
    let got = "";
    child.stdio[3].on("data", (d) => { got += d; const m = /^(\d+)\n/.exec(got); if (m) run.claudePid = child.claudePid = +m[1]; });
    child.stdio[3].on("error", () => {});
  }
  // 留下的进程冒充这一轮时比启动先后（见 leftover.mjs）。claude 不可转储时 /proc 里看不见它：拿一个刚起的进程的启动时刻代替（不会更晚于 claude）
  run.childStart = procStart(child.pid) ?? nowTicks();
  // 核过之后、真正执行之前程序被换掉了（来回替换卡时间窗）：这一轮停掉（DeepSeek 复核建议 2）
  if (!P.local && !sealStillValid()) {
    log(`${runTag(run)} ⚠️ [Claude Code 核验] 核过之后程序文件又变了，停掉这一轮`);
    tamperRecord("claude", ["claude: changed right after it was verified"]);
    emit({ type: "error", message: tr(LAST_LANG, "Claude Code 程序和官方签名清单对不上，可能被改过，这一轮没有启动。到 设置 → 更新 里重新安装后再试。") });
    abortRun(run);
  }
  if (item.timeoutMs > 0) run.limitTimer = setTimeout(() => { run.timedOut = true; log(`${runTag(run)} ⏱ 超过时长上限 ${Math.round(item.timeoutMs / 60000)} 分钟，停止`); abortRun(run); }, item.timeoutMs);
  child.stdin.on("error", () => {});
  const writeUser = (content) => child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n");
  // 该建档时，提醒作为本轮消息的第二段跟进去：读用户消息的地方只认第一段、或跳过 <…> 开头的段，历史 / 搜索 / 分叉比对都看不见它。斜杠命令不带（包成两段 claude 就不认它是命令了）
  // 子代理汇总也是这样跟着用户的消息进去（见 takeAgentNote），不单独叫醒主会话
  // 图片块（见 inlineimg.mjs）排在用户原话后面、提醒前面
  // 用户原话里冒充系统的标签（<system-reminder> 之类）先换成全角，只有网关自己加的提醒是真标签（见 integrity.mjs）
  // 取走的提醒先记着：这一轮没送到模型（没起来、出错、没答完）就放回去，下一轮再带（0.6.9 审计 200-S-10：以前取用即销毁）
  const back = { tamper: [], path: "", uc: "", agent: [] };
  run.giveNotesBack = () => {
    run.giveNotesBack = null;
    if (back.tamper.length) tamperRetell(back.tamper);
    putPathNote(run.sessionId, back.path);
    ucPutNote(back.uc);
    if (back.agent.length) putAgentNote(run.cwd, run.sessionId, back.agent.join("\n"));
    if (back.tamper.length || back.path || back.uc || back.agent.length) log("这一轮没送到模型：提醒放回去，下一轮再带");
  };
  const withNotes = (msg0, extra, imgs = []) => {
    const msg = neutralizeMarkers(msg0);
    if (P.local || msg.trim().startsWith("/")) return msg;
    const an = takeAgentNote(run.cwd, run.sessionId);
    if (an) back.agent.push(an);
    const notes = [msg !== msg0 ? SPOOF_NOTE : "", extra, an].filter(Boolean);
    return notes.length || imgs.length ? [{ type: "text", text: msg }, ...imgs, ...notes.map((n) => ({ type: "text", text: `<system-reminder>\n${n}\n</system-reminder>` }))] : msg;
  };
  // 上一轮只写了文件名没写全路径：这一轮的消息带上提醒（见 pathnote.mjs）。命令那轮不带（带了也包不进去，提醒会白白丢掉）
  const pathNote = back.path = isCmd || P.local ? "" : takePathNote(run.sessionId);
  // 应用文件被改过、已还原（tamper.mjs）：告诉模型一次，别再去改回来
  // 这两条不分会话：没人看着的（定时任务）不取，留给用户下一次自己发的那轮
  const tamperN = isCmd || P.local || run.unattended ? "" : tamperNote(back.tamper);
  const ucN = back.uc = isCmd || P.local || run.unattended ? "" : ucTakeNote();
  writeUser(withNotes(message, [tamperN, ucN, integNote, arch?.note, pathNote, refN].filter(Boolean).join("\n\n"), imgs0));
  run.inputOpen = true;
  run.pendingInject = [];      // 已写进 stdin、还没被 claude 吃进去的插话
  run.slashFlight = [];        // 空闲时送进去的斜杠命令（见 run.inject）：等它的 result。只在空闲时送，同时最多一条
  run.slashMark = { seen: false, bg: false, yielded: false };   // 那条命令有没有动静（回显、压缩事件、<synthetic> 输出）、送进去后后台任务有没有变
  const WROTE = new WeakMap();  // 普通插话 → 写进 stdin 的文字（回显按它认，别按内容猜成斜杠命令的，复核 v067b-1）
  const textOf = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.filter((x) => x && x.type === "text").map((x) => x.text).join("\n") : "").trim();
  run.bgTasks = 0;             // claude 报的后台任务数（见 feed）
  run.bgList = [];             // 后台任务明细：{ id, type, desc }（shell / 子代理 / monitor / 工作流），界面列出来、可单独停
  run.replays = 0;
  run.usageTools = new Set();   // 使用统计：本轮见过的工具调用（流式会重复报同一个）
  let subDir = null;
  // 本轮输出了多少 token（主会话 + 子代理，按请求去重，口径同使用统计）：边跑边推给底栏，收尾也报这个数。
  // 一秒最多推一次，推的事件进本轮记录，切走再切回来补发时也接得上
  run.outTok = 0;
  let outTimer = null, outSent = 0;
  const outEmit = () => {
    outTimer = null;
    if (run.ended || run.outTok === outSent) return;
    outSent = run.outTok;
    emit({ type: "run_tokens", out: run.outTok });
  };
  run.meter = usageMeter({ sid: () => run.sessionId, model: () => run.usageModel, start: Date.now(),   // token 边跑边记（见 usage.mjs）
    add: (d, sid, model) => {
      usageAdd(d, sid, model);   // 使用统计关着时它自己不记，这里的累计照算
      noteTokenDelta(run.provider, d);   // 接口账本也按这个记：含子代理、中断的那轮、按实际发生的小时（195-O.1/O.3/O.4）
      if (d.o > 0) { run.outTok += d.o; if (!outTimer) { outTimer = setTimeout(outEmit, 1000); outTimer.unref?.(); } }
    },
    subDir: () => subDir || (subDir = sfile()?.replace(/\.jsonl$/, "/subagents") || null) });
  run.paths = pathWatch();      // 本轮写过的文件、回复里有没有写全路径（收尾时核对，见 pathnote.mjs）
  run.inject = (item) => {
    if (!run.inputOpen || run.ended || run.aborted) return false;
    if (item.message.trim().startsWith("/")) {
      // 斜杠命令（只在这一轮答完、只剩后台任务时进来，见 queue.mjs 的 tryInject）。claude 回显不统一（11-05 实测）：
      // /compact 回显「<local-command-stdout>…」，/cost /context 不回显，不认识的命令原样回显 —— 不能像普通插话那样靠回显算送达。
      // 所以写进去就当场画出来、算新的一轮；回显来了吞掉，它的 result 出来就算办完
      try { writeUser(item.message); } catch { return false; }
      run.slashFlight.push(item);
      run.slashMark = { seen: false, bg: false, yielded: false };
      run.idle = false; resultStale = true;
      emit({ type: "inject", text: item.message, cid: item.cid, itemId: item.id });   // 先画消息（前端借它另起气泡、重新计时）
      emit({ type: "run_busy", startedAt: Date.now() });
      saveRunMark(); publishState();
      log(`↪ 插话 ${promptLogLine(item.message, true)}`);
      return true;
    }
    // 插话里的档号也附上那一章的摘要（同步版：只查已有索引，等不起整理）
    let refI = "";
    if (!P.local) try { refI = refNoteSync(item.message, run.sessionId); } catch (e) { log("插话档号引用失败: " + e.message); }
    const content = withNotes(item.message, refI || null, inlineImagesSync(item.message, P));
    try { writeUser(content); } catch { return false; }
    WROTE.set(item, textOf(content));
    run.pendingInject.push(item);
    // 空闲轮次的收尾定时器（6 秒 / IDLE_CLOSE_MS）要撤掉：claude 吃进这条、吐出第一个事件之前它到点了，
    // 就会把 stdin 关掉，这一轮被打断、之后的工具确认也写不进去（0.6.9 审计 195-W.3）。这一轮的 result 之后照常判断收尾
    if (run.idleClose) { clearTimeout(run.idleClose); run.idleClose = null; }
    saveRunMark();     // 马上落盘：送达前 App 被强停，下次启动它还能回到队列里，不会凭空消失
    log(`↪ 插话 ${promptLogLine(item.message, false)}`);
    return true;
  };
  // 子代理联络簿：落盘交代/汇报/长消息，推 ag 事件；一批全部结束时留一条只带路径的短话，跟着用户下一条消息进去
  run.agents = agentBook(run, { emit });
  // 每轮 result 之后：没有待送达的插话就关 stdin，claude 随即退出；有就留着，它会接着处理
  // ── 权限确认（stream-json 控制协议）──
  // claude 要用需确认的工具时，往 stdout 发 control_request(can_use_tool) 然后等；我们回 control_response。
  // 待答的请求存在 run.perms，同时作为 perm_request 事件发给前端（也进 run.log，断线重连能补到）。
  run.perms = new Map();
  const writeCtl = (o) => { try { child.stdin.write(JSON.stringify(o) + "\n"); return true; } catch { return false; } };
  let ctlN = 0;
  run.setMode = (mode) => { run.permMode = mode; return run.inputOpen && writeCtl({ type: "control_request", request_id: "ccapp-" + (++ctlN), request: { subtype: "set_permission_mode", mode } }); };
  // 停掉一个后台任务（stop_task 控制请求；claude 停完会再报一次 background_tasks_changed）
  run.stopTask = (taskId) => run.inputOpen && run.bgList.some((t) => t.id === taskId) &&
    writeCtl({ type: "control_request", request_id: "ccapp-" + (++ctlN), request: { subtype: "stop_task", task_id: taskId } }) && (run.stopAsked = true);
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
      if (p.guard) (run.guardOk = run.guardOk || new Set()).add(guardKey(p));   // 这一轮同样的不再问（读屏点按按类别，其余按具体目标）
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
    // 「拒绝并停止」也是停止：这一轮后面排着的别自动发（审查 #49 P2-3）
    if (resp.interrupt) holdLane(run);
    // 超时没答的和用户点了拒绝要分得开：界面上不能把「没人答」说成用户拒绝（FIND-043）
    const expired = !!a.expired;
    log(`${resp.behavior === "allow" ? "✓ 允许" : expired ? "⌛ 超时未答，按拒绝处理" : "✗ 拒绝"} ${p.tool}${a.always && resp.updatedPermissions ? "（始终）" : ""}${a.interrupt ? "（并停止）" : ""}`);
    emit({ type: "perm_resolved", id, behavior: resp.behavior, always: !!resp.updatedPermissions, interrupt: !!a.interrupt, ...(expired ? { expired: true } : {}) });
    // 批准时顺带切模式，规则见 config.mjs permModeAction；"run" 只把这一轮从计划模式带回原模式，全局设置不动（项目默认可能和全局不同）
    const act = permModeAction(resp.behavior, a.mode, run.permMode);
    if (act === "global") setPermMode(a.mode);
    else if (act === "run") run.setMode(a.mode);
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
      // 敏感操作再确认（guard/cc-guard.mjs 的 ask）：reason 形如 cccodroid-guard|类别|说明
      const gm = r.decision_reason_type === "hook" && /^cccodroid-guard\|([^|]+)\|(.*)$/s.exec(String(r.decision_reason || ""));
      if (gm) { p.guard = { cat: gm[1].slice(0, 80), what: gm[2].slice(0, 200) }; p.reason = null; }
      if (run.unattended) {
        log(`✗ 无人值守，自动拒绝 ${p.tool} ${argLen(p.input)}`);
        (run.denied = run.denied || []).push(p.tool);
        writeCtl({ type: "control_response", response: { subtype: "success", request_id: id, response: { behavior: "deny",
          message: "This is an unattended scheduled run: nobody can approve this action, so it is denied. Do not retry it; finish with what you can do and say what was blocked." } } });
        return;
      }
      // 同一轮里这一类敏感操作已经点过允许（比如一连串读屏点按）：别每步都问
      if (p.guard && run.guardOk?.has(guardKey(p))) {
        log(`✓ 敏感操作本轮已允许过，放行 ${p.tool} ${p.guard.cat || ""}`);
        writeCtl({ type: "control_response", response: { subtype: "success", request_id: id, response: { behavior: "allow", updatedInput: p.input } } });
        return;
      }
      // 全部放行时 claude 不该再来问；来了（子代理没继承到模式之类）就直接放行，必须由人回答的（AskUserQuestion 等）照问。
      // 敏感操作再确认的卡片例外：那是专门为全部放行加的一道兜底
      if (run.permMode === "bypassPermissions" && !p.interactive && !HUMAN_TOOLS.has(p.tool) && !p.guard) {
        log(`✓ 全部放行，自动允许 ${p.tool}${p.agentId ? "（子代理）" : ""} ${argLen(p.input)}`);
        writeCtl({ type: "control_response", response: { subtype: "success", request_id: id, response: { behavior: "allow", updatedInput: p.input } } });
        return;
      }
      run.perms.set(id, p);
      // 一直没人答：到点按「拒绝并停止」收掉，别让这一轮永远占着车道、后面的消息一直排队（0.6.9 审计 P1-4）
      const tm = setTimeout(guarded("权限确认超时", () => {
        if (!run.perms.has(id) || run.ended) return;
        log(`${runTag(run)} ⌛ ${p.tool} 等确认超过 ${PERM_WAIT_MS / 60000} 分钟没人答，按拒绝处理并停止这一轮`);
        run.answerPerm(id, { behavior: "deny", interrupt: true, expired: true, message: `The user did not respond to this permission request for ${PERM_WAIT_MS / 60000} minutes, so it was denied.` });
      }), PERM_WAIT_MS);
      tm.unref?.();
      log(`⏸ 等确认 ${p.tool} ${argLen(p.input)}`);
      emit({ type: "perm_request", ...permView(p) });
      publishState();
      return;
    }
    // 别的控制请求（hook 回调、MCP elicitation…）我们不接：回错误，别让 claude 干等
    if (id) {
      log(`${runTag(run)} ↩ 不支持的控制请求 ${String(r.subtype || "?")}（${id}），回了 error`);
      writeCtl({ type: "control_response", response: { subtype: "error", request_id: id, error: `unsupported: ${r.subtype}` } });
    }
  };

  const closeInput = () => {
    if (!run.inputOpen || run.perms.size) return;
    run.inputOpen = false;
    try { child.stdin.end(); } catch {}
  };

  // lastResult 只证明「它那一轮」答完了：后台回报 / 插话会在同一进程里再起一轮，
  // 那一轮还没出 result 就异常退出时，不能拿旧的 result 报成功（#96 02-002）。resultStale 记「之后又动起来了」
  let buf = "", stderr = "", lastResult = null, resultStale = false;
  // 开了 --include-partial-messages，正文已经逐字发过，assistant 事件别重复整段
  const flags = { gotDelta: false, isCmd };
  const onInit = (init) => {
    if (!run.tInit) { run.tInit = Date.now(); emit({ type: "phase", phase: "connect", from: "init" }); }
    setLastInit(init);
    run.sessionId = init.session_id;
    markIncomplete(run.sessionId, run.id);   // 新会话：拿到会话号就记上（FIND-040）
    run.usageModel = init.model || run.usageModel;
    // 新会话的 run_start 发出时还没有会话号：回填进日志，别的视图切过来、整轮重放时才认得出这是它的
    for (const e of run.log || []) if (e.type === "run_start" && !e.sessionId) e.sessionId = run.sessionId;
    RUN_SESSIONS.set(run.id, run.sessionId);
    if (run.privTok && !PRIV_TOK.has(run.sessionId)) PRIV_TOK.set(run.sessionId, run.privTok);   // 新会话：有了会话号才挂上
    if (RUN_SESSIONS.size > 500) RUN_SESSIONS.delete(RUN_SESSIONS.keys().next().value);
    rememberSession(run.sessionId);
    if (item.pin) setSessModel(run.sessionId, item.pin, item.projectId);   // 新会话首条带来的选择：有了会话号就记上
    if (item.mergeFrom && !item.sessionId) { recordExtra(run.sessionId, item.mergeFrom); item.mergeFrom = null; }   // 汇合：当场记来源（事后推断不出来）
    saveRunMark();                       // 标记里补上会话号：被杀之后「继续」要靠它 --resume
    if (!SESSIONS.has(init.session_id)) {
      SESSIONS.set(init.session_id, { id: init.session_id, title: message.slice(0, 60), createdAt: Date.now() });
      // 网关长跑不重启时别一直涨（0.6.9 审计 200-6-05 剩下的一半，v4pro 复核）。只拿来判断「本次起过的会话」，淘汰掉的退回查文件在不在
      if (SESSIONS.size > 5000) SESSIONS.delete(SESSIONS.keys().next().value);
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
    lastResult = r; resultStale = false;
    // 这一轮走到了结果（答完或报错）：不再是「没跑完」（FIND-040）
    clearIncomplete(run.sessionId);
    if (run.intrPending && !r.is_error) { run.intrPending = false; clearInterrupted(run.sessionId); }
    // 空闲时送进去的斜杠命令：这个 result 一般就是它的（送进去前这一轮已经答完）。
    // 送进去后后台任务有变、命令自己又还没动静：这个多半是后台任务回报那一轮的，不认领（认领了会在命令还没办完时关 stdin，复核 v067b-3）；
    // 每条命令最多让一次，之后的 result 照认：命令自己的轮次里也会动后台任务，让了它自己的 result 就会永远挂着（DeepSeek 复核 v067c 中-2）。
    // 认错了只是轮数统计的归属漂一下
    let slashDone = null;
    if (run.slashFlight.length) {
      if (run.slashMark.seen || !run.slashMark.bg || run.slashMark.yielded) { slashDone = run.slashFlight.shift(); run.slashMark = { seen: false, bg: false, yielded: false }; saveRunMark(); }
      else { run.slashMark.bg = false; run.slashMark.yielded = true; }
    }
    run.lastSlash = !!slashDone;
    run.meter.result(r, !isCmd && !slashDone);   // 斜杠命令不算一轮对话，但 /compact 这类真花了的 token 照记
    // 定时任务的单次花费上限：后台回报 / 插话会在同一进程里接着花，每出一个 result 就核一次，超了当场停（#98 03-010）。
    // 一轮之内 claude 不报花费，这一轮本身超出的部分只能在它答完时发现
    // 只有官方（nativeModels）的价目对得上：第三方端口按 Anthropic 价目估出来能高一二十倍，不计花费，金额上限 / 每日预算对它不生效（0.6.9 审计 195-U.3、197-5.8，用户定）
    if (P.nativeModels) run.costSeen = Math.max(run.costSeen || 0, Number(r.total_cost_usd) || 0);
    if (item.limitCost > 0 && run.costSeen > item.limitCost && !run.overBudget) {
      run.overBudget = true;
      // 本来就要收尾的（没有插话、没有后台任务）让它正常结束，留下回复；还要接着干的当场停
      if (run.pendingInject.length || run.bgTasks) {
        log(`${runTag(run)} 💸 花费 $${run.costSeen.toFixed(4)} 超过单次上限 $${item.limitCost}，停止`);
        abortRun(run);
        return;
      }
    }
    if (run.pendingInject.length || run.slashFlight.length) { resultStale = true; return; }   // 插话还没送到 / 命令还没办完：claude 接着还要答一轮
    if (!run.bgTasks) return closeInput();
    // 答完了，只是后台任务（本地服务之类）还在跑：界面上算这一轮结束，进程和 stdin 留着等任务回报
    run.idle = true;
    emit({ type: "run_idle", bg: run.bgTasks, at: Date.now() });
    publishState();
  };
  // 斜杠命令在途时才认它的回显：「<local-command-…」或命令原文
  const slashEcho = (txt) => run.slashFlight.length > 0 && (/^<local-command-(?:stdout|stderr)>/.test(txt) || run.slashFlight.some((it) => it.message.trim() === txt));
  const onReplay = (ev) => {
    // 第一条回显是本轮的原始消息；之后每条都是一条送达的插话（按写入顺序）
    // 斜杠命令的回显吞掉：它在送进去时已经画过了，也不占普通插话的位置。和排在最前的普通插话写进去的一字不差的，算那条插话
    if (run.replays > 0) {
      const txt = textOf(ev.message?.content), head = run.pendingInject[0];
      if (!(head && WROTE.get(head) === txt) && slashEcho(txt)) { run.slashMark.seen = true; return; }
    }
    const said = run.replays === 0 ? message : run.pendingInject[0] && run.pendingInject[0].message;
    if (said && usageIsPrompt(said)) usageAdd({ m: 1 }, run.sessionId);
    if (run.replays++ === 0) return;
    const it = run.pendingInject.shift();
    if (it) { emit({ type: "inject", text: it.message, cid: it.cid, itemId: it.id }); saveRunMark(); }
  };
  const feed = (line) => {
    let ev; try { ev = JSON.parse(line); } catch { return; }
    if (ev.type === "control_request") return onControl(ev);
    run.meter.feed(ev);
    if (run.slashFlight.length && ((ev.type === "system" && (ev.subtype === "compact_boundary" || (ev.subtype === "status" && ev.status === "compacting"))) ||
        (ev.type === "assistant" && ev.message?.model === "<synthetic>"))) run.slashMark.seen = true;
    // 清单工具一出结果就推，不等 4 秒轮询
    if (ev.type === "user" && ev.tool_use_result && (ev.tool_use_result.task || ev.tool_use_result.statusChange || ev.tool_use_result.updatedFields)) setImmediate(() => tasksCheck(run.sessionId));
    // 我们发的 set_permission_mode 的回执：被拒要记下来（以前直接丢掉，切了没生效也看不出来）
    if (ev.type === "control_response") {
      // 说清楚是「控制请求回了错误」，不是用户拒绝：以前一律写成「claude 拒绝了控制请求」，排查时误导（FIND-043）
      const cr = ev.response || {};
      if (cr.subtype === "error") log(`${runTag(run)} ⚠️ 控制请求回了错误（request=${String(cr.request_id || "?")}，code=${String(cr.error_code || "-")}）：${String(cr.error || "").slice(0, 160)}`);
      return;
    }
    if (ev.type === "assistant" && Array.isArray(ev.message && ev.message.content)) {
      let n = 0;
      for (const c of ev.message.content) if (c && c.type === "tool_use" && c.id && !run.usageTools.has(c.id)) { run.usageTools.add(c.id); n++; }
      if (n) usageAdd({ tl: n }, run.sessionId);
      run.paths.feed(ev);
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
      if (run.slashFlight.length && ev.tasks.length !== run.bgTasks) run.slashMark.bg = true;
      run.bgTasks = ev.tasks.length;
      run.bgList = ev.tasks.slice(0, 30).map((t) => ({ id: String(t.task_id || ""), type: String(t.task_type || ""), desc: String(t.description || "").slice(0, 200) }));
      if (run.idle && run.bgTasks) emit({ type: "run_idle", bg: run.bgTasks });
      publishState();                    // 明细跟着状态走（runInfo.bgList），断线重连也补得上
      // 空闲中后台任务全没了：任务自己跑完时 claude 会接着起一轮（之后的 result 会关 stdin）；
      // 被 stop_task 停掉的只排进它的队列、不起新一轮，这一轮就永远挂着：我们发过 stop_task 的等 6 秒没动静就收尾。
      // 自己跑完的不能这么快关：上下文大时 claude 起新一轮的第一个字常常超过 6 秒，stdin 先关了，那一轮里再起的后台任务
      // （比如重开一条 SSH 隧道）就成了插话发不进、停止按不动的死局，消息永远排着（11-02 群友）。这种只留个兜底
      clearTimeout(run.idleClose);
      if (run.idle && !run.bgTasks) run.idleClose = setTimeout(() => { if (run.idle && !run.bgTasks && !run.ended) closeInput(); }, run.stopAsked ? 6000 : IDLE_CLOSE_MS);
    }
    // 空闲中 claude 又动起来了（后台任务回报、或用户发来的新消息）：重新算「生成中」。
    // 只认主会话自己的事件：后台子代理的消息也从这条流出来（带 parent_tool_use_id），它们说话不等于主会话开了新一轮——
    // 以前不分，主会话答完「请稍等」、子代理一开口，界面就又是「生成中」加一个空的「连接中」，一直挂到子代理跑完
    const mainEv = !ev.parent_tool_use_id && !ev.isSidechain;
    if (run.idle && mainEv && (ev.type === "assistant" || ev.type === "stream_event" || (ev.type === "system" && ev.subtype === "init"))) {
      run.idle = false; resultStale = true;
      run.stopAsked = false;   // 发过的 stop_task 只管那一次空闲；新一轮之后再空闲，照「自己跑完」的兜底算（DeepSeek 复核 中-1）
      emit({ type: "run_busy", startedAt: Date.now() });
      publishState();
    }
    run.agents.feed(ev);
    // 钩子往上下文里塞的文本过破甲检查（红队 11-07 通道 C）：命中就中止这一轮，注入原文折叠亮给用户。
    // 发行版封口把用户/项目钩子挡在 --setting-sources "" 外，这是 dev 包的兜底；网关自带的钩子不产 additionalContext，无感
    if (ev.type === "system" && ev.subtype === "hook_response") {
      const htext = hookBlocked(ev);
      if (htext && !run.hookBlocked) {
        run.hookBlocked = true;   // 中止后进程死前还会来事件：只报一次
        const hname = String(ev.hook_event || ev.hook_name || "hook").slice(0, 60);
        log(`[钩子注入] ${hname} 命中破甲特征，这一轮中止`);
        emit({ type: "hook_ctx", event: hname, text: htext });
        emit({ type: "note", key: "hook_blocked", text: tz("钩子（{ev}）注入的文字命中破甲特征，这一轮已中止；注入原文折叠在上方。", { ev: hname }) });
        abortRun(run);
        return;
      }
    }
    if (!run.tFirst && run.tInit && ev.type === "stream_event" && ev.event?.type === "message_start" && !ev.parent_tool_use_id) {
      run.tFirst = Date.now();
      const s = (ms) => (ms / 1000).toFixed(1) + "s";
      log(`⏱ 首个回应前：准备 ${s(run.tBoot - run.startedAt)} · 启动并连工具 ${s(run.tInit - run.tBoot)} · 等端口 ${s(run.tFirst - run.tInit)}`);
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
      // 单条事件处理出错只丢这一条：以前这里没有 try，一个形状不对的事件就带走整个网关（0.6.9 审计 P1-6）
      if (line) { try { feed(line); } catch (e) { log(`${runTag(run)} ⚠️ 处理 claude 事件出错（已跳过这条）: ${(e && e.stack) || e}`); } }
    }
  });

  child.stderr.on("data", (d) => {
    const s = d.toString("utf8");
    stderr = (stderr + s).slice(-20000);      // 留最后一段：出错原因通常在末尾，以前只留开头，尾巴全丢（FIND-045）
    if (/error|Error|failed|ENOENT|EACCES/.test(s)) log(`${runTag(run)} [claude!] ${s.trim().slice(0, 300)}`);
  });

  // 收尾时把没送达的插话/斜杠命令退回队列。抽成函数，强制收尾路径（queue.abortRun）也要用，
  // 否则 5 秒兜底直接 endRun 会把已经写进 stdin 的消息静默丢掉（审查 11-05）
  const requeuePending = () => {
    if (run.pendingInject.length) {
      log(`插话 ${run.pendingInject.length} 条没来得及送达，退回队首`);
      QUEUE.unshift(...run.pendingInject.map((it) => ({ ...it, injected: false, held: !!((run.aborted && !run.retired) || run.laneHeld) })));
      run.pendingInject = [];
    }
    // 没办完的斜杠命令也退回（复核 v067b-2）。可能已经办了一半（比如压缩完了没等到 result）：一律挂起，等用户点 ⚡ 再发
    if (run.slashFlight.length) {
      log(`斜杠命令 ${run.slashFlight.length} 条没等到结果，挂起退回队首`);
      QUEUE.unshift(...run.slashFlight.map((it) => ({ ...it, injected: false, held: true })));
      run.slashFlight = [];
    }
  };
  run.requeuePending = requeuePending;

  const finish = (code, signal) => {
    if (buf.trim()) feed(buf.trim());
    buf = "";
    run.meter.close();                   // 中断 / 被杀也走这里：子代理记录最后扫一遍
    try { run.agents?.close(); } catch (e) { log(`${runTag(run)} 子代理收尾出错: ${e.message}`); }
    // claude 已经退出，这时的记录就是下一轮的基准；提醒这一轮已经交出去（正常答完）才清掉标记
    if (!lastResult || lastResult.is_error) run.giveNotesBack?.();
    try { sealSession(run.sessionId, sfile(), { clear: !!integNote && !run.aborted && !!lastResult && !lastResult.is_error, base: run.sealBase?.sid === run.sessionId && run.sealBase.hash ? run.sealBase : null }); } catch (e) { log(`${runTag(run)} [封签] ${e.message}`); }
    run.inputOpen = false;
    run.perms.clear();                // 卡片随 run_end 一起作废（前端按 run_end 收起）
    requeuePending();
    const ms = Date.now() - t0;
    // 定时任务已经花掉的（崩了、没出 result 也一样）：按 0 记会让它当作没花钱再重试（DeepSeek 复核 #1）
    const spent = () => (run.sched && run.costSeen ? { costRaw: run.costSeen } : {});
    if (run.aborted) {
      log(`${runTag(run)} ⏹ 已中断 (${ms}ms)`);
      return endRun(run, { durationMs: ms, ...(run.retired ? { retired: true } : {}), ...(run.outTok ? { usage: { output_tokens: run.outTok } } : {}), ...(run.sched && run.costSeen ? { costRaw: run.costSeen } : {}) });
    }
    // 最后一个 result 之后又起了一轮、没等到它的 result 就异常退出：按失败算，别沿用上一轮的成功
    if (lastResult && resultStale && (code !== 0 || signal)) {
      const hint = exitHint(code, signal);
      log(`${runTag(run)} ✖ ${hint}（上一轮已答完，接着的这一轮没答完）${stderr ? " :: " + stderr.trim().slice(-300) : ""}`);
      billAfterRun(run.provider);
      emit({ type: "error", message: tr(LAST_LANG, hint), detail: exitDetail(stderr) });
      return endRun(run, { failed: true, durationMs: ms, ...spent() });
    }
    if (lastResult) {
      const localCmd = run.lastSlash ? null : lastResult.local_command || null;   // 插进去的命令的输出已经画过，别把整轮画成命令卡（复核 v067b-5）
      log(`✔ 完成 ${ms}ms  ${lastResult.num_turns || "?"} 轮  ` +
          `上下文=${flags.contextTokens ?? "?"} out=${lastResult.usage?.output_tokens ?? "?"}  ` +
          `$${Number(lastResult.total_cost_usd || 0).toFixed(5)}${localCmd ? "  [" + localCmd + "]" : ""}`);
      billAfterRun(run.provider);
      if (!isCmd && !lastResult.is_error && run.sessionId) idleArm(run.sessionId, flags);
      if (!isCmd && !P.local && !lastResult.is_error) settlePathNote(run.sessionId, run.paths);
      // 新会话第一轮答完就在后台起个标题，不等第二条消息（#60，见 autotitle.mjs）；定时任务的会话不起
      if (!isCmd && !P.local && !run.sched && !lastResult.is_error) autoTitle(run.sessionId, P, model);
      return endRun(run, {
        durationMs: ms,
        // claude 按内置的 Anthropic 价目表算账；第三方厂商的价格差得远，报出来能高一二十倍，干脆不报
        costUsd: P.nativeModels ? Number(lastResult.total_cost_usd || 0) : 0,
        usage: lastResult.usage
          ? {
              // 算上子代理（result.usage 只有主会话）；流里一条都没记到时退回 result 的数
              output_tokens: run.outTok || lastResult.usage.output_tokens || 0,
              context_tokens: flags.contextTokens || 0,   // 真实占用（累计和不算）
              context_window: contextWindowOf(lastResult, P, model || undefined),
            }
          : null,
        subtype: lastResult.subtype,
        isError: !!lastResult.is_error,
        // 本地命令（/context /cost …）的结果正文在这里
        localCommand: localCmd,
        resultText: localCmd ? String(lastResult.result || "") : "",
        ...(run.sched ? { finalText: String(lastResult.result || "").slice(0, 4000), costRaw: P.nativeModels ? Number(lastResult.total_cost_usd || 0) : 0 } : {}),
      });
    }
    const hint = code !== 0 || signal ? exitHint(code, signal) : tz("生成结束但没有返回结果");
    log(`${runTag(run)} ✖ ${hint}${stderr ? " :: " + stderr.trim().slice(-300) : ""}`);
    emit({ type: "error", message: tr(LAST_LANG, hint), detail: exitDetail(stderr) });
    endRun(run, { failed: true, durationMs: ms, ...spent() });
  };

  child.on("error", (e) => {
    log(`${runTag(run)} spawn 出错: ${e.message}`);
    run.giveNotesBack?.();
    emit({ type: "error", message: tr(LAST_LANG, tz("无法启动 claude：{err}", { err: e.message })) });
    endRun(run, { failed: true });
  });
  // 收尾出错也要把这一轮结束掉，不然车道永远占着（0.6.9 审计 P1-6）
  let closed = false;
  const finishSafe = (code, signal) => {
    if (closed) return;
    closed = true;
    try { finish(code, signal); }
    catch (e) { log(`${runTag(run)} ⚠️ 收尾出错: ${(e && e.stack) || e}`); try { endRun(run, { failed: true }); } catch {} }
  };
  // 管道关不掉的兜底（queue.abortRun 5+2 秒后调）：走和正常退出同一条 finish —— 封签、账本、权限卡、未送达消息都要收，
  // 以前直接 endRun 把这些全跳过了（FIND-002）。进程树由调用方负责杀，这里只把管道拆掉
  run.forceFinish = () => {
    log(`${runTag(run)} ⏹ 强制收尾：按正常收尾处理`);
    for (const s of [child.stdin, child.stdout, child.stderr]) try { s?.destroy(); } catch {}
    finishSafe(null, "SIGKILL");
  };
  child.on("close", finishSafe);
  // claude 已经退出、但另开进程组的子孙还攥着它的 stdout / stderr 时，close 永远不来：退出 5 秒后还没 close 就自己收尾（0.6.9 审计 195-T.1，同 terminal.mjs）
  child.on("exit", (code, signal) => {
    const t = setTimeout(() => {
      if (closed) return;
      log(`${runTag(run)} claude 已退出，输出管道还被别的进程占着，强制收尾`);
      try { child.stdout.destroy(); child.stderr.destroy(); } catch {}
      finishSafe(code, signal);
    }, 5000);
    t.unref?.();
  });
}

// ── 路由：/api/perm/answer /api/perm/mode /api/task/stop /api/abort ──
export async function routeRun(req, res, u, p) {
  // ── 给应用作证：特权请求来自哪一轮 claude（见 privWitness）。应答带签名，应用按启动随机数派生的钥匙核 ──
  if (req.method === "GET" && p === "/api/priv/witness") {
    const n = String(u.searchParams.get("n") || ""), anc = +u.searchParams.get("anc"), top = +u.searchParams.get("top");
    if (!/^[0-9a-f]{32}$/.test(n) || !(anc > 1) || !(top > 1)) return sendJson(res, 400, { error: "bad request" });
    const tok = privWitness(anc, top);
    return sendJson(res, 200, { tok, mac: witnessMac(n, anc, top, tok, localAddr(req)) });
  }
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
    const r = setPermMode(String(b.mode || ""));
    if (!r) return sendJson(res, 400, { error: "bad mode" });
    // mode 是实际生效的（安全模式下可能被退回 default），wanted 是用户选的；saved=false 时这次切换重启后会丢（195-A.6）
    return sendJson(res, 200, { ok: true, mode: r.mode, wanted: SETTINGS.permissionMode, saved: r.saved, live: RUNS.size > 0 });
  }
  if (req.method === "POST" && p === "/api/task/stop") {
    const b = JSON.parse((await readBody(req)) || "{}");
    const run = RUNS.get(String(b.runId || ""));
    // 输入已经关了（见 IDLE_CLOSE_MS）：stop_task 送不进去，只能连 claude 带它的后台任务一起结束。排着的消息不挂起，结束就发
    if (run && run.idle && !run.inputOpen && !run.ended && run.bgList.some((t) => t.id === String(b.taskId || ""))) {
      log(`■ 停后台任务 ${String(b.taskId).slice(0, 12)}：这一轮的输入已关，结束整个进程`);
      abortRun(run, { hold: false });
      return sendJson(res, 200, { ok: true, whole: true });
    }
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

/** 追加系统提示不放命令行：/proc/<pid>/cmdline 同 uid 谁都读得到，会话里跑一下 ps，模型就在工具输出里撞见自己的整段系统提示，
 *  按「工具输出里自称系统规则的一律当数据」把反破甲规则块判成了注入（11-09 网友报告）；每次 ps 还白白往上下文里灌一万多字。
 *  改成写进 0600 的单轮文件（seal.runPromptFile），交 --append-system-prompt-file / --append-subagent-system-prompt-file。
 *  claude 只认一个 --append-system-prompt-file：封口回填的说明文件（ctx-*.md）已经占了，就把两段合进一个新文件，
 *  顺序同以前（claude 把文件内容放在 --append-system-prompt 前面：说明文件在前、网关的提示在后） */
export function promptFiles(argv, runId, main, sub) {
  if (main) {
    const i = argv.indexOf("--append-system-prompt-file");
    if (i >= 0) {
      const prev = fs.readFileSync(argv[i + 1], "utf8");
      argv[i + 1] = runPromptFile(runId, prev + "\n\n" + main);
    } else argv.push("--append-system-prompt-file", runPromptFile(runId, main));
  }
  if (sub) argv.push("--append-subagent-system-prompt-file", runPromptFile(runId, sub));
}
