import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { CFG } from "./config.mjs";
import { SETTINGS } from "./settings-store.mjs";

// ── 分段并行下载 ─────────────────────────────────────────────────────
// 单个连接常被限速（实测 dl.cccodroid.net 单线 2.7 MB/s，4 路并行 14 MB/s）：服务器认 Range、文件又够大时，
// 把还没下的部分切成 N 段，各开一个 curl 同时下，按偏移写进同一个 .part（先占满到总大小）。
// 每段进度记在 <part>.seg（[起, 止, 已下]，每秒落盘一次，只会比实际写入的少）——被打断、换来源后按它续传，
// 换来源也没关系：几个来源是逐字节同一份文件，最后照样核 sha256。
// 文件小、不知道大小、服务器不认 Range 时退回单连接 curl -C -（和以前一样）。
// 返回 "" 表示下完了；否则返回一行错误（调用方据此换来源 / 重试，.part 和 .seg 都留着）
const MIN_SEG = 8 << 20;

export async function pget({ curl, url, file, total, n = 4, curlArgs = [], onProgress = () => {}, cancelled = () => false }) {
  const segFile = file + ".seg";
  let st = null; try { st = JSON.parse(fs.readFileSync(segFile, "utf8")); } catch {}
  const have = (() => { try { return fs.statSync(file).size; } catch { return 0; } })();
  // .seg 和 .part 对不上（大小变了、.part 被删了——比如校验不符时调用方只删了 .part）：两个都作废重来
  if (st && (st.total !== total || !Array.isArray(st.segs) || have !== total)) { st = null; fs.rmSync(segFile, { force: true }); fs.rmSync(file, { force: true }); }
  const have2 = st ? total : (() => { try { return fs.statSync(file).size; } catch { return 0; } })();
  if (!st && total > 0 && have2 === total) return "";                 // 上回已经下全、没来得及改名
  if (!st && !(total >= 2 * MIN_SEG && await rangeOk(curl, url, curlArgs))) return single({ curl, url, file, total, curlArgs, onProgress, cancelled });
  if (st && !(await rangeOk(curl, url, curlArgs))) {                          // 换到的来源不认 Range：分段的半成品没法接，从头单线下
    fs.rmSync(segFile, { force: true }); fs.rmSync(file, { force: true });
    return single({ curl, url, file, total, curlArgs, onProgress, cancelled });
  }
  if (!st) {
    // 以前单线下了一截的 .part 接着用：从它的末尾往后切段
    const from = Math.min(have2, total), left = total - from;
    const k = Math.max(1, Math.min(n, Math.floor(left / MIN_SEG)));
    const segs = [];
    for (let i = 0; i < k; i++) segs.push([from + Math.floor(left * i / k), from + Math.floor(left * (i + 1) / k) - 1, 0]);
    st = { total, segs };
    await fs.promises.writeFile(segFile, JSON.stringify(st));
  }
  // 异步文件句柄写入（走 libuv 线程池，配合 stdout pause/resume 背压）：
  // 并发下载多个组件时 8–12 路 curl 高速吐块，以前同步 fs.writeSync 会把事件循环堵死 >1.5s，触发宿主 /__proof 超时回 502
  const fh = await fs.promises.open(file, fs.existsSync(file) ? "r+" : "w+");
  let saveChain = Promise.resolve();
  try {
    await fh.truncate(total);
    const doneBytes = () => total - st.segs.reduce((a, [s, e, p]) => a + (e - s + 1 - p), 0);
    const save = () => {
      const snap = JSON.stringify(st);
      saveChain = saveChain.then(() => fs.promises.writeFile(segFile, snap).catch(() => {}));
      return saveChain;
    };
    const kids = new Set();
    const tick = setInterval(() => { save(); onProgress(doneBytes()); if (cancelled()) for (const c of kids) c.kill("SIGKILL"); }, 1000);
    const runSeg = async (seg) => {
      let fatal = false;                                              // curl 根本起不来：重试也没用，直接让下一个来源接手
      for (let attempt = 0; seg[2] < seg[1] - seg[0] + 1; attempt++) {
        if (cancelled()) return "cancelled";
        const err = await new Promise((resolve) => {
          const c = spawn(curl, ["-fsSL", "--connect-timeout", "15", "--speed-limit", "20480", "--speed-time", "30", ...curlArgs,
            "-r", `${seg[0] + seg[2]}-${seg[1]}`, url], { stdio: ["ignore", "pipe", "pipe"] });
          kids.add(c);
          let e = "", settled = false, queued = seg[2], pending = Promise.resolve();
          const done = (msg) => { if (settled) return; settled = true; kids.delete(c); resolve(msg); };
          c.stdout.on("data", (b) => {
            if (fatal || settled) return;
            const room = seg[1] - seg[0] + 1 - queued;
            const len = Math.min(b.length, room);
            const pos = seg[0] + queued;
            queued += len;
            if (b.length > room) c.kill("SIGKILL");                   // 服务器多给了（不该发生）：够了就停
            if (len <= 0) return;
            c.stdout.pause();
            pending = pending.then(async () => {
              if (fatal || settled) return;
              try {
                let off = 0;
                while (off < len) {
                  const { bytesWritten } = await fh.write(b, off, len - off, pos + off);
                  if (!bytesWritten) throw new Error("short write");
                  off += bytesWritten;
                }
                seg[2] += len;
              } catch (er) {
                // 写盘失败（ENOSPC/EIO）不能冒成未捕获异常把网关带走（#121-2）
                fatal = true;
                e = "写盘失败 " + (er.code || er.message);
                c.kill("SIGKILL");
                done(e);
                return;
              }
              if (!c.stdout.destroyed) c.stdout.resume();
            });
          });
          c.stderr.on("data", (d) => { e += d; });
          // curl 起不来（缺失/不可执行）只发 error：不接就是未处理的 error 事件，整个网关跟着退出（#102 04-006）
          c.on("error", (er) => { fatal = true; pending.finally(() => done("curl " + (er.code || er.message))); });
          c.on("close", (code) => {
            pending.finally(() => {
              if (settled) return;
              if (seg[2] >= seg[1] - seg[0] + 1) return done("");
              done(code === 0 ? "连接提前结束" : (e.trim().split("\n").pop() || "curl " + code).replace(/^curl: \(\d+\) /, ""));
            });
          });
        });
        if (!err) return "";
        if (cancelled() || fatal || attempt >= 2) return err;
        await new Promise((ok) => setTimeout(ok, 2000 * (attempt + 1)));
      }
      return "";
    };
    const errs = await Promise.all(st.segs.map(runSeg));
    clearInterval(tick); await save(); onProgress(doneBytes());
    const bad = errs.find(Boolean);
    if (bad) return bad;
    fs.rmSync(segFile, { force: true });
    return "";
  } finally {
    await saveChain.catch(() => {});
    await fh.close().catch(() => {});
  }
}

// 认不认 Range：要 1 个字节，回 206 才算。
// 必须异步：以前用 spawnSync，网络差时这一下最多卡住整个网关 20 秒（界面没反应、流式输出停住）——写测试时才发现
function rangeOk(curl, url, curlArgs) {
  return new Promise((resolve) => {
    let out = "";
    const c = spawn(curl, ["-sSL", "--connect-timeout", "10", "--max-time", "20", ...curlArgs, "-r", "0-0", "-o", "/dev/null", "-w", "%{http_code}", url], { stdio: ["ignore", "pipe", "ignore"] });
    c.stdout.on("data", (d) => { out += d; });
    c.on("error", () => resolve(false));
    c.on("close", (code) => resolve(code === 0 && out.trim() === "206"));
  });
}

function single({ curl, url, file, total, curlArgs, onProgress, cancelled }) {
  return new Promise((resolve) => {
    const c = spawn(curl, ["-fsSL", "--connect-timeout", "15", "--speed-limit", "20480", "--speed-time", "30", ...curlArgs, "-C", "-", "-o", file, url], { stdio: ["ignore", "ignore", "pipe"] });
    let e = ""; c.stderr.on("data", (d) => { e += d; });
    const size = () => { try { return fs.statSync(file).size; } catch { return 0; } };
    const tick = setInterval(() => { onProgress(size()); if (cancelled()) c.kill("SIGKILL"); }, 1000);
    c.on("error", (er) => { clearInterval(tick); resolve("curl " + (er.code || er.message)); });   // 同上：起不来别带走网关
    c.on("close", (code) => {
      clearInterval(tick); onProgress(size());
      if (code === 0 || (total > 0 && size() === total)) return resolve("");
      resolve((e.trim().split("\n").pop() || "curl " + code).replace(/^curl: \(\d+\) /, ""));
    });
  });
}

export function ghProxyEnabled() {
  if (CFG.runtime) {
    try { return fs.statSync(path.join(CFG.runtime, ".gh-proxy")).isFile(); } catch { return false; }
  }
  return SETTINGS.ghProxy === true;
}

/** GitHub 地址的备用加速线（gh-proxy.com，第三方）：默认关闭；仅用户在设置里开启后才作为最后一条备用；内容照样按 sha256 把关 */
export function ghProxy(url, enabled = ghProxyEnabled()) {
  if (!enabled) return "";
  return /^https:\/\/github\.com\//.test(url || "") ? "https://gh-proxy.com/" + url.slice("https://".length) : "";
}
