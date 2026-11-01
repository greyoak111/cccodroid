package cc.codroid;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.hardware.display.DisplayManager;
import android.provider.Settings;
import android.view.Display;
import android.view.Window;
import android.view.WindowManager;

import java.util.TreeSet;

/**
 * 应用内刷新率（核心逻辑，无界面）。
 *
 * 普通应用想让系统提刷新率，是把窗口的 preferredRefreshRate 投上去。小米 / 红米（HyperOS）
 * 把 cccodroid 认成「游戏」之后（云端按包名判定，设置 → 刷新率里显示为「跟随应用内设置」），
 * DisplayModeDirector 会忽略窗口投票（mIgnorePreferredRefreshRate: true）；游戏自己的帧率
 * 走的是 Joyose → PowerKeeper 的 com.xiaomi.joyose.OVERRIDE_GAME_FRESHRATE 广播。
 * 所以这里两条都发：别的系统没有这个接收器，多一条广播无害。
 *
 * 取的都是系统里用户选的刷新率（跟随系统），不提供应用内开关。
 */
final class FrameRate {
    private static final String ACTION_MIUI_GAME_FPS = "com.xiaomi.joyose.OVERRIDE_GAME_FRESHRATE";

    private FrameRate() {}

    /** 回到前台 / 心跳时调：窗口投票 + （小米上）给 PowerKeeper 报应用自己的帧率 */
    static void apply(Activity a) {
        int rate = target(a);
        Window w = a.getWindow();
        WindowManager.LayoutParams lp = w.getAttributes();
        if (lp.preferredRefreshRate != rate) {
            lp.preferredRefreshRate = rate;
            try { w.setAttributes(lp); } catch (Throwable ignored) {}
        }
        Intent i = new Intent(ACTION_MIUI_GAME_FPS).setPackage("com.miui.powerkeeper");
        i.putExtra("override_pkg_name", a.getPackageName());
        i.putExtra("override_freshrate", rate);
        try { a.sendBroadcast(i); } catch (Throwable ignored) {}
    }

    /** 实际要的刷新率：系统里设的刷新率，按屏幕支持的模式取最接近的 */
    static int target(Context c) {
        return nearest(c, systemRate(c));
    }

    /** 系统设置里的刷新率（小米写 user_refresh_rate；没有就看 peak_refresh_rate；再没有用屏幕最高档） */
    static int systemRate(Context c) {
        int v = readRate(c, "user_refresh_rate");
        if (v <= 0) v = readRate(c, "peak_refresh_rate");
        if (v > 0) return v;
        int[] m = modes(c);
        return m.length > 0 ? m[m.length - 1] : 60;
    }

    private static int readRate(Context c, String key) {
        try {
            String s = Settings.System.getString(c.getContentResolver(), key);
            if (s == null || s.isEmpty()) return 0;
            return Math.round(Float.parseFloat(s));
        } catch (Throwable t) {
            return 0;
        }
    }

    /** 屏幕支持的刷新率，升序去重 */
    static int[] modes(Context c) {
        TreeSet<Integer> set = new TreeSet<>();
        try {
            DisplayManager dm = (DisplayManager) c.getSystemService(Context.DISPLAY_SERVICE);
            Display d = dm == null ? null : dm.getDisplay(Display.DEFAULT_DISPLAY);
            if (d != null) {
                for (Display.Mode m : d.getSupportedModes()) {
                    int r = Math.round(m.getRefreshRate());
                    if (r > 0) set.add(r);
                }
            }
        } catch (Throwable ignored) {}
        int[] out = new int[set.size()];
        int n = 0;
        for (int r : set) out[n++] = r;
        return out;
    }

    static int nearest(Context c, int want) {
        int[] m = modes(c);
        if (m.length == 0) return want > 0 ? want : 60;
        int best = m[0];
        for (int r : m) if (Math.abs(r - want) < Math.abs(best - want)) best = r;
        return best;
    }
}
