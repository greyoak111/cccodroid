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
    /** 系统闹钟叫醒（SchedAlarm）：跑完到点的任务就自己退，不常驻（0.6.9 审计 13-01） */
    static final String ACTION_ALARM = "cc.codroid.ALARM";

    /** 替换工具包期间停住网关（它跑的 node 就在要被换掉的目录里） */
    private static volatile boolean paused;
    private static volatile GatewayService self;
    /** 停住期间通知栏上写什么；null 按更新工具包说 */
    private static volatile String pauseWhy;
    static void pause(boolean on) { pause(on, null); }
    static void pause(boolean on, String why) {
        pauseWhy = on ? why : null;
        paused = on;
        GatewayService s = self;
        if (on && s != null) s.killGateway();
    }

    private Env env;
    // 守护线程里赋值、界面线程（划掉 / 停止 / 更新工具包）里读：不 volatile 时那边可能拿到 null，
    // 该杀的网关没杀，留下一个占着端口的孤儿（0.6.9 审计 13-06）
    private volatile Process proc;
    /** 这次网关起于何时：刚起来的那几秒还答不了身份证明，alive() 据此给宽限 */
    private volatile long spawnedAt;
    /** 自己拉起的网关连续证明不了自己的起点：0 = 上一次探活过了。只由守护线程读写 */
    private long aliveUnprovenSince;
    private PowerManager.WakeLock wake;
    private volatile boolean stopping;
    /** 界面被划掉时还有任务在跑：跑完再停（重新打开界面就作罢）。闹钟 / 粘性重建拉起的也用它（0.6.9 审计 13-01） */
    private volatile boolean closeWhenIdle;
    /** 空闲退出的宽限拍数：刚被闹钟叫醒时网关还没起来、任务还没进队列，先别数空闲（watchFreeze 每 2 秒减一） */
    private volatile int idleGrace;
    private Thread supervisor;
    /** 生命周期锁：停止 / 销毁与启动准备并发时，靠它原子地交接进程（BUG-A03）；划掉后的空闲查询也在它下面复核代次（BUG-A02） */
    private final Object life = new Object();
    /** 服务代次：每次停止 / 销毁 +1；准备中的 spawnGateway 见到它变了就放弃启动（BUG-A03） */
    private long lifeGen;
    /** 启动请求代次：每次 onStartCommand +1；划掉后的空闲查询据此发现服务又被拉起过（BUG-A02） */
    private long startSeq;
    /** 自己拉起的网关刚起来时的宽限：这几秒还答不了身份证明（同 alive()） */
    static final long PROOF_GRACE_MS = 20000;
    /** 过了宽限还连续这么久证明不了自己：结束重起（BUG-A01） */
    static final long UNPROVEN_KILL_MS = 15000;
    /** squatted() 的三种结论：端口空出来 / 端口上已经是能证明自己的网关 / 被别的应用占着 */
    static final int SQUAT_NO = 0, SQUAT_ADOPTED = 1, SQUAT_HIJACKED = 2;

    /** 服务这会儿在不在（常驻通知里点了停止之后为 false） */
    static boolean serviceUp() { return self != null; }

    static void start(Context c) {
        start(c, new Intent(c, GatewayService.class));
    }

    /** 系统闹钟叫醒：和界面明确打开的启动不同，干完活要能自己退（见 onStartCommand 的 closeWhenIdle）
     *  @return 系统收没接受启动请求：targetSdk 31+ 后台会被拒，调用方得告诉用户（0.6.9 审计 13-05） */
    static boolean startAlarm(Context c) {
        return start(c, new Intent(c, GatewayService.class).setAction(ACTION_ALARM));
    }

    private static boolean start(Context c, Intent i) {
        // targetSdk ≥ 31：后台（非精确闹钟、没在电池优化白名单）拉前台服务会抛 ForegroundServiceStartNotAllowedException，别让它崩掉调用方
        try { c.startForegroundService(i); return true; } catch (RuntimeException e) { Log.w(TAG, "拉起网关服务被系统拒绝", e); return false; }
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
                // 界面开着就是用户在用它：把「跑完就停」作罢。闹钟 / 粘性重建拉起时界面恰好开着、之后按 Home
                // 退到后台（没划掉）也不会被当成空闲退出（0.6.9 审计 13-01）
                if (MainActivity.appForeground()) closeWhenIdle = false;
                // 划掉时在跑的任务跑完了：连着三次（约 6 秒）都空闲才停，免得撞上队列里下一条、/goal 下一轮开跑前的空档
                if (idleGrace > 0) { idleGrace--; idle = 0; }
                else idle = closeWhenIdle && !busy() ? idle + 1 : 0;
                if (idle >= 3) {
                    // 标记文件可能没写上（存储满）或没来得及更新：真要停之前直接问一次网关。
                    // 问不到（网关没起来）才算空闲；网关起着说还有轮次 / 排队，就接着保活（0.6.9 审计 13-03）
                    if (Updater.gatewayBusy()) { idle = 0; continue; }
                    // 问的这几秒里用户可能又把界面打开了：那就不算「划掉」
                    if (closeWhenIdle && !MainActivity.appForeground()) { Log.i(TAG, "划掉时在跑的任务跑完了，停止服务"); shutdown(); break; }
                    idle = 0;
                }
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
        // 又收到一次启动请求（用户回到界面、闹钟、粘性重建）：划掉后的空闲查询查到一半也要作废重判（BUG-A02）
        synchronized (life) { startSeq++; }
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
        // 系统闹钟叫醒的、系统粘性重建的，都不是用户在盯着界面：跑到点该跑的任务就自己退，不常驻、不占着 WakeLock。
        // 给约 60 秒宽限，等网关起来、任务进队列（.run-active 落盘）再开始数空闲（0.6.9 审计 13-01）
        if (i == null || ACTION_ALARM.equals(i.getAction())) { closeWhenIdle = true; idleGrace = 30; }
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
            if (busy()) { Log.i(TAG, "界面被划掉，任务跑完再停"); closeWhenIdle = true; }
            else {
                // 标记文件可能没写上（0.6.9 审计 13-03）：问一次网关再决定。这里在主线程，网络请求放后台线程，
                // 问不到（网关没起来）就当空闲；网关起着说还有轮次 / 排队，就改成跑完再停
                final long seen;
                synchronized (life) { seen = startSeq; }
                new Thread(() -> {
                    if (MainActivity.appForeground()) { Log.i(TAG, "界面又打开了，不按划掉处理"); return; }
                    if (Updater.gatewayBusy()) { Log.i(TAG, "界面被划掉，网关说还有任务，跑完再停"); closeWhenIdle = true; }
                    else {
                        // 查询期间用户可能已经回到前台、服务也可能被重新拉起：拿一致的生命周期状态复核后再停（BUG-A02）。
                        // 以前只查了查询开始前的前台状态，响应的这几秒里用户回来也会把新接纳的任务停掉
                        if (shutdownIfIdle(seen)) Log.i(TAG, "界面被划掉且没有任务在跑，停止服务");
                        else Log.i(TAG, "空闲查询期间界面又开了或服务被重新拉起，不按划掉处理");
                    }
                }, "task-removed-check").start();
            }
        }
        super.onTaskRemoved(root);
    }

    /** 有一轮在跑（标记文件由网关在一轮开始 / 全部结束时增删；网关被杀时会留下，正好算「跑到一半」） */
    private boolean busy() { return new File(env.home, ".run-active").exists(); }

    private void shutdown() { shutdownIfIdle(null); }

    /** 停机；给了 seenSeq（划掉后的空闲查询）就先在锁里复核用户没回来、服务没被重新拉起，不能停就返回 false。
     *  代次和 stopping 在锁里定，退出锁才去杀进程 / 停前台：别让等这把锁的主线程跟着等网关收尾的 5 秒 */
    private boolean shutdownIfIdle(Long seenSeq) {
        synchronized (life) {
            if (seenSeq != null && !idleQueryStillValid(MainActivity.appForeground(), seenSeq, startSeq)) return false;
            lifeGen++;
            stopping = true;
        }
        killGateway();
        ShizukuSetup.get(this).onExit();
        stopForeground(true);
        stopSelf();
        return true;
    }

    @Override public void onDestroy() {
        if (self == this) self = null;
        synchronized (life) { lifeGen++; stopping = true; }
        Updater.get(this).stopLoop();
        Notify.get(this).stop();
        killGateway();
        if (wake != null && wake.isHeld()) wake.release();
        super.onDestroy();
    }

    /** 端口被别的应用占着、或网关运行库对不上没起网关时回调（MainActivity 把界面换成说明页） */
    static volatile Runnable onSquat;
    /** 发行版网关运行库对不上、没起网关时给人看的原因（MainActivity 说明页用）；网关起来了就是 null */
    static volatile String gwBlocked;

    /** 网关运行库凑不齐（GwRuntime.ensure 失败）：发行版不起网关 */
    static final class GwUnavailable extends Exception { GwUnavailable(String m) { super(m); } }
    private String gwLastErr;        // 同一个原因只记一次账本
    private long gwFetchAt;          // 上次联网取运行库的时间：取回来还对不上时别每分钟下一遍 128 MB
    /** 起网关前正在联网取回网关运行库（GwRuntime.fetchBase）：当前这一步和下载字节数。启动页据此显示进度、不按 60 秒超时切走。
     *  11-09 群友：移动数据下 122 MB 的基础模块包下了好几分钟，启动页只写「等待网关…」、进度只在通知栏里，以为卡死，划掉重开了六次 */
    static volatile String gwFetchStep;
    static volatile long gwFetchDone, gwFetchTotal;

    /** 守护循环：网关退出就重拉；连续快速崩溃时退避，别把电池耗光 */
    private void supervise() {
        long backoff = 1000;
        String why = null;
        while (!stopping) {
            if (paused) { String w = pauseWhy; update(w != null ? w : Tr.t("正在更新开发工具包…")); sleep(1000); continue; }
            if (!env.devkitReady()) { update(Tr.t("工具链未安装")); sleep(3000); continue; }
            // 走到这里的是接手的网关（不是本服务拉起的，拉起的在下面 waitFor 里，一退出就作废核身份缓存）：
            // 2 秒看一次，缩短它挂掉到发现端口换了人之间的空档（审查 10-30 第九份 中5）
            if (alive()) { update(Tr.t("运行中 · 127.0.0.1:") + Env.PORT); sleep(2000); continue; }
            int sq = squatted();
            if (sq == SQUAT_ADOPTED) { sleep(500); continue; }   // 这期间已经有真网关了：回循环顶部让 alive() 接管，别再拉一个撞端口
            if (sq == SQUAT_HIJACKED) {
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
                // 有界等待 + 身份检查交替：以前这里是无界 waitFor()，自己拉起的网关活着但卡死 / 失联时
                // 永远走不到循环顶部的 alive()，只能等它自己退出（BUG-A01）
                int rc = waitGatewayExit();
                if (stopping) break;
                Env.resetBoot();             // 网关没了：上一次核身份的缓存作废，别在 3 秒内把签名请求交给接手端口的人
                why = exitWhy(rc);
                Log.w(TAG, "网关退出 rc=" + rc + (why != null ? "：" + why : ""));
            } catch (Cancelled e) {
                // 准备期间服务被停掉 / 停住（更新工具包）：这次不启动，回循环顶部按最新状态再判断（BUG-A03）
                continue;
            } catch (GwUnavailable e) {
                Log.e(TAG, "网关运行库对不上，不起网关：" + e.getMessage());
                gwBlocked = Tr.f("网关自己的运行库和安装包对不上，为了安全没有启动网关：{0}\n\n联网后会自动再试；一直不行请重装 cccodroid", e.getMessage());
                Runnable cb = onSquat;
                if (cb != null) cb.run();
                if (stopping) break;
                backoff = Math.min(Math.max(backoff, 15000) * 2, 300000);
                update(Tr.t("网关运行库对不上，网关没有启动"));
                sleep(backoff);
                continue;
            } catch (Exception e) {
                Log.e(TAG, "网关启动失败", e);
            }
            if (stopping) break;
            backoff = System.currentTimeMillis() - t0 > 60000 ? 1000 : Math.min(backoff * 2, 60000);
            // 反复退出时用户多半拿不到日志（界面停在「等待网关」页）：把这次退出的原因带进通知，截个图就能定位（11-07 升级后网关起不来）
            update(why != null ? Tr.f("网关已退出：{0}，{1} 秒后重启", why, backoff / 1000) : Tr.f("网关已退出，{0} 秒后重启", backoff / 1000));
            why = null;
            sleep(backoff);
        }
    }

    private void spawnGateway() throws Exception {
        final long myGen;
        synchronized (life) { myGen = lifeGen; }     // 这次启动属于哪一代服务（BUG-A03）
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
        // 网关自己的运行库（安全 4 第 2 层，见 GwRuntime）：按安装包钉的哈希核 files/gw，对不上的先从 $PREFIX 拷、再联网取。
        // 凑不齐：发行版不起网关（$PREFIX 里的 node 和库同 uid 的进程都能换）；开发版退回 $PREFIX 的，记账本
        checkSpawn(myGen);                   // 这段可能要联网下 128 MB：停掉 / 停住之后别再白干（BUG-A03）
        GwRuntime gw = new GwRuntime(this, env);
        boolean fetch = System.currentTimeMillis() - gwFetchAt > 30 * 60000L;
        String gwErr;
        try {
            gwErr = gw.ensure(fetch, new GwRuntime.Say() {
                long lastMb = -1;
                public void say(String m) { gwFetchStep = m.trim(); update(gwFetchStep); }
                public void bytes(long d, long t) {
                    gwFetchDone = d; gwFetchTotal = t;
                    long mb = d >> 20;      // 通知一兆一更，别刷屏
                    if (t > 0 && mb != lastMb) { lastMb = mb; update(Tr.f("取回网关运行库：{0} / {1} MB", mb, t >> 20)); }
                }
            });
        } finally { gwFetchStep = null; gwFetchDone = gwFetchTotal = 0; }
        checkSpawn(myGen);                   // 取运行库期间可能已经被停掉（BUG-A03）
        if (gwErr != null && fetch) gwFetchAt = System.currentTimeMillis();
        if (gwErr != null && !gwErr.equals(gwLastErr)) Ledger.add(env, "verify", false, Tr.t("网关运行库：") + gwErr, null);
        gwLastErr = gwErr;
        if (gwErr != null && GwRuntime.sealed(this)) throw new GwUnavailable(gwErr);
        if (gwErr != null) Log.w(TAG, "开发版：网关运行库凑不齐，退回 $PREFIX 的 node：" + gwErr);
        boolean own = gwErr == null;
        File node = own ? gw.node() : env.bin("node");
        // --openssl-config：node 默认读 $PREFIX/etc/tls/openssl.cnf 的 nodejs_conf 段，那里能写 providers 让 libcrypto 去 dlopen 任意模块。
        // 网关用不上它（根证书是 node 自带的），给一份空的；只管网关自己，子进程照旧
        ProcessBuilder pb = new ProcessBuilder(env.cmd(node.getPath(), "--openssl-config=/dev/null", "--input-type=module", "-e", boot, env.app.getPath(), String.valueOf(Env.PORT)));
        env.apply(pb.environment());
        // NODE_OPTIONS 的 --require 也是从盘上读的：网关自己不挂（引导里做同样的事），交给引导转给它拉的子 node
        String nodeOpts = pb.environment().remove("NODE_OPTIONS");
        if (nodeOpts != null) pb.environment().put("CCAPP_NODE_OPTIONS", nodeOpts);
        // 网关不可转储（安全 4 第 3 层，android/native/nodump.c）：同 uid 的进程（会话里的命令、终端）不能 ptrace 它、读写它的内存。
        // libccnodump.so 在 APK 原生库目录里，经 LD_PRELOAD 挂上；它认 CCAPP_NODUMP=1，生效后把变量改成 0。
        // 子进程不该带着它：原来的 LD_PRELOAD 经 CCAPP_CHILD_LD_PRELOAD 交给引导（gateway/boot.mjs）放回去
        String pre = pb.environment().get("LD_PRELOAD");
        pb.environment().put("CCAPP_CHILD_LD_PRELOAD", pre == null ? "" : pre);
        pb.environment().put("LD_PRELOAD", env.nlib("libccnodump.so") + (pre == null || pre.isEmpty() ? "" : ":" + pre));
        pb.environment().put("CCAPP_NODUMP", "1");
        if (env.loader) pb.environment().put("TERMUX_EXEC__PROC_SELF_EXE", node.getPath());   // 引导据此把 process.execPath 从 linker64 改回来
        if (own) {
            // 网关进程按 files/gw 找库（LD_LIBRARY_PATH 先于 node 的 RUNPATH）；经加载器时 termux-exec 也换成 files/gw 那份。
            // 子进程（claude 的钩子、MCP、终端、组件）照旧用 $PREFIX 的 node 和库：原值经 CCAPP_CHILD_* 交给引导放回去
            pb.environment().put("LD_LIBRARY_PATH", gw.dir.getPath());
            pb.environment().put("CCAPP_CHILD_LD_LIBRARY_PATH", "");
            if (env.loader) {
                String tx = new File(env.usr, "lib/libtermux-exec-linker-ld-preload.so").getPath();
                pb.environment().put("LD_PRELOAD", pb.environment().get("LD_PRELOAD").replace(tx, new File(gw.dir, "libtermux-exec-linker-ld-preload.so").getPath()));
            }
            pb.environment().put("CCAPP_CHILD_NODE", env.bin("node").getPath());
            // 网关起 claude 用这份 glibc（gateway/gw/config.mjs PATHS.claudeLoader / claudeLib），起之前按钉子再核一遍（gw/gwpin.mjs）
            pb.environment().put("CCAPP_GW_GLIBC_LIB", gw.glibc.getPath());
            pb.environment().put("CCAPP_GW_LOADER", env.loader ? env.nlib("libldlinux.so") : gw.loader().getPath());
            pb.environment().put("CCAPP_GW_GLIBC_PIN", gw.glibcPin());
        }
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
        goutFrom = gout.length();
        // 先换上新的再起：网关读到 stdin 之前答不了话，核身份不会拿旧的去比
        Env.spawnKey = ks.toString();
        Env.resetBoot();
        checkSpawn(myGen);                   // pb.start 前最后一眼（BUG-A03）
        Process p = pb.start();
        // 进程发布与停止方清理在有同一把锁里交接：停止/销毁要么看到这个新进程把它收走，
        // 要么在发布前把代次改掉，让这里当场结束它 —— 以前两次 kill 都可能早于新 Process 发布，
        // 准备完成后仍会把网关拉起来、留下停止后才启动的进程（BUG-A03）
        boolean cancel;
        synchronized (life) {
            cancel = spawnCancelled(stopping, paused, myGen, lifeGen);
            if (!cancel) {
                proc = p;
                spawnedAt = System.currentTimeMillis();
                aliveUnprovenSince = 0;
                gwBlocked = null;
            }
        }
        // 收尾放在锁外：停止方可能正等着这把锁；没交出去的这个进程也要收干净
        if (cancel) { terminate(p); throw new Cancelled(); }
        try (java.io.OutputStream o = p.getOutputStream()) { o.write((ks + "\n").getBytes(java.nio.charset.StandardCharsets.US_ASCII)); }
        catch (java.io.IOException e) { Log.w(TAG, "启动随机数没交过去：" + e.getMessage()); }
    }

    private void killGateway() {
        Process p;
        synchronized (life) { p = proc; }
        if (p != null) terminate(p);
    }

    /** SIGTERM 让网关自己收尾（它会连带杀掉正在跑的 claude 进程树），5 秒不退再强杀 */
    private static void terminate(Process p) {
        p.destroy();
        try { if (!p.waitFor(5, java.util.concurrent.TimeUnit.SECONDS)) p.destroyForcibly(); } catch (InterruptedException ignored) {}
    }

    /** 准备 / 启动期间服务被停掉或停住：放弃这次启动，别在停止之后再拉起一个网关（BUG-A03） */
    private static final class Cancelled extends Exception { Cancelled() { super("superseded"); } }

    private void checkSpawn(long gen) throws Cancelled {
        synchronized (life) {
            if (spawnCancelled(stopping, paused, gen, lifeGen)) throw new Cancelled();
        }
    }

    /** 这次启动是否已经被服务停止 / 停住取代（纯判断，见 checkSpawn 与发布进程时的复核） */
    static boolean spawnCancelled(boolean stopping, boolean paused, long genAtStart, long genNow) {
        return stopping || paused || genAtStart != genNow;
    }

    /** 划掉后的空闲查询查完还能不能按空闲停机：查询期间用户回到前台、或服务又被重新拉起过，都不能停（BUG-A02） */
    static boolean idleQueryStillValid(boolean foreground, long seenStartSeq, long nowStartSeq) {
        return !foreground && seenStartSeq == nowStartSeq;
    }

    /** 自己拉起的网关还活着、却一直证明不了自己：过了启动宽限，又连续失联这么久，就该结束重起（BUG-A01） */
    static boolean unprovenTooLong(long now, long spawnedAt, long unprovenSince) {
        return unprovenSince > 0 && now - spawnedAt >= PROOF_GRACE_MS && now - unprovenSince >= UNPROVEN_KILL_MS;
    }

    /** aliveDecision 的三种结论：继续观察 / 记下失联起点 / 结束重起 */
    static final int ALIVE_KEEP = 0, ALIVE_ARM = 1, ALIVE_KILL = 2;

    /** 自己拉起的网关这一次探活失败后的处置（纯逻辑，waitGatewayExit / alive 共用）：
     *  宽限内、或连续失联还不够久 → 继续观察；刚失联 → 记起点；连续够久 → 结束重起。
     *  进程已经死了不进这里（那是 squatted() 的事）。 */
    static int aliveDecision(boolean proved, long now, long spawnedAt, long unprovenSince) {
        if (proved) return ALIVE_KEEP;
        if (now - spawnedAt < PROOF_GRACE_MS) return ALIVE_KEEP;
        if (unprovenSince == 0) return ALIVE_ARM;
        return unprovenTooLong(now, spawnedAt, unprovenSince) ? ALIVE_KILL : ALIVE_KEEP;
    }

    /** 等这一代网关退出：有界等一会儿就核一次身份，不再无界 waitFor（BUG-A01）。
     *  进程还活着但证明不了自己时，先给启动宽限，再要求连续失联一段时间才结束 —— 偶发一次探活失败不杀进程 */
    private int waitGatewayExit() throws InterruptedException {
        Process p = proc;
        long unprovenSince = 0;
        while (true) {
            if (p.waitFor(5, java.util.concurrent.TimeUnit.SECONDS)) return p.exitValue();
            if (stopping || paused) { killGateway(); continue; }   // 停止 / 停住：销毁后下一拍就退出了
            long now = System.currentTimeMillis();
            if (Env.proveGateway()) { unprovenSince = 0; continue; }
            int d = aliveDecision(false, now, spawnedAt, unprovenSince);
            if (d == ALIVE_KEEP) continue;                         // 刚起的网关还没监听好 / 连续失联还不够久
            if (d == ALIVE_ARM) { unprovenSince = now; continue; }
            Log.w(TAG, "网关进程还活着但连续 " + ((now - unprovenSince) / 1000) + " 秒证明不了自己，结束重起");
            killGateway();
            return p.waitFor(5, java.util.concurrent.TimeUnit.SECONDS) ? p.exitValue() : -1;
        }
    }

    /** 端口上已经有活的网关（比如服务重建前留下的那个）就别再起一个。
     *  只认证明得了自己的（审查 S1）：以前任何答 200 的都算，探活时还把令牌头带过去了 */
    private boolean alive() {
        Process p = proc;
        if (p != null && p.isAlive()) {
            // 自己拉起的进程还活着：也要有证明。刚起的几秒网关还没监听好，给一段宽限；
            // 过了宽限还证明不了自己（卡死、端口被别人接了）就结束它重起 —— 以前根本不看证明结果（0.6.9 审计 13-02）
            if (Env.proveGateway()) { aliveUnprovenSince = 0; return true; }
            long now = System.currentTimeMillis();
            // 一次探活失败不算数：组件安装等重活会把事件循环占住一会儿，探活 1.5 秒超时很正常。
            // 和 waitGatewayExit 一样要求「连续」证明不了自己，别把正在干活的网关杀掉
            int d = aliveDecision(false, now, spawnedAt, aliveUnprovenSince);
            if (d == ALIVE_KEEP) return true;
            if (d == ALIVE_ARM) { aliveUnprovenSince = now; return true; }
            Log.w(TAG, "网关进程还活着但连续 " + ((now - aliveUnprovenSince) / 1000) + " 秒证明不了自己，结束重起");
            killGateway();
            aliveUnprovenSince = 0;
            return false;
        }
        // 没有自己拉起的进程：端口上那个必须证明得了自己。接管不了 —— 启动随机数只在原进程内存里（Env.key），
        // 认不出来的只能请它退出重起，不能把令牌交给一个证明不了身份的进程（0.6.9 审计 13-02）
        return Env.proveGateway();
    }

    /** /proc/<pid>/cmdline（\0 分隔）是不是本应用的网关：现在经引导起（node --input-type=module -e <boot.mjs> <files/app> <端口>），
     *  升级前留下的旧网关是 node <files/app>/server.mjs <端口> */
    static boolean isGatewayCmd(String cmd, String app) {
        if (cmd.contains(app + "/server.mjs")) return true;
        return cmd.contains("\0--input-type=module\0-e\0") && cmd.endsWith("\0" + app + "\0" + Env.PORT + "\0");
    }

    private static boolean alivePid(int pid) {
        try { android.system.Os.stat("/proc/" + pid); return true; } catch (Exception e) { return false; }
    }
    private static boolean anyAlive(java.util.List<Integer> pids) {
        for (int p : pids) if (alivePid(p)) return true;
        return false;
    }

    /** 端口有人占着、又证明不了自己。本应用自己的残留网关（旧版没有 /__proof，或令牌换过）就请它退出，按 SQUAT_NO 照常起；
     *  杀不着的是别的应用 —— 不起网关，也不往那儿交任何东西（SQUAT_HIJACKED）。
     *  清理期间要是有能证明自己的网关起来了（SQUAT_ADOPTED），交给上面的 alive() 接管，不再拉一个新的撞端口。
     *  前提是 Env.portBusy() 把 127.0.0.1 和 127.0.0.2 都算上（199-1-03 的 Env 半，j1 车道改）；
     *  只探 127.0.0.2 的话，127.0.0.1 被占时这里看不出来，网关会起不来又反复重启 */
    private int squatted() {
        if (!Env.portBusy()) return SQUAT_NO;
        int me = android.os.Process.myUid(), killed = 0;
        File[] ps = new File("/proc").listFiles();
        java.util.List<Integer> gw = new java.util.ArrayList<>();
        for (File d : ps == null ? new File[0] : ps) {
            String name = d.getName();
            if (!name.matches("\\d+")) continue;
            try {
                if (android.system.Os.stat(d.getPath()).st_uid != me) continue;
                String cmd = new String(java.nio.file.Files.readAllBytes(new File(d, "cmdline").toPath()), java.nio.charset.StandardCharsets.UTF_8);
                if (!isGatewayCmd(cmd, env.app.getPath())) continue;   // 只认本应用的网关，用户自己的 server.mjs 不碰
                gw.add(Integer.parseInt(name));
            } catch (Exception ignored) {}
        }
        if (!gw.isEmpty()) {
            // 先礼后兵：SIGTERM 让网关自己收尾（它退出时会连带结束正在跑的 claude 进程树）。
            // 以前直接 SIGKILL：收尾没跑，claude 成了孤儿；而且这里就 return 了，下面的兜底清理也不做（0.6.9 审计 13-02）
            for (int pid : gw) { Log.w(TAG, "端口上是本应用的残留网关 pid=" + pid + "，请它退出"); android.os.Process.sendSignal(pid, 15); }
            long until = System.currentTimeMillis() + 3000;
            while (System.currentTimeMillis() < until && anyAlive(gw)) sleep(100);
            for (int pid : gw) if (alivePid(pid)) { Log.w(TAG, "残留网关没退出，强制结束 pid=" + pid); android.os.Process.sendSignal(pid, 9); }
            killed += gw.size();
            sleep(500);
        }
        // 再看一遍：网关拉起的进程（claude、钩子、终端里跑的东西）环境里都带着 CCAPP_TOKEN_FILE。网关已经不在了，
        // 它们占着端口、又证明不了自己，多半是会话里起的冒牌网关（反破甲 11-03，DeepSeek 复核必修 2）：杀掉再起。
        // 把这个变量摘掉再起的认不出来；那种情况强行停止应用（整个 uid 的进程一起结束）就能恢复。
        // 上面刚把网关杀掉时更要走这里：被 SIGKILL 的网关没机会收尾，它的 claude 子树就靠这一段兜底（0.6.9 审计 13-02）
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
        // 自己刚杀掉的网关可能要几秒才退干净（要收尾、杀 claude 子树）：多等一会儿，
        // 别在它还没放手时就下结论说「被别的应用占着」
        if (killed > 0) {
            for (int i = 0; i < 30; i++) { sleep(100); if (!Env.portBusy()) return SQUAT_NO; }
        }
        if (Env.proveGateway(true)) return SQUAT_ADOPTED;  // 这期间已经有能证明自己的网关了：交给上面接管（不吃 3 秒缓存）
        Log.e(TAG, "端口 " + Env.PORT + " 被别的应用占着（证明不了自己是网关）");
        return SQUAT_HIJACKED;
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
            .setStyle(new Notification.BigTextStyle().bigText(text))
            .setOngoing(true)
            .setContentIntent(open)
            .addAction(new Notification.Action.Builder(null, Tr.t("停止"), stop).build())
            .build();
    }

    private long goutFrom;           // 这次起网关前 gateway.out 的长度：退出时只看这一次写的

    /** 这次网关为什么退出：gateway.out 里这一次写下的最后一条 ⚠️ 或报错行（去掉时间戳，截短）；找不到给退出码 */
    private String exitWhy(int rc) {
        File gout = new File(env.home, "gateway.out");
        String last = null;
        try (java.io.RandomAccessFile r = new java.io.RandomAccessFile(gout, "r")) {
            long n = r.length(), from = Math.max(goutFrom, n - 16384);
            if (n > from) {
                byte[] b = new byte[(int) (n - from)];
                r.seek(from); r.readFully(b);
                String[] lines = new String(b, java.nio.charset.StandardCharsets.UTF_8).split("\n");
                for (int i = lines.length - 1; i >= 0 && last == null; i--) {
                    String l = lines[i].replaceFirst("^\\[[^\\]]*\\]\\s*", "").trim();
                    if (l.startsWith("⚠️") || l.matches("^\\w*Error\\b.*") || l.contains("Error:")) last = l;
                }
            }
        } catch (Exception ignored) {}
        if (last == null) return rc == 0 ? null : Tr.f("退出码 {0}", rc);
        return last.length() > 160 ? last.substring(0, 160) + "…" : last;
    }

    private static void sleep(long ms) { try { Thread.sleep(ms); } catch (InterruptedException ignored) {} }
}
