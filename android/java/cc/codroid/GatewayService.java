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

    /** 替换工具包期间停住网关（引用计数：多个并发暂停方都放开才恢复，且 pause(true) 递增 lifeGen 阻断在途 spawnGateway） */
    private static final Object PAUSE_LOCK = new Object();
    private static int pauseCount;
    private static volatile boolean paused;
    private static volatile GatewayService self;
    /** 停住期间通知栏上写什么；null 按更新工具包说 */
    private static volatile String pauseWhy;
    static void pause(boolean on) { pause(on, null); }
    static void pause(boolean on, String why) {
        GatewayService s = self;
        synchronized (PAUSE_LOCK) {
            if (on) {
                pauseCount++;
                pauseWhy = why;
                paused = true;
            } else {
                if (pauseCount > 0) pauseCount--;
                if (pauseCount == 0) { paused = false; pauseWhy = null; }
            }
        }
        if (on && s != null) {
            synchronized (s.life) { s.lifeGen++; }
            s.killGateway();
        }
    }

    /** 暂停期间再踢一次网关，不改变引用计数：换工具包 / 恢复设置的 finally 里补刀用。
     *  必须在本方还持着 pause(true) 时调用（否则可能杀掉已经放行后新起的网关）。 */
    static void pauseKick() {
        final GatewayService s;
        synchronized (PAUSE_LOCK) {
            if (pauseCount <= 0) return;
            s = self;
        }
        if (s == null) return;
        synchronized (s.life) { s.lifeGen++; }
        s.killGateway();
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
    private Thread freezeWatcher;
    /** 生命周期锁：停止 / 销毁与启动准备并发时，靠它原子地交接进程（BUG-A03）；划掉后的空闲查询也在它下面复核代次（BUG-A02） */
    private final Object life = new Object();
    /** 服务代次：每次停止 / 销毁 +1；准备中的 spawnGateway 见到它变了就放弃启动（BUG-A03） */
    private long lifeGen;
    /** 启动请求代次：每次 onStartCommand +1；划掉后的空闲查询据此发现服务又被拉起过（BUG-A02） */
    private long startSeq;
    /** 最近一次 onStartCommand 的 startId：停机收尾改用 stopSelfResult，避免杀掉刚到来的新启动请求 */
    private int lastStartId;
    /** 自己拉起的网关刚起来时的宽限：这几秒还答不了身份证明（同 alive()） */
    static final long PROOF_GRACE_MS = 20000;
    /** 过了宽限还连续这么久证明不了自己：结束重起（BUG-A01） */
    static final long UNPROVEN_KILL_MS = 15000;
    /** 组件安装（switch/backup/move/recover）期间探活失败不算数：网关在分批搬几千个文件，/__proof 答不上来是正常的。
     *  网关落 components/.runs/<id>.installing 心跳；分批搬移持续多久都放行（复核 P1-5），
     *  但单次同步系统调用卡死（现场 157/338 秒那种停顿）会让心跳停更——停更超过这时长仍按真卡死处理，
     *  由启动恢复收口（复核 R2-P2-7：这里是「心跳停更上限」，不是「安装总时长上限」） */
    static final long INSTALL_GRACE_MS = 120000;
    /** squatted() 的四种结论：端口空出来 / 端口上已经是能证明自己的网关 / 被别的应用占着 / 残留网关在安装，先不打扰 */
    static final int SQUAT_NO = 0, SQUAT_ADOPTED = 1, SQUAT_HIJACKED = 2, SQUAT_WAIT = 3;

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
        ShizukuSetup.get(this).startKeepaliveWatch();
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
        synchronized (life) {
            if (freezeWatcher != null && freezeWatcher.isAlive()) return;
            Thread t = new Thread(() -> {
                android.content.SharedPreferences sp = getSharedPreferences("bg", MODE_PRIVATE);
                int idle = 0;
                try {
                    for (;;) {
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
                                final long seen;
                                synchronized (life) { seen = startSeq; }
                                // 标记文件可能没写上（存储满）或没来得及更新：真要停之前直接问一次网关。
                                // 问不到（网关没起来）才算空闲；网关起着说还有轮次 / 排队，就接着保活（0.6.9 审计 13-03）
                                if (Updater.gatewayBusy()) { idle = 0; continue; }
                                // 问的这几秒里用户可能又把界面打开了或新闹钟/启动请求到达：带 seen 复核（BUG-A02）
                                if (closeWhenIdle && !MainActivity.appForeground()) {
                                    if (shutdownIfIdle(seen)) { Log.i(TAG, "划掉时在跑的任务跑完了，停止服务"); break; }
                                }
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
                        // 退出前在锁内复核：停机后秒重拉会把 stopping 复位，避免旧线程未退完导致 onStartCommand 漏起新线程
                        synchronized (life) {
                            if (!stopping && freezeWatcher == Thread.currentThread()) continue;
                            if (freezeWatcher == Thread.currentThread()) freezeWatcher = null;
                            return;
                        }
                    }
                } finally {
                    synchronized (life) { if (freezeWatcher == Thread.currentThread()) freezeWatcher = null; }
                }
            }, "freeze-watch");
            t.setDaemon(true);
            freezeWatcher = t;
            t.start();
        }
    }

    @Override public int onStartCommand(Intent i, int flags, int id) {
        // 又收到一次启动请求（用户回到界面、闹钟、粘性重建）：划掉后的空闲查询查到一半也要作废重判（BUG-A02）
        synchronized (life) { startSeq++; lastStartId = id; }
        // 只认自己通知里那个「停止」：服务是导出的，有跨用户权限的进程（shell、别的拿了 Shizuku 的应用）也能发；对不上就当普通启动（审查 v0.5.9 B5）
        String ik = i == null ? null : i.getStringExtra(MainActivity.IK);
        boolean mine = ik != null && java.security.MessageDigest.isEqual(ik.getBytes(), MainActivity.intentKey(this).getBytes());
        if (i != null && ACTION_STOP.equals(i.getAction()) && mine) { shutdownAsync(); return START_NOT_STICKY; }
        // 系统把被杀的服务带空 intent 重建：没任务在跑就不起了。用户在最近任务里划掉、ROM 只杀进程不强停时，
        // 粘性重建出来的服务紧接着又被冻住，通知卡在「正在启动…」（红魔，11-03 用户反馈）。
        // 定时任务不靠这个：到点由系统闹钟（SchedAlarm）拉起；下次打开界面也会拉起
        if (i == null && !busy()) { Log.i(TAG, "粘性重建时没有任务在跑，不再拉起"); shutdownAsync(); return START_NOT_STICKY; }
        // 有人明确要服务（打开界面、闹钟、开机）：划掉时记的「跑完就停」作罢。口令对不上的 STOP 不算（服务是导出的，审查 0601b）
        if (i != null && !ACTION_STOP.equals(i.getAction())) closeWhenIdle = false;
        // 系统闹钟叫醒的、系统粘性重建的，都不是用户在盯着界面：跑到点该跑的任务就自己退，不常驻、不占着 WakeLock。
        // 给约 60 秒宽限，等网关起来、任务进队列（.run-active 落盘）再开始数空闲（0.6.9 审计 13-01）
        if (i == null || ACTION_ALARM.equals(i.getAction())) { closeWhenIdle = true; idleGrace = 30; }
        // 上一次 shutdownIfIdle 可能还在锁外等 killGateway（最多 5 秒）或尚未 onDestroy：
        // 系统复用同一个 Service 实例回调 onStartCommand，必须在同一把 life 锁里复位 stopping 并确保看护线程在线，
        // 避免旧线程刚跳出 while (!stopping) 但尚未完全结束（isAlive() 仍为 true）导致漏起新线程、服务永久卡死在「等待网关…」
        synchronized (life) {
            if (stopping) {
                stopping = false;
                lifeGen++;
            }
            if (freezeWatcher == null || !freezeWatcher.isAlive()) watchFreeze();
            if (supervisor == null || !supervisor.isAlive()) {
                supervisor = new Thread(this::supervise, "gateway-supervisor");
                supervisor.start();
            }
        }
        // 开机重新激活 Shizuku 也只认自己的开机广播带来的口令（11-01 独立审查低-6）
        if (i != null && ACTION_BOOT.equals(i.getAction()) && mine) ShizukuSetup.get(this).reactivateAsync(true);
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

    /** 主线程停机入口（ACTION_STOP / 粘性重建无任务）：异步杀网关，收尾照旧在杀完之后复核。
     *  以前在 onStartCommand 里同步 killGateway（最多等 5 秒）再复核 startSeq；改成异步后不能把复核也省掉，
     *  否则用户点「停止」后立刻回到界面（新 onStartCommand 已把 stopping 复位）仍会被这次 stopSelf 杀回去。 */
    private void shutdownAsync() {
        final long mySeq;
        final int myStartId;
        synchronized (life) {
            mySeq = startSeq;
            myStartId = lastStartId;
            lifeGen++;
            stopping = true;
        }
        killGatewayAsync(() -> {
            synchronized (life) {
                if (!shouldFinishStop(stopping, mySeq, startSeq)) return;
            }
            ShizukuSetup.get(this).onExit();
            stopForeground(true);
            if (myStartId > 0) stopSelfResult(myStartId);
            else stopSelf();
        });
    }

    /** 停机；给了 seenSeq（划掉后的空闲查询）就先在锁里复核用户没回来、服务没被重新拉起，不能停就返回 false。
     *  代次和 stopping 在锁里定，退出锁才去杀进程 / 停前台：别让等这把锁的主线程跟着等网关收尾的 5 秒 */
    private boolean shutdownIfIdle(Long seenSeq) {
        final long mySeq;
        final int myStartId;
        synchronized (life) {
            if (seenSeq != null && !idleQueryStillValid(MainActivity.appForeground(), seenSeq, startSeq)) return false;
            mySeq = startSeq;
            myStartId = lastStartId;
            lifeGen++;
            stopping = true;
        }
        killGateway();
        // killGateway 最多等 5 秒：期间如果用户重开界面或闹钟再次调起 onStartCommand，服务已复活，不能继续停掉它
        synchronized (life) {
            if (!shouldFinishStop(stopping, mySeq, startSeq)) return false;
        }
        ShizukuSetup.get(this).onExit();
        stopForeground(true);
        if (myStartId > 0) stopSelfResult(myStartId);
        else stopSelf();
        return true;
    }

    @Override public void onDestroy() {
        if (self == this) self = null;
        synchronized (life) { lifeGen++; stopping = true; }
        ShizukuSetup.get(this).stopKeepaliveWatch();
        Updater.get(this).stopLoop();
        Notify.get(this).stop();
        killGatewayAsync();
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
        try {
            for (;;) {
                while (!stopping) {
                    if (paused) { String w = pauseWhy; update(w != null ? w : Tr.t("正在更新开发工具包…")); sleep(1000); continue; }
                    if (!env.devkitReady()) { update(Tr.t("工具链未安装")); sleep(3000); continue; }
                    // 走到这里的是接手的网关（不是本服务拉起的，拉起的在下面 waitFor 里，一退出就作废核身份缓存）：
                    // 2 秒看一次，缩短它挂掉到发现端口换了人之间的空档（审查 10-30 第九份 中5）
                    if (alive()) { update(Tr.t("运行中 · 127.0.0.1:") + Env.PORT); sleep(2000); continue; }
                    int sq = squatted();
                    if (sq == SQUAT_ADOPTED || sq == SQUAT_WAIT) { sleep(500); continue; }   // 真网关起来了 / 残留网关在安装：回循环顶部让 alive() 再判断，别抢端口、别杀它
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
                        if (paused) { backoff = 1000; continue; }    // 主动暂停（更新工具包/部署资源）：不算崩溃，不走退避
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
                // 退出前在锁内复核：停机后秒重拉会把 stopping 复位，避免旧线程未退完导致 onStartCommand 漏起新看护线程
                synchronized (life) {
                    if (!stopping && supervisor == Thread.currentThread()) continue;
                    if (supervisor == Thread.currentThread()) supervisor = null;
                    return;
                }
            }
        } finally {
            synchronized (life) { if (supervisor == Thread.currentThread()) supervisor = null; }
        }
    }

    private void spawnGateway() throws Exception {
        final long myGen;
        synchronized (life) { myGen = lifeGen; }     // 这次启动属于哪一代服务（BUG-A03）
        env = new Env(this);                 // 每次重读：执行方式（files/.exec-mode）改了，重启网关就生效
        Log.i(TAG, "执行方式 pref=" + Env.execPref(this) + " targetSdk=" + env.targetSdk + " loader=" + env.loader + " ldso=" + env.ldsoMatches());
        // 起之前原子核对 files/app（A-09）：与 MainActivity.deployAssets 共用 AppFiles.ensureSynced 锁，避免升级时双铺或假篡改
        AppFiles.SyncResult syncRes = AppFiles.ensureSynced(this, env, false, null, null);
        if (syncRes.kind == AppFiles.SyncResult.UPDATED) {
            Log.i(TAG, "刚升级（" + syncRes.detail + "），起网关前按新安装包重铺 files/app");
        }
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
            // 受核验的网关自身 Node 运行时路径：供 guardHooks() 优先锚定 files/gw/node（而非可写 $PREFIX/bin/node）
            pb.environment().put("CCAPP_GW_NODE", gw.node().getPath());
            pb.environment().put("CCAPP_GW_LIB", gw.dir.getPath());
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
        // 界面地址探测的结果（见 Env.checkHost）：回退设备上让网关把界面地址并进主地址（gateway/gw/access.mjs 的 UI_HOST）
        pb.environment().put("CCAPP_UI_HOST", Env.HOST);
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
        int gpid = processPid(p);
        long gst = gpid > 0 ? procStartTime(gpid) : -1;
        if (gpid > 0 && gst > 0) writeGatewayPid(env.files, gpid, gst);
        try (java.io.OutputStream o = p.getOutputStream()) { o.write((ks + "\n").getBytes(java.nio.charset.StandardCharsets.US_ASCII)); }
        catch (java.io.IOException e) { Log.w(TAG, "启动随机数没交过去：" + e.getMessage()); }
    }

    private void killGateway() {
        Process p;
        synchronized (life) { p = proc; proc = null; }
        if (p != null) terminate(p);
    }

    /** 原子取出 proc 并在后台等待收尾：主线程只发 SIGTERM，绝不 waitFor(5s) 卡死主线程触发 ANR。
     *  after 在进程真正退出（或 5 秒后强杀）之后执行，用来把「等网关收尾再决定要不要停机」的逻辑搬到后台。 */
    private void killGatewayAsync() { killGatewayAsync(null); }
    private void killGatewayAsync(Runnable after) {
        final Process p;
        synchronized (life) { p = proc; proc = null; }
        if (p == null) { if (after != null) after.run(); return; }
        p.destroy();
        Thread t = new Thread(() -> {
            try { if (!p.waitFor(5, java.util.concurrent.TimeUnit.SECONDS)) p.destroyForcibly(); } catch (InterruptedException ignored) {}
            if (after != null) try { after.run(); } catch (Throwable ignored) {}
        }, "gateway-reap");
        t.setDaemon(true);
        t.start();
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

    /** killGateway 返回后复核还能不能继续停前台并 stopSelf：若期间有新启动请求把服务救活则放弃停机 */
    static boolean shouldFinishStop(boolean stoppingNow, long seqAtStart, long seqNow) {
        return stoppingNow && seqAtStart == seqNow;
    }

    /** 自己拉起的网关还活着、却一直证明不了自己：过了启动宽限，又连续失联这么久，就该结束重起（BUG-A01） */
    static boolean unprovenTooLong(long now, long spawnedAt, long unprovenSince) {
        return unprovenSince > 0 && now - spawnedAt >= PROOF_GRACE_MS && now - unprovenSince >= UNPROVEN_KILL_MS;
    }

    /** 心跳阶段里值得放行探活失败的：switch（记录切换）、backup（备份旧版）、move（搬文件）、recover（启动恢复回滚）
     *  都可能长时间占着事件循环（组件安装报告 §1；复核 P1-3/P2-13） */
    static boolean installingPhase(String phase) { return "switch".equals(phase) || "backup".equals(phase) || "move".equals(phase) || "recover".equals(phase); }
    /** 心跳还新鲜吗：at 要是个过去的时间，且距今不超过 INSTALL_GRACE_MS（at<=0 或未来时间都算不新鲜） */
    static boolean installingFresh(long now, long at) { return at > 0 && at <= now && now - at < INSTALL_GRACE_MS; }
    /** 多份心跳取最新时只认「没到未来时间、阶段值得放行」的：系统时间被回拨留下的未来时间戳、
     *  或 downloading 之类阶段的心跳，不能盖住真正新鲜的 move 心跳（复核 P2-9） */
    static long beatBetter(long now, long bestAt, long t, String phase) {
        return t > bestAt && t <= now && installingPhase(phase) ? t : bestAt;
    }

    /** 手写解析网关写的心跳（JSON {id, phase, moved, at, gw, boot}，at 是 /proc/uptime 单调毫秒）：
     *  桌面 JVM 的 android.jar 是桩、org.json 调不了，纯字符串解析让 installingBeat 能进 JVM 测试跑全链路（复核 P2-14）。
     *  字段名与 gateway/gw/components.mjs 的 beat 写入口径一致，改字段要两头一起改。冒号前后允许空白（复核 R2-P2-5）；
     *  带 boot 的心跳和本机 boot_id 对不上（重启后的旧文件）当无效（复核 R2-P3-4）。畸形 / 缺字段 / 未来 at / 阶段不放行 → null */
    private static String hostBootId = null;
    /** 找字段名（"name"）：只认 { 或 , 后面的位置（JSON 键），心跳里的 id 等值恰好叫 at/boot/phase 不能误命中（复核第三轮 §2） */
    private static int fieldPos(String s, String name) {
        int from = 0;
        while (true) {
            int i = s.indexOf("\"" + name + "\"", from);
            if (i < 0) return -1;
            int j = i - 1;
            while (j >= 0 && (s.charAt(j) == ' ' || s.charAt(j) == '\t' || s.charAt(j) == '\n' || s.charAt(j) == '\r')) j--;
            if (j < 0 || s.charAt(j) == '{' || s.charAt(j) == ',') return i;
            from = i + 1;
        }
    }
    static Long parseBeatAt(String s, long now) {
        if (s == null) return null;
        int p = fieldPos(s, "at");
        if (p < 0) return null;
        p = skipWsColon(s, p + 4);
        if (p < 0) return null;
        int e = p;
        while (e < s.length() && s.charAt(e) >= '0' && s.charAt(e) <= '9') e++;
        if (e == p) return null;
        long t;
        try { t = Long.parseLong(s.substring(p, e)); } catch (NumberFormatException x) { return null; }
        int q = fieldPos(s, "phase");
        if (q < 0) return null;
        q = skipWsColon(s, q + 7);
        if (q < 0 || q >= s.length() || s.charAt(q) != '"') return null;
        int qe = s.indexOf('"', q + 1);
        if (qe < 0) return null;
        String phase = s.substring(q + 1, qe);
        // boot 校验：心跳带了开机代号就对一下，跨重启的旧 at 会「回到过去」造成误判
        int b = fieldPos(s, "boot");
        if (b >= 0) {
            b = skipWsColon(s, b + 6);
            if (b < 0 || b >= s.length() || s.charAt(b) != '"') return null;
            int be = s.indexOf('"', b + 1);
            if (be < 0) return null;
            if (!s.substring(b + 1, be).equals(hostBoot())) return null;
        }
        long got = beatBetter(now, 0, t, phase);
        return got > 0 ? got : null;
    }
    /** 从 i 起跳过空白与冒号，返回字段值起点；格式不对返回 -1 */
    private static int skipWsColon(String s, int i) {
        while (i < s.length() && (s.charAt(i) == ' ' || s.charAt(i) == '\t' || s.charAt(i) == '\n' || s.charAt(i) == '\r')) i++;
        if (i >= s.length() || s.charAt(i) != ':') return -1;
        i++;
        while (i < s.length() && (s.charAt(i) == ' ' || s.charAt(i) == '\t' || s.charAt(i) == '\n' || s.charAt(i) == '\r')) i++;
        return i;
    }
    private static String hostBoot() {
        // 读失败不缓存空串：下次再读。缓存了空串，网关侧读成功就永久不匹配，宽限静默关闭（复核第三轮 §3）
        if (hostBootId != null && !hostBootId.isEmpty()) return hostBootId;
        try {
            hostBootId = new String(java.nio.file.Files.readAllBytes(java.nio.file.Paths.get("/proc/sys/kernel/random/boot_id")), java.nio.charset.StandardCharsets.UTF_8).trim();
        } catch (Exception e) { hostBootId = ""; }
        return hostBootId;
    }

    /** 读网关落的安装心跳（components/.runs/*.installing），取 at 最新的一份。now 传 SystemClock.elapsedRealtime()
     *  （心跳 at 是 /proc/uptime 单调毫秒，同一基准；墙钟跳变不再影响判定，复核 P2-9）。
     *  返回 { 时间戳, 是否安装阶段 }；没有 / 读不了 / 不是普通文件 / 超 4 KB 都当没有 */
    static long[] installingBeat(File files, long now) {
        File[] list = new File(files, "components/.runs").listFiles();
        long at = 0;
        if (list != null) for (File f : list) {
            if (!f.getName().endsWith(".installing") || !f.isFile()) continue;   // FIFO / 目录别去读，会把 supervise 线程卡死（复核 P2-11）
            try {
                byte[] buf = new byte[4097]; int total = 0, c;
                try (java.io.InputStream in = new java.io.FileInputStream(f)) {
                    while (total < buf.length && (c = in.read(buf, total, buf.length - total)) > 0) total += c;
                }
                if (total > 4096) continue;
                Long t = parseBeatAt(new String(buf, 0, total, "UTF-8"), now);
                if (t != null && t > at) at = t;
            } catch (Exception ignored) {}
        }
        if (at == 0) return null;
        return new long[]{ at, 1 };
    }

    /** 网关正在合法地长时间忙组件安装：探活失败暂时不算数（组件安装报告 §1）。
     *  心跳持续新鲜就继续放行（安装搬几千个文件可能要好几分钟，复核 P1-5）；
     *  心跳停更超过 INSTALL_GRACE_MS 才按真卡死处理，看门狗仍会结束它。
     *  时间基准用开机单调钟：心跳 at 是网关按 /proc/uptime 写的，墙钟跳变两边都不会失真（复核 P2-9） */
    private boolean installingGrace() {
        Env e = env;
        long now = android.os.SystemClock.elapsedRealtime();
        long[] beat = e == null ? null : installingBeat(e.files, now);
        return beat != null && beat[1] == 1 && installingFresh(now, beat[0]);
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
            if (installingGrace()) { unprovenSince = 0; continue; }   // 组件安装合法占着事件循环：探活失败不算数
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
            if (installingGrace()) { aliveUnprovenSince = 0; return true; }   // 组件安装合法占着事件循环：探活失败不算数
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
        // 认不出来的只能请它退出重起，不能把令牌交给一个证明不了身份的进程（0.6.9 审计 13-02）。
        // 正在安装的残留网关（服务重建、proc==null、端口还被它占着）先别判死；自己拉起的进程死了
        // （proc 非 null 但 isAlive 为假）绝不宽限——心跳文件可能还是新的，但网关已经不在了（复核 R2-P1-3）
        if (proc == null && Env.portBusy() && installingGrace()) return true;
        return Env.proveGateway();
    }

    /** /proc/<pid>/cmdline（\0 分隔）是不是本应用的网关：现在经引导起（node --input-type=module -e <boot.mjs> <files/app> <端口>），
     *  升级前留下的旧网关是 node <files/app>/server.mjs <端口> */
    static boolean isGatewayCmd(String cmd, String app) {
        if (cmd.contains(app + "/server.mjs")) return true;
        return cmd.contains("\0--input-type=module\0-e\0") && cmd.endsWith("\0" + app + "\0" + Env.PORT + "\0");
    }

    private static final String GW_PID_FILE = ".gateway.pid";

    /** 提取子进程 PID（兼容 API 26-36，不依赖 Java 9 Process.pid()） */
    static int processPid(Process p) {
        if (p == null) return -1;
        try {
            java.lang.reflect.Field f = p.getClass().getDeclaredField("pid");
            f.setAccessible(true);
            int v = f.getInt(p);
            if (v > 0) return v;
        } catch (Throwable ignored) {}
        try {
            java.util.regex.Matcher m = java.util.regex.Pattern.compile("pid=(\\d+)").matcher(String.valueOf(p));
            if (m.find()) return Integer.parseInt(m.group(1));
        } catch (Throwable ignored) {}
        return -1;
    }

    /** 解析 /proc/<pid>/stat 第 22 字段 starttime（PR_SET_DUMPABLE=0 下仍可读，防 PID 复用） */
    static long parseStatStartTime(String stat) {
        if (stat == null) return -1;
        int rp = stat.lastIndexOf(')');
        if (rp < 0 || rp + 2 >= stat.length()) return -1;
        String[] fields = stat.substring(rp + 2).trim().split("\\s+");
        if (fields.length <= 19) return -1;
        try { return Long.parseLong(fields[19]); } catch (NumberFormatException e) { return -1; }
    }

    static long procStartTime(int pid) {
        if (pid <= 0) return -1;
        try {
            String s = new String(java.nio.file.Files.readAllBytes(new File("/proc/" + pid + "/stat").toPath()), java.nio.charset.StandardCharsets.UTF_8);
            return parseStatStartTime(s);
        } catch (Exception e) { return -1; }
    }

    /** 原子落盘网关 pid:starttime（A-06）：App 重建后即使 PR_SET_DUMPABLE=0 阻断 /proc/cmdline/environ/fd 也能精准收割旧网关 */
    static void writeGatewayPid(File files, int pid, long startTime) {
        if (files == null || pid <= 0 || startTime <= 0) return;
        File dst = new File(files, GW_PID_FILE);
        File tmp = new File(files, GW_PID_FILE + ".tmp");
        byte[] data = (pid + ":" + startTime + "\n").getBytes(java.nio.charset.StandardCharsets.US_ASCII);
        try {
            java.nio.file.Files.write(tmp.toPath(), data);
            if (!tmp.renameTo(dst)) {
                java.nio.file.Files.write(dst.toPath(), data);
                tmp.delete();
            }
        } catch (Exception ignored) {}
    }

    static long[] readGatewayPid(File files) {
        if (files == null) return null;
        try {
            String s = new String(java.nio.file.Files.readAllBytes(new File(files, GW_PID_FILE).toPath()), java.nio.charset.StandardCharsets.US_ASCII).trim();
            int i = s.indexOf(':');
            if (i <= 0) return null;
            long pid = Long.parseLong(s.substring(0, i).trim());
            long st = Long.parseLong(s.substring(i + 1).trim());
            return pid > 0 && st > 0 ? new long[]{ pid, st } : null;
        } catch (Exception e) { return null; }
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
        // A-06：PR_SET_DUMPABLE=0 下部分内核同 UID 读 /proc/<pid>/cmdline 也会 EACCES；补充查 .gateway.pid（校验同 UID + starttime 防 PID 复用）
        long[] savedPid = readGatewayPid(env.files);
        if (savedPid != null) {
            int spid = (int) savedPid[0];
            long sstart = savedPid[1];
            if (spid > 0 && spid != android.os.Process.myPid() && !gw.contains(spid)) {
                try {
                    if (android.system.Os.stat("/proc/" + spid).st_uid == me && procStartTime(spid) == sstart) {
                        Log.w(TAG, "经 .gateway.pid 识别到本应用残留网关 pid=" + spid);
                        gw.add(spid);
                    }
                } catch (Exception ignored) {}
            }
        }
        // 残留网关正在安装（心跳新鲜）且它的进程真活着：先别发信号杀它，回循环顶部让 alive() 按安装心跳继续等。
        // 没有活着的网关进程就不等——心跳文件可能是刚被杀的网关留下的，空转 120 秒只会让 UI 干等（复核 R2-P1-3）
        if (!gw.isEmpty() && anyAlive(gw) && installingGrace()) { Log.w(TAG, "端口上的残留网关正在安装组件，先不打扰，等它收尾"); return SQUAT_WAIT; }
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
