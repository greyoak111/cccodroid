import "../gw/config.mjs"; // 必须经 scripts/test.mjs：只用隔离 HOME / PREFIX，不接触真实 App、桥或凭据。
import { test, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import childProcess from "node:child_process";
import { Readable } from "node:stream";
import { syncBuiltinESMExports } from "node:module";
import { performance } from "node:perf_hooks";

// 不读取或继承调用者的真实令牌；所有组件子进程只应得到固定的非秘密环境白名单。
const upstreamSecret = "fixture-models-upstream-NOT-FOR-OUTPUT";
const oldSecret = "fixture-models-old-key-NOT-FOR-APP";
const ambientSecret = "fixture-models-ambient-NOT-FORWARD";
const localSecret = "e".repeat(48);
for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "OPENAI_AUTH_TOKEN", "CCAPP_RUN", "CCAPP_FIXTURE_SECRET"])
  process.env[name] = ambientSecret;

const home = process.env.CCAPP_HOME, prefix = process.env.CCAPP_PREFIX, temporary = process.env.CCAPP_TMP;
assert.equal(process.env.CCAPP_TEST, "1");
assert.ok(temporary && path.basename(temporary).startsWith("cccodroid-test-"), "必须由 scripts/test.mjs 创建临时根目录");
assert.equal(home, path.join(temporary, "home")); assert.equal(prefix, path.join(temporary, "usr"));
assert.equal(process.env.HOME, home); assert.equal(process.env.CCAPP_WORKSPACE, path.join(temporary, "workspace"));

const { routeComponents, compIndexCache } = await import("../gw/components.mjs");
const providers = await import("../gw/providers.mjs");
const { SETTINGS } = await import("../gw/settings-store.mjs");
const { CFG } = await import("../gw/config.mjs");
const { RUNS } = await import("../gw/runs.mjs");
const root = fs.mkdtempSync(path.join(process.env.CCAPP_WORKSPACE, "bridge-models-"));
const target = path.join(home, ".local/share/ccr-bridge-kit");
const registration = path.join(home, ".cccodroid/services/openai-bridge.json");
const mapping = path.join(path.dirname(registration), "openai-bridge-app.json");
const record = path.join(path.dirname(prefix), "components/openai-bridge.json");
const component = path.join(prefix, "lib/openai-bridge/component.cjs");
const marker = path.join(root, "calls");
const controlFile = path.join(root, "control.json");
const releaseFile = path.join(root, "release");
const stoppedFile = path.join(root, "stopped");
const modelsPath = "/api/components/openai-bridge/models";
const configPath = "/api/components/openai-bridge/config";
const endpoint = "https://models.example.invalid/v1";
const normalizedEndpoint = endpoint + "/chat/completions";
const localEndpoint = "http://127.0.0.1:34596";
const fixtureProvider = "custom-424242";
const put = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); };
const input = (more = {}) => ({ endpoint, apiKey: upstreamSecret, consent: true, ...more });
const protocol = (more = {}) => ({ schema: 1, id: "openai-bridge", models: [{ id: "fixture-model" }, { id: "vendor/model-2:free" }], truncated: false, ...more });
const control = (value) => put(controlFile, value);
const calls = () => { try { return fs.readFileSync(marker, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse); } catch { return []; } };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, message, max = 4000) {
  const started = Date.now();
  while (!check()) { assert.ok(Date.now() - started < max, message); await delay(10); }
}

const source = `const fs=require('node:fs');
const marker=${JSON.stringify(marker)},controlFile=${JSON.stringify(controlFile)},release=${JSON.stringify(releaseFile)},stopped=${JSON.stringify(stoppedFile)},registration=${JSON.stringify(registration)};
let raw='';process.stdin.on('data',c=>raw+=c);process.stdin.on('end',()=>{
 const command=process.argv[2],ctl=JSON.parse(fs.readFileSync(controlFile,'utf8')),input=raw?JSON.parse(raw):null;
 fs.appendFileSync(marker,JSON.stringify({pid:process.pid,entry:process.argv[1],args:process.argv.slice(2),input,envNames:Object.keys(process.env),secretInArgv:!!input?.apiKey&&process.argv.some(v=>v.includes(input.apiKey)),secretInEnv:!!input?.apiKey&&Object.values(process.env).some(v=>v.includes(input.apiKey))})+'\\n');
 const error=(code)=>{console.error(JSON.stringify({schema:1,id:'openai-bridge',error:{code,message:ctl.message||'untrusted fixture diagnostic',apiKey:input?.apiKey}}));process.exitCode=1;};
 const output=()=>{
  if(command==='gui-status'){console.log(JSON.stringify({schema:1,id:'openai-bridge',configured:false,endpoint:'',model:'',hasKey:false,localReady:false}));return;}
  if(command==='gui-configure'){error('RUNTIME_CONFLICT');return;}
  if(command==='uninstall'){fs.rmSync(registration,{force:true});return;}
  if(command!=='gui-models'){process.exitCode=2;return;}
  if(ctl.mode==='error'){error(ctl.code);return;}
  if(ctl.mode==='raw'){process.stdout.write(ctl.raw);return;}
  if(ctl.mode==='binary'){process.stdout.write(Buffer.from([0xff]));process.stdout.write(JSON.stringify(ctl.reply||{}));return;}
  if(ctl.mode==='stderr-raw'){process.stderr.write(ctl.raw);process.exitCode=1;return;}
  if(ctl.mode==='stderr-large'){process.stderr.write('X'.repeat(131073));process.exitCode=1;return;}
  if(ctl.mode==='echo-key'){console.log(JSON.stringify({schema:1,id:'openai-bridge',models:[{id:input.apiKey}],truncated:false}));return;}
  console.log(JSON.stringify(Object.hasOwn(ctl,'reply')?ctl.reply:{schema:1,id:'openai-bridge',models:[{id:'fixture-model'},{id:'vendor/model-2:free'}],truncated:false}));
 };
 if(command==='gui-models'&&ctl.mode==='hang'){
  const timer=setInterval(()=>{},100);
  process.on('SIGTERM',()=>{fs.writeFileSync(stopped,'stopped');clearInterval(timer);});
  setTimeout(()=>{clearInterval(timer);process.exitCode=29;},8000).unref();return;
 }
 if(ctl.gate===command){
  const timer=setInterval(()=>{if(fs.existsSync(release)){clearInterval(timer);output();}},10);
  setTimeout(()=>{clearInterval(timer);process.exitCode=28;},6000).unref();return;
 }
 output();
});`;

const providerFile = path.join(home, "ccapp-providers.json");
const settingsFile = path.join(home, "ccapp-settings.json");
const configFile = path.join(home, "ccapp-config.json");
const seedFile = path.join(home, "ccapp-seed.json");
const credentialsFile = path.join(home, ".claude/.credentials.json");
const oldConfigFiles = [path.join(target, "config.json"), path.join(target, "ccr-config.json"), path.join(target, ".claude-code-router/config.json")];
const protectedFiles = [registration, mapping, providerFile, settingsFile, configFile, seedFile, credentialsFile,
  path.join(target, ".ccr-bridge-kit.json"), path.join(target, "connection.json"), ...oldConfigFiles];
const originalFiles = new Map([...protectedFiles, path.join(prefix, ".devkit-ok")].map((file) => [file, fs.existsSync(file) ? fs.readFileSync(file) : null]));
const originalIndex = structuredClone(compIndexCache);
const originalProviders = structuredClone(providers.PROVIDERS_CFG), originalSettings = structuredClone(SETTINGS);
const originalCFG = { upstream: CFG.upstream, model: CFG.model };
function restoreMemory() {
  for (const key of Object.keys(providers.PROVIDERS_CFG)) delete providers.PROVIDERS_CFG[key];
  Object.assign(providers.PROVIDERS_CFG, structuredClone(originalProviders));
  for (const key of Object.keys(SETTINGS)) delete SETTINGS[key];
  Object.assign(SETTINGS, structuredClone(originalSettings));
  providers.applyProvider(); Object.assign(CFG, originalCFG);
}
function fixture() {
  fs.mkdirSync(path.dirname(component), { recursive: true }); fs.writeFileSync(component, source);
  put(record, { id: "openai-bridge", state: "ok", base: "models-fixture-devkit", files: ["lib/openai-bridge/component.cjs"] });
  put(path.join(prefix, ".devkit-ok"), { sha256: "models-fixture-devkit" });
  control({ mode: "ok" });
}
function existingConfiguration() {
  const provider = { custom: true, label: "existing fake bridge", baseUrl: localEndpoint, apiKey: localSecret, defaultModel: "old-model", authStyle: "bearer" };
  providers.PROVIDERS_CFG.providers[fixtureProvider] = provider; providers.PROVIDERS_CFG.active = fixtureProvider;
  SETTINGS.provider = fixtureProvider; providers.applyProvider();
  put(providerFile, { active: fixtureProvider, providers: { [fixtureProvider]: provider } });
  put(settingsFile, { provider: fixtureProvider, model: "old-model" });
  put(configFile, { apiKey: oldSecret }); put(seedFile, { apiKey: oldSecret });
  put(credentialsFile, { fixtureOnly: true, accessToken: oldSecret });
  for (const file of oldConfigFiles) put(file, { Providers: [{ api_key: oldSecret }], Router: { default: "fixture,old-model" } });
  put(path.join(target, ".ccr-bridge-kit.json"), { id: "ccr-bridge-kit", target, guiManaged: true });
  put(path.join(target, "connection.json"), { baseUrl: localEndpoint, apiKey: localSecret, model: "old-model" });
  put(registration, { schema: 1, id: "openai-bridge", endpoint: localEndpoint, runtimeDir: target, instanceId: "c".repeat(32) });
  put(mapping, { schema: 1, id: "openai-bridge", providerId: fixtureProvider,
    fingerprint: crypto.createHash("sha256").update(localEndpoint + "\0" + localSecret).digest("hex") });
}
function snapshot() {
  return { files: protectedFiles.map((file) => {
    if (!fs.existsSync(file)) return [file, null];
    const stat = fs.statSync(file, { bigint: true });
    return [file, { bytes: fs.readFileSync(file).toString("base64"), mode: String(stat.mode), ino: String(stat.ino), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) }];
  }),
    provider: structuredClone(providers.PROVIDER), providers: structuredClone(providers.PROVIDERS_CFG), settings: structuredClone(SETTINGS), apiKey: providers.API_KEY,
    upstream: CFG.upstream, model: CFG.model };
}
function noSecrets(text) {
  for (const secret of [upstreamSecret, oldSecret, ambientSecret, localSecret]) assert.equal(text.includes(secret), false, "HTTP 不得泄露任何假凭据");
  for (const value of ["keyTail", "connectionPath", "untrusted fixture diagnostic", home, prefix]) assert.equal(text.includes(value), false, "HTTP 不得转发组件私有诊断或路径");
}

// 路由真实读取 Readable 字节并验证 ccBodySha；不用真实网关、访问令牌、Provider 测试接口或任何外部服务。
async function request(body = input(), { pathname = modelsPath, method = "POST", raw, sha, chunks } = {}) {
  const bytes = raw === undefined ? Buffer.from(body === undefined ? "" : JSON.stringify(body)) : Buffer.from(raw);
  const req = Readable.from(chunks || [bytes]);
  Object.assign(req, { method, url: pathname, headers: { "content-type": "application/json", "x-cc-lang": "zh" } });
  if (sha !== undefined) req.ccBodySha = sha === "valid" ? crypto.createHash("sha256").update(bytes).digest("hex") : sha;
  let status, headers, text;
  const res = { req, writeHead(code, h) { status = code; headers = h; }, end(data) { text = String(data); } };
  const url = new URL(pathname, "http://127.0.0.1");
  await routeComponents(req, res, url, url.pathname);
  assert.equal(typeof text, "string", "真实组件路由必须作出响应");
  assert.match(headers["content-type"], /application\/json/); noSecrets(text);
  return { status, body: JSON.parse(text), text, bodyRead: req.readableDidRead };
}
const listItem = async () => (await request(undefined, { pathname: "/api/components", method: "GET" })).body.items.find((item) => item.id === "openai-bridge");
function failed(result, code, status = 400) {
  assert.equal(result.status, status); assert.equal(result.body.ok, false);
  if (code) assert.equal(result.body.code, code);
  assert.ok(["method", "INVALID_INPUT", "KEY_REQUIRED", "KEY_HOST_CHANGED", "RUNTIME_CONFLICT", "BUSY", "not_installed", "consent_required", "invalid_input", "invalid_endpoint", "unsupported_path", "invalid_key",
    "MODELS_AUTH", "MODELS_FORBIDDEN", "MODELS_NOT_FOUND", "MODELS_RATE_LIMIT", "MODELS_TIMEOUT", "MODELS_NETWORK", "MODELS_INVALID_RESPONSE", "MODELS_TOO_LARGE", "MODELS_REDIRECT", "MODELS_FAILED"].includes(result.body.code), "只能返回静态白名单错误码");
  assert.equal("models" in result.body, false); assert.equal("apiKey" in result.body, false);
}
// 上游错误按类别映射状态码，外部客户端才能按码退避（0.6.9 审计 196 上游.8）
function upstreamStatus(code) {
  return ["BUSY", "RUNTIME_CONFLICT", "not_installed"].includes(code) ? 409
    : code === "MODELS_RATE_LIMIT" ? 429
    : code === "MODELS_TIMEOUT" ? 504
    : ["MODELS_NETWORK", "MODELS_FAILED"].includes(code) ? 502
    : code === "MODELS_AUTH" ? 401
    : code === "MODELS_FORBIDDEN" ? 403
    : code === "MODELS_NOT_FOUND" ? 404
    : 400;
}
function success(result, models = protocol().models, truncated = false) {
  assert.equal(result.status, 200); assert.deepEqual(result.body, { ok: true, models, truncated });
}

beforeEach(() => {
  restoreMemory();
  for (const file of [marker, releaseFile, stoppedFile, registration, mapping, record, component, ...protectedFiles]) fs.rmSync(file, { force: true });
  fs.rmSync(target, { recursive: true, force: true });
  fixture(); existingConfiguration();
  // 完全离线的索引缓存只供断言 COMP_JOBS 对外 phase；绝不调用下载或安装。
  compIndexCache.at = Date.now(); compIndexCache.error = "";
  compIndexCache.data = { components: { "openai-bridge": { name: { zh: "fixture", en: "fixture" }, builds: [], source: "preset" } } };
});
afterEach(() => restoreMemory());
after(() => {
  Object.assign(compIndexCache, originalIndex);
  for (const file of [registration, mapping, record, component, ...protectedFiles]) fs.rmSync(file, { force: true });
  fs.rmSync(target, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true });
  for (const [file, bytes] of originalFiles) {
    if (bytes === null) fs.rmSync(file, { force: true });
    else { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes, { mode: 0o600 }); }
  }
});

test("获取模型必须显式 consent=true，任何未同意请求都零组件执行", async () => {
  for (const consent of [undefined, false, null, 0, 1, "true", [], {}]) failed(await request(input({ consent })));
  assert.deepEqual(calls(), []);
});

test("models 仅允许 POST，其余 method 不读取 body 或执行组件", async () => {
  for (const method of ["GET", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
    const result = await request(input(), { method });
    failed(result, "method", 405); assert.equal(result.bodyRead, false);
  }
  assert.deepEqual(calls(), []);
});

test("请求字段白名单仅 endpoint/apiKey/consent，拒绝脚本、路径、模型或旧Key注入", async () => {
  for (const field of ["model", "dir", "port", "command", "args", "env", "component", "modelsUrl", "provider", "oldKey", "keepKey", "__proto__", "constructor"])
    failed(await request({ ...input(), [field]: "fixture-forbidden-value" }));
  for (const value of [null, [], "input", 1, true]) failed(await request(value));
  assert.deepEqual(calls(), []);
});

test("地址/Key 类型与边界在执行组件前验证，不探测或猜测私有路径", async () => {
  for (const value of [undefined, null, 1, {}, "", "http://models.example.invalid/v1", "https://u:p@models.example.invalid/v1", "https://models.example.invalid/v1?key=fake", "https://models.example.invalid/v1#frag", "https://models.example.invalid/private", "https://models.example.invalid/v1/responses", "https://models.example.invalid\\v1", "https://models.example.invalid/\n", "https://" + "x".repeat(2050)])
    failed(await request(input({ endpoint: value })));
  for (const value of [null, 1, false, [], {}, "x".repeat(1025), "key\nline", "key\0value", "key\u007fvalue", "two words"])
    failed(await request(input({ apiKey: value })));
  assert.deepEqual(calls(), []);
});

test("合法根地址、/v1 与完整私有 chat/completions 只规范化后交固定组件，不改写 origin 或私有路径", async () => {
  const before = snapshot();
  for (const value of ["https://models.example.invalid", "https://models.example.invalid/", "https://models.example.invalid/v1/", "https://models.example.invalid/private/chat/completions"])
    success(await request(input({ endpoint: value })));
  assert.deepEqual(calls().map((call) => call.input.endpoint), [normalizedEndpoint, normalizedEndpoint, normalizedEndpoint, "https://models.example.invalid/private/chat/completions"]);
  assert.deepEqual(snapshot(), before);
});

test("固定 gui-models 命令与 Key 只经 stdin；不带 consent，不转发 ambient/env，不回密钥", async () => {
  const before = snapshot();
  success(await request());
  const [call] = calls(); assert.equal(calls().length, 1);
  assert.equal(call.entry, component); assert.deepEqual(call.args, ["gui-models"]);
  assert.deepEqual(call.input, { endpoint: normalizedEndpoint, apiKey: upstreamSecret });
  assert.equal(call.secretInArgv, false); assert.equal(call.secretInEnv, false);
  assert.equal(call.envNames.some((name) => /^(?:ANTHROPIC_|OPENAI_|CCAPP_)/.test(name)), false);
  assert.deepEqual(snapshot(), before, "获取模型不得保存、启动、切换 provider 或修改既有配置");
});

test("已有桥 provider 正在会话中也只读模型，不触碰 RUNS、不启动桥或切换会话", async () => {
  const run = { provider: fixtureProvider, ended: false, child: null, fixtureOnly: true };
  RUNS.set("bridge-models-active-fixture", run);
  try {
    const before = snapshot(); success(await request());
    assert.equal(RUNS.get("bridge-models-active-fixture"), run); assert.deepEqual(run, { provider: fixtureProvider, ended: false, child: null, fixtureOnly: true });
    assert.deepEqual(snapshot(), before); assert.deepEqual(calls().map((call) => call.args), [["gui-models"]]);
  } finally { RUNS.delete("bridge-models-active-fixture"); }
});

test("App 只调用组件，成功和失败均不得自己 fetch/http/https/socket/curl 直连远端", async (t) => {
  const attempts = [], launched = [], blocked = (name) => () => { attempts.push(name); throw new Error("fixture forbids outbound " + name); };
  const spawn = childProcess.spawn;
  const hooks = [t.mock.method(globalThis, "fetch", blocked("fetch")), t.mock.method(http, "request", blocked("http.request")),
    t.mock.method(http, "get", blocked("http.get")), t.mock.method(https, "request", blocked("https.request")),
    t.mock.method(https, "get", blocked("https.get")), t.mock.method(net, "connect", blocked("net.connect")),
    t.mock.method(net, "createConnection", blocked("net.createConnection")), t.mock.method(net.Socket.prototype, "connect", blocked("socket.connect")),
    t.mock.method(childProcess, "spawn", (file, args, options) => {
      launched.push([file, ...args]);
      assert.equal(file, process.execPath); assert.deepEqual(args, [component, "gui-models"]);
      return spawn(file, args, options);
    }), ...["exec", "execFile", "execSync", "execFileSync", "spawnSync"].map((name) => t.mock.method(childProcess, name, blocked("child_process." + name)))];
  syncBuiltinESMExports();
  const before = snapshot();
  try {
    success(await request());
    control({ mode: "error", code: "MODELS_NETWORK", message: upstreamSecret });
    failed(await request(), "MODELS_NETWORK", 502);
    assert.deepEqual(attempts, []); assert.deepEqual(snapshot(), before); assert.equal(launched.length, 2);
    assert.deepEqual(calls().map((call) => call.args), [["gui-models"], ["gui-models"]]);
  } finally { for (const hook of hooks) hook.mock.restore(); syncBuiltinESMExports(); }
});

test("省略/留空 Key 交组件处理，App 不读任何旧凭据、连接配置或 provider 文件", async (t) => {
  const reads = [], secretPaths = new Set(protectedFiles);
  const guarded = (original) => function (file, ...args) {
    const name = typeof file === "string" ? file : file instanceof URL ? file.pathname : "";
    if (secretPaths.has(name) || name.startsWith(target + "/") || name.startsWith(path.dirname(credentialsFile) + "/") ||
        name.startsWith(path.join(home, ".claude-code-router") + "/") || name.startsWith("/proc/self/fd/")) {
      reads.push(name); throw new Error("fixture forbids App credential reads");
    }
    return Reflect.apply(original, this, [file, ...args]);
  };
  const hooks = ["openSync", "readFileSync", "readFile", "createReadStream", "open"].map((name) => t.mock.method(fs, name, guarded(fs[name])));
  hooks.push(t.mock.method(fs.promises, "readFile", guarded(fs.promises.readFile)), t.mock.method(fs.promises, "open", guarded(fs.promises.open)));
  syncBuiltinESMExports();
  try {
    success(await request(input({ apiKey: undefined })));
    success(await request(input({ apiKey: "" })));
    control({ mode: "error", code: "KEY_REQUIRED", message: oldSecret });
    failed(await request(input({ apiKey: undefined })), "KEY_REQUIRED");
    control({ mode: "error", code: "KEY_HOST_CHANGED", message: oldSecret });
    failed(await request(input({ endpoint: "https://other.example.invalid/v1", apiKey: "" })), "KEY_HOST_CHANGED");
    assert.deepEqual(reads, []);
    assert.deepEqual(calls().map((call) => call.args), [["gui-models"], ["gui-models"], ["gui-models"], ["gui-models"]]);
    for (const call of calls()) {
      assert.equal(call.input.apiKey || "", "");
      assert.equal(Object.keys(call.input).some((key) => !["endpoint", "apiKey"].includes(key)), false);
    }
  } finally { for (const hook of hooks) hook.mock.restore(); syncBuiltinESMExports(); }
});

test("响应只投影 id 与 truncated，不透传组件额外字段或假Key", async () => {
  control({ reply: protocol({ apiKey: upstreamSecret, keyTail: "SECRET", connectionPath: home,
    models: [{ id: "fixture-model", apiKey: upstreamSecret, name: oldSecret, path: home }] }) });
  const result = await request();
  if (result.status === 200) success(result, [{ id: "fixture-model" }]);
  else failed(result, "MODELS_INVALID_RESPONSE");
});

test("模型窗口只投影合法context_window，其他远端内容不透传、不把输出上限当窗口", async () => {
  const models = [{ id: "large", context_window: 1048576, apiKey: upstreamSecret },
    { id: "unknown", max_tokens: 32000 }, { id: "bad-string", context_window: "1000000" },
    { id: "bad-negative", context_window: -1 }, { id: "bad-fraction", context_window: 1234.5 },
    { id: "bad-huge", context_window: 16777217 }];
  control({ reply: protocol({ models }) });
  success(await request(), [{ id: "large", context_window: 1048576 }, ...models.slice(1).map((m) => ({ id: m.id }))]);
});

test("恶意组件把本次 API Key 伪装成合法 model id 时不得回显到 HTTP", async () => {
  const before = snapshot();
  control({ mode: "echo-key" }); failed(await request(), "MODELS_INVALID_RESPONSE");
  assert.deepEqual(snapshot(), before);
  control({ mode: "ok" }); success(await request());
});

test("允许空模型清单、truncated=true 与最多 500 个唯一合法 id，不补默认模型", async () => {
  for (const reply of [protocol({ models: [] }), protocol({ models: [{ id: "one" }], truncated: true }),
    protocol({ models: Array.from({ length: 500 }, (_, i) => ({ id: String(i).padStart(4, "0") + "m".repeat(196) })) })]) {
    control({ reply }); success(await request(), reply.models, reply.truncated);
  }
});

const invalidReplies = [
  ["null", null], ["标量", true], ["空对象", {}], ["数组", []], ["schema缺失", { ...protocol(), schema: undefined }],
  ["schema字符串", protocol({ schema: "1" })], ["schema未来版", protocol({ schema: 2 })],
  ["组件id不符", protocol({ id: "other-component" })], ["组件id类型", protocol({ id: 1 })],
  ["models缺失", { ...protocol(), models: undefined }], ["models对象", protocol({ models: {} })],
  ["models字符串", protocol({ models: "fixture-model" })], ["models=null", protocol({ models: null })],
  ["truncated缺失", { ...protocol(), truncated: undefined }], ["truncated字符串", protocol({ truncated: "false" })],
  ["truncated数字", protocol({ truncated: 0 })], ["truncated=null", protocol({ truncated: null })],
  ["超过500个模型", protocol({ models: Array.from({ length: 501 }, (_, i) => ({ id: "m-" + i })) })],
  ["重复id", protocol({ models: [{ id: "same" }, { id: "same" }] })],
  ["合法项后混入非法项", protocol({ models: [{ id: "valid-model" }, { id: 42 }] })],
  ...[null, 1, "model", [], {}, { id: null }, { id: 42 }, { id: {} }, { id: "" }, { id: " " },
    { id: "bad,model" }, { id: "bad\nmodel" },
    { id: "bad\u0000model" }, { id: "bad\u007fmodel" }, { id: "m".repeat(201) }]
    .map((item, i) => ["非法模型条目" + i, protocol({ models: [item] })]),
];
for (const [name, reply] of invalidReplies) test(`恶意组件返回${name}：整包拒绝且释放组件槽`, async () => {
  const before = snapshot();
  control({ reply }); failed(await request(), reply?.models?.length > 500 ? "MODELS_TOO_LARGE" : "MODELS_INVALID_RESPONSE");
  assert.deepEqual(snapshot(), before);
  control({ mode: "ok" }); success(await request(), protocol().models);
  assert.equal((await listItem()).progress, null, "每个协议失败后都须释放 fetching-models 槽");
});

test("非 JSON、截断 JSON、多份 JSON 不转发原始 stdout/stderr", async () => {
  for (const raw of ["", "{", JSON.stringify(protocol()) + "\n" + JSON.stringify(protocol()), upstreamSecret]) {
    control({ mode: "raw", raw }); failed(await request(), "MODELS_INVALID_RESPONSE");
  }
  control({ mode: "binary", reply: protocol() }); failed(await request(), "MODELS_INVALID_RESPONSE");
});

test("模型输出上限是 128KiB 而非配置的 16KiB，超一字节立即拒绝并恢复组件槽", async () => {
  const json = JSON.stringify(protocol()), limit = 128 * 1024;
  const raw = json + " ".repeat(limit - Buffer.byteLength(json));
  control({ mode: "raw", raw }); success(await request());
  control({ mode: "raw", raw: raw + " " }); failed(await request(), "MODELS_TOO_LARGE");
  control({ mode: "stderr-large" }); failed(await request());
  control({ mode: "ok" }); success(await request());
  assert.equal((await listItem()).progress, null);
});

test("组件失败只接受静态 MODELS_* 白名单，未知码/任意异常不得回显或冒充成功", async () => {
  const before = snapshot();
  for (const code of ["MODELS_AUTH", "MODELS_FORBIDDEN", "MODELS_NOT_FOUND", "MODELS_RATE_LIMIT", "MODELS_TIMEOUT", "MODELS_NETWORK", "MODELS_INVALID_RESPONSE", "MODELS_TOO_LARGE", "MODELS_REDIRECT", "MODELS_FAILED", "INVALID_INPUT", "KEY_REQUIRED", "KEY_HOST_CHANGED", "RUNTIME_CONFLICT", "BUSY"])
    { control({ mode: "error", code, message: upstreamSecret + " " + home }); failed(await request(), code, upstreamStatus(code)); }
  for (const code of ["EVIL_" + upstreamSecret, "MODELS_" + upstreamSecret, "MODELS_NOT_A_REAL_CODE", "component_spawn", "__proto__", "constructor"])
    { control({ mode: "error", code, message: oldSecret }); failed(await request(), "MODELS_FAILED", 502); }
  assert.deepEqual(snapshot(), before);
});

test("stderr 的已知错误码也必须有正确 schema/id，其他包一律静态失败", async () => {
  const error = { code: "MODELS_AUTH", message: upstreamSecret + " " + home };
  for (const reply of [{ schema: "1", id: "openai-bridge", error }, { schema: 2, id: "openai-bridge", error },
    { schema: 1, id: "wrong-bridge", error }, { schema: 1, id: "openai-bridge", error: { code: { value: "MODELS_AUTH" } } }]) {
    control({ mode: "stderr-raw", raw: JSON.stringify(reply) }); failed(await request(), "MODELS_FAILED", 502);
  }
  control({ mode: "stderr-raw", raw: upstreamSecret }); failed(await request(), "MODELS_FAILED", 502);
});

test("超时终止短命 gui-models；错误静态、配置不变，finished 后可再次获取", async (t) => {
  const before = snapshot(), scheduled = [], schedule = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (fn, ms, ...args) => {
    if (ms >= 10000) { scheduled.push(ms); return schedule(fn, 600, ...args); }
    return schedule(fn, ms, ...args);
  });
  control({ mode: "hang" });
  failed(await request(), "MODELS_TIMEOUT", 504);
  assert.equal(scheduled.length, 1, "必须确实走生产超时计时器而非 fixture 自行退出");
  await until(() => fs.existsSync(stoppedFile), "超时必须终止组件，不只是提前返回HTTP");   // 组件收到信号后才写这个文件，和 HTTP 返回有先后
  assert.equal(fs.readFileSync(stoppedFile, "utf8"), "stopped", "超时必须终止组件，不只是提前返回HTTP");
  const pid = calls()[0].pid;
  await until(() => { try { process.kill(pid, 0); return false; } catch (error) { return error.code === "ESRCH"; } }, "超时返回后短命组件仍存活");
  assert.deepEqual(snapshot(), before);
  control({ mode: "ok" }); success(await request());
  assert.equal((await listItem()).progress, null);
});

for (const mode of ["ok", "error"]) test(`fetching-models ${mode} 期间与重复获取/安装/卸载/取消互斥，完成后配置与获取恢复`, async () => {
  const before = snapshot();
  control({ mode, code: "MODELS_NETWORK", gate: "gui-models" });
  const pending = request();
  try {
    await until(() => calls().some((call) => call.args[0] === "gui-models"), "模型组件未进入在途状态");
    const item = await listItem(); assert.equal(item.state, "fetching-models"); assert.equal(item.progress.phase, "fetching-models");
    failed(await request(), "BUSY", 409);
    for (const pathname of ["/api/components/install", "/api/components/remove", "/api/components/cancel"]) {
      const result = await request({ id: "openai-bridge" }, { pathname });
      assert.equal(result.body.ok, false); assert.equal(result.body.message, "busy");
    }
    assert.equal(calls().length, 1, "占槽期间绝不能启动第二个组件命令");
  } finally { fs.writeFileSync(releaseFile, "release"); await pending; }
  const result = await pending;
  if (mode === "ok") success(result); else failed(result, "MODELS_NETWORK", 502);
  assert.deepEqual(snapshot(), before);
  assert.equal((await listItem()).progress, null);
  control({ mode: "ok" }); success(await request());
  const configured = await request({ ...input(), model: "new-model" }, { pathname: configPath });
  assert.equal(configured.body.code, "RUNTIME_CONFLICT", "获取结束后配置须进入组件，而不是残留BUSY");
  assert.deepEqual(calls().map((call) => call.args), [["gui-models"], ["gui-models"], ["gui-status"], ["gui-configure"]]);
});

test("config POST 主动抢占 fetch：models 静态失败，helper close 后才配置，2秒内接手不返回 BUSY", async (t) => {
  const before = snapshot(); control({ mode: "hang" });
  const spawn = childProcess.spawn; let modelsChild, childClosed = false;
  const hook = t.mock.method(childProcess, "spawn", (file, args, options) => {
    if (args[0] === component && args[1] !== "gui-models" && modelsChild)
      assert.equal(childClosed, true, "必须等 gui-models 子进程 close 后才可启动配置组件，不能只发信号就放行");
    const child = spawn(file, args, options);
    if (args[0] === component && args[1] === "gui-models") { modelsChild = child; child.once("close", () => { childClosed = true; }); }
    return child;
  });
  syncBuiltinESMExports();
  const pending = request();
  try {
    await until(() => calls().some((call) => call.args[0] === "gui-models"), "模型组件未进入在途状态");
    const started = performance.now();
    const configured = await request({ ...input(), model: "new-model" }, { pathname: configPath });
    const cancelled = await pending;
    assert.ok(performance.now() - started < 2000, "配置必须主动取消在途 helper 并在2秒内接手，不能等15秒网络超时");
    failed(cancelled, "MODELS_FAILED", 502);
    assert.equal(configured.status, 409); assert.equal(configured.body.code, "RUNTIME_CONFLICT", "应执行配置 fixture，不能因在途 fetch 返回 BUSY");
    assert.equal(childClosed, true); assert.equal(fs.readFileSync(stoppedFile, "utf8"), "stopped");
    assert.deepEqual(calls().map((call) => call.args), [["gui-models"], ["gui-status"], ["gui-configure"]]);
    assert.deepEqual(snapshot(), before);
  } finally {
    modelsChild?.kill("SIGTERM"); await pending; hook.mock.restore(); syncBuiltinESMExports();
  }
  assert.equal((await listItem()).progress, null);
  control({ mode: "ok" }); success(await request());
});

test("configure 先占槽时 models 不能交错；configure 失败完成后 models 可正常执行", async () => {
  control({ gate: "gui-configure" });
  const pending = request({ ...input(), model: "fixture-model" }, { pathname: configPath });
  try {
    await until(() => calls().some((call) => call.args[0] === "gui-configure"), "配置组件未进入在途状态");
    failed(await request(), "BUSY", 409);
    assert.deepEqual(calls().map((call) => call.args), [["gui-status"], ["gui-configure"]]);
  } finally { fs.writeFileSync(releaseFile, "release"); await pending; }
  assert.equal((await pending).body.code, "RUNTIME_CONFLICT");
  control({ mode: "ok" }); success(await request());
  assert.equal((await listItem()).progress, null);
});

test("remove 先占槽时 models 不执行；卸载结束并重建假组件后 finished 槽已释放", async () => {
  control({ gate: "uninstall" });
  const pending = request({ id: "openai-bridge" }, { pathname: "/api/components/remove" });
  try {
    await until(() => calls().some((call) => call.args[0] === "uninstall"), "卸载组件未进入在途状态");
    failed(await request(), "BUSY", 409);
    assert.equal(calls().filter((call) => call.args[0] === "gui-models").length, 0);
  } finally { fs.writeFileSync(releaseFile, "release"); await pending; }
  assert.equal((await pending).body.ok, true);
  fixture(); success(await request());
  assert.equal((await listItem()).progress, null);
});

test("请求 sha256 摘要不匹配与无效 JSON 均在执行任何组件前拒绝", async () => {
  const before = snapshot();
  failed(await request(input(), { sha: "0".repeat(64) }));
  for (const raw of ["{", "", JSON.stringify(input()) + "{}"])
    failed(await request(undefined, { raw, sha: "valid" }));
  assert.deepEqual(calls(), []); assert.deepEqual(snapshot(), before);
  success(await request(input(), { sha: "valid" }));
});

test("16KiB body 上限按原始字节和分块执行，签名正确但超一字节也零组件执行", async () => {
  const before = snapshot(), json = JSON.stringify(input()), size = 16 * 1024;
  const exact = json + " ".repeat(size - Buffer.byteLength(json));
  const over = exact + " ";
  for (const chunks of [[Buffer.from(over)], [Buffer.from(over.slice(0, 100)), Buffer.from(over.slice(100))]])
    failed(await request(undefined, { raw: over, chunks, sha: "valid" }));
  assert.deepEqual(calls(), []); assert.deepEqual(snapshot(), before);
  success(await request(undefined, { raw: exact, sha: "valid" }));
  assert.deepEqual(calls().map((call) => call.args), [["gui-models"]]);
});

test("真实 HTTP 客户端 abort：2秒内终止模型 helper 并释放 fetching-models 槽，随后 HTTP 请求可重试", async (t) => {
  const before = snapshot(); control({ mode: "hang" });
  const spawn = childProcess.spawn; let modelsChild, childClosed = false;
  const hook = t.mock.method(childProcess, "spawn", (file, args, options) => {
    const child = spawn(file, args, options);
    if (!modelsChild && args[0] === component && args[1] === "gui-models") {
      modelsChild = child; child.once("close", () => { childClosed = true; });
    }
    return child;
  });
  syncBuiltinESMExports();
  let routeDone = false, responseClosed = false, routeError;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    assert.equal(url.pathname, modelsPath);
    res.once("close", () => { responseClosed = true; });
    Promise.resolve(routeComponents(req, res, url, url.pathname)).then(() => { routeDone = true; }, (error) => {
      routeError = error; routeDone = true;
      if (!res.headersSent && !res.destroyed) { res.writeHead(500); res.end("{}"); }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let client;
  const post = () => new Promise((resolve) => {
    client = http.request(origin + modelsPath, { method: "POST", agent: false, headers: { "content-type": "application/json" } }, (res) => {
      let text = ""; res.setEncoding("utf8"); res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, text }));
      res.on("error", (error) => resolve({ error }));
    });
    client.on("error", (error) => resolve({ error }));
    client.setTimeout(4000, () => client.destroy(new Error("fake abort HTTP request timed out")));
    client.end(JSON.stringify(input()));
  });
  const pending = post();
  try {
    await until(() => calls().some((call) => call.args[0] === "gui-models"), "真实 HTTP 请求未启动模型 helper");
    assert.equal((await listItem()).progress.phase, "fetching-models");
    const started = performance.now(); client.destroy();
    await until(() => routeDone && responseClosed && childClosed, "真实 HTTP abort 后2秒内 helper 未退出或模型路由未释放", 2000);
    assert.ok(performance.now() - started < 2000, "断开请求必须主动取消，不能等待网络超时");
    assert.equal(routeError, undefined); assert.equal(fs.readFileSync(stoppedFile, "utf8"), "stopped");
    const disconnected = await pending; assert.equal(disconnected.error?.code, "ECONNRESET");
    assert.deepEqual(calls().map((call) => call.args), [["gui-models"]]);
    assert.equal((await listItem()).progress, null, "真实 HTTP abort 后 fetching-models 槽必须释放");
    assert.deepEqual(snapshot(), before);
    control({ mode: "ok" });
    const retried = await post(); assert.equal(retried.error, undefined); noSecrets(retried.text);
    success({ status: retried.status, body: JSON.parse(retried.text) });
    assert.deepEqual(calls().map((call) => call.args), [["gui-models"], ["gui-models"]]);
  } finally {
    client?.destroy(); modelsChild?.kill("SIGTERM");
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    await until(() => routeDone, "HTTP abort fixture 清理时路由仍在途");
    hook.mock.restore(); syncBuiltinESMExports();
  }
});

for (const mode of ["signature-mismatch", "overlong"]) test(`真实 HTTP ${mode}：拒绝 body 并零组件执行，不留 busy 状态`, async () => {
  const before = snapshot(); let done;
  const completed = new Promise((resolve) => { done = resolve; });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    assert.equal(url.pathname, modelsPath);
    if (mode === "signature-mismatch") req.ccBodySha = "0".repeat(64);
    Promise.resolve(routeComponents(req, res, url, url.pathname)).then(done, () => {
      if (!res.headersSent && !res.destroyed) { res.writeHead(500); res.end("{}"); }
      done();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    // 超限请求语义上仍是合法 JSON；必须由 16KiB 原始字节限制拒绝，而非字段校验冒充。
    const raw = JSON.stringify(input()) + (mode === "overlong" ? " ".repeat(16385) : "");
    const outcome = await new Promise((resolve) => {
      const req = http.request(`http://127.0.0.1:${server.address().port}${modelsPath}`, { method: "POST", headers: { "content-type": "application/json" } }, (res) => {
        let text = ""; res.setEncoding("utf8"); res.on("data", (chunk) => { text += chunk; });
        res.on("end", () => resolve({ status: res.statusCode, text }));
      });
      req.on("error", (error) => resolve({ error }));
      req.setTimeout(3000, () => req.destroy(new Error("fake models request timed out")));
      req.end(raw);
    });
    await completed;
    if (outcome.error) {
      assert.equal(mode, "overlong", "摘要不匹配应正常返回JSON而非意外断连");
      assert.equal(outcome.error.code, "ECONNRESET", "仅接受readBodyBuf主动destroy的断连");
    } else {
      noSecrets(outcome.text); failed({ status: outcome.status, body: JSON.parse(outcome.text) }, "invalid_input");
    }
    assert.deepEqual(calls(), []); assert.deepEqual(snapshot(), before);
    success(await request());
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});

test("安装记录损坏/入口软链/缺失时模型接口不执行其他脚本或回传私有路径", async () => {
  put(record, { id: "openai-bridge", state: "ok", files: ["lib/openai-bridge/component.cjs", "../escape"] });
  failed(await request(), undefined, 409); assert.deepEqual(calls(), []);
  fixture(); const other = path.join(root, "untrusted-component.cjs");
  fs.renameSync(component, other); fs.symlinkSync(other, component);
  failed(await request(), undefined, 409); assert.deepEqual(calls(), []);
  fs.rmSync(component); fs.rmSync(record);
  failed(await request(), undefined, 409); assert.deepEqual(calls(), []);
  fixture(); success(await request());
  assert.equal((await listItem()).progress, null);
});
