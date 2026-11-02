package cc.codroid;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.ConnectivityManager;
import android.os.StatFs;
import android.system.Os;
import android.util.Log;
import java.io.File;
import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 三样东西的更新：应用本体（APK）、开发工具包（devkit）、官方 Claude Code。默认自动。
 *
 *   Claude Code：装进新的版本目录再切 current 指针 —— 正在跑的 claude 用的还是旧文件，不受影响，所以全程静默。
 *                （它自带的自动更新被 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC 关了，而且也不认我们的目录布局。）
 *   APK：下载、核对签名与本应用一致。有 Shizuku 且空闲、界面不在前台时静默装；否则发通知，点一下走系统安装确认。
 *   工具包：按已装的模块下（0.3.8 及以前的整包约 650 MB，升上来时装全部模块），会替换整个 $PREFIX。自动模式只在不计流量的网络上预先下载；
 *           下次冷启动且没有任务在跑时替换（或用户在设置页点"安装"）。用户自装进 $PREFIX 的东西会搬过去。
 *
 * 版本来源：GitHub Releases（v* 是 APK，devkit-* 是工具包）；Claude Code 走官方 downloads.claude.ai。
 *
 * 先后顺序：工具包在下载或替换时，APK 不装（装 APK 会杀掉本进程，把工具包那边拦腰截断）——
 * 等工具包下完（已落盘、已校验）或装完再装 APK。已下好的工具包在新进程启动时接着装。
 * 已装版本只认 .devkit-ok 里记的内容哈希，绝不拿本 APK 内置的钉子去猜（新 APK 的钉子会把旧工具包"认成"新版）。
 */
final class Updater {
    static final String TAG = "cccodroid-upd";
    static final String REPO = "greyoak111/cccodroid";
    /** 备用源：cccodroid.net 镜像了最近几个版本的 APK 和一份同形状的发布列表（dl/releases.json）。
     *  只在 GitHub 连不上 / 下载不顺时用；下来的 APK 照样核 sha256 和签名。工具包太大，没有镜像 */
    static final String MIRROR = "https://cccodroid.net";
    /** 同一份 APK 与发布列表的直连线路（不经 Cloudflare；国内有的网络只通其中一条） */
    static final String DL = "https://dl.cccodroid.net";
    /** 工具包与本 APK 的接口版本：lock.json 里的 compat（缺省 1）对不上就不装，防止新工具包配旧外壳 */
    static final int DEVKIT_COMPAT = 1;
    static final String CH = "updates";
    static final long AUTO_EVERY = 6 * 3600_000L;

    private static Updater inst;
    static synchronized Updater get(Context c) { if (inst == null) inst = new Updater(c.getApplicationContext()); return inst; }

    final Context ctx;
    final Env env;
    private final Item app = new Item("app", "cccodroid"), devkit = new Item("devkit", "开发工具包"), claude = new Item("claude", "Claude Code");
    private volatile boolean checking;
    private volatile String lastError = "";
    /** APK 已下好但因为工具包在忙而推迟安装；user=用户点的（走系统确认），否则静默规则 */
    private volatile boolean appWaiting, appWaitingUser;
    /** 最近一次校验的结果（给界面看） */
    private volatile JSONObject lastVerify;
    private volatile boolean repairing;    // 这次下载 / 安装是「修复」发起的（账本里分开记）

    static final class Item {
        final String id, name;
        volatile String current = "", latest = "", state = "unknown", message = "";
        volatile long done, total;
        // 下载需要的东西
        volatile String url, alt, alt2, sha, base, tarSha;
        volatile long size, need;
        volatile File file;
        // 模块化工具包（0.3.9 起）：modules.json 原文、它的 sha256、要装的模块。file 指向落盘的 modules.json（全部块下完才写，等于「已下好」的记号）
        volatile byte[] modules;
        volatile String modSha;
        volatile java.util.List<String> moduleIds;
        Item(String id, String name) { this.id = id; this.name = name; }   // name 存中文原句，输出时才按当前语言翻（单例建得早，那时界面可能还没报语言）
        JSONObject json() throws Exception {
            return new JSONObject().put("id", id).put("name", Tr.t(name)).put("current", current).put("latest", latest)
                .put("state", state).put("message", message).put("done", done).put("total", total);
        }
        void set(String st, String msg) { state = st; message = msg == null ? "" : msg; Log.i(TAG, id + " → " + st + " " + message); }
    }

    private Updater(Context c) {
        ctx = c;
        env = new Env(c);
        NotificationChannel ch = new NotificationChannel(CH, Tr.t("更新"), NotificationManager.IMPORTANCE_DEFAULT);
        ch.setDescription(Tr.t("新版本已下载、等你点一下安装"));
        c.getSystemService(NotificationManager.class).createNotificationChannel(ch);
        refreshCurrent();
        // 上次下好、还没装的工具包（进程重启后状态在内存里没了，靠这条记录接上）
        try {
            JSONObject st = new JSONObject(prefs().getString("devkitStaged", "{}"));
            File f = new File(st.optString("file", "/nonexistent"));
            if (f.isFile() && f.length() == st.optLong("size")) {
                devkit.file = f; devkit.base = st.getString("base"); devkit.sha = st.getString("sha256");
                devkit.size = st.getLong("size"); devkit.url = devkit.base + f.getName(); devkit.latest = tagOf(devkit.base);
                devkit.alt = devkitMirror(devkit.base, f.getName());
                devkit.tarSha = st.optString("tarSha256", null);
                if (st.has("modSha")) {
                    devkit.modules = java.nio.file.Files.readAllBytes(f.toPath());
                    devkit.modSha = st.getString("modSha");
                    devkit.moduleIds = new java.util.ArrayList<>();
                    JSONArray ids = st.optJSONArray("moduleIds");
                    if (ids != null) for (int i = 0; i < ids.length(); i++) devkit.moduleIds.add(ids.getString(i));
                }
                devkit.set("ready", "");
                dropStagedIfInstalled();
            }
        } catch (Exception ignored) {}
    }

    /** 已下载待装的那份其实已经装上了（上次被打断、recover() 接着装完的）：删掉，别再装一遍 */
    void dropStagedIfInstalled() {
        if (!"ready".equals(devkit.state) || devkit.sha == null || !devkit.sha.equals(installedDevkitSha())) return;
        if (devkit.file != null) devkit.file.delete();
        // 按块下好的压缩包也删（几百 MB）；已经装进去的那几块，installModules 解完就删过了
        if (devkit.modules != null) try {
            JSONArray all = new JSONObject(new String(devkit.modules, StandardCharsets.UTF_8)).optJSONArray("modules");
            for (int i = 0; all != null && i < all.length(); i++) {
                JSONObject gz = all.optJSONObject(i) == null ? null : all.optJSONObject(i).optJSONObject("gz");
                if (gz == null) continue;
                new File(env.files, gz.optString("file")).delete();
                new File(env.files, gz.optString("file") + ".part").delete();
            }
        } catch (Exception ignored) {}
        prefs().edit().remove("devkitStaged").apply();
        refreshCurrent();
        devkit.set("uptodate", "");
    }

    SharedPreferences prefs() { return ctx.getSharedPreferences("upd", Context.MODE_PRIVATE); }
    boolean auto() { return prefs().getBoolean("auto", true); }
    /** stable / latest = 跟随官方渠道；pinned = 固定在 pinVer()，自动更新、检查更新都不动它（用户 10-22 定：不能强制绑最新） */
    String channel() { String o = ovCh; return o != null ? o : prefs().getString("channel", "stable"); }
    String pinVer() { String o = ovPin; return o != null ? o : prefs().getString("pin", ""); }
    // 换渠道 / 固定版本在等用户确认降级时：新设置只放在内存里（见 set），确认了才写盘。
    // 拒绝、出错、进程被杀，盘上都还是原来的设置（10-31 六轮核验：先写盘再回滚，挡不住并发请求和杀进程）
    private volatile String ovCh, ovPin;
    String latestClaude() { return claude.latest; }
    // claude.latest 是哪个渠道查出来的：拿 stable / latest 判降级时，得是同一个渠道的结果才作数
    private volatile String latestCh = "";
    boolean switchingNow() { return switching.get(); }
    boolean claudeInstalled() { refreshCurrent(); return !claude.current.isEmpty(); }
    boolean pinned() { return "pinned".equals(channel()) && !pinVer().isEmpty(); }

    // ── 安装包方案：targetSdk 28（默认，兼容最好）/ 36（系统不让装 28 时用）。同一包名、同一钥匙、同一版本号，互相覆盖安装数据都在 ──
    /** 本机装着的是哪一套 */
    String flavor() { return ctx.getApplicationInfo().targetSdkVersion >= 29 ? "36" : "28"; }
    /** 用户选的：auto / 28 / 36 */
    String flavorPref() { return prefs().getString("flavor", "auto"); }
    /** 认定这台机器只能用 36 的原因（系统拒装 28 时记下，之后一直有效）；空 = 没发现 */
    String only36() { return prefs().getString("only36", ""); }
    /** 更新要下哪一套：只能 36 就 36；用户明选的照办；自动 = 跟着现在装的走（默认发的是 28，换过 36 的人就留在 36） */
    String wantFlavor() {
        if (!only36().isEmpty()) return "36";
        String p = flavorPref();
        return "28".equals(p) || "36".equals(p) ? p : flavor();
    }
    static String apkName(String flavor) { return "36".equals(flavor) ? "cccodroid-36.apk" : "cccodroid.apk"; }
    /** 系统拒装 28 的报错：安卓 14 起有「最低可安装 targetSdk」，以后的版本可能抬过 28 */
    static boolean sdkTooOld(String msg) { return msg != null && msg.contains("DEPRECATED_SDK_VERSION"); }
    /** 装 28 被系统以 targetSdk 太旧拒掉：记下只能 36，改下 36 那套 */
    private void markOnly36(String why) {
        Log.i(TAG, "系统拒装 targetSdk 28 → 以后只用 36：" + why);
        prefs().edit().putString("only36", why.length() > 200 ? why.substring(0, 200) : why).apply();
        if (app.file != null) app.file.delete();
        app.url = null;
        app.set("unknown", "");
        checkAsync(false);
    }

    // ── 状态 ───────────────────────────────────────────────────────────
    JSONObject status() throws Exception {
        refreshCurrent();
        // 结果只在内存里：进程重启后第一次有人来看（打开设置页）就顺手查一次（只查，不自动装）
        if (!checking && "unknown".equals(app.state) && "unknown".equals(claude.state)) checkAsync(true);
        JSONArray a = new JSONArray();
        for (Item i : new Item[]{app, devkit, claude}) a.put(i.json());
        return new JSONObject().put("ok", true).put("auto", auto()).put("channel", channel()).put("pin", pinVer())
            .put("flavor", flavor()).put("flavorPref", flavorPref()).put("only36", only36()).put("wantFlavor", wantFlavor())
            .put("lastCheck", prefs().getLong("lastCheck", 0)).put("checking", checking).put("error", lastError).put("items", a)
            .put("verify", lastVerify == null ? JSONObject.NULL : lastVerify);
    }

    /** 换安装包方案。只能 36 的机器要切 28：拒绝（装上去系统也不认）。返回 null = 已切，否则是拒绝的原因 */
    synchronized String setFlavor(String want) {
        if (!want.equals("auto") && !want.equals("28") && !want.equals("36")) return Tr.t("未知的安装包方案");
        if (want.equals("28") && !only36().isEmpty())
            return Tr.t("这台机器的系统已经不让装 targetSdk 28 的版本，切过去会装不上，所以没有切换。") + "\n" + only36();
        if (want.equals(flavorPref())) return null;
        prefs().edit().putString("flavor", want).apply();
        Log.i(TAG, "安装包方案 → " + want + "（要下 " + wantFlavor() + "，装着 " + flavor() + "）");
        // 要的和装着的不一样：马上查一次，查到就照自动更新的规则下（用户在设置页点「安装」走系统确认）
        // 在途的那份不删不清（05-008）：下完 checkApkSigner 会按方案拒掉，之后的检查再按新方案找
        boolean moving = "downloading".equals(app.state) || "installing".equals(app.state);
        if (!moving && app.file != null && !app.file.getName().endsWith("-" + wantFlavor() + ".apk")) { app.file.delete(); app.url = null; }
        if (!"downloading".equals(app.state) && !"installing".equals(app.state)) app.set("unknown", "");
        checkAsync(true);
        return null;
    }

    void set(JSONObject req) { set(req, "?"); }
    // 换渠道那条线程还在跑（可能在等用户确认降级）：自动更新别插进来，也不接第二次换渠道
    private final java.util.concurrent.atomic.AtomicBoolean switching = new java.util.concurrent.atomic.AtomicBoolean();

    /** who：发起方（Priv.caller 认的，只作对话框里的参考） */
    void set(JSONObject req, String who) {
        if (req.has("auto")) prefs().edit().putBoolean("auto", req.optBoolean("auto", true)).apply();
        String ch = req.optString("channel", ""), pv = req.optString("version", "").trim();
        boolean switched = (ch.equals("stable") || ch.equals("latest")) && !ch.equals(channel());
        String pin = pinVer();
        // 固定版本：换到 pinned、或换固定的版本号都算「明说要这一版」
        if (ch.equals("pinned") && pv.matches("\\d+\\.\\d+\\.\\d+[\\w.+-]*") && (!"pinned".equals(channel()) || !pv.equals(pinVer()))) {
            pin = pv; switched = true;
        }
        if (!switched) return;
        // 同一时间只换一次：上一次还在等确认就不接新的
        if (!switching.compareAndSet(false, true)) { Log.i("cccodroid", "上一次换渠道还没完，这次不接"); return; }
        final String toCh = ch, toPin = pin;
        // 换渠道是用户明说要哪个版本：马上按新渠道查，版本对不上就直接换（切回 stable 也会换回 stable 的版本）
        new Thread(() -> {
            boolean keep = false;
            try {
                ovPin = toPin; ovCh = toCh;
                checkClaude();
                String to = claude.latest;
                // 只按版本判，不看状态：「安装中」时状态不更新，以前借这个跳过确认直接写盘（10-31 七轮核验）
                boolean down = claudeDowngrade(to);
                // 换渠道 / 固定版本落到比已装的旧：和 upd_apply 指定旧版本一样要用户点头（10-31 四轮复核：这是降级的另一条路）
                if (down && !Priv.confirm(Tr.f("把 Claude Code 降级到 {0}", to), who, "upd:" + to)) {
                    Log.i("cccodroid", "没有允许降级到 " + to + "，设置不变");
                } else {
                    prefs().edit().putString("channel", toCh).putString("pin", toPin).commit();
                    keep = true;
                    ovCh = null; ovPin = null;
                    if ("available".equals(claude.state)) apply("claude", true, to);   // 装的就是确认过的这一版
                }
            } catch (Exception ex) {
                // 查不到版本（断网）：stable / latest 的选择照样记下（比已装的旧时 claudeOlder 会挡住自动更新）；固定版本不查网，到不了这里
                if (!"pinned".equals(toCh)) { prefs().edit().putString("channel", toCh).commit(); keep = true; }
                claude.set("error", Tr.t("连不上 downloads.claude.ai：") + ex.getMessage());
            } finally {
                ovCh = null; ovPin = null;
                if (!keep) { try { checkClaude(); } catch (Exception ignored) {} }
                switching.set(false);
            }
        }, "upd-channel").start();
    }

    private void refreshCurrent() {
        try { app.current = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0).versionName; } catch (Exception ignored) {}
        String b = installedDevkitBase();
        devkit.current = !b.isEmpty() ? tagOf(b) : !installedDevkitSha().isEmpty() ? Tr.t("本地安装") : env.devkitReady() ? Tr.t("未知") : "";
        try { claude.current = new File(Os.readlink(new File(env.home, ".local/share/cccodroid/claude/current").getPath())).getName(); }
        catch (Exception e) { claude.current = ""; }
    }

    /**
     * 已装工具包来自哪个 Release 目录；离线装的、早期版本装的没有记录，返回空串。
     * 以前这里拿本 APK 内置的钉子兜底 —— 错的：APK 升级后钉子换成新版，旧工具包就被当成新版，显示"已是最新"而内容还是旧的。
     */
    String installedDevkitBase() { return env.devkitInfo().optString("base", ""); }
    private String installedDevkitSha() { return env.devkitInfo().optString("sha256", ""); }
    /** 同一个文件在 dl.cccodroid.net 上的地址：GitHub 下得不顺时接着续传（内容照样核 sha256） */
    static String devkitMirror(String base, String file) { return Installer.DEVKIT_MIRROR + tagOf(base) + "/" + file; }

    /** 本 APK 绑定的那一版工具包的清单（assets/devkit-pin.json，打包时从 Release 的 devkit.lock.json 摘出来）。
     *  首装从镜像下、本地文件认身份，都拿它当准：校验值跟着 APK 走，不靠下载来源 */
    static JSONObject devkitPin(Context c) {
        try (java.io.InputStream in = c.getAssets().open("devkit-pin.json")) {
            return new JSONObject(new String(readAll(in), StandardCharsets.UTF_8));
        } catch (Exception e) { return null; }
    }

    /**
     * 本地工具包文件是哪一版：拿它的 sha256（gz 或 tar 都行）对已知清单 —— 本 APK 自带的钉子、刚查到的最新版、
     * GitHub 上最近几个 devkit-* 的 devkit.lock.json。认出来返回 {tag, base, target, compat, sha256(gz), tarSha256}；
     * 认不出（自己构建的、来路不明的、没网查不了）返回 null，由调用方决定要不要让用户硬装。
     */
    JSONObject identifyDevkit(String sha) {
        JSONObject pin = devkitPin(ctx);
        JSONObject hit = matchLock(pin, sha, pin != null ? pin.optString("base") : "");
        if (hit != null) return hit;
        try {
            JSONArray rels = new JSONArray(new String(Installer.httpGetSmall(feed()), StandardCharsets.UTF_8));
            int n = 0;
            for (int i = 0; i < rels.length() && n < 8; i++) {
                JSONObject r = rels.getJSONObject(i);
                String tag = r.optString("tag_name");
                if (r.optBoolean("draft") || !tag.startsWith("devkit-")) continue;
                n++;
                String base = "https://github.com/" + REPO + "/releases/download/" + tag + "/";
                try {
                    // 线上清单要验过签才拿来认本地文件：只靠 TLS 的话，换掉清单就能让自制工具包显示成「已发布的版本」（审查 10-29 低8）
                    byte[] lb = Installer.httpGetSmall(base + "devkit.lock.json");
                    if (!lockSigned(base, lb)) continue;
                    hit = matchLock(new JSONObject(new String(lb, StandardCharsets.UTF_8)), sha, base);
                    if (hit != null) return hit;
                } catch (Exception ignored) {}
            }
        } catch (Exception e) { Log.i(TAG, "identifyDevkit: 查不了线上清单 " + e); }
        return null;
    }

    private static JSONObject matchLock(JSONObject lock, String sha, String base) {
        if (lock == null || sha == null) return null;
        JSONObject gz = lock.optJSONObject("gz"), tar = lock.optJSONObject("tar");
        String gzSha = gz != null ? gz.optString("sha256") : "", tarSha = tar != null ? tar.optString("sha256") : "";
        if (!sha.equals(gzSha) && !sha.equals(tarSha)) return null;
        try {
            return new JSONObject().put("tag", tagOf(base)).put("base", base).put("target", lock.optString("target"))
                .put("compat", lock.optInt("compat", 1)).put("sha256", gzSha).put("tarSha256", tarSha);
        } catch (Exception e) { return null; }
    }

    /** 能不能装到本 APK 上：包名对得上、接口版本一致。返回不能装的原因，能装返回 null */
    String devkitIncompatible(JSONObject id) {
        if (id == null) return null;
        if (!ctx.getPackageName().equals(id.optString("target")) || id.optInt("compat", 1) != DEVKIT_COMPAT)
            return Tr.f("{0} 与本版 cccodroid 不兼容", id.optString("tag"));
        return null;
    }

    /** 更新卡片的「从本地文件安装」：在 MainActivity 的线程里调，进度打到安装界面。id 为 null = 用户确认过硬装 */
    void applyLocalDevkit(Installer ins, Installer.Source src, long total, boolean gzip, String sha, JSONObject id) throws Exception {
        if (devkitMoving()) throw new IOException(Tr.t("工具包正在下载或安装，等它结束再试"));
        devkit.set("installing", "");
        GatewayService.pause(true);
        try {
            for (int i = 0; i < 40 && pingGateway(); i++) Thread.sleep(250);
            String base = id != null ? id.optString("base") : "";
            String gzSha = id != null && !id.optString("sha256").isEmpty() ? id.optString("sha256") : sha;
            String tarSha = id != null ? id.optString("tarSha256", null) : null;
            ins.installDevkit(src.open(), total, gzip, base, gzSha, tarSha);
            refreshCurrent();
            devkit.set("uptodate", id != null ? "" : Tr.t("本地文件（未核对来源）"));
            Ledger.add(env, "install", true, Tr.t("从本地文件装上 ") + (id != null ? id.optString("tag") : sha.substring(0, 12)),
                new JSONObject().put("sha256", gzSha).put("verified", id != null));
        } catch (Exception e) {
            devkit.set("error", e.getMessage());
            Ledger.add(env, "install", false, Tr.t("本地安装失败：") + e.getMessage(), null);
            throw e;
        } finally {
            GatewayService.pause(false);
            releaseApp();
        }
    }

    private String pinnedDevkitBase() {
        try (java.io.InputStream in = ctx.getAssets().open("devkit-sources.txt")) {
            return new String(readAll(in), StandardCharsets.UTF_8).trim().split("\\s+")[0];
        } catch (Exception e) { return ""; }
    }
    static String tagOf(String base) {
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("/download/([^/]+)/?$").matcher(base == null ? "" : base);
        return m.find() ? m.group(1) : "";
    }

    // ── 检查 ───────────────────────────────────────────────────────────
    /** 后台线程里跑。manual=true：用户点的"检查更新"——只查不自动装大件；auto 模式下顺带按规则自动下载/安装 */
    void checkAsync(boolean manual) {
        if (checking) return;
        checking = true;
        new Thread(() -> {
            try { check(manual); } finally { checking = false; }
        }, "upd-check").start();
    }

    private void check(boolean manual) {
        lastError = "";
        refreshCurrent();
        String[] ghErr = new String[1];
        JSONArray[] lists = fetchLists(ghErr);
        JSONArray rels = lists[0];
        boolean mirror = false;
        if (rels == null) {
            lastError = Tr.t("连不上 GitHub：") + ghErr[0];
            rels = lists[1];
            mirror = rels != null;
            // GitHub 不通：应用本身改看镜像的发布列表；工具包没有镜像，如实说查不了（别报成"已是最新"）
            if (rels == null) app.set("error", lastError);
            if (pinnedInstalled()) devkit.set("uptodate", Tr.t("已是本应用配套的版本（GitHub 连不上，暂时查不了更新的）"));
            else devkit.set("error", lastError);
        }
        if (rels != null) {
            try { checkApp(rels); if (mirror && !"error".equals(app.state)) app.message = app.message.isEmpty() ? Tr.t("来自 cccodroid.net 镜像") : app.message + Tr.t(" · 来自 cccodroid.net 镜像"); }
            catch (Exception e) { app.set("error", e.getMessage()); }
            // 首装还没完成（工具包没装好）就别查工具包：那时读不到已装的模块，planModules 会按「整包用户」规划成全部模块，
            // 自动更新在 Wi‑Fi 下把它们全下好，首装刚按勾选装完，启动流程又把这份「已下载的更新」装上 —— 勾了两个、装了八个（群友 10-24）
            if (!env.devkitReady()) devkit.set("uptodate", Tr.t("首次安装进行中"));
            else if (!mirror) try { checkDevkit(rels); } catch (Exception e) { devkit.set("error", e.getMessage()); }
        }
        try { checkClaude(); } catch (Exception e) { claude.set("error", Tr.t("连不上 downloads.claude.ai：") + e.getMessage()); }
        prefs().edit().putLong("lastCheck", System.currentTimeMillis()).apply();
        if (auto() && !manual && env.devkitReady()) autoApply();      // 首装期间不自动装任何东西，Claude Code 也由首装流程来装
        releaseApp();         // 工具包停在"已下载"没去装（比如有任务在跑）时，别让 APK 一直等着
    }

    /**
     * 发布列表三条线同时问：GitHub（App + 工具包）、cccodroid.net 与 dl.cccodroid.net（只有 App，由 GitHub 定时生成）。
     * 以前先等 GitHub 连接 20 秒 + 读 60 秒超时才看镜像，不开代理的网络里一次检查要卡一分多钟（群友 10-31）。
     * GitHub 通了就用它（镜像可能晚几分钟）；GitHub 报错立刻看镜像；GitHub 一直挂着，最多等它 15 秒，镜像有了就先用镜像。
     * 返回 {GitHub 的列表, 镜像的列表}，没取到的是 null
     */
    private JSONArray[] fetchLists(String[] ghErr) {
        final String[] urls = { feed(), MIRROR + "/dl/releases.json", DL + "/dl/releases.json" };
        final JSONArray[] got = new JSONArray[3];
        final String[] err = new String[3];
        final boolean[] fin = new boolean[3];
        final Object lk = new Object();
        for (int i = 0; i < 3; i++) {
            final int k = i;
            Thread t = new Thread(() -> {
                JSONArray a = null; String e = null;
                try { a = new JSONArray(new String(Installer.httpGetSmall(urls[k]), StandardCharsets.UTF_8)); }
                catch (Exception x) { e = String.valueOf(x.getMessage()); }
                synchronized (lk) { got[k] = a; err[k] = e; fin[k] = true; lk.notifyAll(); }
            }, "upd-feed-" + i);
            t.setDaemon(true);
            t.start();
        }
        long t0 = System.currentTimeMillis();
        synchronized (lk) {
            for (;;) {
                long el = System.currentTimeMillis() - t0;
                boolean mirOk = got[1] != null || got[2] != null, mirDone = mirOk || fin[1] && fin[2];
                // GitHub 通了就用；GitHub 失败且镜像都有结果了就收；GitHub 挂过 15 秒、镜像确实拿到了列表才不等它。
                // 镜像都不通时得接着等 GitHub（慢但能通的梯子），不能 15 秒就放弃
                if (got[0] != null || fin[0] && mirDone || el >= 15000 && mirOk || el >= 90000) break;
                try { lk.wait(250); } catch (InterruptedException e) { break; }
            }
            ghErr[0] = fin[0] ? err[0] : Tr.t("超时");
            JSONArray mir = got[1];
            if (mir == null || got[2] != null && cmpVer(latestApp(got[2]), latestApp(mir)) > 0) mir = got[2];
            Log.i(TAG, "发布列表：GitHub " + (got[0] != null ? "通" : fin[0] ? "不通" : "未回") + "，镜像 " + (got[1] != null ? "通" : "-") + "/" + (got[2] != null ? "通" : "-"));
            return new JSONArray[]{ got[0], mir };
        }
    }

    /** 列表里最新的 App 版本号（不带 v），没有返回 "0" */
    static String latestApp(JSONArray rels) {
        for (int i = 0; i < rels.length(); i++) {
            JSONObject r = rels.optJSONObject(i);
            if (r == null) continue;
            String tag = r.optString("tag_name");
            if (!r.optBoolean("draft") && tag.matches("v\\d+(\\.\\d+)*")) return tag.substring(1);
        }
        return "0";
    }

    // 和 apply 同一把锁：apply 占槽与这里改目标不会交错（05-008）
    private synchronized void checkApp(JSONArray rels) throws Exception {
        // 正在下 / 正在装 / 下好了在等工具包换完再装：url、文件、哈希都是在途任务的，别换成新查到的，
        // 状态也别动（审查 #105 05-008，同工具包 checkDevkit；等工具包那段与在途时打成 uptodate 见 DeepSeek 复核 b7 中-5、低-10）。
        // 新版等这一份走完再查
        // 刚下完（ready）而工具包在动：下载线程马上就要 deferApp，置 appWaiting 前这一下也不能换（DeepSeek 复核 b7r2 低-1）
        if ("downloading".equals(app.state) || "installing".equals(app.state) || appWaiting
            || "ready".equals(app.state) && devkitMoving()) return;
        for (int i = 0; i < rels.length(); i++) {
            JSONObject r = rels.getJSONObject(i);
            String tag = r.optString("tag_name");
            if (r.optBoolean("draft") || !tag.matches("v\\d+(\\.\\d+)*")) continue;
            app.latest = tag.substring(1);
            String want = wantFlavor(), name = apkName(want);
            // 版本相同但要换一套（28 ↔ 36）：也算有更新，同版本号覆盖安装系统是认的
            int c = cmpVer(app.latest, app.current);
            boolean swap = c == 0 && !want.equals(flavor());
            if (c < 0 || c == 0 && !swap) { app.set("uptodate", ""); return; }
            JSONArray as = r.getJSONArray("assets");
            for (int k = 0; k < as.length(); k++) {
                JSONObject a = as.getJSONObject(k);
                if (!a.optString("name").equals(name)) continue;
                app.url = a.getString("browser_download_url");
                // 三处都是同一份文件，谁先谁后由下载前测速定（Installer.rank），这里只管都列上
                String gh = "https://github.com/" + REPO + "/releases/download/" + tag + "/" + name;
                app.alt = app.url.equals(gh) ? MIRROR + "/dl/" + tag + "/" + name : gh;
                app.alt2 = DL + "/dl/" + tag + "/" + name;
                app.size = a.optLong("size");
                String d = a.optString("digest", "");
                app.sha = d.startsWith("sha256:") ? d.substring(7) : null;
                app.file = new File(env.files, "updates/cccodroid-" + app.latest + "-" + want + ".apk");
                String note = swap ? Tr.f("换成 targetSdk {0} 的安装包", want) : r.optBoolean("prerelease") ? Tr.t("预览版") : "";
                app.set(app.file.isFile() && app.file.length() == app.size ? "ready" : "available", note);
                return;
            }
            app.set("error", Tr.f("v{0} 里没有 {1}", app.latest, name));
            return;
        }
        app.set("uptodate", "");
    }

    private void checkDevkit(JSONArray rels) throws Exception {
        String best = null;
        for (int i = 0; i < rels.length(); i++) {
            JSONObject r = rels.getJSONObject(i);
            String tag = r.optString("tag_name");
            if (r.optBoolean("draft") || !tag.startsWith("devkit-")) continue;
            if (best == null || cmpVer(tag.substring(7), best.substring(7)) > 0) best = tag;
        }
        if (best == null) { devkit.set("uptodate", ""); return; }
        // 不往回装：比已装的、比本 APK 钉的旧，一律当没有新版。签名有效的旧清单照样验得过，
        // 中间人只给一份旧版本的发布列表，就能把工具链退回有已知问题的旧版（审查 v0513b 低-21；APK 和 Claude Code 早就防了）
        {
            String floor = null;
            JSONObject pin0 = devkitPin(ctx);
            for (String f : new String[] { tagOf(installedDevkitBase()), pin0 != null ? pin0.optString("tag", "") : "" })
                if (f != null && f.startsWith("devkit-") && (floor == null || cmpVer(f.substring(7), floor.substring(7)) > 0)) floor = f;
            if (floor != null && cmpVer(best.substring(7), floor.substring(7)) < 0) {
                Log.w(TAG, "发布列表里最新的工具包 " + best + " 比 " + floor + " 旧，不装");
                devkit.set("uptodate", "");
                return;
            }
        }
        devkit.latest = best;
        // 正在下、正在装、正在校验，或者已下好一份等着装：别动它的文件与哈希（文件名各版本相同，换了哈希就和落盘的那份对不上）
        String st0 = devkit.state;
        if ("verifying".equals(st0)) { recheckDevkit = true; return; }   // 校验完再补查（见 verifyAsync）
        if ("downloading".equals(st0) || "installing".equals(st0) || "ready".equals(st0)) return;
        String base = "https://github.com/" + REPO + "/releases/download/" + best + "/";
        // 最新的就是 APK 钉的那版（常态：新工具包跟着新 APK 走）：校验值用 APK 自带的，不联网 ——
        // 国内连不上 github.com 时，以前这里取 devkit.lock.json 失败，整行报错（群友 10-22）
        JSONObject pin = devkitPin(ctx), lock;
        byte[] lockBytes = null;
        if (pin != null && best.equals(pin.optString("tag")) && pin.optJSONObject("gz") != null) lock = pin;
        else {
            byte[][] got = new byte[1][];
            fetchDevkitFile(base, "devkit.lock.json", got);
            lockBytes = got[0];
            lock = new JSONObject(new String(lockBytes, StandardCharsets.UTF_8));
        }
        if (!ctx.getPackageName().equals(lock.optString("target")) || lock.optInt("compat", 1) != DEVKIT_COMPAT) {
            devkit.set("uptodate", Tr.f("{0} 需要更新版本的 cccodroid", best)); return;
        }
        JSONObject gz = lock.getJSONObject("gz");
        String sha = gz.getString("sha256");
        String have = installedDevkitSha();
        if (!have.isEmpty() && have.equals(sha)) {
            devkit.current = best;
            if (!"damaged".equals(devkit.state)) devkit.set("uptodate", "");     // 自检查出坏了：同一版本，等用户点修复
            return;
        }
        JSONObject tar = lock.optJSONObject("tar");
        devkit.base = base; devkit.sha = sha; devkit.size = gz.getLong("bytes");
        devkit.tarSha = tar != null ? tar.optString("sha256", null) : null;
        devkit.need = tar != null ? tar.optLong("bytes") : devkit.size * 4;
        devkit.url = base + gz.getString("file");
        devkit.alt = devkitMirror(base, gz.getString("file"));
        devkit.file = new File(env.files, gz.getString("file"));
        devkit.modules = null; devkit.modSha = null; devkit.moduleIds = null;
        planModules(base);
        // 整包清单只靠 TLS 不够（装了根证书的代理、仓库被攻破都能换掉整个工具包 —— 审查 H3）：
        // 不是 APK 钉的那份、又没有验得过的 .sig，就只许按块装（modules.json 验过签）；按块的没核实成就报错，不再静默退回整包
        if (devkit.modules == null && lock != pin && !lockSigned(base, lockBytes))
            throw new IOException(Tr.f("{0} 的工具包清单没核实成（签名对不上或没取到）；过会儿再检查更新", best));
        String mb = String.format(java.util.Locale.ROOT, "%.0f MB", devkit.size / 1048576.0);
        devkit.set("available", have.isEmpty() && env.devkitReady() ? mb + Tr.t(" · 无法确认已装的是哪一版，建议更新一次") : mb);
    }

    /** devkit.lock.json 带了 ed25519 签名（devkit.lock.json.sig，和 modules.json 同一把钥匙）且验得过，
     *  而且签进去的 release 就是下载地址里的这个 tag —— 旧版清单连签名一起搬到新 tag 下冒充新版过不去（审查 10-29 中2） */
    static boolean lockSigned(String base, byte[] lockBytes) {
        if (lockBytes == null) return false;
        try {
            String rel = new JSONObject(new String(lockBytes, StandardCharsets.UTF_8)).optString("release");
            if (rel.isEmpty() || !rel.equals(tagOf(base))) return false;
            byte[][] got = new byte[1][];
            fetchDevkitFile(base, "devkit.lock.json.sig", got);
            return Ed25519.verifyIndex(lockBytes, new String(got[0], StandardCharsets.UTF_8));
        } catch (Exception e) { return false; }
    }

    /** 工具包 Release 里的小文件：先 GitHub，连不上换 dl.cccodroid.net（同一份文件）。返回 true = 来自镜像 */
    private static boolean fetchDevkitFile(String base, String name, byte[][] out) throws IOException {
        try { out[0] = Installer.httpGetSmall(base + name); return false; }
        catch (IOException e) {
            try { out[0] = Installer.httpGetSmall(devkitMirror(base, name)); return true; }
            catch (IOException e2) { throw new IOException(Tr.t("GitHub 和 cccodroid.net 镜像都连不上：") + e.getMessage()); }
        }
    }

    /** 装着的工具包就是本 APK 钉的那一版 */
    private boolean pinnedInstalled() {
        JSONObject pin = devkitPin(ctx);
        JSONObject gz = pin == null ? null : pin.optJSONObject("gz");
        String have = installedDevkitSha();
        return gz != null && !have.isEmpty() && have.equals(gz.optString("sha256"));
    }

    /**
     * 这个 Release 有 modules.json（模块化）就改成按块装：要装哪些 = 现在已装的那些（整包用户 = 全部模块，一样不少）；
     * 下载量 / 占用按这些块重算。取不到 modules.json 就照旧装整包。
     * modules.json 要带签名（modules.json.sig，和组件索引同一把 ed25519 钥匙）：里面有每块的 sha256，签名对不上就不信它，退回整包。
     * 首装不走这里 —— 那时 modules.json 按 APK 钉的 sha256 核
     */
    private void planModules(String base) {
        try {
            byte[][] got = new byte[1][];
            fetchDevkitFile(base, "modules.json", got);
            byte[] b = got[0];
            fetchDevkitFile(base, "modules.json.sig", got);
            String sig = new String(got[0], StandardCharsets.UTF_8);
            if (!Ed25519.verifyIndex(b, sig)) { Log.w(TAG, "planModules: modules.json 签名对不上，按整包装"); return; }
            JSONObject mj = new JSONObject(new String(b, StandardCharsets.UTF_8));
            if (!ctx.getPackageName().equals(mj.optString("target")) || mj.optInt("compat", 1) != DEVKIT_COMPAT) return;
            // 签名只说明是我们发的，不说明是哪一版：旧版清单连签名搬到新 tag 下能冒充新版（审查 10-29 第六份 中1）。
            // 新清单带 release 字段，要和下载地址的 tag 一致；没带的老清单只认 APK 钉的那份
            String sha = Installer.hex(java.security.MessageDigest.getInstance("SHA-256").digest(b));
            if (mj.has("release")) {
                if (!mj.optString("release").equals(tagOf(base))) { Log.w(TAG, "planModules: modules.json 属于 " + mj.optString("release") + "，不是 " + tagOf(base)); return; }
            } else {
                JSONObject pin = devkitPin(ctx), pm = pin == null ? null : pin.optJSONObject("modules");
                if (pm == null || !sha.equals(pm.optString("sha256"))) { Log.w(TAG, "planModules: modules.json 没写 release、也不是钉的那份"); return; }
            }
            java.util.List<String> ids = installedModuleIds(mj);
            long dl = 0, need = 0;
            for (JSONObject m : Installer.moduleOrder(mj, ids)) { dl += m.getJSONObject("gz").optLong("bytes"); need += m.getJSONObject("tar").optLong("bytes"); }
            devkit.modules = b; devkit.modSha = sha;
            devkit.moduleIds = ids; devkit.size = dl; devkit.need = need;
            devkit.file = new File(env.files, "modules-" + tagOf(base) + ".json");
        } catch (Exception e) { Log.i(TAG, "planModules: 按整包装（" + e + "）"); }
    }

    /** 现在装着哪些模块：模块化工具包按各块的 .ok；整包工具包 = 新清单里整包本来就有的模块（full，升级后一样不少，不用的再到扩展页卸） */
    private java.util.List<String> installedModuleIds(JSONObject newMj) {
        java.util.List<String> ids = new java.util.ArrayList<>();
        JSONObject cur = new Installer(env, null).readModules();
        JSONArray all = newMj.optJSONArray("modules");
        for (int i = 0; all != null && i < all.length(); i++) {
            JSONObject m = all.optJSONObject(i);
            if (m == null || !"module".equals(m.optString("kind"))) continue;
            String id = m.optString("id");
            // 整包里没有的模块（full=false，比如后加的 Go、Node 生态）不算已装，要用再到扩展页加
            if (cur == null) { if (m.optBoolean("full", true)) ids.add(id); continue; }
            JSONObject old = Installer.moduleById(cur, id);
            if (old != null && new File(env.usr, old.optString("dir") + "/.ok").isFile()) ids.add(id);
        }
        return ids;
    }

    private void checkClaude() throws Exception {
        // 版本号：官方 → cccodroid.net 镜像 → npm 镜像的 dist-tags（Anthropic 在 npm 上用同名的 stable / latest 标签）。
        // 这里只是「有没有新版」；真正下载时 install-claude.mjs 会按官方清单的 sha256 或 npm 签名校验
        String v = null, why = "";
        claudeHeld = false;
        // 固定版本时只顺带查 stable 到了哪一版（提示用），查不到也不算错
        final String ch = pinned() ? "stable" : channel();
        String[] urls = { "https://downloads.claude.ai/claude-code-releases/" + ch, "https://cccodroid.net/claude-code/" + ch, "https://dl.cccodroid.net/claude-code/" + ch,
            "https://registry.npmmirror.com/-/package/@anthropic-ai%2fclaude-code-linux-arm64/dist-tags",
            "https://registry.npmjs.org/-/package/@anthropic-ai%2fclaude-code-linux-arm64/dist-tags" };
        for (String u : urls) {
            try {
                String t = new String(Installer.httpGetSmall(u), StandardCharsets.UTF_8).trim();
                if (t.startsWith("{")) t = new JSONObject(t).optString(ch, "");
                if (t.matches("\\d+\\.\\d+\\.\\d+.*")) { v = t; break; }
                why = Tr.t("版本号不对：") + t;
            } catch (Exception ex) { if (why.isEmpty()) why = ex.getMessage(); }
        }
        if (pinned()) {
            String pin = pinVer();
            // 钉的版本比已装的旧：不自动装回去（10-31 八轮核验：钉住当前版本不用确认，之后一升级，自动更新就会悄悄退回来）。
            // 用户确认过的降级在确认时当场就装了；之后要退回钉的版本，点安装会走降级确认
            refreshCurrent();
            claudeOlder = !claude.current.isEmpty() && cmpVer(pin, claude.current) < 0;
            claude.latest = pin; latestCh = "pinned";
            if (env.claudeOff() && !env.claudeReady()) { if (!"installing".equals(claude.state)) claude.set("missing", ""); return; }
            if (!"installing".equals(claude.state)) {
                String info = v != null && cmpVer(v, pin) != 0 ? Tr.f("已固定 {0} · stable 已到 {1}", pin, v) : Tr.f("已固定 {0}", pin);
                if (pin.equals(claude.current)) claude.set("uptodate", info);
                else claude.set("available", Tr.f("固定到 {0}", pin));
            }
            return;
        }
        if (v == null) throw new IOException(why);
        claude.latest = v; latestCh = ch;
        // 用户在设置里卸了：只报「未安装」，不当成「有更新」（那样自动更新、换渠道都会把它装回去）
        if (env.claudeOff() && !env.claudeReady()) { if (!"installing".equals(claude.state)) claude.set("missing", ""); return; }
        // 已装的版本要和所选渠道的版本「一致」，而不只是「不比它旧」：
        // 从 latest 切回 stable 时，stable 的版本号更小，以前这里判成「已是最新」，结果一直停在 latest 的版本上
        if (!"installing".equals(claude.state)) {
            int c = cmpVer(v, claude.current);
            claudeOlder = c < 0 && !claude.current.isEmpty();
            String tag = channel().equals("latest") ? Tr.t("latest 渠道") : "";
            if (c == 0) claude.set("uptodate", tag);
            else if (c > 0 || claude.current.isEmpty()) claude.set("available", tag);
            else claude.set("available", Tr.f("切回 {0} 渠道：将换成 {1}（比当前的 {2} 旧）", channel(), v, claude.current));
            // 维护者标成「有已知问题」的版本：先不自动装，写明原因；用户自己点更新照样装
            String bad = c != 0 ? knownBad(v) : null;
            claudeHeld = bad != null;
            if (bad != null) claude.set("available", Tr.f("{0} 有已知问题，没有自动更新：{1}", v, bad));
        }
        // 当初只能靠 npm 签名装上、后来按官方清单补核又对不上的（网关 install-claude.mjs --recheck 留下 .mismatch）：
        // 当成「有更新」，点更新（或自动更新）就从头重下这一版，装之前按官方清单核 sha256
        if (!"installing".equals(claude.state) && new File(env.home, ".local/share/cccodroid/claude/current/.mismatch").isFile())
            claude.set("available", Tr.t("这一版与官方清单的 sha256 对不上，点更新重新下载"));
    }

    /** 渠道上的新版被标成有问题时为 true：autoApply 不装它 */
    private volatile boolean claudeHeld;
    /**
     * 渠道给的版本比已装的旧（切回 stable 是正常情形）。版本号来自镜像、本身没签名，被人改小了全链校验照样过：
     * 自动更新不装比当前旧的，等用户自己点（审查 10-29 M3）
     */
    private volatile boolean claudeOlder;

    /**
     * 维护者标成「有已知问题」的 Claude Code 版本（scripts/claude-verified.mjs 发布、网关 gw/ccverified.mjs 验过签存在 home 里的那份）。
     * 返回原因（按界面语言，中文以外都用英文），没标就返回 null。文件不在、读不了都当没标：只少一道提醒，不挡更新
     */
    private String knownBad(String v) {
        try {
            File f = new File(env.home, ".cache/cccodroid/claude-verified.json");
            if (!f.isFile()) return null;
            JSONObject bad = new JSONObject(new String(java.nio.file.Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8)).optJSONObject("bad");
            JSONObject e = bad == null ? null : bad.optJSONObject(v);
            if (e == null) return null;
            String zh = e.optString("zh", ""), en = e.optString("en", "");
            return Tr.lang().startsWith("zh") && !zh.isEmpty() ? zh : !en.isEmpty() ? en : zh;
        } catch (Exception ex) { return null; }
    }

    /** 发布列表地址。home/.config/cccodroid/update-feed 里写了地址就用它（测试更新流程用，形状同 GitHub API）。
     *  只在可调试的包里认：正式包里应用身份的任何程序都能写这个文件，拿它把更新检查指到别处（审查 v0.5.9 B1） */
    private String feed() {
        File f = new File(env.home, ".config/cccodroid/update-feed");
        boolean debuggable = (ctx.getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        try { if (debuggable && f.isFile()) { String u = new String(java.nio.file.Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8).trim(); if (!u.isEmpty()) return u; } }
        catch (Exception ignored) {}
        return "https://api.github.com/repos/" + REPO + "/releases?per_page=30";
    }

    /** 自动模式的规则：见类注释 */
    private void autoApply() {
        boolean unmetered = !ctx.getSystemService(ConnectivityManager.class).isActiveNetworkMetered();
        if ("available".equals(claude.state) && unmetered && !claudeHeld && !claudeOlder && !switching.get()) {
            // 版本只读一次，装之前再按已装的现读比一遍：几个字段可能是两次检查交错写的，别凭拼起来的状态装回旧版（10-31 八轮核验）
            String v = claude.latest;
            if (!v.isEmpty() && !claudeDowngrade(v)) apply("claude", false, v);
        }
        if ("available".equals(app.state)) apply("app", false);              // 几 MB，什么网都下
        else if ("ready".equals(app.state)) maybeSilentInstallApp();
        if ("available".equals(devkit.state) && unmetered) apply("devkit", false);
        else if ("ready".equals(devkit.state)) notifyReady(devkit);
    }

    /** 后台定时：服务起来 20 秒后、之后每 30 分钟看一眼，距上次检查超过 6 小时就查 */
    void loop() {
        new Thread(() -> {
            sleep(20_000);
            while (true) {
                if (auto() && System.currentTimeMillis() - prefs().getLong("lastCheck", 0) > AUTO_EVERY) checkAsync(false);
                sleep(30 * 60_000L);
            }
        }, "upd-loop").start();
    }

    // ── 应用更新 ─────────────────────────────────────────────────────────
    /** @param user 用户点的（或从通知点进来的）：APK 就走安装确认；工具包就去替换 */
    JSONObject apply(String id, boolean user) { return apply(id, user, ""); }

    /** version：只对 Claude Code 有用 —— stable / latest / 具体版本号；空 = 当前渠道查到的最新版 */
    /** 指定的版本比已装的旧（降级）：经套接字谁都能发，降回有漏洞的旧版要用户点头（见 Priv「upd_apply」） */
    boolean claudeDowngrade(String version) {
        // 已装的版本现读：首装、终端里手动装过之后，内存里记的可能还是空的或旧的（10-31 八轮核验）
        refreshCurrent();
        String v = version == null ? "" : version.trim();
        // 渠道名（stable / latest）：换到别的渠道、或者认不出这个渠道现在是哪一版，都按可能降级处理
        if (v.equals("stable") || v.equals("latest"))
            return !claude.current.isEmpty() && (!v.equals(channel()) || !v.equals(latestCh) || claude.latest.isEmpty() || claudeDowngrade(claude.latest));
        return v.matches("\\d+\\.\\d+\\.\\d+[\\w.+-]*") && !claude.current.isEmpty() && cmpVer(v, claude.current) < 0;
    }

    // synchronized + 起线程前先把状态占上（审查 #105 05-007）：每个 Priv 连接一条线程，两次请求挨得近时，
    // 以前都只看到旧状态、各起一份下载/安装，共用 .part 与临时目录互相踩
    synchronized JSONObject apply(String id, boolean user, String version) {
        Item it = id.equals("app") ? app : id.equals("devkit") ? devkit : id.equals("claude") ? claude : null;
        JSONObject r = new JSONObject();
        try {
            if (it == null) return r.put("ok", false).put("message", Tr.t("未知项 ") + id);
            if ("downloading".equals(it.state) || "installing".equals(it.state)) return r.put("ok", true).put("message", Tr.t("进行中"));
            if (it == claude) {
                String ver = version == null ? "" : version.trim();
                if (!ver.isEmpty() && !ver.matches("stable|latest|\\d+\\.\\d+\\.\\d+[\\w.+-]*"))
                    return r.put("ok", false).put("message", Tr.f("版本号不对：{0}（填 stable、latest 或 2.1.100 这样的版本号）", ver));
                if (ver.isEmpty()) ver = claude.latest;
                if (ver.isEmpty()) return r.put("ok", false).put("message", Tr.t("先检查更新"));
                final String v = ver;
                claude.set("installing", "");
                new Thread(() -> installClaude(v), "upd-claude").start();
                return r.put("ok", true).put("message", claude.current.isEmpty() ? Tr.f("开始安装 Claude Code {0}", v) : Tr.t("开始更新 Claude Code"));
            }
            if (it.url == null) {
                // 「出错」时的「重试」：没有待下载的东西（出错的是检查本身），就重新检查一遍
                if ("error".equals(it.state)) { checkAsync(true); return r.put("ok", true).put("message", Tr.t("正在重新检查更新")); }
                return r.put("ok", false).put("message", Tr.t("没有可用的更新，先检查"));
            }
            if ("ready".equals(it.state)) {
                if (it == app) { app.set("installing", ""); new Thread(this::installApp, "upd-install").start(); return r.put("ok", true).put("message", Tr.t("正在安装")); }
                if (user) { new Thread(this::startDevkitApply, "upd-devkit").start(); return r.put("ok", true).put("message", Tr.t("正在替换开发工具包")); }
                return r.put("ok", true).put("message", Tr.t("已下载，等待安装"));
            }
            it.set("downloading", "");
            new Thread(() -> download(it, user), "upd-dl-" + id).start();
            return r.put("ok", true).put("message", Tr.t("开始下载"));
        } catch (Exception e) {
            try { r.put("ok", false).put("message", e.getMessage()); } catch (Exception ignored) {}
            return r;
        }
    }

    private Installer installer(Item it) {
        return new Installer(env, new Installer.Progress() {
            public void step(String m) { Log.i(TAG, it.id + ": " + m); if (m.startsWith("  ")) it.message = m.trim(); }
            public void bytes(long d, long t) { it.done = d; it.total = t; }
        });
    }

    private void download(Item it, boolean user) {
        String via = null;
        it.set("downloading", "");
        it.done = 0; it.total = it.size;
        try {
            if (it == devkit) {
                long need = it.size + (it.need > 0 ? it.need : it.size * 4) + (300L << 20);   // gz + 解出来的新目录（旧目录换名前一直在）+ 余量
                long free = new StatFs(env.files.getPath()).getAvailableBytes();
                if (free < need) throw new IOException(String.format(java.util.Locale.ROOT, Tr.t("空间不够：需要约 %.1f GB，只剩 %.1f GB"), need / 1e9, free / 1e9));
            }
            if (it == devkit && it.modules != null) downloadModules(it);
            else { Installer ins = installer(it); ins.download(it.url, new String[]{ it.alt, it.alt2 }, it.file, it.size, it.sha); via = ins.lastHost; }
            if (it == app) checkApkSigner(it.file);
            if (it == devkit) {
                JSONObject st = new JSONObject().put("file", it.file.getPath())
                    .put("base", it.base).put("sha256", it.sha).put("size", it.file.length()).put("tarSha256", it.tarSha == null ? "" : it.tarSha);
                if (it.modules != null) st.put("modSha", it.modSha).put("moduleIds", new JSONArray(it.moduleIds));
                prefs().edit().putString("devkitStaged", st.toString()).apply();
            }
            it.set("ready", via != null ? Tr.f("从 {0} 下载", via) : "");
            if (it == app) { if (user) installApp(); else maybeSilentInstallApp(); }
            else if (user) startDevkitApply();
            else { notifyReady(it); releaseApp(); }
        } catch (Exception e) {
            if (it == app && it.file != null) it.file.delete();
            it.set("error", e.getMessage());
            if (it == devkit) releaseApp();
        }
    }

    /** 模块化：按依赖顺序逐块下到 files/（断点续传、两个来源互为备用、按 modules.json 的 sha256 核），全部下完才落 modules.json */
    private void downloadModules(Item it) throws Exception {
        JSONObject mj = new JSONObject(new String(it.modules, StandardCharsets.UTF_8));
        long[] before = {0};
        Installer ins = new Installer(env, new Installer.Progress() {
            public void step(String m) { Log.i(TAG, "devkit: " + m); if (m.startsWith("  ")) it.message = m.trim(); }
            public void bytes(long d, long t) { it.done = before[0] + d; it.total = it.size; }
        });
        for (JSONObject m : Installer.moduleOrder(mj, it.moduleIds)) {
            JSONObject gz = m.getJSONObject("gz");
            String file = gz.getString("file");
            ins.download(it.base + file, devkitMirror(it.base, file), new File(env.files, file), gz.optLong("bytes"), gz.getString("sha256"));
            before[0] += gz.optLong("bytes");
        }
        Installer.write(it.file, new String(it.modules, StandardCharsets.UTF_8));
    }

    /** 下载来的 APK 必须是本应用、同一把签名钥匙。签名不同系统本来也拒装，这里先挡住，免得弹一个必失败的确认框 */
    private void checkApkSigner(File apk) throws Exception {
        PackageManager pm = ctx.getPackageManager();
        PackageInfo a = Apk.archiveInfo(ctx, apk);
        if (a == null || !ctx.getPackageName().equals(a.packageName)) throw new IOException(Tr.t("下载的不是 cccodroid 安装包"));
        if (!Apk.signer(a).equals(Apk.signer(pm.getPackageInfo(ctx.getPackageName(), Apk.SIG_FLAGS))))
            throw new IOException(Tr.t("安装包签名与本应用不一致，拒绝安装"));
        String got = a.applicationInfo != null && a.applicationInfo.targetSdkVersion >= 29 ? "36" : "28";
        if (!got.equals(wantFlavor())) throw new IOException(Tr.f("下载的是 targetSdk {0} 的安装包，要的是 {1}", got, wantFlavor()));
        // 比真实版本号，别只信更新源声称的 tag（审查 10-29 第六份 低1）：同版本只在换 28/36 时才装，不然中间人能让它反复重装
        PackageInfo me = pm.getPackageInfo(ctx.getPackageName(), 0);
        String mine = ctx.getApplicationInfo().targetSdkVersion >= 29 ? "36" : "28";
        long va = a.getLongVersionCode(), vm = me.getLongVersionCode();
        if (va < vm || (va == vm && got.equals(mine))) throw new IOException(Tr.f("下载的安装包版本（{0}）不比已装的新，不装", a.versionName));
    }

    /** 工具包正在下载 / 替换：这时装 APK 会把它拦腰截断 */
    boolean devkitMoving() { return "downloading".equals(devkit.state) || "installing".equals(devkit.state); }

    /** 推迟 APK，等工具包这一步走完 */
    private boolean deferApp(boolean user) {
        if (!devkitMoving()) return false;
        appWaiting = true; appWaitingUser |= user;
        app.set("ready", ("installing".equals(devkit.state) ? Tr.t("等开发工具包装完再装，免得把它打断") : Tr.t("等开发工具包下完再装，免得把它打断")));
        return true;
    }
    /** 工具包这一步走完（下完 / 装完 / 出错）：放行等着的 APK */
    private void releaseApp() {
        if (!appWaiting || devkitMoving()) return;
        boolean user = appWaitingUser;
        appWaiting = false; appWaitingUser = false;
        if (!"ready".equals(app.state)) return;
        app.set("ready", "");
        if (user) installApp(); else maybeSilentInstallApp();
    }

    void installApp() {
        if (app.file == null || !app.file.isFile()) { app.set("error", Tr.t("安装包不见了，重新检查更新")); return; }
        if (deferApp(true)) return;
        app.set("installing", "");
        // 有 Shizuku 就静默装（进程会被系统替换掉，服务由 MY_PACKAGE_REPLACED 拉起）；否则走系统安装确认
        if (Priv.granted() && !gatewayBusy()) {
            String out = Priv.pipeInstall(app.file, MainActivity.visible, app.latest);
            Log.i(TAG, "pm install → " + out);     // 走到这里多半说明没装上（装上的话本进程已经没了）
            if (sdkTooOld(out) && "28".equals(wantFlavor())) { markOnly36(out.trim()); return; }
            if (!out.contains("Success")) app.set("ready", Tr.f("静默安装失败（{0}），点安装走系统确认", out));
            return;
        }
        // 走系统安装确认：装完系统把我们整个杀掉，界面不会自己回来 —— 记一笔，SysEvents 收到 MY_PACKAGE_REPLACED 时把界面拉起来
        if (MainActivity.visible) ctx.getSharedPreferences("upd", Context.MODE_PRIVATE).edit().putLong("reopenAt", System.currentTimeMillis()).apply();
        try { Apk.install(ctx, app.file, "app"); }
        catch (Exception e) { app.set("error", Tr.t("安装失败：") + e.getMessage()); }
    }

    /** 自动模式：Shizuku 可用、没有任务在跑、界面不在前台 —— 静默装；否则通知用户 */
    private void maybeSilentInstallApp() {
        if (deferApp(false)) return;
        if (Priv.granted() && !gatewayBusy() && !MainActivity.visible) installApp();
        else notifyReady(app);
    }

    void onInstallResult(String what, boolean ok, String msg) {
        Item it = "app".equals(what) ? app : null;
        if (it == null) return;
        if (!ok && sdkTooOld(msg) && "28".equals(wantFlavor())) { markOnly36(msg); return; }
        it.set(ok ? "uptodate" : "ready", ok ? "" : msg);
    }

    /** 卸载之后（MainActivity.uninstallUi）：状态改成「未安装」 */
    void claudeRemoved() { refreshCurrent(); claude.set("missing", ""); }

    private void installClaude(String ver) {
        claude.set("installing", "");
        claude.done = 0; claude.total = 0;
        try {
            int rc = installer(claude).run(env.bin("bash").getPath(), new File(env.app, "scripts/install-claude.sh").getPath(), ver);
            refreshCurrent();
            if (rc != 0) throw new IOException(Tr.t("install-claude.sh 返回 ") + rc);
            env.claudeOffFlag().delete();        // 装上了：以后照常跟着更新走
            claude.set("uptodate", Tr.f("已更新到 {0}（下一轮对话起生效）", claude.current));
        } catch (Exception e) { claude.set("error", e.getMessage()); }
    }

    // ── 工具包替换 ───────────────────────────────────────────────────────
    boolean devkitStaged() { return "ready".equals(devkit.state) && devkit.file != null && devkit.file.isFile(); }

    /** 交给界面做：替换期间网关要停，界面切回安装进度页 */
    private void startDevkitApply() {
        if (gatewayBusy()) { devkit.set("ready", Tr.t("有任务正在跑，等它结束再装")); releaseApp(); return; }
        ctx.startActivity(MainActivity.internal(ctx, MainActivity.ACTION_APPLY_DEVKIT).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
    }

    /** 在 MainActivity 的线程里调。ins 的进度打到安装界面 */
    void applyDevkit(Installer ins) throws Exception {
        devkit.set("installing", "");
        try {
            // 落盘以后可能过了好几天、经历过 APK 升级：装之前再核一遍，坏了就删掉重下，不拿它去换掉能用的旧版
            ins.step(Tr.t("核对已下载的工具包…"));
            if (devkit.modSha != null ? !devkit.modSha.equals(Installer.sha256(devkit.file)) : devkit.sha != null && !devkit.sha.equals(Installer.sha256(devkit.file))) {
                devkit.file.delete();
                prefs().edit().remove("devkitStaged").apply();
                throw new IOException(Tr.t("已下载的工具包校验不通过，已删除；重新检查更新会再下一次"));
            }
        } catch (Exception e) { devkit.set("error", e.getMessage()); releaseApp(); throw e; }
        GatewayService.pause(true);
        try {
            for (int i = 0; i < 40 && pingGateway(); i++) Thread.sleep(250);
            if (devkit.modules != null) ins.installModules(devkit.modules, devkit.moduleIds, devkit.base, devkit.sha, false);
            else ins.installDevkit(devkit.file.getPath(), devkit.base, devkit.sha, devkit.tarSha);
            devkit.file.delete();
            prefs().edit().remove("devkitStaged").apply();
            refreshCurrent();
            devkit.set("uptodate", "");
            ctx.getSystemService(NotificationManager.class).cancel(20);
            Ledger.add(env, repairing ? "repair" : "install", true, (repairing ? Tr.t("修复完成：重装 ") : Tr.t("已装上 ")) + tagOf(devkit.base),
                new JSONObject().put("sha256", devkit.sha));
        } catch (Exception e) {
            devkit.set("error", e.getMessage());
            Ledger.add(env, repairing ? "repair" : "install", false, (repairing ? Tr.t("修复失败：") : Tr.t("安装失败：")) + e.getMessage(), null);
            throw e;
        } finally {
            repairing = false;
            GatewayService.pause(false);
            releaseApp();
        }
    }

    // ── 校验与修复 ─────────────────────────────────────────────────────────
    /** 后台核对已装工具包。full=false：只看文件在不在（启动时自动跑）；full=true：逐个算哈希（用户点的） */
    /** 检查更新时工具包正在校验、被跳过了：校验一结束就补查一次，不然它会一直显示「未检查」 */
    private volatile boolean recheckDevkit;

    private void recheckAfterVerify() {
        if (!recheckDevkit) return;
        recheckDevkit = false;
        new Thread(() -> {
            try { for (int i = 0; i < 120 && checking; i++) Thread.sleep(250); } catch (InterruptedException ignored) {}
            checkAsync(true);
        }, "upd-recheck").start();
    }

    JSONObject verifyAsync(boolean full) {
        JSONObject r = new JSONObject();
        try {
            if (!env.devkitReady()) return r.put("ok", false).put("message", Tr.t("开发工具包还没装好"));
            if (devkitMoving() || "verifying".equals(devkit.state)) return r.put("ok", true).put("message", Tr.t("进行中"));
            String prev = devkit.state, prevMsg = devkit.message;
            devkit.set("verifying", full ? Tr.t("逐个文件核对哈希") : "");
            devkit.done = 0; devkit.total = 0;
            new Thread(() -> {
                try {
                    JSONObject v = installer(devkit).verifyDevkit(full);
                    v.put("full", full).put("at", System.currentTimeMillis());
                    lastVerify = v;
                    int nBad = v.optInt("missing") + v.optInt("changed");
                    // 启动时的快速自检每次都跑，没问题就不记，免得账本被刷满
                    if (full || nBad > 0 || !v.optBoolean("manifest"))
                        Ledger.add(env, "verify", v.optBoolean("manifest") && nBad == 0,
                            (full ? Tr.t("完整校验") : Tr.t("快速自检")) + Tr.t("：") + (!v.optBoolean("manifest") ? Tr.t("没有文件清单，无法核对")
                                : nBad == 0 ? Tr.f("{0} 个文件完好", v.optInt("total"))
                                : Tr.f("缺 {0} 个、内容不对 {1} 个", v.optInt("missing"), v.optInt("changed"))),
                            new JSONObject().put("installed", tagOf(installedDevkitBase())).put("total", v.optInt("total"))
                                .put("missing", v.optInt("missing")).put("changed", v.optInt("changed")).put("samples", v.optJSONArray("samples")));
                    if (!v.optBoolean("manifest")) {
                        devkit.set(full ? "damaged" : prev, full ? Tr.t("这一版工具包没带文件清单，没法逐个核对；可以修复（重装同一版本）") : prevMsg);
                        if (!full) recheckAfterVerify();
                        return;
                    }
                    int bad = v.optInt("missing") + v.optInt("changed");
                    if (bad == 0) {
                        // 之前是「出错」（多半是上次检查 / 下载没成功）也一样：装着的这份完好，就别再挂着出错和一个点了没用的「重试」
                        devkit.set("damaged".equals(prev) || "error".equals(prev) ? "uptodate" : prev, full ? Tr.f("已核对 {0} 个文件，全部完好", v.optInt("total")) : prevMsg);
                        recheckAfterVerify();
                        return;
                    }
                    devkit.set("damaged", (v.optInt("missing") > 0 ? Tr.f("缺 {0} 个文件", v.optInt("missing")) : "")
                        + (v.optInt("missing") > 0 && v.optInt("changed") > 0 ? "、" : "")
                        + (v.optInt("changed") > 0 ? Tr.f("{0} 个文件内容不对", v.optInt("changed")) : "") + Tr.t("，点修复重装同一版本"));
                    if (!full) notifyDamaged(v);
                } catch (Exception e) {
                    recheckDevkit = false;
                    devkit.set("error", Tr.t("校验失败：") + e.getMessage());
                    Ledger.add(env, "verify", false, Tr.t("校验失败：") + e.getMessage(), null);
                }
            }, "upd-verify").start();
            return r.put("ok", true).put("message", full ? Tr.t("开始逐个核对（一两分钟）") : Tr.t("开始核对"));
        } catch (Exception e) {
            try { r.put("ok", false).put("message", e.getMessage()); } catch (Exception ignored) {}
            return r;
        }
    }

    /** 修复：把已装的那一版（不知道是哪版就用本 APK 内置的那版）重新下载、重装。用户自装的 pip / npm 包照常保留 */
    JSONObject repair() {
        JSONObject r = new JSONObject();
        try {
            if (devkitMoving()) return r.put("ok", true).put("message", Tr.t("进行中"));
            String base = installedDevkitBase();
            if (base.isEmpty()) base = pinnedDevkitBase();
            boolean modular = new Installer(env, null).readModules() != null;
            JSONObject pin = devkitPin(ctx), lock;
            byte[] lockBytes = null;
            if (pin != null && base.equals(pin.optString("base")) && pin.optJSONObject("gz") != null) lock = pin;
            else {
                lockBytes = Installer.httpGetSmall(base + "devkit.lock.json");
                lock = new JSONObject(new String(lockBytes, StandardCharsets.UTF_8));
                // 整包重装同样要清单可信（审查 H3）：没签名的整包旧版，改装本 APK 钉的那版
                if (!modular && !lockSigned(base, lockBytes) && pin != null && pin.optJSONObject("gz") != null) {
                    base = pin.optString("base"); lock = pin; lockBytes = null;
                }
            }
            if (!ctx.getPackageName().equals(lock.optString("target")) || lock.optInt("compat", 1) != DEVKIT_COMPAT)
                return r.put("ok", false).put("message", Tr.f("{0} 与本版 cccodroid 不兼容", tagOf(base)));
            JSONObject gz = lock.getJSONObject("gz"), tar = lock.optJSONObject("tar");
            devkit.base = base; devkit.latest = tagOf(base);
            devkit.sha = gz.getString("sha256"); devkit.size = gz.getLong("bytes");
            devkit.tarSha = tar != null ? tar.optString("sha256", null) : null;
            devkit.need = tar != null ? tar.optLong("bytes") : devkit.size * 4;
            devkit.url = base + gz.getString("file");
            devkit.alt = devkitMirror(base, gz.getString("file"));
            devkit.file = new File(env.files, gz.getString("file"));
            devkit.modules = null; devkit.modSha = null; devkit.moduleIds = null;
            if (modular) planModules(base);       // 模块化：按已装的块重装
            if (devkit.modules == null && lock != pin && !lockSigned(base, lockBytes))
                return r.put("ok", false).put("message", Tr.f("{0} 的工具包清单没核实成（签名对不上或没取到）；过会儿再试", tagOf(base)));
            devkit.set("available", Tr.t("修复：重装 ") + devkit.latest);
            repairing = true;
            Ledger.add(env, "repair", true, Tr.t("开始修复：重新下载 ") + devkit.latest, null);
            new Thread(() -> download(devkit, true), "upd-dl-devkit").start();
            return r.put("ok", true).put("message", Tr.f("开始下载 {0} 用于修复", devkit.latest));
        } catch (Exception e) {
            Ledger.add(env, "repair", false, Tr.t("修复没开始：") + e.getMessage(), null);
            try { r.put("ok", false).put("message", Tr.t("修复没开始：") + e.getMessage()); } catch (Exception ignored) {}
            return r;
        }
    }

    private void notifyDamaged(JSONObject v) {
        String text = Tr.f("开发工具包缺了 {0} 个文件。点此打开设置修复（重装同一版本，你自己装的 pip / npm 包会保留）", v.optInt("missing"));
        PendingIntent pi = PendingIntent.getActivity(ctx, 23,
            new Intent(ctx, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        ctx.getSystemService(NotificationManager.class).notify(20, new Notification.Builder(ctx, CH)
            .setSmallIcon(android.R.drawable.stat_sys_warning)
            .setContentTitle(Tr.t("开发工具包不完整"))
            .setContentText(text)
            .setStyle(new Notification.BigTextStyle().bigText(text))
            .setContentIntent(pi).setAutoCancel(true).build());
    }

    // ── 通知 ───────────────────────────────────────────────────────────
    private void notifyReady(Item it) {
        String text = it == app ? Tr.f("新版本 v{0} 已下载，点此安装", app.latest)
            : Tr.f("开发工具包 {0} 已下载。点此安装（约 1–2 分钟，期间暂停服务）；不点的话下次打开应用且空闲时自动装", devkit.latest);
        PendingIntent pi = PendingIntent.getActivity(ctx, it == app ? 21 : 22,
            MainActivity.internal(ctx, MainActivity.ACTION_UPDATE).putExtra("item", it.id).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification n = new Notification.Builder(ctx, CH)
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setContentTitle(Tr.f("{0} 有更新", Tr.t(it.name)))
            .setContentText(text)
            .setStyle(new Notification.BigTextStyle().bigText(text))
            .setContentIntent(pi)
            .setAutoCancel(true)
            .build();
        ctx.getSystemService(NotificationManager.class).notify(it == app ? 21 : 20, n);
    }

    // ── 小工具 ───────────────────────────────────────────────────────────
    static boolean pingGateway() {
        try {
            HttpURLConnection c = Env.gateway("/api/status");
            c.setConnectTimeout(800); c.setReadTimeout(1500);
            return c.getResponseCode() == 200;
        } catch (Exception e) { return false; }
    }

    /** 网关在跑任务（或排着队）吗。问不到就当忙，宁可不打断 */
    static boolean gatewayBusy() {
        try {
            HttpURLConnection c = Env.gateway("/api/status");
            c.setConnectTimeout(800); c.setReadTimeout(3000);
            if (c.getResponseCode() != 200) return true;
            JSONObject o = new JSONObject(new String(readAll(c.getInputStream()), StandardCharsets.UTF_8));
            return o.optBoolean("busy") || o.optInt("queued") > 0;
        } catch (Exception e) { return pingGateway(); }      // 网关没起来 = 不忙；起着却问不清 = 当忙
    }

    /** 1.2.10 > 1.2.9；非数字段忽略 */
    /** 比版本号。带后缀的预发布版（0.2.0-rc1）排在同号正式版（0.2.0）前面。
     *  0.2.0 以前把 "0.2.0-rc1" 整串拆成 0.2.0.1，判成比 0.2.0 还新，rc1 用户因此收不到 0.2.0 */
    static int cmpVer(String a, String b) {
        String[] pa = a.split("-", 2), pb = b.split("-", 2);
        int c = cmpNums(pa[0], pb[0]);
        if (c != 0) return c;
        boolean sa = pa.length > 1, sb = pb.length > 1;
        if (sa != sb) return sa ? -1 : 1;
        return sa ? cmpNums(pa[1], pb[1]) : 0;
    }

    private static int cmpNums(String a, String b) {
        String[] x = a.split("[^0-9]+"), y = b.split("[^0-9]+");
        for (int i = 0; i < Math.max(x.length, y.length); i++) {
            // 按字符串比数值：超过 long 的数字段 parseLong 会抛（审查 10-30 第九份 安卓低16）
            String p = i < x.length ? x[i].replaceFirst("^0+", "") : "", q = i < y.length ? y[i].replaceFirst("^0+", "") : "";
            int c = p.length() != q.length() ? Integer.compare(p.length(), q.length()) : p.compareTo(q);
            if (c != 0) return c < 0 ? -1 : 1;
        }
        return 0;
    }

    static byte[] readAll(java.io.InputStream in) throws IOException {
        java.io.ByteArrayOutputStream b = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        for (int r; (r = in.read(buf)) > 0; ) b.write(buf, 0, r);
        return b.toByteArray();
    }
    private static void sleep(long ms) { try { Thread.sleep(ms); } catch (InterruptedException ignored) {} }
}
