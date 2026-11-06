package cc.codroid;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;
import java.io.File;
import java.net.HttpURLConnection;
import java.nio.file.Files;

/**
 * 定时任务的系统闹钟。网关只在自己活着时准点（每 30 秒查一次）；应用被系统杀掉、或机器深睡时会错过。
 * 网关把最近一次要跑的时刻报过来（事件 sched_next，启动时读 home/ccapp-sched-next），这里定一个
 * setExactAndAllowWhileIdle 闹钟：到点拉起网关服务，再调 /api/sched/tick 让它立刻查一遍。
 * targetSdk 28：安卓 12 起的「精确闹钟要授权」「后台不许启动前台服务」都不约束我们，不用引导用户去开。
 * targetSdk 36 的包：没给精确闹钟时退回非精确闹钟，但非精确闹钟响了不许从后台起前台服务，网关拉不起来、任务被跳过，
 * 所以第一次碰上就发一条通知，点了去系统设置里给（11-04 报告 A8）。
 */
public class SchedAlarm extends BroadcastReceiver {
    static final String TAG = "cccodroid";
    static final String ACTION = "cc.codroid.SCHED_ALARM";
    private static long lastAt = -1;

    private static PendingIntent pi(Context c) {
        Intent i = new Intent(c, SchedAlarm.class).setAction(ACTION);
        return PendingIntent.getBroadcast(c, 70, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    /** at：毫秒时间戳，0 = 没有要跑的，取消闹钟 */
    static synchronized void set(Context c, long at) {
        if (at == lastAt) return;
        AlarmManager am = c.getSystemService(AlarmManager.class);
        if (am == null) return;
        PendingIntent p = pi(c);
        if (at <= 0) {
            try { am.cancel(p); lastAt = at; Log.i(TAG, "定时任务闹钟：已取消"); }
            catch (Exception e) { lastAt = -1; Log.w(TAG, "定时任务闹钟取消失败", e); }
            return;
        }
        try {
            boolean exact = Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms();
            if (exact) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, p);
            else { am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, p); askExact(c); }
            lastAt = at;   // 登记成功后才记账：一次异常后同一时刻还能重试（审查 11-05）
            Log.i(TAG, "定时任务闹钟：" + new java.util.Date(at) + (exact ? "（精确）" : "（非精确）"));
        } catch (Exception e) {
            lastAt = -1;
            Log.w(TAG, "定时任务闹钟设置失败", e);
        }
    }

    /** 精确闹钟授权/撤销后重新登记：系统会把已经登记的精确闹钟取消掉，光等下次 nextAt 变化任务就漏了 */
    static synchronized void reschedule(Context c) { lastAt = -1; fromFile(c); }

    /** 只问一次：发通知，点了去「闹钟和提醒」里给本应用开 */
    private static void askExact(Context c) {
        if (Build.VERSION.SDK_INT < 31 || c.getApplicationInfo().targetSdkVersion < 31) return;
        android.content.SharedPreferences sp = c.getSharedPreferences("ui", Context.MODE_PRIVATE);
        if (sp.getBoolean("exactAsked", false)) return;
        sp.edit().putBoolean("exactAsked", true).apply();
        try {
            Notify.get(c);   // 建好「等你确认」渠道
            Intent go = new Intent(android.provider.Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, android.net.Uri.parse("package:" + c.getPackageName()));
            PendingIntent tap = PendingIntent.getActivity(c, 71, go, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            String text = Tr.t("应用不在前台时，定时任务要「闹钟和提醒」权限才能准时拉起。点此去开");
            c.getSystemService(android.app.NotificationManager.class).notify(71, new android.app.Notification.Builder(c, Notify.CH_ASK)
                .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
                .setContentTitle(Tr.t("定时任务需要闹钟权限"))
                .setContentText(text).setStyle(new android.app.Notification.BigTextStyle().bigText(text))
                .setContentIntent(tap).setAutoCancel(true).build());
        } catch (Exception e) { Log.w(TAG, "精确闹钟引导发不出去", e); }
    }

    /** 网关写的 home/ccapp-sched-next（服务启动、事件流重连时补一次，免得漏掉事件） */
    static void fromFile(Context c) {
        try {
            File f = new File(new Env(c).home, "ccapp-sched-next");
            if (!f.exists()) return;
            set(c, Long.parseLong(new String(Files.readAllBytes(f.toPath()), "UTF-8").trim()));
        } catch (Exception e) {
            Log.w(TAG, "定时任务闹钟：读文件失败", e);
        }
    }

    @Override public void onReceive(Context c, Intent i) {
        if (!ACTION.equals(i.getAction())) return;
        Log.i(TAG, "定时任务闹钟响了");
        synchronized (SchedAlarm.class) { lastAt = -1; }   // 已经响过，下次报来的同一时刻也要重新定
        try { GatewayService.start(c); } catch (Exception e) { Log.w(TAG, "定时任务闹钟：拉起服务失败", e); }
        // 挂住广播（后台广播最多约 60 秒）：等网关能接请求了让它立刻查一遍；网关刚启动的话它 5 秒后也会自己查
        PendingResult pr = goAsync();
        new Thread(() -> {
            try {
                for (int n = 0; n < 20; n++) {
                    try {
                        HttpURLConnection h = Env.gateway("POST", "/api/sched/tick", null);
                        h.setConnectTimeout(2000); h.setReadTimeout(5000);
                        int code = h.getResponseCode();
                        h.disconnect();
                        if (code == 200) { Log.i(TAG, "定时任务闹钟：网关已查过"); return; }
                    } catch (Exception ignored) {}
                    try { Thread.sleep(2500); } catch (InterruptedException e) { return; }
                }
            } finally { pr.finish(); }
        }, "sched-alarm").start();
    }
}
