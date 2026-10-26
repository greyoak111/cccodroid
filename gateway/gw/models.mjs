import fs from "node:fs";
import { PATHS, log } from "./config.mjs";
import { SETTINGS } from "./settings.mjs";
import { PROVIDER, keyOf, providerBrief, providerById } from "./providers.mjs";
import { NEXT, sendJson } from "./http.mjs";
import { localModels } from "./local.mjs";
import { effectiveModel } from "./sessmodel.mjs";
import { effectiveAutoCompact } from "./stream.mjs";

// ── 模型清单（按厂商拉，10 分钟缓存，失败用该厂商的 fallback）─────────
// MODELS 是全局生效那家的清单（老代码直接读它）；每家各自的缓存在 CACHE（0.3.16 起各会话可以用不同的家）
export let MODELS = null, MODELS_AT = 0, MODELS_FOR = null;
const CACHE = new Map();   // 厂商 id → { list, at }

/** 把不同厂商的 /models 响应归一成同一种形状。
 *  两家形状不同：DeepSeek 用 context_window/max_output_tokens/effort.supported_levels，
 *  官方 /v1/models 用 max_input_tokens/max_tokens/capabilities.*（能力位里带 supported 标记）。 */
export function normalizeModels(j) {
  const raw = Array.isArray(j && j.data) ? j.data
            : Array.isArray(j && j.models) ? j.models : [];
  return raw.filter((m) => m && m.id).map((m) => {
    const caps = m.capabilities || {};
    // 官方形状：effort 档位散在 capabilities.effort 底下，键名就是档位名
    let effort = m.effort || null;
    if (!effort && caps.effort && typeof caps.effort === "object") {
      const lv = ["low", "medium", "high", "xhigh", "max"]
        .filter((k) => caps.effort[k] && caps.effort[k].supported);
      if (lv.length) effort = { supported_levels: lv, default_level: "high" };
    }
    let mods = m.input_modalities;
    if (!mods) {
      const img = caps.image_input && caps.image_input.supported;
      mods = img ? ["text", "image"] : ["text"];
    }
    return {
      id: m.id,
      name: m.name || m.display_name || m.id,
      context_window: m.context_window || m.contextWindow || m.max_input_tokens || 0,
      max_output_tokens: m.max_output_tokens || m.maxOutputTokens || m.max_tokens || 0,
      input_modalities: mods,
      effort,
    };
  });
}

/** 走官方账户登录（且没填密钥）时：凭据只归 claude 自己管。
 *  Anthropic 条款：第三方不得收集、保存或中转 claude.ai 凭据/会话令牌，登录须走官方流程。
 *  所以这种情况下网关既不读 .credentials.json，也不让请求经过本地桥 —— claude 直连官方。 */
export function isLoginMode(p = PROVIDER) { return !!(p && p.login && !keyOf(p)); }

// 登录态拉不了清单（那要用令牌，我们不碰），给一份静态的；厂商配置里写了 fallbackModels 就用那份。
// 别名排前面：claude 自己把它解析成该系列的最新版，最不容易过时。
// 窗口一开始不知道（官方清单要令牌才能拉），跑过一轮后从 result.modelUsage 学到，见 learnWindow。
const LOGIN_MODELS = [
  ["opus", "Opus（最新）"], ["sonnet", "Sonnet（最新）"], ["haiku", "Haiku（最新）"], ["fable", "Fable（最新）"],
  ["claude-opus-5-5", "Opus 5.5"], ["claude-fable-5-1", "Fable 5.1"],
  ["claude-sonnet-5-5", "Sonnet 5.5"], ["claude-sonnet-5", "Sonnet 5"],
  ["claude-haiku-5-5", "Haiku 5.5"], ["claude-haiku-4-5-20251001", "Haiku 4.5"],
].map(([id, name]) => ({ id, name, context_window: 0, max_output_tokens: 0, input_modalities: ["text", "image"] }));

// claude --effort 认的全部档位（claude --help 原文：low, medium, high, xhigh, max）。
// 原生厂商的模型不带档位信息时就用这一套 —— 以前回落成 DeepSeek 的三档，medium/xhigh 凭空消失。
const CLAUDE_EFFORT = ["low", "medium", "high", "xhigh", "max"];
export function effortLevelsOf(model, p = PROVIDER) {
  return (model && model.effort && model.effort.supported_levels) ||
         (p.nativeModels ? CLAUDE_EFFORT : ["low", "high", "max"]);
}

// 从 result.modelUsage 学到的真实窗口（按模型 id 记，落盘）—— 官方账户拿不到 /models，只能这样补
let WINDOWS = {};
try { WINDOWS = JSON.parse(fs.readFileSync(PATHS.windows, "utf8")); } catch {}
export function learnWindow(result, p = PROVIDER) {
  if (!p.nativeModels) return;
  let changed = false;
  for (const [id, u] of Object.entries((result && result.modelUsage) || {})) {
    const w = { context_window: Number(u && u.contextWindow) || 0, max_output_tokens: Number(u && u.maxOutputTokens) || 0 };
    if (!w.context_window) continue;
    // 别名也记一份（opus → claude-opus-5-5 是 init 里看到的），下次列表里别名那项也有窗口
    for (const k of [id, ...Object.keys(ALIAS_SEEN).filter((a) => ALIAS_SEEN[a] === id)]) {
      if (JSON.stringify(WINDOWS[k]) !== JSON.stringify(w)) { WINDOWS[k] = w; changed = true; }
    }
  }
  if (changed) try { fs.writeFileSync(PATHS.windows, JSON.stringify(WINDOWS, null, 2)); } catch {}
}
/** 别名（opus）学不到窗口 —— modelUsage 里记的是全名；别名就借 init 报过的那个全名 */
export const ALIAS_SEEN = {};
export function withWindows(list) {
  return list.map((m) => {
    const w = WINDOWS[m.id];
    return w && !m.context_window ? { ...m, ...w } : m;
  });
}

// ── 目录补全：厂商 /models 只报 id 时，用 models.dev 的公开目录补窗口 ──
// 不少兼容端点（比如 opencode 的 /v1/models）只回 id/created/owned_by，窗口和输出上限都没有，
// 清单里就只剩「—」。models.dev 是公开的模型目录，按 id 能查到上下文档位。
// 只补厂商没报的字段，不覆盖它自己给的值；拉不到就留空，不瞎编。
const CATALOG_URL = "https://models.dev/api.json";
const CATALOG_TTL = 12 * 3600e3, CATALOG_BACKOFF = 30 * 60e3;
let CAT = null, CAT_AT = 0, CAT_TRY = null, CAT_FAIL_AT = 0;

async function loadCatalog() {
  if (CAT && Date.now() - CAT_AT < CATALOG_TTL) return CAT;
  if (CAT_TRY) return CAT_TRY;
  if (Date.now() - CAT_FAIL_AT < CATALOG_BACKOFF) return null;
  CAT_TRY = (async () => {
    try {
      const r = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(9000) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      const byProv = new Map(), votes = new Map();
      for (const [pid, pv] of Object.entries(j || {})) {
        const m = new Map();
        for (const [mid, mv] of Object.entries((pv && pv.models) || {})) {
          const lim = (mv && mv.limit) || {};
          const ctx = Number(lim.context) || 0;
          if (!ctx) continue;
          const v = { context_window: ctx, max_output_tokens: Number(lim.output) || 0 };
          m.set(mid, v);
          // 同一个 id 在多家目录里窗口可能不一样：按出现次数取多数，免得被冷门厂商的旧值带偏
          let vs = votes.get(mid);
          if (!vs) votes.set(mid, vs = new Map());
          const k = v.context_window + "/" + v.max_output_tokens;
          vs.set(k, (vs.get(k) || 0) + 1);
        }
        if (m.size) byProv.set(pid, m);
      }
      const byId = new Map();
      for (const [mid, vs] of votes) {
        let best = "", n = 0;
        for (const [k, c] of vs) if (c > n) { n = c; best = k; }
        const [ctx, out] = best.split("/").map(Number);
        byId.set(mid, { context_window: ctx, max_output_tokens: out });
      }
      CAT = { byProv, byId }; CAT_AT = Date.now(); CAT_FAIL_AT = 0;
      log(`[catalog] models.dev 已载入：${byProv.size} 家 / ${byId.size} 个型号`);
      return CAT;
    } catch (e) {
      CAT_FAIL_AT = Date.now();
      log(`[catalog] 拉 models.dev 失败：${e.message}`);
      return null;
    } finally { CAT_TRY = null; }
  })();
  return CAT_TRY;
}

/** 这家厂商在目录里对应哪几家：先看配置里写死的 catalog，再按 baseUrl 的域名猜
 *  （opencode.ai 的订阅端点在 /go/ 下，目录里分 opencode 和 opencode-go 两份） */
function catalogKeys(p) {
  const keys = [];
  if (p.catalog) keys.push(String(p.catalog));
  let host = "";
  try { host = new URL(p.baseUrl || "").hostname; } catch {}
  const name = (host.split(".")[0] || "").replace(/^api$/, host.split(".")[1] || "");
  if (name) keys.push(name + "-go", name);
  return keys;
}

async function withCatalog(list, p) {
  if (!list.some((m) => !m.context_window)) return list;
  const cat = await loadCatalog();
  if (!cat) return list;
  const maps = catalogKeys(p).map((k) => cat.byProv.get(k)).filter(Boolean);
  return list.map((m) => {
    if (m.context_window) return m;
    let lim = null;
    for (const mp of maps) { lim = mp.get(m.id); if (lim) break; }
    if (!lim) lim = cat.byId.get(m.id);
    if (!lim) return m;
    return { ...m, context_window: lim.context_window, max_output_tokens: m.max_output_tokens || lim.max_output_tokens };
  });
}

// 清空 / 让它过期：别的模块改不了这几个变量（ES 模块的导入是只读的），走这两个函数
export function dropModelCache() { MODELS = null; MODELS_AT = 0; MODELS_FOR = null; CACHE.clear(); }
export function expireModelCache() { MODELS_AT = 0; for (const c of CACHE.values()) c.at = 0; }

/** p：哪家（缺省 = 全局生效的）。按家各缓存 10 分钟；全局那家的结果同时放进 MODELS */
export async function fetchModels(force, p = PROVIDER) {
  const list = await fetchModelsOf(p, force);
  if (p.id === PROVIDER.id) { MODELS = list; MODELS_AT = Date.now(); MODELS_FOR = p.id; }
  return list;
}
async function fetchModelsOf(p, force) {
  const c = CACHE.get(p.id);
  const keep = (list, ttl = true) => { CACHE.set(p.id, { list, at: ttl ? Date.now() : 0 }); return list; };
  if (!force && c && c.at && Date.now() - c.at < 600000) return c.list;

  if (p.local) return keep(localModels(), false);   // 端侧：模型目录里有什么就是什么（每次现扫，刚放进去的文件马上能选）
  if (isLoginMode(p)) return keep((p.fallbackModels && p.fallbackModels.length) ? p.fallbackModels : LOGIN_MODELS);

  const key = keyOf(p);
  if (p.modelsUrl && (key || p.modelsAuth === "none")) {
    try {
      const headers = {};
      if (key) {
        if (p.modelsAuth === "x-api-key") {
          headers["x-api-key"] = key;
          headers["anthropic-version"] = "2023-06-01";
        } else if (p.modelsAuth !== "none") {
          headers.Authorization = `Bearer ${key}`;
        }
      }
      const r = await fetch(p.modelsUrl, { headers, signal: AbortSignal.timeout(15000) });
      if (r.ok) {
        const list = await withCatalog(mergeKnown(normalizeModels(await r.json()), p.fallbackModels), p);
        if (list.length) {
          log(`[${p.id}] 模型清单：${list.map((m) => m.id).join(", ")}`);
          return keep(list);
        }
      }
      log(`[${p.id}] 拉模型清单失败 HTTP ${r.status}`);
    } catch (e) {
      log(`[${p.id}] 拉模型清单出错: ${e.message}`);
    }
  }
  return keep(c && c.list ? c.list
    : (p.fallbackModels || []).map((m) => ({ context_window: 0, max_output_tokens: 0, input_modalities: ["text"], effort: null, ...m })));
}
/** 已缓存的那家清单（不发请求）；没拉过就是目录里写的 */
export function cachedModels(p = PROVIDER) {
  const c = CACHE.get(p.id);
  return withWindows((c && c.list) || (p.id === PROVIDER.id && MODELS) || p.fallbackModels || []);
}

/** 厂商的 /models 多是 OpenAI 形状：不报窗口，还混着向量、语音、画图模型。
 *  去掉明显不能对话的，窗口拿目录里已知的补上（不知道就留 0，不瞎编） */
function mergeKnown(list, known) {
  const byId = new Map((known || []).map((m) => [m.id, m]));
  return list
    .filter((m) => !/embed|rerank|tts|asr|whisper|speech|audio|wanx|cogview|cogvideo|image-|moderation/i.test(m.id))
    .map((m) => {
      const k = byId.get(m.id);
      if (!k) return m;
      return { ...m, name: m.name && m.name !== m.id ? m.name : (k.name || m.id),
        context_window: m.context_window || k.context_window || 0,
        max_output_tokens: m.max_output_tokens || k.max_output_tokens || 0,
        effort: m.effort || k.effort || null };
    });
}

/** claude 的 --effort 档位比 DeepSeek 多，收敛到该模型真正支持的档位。
 *  没设过（want 为空）就保持不设 —— 由模型自己决定，别替用户做主。 */
export function normEffort(model, want, p = PROVIDER) {
  if (!want) return null;
  const ok = effortLevelsOf(model, p);
  if (ok.includes(want)) return want;
  return (model && model.effort && model.effort.default_level) || null;
}

// ── 路由：/api/models ──
export async function routeModels(req, res, u, p) {
  // ── DeepSeek 模型清单 ──
  if (req.method === "GET" && p === "/api/models") {
    // ?sid=：按这个会话记下的接口 / 模型 / 档位回（0.3.16 起每个会话各用各的）；不给就是全局默认
    // ?model= / ?effort= / ?provider=：还没会话号的新会话在面板里先选了（前端暂存，随第一条消息带走），按选的回
    // ?browse=接口：面板里点开别的接口看它的模型（只换清单，current 仍是这个会话的）
    const sid = u.searchParams.get("sid") || "", q = (k) => (u.searchParams.has(k) ? u.searchParams.get(k) : null);
    const now = effectiveModel(sid, q("project"), { provider: q("provider"), model: q("model"), effort: q("effort") });
    const pp = providerById(now.provider) || PROVIDER;
    const bp = (u.searchParams.get("browse") && providerById(u.searchParams.get("browse"))) || pp;
    const ms = withWindows(await fetchModels(u.searchParams.get("refresh") === "1", bp));
    const own = withWindows(bp === pp ? ms : cachedModels(pp));
    const cur = own.find((m) => m.id === now.model) || own.find((m) => m.id === pp.defaultModel) || own[0] || {};
    return sendJson(res, 200, {
      models: ms,
      current: now.model || null,
      // 给前端判"这家用不用得着挑模型"：官方账户不挑就是用它的默认
      provider: pp.id,                       // 这个会话用的那家
      listProvider: bp.id,                   // models 是哪家的
      globalProvider: PROVIDER.id,
      providers: providerBrief(),
      nativeModels: !!bp.nativeModels,
      defaultModel: bp.defaultModel || null,
      effort: now.effortRun || null,          // 真跑时的档位（跟来的档位那家不支持时已换过）
      effortLevels: effortLevelsOf(cur, pp),
      // 原生厂商的默认档位由 claude 按模型定，我们不知道就别瞎报
      effortDefault: (cur.effort && cur.effort.default_level) || (pp.nativeModels ? null : "high"),
      // 真实窗口 —— 前端用量条和门限都按它算，不写死
      contextWindow: Number(cur.context_window) || 0,
      maxOutputTokens: Number(cur.max_output_tokens) || 0,
      autoCompactWindow: effectiveAutoCompact(),
    });
  }
  return NEXT;
}
