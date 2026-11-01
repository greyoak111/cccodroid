import "../gw/config.mjs";
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { routeComponents } from "../gw/components.mjs";
import { normalizeBridgeEndpoint } from "../gw/bridge-config.mjs";
import { PROVIDER, PROVIDERS_CFG } from "../gw/providers.mjs";
import { SETTINGS } from "../gw/settings-store.mjs";
import { RUNS } from "../gw/runs.mjs";

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
 if(mode==='conflict'){console.error(JSON.stringify({schema:1,id:'openai-bridge',error:{code:'RUNTIME_CONFLICT',message:'must not forward '+${JSON.stringify(upstreamSecret)}}}));process.exitCode=1;return;}
 let state=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile,'utf8')):null;
 const view=()=>({schema:1,id:'openai-bridge',configured:!!state,endpoint:state?.endpoint||'',model:state?.model||'',hasKey:!!state,localReady:!!state&&mode!=='not-ready',apiKey:${JSON.stringify(upstreamSecret)},keyTail:'LEAK',connectionPath:'/untrusted/path'});
 if(command==='gui-status'){console.log(JSON.stringify(view()));return;}
 if(command==='uninstall'){fs.rmSync(reg,{force:true});return;}
 if(command!=='gui-configure'){process.exitCode=2;return;}
 const body=JSON.parse(input);
 if(body.apiKey)state={...body};else state={...body,apiKey:state.apiKey};
 write(stateFile,state);write(path.join(target,'.ccr-bridge-kit.json'),{id:'ccr-bridge-kit',target,guiManaged:true});write(path.join(target,'connection.json'),{baseUrl:'http://127.0.0.1:34597',apiKey:mode==='fresh'?${JSON.stringify(freshLocalSecret)}:${JSON.stringify(localSecret)},model:state.model});
 write(reg,{schema:1,id:'openai-bridge',endpoint:'http://127.0.0.1:34597',runtimeDir:target,instanceId:'b'.repeat(32)});
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

test("手工/旧runtime冲突明确报告迁移，不自动uninstall或泄露stderr", async () => {
  fs.writeFileSync(modeFile, "conflict");
  const result = await request(input());
  assert.equal(result.status, 409); assert.equal(result.body.code, "RUNTIME_CONFLICT"); assert.equal(result.body.saved, false);
  assert.match(result.body.message, /迁移|原安装/); assert.deepEqual(calls().map((call) => call.args), [["gui-status"]]);
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
