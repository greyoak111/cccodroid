package cc.codroid;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.accessibilityservice.GestureDescription;
import android.content.ComponentName;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.Path;
import android.graphics.Rect;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.Log;
import android.view.Display;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;

/**
 * 无障碍服务：给设备工具里的「读屏 / 点按 / 输入 / 滑动 / 截屏」用。默认关。
 *
 * 省电：耗电来自系统不停往服务里推界面事件。这里只订窗口切换一类事件，事件本身也不处理；
 * 「用时自动开」模式下平时整个服务是关的 —— 工具要用时由 DeviceTools 写系统设置打开
 * （Shizuku 激活时顺手拿到的 WRITE_SECURE_SETTINGS），空闲 N 分钟后 disableSelf() 自己关掉。
 *
 * 节点编号：screen_read 把当前界面里有意义的节点按顺序编号缓存起来，后面的点按 / 输入按编号找；
 * 下一次 screen_read 换一批编号。点按 / 滑动 / 输入 / 按键做完会等界面静下来、顺手读一次新屏幕一起交回（settle），
 * 模型不用再单独 screen_read 一回合。等的那一小会儿才临时多订内容变化事件，平时照旧只订窗口切换。
 */
public class A11y extends AccessibilityService {
    static final String TAG = "cccodroid";
    static volatile A11y self;
    /** 支付、网银、动态口令（2FA）、密码管理器与系统权限/凭据授权界面：即使当前会话已开启无障碍，也硬性拒绝读屏、截屏与模拟操作 */
    private static final java.util.Set<String> PROTECTED_PACKAGES = new java.util.HashSet<>(java.util.Arrays.asList(
        // 系统权限、安装包确认、凭据与 VPN 授权框
        "com.android.permissioncontroller", "com.google.android.permissioncontroller",
        "com.android.packageinstaller", "com.google.android.packageinstaller", "com.miui.packageinstaller",
        "com.miui.securitycenter", "com.oplus.appdetail", "com.vivo.permissionmanager", "com.huawei.systemmanager",
        "com.android.vpndialogs", "com.android.credentialmanager", "com.android.keychain",
        // 支付与数字钱包
        "com.eg.android.AlipayGphone", "com.unionpay", "com.paypal.android.p2pmobile",
        "com.google.android.apps.walletnfcrel", "com.mipay.wallet", "com.huawei.wallet",
        "com.finshell.wallet", "com.nearme.atlas", "com.vivo.wallet",
        // 手机银行与金融客户端
        "com.icbc", "com.chinamworld.main", "com.chinamworld.bocmbci", "com.android.bankabc",
        "com.bankcomm.Bankcomm", "cmb.pb", "com.yitong.mbank.psbc", "com.ecitic.bank.mobile",
        "cn.com.spdb.mobilebank.per", "cn.com.cmbc.newmbank", "com.cebbank.mobile.cemb",
        "com.pingan.paces.ccms", "com.cib.cibmb", "com.hxb.mobile.client",
        "com.webank.wemoney", "com.mybank.android.phone", "hk.com.hsbc.hsbchkmobilebanking", "com.chase.sig.android",
        // 2FA 动态口令与密码管理器（TOTP 数字与明文密码条目常为普通 TextView，isPassword 拦不住）
        "com.google.android.apps.authenticator2", "com.azure.authenticator", "com.duosecurity.duomobile",
        "com.authy.authy", "com.beemdevelopment.aegis", "org.fedorahosted.freeotp", "org.fedorahosted.freeotpplus",
        "me.jmh.authenticatorpro", "com.twofasapp",
        "com.x8bit.bitwarden", "com.agilebits.onepassword", "com.dashlane", "com.lastpass.lpandroid",
        "proton.android.pass", "com.kunzisoft.keepass.free", "com.kunzisoft.keepass.libre"
    ));

    static boolean isProtectedPackage(String pkg) {
        if (pkg == null || pkg.isEmpty()) return false;
        return PROTECTED_PACKAGES.contains(pkg) || pkg.startsWith("keepass2android.");
    }

    private static String activePackage(A11y s) {
        if (s == null) return "";
        try {
            AccessibilityNodeInfo root = s.getRootInActiveWindow();
            if (root != null && root.getPackageName() != null) return String.valueOf(root.getPackageName());
        } catch (Throwable ignored) {}
        return "";
    }
    private static final Object LOCK = new Object();
    private static final List<AccessibilityNodeInfo> nodes = new ArrayList<>();
    // 每个编号读屏那一刻长什么样（类名 + 文字 + 描述 + 资源名）。列表回收时同一个节点对象会换上别的内容，
    // refresh() 照样成功、编号照样有效，但已经不是模型看到的那个元素了：动作前比一下，对不上就不动手
    private static final List<String> sigs = new ArrayList<>();
    private static volatile long lastUse;
    private static volatile long lastEvt;
    private static volatile int evts;
    private final Handler h = new Handler(Looper.getMainLooper());

    static ComponentName component(Context c) { return new ComponentName(c, A11y.class); }

    @Override protected void onServiceConnected() {
        self = this;
        lastUse = System.currentTimeMillis();
        Log.i(TAG, "无障碍服务已连接");
        scheduleIdle();
    }

    @Override public boolean onUnbind(android.content.Intent i) {
        self = null;
        synchronized (LOCK) { nodes.clear(); sigs.clear(); }
        Log.i(TAG, "无障碍服务已断开");
        return super.onUnbind(i);
    }

    @Override public void onDestroy() { self = null; super.onDestroy(); }
    @Override public void onAccessibilityEvent(AccessibilityEvent e) { lastEvt = android.os.SystemClock.uptimeMillis(); evts++; }
    @Override public void onInterrupt() { }

    static void touch() { lastUse = System.currentTimeMillis(); }

    /** 「用时自动开」：空闲够久就自己关。每分钟看一次 */
    private void scheduleIdle() {
        h.removeCallbacksAndMessages(null);
        h.postDelayed(new Runnable() {
            @Override public void run() {
                if (self != A11y.this) return;
                SharedPreferences sp = getSharedPreferences(DeviceTools.PREFS, Context.MODE_PRIVATE);
                String mode = DeviceTools.a11yMode(A11y.this);
                int idle = sp.getInt("a11yIdle", 10);
                if (!"on".equals(mode) && System.currentTimeMillis() - lastUse > idle * 60_000L) {
                    Log.i(TAG, "无障碍空闲 " + idle + " 分钟，自动关闭");
                    disableSelf();
                    return;
                }
                h.postDelayed(this, 60_000);
            }
        }, 60_000);
    }

    // ── 开 / 关（写系统设置；没有 WRITE_SECURE_SETTINGS 时只能让用户自己去系统设置开）──
    static boolean canToggle(Context c) {
        return c.checkSelfPermission("android.permission.WRITE_SECURE_SETTINGS") == android.content.pm.PackageManager.PERMISSION_GRANTED;
    }

    /** 打开并等它连上。返回 null = 好了；否则是说明为什么开不了 */
    static String enable(Context c, long waitMs) {
        if (self != null) return null;
        if (!canToggle(c)) return Tr.t("无障碍没开。到 设置 → 设备工具 里打开（要先激活 Shizuku），或自己去系统的无障碍设置里打开 cccodroid");
        String me = component(c).flattenToString();
        android.content.ContentResolver cr = c.getContentResolver();
        String cur = Settings.Secure.getString(cr, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
        // 别的应用（比如输入法、DSH）的服务原样留着，只把自己接在后面
        boolean has = false;
        if (cur != null) for (String s : cur.split(":")) if (s.equalsIgnoreCase(me)) has = true;
        try {
            if (!has) Settings.Secure.putString(cr, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES, cur == null || cur.isEmpty() ? me : cur + ":" + me);
            Settings.Secure.putInt(cr, Settings.Secure.ACCESSIBILITY_ENABLED, 1);
        } catch (SecurityException e) {
            return Tr.t("写系统设置被拒绝：") + e.getMessage();
        }
        long end = System.currentTimeMillis() + waitMs;
        while (self == null && System.currentTimeMillis() < end) try { Thread.sleep(100); } catch (InterruptedException ignored) { break; }
        return self != null ? null : Tr.t("已经写了系统设置，但服务没连上（有的系统会拦，去系统的无障碍设置里看看）");
    }

    static void disable(Context c) {
        A11y s = self;
        if (s != null) { s.disableSelf(); return; }
        if (!canToggle(c)) return;
        String me = component(c).flattenToString();
        android.content.ContentResolver cr = c.getContentResolver();
        String cur = Settings.Secure.getString(cr, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
        if (cur == null) return;
        StringBuilder sb = new StringBuilder();
        for (String x : cur.split(":")) if (!x.isEmpty() && !x.equalsIgnoreCase(me)) sb.append(sb.length() > 0 ? ":" : "").append(x);
        try { Settings.Secure.putString(cr, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES, sb.toString()); } catch (SecurityException ignored) {}
    }

    // ── 读屏 ─────────────────────────────────────────────────────────────
    static JSONObject read(boolean all) throws Exception {
        A11y s = self;
        if (s == null) return fail(Tr.t("无障碍没开。到 设置 → 设备工具 里打开（要先激活 Shizuku），或自己去系统的无障碍设置里打开 cccodroid"));
        touch();
        AccessibilityNodeInfo root = s.getRootInActiveWindow();
        JSONObject r = new JSONObject().put("ok", true);
        if (root == null) return r.put("ok", false).put("message", Tr.t("拿不到当前界面（锁屏、或者是不让读的安全界面）"));
        String pkg = String.valueOf(root.getPackageName());
        if (isProtectedPackage(pkg)) {
            synchronized (LOCK) { nodes.clear(); sigs.clear(); }
            return fail(Tr.t("当前界面属于支付、网银、动态口令、密码管理或系统授权受保护应用，已拒绝读取：") + pkg);
        }
        r.put("package", pkg);
        for (AccessibilityWindowInfo w : s.getWindows())
            if (w.isActive() && w.getTitle() != null) { r.put("window", w.getTitle().toString()); break; }
        StringBuilder out = new StringBuilder();
        List<AccessibilityNodeInfo> localNodes = new ArrayList<>();
        List<String> localSigs = new ArrayList<>();
        walk(root, 0, all, out, localNodes, localSigs);
        // 网页（WebView / 浏览器）在无障碍刚打开时还没生成内容树，只露出一个空壳：等一下再读一次
        if (localNodes.size() <= 2 && out.indexOf("WebView") >= 0) {
            Thread.sleep(800);
            root.refresh();
            out.setLength(0);
            localNodes.clear(); localSigs.clear();
            walk(root, 0, all, out, localNodes, localSigs);
        }
        int count;
        synchronized (LOCK) {
            nodes.clear(); nodes.addAll(localNodes);
            sigs.clear(); sigs.addAll(localSigs);
            count = nodes.size();
        }
        Rect sc = new Rect(); root.getBoundsInScreen(sc);
        r.put("screen", sc.width() + "x" + sc.height());
        r.put("count", count);
        String txt = out.toString();
        if (txt.length() > 60000) txt = txt.substring(0, 60000) + "\n…(" + Tr.t("太长，截断了") + ")";
        return r.put("tree", txt);
    }

    private static void walk(AccessibilityNodeInfo n, int depth, boolean all, StringBuilder out,
                             List<AccessibilityNodeInfo> localNodes, List<String> localSigs) {
        if (n == null || localNodes.size() >= 800) return;
        if (!n.isVisibleToUser()) return;
        CharSequence text = n.getText(), desc = n.getContentDescription();
        // 密码框的内容不交给模型：有的应用 getText 给的是明文，不是圆点，也有把明文放进描述的，两样都不读
        // （框本身照样列出，标 password，还能填）
        boolean pw = n.isPassword();
        if (pw) { text = null; desc = null; }
        boolean click = n.isClickable() || n.isLongClickable(), edit = n.isEditable(), scroll = n.isScrollable();
        boolean useful = all || pw || click || edit || scroll || n.isCheckable()
            || (text != null && text.length() > 0) || (desc != null && desc.length() > 0);
        int nextDepth = depth;
        if (useful) {
            int id = localNodes.size();
            localNodes.add(n);
            localSigs.add(sig(n));
            Rect b = new Rect(); n.getBoundsInScreen(b);
            for (int i = Math.min(depth, 12); i > 0; i--) out.append("  ");
            out.append('[').append(id).append("] ");
            String cls = String.valueOf(n.getClassName());
            out.append(cls.substring(cls.lastIndexOf('.') + 1));
            if (text != null && text.length() > 0) out.append(" \"").append(clip(text)).append('"');
            if (desc != null && desc.length() > 0 && !String.valueOf(desc).equals(String.valueOf(text))) out.append(" (").append(clip(desc)).append(')');
            String rid = n.getViewIdResourceName();
            if (rid != null) out.append(" #").append(rid.substring(rid.indexOf('/') + 1));
            out.append(" @").append(b.centerX()).append(',').append(b.centerY());
            if (click) out.append(" click");
            if (edit) out.append(" edit");
            if (pw) out.append(" password");
            if (scroll) out.append(" scroll");
            if (n.isCheckable()) out.append(n.isChecked() ? " checked" : " unchecked");
            if (n.isFocused()) out.append(" focused");
            if (n.isSelected()) out.append(" selected");
            if (!n.isEnabled()) out.append(" disabled");
            out.append('\n');
            nextDepth = depth + 1;
        }
        for (int i = 0; i < n.getChildCount(); i++) walk(n.getChild(i), nextDepth, all, out, localNodes, localSigs);
    }

    /** 编号的指纹：模型从屏幕树里认这个元素靠的那几样。输入框的文字会随输入变，不算；密码框的内容本来就不读 */
    private static String sig(AccessibilityNodeInfo n) {
        boolean pw = n.isPassword();
        CharSequence t = pw || n.isEditable() ? null : n.getText(), d = pw ? null : n.getContentDescription();
        return n.getClassName() + "\u0001" + t + "\u0001" + d + "\u0001" + n.getViewIdResourceName();
    }

    private static String clip(CharSequence c) {
        // 控制字符（应用里偶尔混着 \u0000、方向控制符之类）不交给模型，换成空格
        String s = c.toString().replaceAll("[\\p{Cc}\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]", " ");
        return s.length() > 160 ? s.substring(0, 160) + "…" : s;
    }

    private static AccessibilityNodeInfo node(int id, String[] missOut) {
        synchronized (LOCK) {
            if (missOut != null && missOut.length > 0) missOut[0] = Tr.t("找不到这个编号的元素：界面变了，先重新 screen_read");
            if (id < 0 || id >= nodes.size()) return null;
            AccessibilityNodeInfo n = nodes.get(id);
            if (!n.refresh()) return null;
            if (!sig(n).equals(sigs.get(id))) {
                if (missOut != null && missOut.length > 0) missOut[0] = Tr.t("这个编号上的元素已经换了内容（列表滚动或刷新过），没有动手：按新屏幕重新选");
                return null;
            }
            return n;
        }
    }

    // ── 动作后等界面静下来 ────────────────────────────────────────────────
    // 首个事件最多等 800ms（没来 = 界面没动），之后静默 250ms 算稳，总共最多 2.5 秒。
    // notificationTimeout 平时是 1000（系统攒一秒才推一次），等的时候临时压到 50，不然首个事件就要晚一秒
    static final int EVT_SETTLE = AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED | AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED
        | AccessibilityEvent.TYPE_WINDOWS_CHANGED | AccessibilityEvent.TYPE_VIEW_SCROLLED;
    private static final java.util.concurrent.atomic.AtomicInteger armCount = new java.util.concurrent.atomic.AtomicInteger();

    /** 动作前调用：临时多订事件（引用计数，并发动作不提前撤订）。返回动作前的事件计数，交给 settle */
    static int arm() {
        if (armCount.incrementAndGet() == 1) {
            A11y s = self;
            if (s != null) try {
                AccessibilityServiceInfo i = s.getServiceInfo();
                if (i != null) { i.eventTypes = EVT_SETTLE; i.notificationTimeout = 50; s.setServiceInfo(i); }
            } catch (Throwable t) { Log.w(TAG, "settle arm", t); }
        }
        return evts;
    }

    static void disarm() {
        if (armCount.updateAndGet(v -> v > 0 ? v - 1 : 0) == 0) {
            A11y s = self;
            if (s != null) try {
                AccessibilityServiceInfo i = s.getServiceInfo();
                if (i != null) { i.eventTypes = AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED; i.notificationTimeout = 1000; s.setServiceInfo(i); }
            } catch (Throwable t) { Log.w(TAG, "settle disarm", t); }
        }
    }

    /** 等界面静下来；返回等了多少毫秒 */
    static long settle(int before) {
        long t0 = android.os.SystemClock.uptimeMillis();
        try {
            while (evts == before && android.os.SystemClock.uptimeMillis() - t0 < 800) Thread.sleep(20);
            if (evts != before)
                while (android.os.SystemClock.uptimeMillis() - lastEvt < 250 && android.os.SystemClock.uptimeMillis() - t0 < 2500) Thread.sleep(20);
        } catch (InterruptedException ignored) {
        } finally { disarm(); }
        return android.os.SystemClock.uptimeMillis() - t0;
    }

    /** 动作结果后面接上新屏幕。动作没做成也读（多半是编号过期了，新屏幕正好拿来重选），只是不等 */
    static JSONObject withScreen(JSONObject res, int before) throws Exception {
        boolean done = res.optBoolean("ok");
        if (done) res.put("settle_ms", settle(before)); else disarm();
        JSONObject sc;
        try { sc = read(false); } catch (Throwable t) { return res; }
        if (!sc.optBoolean("ok")) return res.put("screen_error", sc.optString("message"));
        for (String k : new String[] { "package", "window", "screen", "count", "tree" }) if (sc.has(k)) res.put(k, sc.get(k));
        return res;
    }

    // ── 动作 ─────────────────────────────────────────────────────────────
    static JSONObject tap(JSONObject a) throws Exception {
        touch();
        String activePkg = activePackage(self);
        if (isProtectedPackage(activePkg)) return fail(Tr.t("当前界面属于支付、网银、动态口令、密码管理或系统授权受保护应用，已拒绝操作：") + activePkg);
        boolean lng = a.optBoolean("long", false);
        if (a.has("node")) {
            String[] miss = new String[1];
            AccessibilityNodeInfo n = node(a.getInt("node"), miss);
            if (n == null) return fail(miss[0]);
            int act = lng ? AccessibilityNodeInfo.ACTION_LONG_CLICK : AccessibilityNodeInfo.ACTION_CLICK;
            // 文字本身不可点时，往上找第一个可点的父节点（列表项常见）
            for (AccessibilityNodeInfo p = n; p != null; p = p.getParent())
                if ((lng ? p.isLongClickable() : p.isClickable()) && p.performAction(act)) return ok("action");
            Rect b = new Rect(); n.getBoundsInScreen(b);
            return gesture(b.centerX(), b.centerY(), b.centerX(), b.centerY(), lng ? 700 : 60) ? ok("gesture") : fail(Tr.t("点不动"));
        }
        if (!a.has("x") || !a.has("y")) return fail(Tr.t("要给 node（screen_read 里的编号），或者 x、y 坐标"));
        int x = a.getInt("x"), y = a.getInt("y");
        return gesture(x, y, x, y, lng ? 700 : 60) ? ok("gesture") : fail(Tr.t("手势被系统取消了"));
    }

    static JSONObject swipe(JSONObject a) throws Exception {
        touch();
        String activePkg = activePackage(self);
        if (isProtectedPackage(activePkg)) return fail(Tr.t("当前界面属于支付、网银、动态口令、密码管理或系统授权受保护应用，已拒绝操作：") + activePkg);
        if (a.has("node")) {
            String[] miss = new String[1];
            AccessibilityNodeInfo n = node(a.getInt("node"), miss);
            if (n == null) return fail(miss[0]);
            boolean back = "backward".equals(a.optString("direction", "forward"));
            int act = back ? AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD : AccessibilityNodeInfo.ACTION_SCROLL_FORWARD;
            for (AccessibilityNodeInfo p = n; p != null; p = p.getParent())
                if (p.isScrollable() && p.performAction(act)) return ok("scroll");
            return fail(Tr.t("这个元素和它的上层都不能滚动"));
        }
        int dur = Math.max(50, Math.min(a.optInt("duration_ms", 300), 5000));
        return gesture(a.getInt("x1"), a.getInt("y1"), a.getInt("x2"), a.getInt("y2"), dur) ? ok("gesture") : fail(Tr.t("手势被系统取消了"));
    }

    static JSONObject type(JSONObject a) throws Exception {
        touch();
        String activePkg = activePackage(self);
        if (isProtectedPackage(activePkg)) return fail(Tr.t("当前界面属于支付、网银、动态口令、密码管理或系统授权受保护应用，已拒绝操作：") + activePkg);
        AccessibilityNodeInfo n = null;
        if (a.has("node")) { String[] miss = new String[1]; n = node(a.getInt("node"), miss); if (n == null) return fail(miss[0]); }
        else {
            A11y s = self;
            if (s == null) return fail(Tr.t("无障碍没开。到 设置 → 设备工具 里打开（要先激活 Shizuku），或自己去系统的无障碍设置里打开 cccodroid"));
            AccessibilityNodeInfo root = s.getRootInActiveWindow();
            if (root != null) n = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        }
        if (n == null || !n.isEditable()) return fail(Tr.t("没找到输入框：给 node（screen_read 里带 edit 的编号），或先点一下输入框"));
        String text = a.optString("text", "");
        if (a.optBoolean("append", false) && n.isPassword()) return fail(Tr.t("密码框不读原有内容，不能追加：请给出完整内容，不带 append"));
        if (a.optBoolean("append", false) && n.getText() != null) text = n.getText() + text;
        Bundle b = new Bundle();
        b.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
        if (!n.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, b)) return fail(Tr.t("这个输入框不接受直接填字"));
        if (a.optBoolean("submit", false)) {
            // 回车 / 搜索：安卓 11+ 有 IME 动作
            if (android.os.Build.VERSION.SDK_INT >= 30) n.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.getId());
        }
        return ok("set_text");
    }

    static JSONObject key(JSONObject a) throws Exception {
        touch();
        String k = a.optString("key");
        int g;
        switch (k) {
            case "back": g = GLOBAL_ACTION_BACK; break;
            case "home": g = GLOBAL_ACTION_HOME; break;
            case "recents": g = GLOBAL_ACTION_RECENTS; break;
            case "notifications": g = GLOBAL_ACTION_NOTIFICATIONS; break;
            case "quick_settings": g = GLOBAL_ACTION_QUICK_SETTINGS; break;
            case "lock_screen": g = GLOBAL_ACTION_LOCK_SCREEN; break;
            default: return fail(Tr.t("不认识的按键：") + k);
        }
        A11y s = self;
        if (s == null) return fail(Tr.t("无障碍没开。到 设置 → 设备工具 里打开（要先激活 Shizuku），或自己去系统的无障碍设置里打开 cccodroid"));
        return s.performGlobalAction(g) ? ok(k) : fail(Tr.t("系统没执行"));
    }

    /** 截屏 → JPEG（长边缩到 1280，省 token）。返回 base64 和存下来的路径 */
    static JSONObject screenshot(Context c) throws Exception {
        touch();
        if (android.os.Build.VERSION.SDK_INT < 30) return fail(Tr.t("截屏要安卓 11 以上"));
        A11y s = self;
        if (s == null) return fail(Tr.t("无障碍没开。到 设置 → 设备工具 里打开（要先激活 Shizuku），或自己去系统的无障碍设置里打开 cccodroid"));
        String activePkg = activePackage(s);
        if (isProtectedPackage(activePkg))
            return fail(Tr.t("当前界面属于支付、网银、动态口令、密码管理或系统授权受保护应用，已拒绝截屏：") + activePkg);
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<Bitmap> bmp = new AtomicReference<>();
        AtomicReference<String> err = new AtomicReference<>();
        s.takeScreenshot(Display.DEFAULT_DISPLAY, c.getMainExecutor(), new TakeScreenshotCallback() {
            @Override public void onSuccess(ScreenshotResult r) {
                android.hardware.HardwareBuffer hb = r.getHardwareBuffer();
                Bitmap hw = null;
                try {
                    hw = Bitmap.wrapHardwareBuffer(hb, r.getColorSpace());
                    bmp.set(hw == null ? null : hw.copy(Bitmap.Config.ARGB_8888, false));
                } catch (Throwable t) { err.set(t.toString()); }
                finally {
                    if (hw != null) hw.recycle();
                    if (hb != null) hb.close();
                }
                done.countDown();
            }
            @Override public void onFailure(int code) {
                err.set(code == ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT ? Tr.t("截得太快了，隔一秒再截") : Tr.t("系统拒绝截屏，错误码 ") + code);
                done.countDown();
            }
        });
        if (!done.await(5, TimeUnit.SECONDS)) return fail(Tr.t("截屏超时"));
        Bitmap orig = bmp.get();
        if (orig == null) return fail(err.get() != null ? err.get() : Tr.t("截屏失败"));
        Bitmap scaled = null;
        int w = orig.getWidth(), hh = orig.getHeight(), max = Math.max(w, hh);
        int sw = w, sh = hh;
        byte[] jpg;
        try {
            Bitmap b = orig;
            if (max > 1280) {
                float k = 1280f / max;
                scaled = Bitmap.createScaledBitmap(orig, Math.round(w * k), Math.round(hh * k), true);
                b = scaled;
            }
            sw = b.getWidth(); sh = b.getHeight();
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            b.compress(Bitmap.CompressFormat.JPEG, 80, bo);
            jpg = bo.toByteArray();
        } finally {
            if (scaled != null && scaled != orig) scaled.recycle();
            orig.recycle();
        }
        java.io.File dir = new java.io.File(new Env(c).home, ".cache/screens");
        dir.mkdirs();
        java.io.File[] old = dir.listFiles();
        if (old != null && old.length >= 20) {          // 只留最近 20 张
            java.util.Arrays.sort(old, (x, y) -> Long.compare(x.lastModified(), y.lastModified()));
            for (int i = 0; i < old.length - 19; i++) old[i].delete();
        }
        java.io.File f = new java.io.File(dir, "screen-" + System.currentTimeMillis() + ".jpg");
        try (java.io.FileOutputStream fo = new java.io.FileOutputStream(f)) { fo.write(jpg); }
        return ok("screenshot").put("path", f.getPath()).put("size", w + "x" + hh)
            .put("scaled", sw + "x" + sh)
            .put("jpeg", android.util.Base64.encodeToString(jpg, android.util.Base64.NO_WRAP));
    }

    private static boolean gesture(int x1, int y1, int x2, int y2, long ms) throws InterruptedException {
        Path p = new Path();
        p.moveTo(x1, y1);
        if (x1 != x2 || y1 != y2) p.lineTo(x2, y2);
        GestureDescription g = new GestureDescription.Builder().addStroke(new GestureDescription.StrokeDescription(p, 0, ms)).build();
        CountDownLatch done = new CountDownLatch(1);
        boolean[] okk = {false};
        new Handler(Looper.getMainLooper()).post(() -> {
            boolean sent = self != null && self.dispatchGesture(g, new GestureResultCallback() {
                @Override public void onCompleted(GestureDescription d) { okk[0] = true; done.countDown(); }
                @Override public void onCancelled(GestureDescription d) { done.countDown(); }
            }, null);
            if (!sent) done.countDown();
        });
        done.await(ms + 3000, TimeUnit.MILLISECONDS);
        return okk[0];
    }

    private static JSONObject ok(String via) throws Exception { return new JSONObject().put("ok", true).put("via", via); }
    private static JSONObject fail(String m) throws Exception { return new JSONObject().put("ok", false).put("message", m); }
}
