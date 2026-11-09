import { PATHS } from "../gw/config.mjs"; // scripts/test.mjs 先隔离 HOME / fake PREFIX。
import "./fixtures/uc-baseline.mjs";   // 共用 home 里前面测试留下的 ~/.claude 改动先认下，免得真起一轮时卡在确认卡片
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import { performance } from "node:perf_hooks";

// 即使意外走到 CLI，也只会得到可丢弃的假凭据和假入口。
process.env.ANTHROPIC_API_KEY = "fixture-only-do-not-forward";
process.env.ANTHROPIC_AUTH_TOKEN = "fixture-only-do-not-forward";
const home = process.env.CCAPP_HOME, prefix = process.env.CCAPP_PREFIX;
const root = fs.mkdtempSync(path.join(process.env.CCAPP_WORKSPACE, "managed-run-"));
const reg = path.join(home, ".cccodroid/services/openai-bridge.json");
const record = path.join(path.dirname(prefix), "components/openai-bridge.json");
const component = path.join(prefix, "lib/openai-bridge/component.cjs");
const providerFile = path.join(home, "ccapp-providers.json");
const cli = path.join(root, "fake-loader.cjs"), cliMarker = path.join(root, "cli-called");
fs.mkdirSync(path.dirname(component), { recursive: true });
fs.mkdirSync(path.dirname(reg), { recursive: true });
fs.mkdirSync(path.dirname(record), { recursive: true });
fs.writeFileSync(component, `const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),dir=args[args.indexOf('--dir')+1];
fs.appendFileSync(path.join(dir,'calls'),args[0]+'\\n');
fs.writeFileSync(path.join(dir,'launcher.pid'),String(process.pid));
setTimeout(()=>{process.exitCode=1;},300);
`);
// 假 loader 用 sh：claude 的环境变量清掉了 LD_LIBRARY_PATH，有的机器上 node 离了它起不来（缺 libz），假 CLI 根本跑不到
const sh = fs.existsSync("/system/bin/sh") ? "/system/bin/sh" : "/bin/sh";
fs.writeFileSync(cli, `#!${sh}\necho called > ${JSON.stringify(cliMarker)}\nexit 97\n`, { mode: 0o700 });
const endpoint = "http://127.0.0.1:34592";
// 只使用自身临时配置；KEY 检查需要非空假值，不导入活 App 的 providers。
fs.writeFileSync(providerFile, JSON.stringify({ active: "custom-managed-test", providers: {
  "custom-managed-test": { label: "Fake bridge", baseUrl: endpoint, apiKey: "fixture-only", authStyle: "bearer", defaultModel: "fixture-model", fallbackModels: [{ id: "fixture-model" }] },
  "custom-managed-other": { label: "Other fixture provider", baseUrl: "https://other-fixture.example.invalid", apiKey: "fixture-other-only", authStyle: "bearer", defaultModel: "fixture-model", fallbackModels: [{ id: "fixture-model" }] },
} }));
const previousPaths = { claude: PATHS.claude, loader: PATHS.loader, claudeLoader: PATHS.claudeLoader };
PATHS.claude = process.execPath;
PATHS.loader = PATHS.claudeLoader = cli;
const { startRun } = await import("../gw/run.mjs");
const { abortRun } = await import("../gw/queue.mjs");
const { RUNS } = await import("../gw/runs.mjs");
const { onPublish } = await import("../gw/bus.mjs");
const { ensureManagedBridge } = await import("../gw/managed-bridge.mjs");
const { routeComponents } = await import("../gw/components.mjs");
const { routeProviders } = await import("../gw/providers.mjs");
const events = [], requests = [];
const off = onPublish((ev) => events.push(ev));
const originalFetch = globalThis.fetch;
globalThis.fetch = async (...args) => { requests.push(String(args[0])); throw new Error("fixture must not send a model request"); };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, ms = 3000) {
  const start = performance.now();
  while (!check()) { assert.ok(performance.now() - start < ms, "假组件 ensure 未开始"); await delay(10); }
}
function fixture() {
  const dir = fs.mkdtempSync(path.join(root, "instance-"));
  fs.writeFileSync(reg, JSON.stringify({ schema: 1, id: "openai-bridge", endpoint, runtimeDir: dir, instanceId: crypto.randomBytes(16).toString("hex") }));
  fs.writeFileSync(record, JSON.stringify({ id: "openai-bridge", state: "ok", files: ["lib/openai-bridge/component.cjs"] }));
  return { dir, calls: () => { try { return fs.readFileSync(path.join(dir, "calls"), "utf8").trim().split("\n"); } catch { return []; } } };
}
function ended(id, { failed = false, aborted = false } = {}) {
  assert.equal(RUNS.has(id), false);
  const mine = events.filter((e) => e.runId === id), ends = mine.filter((e) => e.type === "run_end");
  assert.equal(ends.length, 1);
  assert.equal(!!ends[0].failed, failed);
  assert.equal(!!ends[0].aborted, aborted);
  assert.equal(mine.some((e) => e.type === "init"), false);
  assert.equal(fs.existsSync(cliMarker), false, "readiness 之前不能执行 CLI");
  assert.equal(requests.length, 0, "readiness 之前不能发模型/模型列表请求");
  return mine;
}
after(() => {
  off();
  globalThis.fetch = originalFetch;
  Object.assign(PATHS, previousPaths);
  for (const p of [reg, record, component, providerFile]) fs.rmSync(p, { force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test("真实 startRun 的桥失败在 CLI/请求之前清晰结束，不靠 502 重试", async () => {
  const f = fixture();
  await startRun({ id: "managed-failure", message: "fixture message", cwd: root });
  assert.deepEqual(f.calls(), ["ensure"]);
  const mine = ended("managed-failure", { failed: true });
  assert.equal(mine.filter((e) => e.type === "error").length, 1);
  assert.match(mine.find((e) => e.type === "error").message, /本地 OpenAI 桥未就绪/);
});

test("真实 abortRun 能停止 readiness 等待并清槽，不杀共享服务", async () => {
  const f = fixture();
  const work = startRun({ id: "managed-cancel", message: "fixture message", cwd: root });
  const run = RUNS.get("managed-cancel");
  assert(run && run.child === null);
  await until(() => f.calls().length === 1);
  assert.equal(abortRun(run), true);
  await work;
  const mine = ended("managed-cancel", { aborted: true });
  assert.equal(mine.some((e) => e.type === "error"), false);
  // 本轮取消不杀共享启动器；另一个等待者仍收到组件自身的失败，不是 AbortError。
  await assert.rejects(ensureManagedBridge({ custom: true, baseUrl: endpoint }), /本地 OpenAI 桥未就绪/);
  assert.deepEqual(f.calls(), ["ensure"]);
});

test("run_start 时同步取消，readyAbort 尚未创建也必须结束且不 spawn ensure", async () => {
  const f = fixture();
  let cancelled = false, beforeReady = false;
  const unsubscribe = onPublish((ev) => {
    if (ev.type !== "run_start" || ev.runId !== "managed-early-cancel") return;
    const run = RUNS.get(ev.runId);
    beforeReady = !!run && run.readyAbort == null && run.child === null;
    cancelled = abortRun(run);
  });
  try { await startRun({ id: "managed-early-cancel", message: "fixture message", cwd: root }); }
  finally { unsubscribe(); }
  assert.equal(beforeReady, true, "取消必须确实发生在 readyAbort 创建之前");
  assert.equal(cancelled, true);
  assert.deepEqual(f.calls(), [], "已取消 run 不能再启动 readiness");
  const mine = ended("managed-early-cancel", { aborted: true });
  assert.equal(mine.some((e) => e.type === "error"), false);
});

test("两个真实 run 共享 ensure，停止其中一个不取消另一个", async () => {
  const f = fixture();
  const first = startRun({ id: "managed-shared-cancel", message: "first fixture", cwd: root });
  const second = startRun({ id: "managed-shared-survivor", message: "second fixture", cwd: root });
  await until(() => f.calls().length === 1);
  assert.equal(abortRun(RUNS.get("managed-shared-cancel")), true);
  await first;
  assert.equal(ended("managed-shared-cancel", { aborted: true }).some((e) => e.type === "error"), false);
  assert.equal(RUNS.has("managed-shared-survivor"), true);
  await second;
  const mine = ended("managed-shared-survivor", { failed: true });
  assert.equal(mine.filter((e) => e.type === "error").length, 1);
  assert.match(mine.find((e) => e.type === "error").message, /本地 OpenAI 桥未就绪/);
  assert.deepEqual(f.calls(), ["ensure"]);
});

const guiTarget = path.join(home, ".local/share/ccr-bridge-kit");
const guiState = path.join(home, ".cccodroid/services/openai-bridge-app.json");
const guiSource = `const fs=require('node:fs'),path=require('node:path');
const target=path.join(process.env.HOME,'.local/share/ccr-bridge-kit'),command=process.argv[2];
const endpoint=${JSON.stringify(endpoint)},registration=path.join(process.env.HOME,'.cccodroid/services/openai-bridge.json');
fs.appendFileSync(path.join(target,'calls'),command+'\\n');
const view=(model='fixture-model',endpoint='https://fixture-upstream.example.invalid/v1/chat/completions')=>({schema:1,id:'openai-bridge',configured:true,hasKey:true,localReady:true,model,endpoint});
if(command==='ensure')console.log(JSON.stringify({schema:1,id:'openai-bridge',ready:true,endpoint,instanceId:JSON.parse(fs.readFileSync(registration,'utf8')).instanceId}));
else if(command==='gui-status')console.log(JSON.stringify(view()));
else if(command==='uninstall')fs.rmSync(registration,{force:true});
else if(command==='gui-configure'){
  let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{
    const body=JSON.parse(input);fs.writeFileSync(path.join(target,'configuring'),'started');
    const timeout=setTimeout(()=>process.exit(29),5000);
    const timer=setInterval(()=>{if(!fs.existsSync(path.join(target,'release')))return;
      clearInterval(timer);clearTimeout(timeout);
      if(fs.readFileSync(path.join(target,'mode'),'utf8')==='failure'){
        console.error(JSON.stringify({schema:1,id:'openai-bridge',error:{code:'BUSY'}}));process.exitCode=17;
      }else{
        const connection=JSON.parse(fs.readFileSync(path.join(target,'connection.json'),'utf8'));
        fs.writeFileSync(path.join(target,'connection.json'),JSON.stringify({baseUrl:endpoint,apiKey:connection.apiKey,model:body.model}),{mode:0o600});
        console.log(JSON.stringify(view(body.model,body.endpoint)));
      }
    },15);
  });
}else process.exitCode=2;
`;
function configGateFixture(mode, { resetMapping = true, localKey = "c".repeat(48) } = {}) {
  fs.mkdirSync(guiTarget, { recursive: true });
  fs.mkdirSync(path.dirname(component), { recursive: true });
  for (const file of ["calls", "configuring", "release"]) fs.rmSync(path.join(guiTarget, file), { force: true });
  if (resetMapping) fs.rmSync(guiState, { force: true });
  fs.writeFileSync(path.join(guiTarget, "mode"), mode);
  fs.writeFileSync(path.join(guiTarget, ".ccr-bridge-kit.json"), JSON.stringify({ id: "ccr-bridge-kit", target: guiTarget, guiManaged: true }), { mode: 0o600 });
  fs.writeFileSync(path.join(guiTarget, "connection.json"), JSON.stringify({ baseUrl: endpoint, apiKey: localKey, model: "fixture-model" }), { mode: 0o600 });
  fs.writeFileSync(component, guiSource);
  fs.writeFileSync(reg, JSON.stringify({ schema: 1, id: "openai-bridge", endpoint, runtimeDir: guiTarget, instanceId: crypto.randomBytes(16).toString("hex") }));
  fs.writeFileSync(record, JSON.stringify({ id: "openai-bridge", state: "ok", files: ["lib/openai-bridge/component.cjs"] }));
  return { calls: () => { try { return fs.readFileSync(path.join(guiTarget, "calls"), "utf8").trim().split("\n"); } catch { return []; } } };
}
function postConfig(origin) {
  return new Promise((resolve, reject) => {
    const request = http.request(origin + "/api/components/openai-bridge/config", { method: "POST", headers: { "content-type": "application/json", "x-cc-lang": "zh" } }, (response) => {
      let text = "";
      response.setEncoding("utf8"); response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => {
        try {
          assert.match(response.headers["content-type"], /application\/json/);
          assert.equal(text.includes("fixture-upstream-key"), false);
          assert.equal(text.includes("c".repeat(48)), false);
          resolve({ status: response.statusCode, body: JSON.parse(text) });
        } catch (e) { reject(e); }
      });
    });
    request.on("error", reject);
    request.setTimeout(7000, () => request.destroy(new Error("fake configuration request timed out")));
    request.end(JSON.stringify({ endpoint: "https://fixture-upstream.example.invalid/v1", apiKey: "fixture-upstream-key", model: "fixture-model", consent: true }));
  });
}

async function lifecycleRequest(origin, pathname, body) {
  return new Promise((resolve, reject) => {
    const request = http.request(origin + pathname, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", "x-cc-lang": "zh" } }, (response) => {
      let text = ""; response.setEncoding("utf8"); response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => {
        try {
          assert.match(response.headers["content-type"], /application\/json/);
          resolve({ status: response.statusCode, body: JSON.parse(text) });
        } catch (error) { reject(error); }
      });
    });
    request.on("error", reject);
    request.setTimeout(7000, () => request.destroy(new Error("fake lifecycle route request timed out")));
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

for (const mode of ["signature-mismatch", "overlong"]) test(`真实配置请求 ${mode}：拒绝无效 body，组件命令零调用`, async () => {
  const f = configGateFixture("success");
  const registration = fs.readFileSync(reg, "utf8");
  let routeDone;
  const completed = new Promise((resolve) => { routeDone = resolve; });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (mode === "signature-mismatch") req.ccBodySha = "0".repeat(64);
    Promise.resolve(routeComponents(req, res, url, url.pathname)).then(routeDone, (e) => {
      if (!res.headersSent && !res.destroyed) { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: e.message })); }
      routeDone();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const body = { endpoint: "https://fixture-upstream.example.invalid/v1", apiKey: "fixture-upstream-key", model: "fixture-model", consent: true };
    // 额外JSON空白使语义上仍是同一份合法输入；只有字节上限能挡住，不能靠字段校验冒充通过。
    const raw = JSON.stringify(body) + (mode === "overlong" ? " ".repeat(512 * 1024 + 1) : "");
    const outcome = await new Promise((resolve) => {
      const request = http.request(`http://127.0.0.1:${server.address().port}/api/components/openai-bridge/config`, { method: "POST", headers: { "content-type": "application/json" } }, (response) => {
        let text = ""; response.setEncoding("utf8"); response.on("data", (chunk) => { text += chunk; });
        response.on("end", () => resolve({ status: response.statusCode, text }));
      });
      request.on("error", (error) => resolve({ error }));
      request.setTimeout(3000, () => request.destroy(new Error("invalid body fixture timed out")));
      request.end(raw);
    });
    await completed;
    if (outcome.error) {
      assert.equal(mode, "overlong", "摘要不匹配应该是正常JSON拒绝，不应意外断连");
      assert.equal(outcome.error.code, "ECONNRESET", "仅接受readBodyBuf主动destroy造成的断连");
    } else {
      assert.equal(outcome.status, 400);
      assert.equal(JSON.parse(outcome.text).code, "invalid_input");
    }
    assert.deepEqual(f.calls(), [], "无效请求不能启动gui-status/gui-configure/ensure");
    assert.equal(fs.existsSync(path.join(guiTarget, "configuring")), false);
    assert.equal(fs.readFileSync(reg, "utf8"), registration);
    assert.equal(fs.existsSync(guiState), false);
  } finally {
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    fs.rmSync(guiTarget, { recursive: true, force: true });
  }
});

for (const mode of ["success", "failure"]) test(`真实配置 ${mode} 在途 gate：阻止已有 ready 的桥 run，不影响别家，结束后失效缓存并解锁`, async () => {
  const f = configGateFixture(mode), p = { custom: true, baseUrl: endpoint };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname !== "/api/components/openai-bridge/config") { res.writeHead(404); res.end(); return; }
    Promise.resolve(routeComponents(req, res, url, url.pathname)).catch(() => { if (!res.headersSent) res.writeHead(500); res.end("{}"); });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let saving;
  try {
    assert.equal(await ensureManagedBridge(p), true);
    assert.equal(await ensureManagedBridge(p), true);
    assert.deepEqual(f.calls(), ["ensure"], "必须先确实建立 ready 缓存");
    saving = postConfig(`http://127.0.0.1:${server.address().port}`);
    let finished;
    const saveResult = saving.then((result) => { finished = { result }; return finished; }, (error) => { finished = { error }; return finished; });
    await until(() => fs.existsSync(path.join(guiTarget, "configuring")) || !!finished);
    assert.equal(finished, undefined, "配置必须实际进入 fake gui-configure hold，不能在门前被无关验证拒绝");
    const bridgeId = "managed-config-bridge-" + mode;
    await startRun({ id: bridgeId, message: "fixture bridge while configuring", cwd: root });
    const bridgeEvents = ended(bridgeId, { failed: true });
    assert.equal(bridgeEvents.filter((e) => e.type === "error").length, 1);
    assert.equal(f.calls().filter((command) => command === "ensure").length, 1, "配置期间不能复用缓存或 spawn ensure");
    for (const other of [{ custom: true, baseUrl: "https://other-fixture.example.invalid" }, { custom: true, baseUrl: "http://127.0.0.1:34599" }]) {
      assert.equal(await ensureManagedBridge(other), false, "配置闸门不能拦其他 provider");
    }
    const otherId = "managed-config-other-" + mode;
    await startRun({ id: otherId, provider: "custom-managed-other", message: "other fixture provider during bridge configure", cwd: root });
    await until(() => events.some((ev) => ev.type === "run_end" && ev.runId === otherId));
    assert.equal(fs.existsSync(cliMarker), true, "其他 provider 必须仍能经过 readiness 到假 CLI");
    assert.equal(RUNS.has(otherId), false);
    assert.equal(events.some((ev) => ev.runId === otherId && ev.type === "error" && /本地 OpenAI 桥未就绪/.test(ev.message)), false);
    assert.equal(requests.length, 0);
    fs.rmSync(cliMarker, { force: true });
    fs.writeFileSync(path.join(guiTarget, "release"), "finish fixture configuration");
    const settled = await saveResult;
    if (settled.error) throw settled.error;
    assert.equal(settled.result.status, mode === "success" ? 200 : 409);
    assert.equal(settled.result.body.ok, mode === "success");
    if (mode === "failure") assert.equal(settled.result.body.code, "BUSY");
    assert.equal(await ensureManagedBridge(p), true, "配置成功/失败后均须解除 gate");
    assert.equal(f.calls().filter((command) => command === "ensure").length, 2, "即使原绑定没改，配置后旧 ready 缓存也应失效");
  } finally {
    if (saving) {
      fs.writeFileSync(path.join(guiTarget, "release"), "finish fixture configuration cleanup");
      await saving.catch(() => {});
    }
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    fs.rmSync(cliMarker, { force: true }); fs.rmSync(guiState, { force: true });
    fs.rmSync(guiTarget, { recursive: true, force: true });
  }
});

test("真实配置→卸载→重装换本地 key：清旧映射但不删 providers/config，新实例可再次配置", async () => {
  const f = configGateFixture("success");
  fs.writeFileSync(path.join(guiTarget, "release"), "finish initial fixture configure");
  const configFile = path.join(home, "ccapp-config.json");
  const originalConfig = fs.existsSync(configFile) ? fs.readFileSync(configFile) : null;
  const configBytes = JSON.stringify({ fixture: "unrelated user configuration must survive" });
  fs.writeFileSync(configFile, configBytes, { mode: 0o600 });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const route = url.pathname === "/api/providers/save" ? routeProviders : routeComponents;
    Promise.resolve(route(req, res, url, url.pathname)).catch(() => { if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" }); res.end("{}"); });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const initial = await postConfig(origin);
    assert.equal(initial.status, 200); assert.equal(initial.body.ok, true);
    const oldId = initial.body.providerId;
    assert.match(oldId, /^custom-[1-9][0-9]*$/);
    const oldProviders = JSON.parse(fs.readFileSync(providerFile, "utf8"));
    const oldProvider = oldProviders.providers[oldId];
    const oldMapping = JSON.parse(fs.readFileSync(guiState, "utf8"));
    const oldInstance = JSON.parse(fs.readFileSync(reg, "utf8")).instanceId;
    const removal = await lifecycleRequest(origin, "/api/components/remove", { id: "openai-bridge" });
    assert.equal(removal.status, 200); assert.equal(removal.body.ok, true);
    assert.equal(fs.existsSync(reg), false);
    assert.equal(fs.existsSync(record), false);
    assert.equal(fs.existsSync(component), false);
    assert.equal(fs.existsSync(guiState), false, "成功卸载必须清固定非密映射，否则新local key与旧fingerprint永久冲突");
    assert.deepEqual(JSON.parse(fs.readFileSync(providerFile, "utf8")), oldProviders, "卸载不能删除或重写providers");
    assert.equal(fs.readFileSync(configFile, "utf8"), configBytes);
    assert.equal(fs.existsSync(path.join(guiTarget, ".ccr-bridge-kit.json")), true, "普通卸载保留私有运行数据");
    assert.equal(f.calls().filter((command) => command === "uninstall").length, 1);

    // 不能让测试安装器偷偷删旧映射，否则会掩盖卸载没有清理它的实现缺陷。
    const secondFixture = configGateFixture("success", { resetMapping: false, localKey: "d".repeat(48) });
    fs.writeFileSync(path.join(guiTarget, "release"), "finish reinstalled fixture configure");
    assert.notEqual(JSON.parse(fs.readFileSync(reg, "utf8")).instanceId, oldInstance);
    assert.equal(fs.existsSync(guiState), false);
    const status = await lifecycleRequest(origin, "/api/components/openai-bridge/config");
    assert.equal(status.status, 200); assert.equal(status.body.ok, true);
    assert.equal(status.body.providerId, "");
    const reconfigured = await postConfig(origin);
    assert.equal(reconfigured.status, 200); assert.equal(reconfigured.body.ok, true);
    const newId = reconfigured.body.providerId;
    assert.match(newId, /^custom-[1-9][0-9]*$/); assert.notEqual(newId, oldId);
    const newProviders = JSON.parse(fs.readFileSync(providerFile, "utf8"));
    assert.deepEqual(newProviders.providers[oldId], oldProvider, "新实例不能覆盖旧provider");
    assert.equal(newProviders.providers[newId].apiKey, "d".repeat(48));
    assert.equal(newProviders.active, oldProviders.active, "重配不能静默切换当前provider");
    assert.equal(fs.readFileSync(configFile, "utf8"), configBytes);
    const mapping = JSON.parse(fs.readFileSync(guiState, "utf8"));
    assert.equal(mapping.providerId, newId); assert.notEqual(mapping.fingerprint, oldMapping.fingerprint);
    assert.equal((await lifecycleRequest(origin, "/api/components/openai-bridge/config")).body.providerId, newId);

    const changed = await lifecycleRequest(origin, "/api/providers/save", { id: newId, baseUrl: "https://user-edited-fixture.example.invalid" });
    assert.equal(changed.status, 200); assert.equal(changed.body.ok, true);
    const editedBytes = fs.readFileSync(providerFile, "utf8");
    const beforeConfigure = secondFixture.calls().filter((command) => command === "gui-configure").length;
    for (const response of [await lifecycleRequest(origin, "/api/components/openai-bridge/config"), await postConfig(origin)]) {
      assert.equal(response.status, 409); assert.equal(response.body.code, "RUNTIME_CONFLICT");
    }
    assert.equal(secondFixture.calls().filter((command) => command === "gui-configure").length, beforeConfigure);
    assert.equal(fs.readFileSync(providerFile, "utf8"), editedBytes, "用户改过的provider仍拒绝覆盖");
    assert.equal(requests.length, 0);
  } finally {
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    fs.rmSync(guiState, { force: true }); fs.rmSync(guiTarget, { recursive: true, force: true });
    if (originalConfig) fs.writeFileSync(configFile, originalConfig); else fs.rmSync(configFile, { force: true });
  }
});
