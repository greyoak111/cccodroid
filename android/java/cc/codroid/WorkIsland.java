package cc.codroid;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.drawable.Icon;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.Log;
import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONObject;

/**
 * 内置工作岛（全厂商通用，无需伴侣应用与厂商私有白名单）：
 *   1. Android 16+（API >= 36）：标准 Live Updates（Notification.ProgressStyle +
 *      setRequestPromotedOngoing + setShortCriticalText），直接接入荣耀 MagicOS 灵动胶囊、
 *      OPPO/一加 ColorOS 流体云、小米 HyperOS 3+ 超级岛、Pixel / OneUI 等系统原生实况通知；
 *   2. 可选悬浮胶囊兜底（WorkIslandOverlay，默认关闭）：供 Android 12–15 或系统未放行推广的机型使用；
 *   3. 普通同卡进度通知兜底：零额外权限，点击直达对应会话，任务结束自动收起。
 *
 * 为兼容现有 compileSdk 35（android-35）构建链路，API 36+ 新增方法经由轻量反射调用。
 */
final class WorkIsland {
    static final String TAG = "cccodroid";
    static final String CH_ISLAND = "work_island";
    private static final String TAG_ISLAND = "work_island";
    private static final int ID_ISLAND = 81;
    private static final String EXTRA_PROMOTED = "android.requestPromotedOngoing";
    private static final String ACTION_PROMO_SETTINGS = "android.settings.APP_NOTIFICATION_PROMOTION_SETTINGS";

    static final int COLOR_WORKING = 0xFFD97757;
    static final int COLOR_WAITING = 0xFFE59F3D;
    static final int COLOR_DONE = 0xFF3DA36D;
    static final int COLOR_ERROR = 0xFFD9534F;

    private final Context ctx;
    private final NotificationManager nm;
    private final SharedPreferences sp;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final WorkIslandOverlay overlay;

    private int previewGen;
    private volatile boolean previewActive;
    private volatile boolean lastPromotable;
    private volatile boolean foreground;
    private JSONObject lastFrame;
    private PendingIntent lastOpen;

    WorkIsland(Context c, NotificationManager nm, SharedPreferences sp) {
        this.ctx = c.getApplicationContext();
        this.nm = nm;
        this.sp = sp;
        this.overlay = new WorkIslandOverlay(this.ctx);
        ensureChannel();
    }

    private void ensureChannel() {
        // IMPORTANCE_DEFAULT + 无声无振：满足 Android 16+ Live Updates 对渠道重要度的要求，同时保持安静不弹横幅
        NotificationChannel ch = new NotificationChannel(CH_ISLAND, Tr.t("工作岛（实时状态）"),
            NotificationManager.IMPORTANCE_DEFAULT);
        ch.setDescription(Tr.t("实时显示 Claude 正在执行的操作、清单进度和待确认状态"));
        ch.setSound(null, null);
        ch.enableVibration(false);
        ch.setShowBadge(false);
        nm.createNotificationChannel(ch);
    }

    boolean systemIslandOn() { return sp.getBoolean("island_sys", true); }
    boolean overlayOn() { return sp.getBoolean("island_overlay", false); }
    float overlayY() { return clamp(sp.getFloat("island_overlay_y", 0.02f), 0f, 0.8f); }
    float overlayOpacity() { return clamp(sp.getFloat("island_overlay_opacity", 0.78f), 0.4f, 0.8f); }

    boolean canPostPromoted() { return LiveUpdatesApi.canPostPromoted(nm); }
    boolean canDrawOverlays() {
        try { return Settings.canDrawOverlays(ctx); } catch (RuntimeException e) { return false; }
    }

    JSONObject status() throws Exception {
        NotificationChannel ch = nm.getNotificationChannel(CH_ISLAND);
        return new JSONObject()
            .put("ok", true)
            .put("builtin", true)
            .put("sdk", Build.VERSION.SDK_INT)
            .put("systemSupported", Build.VERSION.SDK_INT >= 36)
            .put("canPostPromoted", canPostPromoted())
            .put("lastPromotable", lastPromotable)
            .put("notifEnabled", nm.areNotificationsEnabled())
            .put("chEnabled", ch == null || ch.getImportance() != NotificationManager.IMPORTANCE_NONE)
            .put("systemIsland", systemIslandOn())
            .put("overlay", overlayOn())
            .put("canDrawOverlays", canDrawOverlays())
            .put("overlayY", overlayY())
            .put("overlayOpacity", overlayOpacity());
    }

    synchronized void set(JSONObject req) {
        SharedPreferences.Editor e = sp.edit();
        if (req.has("systemIsland")) e.putBoolean("island_sys", req.optBoolean("systemIsland", true));
        if (req.has("overlay")) e.putBoolean("island_overlay", req.optBoolean("overlay", false));
        if (req.has("overlayY")) e.putFloat("island_overlay_y", clamp((float) req.optDouble("overlayY", 0.02), 0f, 0.8f));
        if (req.has("overlayOpacity")) e.putFloat("island_overlay_opacity", clamp((float) req.optDouble("overlayOpacity", 0.78), 0.4f, 0.8f));
        e.apply();
        overlay.setStyle(overlayY(), overlayOpacity());
        if (!overlayOn() || !canDrawOverlays()) overlay.hide();
        else if (lastFrame != null) renderFrame(lastFrame, lastOpen, false);
    }

    void openPromoSettings() {
        Intent i = new Intent(ACTION_PROMO_SETTINGS)
            .putExtra(Settings.EXTRA_APP_PACKAGE, ctx.getPackageName())
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            ctx.startActivity(i);
        } catch (RuntimeException e) {
            try {
                ctx.startActivity(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, ctx.getPackageName())
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            } catch (RuntimeException ignored) {}
        }
    }

    void openOverlaySettings() {
        Intent i = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
            Uri.parse("package:" + ctx.getPackageName()))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            ctx.startActivity(i);
        } catch (RuntimeException e) {
            try {
                ctx.startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.parse("package:" + ctx.getPackageName()))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            } catch (RuntimeException ignored) {}
        }
    }

    synchronized void setForeground(boolean fg) {
        this.foreground = fg;
        overlay.setForeground(fg);
    }

    synchronized void render(JSONObject frame, PendingIntent open) {
        // 真实任务到来时中止试播
        previewGen++;
        previewActive = false;
        renderFrame(frame, open, false);
    }

    synchronized void cancel() {
        previewGen++;
        previewActive = false;
        lastFrame = null;
        lastOpen = null;
        nm.cancel(TAG_ISLAND, ID_ISLAND);
        overlay.hide();
    }

    /** 试播 10 秒：无需发起真实对话，立即在系统岛 / 悬浮胶囊上验证效果 */
    synchronized JSONObject preview(PendingIntent open) throws Exception {
        final int gen = ++previewGen;
        previewActive = true;
        final long since = System.currentTimeMillis();
        renderFrame(previewFrame("UPDATE", Tr.t("思考中"), Tr.t("正在想…"), since, "thinking", 0, 0), open, true);
        main.postDelayed(() -> stepPreview(gen, previewFrame("UPDATE", Tr.t("读文件"), Tr.t("清单 1/3"), since, "reading", 1, 3), open), 3000);
        main.postDelayed(() -> stepPreview(gen, previewFrame("UPDATE", Tr.t("写回复"), Tr.t("清单 2/3"), since, "writing", 2, 3), open), 6000);
        main.postDelayed(() -> stepPreview(gen, previewFrame("DONE", Tr.t("任务完成"), Tr.t("用时 8 秒"), 0, "done", 3, 3), open), 8500);
        main.postDelayed(() -> {
            synchronized (WorkIsland.this) {
                if (gen != previewGen) return;
                previewActive = false;
                if (lastFrame == null) {
                    nm.cancel(TAG_ISLAND, ID_ISLAND);
                    overlay.setForeground(foreground);
                    overlay.hide();
                } else {
                    renderFrame(lastFrame, lastOpen, false);
                }
            }
        }, 11500);
        return status().put("preview", true);
    }

    private synchronized void stepPreview(int gen, JSONObject frame, PendingIntent open) {
        if (gen != previewGen || !previewActive) return;
        renderFrame(frame, open, true);
    }

    private static JSONObject previewFrame(String action, String title, String text, long since, String state, int done, int total) {
        JSONObject o = new JSONObject();
        try {
            o.put("action", action).put("title", title).put("text", text)
                .put("since", since).put("state", state)
                .put("todoDone", done).put("todoTotal", total);
        } catch (Exception ignored) {}
        return o;
    }

    private void renderFrame(JSONObject frame, PendingIntent open, boolean isPreview) {
        if (frame == null) {
            if (!isPreview) { lastFrame = null; lastOpen = null; }
            nm.cancel(TAG_ISLAND, ID_ISLAND);
            overlay.hide();
            return;
        }
        String action = frame.optString("action");
        if ("IDLE".equals(action) || action.isEmpty()) {
            if (!isPreview) { lastFrame = null; lastOpen = null; }
            nm.cancel(TAG_ISLAND, ID_ISLAND);
            overlay.hide();
            return;
        }
        if (!isPreview) { lastFrame = frame; lastOpen = open; }
        boolean done = "DONE".equals(action);
        String state = frame.optString("state", done ? "done" : "working");
        String title = clip(frame.optString("title", done ? Tr.t("任务完成") : Tr.t("正在干活")), 40);
        String text = clip(frame.optString("text", ""), 80);
        long since = frame.optLong("since", 0L);
        int todoDone = Math.max(0, frame.optInt("todoDone", 0));
        int todoTotal = Math.max(0, frame.optInt("todoTotal", 0));
        if (todoTotal > 0 && todoDone > todoTotal) todoDone = todoTotal;

        Notification n = buildNotification(title, text, since, done, state, todoDone, todoTotal, open);
        lastPromotable = LiveUpdatesApi.hasPromotable(n);
        nm.notify(TAG_ISLAND, ID_ISLAND, n);

        if (overlayOn() && canDrawOverlays()) {
            overlay.setStyle(overlayY(), overlayOpacity());
            overlay.setForeground(!isPreview && foreground);
            overlay.update(title, text, since, done, state, statusColor(state), todoDone, todoTotal);
        } else {
            overlay.hide();
        }
    }

    private Notification buildNotification(String title, String text, long since, boolean done,
                                           String state, int todoDone, int todoTotal, PendingIntent open) {
        ensureChannel();
        int color = statusColor(state);
        String chip = shortChip(title, todoDone, todoTotal, done);
        String displayTitle = (!done && todoTotal > 0 && !title.contains(todoDone + "/" + todoTotal))
            ? title + " · " + todoDone + "/" + todoTotal : title;

        Notification.Builder b = new Notification.Builder(ctx, CH_ISLAND)
            .setSmallIcon(done
                ? iconRes(ctx, "ic_work_done", android.R.drawable.stat_sys_download_done)
                : iconRes(ctx, "ic_work_island", android.R.drawable.stat_notify_chat))
            .setContentTitle(displayTitle)
            .setContentText(text.isEmpty() ? displayTitle : text)
            .setColor(color)
            .setCategory(Notification.CATEGORY_PROGRESS)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setTimeoutAfter(done ? 8000L : 30 * 60_000L)
            .setShowWhen(true)
            .setWhen(since > 0 ? since : System.currentTimeMillis())
            .setUsesChronometer(!done && since > 0);
        if (open != null) b.setContentIntent(open);

        boolean promotedRequested = Build.VERSION.SDK_INT >= 36 && systemIslandOn();
        boolean styled = false;
        if (promotedRequested) {
            styled = LiveUpdatesApi.applyProgressStyle(ctx, b, done, todoDone, todoTotal, color);
            LiveUpdatesApi.applyPromoted(b, chip);
        }
        if (!styled) {
            if (done) b.setProgress(0, 0, false);
            else if (todoTotal > 0) b.setProgress(todoTotal, todoDone, false);
            else b.setProgress(0, 0, true);
        }
        return b.build();
    }

    /** 按名字查应用内 drawable 资源（避免在独立 javac 单测里强依赖 R.java），缺失时回退系统图标 */
    static int iconRes(Context ctx, String name, int fallback) {
        if (ctx != null) {
            try {
                int id = ctx.getResources().getIdentifier(name, "drawable", ctx.getPackageName());
                if (id != 0) return id;
            } catch (RuntimeException ignored) {}
        }
        return fallback;
    }

    /** 胶囊折叠态短标签（Android 16+ shortCriticalText，控制在简洁长度内） */
    static String shortChip(String title, int todoDone, int todoTotal, boolean done) {
        String base = title == null ? "" : title.trim();
        if (base.isEmpty()) base = done ? "Done" : "Working";
        String progress = (!done && todoTotal > 0) ? (" " + Math.min(todoDone, todoTotal) + "/" + todoTotal) : "";
        if (!progress.isEmpty() && !base.contains(progress.trim())) base = base + progress;
        return base.length() <= 16 ? base : base.substring(0, 15) + "…";
    }

    static int statusColor(String state) {
        if ("waiting".equals(state)) return COLOR_WAITING;
        if ("done".equals(state)) return COLOR_DONE;
        if ("error".equals(state)) return COLOR_ERROR;
        return COLOR_WORKING;
    }

    private static float clamp(float v, float lo, float hi) {
        if (Float.isNaN(v) || Float.isInfinite(v)) return lo;
        return Math.max(lo, Math.min(hi, v));
    }

    private static String clip(String s, int n) {
        if (s == null) return "";
        s = s.trim();
        return s.length() <= n ? s : s.substring(0, n - 1) + "…";
    }

    /**
     * Android 16+（API 36+）Live Updates 标准接口反射封装：
     * 保持 compileSdk 35 可直接编译，同时在 Android 16/17 真机上完整调用标准 ProgressStyle 与推广 API。
     */
    static final class LiveUpdatesApi {
        private static final Class<?> CLS_PROGRESS_STYLE;
        private static final Class<?> CLS_SEGMENT;
        private static final Constructor<?> CTOR_STYLE;
        private static final Constructor<?> CTOR_SEGMENT;
        private static final Method M_SET_TRACKER;
        private static final Method M_SET_END_ICON;
        private static final Method M_SET_STYLED;
        private static final Method M_SET_SEGMENTS;
        private static final Method M_SET_PROGRESS;
        private static final Method M_SET_INDETERMINATE;
        private static final Method M_SEG_SET_COLOR;
        private static final Method M_SHORT_TEXT;
        private static final Method M_REQ_PROMOTED;
        private static final Method M_CAN_POST;
        private static final Method M_HAS_PROMOTABLE;

        static {
            Class<?> cStyle = null, cSeg = null;
            Constructor<?> ctStyle = null, ctSeg = null;
            Method mTracker = null, mEnd = null, mStyled = null, mSegs = null, mProg = null, mIndet = null;
            Method mSegColor = null, mShort = null, mReq = null, mCan = null, mHas = null;
            if (Build.VERSION.SDK_INT >= 36) {
                try {
                    cStyle = Class.forName("android.app.Notification$ProgressStyle");
                    cSeg = Class.forName("android.app.Notification$ProgressStyle$Segment");
                    ctStyle = cStyle.getConstructor();
                    ctSeg = cSeg.getConstructor(int.class);
                    mTracker = cStyle.getMethod("setProgressTrackerIcon", Icon.class);
                    mEnd = cStyle.getMethod("setProgressEndIcon", Icon.class);
                    mStyled = cStyle.getMethod("setStyledByProgress", boolean.class);
                    mSegs = cStyle.getMethod("setProgressSegments", List.class);
                    mProg = cStyle.getMethod("setProgress", int.class);
                    mIndet = cStyle.getMethod("setProgressIndeterminate", boolean.class);
                    mSegColor = cSeg.getMethod("setColor", int.class);
                } catch (Throwable t) {
                    Log.w(TAG, "ProgressStyle reflect init failed: " + t.getMessage());
                    cStyle = null;
                }
                try { mShort = Notification.Builder.class.getMethod("setShortCriticalText", String.class); }
                catch (Throwable ignored) {
                    try { mShort = Notification.Builder.class.getMethod("setShortCriticalText", CharSequence.class); } catch (Throwable ignored2) {}
                }
                try { mReq = Notification.Builder.class.getMethod("setRequestPromotedOngoing", boolean.class); } catch (Throwable ignored) {}
                try { mCan = NotificationManager.class.getMethod("canPostPromotedNotifications"); } catch (Throwable ignored) {}
                try { mHas = Notification.class.getMethod("hasPromotableCharacteristics"); } catch (Throwable ignored) {}
            }
            CLS_PROGRESS_STYLE = cStyle;
            CLS_SEGMENT = cSeg;
            CTOR_STYLE = ctStyle;
            CTOR_SEGMENT = ctSeg;
            M_SET_TRACKER = mTracker;
            M_SET_END_ICON = mEnd;
            M_SET_STYLED = mStyled;
            M_SET_SEGMENTS = mSegs;
            M_SET_PROGRESS = mProg;
            M_SET_INDETERMINATE = mIndet;
            M_SEG_SET_COLOR = mSegColor;
            M_SHORT_TEXT = mShort;
            M_REQ_PROMOTED = mReq;
            M_CAN_POST = mCan;
            M_HAS_PROMOTABLE = mHas;
        }

        static boolean canPostPromoted(NotificationManager nm) {
            if (M_CAN_POST == null || nm == null) return false;
            try { return Boolean.TRUE.equals(M_CAN_POST.invoke(nm)); } catch (Throwable ignored) { return false; }
        }

        static boolean hasPromotable(Notification n) {
            if (M_HAS_PROMOTABLE == null || n == null) return false;
            try { return Boolean.TRUE.equals(M_HAS_PROMOTABLE.invoke(n)); } catch (Throwable ignored) { return false; }
        }

        static boolean applyProgressStyle(Context ctx, Notification.Builder b, boolean done, int todoDone, int todoTotal, int color) {
            if (CLS_PROGRESS_STYLE == null || CTOR_STYLE == null) return false;
            try {
                Object style = CTOR_STYLE.newInstance();
                M_SET_TRACKER.invoke(style, Icon.createWithResource(ctx, iconRes(ctx, "ic_work_island", android.R.drawable.stat_notify_chat)));
                M_SET_STYLED.invoke(style, true);
                if (done) {
                    int max = todoTotal > 0 ? todoTotal : 100;
                    List<Object> segs = new ArrayList<>(1);
                    Object seg = CTOR_SEGMENT.newInstance(max);
                    M_SEG_SET_COLOR.invoke(seg, color);
                    segs.add(seg);
                    M_SET_SEGMENTS.invoke(style, segs);
                    M_SET_INDETERMINATE.invoke(style, false);
                    M_SET_PROGRESS.invoke(style, max);
                    M_SET_END_ICON.invoke(style, Icon.createWithResource(ctx, iconRes(ctx, "ic_work_done", android.R.drawable.stat_sys_download_done)));
                } else if (todoTotal > 0 && todoTotal <= 8) {
                    List<Object> segs = new ArrayList<>(todoTotal);
                    for (int i = 0; i < todoTotal; i++) {
                        Object seg = CTOR_SEGMENT.newInstance(1);
                        M_SEG_SET_COLOR.invoke(seg, i < todoDone ? color : 0x33FFFFFF);
                        segs.add(seg);
                    }
                    M_SET_SEGMENTS.invoke(style, segs);
                    M_SET_INDETERMINATE.invoke(style, false);
                    M_SET_PROGRESS.invoke(style, Math.max(0, Math.min(todoTotal, todoDone)));
                } else if (todoTotal > 8) {
                    List<Object> segs = new ArrayList<>(1);
                    Object seg = CTOR_SEGMENT.newInstance(todoTotal);
                    M_SEG_SET_COLOR.invoke(seg, color);
                    segs.add(seg);
                    M_SET_SEGMENTS.invoke(style, segs);
                    M_SET_INDETERMINATE.invoke(style, false);
                    M_SET_PROGRESS.invoke(style, Math.max(0, Math.min(todoTotal, todoDone)));
                } else {
                    M_SET_INDETERMINATE.invoke(style, true);
                }
                b.setStyle((Notification.Style) style);
                return true;
            } catch (Throwable t) {
                Log.w(TAG, "applyProgressStyle failed: " + t.getMessage());
                return false;
            }
        }

        static void applyPromoted(Notification.Builder b, String shortText) {
            if (M_SHORT_TEXT != null && shortText != null && !shortText.isEmpty()) {
                try { M_SHORT_TEXT.invoke(b, shortText); } catch (Throwable ignored) {}
            }
            Bundle extras = new Bundle();
            extras.putBoolean(EXTRA_PROMOTED, true);
            b.addExtras(extras);
            if (M_REQ_PROMOTED != null) {
                try { M_REQ_PROMOTED.invoke(b, true); } catch (Throwable ignored) {}
            }
        }
    }
}
