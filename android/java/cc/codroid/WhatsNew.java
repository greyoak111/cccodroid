package cc.codroid;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 更新说明：更新后第一次打开时，界面在主窗口正中显示这次更新了什么。
 * 说明随 APK 带在 assets/whatsnew/v<版本>.<zh|en>.md（发布时 release.sh 也用这两份当 Release 正文）。
 * 记账在 SharedPreferences "ui" 的 whatsNewSeen：上次看过说明的版本。
 *   全新安装（首次安装时间 == 最近更新时间）→ 不显示（也不记账，见 pending 的只读约定）；
 *   从没有这项功能的旧版升上来（没记过、但不是全新安装）→ 只显示当前版本的；
 *   跳过了几个版本 → 显示看过之后的，新的在前，最多 3 个。
 */
final class WhatsNew {
    private static final String DIR = "whatsnew", KEY = "whatsNewSeen";
    private static final int MAX = 3;

    private WhatsNew() {}

    /** 要显示的说明：JSON 数组 [{v, md}]，没有就是 "[]"。lang 是界面最终用的语言（zh* 用中文，其余英文）。
     *  这个方法只读、不记账（0.6.10 审计 200-1-08）：JS 桥的 whatsNew 没有口令，HTML 预览的 iframe 也能调；
     *  以前它会在全新安装 / 本版没写说明时顺手把「已看过」写掉，预览页一调就把更新说明压掉了。
     *  记账只由带口令的 whatsNewSeen → seen() 负责。 */
    static String pending(Context c, String lang) {
        try {
            PackageInfo p = c.getPackageManager().getPackageInfo(c.getPackageName(), 0);
            String cur = p.versionName, seen = prefs(c).getString(KEY, null);
            if (seen == null && p.firstInstallTime == p.lastUpdateTime) return "[]";
            List<String> vs = new ArrayList<>();
            String[] files = c.getAssets().list(DIR);
            for (String f : files == null ? new String[0] : files) {
                if (!f.startsWith("v") || !f.endsWith(".md")) continue;
                String v = f.substring(1, f.length() - 3).replaceFirst("\\.(zh|en)$", "");
                if (vs.contains(v) || Updater.cmpVer(v, cur) > 0) continue;
                if (seen == null ? Updater.cmpVer(v, cur) == 0 : Updater.cmpVer(v, seen) > 0) vs.add(v);
            }
            Collections.sort(vs, new Comparator<String>() {
                @Override public int compare(String a, String b) { return Updater.cmpVer(b, a); }
            });
            boolean zh = lang != null && lang.startsWith("zh");
            JSONArray out = new JSONArray();
            for (String v : vs) {
                if (out.length() >= MAX) break;
                String md = read(c, "v" + v + (zh ? ".zh.md" : ".en.md"));
                if (md == null) md = read(c, "v" + v + (zh ? ".en.md" : ".zh.md"));
                if (md != null && !md.trim().isEmpty()) out.put(new JSONObject().put("v", v).put("md", md));
            }
            return out.toString();
        } catch (Exception e) { return "[]"; }
    }

    /** 界面显示出来了：记成当前版本，下次不再弹 */
    static void seen(Context c) {
        try { mark(c, c.getPackageManager().getPackageInfo(c.getPackageName(), 0).versionName); } catch (Exception ignored) {}
    }

    private static SharedPreferences prefs(Context c) { return c.getSharedPreferences("ui", Context.MODE_PRIVATE); }
    private static void mark(Context c, String v) { prefs(c).edit().putString(KEY, v).apply(); }

    private static String read(Context c, String name) {
        try (InputStream in = c.getAssets().open(DIR + "/" + name)) {
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            for (int n; (n = in.read(buf)) > 0; ) b.write(buf, 0, n);
            return new String(b.toByteArray(), StandardCharsets.UTF_8);
        } catch (Exception e) { return null; }
    }
}
