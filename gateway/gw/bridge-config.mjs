import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import crypto from "node:crypto";
import { CFG, PREFIX, log, tz } from "./config.mjs";
import { componentEnv as sharedComponentEnv } from "./component-env.mjs";
import { readBodyBuf, sendJson } from "./http.mjs";
import { RUNS } from "./runs.mjs";
import { PROVIDERS_CFG, routeProviders } from "./providers.mjs";
import { beginManagedBridgeConfiguration } from "./managed-bridge.mjs";

const ID = "openai-bridge", ENTRY = "lib/openai-bridge/component.cjs";
const MODELS_MAX_BYTES = 128 << 10;
const COMPONENT_ERRORS = ["INVALID_INPUT", "KEY_REQUIRED", "KEY_HOST_CHANGED", "RUNTIME_CONFLICT", "BUSY"];
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
    ? tz("已有桥安装不能自动迁移，请先备份并由你处理原安装；未覆盖或卸载。")
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
  const stdoutLimit = isModels ? MODELS_MAX_BYTES : 16384;
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
      finish(failure(errorCode, ["KEY_REQUIRED", "KEY_HOST_CHANGED"].includes(errorCode) ? "apiKey" : ""));
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
  if (!result.configured) return { installed: true, configured: false, hasKey: false, endpoint: "", model: "", localReady: false, local: { state: "stopped" } };
  if (result.hasKey !== true || typeof result.model !== "string" || !result.model || result.model.length > 200 || /[,\u0000-\u001f\u007f]/.test(result.model)) throw failure("component_response");
  const endpoint = normalizeBridgeEndpoint(result.endpoint);
  if (endpoint !== result.endpoint) throw failure("component_response");
  return { installed: true, configured: true, hasKey: true, endpoint, model: result.model, localReady: result.localReady,
    local: { state: result.localReady ? "ready" : "stopped" } };
}

function assertGuiOwnership() {
  const home = HOME_ROOT(), target = path.join(home, ".local", "share", "ccr-bridge-kit");
  let stat;
  try { stat = fs.lstatSync(target); }
  catch (error) { if (error.code === "ENOENT") return; throw failure("RUNTIME_CONFLICT"); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(target) !== target) throw failure("RUNTIME_CONFLICT");
  try {
    for (const dir of [home, path.join(home, ".local"), path.join(home, ".local", "share"), target])
      if (fs.realpathSync(dir) !== path.resolve(dir)) throw failure("RUNTIME_CONFLICT");
    const manifest = regularJson(path.join(target, ".ccr-bridge-kit.json"), 1 << 20);
    if (!object(manifest) || manifest.id !== "ccr-bridge-kit" || manifest.target !== target || manifest.guiManaged !== true) throw failure("RUNTIME_CONFLICT");
  } catch { throw failure("RUNTIME_CONFLICT"); }
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
    const connection = regularJson(path.join(target, "connection.json"), 4096);
    if (!object(registration) || registration.schema !== 1 || registration.id !== ID || registration.runtimeDir !== target ||
        typeof registration.instanceId !== "string" || !/^[0-9a-f]{32}$/.test(registration.instanceId) ||
        Object.keys(registration).some((key) => !["schema", "id", "endpoint", "runtimeDir", "instanceId"].includes(key))) throw failure("RUNTIME_CONFLICT");
    const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{3,4})$/.exec(registration.endpoint);
    if (!match || Number(match[1]) < 1024 || Number(match[1]) > 65535 || !object(connection) ||
        connection.baseUrl !== registration.endpoint || connection.model !== model ||
        typeof connection.apiKey !== "string" || !/^[0-9a-f]{48}$/.test(connection.apiKey)) throw failure("RUNTIME_CONFLICT");
    return { baseUrl: connection.baseUrl, apiKey: connection.apiKey, model };
  } catch { throw failure("RUNTIME_CONFLICT"); }
}

function validateInput(body, modelsOnly = false) {
  const fields = modelsOnly ? ["endpoint", "apiKey", "consent"] : ["endpoint", "apiKey", "model", "contextWindow", "consent"];
  if (!object(body) || Object.keys(body).some((key) => !fields.includes(key)) || body.consent !== true) throw failure("consent_required");
  const endpoint = normalizeBridgeEndpoint(body.endpoint);
  if (body.apiKey !== undefined && typeof body.apiKey !== "string") throw failure("invalid_key", "apiKey");
  const apiKey = (body.apiKey || "").trim();
  if ((body.apiKey || "").length > 1024 || /[\u0000-\u001f\u007f]/.test(body.apiKey || "") || /\s/.test(apiKey)) throw failure("invalid_key", "apiKey");
  if (modelsOnly) return { endpoint, apiKey };
  if (typeof body.model !== "string" || !body.model.trim() || body.model.length > 200 || /[,\u0000-\u001f\u007f]/.test(body.model)) throw failure("invalid_model", "model");
  return { endpoint, apiKey, model: body.model.trim() };
}

const validWindow = (v) => (Number.isInteger(v) && v >= 1024 && v <= 16777216 ? v : 0);
/** 上下文窗口（可选，宿主自己记，不交给组件）：空 = 不知道；填了要在 1k–16M 之间（#67） */
function contextWindowInput(body) {
  const v = body?.contextWindow;
  if (v === undefined || v === null || v === "" || Number(v) === 0) return 0;   // 和 providers 一致："0" 也算清空
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1024 || n > 16777216) throw failure("invalid_context_window", "contextWindow");
  return n;
}

function modelsView(result, apiKey = "") {
  if (!object(result) || result.schema !== 1 || result.id !== ID || !Array.isArray(result.models) || typeof result.truncated !== "boolean") throw failure("MODELS_INVALID_RESPONSE");
  if (result.models.length > 500) throw failure("MODELS_TOO_LARGE");
  const ids = new Set();
  const models = result.models.map((model) => {
    const id = object(model) ? model.id : undefined;
    if (typeof id !== "string" || !id.trim() || id.length > 200 || /[,\u0000-\u001f\u007f]/.test(id) || ids.has(id) || (apiKey && id.includes(apiKey))) throw failure("MODELS_INVALID_RESPONSE");
    ids.add(id);
    return { id };
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
function configuredProvider(connection) {
  let state;
  try { state = regularJson(providerStateFile(), 4096); }
  catch (error) { if (error.code === "ENOENT") return ""; throw failure("RUNTIME_CONFLICT"); }
  if (!object(state) || state.schema !== 1 || state.id !== ID || typeof state.providerId !== "string" ||
      !/^custom-[1-9][0-9]*$/.test(state.providerId) || state.fingerprint !== localFingerprint(connection)) throw failure("RUNTIME_CONFLICT");
  const provider = PROVIDERS_CFG.providers[state.providerId];
  if (!provider) return "";
  if (!provider.custom || provider.login || provider.local || provider.baseUrl !== connection.baseUrl || provider.apiKey !== connection.apiKey ||
      provider.authStyle !== "bearer" || provider.modelsUrl || provider.endpoints?.length || provider.apiKeyEnv || Object.keys(provider.extraEnv || {}).length) throw failure("RUNTIME_CONFLICT");
  return state.providerId;
}

async function saveProvider(connection, contextWindow = 0) {
  const id = configuredProvider(connection);
  if (id && [...RUNS.values()].some((run) => !run.ended && run.provider === id)) throw failure("BUSY");
  // 复用唯一现有持久化入口，让内存 RAW 与磁盘同时更新；不是发请求，也不调用 test/active。
  const body = Buffer.from(JSON.stringify({ ...(id ? { id } : {}), label: "OpenAI API 本地协议桥", baseUrl: connection.baseUrl,
    apiKey: connection.apiKey, defaultModel: connection.model, fastModel: connection.model, authStyle: "bearer", contextWindow }));
  const req = Readable.from([body]);
  Object.assign(req, { method: "POST", headers: {}, ccBodySha: crypto.createHash("sha256").update(body).digest("hex") });
  let response, status;
  const res = { writeHead(code) { status = code; }, end(data) { response = JSON.parse(String(data)); } };
  const url = new URL("http://127.0.0.1/api/providers/save");
  await routeProviders(req, res, url, url.pathname);
  if (status !== 200 || response?.ok !== true || !/^custom-[1-9][0-9]*$/.test(response.id || "")) throw failure("provider_save_failed");
  const file = providerStateFile(), temp = file + "." + crypto.randomBytes(6).toString("hex") + ".tmp";
  try {
    fs.writeFileSync(temp, JSON.stringify({ schema: 1, id: ID, providerId: response.id, fingerprint: localFingerprint(connection) }), { flag: "wx", mode: 0o600 });
    fs.renameSync(temp, file);
  } finally { try { fs.unlinkSync(temp); } catch {} }
  return response.id;
}

export async function bridgeConfigStatus() {
  try {
    const view = statusView(await invokeComponent("gui-status"));
    if (view.configured) assertGuiOwnership();
    const providerId = view.configured ? configuredProvider(defaultConnection(view.model)) : "";
    return { ok: true, ...view, providerId, contextWindow: validWindow(providerId && PROVIDERS_CFG.providers[providerId]?.contextWindow) };
  } catch (error) {
    if (error.code === "not_installed") return { ok: true, installed: false, configured: false, hasKey: false, endpoint: "", model: "", localReady: false, local: { state: "stopped" } };
    throw error;
  }
}

export async function saveBridgeConfig(body) {
  const input = validateInput(body), contextWindow = contextWindowInput(body);
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
    if (!view.configured || view.endpoint !== input.endpoint || view.model !== input.model) throw failure("component_response");
    saved = true;
    assertGuiOwnership();
    const providerId = await saveProvider(defaultConnection(view.model), contextWindow);
    return { ok: true, saved, ...view, providerId, contextWindow };
  } catch (error) { error.saved = saved; throw error; }
  finally { release?.(); input.apiKey = ""; }
}

export async function handleBridgeConfig(req, res) {
  try {
    if (req.method === "GET") return sendJson(res, 200, await bridgeConfigStatus());
    if (req.method !== "POST") return sendJson(res, 405, { ok: false, code: "method" });
    let body;
    try { body = JSON.parse((await readBodyBuf(req, 16384)).toString("utf8")); } catch { throw failure("invalid_input"); }
    return sendJson(res, 200, await saveBridgeConfig(body));
  } catch (error) {
    const codes = ["BUSY", "RUNTIME_CONFLICT", "not_installed", "component_spawn", "component_failed", "component_response", "component_timeout", "KEY_REQUIRED", "KEY_HOST_CHANGED", "consent_required", "invalid_input", "invalid_endpoint", "unsupported_path", "invalid_key", "invalid_model", "invalid_context_window", "provider_save_failed"];
    const code = codes.includes(error.code) ? error.code : "config_failed";
    const status = ["BUSY", "RUNTIME_CONFLICT", "not_installed"].includes(code) ? 409 : 400;
    log(`[bridge-config] ${req.method === "POST" ? "save" : "status"} failed stage=${code}`);
    return sendJson(res, status, { ok: false, saved: error.saved === true, localReady: false, code,
      ...(["endpoint", "apiKey", "model", "contextWindow"].includes(error.field) ? { field: error.field } : {}), message: failure(code).message });
  }
}
