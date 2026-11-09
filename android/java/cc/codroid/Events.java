package cc.codroid;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.RemoteInput;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.os.Bundle;
import android.util.Log;

/**
 * 应用内部的回调（不导出，别的应用发不进来）：
 *   ACTION_INSTALLED  PackageInstaller 会话的结果（要用户确认时由这里弹系统确认页）
 *   ACTION_PAIR       通知栏里填的无线调试配对码
 *   Notify.ACTION_DENY 通知里点「拒绝」（权限确认 / 计划）
 */
public class Events extends BroadcastReceiver {
    static final String ACTION_INSTALLED = "cc.codroid.INSTALLED";
    static final String ACTION_PAIR = "cc.codroid.PAIR";
    static final String KEY_CODE = "code";

    @Override public void onReceive(Context c, Intent i) {
        Tr.init(c);
        String a = i.getAction();
        if (Notify.ACTION_DENY.equals(a)) {
            // 通知里点「拒绝」：网络请求不能在主线程，挂住广播直到转给网关
            PendingResult pr = goAsync();
            String id = i.getStringExtra("id");
            new Thread(() -> { try { if (id != null) Notify.deny(c, id); } finally { pr.finish(); } }, "perm-deny").start();
            return;
        }
        if (ACTION_PAIR.equals(a)) {
            Bundle r = RemoteInput.getResultsFromIntent(i);
            CharSequence code = r == null ? null : r.getCharSequence(KEY_CODE);
            // 挂住广播直到激活跑完：广播处理期间进程算"在接收"，厂商冻结器（实测红魔）不会在半路把我们冻住
            PendingResult pr = goAsync();
            ShizukuSetup.get(c).onCode(code == null ? "" : code.toString(), pr::finish);
            return;
        }
        if (!ACTION_INSTALLED.equals(a)) return;
        String what = i.getStringExtra("what");
        int st = i.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        String msg = i.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
        Log.i("cccodroid", "安装结果 " + what + " status=" + st + " " + msg);
        if (st == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            Intent confirm = i.getParcelableExtra(Intent.EXTRA_INTENT);
            if (confirm == null) return;
            confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            // 界面在前台就直接弹；在后台时安卓 10+ 不让后台弹界面，改发通知让用户点
            if (MainActivity.appForeground()) { try { c.startActivity(confirm); return; } catch (Exception ignored) {} }
            Updater.ensureChannel(c);   // 新进程里 Updater 可能从没构造过，渠道不在时安卓 8+ 会丢掉这条通知（200-13-09）
            PendingIntent pi = PendingIntent.getActivity(c, 40, confirm, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            c.getSystemService(NotificationManager.class).notify(40, new Notification.Builder(c, Updater.CH)
                .setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setContentTitle("shizuku".equals(what) ? Tr.t("安装 Shizuku") : "file".equals(what) ? Tr.t("安装应用") : Tr.t("安装 cccodroid 新版本"))
                .setContentText(Tr.t("点此确认安装"))
                .setContentIntent(pi).setAutoCancel(true).build());
            return;
        }
        boolean ok = st == PackageInstaller.STATUS_SUCCESS;
        String why = st == PackageInstaller.STATUS_FAILURE_ABORTED ? Tr.t("取消了") : msg;
        if ("file".equals(what)) {
            // 查看器里装的别的应用：系统确认页点完就关了，成没成给一句；用户自己点了取消就不吵
            if (st != PackageInstaller.STATUS_FAILURE_ABORTED)
                android.widget.Toast.makeText(c, ok ? Tr.t("已安装") : Tr.t("安装失败：") + why, android.widget.Toast.LENGTH_LONG).show();
            return;
        }
        if ("shizuku".equals(what)) ShizukuSetup.get(c).onInstalled(ok, why);
        else Updater.get(c).onInstallResult(what, ok, why);
    }
}
