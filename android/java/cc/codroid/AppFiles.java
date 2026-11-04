package cc.codroid;

import android.content.Context;
import android.system.Os;
import android.system.OsConstants;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * files/app（网关、界面、guard、PATH 最前的 pre/ 与 bin/）的部署与核对。
 * 以前只比 TAG（它自己也在 files/app 里），里面的 js 被改了照样跑 —— 项目钩子、MCP 服务器、被网页带偏的 Claude
 * 都以本应用身份运行，改一次网关源码就能把安全检查、系统提示里的提醒整个拿掉，而且一直留着。
 * 安装包里的 assets/app/FILES 记着每个文件的 sha256（build.sh 生成，APK 里的改不了）：每次起网关前核对一遍，
 * 内容不对、少了、多出来的（pre/ 在 PATH 最前，多一个同名程序就能顶替系统命令）都算，有一处就整个按安装包还原。
 * 24 MB 左右，骁龙 8+ 上不到半秒；只在起网关时做。
 */
final class AppFiles {
    private AppFiles() {}

    // 篡改留痕：还原过的文件名攒在内存里，下一次拉起网关时经环境变量交过去（GatewayService.spawnGateway），不落盘
    private static java.util.List<String> restored = null;
    static synchronized void noteRestored(List<String> bad) {
        if (restored == null) restored = new ArrayList<>();
        for (String b : bad) if (restored.size() < 20 && !restored.contains(b)) restored.add(b);
    }
    /** 拿走攒下的（JSON 数组），没有给 null */
    static synchronized String takeRestored() {
        if (restored == null || restored.isEmpty()) return null;
        String j = new org.json.JSONArray(restored).toString();
        restored = null;
        return j;
    }

    // 升级和篡改分开（更新链复盘 U-04）：静默安装后服务自己重启、起网关前核对，新旧版本的差异以前全被记成「篡改留痕」，
    // 还下一轮告诉模型有人改了程序文件。判据：盘上 TAG 和安装包的不一样，并且安装版本（versionCode + lastUpdateTime）
    // 和上次核对通过时记下的不同 —— 才算升级。版本没变、文件却对不上的仍按篡改处理。
    // TAG 和记录都是同 uid 能改的：光凭它们，篡改能被装成「升级」，每次都不留痕（DeepSeek 复核 v066 必修 1a；文件照样整树还原，丢的是留痕和提醒）。
    // 所以再要一条同 uid 改不了的：系统记的安装时间（lastUpdateTime）在 24 小时内。装完服务一般马上起、当场核对，
    // 24 小时是给「装完很久才打开」留的余地；能钻空子的只剩真实升级后的这一段
    private static final long UPDATE_WINDOW = 24L * 3600 * 1000;
    private static String updated = null;
    private static long installedAt(Context c) {
        try { return c.getPackageManager().getPackageInfo(c.getPackageName(), 0).lastUpdateTime; } catch (Exception e) { return 0; }
    }
    private static String pkgStamp(Context c) {
        try {
            android.content.pm.PackageInfo p = c.getPackageManager().getPackageInfo(c.getPackageName(), 0);
            long vc = android.os.Build.VERSION.SDK_INT >= 28 ? p.getLongVersionCode() : p.versionCode;   // 8.0/8.1 没有 getLongVersionCode（#123-1）
            return vc + ":" + p.lastUpdateTime + ":" + p.versionName;
        } catch (Exception e) { return ""; }
    }
    /** 刚升级（或覆盖安装）过：返回「旧版本名->新版本名」，不是返回 null */
    static synchronized String updatedFrom(Context c, File app) {
        String now = pkgStamp(c);
        if (now.isEmpty()) return null;
        long age = System.currentTimeMillis() - installedAt(c);
        if (age < 0 || age > UPDATE_WINDOW) return null;
        String seen = c.getSharedPreferences("appfiles", Context.MODE_PRIVATE).getString("seen", "");
        if (now.equals(seen)) return null;
        String want, have;
        try (InputStream in = c.getAssets().open("app/TAG")) { want = new String(readAll(in), StandardCharsets.UTF_8).trim(); } catch (Exception e) { return null; }
        try { have = new String(java.nio.file.Files.readAllBytes(new File(app, "TAG").toPath()), StandardCharsets.UTF_8).trim(); } catch (Exception e) { have = ""; }
        if (want.equals(have)) return null;
        // seen 是 0.6.6 才有的；从更早的版本升上来时借更新说明记的「上次看到的版本」，只用来显示
        String from = !seen.isEmpty() ? seen.substring(seen.lastIndexOf(58) + 1)
                : c.getSharedPreferences("ui", Context.MODE_PRIVATE).getString("whatsNewSeen", "?");
        return from + "->" + now.substring(now.lastIndexOf(58) + 1);
    }
    /** files/app 和这个安装包对上了：记下安装版本，之后再对不上就不是升级 */
    static synchronized void markSeen(Context c) {
        String now = pkgStamp(c);
        if (!now.isEmpty()) c.getSharedPreferences("appfiles", Context.MODE_PRIVATE).edit().putString("seen", now).apply();
    }
    static synchronized void noteUpdated(String v) { updated = v; }
    static synchronized String takeUpdated() { String v = updated; updated = null; return v; }
    private static byte[] readAll(InputStream in) throws java.io.IOException {
        java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[1 << 16];
        for (int n; (n = in.read(buf)) > 0; ) bo.write(buf, 0, n);
        return bo.toByteArray();
    }

    /** 整个按安装包重新铺一遍 */
    static synchronized void deploy(Context c, File app) throws Exception {
        Installer.deleteTree(app);
        copyAssetDir(c, "app", app);
        // lib/ 里除了 .so 还有可执行的 seccomp-enosys-run、ptyhost
        for (String d : new String[]{"scripts", "bin", "pre", "lib"}) {
            File[] fs = new File(app, d).listFiles();
            if (fs != null) for (File f : fs) f.setExecutable(true, true);
        }
    }

    /** 和安装包对不上的文件（最多列 20 个）；空 = 一致。旧包没有 FILES 就不核 */
    static synchronized List<String> tampered(Context c, File app) {
        List<String> bad = new ArrayList<>();
        Map<String, String> want = new HashMap<>();
        byte[] list;
        try (InputStream in = c.getAssets().open("app/FILES")) {
            java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[1 << 16];
            for (int n; (n = in.read(buf)) > 0; ) bo.write(buf, 0, n);
            list = bo.toByteArray();
        } catch (Exception e) { return bad; }
        try (BufferedReader r = new BufferedReader(new InputStreamReader(new java.io.ByteArrayInputStream(list), StandardCharsets.UTF_8))) {
            for (String l; (l = r.readLine()) != null; ) if (l.length() > 65) want.put(l.substring(65), l.substring(0, 64));
        } catch (Exception e) { return bad; }
        // 清单自己也要和安装包里的一样：网关启动时按 files/app/FILES 做运行期核对（gw/appfiles.mjs），改了它就等于改了核对标准
        want.put("FILES", sha256(list));
        walk(app, "", want, bad);
        for (String k : want.keySet()) { if (bad.size() >= 20) break; if (!k.isEmpty()) bad.add(k + " (missing)"); }
        return bad;
    }

    /** 安装包里清单（assets/app/FILES）的 sha256，交给网关核对盘上那份（gateway/gw/appfiles.mjs）。没有返回 null */
    static String listSha(Context c) {
        try (InputStream in = c.getAssets().open("app/FILES")) {
            java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[1 << 16];
            for (int n; (n = in.read(buf)) > 0; ) bo.write(buf, 0, n);
            return sha256(bo.toByteArray());
        } catch (Exception e) { return null; }
    }

    private static void walk(File dir, String rel, Map<String, String> want, List<String> bad) {
        String[] kids = dir.list();
        if (kids == null) return;
        for (String k : kids) {
            if (bad.size() >= 20) return;
            String r = rel.isEmpty() ? k : rel + "/" + k;
            File f = new File(dir, k);
            int mode;
            try { mode = Os.lstat(f.getPath()).st_mode; } catch (Exception e) { bad.add(r); continue; }
            if (OsConstants.S_ISDIR(mode)) { walk(f, r, want, bad); continue; }
            String h = want.remove(r);
            if (h == null || !OsConstants.S_ISREG(mode) || !h.equals(sha256(f))) bad.add(r);
        }
    }

    private static String sha256(byte[] b) {
        try {
            StringBuilder sb = new StringBuilder();
            for (byte x : MessageDigest.getInstance("SHA-256").digest(b)) sb.append(String.format("%02x", x));
            return sb.toString();
        } catch (Exception e) { return ""; }
    }

    private static String sha256(File f) {
        try (InputStream in = new FileInputStream(f)) {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] buf = new byte[1 << 16];
            for (int n; (n = in.read(buf)) > 0; ) md.update(buf, 0, n);
            StringBuilder sb = new StringBuilder();
            for (byte b : md.digest()) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (Exception e) { return ""; }
    }

    private static void copyAssetDir(Context c, String path, File dst) throws Exception {
        String[] kids = c.getAssets().list(path);
        if (kids == null || kids.length == 0) {
            dst.getParentFile().mkdirs();
            try (InputStream in = c.getAssets().open(path); OutputStream o = new FileOutputStream(dst)) {
                byte[] buf = new byte[1 << 16];
                for (int n; (n = in.read(buf)) > 0; ) o.write(buf, 0, n);
            }
            return;
        }
        dst.mkdirs();
        for (String k : kids) copyAssetDir(c, path + "/" + k, new File(dst, k));
    }
}
