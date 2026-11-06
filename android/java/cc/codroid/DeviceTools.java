package cc.codroid;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.os.StatFs;
import android.provider.AlarmClock;
import android.provider.CalendarContract;
import android.util.Log;
import java.io.File;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 设备工具：网关给 claude 挂的 MCP（bin/device-mcp.mjs）经 Priv 的套接字调到这里。
 *
 * 边界（借 PalmClaw「结构化设备工具」的思路，代码是自己写的）：
 *   · 每个工具有固定参数，不收任意 Intent / 任意命令；
 *   · 用户在 设置 → 设备工具 里可以整体关掉，也可以逐个关；关掉的工具 MCP 里直接不出现；
 *   · claude 那边每次调用照常走权限确认（除非用户自己选了放行）；
 *   · 会打开别的应用的（链接、日历、拨号…）只「打开并预填」，保存 / 发送 / 拨出由用户在那个应用里点。
 *     应用在后台时安卓不让弹界面，改发一条通知让用户点。
 *   · 读屏 / 点按要无障碍，默认关，见 A11y。
 */
final class DeviceTools {
    static final String TAG = "cccodroid";
    static final String PREFS = "devtools";
    static final String CH = "agent";
    static final String[] BASIC = {"device_status", "notify", "clipboard_read", "clipboard_write", "open", "share_file", "app_list"};
    static final String[] SCREEN = {"screen_read", "screen_tap", "screen_swipe", "screen_type", "screen_key", "screenshot"};
    private static int noteId = 600;

    /** 用户在原生对话框里确认过开读屏（MainActivity.confirmA11y）。总开关和读屏模式存在 Consent 里（锁屏签名），
     *  不再是同 uid 脚本改一下 prefs 就能伪造的明文（11-03 审查 H-2） */
    static void a11yConfirmed(Context c, String mode, boolean on) {
        if (on) Consent.grant(c, Consent.DEV_ON, "1");
        if (mode.equals("auto") || mode.equals("on")) Consent.grant(c, Consent.DEV_A11Y, mode);
        if (mode.equals("on")) new Thread(() -> A11y.enable(c, 4000)).start();
    }
    static boolean on(Context c) { return Consent.on(c, Consent.DEV_ON); }
    /** 读屏模式：off / auto（用时自动开）/ on（常开） */
    static String a11yMode(Context c) {
        String m = Consent.get(c, Consent.DEV_A11Y);
        return "auto".equals(m) || "on".equals(m) ? m : "off";
    }
    /** 屏幕类工具现在能不能用（总开关、读屏模式、单个工具都开着）。Priv 据此决定要不要先问这个会话（11-03 审查 M-6） */
    static boolean screenReady(Context c, String tool) {
        return isScreen(tool) && on(c) && !"off".equals(a11yMode(c)) && !sp(c).getStringSet("off", new HashSet<>()).contains(tool);
    }
    static SharedPreferences sp(Context c) { return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE); }
    static boolean isScreen(String t) { for (String s : SCREEN) if (s.equals(t)) return true; return false; }
    private static boolean known(String t) { for (String s : BASIC) if (s.equals(t)) return true; return isScreen(t); }

    // ── 设置 ─────────────────────────────────────────────────────────────
    static JSONObject status(Context c) throws Exception {
        SharedPreferences p = sp(c);
        Set<String> off = p.getStringSet("off", new HashSet<>());
        String mode = a11yMode(c);
        JSONArray tools = new JSONArray();
        for (String s : BASIC) tools.put(new JSONObject().put("name", s).put("enabled", !off.contains(s)));
        for (String s : SCREEN) tools.put(new JSONObject().put("name", s).put("enabled", !off.contains(s)).put("screen", true));
        return new JSONObject().put("ok", true)
            .put("on", on(c))
            .put("tools", tools)
            .put("a11y", new JSONObject()
                .put("mode", mode)
                .put("idle", p.getInt("a11yIdle", 10))
                .put("connected", A11y.self != null)
                .put("canToggle", A11y.canToggle(c))
                .put("screenshot", Build.VERSION.SDK_INT >= 30));
    }

    static JSONObject set(Context c, JSONObject r) throws Exception {
        SharedPreferences.Editor e = sp(c).edit();
        // 打开总开关同样要用户在原生对话框里点头（这条设置经网关谁都能发，被带偏的模型、混进来的脚本都行）
        boolean askOn = r.has("on") && r.getBoolean("on") && !on(c);
        if (r.has("on") && !r.getBoolean("on")) Consent.revoke(c, Consent.DEV_ON);
        if (r.has("tool") && known(r.getString("tool"))) {
            Set<String> off = new HashSet<>(sp(c).getStringSet("off", new HashSet<>()));
            if (r.optBoolean("enabled", true)) off.remove(r.getString("tool")); else off.add(r.getString("tool"));
            e.putStringSet("off", off);
        }
        if (r.has("idle")) e.putInt("a11yIdle", Math.max(1, Math.min(r.getInt("idle"), 240)));
        String mode = r.optString("a11y", "");
        // 读屏切到「用时自动开」或「常开」：每次都要用户在原生对话框里点头（审查 v0.5.9 B4；10-31 复核：以前点过一次就永久免问，
        // 之后谁发一条 dev_set 都能静默切到常开）。这条设置能经网关改，被带偏的模型也改得了；对话框只能在 App 前台弹，后台发起的直接没下文
        boolean ask = (mode.equals("auto") || mode.equals("on")) && !mode.equals(a11yMode(c));
        if (ask || askOn) {
            try { c.startActivity(MainActivity.internal(c, MainActivity.ACTION_A11Y_OK).putExtra("mode", ask ? mode : "").putExtra("on", askOn)
                .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)); } catch (Exception ignored) {}
        }
        if (mode.equals("off")) Consent.revoke(c, Consent.DEV_A11Y);
        e.commit();
        JSONObject res = status(c);
        if (ask || askOn) { res.put("message", Tr.t("请在弹出的对话框里确认")); return res; }
        // 切到「常开」就马上开；切到「关」就马上关；「用时自动开」现在开着就让它按空闲时间自己关
        if (mode.equals("on")) { String why = A11y.enable(c, 4000); res = status(c); if (why != null) res.put("message", why); }
        if (mode.equals("off")) { A11y.disable(c); res = status(c); }
        return res;
    }

    // ── 调用 ─────────────────────────────────────────────────────────────
    static JSONObject call(Context c, JSONObject req) {
        String tool = req.optString("tool");
        JSONObject a = req.optJSONObject("args");
        if (a == null) a = new JSONObject();
        try {
            SharedPreferences p = sp(c);
            if (!on(c)) return fail(Tr.t("用户在设置里关掉了设备工具"));
            if (!known(tool)) return fail(Tr.t("没有这个设备工具：") + tool);
            if (p.getStringSet("off", new HashSet<>()).contains(tool)) return fail(Tr.t("用户在设置里关掉了这个工具：") + tool);
            if (isScreen(tool)) {
                // 正在问用户要不要放行一条特权命令：这会儿不许动屏幕，免得替用户点了「允许」
                if (Priv.asking() || MainActivity.guarding()) return fail(Tr.t("cccodroid 正在等用户确认一条特权命令，这会儿不能操作屏幕，稍后再试"));
                if ("off".equals(a11yMode(c)))
                    return fail(Tr.t("读屏 / 点按没开：用户要在 设置 → 设备工具 里把「无障碍」改成「用时自动开」或「常开」"));
                // 每个会话第一次用屏幕类工具要用户点头：在 Priv 的 dev 分支里问（11-03 审查 M-6），这里只会是问过之后进来的
                String why = A11y.enable(c, 4000);
                if (why != null) return fail(why);
            }
            Log.i(TAG, "设备工具 " + tool);
            switch (tool) {
                case "device_status": return deviceStatus(c);
                case "notify": return notify(c, a);
                case "clipboard_read": return clipRead(c);
                case "clipboard_write": return clipWrite(c, a);
                case "open": return open(c, a);
                case "share_file": return shareFile(c, a);
                case "app_list": return appList(c, a);
                case "screen_read": return A11y.read(a.optBoolean("all", false));
                case "screen_tap": case "screen_swipe": case "screen_type": case "screen_key": {
                    // 做完默认等界面静下来、带上新屏幕（read=false 不带）：省掉模型「做完再读一次」那一回合
                    boolean rd = a.optBoolean("read", true);
                    int before = rd ? A11y.arm() : 0;
                    JSONObject res;
                    try {
                        res = tool.equals("screen_tap") ? A11y.tap(a) : tool.equals("screen_swipe") ? A11y.swipe(a)
                            : tool.equals("screen_type") ? A11y.type(a) : A11y.key(a);
                    } catch (Throwable t) { if (rd) A11y.disarm(); throw t; }
                    return rd ? A11y.withScreen(res, before) : res;
                }
                case "screenshot": return A11y.screenshot(c);
            }
            return fail(tool);
        } catch (Throwable t) {
            Log.w(TAG, "设备工具 " + tool + " 出错", t);
            try { return fail(t.getClass().getSimpleName() + ": " + t.getMessage()); } catch (Exception e) { return new JSONObject(); }
        }
    }

    // ── 各个工具 ─────────────────────────────────────────────────────────
    static JSONObject deviceStatus(Context c) throws Exception {
        JSONObject r = new JSONObject().put("ok", true);
        Intent bat = c.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        if (bat != null) {
            int lv = bat.getIntExtra(BatteryManager.EXTRA_LEVEL, -1), sc = bat.getIntExtra(BatteryManager.EXTRA_SCALE, 100);
            int st = bat.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
            r.put("battery", new JSONObject()
                .put("percent", sc > 0 ? lv * 100 / sc : lv)
                .put("charging", st == BatteryManager.BATTERY_STATUS_CHARGING || st == BatteryManager.BATTERY_STATUS_FULL)
                .put("temperature_c", bat.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 0) / 10.0));
        }
        ConnectivityManager cm = c.getSystemService(ConnectivityManager.class);
        Network n = cm.getActiveNetwork();
        NetworkCapabilities nc = n == null ? null : cm.getNetworkCapabilities(n);
        String type = nc == null ? "none" : nc.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ? "wifi"
            : nc.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) ? "cellular"
            : nc.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) ? "ethernet" : "other";
        r.put("network", new JSONObject().put("type", type)
            .put("vpn", nc != null && nc.hasTransport(NetworkCapabilities.TRANSPORT_VPN))
            .put("metered", cm.isActiveNetworkMetered()));
        PowerManager pm = c.getSystemService(PowerManager.class);
        r.put("screen_on", pm.isInteractive()).put("power_save", pm.isPowerSaveMode());
        r.put("app_in_foreground", MainActivity.appForeground());
        JSONObject st = new JSONObject();
        for (String[] d : new String[][]{{"app", c.getFilesDir().getPath()}, {"shared", "/sdcard"}}) {
            try { StatFs fs = new StatFs(d[1]); st.put(d[0] + "_free_gb", Math.round(fs.getAvailableBytes() / 1e8) / 10.0); } catch (Exception ignored) {}
        }
        r.put("storage", st);
        r.put("device", Build.MANUFACTURER + " " + Build.MODEL).put("android", Build.VERSION.RELEASE).put("sdk", Build.VERSION.SDK_INT);
        r.put("accessibility", A11y.self != null ? "connected" : a11yMode(c));
        return r;
    }

    private static void channel(Context c) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm.getNotificationChannel(CH) == null)
            nm.createNotificationChannel(new NotificationChannel(CH, Tr.t("Claude 发的通知"), NotificationManager.IMPORTANCE_DEFAULT));
    }

    private static JSONObject notify(Context c, JSONObject a) throws Exception {
        String title = a.optString("title", "").trim(), text = a.optString("text", "").trim();
        if (title.isEmpty() && text.isEmpty()) return fail(Tr.t("title 和 text 至少给一个"));
        channel(c);
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (!nm.areNotificationsEnabled()) return fail(Tr.t("系统设置里关掉了本应用的通知"));
        PendingIntent pi = PendingIntent.getActivity(c, 60, new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT),
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        int id = noteId++;
        nm.notify(id, new Notification.Builder(c, CH)
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentTitle(title.isEmpty() ? "Claude" : clip(title, 200))
            .setContentText(clip(text, 1000))
            .setStyle(new Notification.BigTextStyle().bigText(clip(text, 4000)))
            // 锁屏上只露「Claude」，正文解锁后才看得到（审查 10-29 第六份 低3）
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setPublicVersion(new Notification.Builder(c, CH).setSmallIcon(android.R.drawable.stat_notify_chat).setContentTitle("Claude").build())
            .setContentIntent(pi).setAutoCancel(true).build());
        return new JSONObject().put("ok", true).put("id", id);
    }

    /** 剪贴板要在主线程碰 */
    private static <T> T onMain(java.util.concurrent.Callable<T> f) throws Exception {
        if (Looper.myLooper() == Looper.getMainLooper()) return f.call();
        AtomicReference<T> out = new AtomicReference<>();
        AtomicReference<Exception> err = new AtomicReference<>();
        CountDownLatch done = new CountDownLatch(1);
        // 0 排着 / 1 已开始 / 2 已作废。超时时还没开始的作废掉（审查 #107 09-013）：以前只是不等了，
        // 主线程闲下来照样执行，工具已经报了错、剪贴板却在之后被写了
        java.util.concurrent.atomic.AtomicInteger st = new java.util.concurrent.atomic.AtomicInteger();
        new Handler(Looper.getMainLooper()).post(() -> {
            if (!st.compareAndSet(0, 1)) return;
            try { out.set(f.call()); } catch (Exception e) { err.set(e); }
            done.countDown();
        });
        if (!done.await(5, TimeUnit.SECONDS)) {
            if (st.compareAndSet(0, 2)) throw new Exception("timeout");
            // 已经在主线程上跑了：等它跑完，结果照实报
            if (!done.await(10, TimeUnit.SECONDS)) throw new Exception("timeout");
        }
        if (err.get() != null) throw err.get();
        return out.get();
    }

    private static JSONObject clipRead(Context c) throws Exception {
        String s = onMain(() -> {
            ClipboardManager cm = c.getSystemService(ClipboardManager.class);
            ClipData d = cm.getPrimaryClip();
            if (d == null || d.getItemCount() == 0) return null;
            CharSequence t = d.getItemAt(0).coerceToText(c);
            return t == null ? "" : t.toString();
        });
        // 安卓 10 起，应用不在前台读不到剪贴板（系统直接给 null）
        if (s == null) return fail(MainActivity.appForeground() ? Tr.t("剪贴板是空的") : Tr.t("安卓不让后台应用读剪贴板：要读的话，请用户先切回 cccodroid"));
        return new JSONObject().put("ok", true).put("text", clip(s, 20000));
    }

    private static JSONObject clipWrite(Context c, JSONObject a) throws Exception {
        String text = a.optString("text", "");
        // 剪贴板走 Binder，内容过大系统直接抛异常；也别让一段巨量文字把剪贴板占住（审查 10-30 第九份 安卓低12）
        if (text.length() > 200000) return fail(Tr.f("太长了（{0} 字），剪贴板一次最多放 20 万字", text.length()));
        onMain(() -> { c.getSystemService(ClipboardManager.class).setPrimaryClip(ClipData.newPlainText("Claude", text)); return null; });
        return new JSONObject().put("ok", true).put("chars", text.length());
    }

    private static JSONObject appList(Context c, JSONObject a) throws Exception {
        String q = a.optString("query", "").toLowerCase();
        PackageManager pm = c.getPackageManager();
        List<ResolveInfo> l = pm.queryIntentActivities(new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0);
        JSONArray out = new JSONArray();
        Set<String> seen = new HashSet<>();
        for (ResolveInfo ri : l) {
            String pkg = ri.activityInfo.packageName, label = String.valueOf(ri.loadLabel(pm));
            if (!seen.add(pkg)) continue;
            if (!q.isEmpty() && !pkg.toLowerCase().contains(q) && !label.toLowerCase().contains(q)) continue;
            out.put(new JSONObject().put("label", label).put("package", pkg));
        }
        return new JSONObject().put("ok", true).put("apps", out);
    }

    /** 固定几类「打开并预填」：不收任意 action，免得模型拼出拨打、静默发送之类的东西 */
    private static JSONObject open(Context c, JSONObject a) throws Exception {
        String kind = a.optString("kind");
        Intent i;
        String what;
        switch (kind) {
            case "url": {
                String u = a.optString("url");
                if (!u.matches("(?i)^https?://.+")) return fail(Tr.t("url 只收 http / https"));
                i = new Intent(Intent.ACTION_VIEW, Uri.parse(u)); what = u; break;
            }
            case "map":
                i = new Intent(Intent.ACTION_VIEW, Uri.parse("geo:0,0?q=" + Uri.encode(a.optString("query"))));
                what = a.optString("query"); break;
            case "dial":       // 只把号码填进拨号盘，打不打由用户按
                i = new Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + Uri.encode(a.optString("number"))));
                what = a.optString("number"); break;
            case "email":
                i = new Intent(Intent.ACTION_SENDTO, Uri.parse("mailto:" + Uri.encode(a.optString("to"), "@,.+-_")))
                    .putExtra(Intent.EXTRA_SUBJECT, a.optString("subject")).putExtra(Intent.EXTRA_TEXT, a.optString("body"));
                what = a.optString("to"); break;
            case "sms":
                i = new Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:" + Uri.encode(a.optString("number"))))
                    .putExtra("sms_body", a.optString("body"));
                what = a.optString("number"); break;
            case "calendar_event": {
                i = new Intent(Intent.ACTION_INSERT).setData(CalendarContract.Events.CONTENT_URI)
                    .putExtra(CalendarContract.Events.TITLE, a.optString("title"))
                    .putExtra(CalendarContract.Events.DESCRIPTION, a.optString("description"))
                    .putExtra(CalendarContract.Events.EVENT_LOCATION, a.optString("location"))
                    .putExtra(CalendarContract.EXTRA_EVENT_ALL_DAY, a.optBoolean("all_day", false));
                long b = time(a.optString("start")), e = time(a.optString("end"));
                if (b > 0) i.putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, b);
                if (e > 0) i.putExtra(CalendarContract.EXTRA_EVENT_END_TIME, e);
                what = a.optString("title"); break;
            }
            case "alarm":
                i = new Intent(AlarmClock.ACTION_SET_ALARM).putExtra(AlarmClock.EXTRA_HOUR, a.optInt("hour"))
                    .putExtra(AlarmClock.EXTRA_MINUTES, a.optInt("minute")).putExtra(AlarmClock.EXTRA_MESSAGE, a.optString("label"));
                what = a.optInt("hour") + ":" + a.optInt("minute"); break;
            case "timer":
                i = new Intent(AlarmClock.ACTION_SET_TIMER).putExtra(AlarmClock.EXTRA_LENGTH, a.optInt("seconds"))
                    .putExtra(AlarmClock.EXTRA_MESSAGE, a.optString("label"));
                what = a.optInt("seconds") + "s"; break;
            case "share_text":
                i = Intent.createChooser(new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, a.optString("text")), null);
                what = Tr.t("分享文字"); break;
            case "app": {
                i = c.getPackageManager().getLaunchIntentForPackage(a.optString("package"));
                if (i == null) return fail(Tr.t("没装这个应用，或者它没有启动入口：") + a.optString("package"));
                what = a.optString("package"); break;
            }
            default:
                return fail(Tr.t("kind 只能是 url / map / dial / email / sms / calendar_event / alarm / timer / share_text / app"));
        }
        return launch(c, i, what);
    }

    private static long time(String s) {
        if (s == null || s.isEmpty()) return 0;
        try { return java.time.OffsetDateTime.parse(s).toInstant().toEpochMilli(); } catch (Exception ignored) {}
        try { return java.time.LocalDateTime.parse(s).atZone(java.time.ZoneId.systemDefault()).toInstant().toEpochMilli(); } catch (Exception ignored) {}
        try { return java.time.LocalDate.parse(s).atStartOfDay(java.time.ZoneId.systemDefault()).toInstant().toEpochMilli(); } catch (Exception ignored) {}
        return 0;
    }

    private static JSONObject shareFile(Context c, JSONObject a) throws Exception {
        File f = new File(a.optString("path"));
        if (!f.isFile()) return fail(Tr.t("文件不存在：") + f);
        try { f = Share.shareable(c, f); } catch (Exception e) { return fail(e.getMessage()); }
        Uri u = Share.uriFor(c, f);
        if (u == null) return fail(Tr.t("这个文件不能分享：") + f);
        String mime = a.optString("mime", "");
        if (mime.isEmpty()) mime = Share.mimeOf(f);
        Intent send = new Intent(Intent.ACTION_SEND).setType(Share.sendMime(mime)).putExtra(Intent.EXTRA_STREAM, u)
            .putExtra(Intent.EXTRA_SUBJECT, f.getName()).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        send.setClipData(ClipData.newRawUri(f.getName(), u));
        return launch(c, Intent.createChooser(send, f.getName()).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION), f.getName());
    }

    /** 能直接弹就弹（界面在前台、或无障碍连着 —— 系统都放行）；否则发通知让用户点 */
    private static JSONObject launch(Context c, Intent i, String what) throws Exception {
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        if (i.getComponent() == null && i.resolveActivity(c.getPackageManager()) == null && !Intent.ACTION_CHOOSER.equals(i.getAction()))
            return fail(Tr.t("这台设备上没有能处理它的应用"));
        if (MainActivity.appForeground() || A11y.self != null) {
            try { c.startActivity(i); return new JSONObject().put("ok", true).put("shown", "opened"); }
            catch (ActivityNotFoundException e) { return fail(Tr.t("这台设备上没有能处理它的应用")); }
            catch (Exception ignored) { }
        }
        channel(c);
        PendingIntent pi = PendingIntent.getActivity(c, 700 + (noteId % 50), i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        int id = noteId++;
        c.getSystemService(NotificationManager.class).notify(id, new Notification.Builder(c, CH)
            .setSmallIcon(android.R.drawable.ic_menu_send)
            .setContentTitle(Tr.t("Claude 想打开："))
            .setContentText(clip(what, 200))
            .setContentIntent(pi).setAutoCancel(true).setTimeoutAfter(10 * 60_000).build());
        return new JSONObject().put("ok", true).put("shown", "notification")
            .put("message", Tr.t("cccodroid 在后台，安卓不让直接弹出界面：已发通知，用户点了才会打开"));
    }

    private static String clip(String s, int n) { return s == null ? "" : s.length() > n ? s.substring(0, n) + "…" : s; }
    private static JSONObject fail(String m) throws Exception { return new JSONObject().put("ok", false).put("message", m); }
}
