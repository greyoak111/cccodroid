package cc.codroid;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.util.Log;
import android.view.View;

/**
 * 应用内浏览器的全屏窗口（窄屏时用）：看本机开发服务（http://127.0.0.1:端口）和回复里的网页链接。
 * 界面和逻辑都在 BrowserPane 里；宽屏时同一个 BrowserPane 嵌在对话界面的右侧工作区（见 MainActivity）。
 *
 * 不用 lambda：开发端的构建链（同一份源码改包名）不支持。
 */
public class BrowserActivity extends Activity implements BrowserPane.Host {
    static final String EXTRA_URL = "url";
    private BrowserPane pane;

    /** 从对话界面打开：url 为空就回到上次看的那页 */
    static void open(Context c, String url) {
        Intent i = new Intent(c, BrowserActivity.class);
        if (url != null && url.length() > 0) i.putExtra(EXTRA_URL, url);
        c.startActivity(i);
    }

    @Override protected void onCreate(Bundle b) {
        boolean night = BrowserPane.night(this);       // 跟界面里选的外观走
        setTheme(night ? android.R.style.Theme_Material_NoActionBar : android.R.style.Theme_Material_Light_NoActionBar);
        super.onCreate(b);
        Log.i(BrowserPane.TAG, "onCreate saved=" + (b != null));
        int bg = BrowserPane.pal(this, night, "bg");
        getWindow().setStatusBarColor(bg);
        getWindow().setNavigationBarColor(bg);
        if (!night) getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        pane = new BrowserPane(this, this, 8);
        // targetSdk 35 起窗口强制画到系统栏底下，设的栏色也不再生效：内容按系统栏留白，留白处用同一个底色
        getWindow().getDecorView().setBackgroundColor(bg);
        pane.setFitsSystemWindows(true);
        setContentView(pane);
        if (b != null) pane.restoreState(b);
        else load(getIntent());
    }

    @Override protected void onNewIntent(Intent i) {
        Log.i(BrowserPane.TAG, "onNewIntent"); super.onNewIntent(i); setIntent(i); load(i); }

    private void load(Intent i) { pane.load(i == null ? null : i.getStringExtra(EXTRA_URL)); }

    @Override public void onPaneClose() { finish(); }
    // 单独开的浏览器没有对话界面可交：提示一下
    @Override public void onPicked(String json) { android.widget.Toast.makeText(this, Tr.t("只有在 cccodroid 里打开的浏览器窗格能把选中的发给 Claude"), android.widget.Toast.LENGTH_SHORT).show(); }

    @Override protected void onSaveInstanceState(Bundle o) { super.onSaveInstanceState(o); pane.saveState(o); }

    @Override protected void onActivityResult(int req, int res, Intent data) {
        if (req == 8) pane.onResult(res, data);
    }

    @Override public void onBackPressed() {
        if (!pane.back()) finish();
    }

    @Override protected void onPause() { super.onPause(); pane.pause(); }
    @Override protected void onResume() { super.onResume(); pane.resume(); }
    @Override protected void onDestroy() {
        if (pane != null) pane.destroy();
        super.onDestroy();
    }
}
