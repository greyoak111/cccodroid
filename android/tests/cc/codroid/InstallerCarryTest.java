package cc.codroid;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;

/**
 * 工具包重装时组件文件的归属（调查 05：重装丢组件）。
 *
 * 回归的是 0.6.11「同一版工具包重装保住组件」漏掉的那条路径：组件经 dpkg 装进来的包，
 * 包清单 var/lib/dpkg/info/<包>.list 会被 carryOver 当成旧工具包的东西，清单里的文件跟着旧 usr 一起删 ——
 * 组件记录却还认这一版是装好的。同一版重装时，组件 MANIFEST / 记录认领的那份 .list 必须跳过。
 *
 * 只造 MANIFEST（不造 files/components/*.json），所以运行时不碰 org.json；用 android.jar 的桩编译即可。
 */
public class InstallerCarryTest {
    static int fail = 0;
    static void check(String what, boolean ok) { if (!ok) fail++; System.out.println((ok ? "✓ " : "✗ ") + what); }

    static void put(File root, String rel, String text) throws Exception {
        File f = new File(root, rel);
        f.getParentFile().mkdirs();
        Files.write(f.toPath(), text.getBytes(StandardCharsets.UTF_8));
    }

    static final Installer.Progress QUIET = new Installer.Progress() {
        public void step(String m) {}
        public void bytes(long done, long total) {}
    };

    /** 造一套「组件经 pkg 装了一个包」的旧 usr：清单里有组件的文件，也有一条底座包自己的清单 */
    static void componentOld(File old) throws Exception {
        put(old, "var/lib/dpkg/info/comp.list",
            "/data/data/cc.codroid/files/usr\n/data/data/cc.codroid/files/usr/bin\n"
            + "/data/data/cc.codroid/files/usr/bin/comp-tool\n/data/data/cc.codroid/files/usr/share/comp/data\n");
        put(old, "bin/comp-tool", "tool");
        put(old, "share/comp/data", "data");
        put(old, "libexec/devkit/components/comp/MANIFEST",
            "x 4 bin/comp-tool\nx 4 share/comp/data\nx 64 var/lib/dpkg/info/comp.list\n");
        put(old, "var/lib/dpkg/info/base.list", "/data/data/cc.codroid/files/usr/bin/base-tool\n");
        put(old, "bin/base-tool", "base");
    }

    public static void main(String[] args) throws Exception {
        Path tmp = Files.createTempDirectory("cccodroid-carry-test-");
        try {
            File files = new File(tmp.toFile(), "files");
            new File(files, "components").mkdirs();

            File old1 = new File(files, "usr.old"), neu1 = new File(files, "usr");
            old1.mkdirs(); neu1.mkdirs();
            componentOld(old1);
            Installer.carryOver(old1, neu1, files, true, "sha-same", QUIET);
            check("同一版重装：组件自己的程序跟着搬（它的 dpkg 清单不能算底座）", new File(neu1, "bin/comp-tool").isFile());
            check("同一版重装：组件的包数据跟着搬", new File(neu1, "share/comp/data").isFile());
            check("同一版重装：组件清单本身跟着搬", new File(neu1, "var/lib/dpkg/info/comp.list").isFile());
            check("同一版重装：真正的底座包文件不搬（新工具包自己带）", !new File(neu1, "bin/base-tool").exists());

            File old2 = new File(files, "usr2.old"), neu2 = new File(files, "usr2");
            old2.mkdirs(); neu2.mkdirs();
            componentOld(old2);
            Installer.carryOver(old2, neu2, files, false, "", QUIET);
            check("换版本：组件文件不搬（旧工具包上的）", !new File(neu2, "bin/comp-tool").exists());
            check("换版本：底座文件也不搬", !new File(neu2, "bin/base-tool").exists());
        } finally {
            try (java.util.stream.Stream<Path> s = Files.walk(tmp)) {
                s.sorted(Comparator.reverseOrder()).forEach((p) -> { try { Files.delete(p); } catch (Exception ignored) {} });
            }
        }
        System.out.println(fail == 0 ? "ALL PASS" : (fail + " FAILED"));
        if (fail != 0) System.exit(1);
    }
}
