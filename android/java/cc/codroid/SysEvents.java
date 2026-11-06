package cc.codroid;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * 系统广播（导出，只认这两个动作）：
 *   MY_PACKAGE_REPLACED  自更新装完 → 把后台服务拉起来（系统替换时把我们整个杀了）
 *   BOOT_COMPLETED       开机 → 仅当用户开着"开机自动激活 Shizuku"且配对过，才启动服务去重新激活
 */
public class SysEvents extends BroadcastReceiver {
    /**
     * 更新前界面开着（Updater 记的 reopenAt，10 分钟内有效）就把界面拉回来。
     * 广播里直接 startActivity 在安卓 10+ 多半被「后台启动界面」限制拦掉，所以先试一下，再等 Shizuku 的 binder
     * （本进程刚被拉起，binder 一两秒内到）用 shell 身份 am start，shell 不受这条限制。都不行就发条通知点开。
     * Shizuku 静默装那条路由 Priv.pipeInstall 里的 shell 自己拉界面，不记 reopenAt，不走这里。
     */
    private void reopenUi(Context c) {
        android.content.SharedPreferences sp = c.getSharedPreferences("upd", Context.MODE_PRIVATE);
        long at = sp.getLong("reopenAt", 0);
        if (at == 0) return;
        sp.edit().remove("reopenAt").apply();
        if (System.currentTimeMillis() - at > 10 * 60_000) return;
        Intent ui = new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try { c.startActivity(ui); } catch (Throwable ignored) {}
        PendingResult pr = goAsync();
        Priv.start(c);
        new Thread(() -> {
            try {
                for (int i = 0; i < 16 && !MainActivity.visible; i++) {
                    Thread.sleep(500);
                    if (i >= 2 && Priv.granted()) { Priv.run("am start -n " + c.getPackageName() + "/.MainActivity"); Thread.sleep(1500); break; }
                }
                if (!MainActivity.visible) Notify.updatedTapToOpen(c);
            } catch (Throwable ignored) {
            } finally { pr.finish(); }
        }, "reopen-ui").start();
    }

    @Override public void onReceive(Context c, Intent i) {
        Tr.init(c);   // 开机广播先到：不初始化会把语言缓存成系统语言，后面整个进程都改不回来（0.6.6 报告 #6）
        String a = i.getAction();
        if (Intent.ACTION_MY_PACKAGE_REPLACED.equals(a)) {
            Installer.deleteTree(new java.io.File(c.getFilesDir(), "updates"));
            // 装完了：待装记录和安装包一起作废（Updater 下次启动也不会再拿它去装一遍）
            c.getSharedPreferences("upd", Context.MODE_PRIVATE).edit().remove("appStaged").apply();
            if (new Env(c).devkitReady()) GatewayService.start(c);
            reopenUi(c);
        } else if (Intent.ACTION_BOOT_COMPLETED.equals(a)) {
            // 系统重启会清空 AlarmManager 里的登记：定时任务和 Shizuku 自动激活是两件事，
            // 没配 Shizuku 的用户也要按 home/ccapp-sched-next 把闹钟重新定上（#123-3）
            SchedAlarm.fromFile(c);
            ShizukuSetup s = ShizukuSetup.get(c);
            s.prefs().edit().putLong("bootSeen", System.currentTimeMillis()).apply();
            if (s.autostart() && s.prefs().getBoolean("paired", false) && s.hasWss() && new Env(c).devkitReady())
                // 有的 ROM 开机时不让起前台服务（ForegroundServiceStartNotAllowedException）：别让广播接收器崩掉
                try { c.startForegroundService(new Intent(c, GatewayService.class).setAction(GatewayService.ACTION_BOOT).putExtra(MainActivity.IK, MainActivity.intentKey(c))); }
                catch (RuntimeException e) { android.util.Log.w("cccodroid", "开机起网关被拒：" + e); }
        } else if (android.app.AlarmManager.ACTION_SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED.equals(a)) {
            // 用户刚授权/撤销「闹钟和提醒」：重新登记，别让已有任务停在旧的精确/非精确状态（审查 11-05）
            SchedAlarm.reschedule(c);
        }
    }
}
