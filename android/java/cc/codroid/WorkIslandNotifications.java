package cc.codroid;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.graphics.drawable.Icon;
import android.service.notification.StatusBarNotification;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;

import org.json.JSONObject;

import java.util.function.BooleanSupplier;

/** Publishes the gateway's sanitized work status as an Android Live Update. */
final class WorkIslandNotifications {
    private static final String CHANNEL = "work_island";
    private static final int WORK = 81, PREVIEW = 82;
    private static final long MAX_MS = 12 * 60 * 60 * 1000L;

    private final Context ctx;
    private final NotificationManager nm;
    private final Handler previewHandler = new Handler(Looper.getMainLooper());
    private final BooleanSupplier unlocked;
    private final XiaomiWorkIsland xiaomi;
    private int previewGeneration;
    private Card work, trial;

        private static final class Card {
        final int id, done, total;
        final String state, title, text, chip;
        final long since, deadline;
        final PendingIntent open;
        boolean postedUnlocked;

        Card(int id, String state, String title, String text, String chip, int done, int total,
             long since, long deadline, PendingIntent open) {
            this.id = id;
            this.state = state;
            this.title = title;
            this.text = text;
            this.chip = chip;
            this.done = done;
            this.total = total;
            this.since = since;
            this.deadline = deadline;
            this.open = open;
        }
    }

    WorkIslandNotifications(Context ctx, NotificationManager nm, BooleanSupplier unlocked) {
        this.ctx = ctx;
        this.nm = nm;
        this.unlocked = unlocked;
        this.xiaomi = new XiaomiWorkIsland(ctx);
    }

    static boolean supported() {
        return Build.VERSION.SDK_INT >= 36
            && Build.VERSION.SDK_INT_FULL >= Build.VERSION_CODES_FULL.BAKLAVA_1
            && ("Xiaomi".equalsIgnoreCase(Build.MANUFACTURER) || "Redmi".equalsIgnoreCase(Build.BRAND)
                || "Xiaomi".equalsIgnoreCase(Build.BRAND) || "POCO".equalsIgnoreCase(Build.BRAND));
    }

    synchronized void render(JSONObject frame, PendingIntent open) {
        long remaining = frame == null ? 0 : Math.min(MAX_MS, frame.optLong("expires") - System.currentTimeMillis());
        if (remaining <= 0) {
            work = null;
            nm.cancel(WORK);
            return;
        }
        if (!"UPDATE".equals(frame.optString("action"))) return;
        String state = frame.optString("state"), title = frame.optString("title"), text = frame.optString("text");
        int done = frame.optInt("todoDone", -1), total = frame.optInt("todoTotal");
        String critical = chip(state);
        if ("waiting".equals(state)) {
            title = Tr.t("待确认");
            text = confirmation(frame.optString("confirmation"));
        } else if (!"error".equals(state) && total > 0 && done >= 0 && done <= total) {
            critical = done + "/" + total;
            text = text.equals(Tr.f("清单 {0}/{1}", done, total)) ? text : text + " · " + critical;
        }
        if ("waiting".equals(state) || "error".equals(state)) {
            done = -1;
            total = 0;
        }
        work = new Card(WORK, state, title, text, critical, done, total, frame.optLong("since"),
            SystemClock.elapsedRealtime() + remaining, open);
        post(work, unlocked.getAsBoolean());
    }

    private static String confirmation(String kind) {
        switch (kind) {
            case "command": return Tr.t("命令待确认 · 点此打开会话");
            case "plan": return Tr.t("计划待批准 · 点此打开会话");
            case "question": return Tr.t("提问待回答 · 点此打开会话");
            default: return Tr.t("操作待确认 · 点此打开会话");
        }
    }

    // Only a bounded, local 160×160 JPEG from the keyed profile bridge; never used on public versions.
    private static final String AVATAR_PREFIX = "data:image/jpeg;base64,";
    private static final int AVATAR_LIMIT = 64 * 1024;
    static synchronized void saveAvatar(Context ctx, String data) {
        android.content.SharedPreferences prefs = ctx.getSharedPreferences("island_profile", Context.MODE_PRIVATE);
        android.graphics.Bitmap bmp = decodeAvatar(data);
        if (bmp == null) prefs.edit().remove("thumbnail").apply();
        else { bmp.recycle(); prefs.edit().putString("thumbnail", data).apply(); }
    }
    private static android.graphics.Bitmap decodeAvatar(String data) {
        if (data == null || data.length() > AVATAR_LIMIT || !data.startsWith(AVATAR_PREFIX)) return null;
        try {
            byte[] bytes = android.util.Base64.decode(data.substring(AVATAR_PREFIX.length()), android.util.Base64.DEFAULT);
            android.graphics.BitmapFactory.Options bounds = new android.graphics.BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.length, bounds);
            if (bounds.outWidth != 160 || bounds.outHeight != 160 || !"image/jpeg".equals(bounds.outMimeType)) return null;
            return android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
        } catch (RuntimeException ignored) { return null; }
    }

    static int icon(Context ctx) {
        return ctx.getApplicationInfo().icon;
    }

    synchronized void preview(PendingIntent open) {
        int generation = ++previewGeneration;
        long end = SystemClock.elapsedRealtime() + 15_000;
        previewHandler.removeCallbacksAndMessages(null);
        previewStep(generation, end, 1, open);
        previewHandler.postDelayed(() -> previewStep(generation, end, 2, open), 4_000);
        previewHandler.postDelayed(() -> previewStep(generation, end, 4, open), 8_000);
    }

    private synchronized void previewStep(int generation, long end, int done, PendingIntent open) {
        if (generation != previewGeneration || end <= SystemClock.elapsedRealtime()) return;
        trial = new Card(PREVIEW, "running", Tr.t("工作岛试播"), Tr.f("清单 {0}/5", String.valueOf(done)),
            done + "/5", done, 5, 0, end, open);
        post(trial, unlocked.getAsBoolean());
    }

    synchronized void cancel() {
        ++previewGeneration;
        previewHandler.removeCallbacksAndMessages(null);
        work = trial = null;
        nm.cancel(WORK);
        nm.cancel(PREVIEW);
    }

    synchronized void refreshIcons(boolean allowAvatar) {
        for (StatusBarNotification active : nm.getActiveNotifications()) {
            if (active.getTag() != null) continue;
            Card card = active.getId() == WORK ? work : active.getId() == PREVIEW ? trial : null;
            if (card != null && (allowAvatar || card.postedUnlocked)) post(card, allowAvatar);
        }
    }

    private void post(Card card, boolean allowAvatar) {
        long timeout = card.deadline - SystemClock.elapsedRealtime();
        if (timeout <= 0 || !supported() || !nm.areNotificationsEnabled()) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL, Tr.t("工作岛"), NotificationManager.IMPORTANCE_DEFAULT);
        channel.setSound(null, null);
        channel.enableVibration(false);
        channel.setShowBadge(false);
        nm.createNotificationChannel(channel);
        String publicChip = chip(card.state);
        android.graphics.Bitmap avatar = allowAvatar ? decodeAvatar(ctx
            .getSharedPreferences("island_profile", Context.MODE_PRIVATE).getString("thumbnail", "")) : null;
        android.os.Bundle focus = xiaomi.extras(card.state, card.title, card.text, card.chip, publicChip,
            card.done, card.total, timeout, allowAvatar, avatar);
        // Do not let the platform permission query extend the notification's deadline.
        timeout = card.deadline - SystemClock.elapsedRealtime();
        if (timeout <= 0) return;
        Notification.Builder b = new Notification.Builder(ctx, CHANNEL)
            .setSmallIcon(icon(ctx))
            .setContentTitle(allowAvatar ? card.title : Tr.t("工作岛"))
            .setContentText(allowAvatar ? card.text : publicChip).setContentIntent(card.open)
            .setCategory(Notification.CATEGORY_PROGRESS).setOnlyAlertOnce(true)
            .setOngoing(true).setTimeoutAfter(timeout)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setPublicVersion(new Notification.Builder(ctx, CHANNEL)
                .setSmallIcon(icon(ctx)).setContentTitle(Tr.t("工作岛")).setContentText(publicChip).build());
        if (focus != null) {
            b.addExtras(focus);
        } else {
            if (avatar != null) {
                b.setSmallIcon(Icon.createWithAdaptiveBitmap(avatar));
                b.setLargeIcon(avatar);
            }
            b.setRequestPromotedOngoing(true).setShortCriticalText(allowAvatar ? card.chip : publicChip);
            if (allowAvatar && card.total > 0 && card.done >= 0 && card.done <= card.total) {
                b.setStyle(new Notification.ProgressStyle()
                    .addProgressSegment(new Notification.ProgressStyle.Segment(card.total)).setProgress(card.done));
            } else if (allowAvatar && card.since > 0 && card.since <= System.currentTimeMillis()) {
                b.setWhen(card.since).setShowWhen(true).setUsesChronometer(true);
            }
        }
        nm.notify(card.id, b.build());
        card.postedUnlocked = allowAvatar;
    }

    private static String chip(String state) {
        switch (state) {
            case "waiting": return Tr.t("待确认");
            case "error": return Tr.t("出错了");
            default: return Tr.t("进行中");
        }
    }
}
