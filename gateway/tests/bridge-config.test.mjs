import "../gw/config.mjs";
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { performance } from "node:perf_hooks";
import crypto from "node:crypto";
import { registryFlockFixture, guardRegistryFlock } from "./fixtures/registry-flock.mjs";
import { routeComponents } from "../gw/components.mjs";
import { normalizeBridgeEndpoint } from "../gw/bridge-config.mjs";
import { PROVIDER, PROVIDERS_CFG, upsertProvider } from "../gw/providers.mjs";
import { SETTINGS } from "../gw/settings-store.mjs";
import { RUNS } from "../gw/runs.mjs";
import { cachedModels, fetchModels, routeModels } from "../gw/models.mjs";
import { claudeEnv } from "../gw/claude.mjs";

const home = process.env.CCAPP_HOME, prefix = process.env.CCAPP_PREFIX;
const root = fs.mkdtempSync(path.join(process.env.CCAPP_WORKSPACE, "bridge-config-"));
const target = path.join(home, ".local/share/ccr-bridge-kit");
const registration = path.join(home, ".cccodroid/services/openai-bridge.json");
const record = path.join(path.dirname(prefix), "components/openai-bridge.json");
const component = path.join(prefix, "lib/openai-bridge/component.cjs");
const marker = path.join(root, "calls");
const stateFile = path.join(root, "state");
const modeFile = path.join(root, "mode");
const upstreamSecret = "fixture-upstream-key-NOT-FOR-OUTPUT";
const localSecret = "a".repeat(48), freshLocalSecret = "d".repeat(48);
const put = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); };
const source = `const fs=require('node:fs'),path=require('node:path');
const marker=${JSON.stringify(marker)},stateFile=${JSON.stringify(stateFile)},modeFile=${JSON.stringify(modeFile)},target=${JSON.stringify(target)},reg=${JSON.stringify(registration)};
let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{
 const command=process.argv[2],mode=fs.readFileSync(modeFile,'utf8');
 fs.appendFileSync(marker,JSON.stringify({args:process.argv.slice(2),hasUpstreamEnv:!!process.env.ANTHROPIC_API_KEY||!!process.env.OPENAI_API_KEY,hasAppEnv:!!process.env.CCAPP_RUN,fields:input?Object.keys(JSON.parse(input)):[]})+'\\n');
 const write=(p,v)=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(v),{mode:0o600});};
 if(mode==='conflict'){console.error(JSON.stringify({schema:1,id:'openai-bridge',error:{code:'RUNTIME_CONFLICT',check:'APP_PROVIDER',detail:${JSON.stringify(upstreamSecret)},message:'must not forward '+${JSON.stringify(upstreamSecret)}}}));process.exitCode=1;return;}
 let state=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile,'utf8')):null;
 const view=()=>({schema:1,id:'openai-bridge',configured:!!state,endpoint:state?.endpoint||'',model:state?.model||'',...(state?.models?{models:state.models}:{}),hasKey:!!state,localReady:!!state&&mode!=='not-ready',...(mode.startsWith('local:')?{localError:mode.slice(6)}:{}),apiKey:${JSON.stringify(upstreamSecret)},keyTail:'LEAK',connectionPath:'/untrusted/path'});
 if(command==='gui-status'){const output=()=>console.log(JSON.stringify(view()));if(mode==='delay')setTimeout(output,200);else output();return;}
 if(command==='uninstall'){fs.rmSync(reg,{force:true});return;}
 if(command!=='gui-configure'){process.exitCode=2;return;}
 const body=JSON.parse(input);
 if(body.apiKey)state={...body};else state={...body,apiKey:state.apiKey};
 write(stateFile,state);write(path.join(target,'.ccr-bridge-kit.json'),{id:'ccr-bridge-kit',target,guiManaged:true,service:{schema:1,home:process.env.HOME,instanceId:'b'.repeat(32)},settings:path.join(process.env.HOME,'.claude/settings.json'),componentEntry:process.argv[1]});write(path.join(target,'connection.json'),{baseUrl:'http://127.0.0.1:34597',apiKey:mode==='fresh'?${JSON.stringify(freshLocalSecret)}:${JSON.stringify(localSecret)},model:state.model});
 write(reg,{schema:1,id:'openai-bridge',endpoint:'http://127.0.0.1:34597',runtimeDir:target,instanceId:'b'.repeat(32)});
 fs.mkdirSync(path.join(target,'runtime-home/.claude-code-router'),{recursive:true,mode:0o700});
 write(path.join(target,'runtime-home/.claude-code-router/config.json'),{fixture:true,model:state.model,models:state.models||[state.model]});
 const output=()=>console.log(JSON.stringify(view()));
 if(mode==='delay')setTimeout(output,200);else output();
});`;
function fixture() {
  fs.mkdirSync(path.dirname(component), { recursive: true }); fs.writeFileSync(component, source);
  put(record, { id: "openai-bridge", state: "ok", files: ["lib/openai-bridge/component.cjs"] });
  fs.writeFileSync(modeFile, "ok");
}
function calls() { try { return fs.readFileSync(marker, "utf8").trim().split("\n").map(JSON.parse); } catch { return []; } }
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  Promise.resolve(routeComponents(req, res, url, url.pathname)).catch(() => { res.writeHead(500); res.end("{}"); });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
async function request(body, endpoint = "/api/components/openai-bridge/config") {
  const response = await fetch(origin + endpoint, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", "x-cc-lang": "zh" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  assert.equal(text.includes(upstreamSecret), false); assert.equal(text.includes(localSecret), false); assert.equal(text.includes(freshLocalSecret), false); assert.equal(text.includes("keyTail"), false);
  return { status: response.status, body: JSON.parse(text) };
}
const input = (more = {}) => ({ endpoint: "https://api.example.invalid/v1", apiKey: upstreamSecret, model: "fixture-model", consent: true, ...more });
const providerTempWrite = (name) => {
  try {
    const file = typeof name === "number" ? fs.readlinkSync(`/proc/self/fd/${name}`) : String(name);
    return file.startsWith(path.join(home, "ccapp-providers.json") + ".") && file.endsWith(".tmp");
  } catch { return false; }
};
beforeEach(() => {
  for (const file of [marker, stateFile, registration, record, component, path.join(path.dirname(registration), "openai-bridge-app.json")]) fs.rmSync(file, { force: true });
  fs.rmSync(target, { recursive: true, force: true });
  fixture();
});
after(async () => {
  server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  for (const file of [registration, record, component]) fs.rmSync(file, { force: true });
  fs.rmSync(target, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true });
});

test("地址只补全标准根/v1，完整chat completions原样使用，不猜私有路径", () => {
  for (const value of ["https://api.example.invalid", "https://api.example.invalid/", "https://api.example.invalid/v1/"])
    assert.equal(normalizeBridgeEndpoint(value), "https://api.example.invalid/v1/chat/completions");
  assert.equal(normalizeBridgeEndpoint("https://api.example.invalid/private/chat/completions"), "https://api.example.invalid/private/chat/completions");
  for (const value of ["http://api.example.invalid", "https://x.invalid/private", "https://x.invalid/v1/responses", "https://user:pass@x.invalid", "https://x.invalid/v1?key=fake", "https://x.invalid/v1#fragment", "https://x.invalid\\v1"])
    assert.throws(() => normalizeBridgeEndpoint(value));
});

test("GET只调用固定gui-status并且不返回任何密钥或路径", async () => {
  const result = await request();
  assert.equal(result.status, 200); assert.equal(result.body.installed, true); assert.equal(result.body.configured, false);
  assert.deepEqual(calls().map((call) => call.args), [["gui-status"]]);
  assert.equal("connectionPath" in result.body, false);
});

test("保存必须明确consent且拒绝dir/port/命令等额外字段，不执行组件", async () => {
  for (const body of [input({ consent: false }), input({ consent: undefined }), input({ dir: "/untrusted" }), input({ port: 12345 }), input({ command: "uninstall" })])
    assert.equal((await request(body)).status, 400);
  assert.equal(calls().length, 0);
});

test("三字段只经stdin，本地密钥不回HTTP且保存不发送远端测试", async () => {
  process.env.ANTHROPIC_API_KEY = "fixture-ambient-secret"; process.env.CCAPP_RUN = "fixture-run";
  try {
    const active = PROVIDER.id, setting = SETTINGS.provider;
    const result = await request(input());
    assert.equal(result.status, 200); assert.equal(result.body.saved, true); assert.equal(result.body.localReady, true);
    assert.match(result.body.providerId, /^custom-[1-9][0-9]*$/);
    assert.equal(PROVIDER.id, active); assert.equal(SETTINGS.provider, setting);
    const provider = PROVIDERS_CFG.providers[result.body.providerId];
    assert.equal(provider.baseUrl, "http://127.0.0.1:34597"); assert.equal(provider.apiKey, localSecret);
    assert.equal(provider.defaultModel, "fixture-model");
    assert.equal(JSON.stringify(provider).includes(upstreamSecret), false);
    assert.equal(fs.statSync(path.join(home, "ccapp-providers.json")).mode & 0o777, 0o600);
    assert.equal(result.body.endpoint, "https://api.example.invalid/v1/chat/completions");
    assert.deepEqual(calls().map((call) => call.args), [["gui-status"], ["gui-configure"]]);
    assert.deepEqual(calls()[1].fields.sort(), ["apiKey", "endpoint", "model"]);
    assert.equal(calls().some((call) => call.hasUpstreamEnv || call.hasAppEnv), false);
  } finally { delete process.env.ANTHROPIC_API_KEY; delete process.env.CCAPP_RUN; }
});

test("同origin留空保留旧key；换host没新key必须拒绝且不执行configure", async () => {
  const first = await request(input());
  const updated = await request(input({ apiKey: "", model: "second-model" }));
  assert.equal(updated.status, 200); assert.equal(updated.body.model, "second-model");
  assert.equal(updated.body.providerId, first.body.providerId);
  assert.equal((await request()).body.providerId, first.body.providerId);
  assert.equal(PROVIDERS_CFG.providers[first.body.providerId].defaultModel, "second-model");
  const before = calls().filter((call) => call.args[0] === "gui-configure").length;
  const rejected = await request(input({ apiKey: "", endpoint: "https://other.example.invalid/v1" }));
  assert.equal(rejected.status, 400); assert.equal(rejected.body.field, "apiKey");
  assert.equal(calls().filter((call) => call.args[0] === "gui-configure").length, before);
});

test("卸载只清自己的映射，fresh GUI新key可保存为新provider且保留旧配置", async () => {
  const active = PROVIDER.id, setting = SETTINGS.provider;
  const first = await request(input());
  assert.equal(first.status, 200);
  const oldId = first.body.providerId, oldProvider = structuredClone(PROVIDERS_CFG.providers[oldId]);
  const mapping = path.join(path.dirname(registration), "openai-bridge-app.json");
  const neighbor = path.join(path.dirname(registration), "other-bridge-app.json");
  put(neighbor, { preserved: true });
  try {
    assert.equal(fs.existsSync(mapping), true);
    const removed = await request({ id: "openai-bridge" }, "/api/components/remove");
    assert.equal(removed.body.ok, true);
    assert.equal(fs.existsSync(mapping), false);
    assert.equal(fs.existsSync(record), false);
    assert.equal(fs.existsSync(component), false);
    assert.deepEqual(PROVIDERS_CFG.providers[oldId], oldProvider);
    assert.equal(JSON.parse(fs.readFileSync(path.join(target, "connection.json"), "utf8")).apiKey, localSecret);
    assert.deepEqual(JSON.parse(fs.readFileSync(neighbor, "utf8")), { preserved: true });
    // 用户另行处理已保留的旧私有运行目录，再模拟新组件和全新 GUI 实例；卸载本身不 purge。
    fs.rmSync(target, { recursive: true, force: true }); fs.rmSync(stateFile, { force: true });
    fixture(); fs.writeFileSync(modeFile, "fresh");
    const second = await request(input({ model: "fresh-model" }));
    assert.equal(second.status, 200); assert.equal(second.body.saved, true); assert.equal(second.body.localReady, true);
    assert.notEqual(second.body.providerId, oldId);
    assert.equal(PROVIDERS_CFG.providers[second.body.providerId].apiKey, freshLocalSecret);
    assert.deepEqual(PROVIDERS_CFG.providers[oldId], oldProvider);
    assert.equal((await request()).body.providerId, second.body.providerId);
    assert.equal(PROVIDER.id, active); assert.equal(SETTINGS.provider, setting);
  } finally { fs.rmSync(neighbor, { force: true }); }
});

test("终端卸载没清映射：重装后新实例沿用原接口号保存，状态里不报失效的旧连接", async () => {
  const first = await request(input({ contextWindow: 262144 }));
  assert.equal(first.status, 200);
  const oldId = first.body.providerId;
  const mapping = path.join(path.dirname(registration), "openai-bridge-app.json");
  // 终端卸载：组件自己摘注册、留目录，不经过 App，网关映射还在
  fs.rmSync(registration, { force: true }); fs.rmSync(target, { recursive: true, force: true }); fs.rmSync(stateFile, { force: true });
  assert.equal(fs.existsSync(mapping), true);
  fixture(); fs.writeFileSync(modeFile, "fresh");
  const before = (await request()).body;
  assert.equal(before.providerId, "");
  assert.equal(before.contextWindow, 262144, "表单要带回原来的窗口，修复性保存才不会清掉它");
  const second = await request(input({ model: "fresh-model", contextWindow: before.contextWindow }));
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.providerId, oldId);
  assert.equal(PROVIDERS_CFG.providers[oldId].apiKey, freshLocalSecret);
  assert.equal(PROVIDERS_CFG.providers[oldId].defaultModel, "fresh-model");
  assert.equal((await request()).body.providerId, oldId);
  assert.equal(PROVIDERS_CFG.providers[oldId].contextWindow, 262144);
});

test("映射对不上新实例时：组件已配好、接口还连旧实例，状态不报旧接口；接口被改过照样冲突", async () => {
  const first = await request(input());
  const oldId = first.body.providerId, provider = PROVIDERS_CFG.providers[oldId];
  // 直接让组件换成新实例（新本地密钥），网关还没保存
  const comp = JSON.parse(fs.readFileSync(path.join(target, "connection.json"), "utf8"));
  fs.writeFileSync(path.join(target, "connection.json"), JSON.stringify({ ...comp, apiKey: freshLocalSecret }), { mode: 0o600 });
  const status = await request();
  assert.equal(status.status, 200, JSON.stringify(status.body));
  assert.equal(status.body.providerId, "");
  assert.equal(status.body.contextWindow, provider.contextWindow || 0);
  const original = provider.apiKey;
  provider.apiKey = "e".repeat(48);          // 有人动过那家接口：指纹自洽不成立
  try {
    const bad = await request();
    assert.equal(bad.status, 409); assert.equal(bad.body.code, "RUNTIME_CONFLICT");
  } finally { provider.apiKey = original; }
});

test("专用provider正在处理会话时拒绝重配，不改当前实例", async () => {
  const first = await request(input());
  const before = calls().filter((call) => call.args[0] === "gui-configure").length;
  RUNS.set("bridge-config-busy-fixture", { provider: first.body.providerId, ended: false });
  try {
    const result = await request(input({ model: "new-model" }));
    assert.equal(result.status, 409); assert.equal(result.body.code, "BUSY");
    assert.equal(calls().filter((call) => call.args[0] === "gui-configure").length, before);
  } finally { RUNS.delete("bridge-config-busy-fixture"); }
});

test("同名映射的provider被用户改成其他接口后不覆盖也不执行configure", async () => {
  const first = await request(input());
  const provider = PROVIDERS_CFG.providers[first.body.providerId];
  const original = provider.baseUrl;
  provider.baseUrl = "https://other.example.invalid";
  const before = calls().filter((call) => call.args[0] === "gui-configure").length;
  try {
    const result = await request(input());
    assert.equal(result.status, 409); assert.equal(result.body.code, "RUNTIME_CONFLICT");
    assert.equal(calls().filter((call) => call.args[0] === "gui-configure").length, before);
    assert.equal(provider.baseUrl, "https://other.example.invalid");
  } finally { provider.baseUrl = original; }
});

test("provider写入失败与组件配置落盘分开报告，不泄露底层路径", async () => {
  const state = path.join(path.dirname(registration), "openai-bridge-app.json");
  fs.mkdirSync(state, { recursive: true });
  try {
    const result = await request(input());
    assert.equal(result.status, 409); assert.equal(result.body.saved, true); assert.equal(result.body.code, "RUNTIME_CONFLICT");
    assert.equal(JSON.stringify(result.body).includes(home), false);
    assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).model, "fixture-model");
  } finally { fs.rmdirSync(state); }
});

test("落盘成功但本地未就绪独立报告，不冒充远端连接成功", async () => {
  fs.writeFileSync(modeFile, "not-ready");
  const result = await request(input());
  assert.equal(result.status, 200); assert.equal(result.body.saved, true); assert.equal(result.body.localReady, false);
  assert.equal(result.body.local.state, "stopped");
});

for (const code of ["RECOVERY_EXHAUSTED", "PATCH_VERIFICATION_FAILED", "COMPONENT_DISABLED", "LOCAL_START_FAILED", "COMPONENT_UNAVAILABLE", "UPDATE_REQUIRED"]) test(`本地错误${code}在状态和连续保存中保留，健康残存进程也不能就绪`, async () => {
  fs.writeFileSync(modeFile, "local:" + code);
  for (let i = 0; i < 3; i++) {
    const saved = await request(input());
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.configured, true); assert.equal(saved.body.saved, true);
    assert.equal(saved.body.localReady, false); assert.equal(saved.body.localError, code);
    assert.deepEqual(saved.body.local, { state: "error", code });
    const status = await request();
    assert.equal(status.body.localReady, false); assert.equal(status.body.localError, code);
    assert.deepEqual(status.body.local, { state: "error", code });
  }
});

test("未知本地错误不透传组件消息或秘密，按通用故障失败关闭", async () => {
  fs.writeFileSync(modeFile, "local:" + upstreamSecret);
  const result = await request(input());
  assert.equal(result.body.localReady, false); assert.equal(result.body.localError, "LOCAL_START_FAILED");
});

test("已有同版手工实例没有GUI标记时不接管或调用configure", async () => {
  await request(input());
  const manifest = path.join(target, ".ccr-bridge-kit.json");
  put(manifest, { id: "ccr-bridge-kit", target });
  const before = calls().filter((call) => call.args[0] === "gui-configure").length;
  const result = await request(input({ model: "do-not-save" }));
  assert.equal(result.status, 409); assert.equal(result.body.code, "RUNTIME_CONFLICT");
  assert.equal(calls().filter((call) => call.args[0] === "gui-configure").length, before);
  assert.deepEqual(JSON.parse(fs.readFileSync(manifest, "utf8")), { id: "ccr-bridge-kit", target });
});

test("组件统一冲突只报告检查环节，不猜测旧安装或透传私密诊断", async () => {
  fs.writeFileSync(modeFile, "conflict");
  const result = await request(input());
  assert.equal(result.status, 409); assert.equal(result.body.code, "RUNTIME_CONFLICT"); assert.equal(result.body.saved, false);
  assert.equal(result.body.check, "COMPONENT");
  assert.match(result.body.message, /一致性检查未通过/); assert.equal(result.body.message.includes("请先备份"), false);
  assert.deepEqual(calls().map((call) => call.args), [["gui-status"]]);
});

test("只读检查用固定白名单区分App接口、清单、映射和连接错误，绝不自动修复", async () => {
  const first = await request(input()), provider = PROVIDERS_CFG.providers[first.body.providerId];
  const mappingFile = path.join(path.dirname(registration), "openai-bridge-app.json"), mapping = fs.readFileSync(mappingFile);
  const connectionFile = path.join(target, "connection.json"), connection = fs.readFileSync(connectionFile);
  const baseline = structuredClone(provider);
  const expectCheck = async (check) => {
    const before = calls().length, result = await request();
    assert.equal(result.status, 409); assert.equal(result.body.code, "RUNTIME_CONFLICT"); assert.equal(result.body.check, check);
    assert.equal(calls().length, before + 1); assert.equal(calls().at(-1).args[0], "gui-status");
    assert.equal(result.body.message.includes("请先备份"), false);
    return result;
  };
  for (const change of [p => { p.apiKey = "e".repeat(48); }, p => { p.authStyle = "x-api-key"; }]) {
    change(provider); await expectCheck("APP_PROVIDER"); Object.assign(provider, structuredClone(baseline));
  }
  provider.modelsUrl = "https://untrusted.example.invalid/private-models";
  await expectCheck("MODEL_LIST"); Object.assign(provider, structuredClone(baseline));
  put(mappingFile, { schema: 999 }); await expectCheck("APP_MAPPING"); assert.deepEqual(JSON.parse(fs.readFileSync(mappingFile)), { schema: 999 });
  fs.writeFileSync(mappingFile, mapping);
  const wrong = JSON.parse(connection); wrong.model = "different-fixture-model"; put(connectionFile, wrong);
  await expectCheck("CONNECTION"); assert.equal(JSON.parse(fs.readFileSync(connectionFile)).model, wrong.model);
  fs.writeFileSync(connectionFile, connection);
  const manifestFile = path.join(target, ".ccr-bridge-kit.json"), manifest = fs.readFileSync(manifestFile);
  put(manifestFile, { id: "ccr-bridge-kit", target }); await expectCheck("OWNERSHIP"); fs.writeFileSync(manifestFile, manifest);
  assert.deepEqual(provider, baseline); assert.deepEqual(fs.readFileSync(mappingFile), mapping); assert.deepEqual(fs.readFileSync(connectionFile), connection);
});

const repairRequest = body => request(body, "/api/components/openai-bridge/repair");
const inspectRepair = () => repairRequest({ action: "inspect", consent: true });
const applyRepair = ticket => repairRequest({ action: "apply", consent: true, ticket });

test("修复方案只读，确认后只同步同实例App模型清单并保留逐模型窗口", async () => {
  const models = [{ id: "fixture-model", contextWindow: 1048576 }, { id: "second", contextWindow: 128000 }];
  const first = await request(input({ models })), id = first.body.providerId, provider = PROVIDERS_CFG.providers[id];
  const originalUrl = provider.modelsUrl, active = PROVIDER.id, setting = SETTINGS.provider;
  const data = JSON.parse(Buffer.from(originalUrl.split(",")[1], "base64").toString()); data.data.pop();
  upsertProvider(id, { modelsUrl: "data:application/json;base64," + Buffer.from(JSON.stringify(data)).toString("base64") });
  const mapping = path.join(path.dirname(registration), "openai-bridge-app.json"), beforeMapping = fs.readFileSync(mapping);
  const beforeProvider = fs.readFileSync(path.join(home, "ccapp-providers.json")), beforeConnection = fs.readFileSync(path.join(target, "connection.json"));
  const plan = await inspectRepair();
  assert.equal(plan.status, 200, JSON.stringify(plan.body)); assert.equal(plan.body.repair.available, true);
  assert.deepEqual(plan.body.repair.changes, ["MODELS"]); assert.match(plan.body.repair.ticket, /^[0-9a-f]{48}$/);
  assert.deepEqual(plan.body.repair.models, [{ id: "fixture-model", contextWindow: 1048576 }, { id: "second", contextWindow: 200000 }]);
  assert.deepEqual(fs.readFileSync(mapping), beforeMapping); assert.deepEqual(fs.readFileSync(path.join(home, "ccapp-providers.json")), beforeProvider);
  assert.equal(JSON.stringify(plan.body).includes(home), false); assert.equal(JSON.stringify(plan.body).includes("fingerprint"), false);
  const result = await applyRepair(plan.body.repair.ticket); assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.repaired, true);
  assert.equal(result.body.scope, "APP_METADATA"); assert.equal(result.body.providerId, id);
  assert.equal((await request()).body.providerId, id); assert.deepEqual((await request()).body.models, plan.body.repair.models);
  assert.deepEqual(fs.readFileSync(path.join(target, "connection.json")), beforeConnection); assert.equal(PROVIDER.id, active); assert.equal(SETTINGS.provider, setting);
  assert.equal(calls().filter(c => c.args[0] !== "gui-status" && c.args[0] !== "gui-configure").length, 0);
  assert.equal(calls().filter(c => c.args[0] === "gui-configure").length, 1, "repair never calls configure/start/ensure");
  assert.equal((await applyRepair(plan.body.repair.ticket)).body.code, "REPAIR_STALE");
});

test("认证样式修复必须连接地址密钥和归属仍一致，确认后恢复bearer不改本地Key", async () => {
  const first = await request(input()), id = first.body.providerId;
  upsertProvider(id, { authStyle: "x-api-key" });
  const plan = await inspectRepair(); assert.equal(plan.status, 200, JSON.stringify(plan.body)); assert.deepEqual(plan.body.repair.changes, ["AUTH_STYLE"]);
  const result = await applyRepair(plan.body.repair.ticket); assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(PROVIDERS_CFG.providers[id].authStyle, "bearer"); assert.equal(PROVIDERS_CFG.providers[id].apiKey, localSecret);
});

test("修复拒绝无许可、任意字段、坏ticket、无需修复及真实连接改动", async () => {
  for (const body of [{ action: "inspect" }, { action: "inspect", consent: false }, { action: "apply", consent: true }, { action: "inspect", consent: true, providerId: "custom-1" }, { action: "inspect", consent: true, ticket: "a".repeat(48) }])
    assert.equal((await repairRequest(body)).body.code, "invalid_input");
  const first = await request(input()), id = first.body.providerId;
  assert.equal((await inspectRepair()).body.code, "REPAIR_NOT_NEEDED");
  upsertProvider(id, { baseUrl: "https://other.example.invalid" });
  const changed = await inspectRepair(); assert.equal(changed.body.code, "REPAIR_UNAVAILABLE");
});

test("计划后接口或注册实例改变不能执行，ticket单次消费且不覆盖新状态", async () => {
  const first = await request(input()), id = first.body.providerId;
  upsertProvider(id, { authStyle: "x-api-key" });
  const plan = await inspectRepair(); assert.equal(plan.status, 200, JSON.stringify(plan.body));
  upsertProvider(id, { label: "changed after inspection" });
  assert.equal((await applyRepair(plan.body.repair.ticket)).body.code, "REPAIR_STALE");
  assert.equal(PROVIDERS_CFG.providers[id].authStyle, "x-api-key"); assert.equal(PROVIDERS_CFG.providers[id].label, "changed after inspection");
  const second = await inspectRepair(); assert.equal(second.status, 200, JSON.stringify(second.body));
  const reg = JSON.parse(fs.readFileSync(registration)); put(registration, { ...reg, instanceId: "c".repeat(32) });
  const result = await applyRepair(second.body.repair.ticket); assert.equal(result.body.code, "REPAIR_UNAVAILABLE");
  assert.equal(PROVIDERS_CFG.providers[id].authStyle, "x-api-key");
});

test("恢复锁、停用、组件冲突和活动会话不提供自动修复，不清任何标记", async () => {
  const first = await request(input()), id = first.body.providerId;
  upsertProvider(id, { authStyle: "x-api-key" });
  for (const mode of ["local:RECOVERY_EXHAUSTED", "local:PATCH_VERIFICATION_FAILED", "local:COMPONENT_DISABLED", "conflict", "not-ready"]) {
    fs.writeFileSync(modeFile, mode); assert.equal((await inspectRepair()).body.code, "REPAIR_UNAVAILABLE");
  }
  fs.writeFileSync(modeFile, "ok");
  const disabled = path.join(target, "disabled"); fs.writeFileSync(disabled, "configuring\n", { mode: 0o600 });
  assert.equal((await inspectRepair()).body.code, "REPAIR_UNAVAILABLE"); assert.equal(fs.readFileSync(disabled, "utf8"), "configuring\n"); fs.unlinkSync(disabled);
  RUNS.set("repair-busy-fixture", { provider: id, ended: false });
  try { assert.equal((await inspectRepair()).body.code, "BUSY"); } finally { RUNS.delete("repair-busy-fixture"); }
  assert.equal(PROVIDERS_CFG.providers[id].authStyle, "x-api-key");
});

test("修复计划60秒过期和随机伪造ticket均拒绝，不写任何记录", async (t) => {
  const first = await request(input()), id = first.body.providerId;
  upsertProvider(id, { authStyle: "x-api-key" });
  const plan = await inspectRepair(); assert.equal(plan.status, 200, JSON.stringify(plan.body));
  const originalNow = performance.now.bind(performance), hook = t.mock.method(performance, "now", () => originalNow() + 61000);
  try { assert.equal((await applyRepair(plan.body.repair.ticket)).body.code, "REPAIR_STALE"); }
  finally { hook.mock.restore(); }
  assert.equal((await applyRepair("e".repeat(48))).body.code, "REPAIR_STALE"); assert.equal(PROVIDERS_CFG.providers[id].authStyle, "x-api-key");
});

test("修复持锁忙碌不动配置，原ticket已消费且不能重放", async (t) => {
  const first = await request(input()), id = first.body.providerId;
  upsertProvider(id, { authStyle: "x-api-key" }); const plan = await inspectRepair(); assert.equal(plan.status, 200, JSON.stringify(plan.body));
  const flock = registryFlockFixture(), guard = guardRegistryFlock(t, flock); flock.reset("busy");
  try { assert.equal((await applyRepair(plan.body.repair.ticket)).body.code, "REPAIR_UNAVAILABLE"); }
  finally { guard.restore(); flock.reset(); }
  assert.equal(PROVIDERS_CFG.providers[id].authStyle, "x-api-key"); assert.equal((await applyRepair(plan.body.repair.ticket)).body.code, "REPAIR_STALE");
});

test("修复拒绝磁盘接口与内存不一致，不能覆盖设备上新写的接口", async () => {
  const first = await request(input()), id = first.body.providerId;
  upsertProvider(id, { authStyle: "x-api-key" });
  const file = path.join(home, "ccapp-providers.json"), disk = JSON.parse(fs.readFileSync(file));
  disk.providers[id].label = "external edit must survive"; put(file, disk);
  assert.equal((await inspectRepair()).body.code, "REPAIR_UNAVAILABLE"); assert.equal(JSON.parse(fs.readFileSync(file)).providers[id].label, "external edit must survive");
});

test("修复拒绝检查前发生的字段删除和无关接口变更，不以旧整表覆盖磁盘", async () => {
  const first = await request(input()), id = first.body.providerId;
  const other = upsertProvider(null, { label: "unrelated fixture", baseUrl: "https://old.example.invalid", apiKey: "fixture-other-old" }).id;
  upsertProvider(id, { authStyle: "x-api-key" });
  const file = path.join(home, "ccapp-providers.json"), before = fs.readFileSync(file);
  for (const mutation of [disk => { delete disk.providers[id].apiKey; }, disk => { disk.providers[other].baseUrl = "https://new.example.invalid"; disk.providers[other].apiKey = "fixture-other-new"; }, disk => { disk.active = other; }]) {
    const disk = JSON.parse(before); mutation(disk); put(file, disk); const changed = fs.readFileSync(file);
    try { assert.equal((await inspectRepair()).body.code, "REPAIR_UNAVAILABLE"); assert.deepEqual(fs.readFileSync(file), changed); }
    finally { fs.writeFileSync(file, before); }
  }
});

test("修复写入不跟随旧固定tmp软链，不覆写其他文件或把接口文件变成链接", async () => {
  const first = await request(input()), id = first.body.providerId;
  upsertProvider(id, { authStyle: "x-api-key" });
  const file = path.join(home, "ccapp-providers.json"), temp = file + ".tmp", sentinel = path.join(root, "provider-write-sentinel");
  fs.writeFileSync(sentinel, "sentinel must stay byte identical", { mode: 0o600 }); fs.symlinkSync(sentinel, temp);
  try {
    const plan = await inspectRepair(); assert.equal(plan.status, 200, JSON.stringify(plan.body));
    const result = await applyRepair(plan.body.repair.ticket); assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(fs.readFileSync(sentinel, "utf8"), "sentinel must stay byte identical");
    assert.equal(fs.lstatSync(file).isSymbolicLink(), false); assert.equal(fs.statSync(file).mode & 0o077, 0);
  } finally {
    if (fs.lstatSync(file).isSymbolicLink()) { fs.unlinkSync(file); put(file, JSON.parse(fs.readFileSync(sentinel))); }
    fs.rmSync(temp, { force: true }); fs.rmSync(sentinel, { force: true });
  }
});

test("接口随机临时文件碰撞不覆盖链接目标，也不删除已有链接", async () => {
  const first = await request(input()), id = first.body.providerId;
  const file = path.join(home, "ccapp-providers.json"), bytes = fs.readFileSync(file), fixed = "ef".repeat(12), temp = file + "." + fixed + ".tmp";
  const sentinel = path.join(root, "provider-collision-sentinel"), original = crypto.randomBytes;
  fs.writeFileSync(sentinel, "collision sentinel", { mode: 0o600 }); fs.symlinkSync(sentinel, temp);
  crypto.randomBytes = size => size === 12 ? Buffer.from(fixed, "hex") : original(size);
  try {
    assert.throws(() => upsertProvider(id, { label: "must not commit" }), { code: "EEXIST" });
    assert.equal(fs.lstatSync(temp).isSymbolicLink(), true); assert.equal(fs.readFileSync(sentinel, "utf8"), "collision sentinel");
    assert.deepEqual(fs.readFileSync(file), bytes);
  } finally { crypto.randomBytes = original; fs.rmSync(temp, { force: true }); fs.rmSync(sentinel, { force: true }); }
});

test("接口保存失败时修复回滚映射并保留旧接口，用户可重新检查后重试", async () => {
  const first = await request(input()), id = first.body.providerId;
  upsertProvider(id, { authStyle: "x-api-key" }); const plan = await inspectRepair(); assert.equal(plan.status, 200, JSON.stringify(plan.body));
  const file = path.join(home, "ccapp-providers.json"), mapping = path.join(path.dirname(registration), "openai-bridge-app.json"), before = fs.readFileSync(file), beforeMapping = fs.readFileSync(mapping);
  const original = fs.writeFileSync; let injected = false;
  fs.writeFileSync = function(name, ...args) {
    if (providerTempWrite(name)) { injected = true; throw Object.assign(new Error("fixture disk full"), { code: "ENOSPC" }); }
    return original.call(this, name, ...args);
  };
  try { assert.equal((await applyRepair(plan.body.repair.ticket)).body.code, "REPAIR_UNAVAILABLE"); }
  finally { fs.writeFileSync = original; }
  assert.equal(injected, true); assert.deepEqual(fs.readFileSync(file), before); assert.deepEqual(fs.readFileSync(mapping), beforeMapping);
  assert.equal(PROVIDERS_CFG.providers[id].authStyle, "x-api-key");
  const retry = await inspectRepair(); assert.equal(retry.status, 200, JSON.stringify(retry.body)); assert.equal((await applyRepair(retry.body.repair.ticket)).status, 200);
});

test("修复最终映射失败报告已提交，保留精确pending且冷读不丢已同步接口", async () => {
  const models = [{ id: "fixture-model", contextWindow: 1048576 }, { id: "second", contextWindow: 128000 }];
  const first = await request(input({ models })), id = first.body.providerId;
  upsertProvider(id, { authStyle: "x-api-key", modelsUrl: "data:application/json;base64," + Buffer.from(JSON.stringify({ data: [{ id: models[0].id, context_window: models[0].contextWindow }] })).toString("base64") });
  const plan = await inspectRepair(); assert.equal(plan.status, 200, JSON.stringify(plan.body));
  const mapping = path.join(path.dirname(registration), "openai-bridge-app.json"), connection = fs.readFileSync(path.join(target, "connection.json"));
  const original = fs.writeFileSync; let injected = false;
  fs.writeFileSync = function(file, ...args) {
    if (!injected && String(file).startsWith(mapping + ".") && String(file).endsWith(".tmp") && PROVIDERS_CFG.providers[id].authStyle === "bearer") {
      injected = true; throw Object.assign(new Error("fixture finalize disk full"), { code: "ENOSPC" });
    }
    return original.call(this, file, ...args);
  };
  try {
    const partial = await applyRepair(plan.body.repair.ticket);
    assert.equal(injected, true); assert.equal(partial.status, 409); assert.equal(partial.body.code, "REPAIR_PARTIAL");
    assert.equal(partial.body.committed, true); assert.equal(partial.body.scope, "APP_METADATA");
  } finally { fs.writeFileSync = original; }
  assert.equal(PROVIDERS_CFG.providers[id].authStyle, "bearer"); assert.ok(JSON.parse(fs.readFileSync(mapping)).pending);
  assert.deepEqual(fs.readFileSync(path.join(target, "connection.json")), connection);
  const checked = await request(); assert.equal(checked.body.providerId, id); assert.deepEqual(checked.body.models, plan.body.repair.models);
  const { spawnSync } = await import("node:child_process");
  const cold = spawnSync(process.execPath, ["--input-type=module", "-e", `const {bridgeConfigStatus}=await import(${JSON.stringify(new URL("../gw/bridge-config.mjs", import.meta.url).href)});console.log(JSON.stringify(await bridgeConfigStatus()));`], { env: process.env, encoding: "utf8", timeout: 10000 });
  assert.equal(cold.status, 0); assert.equal(JSON.parse(cold.stdout).providerId, id); assert.deepEqual(JSON.parse(cold.stdout).models, plan.body.repair.models);
  assert.equal((await inspectRepair()).body.code, "REPAIR_NOT_NEEDED");
});

test("修复拒绝计划后新增恢复锁及嵌套链接，不能绕过故障或写到外部", async () => {
  const first = await request(input()), id = first.body.providerId;
  upsertProvider(id, { authStyle: "x-api-key" }); const plan = await inspectRepair(); assert.equal(plan.status, 200, JSON.stringify(plan.body));
  const state = path.join(target, "runtime-home/.claude-code-router"), fault = path.join(state, "recovery.failed");
  fs.writeFileSync(fault, "fixture authoritative fault\n", { mode: 0o600 });
  assert.equal((await applyRepair(plan.body.repair.ticket)).body.code, "REPAIR_UNAVAILABLE"); assert.equal(fs.readFileSync(fault, "utf8"), "fixture authoritative fault\n");
  fs.unlinkSync(fault);
  const moved = path.join(root, "held-runtime-home"); fs.renameSync(path.join(target, "runtime-home"), moved); fs.symlinkSync(moved, path.join(target, "runtime-home"));
  try { assert.equal((await inspectRepair()).body.code, "REPAIR_UNAVAILABLE"); }
  finally { fs.unlinkSync(path.join(target, "runtime-home")); fs.renameSync(moved, path.join(target, "runtime-home")); }
  assert.equal(PROVIDERS_CFG.providers[id].authStyle, "x-api-key");
});

test("修复确认占组件槽，重复确认仅执行一次", async () => {
  const first = await request(input()), id = first.body.providerId;
  upsertProvider(id, { authStyle: "x-api-key" });
  fs.writeFileSync(modeFile, "ok");
  const plan = await inspectRepair(); assert.equal(plan.status, 200, JSON.stringify(plan.body));
  const one = applyRepair(plan.body.repair.ticket), two = applyRepair(plan.body.repair.ticket);
  const both = await Promise.all([one, two]);
  assert.equal(both.filter(r => r.status === 200).length, 1);
  assert.ok(both.some(r => ["BUSY", "REPAIR_STALE"].includes(r.body.code)));
  assert.equal(PROVIDERS_CFG.providers[id].authStyle, "bearer");
});

test("修复执行期间配置、卸载和取消都被组件槽拒绝", async () => {
  const first = await request(input()), id = first.body.providerId;
  upsertProvider(id, { authStyle: "x-api-key" });
  const plan = await inspectRepair(); assert.equal(plan.status, 200, JSON.stringify(plan.body));
  fs.writeFileSync(modeFile, "delay"); const count = calls().length, pending = applyRepair(plan.body.repair.ticket), started = Date.now();
  while (calls().length === count) {
    assert.ok(Date.now() - started < 3000); await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(calls().at(-1).args[0], "gui-status");
  assert.equal((await request(input())).body.code, "BUSY");
  assert.equal((await request({ id: "openai-bridge" }, "/api/components/remove")).body.message, "busy");
  assert.equal((await request({ id: "openai-bridge" }, "/api/components/cancel")).body.message, "busy");
  assert.equal((await pending).status, 200);
  assert.equal(PROVIDERS_CFG.providers[id].authStyle, "bearer");
  assert.equal(calls().slice(count).filter(c => c.args[0] !== "gui-status").length, 0);
});

test("不健康record或软链入口不执行固定组件", async () => {
  put(record, { id: "openai-bridge", state: "ok", files: ["lib/openai-bridge/component.cjs", "../escape"] });
  assert.equal((await request(input())).status, 409); assert.equal(calls().length, 0);
  fixture(); const target = path.join(root, "private-component.cjs"); fs.renameSync(component, target); fs.symlinkSync(target, component);
  assert.equal((await request(input())).status, 409); assert.equal(calls().length, 0);
});

test("配置保存占用组件槽，重复保存/卸载/取消都不能交错", async () => {
  fs.writeFileSync(modeFile, "delay");
  const pending = request(input());
  const started = Date.now();
  while (!calls().some((call) => call.args[0] === "gui-configure")) {
    assert.ok(Date.now() - started < 3000); await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal((await request(input())).status, 409);
  assert.equal((await request({ id: "openai-bridge" }, "/api/components/remove")).body.message, "busy");
  assert.equal((await request({ id: "openai-bridge" }, "/api/components/cancel")).body.message, "busy");
  assert.equal((await pending).status, 200);
  assert.equal(calls().filter((call) => call.args[0] === "gui-configure").length, 1);
});

test("同一桥保存多个模型，窗口逐模型持久化，冷缓存/会话切换/CLI环境各取各的", async () => {
  const active = PROVIDER.id, setting = SETTINGS.provider;
  const models = [{ id: "large-model", contextWindow: 1048576 }, { id: "gpt-4o-audio-preview", contextWindow: 128000 }, { id: "image-aware-chat" }];
  const result = await request(input({ model: "large-model", models }));
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const id = result.body.providerId, provider = PROVIDERS_CFG.providers[id];
  const expected = [...models.slice(0, 2), { id: "image-aware-chat", contextWindow: 200000 }];
  assert.deepEqual(result.body.models, expected);
  assert.deepEqual((await request()).body.models, expected);
  const disk = JSON.parse(fs.readFileSync(path.join(home, "ccapp-providers.json"), "utf8")).providers[id];
  assert.equal(disk.modelsUrl, provider.modelsUrl);
  for (const list of [cachedModels(provider), await fetchModels(true, provider)])
    assert.deepEqual(list.map((m) => [m.id, m.context_window]), expected.map((m) => [m.id, m.contextWindow]));
  for (const m of expected) {
    assert.equal(claudeEnv({ model: m.id, provider }).CLAUDE_CODE_MAX_CONTEXT_TOKENS, String(m.contextWindow));
    const url = new URL("http://127.0.0.1/api/models?provider=" + id + "&model=" + m.id);
    let body;
    await routeModels({ method: "GET" }, { writeHead() {}, end(text) { body = JSON.parse(text); } }, url, url.pathname);
    assert.equal(body.current, m.id); assert.equal(body.contextWindow, m.contextWindow);
    assert.deepEqual(body.models.map((item) => item.id), expected.map((item) => item.id));
  }
  assert.equal(PROVIDER.id, active); assert.equal(SETTINGS.provider, setting);
  assert.deepEqual(calls().find((call) => call.args[0] === "gui-configure").fields.sort(), ["apiKey", "endpoint", "model", "models"]);
});

test("旧单模型配置可读且保存缺省窗口为200000，不借其他型号的窗口", async () => {
  const result = await request(input());
  assert.equal(result.body.contextWindow, 200000);
  assert.deepEqual(result.body.models, [{ id: "fixture-model", contextWindow: 200000 }]);
  const next = await request(input({ apiKey: "", model: "other", models: [{ id: "fixture-model", contextWindow: 1048576 }, { id: "other" }] }));
  assert.equal(next.status, 200);
  assert.equal(next.body.contextWindow, 200000);
  assert.equal(next.body.providerId, result.body.providerId);
});

test("多模型请求校验默认项/重复/数量/控制字符/上下文，失败不调用组件", async () => {
  for (const models of [[], ["fixture-model"], [{ id: "other" }], [{ id: "fixture-model" }, { id: "fixture-model" }],
    [{ id: "fixture-model", url: "https://untrusted.invalid" }], [{ id: "fixture-model", contextWindow: 12.5 }],
    [{ id: "fixture-model" }, { id: "bad\u0085model" }], Array.from({ length: 101 }, (_, i) => ({ id: i ? "m" + i : "fixture-model" }))]) {
    assert.equal((await request(input({ models }))).status, 400);
  }
  assert.deepEqual(calls(), []);
});

test("仅允许归属匹配的规范内嵌清单，远端/被改过的清单仍冲突", async () => {
  const result = await request(input({ models: [{ id: "fixture-model" }, { id: "other" }] }));
  const provider = PROVIDERS_CFG.providers[result.body.providerId], original = provider.modelsUrl;
  for (const value of ["", undefined, "https://other.invalid/models", "data:application/json," + encodeURIComponent('{"data":[{"id":"fixture-model"}]}'),
    "data:application/json;base64," + Buffer.from(JSON.stringify({ data: [{ id: "fixture-model", context_window: 1024 }] })).toString("base64")]) {
    if (value === undefined) delete provider.modelsUrl; else provider.modelsUrl = value;
    assert.equal((await request()).body.code, "RUNTIME_CONFLICT");
    const before = calls().filter((call) => call.args[0] === "gui-configure").length;
    assert.equal((await request(input())).body.code, "RUNTIME_CONFLICT");
    assert.equal(calls().filter((call) => call.args[0] === "gui-configure").length, before);
  }
  provider.modelsUrl = original;
  assert.equal((await request()).status, 200);
});

test("只改规范模型清单或窗口只诊断MODEL_LIST，仍拒绝旧新事务之外的清单且不写配置", async () => {
  const models = [{ id: "fixture-model", contextWindow: 1048576 }, { id: "second", contextWindow: 128000 }];
  const first = await request(input({ models })), provider = PROVIDERS_CFG.providers[first.body.providerId];
  const original = provider.modelsUrl, baseUrl = provider.baseUrl, apiKey = provider.apiKey, authStyle = provider.authStyle;
  const mappingFile = path.join(path.dirname(registration), "openai-bridge-app.json"), mapping = fs.readFileSync(mappingFile);
  const connectionFile = path.join(target, "connection.json"), connection = fs.readFileSync(connectionFile);
  const inline = data => "data:application/json;base64," + Buffer.from(JSON.stringify({ data })).toString("base64");
  for (const value of [undefined,
    inline([{ id: "fixture-model", context_window: 1048576 }, { id: "third", context_window: 64000 }]),
    inline([{ id: "fixture-model", context_window: 512000 }, { id: "second", context_window: 128000 }])]) {
    if (value === undefined) delete provider.modelsUrl; else provider.modelsUrl = value;
    const before = calls().filter(c => c.args[0] === "gui-configure").length;
    for (const body of [undefined, input({ models })]) {
      const result = await request(body);
      assert.equal(result.status, 409); assert.equal(result.body.code, "RUNTIME_CONFLICT"); assert.equal(result.body.check, "MODEL_LIST");
    }
    assert.equal(calls().filter(c => c.args[0] === "gui-configure").length, before);
    assert.equal(provider.modelsUrl, value); assert.equal(provider.baseUrl, baseUrl); assert.equal(provider.apiKey, apiKey); assert.equal(provider.authStyle, authStyle);
    assert.deepEqual(fs.readFileSync(mappingFile), mapping); assert.deepEqual(fs.readFileSync(connectionFile), connection);
  }
  provider.modelsUrl = original; assert.equal((await request()).status, 200);
});

test("清单映射最终写入失败仍可读和重试，只认写前记录的精确旧新指纹", async () => {
  const models = [{ id: "fixture-model", contextWindow: 1048576 }, { id: "second", contextWindow: 128000 }];
  const first = await request(input({ models })), id = first.body.providerId;
  const mapping = path.join(path.dirname(registration), "openai-bridge-app.json");
  const originalUrl = PROVIDERS_CFG.providers[id].modelsUrl, writeFileSync = fs.writeFileSync;
  let failed = false;
  fs.writeFileSync = function(file, ...args) {
    if (!failed && String(file).startsWith(mapping + ".") && String(file).endsWith(".tmp") && PROVIDERS_CFG.providers[id].modelsUrl !== originalUrl) {
      failed = true; const error = new Error("fixture write failure"); error.code = "ENOSPC"; throw error;
    }
    return writeFileSync.call(this, file, ...args);
  };
  const updated = [{ ...models[0], contextWindow: 512000 }, models[1]];
  try {
    const partial = await request(input({ models: updated }));
    assert.equal(failed, true); assert.equal(partial.status, 400); assert.equal(partial.body.saved, true);
  } finally { fs.writeFileSync = writeFileSync; }
  const checked = await request();
  assert.equal(checked.status, 200, JSON.stringify(checked.body)); assert.equal(checked.body.providerId, id);
  assert.deepEqual(checked.body.models, updated);
  const { spawnSync } = await import("node:child_process");
  const cold = spawnSync(process.execPath, ["--input-type=module", "-e", `const {bridgeConfigStatus}=await import(${JSON.stringify(new URL("../gw/bridge-config.mjs", import.meta.url).href)});console.log(JSON.stringify(await bridgeConfigStatus()));`], { env: process.env, encoding: "utf8", timeout: 10000 });
  assert.equal(cold.status, 0, "fresh gateway must recognize the precise pending transaction");
  assert.deepEqual(JSON.parse(cold.stdout).models, updated);
  const provider = PROVIDERS_CFG.providers[id], validUrl = provider.modelsUrl;
  for (const value of ["", "https://elsewhere.invalid/models", "data:application/json;base64," + Buffer.from(JSON.stringify({ data: [{ id: "fixture-model", context_window: 1024 }] })).toString("base64")]) {
    provider.modelsUrl = value;
    assert.equal((await request()).body.code, "RUNTIME_CONFLICT");
  }
  provider.modelsUrl = validUrl;
  const retried = await request(input({ models: updated }));
  assert.equal(retried.status, 200, JSON.stringify(retried.body)); assert.equal(retried.body.providerId, id);
  assert.deepEqual((await request()).body.models, updated);
  assert.equal("pending" in JSON.parse(fs.readFileSync(mapping, "utf8")), false);
});

test("首次接口保存映射准备失败不产生无归属接口，恢复写盘后可正常保存", async () => {
  const mapping = path.join(path.dirname(registration), "openai-bridge-app.json"), before = Object.keys(PROVIDERS_CFG.providers);
  const writeFileSync = fs.writeFileSync; let failed = false;
  fs.writeFileSync = function(file, ...args) {
    if (!failed && String(file).startsWith(mapping + ".") && String(file).endsWith(".tmp")) {
      failed = true; const error = new Error("fixture write failure"); error.code = "ENOSPC"; throw error;
    }
    return writeFileSync.call(this, file, ...args);
  };
  try { const result = await request(input()); assert.equal(result.status, 400); assert.equal(result.body.saved, true); }
  finally { fs.writeFileSync = writeFileSync; }
  assert.equal(failed, true); assert.deepEqual(Object.keys(PROVIDERS_CFG.providers), before);
  assert.equal(fs.existsSync(mapping), false);
  const retried = await request(input()); assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.equal(Object.keys(PROVIDERS_CFG.providers).length, before.length + 1);
});

test("接口文件写入失败保留旧内存和磁盘，写前事务允许原接口正常重试", async () => {
  const models = [{ id: "fixture-model", contextWindow: 1048576 }, { id: "second", contextWindow: 128000 }];
  const first = await request(input({ models })), id = first.body.providerId;
  const originalUrl = PROVIDERS_CFG.providers[id].modelsUrl, file = path.join(home, "ccapp-providers.json"), disk = fs.readFileSync(file);
  const writeFileSync = fs.writeFileSync; let failed = false;
  fs.writeFileSync = function(name, ...args) {
    if (!failed && providerTempWrite(name)) {
      failed = true; const error = new Error("fixture write failure"); error.code = "ENOSPC"; throw error;
    }
    return writeFileSync.call(this, name, ...args);
  };
  const updated = [{ ...models[0], contextWindow: 512000 }, models[1]];
  try { assert.equal((await request(input({ models: updated }))).status, 400); }
  finally { fs.writeFileSync = writeFileSync; }
  assert.equal(failed, true); assert.equal(PROVIDERS_CFG.providers[id].modelsUrl, originalUrl);
  assert.deepEqual(fs.readFileSync(file), disk); assert.deepEqual((await request()).body.models, models);
  const retried = await request(input({ models: updated }));
  assert.equal(retried.status, 200, JSON.stringify(retried.body)); assert.equal(retried.body.providerId, id);
  assert.deepEqual((await request()).body.models, updated);
});

test("首次provider写入失败撤销预备映射，普通接口复用ID后不会卡死桥或被覆盖", async () => {
  const file = path.join(home, "ccapp-providers.json"), mapping = path.join(path.dirname(registration), "openai-bridge-app.json");
  const writeFileSync = fs.writeFileSync; let failed = false;
  fs.writeFileSync = function(name, ...args) {
    if (!failed && providerTempWrite(name)) {
      failed = true; const error = new Error("fixture write failure"); error.code = "ENOSPC"; throw error;
    }
    return writeFileSync.call(this, name, ...args);
  };
  try { assert.equal((await request(input())).status, 400); }
  finally { fs.writeFileSync = writeFileSync; }
  assert.equal(failed, true); assert.equal(fs.existsSync(mapping), false);
  const unrelated = upsertProvider(null, { baseUrl: "https://unrelated.example.invalid", label: "Unrelated fixture" });
  assert.equal(unrelated.ok, true);
  const protectedProvider = structuredClone(PROVIDERS_CFG.providers[unrelated.id]);
  const pending = await request(); assert.equal(pending.status, 200); assert.equal(pending.body.providerId, ""); assert.equal(pending.body.localReady, false);
  const saved = await request(input()); assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.notEqual(saved.body.providerId, unrelated.id); assert.deepEqual(PROVIDERS_CFG.providers[unrelated.id], protectedProvider);
});

test("provider落盘失败且组件已换默认模型：不借旧默认窗口，不将不一致接口提供新会话", async () => {
  const models = [{ id: "fixture-model", contextWindow: 1048576 }, { id: "second", contextWindow: 128000 }];
  const first = await request(input({ models }));
  const updated = [...models, { id: "new-default", contextWindow: 64000 }], file = path.join(home, "ccapp-providers.json"), writeFileSync = fs.writeFileSync;
  let failed = false;
  fs.writeFileSync = function(name, ...args) {
    if (!failed && providerTempWrite(name)) {
      failed = true; const error = new Error("fixture write failure"); error.code = "ENOSPC"; throw error;
    }
    return writeFileSync.call(this, name, ...args);
  };
  try { assert.equal((await request(input({ model: "new-default", models: updated }))).status, 400); }
  finally { fs.writeFileSync = writeFileSync; }
  assert.equal(failed, true);
  const pending = await request();
  assert.equal(pending.status, 200, JSON.stringify(pending.body)); assert.equal(pending.body.providerId, "");
  assert.equal(pending.body.localReady, false); assert.equal(pending.body.localError, "LOCAL_START_FAILED");
  assert.equal(pending.body.check, "MODEL_LIST");
  assert.deepEqual(pending.body.models, [...models, { id: "new-default", contextWindow: 200000 }]);
  const saved = await request(input({ model: "new-default", models: updated }));
  assert.equal(saved.status, 200, JSON.stringify(saved.body)); assert.equal(saved.body.providerId, first.body.providerId);
  assert.deepEqual(saved.body.models, updated); assert.equal(saved.body.localReady, true);
});

test("100个长Unicode模型可保存，超过128KiB配置拒绝且不执行组件", async () => {
  const models = Array.from({ length: 100 }, (_, i) => ({ id: String(i).padStart(3, "0") + "模".repeat(197), contextWindow: 200000 }));
  const result = await request(input({ model: models[0].id, models }));
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual((await request()).body.models, models);
  const before = calls().length;
  // readBodyBuf 超限主动断开连接，不保证能再把 JSON 错误送到已关闭的 socket。
  await assert.rejects(request(input({ apiKey: "x".repeat(128 * 1024) })));
  assert.equal(calls().length, before);
});
