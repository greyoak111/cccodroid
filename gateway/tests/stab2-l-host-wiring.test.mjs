// 第二份稳定性报告 l 组：Android 宿主修复的接线锚点。
// 纯逻辑由 android/tests/cc/codroid/Stab2LHostTest.java 跑；这里只检查生命周期 / 投递路径确实接上了，
// 因为这些时序在 JS 测试里模拟不了，真机也没跑（见交付说明「未测」）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(`../../android/java/cc/codroid/${p}`, import.meta.url), "utf8");
const gw = read("GatewayService.java");
const notify = read("Notify.java");
const dev = read("DeviceTools.java");

test("BUG-A01 守护线程不再无界 proc.waitFor，改成有界等待 + 身份检查交替", () => {
  assert.ok(gw.includes("int rc = waitGatewayExit();"), "supervise 没改用 waitGatewayExit");
  assert.ok(!gw.includes("int rc = proc.waitFor();"), "supervise 里还留着无界 proc.waitFor");
  const body = gw.slice(gw.indexOf("private int waitGatewayExit()"), gw.indexOf("private boolean alive()"));
  assert.ok(body.includes("Env.proveGateway()"), "有界等待期间没核身份");
  assert.ok(body.includes("aliveDecision("), "没按连续失联时长决定结束重起");
  assert.ok(body.includes("killGateway()"), "失联够久没结束进程");
});

test("BUG-A02 划掉后的空闲查询查完要复核前台与启动代次", () => {
  assert.ok(gw.includes("synchronized (life) { startSeq++; }"), "onStartCommand 没记启动代次");
  assert.ok(gw.includes("shutdownIfIdle(seen)"), "划掉后的空闲查询没走带复核的停机");
  const body = gw.slice(gw.indexOf("private boolean shutdownIfIdle"), gw.indexOf("public void onDestroy()"));
  assert.ok(body.includes("idleQueryStillValid(MainActivity.appForeground(), seenSeq, startSeq)"),
    "停机前没在一把锁里复核前台与代次");
  // 复核之后、退出锁才杀进程：别让等锁的主线程跟着等网关收尾
  const killAt = body.indexOf("killGateway();");
  const holdAt = body.indexOf("stopping = true;");
  assert.ok(holdAt > 0 && killAt > holdAt, "停机顺序不对");
  assert.ok(body.slice(0, killAt).split("synchronized (life)").length - 1 === 1,
    "杀进程时还在锁里（会卡住主线程 5 秒）");
});

test("BUG-A03 准备期间的启动在停止 / 停住 / 换代后放弃；进程发布与停止方原子交接", () => {
  const spawn = gw.slice(gw.indexOf("private void spawnGateway()"), gw.indexOf("private void killGateway()"));
  const checks = spawn.split("checkSpawn(myGen);").length - 1;
  assert.ok(checks >= 3, "准备前后应有至少 3 次取消检查，实际 " + checks);
  assert.ok(spawn.includes("synchronized (life)") && spawn.includes("spawnCancelled(stopping, paused, myGen, lifeGen)"),
    "pb.start 之后没有在锁里复核代次再发布进程");
  assert.ok(spawn.includes("if (cancel) { terminate(p); throw new Cancelled(); }"),
    "取消后没把已经起来的进程收干净");
  assert.ok(spawn.includes("catch (Cancelled e)") === false); // 捕获在 supervise，不在 spawn
  assert.ok(gw.includes("catch (Cancelled e)"), "supervise 没处理 Cancelled");
});

test("BUG-A04 通知投递前统一检查总开关与具体渠道，launch 不再无条件报已发通知", () => {
  const uses = dev.split("notifyBlocked(c)").length - 1;
  assert.ok(uses >= 2, "notify 与 launch 都要先过 notifyBlocked，实际调用 " + uses + " 次");
  assert.ok(!dev.includes("if (!nm.areNotificationsEnabled()) return fail("),
    "notify 里还留着只看总开关的旧检查");
  const launch = dev.slice(dev.indexOf("private static JSONObject launch("), dev.indexOf("private static String clip("));
  assert.ok(launch.indexOf("notifyBlocked(c)") > 0 && launch.indexOf("notifyBlocked(c)") < launch.indexOf("shown\", \"notification\""),
    "launch 在发通知前没检查通知能不能显示");
});

test("BUG-A05 订阅开始与网关换代时回收旧轮次文本，条数与字数都有上限", () => {
  const run = notify.slice(notify.indexOf("private void run()"), notify.indexOf("private void onEvent("));
  assert.ok(run.includes("runText.clear()"), "新一次订阅没清掉上一次的旧轮次文本");
  assert.ok(notify.includes("gatewayChanged(boot, lastBoot)") && notify.includes("runText.clear()"),
    "hello 里网关启动号变了没回收旧文本");
  assert.ok(notify.includes("removeEldestEntry"), "runText 没有条数上限");
  assert.ok(notify.includes("RUN_TEXT_KEEP") && notify.includes("RUN_TEXT_CHARS"), "runText 缺上限常量");
});

test("组件安装报告 §1：安装心跳接进两处探活失败路径，时限 120 秒", () => {
  assert.ok(gw.includes("static final long INSTALL_GRACE_MS = 120000"), "没放宽到 120 秒");
  const wait = gw.slice(gw.indexOf("private int waitGatewayExit()"), gw.indexOf("private boolean alive()"));
  assert.ok(wait.includes("installingGrace()"), "有界等待的探活失败没查安装心跳");
  const alive = gw.slice(gw.indexOf("private boolean alive()"), gw.indexOf("private static boolean alivePid"));
  assert.ok(alive.includes("installingGrace()"), "alive() 的探活失败没查安装心跳");
  assert.ok(gw.includes("installingBeat(File files, long now)") && gw.includes("installingPhase(String phase)")
    && gw.includes("installingFresh(long now, long at)") && gw.includes("beatBetter(long now, long bestAt, long t, String phase)")
    && gw.includes("parseBeatAt(String s, long now)"), "心跳判定缺了纯逻辑件");
  // 放宽要清零连续失联起点：宽限期一过从零重新累计，不能把安装期间的旧账一次清算
  assert.ok(wait.includes("if (installingGrace()) { unprovenSince = 0; continue; }")
    && alive.includes("if (installingGrace()) { aliveUnprovenSince = 0; return true; }"),
    "安装放宽后没清零连续失联起点");
});

test("复核 67ea9ba：启动恢复心跳、接管路径、多份心跳取最新", () => {
  // P1-3：启动恢复也写 recover 心跳，看门狗放行这个阶段
  assert.ok(gw.includes('"recover".equals(phase)'), "看门狗没放行 recover 阶段的恢复心跳");
  // P2-13：备份是独立阶段，看门狗分得清「在备份」和「卡在 switch」
  assert.ok(gw.includes('"backup".equals(phase)'), "看门狗没放行 backup 阶段的备份心跳");
  // P1-4：没有自己拉起进程时的 alive() 与 squatted() 都先查安装心跳，别杀服务重建前的残留网关
  const alive = gw.slice(gw.indexOf("private boolean alive()"), gw.indexOf("private static boolean alivePid"));
  assert.ok(alive.includes("proc == null && Env.portBusy() && installingGrace()"), "alive() 无进程分支的宽限没要求端口忙 + 服务重建（死进程会空等 120 秒，复核 R2-P1-3）");
  assert.ok(gw.includes("SQUAT_WAIT"), "squatted() 没有「正在安装，先不打扰」的结论");
  const squatted = gw.slice(gw.indexOf("private int squatted()"), gw.indexOf("private String last"));
  assert.ok(squatted.includes("installingGrace()"), "squatted() 发信号前没查安装心跳");
  assert.ok(squatted.includes("!gw.isEmpty() && anyAlive(gw) && installingGrace()"), "squatted() 没要求真有活着的网关进程（心跳文件可能是死网关留下的）");
  assert.ok(gw.includes("sq == SQUAT_ADOPTED || sq == SQUAT_WAIT"), "守护循环没处理 SQUAT_WAIT");
  // P2-11：心跳文件先 isFile 再读，FIFO 不能把 supervise 线程卡死
  assert.ok(gw.includes("!f.getName().endsWith(\".installing\") || !f.isFile()"), "installingBeat 没挡非普通文件");
  // P2-9：看门狗按开机单调时间读心跳，墙钟跳变不再失真
  assert.ok(gw.includes("android.os.SystemClock.elapsedRealtime"), "installingGrace 没用单调钟");
});

test("心跳跨语言契约：JS 写 at/phase/gw/boot 与 Java parseBeatAt 解析口径一致", () => {
  const comp = fs.readFileSync(new URL("../gw/components.mjs", import.meta.url), "utf8");
  // JS 侧：beat 写 {id, phase, moved, at, gw, boot}，at 是 /proc/uptime 单调毫秒
  assert.ok(comp.includes("uptimeMs"), "JS 心跳没用单调时间");
  assert.ok(comp.includes("{ id, phase, moved, at: uptimeMs(), gw: process.pid, boot: bootId() }"), "JS 心跳字段/顺序和契约不符");
  // Java 侧：parseBeatAt 按 "at" / "phase" / "boot" 解析同一批字段；两边的字段名要一起改
  assert.ok(gw.includes("indexOf(\"\\\"at\\\"\")") && gw.includes("indexOf(\"\\\"phase\\\"\")") && gw.includes("indexOf(\"\\\"boot\\\"\")"),
    "Java 解析口径和 JS 写入口径对不上");
  // P0 单飞：启动恢复和安装前预恢复共用同一个，别并发互删
  assert.ok(comp.includes("compRecovering") && comp.includes("if (compRecovering) return compRecovering"), "compRecover 没做单飞");
});
