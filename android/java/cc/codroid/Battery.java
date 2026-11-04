package cc.codroid;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.BatteryManager;
import android.os.PowerManager;
import android.os.SystemClock;
import org.json.JSONObject;

/**
 * 耗电统计的原生那一半：电量、充电状态、电流、亮屏和前台时长。
 * 应用身份读不了 /sys/class/power_supply，也跑不了 dumpsys battery，只有 Java 的 BatteryManager 能拿到。
 * 网关每 5 分钟经 Priv 套接字（op=battery）取一次快照，CPU 时间它自己从 /proc 数。
 * 亮屏 / 前台时长是累计毫秒（本进程起算），网关按差值记账。
 */
final class Battery {
    private static long screenMs, screenSince, fgMs, fgSince;
    private static boolean watching;

    /** GatewayService.onCreate 调：开始数亮屏时长 */
    static synchronized void watch(Context c) {
        if (watching) return;
        watching = true;
        if (c.getSystemService(PowerManager.class).isInteractive()) screenSince = SystemClock.elapsedRealtime();
        IntentFilter f = new IntentFilter(Intent.ACTION_SCREEN_ON);
        f.addAction(Intent.ACTION_SCREEN_OFF);
        c.getApplicationContext().registerReceiver(new BroadcastReceiver() {
            @Override public void onReceive(Context x, Intent i) { screen(Intent.ACTION_SCREEN_ON.equals(i.getAction())); }
        }, f);
    }

    private static synchronized void screen(boolean on) {
        long now = SystemClock.elapsedRealtime();
        if (on) { if (screenSince == 0) screenSince = now; }
        else if (screenSince != 0) { screenMs += now - screenSince; screenSince = 0; }
    }

    /** MainActivity / BrowserActivity 的 onResume / onPause 调；两个界面可能同时在前台（分屏），按个数算 */
    private static int fgCount;
    static synchronized void foreground(boolean on) {
        long now = SystemClock.elapsedRealtime();
        fgCount = Math.max(0, fgCount + (on ? 1 : -1));
        if (fgCount > 0) { if (fgSince == 0) fgSince = now; }
        else if (fgSince != 0) { fgMs += now - fgSince; fgSince = 0; }
    }

    static synchronized JSONObject snapshot(Context c) throws Exception {
        long now = SystemClock.elapsedRealtime();
        Intent b = c.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        BatteryManager bm = c.getSystemService(BatteryManager.class);
        JSONObject o = new JSONObject().put("ok", true)
            .put("screenMs", screenMs + (screenSince != 0 ? now - screenSince : 0))
            .put("fgMs", fgMs + (fgSince != 0 ? now - fgSince : 0))
            .put("screen", c.getSystemService(PowerManager.class).isInteractive());
        if (b != null) {
            int level = b.getIntExtra(BatteryManager.EXTRA_LEVEL, -1), scale = b.getIntExtra(BatteryManager.EXTRA_SCALE, 100);
            int status = b.getIntExtra(BatteryManager.EXTRA_STATUS, 0);
            o.put("level", level >= 0 && scale > 0 ? level * 100.0 / scale : -1)
             .put("plugged", b.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0))
             .put("charging", status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL)
             .put("temp", b.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 0) / 10.0)
             .put("voltage", b.getIntExtra(BatteryManager.EXTRA_VOLTAGE, 0));
        }
        if (bm != null) {
            o.put("currentUa", bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CURRENT_NOW))
             .put("chargeUah", bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CHARGE_COUNTER));
        }
        return o;
    }
}
