// ── 工作岛（可选集成）──────────────────────────────────────────────────────
// 在网关进程里直接订阅事件总线，把 Claude 的工作状态经 am 送给「工作岛」应用。
//
// 约束：
//  · 不另起进程：没有 detached child、没有 PID 文件、没有看门狗。
//    网关停，订阅和定时器一起没，不会留孤儿。
//  · 默认关闭：SETTINGS.workIsland 为 true 才检测应用、开始送状态。
//  · 只用 Node 内置模块；应用没装就完全不启动。
//  · 文案跟随 LAST_LANG；中文/英文两套。
import fs from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { SETTINGS } from "./settings-store.mjs";
import { runList } from "./runs.mjs";
import { onPublish } from "./bus.mjs";
import { LAST_LANG, log } from "./config.mjs";
import { createWorkIsland } from "./work-island-core.mjs";

const PKG = process.env.WORK_ISLAND_PKG || "com.dafeiyu.workisland";
const SVC = PKG + "/.IslandService";

function amArgs(action, title, text, since, state, extra) {
  const a = ["start-foreground-service", "--user", "0", "-n", SVC, "-a", PKG + "." + action];
  if (title) a.push("--es", "title", title);
  if (text) a.push("--es", "text", text);
  if (state) a.push("--es", "state", state);
  if (since) a.push("--el", "since", String(since));
  // 可选的清单进度：工作岛 1.5+ 用它画分段进度条；不传时应用按无清单处理。
  if (extra && Number.isInteger(extra.todoTotal) && extra.todoTotal > 0) {
    a.push("--ei", "todoDone", String(extra.todoDone || 0));
    a.push("--ei", "todoTotal", String(extra.todoTotal));
  }
  return a;
}

let warned = false;
// am 子进程串成一条队：同一时刻最多一个，按入队顺序送达，旧 UPDATE 不会晚于 DONE / IDLE 到（0.6.9 审计 200-13-08）
let amQ = [];
let amBusy = null;                               // 在途的 am 子进程
function amSend(...args) {
  // 排着队还没发出去的 UPDATE 被新的一条盖过：只发新的
  if (args[0] === "UPDATE" && amQ.length && amQ[amQ.length - 1][0] === "UPDATE") amQ.pop();
  amQ.push(args);
  amPump();
}
function amPump() {
  if (amBusy || !amQ.length) return;
  const args = amQ.shift();
  // 用绝对路径：PATH 里的包装脚本在部分环境会返回非零，实际却已经送达。
  const child = seam.exec(amArgs(...args), 8000, (e, out, err) => {
    if (amBusy !== child) return;                // 收尾时被杀掉的那个：不报错、不接着发
    amBusy = null;
    if (e) amFailed(e, err);
    amPump();
  });
  amBusy = child || null;
  if (!amBusy) amPump();
}
function amFailed(e, err) {
  if (!warned) {
    warned = true;
    log(`[work-island] am 失败（应用没装或服务未就绪？后面不再重复）：${e.message} ${String(err || "").slice(0, 120)}`);
  }
  // 系统不允许从应用身份起这个服务（Can't start from invalid source / Permission Denial）：
  // 再每 1.5 秒试下去也没用，停掉发送（0.6.9 审计 195-P.4 / 196 日志考古.2）
  if (/invalid source|not allowed|Permission Denial|SecurityException|unable to start/i.test(String(err || "") + e.message)) {
    log("[work-island] 系统不允许启动工作岛服务，已停止发送；重新打开设置里的开关可再试");
    fail("blocked", String(err || "").trim() || e.message);
    started = false;
    amQ = [];
    if (unsub) { try { unsub(); } catch {} unsub = null; }
    if (core) { try { core.stop(true, false); } catch {} core = null; }
  }
}
function amSendSync(...args) {
  // 退出路径上不等在途的：排队的作废，在途的杀掉（IDLE 本来就盖过它），再同步发这一条
  amQ = [];
  const busy = amBusy;
  amBusy = null;
  if (busy) { try { busy.kill("SIGKILL"); } catch {} }
  try { seam.execSync(amArgs(...args), 3000); } catch {}
}

let started = false;
let detecting = false;
// 最近一次没起来的原因：设置页显示并给「重试」（195-P.4）。not_installed = 没检测到应用；blocked = 系统不许从应用身份起服务
let lastErr = null;
const fail = (code, detail = "") => { lastErr = { code, detail: String(detail).replace(/\s+/g, " ").slice(0, 200), at: Date.now() }; };
let unsub = null;
let core = null;
// 每次开 / 关 +1：检测是异步的，关掉又开之后旧那次的回调必须作废，不能把第二份 core / 订阅装进来（#124-1）
let gen = 0;

function isAndroid() {
  return fs.existsSync("/system/bin/am");
}

function detectApp(cb) {
  if (process.env.CCAPP_WORK_ISLAND === "1") return cb(true);
  if (process.env.CCAPP_WORK_ISLAND === "0") return cb(false);
  // pm 默认按“当前用户”查；应用 uid 会撞 INTERACT_ACROSS_USERS（asks to run as user 10），
  // 必须显式 --user 0。但 Android 16 上包可见性会把 pm list 裁成「只剩自己」，
  // 列不出来不等于没装——再用 am 探一次服务（显式组件不受 list 过滤影响）。
  const probe = () => execFile("/system/bin/am",
    ["start-foreground-service", "--user", "0", "-n", SVC, "-a", PKG + ".IDLE"],
    { timeout: 4000 }, (e2, out2, err2) => {
      const msg = String(err2 || "");
      // 明确的「找不到」或「系统不许从应用身份起」都算用不了；超时之类的错误当作装了，交给后续 am 重试。
      if (e2 && /invalid source|not allowed|Permission Denial|SecurityException/i.test(msg)) return cb(false, "blocked", msg);
      cb(!(e2 && /not found|does not exist|does not have|unable to find/i.test(msg)), "not_installed", msg);
    });
  execFile("/system/bin/pm", ["list", "packages", "--user", "0", PKG], { timeout: 3000 }, (e, out) => {
    if (!e && String(out).includes("package:" + PKG)) return cb(true);
    probe();
  });
}

// 测试替身：检测和「是不是安卓」可以换掉，好在 CI（不是安卓）里按自己定的先后回调，复现开关交错（#124-1）
const seam = {
  detect: (cb) => detectApp(cb),
  android: () => isAndroid(),
  exec: (args, timeout, cb) => execFile("/system/bin/am", args, { timeout }, cb),
  execSync: (args, timeout) => execFileSync("/system/bin/am", args, { timeout, stdio: "ignore" }),
};
export const _islandForTest = { seam, send: amSend, sendSync: amSendSync, state: () => ({ started, detecting, core, unsub, amQ: amQ.length, amBusy: !!amBusy }) };

export function startWorkIsland() {
  if (started || detecting) return;
  if (!SETTINGS.workIsland) return;              // 默认关，用户开了才动
  if (process.env.CCAPP_WORK_ISLAND === "0") return;
  if (!seam.android()) return;
  started = true;
  detecting = true;
  const my = ++gen;                              // 这一次检测的世代：回来时不是它了就不作数
  seam.detect((ok, why, detail) => {
    if (my !== gen) return;                      // 检测期间关过 / 又开过：旧回调直接丢掉
    detecting = false;
    if (!started) return;                        // 检测期间被关掉了
    if (!ok) {
      started = false;
      fail(why === "blocked" ? "blocked" : "not_installed", detail || "");
      log(why === "blocked" ? "[work-island] 系统不允许启动工作岛服务，跳过" : "[work-island] 没检测到工作岛应用，跳过（装好后可在设置里重开一次）");
      return;
    }
    core = createWorkIsland({
      send: amSend,
      sendSync: amSendSync,
      runs: runList,
      lang: () => LAST_LANG,
    });
    unsub = onPublish((ev) => {
      try { core.handleEvent(ev); } catch {}
    });
    const live = runList().filter((r) => r && !r.ended);
    if (live.length) core.start(live[0]);        // 开设置时已经有轮次在跑
    else core.stop(true, true);                  // 没有轮次：先发一次 IDLE，收掉上一任网关被 SIGKILL 后留下的胶囊（195-P.1）
    lastErr = null;
    log("[work-island] 已订阅网关事件");
  });
}

export function stopWorkIsland(sync = false) {
  started = false;
  detecting = false;
  gen++;                                         // 在途检测的结果作废（#124-1）
  if (unsub) { try { unsub(); } catch {} unsub = null; }
  if (core) {
    try { core.stop(sync, true); } catch {}   // 用户关开关 / 网关退出：总要发 IDLE，别管这一进程里显示过没有（195-P.1）
    core = null;
  }
}

/** 网关 SIGTERM：同步发一次 IDLE，让岛收起，再退出。 */
export function stopWorkIslandSync() {
  stopWorkIsland(true);
}

/** 设置页显示用：开着没有、跑起来没有、没起来是为什么（195-P.4） */
export function workIslandStatus() {
  return { supported: seam.android(), wanted: SETTINGS.workIsland === true, started: started && !detecting, detecting, error: started ? null : lastErr };
}
/** 「重试」：关了再开，重新检测（装好应用、或系统放开之后） */
export function retryWorkIsland() {
  stopWorkIsland();
  lastErr = null;
  startWorkIsland();
  return workIslandStatus();
}

/** 设置页开关变化时调用。 */
export function applyWorkIslandSetting() {
  if (SETTINGS.workIsland) startWorkIsland();
  else stopWorkIsland();
}
