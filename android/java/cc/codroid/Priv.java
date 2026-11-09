package cc.codroid;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.net.LocalSocketAddress;
import android.os.Build;
import android.os.Process;
import android.util.Log;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import org.json.JSONArray;
import org.json.JSONObject;
import rikka.shizuku.Shizuku;

/**
 * 经 Shizuku 提权（以 shell 身份 uid 2000 执行命令）。
 *
 * 为什么绕一圈：Shizuku 的 binder 只在本应用的 Java 进程里，而终端里跑的 priv 是普通子进程（bash/node），
 * 拿不到 binder。所以本进程开一个本地套接字当中转：
 *
 *   priv 'cmd'（应用 uid 的子进程）→ 私有目录里的文件套接字 files/.priv.sock（$CCAPP_PRIV_SOCK）
 *     → 本类（核对对端 uid 必须是本应用自己）→ Shizuku.newProcess → shell 身份执行
 *
 * 安全：每个连接先查 SO_PEERCRED —— 不是本应用 uid 的一律断开，别的应用借不到这份权限。
 * 反过来客户端也得确认连的是真服务：以前用抽象套接字 "cc.codroid.priv"，名字全机共享，别的应用抢先绑上就能
 * 收走命令、伪造回应（审查 H2）。文件套接字放在私有目录里，别的应用连路径都进不去，抢不走。
 * 抽象套接字已经关掉（审查 10-29 M2）：客户端 priv.mjs 在 files/app/bin，每次启动按内容哈希从 APK 刷新，不会留旧版。
 *
 * 协议（一问一答）：客户端先发一行 JSON 请求；
 *   op=exec 之后双向走帧：[1 字节类型][4 字节长度 BE][数据]
 *     客户端 → 0=stdin（长度 0 表示 EOF）
 *     服务端 → 1=stdout 2=stderr 3=退出码(4 字节) 4=错误文本
 *   其余 op 回一行 JSON。
 */
final class Priv {
    /** 译文要拼进 sh -c '…' 的双引号里：单双引号换成全角，免得断开命令 */
    static String shq(String s) { return s.replace("'", "’").replace("\"", "”").replace("$", "＄").replace("`", "’"); }

    static final String TAG = "cccodroid-priv";
    static final String MANAGER = "moe.shizuku.privileged.api";
    static final int REQ = 7331;

    private static Context ctx;
    private static volatile boolean started;
    private static volatile String lastPermission = "";

    static synchronized void start(Context c) {
        if (started) return;
        started = true;
        ctx = c.getApplicationContext();
        // Sui（Magisk / KernelSU 模块，提供和 Shizuku 一样的接口，但没有 Shizuku 管理器应用）：先认它，binder 由 Sui 直接递过来（#112）
        try { sui = rikka.sui.Sui.init(ctx.getPackageName()); } catch (Throwable t) { sui = false; }
        if (sui) Log.i(TAG, "检测到 Sui");
        Shizuku.addBinderReceivedListenerSticky(() -> {
            Log.i(TAG, "Shizuku binder 到手 uid=" + safeUid());
            if (Consent.on(ctx, Consent.KEEPALIVE) && granted()) {
                new Thread(() -> keepAlive(true), "keepalive").start();
            }
        });
        Shizuku.addBinderDeadListener(() -> Log.w(TAG, "Shizuku binder 断了"));
        Shizuku.addRequestPermissionResultListener((code, result) -> {
            lastPermission = result == PackageManager.PERMISSION_GRANTED ? "granted" : "denied";
            ShizukuSetup.get(ctx).onPermission(result == PackageManager.PERMISSION_GRANTED);
            if (result == PackageManager.PERMISSION_GRANTED && Consent.on(ctx, Consent.KEEPALIVE)) {
                new Thread(() -> keepAlive(true), "keepalive").start();
            }
        });
        Consent.dropLegacy(ctx);
        new Thread(Priv::serveFile, "priv-server-fs").start();
    }

    static File sockFile(Context c) { return new File(c.getFilesDir(), ".priv.sock"); }
    private static LocalSocket fsSock;   // 留着引用：被回收时会把监听的 fd 一起关掉

    private static void serveFile() {
        File f = sockFile(ctx);
        LocalServerSocket ss;
        try {
            f.delete();                    // 上一个进程留下的套接字文件，不删 bind 会报地址已占用
            LocalSocket b = new LocalSocket();
            b.bind(new LocalSocketAddress(f.getPath(), LocalSocketAddress.Namespace.FILESYSTEM));
            ss = new LocalServerSocket(b.getFileDescriptor());
            fsSock = b;
            android.system.Os.chmod(f.getPath(), 0600);
        } catch (Exception e) { Log.e(TAG, "开不了文件套接字", e); return; }
        acceptLoop(ss);
    }

    private static SharedPreferences prefs() { return ctx.getSharedPreferences("priv", Context.MODE_PRIVATE); }

    // ── 状态 ───────────────────────────────────────────────────────────
    private static volatile boolean sui;
    static boolean sui() { return sui; }
    static boolean installed() {
        if (sui) return true;
        try { ctx.getPackageManager().getPackageInfo(MANAGER, 0); return true; }
        catch (Exception e) { return false; }
    }
    static boolean running() {
        try { return Shizuku.pingBinder(); } catch (Throwable t) { return false; }
    }
    static boolean granted() {
        try { return running() && !Shizuku.isPreV11() && Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED; }
        catch (Throwable t) { return false; }
    }
    /**
     * 实测：真起一个进程跑 id -u。Shizuku 客户端库会缓存"已授权"（在 Shizuku 里撤销后我们这边不刷新），
     * 设置页显示的"已就绪"以它为准。结果缓存 10 秒，设置页 1.5 秒一轮的刷新不至于狂起进程。
     */
    private static volatile long verifiedAt;
    private static volatile boolean verifiedOk;
    static boolean verified() {
        if (!granted()) return false;
        if (System.currentTimeMillis() - verifiedAt < 10_000) return verifiedOk;
        boolean ok;
        try {
            java.lang.Process p = newProcess(new String[]{"id", "-u"}, null, "/");
            p.getOutputStream().close();
            String out = new String(readAll(p.getInputStream()), StandardCharsets.UTF_8).trim();
            ok = p.waitFor() == 0 && (out.equals("2000") || out.equals("0"));
        } catch (Throwable t) { ok = false; }
        verifiedOk = ok; verifiedAt = System.currentTimeMillis();
        return ok;
    }

    private static int safeUid() { try { return Shizuku.getUid(); } catch (Throwable t) { return -1; } }

    static JSONObject status() throws Exception {
        JSONObject o = new JSONObject();
        boolean ins = installed(), run = ins && running(), ok = run && verified();
        o.put("state", !ins ? "not_installed" : !run ? "not_running" : !ok ? "no_permission" : "ok");
        o.put("installed", ins);
        o.put("sui", sui);
        long naUntil = noAskUntil();
        o.put("noask", naUntil > 0);
        if (naUntil > 0) o.put("noaskUntil", naUntil);
        o.put("running", run);
        o.put("granted", ok);
        if (run) {
            try { o.put("version", Shizuku.getVersion()); } catch (Throwable ignored) {}
            o.put("uid", safeUid());     // 2000 = adb 方式启动，0 = root 方式
        }
        o.put("keepalive", Consent.on(ctx, Consent.KEEPALIVE));
        o.put("lastPermission", lastPermission);
        ShizukuSetup.get(ctx).put(o);
        SharedPreferences bg = ctx.getSharedPreferences("bg", Context.MODE_PRIVATE);
        o.put("frozen", new JSONObject().put("at", bg.getLong("frozenAt", 0)).put("ms", bg.getLong("frozenMs", 0))
            .put("count", bg.getInt("frozenCount", 0)).put("vendor", Build.MANUFACTURER.toLowerCase(java.util.Locale.ROOT)));
        return o;
    }

    // ── 执行 ───────────────────────────────────────────────────────────
    /** Shizuku.newProcess 在 13.x 里是 private（官方想让人改用 UserService），
     *  但它正是 rish 用的那条路，最直接；反射拿出来用。 */
    private static java.lang.Process newProcess(String[] argv, String[] envp, String dir) throws Exception {
        Method m = Shizuku.class.getDeclaredMethod("newProcess", String[].class, String[].class, String.class);
        m.setAccessible(true);
        return (java.lang.Process) m.invoke(null, argv, envp, dir);
    }

    /**
     * 把界面叫回前台（官方账户登录在浏览器里授权完，回调落在 claude 的托管页上，用户不知道该回哪）。
     * 安卓 10 起后台不许直接起 Activity：有 Shizuku 就以 shell 身份 am start（不受这条限制）；
     * 没有就弹一条高优先级通知，点一下回来。返回走的是哪条路
     */
    static String toFront(Context ctx, String text) {
        String cmp = ctx.getPackageName() + "/" + MainActivity.class.getName();
        // am start 成功时也有输出（Starting: Intent …），按退出码和有没有报错判断（11-04 报告 A3：以前看输出是否为空，恒走通知）
        if (running() && granted() && amStarted(runRc("am start --activity-reorder-to-front -n " + cmp))) return "shizuku";
        android.app.NotificationManager nm = ctx.getSystemService(android.app.NotificationManager.class);
        nm.createNotificationChannel(new android.app.NotificationChannel("front", Tr.t("回到应用"), android.app.NotificationManager.IMPORTANCE_HIGH));
        android.app.PendingIntent pi = android.app.PendingIntent.getActivity(ctx, 41,
            new Intent(ctx, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT),
            android.app.PendingIntent.FLAG_IMMUTABLE | android.app.PendingIntent.FLAG_UPDATE_CURRENT);
        nm.notify(41, new android.app.Notification.Builder(ctx, "front")
            .setSmallIcon(android.R.drawable.ic_secure)
            .setContentTitle(text == null || text.isEmpty() ? "cccodroid" : text)
            .setContentText(Tr.t("点此回到 cccodroid"))
            .setContentIntent(pi).setAutoCancel(true).setTimeoutAfter(120_000).build());
        return "notification";
    }

    /** runRc 的结果（退出码起不来是 "-"，记 -1）交给 PrivRules 判断 am start 成没成 */
    static boolean amStarted(String[] r) { return PrivRules.amStarted("-".equals(r[0]) ? -1 : Integer.parseInt(r[0]), r[1]); }

    /** 跑一条命令拿全部输出（内部用：保活设置） */
    static String run(String cmd) {
        String[] r = runRc(cmd);
        return r[0].equals("0") ? r[1] : r[0].equals("-") ? Tr.t("[失败] ") + r[1] : "[rc=" + r[0] + "] " + r[1];
    }
    /** 同上，退出码单独给：{退出码（起不来是 "-"）, 输出} */
    static String[] runRc(String cmd) {
        try {
            java.lang.Process p = newProcess(new String[]{"/system/bin/sh", "-c", cmd + " 2>&1"}, null, "/");
            p.getOutputStream().close();
            String out = new String(readAll(p.getInputStream()), StandardCharsets.UTF_8).trim();
            return new String[]{String.valueOf(p.waitFor()), out};
        } catch (Throwable t) {
            return new String[]{"-", String.valueOf(t)};
        }
    }

    static final String STAGE_LOG = "/data/local/tmp/cccodroid-update.log";

    /**
     * 静默装自己的新版本。两步走，因为 pm 替换本应用时会杀掉本进程，而 Shizuku 会跟着杀掉本进程开的子进程：
     *   1. 把 APK 流式写到 /data/local/tmp（shell 读不到本应用私有目录，那里它能读写）；
     *   2. setsid 起一个脱离的 shell 去 pm install，装完由它把后台服务拉起来（不靠 MY_PACKAGE_REPLACED ——
     *      国产 ROM 的自启动管理会把这条广播拦掉，实测红魔 SKIPPED）；界面原本开着就把界面也拉起来。
     *      红魔连 shell 起服务都拦（"Blocked by AutoLaunch"），但拉界面不拦：服务起不来时由 shell 发一条通知，点开即恢复。
     * @return 走到返回说明还活着：多半没装上，返回 pm 的输出
     */
    static String pipeInstall(java.io.File apk, boolean reopenUi, String version) {
        try {
            // 文件名带随机数、装之前再核一遍 sha256（审查 10-29 第六份 低6）：固定路径能被别的 shell 进程抢先占住，
            // 或在写完到 pm install 之间换成另一个同签名的包（28 / 36 两种）
            byte[] rb = new byte[8];
            new java.security.SecureRandom().nextBytes(rb);
            final String STAGE = "/data/local/tmp/cccodroid-update-" + Installer.hex(rb) + ".apk";
            String sha = Installer.sha256(apk);
            java.lang.Process p = newProcess(new String[]{"sh", "-c", "rm -f " + STAGE + " && cat > " + STAGE + " && chmod 644 " + STAGE}, null, "/");
            try (InputStream in = new java.io.FileInputStream(apk); OutputStream o = p.getOutputStream()) {
                byte[] buf = new byte[1 << 16];
                for (int n; (n = in.read(buf)) > 0; ) o.write(buf, 0, n);
            }
            if (p.waitFor() != 0) return Tr.t("[失败] 写不进 ") + STAGE;
            String pkg = ctx.getPackageName();
            // 带点击动作的通知有的 ROM 不让 shell 发（红魔：getIntentSender 权限不足），失败就发纯文字的
            String note = "cmd notification post -t \"" + shq(Tr.f("cccodroid 已更新到 v{0}（系统不让它在后台自己启动）", version)) + "\"";
            String notify = "{ " + note + " -c \"activity -n " + pkg + "/.MainActivity\" cccodroid-updated \"" + shq(Tr.t("点此打开即可继续使用")) + "\""
                + " || " + note + " cccodroid-updated \"" + shq(Tr.t("打开 cccodroid 即可继续使用")) + "\"; } >> " + STAGE_LOG + " 2>&1";
            // 拉界面：am start 回「Starting」不等于界面真出来了 —— 刚装完系统还在做安装后扫描（ColorOS 等），
            // 这时的启动会被悄悄丢掉（10-22 用户手机 0.3.11→0.3.12：日志全成功，界面没回来）。
            // 所以先等两秒，起完看本应用有没有在前台，没有就再拉，三次都不行发通知
            String up = "dumpsys activity activities | grep -qE \"ResumedActivity.*" + pkg + "/\"";
            String job = "if [ \"$(sha256sum " + STAGE + " | cut -d\" \" -f1)\" = " + sha + " ]; then pm install -r " + STAGE + " > " + STAGE_LOG + " 2>&1; else echo \"Error: 安装包被换过\" > " + STAGE_LOG + "; fi; rm -f " + STAGE + "; sleep 2; "
                + "am start-foreground-service -n " + pkg + "/.GatewayService >> " + STAGE_LOG + " 2>&1"
                + (reopenUi ? "; ok=; for i in 1 2 3; do am start -W -n " + pkg + "/.MainActivity >> " + STAGE_LOG + " 2>&1; sleep 3; "
                     + "if " + up + "; then ok=1; break; fi; echo \"界面没起来（第 $i 次）\" >> " + STAGE_LOG + "; done; [ -n \"$ok\" ] || " + notify
                   : "; grep -q Error " + STAGE_LOG + " && " + notify);
            run("rm -f " + STAGE_LOG);       // 上一次的结果别被当成这一次的
            run("setsid sh -c '" + job + "' < /dev/null > /dev/null 2>&1 &");
            // 装上的话本进程在这期间就没了。没装上（pm 回 Failure / Error）就别睡满 60 秒：调用方停着网关在等（审查 11-05 #12）
            for (int i = 0; i < 60; i++) {
                Thread.sleep(1000);
                String[] r = runRc("cat " + STAGE_LOG);
                if (r[0].equals("0") && (r[1].contains("Failure") || r[1].contains("Error") || r[1].contains("Exception"))) return r[1];
            }
            return run("cat " + STAGE_LOG);
        } catch (Throwable t) {
            return Tr.t("[失败] ") + t;
        }
    }

    // ── 后台保活增强 ─────────────────────────────────────────────────────
    /**
     * 安卓 12+ 的"幽灵进程"限制：所有应用的子进程合计超过 32 个就开始杀 —— claude、bash、node、
     * 编译器全是子进程，一次并行构建就可能被收割。另有电池白名单、后台运行限制、待机分组。
     * 这些都要 shell 权限才改得动，所以放在 Shizuku 后面，并且只在用户点了开关之后做。
     */
    private static String[] keepAliveOn() {
        String pkg = ctx.getPackageName();
        return new String[]{
            "device_config set_sync_disabled_for_tests persistent; device_config put activity_manager max_phantom_processes 2147483647",
            "settings put global settings_enable_monitor_phantom_procs false",
            "dumpsys deviceidle whitelist +" + pkg,
            "cmd appops set " + pkg + " RUN_IN_BACKGROUND allow; cmd appops set " + pkg + " RUN_ANY_IN_BACKGROUND allow",
            "am set-standby-bucket " + pkg + " active",
        };
    }
    static JSONObject keepAlive(boolean on) {
        JSONObject r = new JSONObject();
        // 关：先撤同意（以后不再自动打开）；恢复没成的照实报失败，界面把开关留在开着，再点一次关就是重试
        if (!on) Consent.revoke(ctx, Consent.KEEPALIVE);
        if (!granted()) { try { r.put("ok", false).put("message", Tr.t("Shizuku 未就绪或未授权")); } catch (Exception ignored) {} return r; }
        String[] K = keepAliveOn();
        String[][] steps = on ? new String[][]{
            {Tr.t("幽灵进程上限"), K[0]},
            {Tr.t("关闭幽灵进程监控"), K[1]},
            {Tr.t("电池白名单"), K[2]},
            {Tr.t("允许后台运行"), K[3]},
            {Tr.t("待机分组设为活跃"), K[4]},
        } : new String[][]{
            {Tr.t("恢复幽灵进程上限"), "device_config delete activity_manager max_phantom_processes; device_config set_sync_disabled_for_tests none"},
            {Tr.t("恢复幽灵进程监控"), "settings delete global settings_enable_monitor_phantom_procs"},
        };
        // 每一步看退出码：中途 Shizuku 断了、某条命令被 ROM 拒了，不能报「已恢复」（GHSA-7wwv）
        try {
            JSONArray arr = new JSONArray();
            java.util.List<String> bad = new java.util.ArrayList<>();
            for (String[] s : steps) {
                String[] x = runRc(s[1]);
                boolean ok = x[0].equals("0");
                if (!ok) bad.add(s[0]);
                arr.put(new JSONObject().put("step", s[0]).put("ok", ok).put("out", (ok ? "" : "[rc=" + x[0] + "] ") + x[1]));
            }
            r.put("ok", bad.isEmpty()).put("steps", arr);
            if (!bad.isEmpty()) r.put("message", Tr.f("这几步没成功：{0}。可以再点一次开关重试。", String.join(Tr.t("、"), bad)));
            if (on) r.put("phantom", run("device_config get activity_manager max_phantom_processes"));
        } catch (Exception ignored) {}
        Log.i(TAG, "保活增强 " + (on ? "开" : "关") + "：" + r);
        return r;
    }

    // ── 套接字服务 ───────────────────────────────────────────────────────
    private static void acceptLoop(LocalServerSocket ss) {
        int me = Process.myUid();
        while (true) {
            try {
                LocalSocket s = ss.accept();
                int peer = s.getPeerCredentials().getUid();
                if (peer != me) {
                    Log.w(TAG, "拒绝外来连接 uid=" + peer);
                    s.close();
                    continue;
                }
                new Thread(() -> handle(s), "priv-conn").start();
            } catch (IOException e) {
                Log.e(TAG, "accept 出错", e);
            }
        }
    }

    private static void handle(LocalSocket s) {
        try (LocalSocket sock = s) {
            InputStream in = sock.getInputStream();
            OutputStream out = sock.getOutputStream();
            JSONObject req = new JSONObject(readLine(in));
            String op = req.optString("op");
            JSONObject resp;
            switch (op) {
                case "exec": {
                    int pid = 0; try { pid = sock.getPeerCredentials().getPid(); } catch (IOException ignored) {}
                    Thread stdin = exec(req, in, out, pid);
                    // 只关写方向，再等客户端自己关。直接 close 的话，客户端还没送完的 stdin 帧留在我们这边没读，
                    // 它下一次写就是 EPIPE —— Node 遇到写错误会当场销毁套接字，连已经到手的输出和退出码一起丢掉。
                    try { sock.shutdownOutput(); } catch (IOException ignored) {}
                    if (stdin != null) stdin.join(5000);
                    else drain(sock, in);
                    return;
                }
                case "status": resp = status(); break;
                case "request":
                    if (!running()) resp = new JSONObject().put("ok", false).put("message", Tr.t("Shizuku 没在运行"));
                    else if (granted()) resp = new JSONObject().put("ok", true).put("message", Tr.t("已授权"));
                    else { lastPermission = "pending"; Shizuku.requestPermission(REQ); resp = new JSONObject().put("ok", true).put("message", Tr.t("已弹出授权请求")); }
                    break;
                case "open_manager": {
                    Intent i = ctx.getPackageManager().getLaunchIntentForPackage(MANAGER);
                    if (i != null) { i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); ctx.startActivity(i); }
                    resp = new JSONObject().put("ok", i != null);
                    break;
                }
                case "keepalive": {
                    // 打开要用户点头：会改全局的幽灵进程上限、把本应用加进电池白名单（10-31 复核：以前谁发一条都直接改）
                    boolean on = req.optBoolean("enable", true);
                    int pid = 0; try { pid = sock.getPeerCredentials().getPid(); } catch (IOException ignored) {}
                    if (on && !Consent.on(ctx, Consent.KEEPALIVE) && !ask(Tr.t("打开后台保活增强：") + "\n" + String.join("\n", keepAliveOn()), caller(pid), "keepalive")) {
                        resp = new JSONObject().put("ok", false).put("message", Tr.t("没有允许，保活增强没有打开"));
                        break;
                    }
                    if (on && !Consent.on(ctx, Consent.KEEPALIVE)) Consent.grant(ctx, Consent.KEEPALIVE, "1");
                    resp = keepAlive(on);
                    break;
                }
                case "noask": {
                    // 特权命令免确认（总开关）：打开要过原生对话框里的免责说明，脚本发请求没用；关掉随时可以
                    boolean on = req.optBoolean("enable", false);
                    // 时长可选，最长一周（11-08 用户定）；只认固定几档，别的一律按 24 小时。选的时长写进原生说明里，由用户在这里确认
                    long ttl = noAskTtl(req.optInt("hours", 24));
                    long hrs = ttl / 3600000L;
                    String until = hrs % 24 == 0 ? Tr.f("{0} 天后自动关闭，恢复逐条确认。", hrs / 24) : Tr.f("{0} 小时后自动关闭，恢复逐条确认。", hrs);
                    int pid = 0; try { pid = sock.getPeerCredentials().getPid(); } catch (IOException ignored) {}
                    if (on && !noAsk() && !confirm(Tr.t("特权命令不再逐条确认（风险自负）") + "\n\n"
                            + Tr.t("打开后，Claude、终端和本机其他程序发来的特权命令都不再弹框问你，直接以 Shizuku（shell）身份执行，cccodroid 在后台时也一样。这类命令能装卸应用、改权限和系统设置。") + "\n\n"
                            + Tr.t("命令写错、模型判断失误、或者混进来的脚本，都可能造成数据丢失、应用异常甚至需要恢复出厂设置。打开即表示你了解并自行承担这些风险，cccodroid 及其作者不对由此造成的损失负责。") + "\n\n"
                            + Tr.t("涉及 cccodroid 自身、Shizuku / Sui 的命令会尽量拦下来再问你，但拦不住所有写法（比如藏在脚本文件里的）。随时可以在设置里关掉。") + "\n\n"
                            + until, caller(pid), "noask")) {
                        resp = new JSONObject().put("ok", false).put("message", Tr.t("没有确认，仍然逐条询问"));
                        break;
                    }
                    if (on) { if (!noAsk()) Consent.grant(ctx, Consent.NOASK, String.valueOf(System.currentTimeMillis() + ttl)); } else Consent.revoke(ctx, Consent.NOASK);
                    Log.w(TAG, "特权命令免确认 " + (on ? "打开" : "关闭"));
                    resp = new JSONObject().put("ok", true).put("noask", on);
                    break;
                }
                case "to_front": resp = new JSONObject().put("ok", true).put("via", toFront(ctx, req.optString("text"))); break;
                case "freeze_ack": ctx.getSharedPreferences("bg", Context.MODE_PRIVATE).edit().clear().apply(); resp = status(); break;
                case "open_app_settings": {      // 自启动、悬浮窗之类的开关都在应用详情页里
                    ctx.startActivity(new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, android.net.Uri.parse("package:" + ctx.getPackageName())).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                    resp = new JSONObject().put("ok", true);
                    break;
                }
                case "battery": resp = Battery.snapshot(ctx); break;   // 耗电统计（网关每 5 分钟取一次）
                case "usb_list": resp = Usb.list(ctx); break;
                // 一键安装 / 激活 Shizuku（ShizukuSetup），进度在 status 的 setup 字段里
                case "shz_install": ShizukuSetup.get(ctx).install(false); resp = status(); break;
                case "shz_activate": {
                    // 激活会打开无线调试、拉起 Shizuku：要用户在原生对话框里点头，脚本发一条没用（11-04 报告 A6）
                    int pid = 0; try { pid = sock.getPeerCredentials().getPid(); } catch (IOException ignored) {}
                    if (!confirm(Tr.t("激活 Shizuku：会临时打开无线调试，用配对过的钥匙启动 Shizuku 服务。"), caller(pid), "shz_activate")) {
                        resp = status().put("ok", false).put("message", Tr.t("没有允许，没有激活 Shizuku"));
                        break;
                    }
                    ShizukuSetup.get(ctx).activate(); resp = status(); break;
                }
                case "shz_pair": ShizukuSetup.get(ctx).onCode(req.optString("code")); resp = status(); break;
                case "shz_repair": ShizukuSetup.get(ctx).repair(); resp = status(); break;
                case "shz_autostart": {
                    // 打开 = 以后开机时不问就打开无线调试：和保活一样，要原生确认并签名存档；关掉随时可以
                    boolean on = req.optBoolean("enable", true);
                    int pid = 0; try { pid = sock.getPeerCredentials().getPid(); } catch (IOException ignored) {}
                    if (on && !ShizukuSetup.get(ctx).autostart() && !confirm(Tr.t("开机后自动激活 Shizuku：每次开机会临时打开无线调试，用配对过的钥匙启动 Shizuku。"), caller(pid), "shz_autostart")) {
                        resp = status().put("ok", false).put("message", Tr.t("没有允许，自动激活没有打开"));
                        break;
                    }
                    ShizukuSetup.get(ctx).setAutostart(on); resp = status(); break;
                }
                // 更新（Updater）
                case "upd_status": resp = Updater.get(ctx).status(); break;
                case "upd_check": Updater.get(ctx).checkAsync(true); resp = Updater.get(ctx).status(); break;
                case "upd_apply": {
                    String item = req.optString("item"), ver = req.optString("version", "");
                    int pid = 0; try { pid = sock.getPeerCredentials().getPid(); } catch (IOException ignored) {}
                    // 换渠道还没完（可能在等确认降级）：这时的版本信息是临时的，先不接装 Claude Code（10-31 七轮核验）
                    // 没装的不存在降级（卸载后重装：界面改完设置紧接着就发这条）
                    if ("claude".equals(item) && Updater.get(ctx).switchingNow() && Updater.get(ctx).claudeInstalled()) {
                        resp = new JSONObject().put("ok", false).put("message", Tr.t("正在切换 Claude Code 的版本设置，稍后再试"));
                        break;
                    }
                    // 不带版本号 = 装当前渠道查到的那一版：按那一版判（10-31 六轮核验）
                    String chk = ver.trim().isEmpty() ? Updater.get(ctx).latestClaude() : ver;
                    if ("claude".equals(item) && Updater.get(ctx).claudeDowngrade(chk)
                        && !ask(Tr.f("把 Claude Code 降级到 {0}", chk), caller(pid), "upd:" + chk, false)) {
                        resp = new JSONObject().put("ok", false).put("message", Tr.t("没有允许，Claude Code 没有降级"));
                        break;
                    }
                    // 装的就是判过的这一版：别让 apply 再去读一次可能已被换掉的 claude.latest
                    resp = Updater.get(ctx).apply(item, true, "claude".equals(item) && ver.trim().isEmpty() ? chk : ver);
                    break;
                }
                case "upd_set": {
                    // 换安装包方案（28 / 36）：只能 36 的机器切 28 会被拒，原因原样交给界面弹出来
                    String no = req.has("flavor") ? Updater.get(ctx).setFlavor(req.optString("flavor")) : null;
                    int pid = 0; try { pid = sock.getPeerCredentials().getPid(); } catch (IOException ignored) {}
                    Updater.get(ctx).set(req, caller(pid));
                    resp = Updater.get(ctx).status();
                    if (no != null) resp.put("ok", false).put("refused", true).put("message", no);
                    break;
                }
                case "upd_verify": resp = Updater.get(ctx).verifyAsync(req.optBoolean("full", true)); break;
                case "upd_repair": resp = Updater.get(ctx).repair(); break;
                // 通知（Notify）：两个开关 + 跳系统的通知设置
                case "notify_status": resp = Notify.get(ctx).status(); break;
                case "notify_set": Notify.get(ctx).set(req); resp = Notify.get(ctx).status(); break;
                case "notify_settings": {
                    ctx.startActivity(new Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                        .putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, ctx.getPackageName()).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                    resp = new JSONObject().put("ok", true);
                    break;
                }
                case "share_logs": resp = Share.send(ctx, Share.bundleLogs(ctx), "application/zip"); break;
                case "factory_reset": {
                    // 设置页「恢复初始设置」：这里只请界面弹原生确认框（MainActivity.askFactoryReset），执行要用户在框里点；
                    // 谁发来的请求都一样，脚本发了也只是弹个框。界面不在前台就不弹
                    if (!foreground()) { resp = new JSONObject().put("ok", false).put("message", Tr.t("请先把 cccodroid 切到前台")); break; }
                    ctx.startActivity(MainActivity.internal(ctx, MainActivity.ACTION_FACTORY_RESET).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                    resp = new JSONObject().put("ok", true).put("asked", true);
                    break;
                }
                case "share_file": {
                    // 查看器、用量月报都走这里：工作区和 /sdcard 上的文件先拷到导出目录再分享
                    try {
                        java.io.File f = Share.shareable(ctx, new java.io.File(req.optString("path")));
                        String mime = req.optString("mime", "");
                        resp = Share.send(ctx, f, mime.isEmpty() ? Share.mimeOf(f) : mime);
                    } catch (Exception e) { resp = new JSONObject().put("ok", false).put("message", e.getMessage()); }
                    break;
                }
                case "apk_install": {
                    // 查看器里点「安装」：只在 cccodroid 前台时受理，还要用户在应用自己的确认框里点头，之后才轮到系统安装确认。
                    // 这条通道 Claude 和脚本也连得上：不这样拦，后台就能拿任意 APK 一遍遍弹系统安装框（11-09 用户定）
                    int pid = 0; try { pid = sock.getPeerCredentials().getPid(); } catch (IOException ignored) {}
                    if (!foreground()) { resp = new JSONObject().put("ok", false).put("message", Tr.t("请先把 cccodroid 切到前台")); break; }
                    File staged = null;
                    try {
                        File f = new File(req.optString("path")).getCanonicalFile();
                        if (!f.isFile() || !f.getName().toLowerCase(java.util.Locale.ROOT).endsWith(".apk")) throw new IOException(Tr.t("不是 .apk 文件"));
                        Share.guard(ctx, f);       // 凭据、私有目录里工作区以外的不碰，和分享同一道
                        staged = Apk.stage(ctx, f);
                        android.content.pm.PackageInfo pi = Apk.archiveInfo(ctx, staged);
                        if (pi == null) throw new IOException(Tr.t("不是有效的安装包"));
                        // 自己的新版本走「设置 → 更新」：那边核签名、记状态，这里装了更新页的状态就对不上
                        if (ctx.getPackageName().equals(pi.packageName)) throw new IOException(Tr.t("cccodroid 自己的新版本请到「设置 → 更新」里装"));
                        String text = Tr.f("安装应用「{0}」\n包名 {1}\n版本 {2}\n\n文件：{3}", Apk.label(ctx, pi, staged), pi.packageName, String.valueOf(pi.versionName), f.getPath());
                        if (!confirm(text, caller(pid), "apk:" + f.getPath())) {
                            resp = new JSONObject().put("ok", false).put("message", Tr.t("没有允许，没有安装"));
                            break;
                        }
                        Apk.install(ctx, staged, "file");      // 写进安装会话后就不再读这份，下面删掉
                        resp = new JSONObject().put("ok", true);
                    } catch (Exception e) { resp = new JSONObject().put("ok", false).put("message", String.valueOf(e.getMessage())); }
                    finally { if (staged != null) staged.delete(); }
                    break;
                }
                case "usb_open": Usb.open(ctx, req, sock); return;   // 自己回复（fd 随回复走）
                // 设备工具（device-mcp.mjs 调）与它的设置页
                case "dev": {
                    // 设备工具也记进特权命令记录：直连套接字的调用不经 Claude 那层权限确认，至少要留痕（10-31 三轮复核）
                    long t0 = System.currentTimeMillis();
                    int pid = 0; try { pid = sock.getPeerCredentials().getPid(); } catch (IOException ignored) {}
                    String who = caller(pid), tool = req.optString("tool");
                    // 读剪贴板：你从别的应用复制的密码、验证码都在里面，每次都要点头
                    JSONObject da = req.optJSONObject("args");
                    if ("clipboard_read".equals(tool) && !ask(Tr.t("设备工具：读取剪贴板"), who, "dev:clipboard_read", false)) {
                        resp = new JSONObject().put("ok", false).put("message", Tr.t("用户没有允许读剪贴板（cccodroid 不在前台时也会直接拒绝）"));
                    // 写剪贴板能把你刚复制的收款地址悄悄换掉；打开能把浏览器弹到钓鱼网址、把号码填进拨号盘。
                    // 直连套接字的调用不经 Claude 那层确认，这里每次都问（11-01 独立审查低-4）
                    } else if ("clipboard_write".equals(tool) && !ask(Tr.t("设备工具：写入剪贴板") + "\n\n" + clip(da == null ? "" : da.optString("text", "")), who, "dev:clipboard_write", false)) {
                        resp = new JSONObject().put("ok", false).put("message", Tr.t("用户没有允许写剪贴板（cccodroid 不在前台时也会直接拒绝）"));
                    } else if ("open".equals(tool) && !ask(Tr.t("设备工具：打开") + "\n\n" + clip(da == null ? "{}" : da.toString(2)), who, "dev:open", false)) {
                        resp = new JSONObject().put("ok", false).put("message", Tr.t("用户没有允许打开（cccodroid 不在前台时也会直接拒绝）"));
                    // 读屏 / 点按 / 输入 / 截图：每个会话第一次问一次，点了允许，这个会话后面的屏幕操作不再问；
                    // 认不出会话的（终端、脚本直连套接字）每次都问（11-03 审查 M-6）
                    } else if (DeviceTools.screenReady(ctx, tool) && !devSessOk(sessToken(pid), who, tool)) {
                        resp = new JSONObject().put("ok", false).put("message", Tr.t("用户没有允许读屏和点按（cccodroid 不在前台时也会直接拒绝）"));
                    } else resp = DeviceTools.call(ctx, req);
                    audit(t0, who, new JSONObject().put("argv", new JSONArray().put("[" + Tr.t("设备工具") + "] " + tool)), resp.optBoolean("ok", true) ? 0 : 1, System.currentTimeMillis() - t0);
                    break;
                }
                case "dev_status": resp = DeviceTools.status(ctx); break;
                // 定时任务的条件（充电 / 电量 / 仅 Wi-Fi）：平铺的几项，不受「设备工具」开关管（那是给 Claude 用的）。
                // 以前网关问的这个操作根本不存在，Wi-Fi 一直是「不知道」，仅 Wi-Fi 的任务照跑（#108 09-001）
                case "device_status": {
                    try {
                        JSONObject d = DeviceTools.deviceStatus(ctx), b = d.optJSONObject("battery"), n = d.optJSONObject("network");
                        resp = new JSONObject().put("ok", true);
                        if (b != null) resp.put("charging", b.optBoolean("charging")).put("battery", b.optInt("percent"));
                        if (n != null) resp.put("network", n.optString("type")).put("wifi", "wifi".equals(n.optString("type")) || (n.optBoolean("vpn") && vpnOverWifi(ctx)));
                    } catch (Exception e) { resp = new JSONObject().put("ok", false).put("message", String.valueOf(e.getMessage())); }
                    break;
                }
                case "dev_set": resp = DeviceTools.set(ctx, req); break;
                case "a11y_settings":
                    ctx.startActivity(new Intent(android.provider.Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                    resp = new JSONObject().put("ok", true);
                    break;
                default: resp = new JSONObject().put("ok", false).put("message", Tr.t("未知操作 ") + op);
            }
            // 改状态的应用内操作也留痕（10-31 四轮复核：以前只有 exec 进特权命令记录）
            if (op.startsWith("upd_") && !op.equals("upd_status") || op.startsWith("shz_") || op.equals("keepalive") || op.equals("dev_set") || op.equals("noask") || op.equals("apk_install")) {
                int pid = 0; try { pid = sock.getPeerCredentials().getPid(); } catch (IOException ignored) {}
                JSONObject r0 = new JSONObject(req.toString());
                r0.remove("code");    // 配对码不进记录
                audit(System.currentTimeMillis(), caller(pid), new JSONObject().put("argv", new JSONArray().put("[" + op + "] " + r0)), resp.optBoolean("ok", true) ? 0 : 1, 0);
            }
            out.write((resp.toString() + "\n").getBytes(StandardCharsets.UTF_8));
            out.flush();
        } catch (Throwable t) {
            Log.e(TAG, "处理请求出错", t);
        }
    }

    /** 开着 VPN 时活动网络是 VPN 本身：看底下有没有一条连上了的 Wi-Fi（定时任务「仅 Wi-Fi」用） */
    private static boolean vpnOverWifi(Context c) {
        android.net.ConnectivityManager cm = c.getSystemService(android.net.ConnectivityManager.class);
        for (android.net.Network n : cm.getAllNetworks()) {
            android.net.NetworkCapabilities nc = cm.getNetworkCapabilities(n);
            if (nc != null && nc.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI) && !nc.hasTransport(android.net.NetworkCapabilities.TRANSPORT_VPN)
                && nc.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET)) return true;
        }
        return false;
    }

    // ── 高风险命令要用户点头（审查 v0513b 中-3）──
    // 套接字只认同一个 uid，可工具链里跑的一切（npm 的安装脚本、克隆来的 Makefile、模型跑的命令）都是这个 uid，
    // 环境变量谁都能伪造，分不出是 Claude、用户在终端，还是混进来的脚本；发请求的一方完全控制 argv。
    // 所以只有 PrivRules 逐词认得清的查看类命令直接跑，其余一律弹原生对话框问。
    // 「不再问」只对一字不差的同一条命令生效（不然用户放行一条，混进来的脚本跟着搭车）；同一时间只问一条；
    // 应用不在前台就直接拒绝（后台弹不出来，空等 60 秒还占线程）。问的时候设备工具不许动屏幕（见 DeviceTools.call），
    // 免得自己把「允许」点了。
    private static final java.util.concurrent.ConcurrentHashMap<String, Long> TRUST = new java.util.concurrent.ConcurrentHashMap<>();
    private static final java.util.concurrent.ConcurrentHashMap<String, Object[]> ASKS = new java.util.concurrent.ConcurrentHashMap<>();
    // 「截屏给 Claude」是用户在界面上点的：界面经原生桥（带口令，外面的脚本拿不到）领一个一次性截屏码，
    // 网关直接经套接字把它连同请求递过来（不经命令行和环境变量，别的进程看不到）；码只放行 sh -c "screencap -p"，
    // 25 秒＋延时内最多两次（失败会重试一次）
    private static volatile String shotCode;
    private static volatile long shotUntil;
    private static final java.util.concurrent.atomic.AtomicInteger shotLeft = new java.util.concurrent.atomic.AtomicInteger();

    static String armShot(int delaySec) {
        byte[] b = new byte[16];
        new java.security.SecureRandom().nextBytes(b);
        StringBuilder sb = new StringBuilder();
        for (byte x : b) sb.append(String.format("%02x", x & 0xff));
        shotLeft.set(2);
        shotUntil = System.currentTimeMillis() + (Math.max(0, Math.min(30, delaySec)) + 25) * 1000L;
        return shotCode = sb.toString();
    }

    private static boolean shotArmed(String[] argv, String code) {
        if (!(argv.length == 3 && "-c".equals(argv[1]) && "screencap -p".equals(argv[2]) && ("/system/bin/sh".equals(argv[0]) || "sh".equals(argv[0])))) return false;
        String want = shotCode;
        if (want == null || code == null || !java.security.MessageDigest.isEqual(want.getBytes(), code.getBytes())) return false;
        return System.currentTimeMillis() < shotUntil && shotLeft.getAndDecrement() > 0;
    }

    static boolean asking() { return !ASKS.isEmpty(); }

    // ── 免确认 ──
    // 总开关（设置页，打开时原生对话框给免责说明、用户点头才生效）与「本会话都允许」的会话口令（只在内存里）
    private static final java.util.Set<String> SESS_OK = java.util.Collections.newSetFromMap(new java.util.concurrent.ConcurrentHashMap<>());
    /** 允许过屏幕类设备工具的会话口令（只在内存里） */
    private static final java.util.Set<String> DEV_SESS = java.util.Collections.newSetFromMap(new java.util.concurrent.ConcurrentHashMap<>());
    private static boolean devSessOk(String sess, String who, String tool) {
        if (sess != null && DEV_SESS.contains(sess)) return true;
        if (!ask(Tr.t("设备工具：读屏和点按") + " (" + tool + ")\n\n"
                + (sess != null ? Tr.t("允许后，这个会话后面的读屏、点按、输入、截图不再问。") : Tr.t("认不出是哪个会话发起的，这次允许只管这一次。")),
                who, "dev:screen", false)) return false;
        if (sess != null) { if (DEV_SESS.size() > 64) DEV_SESS.clear(); DEV_SESS.add(sess); }
        return true;
    }
    /** 存在 Consent 里（锁屏签名），不再是谁都能改的 prefs（11-03 审查 H-2） */
    /** 免确认是限时的：同意时存的是到期时刻（和同意一起签名，改不了），到点自动关。旧版存的 "1" 当作已到期 */
    static final long NOASK_MAX = 7L * 24 * 3600 * 1000;
    static final int[] NOASK_HOURS = { 1, 4, 24, 72, 168 };
    static long noAskTtl(int hours) {
        for (int h : NOASK_HOURS) if (h == hours) return h * 3600L * 1000;
        return 24L * 3600 * 1000;
    }
    static boolean noAsk() { return noAskUntil() > 0; }
    static long noAskUntil() {
        String v = Consent.get(ctx, Consent.NOASK);
        if (v == null) return 0;
        long t, now = System.currentTimeMillis();
        try { t = Long.parseLong(v); } catch (NumberFormatException e) { t = 0; }
        if (t <= now || t > now + NOASK_MAX + 60000) { Consent.revoke(ctx, Consent.NOASK); Log.w(TAG, "特权命令免确认到期，已关闭"); return 0; }
        return t;
    }
    /** 动到本应用、Shizuku / Sui 自己的命令：开了免确认也照样问。规则见 PrivRules.touchesSelf */
    static boolean touchesSelf(String text) { return PrivRules.touchesSelf(text, ctx.getPackageName()); }

    /** 会话口令（32 位十六进制）。不认发起方自己的环境变量：同 uid 的进程都能读到别的会话的口令，再塞进自己的环境冒用（审查 0601 高-1）。
     *  沿父进程往上找到网关（本应用直接拉起、跑 server.mjs 的那个），只认网关的直接子进程身上的 —— 那是这一轮的 claude，
     *  环境是网关给的，会话里跑的命令改不了。终端、别的会话、setsid 脱离出去的进程、不是本应用拉起的网关，都找不到这条链，照常问。
     *  靠两条不变量成立，改动时别破坏（审查 0601b）：① 本应用的直接子进程只有网关（GatewayService.spawnGateway）；
     *  ② CCAPP_PRIV_SESS 只放进 run.mjs 给 claude 的环境，网关的其他直接子进程（终端的 ptyhost、cc-mem…）一律不带。
     *  比如把终端改成 shell 直接挂在网关下面，shell 就能 exec env CCAPP_PRIV_SESS=偷来的口令 重新执行自己，冒充已允许的会话 */
    static String sessToken(int pid) { return chainToken(pid, android.os.Process.myPid()); }
    /** me：本应用的进程号（拆出来是为了能在宿主上测） */
    static String chainToken(int pid, int me) {
        int below = 0, cur = pid;
        for (int i = 0; i < 64 && cur > 1; i++) {
            int pp = ppid(cur);
            if (pp <= 0) return null;
            // 网关经引导起时命令行里是 boot.mjs 的原文，原文里也有 "server.mjs"（GatewayService.spawnGateway）
            if (pp == me) return below > 0 && proc(cur, "cmdline").contains("server.mjs") ? envToken(below) : null;
            // 0.6.7 起网关和发行版的 claude 不可转储（android/native/nodump.c）：/proc 里看不见，读不了 stat 也读不了环境。
            // 往上数碰到看不见的那一层就问网关作证（它认得自己起的每一轮 claude，见 gateway/gw/run.mjs privWitness）。
            // 请求方自己就看不见（上面 pp<=0）不问：会话里的命令都是 claude 的子孙，看得见
            if (pp != 1 && ppid(pp) <= 0) return witness(pp, cur);
            below = cur; cur = pp;
        }
        return null;
    }

    /** 问网关：anc（看不见的祖先）、top（它下面看得见的那个）是不是它起的某一轮 claude，口令是什么。应答按派生钥匙验签 */
    static String witness(int anc, int top) {
        try {
            byte[] nb = new byte[16];
            new java.security.SecureRandom().nextBytes(nb);
            StringBuilder n = new StringBuilder();
            for (byte x : nb) n.append(String.format("%02x", x));
            java.net.HttpURLConnection c = Env.gateway("/api/priv/witness?n=" + n + "&anc=" + anc + "&top=" + top);
            c.setConnectTimeout(800); c.setReadTimeout(1500);
            try {
                if (c.getResponseCode() != 200) return null;
                java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
                try (java.io.InputStream in = c.getInputStream()) { byte[] b = new byte[1024]; for (int k; bo.size() < 4096 && (k = in.read(b)) > 0; ) bo.write(b, 0, k); }
                JSONObject j = new JSONObject(new String(bo.toByteArray(), StandardCharsets.UTF_8));
                String tok = j.optString("tok", ""), mac = j.optString("mac", "");
                if (!Env.witnessOk(n.toString(), anc, top, tok, mac)) { Log.w(TAG, "网关作证的签名对不上"); return null; }
                return tok.matches("[0-9a-f]{32}") ? tok : null;
            } finally { c.disconnect(); }
        } catch (Exception e) { Log.w(TAG, "问网关作证失败：" + e.getMessage()); return null; }
    }
    /** /proc/<pid>/stat 的父进程号；进程名里可能有空格和括号，从最后一个 ')' 后面数 */
    static int ppid(int pid) {
        String s = proc(pid, "stat");
        int r = s.lastIndexOf(')');
        if (r < 0) return -1;
        try { return Integer.parseInt(s.substring(r + 2).split(" ")[1]); } catch (Exception e) { return -1; }
    }
    private static String envToken(int pid) {
        for (String kv : proc(pid, "environ").split("\0")) if (kv.startsWith("CCAPP_PRIV_SESS=")) {
            String v = kv.substring(16);
            return v.matches("[0-9a-f]{32}") ? v : null;
        }
        return null;
    }
    private static String proc(int pid, String f) {
        try { return new String(java.nio.file.Files.readAllBytes(new java.io.File("/proc/" + pid + "/" + f).toPath()), StandardCharsets.UTF_8); }
        catch (Exception e) { return ""; }
    }

    private static boolean trustable(String[] argv, String cwd, JSONObject env) {
        if (env != null || !"/".equals(cwd)) return false;
        // 直接起某个程序（不是 sh -c）：程序本身就是文件，内容随时能换
        if (!(argv.length == 3 && "-c".equals(argv[1]) && ("/system/bin/sh".equals(argv[0]) || "sh".equals(argv[0])))) return false;
        for (int i = 1; i < argv.length; i++) if (argv[i].indexOf('/') >= 0) return false;
        return true;
    }

    private static boolean foreground() {
        android.app.ActivityManager.RunningAppProcessInfo i = new android.app.ActivityManager.RunningAppProcessInfo();
        android.app.ActivityManager.getMyMemoryState(i);
        return i.importance <= android.app.ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND;
    }

    /** 弹原生对话框等用户回答；true = 允许 */
    private static boolean ask(String cmd, String who, String key) { return ask(cmd, who, key, true); }

    /** 别的模块要用户点头时用（只给「允许这一次」） */
    static boolean confirm(String text, String who, String key) { return ask(text, who, key, false); }

    /** trustable = false：只给「允许这一次」。命令里引用了文件（或工作目录不是根）时，信任的是文本不是文件内容，
     *  别人把文件换掉再原样发一遍就搭上车了（10-31 三轮复核） */
    private static boolean ask(String cmd, String who, String key, boolean trustable) { return ask(cmd, who, key, trustable, null); }
    /** sess：发起方带着的会话口令（见 run.mjs privToken）。给了就在确认框里多一个「本会话都允许」 */
    private static boolean ask(String cmd, String who, String key, boolean trustable, String sess) {
        Long t = trustable ? TRUST.get(key) : null;
        if (t != null && System.currentTimeMillis() < t) return true;
        // 命令整条摆出来（对话框正文能滚动）：截头截尾的话，危险的那段正好藏在省略的中间。太长的不问，直接拒
        if (cmd.length() > 4000) return false;
        String show = cmd;
        String id = Long.toHexString(System.nanoTime()) + Integer.toHexString((int) (Math.random() * 0x7fffffff));
        java.util.concurrent.CountDownLatch done = new java.util.concurrent.CountDownLatch(1);
        Object[] slot = { done, Boolean.FALSE, Boolean.FALSE, Boolean.FALSE };
        synchronized (ASKS) {     // 「同一时间只问一条」：查和登记要一起做，不然同时来的两条都会弹
            if (!ASKS.isEmpty() || !foreground()) return false;
            ASKS.put(id, slot);
        }
        try {
            ctx.startActivity(MainActivity.internal(ctx, MainActivity.ACTION_PRIV_OK).putExtra("id", id)
                .putExtra("cmd", show).putExtra("who", who).putExtra("trust", trustable).putExtra("sess", sess != null)
                // 设置页的免责框：按来路认（exec 的 key 是 JSON 数组开头，撞不上），不看正文 —— 正文是命令原文，能伪造成免责说明的样子（审查 0601 高-2）
                .putExtra("kind", !trustable && "noask".equals(key) ? "noask" : "")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            done.await(60, java.util.concurrent.TimeUnit.SECONDS);
        } catch (Exception e) { Log.w(TAG, "问不了用户", e); }
        finally { ASKS.remove(id); MainActivity.dropPriv(id); }
        if (trustable && Boolean.TRUE.equals(slot[2])) {
            if (TRUST.size() > 64) TRUST.clear();
            TRUST.put(key, System.currentTimeMillis() + 10 * 60_000L);
        }
        if (sess != null && Boolean.TRUE.equals(slot[1]) && Boolean.TRUE.equals(slot[3])) {
            if (SESS_OK.size() > 64) SESS_OK.clear();
            SESS_OK.add(sess);
            Log.i(TAG, "这个会话后面的特权命令不再逐条问（" + who + "）");
        }
        return Boolean.TRUE.equals(slot[1]);
    }

    /** 对话框的回答：how 0=拒绝 1=允许这一次 2=允许，这条命令 10 分钟内不再问 3=允许，这个会话后面的都不再问 */
    static void answer(String id, int how) {
        Object[] slot = id == null ? null : ASKS.get(id);
        if (slot == null) return;
        slot[2] = how == 2;
        slot[3] = how == 3;
        slot[1] = how > 0;
        ((java.util.concurrent.CountDownLatch) slot[0]).countDown();
    }

    /** 返回负责转发 stdin 的线程（它在客户端关闭时结束）；没起进程就返回 null */
    private static Thread exec(JSONObject req, InputStream in, OutputStream rawOut, int peerPid) throws Exception {
        DataOutputStream out = new DataOutputStream(rawOut);
        long t0 = System.currentTimeMillis();
        String who = caller(peerPid);
        if (!granted()) {
            audit(t0, who, req, 126, 0);
            frame(out, 4, (installed() ? (running() ? Tr.t("Shizuku 还没授权给 cccodroid（设置 → Shizuku 里点授权）") : Tr.t("Shizuku 没在运行，先打开 Shizuku 启动服务"))
                : Tr.t("没装 Shizuku（https://shizuku.rikka.app/）")).getBytes(StandardCharsets.UTF_8));
            frameExit(out, 126);
            return null;
        }
        JSONArray a = req.getJSONArray("argv");
        String[] argv = new String[a.length()];
        for (int i = 0; i < argv.length; i++) argv[i] = a.getString(i);
        String[] envp = null;
        JSONObject e = req.optJSONObject("env");
        if (e != null) {
            envp = new String[e.length()];
            java.util.Iterator<String> it = e.keys();
            for (int i = 0; it.hasNext(); i++) { String k = it.next(); envp[i] = k + "=" + e.getString(k); }
        }
        String text = (argv.length >= 3 && "-c".equals(argv[1]) ? argv[2] : String.join(" ", argv)) + (e != null ? "\n\n[env] " + e : "");
        boolean risky = PrivRules.risky(argv, envp != null, req.optString("cwd", "/")) && !(envp == null && shotArmed(argv, req.optString("shot", null)))
            || PrivRules.namesSelf(text, ctx.getPackageName());   // 免问的 am force-stop 等点了本应用 / Shizuku 的名：也要问（审查 0601c）
        // 免确认：设置里打开了总开关，或这个会话已经点过「本会话都允许」。动到本应用自己、Shizuku / Sui 的命令照样问
        String sess = risky && "claude".equals(who) ? sessToken(peerPid) : null;
        boolean self = risky && touchesSelf(text);
        String pass = !risky || self ? null : noAsk() ? "免确认" : sess != null && SESS_OK.contains(sess) ? "本会话已允许" : null;
        if (pass != null) who = who + "·" + pass;
        else if (risky && !ask(text, who, a + "\0" + req.optString("cwd", "/") + "\0" + e, trustable(argv, req.optString("cwd", "/"), e), self ? null : sess)) {
            audit(t0, who, req, 126, 0);
            frame(out, 4, Tr.t("这条特权命令要你在 cccodroid 里点「允许」才会执行（只有带服务名的 dumpsys、pm list、settings get 这类查看命令不用问）。这次没有允许，没有执行。cccodroid 不在前台、或者已经有一条在等确认时，会直接拒绝。想让任务在后台也能跑：下次确认时勾上「这个会话后面的特权命令都允许」，或者在设置 → 设备与权限里打开「特权命令不再逐条确认」。").getBytes(StandardCharsets.UTF_8));
            frameExit(out, 126);
            return null;
        }
        String dir = req.optString("cwd", "/");
        java.lang.Process p;
        try { p = newProcess(argv, envp, dir); }
        catch (Throwable t) { audit(t0, who, req, 127, 0); frame(out, 4, (Tr.t("起进程失败：") + t).getBytes(StandardCharsets.UTF_8)); frameExit(out, 127); return null; }

        Thread o1 = pump(p.getInputStream(), out, 1, p);
        Thread o2 = pump(p.getErrorStream(), out, 2, p);
        // 客户端 → 进程 stdin。零长帧是客户端的 stdin 到头了：只关进程的 stdin，命令照常跑完（sleep、安装这类不读 stdin 的不受影响）；
        // 套接字断了（客户端被杀、会话停了）才算取消：命令还在跑就停掉它。以前断开也只关 stdin，特权命令在后台接着跑（审查 v0.5.20 09-010）
        Thread inT = new Thread(() -> {
            DataInputStream din = new DataInputStream(in);
            OutputStream pin = p.getOutputStream();
            boolean open = true;
            try {
                while (true) {
                    int type = din.read();
                    if (type < 0) break;
                    int len = din.readInt();
                    if (len == 0) { if (open) { open = false; try { pin.close(); } catch (IOException ignored) {} } continue; }
                    if (len < 0 || len > (1 << 24)) break;     // 负数或离谱的长度别去 new（审查 10-30 第九份 安卓低13）
                    byte[] b = new byte[len];
                    din.readFully(b);
                    // 进程自己先关了 stdin：写不进去不等于客户端走了，后面的帧照读、丢掉
                    if (type == 0 && open) try { pin.write(b); pin.flush(); } catch (IOException we) { open = false; }
                }
            } catch (IOException ignored) {
            } finally {
                if (open) try { pin.close(); } catch (IOException ignored) {}
                stopIfAlive(p, "客户端断开");
            }
        }, "priv-stdin");
        inT.setDaemon(true);
        inT.start();
        int rc = p.waitFor();
        o1.join(); o2.join();
        audit(t0, who, req, rc, System.currentTimeMillis() - t0);
        frameExit(out, rc);
        return inT;
    }

    // ── 审计：每条经 priv 执行的命令记一行 JSON（何时、谁发起、命令、退出码、用时），设置页可查 ──
    // 只在本应用私有目录；超过 1 MB 轮转成 .1（只留一份旧的）。命令截到 600 字符
    static final String AUDIT = "home/priv-audit.jsonl";
    private static final int AUDIT_MAX = 1 << 20;

    /** 发起方：看连上来的那个进程（priv.mjs）继承的环境变量，再看它的父进程是不是 cc-mem */
    /** 确认框里摆出来的内容：太长就留头尾（对话框超过 4000 字直接拒） */
    private static String clip(String x) {
        return x.length() <= 3000 ? x : x.substring(0, 1500) + "\n…（" + Tr.f("共 {0} 字", x.length()) + "）…\n" + x.substring(x.length() - 1500);
    }

    private static String caller(int pid) {
        if (pid <= 0) return "?";
        try {
            byte[] env = java.nio.file.Files.readAllBytes(new java.io.File("/proc/" + pid + "/environ").toPath());
            String e = "\0" + new String(env, StandardCharsets.UTF_8) + "\0";
            String parent = "";
            try {
                String st = new String(java.nio.file.Files.readAllBytes(new java.io.File("/proc/" + pid + "/stat").toPath()), StandardCharsets.UTF_8);
                String ppid = st.substring(st.lastIndexOf(')') + 2).split(" ")[1];
                parent = new String(java.nio.file.Files.readAllBytes(new java.io.File("/proc/" + ppid + "/cmdline").toPath()), StandardCharsets.UTF_8);
            } catch (Exception ignored) {}
            if (parent.contains("cc-mem")) return "cc-mem";
            if (e.contains("\0CCAPP_RUN=1\0")) return "claude";
            if (e.contains("\0CCAPP_TERMINAL=1\0")) return "terminal";
            if (e.contains("\0CCAPP_PORT=")) return "gateway";
        } catch (Exception ignored) {}
        return "other";
    }

    private static synchronized void audit(long t0, String who, JSONObject req, int rc, long ms) {
        try {
            JSONArray a = req.optJSONArray("argv");
            StringBuilder cmd = new StringBuilder();
            if (a != null) {
                // priv '命令' 到这里是 [/system/bin/sh, -c, 命令]：只记命令本身
                if (a.length() == 3 && "/system/bin/sh".equals(a.optString(0)) && "-c".equals(a.optString(1))) cmd.append(a.optString(2));
                else for (int i = 0; i < a.length(); i++) { if (i > 0) cmd.append(' '); cmd.append(a.optString(i)); }
            }
            String c = cmd.length() > 600 ? cmd.substring(0, 600) + "…" : cmd.toString();
            JSONObject o = new JSONObject().put("t", t0).put("by", who).put("cmd", c).put("rc", rc).put("ms", ms);
            java.io.File f = new java.io.File(ctx.getFilesDir(), AUDIT);
            f.getParentFile().mkdirs();
            if (f.length() > AUDIT_MAX) f.renameTo(new java.io.File(f.getPath() + ".1"));
            try (java.io.FileOutputStream w = new java.io.FileOutputStream(f, true)) { w.write((o + "\n").getBytes(StandardCharsets.UTF_8)); }
        } catch (Exception e) { Log.w(TAG, "审计日志没写成", e); }
    }

    /** 把客户端还在发的东西读干净，直到它关闭（最多等 5 秒） */
    private static void drain(LocalSocket sock, InputStream in) {
        try {
            sock.setSoTimeout(5000);
            byte[] b = new byte[4096];
            while (in.read(b) >= 0) { }
        } catch (IOException ignored) {}
    }

    private static Thread pump(InputStream src, DataOutputStream out, int type, java.lang.Process p) {
        Thread t = new Thread(() -> {
            byte[] buf = new byte[16384];
            int n;
            while (true) {
                try { if ((n = src.read(buf)) <= 0) return; } catch (IOException e) { return; }
                // 输出送不回去 = 客户端已经走了：同上，停掉还在跑的命令
                try { synchronized (out) { out.writeByte(type); out.writeInt(n); out.write(buf, 0, n); out.flush(); } }
                catch (IOException e) { stopIfAlive(p, "输出送不回客户端"); return; }
            }
        }, "priv-out" + type);
        t.start();
        return t;
    }

    private static void stopIfAlive(java.lang.Process p, String why) {
        try { if (p.isAlive()) { Log.w(TAG, "特权命令还在跑，" + why + "，停掉"); p.destroy(); } } catch (Throwable ignored) {}
    }

    private static void frame(DataOutputStream out, int type, byte[] b) throws IOException {
        synchronized (out) { out.writeByte(type); out.writeInt(b.length); out.write(b); out.flush(); }
    }
    private static void frameExit(DataOutputStream out, int rc) throws IOException {
        synchronized (out) { out.writeByte(3); out.writeInt(4); out.writeInt(rc); out.flush(); }
    }

    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        for (int c; (c = in.read()) >= 0 && c != '\n'; ) {
            if (b.size() >= (4 << 20)) throw new IOException("line too long");   // 一行不给无限长（审查 低13）
            b.write(c);
        }
        return b.toString("UTF-8");
    }
    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        for (int n; (n = in.read(buf)) > 0; ) b.write(buf, 0, n);
        return b.toByteArray();
    }
}
