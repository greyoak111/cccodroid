package cc.codroid;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;
import java.io.File;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * 网关的宿主。为什么要它：
 *   普通应用一进后台，几分钟内就会被冻结或回收，跑到一半的 claude 跟着没了。
 *   前台服务 + 常驻通知让系统把我们当"用户正在用的东西"；部分唤醒锁让锁屏后 CPU 不睡；
 *   网关是本服务的子进程 —— 服务活着，它就活着；它自己挂了，这里按退避重新拉起。
 */
public class GatewayService extends Service {
    static final String TAG = "cccodroid";
    static final String CH = "gateway";
    static final String ACTION_STOP = "cc.codroid.STOP";
    static final String ACTION_BOOT = "cc.codroid.BOOT";

    /** 替换工具包期间停住网关（它跑的 node 就在要被换掉的目录里） */
    private static volatile boolean paused;
    private static final Object serviceOwnerLock = new Object();
    private static volatile GatewayService self;
    static void pause(boolean on) {
        synchronized (serviceOwnerLock) {
            paused = on;
            GatewayService s = self;
            if (on && s != null) s.killGateway();
        }
    }

    private Env env;
    private final Object processLock = new Object();
    private volatile Process proc;
    private PowerManager.WakeLock wake;
    private volatile boolean stopping;
    private Thread supervisor;

    static void start(Context c) {
        Intent i = new Intent(c, GatewayService.class);
        // targetSdk ≥ 31：后台（非精确闹钟、没在电池优化白名单）拉前台服务会抛 ForegroundServiceStartNotAllowedException，别让它崩掉调用方
        try { c.startForegroundService(i); } catch (RuntimeException e) { Log.w(TAG, "拉起网关服务被系统拒绝", e); }
    }

    @Override public IBinder onBind(Intent i) { return null; }

    @Override public void onCreate() {
        super.onCreate();
        Tr.init(this);
        env = new Env(this);
        NotificationManager nm = getSystemService(NotificationManager.class);
        NotificationChannel ch = new NotificationChannel(CH, Tr.t("后台运行"), NotificationManager.IMPORTANCE_LOW);
        ch.setDescription(Tr.t("保持网关与正在进行的任务在后台运行"));
        ch.setShowBadge(false);
        nm.createNotificationChannel(ch);
        // 34 起要带类型（与清单的 specialUse 对应）；早的系统用两参数版
        if (Build.VERSION.SDK_INT >= 34) startForeground(1, note(Tr.t("正在启动…")), 0x40000000 /* FOREGROUND_SERVICE_TYPE_SPECIAL_USE */);
        else startForeground(1, note(Tr.t("正在启动…")));

        PowerManager pm = getSystemService(PowerManager.class);
        wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "cccodroid:gateway");
        wake.setReferenceCounted(false);
        wake.acquire();

        // 提权中转：和网关同寿命（priv 命令、设置页的 Shizuku 状态都靠它）
        Priv.start(this);
        Battery.watch(this);   // 耗电统计：数亮屏时长
        synchronized (serviceOwnerLock) {
            self = this;
            // Publish the owner and acquire its shared hosts in one boundary.
            Notify.get(this).start();
            RemoteHost.get(this).start();
        }
        Updater.get(this).loop();
        // Shizuku 掉了（重启、被杀）而用户开着自动激活：自己重新拉起来
        ShizukuSetup.get(this).reactivateAsync(false);
        watchFreeze();
    }

    /**
     * 冻结检测：每 2 秒醒一次，uptime 跳得远说明 CPU 醒着而我们没在跑 —— 被系统冻住了
     * （深睡时 uptime 不走，不会误报）。前台服务挡不住厂商冻结器：实测红魔在后台 90 秒冻结整个进程组，
     * 网关和正在跑的任务全停。记下来，设置页据此提示用户去系统里允许后台运行。
     */
    private void watchFreeze() {
        Thread t = new Thread(() -> {
            android.content.SharedPreferences sp = getSharedPreferences("bg", MODE_PRIVATE);
            while (!stopping) {
                long t0 = android.os.SystemClock.uptimeMillis();
                sleep(2000);
                long gap = android.os.SystemClock.uptimeMillis() - t0 - 2000;
                if (gap > 15_000) {
                    Log.w(TAG, "被冻结了约 " + gap / 1000 + " 秒");
                    // 空闲时被冻无害，只记跑任务时的那种（标记文件由网关在任务开始/结束时增删）
                    if (!new File(env.home, ".run-active").exists()) continue;
                    sp.edit().putLong("frozenAt", System.currentTimeMillis()).putLong("frozenMs", gap)
                        .putInt("frozenCount", sp.getInt("frozenCount", 0) + 1).apply();
                }
            }
        }, "freeze-watch");
        t.setDaemon(true);
        t.start();
    }

    @Override public int onStartCommand(Intent i, int flags, int id) {
        // 只认自己通知里那个「停止」：服务是导出的，有跨用户权限的进程（shell、别的拿了 Shizuku 的应用）也能发；对不上就当普通启动（审查 v0.5.9 B5）
        String ik = i == null ? null : i.getStringExtra(MainActivity.IK);
        boolean mine = ik != null && java.security.MessageDigest.isEqual(ik.getBytes(), MainActivity.intentKey(this).getBytes());
        if (i != null && ACTION_STOP.equals(i.getAction()) && mine) {
            synchronized (serviceOwnerLock) {
                if (self != this) return START_NOT_STICKY;
                beginStopping();
                killGateway();
                ShizukuSetup.get(this).onExit();
                stopForeground(true);
                stopSelf();
            }
            return START_NOT_STICKY;
        }
        // 开机重新激活 Shizuku 也只认自己的开机广播带来的口令（11-01 独立审查低-6）
        if (i != null && ACTION_BOOT.equals(i.getAction()) && mine) ShizukuSetup.get(this).reactivateAsync(true);
        if (supervisor == null || !supervisor.isAlive()) {
            supervisor = new Thread(this::supervise, "gateway-supervisor");
            supervisor.start();
        }
        // 被系统回收后自动重建（Android 会带空 intent 重启服务）
        return START_STICKY;
    }

    @Override public void onDestroy() {
        beginStopping();
        synchronized (serviceOwnerLock) {
            // Stale destruction owns only its threads/wakelock, never a newer
            // Service's singleton hosts or a Node that it may have adopted.
            if (self == this) {
                self = null;
                Notify.get(this).stop();
                RemoteHost.get(this).stop();
                killGateway();
            }
        }
        Thread retired = supervisor;
        if (retired != null && retired != Thread.currentThread()) {
            retired.interrupt();
            try { retired.join(500); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
        }
        if (wake != null && wake.isHeld()) wake.release();
        super.onDestroy();
    }
    private void beginStopping() {
        // Serialize with ProcessBuilder.start + host binding; no late spawn may
        // publish a child after onDestroy has retired the private host.
        synchronized (processLock) { stopping = true; }
    }

    /** 端口被别的应用占着时回调（MainActivity 把界面换成说明页） */
    static volatile Runnable onSquat;

    /** 守护循环：网关退出就重拉；连续快速崩溃时退避，别把电池耗光 */
    private void supervise() {
        long backoff = 1000;
        while (!stopping && self == this) {
            if (paused) { update(Tr.t("正在更新开发工具包…")); sleep(1000); continue; }
            if (!env.devkitReady()) { update(Tr.t("工具链未安装")); sleep(3000); continue; }
            // 走到这里的是接手的网关（不是本服务拉起的，拉起的在下面 waitFor 里，一退出就作废核身份缓存）：
            // 2 秒看一次，缩短它挂掉到发现端口换了人之间的空档（审查 10-30 第九份 中5）
            if (alive()) { update(Tr.t("运行中 · 127.0.0.1:") + Env.PORT); sleep(2000); continue; }
            if (stopping || self != this) break;
            if (squatted()) {
                if (stopping || self != this) break;
                update(Tr.f("端口 {0} 被别的应用占着，网关起不来。重启手机，或卸载最近装的可疑应用", Env.PORT));
                Env.resetBoot();
                Runnable cb = onSquat;
                if (cb != null) cb.run();
                sleep(10000); continue;      // 照旧每 10 秒再看一次，占用的走了就起网关
            }
            long t0 = System.currentTimeMillis();
            try {
                final Process owned = spawnGateway();
                if (owned == null) continue;
                update(Tr.t("运行中 · 127.0.0.1:") + Env.PORT);
                int rc = owned.waitFor();
                RemoteHost.get(this).gatewayExited(owned);
                synchronized (processLock) { if (proc == owned) proc = null; }
                // A retired Service must not invalidate a replacement's proof.
                if (!stopping && self == this) Env.resetBoot();
                Log.w(TAG, "网关退出 rc=" + rc);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
                break;
            } catch (Exception e) {
                if (!stopping) Log.e(TAG, "网关启动失败", e);
            }
            if (stopping || self != this) break;
            backoff = System.currentTimeMillis() - t0 > 60000 ? 1000 : Math.min(backoff * 2, 60000);
            update(Tr.f("网关已退出，{0} 秒后重启", backoff / 1000));
            sleep(backoff);
        }
    }

    private Process spawnGateway() throws Exception {
        env = new Env(this);                 // 每次重读：执行方式（files/.exec-mode）改了，重启网关就生效
        Log.i(TAG, "执行方式 pref=" + Env.execPref(this) + " targetSdk=" + env.targetSdk + " loader=" + env.loader + " ldso=" + env.ldsoMatches());
        File server = new File(env.app, "server.mjs");
        ProcessBuilder pb = new ProcessBuilder(env.cmd(env.bin("node").getPath(), server.getPath(), String.valueOf(Env.PORT)));
        env.apply(pb.environment());
        RemoteHost.get(this).applyGatewayEnvironment(pb.environment());
        if (env.loader) pb.environment().put("TERMUX_EXEC__PROC_SELF_EXE", env.bin("node").getPath());   // 给 execpath.cjs
        pb.directory(env.app);
        pb.redirectErrorStream(true);
        File gout = new File(env.home, "gateway.out");
        // 一直追加会无限长：起网关前超过 8 MB 就挪成 .1（只留一份旧的 —— 审查 低16）
        if (gout.length() > (8L << 20)) { File old = new File(env.home, "gateway.out.1"); old.delete(); gout.renameTo(old); }
        pb.redirectOutput(ProcessBuilder.Redirect.appendTo(gout));
        // Lock order is service owner -> this Service's process -> RemoteHost.
        synchronized (serviceOwnerLock) {
            synchronized (processLock) {
                if (stopping || paused || self != this) return null;
                final Process owned = pb.start();
                proc = owned;
                RemoteHost.get(this).bindGateway(owned);
                return owned;
            }
        }
    }

    private void killGateway() {
        final Process p;
        synchronized (processLock) { p = proc; }
        if (p == null) return;
        // SIGTERM 让网关自己收尾（它会连带杀掉正在跑的 claude 进程树）
        p.destroy();
        try { if (!p.waitFor(5, java.util.concurrent.TimeUnit.SECONDS)) p.destroyForcibly(); } catch (InterruptedException ignored) {}
    }

    /** 端口上已经有活的网关（比如服务重建前留下的那个）就别再起一个。
     *  只认证明得了自己的（审查 S1）：以前任何答 200 的都算，探活时还把令牌头带过去了 */
    private boolean alive() {
        Process owned = proc;
        if (owned != null && owned.isAlive()) { Env.proveGateway(); return true; }   // 顺手核一下：网关换过了，Cookie 跟着换
        if (!Env.proveGateway()) return false;
        // Preserve the proved adopted Node and its local runs. It has no new
        // stdin capability, so report remote host unavailable instead of killing it.
        synchronized (serviceOwnerLock) {
            synchronized (processLock) {
                if (!stopping && self == this && (proc == null || !proc.isAlive())) RemoteHost.get(this).gatewayAdopted();
            }
        }
        return true;
    }

    /** 端口有人占着、又证明不了自己。本应用自己的残留网关（旧版没有 /__proof，或令牌换过）就杀掉、返回 false 照常起；
     *  杀不着的是别的应用 —— 不起网关，也不往那儿交任何东西 */
    private boolean squatted() {
        if (!Env.portBusy()) return false;
        int me = android.os.Process.myUid(), killed = 0;
        File[] ps = new File("/proc").listFiles();
        for (File d : ps == null ? new File[0] : ps) {
            String name = d.getName();
            if (!name.matches("\\d+")) continue;
            try {
                if (android.system.Os.stat(d.getPath()).st_uid != me) continue;
                String cmd = new String(java.nio.file.Files.readAllBytes(new File(d, "cmdline").toPath()), java.nio.charset.StandardCharsets.UTF_8);
                if (!cmd.contains(new File(env.app, "server.mjs").getPath())) continue;   // 只认本应用的网关脚本，用户自己的 server.mjs 不碰
                Log.w(TAG, "端口上是本应用的残留网关 pid=" + name + "，杀掉重起");
                android.os.Process.sendSignal(Integer.parseInt(name), 9);
                killed++;
            } catch (Exception ignored) {}
        }
        if (killed > 0) { sleep(1000); return false; }
        Log.e(TAG, "端口 " + Env.PORT + " 被别的应用占着（证明不了自己是网关）");
        return true;
    }

    private String last;
    private void update(String text) {
        if (stopping || self != this || text.equals(last)) return;
        last = text;
        getSystemService(NotificationManager.class).notify(1, note(text));
    }

    private Notification note(String text) {
        PendingIntent open = PendingIntent.getActivity(this, 0,
            new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop = PendingIntent.getService(this, 1,
            new Intent(this, GatewayService.class).setAction(ACTION_STOP).putExtra(MainActivity.IK, MainActivity.intentKey(this)),
            PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, CH)
            .setSmallIcon(android.R.drawable.stat_sys_upload_done)
            .setContentTitle("cccodroid")
            .setContentText(text)
            .setOngoing(true)
            .setContentIntent(open)
            .addAction(new Notification.Action.Builder(null, Tr.t("停止"), stop).build())
            .build();
    }

    private static void sleep(long ms) { try { Thread.sleep(ms); } catch (InterruptedException ignored) {} }
}
