package cc.codroid;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

/**
 * 应用内浏览器本体（地址栏 + 系统 WebView）。两处用它：
 *   · BrowserActivity —— 窄屏时全屏打开；
 *   · MainActivity    —— 宽屏时嵌在对话界面右侧工作区，位置由页面（layout.js）经 CCApp.paneBounds 告诉外壳。
 *
 * 用的是系统 WebView —— 它本身就是 Chromium，这里不额外带任何引擎。
 * 和对话界面的 WebView 完全隔开：不挂 CCApp 桥，网页拿不到应用的任何接口。
 * 登录授权页（OAuth）不走这里，仍交给系统浏览器（WebView 里登录会被 Google 等拒绝）。
 *
 * 不用 lambda：开发端的构建链（同一份源码改包名）不支持。
 */
public class BrowserPane extends LinearLayout {
    static final String PREFS = "browser", LAST = "last", DEVTOOLS = "devtools", TAG = "cccodroid-browser";
    /** 开发者工具（Eruda，MIT）：开着时每个页面载完往里注入。本体读网关目录里随包带的那份，不走网络 */
    private boolean devtools;
    private String erudaSrc, pickSrc;
    private TextView pickBtn;
    private int pickPolls;     // 选取模式还剩几次轮询
    private boolean picking;

    /** 宿主：关闭（✕ / 渲染进程崩了）怎么处理由它定 */
    /** onPicked：开发者工具里选中了一块，json 是 JSON.stringify 的结果再经 evaluateJavascript 编成的 JS 字符串字面量 */
    public interface Host { void onPaneClose(); void onPicked(String json); }

    private final Activity act;
    private final Host host;
    private final int fileReq;
    final WebView web;
    private final EditText bar;
    private final ProgressBar prog;
    private final TextView back, fwd;
    private ValueCallback<Uri[]> fileCb;

    @SuppressLint("SetJavaScriptEnabled")
    public BrowserPane(Activity a, Host h, int fileReq) {
        super(a);
        act = a; host = h; this.fileReq = fileReq;
        boolean night = night(a);
        // 和对话界面同一套色（style.css 的 --bg / --fg / --bg3 / --fg3 / --accent，跟着风格走）
        int bg = pal(a, night, "bg");
        int fg = pal(a, night, "fg");
        int field = pal(a, night, "field");
        int hint = pal(a, night, "hint");
        int accent = pal(a, night, "accent");
        setOrientation(VERTICAL);
        setBackgroundColor(bg);

        LinearLayout top = new LinearLayout(a);
        top.setOrientation(HORIZONTAL);
        top.setGravity(Gravity.CENTER_VERTICAL);
        top.setPadding(dp(4), dp(4), dp(4), dp(4));
        back = btn("‹", fg, Tr.t("后退"));
        fwd = btn("›", fg, Tr.t("前进"));
        TextView reload = btn("⟳", fg, Tr.t("刷新"));
        bar = new EditText(a);
        bar.setSingleLine(true);
        bar.setTextSize(14);
        bar.setTextColor(fg);
        bar.setHintTextColor(hint);
        bar.setHint(Tr.t("网址，或 127.0.0.1:端口"));
        android.graphics.drawable.GradientDrawable fieldBg = new android.graphics.drawable.GradientDrawable();
        fieldBg.setColor(field);
        fieldBg.setCornerRadius(dp(10));
        bar.setBackground(fieldBg);
        bar.setHighlightColor((accent & 0x00ffffff) | 0x55000000);
        bar.setPadding(dp(10), dp(6), dp(10), dp(6));
        bar.setImeOptions(EditorInfo.IME_ACTION_GO);
        bar.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_URI);
        bar.setSelectAllOnFocus(true);
        devtools = a.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(DEVTOOLS, false);
        final TextView dt = btn("</>", fg, Tr.t("开发者工具"));
        dt.setTextSize(13);
        dt.setAlpha(devtools ? 1f : 0.45f);
        pickBtn = btn("⌖", fg, Tr.t("选取元素"));
        pickBtn.setVisibility(devtools ? View.VISIBLE : View.GONE);
        TextView ext = btn("↗", fg, Tr.t("用系统浏览器打开"));
        TextView close = btn("✕", fg, Tr.t("关闭"));
        top.addView(back); top.addView(fwd); top.addView(reload);
        LayoutParams lp = new LayoutParams(0, LayoutParams.WRAP_CONTENT, 1);
        lp.setMargins(dp(4), 0, dp(4), 0);
        top.addView(bar, lp);
        top.addView(dt); top.addView(pickBtn); top.addView(ext); top.addView(close);
        addView(top);

        prog = new ProgressBar(a, null, android.R.attr.progressBarStyleHorizontal);
        prog.setMax(100);
        prog.setProgressTintList(android.content.res.ColorStateList.valueOf(accent));
        prog.setProgressBackgroundTintList(android.content.res.ColorStateList.valueOf(bg));
        addView(prog, new LayoutParams(LayoutParams.MATCH_PARENT, dp(3)));

        web = new WebView(a);
        web.setBackgroundColor(night ? bg : Color.WHITE);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        s.setSupportZoom(true);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setAllowFileAccess(false);                 // 网页不许读本机文件
        s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);
        addView(web, new LayoutParams(LayoutParams.MATCH_PARENT, 0, 1));

        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                return route(r.getUrl().toString());
            }
            @SuppressWarnings("deprecation")
            @Override public boolean shouldOverrideUrlLoading(WebView v, String url) { return route(url); }
            // 界面专用地址（任何端口）和网关端口：子资源、iframe、XHR 也一律不许碰（GHSA-hwmm 第 1 项）。
            // 这里和界面共用 CookieManager，专用地址上的会话 Cookie 不分端口，放过去就被那个端口上的应用收走了
            @Override public android.webkit.WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                return forbidden(r.getUrl().toString()) ? MainActivity.blocked() : null;
            }
            @Override public void onPageStarted(WebView v, String url, Bitmap icon) { Log.i(TAG, "start " + logUrl(url)); pickStop(); shown(url); }
            @Override public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                if (r.isForMainFrame()) Log.w(TAG, "error " + e.getErrorCode() + " " + e.getDescription() + " " + logUrl(String.valueOf(r.getUrl())));
            }
            @Override public boolean onRenderProcessGone(WebView v, android.webkit.RenderProcessGoneDetail d) {
                Log.w(TAG, "renderer gone crash=" + d.didCrash());
                host.onPaneClose();
                return true;
            }
            @Override public void onPageFinished(WebView v, String url) {
                Log.i(TAG, "finish " + logUrl(url));
                if (devtools) injectDevtools();
                shown(url);
                act.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(LAST, url).apply();
            }
            @Override public void doUpdateVisitedHistory(WebView v, String url, boolean reload) { shown(url); }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onProgressChanged(WebView v, int p) {
                prog.setProgress(p);
                prog.setVisibility(p >= 100 ? View.INVISIBLE : View.VISIBLE);
            }
            @Override public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
                if (fileCb != null) fileCb.onReceiveValue(null);
                fileCb = cb;
                try { act.startActivityForResult(MainActivity.chooserIntent(p), BrowserPane.this.fileReq); } catch (Exception e) { fileCb = null; return false; }
                return true;
            }
        });
        // 下载：交给系统（下载管理器 / 浏览器），这里不自己存文件
        web.setDownloadListener(new DownloadListener() {
            @Override public void onDownloadStart(String url, String ua, String cd, String mime, long len) { external(url); }
        });

        back.setOnClickListener(new OnClickListener() { @Override public void onClick(View v) { if (web.canGoBack()) web.goBack(); } });
        fwd.setOnClickListener(new OnClickListener() { @Override public void onClick(View v) { if (web.canGoForward()) web.goForward(); } });
        reload.setOnClickListener(new OnClickListener() { @Override public void onClick(View v) { web.reload(); } });
        dt.setOnClickListener(new OnClickListener() { @Override public void onClick(View v) {
            devtools = !devtools;
            act.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(DEVTOOLS, devtools).apply();
            dt.setAlpha(devtools ? 1f : 0.45f);
            pickBtn.setVisibility(devtools ? View.VISIBLE : View.GONE);
            pickStop();
            web.reload();
        } });
        pickBtn.setOnClickListener(new OnClickListener() { @Override public void onClick(View v) {
            if (picking) { pickStop(); web.evaluateJavascript("window.postMessage({cc:'pickoff'},'*')", null); return; }
            if (pickSrc == null) pickSrc = readWeb("vendor/cc-pick.js");
            if (pickSrc == null) return;
            web.evaluateJavascript("if(!window.__ccPick){" + pickSrc + "\n}window.__ccPicked=null;window.postMessage({cc:'pick'},'*')", null);
            picking = true; pickPolls = 200;   // 0.3 秒一次，最多等一分钟
            pickBtn.setAlpha(0.5f);
            android.widget.Toast.makeText(act, Tr.t("点一下网页里的某一块，它就会放进输入框"), android.widget.Toast.LENGTH_SHORT).show();
            pickPoll();
        } });
        ext.setOnClickListener(new OnClickListener() { @Override public void onClick(View v) { external(web.getUrl()); } });
        close.setOnClickListener(new OnClickListener() { @Override public void onClick(View v) { host.onPaneClose(); } });
        bar.setOnEditorActionListener(new TextView.OnEditorActionListener() {
            @Override public boolean onEditorAction(TextView v, int id, KeyEvent e) {
                go(bar.getText().toString());
                return true;
            }
        });
    }

    /** 外壳自己画的东西（状态栏、安装页、对话框、浏览器工具条）和界面同一套色。
     *  风格由 theme.js → CCApp.skinPref 存在 prefs "ui" 的 skin：native（暖色 + 陶土橙）| qiusuo（DeepSeek Harness 的冷灰 + 蓝）| zhuyue（Kimi 式的黑白，强调色就是黑 / 白）| goucheng（构成主义：牛皮纸 + 墨黑 + 红）| shise（拾色：Material You，theme.js 按壁纸主色现算，经 CCApp.skinPal 存在 pal_light / pal_dark）。
     *  键：bg 页面底 / card 对话框 / field 输入框 / line 分隔线 / fg 正文 / dim 次要字 / hint 提示字 / accent 强调色 */
    static int pal(Context c, boolean night, String k) {
        android.content.SharedPreferences ui = c.getSharedPreferences("ui", Context.MODE_PRIVATE);
        if ("accent".equals(k)) {     // 界面里自定了强调色（见 MainActivity.accentPref）就用它
            String own = ui.getString(night ? "accent_dark" : "accent_light", "");
            if (own.matches("#[0-9a-f]{6}")) return Color.parseColor(own);
        }
        String skin = ui.getString("skin", "native");
        boolean qs = "qiusuo".equals(skin);
        String[] keys = { "bg", "card", "field", "line", "fg", "dim", "hint", "accent" };
        String own = "shise".equals(skin) ? ui.getString(night ? "pal_dark" : "pal_light", "")
            : "goucheng".equals(skin) && !night ? ui.getString("gc_pal_light", "") : "";   // 构成浅色调过纸色（MainActivity.gcPal）
        String[] v = own.matches("#[0-9a-f]{6}(,#[0-9a-f]{6}){7}") ? own.split(",")
            : "shise".equals(skin)     // 还没算过（刚切过来、界面没起来）：M3 的默认紫
            ? (night ? new String[] { "#141218", "#1d1b20", "#2b2930", "#49454f", "#e6e0e9", "#cac4d0", "#938f99", "#d0bcff" }
                     : new String[] { "#fef7ff", "#f7f2fa", "#ece6f0", "#cac4d0", "#1d1b20", "#49454f", "#79747e", "#6750a4" })
            : "goucheng".equals(skin)
            ? (night ? new String[] { "#151412", "#1f1d1a", "#2a2723", "#4a453d", "#f0e6d2", "#c9bea7", "#9a8f7c", "#f0473b" }
                     : new String[] { "#f3eee3", "#faf7ef", "#e9e2d2", "#cdc2aa", "#1a1a1a", "#4f483d", "#6b6255", "#c8211b" })
            : "zhuyue".equals(skin)
            ? (night ? new String[] { "#111111", "#1f1f1f", "#292929", "#2b2b2b", "#f2f2f2", "#bdbdbd", "#7a7a7a", "#f2f2f2" }
                     : new String[] { "#ffffff", "#ffffff", "#f5f5f5", "#eeeeee", "#141414", "#5c5c5c", "#9a9a9a", "#141414" })
            : qs
            ? (night ? new String[] { "#151517", "#232324", "#2c2c2e", "#2f3033", "#f9fafb", "#cfd3d6", "#81858c", "#5686fe" }
                     : new String[] { "#ffffff", "#ffffff", "#f1f3f5", "#e5e7eb", "#0f1115", "#61666b", "#81858c", "#4176e6" })
            : (night ? new String[] { "#1f1e1d", "#262624", "#2f2e2b", "#3a3935", "#ece9e1", "#aaa59b", "#7f7a70", "#d97757" }
                     : new String[] { "#faf9f5", "#faf9f5", "#efece4", "#e0dcd0", "#29261f", "#5d594f", "#8b867a", "#c96442" });
        for (int i = 0; i < keys.length; i++) if (keys[i].equals(k)) return Color.parseColor(v[i]);
        throw new IllegalArgumentException(k);
    }

    /** 跟界面里选的外观走（theme.js → CCApp.themePref 存在 prefs "ui"），没选过才看系统 */
    static boolean night(Context c) {
        String p = c.getSharedPreferences("ui", Context.MODE_PRIVATE).getString("theme", "auto");
        if ("dark".equals(p)) return true;
        if ("light".equals(p)) return false;
        return (android.content.res.Resources.getSystem().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
    }

    /** 打开 url；为空就回到上次看的那页，没有上次就停在空白页、光标进地址栏 */
    public void load(String u) {
        if (u == null || u.length() == 0) u = act.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(LAST, null);
        if (u == null || u.length() == 0) {
            shown("");
            // 空白页：光标直接进地址栏、弹键盘（不然焦点会落在"后退"按钮上）
            bar.requestFocus();
            bar.postDelayed(new Runnable() { public void run() {
                InputMethodManager im = (InputMethodManager) act.getSystemService(Context.INPUT_METHOD_SERVICE);
                if (im != null) im.showSoftInput(bar, InputMethodManager.SHOW_IMPLICIT);
            } }, 250);
            return;
        }
        go(u);
    }

    /** 日志里只记到路径：查询串和锚点常带口令 / 授权码，诊断包里用不着（审查 #49 待确认-7） */
    static String logUrl(String u) {
        if (u == null) return "null";
        int i = u.length();
        for (char c : new char[] { '?', '#' }) { int j = u.indexOf(c); if (j >= 0 && j < i) i = j; }
        return i < u.length() ? u.substring(0, i) + "?…" : u;
    }

    /** 地址栏输入 → 网址：带协议的原样；像主机名/IP:端口的补 http(s)；其余当搜索词 */
    private void go(String in) {
        String u = in == null ? "" : in.trim();
        Log.i(TAG, "go '" + logUrl(u) + "'");
        if (u.length() == 0) return;
        // 「localhost:3000」「example.com:8080」冒号后是端口，不是协议；端口后直接跟 ?、# 也算（审查 #49 P3-2）
        if (!u.matches("(?i)^[a-z][a-z0-9+.-]*:.*") || u.matches("^[^/:\\s]+:\\d+([/?#].*)?$")) {
            if (u.matches("^(localhost|127\\.0\\.0\\.1|\\d{1,3}(\\.\\d{1,3}){3}|\\[[0-9a-fA-F:]+\\])(:\\d+)?([/?#].*)?$")) u = "http://" + u;
            else if (!u.contains(" ") && u.matches("^[^/]+\\.[a-zA-Z]{2,}(:\\d+)?([/?#].*)?$")) u = "https://" + u;
            else u = "https://www.bing.com/search?q=" + Uri.encode(u);
        }
        if (route(u)) return;
        web.loadUrl(u);
        web.requestFocus();
        InputMethodManager im = (InputMethodManager) act.getSystemService(Context.INPUT_METHOD_SERVICE);
        if (im != null) im.hideSoftInputFromWindow(bar.getWindowToken(), 0);
    }

    /** http/https 留在这里；其余协议（intent:、mailto:、market:、tel: …）交给系统。返回 true = 已处理 */
    /** 内置浏览器碰不得的地址：老界面专用地址 127.0.0.2 的任何端口、各种回环写法下的网关端口。
     *  故意不跟 Env.HOST 的回退走（见 MainActivity.isUiHostDot2）：回退设备上浏览器还得能开本机 127.0.0.1 上的服务 */
    static boolean forbidden(String url) {
        if (url == null) return false;
        try { if (MainActivity.isUiHostDot2(Uri.parse(url.trim()).getHost())) return true; } catch (Exception e) { return true; }
        return MainActivity.isGatewayUrl(url);
    }

    private boolean route(String url) {
        if (url == null) return true;
        if (forbidden(url)) {
            Toast.makeText(act, Tr.t("这个地址是 cccodroid 自己用的，不能在内置浏览器里打开"), Toast.LENGTH_LONG).show();
            return true;
        }
        String l = url.toLowerCase(java.util.Locale.ROOT);
        if (l.startsWith("http://") || l.startsWith("https://") || l.startsWith("about:") || l.startsWith("data:") || l.startsWith("blob:")) return false;
        external(url);
        return true;
    }

    private void external(String url) {
        if (url == null || url.length() == 0) return;
        try {
            Intent i = url.startsWith("intent:") ? Intent.parseUri(url, Intent.URI_INTENT_SCHEME) : new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            i.addCategory(Intent.CATEGORY_BROWSABLE);
            i.setComponent(null); i.setSelector(null);       // intent: 链接不许点名拉起任意组件
            // 网页里的 intent: 只当成「打开这个地址」：动作一律 VIEW、不带附加数据、不带授权标志，
            // 不许指向本机文件 / content:（审查 10-29 第六份 低2：以前 action 和 extras 由网页随便填）
            i.setAction(Intent.ACTION_VIEW);
            i.replaceExtras((android.os.Bundle) null);
            i.setClipData(null);
            String sc = i.getData() == null ? "" : String.valueOf(i.getData().getScheme()).toLowerCase(java.util.Locale.ROOT);
            if (sc.equals("file") || sc.equals("content") || sc.equals("intent") || sc.equals("javascript")) throw new Exception(sc);
            i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            act.startActivity(i);
        } catch (Exception e) {
            Toast.makeText(act, Tr.t("没有能打开它的应用：") + url, Toast.LENGTH_LONG).show();
        }
    }

    private void shown(String url) {
        if (!bar.hasFocus()) bar.setText(url == null ? "" : url);
        back.setAlpha(web.canGoBack() ? 1f : 0.35f);
        fwd.setAlpha(web.canGoForward() ? 1f : 0.35f);
    }

    /** 返回手势：网页能后退就后退，返回 true；不能就返回 false，由宿主决定关不关 */
    public boolean back() {
        if (web.canGoBack()) { web.goBack(); return true; }
        return false;
    }

    public boolean canBack() { return web.canGoBack(); }

    /** 宿主在 onActivityResult 里转过来（请求码是构造时给的 fileReq） */
    public void onResult(int res, Intent data) {
        if (fileCb == null) return;
        fileCb.onReceiveValue(MainActivity.chooserResult(act, res, data));
        fileCb = null;
    }

    /** 随 APK 带的前端文件（Eruda、选取脚本）：从 assets 读，不读可写的 files/app，
     *  否则同 uid 篡改会让脚本注入到用户正在浏览的任意站点（审查 11-05） */
    private String readWeb(String rel) {
        try (java.io.InputStream in = act.getAssets().open("app/web/" + rel)) {
            java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
            byte[] b = new byte[16384];
            for (int n; (n = in.read(b)) > 0; ) bo.write(b, 0, n);
            return new String(bo.toByteArray(), java.nio.charset.StandardCharsets.UTF_8);
        } catch (Exception e) { Log.w(TAG, rel + ": " + e); return null; }
    }
    /** 选取模式：不给网页开任何原生接口，由这边隔一会儿去网页里取结果（window.__ccPicked），取到就交给对话界面 */
    private void pickPoll() {
        if (!picking) return;
        pickPolls--;
        web.evaluateJavascript("(function(){var p=window.__ccPicked;window.__ccPicked=null;return p?JSON.stringify(p):null})()",
            new ValueCallback<String>() { @Override public void onReceiveValue(String v) {
                if (!picking) return;
                if (v != null && v.startsWith("\"")) { pickStop(); host.onPicked(v); return; }
                if (pickPolls <= 0) { pickStop(); return; }
                web.postDelayed(new Runnable() { public void run() { pickPoll(); } }, 300);
            } });
    }
    private void pickStop() { picking = false; pickPolls = 0; if (pickBtn != null) pickBtn.setAlpha(1f); }

    private void injectDevtools() {
        if (erudaSrc == null) erudaSrc = readWeb("vendor/eruda/eruda.js");
        if (erudaSrc == null) return;
        String theme = night(act) ? "Dark" : "Light";
        web.evaluateJavascript("if(!window.__ccEruda){window.__ccEruda=1;" + erudaSrc
            + "\n;try{eruda.init({defaults:{displaySize:50,transparency:.97,theme:'" + theme + "'}})}catch(e){}}", null);
    }

    public void saveState(Bundle o) { web.saveState(o); }
    public void restoreState(Bundle b) { web.restoreState(b); }
    public void pause() { web.onPause(); CookieManager.getInstance().flush(); }
    public void resume() { web.onResume(); }
    public void destroy() { web.stopLoading(); web.setWebChromeClient(null); web.destroy(); }

    private TextView btn(String label, int fg, String desc) {
        TextView t = new TextView(act);
        t.setText(label);
        t.setTextSize(20);
        t.setTextColor(fg);
        t.setGravity(Gravity.CENTER);
        t.setContentDescription(desc);
        t.setMinWidth(dp(40));
        t.setPadding(dp(6), dp(2), dp(6), dp(2));
        t.setBackgroundResource(android.R.drawable.list_selector_background);
        return t;
    }

    private int dp(int v) { return Math.round(getResources().getDisplayMetrics().density * v); }
}
