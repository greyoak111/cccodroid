import fs from "node:fs";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { CFG, LIVE, HERE, PREFIX, log, tz } from "./config.mjs";
import { SETTINGS, saveSettings } from "./settings-store.mjs";
import { LLAMA_KEY_FILE, LLAMA_PORT } from "./providers.mjs";
import { expireModelCache } from "./models.mjs";
import { ensureShell, killTree } from "./claude.mjs";
import { RUNS } from "./runs.mjs";
import { NEXT, readBody, sendJson } from "./http.mjs";
import { termEnv } from "./terminal.mjs";
import { compIndex, compIndexCache, compRun, sha256File } from "./components.mjs";
import { runEmit } from "./queue.mjs";
import { privCall } from "./usage.mjs";

// ── 端侧小模型：网关按需拉起 llama-server，空闲一阵自动停（模型常驻要占好几 GB 内存） ──
// 模型放 /sdcard/cccodroid/models（和 llama-cpp 组件的 llama-run 同一个目录）或 home/models。
// claude 以 --bare --tools "" 跑：内置只有聊天，提示只有七十 token 左右（完整模式两万 token，手机上光读提示就要好几分钟）。
// 实测 1.5B/3B 都撑不起工具调用（命令写成文字、读目录、选错命令），所以干活不内置；
// 想折腾的用户写 ~/.cccodroid/local-mode.json 开「自定义模式」，配法见随包装进去的 local-model-mode 技能。
const LOCAL_MODEL_DIRS = PREFIX ? ["/sdcard/cccodroid/models", path.join(CFG.home, "models")] : [];
const LLAMA_IDLE_MS = 10 * 60e3;
const LLAMA_LOG = path.join(CFG.home, ".cache", "llama-server.log");
const llamaBin = () => PREFIX ? path.join(PREFIX, "bin", "llama-server") : "";
export const LL = { child: null, file: "", id: "", sig: "", gpu: false, state: "off", since: 0, lastUse: 0, err: "", run: null, loadMs: 0 };
const LOCAL_MODE_FILE = path.join(CFG.home, ".cccodroid", "local-mode.json");

/** 自定义模式的配置：{ have, ok, cfg } 或 { have, ok:false, err }。每次现读，改完下一条消息就生效 */
function localCustom() {
  let raw;
  try { raw = fs.readFileSync(LOCAL_MODE_FILE, "utf8"); } catch { return { have: false, ok: false, path: LOCAL_MODE_FILE }; }
  const bad = (err) => ({ have: true, ok: false, err, path: LOCAL_MODE_FILE });
  let j; try { j = JSON.parse(raw); } catch (e) { return bad("JSON: " + e.message); }
  if (!j || typeof j !== "object" || Array.isArray(j)) return bad(tz("顶层要是一个对象"));
  const str = (v, max) => typeof v === "string" && v.length <= max;
  if (j.label != null && !str(j.label, 40)) return bad(tz("{k} 要是不超过 {n} 字的文本", { k: "label", n: 40 }));
  if (j.tools != null && !str(j.tools, 500)) return bad(tz("{k} 要是不超过 {n} 字的文本", { k: "tools", n: 500 }));
  if (j.systemPrompt != null && !str(j.systemPrompt, 20000)) return bad(tz("{k} 要是不超过 {n} 字的文本", { k: "systemPrompt", n: 20000 }));
  if (j.llamaArgs != null && !(Array.isArray(j.llamaArgs) && j.llamaArgs.length <= 40 && j.llamaArgs.every((x) => str(x, 300))))
    return bad(tz("llamaArgs 要是文本数组（最多 40 项）"));
  if (j.ctx != null && !(Number.isInteger(j.ctx) && j.ctx >= 512 && j.ctx <= 262144)) return bad(tz("ctx 要是 512 到 262144 之间的整数"));
  // 这几个由网关管，用户改了就接不上
  const owned = (j.llamaArgs || []).find((x) => ["-m", "--model", "--host", "--port", "-np", "--parallel"].includes(x));
  if (owned) return bad(tz("llamaArgs 里不能改 {k}（由网关管）", { k: owned }));
  return { have: true, ok: true, path: LOCAL_MODE_FILE,
    cfg: { label: j.label || tz("自定义"), tools: j.tools || "", systemPrompt: j.systemPrompt || "", llamaArgs: j.llamaArgs || [], ctx: j.ctx || 0 } };
}
/** 当前生效的自定义配置；没选自定义、文件不在或写坏了都回落聊天（返回 null） */
export function localCustomActive() {
  if (SETTINGS.localMode !== "custom") return null;
  const c = localCustom();
  return c.ok ? c.cfg : null;
}
let llStarting = null;

export function localModels() {
  const out = [], seen = new Set();
  for (const d of LOCAL_MODEL_DIRS) {
    let list = []; try { list = fs.readdirSync(d); } catch {}
    for (const f of list) {
      // mmproj-*.gguf 是多模态的视觉投影，不是能单独对话的模型
      if (!/\.gguf$/i.test(f) || /^mmproj/i.test(f)) continue;
      const id = f.replace(/\.gguf$/i, "");
      if (seen.has(id)) continue;
      let st; try { st = fs.statSync(path.join(d, f)); } catch { continue; }
      if (!st.isFile() || st.size < 10e6) continue;
      seen.add(id);
      out.push({ id, name: id, file: path.join(d, f), size: st.size, context_window: llamaCtx(), max_output_tokens: 0, input_modalities: ["text"], effort: null });
    }
  }
  return out.sort((a, b) => a.size - b.size);
}
function memTotalKB() { try { return Number((fs.readFileSync("/proc/meminfo", "utf8").match(/MemTotal:\s+(\d+)/) || [])[1]) || 0; } catch { return 0; } }
function memAvailKB() { try { return Number((fs.readFileSync("/proc/meminfo", "utf8").match(/MemAvailable:\s+(\d+)/) || [])[1]) || 0; } catch { return 0; } }
// 上下文按内存给：KV 缓存随上下文线性涨（3B 模型 32k 上下文约 1.2 GB）
function llamaCtx() { const c = localCustomActive(); if (c && c.ctx) return c.ctx; const g = memTotalKB() / 1048576; return g >= 11 ? 32768 : g >= 7 ? 16384 : 8192; }
// 线程数：只用比最慢那档快的核（小核掺进来反而拖慢一倍，llama-run 实测 10.3 vs 25.0 t/s）
function llamaThreads() {
  const f = [];
  for (let i = 0; i < 16; i++) { try { f.push(Number(fs.readFileSync(`/sys/devices/system/cpu/cpu${i}/cpufreq/cpuinfo_max_freq`, "utf8"))); } catch { break; } }
  if (!f.length) return 4;
  const min = Math.min(...f), fast = f.filter((x) => x > min).length;
  return Math.max(2, Math.min(8, fast || f.length));
}
// 有没有真 GPU 驱动：Vulkan 清单里除了 lavapipe（软件实现）还有别的（gpu-driver 组件装的 Turnip）
function llamaGpu() {
  for (const d of [path.join(PREFIX, "share", "vulkan", "icd.d"), path.join(PREFIX, "etc", "vulkan", "icd.d")]) {
    try { if (fs.readdirSync(d).some((f) => f.endsWith(".json") && !/lvp|lavapipe/i.test(f))) return true; } catch {}
  }
  return false;
}
async function llamaHealthy() {
  try { const r = await fetch(`http://127.0.0.1:${LLAMA_PORT}/health`, { signal: AbortSignal.timeout(3000) }); return r.ok; } catch { return false; }
}
function llamaInfo() {
  const cust = localCustom();
  return {
    custom: { have: cust.have, ok: cust.ok, err: cust.err || "", path: cust.path, label: cust.ok ? cust.cfg.label : "",
      tools: cust.ok ? cust.cfg.tools : "", skill: LOCAL_SKILL_FILE },
    can: !!PREFIX, bin: !!PREFIX && fs.existsSync(llamaBin()), gpu: !!PREFIX && llamaGpu(),
    ctx: llamaCtx(), threads: llamaThreads(), memTotal: memTotalKB() * 1024, memAvail: memAvailKB() * 1024,
    dirs: LOCAL_MODEL_DIRS, models: localModels().map(({ id, size, file }) => ({ id, size, file })),
    mode: SETTINGS.localMode === "custom" ? "custom" : "chat",
    server: { state: LL.state, model: LL.id, since: LL.since, lastUse: LL.lastUse, err: LL.err, loadMs: LL.loadMs, idleMs: LLAMA_IDLE_MS },
  };
}

/** 确保 llama-server 跑着、载的是要的模型。note(key, text) 往当前这一轮里报进度 */
export async function ensureLlama(want, note) {
  const list = localModels();
  const m = list.find((x) => x.id === want) || list[0];
  if (!m) throw new Error(tz("还没有端侧模型：把 .gguf 文件放进 {dir}", { dir: LOCAL_MODEL_DIRS[0] }));
  if (!fs.existsSync(llamaBin())) throw new Error(tz("没装 llama.cpp：到「扩展」页装 llama-cpp 组件"));
  LL.lastUse = Date.now();
  const sig = llamaPlan(m).sig;
  if (LL.child && LL.sig === sig && LL.state === "ready" && await llamaHealthy()) return m;
  if (llStarting && LL.sig === sig) { await llStarting; return m; }
  if (llStarting) { try { await llStarting; } catch {} }
  if (LL.child) llamaStop("换模型或参数");
  llStarting = llamaStart(m, note).finally(() => { llStarting = null; });
  await llStarting;
  return m;
}
/** 这次该用什么参数起服务。sig 不同（换模型、换模式、GPU 回退）就得重启 */
function llamaPlan(m) {
  const gpu = llamaGpu(), ctx = llamaCtx();
  const cust = localCustomActive();
  // -np 1：只开一个槽，KV 缓存不被四等分（默认 4 槽，每槽只剩四分之一上下文）；
  // --cache-reuse：同一段提示前缀第二轮起直接复用，不再从头读。自定义参数放最后，同名参数以它为准
  const args = ["-m", m.file, "--host", "127.0.0.1", "--port", String(LLAMA_PORT), "-c", String(ctx), "-np", "1",
    "-t", String(llamaThreads()), "--jinja", "--cache-reuse", "256", "--no-webui", "--api-key-file", LLAMA_KEY_FILE,
    ...(gpu ? ["-ngl", "99"] : ["-dev", "none"]), ...(cust ? cust.llamaArgs : [])];
  return { gpu, ctx, args, sig: JSON.stringify(args) };
}
function llamaStart(m, note) {
  return new Promise((resolve, reject) => {
    const { gpu, ctx, args, sig } = llamaPlan(m);
    fs.mkdirSync(path.dirname(LLAMA_LOG), { recursive: true });
    const logFd = fs.openSync(LLAMA_LOG, "w");
    const argv = [ensureShell(), "-c", 'exec "$0" "$@"', llamaBin(), ...args];
    log(`[local] 启动 llama-server：${m.id}（${gpu ? "GPU" : "CPU"}，上下文 ${ctx}）`);
    note && note("load", tz("正在加载端侧模型 {name}（{how}）…", { name: m.id, how: gpu ? "GPU" : "CPU" }));
    const c = spawn(argv[0], argv.slice(1), { env: termEnv(), cwd: CFG.home, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    Object.assign(LL, { child: c, file: m.file, id: m.id, sig, gpu, state: "loading", since: Date.now(), err: "", loadMs: 0 });
    let tail = "", lastNote = 0;
    const eat = (d) => {
      try { fs.writeSync(logFd, d); } catch {}
      tail = (tail + d).slice(-6000);
      // 读提示的进度（llama-server 每读一批打一行 progress = 0.41）报给当前这一轮：首字前别让人干等
      const s = String(d), mm = s.match(/prompt processing, n_tokens =\s*(\d+), progress = ([\d.]+)/g);
      if (mm && LL.run && !LL.run.ended && Date.now() - lastNote > 1500) {
        const last = mm[mm.length - 1].match(/n_tokens =\s*(\d+), progress = ([\d.]+)/);
        const pct = Math.round(Number(last[2]) * 100);
        lastNote = Date.now();
        runEmit(LL.run, { type: "note", key: "prefill", text: tz("端侧模型正在读提示：{pct}%", { pct }) });
      }
    };
    c.stdout.on("data", eat); c.stderr.on("data", eat);
    let done = false;
    const fail = (msg) => { if (done) return; done = true; LL.state = "error"; LL.err = msg; reject(new Error(msg)); };
    c.on("error", (e) => fail(e.message));
    c.on("close", (code) => {
      try { fs.closeSync(logFd); } catch {}
      const ours = LL.child === c, wasReady = LL.state === "ready";     // ours：不是网关自己停的（llamaStop 会先把 child 清掉）
      if (ours) Object.assign(LL, { child: null, state: LL.state === "error" ? "error" : "off" });
      log(`[local] llama-server 退出 rc=${code}`);
      // 跑着跑着崩了（大模型在 GPU 上可能 vk::DeviceLostError）：只报出来，不替用户改走 CPU —— 想换用 llamaArgs 自己配
      if (ours && wasReady) {
        const why = tail.split("\n").filter((l) => /error|failed|DeviceLost|out of memory/i.test(l)).pop() || "";
        Object.assign(LL, { state: "error", err: tz("llama-server 意外退出（rc={code}）", { code }) + (why ? "：" + why.trim().slice(0, 200) : "") });
        if (LL.run && !LL.run.ended) runEmit(LL.run, { type: "note", key: "crash", text: LL.err });
      }
      // 加载中被网关自己停掉（停服务、换模型）：不是「没起来」，别把状态改成出错（审查 v0.5.3 B8）
      if (!ours) { if (!done) { done = true; reject(new Error(tz("已停止"))); } return; }
      const why = tail.split("\n").filter((l) => /error|failed|out of memory|unable/i.test(l)).pop() || "";
      fail(tz("端侧模型没起来") + (why ? "：" + why.trim().slice(0, 200) : `（rc=${code}）`));
    });
    const t0 = Date.now();
    (async () => {
      while (!done && Date.now() - t0 < 240e3) {
        await new Promise((r) => setTimeout(r, 500));
        if (done) return;
        if (await llamaHealthy()) {
          done = true;
          Object.assign(LL, { state: "ready", loadMs: Date.now() - t0, lastUse: Date.now() });
          log(`[local] 模型已加载 ${m.id}（${Math.round(LL.loadMs / 100) / 10}s）`);
          note && note("load", tz("端侧模型已加载（{s} 秒）", { s: Math.round(LL.loadMs / 100) / 10 }));
          return resolve();
        }
      }
      if (!done) { try { killTree(c); } catch {} fail(tz("端侧模型加载超时")); }
    })();
  });
}
function llamaStop(why) {
  const c = LL.child;
  if (!c) return;
  log(`[local] 停 llama-server（${why}）`);
  Object.assign(LL, { child: null, state: "off", run: null });
  try { killTree(c); } catch {}
}
// 空闲自动停：没有在跑的会话、十分钟没用过，就把模型卸掉还内存
if (PREFIX) setInterval(() => {
  if (!LL.child) return;
  if (RUNS.size) { LL.lastUse = Date.now(); return; }
  if (Date.now() - LL.lastUse > LLAMA_IDLE_MS) llamaStop("空闲");
}, 60e3).unref?.();

// ── 端侧模型下载：内置目录（llama.cpp 能跑的主流开源模型，Q4_K_M 量化，sha256 取自 HuggingFace LFS 记录），curl 断点续传 ──
// 源：ms=1 的（Qwen 官方仓库）先走魔搭；都会试 HuggingFace 和 hf-mirror.com。超过 6B 的下载前提醒一句，不拦。
// 目录外的模型：贴 .gguf 直链下载（不知道哈希，只核对 GGUF 文件头）。
// tag：think = 会先输出思考过程；code = 偏写代码
const LOCAL_CATALOG = [
  { fam: "Qwen3", params: 0.6, repo: "bartowski/Qwen_Qwen3-0.6B-GGUF", file: "Qwen_Qwen3-0.6B-Q4_K_M.gguf", bytes: 484220320,
    sha256: "9acfc1e001311f34b4252001b626f2e466d592a42065f66571bff3790d4e1b14", tag: "think" },
  { fam: "Qwen3", params: 1.7, repo: "bartowski/Qwen_Qwen3-1.7B-GGUF", file: "Qwen_Qwen3-1.7B-Q4_K_M.gguf", bytes: 1282439584,
    sha256: "72c5c3cb38fa32d5256e2fe30d03e7a64c6c79e668ad84057e3bd66e250b24fb", tag: "think" },
  { fam: "Qwen3", params: 4, repo: "Qwen/Qwen3-4B-GGUF", file: "Qwen3-4B-Q4_K_M.gguf", bytes: 2497280256,
    sha256: "7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5", tag: "think", ms: 1 },
  { fam: "Qwen3", params: 8.2, repo: "Qwen/Qwen3-8B-GGUF", file: "Qwen3-8B-Q4_K_M.gguf", bytes: 5027783488,
    sha256: "d98cdcbd03e17ce47681435b5150e34c1417f50b5c0019dd560e4882c5745785", tag: "think", ms: 1 },
  { fam: "Qwen3", params: 14.8, repo: "Qwen/Qwen3-14B-GGUF", file: "Qwen3-14B-Q4_K_M.gguf", bytes: 9001752960,
    sha256: "500a8806e85ee9c83f3ae08420295592451379b4f8cf2d0f41c15dffeb6b81f0", tag: "think", ms: 1 },
  { fam: "Qwen2.5", params: 0.5, repo: "Qwen/Qwen2.5-0.5B-Instruct-GGUF", file: "qwen2.5-0.5b-instruct-q4_k_m.gguf", bytes: 491400032,
    sha256: "74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db", ms: 1 },
  { fam: "Qwen2.5", params: 1.5, repo: "Qwen/Qwen2.5-1.5B-Instruct-GGUF", file: "qwen2.5-1.5b-instruct-q4_k_m.gguf", bytes: 1117320736,
    sha256: "6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e", ms: 1 },
  { fam: "Qwen2.5", params: 3.1, repo: "Qwen/Qwen2.5-3B-Instruct-GGUF", file: "qwen2.5-3b-instruct-q4_k_m.gguf", bytes: 2104932768,
    sha256: "626b4a6678b86442240e33df819e00132d3ba7dddfe1cdc4fbb18e0a9615c62d", ms: 1 },
  { fam: "Qwen2.5", params: 7.6, repo: "bartowski/Qwen2.5-7B-Instruct-GGUF", file: "Qwen2.5-7B-Instruct-Q4_K_M.gguf", bytes: 4683074240,
    sha256: "65b8fcd92af6b4fefa935c625d1ac27ea29dcb6ee14589c55a8f115ceaaa1423" },
  { fam: "Qwen2.5", params: 14.8, repo: "bartowski/Qwen2.5-14B-Instruct-GGUF", file: "Qwen2.5-14B-Instruct-Q4_K_M.gguf", bytes: 8988110976,
    sha256: "e47ad95dad6ff848b431053b375adb5d39321290ea2c638682577dafca87c008" },
  { fam: "Qwen2.5 Coder", params: 1.5, repo: "bartowski/Qwen2.5-Coder-1.5B-Instruct-GGUF", file: "Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf", bytes: 986048800,
    sha256: "f530705d447660a4336c329981af164b471b60b974b1d808d57e8ec9fe23b239", tag: "code" },
  { fam: "Qwen2.5 Coder", params: 7.6, repo: "bartowski/Qwen2.5-Coder-7B-Instruct-GGUF", file: "Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf", bytes: 4683074336,
    sha256: "1664fccab734674a50763490a8c6931b70e3f2f8ec10031b54806d30e5f956b6", tag: "code" },
  { fam: "DeepSeek-R1 Distill", params: 1.8, repo: "bartowski/DeepSeek-R1-Distill-Qwen-1.5B-GGUF", file: "DeepSeek-R1-Distill-Qwen-1.5B-Q4_K_M.gguf", bytes: 1117320800,
    sha256: "1741e5b2d062b07acf048bf0d2c514dadf2a48f94e2b4aa0cfe069af3838ee2f", tag: "think" },
  { fam: "DeepSeek-R1 Distill", params: 7.6, repo: "bartowski/DeepSeek-R1-Distill-Qwen-7B-GGUF", file: "DeepSeek-R1-Distill-Qwen-7B-Q4_K_M.gguf", bytes: 4683073504,
    sha256: "731ece8d06dc7eda6f6572997feb9ee1258db0784827e642909d9b565641937b", tag: "think" },
  { fam: "Llama 3", params: 1.2, repo: "bartowski/Llama-3.2-1B-Instruct-GGUF", file: "Llama-3.2-1B-Instruct-Q4_K_M.gguf", bytes: 807694464,
    sha256: "6f85a640a97cf2bf5b8e764087b1e83da0fdb51d7c9fab7d0fece9385611df83" },
  { fam: "Llama 3", params: 3.2, repo: "bartowski/Llama-3.2-3B-Instruct-GGUF", file: "Llama-3.2-3B-Instruct-Q4_K_M.gguf", bytes: 2019377696,
    sha256: "6c1a2b41161032677be168d354123594c0e6e67d2b9227c84f296ad037c728ff" },
  { fam: "Llama 3", params: 8, repo: "bartowski/Meta-Llama-3.1-8B-Instruct-GGUF", file: "Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf", bytes: 4920739232,
    sha256: "7b064f5842bf9532c91456deda288a1b672397a54fa729aa665952863033557c" },
  { fam: "Gemma 3", params: 1, repo: "bartowski/google_gemma-3-1b-it-GGUF", file: "google_gemma-3-1b-it-Q4_K_M.gguf", bytes: 806058496,
    sha256: "12bf0fff8815d5f73a3c9b586bd8fee8e7b248c935de70dec367679873d0f29d" },
  { fam: "Gemma 3", params: 4, repo: "bartowski/google_gemma-3-4b-it-GGUF", file: "google_gemma-3-4b-it-Q4_K_M.gguf", bytes: 2489758112,
    sha256: "4996030242583a40aa151ff93f49ed787ac8c25e4120c3ae4588b2e2a7d1ae94" },
  { fam: "Gemma 3", params: 12, repo: "bartowski/google_gemma-3-12b-it-GGUF", file: "google_gemma-3-12b-it-Q4_K_M.gguf", bytes: 7300575264,
    sha256: "fc57f67efa46d711c346e587cbef7d049e95f3df8db2eb2271153343ef0acc7b" },
  { fam: "Phi-4", params: 3.8, repo: "bartowski/microsoft_Phi-4-mini-instruct-GGUF", file: "microsoft_Phi-4-mini-instruct-Q4_K_M.gguf", bytes: 2491874688,
    sha256: "01999f17c39cc3074afae5e9c539bc82d45f2dd7faa3917c66cbef76fce8c0c2" },
  { fam: "Phi-4", params: 14.7, repo: "bartowski/phi-4-GGUF", file: "phi-4-Q4_K_M.gguf", bytes: 9053114816,
    sha256: "009aba717c09d4a35890c7d35eb59d54e1dba884c7c526e7197d9c13ab5911d9" },
  { fam: "Mistral", params: 7.2, repo: "bartowski/Mistral-7B-Instruct-v0.3-GGUF", file: "Mistral-7B-Instruct-v0.3-Q4_K_M.gguf", bytes: 4372812000,
    sha256: "1270d22c0fbb3d092fb725d4d96c457b7b687a5f5a715abe1e818da303e562b6" },
  { fam: "GLM-4", params: 9.4, repo: "bartowski/THUDM_GLM-4-9B-0414-GGUF", file: "THUDM_GLM-4-9B-0414-Q4_K_M.gguf", bytes: 6166574464,
    sha256: "2b95f0b88eca423bfb874c4f8e7b9574ec76acab2befd272076e8a8dce31216a" },
  { fam: "Granite", params: 2.5, repo: "bartowski/ibm-granite_granite-3.3-2b-instruct-GGUF", file: "ibm-granite_granite-3.3-2b-instruct-Q4_K_M.gguf", bytes: 1545303616,
    sha256: "555b91485955bc96eb445b57dd4bbf8809aa7d8cce7c313f4f8bc5b2340896b4" },
  { fam: "SmolLM2", params: 1.7, repo: "bartowski/SmolLM2-1.7B-Instruct-GGUF", file: "SmolLM2-1.7B-Instruct-Q4_K_M.gguf", bytes: 1055609824,
    sha256: "77665ea4815999596525c636fbeb56ba8b080b46ae85efef4f0d986a139834d7" },
].map((e) => ({ ...e, id: e.file.replace(/\.gguf$/i, "") }));
// 模型目录：优先用组件签名索引里 llama-cpp 带的 models（组件市场 recipes/llama-cpp/models.json，改目录不用发 App）；
// 索引没取到、没这个字段或有一条不合格，就用上面内置的这份。repo / file 拿来拼下载地址，规则和市场的 tools/lib.mjs 一致
const MODEL_OK = (m) => m && typeof m === "object" && typeof m.fam === "string" && /^[\w .+-]{1,40}$/.test(m.fam) &&
  typeof m.params === "number" && m.params > 0 && m.params < 1000 &&
  typeof m.repo === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(m.repo) &&
  typeof m.file === "string" && /^[A-Za-z0-9_.-]+\.gguf$/i.test(m.file) &&
  Number.isInteger(m.bytes) && m.bytes > 0 && typeof m.sha256 === "string" && /^[0-9a-f]{64}$/.test(m.sha256) &&
  (m.tag === undefined || m.tag === "think" || m.tag === "code") && (m.ms === undefined || m.ms === 1);
function modelCatalog() {
  const list = compIndexCache.data && compIndexCache.data.components["llama-cpp"] && compIndexCache.data.components["llama-cpp"].models;
  if (Array.isArray(list) && list.length && list.length <= 100 && list.every(MODEL_OK))
    return list.map((m) => ({ fam: m.fam, params: m.params, repo: m.repo, file: m.file, bytes: m.bytes, sha256: m.sha256, tag: m.tag, ms: m.ms, id: m.file.replace(/\.gguf$/i, "") }));
  return LOCAL_CATALOG;
}
const modelUrls = (e) => [
  ...(e.ms ? [`https://modelscope.cn/models/${e.repo}/resolve/master/${e.file}`] : []),
  `https://huggingface.co/${e.repo}/resolve/main/${e.file}`,
  `https://hf-mirror.com/${e.repo}/resolve/main/${e.file}`,
];
const MDL = new Map();     // id → { phase: downloading|verifying|error, done, total, err, cancelled, child }

/** 模型下到哪：优先共享目录（和 llama-run 一处），写不进就放 home/models */
function modelDir() {
  for (const d of LOCAL_MODEL_DIRS) {
    try { fs.mkdirSync(d, { recursive: true }); fs.accessSync(d, fs.constants.W_OK); return d; } catch {}
  }
  throw new Error(tz("模型目录写不进去"));
}
function localCatalog() {
  const have = new Map(localModels().map((m) => [m.id, m]));
  const inUse = (h) => !!(h && LL.child && LL.file === h.file);
  const jobView = (j) => j ? { phase: j.phase, done: j.done, total: j.total, err: j.err || "" } : null;
  const items = modelCatalog().map((e) => {
    const h = have.get(e.id);
    return { id: e.id, fam: e.fam, params: e.params, tag: e.tag || "", bytes: e.bytes, repo: e.repo,
      have: !!h, inUse: inUse(h), job: jobView(MDL.get(e.id)) };
  });
  // 贴链接下载的：进行中 / 失败的任务也列出来
  for (const [id, j] of MDL) if (j.url) items.push({ id, fam: "", params: 0, tag: "", bytes: j.total, repo: j.url, custom: true, have: false, inUse: false, job: jobView(j) });
  return { ram: Math.round(memTotalKB() / 104857.6) / 10, big: 6, items };
}
/** 下载一个模型。e：{ id, file, bytes?, sha256?, url? }；没有 sha256 的只核对 GGUF 文件头 */
function modelFetch(e, urls) {
  const cur = MDL.get(e.id);
  if (cur && cur.phase !== "error") return;
  const dir = modelDir(), dst = path.join(dir, e.id + ".gguf"), part = dst + ".part";
  if (fs.existsSync(dst)) throw new Error(tz("已经有同名模型了"));
  const job = { phase: "downloading", done: 0, total: e.bytes || 0, err: "", cancelled: false, child: null, url: e.url || "" };
  MDL.set(e.id, job);
  // 半截文件只按文件名对上不够：同名换了链接（内容不同）还续传，就成了前半 A、后半 B 的拼接，GGUF 头照样过（审查 B25）。
  // 旁边记一笔来源（目录里的按 sha256，没有就按链接），对不上先删掉半截从头下
  const meta = part + ".src", src = e.sha256 ? "sha256:" + e.sha256 : "url:" + (e.url || urls[0] || "");
  let had = ""; try { had = fs.readFileSync(meta, "utf8"); } catch {}
  if (had !== src) { try { fs.rmSync(part, { force: true }); } catch {} }
  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(meta, src); } catch {}
  // 贴链接下的没有目录里的大小可核：剩余空间低于 1 GB 就停，别把存储灌满（审查 10-30 第九份 后端低5）
  const tick = setInterval(() => {
    if (job.phase !== "downloading") return;
    try { job.done = fs.statSync(part).size; } catch {}
    try { const st = fs.statfsSync(dir); if (st.bavail * st.bsize < (1 << 30) && !job.cancelled) { job.cancelled = job.lowSpace = true; if (job.child) killTree(job.child); } } catch {}
  }, 500);
  (async () => {
    try {
      let lastErr = null;
      for (const url of urls) {
        for (let i = 0; i < 3 && !job.cancelled; i++) {
          try {
            // 跳转也只许 https：用户贴的链接可能跳到 http 或内网地址（v0514 审查低-6）
            await compRun(job, path.join(PREFIX, "bin", "curl"), ["-fL", "--proto", "=https", "--proto-redir", "=https", "-sS", "-C", "-", "--retry", "3", "--speed-limit", "20000", "--speed-time", "60", "-o", part, url]);
            lastErr = null; break;
          } catch (er) { lastErr = er; }
          // 下全了没改名（续传回 416）：直接去校验
          let n = 0; try { n = fs.statSync(part).size; } catch {}
          if (e.bytes && n === e.bytes) { lastErr = null; break; }
          if (/ 22：|404|403|401/.test(lastErr.message)) break;    // 这个源没有这个文件：别重试，换源
        }
        if (!lastErr || job.cancelled) break;
        log(`[local] 模型下载换源：${lastErr.message}`);
      }
      if (job.cancelled) throw new Error("cancelled");
      if (lastErr) throw lastErr;
      job.phase = "verifying"; job.done = 0;
      if (e.sha256) {
        if ((await sha256File(part, job)) !== e.sha256) { fs.rmSync(part, { force: true }); throw new Error(tz("下载的文件校验不符（已删除，重试会重新下载）")); }
      } else {
        const fd = fs.openSync(part, "r"), head = Buffer.alloc(4);
        try { fs.readSync(fd, head, 0, 4, 0); } finally { fs.closeSync(fd); }
        if (head.toString("latin1") !== "GGUF") { fs.rmSync(part, { force: true }); throw new Error(tz("下下来的不是 GGUF 模型文件（已删除）")); }
      }
      fs.renameSync(part, dst);
      try { fs.rmSync(meta, { force: true }); } catch {}
      MDL.delete(e.id);
      expireModelCache();
      log(`[local] 模型已下载 ${e.id}`);
    } catch (er) {
      if (job.lowSpace) { try { fs.rmSync(part, { force: true }); } catch {} er = new Error(tz("存储空间不够了")); job.cancelled = false; }
      else if (job.cancelled) { MDL.delete(e.id); try { fs.rmSync(part, { force: true }); fs.rmSync(meta, { force: true }); } catch {} return; }
      Object.assign(job, { phase: "error", err: er.message });
      log(`[local] 模型下载失败 ${e.id}：${er.message}`);
    } finally { clearInterval(tick); }
  })();
}
function modelDownload(id) {
  const e = modelCatalog().find((x) => x.id === id);
  if (e) return modelFetch(e, modelUrls(e));
  const j = MDL.get(id);
  if (j && j.url) return modelFetch({ id, url: j.url }, [j.url]);     // 贴链接下载的重试
  throw new Error(tz("目录里没有这个模型"));
}
/** 贴 .gguf 直链下载：只认 https，文件名只留安全字符 */
function modelFromUrl(raw) {
  let u; try { u = new URL(String(raw).trim()); } catch { throw new Error(tz("链接不对")); }
  if (u.protocol !== "https:") throw new Error(tz("只支持 https 链接"));
  // HuggingFace 的 blob 页面换成真正的下载地址
  if (/(^|\.)(huggingface\.co|hf-mirror\.com)$/.test(u.hostname)) u.pathname = u.pathname.replace("/blob/", "/resolve/");
  let name; try { name = decodeURIComponent(u.pathname.split("/").pop() || ""); } catch { throw new Error(tz("链接不对")); }
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,150}\.gguf$/i.test(name)) throw new Error(tz("链接要指向一个 .gguf 文件"));
  if (/-\d{5}-of-\d{5}\.gguf$/i.test(name)) throw new Error(tz("分卷模型（…-00001-of-0000N.gguf）不支持，请找单文件版本"));
  if (/^mmproj/i.test(name)) throw new Error(tz("mmproj 是多模态投影文件，不能单独对话"));
  const id = name.replace(/\.gguf$/i, "");
  // 同名还在下（或刚取消、curl 没退干净）就拒绝：两个 curl 会续写同一个 .part（审查 中4）。失败的才清掉重来
  const cur = MDL.get(id);
  if (cur && cur.phase !== "error") throw new Error(tz("同名模型正在下载"));
  MDL.delete(id);
  return modelFetch({ id, url: u.href }, [u.href]);
}
function modelCancel(id) {
  const j = MDL.get(id);
  if (!j) return;
  if (j.phase === "error") return MDL.delete(id);
  j.cancelled = true;
  if (j.child) { try { killTree(j.child); } catch {} }
}
/** 删模型：只删模型目录里的 .gguf；正在用就先卸载 */
function modelRemove(id) {
  const m = localModels().find((x) => x.id === id);
  if (!m) throw new Error(tz("没有这个模型"));
  if (!LOCAL_MODEL_DIRS.includes(path.dirname(m.file))) throw new Error(tz("不在模型目录里"));
  if (LL.child && LL.file === m.file) llamaStop("删除模型");
  fs.rmSync(m.file, { force: true });
  expireModelCache();
}

// 配自定义模式的技能：随包带着，启动时装进 ~/.claude/skills（云端 Claude 读它帮用户配）。
// 装过的文件里还留着托管标记才覆盖更新；用户删了标记就当是他自己的版本，不动
const LOCAL_SKILL_FILE = path.join(CFG.home, ".claude", "skills", "local-model-mode", "SKILL.md");
function installLocalSkill() {
  try {
    const src = fs.readFileSync(path.join(HERE, "web", "skills", "local-model-mode", "SKILL.md"), "utf8");
    let cur = null; try { cur = fs.readFileSync(LOCAL_SKILL_FILE, "utf8"); } catch {}
    if (cur === src || (cur != null && !cur.includes("cccodroid:managed"))) return;
    fs.mkdirSync(path.dirname(LOCAL_SKILL_FILE), { recursive: true });
    fs.writeFileSync(LOCAL_SKILL_FILE, src);
    log("[local] 已装 local-model-mode 技能");
  } catch (e) { log(`[local] 技能没装上：${e.message}`); }
}
if (PREFIX && LIVE) installLocalSkill();

/** 把应用界面叫回前台。cccodroid 由 App 进程做（Shizuku 或通知）；开发端直接 priv am start */
export function toFront(text) {
  if (PREFIX) return privCall({ op: "to_front", text }, 8000);
  return new Promise((ok) => execFile("priv", ["am start --activity-reorder-to-front -n li.dsh.claudecli/.MainActivity"],
    { timeout: 8000, env: process.env }, (e) => ok(e ? { message: e.message.slice(0, 120) } : { via: "priv" })));
}

// ── 路由：/api/local /api/local /api/freeze /api/local/catalog /api/local/model ──
export async function routeLocal(req, res, u, p) {
  // ── 端侧小模型：状态 / 切模式 / 停服务 ──
  if (req.method === "GET" && p === "/api/local") return sendJson(res, 200, llamaInfo());
  if (req.method === "POST" && p === "/api/local") {
    const b = JSON.parse((await readBody(req)) || "{}");
    if (b.mode === "chat" || b.mode === "custom") { SETTINGS.localMode = b.mode; saveSettings(); }
    if (b.stop) llamaStop("用户停止");
    return sendJson(res, 200, llamaInfo());
  }
  // 前端滚动冻结脱困前报一声：写进网关日志，事后对时间线（前端自己只在 localStorage 留最近 5 次）
  if (req.method === "POST" && p === "/api/freeze") {
    let j = {};
    try { j = JSON.parse(await readBody(req)); } catch {}
    // 去掉换行：不能借它在日志里伪造一行（v0514 审查低-8）
    const touch = Array.isArray(j.touch) ? j.touch.slice(-40).map((x) => String(x).replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 80)).join(" | ") : "";
    log(`滚动冻结脱困（${j.why === "auto" ? "自动" : "手动"}）${touch ? "，触摸：" + touch : ""}`);
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === "GET" && p === "/api/local/catalog") {
    if (PREFIX) await compIndex(false).catch(() => {});   // 目录在组件索引里（有缓存）
    return sendJson(res, 200, PREFIX ? localCatalog() : { ram: 0, items: [] });
  }
  if (req.method === "POST" && p === "/api/local/model") {
    if (!PREFIX) return sendJson(res, 400, { ok: false, message: "unsupported" });
    const b = JSON.parse((await readBody(req)) || "{}");
    try {
      if (b.op === "download") modelDownload(String(b.id || ""));
      else if (b.op === "url") modelFromUrl(b.url || "");
      else if (b.op === "cancel") modelCancel(String(b.id || ""));
      else if (b.op === "remove") modelRemove(String(b.id || ""));
      else throw new Error("bad op");
      return sendJson(res, 200, { ok: true, ...localCatalog() });
    } catch (e) { return sendJson(res, 200, { ok: false, message: e.message }); }
  }
  return NEXT;
}
