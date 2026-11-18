package cc.codroid;

/**
 * 第二份稳定性报告 l 组（Android 宿主）的纯逻辑回归：
 *   BUG-A01 有界等待时的「连续失联多久才结束重起」；
 *   BUG-A02 划掉后的空闲查询查完，复核前台与启动代次；
 *   BUG-A03 准备中的启动遇到停止 / 停住 / 服务换代就放弃；
 *   BUG-A04 通知总开关 / 渠道重要性决定能不能报「已发通知」；
 *   BUG-A05 网关启动号变了才回收旧轮次文本。
 * 用安卓桩（android.jar）编译运行，不碰安卓运行时；这些判断本身只用基本类型。
 */
public class Stab2LHostTest {
    static int fail = 0;
    static void eq(String what, boolean got, boolean want) {
        boolean ok = got == want;
        if (!ok) fail++;
        System.out.println((ok ? "✓ " : "✗ ") + what + "（得到 " + got + "，期望 " + want + "）");
    }
    static void eql(String what, long got, long want) {
        boolean ok = got == want;
        if (!ok) fail++;
        System.out.println((ok ? "✓ " : "✗ ") + what + "（得到 " + got + "，期望 " + want + "）");
    }

    public static void main(String[] a) {
        // ── BUG-A03：spawnGateway 准备期间的取消判断 ──
        eq("A03 一切都新鲜：照常启动", GatewayService.spawnCancelled(false, false, 7, 7), false);
        eq("A03 服务停止后：放弃这次启动", GatewayService.spawnCancelled(true, false, 7, 7), true);
        eq("A03 更新工具包停住：放弃这次启动", GatewayService.spawnCancelled(false, true, 7, 7), true);
        eq("A03 服务代次变了：放弃这次启动", GatewayService.spawnCancelled(false, false, 7, 8), true);

        // ── BUG-A02：划掉后的空闲查询查完还能不能停 ──
        eq("A02 仍在后台、没被重新拉起：可以停", GatewayService.idleQueryStillValid(false, 3, 3), true);
        eq("A02 查询期间回到前台：不能停", GatewayService.idleQueryStillValid(true, 3, 3), false);
        eq("A02 查询期间收到新的启动请求：不能停", GatewayService.idleQueryStillValid(false, 3, 4), false);

        // ── BUG-A01：过了启动宽限、又连续失联够久才结束重起 ──
        long t0 = 1_000_000L;
        eq("A01 启动宽限内不杀",
            GatewayService.unprovenTooLong(t0 + GatewayService.PROOF_GRACE_MS - 1, t0, t0 + 1000), false);
        eq("A01 刚失联一次不杀",
            GatewayService.unprovenTooLong(t0 + GatewayService.PROOF_GRACE_MS + 1000, t0, t0 + GatewayService.PROOF_GRACE_MS + 1000), false);
        eq("A01 连续失联还不够久不杀",
            GatewayService.unprovenTooLong(t0 + GatewayService.PROOF_GRACE_MS + GatewayService.UNPROVEN_KILL_MS - 1,
                t0, t0 + GatewayService.PROOF_GRACE_MS), false);
        eq("A01 宽限后连续失联够久：结束重起",
            GatewayService.unprovenTooLong(t0 + GatewayService.PROOF_GRACE_MS + GatewayService.UNPROVEN_KILL_MS,
                t0, t0 + GatewayService.PROOF_GRACE_MS), true);
        eq("A01 没有失联记录（身份刚证明过）不杀",
            GatewayService.unprovenTooLong(t0 + 10_000_000, t0, 0), false);

        // ── 独立审查 P2-4：alive() 的连续失联判定 ──
        eq("ALIVE 已证明：继续观察",
            GatewayService.aliveDecision(true, t0 + 10_000_000, t0, 0) == GatewayService.ALIVE_KEEP, true);
        eq("ALIVE 宽限内失联：继续观察",
            GatewayService.aliveDecision(false, t0 + GatewayService.PROOF_GRACE_MS - 1, t0, t0 + 1000)
                == GatewayService.ALIVE_KEEP, true);
        eq("ALIVE 首次失联：记起点",
            GatewayService.aliveDecision(false, t0 + GatewayService.PROOF_GRACE_MS + 1000, t0, 0)
                == GatewayService.ALIVE_ARM, true);
        eq("ALIVE 连续失联还不够久：继续观察",
            GatewayService.aliveDecision(false,
                t0 + GatewayService.PROOF_GRACE_MS + GatewayService.UNPROVEN_KILL_MS - 1,
                t0, t0 + GatewayService.PROOF_GRACE_MS) == GatewayService.ALIVE_KEEP, true);
        eq("ALIVE 连续失联够久：结束重起",
            GatewayService.aliveDecision(false,
                t0 + GatewayService.PROOF_GRACE_MS + GatewayService.UNPROVEN_KILL_MS,
                t0, t0 + GatewayService.PROOF_GRACE_MS) == GatewayService.ALIVE_KILL, true);

        // ── 组件安装报告 §1：安装阶段的心跳放宽「证明不了自己」的时限 ──
        eq("安装 switch / move / recover 阶段算安装中", GatewayService.installingPhase("switch"), true);
        eq("安装 switch / move / recover 阶段算安装中", GatewayService.installingPhase("move"), true);
        eq("安装 启动恢复也算安装中", GatewayService.installingPhase("recover"), true);
        eq("安装 downloading / verifying 不算", GatewayService.installingPhase("downloading"), false);
        eq("安装 空阶段不算", GatewayService.installingPhase(""), false);
        eq("安装 心跳 100 秒前还新鲜", GatewayService.installingFresh(t0 + 100_000, t0), true);
        eq("安装 心跳刚过 120 秒不新鲜",
            GatewayService.installingFresh(t0 + GatewayService.INSTALL_GRACE_MS, t0), false);
        eq("安装 心跳是未来时间不新鲜", GatewayService.installingFresh(t0, t0 + 1), false);
        eq("安装 心跳时间戳为 0 不新鲜", GatewayService.installingFresh(t0, 0), false);

        // ── 复核 P2-9：多份心跳取最新，未来时间戳 / 非安装阶段不能盖住新鲜的 ──
        eql("安装 取最新：更晚的新鲜心跳盖过旧的", GatewayService.beatBetter(t0 + 1000, t0 + 500, t0 + 900, "move"), t0 + 900);
        eql("安装 取最新：旧的不盖新的", GatewayService.beatBetter(t0 + 1000, t0 + 900, t0 + 500, "move"), t0 + 900);
        eql("安装 未来时间戳不参与（时间被回拨过）", GatewayService.beatBetter(t0, t0 - 500, t0 + 100, "move"), t0 - 500);
        eql("安装 非安装阶段的心跳不参与取最新", GatewayService.beatBetter(t0 + 1000, t0 + 500, t0 + 900, "downloading"), t0 + 500);
        // ── 复核 P2-13：备份阶段也算安装中，看门狗分得清「在备份」和「卡在 switch」 ──
        eq("安装 backup 阶段算安装中", GatewayService.installingPhase("backup"), true);

        // ── 复核 P2-14：parseBeatAt 与 installingBeat 文件级（手写解析，桌面 JVM 能跑全链路）──
        eq("安装 parseBeatAt 缺 at 字段返回 null", GatewayService.parseBeatAt("{\"id\":\"x\"}", t0) == null, true);
        eq("安装 parseBeatAt 缺 phase 字段返回 null", GatewayService.parseBeatAt("{\"at\":" + (t0 - 1) + "}", t0) == null, true);
        eq("安装 parseBeatAt 未来 at 不认", GatewayService.parseBeatAt("{\"phase\":\"move\",\"at\":" + (t0 + 1) + "}", t0) == null, true);
        eq("安装 parseBeatAt 下载阶段不认", GatewayService.parseBeatAt("{\"phase\":\"downloading\",\"at\":" + (t0 - 1) + "}", t0) == null, true);
        eq("安装 parseBeatAt 畸形字符串不抛", GatewayService.parseBeatAt("not-json-{", t0) == null, true);
        eq("安装 parseBeatAt 正常", (long) GatewayService.parseBeatAt("{\"phase\":\"move\",\"at\":" + (t0 - 1) + "}", t0) == t0 - 1, true);
        // ── 复核 R2-P2-5 / R2-P3-4：解析容空白，boot 对不上不认 ──
        eq("安装 parseBeatAt 冒号后带空白也认", (long) GatewayService.parseBeatAt("{\"phase\" : \"move\", \"at\" : " + (t0 - 1) + "}", t0) == t0 - 1, true);
        eq("安装 parseBeatAt 换行缩进也认", (long) GatewayService.parseBeatAt("{\n  \"phase\": \"move\",\n  \"at\": " + (t0 - 1) + "\n}", t0) == t0 - 1, true);
        eq("安装 parseBeatAt 冒号前没空白字段不存在", GatewayService.parseBeatAt("{\"phasex\":\"move\",\"at\":" + (t0 - 1) + "}", t0) == null, true);
        eq("安装 parseBeatAt boot 对不上不认（跨重启旧文件）", GatewayService.parseBeatAt("{\"phase\":\"move\",\"at\":" + (t0 - 1) + ",\"boot\":\"wrong-boot\"}", t0) == null, true);
        // ── 复核第三轮 §2：id 恰叫 at/boot/phase 不能误命中字段名 ──
        eq("安装 parseBeatAt id 叫 at 不干扰字段", (long) GatewayService.parseBeatAt("{\"id\":\"at\",\"phase\":\"move\",\"at\":" + (t0 - 1) + "}", t0) == t0 - 1, true);
        eq("安装 parseBeatAt id 叫 boot 不干扰字段", (long) GatewayService.parseBeatAt("{\"id\":\"boot\",\"phase\":\"move\",\"at\":" + (t0 - 1) + "}", t0) == t0 - 1, true);
        eq("安装 parseBeatAt id 叫 phase 不干扰字段", (long) GatewayService.parseBeatAt("{\"id\":\"phase\",\"phase\":\"move\",\"at\":" + (t0 - 1) + "}", t0) == t0 - 1, true);
        String boot = "";
        try { boot = new String(java.nio.file.Files.readAllBytes(java.nio.file.Paths.get("/proc/sys/kernel/random/boot_id")), java.nio.charset.StandardCharsets.UTF_8).trim(); } catch (Exception ignored) {}
        if (!boot.isEmpty()) eq("安装 parseBeatAt boot 匹配认", (long) GatewayService.parseBeatAt("{\"phase\":\"move\",\"at\":" + (t0 - 1) + ",\"boot\":\"" + boot + "\"}", t0) == t0 - 1, true);
        try {
            java.io.File tmp = java.nio.file.Files.createTempDirectory("hb").toFile();
            java.io.File runs = new java.io.File(tmp, "components/.runs");
            if (!runs.mkdirs()) throw new RuntimeException("mkdirs");
            java.nio.charset.Charset utf8 = java.nio.charset.StandardCharsets.UTF_8;
            java.nio.file.Files.write(new java.io.File(runs, "a.installing").toPath(),
                ("{\"id\":\"a\",\"phase\":\"move\",\"moved\":100,\"at\":" + (t0 + 900) + "}").getBytes(utf8));
            java.nio.file.Files.write(new java.io.File(runs, "b.installing").toPath(),
                ("{\"id\":\"b\",\"phase\":\"move\",\"moved\":1,\"at\":" + (t0 + 5000) + "}").getBytes(utf8));   // 未来时间戳
            java.nio.file.Files.write(new java.io.File(runs, "c.installing").toPath(),
                ("{\"id\":\"c\",\"phase\":\"downloading\",\"at\":" + (t0 + 950) + "}").getBytes(utf8));      // 阶段不放行
            StringBuilder big = new StringBuilder("{\"id\":\"d\",\"phase\":\"move\",\"at\":" + t0 + ",\"pad\":\"");
            for (int i = 0; i < 4200; i++) big.append('x');
            java.nio.file.Files.write(new java.io.File(runs, "d.installing").toPath(), big.append("\"}").toString().getBytes(utf8));   // 超 4 KB
            if (!new java.io.File(runs, "e.installing").mkdir()) throw new RuntimeException("mkdir");                                  // 目录
            long[] got = GatewayService.installingBeat(tmp, t0 + 1000);
            eq("安装 installingBeat 只取新鲜 move 心跳、挡掉未来/下载/超大/目录", got != null && got[0] == t0 + 900, true);
        } catch (java.io.IOException e) { throw new RuntimeException(e); }

        // ── 独立审查 P2-4：界面页态决策 ──
        eq("UI 已证明：界面", MainActivity.uiPageDecision(true, false, false) == MainActivity.UI_LOAD, true);
        eq("UI 端口空：界面", MainActivity.uiPageDecision(false, false, false) == MainActivity.UI_LOAD, true);
        eq("UI 端口忙但证明不了：等待页",
            MainActivity.uiPageDecision(false, true, false) == MainActivity.UI_WAIT, true);
        eq("UI 运行库对不上：说明页",
            MainActivity.uiPageDecision(false, true, true) == MainActivity.UI_SQUAT, true);
        eq("UI 运行库对不上优先于证明：说明页",
            MainActivity.uiPageDecision(true, false, true) == MainActivity.UI_SQUAT, true);

        // ── BUG-A05：网关启动号变了才回收旧轮次文本 ──
        eq("A05 同一网关不回收", Notify.gatewayChanged("boot1", "boot1"), false);
        eq("A05 网关换代回收", Notify.gatewayChanged("boot2", "boot1"), true);
        eq("A05 第一次 hello（没有上次启动号）不回收", Notify.gatewayChanged("boot1", ""), false);
        eq("A05 旧网关不带启动号不回收", Notify.gatewayChanged("", "boot1"), false);

        // ── BUG-A04：系统总开关 / 具体渠道关掉时不能报「已发通知」 ──
        eq("A04 应用通知总开关关着：不可用",
            DeviceTools.notifyUsable(false, android.app.NotificationManager.IMPORTANCE_DEFAULT), false);
        eq("A04 agent 渠道被关成 IMPORTANCE_NONE：不可用",
            DeviceTools.notifyUsable(true, android.app.NotificationManager.IMPORTANCE_NONE), false);
        eq("A04 总开关与渠道都开着：可用",
            DeviceTools.notifyUsable(true, android.app.NotificationManager.IMPORTANCE_DEFAULT), true);
        eq("A04 低重要度渠道仍会显示：可用",
            DeviceTools.notifyUsable(true, android.app.NotificationManager.IMPORTANCE_LOW), true);

        if (fail > 0) { System.out.println(fail + " 条失败"); System.exit(1); }
        System.out.println("全部通过");
    }
}
