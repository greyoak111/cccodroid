package cc.codroid;

import java.util.Arrays;
import java.util.List;

/** 更新说明挑版本（WhatsNew.pick）：开发版不能落后一版（11-09）。用安卓桩跑，pick 不碰安卓接口 */
public class WhatsNewPickTest {
    static final String[] FILES = {"v0.6.10.zh.md", "v0.6.10.en.md", "v0.6.11.zh.md", "v0.6.11.en.md", "v0.6.12.zh.md", "v0.6.12.en.md", "readme.txt"};
    static int fail = 0;
    static void eq(String what, List<String> got, String... want) {
        boolean ok = got != null && got.equals(Arrays.asList(want));
        if (!ok) fail++;
        System.out.println((ok ? "✓ " : "✗ ") + what + " → " + got);
    }
    public static void main(String[] a) {
        eq("开发版 0.6.11-dev.1 → 0.6.12-dev.1：弹 0.6.12", WhatsNew.pick(FILES, "0.6.12-dev.1", "0.6.11-dev.1", false), "0.6.12");
        eq("开发版同一版的 dev.1 → dev.2：不再弹", WhatsNew.pick(FILES, "0.6.12-dev.2", "0.6.12-dev.1", false));
        eq("正式版 0.6.11 → 0.6.12", WhatsNew.pick(FILES, "0.6.12", "0.6.11", false), "0.6.12");
        eq("跳了两版：新的在前", WhatsNew.pick(FILES, "0.6.12", "0.6.10", false), "0.6.12", "0.6.11");
        eq("从没记过的旧版升上来：只弹当前版", WhatsNew.pick(FILES, "0.6.12-dev.1", null, false), "0.6.12");
        eq("全新安装：不弹", WhatsNew.pick(FILES, "0.6.12-dev.1", null, true) == null ? Arrays.asList("null") : Arrays.asList("x"), "null");
        eq("开发版装上正式版同号：不重弹", WhatsNew.pick(FILES, "0.6.12", "0.6.12-dev.1", false));
        if (fail > 0) { System.out.println(fail + " 条失败"); System.exit(1); }
    }
}
