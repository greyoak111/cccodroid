package cc.codroid;

import android.accessibilityservice.AccessibilityService;
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
 * 下一次 screen_read 换一批编号。
 */
public class A11y extends AccessibilityService {
    static final String TAG = "cccodroid";
    static volatile A11y self;
    private static final Object LOCK = new Object();
    private static final List<AccessibilityNodeInfo> nodes = new ArrayList<>();
    private static volatile long lastUse;
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
        synchronized (LOCK) { nodes.clear(); }
        Log.i(TAG, "无障碍服务已断开");
        return super.onUnbind(i);
    }

    @Override public void onDestroy() { self = null; super.onDestroy(); }
    @Override public void onAccessibilityEvent(AccessibilityEvent e) { }
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
        touch();
        AccessibilityNodeInfo root = s.getRootInActiveWindow();
        JSONObject r = new JSONObject().put("ok", true);
        if (root == null) return r.put("ok", false).put("message", Tr.t("拿不到当前界面（锁屏、或者是不让读的安全界面）"));
        r.put("package", String.valueOf(root.getPackageName()));
        for (AccessibilityWindowInfo w : s.getWindows())
            if (w.isActive() && w.getTitle() != null) { r.put("window", w.getTitle().toString()); break; }
        StringBuilder out = new StringBuilder();
        synchronized (LOCK) {
            nodes.clear();
            walk(root, 0, all, out);
        }
        // 网页（WebView / 浏览器）在无障碍刚打开时还没生成内容树，只露出一个空壳：等一下再读一次
        if (nodes.size() <= 2 && out.indexOf("WebView") >= 0) {
            Thread.sleep(800);
            root.refresh();
            out.setLength(0);
            synchronized (LOCK) { nodes.clear(); walk(root, 0, all, out); }
        }
        Rect sc = new Rect(); root.getBoundsInScreen(sc);
        r.put("screen", sc.width() + "x" + sc.height());
        r.put("count", nodes.size());
        String txt = out.toString();
        if (txt.length() > 60000) txt = txt.substring(0, 60000) + "\n…(" + Tr.t("太长，截断了") + ")";
        return r.put("tree", txt);
    }

    private static void walk(AccessibilityNodeInfo n, int depth, boolean all, StringBuilder out) {
        if (n == null || nodes.size() >= 800) return;
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
            int id = nodes.size();
            nodes.add(n);
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
        for (int i = 0; i < n.getChildCount(); i++) walk(n.getChild(i), nextDepth, all, out);
    }

    private static String clip(CharSequence c) {
        String s = c.toString().replace('\n', ' ');
        return s.length() > 160 ? s.substring(0, 160) + "…" : s;
    }

    private static AccessibilityNodeInfo node(int id) {
        synchronized (LOCK) {
            if (id < 0 || id >= nodes.size()) return null;
            AccessibilityNodeInfo n = nodes.get(id);
            return n.refresh() ? n : null;
        }
    }

    // ── 动作 ─────────────────────────────────────────────────────────────
    static JSONObject tap(JSONObject a) throws Exception {
        touch();
        boolean lng = a.optBoolean("long", false);
        if (a.has("node")) {
            AccessibilityNodeInfo n = node(a.getInt("node"));
            if (n == null) return fail(Tr.t("找不到这个编号的元素：界面变了，先重新 screen_read"));
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
        if (a.has("node")) {
            AccessibilityNodeInfo n = node(a.getInt("node"));
            if (n == null) return fail(Tr.t("找不到这个编号的元素：界面变了，先重新 screen_read"));
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
        AccessibilityNodeInfo n = null;
        if (a.has("node")) n = node(a.getInt("node"));
        else {
            AccessibilityNodeInfo root = self.getRootInActiveWindow();
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
        return self.performGlobalAction(g) ? ok(k) : fail(Tr.t("系统没执行"));
    }

    /** 截屏 → JPEG（长边缩到 1280，省 token）。返回 base64 和存下来的路径 */
    static JSONObject screenshot(Context c) throws Exception {
        touch();
        if (android.os.Build.VERSION.SDK_INT < 30) return fail(Tr.t("截屏要安卓 11 以上"));
        A11y s = self;
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<Bitmap> bmp = new AtomicReference<>();
        AtomicReference<String> err = new AtomicReference<>();
        s.takeScreenshot(Display.DEFAULT_DISPLAY, c.getMainExecutor(), new TakeScreenshotCallback() {
            @Override public void onSuccess(ScreenshotResult r) {
                try {
                    Bitmap hw = Bitmap.wrapHardwareBuffer(r.getHardwareBuffer(), r.getColorSpace());
                    bmp.set(hw == null ? null : hw.copy(Bitmap.Config.ARGB_8888, false));
                    r.getHardwareBuffer().close();
                } catch (Throwable t) { err.set(t.toString()); }
                done.countDown();
            }
            @Override public void onFailure(int code) {
                err.set(code == ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT ? Tr.t("截得太快了，隔一秒再截") : Tr.t("系统拒绝截屏，错误码 ") + code);
                done.countDown();
            }
        });
        if (!done.await(5, TimeUnit.SECONDS)) return fail(Tr.t("截屏超时"));
        if (bmp.get() == null) return fail(err.get() != null ? err.get() : Tr.t("截屏失败"));
        Bitmap b = bmp.get();
        int w = b.getWidth(), hh = b.getHeight(), max = Math.max(w, hh);
        if (max > 1280) { float k = 1280f / max; b = Bitmap.createScaledBitmap(b, Math.round(w * k), Math.round(hh * k), true); }
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        b.compress(Bitmap.CompressFormat.JPEG, 80, bo);
        byte[] jpg = bo.toByteArray();
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
            .put("scaled", b.getWidth() + "x" + b.getHeight())
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
