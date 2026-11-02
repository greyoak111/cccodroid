package cc.codroid;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.SharedPreferences;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/** Metadata-only notifications. No title, tool input, source, token, or approval action is accepted. */
final class RemoteNotifications {
    static final String CH_EVENTS = "remote-events-v1";
    static final String CH_CONNECTION = "remote-connection-v1";
    private static final String CONNECTION_TAG = "remote-connection";
    private final Context ctx;
    private final NotificationManager nm;
    private final SharedPreferences prefs;
    private final RemotePolicy.Ledger ledger = new RemotePolicy.Ledger();
    private final Set<String> activeTags = new HashSet<>();
    private boolean storageHealthy = true;

    RemoteNotifications(Context ctx) {
        this.ctx = ctx;
        this.nm = ctx.getSystemService(NotificationManager.class);
        this.prefs = ctx.getSharedPreferences("remote-notification-ledger-v1", Context.MODE_PRIVATE);
        NotificationChannel events = new NotificationChannel(CH_EVENTS, Tr.t("远程会话提醒"), NotificationManager.IMPORTANCE_DEFAULT);
        events.setDescription(Tr.t("远程托管邀请、待处理确认与本轮结束；不展示会话正文"));
        events.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
        NotificationChannel connection = new NotificationChannel(CH_CONNECTION, Tr.t("远程后台连接"), NotificationManager.IMPORTANCE_LOW);
        connection.setDescription(Tr.t("仅在你开启接收远程提醒后显示；关闭后仅打开 CC 时实时接收"));
        connection.setShowBadge(false);
        nm.createNotificationChannel(events);
        nm.createNotificationChannel(connection);
        restore();
    }
    boolean systemAllowed() { return nm.areNotificationsEnabled(); }
    boolean channelAllowed(String channel) {
        NotificationChannel c = nm.getNotificationChannel(channel);
        return c != null && c.getImportance() != NotificationManager.IMPORTANCE_NONE;
    }
    synchronized void sync(List<RemotePolicy.Entry> entries, boolean enabled) throws Exception {
        if (!storageHealthy) throw new IllegalStateException("NOTIFICATION_STORAGE_UNAVAILABLE");
        RemotePolicy.Delta d = ledger.sync(entries, System.currentTimeMillis(), enabled && systemAllowed() && channelAllowed(CH_EVENTS));
        apply(d, ledger.latestSnapshot());
    }
    /** Replay only the last bounded metadata snapshot; never reset dedup or renew its TTL. */
    synchronized void replay(boolean enabled) throws Exception {
        if (!storageHealthy) throw new IllegalStateException("NOTIFICATION_STORAGE_UNAVAILABLE");
        RemotePolicy.Delta d = ledger.replay(System.currentTimeMillis(), enabled && systemAllowed() && channelAllowed(CH_EVENTS));
        apply(d, ledger.latestSnapshot());
    }
    private void apply(RemotePolicy.Delta d, List<RemotePolicy.Entry> entries) throws Exception {
        for (String old : new HashSet<>(activeTags)) if (!d.keep.contains(old)) { nm.cancel(old, 0); activeTags.remove(old); }
        for (String old : d.cancel) { nm.cancel(old, 0); activeTags.remove(old); }
        for (RemotePolicy.Entry e : d.post) activeTags.add(e.tag());
        persist(); // Persist dedup before posting; a crash cannot turn a replay into another alert.
        for (RemotePolicy.Entry e : d.post) nm.notify(e.tag(), 0, note(e));
        // Refresh only the generic note's timeout for an ongoing request; a dismissed note is not resurrected.
        for (android.service.notification.StatusBarNotification n : nm.getActiveNotifications()) {
            if (n.getTag() == null || !d.keep.contains(n.getTag())) continue;
            for (RemotePolicy.Entry e : entries) if (n.getTag().equals(e.tag())) { nm.notify(e.tag(), 0, note(e)); break; }
        }
    }
    synchronized void revoke(RemotePolicy.Binding binding) throws Exception {
        RemotePolicy.Delta d = ledger.revoke(binding, System.currentTimeMillis());
        // Android's active notifications also cover a host process restart.
        for (android.service.notification.StatusBarNotification n : nm.getActiveNotifications()) {
            if (n.getTag() != null && n.getTag().startsWith("remote:") && n.getNotification().extras != null
                    && binding.scope().equals(n.getNotification().extras.getString("remote.scope"))
                    && n.getNotification().extras.getLong("remote.grant", Long.MAX_VALUE) <= binding.grantVersion) {
                nm.cancel(n.getTag(), 0); activeTags.remove(n.getTag());
            }
        }
        for (String tag : d.cancel) { nm.cancel(tag, 0); activeTags.remove(tag); }
        persist();
    }
    synchronized void hide() throws Exception {
        ledger.hide();
        cancelAll();
    }
    synchronized void clear() throws Exception {
        ledger.clear();
        cancelAll();
    }
    private void cancelAll() throws Exception {
        for (String tag : activeTags) nm.cancel(tag, 0);
        for (android.service.notification.StatusBarNotification n : nm.getActiveNotifications())
            if (n.getTag() != null && n.getTag().startsWith("remote:")) nm.cancel(n.getTag(), 0);
        activeTags.clear();
        persist();
    }
    synchronized void connection(boolean show) {
        if (!show || !systemAllowed() || !channelAllowed(CH_CONNECTION)) { nm.cancel(CONNECTION_TAG, 0); return; }
        android.app.PendingIntent pi = android.app.PendingIntent.getActivity(ctx, 44109,
            new android.content.Intent(ctx, MainActivity.class).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK),
            android.app.PendingIntent.FLAG_IMMUTABLE);
        nm.notify(CONNECTION_TAG, 0, new Notification.Builder(ctx, CH_CONNECTION)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle(Tr.t("远程后台连接已开启"))
            .setContentText(Tr.t("由 CC 网关接收提醒；连接状态请在应用内查看"))
            .setContentIntent(pi).setOngoing(true).setOnlyAlertOnce(true)
            .setVisibility(Notification.VISIBILITY_PRIVATE).build());
    }
    private Notification note(RemotePolicy.Entry e) throws Exception {
        String title = "request".equals(e.kind) ? Tr.t("平板有一项操作等你确认")
            : "invite".equals(e.kind) ? Tr.t("收到远程托管邀请") : Tr.t("远程会话本轮已结束");
        String text = Tr.t("打开 CC 查看远程会话详情");
        android.os.Bundle metadata = new android.os.Bundle();
        metadata.putString("remote.scope", e.binding.scope());
        metadata.putLong("remote.grant", e.binding.grantVersion);
        Notification publicVersion = new Notification.Builder(ctx, CH_EVENTS)
            .setSmallIcon(android.R.drawable.stat_notify_chat).setContentTitle(title).setContentText(text).build();
        return new Notification.Builder(ctx, CH_EVENTS)
            .setSmallIcon(android.R.drawable.stat_notify_chat).setContentTitle(title).setContentText(text)
            .setVisibility(Notification.VISIBILITY_PRIVATE).setPublicVersion(publicVersion)
            .setCategory(Notification.CATEGORY_REMINDER).setContentIntent(RemoteRoutes.open(ctx, e))
            .setTimeoutAfter(Math.max(1, e.expiresAt - System.currentTimeMillis()))
            .setExtras(metadata).setOnlyAlertOnce(true).setAutoCancel(true).build();
        // Deliberately no addAction: neither approval nor rejection belongs on the lock screen.
    }
    private void restore() {
        try {
            activeTags.addAll(prefs.getStringSet("active", java.util.Collections.<String>emptySet()));
            JSONObject seenJson = new JSONObject(prefs.getString("seen", "{}"));
            JSONObject revokedJson = new JSONObject(prefs.getString("revoked", "{}"));
            Map<String, Long> seen = new HashMap<>();
            Map<String, RemotePolicy.Revocation> revoked = new HashMap<>();
            for (java.util.Iterator<String> it = seenJson.keys(); it.hasNext();) { String k = it.next(); seen.put(k, seenJson.getLong(k)); }
            for (java.util.Iterator<String> it = revokedJson.keys(); it.hasNext();) {
                String k = it.next(); JSONArray value = revokedJson.getJSONArray(k);
                revoked.put(k, new RemotePolicy.Revocation(value.getLong(0), value.getLong(1)));
            }
            ledger.restore(seen, revoked, System.currentTimeMillis());
            for (String tag : activeTags) if (!tag.matches("remote:[0-9a-f]{64}")) throw new IllegalArgumentException("INVALID_LEDGER");
        } catch (Exception ignored) {
            storageHealthy = false; // Do not silently reset replay/revocation protection on corrupted storage.
        }
    }
    private void persist() throws Exception {
        JSONObject seen = new JSONObject(), revoked = new JSONObject();
        for (Map.Entry<String, Long> e : ledger.seenSnapshot().entrySet()) seen.put(e.getKey(), e.getValue());
        for (Map.Entry<String, RemotePolicy.Revocation> e : ledger.revokedSnapshot().entrySet())
            revoked.put(e.getKey(), new JSONArray().put(e.getValue().version).put(e.getValue().until));
        if (!prefs.edit().putString("seen", seen.toString()).putString("revoked", revoked.toString())
                .putStringSet("active", new HashSet<>(activeTags)).commit()) {
            storageHealthy = false;
            throw new IllegalStateException("NOTIFICATION_STORAGE_UNAVAILABLE");
        }
    }
    synchronized JSONObject status() throws Exception {
        return new JSONObject().put("systemNotifications", systemAllowed()).put("eventChannel", channelAllowed(CH_EVENTS))
            .put("connectionChannel", channelAllowed(CH_CONNECTION)).put("notificationStorageHealthy", storageHealthy)
            .put("activeNotifications", activeTags.size());
    }
}
