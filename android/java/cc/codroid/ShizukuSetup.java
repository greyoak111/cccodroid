package cc.codroid;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.RemoteInput;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.util.Log;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;
import rikka.shizuku.Shizuku;

/**
 * Shizuku 一条龙：下载 → 安装 → 激活 → 授权 →（重启后）自动重新激活。
 *
 * 激活走"无线调试"（安卓 11+，不用电脑）。Shizuku 自己的做法也是这样，只是这里由 cccodroid 代劳：
 *   1. 用户在 开发者选项 → 无线调试 → 使用配对码配对设备，弹出 6 位码；
 *      我们用 NSD 找到本机的配对服务端口（_adb-tls-pairing._tcp），用户在通知栏的输入框里填码 —— 不用来回切应用；
 *   2. 工具包里的 adb：adb pair 127.0.0.1:端口 码 → adb connect 127.0.0.1:连接端口（_adb-tls-connect._tcp）；
 *   3. adb shell <Shizuku 的 nativeLibraryDir>/libshizuku.so —— 就是 Shizuku 的启动器，以 shell 身份拉起服务；
 *   4. 服务起来后经 ShizukuProvider 把 binder 递给我们 → 弹授权框 → 授权后顺手给自己 WRITE_SECURE_SETTINGS。
 * 重启后 Shizuku 会失效：有了 WRITE_SECURE_SETTINGS，我们能自己打开无线调试，配对过的 adb 钥匙仍被信任，
 * 于是 2–4 步全自动重来（需要连着 Wi‑Fi —— 无线调试只在 Wi‑Fi 下工作）。
 */
final class ShizukuSetup {
    static final String TAG = "cccodroid-shz";
    /** Shizuku 官方发布包的签名证书（CN=Rikka）sha256：GitHub 资产没有摘要，靠钉证书防掉包 */
    static final String PIN = "268b5590e868fb08bae7e0ac413564cd1ff88f5ccff74af9dbd0dc918e30db30";
    static final String CH = "shizuku";
    static final int NOTE = 30;
    static final String WSS = "android.permission.WRITE_SECURE_SETTINGS";

    private static ShizukuSetup inst;
    static synchronized ShizukuSetup get(Context c) { if (inst == null) inst = new ShizukuSetup(c.getApplicationContext()); return inst; }

    private final Context ctx;
    private final Env env;
    volatile String phase = "idle", message = "";
    volatile long done, total;
    private volatile boolean busy, activateAfterInstall, activateQueued;
    private volatile int pairPort = -1;
    /** 这次配对期间看到的配对服务（名字 → 端口）。这类广播谁都能注册：不止一个时不替用户挑，要他照配对框填端口 */
    private final java.util.Map<String, Integer> pairSeen = new java.util.concurrent.ConcurrentHashMap<>();
    private NsdManager.DiscoveryListener pairDisc;

    private ShizukuSetup(Context c) {
        ctx = c;
        env = new Env(c);
        NotificationChannel ch = new NotificationChannel(CH, Tr.t("Shizuku 激活"), NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription(Tr.t("无线调试配对码输入框、激活结果"));
        c.getSystemService(NotificationManager.class).createNotificationChannel(ch);
        flushStaleNote(c);
    }

    /**
     * 进程刚起来不可能有配对线程在跑，上个进程留下的「配对中…」都是孤儿。
     * 光 cancel 不够：实测（联想 ZUI，Android 15）通知服务里早就没有这条了，下拉栏里却还挂着、划不掉 ——
     * 是 SystemUI 自己留的残影（以前用 CATEGORY_CALL + fullScreenIntent，应用被升级 / 杀掉时取消没传到它那份）。
     * 对同一个键先发一条静默的再取消，SystemUI 收到「更新→删除」才会把残影丢掉。
     * 带输入框、还在等配对码的那条（通知服务里真实存在、没有进度标记）留着，它的广播会把流程重新拉起来。
     */
    private void flushStaleNote(Context c) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        try {
            for (android.service.notification.StatusBarNotification n : nm.getActiveNotifications())
                if (n.getId() == NOTE && !n.getNotification().extras.getBoolean(EXTRA_PROGRESS)) return;
            NotificationChannel q = new NotificationChannel(CH_QUIET, Tr.t("Shizuku（静默）"), NotificationManager.IMPORTANCE_MIN);
            nm.createNotificationChannel(q);
            nm.notify(NOTE, new Notification.Builder(c, CH_QUIET).setSmallIcon(android.R.drawable.ic_secure)
                .setContentTitle("Shizuku").setOnlyAlertOnce(true).build());
            // 通知服务的 notify 是异步入队的：紧跟着 cancel 会把还在队里的那条直接撤掉，SystemUI 根本收不到更新。
            // 隔一会儿再撤（实测立即撤残影不消失）
            new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> nm.cancel(NOTE), 1500);
        } catch (Exception ignored) {}
    }

    private static final String CH_QUIET = "shizuku_quiet";

    private static final String EXTRA_PROGRESS = "cc.codroid.progress";

    /** 用户退出应用：收起配对 / 激活通知，不然常驻通知会一直挂着 */
    void onExit() { cancelNote(); }

    SharedPreferences prefs() { return ctx.getSharedPreferences("shz", Context.MODE_PRIVATE); }
    boolean hasWss() { return ctx.checkSelfPermission(WSS) == PackageManager.PERMISSION_GRANTED; }

    void put(JSONObject o) throws Exception {
        JSONArray lg;
        synchronized (ring) { lg = new JSONArray(ring); }
        o.put("setup", new JSONObject().put("phase", phase).put("message", message).put("done", done).put("total", total).put("log", lg));
        o.put("autostart", prefs().getBoolean("autostart", false));
        o.put("paired", prefs().getBoolean("paired", false));
        o.put("pairOk", pairOk);
        if (Priv.running()) verifyPairAsync();
        o.put("wss", hasWss());
        // 这次开机有没有收到 BOOT_COMPLETED（国产 ROM 的"自启动管理"会拦）。配对之后重启过才有意义
        long bootAt = System.currentTimeMillis() - android.os.SystemClock.elapsedRealtime();
        SharedPreferences sp = prefs();
        o.put("bootMissed", sp.getBoolean("paired", false) && sp.getBoolean("autostart", false)
            && bootAt > sp.getLong("pairedAt", Long.MAX_VALUE) && sp.getLong("bootSeen", 0) < bootAt);
        o.put("bootAt", bootAt / 60000);                     // 本次开机的分钟数：前端据此把「我已允许」记到下次开机
        o.put("wireless", Build.VERSION.SDK_INT >= 30);
    }

    private void set(String p, String m) {
        phase = p; message = m == null ? "" : m;
        log(p + " " + message);
    }

    /** 最近的诊断记录（设置页可展开看；有的 ROM 不让读 logcat） */
    private final java.util.ArrayDeque<String> ring = new java.util.ArrayDeque<>();
    void log(String m) {
        Log.i(TAG, m);
        synchronized (ring) {
            ring.addLast(new java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.ROOT).format(new java.util.Date()) + " " + m);
            while (ring.size() > 40) ring.removeFirst();
        }
    }

    // ── 下载 + 安装 ──────────────────────────────────────────────────────
    void install(boolean thenActivate) {
        synchronized (this) { if (busy) return; busy = true; }
        startInstall(thenActivate);
    }
    /** 调用方已经占着 busy：下载安装线程接手，跑完由它放掉 */
    private void startInstall(boolean thenActivate) {
        activateAfterInstall = thenActivate;
        new Thread(() -> {
            try {
                set("downloading", Tr.t("获取 Shizuku 最新版…"));
                JSONObject rel = new JSONObject(new String(Installer.httpGetSmall("https://api.github.com/repos/RikkaApps/Shizuku/releases/latest"), StandardCharsets.UTF_8));
                JSONArray as = rel.getJSONArray("assets");
                JSONObject a = null;
                for (int i = 0; i < as.length(); i++) if (as.getJSONObject(i).optString("name").endsWith(".apk")) { a = as.getJSONObject(i); break; }
                if (a == null) throw new Exception(Tr.f("Shizuku {0} 里没有 APK", rel.optString("tag_name")));
                File f = new File(env.files, "updates/shizuku.apk");
                done = 0; total = a.optLong("size");
                set("downloading", Tr.f("下载 Shizuku {0}…", rel.optString("tag_name")));
                new Installer(env, new Installer.Progress() {
                    public void step(String m) { if (m.startsWith("  ")) message = m.trim(); }
                    public void bytes(long d, long t) { done = d; total = t; }
                }).download(a.getString("browser_download_url"), f, a.optLong("size"), null);
                PackageInfo p = Apk.archiveInfo(ctx, f);
                if (p == null || !Priv.MANAGER.equals(p.packageName)) { f.delete(); throw new Exception(Tr.t("下载的不是 Shizuku 安装包")); }
                if (!PIN.equals(Apk.signer(p))) { f.delete(); throw new Exception(Tr.t("Shizuku 安装包的签名不是官方的，拒绝安装")); }
                set("installing", Tr.t("在系统弹窗里点「安装」（第一次需要先允许 cccodroid 安装应用）"));
                Apk.install(ctx, f, "shizuku");
            } catch (Exception e) {
                set("error", Tr.t("装 Shizuku 失败：") + e.getMessage() + Tr.t("。也可以去 https://shizuku.rikka.app/download/ 手动下载"));
            } finally {
                // 下载期间又点了「激活」（排队了）：交给装好之后的 onInstalled 去激活，别留在队列里等下一次 idle
                // 才冒出来；这里也不能走 idle()：系统安装框还没点，马上激活会再下一份（DeepSeek 复核 b7 低-8）
                synchronized (ShizukuSetup.this) { busy = false; if (activateQueued) { activateQueued = false; activateAfterInstall = true; } }
            }
        }, "shz-install").start();
    }

    void onInstalled(boolean ok, String msg) {
        new File(env.files, "updates/shizuku.apk").delete();
        if (!ok) { set("error", Tr.t("没装上：") + msg); return; }
        set("idle", Tr.t("✓ Shizuku 已安装"));
        if (activateAfterInstall) activate();
    }

    // ── 激活 ───────────────────────────────────────────────────────────
    /** 用户点的"激活"。正在忙（比如自动重新激活还在跑）就排队，等这一轮结束接着来，不悄悄吞掉 */
    void activate() {
        synchronized (this) {
            if (busy) { activateQueued = true; log("上一步还在进行，激活排队中"); return; }
            busy = true;
        }
        new Thread(() -> {
            try { doActivate(); }
            catch (Exception e) { set("error", e.getMessage()); }
            finally { if (handedOff) handedOff = false; else idle(); }
        }, "shz-activate").start();
    }

    private void idle() {
        boolean again;
        synchronized (this) { busy = false; again = activateQueued && !Priv.granted(); activateQueued = false; }
        if (again) activate();
    }

    private volatile boolean handedOff;   // 这一轮激活把 busy 交给了安装线程（见 doActivate）
    private void doActivate() throws Exception {
        // 没装：busy 直接交给安装线程（审查 #107 09-014）。以前先放掉再 install 重新占，激活线程收尾时又把它清了，
        // 下载还在跑就能再点出一份下载 / 安装
        if (!Priv.installed()) { handedOff = true; startInstall(true); return; }
        if (Priv.running()) { requestPermission(); return; }
        if (Build.VERSION.SDK_INT < 30) {
            set("error", Tr.t("安卓 11 以下没有无线调试，需要用电脑执行一次：adb shell ") + starter()); return;
        }
        if (Settings.Global.getInt(ctx.getContentResolver(), Settings.Global.DEVELOPMENT_SETTINGS_ENABLED, 0) == 0) {
            set("need_dev", Tr.t("先打开「开发者选项」：设置 → 关于手机 → 连点「版本号」7 次。开好后回来再点一次「激活」"));
            startActivity(new Intent(Settings.ACTION_DEVICE_INFO_SETTINGS));
            return;
        }
        if (!onWifi()) { set("need_wifi", Tr.t("无线调试要连着 Wi‑Fi 才能用（不需要能上网）。连上 Wi‑Fi 后再点「激活」")); return; }
        if (connectAndStart()) return;
        startPairing();
    }

    /** 已配对过的情况：开无线调试（有 WRITE_SECURE_SETTINGS 时自己开）→ 连 → 起服务。成功返回 true */
    private boolean connectAndStart() throws Exception {
        if (wirelessOn() == 0 && hasWss()) {
            set("connecting", Tr.t("打开无线调试…"));
            Settings.Global.putInt(ctx.getContentResolver(), "adb_wifi_enabled", 1);
            for (int i = 0; i < 20 && wirelessOn() == 0; i++) Thread.sleep(250);
            Thread.sleep(1500);   // adbd 要一点时间开始监听、广播服务
        }
        if (wirelessOn() == 0) { log("无线调试没开，也没有 WRITE_SECURE_SETTINGS 去开它"); return false; }
        set("connecting", Tr.t("寻找本机的无线调试端口…"));
        boolean[] untrusted = new boolean[1];
        String serial = trustedSerial(untrusted);
        if (serial != null) {
            markPaired();    // 钥匙被信任了（不管是哪次配对的）：重启后能自动来
            startServer(serial);
            return true;
        }
        // 端口在、却连不上：本机已不再信任我们的 adb 钥匙（在无线调试里被"取消保存"了），得重新配对
        if (untrusted[0] && prefs().getBoolean("paired", false)) { prefs().edit().putBoolean("paired", false).apply(); log("钥匙不再被信任，需要重新配对"); }
        return false;
    }

    /** 找一个认我们钥匙的无线调试端口，连上并返回 serial；没有返回 null。有端口拒绝我们时 untrusted[0]=true */
    private String trustedSerial(boolean[] untrusted) throws Exception {
        List<Integer> ports = discover("_adb-tls-connect._tcp", 8000);
        // mDNS 找不到（实测开着 VPN 时就找不到）：扫本机回环口，认出回 STLS 的那个端口
        if (ports.isEmpty()) { log("mDNS 没找到，改扫本机端口"); ports = probeLocalAdb(); }
        log("连接端口候选 " + ports);
        for (int port : ports) {
            String serial = "127.0.0.1:" + port;
            String out = adb(20, "connect", serial);
            if (!out.contains("connected to")) { untrusted[0] = true; continue; }
            String st = adb(10, "-s", serial, "get-state").trim();
            if (st.equals("device")) return serial;
            adb(10, "disconnect", serial); log(serial + " 状态 " + st);
            return null;
        }
        return null;
    }

    private void markPaired() {
        if (!prefs().getBoolean("paired", false)) prefs().edit().putBoolean("paired", true).putLong("pairedAt", System.currentTimeMillis()).apply();
    }

    private void startPairing() {
        pairPort = -1;
        pairSeen.clear();
        startPairDiscovery();
        set("pairing", Tr.t("第一次需要配对：在打开的设置里进「无线调试」→ 打开它 →「使用配对码配对设备」。屏幕顶部会一直悬着 cccodroid 的通知，点「填配对码」，把 6 位码和配对框里的端口一起填，如 123456 37285（也可以填在这里）"));
        pairNote(Tr.t("在无线调试里点「使用配对码配对设备」，然后点下面的「填配对码」"), true);
        Intent i = new Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS);
        Bundle b = new Bundle();
        b.putString(":settings:fragment_args_key", "toggle_adb_wireless");     // 设置里高亮"无线调试"那一项
        i.putExtra(":settings:fragment_args_key", "toggle_adb_wireless");
        i.putExtra(":settings:show_fragment_args", b);
        startActivity(i);
    }

    /**
     * 配对码：来自通知栏输入框或设置页。码和配对框里显示的端口必须一起填，如 "123456 37285" 或 "123456 10.10.14.1:37285"。
     * 不再按 mDNS 找到的端口自动发码：别的应用可以冒充唯一一个配对服务、拿到码后自己去配对（审查 v0.5.4 H1-1）。
     * mDNS 现在只用来提示「配对框出现了」。
     */
    void onCode(String input) { onCode(input, null); }

    /**
     * @param done 流程结束时调用（通知栏的广播靠它挂住）。最多挂 8 秒：通知动作发来的是前台广播，
     *             超过 10 秒系统就弹"应用无响应"（实测：配对→启动全程 16 秒，弹了 ANR 框）。
     *             8 秒够把 adb pair 做完（实测 1–2 秒），后面的连接、启动在没挂广播的情况下继续
     */
    void onCode(String input, Runnable done) {
        java.util.concurrent.atomic.AtomicBoolean fired = new java.util.concurrent.atomic.AtomicBoolean();
        Runnable fin = () -> { if (done != null && fired.compareAndSet(false, true)) done.run(); };
        if (done != null) new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(fin, 8_000);
        String c = "";
        int port = -1;
        for (String tok : (input == null ? "" : input).split("[^0-9]+")) {
            if (tok.length() == 6 && c.isEmpty()) c = tok;
            else if (tok.length() >= 4 && tok.length() <= 5) port = Integer.parseInt(tok);
        }
        if (c.isEmpty()) { pairNote(Tr.t("配对码是 6 位数字，再填一次"), true); set("pairing", Tr.t("配对码是 6 位数字")); fin.run(); return; }
        synchronized (this) {
            if (busy) { fin.run(); return; }
            busy = true;
        }
        final String code = c;
        final int given = port;
        new Thread(() -> {
            try {
                set("pairing", Tr.t("配对中…"));
                pairNote(Tr.t("配对中…"), false);
                // 端口只认用户照配对框填的：只有一个配对服务也可能是冒充的，自动发码等于把码交出去
                if (given <= 0) {
                    set("pairing", Tr.f("为防别的应用冒充配对服务，码要和端口一起填：端口是配对框里「IP 地址和端口」冒号后面那串数字，如 {0}", code + " 37285"));
                    pairNote(Tr.f("码和端口一起填，如 {0}（端口在配对框里）", code + " 37285"), true);
                    return;
                }
                pairPort = given;
                String out = adb(30, "pair", "127.0.0.1:" + pairPort, code);
                if (!out.contains("Successfully paired")) {
                    set("pairing", Tr.f("配对没成功（{0}）。码可能过期了：重新点「使用配对码配对设备」，填新码", out.trim()));
                    pairNote(Tr.t("配对没成功，填新的配对码"), true);
                    return;
                }
                // 「配对成功」是对方说的：冒充的配对服务也能这么回（审查 v0.5.3 H1 残余）。
                // 连上无线调试、确认钥匙真被信任了才记 paired、才报成功
                stopPairDiscovery();
                if (Priv.running()) {     // 只是补配对（Shizuku 本来就在跑）：不用重启它
                    String s = trustedSerial(new boolean[1]);
                    if (s == null) { failNote(Tr.t("配对回了成功，但本机的无线调试不认我们的钥匙，配对可能被别的应用截了。到「无线调试」里取消多出来的配对设备，再重新配对")); return; }
                    adb(10, "disconnect", s);
                    markPaired();
                    pairOk = 1; pairCheckedAt = System.currentTimeMillis();
                    cancelNote();
                    set("done", Tr.t("✓ 已重新配对。重启手机后会自动激活（需连着 Wi‑Fi）"));
                    return;
                }
                pairNote(Tr.t("✓ 配对成功，正在启动 Shizuku…"), false);
                Thread.sleep(1500);
                if (!connectAndStart()) { failNote(Tr.t("配对回了成功，但连不上无线调试：确认「无线调试」开关开着再点「激活」；还不行就到「无线调试」里取消多出来的配对设备，重新配对")); return; }
                pairOk = 1; pairCheckedAt = System.currentTimeMillis();
            } catch (Exception e) {
                // 别只改状态：通知还停在常驻的「配对中…」，用户划不掉
                failNote(Tr.t("配对出错：") + e.getMessage());
            } finally { idle(); fin.run(); }
        }, "shz-pair").start();
    }

    private void startServer(String serial) throws Exception {
        set("starting", Tr.t("启动 Shizuku 服务…"));
        String out = adb(40, "-s", serial, "shell", starter());
        adb(10, "disconnect", serial);
        for (int i = 0; i < 60 && !Priv.running(); i++) Thread.sleep(250);
        if (!Priv.running()) throw new Exception(Tr.t("Shizuku 没起来：") + tail(out));
        cancelNote();
        requestPermission();
    }

    private String starter() throws Exception {
        return ctx.getPackageManager().getApplicationInfo(Priv.MANAGER, 0).nativeLibraryDir + "/libshizuku.so";
    }

    private void requestPermission() {
        if (Priv.granted()) { onPermission(true); return; }
        set("permission", Tr.t("Shizuku 已启动：在弹窗里点「允许」"));
        try { Shizuku.requestPermission(Priv.REQ); } catch (Throwable t) { set("error", Tr.t("请求授权失败：") + t); }
    }

    /** Priv 的授权回调转过来 */
    void onPermission(boolean ok) {
        if (!ok) { set("error", Tr.t("Shizuku 授权被拒绝了。再点「授权」重试")); return; }
        if (!hasWss()) log("grant WSS → " + Priv.run("pm grant " + ctx.getPackageName() + " " + WSS));
        set("done", hasWss() ? Tr.t("✓ 已激活。重启手机后会自动重新激活（需连着 Wi‑Fi）") : Tr.t("✓ 已激活"));
        cancelNote();
    }

    /**
     * 重启后、或 Shizuku 被杀后自动重新激活。条件：用户没关这个开关、配对过、有 WRITE_SECURE_SETTINGS。
     * 开机时 Wi‑Fi 可能还没连上，最多等 3 分钟。
     */
    void reactivateAsync(boolean boot) {
        if (!prefs().getBoolean("autostart", false) || !prefs().getBoolean("paired", false) || !hasWss()) return;
        if (Build.VERSION.SDK_INT < 30 || !Priv.installed()) return;
        new Thread(() -> {
            try {
                if (boot) Thread.sleep(10_000);
                for (int i = 0; i < 18 && !onWifi(); i++) Thread.sleep(10_000);
                if (Priv.running() || busy) return;
                busy = true;
                try {
                    if (!onWifi()) { failNote(Tr.t("没连 Wi‑Fi，Shizuku 没能自动激活。连上 Wi‑Fi 后点此重试")); return; }
                    if (!connectAndStart()) failNote(Tr.t("Shizuku 自动激活没成功，点此重试"));
                } finally { idle(); }
            } catch (Exception e) {
                failNote(Tr.t("Shizuku 自动激活失败：") + e.getMessage());
            }
        }, "shz-reactivate").start();
    }

    /** 配对是否仍被信任：1 有效、0 失效、-1 没验证过 */
    private volatile int pairOk = -1;
    private volatile long pairCheckedAt;

    /**
     * 打开设置页时静默验证一次配对（最多 5 分钟一次）：删掉无线调试里的配对不会停掉正在跑的 Shizuku，
     * 要到下次重启自动激活时才发现。只在无线调试本来就开着时验证，不为此去开关它。
     */
    void verifyPairAsync() {
        if (!prefs().getBoolean("paired", false) || Build.VERSION.SDK_INT < 30 || busy) return;
        if (System.currentTimeMillis() - pairCheckedAt < 5 * 60_000L || wirelessOn() == 0) return;
        pairCheckedAt = System.currentTimeMillis();
        new Thread(() -> {
            synchronized (this) { if (busy) return; busy = true; }
            try {
                List<Integer> ports = discover("_adb-tls-connect._tcp", 6000);
                if (ports.isEmpty()) ports = probeLocalAdb();
                for (int port : ports) {
                    String serial = "127.0.0.1:" + port;
                    String out = adb(15, "connect", serial);
                    boolean ok = out.contains("connected to") && adb(10, "-s", serial, "get-state").trim().equals("device");
                    adb(10, "disconnect", serial);
                    pairOk = ok ? 1 : 0;
                    if (!ok) { prefs().edit().putBoolean("paired", false).apply(); log("配对已失效（无线调试里被取消保存了）"); }
                    return;
                }
            } catch (Exception e) { log("验证配对出错：" + e.getMessage()); }
            finally { idle(); }
        }, "shz-verify").start();
    }

    /** 用户点"重新配对"：Shizuku 在跑也照样走配对 */
    void repair() {
        synchronized (this) { if (busy) { activateQueued = false; return; } busy = true; }
        new Thread(() -> {
            try {
                if (Build.VERSION.SDK_INT < 30) { set("error", Tr.t("安卓 11 以下没有无线调试")); return; }
                if (!onWifi()) { set("need_wifi", Tr.t("无线调试要连着 Wi‑Fi 才能用。连上 Wi‑Fi 后再点「重新配对」")); return; }
                startPairing();
            } finally { idle(); }
        }, "shz-repair").start();
    }

    void setAutostart(boolean on) { prefs().edit().putBoolean("autostart", on).apply(); }

    // ── 工具 ───────────────────────────────────────────────────────────
    private boolean onWifi() {
        ConnectivityManager cm = ctx.getSystemService(ConnectivityManager.class);
        NetworkCapabilities nc = cm.getNetworkCapabilities(cm.getActiveNetwork());
        if (nc != null && nc.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) return true;
        // 走蜂窝上网但 Wi‑Fi 也连着（"WLAN 助理"之类）：看所有网络
        for (android.net.Network n : cm.getAllNetworks()) {
            NetworkCapabilities c = cm.getNetworkCapabilities(n);
            if (c != null && c.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) return true;
        }
        return false;
    }

    private int wirelessOn() { return Settings.Global.getInt(ctx.getContentResolver(), "adb_wifi_enabled", 0); }

    /** 跑工具包里的 adb，返回合并后的输出；超时就杀掉 */
    private String adb(int timeoutSec, String... args) throws Exception {
        List<String> cmd = new ArrayList<>();
        cmd.add(env.bin("adb").getPath());
        Collections.addAll(cmd, args);
        ProcessBuilder pb = new ProcessBuilder(env.cmd(cmd.toArray(new String[0])));
        env.apply(pb.environment());
        pb.directory(env.home);
        pb.redirectErrorStream(true);
        Process p = pb.start();
        p.getOutputStream().close();
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        Thread rd = new Thread(() -> {
            try (InputStream in = p.getInputStream()) { byte[] b = new byte[4096]; for (int n; (n = in.read(b)) > 0; ) synchronized (bo) { bo.write(b, 0, n); } }
            catch (Exception ignored) {}
        });
        rd.start();
        if (!p.waitFor(timeoutSec, TimeUnit.SECONDS)) p.destroyForcibly();
        rd.join(2000);
        String out;
        synchronized (bo) { out = bo.toString("UTF-8"); }
        log("adb " + String.join(" ", args).replaceAll("\\b\\d{6}$", "******") + " → " + tail(out));
        return out;
    }

    /** 找本机广播的 mDNS 服务端口。局域网里别的设备也可能在广播：优先地址是本机的那些 */
    private List<Integer> discover(String type, long ms) throws Exception {
        NsdManager nm = ctx.getSystemService(NsdManager.class);
        List<NsdServiceInfo> found = Collections.synchronizedList(new ArrayList<>());
        NsdManager.DiscoveryListener l = new Disc(found, null);
        nm.discoverServices(type, NsdManager.PROTOCOL_DNS_SD, l);
        // 等到第一个出现后再多等 1 秒（同类服务一般一起冒出来），最多等 ms
        long t0 = System.currentTimeMillis(), first = 0;
        while (System.currentTimeMillis() - t0 < ms) {
            if (first == 0 && !found.isEmpty()) first = System.currentTimeMillis();
            if (first > 0 && System.currentTimeMillis() - first > 1000) break;
            Thread.sleep(100);
        }
        try { nm.stopServiceDiscovery(l); } catch (Exception ignored) {}
        Set<String> mine = localAddrs();
        List<Integer> local = new ArrayList<>(), other = new ArrayList<>();
        for (NsdServiceInfo s : new ArrayList<>(found)) {
            NsdServiceInfo r = resolve(nm, s);
            if (r == null || r.getPort() <= 0) continue;
            InetAddress h = r.getHost();
            log("发现 " + s.getServiceName() + " → " + (h == null ? "?" : h.getHostAddress()) + ":" + r.getPort());
            (h != null && mine.contains(h.getHostAddress()) ? local : other).add(r.getPort());
        }
        local.addAll(other);      // 连 127.0.0.1:端口 —— 别人的端口在本机上连不上，顶多白试一次
        return local;
    }

    /**
     * 扫 127.0.0.1 上开着的端口，挑出无线调试的 adbd：发一个 ADB CNXN 包，它会回 STLS（要求升级 TLS）。
     * 回环口上被拒绝的连接立即返回，64 个线程扫完 1024–65535 只要几秒。
     */
    private List<Integer> probeLocalAdb() throws Exception {
        java.util.concurrent.ExecutorService pool = java.util.concurrent.Executors.newFixedThreadPool(64);
        List<Integer> hits = Collections.synchronizedList(new ArrayList<>());
        java.util.concurrent.atomic.AtomicInteger next = new java.util.concurrent.atomic.AtomicInteger(1024);
        for (int t = 0; t < 64; t++) pool.execute(() -> {
            for (int p; (p = next.getAndIncrement()) <= 65535; ) {
                if (p == Env.PORT || p == 5037) continue;
                try (java.net.Socket so = new java.net.Socket()) {
                    so.connect(new java.net.InetSocketAddress("127.0.0.1", p), 200);
                    so.setSoTimeout(800);
                    so.getOutputStream().write(cnxn());
                    byte[] h = new byte[4];
                    int n = so.getInputStream().read(h);
                    if (n == 4 && (h[0] == 'S' && h[1] == 'T' && h[2] == 'L' && h[3] == 'S')) hits.add(p);
                } catch (Exception ignored) {}
            }
        });
        pool.shutdown();
        pool.awaitTermination(60, TimeUnit.SECONDS);
        return new ArrayList<>(hits);
    }

    /** ADB 协议的 CNXN 消息：24 字节头（小端）+ "host::\0" */
    private static byte[] cnxn() {
        byte[] body = "host::\0".getBytes(StandardCharsets.US_ASCII);
        java.nio.ByteBuffer b = java.nio.ByteBuffer.allocate(24 + body.length).order(java.nio.ByteOrder.LITTLE_ENDIAN);
        int cmd = 0x4e584e43, sum = 0;
        for (byte x : body) sum += x & 0xff;
        b.putInt(cmd).putInt(0x01000001).putInt(256 * 1024).putInt(body.length).putInt(sum).putInt(cmd ^ 0xffffffff).put(body);
        return b.array();
    }

    /** 配对对话框开着的期间持续监听：配对服务只在对话框显示时存在 */
    private synchronized void startPairDiscovery() {
        stopPairDiscovery();
        NsdManager nm = ctx.getSystemService(NsdManager.class);
        Set<String> mine = localAddrs();
        Disc d = new Disc(null, s -> {
            NsdServiceInfo r = resolve(nm, s);
            if (r == null || r.getPort() <= 0) return;
            pairSeen.put(s.getServiceName(), r.getPort());
            InetAddress h = r.getHost();
            if (h == null || mine.isEmpty() || mine.contains(h.getHostAddress()) || pairPort <= 0) {
                boolean fresh = pairPort != r.getPort();
                pairPort = r.getPort();
                if (fresh && "pairing".equals(phase)) pairNote(Tr.t("配对框出现了：点「填配对码」，填 6 位码和配对框里的端口"), true);
            }
            log("配对服务 " + s.getServiceName() + " → " + (h == null ? "?" : h.getHostAddress()) + ":" + r.getPort());
        });
        d.lost = s -> pairSeen.remove(s.getServiceName());     // 配对框关了，服务就没了；重开会换新端口
        pairDisc = d;
        nm.discoverServices("_adb-tls-pairing._tcp", NsdManager.PROTOCOL_DNS_SD, pairDisc);
    }
    private synchronized void stopPairDiscovery() {
        if (pairDisc == null) return;
        try { ctx.getSystemService(NsdManager.class).stopServiceDiscovery(pairDisc); } catch (Exception ignored) {}
        pairDisc = null;
    }

    interface OnFound { void found(NsdServiceInfo s); }
    private static final class Disc implements NsdManager.DiscoveryListener {
        final List<NsdServiceInfo> sink; final OnFound cb; volatile OnFound lost;
        Disc(List<NsdServiceInfo> sink, OnFound cb) { this.sink = sink; this.cb = cb; }
        public void onStartDiscoveryFailed(String t, int e) { if (inst != null) inst.log("NSD 启动失败 " + t + " " + e); }
        public void onStopDiscoveryFailed(String t, int e) {}
        public void onDiscoveryStarted(String t) {}
        public void onDiscoveryStopped(String t) {}
        public void onServiceFound(NsdServiceInfo s) {
            if (inst != null) inst.log("NSD 发现 " + s.getServiceType() + " " + s.getServiceName());
            if (sink != null) sink.add(s);
            if (cb != null) new Thread(() -> cb.found(s), "nsd-resolve").start();
        }
        public void onServiceLost(NsdServiceInfo s) { if (lost != null) lost.found(s); }
    }

    /** resolveService 同一时间只能有一个在跑（否则 FAILURE_ALREADY_ACTIVE），所以串行 */
    @SuppressWarnings("deprecation")
    private static synchronized NsdServiceInfo resolve(NsdManager nm, NsdServiceInfo s) {
        final NsdServiceInfo[] out = new NsdServiceInfo[1];
        CountDownLatch done = new CountDownLatch(1);
        try {
            nm.resolveService(s, new NsdManager.ResolveListener() {
                public void onResolveFailed(NsdServiceInfo i, int e) { if (inst != null) inst.log("resolve 失败 " + i.getServiceName() + " " + e); done.countDown(); }
                public void onServiceResolved(NsdServiceInfo i) { out[0] = i; done.countDown(); }
            });
            done.await(5, TimeUnit.SECONDS);
        } catch (Exception e) { Log.w(TAG, "resolve", e); }
        return out[0];
    }

    private static Set<String> localAddrs() {
        Set<String> s = new HashSet<>();
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces()))
                for (InetAddress a : Collections.list(ni.getInetAddresses())) s.add(a.getHostAddress());
        } catch (Exception ignored) {}
        return s;
    }

    private void startActivity(Intent i) {
        try { ctx.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); }
        catch (Exception e) { Log.w(TAG, "打不开设置页", e); }
    }

    // ── 通知 ───────────────────────────────────────────────────────────
    private void pairNote(String text, boolean withInput) {
        Notification.Builder b = new Notification.Builder(ctx, CH)
            .setSmallIcon(android.R.drawable.ic_secure)
            .setContentTitle(Tr.t("Shizuku 无线调试配对"))
            .setContentText(text)
            .setStyle(new Notification.BigTextStyle().bigText(text))
            .setOnlyAlertOnce(false)
            // 不能用 CATEGORY_CALL：「来电」类通知在部分 ROM 的 SystemUI 里被特殊钉住，取消传不到，留下划不掉的残影
            .setCategory(withInput ? Notification.CATEGORY_REMINDER : Notification.CATEGORY_PROGRESS)
            // 过期由系统收：进程被厂商冻结器冻住 / 被杀时我们的代码根本跑不了，常驻通知会一直挂着「配对中…」。
            // 进度类通知允许划掉、90 秒过期；等填码的那条给 10 分钟（配对码本身几分钟就失效）
            .setOngoing(withInput)
            .setTimeoutAfter(withInput ? 600_000 : 90_000);
        if (!withInput) { Bundle x = new Bundle(); x.putBoolean(EXTRA_PROGRESS, true); b.addExtras(x); }
        if (withInput) {
            RemoteInput ri = new RemoteInput.Builder(Events.KEY_CODE).setLabel(Tr.t("6 位配对码 空格 端口")).build();
            int fl = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
            PendingIntent pi = PendingIntent.getBroadcast(ctx, NOTE, new Intent(ctx, Events.class).setAction(Events.ACTION_PAIR), fl);
            b.addAction(new Notification.Action.Builder(null, Tr.t("填配对码"), pi).addRemoteInput(ri).build());
            // 设置页会隐藏其他应用的悬浮窗（安卓 12 起防点击劫持，实测无线调试页也藏），所以输入只能放在通知里；
            // 带 fullScreenIntent 的通知在亮屏使用中会一直悬在顶部、不自动收起 —— 配对码对话框和输入框同时在屏幕上
            b.setFullScreenIntent(PendingIntent.getActivity(ctx, NOTE + 2,
                MainActivity.internal(ctx, MainActivity.ACTION_SHIZUKU_NOOP).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT), true);
        }
        ctx.getSystemService(NotificationManager.class).notify(NOTE, b.build());
    }

    private void failNote(String text) {
        set("error", text);
        PendingIntent pi = PendingIntent.getActivity(ctx, NOTE + 1,
            MainActivity.internal(ctx, MainActivity.ACTION_SHIZUKU).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        ctx.getSystemService(NotificationManager.class).notify(NOTE, new Notification.Builder(ctx, CH)
            .setSmallIcon(android.R.drawable.ic_secure)
            .setContentTitle("Shizuku")
            .setContentText(text)
            .setStyle(new Notification.BigTextStyle().bigText(text))
            .setContentIntent(pi)
            .setAutoCancel(true)
            .build());
    }

    private void cancelNote() { ctx.getSystemService(NotificationManager.class).cancel(NOTE); }

    private static String tail(String s) {
        s = s == null ? "" : s.trim();
        return s.length() > 300 ? "…" + s.substring(s.length() - 300) : s;
    }
}
