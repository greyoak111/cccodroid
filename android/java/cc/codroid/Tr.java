package cc.codroid;

import android.content.Context;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import org.json.JSONObject;

/**
 * 外壳文案的多语言。源语言是中文、键就是中文原句（和界面 web/lang-*.js 一个思路）。
 * 词典在 assets/i18n/java-<code>.json；缺译回退英文，再回退中文原句。
 *
 * 语言怎么定：界面每次加载都经 CCApp.langPref 报一次它最终用的语言（存在 SharedPreferences ui/lang）；
 * 界面还没起来过（第一次安装那几分钟）就按系统语言配，规则照 web/langs.js。
 *
 * 带变量的句子用 f：占位写 {0} {1}…，译文里可以换顺序。
 */
final class Tr {
    static final String[][] LANGS = {           // code, 系统语言前缀（越具体越前）
        {"zh-Hant", "zh-tw", "zh-hk", "zh-mo", "zh-hant"},
        {"zh", "zh"}, {"en", "en"}, {"fr", "fr"}, {"es", "es"}, {"ru", "ru"}, {"ar", "ar"}, {"ja", "ja"}, {"ko", "ko"}, {"id", "id", "in"},
    };
    private static Context ctx;
    private static String lang;
    private static Map<String, String> dict, en;

    static synchronized void init(Context c) {
        if (ctx == null) ctx = c.getApplicationContext();
    }

    /** 界面报来的语言；变了就换词典 */
    static synchronized void set(String code) {
        if (ctx == null || code == null || !known(code)) return;
        ctx.getSharedPreferences("ui", Context.MODE_PRIVATE).edit().putString("lang", code).apply();
        if (!code.equals(lang)) { lang = null; dict = null; }
    }

    static synchronized String lang() {
        if (lang != null) return lang;
        String s = ctx == null ? null : ctx.getSharedPreferences("ui", Context.MODE_PRIVATE).getString("lang", null);
        lang = s != null && known(s) ? s : system();
        return lang;
    }

    private static boolean known(String code) {
        for (String[] l : LANGS) if (l[0].equals(code)) return true;
        return false;
    }

    private static String system() {
        Locale l = Locale.getDefault();
        String tag = l.toLanguageTag().toLowerCase(Locale.ROOT);
        // zh-Hant-TW 这种带文字的写法，以及只给了地区（zh-TW）的，都要配到繁体
        if (tag.startsWith("zh") && ("hant".equalsIgnoreCase(l.getScript()) || tag.matches("zh-(tw|hk|mo)(-.*)?"))) return "zh-Hant";
        String best = null; int bestLen = -1;
        for (String[] e : LANGS)
            for (int i = 1; i < e.length; i++)
                if ((tag.equals(e[i]) || tag.startsWith(e[i] + "-")) && e[i].length() > bestLen) { best = e[0]; bestLen = e[i].length(); }
        return best != null ? best : "en";
    }

    private static Map<String, String> load(String code) {
        Map<String, String> m = new HashMap<>();
        if (ctx == null || "zh".equals(code)) return m;
        try (InputStream in = ctx.getAssets().open("i18n/java-" + code + ".json")) {
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            byte[] b = new byte[16384];
            for (int n; (n = in.read(b)) > 0; ) bo.write(b, 0, n);
            JSONObject o = new JSONObject(new String(bo.toByteArray(), StandardCharsets.UTF_8));
            for (java.util.Iterator<String> it = o.keys(); it.hasNext(); ) { String k = it.next(); m.put(k, o.getString(k)); }
        } catch (Exception ignored) {}
        return m;
    }

    static synchronized String t(String zh) {
        String code = lang();
        if ("zh".equals(code)) return zh;
        if (dict == null) dict = load(code);
        String s = dict.get(zh);
        if (s == null && !"en".equals(code)) {
            if (en == null) en = load("en");
            s = en.get(zh);
        }
        return s != null ? s : zh;
    }

    static String f(String zh, Object... a) {
        String s = t(zh);
        for (int i = 0; i < a.length; i++) s = s.replace("{" + i + "}", String.valueOf(a[i]));
        return s;
    }
}
