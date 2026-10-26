import fs from "node:fs";
import path from "node:path";
import { CFG, PATHS, PREFIX, log, tz } from "./config.mjs";
import { SETTINGS, saveSettings } from "./settings.mjs";
import { dropModelCache, normalizeModels } from "./models.mjs";
import { RUNS } from "./runs.mjs";
import { NEXT, readBody, sendJson } from "./http.mjs";

// ── 厂商配置（不写死任何一家）─────────────────────────────────────────
// 端点 / 认证风格 / 模型清单来源 全部来自 ccapp-providers.json。
// 只要对端讲 Anthropic Messages 协议，就能在配置里加一条即可切换。
const PROVIDERS_FILE = path.join(CFG.home, "ccapp-providers.json");
export const SEED_FILE = process.env.CCAPP_SEED || "/sdcard/DeepSeekHarness/claude-apk/config.json";

// 配置文件缺失时的最小兜底：等价于历史行为（DeepSeek）
export const BUILTIN_PROVIDER = {
  id: "deepseek",
  label: "DeepSeek",
  baseUrl: "https://api.deepseek.com/anthropic",
  modelsUrl: "https://api.deepseek.com/models",
  modelsAuth: "bearer",      // 拉清单时的认证风格: bearer | x-api-key | none
  authStyle: "bearer",       // 给 claude 的变量: bearer→AUTH_TOKEN, x-api-key→API_KEY
  apiKey: "",
  nativeModels: false,       // true = claude 原生认识的厂商，不覆盖模型
  defaultModel: "deepseek-flash",
  fallbackModels: [],
};

// ── 内置厂商目录 ──────────────────────────────────────────────────────
// 都是各家**官方文档**给 Claude Code 用的 Anthropic 兼容端点（2026-10 逐个核对，并实测路由存在）：
//   DeepSeek  api-docs.deepseek.com/guides/agent_integrations/claude_code
//   智谱 GLM   docs.bigmodel.cn/cn/guide/develop/claude
//   通义千问   help.aliyun.com/zh/model-studio/claude-code
//   Kimi      platform.kimi.com/docs/guide/agent-support
//   2026-10-26 补齐（官方文档 + 不带密钥探测 /v1/messages 回 401、对照路径 404）：
//   MiniMax   platform.minimaxi.com/docs/m-plan/claude-code.md（国内已换 api.minimax.cn）
//   火山方舟   docs.volcengine.com/docs/ark/coding-plan-personal-ai-claude-code（只有 Coding Plan 有 Anthropic 端点）
//   小米 MiMo  mimo.mi.com/docs/zh-CN/tokenplan/integration/claudecode
//   阶跃星辰   platform.stepfun.com/docs/zh/step-plan/integrations/claude-code.md
//   百度千帆   cloud.baidu.com/doc/qianfan-docs/s/6mh3e6gjp、cloud.baidu.com/doc/qianfan/s/Dmrabu8b6
//   腾讯混元   cloud.tencent.com/document/product/1823/130070（混元原平台迁到 TokenHub，按量地址不带 /anthropic）
//   美团 LongCat longcat.chat/platform/docs/zh/ClaudeCode.html
//   xAI Grok  docs.x.ai/openapi.json（POST /v1/messages "compatible with the Anthropic API"）
//   Meta Muse dev.meta.ai/docs/coding-agents
// 名字规矩：界面不是中文时显示 labelEn，所以厂商、线路都给英文名；模型显示名一律英文。
// claude 直连这些端点（ANTHROPIC_BASE_URL + 密钥变量），不需要协议转换。
// 配置文件只存用户自己的东西（密钥、选的线路、改过的默认模型）；目录本身随版本更新。
const PRESETS = {
  anthropic: {
    label: "Claude 账户登录", labelEn: "Claude account sign-in", group: "claude", login: true, nativeModels: true,
    baseUrl: "https://api.anthropic.com", authStyle: "x-api-key", defaultModel: null,
    hint: "用 Claude 订阅账户（Pro / Max / Team）。登录由 Claude Code 自己完成，网关不碰凭据。",
    hintEn: "Use a Claude subscription (Pro / Max / Team). Claude Code signs in by itself; the gateway never touches your credentials.",
  },
  "anthropic-key": {
    label: "Claude API Key", group: "claude", nativeModels: true,
    baseUrl: "https://api.anthropic.com", authStyle: "x-api-key",
    modelsUrl: "https://api.anthropic.com/v1/models", modelsAuth: "x-api-key", defaultModel: null,
    keyUrl: "https://platform.claude.com/settings/keys",
    hint: "Claude 开发者平台的 API Key，按量计费。",
    hintEn: "An API key from the Claude Developer Platform, billed per use.",
  },
  deepseek: {
    label: "DeepSeek", group: "third", authStyle: "bearer", modelsAuth: "bearer",
    baseUrl: "https://api.deepseek.com/anthropic", modelsUrl: "https://api.deepseek.com/models",
    defaultModel: "deepseek-flash", fastModel: "deepseek-flash",
    keyUrl: "https://platform.deepseek.com/api_keys",
    fallbackModels: [
      { id: "deepseek-flash", name: "DeepSeek Flash", context_window: 1048576 },
      { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", context_window: 1048576 },
    ],
  },
  glm: {
    label: "智谱 GLM", labelEn: "Zhipu GLM", group: "third", authStyle: "bearer", modelsAuth: "bearer",
    defaultModel: "glm-5.2", fastModel: "glm-4.7",
    extraEnv: { API_TIMEOUT_MS: "3000000" },
    endpoints: [
      { id: "cn", label: "国内 · open.bigmodel.cn", labelEn: "China · open.bigmodel.cn", baseUrl: "https://open.bigmodel.cn/api/anthropic",
        modelsUrl: "https://open.bigmodel.cn/api/paas/v4/models", keyUrl: "https://bigmodel.cn/usercenter/proj-mgmt/apikeys" },
      { id: "intl", label: "国际 · z.ai", labelEn: "International · z.ai", baseUrl: "https://api.z.ai/api/anthropic",
        modelsUrl: "https://api.z.ai/api/paas/v4/models", keyUrl: "https://z.ai/manage-apikey/apikey-list" },
    ],
    fallbackModels: [
      { id: "glm-5.2", name: "GLM-5.2", context_window: 1000000 },
      { id: "glm-4.7", name: "GLM-4.7" },
    ],
  },
  qwen: {
    label: "通义千问 Qwen", labelEn: "Alibaba Qwen", group: "third", authStyle: "bearer", modelsAuth: "bearer",
    keyUrl: "https://bailian.console.aliyun.com/?tab=model#/api-key",
    endpoints: [
      { id: "payg", label: "按量计费 · dashscope", labelEn: "Pay as you go · dashscope", baseUrl: "https://dashscope.aliyuncs.com/apps/anthropic",
        modelsUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1/models", defaultModel: "qwen3.7-max", fastModel: "qwen3.6-flash" },
      { id: "coding", label: "Coding Plan", baseUrl: "https://coding.dashscope.aliyuncs.com/apps/anthropic",
        defaultModel: "qwen3.7-plus", fastModel: "qwen3.7-plus" },
      { id: "token", label: "Token Plan", baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic",
        defaultModel: "qwen3.8-max", fastModel: "qwen3.8-flash" },
    ],
    fallbackModels: [
      { id: "qwen3.7-max", name: "Qwen3.7 Max" }, { id: "qwen3.7-plus", name: "Qwen3.7 Plus" },
      { id: "qwen3.8-max", name: "Qwen3.8 Max" }, { id: "qwen3.8-flash", name: "Qwen3.8 Flash" },
      { id: "qwen3.6-flash", name: "Qwen3.6 Flash" },
    ],
  },
  kimi: {
    label: "Kimi", group: "third", authStyle: "bearer", modelsAuth: "bearer",
    defaultModel: "kimi-k3", fastModel: "kimi-k2.7-code-highspeed",
    endpoints: [
      { id: "cn", label: "国内 · moonshot.cn", labelEn: "China · moonshot.cn", baseUrl: "https://api.moonshot.cn/anthropic",
        modelsUrl: "https://api.moonshot.cn/v1/models", keyUrl: "https://platform.kimi.com/console/api-keys" },
      { id: "intl", label: "国际 · moonshot.ai", labelEn: "International · moonshot.ai", baseUrl: "https://api.moonshot.ai/anthropic",
        modelsUrl: "https://api.moonshot.ai/v1/models", keyUrl: "https://platform.moonshot.ai/console/api-keys" },
    ],
    fallbackModels: [
      { id: "kimi-k3", name: "Kimi K3", context_window: 1048576 },
      { id: "kimi-k2.7-code-highspeed", name: "Kimi K2.7 Code Highspeed" },
      { id: "kimi-k2.6", name: "Kimi K2.6", context_window: 262144 },
    ],
  },
  minimax: {
    label: "MiniMax", group: "third", authStyle: "bearer", modelsAuth: "bearer",
    defaultModel: "MiniMax-M3.1-Flash", fastModel: "MiniMax-M3",
    endpoints: [
      { id: "cn", label: "国内 · minimax.cn", labelEn: "China · minimax.cn", baseUrl: "https://api.minimax.cn/anthropic",
        modelsUrl: "https://api.minimax.cn/v1/models", keyUrl: "https://platform.minimax.cn/user-center/basic-information/interface-key" },
      { id: "intl", label: "国际 · minimax.io", labelEn: "International · minimax.io", baseUrl: "https://api.minimax.io/anthropic",
        modelsUrl: "https://api.minimax.io/v1/models", keyUrl: "https://platform.minimax.io/user-center/basic-information/interface-key" },
    ],
    hint: "按量计费的 Key 和 M Plan / Token Plan 订阅 Key 都填这里。M3.1 Flash 总是开着思考，关不掉。",
    hintEn: "Works with both pay-as-you-go keys and M Plan / Token Plan subscription keys. M3.1 Flash always thinks; it can't be turned off.",
    fallbackModels: [
      { id: "MiniMax-M3.1-Flash", name: "MiniMax M3.1 Flash", context_window: 1000000 },
      { id: "MiniMax-M3", name: "MiniMax M3", context_window: 1000000 },
    ],
  },
  ark: {
    label: "火山方舟（豆包）", labelEn: "Volcengine Ark (Doubao)", group: "third", authStyle: "bearer", modelsAuth: "bearer",
    baseUrl: "https://ark.cn-beijing.volces.com/api/coding",
    keyUrl: "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey",
    defaultModel: "ark-code-latest", fastModel: "doubao-seed-2.1-lite",
    extraEnv: { API_TIMEOUT_MS: "3000000" },
    hint: "火山方舟 Coding Plan（个人版）。ark-code-latest 用的是你在方舟控制台里选的模型，切换后 3–5 分钟生效；套餐额度只能在编程工具里用。",
    hintEn: "Volcengine Ark Coding Plan (personal). ark-code-latest uses whichever model you picked in the Ark console; switching takes 3–5 minutes. Plan quota only works inside coding tools.",
    fallbackModels: [
      { id: "ark-code-latest", name: "Ark Code Latest (model picked in console)" },
      { id: "doubao-seed-2.1-pro", name: "Doubao Seed 2.1 Pro" },
      { id: "doubao-seed-2.1-lite", name: "Doubao Seed 2.1 Lite" },
      { id: "doubao-seed-evolving", name: "Doubao Seed Evolving" },
      { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
      { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
      { id: "kimi-k2.8-preview", name: "Kimi K2.8 Preview" },
    ],
  },
  mimo: {
    label: "小米 MiMo", labelEn: "Xiaomi MiMo", group: "third", authStyle: "bearer", modelsAuth: "bearer",
    defaultModel: "mimo-v2.6-pro", fastModel: "mimo-v2.6-flash",
    endpoints: [
      { id: "payg", label: "按量计费", labelEn: "Pay as you go", baseUrl: "https://api.xiaomimimo.com/anthropic",
        modelsUrl: "https://api.xiaomimimo.com/v1/models", keyUrl: "https://platform.xiaomimimo.com/#/console/api-keys" },
      { id: "plan", label: "Token Plan", baseUrl: "https://token-plan-cn.xiaomimimo.com/anthropic",
        keyUrl: "https://platform.xiaomimimo.com/#/console/plan-manage" },
    ],
    hint: "按量计费的 Key 以 sk- 开头，Token Plan 的以 tp- 开头，两者不通用。V2.5 已于 10 月 21 日下线。",
    hintEn: "Pay-as-you-go keys start with sk-, Token Plan keys with tp-; they aren't interchangeable. V2.5 was retired on Oct 21.",
    fallbackModels: [
      { id: "mimo-v2.6-pro", name: "MiMo V2.6 Pro", context_window: 1048576 },
      { id: "mimo-v2.6-flash", name: "MiMo V2.6 Flash", context_window: 1048576 },
    ],
  },
  stepfun: {
    label: "阶跃星辰", labelEn: "StepFun", group: "third", authStyle: "bearer", modelsAuth: "bearer",
    defaultModel: "step-5-preview", fastModel: "step-3.7-flash",
    endpoints: [
      { id: "cn", label: "国内 · 按量计费", labelEn: "China · Pay as you go", baseUrl: "https://api.stepfun.com",
        modelsUrl: "https://api.stepfun.com/v1/models", keyUrl: "https://platform.stepfun.com/interface-key" },
      { id: "cn-plan", label: "国内 · Step Plan", labelEn: "China · Step Plan", baseUrl: "https://api.stepfun.com/step_plan",
        keyUrl: "https://platform.stepfun.com/interface-key" },
      { id: "intl", label: "国际 · 按量计费", labelEn: "International · Pay as you go", baseUrl: "https://api.stepfun.ai",
        modelsUrl: "https://api.stepfun.ai/v1/models", keyUrl: "https://platform.stepfun.ai/interface-key" },
      { id: "intl-plan", label: "国际 · Step Plan", labelEn: "International · Step Plan", baseUrl: "https://api.stepfun.ai/step_plan",
        keyUrl: "https://platform.stepfun.ai/interface-key" },
    ],
    hint: "Step Plan 要先订阅；组织空间的 Key 不能用在 Step Plan 线路上。",
    hintEn: "Step Plan needs an active subscription; organization keys don't work on the Step Plan lines.",
    fallbackModels: [
      { id: "step-5-preview", name: "Step 5 Preview", context_window: 1048576 },
      { id: "step-3.7-flash", name: "Step 3.7 Flash" },
      { id: "step-3.5-flash", name: "Step 3.5 Flash" },
    ],
  },
  qianfan: {
    label: "百度千帆", labelEn: "Baidu Qianfan", group: "third", authStyle: "bearer", modelsAuth: "bearer",
    keyUrl: "https://console.bce.baidu.com/qianfan/ais/console/apiKey",
    extraEnv: { API_TIMEOUT_MS: "600000" },
    endpoints: [
      { id: "payg", label: "按量计费", labelEn: "Pay as you go", baseUrl: "https://qianfan.baidubce.com/anthropic",
        modelsUrl: "https://qianfan.baidubce.com/v2/models", defaultModel: "deepseek-v3.2", fastModel: "deepseek-v3.2" },
      { id: "tokenplan", label: "Token Plan 个人版", labelEn: "Token Plan (personal)", baseUrl: "https://qianfan.baidubce.com/anthropic/tokenplan/personal",
        defaultModel: "qianfan-code-latest", fastModel: "qianfan-code-latest" },
    ],
    hint: "千帆上的对话模型都能用。Token Plan 填 qianfan-code-latest，实际用哪个模型在千帆控制台里选；套餐 Key 和按量 Key 不通用。",
    hintEn: "Any chat model on Qianfan works. For Token Plan use qianfan-code-latest and pick the actual model in the Qianfan console; plan keys and pay-as-you-go keys aren't interchangeable.",
    fallbackModels: [
      { id: "deepseek-v3.2", name: "DeepSeek V3.2" },
      { id: "kimi-k2.5", name: "Kimi K2.5" },
      { id: "qianfan-code-latest", name: "Qianfan Code Latest (model picked in console)" },
    ],
  },
  hunyuan: {
    label: "腾讯混元", labelEn: "Tencent Hunyuan", group: "third", authStyle: "bearer", modelsAuth: "bearer",
    defaultModel: "hy3-preview", fastModel: "hy3-preview",
    keyUrl: "https://console.cloud.tencent.com/tokenhub",
    extraEnv: { ENABLE_TOOL_SEARCH: "false" },
    endpoints: [
      { id: "cn", label: "国内 · TokenHub（广州）", labelEn: "China · TokenHub (Guangzhou)", baseUrl: "https://tokenhub.tencentmaas.com",
        modelsUrl: "https://tokenhub.tencentmaas.com/v1/models" },
      { id: "intl", label: "国际 · TokenHub（新加坡）", labelEn: "International · TokenHub (Singapore)", baseUrl: "https://tokenhub-intl.tencentmaas.com",
        modelsUrl: "https://tokenhub-intl.tencentmaas.com/v1/models" },
    ],
    hint: "走腾讯云 TokenHub 按量计费（混元原平台已迁到这里）。TokenHub 上的其他模型也能在模型列表里选。",
    hintEn: "Uses Tencent Cloud TokenHub pay-as-you-go (Hunyuan moved here from its old platform). Other TokenHub models show up in the model list too.",
    fallbackModels: [
      { id: "hy3-preview", name: "Hy3 Preview" },
    ],
  },
  longcat: {
    label: "美团 LongCat", labelEn: "Meituan LongCat", group: "third", authStyle: "bearer", modelsAuth: "bearer",
    baseUrl: "https://api.longcat.chat/anthropic", modelsUrl: "https://api.longcat.chat/openai/v1/models",
    keyUrl: "https://longcat.chat/platform/api_keys",
    defaultModel: "LongCat-2.5-Preview", fastModel: "LongCat-2.5-Preview",
    extraEnv: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: "131072" },
    fallbackModels: [
      { id: "LongCat-2.5-Preview", name: "LongCat 2.5 Preview" },
      { id: "LongCat-2.0", name: "LongCat 2.0" },
    ],
  },
  xai: {
    label: "xAI Grok", group: "third", authStyle: "bearer", modelsAuth: "bearer",
    baseUrl: "https://api.x.ai", modelsUrl: "https://api.x.ai/v1/models",
    keyUrl: "https://console.x.ai",
    defaultModel: "grok-4.7", fastModel: "grok-4.20-0309-non-reasoning",
    fallbackModels: [
      { id: "grok-4.7", name: "Grok 4.7", context_window: 500000 },
      { id: "grok-4.3", name: "Grok 4.3", context_window: 1000000 },
      { id: "grok-4.20-0309-reasoning", name: "Grok 4.20 Reasoning", context_window: 1000000 },
      { id: "grok-4.20-0309-non-reasoning", name: "Grok 4.20 Non-reasoning", context_window: 1000000 },
    ],
  },
  meta: {
    label: "Meta Muse", group: "third", authStyle: "bearer", modelsAuth: "bearer",
    baseUrl: "https://api.meta.ai", modelsUrl: "https://api.meta.ai/v1/models",
    keyUrl: "https://dev.meta.ai/platform",
    defaultModel: "muse-wonder-1.0", fastModel: "muse-spark-1.3",
    extraEnv: { ENABLE_TOOL_SEARCH: "true" },
    hint: "Meta Model API 还在公开预览，能不能用看所在国家和地区（中国大陆用不了）。",
    hintEn: "Meta Model API is in public preview; availability depends on your country or region.",
    fallbackModels: [
      { id: "muse-wonder-1.0", name: "Muse Wonder 1.0", context_window: 1048576 },
      { id: "muse-spark-1.3", name: "Muse Spark 1.3", context_window: 1048576 },
    ],
  },
};
// 端侧小模型（cccodroid）：llama.cpp 的 llama-server 自带 Anthropic Messages 端点（/v1/messages），claude 直连本机。
// 不要密钥（给个占位值，llama-server 不校验）；模型清单就是模型目录里的 .gguf，服务由网关按需拉起，见「端侧小模型」一节
export const LLAMA_PORT = Number(process.env.CCAPP_LLAMA_PORT) || 8811;
if (PREFIX) PRESETS.local = {
  label: "端侧小模型（本机）", labelEn: "On-device model", group: "local", local: true,
  baseUrl: `http://127.0.0.1:${LLAMA_PORT}`, authStyle: "x-api-key", apiKey: "local", defaultModel: null,
  // 手机上读一万多 token 的提示要几分钟：别让 claude 等两分钟就当超时。
  // 重试只给两次：本机服务挂了就是挂了，默认十次退避要白等三分钟
  extraEnv: { API_TIMEOUT_MS: "3000000", CLAUDE_CODE_MAX_RETRIES: "2" },
  hint: "用本机的 llama.cpp 跑小模型聊天，不联网、不花钱。手机算力有限，干活请用云端模型。",
  hintEn: "Chat with a small model running on this device via llama.cpp — offline and free. Phone hardware is limited; use a cloud model for real work.",
};
// 预置条目只从配置文件里取这些"属于用户"的字段；其余（名字、线路表、端点）以目录为准，
// 这样旧配置里抄死的 label/baseUrl 不会把目录更新挡住。自定义条目则整条都是用户的。
const USER_FIELDS = ["apiKey", "apiKeyEnv", "endpoint", "defaultModel", "fastModel", "extraEnv"];

/** 合成一条生效配置：目录 + 用户字段 + 所选线路 */
function composeProvider(id, raw) {
  const pre = PRESETS[id];
  let v;
  if (pre) {
    v = { ...pre };
    for (const k of USER_FIELDS) if (raw && raw[k] != null && raw[k] !== "") v[k] = raw[k];
    // 旧配置里自己攒的模型清单（带真实窗口）比目录里的全，留着
    if (raw && Array.isArray(raw.fallbackModels) && raw.fallbackModels.length) v.fallbackModels = raw.fallbackModels;
  } else {
    v = { group: "custom", authStyle: "bearer", modelsAuth: "bearer", ...raw, custom: true };
  }
  if (v.endpoints && v.endpoints.length) {
    const ep = v.endpoints.find((e) => e.id === v.endpoint) || v.endpoints[0];
    v.endpoint = ep.id;
    v.baseUrl = ep.baseUrl;
    v.modelsUrl = ep.modelsUrl || "";
    if (ep.keyUrl) v.keyUrl = ep.keyUrl;
    // 线路自带的默认模型只在用户没改过时生效
    if (!(raw && raw.defaultModel) && ep.defaultModel) v.defaultModel = ep.defaultModel;
    if (!(raw && raw.fastModel) && ep.fastModel) v.fastModel = ep.fastModel;
  }
  return v;
}

let PROVIDERS_RAW = { active: null, providers: {} };   // 配置文件原样（只含用户字段与自定义条目）
function loadProviders() {
  try {
    const j = JSON.parse(fs.readFileSync(PROVIDERS_FILE, "utf8"));
    if (j && typeof j === "object") PROVIDERS_RAW = { ...j, providers: (j.providers && typeof j.providers === "object") ? j.providers : {} };
  } catch {}
  const providers = {};
  for (const id of Object.keys(PRESETS)) providers[id] = composeProvider(id, PROVIDERS_RAW.providers[id]);
  for (const [id, raw] of Object.entries(PROVIDERS_RAW.providers)) {
    if (!PRESETS[id] && raw && raw.baseUrl) providers[id] = composeProvider(id, raw);
  }
  const active = providers[PROVIDERS_RAW.active] ? PROVIDERS_RAW.active : (PREFIX ? "anthropic" : "deepseek");
  return { active, providers };
}
function saveProvidersRaw() {
  fs.writeFileSync(PROVIDERS_FILE, JSON.stringify(PROVIDERS_RAW, null, 2), { mode: 0o600 });
  PROVIDERS_CFG = loadProviders();
}
export let PROVIDERS_CFG = loadProviders();

/** 给界面看的一家：密钥只露末四位 */
function providerView(id, v) {
  const key = String(v.apiKey || "").trim();
  return {
    id, label: v.label || id, labelEn: v.labelEn || "", group: v.group || "custom", custom: !!v.custom,
    login: !!v.login, nativeModels: !!v.nativeModels, local: !!v.local,
    baseUrl: v.baseUrl || "", modelsUrl: v.modelsUrl || "", authStyle: v.authStyle || "bearer",
    endpoints: (v.endpoints || []).map((e) => ({ id: e.id, label: e.label, labelEn: e.labelEn || "" })), endpoint: v.endpoint || null,
    defaultModel: v.defaultModel || null, fastModel: v.fastModel || null,
    keyUrl: v.keyUrl || null, hint: v.hint || "", hintEn: v.hintEn || "",
    hasKey: !!key, keyTail: key ? key.slice(-4) : "",
    active: id === PROVIDER.id,
  };
}

function upsertProvider(id, b) {
  const isNew = !id;
  if (isNew) {
    if (!b.baseUrl) return { error: "need_baseUrl", message: tz("自定义接口至少要填端点地址") };
    let n = 1; while (PROVIDERS_RAW.providers["custom-" + n] || PRESETS["custom-" + n]) n++;
    id = "custom-" + n;
  }
  if (!PRESETS[id] && !PROVIDERS_RAW.providers[id] && !isNew) return { error: "unknown provider" };
  const cur = { ...(PROVIDERS_RAW.providers[id] || {}) };
  const str = (v) => String(v == null ? "" : v).trim();
  if ("apiKey" in b && str(b.apiKey)) cur.apiKey = str(b.apiKey);   // 空串 = 不改（界面上不回显旧密钥）
  if (b.clearKey) delete cur.apiKey;
  for (const k of ["endpoint", "defaultModel", "fastModel"]) if (k in b) { if (str(b[k])) cur[k] = str(b[k]); else delete cur[k]; }
  if (!PRESETS[id]) {
    for (const k of ["label", "baseUrl", "modelsUrl"]) if (k in b) cur[k] = str(b[k]);
    if ("authStyle" in b) cur.authStyle = b.authStyle === "x-api-key" ? "x-api-key" : "bearer";
    cur.modelsAuth = cur.authStyle || "bearer";
    if (!cur.label) cur.label = id;
    if (!/^https?:\/\//.test(cur.baseUrl || "")) return { error: "bad_baseUrl", message: tz("端点地址要以 http:// 或 https:// 开头") };
    cur.baseUrl = cur.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");   // claude 自己会补 /v1/messages
  }
  PROVIDERS_RAW.providers[id] = cur;
  saveProvidersRaw();
  if (id === PROVIDER.id) { applyProvider(); dropModelCache(); }
  log(`[provider] 已保存 ${id}${"apiKey" in b && str(b.apiKey) ? "（含密钥）" : ""}`);
  return { ok: true, id, provider: providerView(id, PROVIDERS_CFG.providers[id]) };
}

/** 验密钥：有模型清单接口就拉清单（不花钱）；没有就发一条 max_tokens=1 的消息 */
async function testProvider(id) {
  const v = PROVIDERS_CFG.providers[id];
  if (!v) return { ok: false, message: tz("没有这家厂商") };
  if (v.login) return { ok: false, message: tz("账户登录不用测密钥，看登录状态即可") };
  const key = String(v.apiKey || "").trim();
  if (!key) return { ok: false, message: tz("还没填密钥") };
  const auth = v.authStyle === "x-api-key"
    ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
    : { Authorization: `Bearer ${key}`, "anthropic-version": "2023-06-01" };
  try {
    let r, how;
    if (v.modelsUrl) {
      how = "模型清单";
      r = await fetch(v.modelsUrl, { headers: auth, signal: AbortSignal.timeout(15000) });
    } else {
      how = "试发一条消息";
      r = await fetch(v.baseUrl.replace(/\/+$/, "") + "/v1/messages", {
        method: "POST", headers: { ...auth, "content-type": "application/json" }, signal: AbortSignal.timeout(30000),
        body: JSON.stringify({ model: v.defaultModel || "x", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
      });
    }
    const text = await r.text();
    if (r.ok) {
      let n = 0; try { n = normalizeModels(JSON.parse(text)).length; } catch {}
      return { ok: true, message: n ? tz("密钥有效（{how}，{n} 个模型）", { how, n }) : tz("密钥有效（{how}）", { how }) };
    }
    let msg = text.slice(0, 200);
    try { const j = JSON.parse(text); msg = j.error?.message || j.message || j.msg || msg; } catch {}
    const why = r.status === 401 || r.status === 403 ? "密钥无效或与线路不匹配" : `HTTP ${r.status}`;
    // 聚合平台（如 opencode Zen）同一个型号可能只走 OpenAI 协议：报 "does not support this protocol"。议题 #23
    const hint = /support(s|ed)? (this|the) protocol|unsupported protocol/i.test(msg) ? tz("（这个型号在这个地址上不支持 Anthropic 协议：换一个支持的型号，或换成平台给 Claude Code 用的那个地址）") : "";
    return { ok: false, status: r.status, message: `${why}：${msg}${hint}` };
  } catch (e) {
    return { ok: false, message: tz("连不上：{err}", { err: e.message }) };
  }
}
// ── 余额与消费（设置页的厂商卡片）────────────────────────────────────
// 余额：问平台（各家接口不一样，没开放的就没有）。
// 消费：没有一家给 API Key 开放账单接口，只能自己记 —— 每次查到余额记一笔，比上次少了就是花掉的，
//       多了是充值（不算消费）。算的是整个账号的真实花费，同一把 Key 在别处用掉的也算。
// token：每轮结束按 claude 报的用量记一笔，所有厂商都有（查不了余额的平台就看这个）。
const BILL_FILE = path.join(CFG.home, "ccapp-billing.json");
let BILL = (() => { try { return JSON.parse(fs.readFileSync(BILL_FILE, "utf8")) || {}; } catch { return {}; } })();
let billSaveT = null;
const saveBill = () => { clearTimeout(billSaveT); billSaveT = setTimeout(() => { try { fs.writeFileSync(BILL_FILE, JSON.stringify(BILL), { mode: 0o600 }); } catch {} }, 500); };
const billOf = (id) => (BILL[id] ||= { since: Date.now(), spends: [], spentOld: 0, tok: [], tokOld: { in: 0, out: 0, cache: 0 } });
const KEEP_MS = 92 * 86400e3;   // 明细留三个月，更早的并进累计

/** 按端点认平台。认不出的（含自定义）就只记 token */
function billKind(v) {
  const u = String(v.baseUrl || "");
  if (/\/\/api\.deepseek\.com/.test(u)) return { kind: "deepseek" };
  if (/\/\/api\.moonshot\.cn/.test(u)) return { kind: "kimi", host: "https://api.moonshot.cn", currency: "CNY" };
  if (/\/\/api\.moonshot\.ai/.test(u)) return { kind: "kimi", host: "https://api.moonshot.ai", currency: "USD" };
  if (/\/\/open\.bigmodel\.cn/.test(u)) return { kind: "glm", host: "https://open.bigmodel.cn" };
  if (/\/\/api\.z\.ai/.test(u)) return { kind: "glm", host: "https://api.z.ai" };
  if (/\/\/openrouter\.ai/.test(u)) return { kind: "openrouter", currency: "USD" };
  return { kind: "none" };
}

async function fetchJson(url, headers) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch {}
  if (!r.ok) throw new Error(`HTTP ${r.status}：${(j && (j.error?.message || j.message || j.msg)) || text.slice(0, 120)}`);
  return j;
}

/** 问平台要余额 → { currency, balance, parts:[{k,v}] } 或套餐额度 { plan:[...] } */
async function queryBalance(v, k) {
  const key = String(v.apiKey || "").trim();
  if (k.kind === "deepseek") {
    const j = await fetchJson("https://api.deepseek.com/user/balance", { Authorization: `Bearer ${key}` });
    // 按币种各一条（人民币、美元）：别只拿第一条 —— 钱在美元那条时第一条是 0，界面就一直显示 ¥0.00，顺序一变还会跳。
    // 取有钱的那条（都有就取多的；都没有优先人民币），另一种币有钱的话列在明细里
    const infos = (j.balance_infos || []).filter((x) => x && x.currency);
    if (!infos.length) throw new Error("no balance_infos");
    const b = infos.slice().sort((x, y) => (+y.total_balance || 0) - (+x.total_balance || 0) || (x.currency === "CNY" ? -1 : y.currency === "CNY" ? 1 : 0))[0];
    const parts = [{ k: "granted", v: +b.granted_balance }, { k: "topped", v: +b.topped_up_balance }];
    for (const o of infos) if (o !== b && +o.total_balance > 0) parts.push({ k: o.currency, v: +o.total_balance, currency: o.currency });
    return { currency: b.currency, balance: +b.total_balance, parts, available: j.is_available !== false };
  }
  if (k.kind === "kimi") {
    const j = await fetchJson(k.host + "/v1/users/me/balance", { Authorization: `Bearer ${key}` });
    if (j.code !== 0 || !j.data) throw new Error(j.error?.message || j.message || "code " + j.code);
    return { currency: k.currency, balance: +j.data.available_balance, parts: [{ k: "voucher", v: +j.data.voucher_balance }, { k: "cash", v: +j.data.cash_balance }] };
  }
  if (k.kind === "openrouter") {
    const j = await fetchJson("https://openrouter.ai/api/v1/key", { Authorization: `Bearer ${key}` });
    const d = j.data || {};
    if (d.limit_remaining == null) return { currency: "USD", balance: null, usage: +d.usage || 0 };
    return { currency: "USD", balance: +d.limit_remaining, usage: +d.usage || 0 };
  }
  if (k.kind === "glm") {
    // 智谱没有公开的余额接口；这是官方用量插件用的 Coding Plan 额度接口（非公开，可能变）。按量计费的 Key 查不到
    let j, err;
    for (const auth of [key, `Bearer ${key}`]) {
      try { j = await fetchJson(k.host + "/api/monitor/usage/quota/limit", { Authorization: auth, "Accept-Language": "zh-CN,zh" }); break; } catch (e) { err = e; }
    }
    if (!j) throw err;
    const lim = (j.data && j.data.limits) || [];
    if (!lim.length) return { plan: [], level: j.data && j.data.level };
    return {
      level: j.data.level || null,
      plan: lim.map((x) => ({
        window: x.unit === 3 ? "5h" : x.unit === 6 ? "week" : x.unit === 5 ? "month" : String(x.unit || ""),
        type: x.type || "", pct: Number(x.percentage) || 0, resetsAt: Number(x.nextResetTime) || 0,
        used: x.usage != null ? +x.usage : null, remaining: x.remaining != null ? +x.remaining : null,
      })),
    };
  }
  return null;
}

/** 记一次余额：比上次少 → 消费；多 → 充值（只更新基准） */
function noteBalance(id, cur, bal) {
  if (!Number.isFinite(bal)) return;
  const b = billOf(id);
  if (b.currency && b.currency !== cur) { b.last = null; }      // 换了币种（换了线路）：重新起算
  b.currency = cur;
  const now = Date.now();
  if (b.last && Number.isFinite(b.last.bal)) {
    const d = +(b.last.bal - bal).toFixed(6);
    if (d > 0) b.spends.push([now, d]);
    else if (d < 0) b.topups = (b.topups || 0) + 1;
  }
  b.last = { at: now, bal };
  const cut = now - KEEP_MS;
  while (b.spends.length && b.spends[0][0] < cut) b.spentOld += b.spends.shift()[1];
  saveBill();
}

/** 一轮结束记 token（按小时合并） */
export function noteTokens(id, u) {
  if (!id || !u) return;
  const b = billOf(id);
  const hour = Math.floor(Date.now() / 3600e3) * 3600e3;
  const add = [u.input_tokens || 0, u.output_tokens || 0, (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)];
  const last = b.tok[b.tok.length - 1];
  if (last && last[0] === hour) for (let i = 0; i < 3; i++) last[i + 1] += add[i];
  else b.tok.push([hour, ...add]);
  const cut = Date.now() - KEEP_MS;
  while (b.tok.length && b.tok[0][0] < cut) { const x = b.tok.shift(); b.tokOld.in += x[1]; b.tokOld.out += x[2]; b.tokOld.cache += x[3]; }
  saveBill();
}

// 汇率：界面货币跟语言走（中文显示人民币，其余显示美元），账户币种不同时按汇率换算并标「≈」。半天取一次
let FX = null;
export async function usdCny() {
  if (FX && Date.now() - FX.at < 12 * 3600e3) return FX;
  try {
    const j = await fetchJson("https://open.er-api.com/v6/latest/USD", {});
    if (j.result === "success" && j.rates && j.rates.CNY) FX = { rate: +j.rates.CNY, at: Date.now(), src: "open.er-api.com" };
  } catch (e) { log(`汇率获取失败：${e.message}`); }
  return FX;
}

const BAL_CACHE = new Map();   // id → { at, data }
async function billingInfo(id, force) {
  const v = PROVIDERS_CFG.providers[id];
  if (!v) return { error: tz("没有这家厂商") };
  const k = billKind(v);
  const out = { id, kind: k.kind, hasKey: !!String(v.apiKey || "").trim() };
  if (k.kind !== "none" && out.hasKey) {
    const c = BAL_CACHE.get(id);
    if (!force && c && Date.now() - c.at < 60000) Object.assign(out, c.data);
    else {
      try {
        const d = await queryBalance(v, k);
        if (d && d.currency && Number.isFinite(d.balance)) noteBalance(id, d.currency, d.balance);
        BAL_CACHE.set(id, { at: Date.now(), data: { ...(d || {}), balanceAt: Date.now() } });
        Object.assign(out, d || {}, { balanceAt: Date.now() });
      } catch (e) { out.balanceError = e.message; }
    }
  }
  const b = BILL[id];
  if (b) Object.assign(out, { since: b.since, spends: b.spends, spentOld: b.spentOld, ledgerCurrency: b.currency || null, tok: b.tok, tokOld: b.tokOld, checkedAt: b.last ? b.last.at : null });
  out.fx = await usdCny();
  return out;
}

/** 一轮跑完补查余额（能查的平台），消费记录才连得上。
 *  平台扣费有延迟（DeepSeek 实测跑完 20 秒还没扣、几分钟后才扣），所以分几次查：30 秒、3 分钟、10 分钟。
 *  又跑了一轮就重新排，连续干活时不会越堆越多 */
const billPending = new Map();
export function billAfterRun(id) {
  const v = PROVIDERS_CFG.providers[id];
  if (!v || billKind(v).kind === "none" || !String(v.apiKey || "").trim()) return;
  for (const t of billPending.get(id) || []) clearTimeout(t);
  // 查完推一条 billing：顶栏的余额速览、用量页跟着更新（bus.mjs 间接引用本文件，这里按需加载免得循环引用）
  const done = () => import("./bus.mjs").then((m) => m.publish({ type: "billing", id })).catch(() => {});
  billPending.set(id, [30e3, 180e3, 600e3].map((ms) => { const t = setTimeout(() => billingInfo(id, true).then(done, () => {}), ms); t.unref?.(); return t; }));
}

export let PROVIDER = BUILTIN_PROVIDER;

/** 逐级回落取密钥：生效厂商自带 → 环境变量 → 历史配置文件 */
function loadApiKey(p) {
  if (p && p.apiKey) return String(p.apiKey).trim();

  // 显式配置过的厂商（ccapp-providers.json 里有它一条），密钥就只认它自己那一条。
  // ⚠️ 这里的"留空"是**故意的**，不是"没配"：官方账户条目留空 = 不注入任何密钥，
  //    让 claude 用 ~/.claude/.credentials.json 里的登录态。
  //    以前没有这道闸，留空会一路回落到 ccapp-config.json —— 那里面躺的是 DeepSeek 的钥匙，
  //    于是切到官方账户时被注成 ANTHROPIC_API_KEY（它优先级高于登录态），
  //    拿 DeepSeek 钥匙打 api.anthropic.com，全网 401。
  if (p && p.explicit) {
    if (p.apiKeyEnv && process.env[p.apiKeyEnv]) return String(process.env[p.apiKeyEnv]).trim();
    return null;                     // 不注入 = 登录态原样透传
  }

  if (process.env.ANTHROPIC_AUTH_TOKEN) return process.env.ANTHROPIC_AUTH_TOKEN;
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;

  for (const f of [PATHS.config, path.join(CFG.home, "ccapp-seed.json")]) {
    try {
      const j = JSON.parse(fs.readFileSync(f, "utf8"));
      const k = j.apiKey || j.API_KEY || j.token || j.DEEPSEEK_API_KEY;
      if (k) return k;
    } catch {}
  }
  try {
    const j = JSON.parse(fs.readFileSync(SEED_FILE, "utf8"));
    const k = j.apiKey || j.API_KEY || j.token || j.DEEPSEEK_API_KEY;
    if (k) {
      try {
        fs.mkdirSync(path.dirname(PATHS.config), { recursive: true });
        fs.writeFileSync(PATHS.config, JSON.stringify({ apiKey: k }, null, 2), { mode: 0o600 });
        log(`[key] 已从共享位置导入密钥到私有目录`);
        // 导完立刻把共享区那份清空 —— 明文密钥不该在 /sdcard 上多留一秒，
        // 那是任何有存储权限的应用都读得到的地方。密钥已进私有目录，清空不影响使用。
        try {
          fs.writeFileSync(SEED_FILE, "{}");
          log(`[key] 已清空共享区的 seed 文件 ${SEED_FILE}`);
        } catch (e) { log(`[key] 共享区清空失败（不影响使用）: ${e.message}`); }
      } catch (e) { log(`[key] 私有目录写入失败: ${e.message}`); }
      return k;
    }
  } catch {}
  return null;
}

export let API_KEY = null;   // 在 SETTINGS 载入后按「生效厂商」解析
/** 按 id 取一家（0.3.16 起各会话可以用不同的接口）：生效的那家直接给 PROVIDER；配置里没有的给 null */
export function providerById(id) {
  if (!id || id === PROVIDER.id) return PROVIDER;
  if (PROVIDERS_CFG && PROVIDERS_CFG.providers[id]) return pickProvider(id);
  return id === BUILTIN_PROVIDER.id ? BUILTIN_PROVIDER : null;
}
/** 各家能不能用（有钥匙 / 走登录 / 本机），给输入栏的模型面板按接口分组用。钥匙本身不出网关 */
export function providerBrief() {
  const ids = PROVIDERS_CFG ? Object.keys(PROVIDERS_CFG.providers) : [BUILTIN_PROVIDER.id];
  if (!ids.includes(PROVIDER.id)) ids.unshift(PROVIDER.id);
  return ids.map((id) => {
    const p = providerById(id);
    return p && { id, label: p.label || id, labelEn: p.labelEn || "", login: !!p.login, local: !!p.local,
      nativeModels: !!p.nativeModels, usable: !!(p.login || p.local || keyOf(p)), active: id === PROVIDER.id,
      keyMode: keyOf(p) ? "key" : p.login ? "login" : "none", defaultModel: p.defaultModel || null };
  }).filter(Boolean);
}
/** 这一家的密钥：生效的那家用已解析好的 API_KEY，别家现取（同样的回落规则，见 loadApiKey） */
export function keyOf(p) {
  if (!p || p === PROVIDER || p.id === PROVIDER.id) return API_KEY;
  return loadApiKey(p);
}

/** 应用当前厂商：更新上游与密钥。
 *  模型清单缓存无需在此清除 —— fetchModels 以 MODELS_FOR===PROVIDER.id 为键，
 *  换厂商自然失效。 */
export function applyProvider() {
  PROVIDER = resolveProvider();
  CFG.upstream = PROVIDER.baseUrl || BUILTIN_PROVIDER.baseUrl;
  API_KEY = loadApiKey(PROVIDER);
}

/** claude 认的权限模式（2026-10 版二进制）。没有 manual */
export const PERM_MODES = ["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"];

function pickProvider(id) { return { id, explicit: !!PROVIDERS_RAW.providers[id] || id !== BUILTIN_PROVIDER.id, ...PROVIDERS_CFG.providers[id] }; }
/** 生效厂商：设置里的 provider 优先，其次配置文件 active，最后内置兜底 */
function resolveProvider() {
  const want = SETTINGS.provider;
  if (PROVIDERS_CFG) {
    // explicit=true：这个厂商是配置文件里显式写着的 —— 它的密钥只认自己那一条，
    // 不再往历史配置回落（见 loadApiKey 里那段血泪注释）。
    // explicit：密钥只认这条自己的，不往历史配置回落。唯一例外是老版 DeepSeek ——
    // 它的密钥可能还躺在 ccapp-config.json 里、配置文件里没它这一条。
    // （官方账户条目绝不能回落：那会把 DeepSeek 的钥匙注成 ANTHROPIC_API_KEY，见 loadApiKey）
    const pick = pickProvider;
    if (want && PROVIDERS_CFG.providers[want]) return pick(want);
    const a = PROVIDERS_CFG.active;
    if (a && PROVIDERS_CFG.providers[a]) return pick(a);
  }
  return BUILTIN_PROVIDER;
}

// ── 路由：/api/key /api/providers /api/providers/save /api/providers/delete /api/providers/test /api/billing ──
export async function routeProviders(req, res, u, p) {
  // 老接口：只存密钥。新界面走 /api/providers/save
  if (req.method === "POST" && p === "/api/key") {
    const b = JSON.parse((await readBody(req)) || "{}");
    const k = String(b.apiKey || "").trim();
    if (!k) return sendJson(res, 400, { error: "empty" });
    const r = upsertProvider(b.provider ? String(b.provider) : PROVIDER.id, { apiKey: k });
    return sendJson(res, r.error ? 400 : 200, r);
  }
  // ── 厂商列表（供界面切换用）──
  if (req.method === "GET" && p === "/api/providers") {
    const list = Object.entries(PROVIDERS_CFG.providers).map(([id, v]) => providerView(id, v));
    return sendJson(res, 200, {
      active: PROVIDER.id,
      configFile: PROVIDERS_FILE,
      configFound: fs.existsSync(PROVIDERS_FILE),
      providers: list,
    });
  }
  // 存一家：预置厂商只收密钥 / 线路 / 默认模型；自定义厂商收全部字段，id 为空就新建
  if (req.method === "POST" && p === "/api/providers/save") {
    const b = JSON.parse((await readBody(req)) || "{}");
    const r = upsertProvider(b.id ? String(b.id) : null, b);
    return sendJson(res, r.error ? 400 : 200, r);
  }
  if (req.method === "POST" && p === "/api/providers/delete") {
    const b = JSON.parse((await readBody(req)) || "{}");
    const id = String(b.id || "");
    if ([...RUNS.values()].some((r) => !r.ended && r.provider === id)) return sendJson(res, 409, { error: "busy", message: tz("这一家正在用，等这一轮跑完再删。") });
    if (PRESETS[id]) {
      // 预置厂商删不掉，只清空用户字段（密钥等）
      delete PROVIDERS_RAW.providers[id];
    } else if (PROVIDERS_RAW.providers[id]) {
      delete PROVIDERS_RAW.providers[id];
      if (SETTINGS.provider === id) { SETTINGS.provider = null; SETTINGS.model = null; saveSettings(); }
    } else return sendJson(res, 404, { error: "unknown provider" });
    saveProvidersRaw();
    applyProvider();
    dropModelCache();
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === "POST" && p === "/api/providers/test") {
    const b = JSON.parse((await readBody(req)) || "{}");
    return sendJson(res, 200, await testProvider(String(b.id || PROVIDER.id)));
  }
  if (req.method === "GET" && p === "/api/billing") {
    return sendJson(res, 200, await billingInfo(String(u.searchParams.get("id") || PROVIDER.id), u.searchParams.get("refresh") === "1"));
  }
  return NEXT;
}
