import "../gw/config.mjs"; // 必须经 scripts/test.mjs：只操作隔离 HOME / fake PREFIX。
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import { ensureManagedBridge, retireManagedBridge, warmManagedBridge } from "../gw/managed-bridge.mjs";
import { guardRegistryFlock, registryFlockFixture } from "./fixtures/registry-flock.mjs";

// 用确定的假值验证环境隔离；不读取或转发调用者的任何真实凭据。
process.env.ANTHROPIC_API_KEY = "fixture-only-do-not-forward";
process.env.ANTHROPIC_AUTH_TOKEN = "fixture-only-do-not-forward";
process.env.CCAPP_RUN = "fixture-only-do-not-forward";
const home = process.env.CCAPP_HOME, prefix = process.env.CCAPP_PREFIX;
const root = fs.mkdtempSync(path.join(process.env.CCAPP_WORKSPACE, "managed-"));
const reg = path.join(home, ".cccodroid/services/openai-bridge.json");
const record = path.join(path.dirname(prefix), "components/openai-bridge.json");
const component = path.join(prefix, "lib/openai-bridge/component.cjs");
const lockFixture = registryFlockFixture();
beforeEach(() => lockFixture.reset());
const put = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o), { mode: 0o600 }); };
const replaceJson = (p, o) => { put(p + ".new", o); fs.renameSync(p + ".new", p); };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, message, ms = 3000) {
  const start = performance.now();
  while (!check()) {
    assert.ok(performance.now() - start < ms, message);
    await delay(15);
  }
}
async function within(work, ms, message) {
  let timer;
  try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
  finally { clearTimeout(timer); }
}
const fixtureSource = `const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const args=process.argv.slice(2),dir=args[args.indexOf('--dir')+1],endpoint=args[args.indexOf('--endpoint')+1],instanceId=args[args.indexOf('--instance')+1];
fs.appendFileSync(path.join(dir,'calls'),JSON.stringify({command:args[0],apiInEnv:!!process.env.ANTHROPIC_API_KEY||!!process.env.ANTHROPIC_AUTH_TOKEN,ccappRun:!!process.env.CCAPP_RUN})+'\\n');
const mode=fs.readFileSync(path.join(dir,'mode'),'utf8');
if(args[0]==='ensure'){
  fs.writeFileSync(path.join(dir,'launcher.pid'),String(process.pid));
  if(mode==='resident-hang'){
    const resident=spawn(process.execPath,['-e',"const fs=require('node:fs'),dir=process.argv[1].slice('managed-fixture-resident='.length);let beat=0;setInterval(()=>fs.writeFileSync(dir+'/heartbeat',String(++beat)),25);",'managed-fixture-resident='+dir],{detached:true,stdio:'ignore',env:process.env});
    resident.unref();fs.writeFileSync(path.join(dir,'resident.pid'),String(resident.pid));
  }
  setTimeout(()=>{if(mode==='fail')process.exitCode=1;else console.log(JSON.stringify({schema:1,id:'openai-bridge',ready:true,endpoint,instanceId:mode==='wrong'?'wrong':instanceId}));},mode==='hang'||mode==='resident-hang'?70000:100);
}else if(args[0]==='uninstall'){
  setTimeout(()=>{
    const registration=path.join(process.env.HOME,'.cccodroid/services/openai-bridge.json');
    if(mode==='fail'||mode==='uninstall-fail')process.exitCode=1;
    else if(mode==='replace-reg'){
      fs.rmSync(registration,{force:true});
      fs.writeFileSync(registration+'.next',fs.readFileSync(path.join(dir,'replacement.json')));
      fs.renameSync(registration+'.next',registration);
    }else if(mode!=='leave-reg')fs.rmSync(registration,{force:true});
  },100);
}else process.exitCode=2;
`;

function fixture(mode = "ok") {
  const dir = fs.mkdtempSync(path.join(root, "instance-"));
  fs.mkdirSync(path.dirname(component), { recursive: true });
  fs.writeFileSync(component, fixtureSource);
  fs.writeFileSync(path.join(dir, "mode"), mode);
  const r = { schema: 1, id: "openai-bridge", endpoint: "http://127.0.0.1:34591", runtimeDir: dir, instanceId: crypto.randomBytes(16).toString("hex") };
  const rec = { id: "openai-bridge", state: "ok", files: ["lib/openai-bridge/component.cjs", ...Array.from({ length: 1000 }, (_, i) => "lib/openai-bridge/node_modules/fixture/" + i)] };
  put(reg, r);
  put(record, rec);
  return { r, rec, dir, p: { custom: true, baseUrl: r.endpoint }, calls: () => {
    try { return fs.readFileSync(path.join(dir, "calls"), "utf8").trim().split("\n").map(JSON.parse); } catch { return []; }
  } };
}

function replacementFixture(f) {
  const dir = fs.mkdtempSync(path.join(root, "replacement-"));
  const r = { ...f.r, endpoint: "http://127.0.0.1:34594", runtimeDir: dir, instanceId: crypto.randomBytes(16).toString("hex") };
  fs.writeFileSync(path.join(dir, "mode"), "ok");
  fs.writeFileSync(path.join(dir, "private-data.txt"), "unrelated replacement fixture must survive");
  put(path.join(f.dir, "replacement.json"), r);
  return { dir, r };
}
function preservedReplacement(f, replacement) {
  assert.deepEqual(JSON.parse(fs.readFileSync(reg, "utf8")), replacement.r, "原实例卸载不得清掉随后注册的新实例");
  assert.equal(fs.readFileSync(path.join(replacement.dir, "private-data.txt"), "utf8"), "unrelated replacement fixture must survive");
  assert.equal(fs.existsSync(path.join(replacement.dir, "calls")), false, "不能执行新实例运行目录的 uninstall/ensure");
  assert.equal(fs.existsSync(path.join(replacement.dir, "launcher.pid")), false);
  assert.ok(f.calls().every((call) => call.command === "uninstall"));
}

// 只清理本测试写下且 /proc 命令行仍匹配的假进程，绝不扫描/停止真实桥服务。
function stopFixtureProcess(dir, name) {
  try {
    const pid = Number(fs.readFileSync(path.join(dir, name + ".pid"), "utf8"));
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    if (name === "resident" ? cmd.includes("managed-fixture-resident=" + dir) : cmd.includes(component) && cmd.includes(dir)) process.kill(pid, "SIGTERM");
  } catch {}
}
after(() => {
  for (const d of fs.readdirSync(root)) for (const name of ["launcher", "resident"]) stopFixtureProcess(path.join(root, d), name);
  fs.rmSync(root, { recursive: true, force: true });
  for (const p of [reg, record, component]) fs.rmSync(p, { force: true });
});

test("冷态在包装前调用固定组件 ensure，等待 ready；支持大安装记录", async () => {
  const f = fixture();
  let done = false;
  const result = ensureManagedBridge(f.p).then((r) => { done = true; return r; });
  await delay(20);
  assert.equal(done, false);
  assert.equal(await result, true);
  assert.deepEqual(f.calls(), [{ command: "ensure", apiInEnv: false, ccappRun: false }]);
});

test("并发会话共用同一次就绪，不启动多套组件", async () => {
  const f = fixture();
  assert.deepEqual(await Promise.all(Array.from({ length: 12 }, () => ensureManagedBridge(f.p))), Array(12).fill(true));
  assert.equal(f.calls().length, 1);
});

test("ready 缓存固定 20 秒，命中不续期、不过早失效，也不每轮 spawn", async (t) => {
  const f = fixture();
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  assert.equal(await ensureManagedBridge(f.p), true);
  now += 10000;
  assert.equal(await ensureManagedBridge(f.p), true);
  now += 9999;
  assert.deepEqual(await Promise.all(Array.from({ length: 10 }, () => ensureManagedBridge(f.p))), Array(10).fill(true));
  assert.equal(f.calls().length, 1, "20 秒内不能重复执行组件入口");
  now += 2;
  assert.equal(await ensureManagedBridge(f.p), true);
  assert.equal(f.calls().length, 2, "20 秒到期后必须重新确认就绪");
});

for (const [name, change] of [
  ["注册文件", (f) => replaceJson(reg, f.r)],
  ["安装记录", (f) => replaceJson(record, { ...f.rec, at: 12345 })],
  ["固定入口", () => fs.writeFileSync(component, fixtureSource + "\n// installed entry changed\n")],
]) test(`ready 缓存绑定${name}，文件变更后立即重新 ensure`, async () => {
  const f = fixture();
  assert.equal(await ensureManagedBridge(f.p), true);
  change(f);
  assert.equal(await ensureManagedBridge(f.p), true);
  assert.equal(f.calls().length, 2);
});

for (const [name, change] of [
  ["schema 2 注册", (f) => put(reg, { ...f.r, schema: 2 })],
  ["非 ok 安装记录", (f) => put(record, { ...f.rec, state: "installing" })],
  ["安装记录缺失", () => fs.rmSync(record)],
  ["固定入口缺失", () => fs.rmSync(component)],
]) test(`已有 ready 缓存不能掩盖${name}`, async () => {
  const f = fixture();
  assert.equal(await ensureManagedBridge(f.p), true);
  change(f);
  await assert.rejects(ensureManagedBridge(f.p), /本地 OpenAI 桥未就绪/);
  assert.equal(f.calls().length, 1);
});

test("远端、其他回环、错误边界、登录及端侧均不启动", async () => {
  const f = fixture();
  for (const baseUrl of ["https://other.example.invalid", "http://127.0.0.1:34592", f.r.endpoint + ".invalid", f.r.endpoint + "/v1", f.r.endpoint + "?token=fake", "http://fixture@127.0.0.1:34591", "http://127.1:34591"]) {
    assert.equal(await ensureManagedBridge({ custom: true, baseUrl }), false);
  }
  for (const flags of [{ login: true }, { local: true }, { custom: false }]) assert.equal(await ensureManagedBridge({ ...f.p, ...flags }), false);
  assert.equal(f.calls().length, 0);
});

test("缺少注册不接管其他本机服务；注册不允许指定命令", async () => {
  const f = fixture();
  fs.rmSync(reg);
  assert.equal(await ensureManagedBridge(f.p), false);
  put(reg, null);
  assert.equal(await ensureManagedBridge(f.p), false);
  fs.writeFileSync(reg, "{bad-json");
  assert.equal(await ensureManagedBridge({ custom: true, baseUrl: "http://127.0.0.1:34592" }), false);
  put(reg, { ...f.r, command: "do-not-execute" });
  await assert.rejects(ensureManagedBridge(f.p), /本地 OpenAI 桥未就绪/);
  assert.equal(f.calls().length, 0);
});

test("卸载或安装损坏后拒绝启动，不执行私有副本", async () => {
  const f = fixture();
  fs.rmSync(record);
  await assert.rejects(ensureManagedBridge(f.p), /本地 OpenAI 桥未就绪/);
  put(record, { id: "openai-bridge", state: "installing", files: ["lib/openai-bridge/component.cjs"] });
  await assert.rejects(ensureManagedBridge(f.p), /本地 OpenAI 桥未就绪/);
  assert.equal(f.calls().length, 0);
});

test("注册符号链接和被替换的固定入口不会执行其他脚本", async () => {
  const f = fixture();
  const dest = path.join(f.dir, "copied-registration");
  fs.renameSync(reg, dest);
  fs.symlinkSync(dest, reg);
  assert.equal(await ensureManagedBridge(f.p), false);
  fs.unlinkSync(reg); put(reg, f.r);
  const moved = path.join(f.dir, "moved-component.cjs");
  fs.renameSync(component, moved);
  fs.symlinkSync(moved, component);
  try { await assert.rejects(ensureManagedBridge(f.p), /本地 OpenAI 桥未就绪/); }
  finally { fs.unlinkSync(component); fs.renameSync(moved, component); }
  assert.equal(f.calls().length, 0);
});

test("失败明确结束且短期重复请求不反复拉起", async () => {
  const f = fixture("fail");
  await assert.rejects(ensureManagedBridge(f.p), /本地 OpenAI 桥未就绪/);
  await assert.rejects(ensureManagedBridge(f.p), /本地 OpenAI 桥未就绪/);
  assert.equal(f.calls().length, 1);
});

test("错误实例和就绪期间注册、安装记录被删除均拒绝", async () => {
  let f = fixture("wrong");
  await assert.rejects(ensureManagedBridge(f.p), /本地 OpenAI 桥未就绪/);
  f = fixture();
  const work = ensureManagedBridge(f.p);
  fs.rmSync(reg);
  await assert.rejects(work, /本地 OpenAI 桥未就绪/);
  f = fixture();
  const removal = ensureManagedBridge(f.p);
  fs.rmSync(record);
  await assert.rejects(removal, /本地 OpenAI 桥未就绪/);
});

test("恢复会话命中 ready 缓存，重开 App 后仍读取持久注册重新确认", async () => {
  const f = fixture();
  assert.equal(await ensureManagedBridge(f.p), true);
  assert.equal(await ensureManagedBridge({ ...f.p, baseUrl: f.p.baseUrl + "/" }), true);
  assert.equal(f.calls().length, 1);
  const fresh = await import("../gw/managed-bridge.mjs?new-gateway");
  assert.equal(await fresh.ensureManagedBridge(f.p), true);
  assert.equal(f.calls().length, 2);
});

test("组件管理器先 abort 在途 ensure 再卸载，不等 75 秒、不误杀常驻服务", { timeout: 8000 }, async (t) => {
  const f = fixture("resident-hang");
  let retirement;
  t.after(async () => {
    stopFixtureProcess(f.dir, "launcher"); stopFixtureProcess(f.dir, "resident");
    if (retirement) await within(retirement.catch(() => {}), 1500, "假卸载清理未结束");
  });
  const first = ensureManagedBridge(f.p), second = ensureManagedBridge(f.p);
  // 立即接 rejection handler；卸载应同时结束两个共享等待者。
  const starting = Promise.allSettled([first, second]);
  await until(() => fs.existsSync(path.join(f.dir, "resident.pid")), "假 ensure 未启动常驻服务");
  const resident = Number(fs.readFileSync(path.join(f.dir, "resident.pid"), "utf8"));
  assert.doesNotThrow(() => process.kill(resident, 0));
  const before = performance.now();
  const removal = retirement = retireManagedBridge("openai-bridge");
  await assert.rejects(ensureManagedBridge(f.p), /本地 OpenAI 桥未就绪/);
  assert.equal(await within(removal, 3000, "retire 仍在等待 75 秒 ensure 超时"), true);
  const settled = await within(starting, 1000, "在途 ensure 等待者未结束");
  assert.ok(settled.every((r) => r.status === "rejected"));
  assert.ok(performance.now() - before < 3000);
  assert.deepEqual(f.calls().map((c) => c.command), ["ensure", "uninstall"]);
  assert.doesNotThrow(() => process.kill(resident, 0), "retire 只能终止 ensure 启动器，不能误杀常驻服务");
  const heartbeat = () => { try { return Number(fs.readFileSync(path.join(f.dir, "heartbeat"), "utf8")); } catch { return 0; } };
  const beforeBeat = heartbeat();
  await until(() => heartbeat() > beforeBeat + 1, "卸载误杀常驻服务，心跳已停止", 1000);
  assert.equal(fs.existsSync(reg), false);
  assert.equal(await ensureManagedBridge(f.p), false);
  assert.equal(await retireManagedBridge("other-component"), false);
});

test("卸载清除 ready 缓存，原样恢复注册后仍须重新 ensure", async () => {
  const f = fixture();
  assert.equal(await ensureManagedBridge(f.p), true);
  assert.equal(await retireManagedBridge("openai-bridge"), true);
  assert.equal(fs.existsSync(reg), false);
  put(reg, f.r);
  assert.equal(await ensureManagedBridge(f.p), true);
  assert.deepEqual(f.calls().map((c) => c.command), ["ensure", "uninstall", "ensure"]);
});

test("合法 uninstall 删除自身后注册新实例：retire 成功且保留 replacement，不执行新目录", async () => {
  const f = fixture("replace-reg"), replacement = replacementFixture(f);
  assert.equal(await retireManagedBridge("openai-bridge"), true);
  assert.deepEqual(f.calls(), [{ command: "uninstall", apiInEnv: false, ccappRun: false }]);
  preservedReplacement(f, replacement);
});

for (const [name, corrupt] of [
  ["坏 JSON", () => fs.writeFileSync(reg, "{bad-json")],
  ["schema 2", (f) => put(reg, { ...f.r, schema: 2 })],
]) test(`fallback ${name}快照读取后被合法新实例替换：只保留新注册、不执行任何目录`, async (t) => {
  const f = fixture(), replacement = replacementFixture(f);
  corrupt(f);
  const close = fs.closeSync;
  let replaced = false;
  const hook = t.mock.method(fs, "closeSync", function (fd) {
    let target;
    try { target = fs.readlinkSync(`/proc/self/fd/${fd}`); } catch {}
    const result = Reflect.apply(close, fs, [fd]);
    if (!replaced && target === reg) {
      // 确定发生在原文件 snapshot 读取结束后，不依赖定时或调度竞争。
      replaced = true;
      replaceJson(reg, replacement.r);
    }
    return result;
  });
  let result;
  try { result = await retireManagedBridge("openai-bridge"); }
  finally { hook.mock.restore(); }
  assert.equal(replaced, true, "必须实际触发旧注册读取后的替换窗口");
  assert.equal(typeof result, "boolean");
  assert.deepEqual(f.calls(), []);
  preservedReplacement(f, replacement);
});

test("合法停用失败保留注册，返回卸载专用错误且允许修复后重试", async () => {
  const f = fixture("uninstall-fail");
  await assert.rejects(retireManagedBridge("openai-bridge"), (e) => {
    assert.match(e.message, /卸载|停用/);
    assert.doesNotMatch(e.message, /已停止本轮请求/);
    assert.equal(e.code, "MANAGED_BRIDGE_RETIRE_FAILED");
    assert.equal(e.stage, "retire-exit");
    return true;
  });
  assert.equal(fs.existsSync(reg), true);
  fs.writeFileSync(path.join(f.dir, "mode"), "ok");
  assert.equal(await retireManagedBridge("openai-bridge"), true);
});

test("retire 注册锁仅支持toybox -n：健康停用与坏注册清理都无需host -w", async () => {
  const f = fixture("leave-reg");
  assert.equal(await retireManagedBridge("openai-bridge"), true);
  assert.equal(fs.existsSync(reg), false); assert.deepEqual(f.calls().map((call) => call.command), ["uninstall"]);
  assert.ok(lockFixture.calls().length >= 2);
  assert.ok(lockFixture.calls().every((call) => JSON.stringify(call.args) === JSON.stringify(["-n", "3"])));
  put(reg, { ...f.r, schema: 2 });
  assert.equal(await retireManagedBridge("openai-bridge"), true);
  assert.equal(fs.existsSync(reg), false); assert.equal(f.calls().length, 1, "坏注册只能清固定元数据，不能执行uninstall");
});

test("retire 注册锁持续争用约1秒：专用锁失败保注册，释放后重试不粘retiring", async (t) => {
  const f = fixture(), original = fs.readFileSync(reg, "utf8"), guard = guardRegistryFlock(t, lockFixture); lockFixture.setMode("busy");
  const started = performance.now(); let ticks = 0; const heartbeat = setInterval(() => ticks++, 20);
  try {
    await assert.rejects(retireManagedBridge("openai-bridge"), (error) => {
      assert.equal(error.code, "MANAGED_BRIDGE_RETIRE_FAILED"); assert.equal(error.stage, "retire-lock");
      assert.match(error.message, /卸载|停用/); assert.doesNotMatch(error.message, /已停止本轮请求/);
      return true;
    });
    const elapsed = performance.now() - started;
    assert.ok(elapsed >= 900 && elapsed < 2200, `retire锁等待必须约1秒且有界，实际${elapsed}ms`);
    assert.ok(ticks >= 10, "锁争用时应异步重试而非阻塞网关");
    assert.ok(lockFixture.calls().length > 1); assert.deepEqual(f.calls(), []);
    assert.equal(fs.readFileSync(reg, "utf8"), original); assert.equal(fs.existsSync(component), true); assert.equal(fs.existsSync(record), true);
  } finally { clearInterval(heartbeat); lockFixture.setMode("ok"); guard.restore(); }
  assert.equal(await retireManagedBridge("openai-bridge"), true);
  assert.equal(fs.existsSync(reg), false); assert.deepEqual(f.calls().map((call) => call.command), ["uninstall"]);
});

test("坏注册遇到锁争用也不能无锁删除，锁恢复后可安全清掉而不执行组件", async (t) => {
  const f = fixture(), guard = guardRegistryFlock(t, lockFixture); fs.writeFileSync(reg, "{bad-registry-json"); lockFixture.setMode("busy");
  try {
    await assert.rejects(retireManagedBridge("openai-bridge"), { code: "MANAGED_BRIDGE_RETIRE_FAILED", stage: "retire-lock" });
    assert.equal(fs.readFileSync(reg, "utf8"), "{bad-registry-json"); assert.deepEqual(f.calls(), []);
  } finally { lockFixture.setMode("ok"); guard.restore(); }
  assert.equal(await retireManagedBridge("openai-bridge"), true);
  assert.equal(fs.existsSync(reg), false); assert.deepEqual(f.calls(), []);
});

test("已 aborted 的等待者不启动 ensure", async () => {
  const f = fixture(), controller = new AbortController();
  controller.abort();
  await assert.rejects(ensureManagedBridge(f.p, { signal: controller.signal }), { name: "AbortError" });
  assert.equal(f.calls().length, 0);
});

test("所有等待者取消后共享 ensure 仍继续，完成后可复用 ready", async () => {
  const f = fixture(), first = new AbortController(), second = new AbortController();
  const waiting = [ensureManagedBridge(f.p, { signal: first.signal }), ensureManagedBridge(f.p, { signal: second.signal })];
  const settled = Promise.allSettled(waiting);
  await until(() => f.calls().length === 1, "共享 ensure 未启动");
  first.abort(); second.abort();
  const results = await settled;
  assert.ok(results.every((r) => r.status === "rejected" && r.reason.name === "AbortError"));
  assert.equal(await ensureManagedBridge(f.p), true);
  assert.equal(f.calls().length, 1, "取消等待者不能取消后台共享启动");
});

test("停止等待只取消本会话，不杀共享启动器或另一会话", async () => {
  const f = fixture(), controller = new AbortController();
  const first = ensureManagedBridge(f.p, { signal: controller.signal });
  const second = ensureManagedBridge(f.p);
  await until(() => f.calls().length === 1, "共享 ensure 未启动");
  controller.abort();
  await assert.rejects(first, { name: "AbortError" });
  assert.equal(await second, true);
  assert.equal(await ensureManagedBridge(f.p), true);
  assert.equal(f.calls().length, 1);
});

test("网关启动预热：有注册时后台拉起一次", async () => {
  const f = fixture();
  assert.equal(await warmManagedBridge(), true);
  assert.deepEqual(f.calls().map((call) => call.command), ["ensure"]);
  assert.equal(await warmManagedBridge(), true);
  assert.equal(f.calls().length, 1, "ready 缓存内不重复拉起");
});

test("网关启动预热：没有注册时不碰组件", async () => {
  const f = fixture();
  fs.rmSync(reg, { force: true });
  assert.equal(await warmManagedBridge(), false);
  assert.deepEqual(f.calls(), []);
});

test("网关启动预热：已停用或恢复预算耗尽时不自作主张重启", async (t) => {
  for (const marker of [path.join("disabled"), path.join("runtime-home/.claude-code-router/recovery.failed")]) {
    const f = fixture();
    fs.mkdirSync(path.dirname(path.join(f.dir, marker)), { recursive: true });
    fs.writeFileSync(path.join(f.dir, marker), "stopped\n");
    assert.equal(await warmManagedBridge(), false, marker + " 时不应预热");
    assert.deepEqual(f.calls(), [], marker + " 时不应调用组件");
  }
});

test("网关启动预热：组件不健康只当没预热，不抛出", async () => {
  const f = fixture("fail");
  assert.equal(await warmManagedBridge(), false);
  assert.deepEqual(f.calls().map((call) => call.command), ["ensure"]);
});
