package cc.codroid;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.Build;
import android.os.ParcelFileDescriptor;
import android.os.StatFs;
import android.provider.OpenableColumns;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/**
 * 往外发文件：会话导出包、日志包，经系统分享面板交给别的应用。
 *
 * 自己写一个最小的 ContentProvider，不引 androidx 的 FileProvider（构建链里没有它）。
 * 不导出，只靠分享时随 Intent 发出的一次性读授权访问；只认三个目录，别的路径一概拒绝。
 */
public final class Share extends ContentProvider {
    static final String AUTH = "cc.codroid.share";

    /** URI 第一段 → 允许的根目录 */
    private static File root(Context c, String name) {
        Env env = new Env(c);
        switch (name) {
            case "logs": return new File(env.files, "cache/share");
            case "exports": return new File(env.home, "exports");
            case "sexports": { File s = env.shared(); return s == null ? null : new File(s, "exports"); }
            case "camera": return Camera.dir(c);          // 拍照：系统相机往这里写（只有这个根可写）
            default: return null;
        }
    }

    /** 绝对路径 → content:// 地址；不在允许的目录里就返回 null */
    static Uri uriFor(Context c, File f) throws IOException {
        String p = f.getCanonicalPath();
        for (String r : new String[]{"logs", "exports", "sexports", "camera"}) {
            File d = root(c, r);
            if (d == null) continue;
            String dp = d.getCanonicalPath() + "/";
            if (p.startsWith(dp)) return new Uri.Builder().scheme("content").authority(AUTH).appendPath(r).appendEncodedPath(Uri.encode(p.substring(dp.length()), "/")).build();
        }
        return null;
    }

    private File fileFor(Uri u) throws FileNotFoundException {
        java.util.List<String> seg = u.getPathSegments();
        if (seg.size() < 2) throw new FileNotFoundException();
        File d = root(getContext(), seg.get(0));
        if (d == null) throw new FileNotFoundException();
        try {
            File f = new File(d, String.join("/", seg.subList(1, seg.size()))).getCanonicalFile();
            if (!f.getPath().startsWith(d.getCanonicalPath() + "/") || !f.isFile()) throw new FileNotFoundException();
            return f;
        } catch (IOException e) { throw new FileNotFoundException(); }
    }

    /** 不往外分享的：本应用的令牌与厂商密钥配置（审查 10-29 第六份 低7），Claude 登录凭据、SSH/GPG 目录、私钥与证书库（v0.5.7 独立审查 L7） */
    static boolean secret(File f) {
        String nm = f.getName(), p = f.getPath();
        return nm.equals(".gateway-token") || nm.matches("ccapp-(providers|config|seed).*\\.json") || nm.equals("ccapp-key") || nm.equals("llama-api-key")
            || nm.equals(".credentials.json") || nm.matches("id_(rsa|dsa|ecdsa|ed25519)(_sk)?") || nm.matches("(?i).*\\.(pem|key|p12|pfx|jks|keystore)")
            || nm.equals(".netrc") || nm.equals(".git-credentials")
            // Claude 的登录与设置（.claude.json 里有 OAuth 刷新令牌，settings.json 常放 ANTHROPIC_AUTH_TOKEN）、npm / pip 的令牌（审查 v0513b 低-19）
            || nm.equals(".claude.json") || nm.matches("\\.claude\\.json\\.backup.*") || p.matches(".*/\\.claude/settings(\\.local)?\\.json")
            || nm.equals(".npmrc") || nm.equals(".pypirc") || nm.equals("hosts.yml") && p.contains("/gh/")
            // 其他常见的包管理 / 数据库 / 云凭据（10-31 复核）
            || nm.equals(".yarnrc.yml") || nm.equals("pip.conf") || nm.equals(".pgpass") || nm.equals(".my.cnf") || nm.equals(".s3cfg") || nm.equals(".boto")
            || nm.equals(".terraformrc") || nm.equals("credentials.tfrc.json") || p.matches(".*/\\.m2/settings(-security)?\\.xml") || p.matches(".*/\\.gradle/gradle\\.properties")
            || p.matches(".*/\\.cargo/credentials(\\.toml)?")
            || p.matches(".*/\\.(ssh|gnupg|aws|docker|kube|azure)/.*") || p.matches(".*/\\.config/gcloud/.*");
    }

    /** 能不能交出本应用（分享、「保存到」）：凭据按真实路径拦（软链指过去的也算）；
     *  私有目录里只交工作区和导出目录的，别的（配置、登录态、日志、会话记录）和网关 /api/file 一样不往外给（审查 v0513b 低-19）。
     *  「私有目录」是整个应用数据目录（shared_prefs、databases、files 下 home 以外的都算），不只 home（审查 v0.5.20 09-015）；
     *  诊断包和拍照那两个分享根照常能交 */
    static void guard(Context c, File f) throws IOException {
        File cf = f.getCanonicalFile();
        if (secret(cf)) throw new IOException(Tr.t("这是凭据或私钥文件，不分享"));
        String p = cf.getPath();
        boolean priv = false;
        for (File d : new File[]{c.getDataDir(), c.createDeviceProtectedStorageContext().getDataDir()})
            if (d != null && p.startsWith(d.getCanonicalPath() + "/")) priv = true;
        if (priv) {
            Env env = new Env(c);
            boolean ok = false;
            for (File d : new File[]{new File(env.home, "workspace"), new File(env.home, "exports"), root(c, "logs"), Camera.dir(c)})
                if (p.startsWith(d.getCanonicalPath() + "/")) ok = true;
            if (!ok) throw new IOException(Tr.t("应用私有目录里的这个文件不分享"));
            // 硬链接不改真实路径：工作区里一个硬链接就能指到凭据文件上（10-31 复核）。私有目录里正常的文件只有一个名字
            try { if (android.system.Os.stat(cf.getPath()).st_nlink > 1) throw new IOException(Tr.t("这个文件有多个硬链接，不分享")); }
            catch (android.system.ErrnoException ignored) {}
        }
    }

    /** 不在允许目录里的文件（工作区、/sdcard 上的）：拷一份到 exports/shared 再分享，别的应用拿到的是这一份的只读授权 */
    static File shareable(Context c, File f) throws Exception {
        if (!f.isFile()) throw new FileNotFoundException(Tr.t("文件不存在：") + f);
        guard(c, f);
        if (uriFor(c, f) != null) return f;
        if (f.length() > 512L << 20) throw new IOException(Tr.t("文件超过 512 MB，不分享"));
        File dir = new File(new Env(c).home, "exports/shared");
        dir.mkdirs();
        // 拷出来的副本放一天就清：以前分享过什么就永远留一份
        File[] old = dir.listFiles();
        long cut = System.currentTimeMillis() - 24L * 3600 * 1000;
        if (old != null) for (File o : old) if (o.lastModified() < cut) {
            File[] in = o.isDirectory() ? o.listFiles() : null;
            if (in != null) for (File x : in) x.delete();
            o.delete();
        }
        // 每次分享一个新的子目录：同名的两次分享以前共用一个副本，后一次会把前一次接收方还没读的内容换掉（审查 v0.5.20 09-004）
        File sub;
        do { sub = new File(dir, Long.toString(System.currentTimeMillis(), 36) + "-" + Integer.toHexString(new java.security.SecureRandom().nextInt())); } while (sub.exists());
        if (!sub.mkdirs()) throw new IOException(Tr.t("建不了分享目录"));
        File dst = new File(sub, f.getName());
        java.nio.file.Files.copy(f.toPath(), dst.toPath());
        return dst;
    }

    /** 按扩展名猜类型；猜不出就当二进制 */
    static String mimeOf(File f) { return mimeOfName(f.getName()); }
    /** 只看最后一个点后面的后缀。以前先 Uri.encode 再交给 getFileExtensionFromUrl：后者整名只认 [a-zA-Z_0-9.\-()%]，
     *  O'Reilly.pdf、report~draft.pdf、photo!.jpg 这种普通名字就取不到后缀，一律报成二进制（#147-2） */
    static String mimeOfName(String name) {
        int dot = name == null ? -1 : name.lastIndexOf('.');
        String ext = dot < 0 ? "" : name.substring(dot + 1).toLowerCase(java.util.Locale.ROOT);
        String m = ext.isEmpty() || !ext.matches("[a-z0-9]{1,16}") ? null : android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
        return m == null ? "application/octet-stream" : m;
    }

    /** 分享面板按类型筛目标应用：text/markdown、text/x-python 这类冷门文本类型，有的应用（实测 QQ 的「发送给好友」）不接，
     *  只剩收藏 / 发到电脑。文本统一按 text/plain 报（html、csv 各家都认，保留）；接收方按文件名认格式，内容不变 */
    static String sendMime(String mime) {
        if (mime == null || mime.isEmpty()) return "application/octet-stream";
        return mime.startsWith("text/") && !mime.equals("text/html") && !mime.equals("text/csv") ? "text/plain" : mime;
    }

    /** 弹系统分享面板 */
    static JSONObject send(Context c, File f, String mime) throws Exception {
        Uri u = uriFor(c, f);
        if (u == null || !f.isFile()) return new JSONObject().put("ok", false).put("message", Tr.t("这个文件不能分享：") + f);
        Intent send = new Intent(Intent.ACTION_SEND).setType(sendMime(mime))
            .putExtra(Intent.EXTRA_STREAM, u).putExtra(Intent.EXTRA_SUBJECT, f.getName())
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        send.setClipData(android.content.ClipData.newRawUri(f.getName(), u));
        c.startActivity(Intent.createChooser(send, f.getName())
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION));
        return new JSONObject().put("ok", true).put("file", f.getPath());
    }

    // ── 日志包 ──────────────────────────────────────────────────────────
    // 密钥、令牌、邮箱抹掉再打包。JSON 里键名像密钥的（apiKey、"token": …）整对抹掉，带数字、短值也算（审查 10-29 L17、v0.5.3 L23）。提问开头那几十个字网关日志里有，界面上发之前会提醒
    private static final Pattern SECRET = Pattern.compile(
        "(sk-[A-Za-z0-9_\\-]{4,}|sk-ant-[A-Za-z0-9_\\-]+|gh[pousr]_[A-Za-z0-9]{8,}|Bearer\\s+[A-Za-z0-9._\\-]{8,}|\"[A-Za-z0-9_\\-]*(?i:key|token|secret|passw(?:or)?d|pin|auth(?:orization)?)[A-Za-z0-9_\\-]*\"\\s*:\\s*\"[^\"]+\"|cc_t_\\d+=[^;\\s]+|X-CC-Token:?\\s*\\S+)");
    // 网址里带的口令参数（预览凭证 ?t=、外壳口令 ?k=、OAuth 回调 code= 之类）：日志里常有完整网址（审查 #49 待确认-7）
    private static final Pattern QSECRET = Pattern.compile("(?i)([?&#;](?:t|k|token|key|api_?key|code|state|access_token|refresh_token|id_token|auth|sig|signature|secret|password|pass|pwd)=)[^&#\\s'\"<>]+");
    // 网址里的账号口令：http://user:pass@host（自定义接口地址可能这么写）
    private static final Pattern USERINFO = Pattern.compile("(?i)(\\b[a-z][a-z0-9+.\\-]*://)[^/\\s@'\"<>]+@");
    private static final Pattern EMAIL = Pattern.compile("[A-Za-z0-9._%+\\-]+@[A-Za-z0-9.\\-]+\\.[A-Za-z]{2,}");
    // 网关日志里记着每条提问 / 插话的开头几十个字：那是用户的对话内容，诊断用不着，抹掉
    private static final Pattern ASK = Pattern.compile("(▶ (?:提问|命令) ).*?(  \\((?:续 [0-9a-f]{8}|新会话)\\))", Pattern.DOTALL);
    private static final Pattern INJ = Pattern.compile("(↪ 插话 ).*");
    // 本地命令的参数、工具确认带的命令 / 路径 / 网址：新版网关不再记，旧日志里还有（审查 v0.5.20 08-001）
    private static final Pattern LOCAL_CMD = Pattern.compile("(⌘ 本地命令 /[A-Za-z]+)[^\\n]*");
    private static final Pattern TOOL_ARG = Pattern.compile("((?:✗ 无人值守，自动拒绝|✓ 全部放行，自动允许|⏸ 等确认|✓ 敏感操作本轮已允许过，放行) [^\\s（]+(?:（子代理）)?)[^\\n]*");
    // 私钥块、.env 式的「名字里带 KEY/TOKEN/SECRET/PASSWORD 的变量=值」（审查 10-30 第九份 安卓低11）
    private static final Pattern PEM = Pattern.compile("-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?(-----END [A-Z0-9 ]*PRIVATE KEY-----|\\z)", Pattern.DOTALL);
    private static final Pattern ENVKV = Pattern.compile("(?m)\\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIALS?)[A-Z0-9_]*\\s*[=:]\\s*)[\"']?[^\\s\"']{4,}[\"']?");
    static String scrub(String s) {
        s = PEM.matcher(s).replaceAll("«私钥已抹去»");
        s = ENVKV.matcher(s).replaceAll("$1«已抹去»");
        s = INJ.matcher(ASK.matcher(s).replaceAll("$1«内容已抹去»$2")).replaceAll("$1«内容已抹去»");
        s = TOOL_ARG.matcher(LOCAL_CMD.matcher(s).replaceAll("$1")).replaceAll("$1");
        s = QSECRET.matcher(s).replaceAll("$1«已抹去»");
        s = USERINFO.matcher(s).replaceAll("$1«已抹去»@");
        return EMAIL.matcher(SECRET.matcher(s).replaceAll("«已抹去»")).replaceAll("«邮箱»");
    }

    /** 包里有什么、去掉了什么 —— 「我卡住了」打包前给用户看的就是这份（README.txt 也放一份进包里） */
    static String contents() { return
        Tr.t("包里有：\n") +
        Tr.t("· 版本与设备：cccodroid / Android 版本、机型、芯片、剩余空间\n") +
        Tr.t("· 开发工具包：装的是哪一版（校验哈希）、更新与自检状态\n") +
        Tr.t("· 最近的日志：本应用的系统日志、网关日志的最后一段\n") +
        Tr.t("· 修复账本：安装、校验、修复做过哪些、成没成\n") +
        Tr.t("· 网络：开没开 VPN，应用连不连得上几个下载源（只记结果）\n") +
        Tr.t("\n已经去掉：\n") +
        Tr.t("· 密钥、令牌、登录凭据、邮箱\n") +
        Tr.t("· 你发给 Claude 的消息内容（日志里只留「提问了一次」）\n") +
        Tr.t("· 会话记录本身不在包里\n"); }

    /** 打包：诊断信息 + 本应用 logcat + 网关日志尾部 + 修复账本 → files/cache/share/cccodroid-logs-*.zip */
    static File bundleLogs(Context c) throws Exception {
        Env env = new Env(c);
        File dir = new File(env.files, "cache/share");
        dir.mkdirs();
        File[] old = dir.listFiles();
        if (old != null) for (File o : old) if (o.getName().startsWith("cccodroid-logs-")) o.delete();
        String stamp = new SimpleDateFormat("yyyyMMdd-HHmmss-SSS", Locale.ROOT).format(new Date());
        File out = new File(dir, "cccodroid-logs-" + stamp + ".zip");
        JSONObject parts = new JSONObject();
        try (ZipOutputStream z = new ZipOutputStream(new FileOutputStream(out))) {
            parts.put("README.txt", put(z, "README.txt", Tr.t("cccodroid 诊断包（「我卡住了」）\n\n") + contents()));
            parts.put("diagnostics.txt", put(z, "diagnostics.txt", diagnostics(c, env)));
            parts.put("logcat.txt", put(z, "logcat.txt", scrub(logcat())));
            if (env.log.isFile()) parts.put("gateway.log", put(z, "gateway.log", scrub(tail(env.log, 1024 * 1024))));
            // 网关进程的标准输出 / 错误：node 崩溃的堆栈只在这里
            File gout = new File(env.home, "gateway.out");
            if (gout.isFile()) parts.put("gateway.out", put(z, "gateway.out", scrub(tail(gout, 512 * 1024))));
            File led = Ledger.file(env);
            if (led.isFile()) parts.put("ledger.jsonl", put(z, "ledger.jsonl", scrub(tail(led, 512 * 1024))));
        }
        Ledger.add(env, "logs", true, Tr.f("打包日志用于分享（压缩后 {0} KB）", out.length() / 1024), parts);
        return out;
    }

    /** @return 写进去的字节数（账本里记一笔，方便核对包里到底有什么） */
    private static int put(ZipOutputStream z, String name, String text) throws IOException {
        byte[] b = text.getBytes(StandardCharsets.UTF_8);
        z.putNextEntry(new ZipEntry(name));
        z.write(b);
        z.closeEntry();
        return b.length;
    }

    private static String diagnostics(Context c, Env env) {
        StringBuilder sb = new StringBuilder();
        try {
            sb.append("cccodroid ").append(c.getPackageManager().getPackageInfo(c.getPackageName(), 0).versionName).append('\n');
            sb.append("Android ").append(Build.VERSION.RELEASE).append(" (SDK ").append(Build.VERSION.SDK_INT).append(")  ")
              .append(Build.MANUFACTURER).append(' ').append(Build.MODEL).append("  ").append(Build.SUPPORTED_ABIS[0]).append('\n');
            sb.append("user=").append(android.os.Process.myUid() / 100000).append("  files=").append(c.getFilesDir().getAbsolutePath())
              .append(MainActivity.secondaryUser(c) ? "  （非主空间）" : "").append('\n');
            sb.append("SoC ").append(Build.VERSION.SDK_INT >= 31 ? Build.SOC_MODEL : "?").append("  内核 ").append(System.getProperty("os.version")).append('\n');
            StatFs st = new StatFs(env.files.getPath());
            sb.append("私有目录剩余 ").append(st.getAvailableBytes() >> 20).append(" MB\n");
            sb.append("开发工具包就绪 ").append(env.devkitReady()).append("  claude 就绪 ").append(env.claudeReady()).append('\n');
            File ok = new File(env.usr, ".devkit-ok");
            if (ok.isFile()) sb.append(".devkit-ok ").append(new String(java.nio.file.Files.readAllBytes(ok.toPath()), StandardCharsets.UTF_8).trim()).append('\n');
            sb.append("安全模式 ").append(new File(env.home, ".ccapp-safe-mode").exists()).append('\n');
            sb.append("\n更新状态\n").append(Updater.get(c).status().toString(1)).append('\n');
        } catch (Exception e) { sb.append("（诊断信息不全：").append(e).append("）\n"); }
        envFails(env, sb);
        netProbe(c, env, sb);
        return scrub(sb.toString());
    }

    /** 本机自检没过的项（网关跑完写在 ~/.cccodroid-env.json；以前诊断包只看得到「失败 10 项」） */
    private static void envFails(Env env, StringBuilder sb) {
        File f = new File(env.home, ".cccodroid-env.json");
        if (!f.isFile()) return;
        try {
            JSONObject j = new JSONObject(new String(java.nio.file.Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8));
            org.json.JSONArray fail = j.optJSONArray("fail");
            sb.append("\n本机自检：通过 ").append(j.optInt("pass")).append(" 项，失败 ").append(fail == null ? 0 : fail.length()).append(" 项\n");
            for (int i = 0; fail != null && i < Math.min(fail.length(), 40); i++) sb.append("  ✗ ").append(fail.optString(i)).append('\n');
        } catch (Exception e) { sb.append("（读不了自检结果：").append(e.getMessage()).append("）\n"); }
    }

    // 下载 Claude Code / 组件 / 更新要连的几个地方
    private static final String[] PROBE_HOSTS = { "downloads.claude.ai", "cccodroid.net", "dl.cccodroid.net", "registry.npmmirror.com", "registry.npmjs.org", "github.com" };

    /** 网络：系统看到的网络状态 + Java 解析 + 应用自己的 curl 连一下（并行，总共最多十来秒）。
     *  安装失败常见的是「Java 能下、原生程序出不去」（VPN / 联网控制），两边都测才分得清。只记结果，不发任何内容 */
    private static void netProbe(Context c, Env env, StringBuilder sb) {
        sb.append("\n网络\n");
        try {
            android.net.ConnectivityManager cm = c.getSystemService(android.net.ConnectivityManager.class);
            android.net.Network n = cm.getActiveNetwork();
            android.net.NetworkCapabilities nc = n == null ? null : cm.getNetworkCapabilities(n);
            String kind = nc == null ? "无" : nc.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI) ? "WLAN"
                : nc.hasTransport(android.net.NetworkCapabilities.TRANSPORT_CELLULAR) ? "移动数据" : "其他";
            sb.append("当前网络 ").append(kind)
              .append("  VPN ").append(nc != null && nc.hasTransport(android.net.NetworkCapabilities.TRANSPORT_VPN))
              .append("  系统已验证可上网 ").append(nc != null && nc.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_VALIDATED))
              .append("  后台数据限制 ").append(cm.getRestrictBackgroundStatus()).append("（1=未限制 2=白名单 3=受限）\n");
        } catch (Exception e) { sb.append("（读不了网络状态：").append(e.getMessage()).append("）\n"); }
        File curl = new File(env.usr, "bin/curl");
        final String[] res = new String[PROBE_HOSTS.length];
        Thread[] ts = new Thread[PROBE_HOSTS.length];
        for (int i = 0; i < PROBE_HOSTS.length; i++) {
            final int k = i;
            ts[i] = new Thread(() -> res[k] = probeHost(env, curl, PROBE_HOSTS[k]), "probe");
            ts[i].start();
        }
        long end = System.currentTimeMillis() + 15000;
        for (int i = 0; i < ts.length; i++) {
            try { ts[i].join(Math.max(1, end - System.currentTimeMillis())); } catch (InterruptedException ignored) {}
            sb.append("  ").append(PROBE_HOSTS[i]).append("  ").append(res[i] != null ? res[i] : "（没来得及测完）").append('\n');
        }
    }

    private static String probeHost(Env env, File curl, String host) {
        StringBuilder r = new StringBuilder();
        long t0 = System.currentTimeMillis();
        try {
            // getAllByName 没有超时：DNS 黑洞时会一直卡，单独放个线程只等 4 秒
            java.util.concurrent.FutureTask<java.net.InetAddress[]> dns = new java.util.concurrent.FutureTask<>(() -> java.net.InetAddress.getAllByName(host));
            Thread dt = new Thread(dns, "probe-dns"); dt.setDaemon(true); dt.start();
            java.net.InetAddress[] a = dns.get(4, java.util.concurrent.TimeUnit.SECONDS);
            r.append("Java 解析 ").append(a.length > 0 ? a[0].getHostAddress() : "空").append(" ").append(System.currentTimeMillis() - t0).append("ms");
        } catch (java.util.concurrent.TimeoutException e) { r.append("Java 解析超时（4 秒）");
        } catch (java.util.concurrent.ExecutionException e) { r.append("Java 解析失败 ").append(e.getCause() == null ? "?" : e.getCause().getClass().getSimpleName());
        } catch (Exception e) { r.append("Java 解析失败 ").append(e.getClass().getSimpleName()); }
        if (!curl.isFile()) return r.append("  （没有 curl）").toString();
        Process p = null;
        try {
            ProcessBuilder pb = new ProcessBuilder(env.cmd(curl.getPath(), "-sS", "-o", "/dev/null", "-w", "HTTP %{http_code} %{remote_ip} %{time_total}s",
                "--connect-timeout", "5", "--max-time", "10", "https://" + host + "/"));
            env.apply(pb.environment());
            pb.directory(env.home);
            pb.redirectErrorStream(true);
            p = pb.start();
            String out = readAll(p.getInputStream()).trim().replace('\n', ' ');
            if (!p.waitFor(12, java.util.concurrent.TimeUnit.SECONDS)) { p.destroyForcibly(); p.waitFor(2, java.util.concurrent.TimeUnit.SECONDS); return r.append("  curl 卡住").toString(); }
            r.append("  curl rc=").append(p.exitValue()).append(' ').append(out.length() > 200 ? out.substring(0, 200) : out);
        } catch (Exception e) {
            r.append("  curl 起不来：").append(e.getMessage());
            if (p != null) { p.destroyForcibly(); try { p.waitFor(2, java.util.concurrent.TimeUnit.SECONDS); } catch (InterruptedException ignored) {} }
        }
        return r.toString();
    }

    /** 本进程能读到的只有自己的日志（安卓 4.1 起），正好 */
    private static String logcat() {
        try {
            Process p = new ProcessBuilder("logcat", "-d", "-v", "time", "-t", "8000").redirectErrorStream(true).start();
            String s = readAll(p.getInputStream());
            p.waitFor();
            return s;
        } catch (Exception e) { return "（读不到 logcat：" + e + "）"; }
    }

    private static String tail(File f, int max) throws IOException {
        try (RandomAccessFile r = new RandomAccessFile(f, "r")) {
            long n = r.length(), from = Math.max(0, n - max);
            byte[] b = new byte[(int) (n - from)];
            r.seek(from); r.readFully(b);
            return (from > 0 ? "…（前面省略 " + from / 1024 + " KB）\n" : "") + new String(b, StandardCharsets.UTF_8);
        }
    }

    private static String readAll(InputStream in) throws IOException {
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        byte[] b = new byte[65536];
        for (int k; (k = in.read(b)) > 0; ) o.write(b, 0, k);
        return o.toString("UTF-8");
    }

    // ── ContentProvider ────────────────────────────────────────────────
    @Override public boolean onCreate() { return true; }

    @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if ("r".equals(mode)) {
            // 交出去之前照「分享」的规矩再查一遍（凭据、私有目录、硬链接），不只看在不在分享根下面（11-03 审查 L-12）
            File f = fileFor(uri);
            try { guard(getContext(), f); } catch (IOException e) { throw new FileNotFoundException(e.getMessage()); }
            return ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY);
        }
        // 只有拍照目录可写：相机按 EXTRA_OUTPUT 写进我们事先建好的空文件
        if (uri.getPathSegments().size() == 2 && "camera".equals(uri.getPathSegments().get(0)))
            return ParcelFileDescriptor.open(fileFor(uri), ParcelFileDescriptor.parseMode(mode));
        throw new FileNotFoundException("只读");
    }

    @Override public Cursor query(Uri uri, String[] proj, String sel, String[] args, String sort) {
        File f;
        try { f = fileFor(uri); } catch (FileNotFoundException e) { return null; }
        String[] cols = proj != null ? proj : new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE};
        MatrixCursor c = new MatrixCursor(cols, 1);
        Object[] row = new Object[cols.length];
        for (int i = 0; i < cols.length; i++) {
            if (OpenableColumns.DISPLAY_NAME.equals(cols[i])) row[i] = f.getName();
            else if (OpenableColumns.SIZE.equals(cols[i])) row[i] = f.length();
        }
        c.addRow(row);
        return c;
    }

    @Override public String getType(Uri uri) {
        // 和发出去时 Intent 里写的类型同一套（月报 PNG、PDF 以前在这里都报成二进制，按类型打开的接收方会被系统拒掉，#147-3）
        return mimeOfName(uri.getLastPathSegment());
    }
    @Override public Uri insert(Uri uri, ContentValues v) { throw new UnsupportedOperationException(); }
    @Override public int delete(Uri uri, String s, String[] a) { throw new UnsupportedOperationException(); }
    @Override public int update(Uri uri, ContentValues v, String s, String[] a) { throw new UnsupportedOperationException(); }
}
