package cc.codroid;

/**
 * 开发工具包预下载暂存（devkitStaged）、降级判据与启动期原生确认弹窗回归测试：
 *   1. 升级 APK 抬高 devkitPin 后，旧版预下的 devkitStaged（如 11.21.1 < 11.21.2）必须判为过期丢弃，避免启动卡死死循环；
 *   2. 线上发布更新的 best（如 11.21.2）必须能替换掉本地尚未安装的较旧 ready 暂存包（11.21.1），同版本或更新的暂存则保留；
 *   3. 实际安装与修复判据：同版本修复（repairing=true）及高于真实已装版本的本地安装（10.28 -> 11.21.1）绝不误判为降级；
 *   4. MainActivity 在 booted=false（冷启动 / 替换工具包进度页）期间收到 ACTION_PRIV_OK / ACTION_CONSENT / ACTION_A11Y_OK 必须立即处理防死锁。
 */
public class UpdaterDevkitStagedTest {
    static int fail = 0;

    static void eq(String what, Object got, Object want) {
        boolean ok = got == null ? want == null : got.equals(want);
        if (!ok) fail++;
        System.out.println((ok ? "✓ " : "✗ ") + what + "（得到 " + got + "，期望 " + want + "）");
    }

    public static void main(String[] args) {
        // 1. 线上检查与自动暂存基线 devkitFloorOf = max(已装, APK钉子)
        eq("基线：已装 10.28 + 钉子 11.21.2 取 11.21.2",
            Updater.devkitFloorOf("devkit-2026.10.28", "devkit-2026.11.21.2"), "devkit-2026.11.21.2");
        eq("基线：已装 12.01 + 钉子 11.21.2 取 12.01",
            Updater.devkitFloorOf("devkit-2026.12.01", "devkit-2026.11.21.2"), "devkit-2026.12.01");
        eq("基线：已装未知 + 钉子 11.21.2 取 11.21.2",
            Updater.devkitFloorOf("", "devkit-2026.11.21.2"), "devkit-2026.11.21.2");

        // 2. 暂存包过期判定 stagedDevkitOutdated（群友复现场景：已装 10.28、预下 11.21.1、升 APK 钉子变 11.21.2）
        String floor = Updater.devkitFloorOf("devkit-2026.10.28", "devkit-2026.11.21.2");
        eq("暂存 11.21.1 比新 APK 基线 11.21.2 旧：判过期丢弃",
            Updater.stagedDevkitOutdated("devkit-2026.11.21.1", floor), true);
        eq("暂存 11.21.2 等于新 APK 基线 11.21.2：不过期，保留待装",
            Updater.stagedDevkitOutdated("devkit-2026.11.21.2", floor), false);
        eq("暂存 12.01 高于基线 11.21.2：不过期，保留待装",
            Updater.stagedDevkitOutdated("devkit-2026.12.01", floor), false);
        eq("暂存标签损坏或为空：判过期丢弃",
            Updater.stagedDevkitOutdated("", floor), true);

        // 3. checkDevkit 面对既有 ready 暂存包的保留/覆盖判断 stagedKeepsOver
        eq("暂存 11.21.1 遇到线上 11.21.2：不挡住，允许覆盖为新版计划",
            Updater.stagedKeepsOver("devkit-2026.11.21.1", "devkit-2026.11.21.2"), false);
        eq("暂存 11.21.2 遇到线上 11.21.2：已是最新暂存，继续保留",
            Updater.stagedKeepsOver("devkit-2026.11.21.2", "devkit-2026.11.21.2"), true);
        eq("暂存 12.01 遇到线上 11.21.2：暂存更新，继续保留",
            Updater.stagedKeepsOver("devkit-2026.12.01", "devkit-2026.11.21.2"), true);

        // 4. 实际安装与修复降级判据 downgradeFloorForInstall
        eq("修复：已装 10.28 < 钉子 11.21.2 时重装同版 10.28 不算降级",
            Updater.downgradeFloorForInstall("devkit-2026.10.28", "devkit-2026.10.28", "devkit-2026.11.21.2", true), null);
        eq("本地升级：已装 10.28 时手动装 11.21.1（虽低于钉子 11.21.2）是升级不算降级",
            Updater.downgradeFloorForInstall("devkit-2026.11.21.1", "devkit-2026.10.28", "devkit-2026.11.21.2", false), null);
        eq("真实降级：已装 10.28 时装 09.15 必须返回真实已装版本 10.28 弹确认",
            Updater.downgradeFloorForInstall("devkit-2026.09.15", "devkit-2026.10.28", "devkit-2026.11.21.2", false), "devkit-2026.10.28");
        eq("未知已装版本时装比钉子旧的 10.28：以钉子 11.21.2 兜底确认",
            Updater.downgradeFloorForInstall("devkit-2026.10.28", "", "devkit-2026.11.21.2", false), "devkit-2026.11.21.2");
        eq("未知已装版本时修复钉子同版 11.21.2：不算降级",
            Updater.downgradeFloorForInstall("devkit-2026.11.21.2", "", "devkit-2026.11.21.2", true), null);
        eq("未识别出自制包 tag（空串）：交由自制包风险确认处理，不走降级分支",
            Updater.downgradeFloorForInstall("", "devkit-2026.10.28", "devkit-2026.11.21.2", false), null);

        // 5. booted=false 期间必须即时放行的原生确认 Intent，防止 Priv.confirm 60 秒自锁
        eq("booted=false 期间 ACTION_PRIV_OK 立即处理",
            MainActivity.immediateWhileBooting(MainActivity.ACTION_PRIV_OK), true);
        eq("booted=false 期间 ACTION_CONSENT 立即处理",
            MainActivity.immediateWhileBooting(MainActivity.ACTION_CONSENT), true);
        eq("booted=false 期间 ACTION_A11Y_OK 立即处理",
            MainActivity.immediateWhileBooting(MainActivity.ACTION_A11Y_OK), true);
        eq("booted=false 期间 ACTION_APPLY_DEVKIT 仍排队等启动完成",
            MainActivity.immediateWhileBooting(MainActivity.ACTION_APPLY_DEVKIT), false);
        eq("booted=false 期间 ACTION_UPDATE 仍排队等启动完成",
            MainActivity.immediateWhileBooting(MainActivity.ACTION_UPDATE), false);
        eq("booted=false 期间 null action 不即时处理",
            MainActivity.immediateWhileBooting(null), false);

        if (fail > 0) {
            System.err.println("UpdaterDevkitStagedTest FAILED: " + fail);
            System.exit(1);
        }
        System.out.println("UpdaterDevkitStagedTest: all passed");
    }
}
