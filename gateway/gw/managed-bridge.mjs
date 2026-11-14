import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { CFG, PREFIX, log, tz } from "./config.mjs";
import { componentEnv as sharedComponentEnv } from "./component-env.mjs";
import { sameFile as pathSame } from "./pathguard.mjs";

const ID = "openai-bridge";
const ENTRY = "lib/openai-bridge/component.cjs";
const inFlight = new Map(), failures = new Map(), configuring = new Set();
const SUCCESS_TTL = 20000, FAILURE_TTL = 60000, OUTPUT_LIMIT = 16384;
let retiring = null, ready = null, configurationEpoch = 0;

function fail(stage = "binding") {
  const removal = stage.startsWith("retire-");
  const error = new Error(removal
    ? tz("本地 OpenAI 桥停用失败，组件文件已保留。请检查运行状态后重试卸载。")
    : tz("本地 OpenAI 桥未就绪，已停止本轮请求。请检查组件配置或运行状态。"));
  // 只携带本模块的静态阶段；不附注册、命令参数、子进程输出或底层异常。
  error.code = removal ? "MANAGED_BRIDGE_RETIRE_FAILED" : "MANAGED_BRIDGE_NOT_READY";
  error.stage = stage;
  return error;
}

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const stamp = (st) => [st.dev, st.ino, st.mode, st.size, st.mtimeNs, st.ctimeNs].join(":");
const hash = (data) => crypto.createHash("sha256").update(data).digest("hex");

function snapshot(file, max) {
  // O_NOFOLLOW/O_NONBLOCK 同时拒绝链接和会阻塞网关的特殊文件；读取量也有硬上限。
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > BigInt(max)) throw fail();
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let length = 0, n;
    while (length < bytes.length && (n = fs.readSync(fd, bytes, length, bytes.length - length, null))) length += n;
    if (length !== Number(before.size) || stamp(before) !== stamp(fs.fstatSync(fd, { bigint: true }))) throw fail();
    const data = bytes.subarray(0, length);
    return { data, identity: stamp(before) + ":" + hash(data) };
  } finally { fs.closeSync(fd); }
}

function jsonSnapshot(file, max = 4096) {
  const s = snapshot(file, max);
  return { value: JSON.parse(s.data.toString("utf8")), identity: s.identity };
}

function registryDirectory() {
  // HOME 是宿主指定的信任根。逐级固定目录 fd，既不跟 .cccodroid/services 的链接，
  // 也不让并发改名把 unlink 引到别处；最后的注册链接只会被 unlink，绝不跟随。
  let fd = fs.openSync(CFG.home, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try {
    for (const name of [".cccodroid", "services"]) {
      const next = fs.openSync(`/proc/self/fd/${fd}/${name}`,
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      fs.closeSync(fd);
      fd = next;
    }
    return fd;
  } catch (error) { fs.closeSync(fd); throw error; }
}

function withRegistryFile(fn) {
  const fd = registryDirectory();
  try { return fn(`/proc/self/fd/${fd}/${ID}.json`); }
  finally { fs.closeSync(fd); }
}

function registrationExists() {
  try { return withRegistryFile((file) => { fs.lstatSync(file); return true; }); }
  catch (error) { if (error.code === "ENOENT") return false; throw fail("retire-lock"); }
}

const readRegistration = () => withRegistryFile((file) => jsonSnapshot(file));

function inspectRegistration(file) {
  const st = fs.lstatSync(file, { bigint: true });
  const current = { stamp: stamp(st), stored: null, identity: null };
  // 坏 JSON 也保留原字节身份；链接/特殊文件只看 lstat，绝不跟随或阻塞读取。
  if (st.isFile() && st.size <= 4096n) {
    const s = snapshot(file, 4096);
    if (stamp(fs.lstatSync(file, { bigint: true })) !== current.stamp || !s.identity.startsWith(current.stamp + ":")) throw fail();
    current.identity = s.identity;
    try { current.stored = { value: JSON.parse(s.data.toString("utf8")), identity: s.identity }; }
    catch {}
  }
  return current;
}

function tryRegistryLock(tool, fd, timeout) {
  return new Promise((resolve) => {
    let child, timer, settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true; clearTimeout(timer); resolve(result);
    };
    try {
      // util-linux 和 Android toybox 都支持 -n；不能用后者不支持的 -w，也不用 shell。
      child = spawn(tool, ["-n", "3"], { env: componentEnv(), stdio: ["ignore", "ignore", "ignore", fd] });
    } catch (error) { finish(error.code === "ENOENT" ? "missing" : "unsupported"); return; }
    child.once("error", (error) => finish(error.code === "ENOENT" ? "missing" : "unsupported"));
    child.once("close", (code) => finish(code === 0 ? "locked" : code === 1 ? "busy" : "unsupported"));
    timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      finish("timeout");
    }, Math.max(1, timeout));
  });
}

async function withRegistryLock(fn) {
  let dir, fd, acquired = false;
  try {
    dir = registryDirectory();
    const file = `/proc/self/fd/${dir}/${ID}.json`, lock = `/proc/self/fd/${dir}/${ID}.lock`;
    // 和组件共用同一 open-file-description；目录/锁 fd 跨异步重试保持打开。
    fd = fs.openSync(lock, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
    const st = fs.fstatSync(fd, { bigint: true });
    const sameLock = () => {
      const current = fs.lstatSync(lock, { bigint: true }), opened = fs.fstatSync(fd, { bigint: true });
      return st.isFile() && current.isFile() && opened.isFile() &&
        ["dev", "ino", "mode"].every((key) => st[key] === current[key] && st[key] === opened[key]);
    };
    if (!sameLock()) throw fail("retire-lock");
    const tools = [...new Set([path.join(PREFIX, "bin", "flock"), path.join(path.dirname(process.execPath), "flock"), "/system/bin/flock"])];
    const deadline = performance.now() + 1000;
    while (tools.length && performance.now() < deadline) {
      for (let i = 0; i < tools.length && performance.now() < deadline;) {
        if (!sameLock()) throw fail("retire-lock");
        // 每次尝试给满剩下的预算：手机内存紧时 exec 一次就可能过 200ms，以前 200ms 一到就杀掉、还把这个候选删了，
        // 唯一能用的 /system/bin/flock 一次没起来就直接报卸载失败
        const result = await tryRegistryLock(tools[i], fd, deadline - performance.now());
        if (!sameLock()) throw fail("retire-lock");
        if (result === "locked") {
          acquired = true;
          return await fn(file, () => { if (!sameLock()) throw fail("retire-lock"); });
        }
        // -n 返回竞争失败说明工具可用；锁定此候选重试，不能借另一程序绕开同一把锁。
        if (result === "busy") { tools.splice(0, tools.length, tools[i]); break; }
        if (result === "timeout") break;     // 预算已耗尽，统一交给下面报 retire-lock
        // 不存在与不兼容/执行失败均继续尝试下一固定候选，不依赖宿主恰有 util-linux。
        tools.splice(i, 1);
      }
      const remaining = deadline - performance.now();
      if (tools.length && remaining > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(25, remaining)));
    }
    throw fail("retire-lock");
  } catch (error) {
    if (acquired || error.stage === "retire-lock" || error.code === "ENOENT") throw error;
    throw fail("retire-lock");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (dir !== undefined) fs.closeSync(dir);
  }
}

// App 层修复只复用固定注册锁，不执行组件启动/停止，也不接受请求指定锁路径。
export const withManagedBridgeRegistryLock = (fn) => withRegistryLock((file, recheck) => fn(recheck));

function clearRegistration(file, expected, sameInstance) {
  try {
    const current = inspectRegistration(file);
    const sameFile = current.stamp === expected.stamp && current.identity === expected.identity;
    // 健康卸载可清除同一实例的重写注册；另一实例（即便合法）一律保留。
    const r = current.stored?.value;
    // runtimeDir 按目录身份（dev:ino）比：同一目录的别名写法（/data/data 与 /data/user/0）不算「另一实例」（06-路径别名卸载走不通）
    const same = sameInstance && object(r) && Object.keys(r).length === 5 &&
      ["schema", "id", "endpoint", "instanceId"].every((key) => r[key] === sameInstance[key]) &&
      typeof r.runtimeDir === "string" && pathSame(r.runtimeDir, sameInstance.runtimeDir);
    if (!sameFile && !same) {
      log("[comp] openai-bridge 卸载降级（stage=retire-registration-changed）");
      return false;
    }
    fs.unlinkSync(file);
    return true;
  } catch (error) {
    if (error.code !== "ENOENT") log("[comp] openai-bridge 卸载降级（stage=retire-cleanup）");
    return false; // 清不了也不能执行坏元数据指定的脚本或阻塞组件文件卸载。
  }
}

function endpointOf(value) {
  if (typeof value !== "string") return "";
  const m = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{3,4})\/?$/.exec(value);
  return m && Number(m[1]) >= 1024 && Number(m[1]) <= 65535 ? "http://127.0.0.1:" + m[1] : "";
}

function installedBinding(stored) {
  const r = stored.value;
  const endpoint = endpointOf(r?.endpoint);
  if (!object(r) || r.schema !== 1 || r.id !== ID || !endpoint || r.endpoint !== endpoint ||
      typeof r.runtimeDir !== "string" || !path.isAbsolute(r.runtimeDir) || r.runtimeDir.includes("\0") ||
      path.resolve(r.runtimeDir) !== r.runtimeDir || typeof r.instanceId !== "string" || !/^[0-9a-f]{32}$/.test(r.instanceId) ||
      Object.keys(r).length !== 5 || Object.keys(r).some((k) => !["schema", "id", "endpoint", "runtimeDir", "instanceId"].includes(k))) throw fail();
  const component = path.join(PREFIX, ENTRY);
  try {
    const record = jsonSnapshot(path.join(path.dirname(PREFIX), "components", ID + ".json"), 4 << 20);
    const rec = record.value;
    const safeRel = (value) => typeof value === "string" && value.length > 0 && !value.includes("\0") && !value.includes("\\") &&
      !path.isAbsolute(value) && value.split("/").every((part) => part && part !== "." && part !== "..");
    if (!object(rec) || rec.id !== ID || rec.state !== "ok" || !Array.isArray(rec.files) ||
        !rec.files.includes(ENTRY) || !rec.files.every(safeRel) ||
        (rec.skill && (typeof rec.skill !== "string" || !/^(?!\.+$)[A-Za-z0-9._-]{1,64}$/.test(rec.skill)))) throw fail();
    const real = fs.realpathSync(component), root = fs.realpathSync(path.join(PREFIX, "lib", ID));
    const prefixRoot = fs.realpathSync(PREFIX);
    if (root !== path.join(prefixRoot, "lib", ID) || real !== path.join(root, "component.cjs")) throw fail();
    const entry = snapshot(component, 4 << 20);
    // 不能只按注册字段缓存：同路径原子替换、内容/状态/权限改变也必须重新 ensure。
    const key = hash(JSON.stringify([r, component, prefixRoot, stored.identity, record.identity, entry.identity]));
    return { ...r, component, key };
  } catch { throw fail(); }
}

function providerEndpoint(p) {
  // 在 streamfix 包装之前只认显式注册的本机端点；其他接口和登录令牌不碰。
  return PREFIX && p?.custom && !p.login && !p.local ? endpointOf(p.baseUrl) : "";
}

function binding(endpoint) {
  let stored;
  try { stored = readRegistration(); }
  catch { return null; }
  if (!object(stored.value) || endpointOf(stored.value.endpoint) !== endpoint) return null;
  return installedBinding(stored);
}

// HOME 在信任根这一层规范成真实路径，和 bridge-config 的归属检查一致（#66 第 4 项）
const componentEnv = () => { let home = CFG.home; try { home = fs.realpathSync(home); } catch {} return sharedComponentEnv(home, PREFIX); };

function signalLauncher(child, signal) {
  if (!child?.pid) return;
  const groups = new Set();
  if (child.exitCode === null && child.signalCode === null) groups.add(child.pid);
  // component -> spawnSync installer -> spawnSync bash，timeout 还可能另开 PGID。
  // detached launcher 独占 SID，只取消这个 session 内的短命组；不按后代树杀进程。
  // start-bridge/watchdog 用 setsid 投递常驻 watchdog/CCR，二者的 SID 不同，绝不会入选。
  try {
    for (const name of fs.readdirSync("/proc")) {
      if (!/^[1-9][0-9]*$/.test(name)) continue;
      try {
        const stat = fs.readFileSync(`/proc/${name}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
        const group = Number(fields[2]), session = Number(fields[3]);
        if (session === child.pid && group > 1) groups.add(group);
      } catch {} // 进程退出或无权查看，不读取 cmdline/environ。
    }
  } catch {}
  for (const group of groups) {
    try { process.kill(-group, signal); } catch {}
  }
}

function launch(r, command) {
  const removal = command === "uninstall", stage = removal ? "retire" : "ensure";
  let child, timeout, killTimer, settled = false, stopping = false;
  let cancel;
  const promise = new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      child?.stdout?.destroy();
      if (error) reject(error);
      else resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const stop = (error) => {
      if (settled || stopping) return;
      stopping = true;
      clearTimeout(timeout);
      signalLauncher(child, "SIGTERM");
      // 即使 launcher 先退出，也要完成第二次清扫，避免 spawnSync/忽略 TERM 的孙进程遗留。
      killTimer = setTimeout(() => {
        signalLauncher(child, "SIGKILL");
        finish(error);
      }, 300);
    };
    cancel = () => stop(fail("ensure-cancelled"));
    const args = [r.component, command, "--dir", r.runtimeDir, "--endpoint", r.endpoint, "--instance", r.instanceId];
    if (removal) args.push("--yes");
    try {
      // 注册数据不能指定可执行文件或 shell 片段；不继承凭据、模型环境或子进程输出。
      child = spawn(process.execPath, args, {
        env: componentEnv(), detached: true, stdio: ["ignore", removal ? "ignore" : "pipe", "ignore"],
      });
    } catch { finish(fail(stage + "-spawn")); return; }
    child.on("error", () => { if (!stopping) finish(fail(stage + "-spawn")); });
    child.stdout?.on("data", (chunk) => {
      if (stopping || settled) return;
      length += chunk.length;
      if (length > OUTPUT_LIMIT) { stop(fail("ensure-output")); return; }
      chunks.push(chunk);
    });
    child.stdout?.on("error", () => stop(fail("ensure-output")));
    child.on("exit", (code) => {
      if (code !== 0) stop(fail(stage + "-exit"));
    });
    child.on("close", (code) => {
      if (settled || stopping) return;
      if (code !== 0) stop(fail(stage + "-exit"));
      else finish();
    });
    timeout = setTimeout(() => stop(fail(stage + "-timeout")), removal ? 40000 : 75000);
  });
  return { promise, cancel: () => cancel?.() };
}

function waitFor(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason || new Error("aborted"));
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason || new Error("aborted")); };
    signal.addEventListener("abort", abort, { once: true });
    // 不用被丢弃的 .finally 派生拒绝 promise；即使所有 waiter 都取消，共享工作仍有拒绝处理器。
    promise.then((value) => {
      signal.removeEventListener("abort", abort);
      resolve(value);
    }, (error) => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
  });
}

/**
 * GUI 写配置/重启前同步占闸，finally 调用返回的幂等 release。只清内存、不启动/停止服务。
 * 已有注册端点和配置期间新注册端点受保护；其他 provider 不被配置操作阻塞。
 */
export function beginManagedBridgeConfiguration() {
  const scope = { endpoint: "" };
  try {
    const r = readRegistration().value;
    if (object(r)) scope.endpoint = endpointOf(r.endpoint);
  } catch {}
  const invalidate = () => { ready = null; failures.clear(); configurationEpoch++; };
  configuring.add(scope);
  invalidate();
  return () => {
    if (!configuring.delete(scope)) return;
    invalidate();
  };
}

/** false = 非显式托管端点；true = 固定入口确认就绪（20 秒内可复用）。signal 只取消本次等待。 */
export async function ensureManagedBridge(p, { signal } = {}) {
  const endpoint = providerEndpoint(p);
  if (!endpoint) return false;
  if (retiring) throw fail("retiring");
  if ([...configuring].some((scope) => scope.endpoint === endpoint)) throw fail("configuring");
  let r;
  try { r = binding(endpoint); }
  catch { ready = null; throw fail(); }
  if (!r) { ready = null; return false; }
  if (configuring.size) {
    // 第一次配置可能此时才写出注册；后续短暂移除注册时也继续保护这个端点。
    for (const scope of configuring) if (!scope.endpoint) scope.endpoint = endpoint;
    throw fail("configuring");
  }
  if (signal?.aborted) throw signal.reason || new Error("aborted");
  const epoch = configurationEpoch, key = epoch + ":" + r.key;
  if (ready?.key !== key) ready = null;
  if (ready && ready.until > Date.now()) return true;
  if ((failures.get(key) || 0) > Date.now()) throw fail("cooldown");
  if (!inFlight.has(key)) {
    const task = launch(r, "ensure");
    const work = task.promise.then((out) => {
      if (retiring) throw fail("ensure-cancelled");
      if (configuring.size || epoch !== configurationEpoch) throw fail("configuring");
      let result;
      try { result = JSON.parse(out.trim()); }
      catch { throw fail("ensure-result"); }
      if (!object(result) || result.schema !== 1 || result.id !== ID || result.ready !== true ||
          result.endpoint !== r.endpoint || result.instanceId !== r.instanceId) throw fail("ensure-result");
      const current = binding(r.endpoint);
      if (!current || current.key !== r.key) throw fail("ensure-changed");
      ready = { key, until: Date.now() + SUCCESS_TTL };
      failures.delete(key);
      return true;
    }).catch((error) => {
      if (!retiring && !configuring.size && epoch === configurationEpoch) {
        if (failures.size >= 32) failures.delete(failures.keys().next().value);
        failures.set(key, Date.now() + FAILURE_TTL);
      }
      throw error;
    }).finally(() => {
      if (inFlight.get(key)?.promise === work) inFlight.delete(key);
    });
    inFlight.set(key, { promise: work, cancel: task.cancel });
    work.catch(() => {});
  }
  return waitFor(inFlight.get(key).promise, signal);
}

/**
 * false = 非本组件/无可安全清除的注册；true = 已停用，或只清理固定残留注册并跳过脚本。
 * 固定 uninstall 或注册锁失败会拒绝（静态 code/stage），让组件管理器保包。
 */
export function retireManagedBridge(id) {
  if (id !== ID || !PREFIX) return Promise.resolve(false);
  if (retiring) return retiring;
  ready = null;
  failures.clear();
  // 先同步建立闸门，再取消共享 ensure；会话自己的 AbortSignal 永远不走这里。
  const pending = [...inFlight.values()];
  retiring = Promise.resolve().then(async () => {
    for (const task of pending) task.cancel();
    await Promise.allSettled(pending.map((task) => task.promise));
    let r, original;
    try {
      // 缺失注册不需要打开/创建锁，更不能因 flock 不可用阻塞元数据降级清理。
      if (!registrationExists()) return false;
      const result = await withRegistryLock((file) => {
        const expected = inspectRegistration(file);
        try { return { r: installedBinding(expected.stored), original: expected }; }
        catch {
          log("[comp] openai-bridge 卸载降级（stage=retire-binding）");
          return { cleared: clearRegistration(file, expected) };
        }
      });
      if (!result.r) return result.cleared;
      ({ r, original } = result);
    } catch (error) {
      if (error.code === "ENOENT") {
        try { if (!registrationExists()) return false; } catch {}
        throw fail("retire-lock");
      }
      if (error.stage === "retire-lock") throw error;
      log("[comp] openai-bridge 卸载降级（stage=retire-binding）");
      return false;
    }
    try { await launch(r, "uninstall").promise; }
    catch (e) {
      // 注册表指向的运行时目录已经不存在：旧实例不可能还在跑，launch 只会失败，不能再让它卡住组件卸载。
      // 其它失败（安装器退出非 0）照旧保注册、报错让用户重试，不能把还在的实例悄悄丢下（0.6.9 审计 200-OB-06）
      if (e.stage === "retire-lock" || fs.existsSync(r.runtimeDir)) throw e;
      log(`[comp] openai-bridge 卸载降级（stage=${e.stage || "retire-launch"}，运行时目录已不在）`);
    }
    // uninstall 自己也要拿注册锁，不能跨进程执行持锁；返回后重新拿锁校验身份。
    // 原实例已消失则无需拿锁；同实例残留可清，别的新实例绝不删，不访问 runtimeDir。
    try {
      if (!registrationExists()) return true;
      await withRegistryLock((file) => clearRegistration(file, original, r));
    } catch (error) {
      if (error.code === "ENOENT") {
        try { if (!registrationExists()) return true; } catch {}
        throw fail("retire-lock");
      }
      if (error.stage === "retire-lock") throw error;
      log("[comp] openai-bridge 卸载降级（stage=retire-cleanup）");
    }
    return true;
  }).finally(() => { retiring = null; });
  retiring.catch(() => {});
  return retiring;
}
