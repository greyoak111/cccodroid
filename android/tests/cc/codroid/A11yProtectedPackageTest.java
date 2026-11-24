package cc.codroid;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;

/**
 * 隐私与合规加固回归（Java 侧）：
 *   1. A11y.isProtectedPackage 硬隔离支付、网银、2FA 动态口令、密码管理器与系统权限授权界面；
 *   2. Installer.ghProxyEnabled 默认关闭（false），仅在 files/.gh-proxy 普通文件存在时为 true。
 */
public final class A11yProtectedPackageTest {
    private static int n;

    private static void checkPkg(boolean want, String pkg) {
        n++;
        boolean got = A11y.isProtectedPackage(pkg);
        if (got != want) throw new AssertionError("isProtectedPackage(" + pkg + ")=" + got + ", want " + want);
    }

    private static void checkBool(String what, boolean want, boolean got) {
        n++;
        if (got != want) throw new AssertionError(what + ": got " + got + ", want " + want);
    }

    public static void main(String[] args) throws Exception {
        // 受保护的高敏包必须硬拦截
        checkPkg(true, "com.eg.android.AlipayGphone");
        checkPkg(true, "com.unionpay");
        checkPkg(true, "com.icbc");
        checkPkg(true, "cmb.pb");
        checkPkg(true, "com.chinamworld.main");
        checkPkg(true, "com.google.android.apps.authenticator2");
        checkPkg(true, "com.beemdevelopment.aegis");
        checkPkg(true, "com.twofasapp");
        checkPkg(true, "com.x8bit.bitwarden");
        checkPkg(true, "com.agilebits.onepassword");
        checkPkg(true, "keepass2android.keepass2android");
        checkPkg(true, "keepass2android.keepass2android_nonet");
        checkPkg(true, "com.android.permissioncontroller");
        checkPkg(true, "com.google.android.permissioncontroller");
        checkPkg(true, "com.android.credentialmanager");

        // 普通应用与空值不误伤
        checkPkg(false, null);
        checkPkg(false, "");
        checkPkg(false, "cc.codroid");
        checkPkg(false, "ha.chi.mia");
        checkPkg(false, "cox.dragon");
        checkPkg(false, "com.android.chrome");
        checkPkg(false, "org.mozilla.firefox");
        checkPkg(false, "com.android.settings");

        // gh-proxy 默认关闭，仅普通文件 .gh-proxy 打开
        Path tmp = Files.createTempDirectory("ccapp-ghproxy-test-");
        try {
            File files = tmp.toFile();
            checkBool("null files default false", false, Installer.ghProxyEnabled(null));
            checkBool("missing .gh-proxy default false", false, Installer.ghProxyEnabled(files));

            File flagDir = new File(files, ".gh-proxy");
            flagDir.mkdir();
            checkBool("directory .gh-proxy must be false", false, Installer.ghProxyEnabled(files));
            flagDir.delete();

            Files.write(flagDir.toPath(), "1\n".getBytes(StandardCharsets.UTF_8));
            checkBool("file .gh-proxy turns on fallback", true, Installer.ghProxyEnabled(files));

            flagDir.delete();
            checkBool("deleting .gh-proxy turns off fallback", false, Installer.ghProxyEnabled(files));

            checkBool("ghProxy rewrites github.com", true,
                "https://gh-proxy.com/github.com/a/b/releases/download/v1/x.apk".equals(
                    Installer.ghProxy("https://github.com/a/b/releases/download/v1/x.apk")));
            checkBool("ghProxy ignores non-github host", true,
                Installer.ghProxy("https://dl.cccodroid.net/x.apk") == null);
        } finally {
            try (java.util.stream.Stream<Path> s = Files.walk(tmp)) {
                s.sorted(Comparator.reverseOrder()).forEach((p) -> { try { Files.delete(p); } catch (Exception ignored) {} });
            }
        }
        System.out.println("A11yProtectedPackageTest OK (" + n + " cases)");
    }
}
