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
