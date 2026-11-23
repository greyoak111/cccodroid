package cc.codroid;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.BooleanSupplier;

/** Acknowledgeable reminder visible while the user is in system Settings. */
final class SplitPairingNotice {
    static final String ACTION_ACK = "cc.codroid.SPLIT_PAIRING_ACK";
    private static final String TAG = "split-pairing";
    private static final int ID = 1;
    private static final ExecutorService worker = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "split-pairing-notice"); t.setDaemon(true); return t;
    });

    static void show(Context c, String message, BooleanSupplier stillNeeded) {
        Context app = c.getApplicationContext();
        worker.execute(() -> {
            try {
                if (!stillNeeded.getAsBoolean()) return;
                NotificationManager nm = app.getSystemService(NotificationManager.class);
                if (!nm.areNotificationsEnabled()) {
                    android.util.Log.w("cccodroid", "分屏提醒通知未开启；保留页面手动指引");
                    return;
                }
                // Use the same channel the user already sees for pairing-code input on MIUI.
                // Do not call ShizukuSetup.get(): notification setup must not start activation / ADB.
                ShizukuSetup.ensureNotificationChannel(app);
                PendingIntent acknowledge = PendingIntent.getActivity(app, 5301,
                    MainActivity.internal(app, ACTION_ACK).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                        | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT),
                    PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
                // Match the pairing prompt: persistent heads-up while Settings is in front.
                // The fullscreen fallback is a no-op, not ACK or activation; only a user tap acknowledges.
                PendingIntent attention = PendingIntent.getActivity(app, 5302,
                    MainActivity.internal(app, MainActivity.ACTION_SHIZUKU_NOOP).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                    PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
                Notification notice = new Notification.Builder(app, ShizukuSetup.CH)
                    .setSmallIcon(android.R.drawable.ic_secure)
                    .setContentTitle(Tr.t("未检测到分屏，请手动操作"))
                    .setContentText(message)
                    .setStyle(new Notification.BigTextStyle().bigText(message))
                    .setContentIntent(acknowledge)
                    .addAction(new Notification.Action.Builder(null, Tr.t("知道了，返回应用"), acknowledge).build())
                    .setCategory(Notification.CATEGORY_REMINDER)
                    .setFullScreenIntent(attention, true)
                    .setOnlyAlertOnce(false).setOngoing(true).setAutoCancel(true)
                    .setTimeoutAfter(600_000).build();
                if (stillNeeded.getAsBoolean()) nm.notify(TAG, ID, notice);
            } catch (RuntimeException e) {
                android.util.Log.w("cccodroid", "无法显示分屏提醒；保留页面手动指引", e);
            }
        });
    }

    static void dismiss(Context c) {
        Context app = c.getApplicationContext();
        worker.execute(() -> {
            try { app.getSystemService(NotificationManager.class).cancel(TAG, ID); }
            catch (RuntimeException e) { android.util.Log.w("cccodroid", "无法收起分屏提醒", e); }
        });
    }
}
