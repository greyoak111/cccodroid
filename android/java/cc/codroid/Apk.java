package cc.codroid;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.os.Build;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.MessageDigest;

/**
 * 装 APK（自更新、Shizuku）。走 PackageInstaller 会话而不是 ACTION_VIEW：
 * 不需要 FileProvider 把私有文件暴露出去，结果也能回调到 Events。
 * 系统会弹安装确认（targetSdk 28 无法免确认）；第一次还会要求在设置里允许"安装未知应用"。
 */
final class Apk {
    static final int SIG_FLAGS = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;

    static PackageInfo archiveInfo(Context c, File apk) {
        return c.getPackageManager().getPackageArchiveInfo(apk.getPath(), SIG_FLAGS);
    }

    /** 当前签名证书的 sha256（小写十六进制） */
    @SuppressWarnings("deprecation")
    static String signer(PackageInfo p) throws Exception {
        Signature[] s = Build.VERSION.SDK_INT >= 28 && p.signingInfo != null
            ? (p.signingInfo.hasMultipleSigners() ? p.signingInfo.getApkContentsSigners() : p.signingInfo.getSigningCertificateHistory())
            : p.signatures;
        if (s == null || s.length == 0) throw new IOException(Tr.t("读不到签名"));
        StringBuilder hex = new StringBuilder();
        // 签名轮换过的话 history 里有多张，最后一张是当前的；只比当前那张
        Signature cur = Build.VERSION.SDK_INT >= 28 && p.signingInfo != null && !p.signingInfo.hasMultipleSigners() ? s[s.length - 1] : s[0];
        byte[] d = MessageDigest.getInstance("SHA-256").digest(cur.toByteArray());
        for (byte b : d) hex.append(String.format("%02x", b));
        return hex.toString();
    }

    /** 查看器里点「安装」的那份：先拷进私有缓存再验、再装。验的和装的是同一份，原文件在确认框开着时被换掉也装不进别的 */
    static File stage(Context c, File src) throws IOException {
        File dir = new File(c.getCacheDir(), "apk-install");
        File[] old = dir.listFiles();
        if (old != null) for (File o : old) o.delete();     // 上次没走完（进程被杀）留下的
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException(Tr.t("建不了暂存目录"));
        File dst = new File(dir, Long.toString(System.currentTimeMillis(), 36) + ".apk");
        java.nio.file.Files.copy(src.toPath(), dst.toPath());
        return dst;
    }

    /** 安装包里写的应用名；读不到就用包名 */
    static String label(Context c, PackageInfo p, File apk) {
        try {
            p.applicationInfo.sourceDir = apk.getPath();
            p.applicationInfo.publicSourceDir = apk.getPath();
            CharSequence l = p.applicationInfo.loadLabel(c.getPackageManager());
            if (l != null && l.length() > 0) return l.toString();
        } catch (Exception ignored) {}
        return p.packageName;
    }

    /** @param what 回调时带回去的标记：app / shizuku / file（查看器里装的别的 APK） */
    static void install(Context c, File apk, String what) throws IOException {
        PackageInstaller pi = c.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams p = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        p.setSize(apk.length());
        int id = pi.createSession(p);
        try (PackageInstaller.Session s = pi.openSession(id)) {
            try (InputStream in = new FileInputStream(apk); OutputStream out = s.openWrite("base.apk", 0, apk.length())) {
                byte[] buf = new byte[1 << 16];
                for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
                s.fsync(out);
            }
            Intent i = new Intent(c, Events.class).setAction(Events.ACTION_INSTALLED).putExtra("what", what);
            int fl = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
            s.commit(PendingIntent.getBroadcast(c, id, i, fl).getIntentSender());
        }
    }
}
