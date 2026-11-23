package cc.codroid;

/** DeviceTools URL 严格校验回归（openUrl 与 device.open kind=url 共用 safeHttpUri / isSafeHttpUrl） */
public final class DeviceToolsUrlTest {
    private static int n;
    private static void check(boolean want, String url) {
        n++;
        boolean got = DeviceTools.isSafeHttpUrl(url);
        if (got != want) throw new AssertionError("isSafeHttpUrl(" + url + ")=" + got + ", want " + want);
    }
    public static void main(String[] args) {
        // 合法 http / https
        check(true, "https://example.com");
        check(true, "http://127.0.0.1:8791/path?a=1#frag");
        check(true, "HTTPS://docs.github.com/en/actions");
        check(true, "http://[::1]:8080/test");
        check(true, "https://example.com/a@b?email=u@d.com"); // @ 在路径/查询中合法

        // 非法协议与空值
        check(false, null);
        check(false, "");
        check(false, "javascript:alert(1)");
        check(false, "file:///etc/passwd");
        check(false, "intent://scan/#Intent;end");

        // 凭据伪装（user@host）与反斜杠混淆
        check(false, "https://good.com@evil.com/login");
        check(false, "https://user:pass@evil.com/");
        check(false, "https://good.com\\@evil.com/");

        // 控制字符与空白
        check(false, "https://example.com/\nfoo");
        check(false, "https://example.com/\r\n");
        check(false, "https://example.com/a b");
        check(false, "https://example.com/\u0000");
        check(false, "https://example.com/\u007f");
        check(false, " https://example.com");

        // 空主机 / 点主机 / 畸形端口
        check(false, "https://");
        check(false, "https:///path");
        check(false, "http://.");
        check(false, "http://:8080/");
        check(false, "http://example.com:/");
        check(false, "http://example.com:abc/");
        check(false, "http://example.com:0/");
        check(false, "http://example.com:70000/");
        check(false, "http://[]/");
        check(false, "http://[::1]:/");
        check(false, "http://[::1]:abc/");
        check(false, "http://[::1]:99999/");
        check(false, "https://good.com%40evil.com/");

        System.out.println("DeviceToolsUrlTest OK (" + n + " cases)");
    }
}
