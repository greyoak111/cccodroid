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
    // 部分 Android 13–16 厂商 ROM 用 getPackageArchiveInfo 读仅带 v1+v2 签名的未安装 APK 时，
    // 只传 GET_SIGNING_CERTIFICATES 会让 signingInfo 或 getSigningCertificateHistory() 为空；
    // 同时带上 GET_SIGNATURES 并在下面逐级回退，避免误报「读不到签名」（known-issues #10）
    @SuppressWarnings("deprecation")
    static final int SIG_FLAGS = Build.VERSION.SDK_INT >= 28
        ? (PackageManager.GET_SIGNING_CERTIFICATES | PackageManager.GET_SIGNATURES)
        : PackageManager.GET_SIGNATURES;

    static PackageInfo archiveInfo(Context c, File apk) {
        return c.getPackageManager().getPackageArchiveInfo(apk.getPath(), SIG_FLAGS);
    }

    /** 按优先级挑出当前生效的签名证书字节（纯逻辑，便于 JVM 回归）：
     *  多签取 contents[0]；单签优先取 history 最后一张（签名轮换时当前证书在末尾），
     *  history 为空时回退 contents[0]（无 v3 lineage 的 v1+v2 包在部分 ROM 上只填这里），
     *  仍为空则回退旧接口 legacy[0]。 */
    static byte[] pickSigner(boolean multi, byte[][] history, byte[][] contents, byte[][] legacy) {
        if (multi) {
            if (contents != null && contents.length > 0) return contents[0];
        } else {
            if (history != null && history.length > 0) return history[history.length - 1];
            if (contents != null && contents.length > 0) return contents[0];
        }
        if (legacy != null && legacy.length > 0) return legacy[0];
        return null;
    }

    private static byte[][] toBytes(Signature[] arr) {
        if (arr == null || arr.length == 0) return null;
        byte[][] out = new byte[arr.length][];
        for (int i = 0; i < arr.length; i++) out[i] = arr[i] == null ? null : arr[i].toByteArray();
        return out;
    }

    /** 当前签名证书的 sha256（小写十六进制） */
    @SuppressWarnings("deprecation")
    static String signer(PackageInfo p) throws Exception {
        boolean multi = Build.VERSION.SDK_INT >= 28 && p.signingInfo != null && p.signingInfo.hasMultipleSigners();
        byte[][] history = Build.VERSION.SDK_INT >= 28 && p.signingInfo != null ? toBytes(p.signingInfo.getSigningCertificateHistory()) : null;
        byte[][] contents = Build.VERSION.SDK_INT >= 28 && p.signingInfo != null ? toBytes(p.signingInfo.getApkContentsSigners()) : null;
        byte[] cur = pickSigner(multi, history, contents, toBytes(p.signatures));
        if (cur == null || cur.length == 0) throw new IOException(Tr.t("读不到签名"));
        StringBuilder hex = new StringBuilder();
        byte[] d = MessageDigest.getInstance("SHA-256").digest(cur);
        for (byte b : d) hex.append(String.format("%02x", b));
        return hex.toString();
    }

    private static final java.util.concurrent.atomic.AtomicInteger STAGE_SEQ = new java.util.concurrent.atomic.AtomicInteger();

    /** 查看器里点「安装」的那份：先拷进私有缓存再验、再装。验的和装的是同一份，原文件在确认框开着时被换掉也装不进别的 */
    static File stage(Context c, File src) throws IOException {
        File dir = new File(c.getCacheDir(), "apk-install");
        long cutoff = System.currentTimeMillis() - 10 * 60_000L;
        File[] old = dir.listFiles();
        // 只清超过 10 分钟的遗留文件，避免并发装包请求删掉另一条正在等用户确认的暂存 APK
        if (old != null) for (File o : old) if (o.lastModified() < cutoff) o.delete();
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException(Tr.t("建不了暂存目录"));
        File dst = new File(dir, Long.toString(System.currentTimeMillis(), 36) + "-" + STAGE_SEQ.incrementAndGet() + ".apk");
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
        boolean committed = false;
        try (PackageInstaller.Session s = pi.openSession(id)) {
            try (InputStream in = new FileInputStream(apk); OutputStream out = s.openWrite("base.apk", 0, apk.length())) {
                byte[] buf = new byte[1 << 16];
                for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
                s.fsync(out);
            }
            Intent i = new Intent(c, Events.class).setAction(Events.ACTION_INSTALLED).putExtra("what", what);
            int fl = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
            s.commit(PendingIntent.getBroadcast(c, id, i, fl).getIntentSender());
            committed = true;
        } finally {
            if (!committed) try { pi.abandonSession(id); } catch (Exception ignored) {}
        }
    }
}
