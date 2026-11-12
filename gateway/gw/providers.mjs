import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { CFG, PATHS, PREFIX, log, tz } from "./config.mjs";
import { SETTINGS, saveSettings } from "./settings-store.mjs";
import { MODEL_ID_RE, dropModelCache, extraModelsOf, normalizeModels } from "./models.mjs";
import { RUNS } from "./runs.mjs";
import { NEXT, fetchText, readBody, sendJson } from "./http.mjs";
import { readSmallFile } from "./saferead.mjs";
import { isObj, loadState, saveState } from "./statefile.mjs";
import { onShutdown } from "./crashguard.mjs";

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
// 都是各家**官方文档**给 Claude Code 用的 Anthropic 兼容端点（2026-11-13 逐个复核，并实测路由存在）：
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
      { id: "deepseek-flash", name: "DeepSeek V4.1 Flash", context_window: 1048576 },
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
    hint: "GLM Coding Plan 目前只能用 OpenAI 协议调 5.3 系列；这里走 Anthropic 接口，Coding Plan 请选 GLM-5.2，按量计费的 Key 可以用 5.3。",
    hintEn: "GLM Coding Plan can currently use the 5.3 series only over the OpenAI protocol; on this Anthropic endpoint pick GLM-5.2. Pay-as-you-go keys can use 5.3.",
    fallbackModels: [
      { id: "glm-5.3", name: "GLM-5.3", context_window: 1000000 },
      { id: "glm-5.3-flash", name: "GLM-5.3 Flash", context_window: 1000000 },
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
    defaultModel: "kimi-k3.1-pro", fastModel: "kimi-k3.1-pro-highspeed",
    endpoints: [
      { id: "cn", label: "国内 · moonshot.cn", labelEn: "China · moonshot.cn", baseUrl: "https://api.moonshot.cn/anthropic",
        modelsUrl: "https://api.moonshot.cn/v1/models", keyUrl: "https://platform.kimi.com/console/api-keys" },
      { id: "intl", label: "国际 · moonshot.ai", labelEn: "International · moonshot.ai", baseUrl: "https://api.moonshot.ai/anthropic",
        modelsUrl: "https://api.moonshot.ai/v1/models", keyUrl: "https://platform.moonshot.ai/console/api-keys" },
    ],
    fallbackModels: [
      { id: "kimi-k3.1-pro", name: "Kimi K3.1 Pro", context_window: 1048576 },
      { id: "kimi-k3.1-pro-highspeed", name: "Kimi K3.1 Pro Highspeed", context_window: 1048576 },
      { id: "kimi-k3", name: "Kimi K3", context_window: 1048576 },
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
      { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", context_window: 1048576 },
      { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
      { id: "kimi-k3.1-pro", name: "Kimi K3.1 Pro", context_window: 1048576 },
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
        modelsUrl: "https://qianfan.baidubce.com/v2/models", defaultModel: "deepseek-v4-pro", fastModel: "deepseek-v4.1-flash" },
      { id: "tokenplan", label: "Token Plan 个人版", labelEn: "Token Plan (personal)", baseUrl: "https://qianfan.baidubce.com/anthropic/tokenplan/personal",
        defaultModel: "qianfan-code-latest", fastModel: "qianfan-code-latest" },
    ],
    hint: "千帆上的对话模型都能用。Token Plan 填 qianfan-code-latest，实际用哪个模型在千帆控制台里选；套餐 Key 和按量 Key 不通用。",
    hintEn: "Any chat model on Qianfan works. For Token Plan use qianfan-code-latest and pick the actual model in the Qianfan console; plan keys and pay-as-you-go keys aren't interchangeable.",
    fallbackModels: [
      { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", context_window: 1048576 },
      { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", context_window: 1048576 },
      { id: "ernie-5.5-flash-preview", name: "ERNIE 5.5 Flash Preview", context_window: 1048576 },
      { id: "glm-5.3", name: "GLM-5.3", context_window: 1000000 },
      { id: "glm-5.3-flash", name: "GLM-5.3 Flash", context_window: 1000000 },
      { id: "deepseek-v3.2", name: "DeepSeek V3.2" },
      { id: "qianfan-code-latest", name: "Qianfan Code Latest (model picked in console)" },
    ],
  },
  hunyuan: {
    label: "腾讯混元", labelEn: "Tencent Hunyuan", group: "third", authStyle: "bearer", modelsAuth: "bearer",
    defaultModel: "hy4", fastModel: "hy3",
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
      { id: "hy4", name: "Hy4", context_window: 1048576 },
      { id: "hy4-preview", name: "Hy4 Preview", context_window: 1048576 },
      { id: "hy3", name: "Hy3", context_window: 262144 },
    ],
  },
  longcat: {
    label: "美团 LongCat", labelEn: "Meituan LongCat", group: "third", authStyle: "bearer", modelsAuth: "bearer",
    baseUrl: "https://api.longcat.chat/anthropic", modelsUrl: "https://api.longcat.chat/openai/v1/models",
    keyUrl: "https://longcat.chat/platform/api_keys",
    defaultModel: "LongCat-2.5", fastModel: "LongCat-2.5",
    extraEnv: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: "131072" },
    fallbackModels: [
      { id: "LongCat-2.5", name: "LongCat 2.5", context_window: 1048576 },
      { id: "LongCat-2.5-Preview", name: "LongCat 2.5 Preview", context_window: 1048576 },
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
    defaultModel: "muse-wonder-1.0", fastModel: "muse-ember-1.0",
    extraEnv: { ENABLE_TOOL_SEARCH: "true" },
    hint: "Meta Model API 还在公开预览，能不能用看所在国家和地区（中国大陆用不了）。",
    hintEn: "Meta Model API is in public preview; availability depends on your country or region.",
    fallbackModels: [
      { id: "muse-wonder-1.0", name: "Muse Wonder 1.0", context_window: 1048576 },
      { id: "muse-ember-1.0", name: "Muse Ember 1.0" },
      { id: "muse-spark-1.3", name: "Muse Spark 1.3", context_window: 1048576 },
    ],
  },
};
// 端侧小模型（cccodroid）：llama.cpp 的 llama-server 自带 Anthropic Messages 端点（/v1/messages），claude 直连本机。
// 模型清单就是模型目录里的 .gguf，服务由网关按需拉起，见「端侧小模型」一节
export const LLAMA_PORT = Number(process.env.CCAPP_LLAMA_PORT) || 8811;
// 端侧服务要密钥（审查 中9）：127.0.0.1 的端口全机共享，不设的话同机别的应用能白用算力、把 KV 缓存占满。
// llama-server 用 --api-key-file 读它（Bearer、X-Api-Key 两种头都认）。存在 home/.cache 里（0600），
// 跨网关重启不变 —— 还活着的 llama-server 和新起的网关对得上
export const LLAMA_KEY_FILE = path.join(CFG.home, ".cache", "llama-api-key");
export const LLAMA_KEY = !PREFIX ? "local" : (() => {
  try { const k = fs.readFileSync(LLAMA_KEY_FILE, "utf8").trim(); if (/^[0-9a-f]{48}$/.test(k)) return k; } catch {}
  const k = crypto.randomBytes(24).toString("hex");
  try { fs.mkdirSync(path.dirname(LLAMA_KEY_FILE), { recursive: true }); fs.writeFileSync(LLAMA_KEY_FILE, k + "\n", { mode: 0o600 }); } catch {}
  return k;
})();
if (PREFIX) PRESETS.local = {
  label: "端侧小模型（本机）", labelEn: "On-device model", group: "local", local: true,
  baseUrl: `http://127.0.0.1:${LLAMA_PORT}`, authStyle: "x-api-key", apiKey: LLAMA_KEY, defaultModel: null,
  // 手机上读一万多 token 的提示要几分钟：别让 claude 等两分钟就当超时。
  // 重试只给两次：本机服务挂了就是挂了，默认十次退避要白等三分钟
  extraEnv: { API_TIMEOUT_MS: "3000000", CLAUDE_CODE_MAX_RETRIES: "2" },
  hint: "用本机的 llama.cpp 跑小模型聊天，不联网、不花钱。手机算力有限，干活请用云端模型。",
  hintEn: "Chat with a small model running on this device via llama.cpp — offline and free. Phone hardware is limited; use a cloud model for real work.",
};
// 预置条目只从配置文件里取这些"属于用户"的字段；其余（名字、线路表、端点）以目录为准，
// 这样旧配置里抄死的 label/baseUrl 不会把目录更新挡住。自定义条目则整条都是用户的。
const USER_FIELDS = ["apiKey", "apiKeyEnv", "endpoint", "defaultModel", "fastModel", "extraEnv", "inlineImages"];

/** 配置文件里的模型清单也要过一遍形状：它和自定义厂商一样是用户可以手改/分享进来的。
 *  坏条目（null、缺 id、effort.supported_levels 不是数组）会让 /model、/effort 和每轮启动抛 TypeError（审查 11-05）。 */
const cleanModel = (m) => {
  if (!m || typeof m !== "object") return null;
  const id = typeof m.id === "string" ? m.id.trim().slice(0, 200) : "";
  if (!id) return null;
  const out = { ...m, id, name: typeof m.name === "string" ? m.name.slice(0, 200) : id };
  const lv = out.effort && out.effort.supported_levels;
  if (out.effort && typeof out.effort === "object" && Array.isArray(lv))
    out.effort = { ...out.effort, supported_levels: lv.filter((x) => typeof x === "string").slice(0, 32) };
  else delete out.effort;
  for (const k of ["context_window", "max_output_tokens"]) if (!Number.isFinite(out[k]) || out[k] < 0) delete out[k];
  if (!Array.isArray(out.input_modalities)) delete out.input_modalities;
  return out;
};
const cleanModels = (a) => Array.isArray(a) ? a.slice(0, 500).map(cleanModel).filter(Boolean) : [];

/** 合成一条生效配置：目录 + 用户字段 + 所选线路 */
// 配置文件能手改、能分享导入：这几个字段该是字符串的不是（数字、对象、数组），拼进 --model / 环境变量 / 地址时
// 每一轮起跑就失败。先从 raw 里拿掉，内置条目就用目录 / 线路里的值，自定义条目当没填（0.6.9 审计 199-5-03）
const STR_FIELDS = ["defaultModel", "fastModel", "endpoint", "apiKey", "apiKeyEnv", "baseUrl", "modelsUrl"];
function cleanRaw(id, raw) {
  if (!raw || !STR_FIELDS.some((k) => raw[k] != null && typeof raw[k] !== "string")) return raw;
  const out = { ...raw };
  for (const k of STR_FIELDS) if (out[k] != null && typeof out[k] !== "string") { log(`⚠️ 接口 ${id} 的 ${k} 不是字符串，不用`); delete out[k]; }
  return out;
}
function composeProvider(id, raw) {
  const pre = PRESETS[id];
  raw = cleanRaw(id, raw);
  let v;
  if (pre) {
    v = { ...pre };
    for (const k of USER_FIELDS) if (raw && raw[k] != null && raw[k] !== "") v[k] = raw[k];
    if (pre.local) v.apiKey = LLAMA_KEY;    // 旧配置里存的占位 "local" 不算数
    // 旧配置里自己攒的模型清单（带真实窗口）比目录里的全，留着
    if (raw && Array.isArray(raw.fallbackModels) && raw.fallbackModels.length) v.fallbackModels = cleanModels(raw.fallbackModels);
  } else {
    v = { group: "custom", authStyle: "bearer", modelsAuth: "bearer", ...raw, custom: true };
    // 这几个是内置条目才有的身份标志，自定义条目（能分享导入）自己写了也不认：
    // explicit:false 会让密钥回落到 DeepSeek 那把、送去它的地址；local/login 会关掉地址修正和防护提示（11-04 报告）
    for (const k of ["id", "explicit", "login", "local", "nativeModels"]) delete v[k];
  }
  // 自定义条目整条来自 raw，fallbackModels 也要清洗
  if (Array.isArray(v.fallbackModels)) v.fallbackModels = cleanModels(v.fallbackModels);
  // 线路表只认数组里像样的条目：自定义条目整条来自配置文件，endpoints 写成对象 / 字符串时 .find 抛错，
  // 而这里在模块加载时就跑 —— 网关启动即崩、重启再崩（0.6.9 审计 P1-15）
  if (v.endpoints != null) {
    v.endpoints = Array.isArray(v.endpoints) ? v.endpoints.filter((e) => e && typeof e === "object" && typeof e.id === "string" && typeof e.baseUrl === "string") : [];
    if (!v.endpoints.length) delete v.endpoints;
  }
  if (v.endpoints && v.endpoints.length) {
    const hit = v.endpoints.find((e) => e.id === v.endpoint);
    // 记着的线路已经不在了（厂商目录更新删了它）：照旧显示第一条，但不带旧 Key 过去——那把 Key 是给原线路的，
    // 新线路可能是另一个地区 / 另一家主机（0.6.9 审计 196-凭据.1）。用户重选线路、重填 Key 后恢复
    if (v.endpoint && !hit) v.endpointLost = v.endpoint;
    const ep = hit || v.endpoints[0];
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

// 三张表都不带原型：id 是外面传进来的，providers["constructor"] / PRESETS["__proto__"] 不能被当成认识的厂商（v0514 审查低-4）
Object.setPrototypeOf(PRESETS, null);
const bare = (o) => Object.assign(Object.create(null), o);
let PROVIDERS_RAW = { active: null, providers: bare({}) };   // 配置文件原样（只含用户字段与自定义条目）
let PROV_DISK_H = null;    // 盘上那份最后读写时的样子（见 providersDiskCheck）
const provHash = (s) => crypto.createHash("sha256").update(s).digest("hex");
/** 配置文件的形状：顶层是对象，providers 是对象、每条也是对象（别的丢掉） */
function provShape(j) {
  if (!isObj(j)) return undefined;
  const providers = bare({});
  if (isObj(j.providers)) for (const [k, v] of Object.entries(j.providers)) if (isObj(v)) providers[k] = v;
  return { ...j, providers };
}
function loadProviders() {
  // 读坏了（语法错、形状不对）：原文件留底成 .bad-*（厂商 Key 都在里面），按空表起。
  // 以前是静默回落空表，下一次保存就把整份连 Key 一起覆盖掉（0.6.9 审计 P1-1）
  const r = loadState(PROVIDERS_FILE, { shape: provShape, fallback: () => null, max: 4 << 20 });
  if (r.data) {
    PROVIDERS_RAW = r.data;
    const raw = readSmallFile(PROVIDERS_FILE, 4 << 20);
    PROV_DISK_H = raw == null ? null : provHash(raw);
  } else if (r.bad) PROV_DISK_H = null;
  const providers = bare({});
  for (const id of Object.keys(PRESETS)) providers[id] = composeProvider(id, PROVIDERS_RAW.providers[id]);
  for (const [id, raw] of Object.entries(PROVIDERS_RAW.providers)) {
    if (!PRESETS[id] && raw && raw.baseUrl) providers[id] = composeProvider(id, raw);
  }
  const active = providers[PROVIDERS_RAW.active] ? PROVIDERS_RAW.active : (PREFIX ? "anthropic" : "deepseek");
  return { active, providers };
}
function saveProvidersRaw() {
  // 随机、独占且不跟随链接的临时文件；旧固定 .tmp 或碰撞文件都不能接收凭据。
  const temp = PROVIDERS_FILE + "." + crypto.randomBytes(12).toString("hex") + ".tmp";
  let fd, created = false;
  try {
    fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    created = true;
    const out = JSON.stringify(PROVIDERS_RAW, null, 2);
    fs.writeFileSync(fd, out);
    fs.fsyncSync(fd);     // 先落盘再换名：掉电时不会换上一个还没写进去的空文件（密钥都在这里）
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, PROVIDERS_FILE);
    PROV_DISK_H = provHash(out);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (created) { try { fs.unlinkSync(temp); } catch {} }
  }
  PROVIDERS_CFG = loadProviders();
}
/** 网关跑着时厂商配置以内存为准：盘上被别人改了（换接口地址就能把密钥送出去），按内存写回，返回 true（调用方记留痕）。
 *  网关没跑时改的，启动时照常读进来 */
export function providersDiskCheck() {
  if (PROV_DISK_H == null) return false;
  const raw = readSmallFile(PROVIDERS_FILE, 4 << 20);
  if (raw != null && provHash(raw) === PROV_DISK_H) return false;
  try { saveProvidersRaw(); return true; } catch (e) { log(`[厂商配置] 写回失败：${e.message}`); return false; }
}
export let PROVIDERS_CFG = loadProviders();
// 受控修复会重写整表，必须核对整份原始配置，包括删除的字段、无关接口和 active。
export const providersDiskMatches = (disk) => isDeepStrictEqual(disk, { ...PROVIDERS_RAW, providers: { ...PROVIDERS_RAW.providers } });

/** 给界面看的一家：密钥只露末四位 */
function providerView(id, v) {
  const key = String(v.apiKey || "").trim();
  return {
    id, label: v.label || id, labelEn: v.labelEn || "", group: v.group || "custom", custom: !!v.custom,
    login: !!v.login, nativeModels: !!v.nativeModels, local: !!v.local,
    baseUrl: v.baseUrl || "", modelsUrl: v.modelsUrl || "", authStyle: v.authStyle || "bearer",
    endpoints: (v.endpoints || []).map((e) => ({ id: e.id, label: e.label, labelEn: e.labelEn || "" })), endpoint: v.endpoint || null,
    defaultModel: v.defaultModel || null, fastModel: v.fastModel || null, inlineImages: !!v.inlineImages, contextWindow: Number(v.contextWindow) || 0,
    extraModels: v.custom ? extraModelsOf(v) : [],
    keyUrl: v.keyUrl || null, hint: v.hint || "", hintEn: v.hintEn || "",
    hasKey: !!key, keyTail: key ? key.slice(-4) : "", endpointLost: v.endpointLost || null,   // 记着的线路不在了：界面提示重选（196-凭据.1）
    plainHttp: plainRemote(v.baseUrl),   // 远程明文 http：Key 明文过网，只警告不拦（0.6.9 审计 199-9-02，用户定）
    active: id === PROVIDER.id,
  };
}

/** home 下网关自己的状态文件（会话钉选、项目、定时任务、设置…）里还记着的最大 custom-N。只是数号，读不了的跳过 */
function maxCustomReferenced() {
  let n = 0;
  let names = []; try { names = fs.readdirSync(CFG.home).filter((f) => /^ccapp-.*\.json$/.test(f)); } catch {}
  for (const f of names) {
    const raw = readSmallFile(path.join(CFG.home, f), 8 << 20);
    if (raw) for (const m of raw.matchAll(/"custom-(\d{1,9})"/g)) n = Math.max(n, Number(m[1]));
  }
  return n;
}

export function upsertProvider(id, b, prepare) {
  const isNew = !id;
  if (isNew) {
    if (!b.baseUrl) return { error: "need_baseUrl", message: tz("自定义接口至少要填端点地址") };
    // 接口号只增不减（#122-1）：删掉的 custom-N 不再发给新接口，旧会话 / 项目 / 定时任务里记着的 id
    // 才不会在另一个端点上「复活」。老配置没有 nextCustom 时，从现有最大号接着往后数。
    let n = Number(PROVIDERS_RAW.nextCustom) || 0;
    for (const k of [...Object.keys(PRESETS), ...Object.keys(PROVIDERS_RAW.providers)]) {
      const m = /^custom-(\d+)$/.exec(k);
      if (m) n = Math.max(n, Number(m[1]));
    }
    // 老配置没有 nextCustom、最大号又刚被删掉时，上面数不到它：会话钉选、项目、定时任务、设置里还记着的 custom-N 也算进来，
    // 否则新接口拿到同一个号，旧会话 / 任务被悄悄送到新端点（0.6.9 审计 P1-8）
    n = Math.max(n, maxCustomReferenced());
    n += 1;
    while (PROVIDERS_RAW.providers["custom-" + n] || PRESETS["custom-" + n]) n++;
    id = "custom-" + n;
    PROVIDERS_RAW.nextCustom = n;
  }
  if (!PRESETS[id] && !PROVIDERS_RAW.providers[id] && !isNew) return { error: "unknown provider" };
  const cur = { ...(PROVIDERS_RAW.providers[id] || {}) };
  let keyCleared = false;
  const str = (v) => String(v == null ? "" : v).trim();
  // 预置厂商还没 Key、这次又什么都没给：别回「已保存」，其实什么都没配上（审查 P3-3）
  if (PRESETS[id] && !isNew && "apiKey" in b && !str(b.apiKey) && !cur.apiKey && !b.clearKey
    && !["endpoint", "defaultModel", "fastModel"].some((k) => k in b && str(b[k]) && str(b[k]) !== str(cur[k]))) return { error: "need_key", message: tz("先把 API Key 粘进来再保存") };
  if ("apiKey" in b && str(b.apiKey)) cur.apiKey = str(b.apiKey);   // 空串 = 不改（界面上不回显旧密钥）
  if (b.clearKey) delete cur.apiKey;
  // 图片随消息发（兼容兜底，见 inlineimg.mjs）：预置和自定义都能开
  if ("inlineImages" in b) { if (b.inlineImages === true) cur.inlineImages = true; else delete cur.inlineImages; }
  // 换线路时旧 Key 不能跟着走：Key 是按线路发的（cn / intl、按量 / 套餐往往不通用），没有依据默认两家通用。
  // 旧线路被目录删除时一直会清（196-凭据.1）；两条预置线路之间正常切换漏了，旧 Key 会随新线路域名发出去（FIND-050）。
  // 没记过线路 = 第一条线路，把第一条明确存回去不算换线路。
  const eps = PRESETS[id] && Array.isArray(PRESETS[id].endpoints) ? PRESETS[id].endpoints : null;
  if (eps && cur.apiKey && !("apiKey" in b && str(b.apiKey)) && "endpoint" in b) {
    const next = str(b.endpoint);
    const known = (x) => eps.some((e) => e && e.id === x);
    const oldLost = !!cur.endpoint && !known(cur.endpoint);
    const oldEff = oldLost || !cur.endpoint ? eps[0].id : cur.endpoint;   // 没记过线路时生效的就是第一条
    const nextEff = next ? (known(next) ? next : null) : eps[0].id;       // 空 = 回到第一条
    if (oldLost || (nextEff && nextEff !== oldEff)) {
      delete cur.apiKey;
      keyCleared = true;
    }
  }
  for (const k of ["endpoint", "defaultModel", "fastModel"]) if (k in b) { if (str(b[k])) cur[k] = str(b[k]); else delete cur[k]; }
  if (!PRESETS[id]) {
    for (const k of ["label", "baseUrl", "modelsUrl"]) if (k in b) cur[k] = str(b[k]);
    if ("authStyle" in b) cur.authStyle = b.authStyle === "x-api-key" ? "x-api-key" : "bearer";
    cur.modelsAuth = cur.authStyle || "bearer";
    // 上下文窗口（自己声明）：上游清单不报窗口、或者根本没清单时，默认/快速模型就按它算（#67）
    if ("contextWindow" in b) {
      const n = Number(b.contextWindow);
      if (b.contextWindow === null || b.contextWindow === "" || n === 0) delete cur.contextWindow;
      else if (Number.isInteger(n) && n >= 1024 && n <= 16777216) cur.contextWindow = n;
      else return { error: "bad_context_window", message: tz("上下文窗口填 1024 到 16777216 之间的整数，也可以写 256k、1m") };
    }
    // 另加的型号（接口卡「更多模型」）：[{ id, contextWindow }]，空数组 = 清掉
    if ("extraModels" in b) {
      const list = Array.isArray(b.extraModels) ? b.extraModels : null;
      if (!list || list.length > 64) return { error: "bad_extra_models", message: tz("更多模型最多 64 个") };
      for (const e of list) {
        const id = e && typeof e.id === "string" ? e.id.trim() : "", n = Number(e && e.contextWindow);
        if (!MODEL_ID_RE.test(id)) return { error: "bad_extra_models", message: tz("模型名不能有空格、逗号或控制字符，不超过 128 个字符：{id}", { id: String(e && e.id || "").slice(0, 40) }) };
        if (e.contextWindow && !(Number.isInteger(n) && n >= 1024 && n <= 16777216)) return { error: "bad_context_window", message: tz("上下文窗口填 1024 到 16777216 之间的整数，也可以写 256k、1m") };
      }
      const clean = extraModelsOf({ extraModels: list });
      if (clean.length) cur.extraModels = clean; else delete cur.extraModels;
    }
    if (!cur.label) cur.label = id;
    if (!/^https?:\/\//.test(cur.baseUrl || "")) return { error: "bad_baseUrl", message: tz("端点地址要以 http:// 或 https:// 开头") };
    cur.baseUrl = cur.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");   // claude 自己会补 /v1/messages
    // 改了端点（或模型清单）的主机、这次又没给新 Key：旧 Key 不能跟着送去新主机，清掉，要用户重新填（0.6.9 审计 P1-2）
    const host = (u) => { try { return new URL(u).host.toLowerCase(); } catch { return ""; } };
    const prev = PROVIDERS_RAW.providers[id] || {};
    const hostsOf = (v) => [host(v.baseUrl), host(v.modelsUrl)].filter(Boolean);
    if (!isNew && cur.apiKey && !("apiKey" in b && str(b.apiKey)) && hostsOf(cur).some((h) => !hostsOf(prev).includes(h))) {
      delete cur.apiKey;
      keyCleared = true;
    }
  }
  // 正在用这家的轮次已经拿了旧地址，密钥却是每次现读（apiKeyHelper / keyOf 按 id 取新的）：改连接会拼出「旧地址 + 新密钥」，
  // 和删除一样等它跑完（审查 B01）。只改默认型号、窗口、名字这些不碍事，照常放行
  const conn = (v) => [v.apiKey, v.baseUrl, v.authStyle, v.endpoint].map((x) => String(x || "")).join("\0");
  if (!isNew && conn(PROVIDERS_RAW.providers[id] || {}) !== conn(cur) && [...RUNS.values()].some((r) => !r.ended && r.provider === id))
    return { error: "busy", status: 409, message: tz("这一家正在用，等这一轮跑完再改地址或密钥。") };
  // 受管桥先持久化非秘密的旧/新指纹，再同步写接口；回调不接收密钥，HTTP 请求也不能提供它。
  const rollback = prepare?.(id), previous = PROVIDERS_RAW.providers[id];
  PROVIDERS_RAW.providers[id] = cur;
  try { saveProvidersRaw(); }
  catch (error) {
    if (previous === undefined) delete PROVIDERS_RAW.providers[id]; else PROVIDERS_RAW.providers[id] = previous;
    try { rollback?.(); } catch { log("[provider] 受管映射回滚未完成"); }
    throw error;
  }
  if (id === PROVIDER.id) applyProvider();
  dropModelCache();   // 会话可能钉在不是全局的这家上：哪家改了都清，免得清单/窗口还是旧的
  log(`[provider] 已保存 ${id}${"apiKey" in b && str(b.apiKey) ? "（含密钥）" : ""}`);
  return { ok: true, id, provider: providerView(id, PROVIDERS_CFG.providers[id]), ...(keyCleared ? { keyCleared: true } : {}),
    ...(plainRemote(cur.baseUrl) ? { plainHttp: true, warning: tz("这个地址是明文 http，密钥和对话内容会不加密地发到对方机器上；能用 https 就换成 https。") } : {}) };
}

/** 模型清单地址能不能带密钥去问：要 https、和接口地址同一个主机（审查 10-30 第九份 存疑4、v0.5.12 中1、v0.5.13 低1）。
 *  厂商配置能分享导入，别人塞个外站的 modelsUrl，一点「测试」或刷新型号就把密钥交出去了。
 *  以前按「同站点」放行，但共享后缀（动态域名、云存储、托管平台）列不全，总有两家无关租户被判成同站；内置厂商的清单都和接口同主机。
 *  不放行时最坏只是型号清单拉不到、改用试发消息验密钥 */
export function modelsUrlOk(p) {
  try {
    const m = new URL(p.modelsUrl), b = new URL(p.baseUrl);
    const h = m.hostname.toLowerCase().replace(/\.$/, "");
    if (h !== b.hostname.toLowerCase().replace(/\.$/, "")) return false;
    // 端口也要一样：同主机的别的端口可能是另一个服务（本机回环上尤其如此），不能把 Key 带过去（0.6.9 审计 196-凭据.2）
    if (m.port !== b.port) return false;
    // 本机跑的 llama-server / LiteLLM 多半是 http：回环地址出不了本机，https 要求没有意义（10-31 三轮复核）
    return m.protocol === "https:" || (loopHost(h) && m.protocol === "http:");
  } catch { return false; }
}
const loopHost = (h) => h === "localhost" || h === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(h);
/** 接口地址是不是发往别的机器的明文 http（Key 会明文过网）；本机回环不算 */
export function plainRemote(u) {
  try { const x = new URL(u); return x.protocol === "http:" && !loopHost(x.hostname.toLowerCase().replace(/\.$/, "")); } catch { return false; }
}

/** 带密钥的请求：不跟着跳到别的主机（x-api-key 这类自定义头 fetch 跨站跳转时不会替你剥掉）。
 *  同源的跳转最多跟 3 次；非 GET 只跟 307 / 308（方法和请求体原样保留，301/302/303 会被改成 GET）。跳到别处就当失败 */
export async function fetchKeyed(url, opts = {}) {
  let u = new URL(url);
  for (let i = 0; ; i++) {
    const r = await fetch(u, { ...opts, redirect: "manual" });
    if (r.status < 300 || r.status >= 400 || r.status === 304) return r;
    const loc = r.headers.get("location");
    let n = null;
    try { n = loc ? new URL(loc, u) : null; } catch {}
    if (!n || n.origin !== u.origin || i >= 3 || (opts.method && opts.method !== "GET" && r.status !== 307 && r.status !== 308)) {
      try { await r.body?.cancel(); } catch {}
      throw new Error(`HTTP ${r.status} redirect refused`);
    }
    try { await r.body?.cancel(); } catch {}
    u = n;
  }
}

/** 验密钥：有模型清单接口就拉清单（不花钱）；没有就发一条 max_tokens=1 的消息 */
// 上游的报错正文不受本机控制：个别网关会把收到的认证值原样写回 message 里。
// 测试错误要原样给界面看，就得先把本次用到的 Key 抹掉（UIFS-009）。太短的 Key 不替换，
// 免得把正常文案搅乱；真实厂商 Key 都远长于这个长度。
function redactKey(s, key) {
  const t = String(s == null ? "" : s);
  return key && key.length >= 8 ? t.split(key).join("…") : t;
}
export async function testProvider(id) {
  const v = PROVIDERS_CFG.providers[id];
  if (!v) return { ok: false, message: tz("没有这家厂商") };
  if (v.login) return { ok: false, message: tz("账户登录不用测密钥，看登录状态即可") };
  const key = String(v.apiKey || "").trim();
  if (!key) return { ok: false, message: tz("还没填密钥") };
  const auth = v.authStyle === "x-api-key"
    ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
    : { Authorization: `Bearer ${key}`, "anthropic-version": "2023-06-01" };
  // 拉清单用 modelsAuth，和平时拉清单（models.mjs fetchModels）同一套头：导入配置两者不同时以前会误报 401。
  // modelsAuth:"none" 的清单不带密钥，拉到了也说明不了密钥对不对，改成试发（0.6.9 审计 195-U.5）
  const mAuth = v.modelsAuth === "x-api-key" ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
    : v.modelsAuth === "none" ? null : { Authorization: `Bearer ${key}` };
  try {
    let r, how, viaModels = false;
    if (v.modelsUrl && mAuth && modelsUrlOk(v)) {
      how = "模型清单"; viaModels = true;
      r = await fetchKeyed(v.modelsUrl, { headers: mAuth, signal: AbortSignal.timeout(15000) });
    } else {
      how = "试发一条消息";
      r = await fetchKeyed(v.baseUrl.replace(/\/+$/, "") + "/v1/messages", {
        method: "POST", headers: { ...auth, "content-type": "application/json" }, signal: AbortSignal.timeout(30000),
        body: JSON.stringify({ model: v.defaultModel || "x", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
      });
    }
    let text;
    try { text = await fetchText(r); }
    catch (e) {
      // 响应体超过上限不是网络问题（FIND-020）：以前混进 catch 里报成「连不上」，把排查方向带偏
      if (/response too large/.test(String(e && e.message))) {
        return { ok: false, status: r.status, message: tz("地址回了 {s}，但响应体太大（超过 8 MB），没法确认密钥有效", { s: r.status }) };
      }
      throw e;
    }
    if (r.ok) {
      // 2xx 不等于有效：登录页 HTML、空体、200 包着的错误 JSON 以前都报「密钥有效」。要认得出是清单 / 是一条回复
      let j = null; try { j = JSON.parse(text); } catch {}
      const err = j && typeof j === "object" && (j.error || j.type === "error" || j.success === false) ? (j.error?.message || j.message || j.msg || (typeof j.error === "string" ? j.error : "")) : null;
      const shaped = j && typeof j === "object" && !Array.isArray(j) && err === null && (viaModels
        ? Array.isArray(j.data) || Array.isArray(j.models)
        : j.type === "message" || Array.isArray(j.content));
      if (shaped) {
        const n = viaModels ? normalizeModels(j).length : 0;
        return { ok: true, message: n ? tz("密钥有效（{how}，{n} 个模型）", { how, n }) : tz("密钥有效（{how}）", { how }) };
      }
      const what = err ? redactKey(String(err), key).slice(0, 200) : (text.trim() ? redactKey(text.trim(), key).slice(0, 120) : tz("（空）"));
      return { ok: false, status: r.status, message: tz("地址回了 {s}，但不是预期的格式，没法确认密钥有效：{what}", { s: r.status, what }) };
    }
    let msg = text.slice(0, 200);
    try { const j = JSON.parse(text); msg = j.error?.message || j.message || j.msg || msg; } catch {}
    msg = redactKey(String(msg == null ? "" : msg), key).slice(0, 200);   // 上游回显的认证值不外泄（UIFS-009）
    // 401 才是密钥问题；403 多半是地区 / 风控 / 防火墙拦的，不能一概说「密钥无效」（FIND-020）
    const why = r.status === 401 ? "密钥无效或与线路不匹配"
      : r.status === 403 ? "服务器拒绝访问（403）：可能是地区、网络或防火墙限制，不一定是密钥问题"
      : `HTTP ${r.status}`;
    // 聚合平台（如 opencode Zen）同一个型号可能只走 OpenAI 协议：报 "does not support this protocol"。议题 #23
    const hint = /support(s|ed)? (this|the) protocol|unsupported protocol/i.test(msg) ? tz("（这个型号在这个地址上不支持 Anthropic 协议：换一个支持的型号，或换成平台给 Claude Code 用的那个地址）") : "";
    return { ok: false, status: r.status, message: `${why}：${msg}${hint}` };
  } catch (e) {
    return { ok: false, message: tz("连不上：{err}", { err: redactKey(e.message, key) }) };
  }
}
// ── 余额与消费（设置页的厂商卡片）────────────────────────────────────
// 余额：问平台（各家接口不一样，没开放的就没有）。
// 消费：没有一家给 API Key 开放账单接口，只能自己记 —— 每次查到余额记一笔，比上次少了就是花掉的，
//       多了是充值（不算消费）。算的是整个账号的真实花费，同一把 Key 在别处用掉的也算。
// token：每轮结束按 claude 报的用量记一笔，所有厂商都有（查不了余额的平台就看这个）。
const BILL_FILE = path.join(CFG.home, "ccapp-billing.json");
// 账本缺字段时 noteTokens 会抛异常，而 server.mjs 不接 uncaughtException（整条 result 会带崩网关）。
// 读进来先补成完整形状；整体不是对象就按空账本处理。
function billShape(j) {
  if (!j || typeof j !== "object" || Array.isArray(j)) return {};
  for (const [id, b] of Object.entries(j)) {
    if (!b || typeof b !== "object" || Array.isArray(b)) { delete j[id]; continue; }
    // 数组元素也要校验：noteTokens/noteBalance 直接按下标读，null/字符串会抛 TypeError 带崩网关
    if (!Array.isArray(b.spends)) b.spends = [];
    else b.spends = b.spends.filter((x) => Array.isArray(x) && x.length >= 2 && Number.isFinite(x[0]) && Number.isFinite(x[1]));
    if (!Array.isArray(b.tok)) b.tok = [];
    else b.tok = b.tok.filter((x) => Array.isArray(x) && x.length >= 4 && Number.isFinite(x[0]) && Number.isFinite(x[1]) && Number.isFinite(x[2]) && Number.isFinite(x[3]));
    if (!b.tokOld || typeof b.tokOld !== "object") b.tokOld = { in: 0, out: 0, cache: 0 };
    else for (const k of ["in", "out", "cache"]) if (typeof b.tokOld[k] !== "number") b.tokOld[k] = 0;
    if (typeof b.spentOld !== "number") b.spentOld = 0;
    if (typeof b.since !== "number") b.since = Date.now();
  }
  return j;
}
// 账本用无原型对象：provider id 为 __proto__ 时不能把 since/spends/tok 写到 Object.prototype
// 语法坏了 / 太大：原文件留底成 .bad-*，不再当空账本、500ms 后整份写回把消费历史清零（0.6.9 审计 195-Z.5）
let BILL = (() => { const out = Object.create(null); Object.assign(out, loadState(BILL_FILE, { shape: (j) => (isObj(j) ? billShape(j) : undefined) }).data); return out; })();
let billSaveT = null;
// 直接写目标文件会先截断：写一半被杀/满盘就把整个账本毁了，下次启动只能当空账本。临时文件 + fsync + 换名
const flushBill = () => { if (!billSaveT) return; clearTimeout(billSaveT); billSaveT = null; saveState(BILL_FILE, BILL, { pretty: false }); };
const saveBill = () => { clearTimeout(billSaveT); billSaveT = setTimeout(flushBill, 500); };
onShutdown("账本", flushBill);   // SIGTERM 时防抖还没到点的也写下去（195-W.2）
const billOf = (id) => {
  const b = (BILL[id] ||= {});
  b.since ||= Date.now(); b.spends ||= []; b.spentOld ||= 0; b.tok ||= []; b.tokOld ||= { in: 0, out: 0, cache: 0 };
  return b;
};
const KEEP_MS = 92 * 86400e3;   // 明细留三个月，更早的并进累计

/** 按端点认平台。认不出的（含自定义）就只记 token */
// 余额查询会把这家的密钥发到下面固定的官方主机：只认主机名完全一致的 https 地址。
// 以前按网址子串认，api.deepseek.com.example.net 这种代理地址会被当成官方，密钥被发去官方主机（GHSA-4cfj）
const BILL_HOSTS = {
  "api.deepseek.com": { kind: "deepseek" },
  "api.moonshot.cn": { kind: "kimi", host: "https://api.moonshot.cn", currency: "CNY" },
  "api.moonshot.ai": { kind: "kimi", host: "https://api.moonshot.ai", currency: "USD" },
  "open.bigmodel.cn": { kind: "glm", host: "https://open.bigmodel.cn" },
  "api.z.ai": { kind: "glm", host: "https://api.z.ai" },
  "openrouter.ai": { kind: "openrouter", currency: "USD" },
};
export function billKind(v) {
  let u; try { u = new URL(String(v.baseUrl || "")); } catch { return { kind: "none" }; }
  if (u.protocol !== "https:" || u.username || u.password) return { kind: "none" };
  const hit = Object.hasOwn(BILL_HOSTS, u.hostname) ? BILL_HOSTS[u.hostname] : null;
  return hit ? { ...hit } : { kind: "none" };
}

async function fetchJson(url, headers) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  const text = await fetchText(r);
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

// 账户身份：同一家接口换了 Key（或地址）就是另一个账户，两个账户的余额差不是消费（#135）。只存哈希的前 16 位
const acctOf = (v) => crypto.createHash("sha256").update(String(v.baseUrl || "") + "\0" + String(v.apiKey || "").trim()).digest("hex").slice(0, 16);
/** 记一次余额：比上次少 → 消费；多 → 充值（只更新基准） */
function noteBalance(id, cur, bal, acct) {
  if (!Number.isFinite(bal)) return;
  const b = billOf(id);
  // 升级前记的基准没有账户指纹：分不清是不是同一个账户，重新起算一次（宁可少记这一笔，也别把两个账户的差额记成消费）
  if (acct && b.last && b.last.acct !== acct) { b.last = null; log(`[账本] ${id} 换了账户（或基准是升级前记的），余额基准重新起算`); }
  if (b.currency && b.currency !== cur) {
    // 换了币种（换了线路、双币余额谁多换了）：余额基准重新起算；已记的消费是旧币种的，不能直接贴上新币种（#102 04-009）。
    // 人民币/美元之间按手上的汇率折过去；折不了就把旧账本收起来另存，从零记
    b.last = null;
    const r = FX && FX.rate, k = r && b.currency === "CNY" && cur === "USD" ? 1 / r : r && b.currency === "USD" && cur === "CNY" ? r : 0;
    if (k) { b.spends = b.spends.map(([t, v]) => [t, +(v * k).toFixed(6)]); b.spentOld = +(b.spentOld * k).toFixed(6); }
    else if (b.spends.length || b.spentOld) {
      (b.oldLedgers ||= []).push({ currency: b.currency, spent: +(b.spentOld + b.spends.reduce((a, x) => a + x[1], 0)).toFixed(6), until: Date.now() });
      if (b.oldLedgers.length > 10) b.oldLedgers.shift();
      b.spends = []; b.spentOld = 0;
    }
    log(`[账本] ${id} 币种 ${b.currency} → ${cur}${k ? "，旧消费按汇率折算" : "，旧账本另存"}`);
  }
  b.currency = cur;
  const now = Date.now();
  if (b.last && Number.isFinite(b.last.bal)) {
    const d = +(b.last.bal - bal).toFixed(6);
    if (d > 0) b.spends.push([now, d]);
    else if (d < 0) b.topups = (b.topups || 0) + 1;
  }
  b.last = { at: now, bal, ...(acct ? { acct } : {}) };
  const cut = now - KEEP_MS;
  while (b.spends.length && b.spends[0][0] < cut) b.spentOld += b.spends.shift()[1];
  saveBill();
}

/** 一轮结束记 token（按小时合并） */
export function noteTokens(id, u) {
  if (!id || !u) return;
  noteAdd(id, [u.input_tokens || 0, u.output_tokens || 0, (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)]);
}
/** 运行中的计量（usage.mjs usageMeter）每涨一次记一笔：d.i 是含缓存的输入、d.c 是其中读缓存的、d.o 输出。
 *  以前等 result 才按 result.usage 记：子代理的不在里面、中断的那轮没有 result、跨小时的全算到结束那个小时（0.6.9 审计 195-O.1/O.3/O.4）。
 *  写缓存的那部分并进输入（计量里分不出来） */
export function noteTokenDelta(id, d) {
  if (!id || !d) return;
  const add = [Math.max(0, (d.i || 0) - (d.c || 0)), d.o || 0, d.c || 0];
  if (add[0] || add[1] || add[2]) noteAdd(id, add);
}
function noteAdd(id, add) {
  const b = billOf(id);
  const hour = Math.floor(Date.now() / 3600e3) * 3600e3;
  const last = b.tok[b.tok.length - 1];
  if (last && last[0] === hour) for (let i = 0; i < 3; i++) last[i + 1] += add[i];
  else b.tok.push([hour, ...add]);
  const cut = Date.now() - KEEP_MS;
  while (b.tok.length && b.tok[0][0] < cut) { const x = b.tok.shift(); b.tokOld.in += x[1]; b.tokOld.out += x[2]; b.tokOld.cache += x[3]; }
  saveBill();
}

// 汇率：界面货币跟语言走（中文显示人民币，其余显示美元），账户币种不同时按汇率换算并标「≈」。半天取一次
// 取不到时退避（0.6.9 审计 195-E.11：以前每次 /api/billing 都重新去等，离线时每次多等十几秒）：
// 失败后 1 分钟内不再试，连续失败翻倍到 1 小时；同时只有一个请求在路上，后来的等它
let FX = null, FX_FAIL = 0, FX_NEXT = 0, FX_FLY = null;
export async function usdCny() {
  if (FX && Date.now() - FX.at < 12 * 3600e3) return FX;
  if (Date.now() < FX_NEXT) return FX;
  if (FX_FLY) return FX_FLY;
  FX_FLY = (async () => {
    try {
      const j = await fetchJson("https://open.er-api.com/v6/latest/USD", {});
      if (j.result === "success" && j.rates && j.rates.CNY) { FX = { rate: +j.rates.CNY, at: Date.now(), src: "open.er-api.com" }; FX_FAIL = 0; return FX; }
      throw new Error("返回不对");
    } catch (e) {
      FX_FAIL++; FX_NEXT = Date.now() + Math.min(3600e3, 60e3 * 2 ** (FX_FAIL - 1));
      log(`汇率获取失败：${e.message}（${Math.round((FX_NEXT - Date.now()) / 60e3)} 分钟内不再试）`);
      return FX;
    } finally { FX_FLY = null; }
  })();
  return FX_FLY;
}

const BAL_CACHE = new Map();   // id → { at, acct, data }
async function billingInfo(id, force) {
  const v = PROVIDERS_CFG.providers[id];
  if (!v) return { error: tz("没有这家厂商") };
  const k = billKind(v);
  const out = { id, kind: k.kind, hasKey: !!String(v.apiKey || "").trim() };
  if (k.kind !== "none" && out.hasKey) {
    const c = BAL_CACHE.get(id), acct = acctOf(v);   // 查之前取定：查的途中换了 Key，这次结果也算在查的那个账户上
    if (!force && c && c.acct === acct && Date.now() - c.at < 60000) Object.assign(out, c.data);
    else {
      try {
        const d = await queryBalance(v, k);
        if (d && d.currency && Number.isFinite(d.balance)) noteBalance(id, d.currency, d.balance, acct);
        BAL_CACHE.set(id, { at: Date.now(), acct, data: { ...(d || {}), balanceAt: Date.now() } });
        Object.assign(out, d || {}, { balanceAt: Date.now() });
      } catch (e) { out.balanceError = redactKey(e.message, String(v.apiKey || "").trim()); }   // 上游报错回显的 Key 不进设置页（UIFS-009 扩到余额）
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
  if (p && p.endpointLost) return null;   // 线路失配：哪把 Key 都不带（196-凭据.1）
  if (p && p.apiKey) return String(p.apiKey).trim();

  // 显式配置过的厂商（ccapp-providers.json 里有它一条），密钥就只认它自己那一条。
  // ⚠️ 这里的"留空"是**故意的**，不是"没配"：官方账户条目留空 = 不注入任何密钥，
  //    让 claude 用 ~/.claude/.credentials.json 里的登录态。
  //    以前没有这道闸，留空会一路回落到 ccapp-config.json —— 那里面躺的是 DeepSeek 的钥匙，
  //    于是切到官方账户时被注成 ANTHROPIC_API_KEY（它优先级高于登录态），
  //    拿 DeepSeek 钥匙打 api.anthropic.com，全网 401。
  if (p && p.explicit) {
    // apiKeyEnv 只认内置厂商的（地址是我们定的）；自定义接口的配置能分享导入，填个别的变量名就把网关环境里的值送去它的地址（v0513b 低-1）
    if (p.apiKeyEnv && !p.custom && /^[A-Z][A-Z0-9_]{0,63}$/.test(p.apiKeyEnv) && process.env[p.apiKeyEnv]) return String(process.env[p.apiKeyEnv]).trim();
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
  // 共享区的种子只给开发端（claude-apk）用：cccodroid 从不往那里放密钥，却会在没配密钥时去读 ——
  // 别的应用往那里写一把自己的 key，用户的对话就全走它的账、它在控制台看得到全部提示词（审查 中6）。
  // 显式给了 CCAPP_SEED 的照旧
  if (PREFIX && !process.env.CCAPP_SEED) return null;
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
 *  模型清单缓存无需在此清除 —— 缓存按接口配置指纹存取（models.mjs 的 sigOf），
 *  换厂商自然对不上。 */
export function applyProvider() {
  PROVIDER = resolveProvider();
  CFG.upstream = PROVIDER.baseUrl || BUILTIN_PROVIDER.baseUrl;
  API_KEY = loadApiKey(PROVIDER);
}

// PERM_MODES 挪到 config.mjs：settings.mjs 加载时就要用，放这里会因循环依赖在单独导入时撞上暂时性死区（审查 10-30 v0.5.12 低5）
export { PERM_MODES } from "./config.mjs";

// id / explicit 放最后：条目里自带的同名字段不能盖过它们（见 composeProvider）
function pickProvider(id) { return { ...PROVIDERS_CFG.providers[id], id, explicit: !!PROVIDERS_RAW.providers[id] || id !== BUILTIN_PROVIDER.id }; }
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
    return sendJson(res, r.error ? r.status || 400 : 200, r);
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
    return sendJson(res, r.error ? r.status || 400 : 200, r);
  }
  if (req.method === "POST" && p === "/api/providers/delete") {
    const b = JSON.parse((await readBody(req)) || "{}");
    const id = String(b.id || "");
    if ([...RUNS.values()].some((r) => !r.ended && r.provider === id)) return sendJson(res, 409, { error: "busy", message: tz("这一家正在用，等这一轮跑完再删。") });
    const previous = PROVIDERS_RAW.providers[id];
    if (!PRESETS[id] && !previous) return sendJson(res, 404, { error: "unknown provider" });
    const wasActive = id === PROVIDER.id;   // 在 applyProvider() 换掉当前厂商之前记下
    // 预置厂商删不掉，只清空用户字段（密钥等）；自定义的整条删掉
    delete PROVIDERS_RAW.providers[id];
    const resetSettings = !PRESETS[id] && SETTINGS.provider === id;
    const settingsOld = resetSettings ? { provider: SETTINGS.provider, model: SETTINGS.model } : null;
    if (resetSettings) { SETTINGS.provider = null; SETTINGS.model = null; }
    try {
      saveProvidersRaw();
    } catch (e) {
      // 写盘失败：把它放回内存里的原始表，和磁盘（没变）保持一致；这样再删一次还是这家，不会 404，
      // 也不会被之后保存别的接口时顺手写死（#122-5）
      if (previous === undefined) delete PROVIDERS_RAW.providers[id]; else PROVIDERS_RAW.providers[id] = previous;
      if (settingsOld) { SETTINGS.provider = settingsOld.provider; SETTINGS.model = settingsOld.model; }
      throw e;
    }
    if (resetSettings) saveSettings();   // 接口已经删掉了；设置即使没写进去，加载时也会按「那家不在了」回落
    applyProvider();
    dropModelCache();
    // claude 每次要钥匙都读 .cache 里的密钥文件；接口都删了，缓存不能继续留着（FIND-052）
    try { (await import("./claude.mjs")).clearKeyCache(id, wasActive); }
    catch (e) { log(`[provider] 清理密钥缓存失败：${e.message}`); }
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

// 设置已在 settings-store.mjs 载入；本模块的变量此时都已初始化，在这里解析生效厂商（原来在 settings.mjs 顶层调，单独导入时会撞死区）
applyProvider();
export const _billForTest = { noteBalance, billOf, billShape, noteTokens };   // 只给测试用
