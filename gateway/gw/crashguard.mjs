import { log } from "./config.mjs";

// ── 最后一道兜底：漏网的异常别带走整个网关 ──
// 以前故意不接 uncaughtException：孤儿网关（App 已经不在了，stdout 断了）要靠往 stdout 写日志时的 EPIPE 异常退出。
// 代价是任何定时器 / 子进程回调里一个形状不对的 JSON 就让网关崩了重启、重启再崩（0.6.9 审计 P1-6/11/14/15/16/19）。
// 现在接住：stdout / stderr 断了（EPIPE 那一类）照旧退出，保住孤儿自己退出的机制；别的记日志接着跑。
// 一分钟里接住太多次说明状态已经乱了，退出等 App 重拉（重拉有退避），别在坏状态里空转。

const PIPE_GONE = new Set(["EPIPE", "ERR_STREAM_DESTROYED", "ERR_STREAM_WRITE_AFTER_END"]);
const BURST = 20, WINDOW = 60e3;
let hits = [];

export function installCrashGuard() {
  process.on("uncaughtException", (e) => {
    if (e && PIPE_GONE.has(e.code)) process.exit(0);
    const now = Date.now();
    hits = hits.filter((t) => now - t < WINDOW); hits.push(now);
    try { log(`⚠️ 未捕获的异常（已接住，网关继续运行）: ${(e && e.stack) || e}`); } catch {}
    if (hits.length > BURST) { try { log("⚠️ 一分钟内接住的异常太多，退出等 App 重新拉起"); } catch {} process.exit(1); }
  });
  process.on("unhandledRejection", (e) => log(`未处理的 Promise 拒绝: ${(e && e.stack) || e}`));
}

/** 包一层：回调 / 定时器里抛的异常只记日志，不往外冒（label 写进日志，好查是谁） */
export function guarded(label, fn) {
  return function (...a) {
    try { return fn.apply(this, a); }
    catch (e) { log(`⚠️ ${label} 出错（已跳过）: ${(e && e.stack) || e}`); }
  };
}
