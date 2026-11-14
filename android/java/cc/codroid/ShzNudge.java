package cc.codroid;

import android.app.Service;
import android.content.Intent;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

/**
 * 激活 Shizuku 后用来「敲门」的一次性进程，几秒后自己退出。
 *
 * Shizuku 13.5+ 的服务只有两条投递 binder 的路：启动时扫一遍申请了 API 的应用逐个投，
 * 和之后任何应用进程状态变化时补投。荣耀 Magic V6 / 安卓 17 实测：第一条路对 shell 拉起的
 * 服务进程返回空（包可见性过滤），激活时本应用又一直前台、进程状态不变——两条路都走不通，
 * binder 永远到不了。起一个独立进程，服务的进程观察者就会看到一次状态变化，把 binder
 * 补投给主进程里的 provider。存活几秒只为确保状态变化被观察到。
 */
public class ShzNudge extends Service {
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // 只 stopSelf 不够：空进程会被系统留在缓存里，下次 startService 复用它、不再产生新的进程
        // 状态变化事件，敲门就失效了（荣耀实测第二次激活必挂）。连进程一起杀掉，每次都是全新进程。
        new Handler(Looper.getMainLooper()).postDelayed(() -> {
            stopSelf();
            android.os.Process.killProcess(android.os.Process.myPid());
        }, 5000);
        return START_NOT_STICKY;
    }
}
