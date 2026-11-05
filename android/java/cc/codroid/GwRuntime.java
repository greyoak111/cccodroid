package cc.codroid;

import android.content.Context;
import android.system.Os;
import android.system.OsConstants;
import android.util.Log;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/**
 * 网关自己的运行库（安全 4 第 2 层）：网关的 node 和它加载的库、网关起 claude 用的 glibc，单独放一份在 files/gw，
 * 起网关前逐个按安装包钉住的 sha256 核（assets/gwpin.json，build.sh 从钉住那版工具包的基础模块包算出来，见 devkit.mjs gwpin）。
 *
 * 为什么另放一份：$PREFIX 里的 node、libssl、libicu、glibc 和会话里跑的命令同一个 uid，换掉它们网关 / claude 就跑别人的代码；
 * 而且用户 pkg upgrade 会合法地换掉这些库，按哈希核 $PREFIX 就会把正常升级当成篡改。files/gw 不归 pkg、工具包更新也不动（在 usr 外面），
 * 只有这里按钉子写进来。
 *
 * 对不上的先从 $PREFIX 里对得上的那份拷（刚装好的工具包、没升级过的库）；$PREFIX 里也对不上（升级过、被改过）就联网取钉住那版的基础模块包，
 * 一路按 devkit-pin.json → modules.json → 包的 sha256 核下来，解出要的几个文件。都不成：发行版不起网关（GatewayService），开发版退回用 $PREFIX 的。
 * 目录里多出来的文件一律删掉（别让人往网关的库目录里塞一个同名库）。
 *
 * 剩下的边界（SECURITY.md）：核完到 node / ld.so 真正映射进来之间有几毫秒的窗口；网关跑着时 files/gw/glibc 被换，
 * 网关起 claude 前会再核（gateway/gw/gwpin.mjs），对不上那一轮不起、网关退出让这里重新核。
 */
final class GwRuntime {
    private static final String TAG = "cccodroid.gw";

    final File dir, glibc;
    private final Env env;
    private final Context ctx;

    GwRuntime(Context c, Env env) {
        this.ctx = c; this.env = env;
        dir = new File(env.files, "gw");
        glibc = new File(dir, "glibc");
    }

    File node() { return new File(dir, "node"); }
    File loader() { return new File(glibc, "ld-linux-aarch64.so.1"); }

    /** 安装包钉的那份（assets/gwpin.json）；没有返回 null */
    static JSONObject pin(Context c) {
        String s = AppFiles.assetText(c, "gwpin.json");
        if (s == null) return null;
        try { return new JSONObject(s); } catch (Exception e) { return null; }
    }

    /** 发行版（gateway/gw/edition.mjs 里的 SEALED）：读安装包里那份原文，不认盘上的、不认任何开关 */
    static boolean sealed(Context c) {
        String s = AppFiles.assetText(c, "app/gw/edition.mjs");
        return s == null || !java.util.regex.Pattern.compile("(?m)^let SEALED = false;").matcher(s).find();   // 认不出按发行版，宁严勿松
    }

    /** glibc 那组的钉子（文件名 → sha256），交给网关在起 claude 前再核 */
    String glibcPin() {
        JSONObject p = pin(ctx);
        JSONObject g = p == null ? null : p.optJSONObject("glibc");
        if (g == null) return "";
        JSONObject o = new JSONObject();
        try { for (java.util.Iterator<String> it = g.keys(); it.hasNext(); ) { String k = it.next(); o.put(k, g.getJSONObject(k).getString("sha256")); } }
        catch (Exception e) { return ""; }
        return o.toString();
    }

    /** 进度（通知栏上的那行字）；可为 null */
    interface Say { void say(String s); }

    /**
     * 让 files/gw 和钉子一致。返回 null 表示好了；否则是给人看的原因。
     * @param fetch 本地凑不齐时可以联网取钉住那版的基础模块包
     */
    String ensure(boolean fetch, Say say) {
        JSONObject p = pin(ctx);
        if (p == null) return Tr.t("安装包里没有网关运行库的清单（gwpin.json）");
        if (!ctx.getPackageName().equals(p.optString("target"))) return Tr.f("网关运行库的清单是给 {0} 的", p.optString("target"));
        JSONObject gw = p.optJSONObject("gw"), gl = p.optJSONObject("glibc");
        if (gw == null || gl == null || !gw.has("node")) return Tr.t("网关运行库的清单坏了");
        dir.mkdirs(); glibc.mkdirs();
        java.util.List<String[]> missing = new java.util.ArrayList<>();   // {目标路径, 源相对路径, sha256}
        try {
            prune(dir, gw, true);
            prune(glibc, gl, false);
            for (Object[] grp : new Object[][] { { dir, gw }, { glibc, gl } }) {
                File d = (File) grp[0]; JSONObject g = (JSONObject) grp[1];
                for (java.util.Iterator<String> it = g.keys(); it.hasNext(); ) {
                    String name = it.next();
                    JSONObject e = g.getJSONObject(name);
                    File dst = new File(d, name);
                    String want = e.getString("sha256"), src = e.getString("src");
                    if (want.equals(shaCached(dst))) continue;
                    File from = new File(env.usr, src);
                    if (want.equals(shaCached(from))) { put(from, dst, want, null); continue; }
                    missing.add(new String[] { dst.getPath(), src, want });
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "整理 files/gw 失败", e);
            return Tr.t("整理网关运行库失败：") + e.getMessage();
        }
        if (missing.isEmpty()) return null;
        Log.w(TAG, "files/gw 缺 " + missing.size() + " 个，$PREFIX 里也对不上");
        if (!fetch) return Tr.f("网关运行库有 {0} 个文件和安装包对不上", missing.size());
        try {
            fetchBase(missing, say);
            return null;
        } catch (Exception e) {
            Log.w(TAG, "联网取网关运行库失败", e);
            return Tr.t("网关运行库和安装包对不上，联网取回也没成：") + e.getMessage();
        }
    }

    /** 删掉目录里钉子以外的东西（top：网关目录，glibc 子目录留着） */
    private static void prune(File d, JSONObject keep, boolean top) {
        File[] fs = d.listFiles();
        if (fs == null) return;
        for (File f : fs) {
            String n = f.getName();
            if (top && n.equals("glibc") && f.isDirectory() && !isLink(f)) continue;
            if (keep.has(n) && f.isFile() && !isLink(f)) continue;
            Installer.deleteTree(f);
        }
    }

    private static boolean isLink(File f) {
        try { return android.system.OsConstants.S_ISLNK(Os.lstat(f.getPath()).st_mode); } catch (Exception e) { return false; }
    }

    /**
     * 拷进来：写到随机名的临时文件、核过再换名；swap 非空时边拷边改前缀（等长）。
     * 目录同 uid 可写，写的时候别人能抢先放符号链接、写完换成别的文件（DeepSeek 复核 v067 必修 1）：
     * 临时文件 O_CREAT|O_EXCL 新建（不跟已有的链接），权限用 fchmod 打在自己打开的那个上，
     * 换名前后都按 inode 认是不是自己写的那个，不是就删掉报错（下次起网关重来）
     */
    private static void put(File from, File dst, String want, byte[][] swap) throws IOException {
        File tmp = new File(dst.getPath() + ".tmp-" + Long.toHexString(new java.security.SecureRandom().nextLong() & Long.MAX_VALUE));
        MessageDigest md = md();
        java.io.FileDescriptor fd;
        try { fd = Os.open(tmp.getPath(), OsConstants.O_WRONLY | OsConstants.O_CREAT | OsConstants.O_EXCL | OsConstants.O_NOFOLLOW, 0600); }
        catch (android.system.ErrnoException e) { throw new IOException(e.getMessage()); }
        long ino;
        try (InputStream in = new FileInputStream(from); FileOutputStream o = new FileOutputStream(fd)) {
            byte[] all = swap == null ? null : readAll(in);
            if (all != null) { swapInPlace(all, swap[0], swap[1]); md.update(all); o.write(all); }
            else { byte[] b = new byte[1 << 20]; for (int n; (n = in.read(b)) > 0; ) { md.update(b, 0, n); o.write(b, 0, n); } }
            o.flush();
            Os.fsync(fd);
            Os.fchmod(fd, 0700);
            ino = Os.fstat(fd).st_ino;
        } catch (android.system.ErrnoException e) {
            tmp.delete(); throw new IOException(e.getMessage());
        } finally {
            try { Os.close(fd); } catch (Exception ignored) {}
        }
        String got = Installer.hex(md.digest());
        if (!want.equals(got)) { tmp.delete(); throw new IOException(Tr.f("{0} 拷过来以后对不上", dst.getName())); }
        try {
            android.system.StructStat t = Os.lstat(tmp.getPath());
            if (!OsConstants.S_ISREG(t.st_mode) || t.st_ino != ino) { tmp.delete(); throw new IOException(Tr.f("{0} 拷过来以后对不上", dst.getName())); }
            Os.rename(tmp.getPath(), dst.getPath());
            android.system.StructStat d = Os.lstat(dst.getPath());
            if (!OsConstants.S_ISREG(d.st_mode) || d.st_ino != ino) { dst.delete(); throw new IOException(Tr.f("{0} 拷过来以后对不上", dst.getName())); }
        } catch (android.system.ErrnoException e) {
            tmp.delete(); throw new IOException(Tr.t("换名失败: ") + dst);
        }
        CACHE.remove(dst.getPath());
    }

    /**
     * 联网取钉住那版工具包的基础模块包（devkit-pin.json 钉 modules.json 的 sha256，modules.json 钉包的 sha256 与 tar 的 sha256），
     * 解到 files/gw-stage，取出要的文件按钉子核过放进来，然后把下载的包和解出的东西都删掉
     */
    private void fetchBase(java.util.List<String[]> missing, Say say) throws Exception {
        JSONObject dp = Updater.devkitPin(ctx);
        JSONObject mref = dp == null ? null : dp.optJSONObject("modules");
        if (mref == null) throw new IOException(Tr.t("安装包里的工具包清单没有模块表"));
        String base = dp.optString("base"), tag = dp.optString("tag");
        String mjUrl = base + mref.optString("file", "modules.json");
        byte[] mj;
        try { mj = Installer.httpGetSmall(mjUrl); }
        catch (IOException e) { mj = Installer.httpGetSmall(Installer.DEVKIT_MIRROR + tag + "/" + mref.optString("file", "modules.json")); }
        if (!mref.optString("sha256").equals(Installer.hex(md().digest(mj)))) throw new IOException(Tr.t("模块表和安装包钉的对不上"));
        JSONObject baseMod = null;
        org.json.JSONArray mods = new JSONObject(new String(mj, StandardCharsets.UTF_8)).optJSONArray("modules");
        for (int i = 0; mods != null && i < mods.length(); i++) if ("base".equals(mods.getJSONObject(i).optString("kind"))) baseMod = mods.getJSONObject(i);
        JSONObject gz = baseMod == null ? null : baseMod.optJSONObject("gz"), tar = baseMod == null ? null : baseMod.optJSONObject("tar");
        if (gz == null || tar == null) throw new IOException(Tr.t("模块表里没有基础模块"));
        Installer ins = new Installer(env, new Installer.Progress() {
            public void step(String m) { if (say != null) say.say(m); }
            public void bytes(long done, long total) {}
        });
        long need = gz.optLong("bytes") + tar.optLong("bytes") + (100L << 20);
        long free = new android.os.StatFs(env.files.getPath()).getAvailableBytes();
        if (free < need) throw new Installer.NoSpace(need, free);
        String file = gz.optString("file");
        if (say != null) say.say(Tr.f("取回网关运行库：下载 {0} MB…", String.valueOf(gz.optLong("bytes") >> 20)));
        File got = ins.download(Installer.DEVKIT_MIRROR + tag + "/" + file, base + file, new File(env.files, "gw-" + file), gz.optLong("bytes"), gz.optString("sha256"));
        File stage = new File(env.files, "gw-stage");
        Installer.deleteTree(stage);
        try {
            stage.mkdirs();
            if (say != null) say.say(Tr.t("取回网关运行库：解包…"));
            ins.extractInto(stage, new FileInputStream(got), got.length(), true, tar.optString("sha256"));
            // 包是给 devkit-pin 的目标包名做的；本应用包名不同（开发版）就等长改前缀，和 devkit.mjs gwpin 算钉子时一样
            String from = dp.optString("target"), to = ctx.getPackageName();
            byte[][] swap = null;
            if (!from.isEmpty() && !from.equals(to)) {
                byte[] a = ("/data/data/" + from + "/").getBytes(StandardCharsets.UTF_8), b = ("/data/data/" + to + "/").getBytes(StandardCharsets.UTF_8);
                if (a.length != b.length) throw new IOException(Tr.t("包名长度不同，没法改前缀"));
                swap = new byte[][] { a, b };
            }
            for (String[] m : missing) put(new File(stage, m[1]), new File(m[0]), m[2], swap);
        } finally {
            Installer.deleteTree(stage);
            got.delete();
            new File(got.getPath() + ".sha256").delete();
        }
    }

    // ── 哈希缓存：同一个文件（inode、大小、修改时间、ctime 都没变）不重算。ctime 用户态改不了，换内容一定会变 ──
    private static final java.util.Map<String, String[]> CACHE = new java.util.concurrent.ConcurrentHashMap<>();

    static String shaCached(File f) {
        try {
            android.system.StructStat s = Os.lstat(f.getPath());
            if (!android.system.OsConstants.S_ISREG(s.st_mode)) return "";
            String fp = s.st_ino + ":" + s.st_size + ":" + s.st_mtime + ":" + s.st_ctime;   // minSdk 26 没有 st_mtim / st_ctim（纳秒要 API 27）
            String[] c = CACHE.get(f.getPath());
            // 刚改过的不信缓存：时间戳只到秒，同一秒里写两遍、大小不变，指纹就一样
            if (c != null && c[0].equals(fp) && System.currentTimeMillis() / 1000 - s.st_ctime > 2) return c[1];
            String h = Installer.sha256(f);
            CACHE.put(f.getPath(), new String[] { fp, h });
            return h;
        } catch (Exception e) { return ""; }
    }

    private static MessageDigest md() {
        try { return MessageDigest.getInstance("SHA-256"); } catch (java.security.NoSuchAlgorithmException e) { throw new RuntimeException(e); }
    }

    private static byte[] readAll(InputStream in) throws IOException {
        java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
        byte[] b = new byte[1 << 20];
        for (int n; (n = in.read(b)) > 0; ) bo.write(b, 0, n);
        return bo.toByteArray();
    }

    private static void swapInPlace(byte[] buf, byte[] a, byte[] b) {
        outer:
        for (int i = 0; i + a.length <= buf.length; i++) {
            for (int j = 0; j < a.length; j++) if (buf[i + j] != a[j]) continue outer;
            System.arraycopy(b, 0, buf, i, b.length);
            i += a.length - 1;
        }
    }
}
