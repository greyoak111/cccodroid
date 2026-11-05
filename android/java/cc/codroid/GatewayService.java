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
    private static volatile GatewayService self;
    static void pause(boolean on) {
        paused = on;
        GatewayService s = self;
        if (on && s != null) s.killGateway();
    }

    private Env env;
    private Process proc;
    private PowerManager.WakeLock wake;
    private volatile boolean stopping;
    /** 界面被划掉时还有任务在跑：跑完再停（重新打开界面就作罢） */
    private volatile boolean closeWhenIdle;
    private Thread supervisor;

    /** 服务这会儿在不在（常驻通知里点了停止之后为 false） */
    static boolean serviceUp() { return self != null; }

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
        self = this;
        Updater.get(this).loop();
        // Shizuku 掉了（重启、被杀）而用户开着自动激活：自己重新拉起来
        ShizukuSetup.get(this).reactivateAsync(false);
        watchFreeze();
        // 后台时的完成 / 等确认通知：订阅网关事件流（界面关了也照发）
        Notify.get(this).start();
    }

    /**
     * 冻结检测：每 2 秒醒一次，uptime 跳得远说明 CPU 醒着而我们没在跑 —— 被系统冻住了
     * （深睡时 uptime 不走，不会误报）。前台服务挡不住厂商冻结器：实测红魔在后台 90 秒冻结整个进程组，
     * 网关和正在跑的任务全停。记下来，设置页据此提示用户去系统里允许后台运行。
     * 顺带看「划掉时在跑、跑完再停」（onTaskRemoved）。
     */
    private void watchFreeze() {
        Thread t = new Thread(() -> {
            android.content.SharedPreferences sp = getSharedPreferences("bg", MODE_PRIVATE);
            int idle = 0;
            while (!stopping) {
                long t0 = android.os.SystemClock.uptimeMillis();
                sleep(2000);
                // 划掉时在跑的任务跑完了：连着三次（约 6 秒）都空闲才停，免得撞上队列里下一条、/goal 下一轮开跑前的空档
                idle = closeWhenIdle && !busy() ? idle + 1 : 0;
                if (idle >= 3) { Log.i(TAG, "划掉时在跑的任务跑完了，停止服务"); shutdown(); break; }
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
        if (i != null && ACTION_STOP.equals(i.getAction()) && mine) { shutdown(); return START_NOT_STICKY; }
        // 系统把被杀的服务带空 intent 重建：没任务在跑就不起了。用户在最近任务里划掉、ROM 只杀进程不强停时，
        // 粘性重建出来的服务紧接着又被冻住，通知卡在「正在启动…」（红魔，11-03 用户反馈）。
        // 定时任务不靠这个：到点由系统闹钟（SchedAlarm）拉起；下次打开界面也会拉起
        if (i == null && !busy()) { Log.i(TAG, "粘性重建时没有任务在跑，不再拉起"); shutdown(); return START_NOT_STICKY; }
        // 开机重新激活 Shizuku 也只认自己的开机广播带来的口令（11-01 独立审查低-6）
        // 有人明确要服务（打开界面、闹钟、开机）：划掉时记的「跑完就停」作罢。口令对不上的 STOP 不算（服务是导出的，审查 0601b）
        if (i != null && !ACTION_STOP.equals(i.getAction())) closeWhenIdle = false;
        if (i != null && ACTION_BOOT.equals(i.getAction()) && mine) ShizukuSetup.get(this).reactivateAsync(true);
        if (supervisor == null || !supervisor.isAlive()) {
            supervisor = new Thread(this::supervise, "gateway-supervisor");
            supervisor.start();
        }
        // 被系统回收后自动重建（Android 会带空 intent 重启服务）
        return START_STICKY;
    }

    /** 在最近任务里划掉主界面 = 关掉：没任务在跑就停服务；有任务在跑照旧保活，跑完再停（守护循环里看） */
    @Override public void onTaskRemoved(Intent root) {
        android.content.ComponentName cn = root == null ? null : root.getComponent();
        if (cn != null && MainActivity.class.getName().equals(cn.getClassName())) {
            if (!busy()) { Log.i(TAG, "界面被划掉且没有任务在跑，停止服务"); shutdown(); }
            else { Log.i(TAG, "界面被划掉，任务跑完再停"); closeWhenIdle = true; }
        }
        super.onTaskRemoved(root);
    }

    /** 有一轮在跑（标记文件由网关在一轮开始 / 全部结束时增删；网关被杀时会留下，正好算「跑到一半」） */
    private boolean busy() { return new File(env.home, ".run-active").exists(); }

    private void shutdown() {
        stopping = true;
        killGateway();
        ShizukuSetup.get(this).onExit();
        stopForeground(true);
        stopSelf();
    }

    @Override public void onDestroy() {
        if (self == this) self = null;
        stopping = true;
        Updater.get(this).stopLoop();
        Notify.get(this).stop();
        killGateway();
        if (wake != null && wake.isHeld()) wake.release();
        super.onDestroy();
    }

    /** 端口被别的应用占着时回调（MainActivity 把界面换成说明页） */
    static volatile Runnable onSquat;

    /** 守护循环：网关退出就重拉；连续快速崩溃时退避，别把电池耗光 */
    private void supervise() {
        long backoff = 1000;
        while (!stopping) {
            if (paused) { update(Tr.t("正在更新开发工具包…")); sleep(1000); continue; }
            if (!env.devkitReady()) { update(Tr.t("工具链未安装")); sleep(3000); continue; }
            // 走到这里的是接手的网关（不是本服务拉起的，拉起的在下面 waitFor 里，一退出就作废核身份缓存）：
            // 2 秒看一次，缩短它挂掉到发现端口换了人之间的空档（审查 10-30 第九份 中5）
            if (alive()) { update(Tr.t("运行中 · 127.0.0.1:") + Env.PORT); sleep(2000); continue; }
            if (squatted()) {
                update(Tr.f("端口 {0} 被别的应用占着，网关起不来。重启手机，或卸载最近装的可疑应用", Env.PORT));
                Env.resetBoot();
                Runnable cb = onSquat;
                if (cb != null) cb.run();
                sleep(10000); continue;      // 照旧每 10 秒再看一次，占用的走了就起网关
            }
            long t0 = System.currentTimeMillis();
            try {
                spawnGateway();
                update(Tr.t("运行中 · 127.0.0.1:") + Env.PORT);
                int rc = proc.waitFor();
                Env.resetBoot();             // 网关没了：上一次核身份的缓存作废，别在 3 秒内把签名请求交给接手端口的人
                Log.w(TAG, "网关退出 rc=" + rc);
            } catch (Exception e) {
                Log.e(TAG, "网关启动失败", e);
            }
            if (stopping) break;
            backoff = System.currentTimeMillis() - t0 > 60000 ? 1000 : Math.min(backoff * 2, 60000);
            update(Tr.f("网关已退出，{0} 秒后重启", backoff / 1000));
            sleep(backoff);
        }
    }

    private void spawnGateway() throws Exception {
        env = new Env(this);                 // 每次重读：执行方式（files/.exec-mode）改了，重启网关就生效
        Log.i(TAG, "执行方式 pref=" + Env.execPref(this) + " targetSdk=" + env.targetSdk + " loader=" + env.loader + " ldso=" + env.ldsoMatches());
        // 起之前核一遍 files/app（见 AppFiles）：两次起网关之间被改过的，按安装包还原了再起
        java.util.List<String> bad = AppFiles.tampered(this, env.app);
        if (!bad.isEmpty()) {
            String upd = AppFiles.updatedFrom(this, env.app);
            AppFiles.deploy(this, env.app);
            if (upd != null) {
                // 刚升级：文件不一样是版本差异，按新安装包铺好就是，不记篡改、不提醒模型（AppFiles.updatedFrom）
                Log.i(TAG, "刚升级（" + upd + "），起网关前按新安装包重铺 files/app");
                AppFiles.noteUpdated(upd);
            } else {
                Log.w(TAG, "files/app 被改过，起网关前还原：" + bad);
                Ledger.add(env, "repair", true, Tr.t("界面与网关的文件被改动过，已按安装包还原：") + android.text.TextUtils.join(", ", bad), null);
                AppFiles.noteRestored(bad);
            }
        }
        AppFiles.markSeen(this);
        // 不让 node 按路径去读 server.mjs：核完到它读进来之间能被换掉（安全 5）。引导 boot.mjs 从安装包里取原文经 -e 交过去，
        // 它按 FILES 核 node 实际读到的每个模块的字节再执行（gateway/boot.mjs）
        String boot = AppFiles.assetText(this, "app/boot.mjs");
        if (boot == null) throw new java.io.IOException("安装包里没有 app/boot.mjs");
        ProcessBuilder pb = new ProcessBuilder(env.cmd(env.bin("node").getPath(), "--input-type=module", "-e", boot, env.app.getPath(), String.valueOf(Env.PORT)));
        env.apply(pb.environment());
        // NODE_OPTIONS 的 --require 也是从盘上读的：网关自己不挂（引导里做同样的事），交给引导转给它拉的子 node
        String nodeOpts = pb.environment().remove("NODE_OPTIONS");
        if (nodeOpts != null) pb.environment().put("CCAPP_NODE_OPTIONS", nodeOpts);
        if (env.loader) pb.environment().put("TERMUX_EXEC__PROC_SELF_EXE", env.bin("node").getPath());   // 给 execpath.cjs
        // 篡改留痕：这次（或界面那边部署时）还原过的文件交给网关，它记日志、界面提示一次、下一轮告诉模型（gateway/gw/tamper.mjs）
        String restored = AppFiles.takeRestored();
        if (restored != null) pb.environment().put("CCAPP_TAMPERED", restored);
        String updated = AppFiles.takeUpdated();
        if (updated != null) pb.environment().put("CCAPP_UPDATED", updated);
        // 清单的哈希：网关拿它核对盘上的 FILES，核完到起进程之间被换了、或者读不到，网关不退回「不核」（gateway/gw/appfiles.mjs）
        String listSha = AppFiles.listSha(this);
        if (listSha != null) pb.environment().put("CCAPP_FILES_SHA", listSha);
        // 防冒名：现造一个随机数，起来后经 stdin 交过去（见 Env.spawnKey、gateway/gw/access.mjs）
        byte[] kb = new byte[32];
        new java.security.SecureRandom().nextBytes(kb);
        StringBuilder ks = new StringBuilder();
        for (byte x : kb) ks.append(String.format("%02x", x));
        pb.environment().put("CCAPP_SPAWN_KEY", "stdin");
        pb.redirectInput(ProcessBuilder.Redirect.PIPE);
        pb.directory(env.app);
        pb.redirectErrorStream(true);
        File gout = new File(env.home, "gateway.out");
        // 一直追加会无限长：起网关前超过 8 MB 就挪成 .1（只留一份旧的 —— 审查 低16）
        if (gout.length() > (8L << 20)) { File old = new File(env.home, "gateway.out.1"); old.delete(); gout.renameTo(old); }
        pb.redirectOutput(ProcessBuilder.Redirect.appendTo(gout));
        // 先换上新的再起：网关读到 stdin 之前答不了话，核身份不会拿旧的去比
        Env.spawnKey = ks.toString();
        Env.resetBoot();
        proc = pb.start();
        try (java.io.OutputStream o = proc.getOutputStream()) { o.write((ks + "\n").getBytes(java.nio.charset.StandardCharsets.US_ASCII)); }
        catch (java.io.IOException e) { Log.w(TAG, "启动随机数没交过去：" + e.getMessage()); }
    }

    private void killGateway() {
        Process p = proc;
        if (p == null) return;
        // SIGTERM 让网关自己收尾（它会连带杀掉正在跑的 claude 进程树）
        p.destroy();
        try { if (!p.waitFor(5, java.util.concurrent.TimeUnit.SECONDS)) p.destroyForcibly(); } catch (InterruptedException ignored) {}
    }

    /** 端口上已经有活的网关（比如服务重建前留下的那个）就别再起一个。
     *  只认证明得了自己的（审查 S1）：以前任何答 200 的都算，探活时还把令牌头带过去了 */
    private boolean alive() {
        if (proc != null && proc.isAlive()) { Env.proveGateway(); return true; }   // 顺手核一下：网关换过了，Cookie 跟着换
        return Env.proveGateway();
    }

    /** /proc/<pid>/cmdline（\0 分隔）是不是本应用的网关：现在经引导起（node --input-type=module -e <boot.mjs> <files/app> <端口>），
     *  升级前留下的旧网关是 node <files/app>/server.mjs <端口> */
    static boolean isGatewayCmd(String cmd, String app) {
        if (cmd.contains(app + "/server.mjs")) return true;
        return cmd.contains("\0--input-type=module\0-e\0") && cmd.endsWith("\0" + app + "\0" + Env.PORT + "\0");
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
                if (!isGatewayCmd(cmd, env.app.getPath())) continue;   // 只认本应用的网关，用户自己的 server.mjs 不碰
                Log.w(TAG, "端口上是本应用的残留网关 pid=" + name + "，杀掉重起");
                android.os.Process.sendSignal(Integer.parseInt(name), 9);
                killed++;
            } catch (Exception ignored) {}
        }
        if (killed > 0) { sleep(1000); return false; }
        // 再看一遍：网关拉起的进程（claude、钩子、终端里跑的东西）环境里都带着 CCAPP_TOKEN_FILE。网关已经不在了，
        // 它们占着端口、又证明不了自己，多半是会话里起的冒牌网关（反破甲 11-03，DeepSeek 复核必修 2）：杀掉再起。
        // 把这个变量摘掉再起的认不出来；那种情况强行停止应用（整个 uid 的进程一起结束）就能恢复
        int mine = android.os.Process.myPid();
        for (File d : ps == null ? new File[0] : ps) {
            String name = d.getName();
            if (!name.matches("\\d+") || Integer.parseInt(name) == mine) continue;
            try {
                if (android.system.Os.stat(d.getPath()).st_uid != me) continue;
                String envs = new String(java.nio.file.Files.readAllBytes(new File(d, "environ").toPath()), java.nio.charset.StandardCharsets.UTF_8);
                if (!("\0" + envs).contains("\0CCAPP_TOKEN_FILE=")) continue;
                Log.w(TAG, "端口被占、网关不在：结束网关留下的进程 pid=" + name);
                android.os.Process.sendSignal(Integer.parseInt(name), 9);
                killed++;
            } catch (Exception ignored) {}
        }
        if (killed > 0) { sleep(1000); if (!Env.portBusy()) return false; }
        Log.e(TAG, "端口 " + Env.PORT + " 被别的应用占着（证明不了自己是网关）");
        return true;
    }

    private String last;
    private void update(String text) {
        if (text.equals(last)) return;
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
