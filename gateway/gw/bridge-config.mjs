import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import { CFG, PREFIX, log, tz } from "./config.mjs";
import { componentEnv as sharedComponentEnv } from "./component-env.mjs";
import { readBodyBuf, sendJson } from "./http.mjs";
import { RUNS } from "./runs.mjs";
import { PROVIDERS_CFG, upsertProvider, providersDiskMatches } from "./providers.mjs";
import { beginManagedBridgeConfiguration, withManagedBridgeRegistryLock } from "./managed-bridge.mjs";

const ID = "openai-bridge", ENTRY = "lib/openai-bridge/component.cjs";
const MODELS_MAX_BYTES = 128 << 10, CONFIG_MAX_BYTES = 128 << 10, CONFIG_MODEL_LIMIT = 100;
const DEFAULT_CONTEXT_WINDOW = 200000;
const validModel = (id) => typeof id === "string" && !!id.trim() && id === id.trim() && id.length <= 200 && !/[,\u0000-\u001f\u007f-\u009f]/.test(id);
const LOCAL_ERRORS = ["RECOVERY_EXHAUSTED", "PATCH_VERIFICATION_FAILED", "COMPONENT_DISABLED", "LOCAL_START_FAILED", "COMPONENT_UNAVAILABLE", "UPDATE_REQUIRED"];
const COMPONENT_ERRORS = ["INVALID_INPUT", "KEY_REQUIRED", "KEY_HOST_CHANGED", "RUNTIME_CONFLICT", "BUSY", ...LOCAL_ERRORS];
const CONFIG_CHECKS = ["COMPONENT", "OWNERSHIP", "CONNECTION", "APP_MAPPING", "APP_PROVIDER", "MODEL_LIST"];
const conflict = (check) => Object.assign(failure("RUNTIME_CONFLICT"), { check });
const modelsUnavailable = () => tz("暂时无法读取模型清单，可重试或手填模型。");
const MODELS_ERRORS = {
  MODELS_AUTH: () => tz("API Key 未获授权，请检查后重试。"),
  MODELS_FORBIDDEN: () => tz("服务拒绝读取模型清单，请检查权限或手填模型。"),
  MODELS_NOT_FOUND: () => tz("服务不支持读取模型清单，请手填模型名称。"),
  MODELS_RATE_LIMIT: () => tz("读取模型清单过于频繁，请稍后重试。"),
  MODELS_TIMEOUT: () => tz("读取模型清单超时，可重试或手填模型。"),
  MODELS_NETWORK: modelsUnavailable,
  MODELS_INVALID_RESPONSE: modelsUnavailable,
  MODELS_TOO_LARGE: modelsUnavailable,
  MODELS_REDIRECT: modelsUnavailable,
  MODELS_FAILED: modelsUnavailable,
};
const MODELS_ERROR_CODES = Object.keys(MODELS_ERRORS);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const safeRel = (value) => typeof value === "string" && value.length > 0 && !value.includes("\0") && !value.includes("\\") &&
  !path.isAbsolute(value) && value.split("/").every((part) => part && part !== "." && part !== "..");

function failure(code, field = "") {
  const error = new Error(MODELS_ERROR_CODES.includes(code) ? MODELS_ERRORS[code]() : code === "RUNTIME_CONFLICT"
    ? tz("桥配置一致性检查未通过，暂不能安全读取或保存；请查看检查说明，不要先删目录或卸载。")
    : tz("桥配置未完成，请检查字段或组件状态后重试；当前会话保持不变。"));
  error.code = code;
  error.field = field;
  return error;
}

// 只补全根地址或 /v1；私有路径必须由用户完整给出，不能猜测或向远端探测。
export function normalizeBridgeEndpoint(value) {
  if (typeof value !== "string" || value.length > 2048 || /[\u0000- \u007f\\]/.test(value)) throw failure("invalid_endpoint", "endpoint");
  let url;
  try { url = new URL(value); } catch { throw failure("invalid_endpoint", "endpoint"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw failure("invalid_endpoint", "endpoint");
  const pathname = url.pathname.replace(/\/+$/, "");
  if (!pathname || pathname === "/v1") url.pathname = "/v1/chat/completions";
  else if (pathname.endsWith("/chat/completions")) url.pathname = pathname;
  else throw failure("unsupported_path", "endpoint");
  return url.href;
}

function regularJson(file, max) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.size > BigInt(max)) throw failure("invalid_component");
    const bytes = Buffer.alloc(Number(stat.size) + 1);
    let length = 0, n;
    while (length < bytes.length && (n = fs.readSync(fd, bytes, length, bytes.length - length, null))) length += n;
    const after = fs.fstatSync(fd, { bigint: true });
    if (length !== Number(stat.size) || ["dev", "ino", "mode", "size", "mtimeNs", "ctimeNs"].some((k) => stat[k] !== after[k])) throw failure("invalid_component");
    return JSON.parse(bytes.subarray(0, length).toString("utf8"));
  } finally { fs.closeSync(fd); }
}

function componentEntry() {
  if (!PREFIX) throw failure("not_installed");
  try {
    const rec = regularJson(path.join(path.dirname(PREFIX), "components", ID + ".json"), 4 << 20);
    if (!object(rec) || rec.id !== ID || rec.state !== "ok" || !Array.isArray(rec.files) ||
        !rec.files.includes(ENTRY) || !rec.files.every(safeRel)) throw failure("invalid_component");
    const prefix = fs.realpathSync(PREFIX), root = fs.realpathSync(path.join(PREFIX, "lib", ID));
    const entry = path.join(PREFIX, ENTRY);
    if (root !== path.join(prefix, "lib", ID) || fs.realpathSync(entry) !== path.join(root, "component.cjs")) throw failure("invalid_component");
    const st = fs.lstatSync(entry);
    if (!st.isFile() || st.isSymbolicLink()) throw failure("invalid_component");
    return entry;
  } catch { throw failure("not_installed"); }
}

// HOME 是信任根：宿主给的若是别名（/data/data ↔ /data/user/0），在根这一层规范成真实路径，
// 组件拿到的 HOME、manifest 里的 target、这里的归属检查才是同一个；根以下各级仍逐级要求不是链接（#66 第 4 项）
const HOME_ROOT = () => { try { return fs.realpathSync(CFG.home); } catch { return CFG.home; } };
const componentEnv = () => sharedComponentEnv(HOME_ROOT(), PREFIX);

function stopLauncher(child, signal) {
  if (!child?.pid) return;
  const groups = new Set();
  if (child.exitCode === null && child.signalCode === null) groups.add(child.pid);
  // 只取消固定入口的短命 session；已 setsid 的常驻服务不在其中，不能按后代树误杀。
  try {
    for (const name of fs.readdirSync("/proc")) {
      if (!/^[1-9][0-9]*$/.test(name)) continue;
      try {
        const stat = fs.readFileSync(`/proc/${name}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
        if (Number(fields[3]) === child.pid && Number(fields[2]) > 1) groups.add(Number(fields[2]));
      } catch {}
    }
  } catch {}
  for (const group of groups) try { process.kill(-group, signal); } catch {}
}

// 只收固定入口的一份有界 JSON；错误只提取白名单静态 code，不回传 stderr/异常/命令。
function invokeComponent(command, input, signal) {
  const isModels = command === "gui-models", abortSignal = isModels ? signal : undefined;
  if (abortSignal?.aborted) return Promise.reject(failure("MODELS_FAILED"));
  const entry = componentEntry();
  const stdoutLimit = isModels ? MODELS_MAX_BYTES : CONFIG_MAX_BYTES;
  const responseCode = isModels ? "MODELS_INVALID_RESPONSE" : "component_response";
  const failedCode = isModels ? "MODELS_FAILED" : "component_failed";
  return new Promise((resolve, reject) => {
    let child, timer, killTimer, settled = false, stopping = false, length = 0, errorLength = 0;
    const chunks = [], errors = [];
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(killTimer);
      abortSignal?.removeEventListener("abort", abort);
      child?.stdout?.destroy(); child?.stderr?.destroy();
      if (error) reject(error);
      else {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch { reject(failure(responseCode)); }
      }
    };
    const stop = (error) => {
      if (settled || stopping) return;
      stopping = true; clearTimeout(timer); stopLauncher(child, "SIGTERM");
      killTimer = setTimeout(() => { stopLauncher(child, "SIGKILL"); finish(error); }, 300);
    };
    const abort = () => stop(failure("MODELS_FAILED"));
    try { child = spawn(process.execPath, [entry, command], { env: componentEnv(), stdio: ["pipe", "pipe", "pipe"], detached: true }); }
    catch { finish(failure(isModels ? failedCode : "component_spawn")); return; }
    child.stdin.on("error", () => {});
    child.on("error", () => { if (!stopping) finish(failure(isModels ? failedCode : "component_spawn")); });
    child.stdout.on("data", (chunk) => {
      if (stopping || settled) return;
      length += chunk.length;
      if (length > stdoutLimit) { stop(failure(isModels ? "MODELS_TOO_LARGE" : responseCode)); return; }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (stopping || settled) return;
      errorLength += chunk.length;
      if (errorLength > 16384) { stop(failure(isModels ? "MODELS_TOO_LARGE" : responseCode)); return; }
      errors.push(chunk);
    });
    child.stdout.on("error", () => stop(failure(responseCode)));
    child.stderr.on("error", () => stop(failure(responseCode)));
    child.on("close", (code) => {
      if (stopping || settled) return;
      if (code === 0) { finish(); return; }
      let result;
      try { result = JSON.parse(Buffer.concat(errors).toString("utf8")); } catch {}
      const known = result?.schema === 1 && result.id === ID &&
        (COMPONENT_ERRORS.includes(result.error?.code) || (isModels && MODELS_ERROR_CODES.includes(result.error?.code)));
      const errorCode = known ? result.error.code : failedCode;
      finish(errorCode === "RUNTIME_CONFLICT" ? conflict("COMPONENT")
        : failure(errorCode, ["KEY_REQUIRED", "KEY_HOST_CHANGED"].includes(errorCode) ? "apiKey" : ""));
    });
    timer = setTimeout(() => stop(failure(isModels ? "MODELS_TIMEOUT" : "component_timeout")), isModels ? 15000 : command === "gui-status" ? 10000 : 120000);
    abortSignal?.addEventListener("abort", abort, { once: true });
    if (abortSignal?.aborted) { abort(); child.stdin.end(); return; }
    child.stdin.end(input ? JSON.stringify(input) : undefined);
  });
}

function statusView(result) {
  if (!object(result) || result.schema !== 1 || result.id !== ID || typeof result.configured !== "boolean" ||
      typeof result.localReady !== "boolean" || typeof result.hasKey !== "boolean") throw failure("component_response");
  if (!result.configured) return { installed: true, configured: false, hasKey: false, endpoint: "", model: "", models: [], localReady: false, local: { state: "stopped" } };
  if (result.hasKey !== true || !validModel(result.model)) throw failure("component_response");
  const models = result.models === undefined ? [result.model] : result.models;
  if (!Array.isArray(models) || !models.length || models.length > CONFIG_MODEL_LIMIT || !models.every(validModel) ||
      new Set(models).size !== models.length || !models.includes(result.model)) throw failure("component_response");
  const endpoint = normalizeBridgeEndpoint(result.endpoint);
  if (endpoint !== result.endpoint) throw failure("component_response");
  const localError = LOCAL_ERRORS.includes(result.localError) ? result.localError : result.localError ? "LOCAL_START_FAILED" : "";
  // 故障标记优先于残存进程的 /health；配置页不能给实际 ensure 会拒绝的实例放行。
  const localReady = result.localReady && !localError;
  return { installed: true, configured: true, hasKey: true, endpoint, model: result.model, models: [...models], localReady,
    ...(localError ? { localError } : {}), local: { state: localError ? "error" : localReady ? "ready" : "stopped", ...(localError ? { code: localError } : {}) } };
}

function assertGuiOwnership() {
  const home = HOME_ROOT(), target = path.join(home, ".local", "share", "ccr-bridge-kit");
  let stat;
  try { stat = fs.lstatSync(target); }
  catch (error) { if (error.code === "ENOENT") return; throw conflict("OWNERSHIP"); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(target) !== target) throw conflict("OWNERSHIP");
  try {
    for (const dir of [home, path.join(home, ".local"), path.join(home, ".local", "share"), target])
      if (fs.realpathSync(dir) !== path.resolve(dir)) throw conflict("OWNERSHIP");
    const manifest = regularJson(path.join(target, ".ccr-bridge-kit.json"), 1 << 20);
    if (!object(manifest) || manifest.id !== "ccr-bridge-kit" || manifest.target !== target || manifest.guiManaged !== true) throw conflict("OWNERSHIP");
  } catch { throw conflict("OWNERSHIP"); }
}

function defaultConnection(model) {
  // 绝不相信 CLI 返回的 connectionPath 或注册里的任意 runtimeDir，只读默认专用实例。
  const home = HOME_ROOT(), target = path.join(home, ".local", "share", "ccr-bridge-kit");
  try {
    for (const dir of [home, path.join(home, ".local"), path.join(home, ".local", "share"), target,
      path.join(home, ".cccodroid"), path.join(home, ".cccodroid", "services")]) {
      if (fs.realpathSync(dir) !== path.resolve(dir)) throw failure("RUNTIME_CONFLICT");
    }
    const registration = regularJson(path.join(home, ".cccodroid", "services", ID + ".json"), 4096);
    const connection = regularJson(path.join(target, "connection.json"), CONFIG_MAX_BYTES);
    if (!object(registration) || registration.schema !== 1 || registration.id !== ID || registration.runtimeDir !== target ||
        typeof registration.instanceId !== "string" || !/^[0-9a-f]{32}$/.test(registration.instanceId) ||
        Object.keys(registration).some((key) => !["schema", "id", "endpoint", "runtimeDir", "instanceId"].includes(key))) throw failure("RUNTIME_CONFLICT");
    const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{3,4})$/.exec(registration.endpoint);
    if (!match || Number(match[1]) < 1024 || Number(match[1]) > 65535 || !object(connection) ||
        connection.baseUrl !== registration.endpoint || connection.model !== model ||
        typeof connection.apiKey !== "string" || !/^[0-9a-f]{48}$/.test(connection.apiKey)) throw failure("RUNTIME_CONFLICT");
    return { baseUrl: connection.baseUrl, apiKey: connection.apiKey, model };
  } catch { throw conflict("CONNECTION"); }
}

function validateInput(body, modelsOnly = false) {
  const fields = modelsOnly ? ["endpoint", "apiKey", "consent"] : ["endpoint", "apiKey", "model", "models", "contextWindow", "consent"];
  if (!object(body) || Object.keys(body).some((key) => !fields.includes(key)) || body.consent !== true) throw failure("consent_required");
  const endpoint = normalizeBridgeEndpoint(body.endpoint);
  if (body.apiKey !== undefined && typeof body.apiKey !== "string") throw failure("invalid_key", "apiKey");
  const apiKey = (body.apiKey || "").trim();
  if ((body.apiKey || "").length > 1024 || /[\u0000-\u001f\u007f]/.test(body.apiKey || "") || /\s/.test(apiKey)) throw failure("invalid_key", "apiKey");
  if (modelsOnly) return { endpoint, apiKey };
  if (typeof body.model !== "string" || !validModel(body.model.trim())) throw failure("invalid_model", "model");
  const model = body.model.trim();
  const models = body.models === undefined ? undefined : configuredModelsInput(body.models, model);
  return { endpoint, apiKey, model, ...(models?.length > 1 ? { models: models.map((item) => item.id) } : {}) };
}

const validWindow = (v) => (Number.isInteger(v) && v >= 1024 && v <= 16777216 ? v : 0);
// 窗口由宿主按型号记，不交给组件；缺省按 200k，旧单型号请求仍接受清空。
function contextWindowInput(body) {
  const v = body?.contextWindow;
  if (v === undefined || v === null || v === "" || Number(v) === 0) return 0;   // 和 providers 一致："0" 也算清空
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1024 || n > 16777216) throw failure("invalid_context_window", "contextWindow");
  return n;
}

function configuredModelsInput(raw, model) {
  if (!Array.isArray(raw) || !raw.length || raw.length > CONFIG_MODEL_LIMIT) throw failure("invalid_model", "model");
  const seen = new Set();
  const models = raw.map((item) => {
    if (!object(item) || Object.keys(item).some((key) => !["id", "contextWindow"].includes(key)) ||
        !validModel(item.id) || seen.has(item.id)) throw failure("invalid_model", "model");
    seen.add(item.id);
    return { id: item.id, contextWindow: contextWindowInput(item) || DEFAULT_CONTEXT_WINDOW };
  });
  if (!seen.has(model)) throw failure("invalid_model", "model");
  return models;
}

// 只接受我们自己生成的纯本地清单，不能借多模型放开任意 modelsUrl 或远端地址。
const inlineModelList = (models) => "data:application/json;base64," + Buffer.from(JSON.stringify({ data: models.map((m) => ({ id: m.id, context_window: m.contextWindow })) })).toString("base64");
function providerModels(provider) {
  if (!provider?.modelsUrl) return null;
  const prefix = "data:application/json;base64,";
  if (typeof provider.modelsUrl !== "string" || !provider.modelsUrl.startsWith(prefix) || provider.modelsUrl.length > 180 << 10) throw conflict("MODEL_LIST");
  try {
    const data = JSON.parse(Buffer.from(provider.modelsUrl.slice(prefix.length), "base64").toString("utf8"));
    if (!object(data) || Object.keys(data).length !== 1 || !Array.isArray(data.data)) throw failure("RUNTIME_CONFLICT");
    const models = configuredModelsInput(data.data.map((m) => {
      if (!object(m) || Object.keys(m).some((k) => !["id", "context_window"].includes(k)) || !validWindow(m.context_window)) throw failure("RUNTIME_CONFLICT");
      return { id: m.id, contextWindow: m.context_window };
    }), provider.defaultModel);
    if (inlineModelList(models) !== provider.modelsUrl) throw failure("RUNTIME_CONFLICT");
    return models;
  } catch { throw conflict("MODEL_LIST"); }
}
function modelWindows(view, provider) {
  const known = providerModels(provider) || [];
  const ids = view.models?.length ? view.models : known.map((m) => m.id);
  return ids.map((id) => ({ id, contextWindow: known.find((m) => m.id === id)?.contextWindow ||
    (id === provider?.defaultModel ? validWindow(provider?.contextWindow) : 0) || DEFAULT_CONTEXT_WINDOW }));
}

function modelsView(result, apiKey = "") {
  if (!object(result) || result.schema !== 1 || result.id !== ID || !Array.isArray(result.models) || typeof result.truncated !== "boolean") throw failure("MODELS_INVALID_RESPONSE");
  if (result.models.length > 500) throw failure("MODELS_TOO_LARGE");
  const ids = new Set();
  const models = result.models.map((model) => {
    const id = object(model) ? model.id : undefined;
    if (typeof id !== "string" || !id.trim() || id.length > 200 || /[,\u0000-\u001f\u007f]/.test(id) || ids.has(id) || (apiKey && id.includes(apiKey))) throw failure("MODELS_INVALID_RESPONSE");
    ids.add(id);
    const contextWindow = validWindow(model.context_window);
    return { id, ...(contextWindow ? { context_window: contextWindow } : {}) };
  });
  const view = { ok: true, models, truncated: result.truncated };
  if (Buffer.byteLength(JSON.stringify(view)) > MODELS_MAX_BYTES) throw failure("MODELS_TOO_LARGE");
  return view;
}

export async function fetchBridgeModels(body, signal) {
  const input = validateInput(body, true);
  try {
    // 健康状态只检查固定组件入口；旧 key 的安全实例/同 origin 匹配全由组件 resolver 处理。
    // 不做 gui-status 预检，也不触发配置、provider、持久化或常驻服务启动。
    return modelsView(await invokeComponent("gui-models", input, signal), input.apiKey);
  } finally { input.apiKey = ""; }
}

export async function handleBridgeModels(req, res, signal) {
  try {
    if (req.method !== "POST") return sendJson(res, 405, { ok: false, code: "method" });
    let body, abortBody;
    try {
      const pending = readBodyBuf(req, 16384);
      const cancelled = new Promise((_, reject) => {
        abortBody = () => reject(failure("MODELS_FAILED"));
        signal?.addEventListener("abort", abortBody, { once: true });
        if (signal?.aborted) abortBody();
      });
      body = JSON.parse((await Promise.race([pending, cancelled])).toString("utf8"));
    } catch { throw failure(signal?.aborted ? "MODELS_FAILED" : "invalid_input"); }
    finally { signal?.removeEventListener("abort", abortBody); }
    const view = await fetchBridgeModels(body, signal);
    if (!res.destroyed && !res.writableEnded) return sendJson(res, 200, view);
  } catch (error) {
    if (res.destroyed || res.writableEnded) return;
    const codes = [...COMPONENT_ERRORS, ...MODELS_ERROR_CODES, "not_installed", "consent_required", "invalid_input", "invalid_endpoint", "unsupported_path", "invalid_key"];
    const code = codes.includes(error.code) ? error.code : "MODELS_FAILED";
    const status = ["BUSY", "RUNTIME_CONFLICT", "not_installed"].includes(code) ? 409 : 400;
    log(`[bridge-config] models failed stage=${code}`);
    return sendJson(res, status, { ok: false, code,
      ...(["endpoint", "apiKey"].includes(error.field) ? { field: error.field } : {}), message: failure(code).message });
  }
}

const providerStateFile = () => path.join(HOME_ROOT(), ".cccodroid", "services", "openai-bridge-app.json");

export function clearBridgeConfigMapping(id) {
  if (id !== ID) return false;
  let fd;
  try {
    fd = fs.openSync(HOME_ROOT(), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    // 只解开本桥的非秘密映射；不跟随父目录链接，也不删除保留的 provider 或运行配置。
    for (const name of [".cccodroid", "services"]) {
      const next = fs.openSync(`/proc/self/fd/${fd}/${name}`, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      fs.closeSync(fd); fd = next;
    }
    fs.unlinkSync(`/proc/self/fd/${fd}/openai-bridge-app.json`);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw failure("mapping_clear_failed");
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

const localFingerprint = (connection) => crypto.createHash("sha256").update(connection.baseUrl + "\0" + connection.apiKey).digest("hex");
const modelsFingerprint = (provider) => provider.modelsUrl ? crypto.createHash("sha256").update(provider.modelsUrl).digest("hex") : "";
const validFingerprints = (value) => object(value) && typeof value.fingerprint === "string" && /^[0-9a-f]{64}$/.test(value.fingerprint) &&
  (value.modelsFingerprint === undefined || (typeof value.modelsFingerprint === "string" && /^[0-9a-f]{64}$/.test(value.modelsFingerprint)));
const sameFingerprints = (value, provider) => value.fingerprint === localFingerprint(provider) && (value.modelsFingerprint || "") === modelsFingerprint(provider);
function writeProviderState(value) {
  const file = providerStateFile(), temp = file + "." + crypto.randomBytes(6).toString("hex") + ".tmp";
  try {
    fs.writeFileSync(temp, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    fs.renameSync(temp, file);
  } finally { try { fs.unlinkSync(temp); } catch {} }
}
/** 映射记的那家接口：{ id, stale }。stale = 桥实例换过了（卸载后重装、本地密钥是新的），那家接口还连着旧实例：
 *  保存时沿用这个接口号改成新连接，状态里先不报（旧连接已失效，别让「新建会话使用」选到它）。
 *  判据：映射指纹对不上当前连接，但那家接口自己的地址 + 密钥仍和映射指纹吻合 —— 说明映射与接口都没被动过，只是实例换了。
 *  从终端卸载不经过 App，映射没人清，以前这里一律报冲突、配置页从此打不开 */
function mappedProvider(connection) {
  let state;
  try { state = regularJson(providerStateFile(), 4096); }
  catch (error) { if (error.code === "ENOENT") return { id: "", stale: false }; throw conflict("APP_MAPPING"); }
  if (!object(state) || state.schema !== 1 || state.id !== ID || typeof state.providerId !== "string" ||
      !/^custom-[1-9][0-9]*$/.test(state.providerId) || !validFingerprints(state) ||
      (state.pending !== undefined && !validFingerprints(state.pending))) throw conflict("APP_MAPPING");
  const provider = PROVIDERS_CFG.providers[state.providerId];
  if (!provider) return { id: "", stale: false };
  if (!provider.custom || provider.login || provider.local || provider.authStyle !== "bearer" ||
      provider.endpoints?.length || provider.apiKeyEnv || Object.keys(provider.extraEnv || {}).length) throw conflict("APP_PROVIDER");
  providerModels(provider);
  // 只有写前记录的精确旧/新组合可恢复；删掉清单或换成第三种清单仍是冲突。
  const current = sameFingerprints(state, provider) ? state
    : state.pending && sameFingerprints(state.pending, provider) ? state.pending : null;
  if (!current) {
    // 诊断不改变精确旧/新配对规则：连接指纹仍匹配、只有模型指纹不符时才归为清单问题。
    const matchesConnection = state.fingerprint === localFingerprint(provider) || state.pending?.fingerprint === localFingerprint(provider);
    throw conflict(matchesConnection ? "MODEL_LIST" : "APP_PROVIDER");
  }
  if (current.fingerprint === localFingerprint(connection)) {
    if (provider.baseUrl !== connection.baseUrl || provider.apiKey !== connection.apiKey) throw conflict("APP_PROVIDER");
    return { id: state.providerId, stale: false };
  }
  if (typeof provider.baseUrl !== "string" || typeof provider.apiKey !== "string" ||
      !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{3,4}$/.test(provider.baseUrl) || !/^[0-9a-f]{48}$/.test(provider.apiKey)) throw conflict("APP_PROVIDER");
  return { id: state.providerId, stale: true };
}

function saveProvider(connection, contextWindow = 0, models = [{ id: connection.model, contextWindow: contextWindow || DEFAULT_CONTEXT_WINDOW }], repair = null) {
  const { id } = repair ? { id: repair.id } : mappedProvider(connection);
  if (id && [...RUNS.values()].some((run) => !run.ended && run.provider === id)) throw failure("BUSY");
  // 复用同一个同步持久化入口；先记非秘密指纹事务，避免接口已落盘而映射写失败后永久锁死。
  const modelsUrl = inlineModelList(models), next = { fingerprint: localFingerprint(connection), modelsFingerprint: modelsFingerprint({ modelsUrl }) };
  const previous = id && PROVIDERS_CFG.providers[id], previousState = id ? regularJson(providerStateFile(), 4096) : null;
  const response = upsertProvider(id || null, { ...(!repair ? { label: "OpenAI API 本地协议桥" } : {}), baseUrl: connection.baseUrl,
    apiKey: connection.apiKey, defaultModel: connection.model, fastModel: connection.model, authStyle: "bearer", contextWindow, modelsUrl }, (providerId) => {
    repair?.recheck();
    writeProviderState({ schema: 1, id: ID, providerId, ...(previous ? {
      fingerprint: localFingerprint(previous), ...(previous.modelsUrl ? { modelsFingerprint: modelsFingerprint(previous) } : {}), pending: next,
    } : next) });
    return () => { if (previousState) writeProviderState(previousState); else clearBridgeConfigMapping(ID); };
  });
  if (response?.ok !== true || !/^custom-[1-9][0-9]*$/.test(response.id || "")) throw failure("provider_save_failed");
  try { writeProviderState({ schema: 1, id: ID, providerId: response.id, ...next }); }
  catch (error) {
    // 接口已提交；精确 pending 仍可冷读，不能谎称未执行或自动重放整次修复。
    if (repair) throw repairFailure("REPAIR_PARTIAL");
    throw error;
  }
  return response.id;
}

export async function bridgeConfigStatus() {
  try {
    const view = statusView(await invokeComponent("gui-status"));
    if (view.configured) assertGuiOwnership();
    // 实例换过（stale）不报接口号，但窗口照旧带回表单：修复性保存不该把用户设过的窗口清零。没配置时读映射出错就当没有
    let m = { id: "", stale: false };
    if (view.configured) m = mappedProvider(defaultConnection(view.model));
    else try { m = mappedProvider({ baseUrl: "", apiKey: "" }); } catch {}
    const provider = m.id && PROVIDERS_CFG.providers[m.id], models = modelWindows(view, provider), known = providerModels(provider);
    const matches = !view.configured || (provider && provider.defaultModel === view.model &&
      JSON.stringify((known || [{ id: provider.defaultModel }]).map((item) => item.id)) === JSON.stringify(view.models));
    const localError = view.localError || (!matches && !m.stale ? "LOCAL_START_FAILED" : "");
    const blocked = localError ? { localReady: false, localError, local: { state: "error", code: localError } } : {};
    return { ok: true, ...view, ...blocked, ...(!matches && !m.stale ? { check: provider ? "MODEL_LIST" : "APP_MAPPING" } : {}), models, providerId: m.stale || !matches ? "" : m.id,
      contextWindow: models.find((item) => item.id === view.model)?.contextWindow ||
        (!view.configured && provider ? validWindow(provider.contextWindow) : 0) };
  } catch (error) {
    if (error.code === "not_installed") return { ok: true, installed: false, configured: false, hasKey: false, endpoint: "", model: "", localReady: false, local: { state: "stopped" } };
    throw error;
  }
}

export async function saveBridgeConfig(body) {
  const input = validateInput(body);
  const models = body.models === undefined ? [{ id: input.model, contextWindow: contextWindowInput(body) || DEFAULT_CONTEXT_WINDOW }]
    : configuredModelsInput(body.models, input.model);
  const contextWindow = models.find((item) => item.id === input.model).contextWindow;
  let saved = false, release;
  try {
    const current = await bridgeConfigStatus();
    if (!current.installed) throw failure("not_installed");
    if (!input.apiKey && !current.hasKey) throw failure("KEY_REQUIRED", "apiKey");
    if (!input.apiKey && new URL(current.endpoint).origin !== new URL(input.endpoint).origin) throw failure("KEY_HOST_CHANGED", "apiKey");
    if (current.configured) {
      const connection = defaultConnection(current.model);
      if ([...RUNS.values()].some((run) => !run.ended && PROVIDERS_CFG.providers[run.provider]?.baseUrl === connection.baseUrl)) throw failure("BUSY");
    }
    assertGuiOwnership();
    release = beginManagedBridgeConfiguration();
    const configured = await invokeComponent("gui-configure", input);
    saved = configured?.schema === 1 && configured.id === ID && configured.configured === true;
    const view = statusView(configured);
    if (!view.configured || view.endpoint !== input.endpoint || view.model !== input.model ||
        JSON.stringify(view.models) !== JSON.stringify(models.map((item) => item.id))) throw failure("component_response");
    saved = true;
    assertGuiOwnership();
    const providerId = await saveProvider(defaultConnection(view.model), contextWindow, models);
    return { ok: true, saved, ...view, models, providerId, contextWindow };
  } catch (error) { error.saved = saved; throw error; }
  finally { release?.(); input.apiKey = ""; }
}

const repairTickets = new Map(), REPAIR_TTL = 60000;
function repairFailure(code = "REPAIR_UNAVAILABLE") { return Object.assign(failure(code), { code }); }
function repairFile(file, max) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const a = fs.fstatSync(fd, { bigint: true });
    if (!a.isFile() || a.nlink !== 1n || a.size > BigInt(max) || (a.mode & 0o077n) !== 0n || a.uid !== BigInt(process.getuid())) throw repairFailure();
    const bytes = Buffer.alloc(Number(a.size) + 1);
    let length = 0, n;
    while (length < bytes.length && (n = fs.readSync(fd, bytes, length, bytes.length - length, null))) length += n;
    const b = fs.fstatSync(fd, { bigint: true }), c = fs.lstatSync(file, { bigint: true });
    const keys = ["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"];
    if (length !== Number(a.size) || keys.some(k => a[k] !== b[k] || a[k] !== c[k])) throw repairFailure();
    return keys.map(k => String(a[k])).join(":") + ":" + crypto.createHash("sha256").update(bytes.subarray(0, length)).digest("hex");
  } catch { throw repairFailure(); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function repairSnapshot() {
  const home = HOME_ROOT(), target = path.join(home, ".local/share/ccr-bridge-kit"), entry = componentEntry();
  const directories = [home, path.join(home, ".local"), path.join(home, ".local/share"), target,
    path.join(home, ".cccodroid"), path.join(home, ".cccodroid/services"), path.join(target, "runtime-home"),
    path.join(target, "runtime-home/.claude-code-router")];
  const identities = directories.map(dir => {
    const st = fs.lstatSync(dir, { bigint: true });
    if (!st.isDirectory() || st.isSymbolicLink() || fs.realpathSync(dir) !== dir || st.uid !== BigInt(process.getuid())) throw repairFailure();
    return [String(st.dev), String(st.ino), String(st.mode)];
  });
  // 只绑定文件身份/哈希，不把路径、Key 或哈希投影到 HTTP；运行配置由固定组件自己只读校验。
  const files = [[path.join(target, ".ccr-bridge-kit.json"), 65536], [path.join(target, "connection.json"), CONFIG_MAX_BYTES],
    [path.join(target, "runtime-home/.claude-code-router/config.json"), CONFIG_MAX_BYTES],
    [path.join(home, ".cccodroid/services/openai-bridge.json"), 4096], [providerStateFile(), 4096],
    [path.join(home, "ccapp-providers.json"), 4 << 20]];
  const protectedFiles = files.map(([file, max]) => repairFile(file, max));
  for (const file of [path.join(target, "disabled"), path.join(target, "runtime-home/.claude-code-router/recovery.failed")]) {
    try { fs.lstatSync(file); throw repairFailure(); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  // 包文件可能为 0644；它们仍需 NOFOLLOW/普通文件及稳定读，不能套用私有凭据的 0600 要求。
  const component = regularJson(path.join(path.dirname(PREFIX), "components", ID + ".json"), 4 << 20);
  const st = fs.lstatSync(entry, { bigint: true });
  return JSON.stringify([identities, protectedFiles, component, String(st.dev), String(st.ino), String(st.mtimeNs), String(st.ctimeNs)]);
}
function repairBusy(id, baseUrl) {
  return [...RUNS.values()].some(run => !run.ended && (run.provider === id || PROVIDERS_CFG.providers[run.provider]?.baseUrl === baseUrl));
}
async function repairCandidate() {
  const before = repairSnapshot(), view = statusView(await invokeComponent("gui-status"));
  if (!view.configured || view.localError || !view.localReady) throw repairFailure();
  assertGuiOwnership();
  const home = HOME_ROOT(), target = path.join(home, ".local/share/ccr-bridge-kit"), connection = defaultConnection(view.model);
  const registration = regularJson(path.join(home, ".cccodroid/services/openai-bridge.json"), 4096);
  const manifest = regularJson(path.join(target, ".ccr-bridge-kit.json"), 65536);
  if (manifest.service?.schema !== 1 || manifest.service.home !== home || manifest.service.instanceId !== registration.instanceId ||
      manifest.componentEntry !== componentEntry() || manifest.settings !== path.join(home, ".claude/settings.json")) throw repairFailure();
  const state = regularJson(providerStateFile(), 4096);
  if (!object(state) || state.schema !== 1 || state.id !== ID || !/^custom-[1-9][0-9]*$/.test(state.providerId || "") ||
      Object.keys(state).some(k => !["schema", "id", "providerId", "fingerprint", "modelsFingerprint", "pending"].includes(k)) ||
      !validFingerprints(state) || state.pending !== undefined && !validFingerprints(state.pending)) throw repairFailure();
  const provider = PROVIDERS_CFG.providers[state.providerId];
  if (!provider?.custom || provider.login || provider.local || provider.nativeModels || provider.endpoints?.length || provider.endpoint ||
      provider.apiKeyEnv || Object.keys(provider.extraEnv || {}).length || !["bearer", "x-api-key"].includes(provider.authStyle) ||
      provider.baseUrl !== connection.baseUrl || provider.apiKey !== connection.apiKey) throw repairFailure();
  const fingerprint = localFingerprint(connection);
  if (state.fingerprint !== fingerprint && state.pending?.fingerprint !== fingerprint) throw repairFailure();
  const disk = regularJson(path.join(home, "ccapp-providers.json"), 4 << 20), raw = disk.providers?.[state.providerId];
  if (!providersDiskMatches(disk) || !object(raw) ||
      Object.entries(raw).some(([key, value]) => JSON.stringify(provider[key]) !== JSON.stringify(value))) throw repairFailure();
  if (repairBusy(state.providerId, connection.baseUrl)) throw repairFailure("BUSY");
  let known = [];
  try { known = providerModels(provider) || []; } catch {}
  const models = view.models.map(id => ({ id, contextWindow: known.find(m => m.id === id)?.contextWindow ||
    (id === provider.defaultModel ? validWindow(provider.contextWindow) : 0) || DEFAULT_CONTEXT_WINDOW }));
  const changes = [];
  if (provider.authStyle !== "bearer") changes.push("AUTH_STYLE");
  if (provider.modelsUrl !== inlineModelList(models) || provider.defaultModel !== view.model || provider.fastModel !== view.model) changes.push("MODELS");
  if (!changes.length) throw repairFailure("REPAIR_NOT_NEEDED");
  if (repairSnapshot() !== before) throw repairFailure("REPAIR_STALE");
  const providerText = JSON.stringify(provider), stateText = JSON.stringify(state);
  const proof = crypto.createHash("sha256").update(before).update(providerText).update(stateText).update(JSON.stringify(view)).digest("hex");
  const recheck = () => {
    if (repairSnapshot() !== before || JSON.stringify(PROVIDERS_CFG.providers[state.providerId]) !== providerText ||
        repairBusy(state.providerId, connection.baseUrl)) throw repairFailure("REPAIR_STALE");
  };
  return { id: state.providerId, connection, models, contextWindow: models.find(m => m.id === view.model).contextWindow,
    changes, proof, recheck, view };
}
export async function handleBridgeRepair(req, res) {
  let release;
  try {
    if (req.method !== "POST") return sendJson(res, 405, { ok: false, code: "method" });
    let body;
    try { body = JSON.parse((await readBodyBuf(req, 2048)).toString("utf8")); } catch { throw repairFailure("invalid_input"); }
    if (!object(body) || body.consent !== true || !["inspect", "apply"].includes(body.action) ||
        Object.keys(body).some(k => !["action", "consent", "ticket"].includes(k))) throw repairFailure("invalid_input");
    const now = performance.now();
    for (const [key, value] of repairTickets) if (value.expires < now) repairTickets.delete(key);
    if (body.action === "inspect") {
      if (body.ticket !== undefined) throw repairFailure("invalid_input");
      const candidate = await repairCandidate(), ticket = crypto.randomBytes(24).toString("hex");
      while (repairTickets.size >= 8) repairTickets.delete(repairTickets.keys().next().value);
      repairTickets.set(ticket, { proof: candidate.proof, expires: performance.now() + REPAIR_TTL });
      return sendJson(res, 200, { ok: true, repair: { available: true, action: "SYNC_APP_METADATA", ticket, expiresIn: 60,
        changes: candidate.changes, models: candidate.models } });
    }
    if (typeof body.ticket !== "string" || !/^[0-9a-f]{48}$/.test(body.ticket)) throw repairFailure("invalid_input");
    const pending = repairTickets.get(body.ticket); repairTickets.delete(body.ticket);
    if (!pending || pending.expires < performance.now()) throw repairFailure("REPAIR_STALE");
    release = beginManagedBridgeConfiguration();
    const result = await withManagedBridgeRegistryLock(async recheckLock => {
      const candidate = await repairCandidate();
      if (candidate.proof !== pending.proof) throw repairFailure("REPAIR_STALE");
      recheckLock(); candidate.recheck();
      const id = saveProvider(candidate.connection, candidate.contextWindow, candidate.models, {
        id: candidate.id, recheck() { recheckLock(); candidate.recheck(); },
      });
      return { ok: true, repaired: true, scope: "APP_METADATA", providerId: id };
    });
    // 请求已断开就不回写（同 handleBridgeModels）；修复本身已完成或已回滚，结果靠下次检查读出
    if (res.destroyed || res.writableEnded) return;
    return sendJson(res, 200, result);
  } catch (error) {
    const code = ["BUSY", "REPAIR_STALE", "REPAIR_NOT_NEEDED", "REPAIR_PARTIAL", "invalid_input"].includes(error.code) ? error.code : "REPAIR_UNAVAILABLE";
    log(`[bridge-config] repair failed stage=${code}`);
    if (res.destroyed || res.writableEnded) return;
    return sendJson(res, ["BUSY", "REPAIR_STALE", "REPAIR_UNAVAILABLE", "REPAIR_PARTIAL"].includes(code) ? 409 : 400, { ok: false, code,
      ...(code === "REPAIR_PARTIAL" ? { committed: true, scope: "APP_METADATA" } : {}) });
  } finally { release?.(); }
}

export async function handleBridgeConfig(req, res) {
  try {
    if (req.method === "GET") return sendJson(res, 200, await bridgeConfigStatus());
    if (req.method !== "POST") return sendJson(res, 405, { ok: false, code: "method" });
    let body;
    try { body = JSON.parse((await readBodyBuf(req, CONFIG_MAX_BYTES)).toString("utf8")); } catch { throw failure("invalid_input"); }
    return sendJson(res, 200, await saveBridgeConfig(body));
  } catch (error) {
    const codes = ["BUSY", "RUNTIME_CONFLICT", "not_installed", "component_spawn", "component_failed", "component_response", "component_timeout", "KEY_REQUIRED", "KEY_HOST_CHANGED", "consent_required", "invalid_input", "invalid_endpoint", "unsupported_path", "invalid_key", "invalid_model", "invalid_context_window", "provider_save_failed", ...LOCAL_ERRORS];
    const code = codes.includes(error.code) ? error.code : "config_failed";
    const status = ["BUSY", "RUNTIME_CONFLICT", "not_installed"].includes(code) ? 409 : 400;
    log(`[bridge-config] ${req.method === "POST" ? "save" : "status"} failed stage=${code}`);
    return sendJson(res, status, { ok: false, saved: error.saved === true, localReady: false, code,
      ...(code === "RUNTIME_CONFLICT" ? { check: CONFIG_CHECKS.includes(error.check) ? error.check : "UNKNOWN" } : {}),
      ...(["endpoint", "apiKey", "model", "contextWindow"].includes(error.field) ? { field: error.field } : {}), message: failure(code).message });
  }
}
