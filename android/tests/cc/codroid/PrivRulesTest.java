package cc.codroid;

/** PrivRules 回归：哪些特权命令要用户点头。sh scripts/java-tests.sh 跑 */
public final class PrivRulesTest {
    static int fail = 0;
    static void want(boolean expect, String... argv) {
        boolean got = PrivRules.risky(argv);
        if (got != expect) { fail++; System.out.println("FAIL " + (expect ? "应当要问" : "不该问") + "：" + String.join(" ", argv)); }
    }
    static void sh(boolean expect, String cmd) { want(expect, "/system/bin/sh", "-c", cmd); }

    static void self(boolean expect, String cmd) {
        if (PrivRules.touchesSelf(cmd, "cc.codroid") != expect) { fail++; System.out.println("FAIL " + (expect ? "应当算动到自己" : "不该算动到自己") + "：" + cmd); }
    }

    static void names(boolean expect, String cmd) {
        if (PrivRules.namesSelf(cmd, "cc.codroid") != expect) { fail++; System.out.println("FAIL namesSelf " + expect + "：" + cmd); }
    }

    public static void main(String[] a) {
        // 11-04 报告 A3：am start 成功也有输出
        if (!PrivRules.amStarted(0, "Starting: Intent { cmp=cc.codroid/.MainActivity }")) { fail++; System.out.println("FAIL amStarted 成功输出"); }
        if (!PrivRules.amStarted(0, "Warning: Activity not started, its current task has been brought to the front")) { fail++; System.out.println("FAIL amStarted 已在前台"); }
        if (PrivRules.amStarted(0, "Error: Activity class {cc.codroid/x} does not exist.")) { fail++; System.out.println("FAIL amStarted 报错退 0"); }
        if (PrivRules.amStarted(1, "Starting: Intent")) { fail++; System.out.println("FAIL amStarted 退出码非 0"); }
        if (PrivRules.amStarted(-1, "java.lang.SecurityException")) { fail++; System.out.println("FAIL amStarted 起不来"); }
        // 0601c：免问命令点了本应用 / Shizuku 的名也要问
        names(true, "am force-stop cc.codroid");
        names(true, "am stop-app 'cc.codro''id'");
        names(true, "am force-stop moe.shizuku.privileged.api");
        names(false, "am force-stop com.foo");
        names(false, "dumpsys meminfo | grep -E '^ +[0-9]'");
        // 免确认下也要问的：动到本应用、Shizuku / Sui，或写法看不清（审查 0601 中-3、0601b 引号拆词）
        self(true, "pm uninstall cc.codroid");
        self(true, "pm uninstall cc.codro\"i\"d");
        self(true, "am force-stop moe.shizuku.privileged.api");
        self(true, "rm -rf /data/adb/modules");
        self(true, "echo Y2MuY29kcm9pZA== | base64 -d | xargs pm uninstall");
        self(true, "echo Y2MuY29kcm9pZA== | ba''se64 -d | xargs pm uninstall");
        self(true, "echo Y2MuY29kcm9pZA== | ba\"\"se64 -d | x''args pm uninstall");
        self(true, "echo pm uninstall cc.xodroid | sed s/x/c/ | sh");
        self(true, "pm uninstall $P");
        self(true, "pm uninstall cc.codr*");
        self(true, "ev''al pm uninstall");
        // 0601c：sed 转写 / awk 拼接 / . 从管道读
        self(true, "echo abcdefghij | sed 'y/abcdefghij/pm unistl/' | . /dev/stdin");
        self(true, "awk 'BEGIN { cmd = \"pm uninstall cc\" \".codroid\"; cmd | getline }'");
        self(true, "echo x; . /sdcard/x");
        self(true, "cat /dev/fd/0");
        self(true, "echo x | { . /proc/self/fd/0; }");
        self(true, "if :; then . /sdcard/x; fi");
        self(true, "{ :; }. /sdcard/x");
        self(true, "echo x | mksh");
        self(false, "ls . | wc -l");
        self(false, "pm uninstall com.example.app");
        self(false, "settings put global window_animation_scale 0.5");
        self(false, "dumpsys shortcut | grep -c ShortcutInfo");
        self(false, "am force-stop com.foo; ssh-keygen -h");

        // 查看类：直接跑（含 cc-mem、网关自己用的）
        sh(false, "pm list packages");
        sh(false, "pm list packages --uid 10123; pm list packages --uid 10124");
        sh(false, "dumpsys meminfo");
        sh(false, "echo @WEBVIEW; dumpsys webviewupdate | grep -oE 'Current WebView package \\(name, version\\): \\([^,]+'");
        sh(false, "{ echo @LRU; dumpsys activity lru; echo @PROC; dumpsys activity processes | grep -E '^ +\\*[A-Z]+\\* |packageList=' \n} 2>&1");
        sh(false, "echo @HOME; cmd package resolve-activity --brief -c android.intent.category.HOME -a android.intent.action.MAIN | tail -1");
        sh(false, "settings get secure default_input_method");
        sh(false, "am force-stop 'com.example.app'; am stop-app 'com.foo.bar'");
        sh(false, "am set-bg-restriction-level 'com.foo' restricted");
        sh(false, "dumpsys batterystats --checkin");
        sh(false, "id -u");
        sh(false, "pm path com.foo");
        want(false, "/system/bin/dumpsys", "battery");
        sh(false, "dumpsys battery 2>/dev/null >/dev/null");
        sh(false, "getprop ro.build.version.sdk");
        // 白名单以外的一律要问（10-31 二次复核：按命令长相猜危险防不住控制 argv 的一方）
        sh(true, "screencap -p /sdcard/x.png");
        sh(true, "input tap 100 200");
        sh(true, "am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file:///sdcard/Movies/a.mp4");
        want(true, "/data/user/0/cc.codroid/files/home/x.sh");
        want(true, "x.sh");
        want(true, "/sdcard/dumpsys");
        want(true, "sh", "-c", "$0 install x", "pm", "/sdcard/evil.apk");
        want(true, "sh", "-c", "dumpsys", "pm");
        sh(true, "svc power reboot");
        sh(true, "pm set-permission-enforced android.permission.X true");
        sh(true, "pm move-package com.x internal");
        sh(true, "am start-foreground-service -n com.x/.S");
        sh(true, "am start-service -n com.x/.S");
        sh(true, "am start -a android.intent.action.CALL -d tel:10086");
        // v0514 审查低-1：打开界面、写共享存储、读 Wi-Fi / 使用记录都要问
        sh(true, "am start --activity-reorder-to-front -n li.dsh.claudecli/.MainActivity");
        sh(true, "am start -a android.intent.action.VIEW -d https://example.com");
        sh(true, "am start-activity -n com.x/.A");
        sh(true, "echo hi > /sdcard/a.txt");
        sh(true, "dumpsys battery >> /sdcard/cccodroid/b.txt");
        sh(true, "dumpsys wifi");
        sh(true, "dumpsys -t 5 usagestats");
        sh(true, "dumpsys bluetooth_manager");
        sh(true, "dumpsys deviceidle whitelist +com.evil");
        sh(true, "dumpsys battery set level 1");
        sh(true, "dumpsys batterystats --reset");
        sh(true, "cat /sdcard/Android/data/com.victim/files/token");
        sh(true, "cat /storage/emulated/0/ANDROID//Data/com.victim/x");
        sh(true, "ls /sdcard/Android/./obb");
        sh(true, "cat /sdcard/Download/../Android/data/x");
        sh(true, "cat /data/system/packages.xml");
        sh(true, "echo x > /data/local/tmp/x.sh");
        sh(true, "echo x > /sdcard/Android/media/x");
        sh(true, "echo x > rel.txt");
        sh(true, "cat <<EOF\npm install x\nEOF");
        sh(true, "LD_PRELOAD=/sdcard/x.so dumpsys");
        sh(true, "grep -r token /sdcard");
        sh(true, "ls -laR /sdcard");
        sh(true, "sort -o /sdcard/x /sdcard/y");
        sh(true, "logcat -f /sdcard/x");
        // 11-01 独立审查：裸 dumpsys、全机日志、读共享存储
        sh(true, "dumpsys");
        sh(true, "dumpsys 2>/dev/null");
        sh(true, "logcat -d -t 200 | grep cccodroid");
        want(true, "/system/bin/logcat", "-d");
        sh(true, "cat /sdcard/DCIM/a.jpg");
        sh(true, "head -c 100 /storage/emulated/0/Download/x");
        sh(true, "grep -f/sdcard/pat /proc/version");
        sh(true, "tail /storage/1234-5678/x");
        sh(true, "wc -l /mnt/user/0/emulated/0/x");
        sh(true, "cat sdcard/x");
        sh(true, "dumpsys -t 10");
        sh(true, "dumpsys --proto");
        sh(true, "dumpsys --priority NORMAL");
        sh(true, "dumpsys --skip meminfo");
        sh(false, "dumpsys -t 10 meminfo");
        sh(true, "grep -fsdcard/pat /system/build.prop");
        sh(true, "grep -e x sdcard/a.txt");
        sh(false, "ls /sdcard/Download");
        sh(false, "dumpsys meminfo | grep -i total");
        sh(true, "settings --user 0 get secure x");
        sh(true, "cmd package install x");
        sh(true, "cmd activity start x");
        sh(true, "wm size 1x1");
        sh(true, "tee /sdcard/x");
        sh(true, "find /sdcard -exec rm {} ;");
        sh(true, "echo a | sh");
        sh(true, "dumpsys meminfo | sed -n '/x/,/^$/p'");
        sh(true, "echo 'unterminated");
        // 第二轮复核：查看面收窄
        sh(true, "cat /dev/input/event3");
        sh(true, "head -c 10000 /dev/input/event3");
        sh(true, "cat dev/input/event3");
        sh(true, "grep --file=/dev/input/event3 x /sdcard/a");
        sh(true, "cat //data/tombstones/tombstone_00");
        sh(true, "cat /./data/local/tmp/x");
        sh(true, "cat /sdcard/Android/media/com.victim/x.jpg");
        sh(true, "ls //sdcard//Android//media");
        sh(true, "cat /proc/1/cmdline");
        sh(true, "cat /bugreports/x.zip");
        sh(true, "logcat -c");
        sh(true, "logcat --clear");
        sh(true, "am kill com.victim");
        sh(true, "am stack move-task 1 2 true");
        sh(true, "dumpsys deviceidle deep");
        sh(true, "dumpsys jobscheduler run -f com.x 1");
        sh(true, "dumpsys deviceidle temp-whitelist com.x");
        sh(true, "dumpsys notification --noredact");
        // 三轮复核：工作目录 + 相对路径、ps/top 交出全机命令行
        for (String cwd : new String[]{"/sdcard/Android", "/storage/emulated/0/Android/", "/sdcard//android/.", "/sdcard/Android/media"})
            if (PrivRules.risky(new String[]{"/system/bin/sh", "-c", "cat obb/com.victim/main.pak"}, false, cwd) != true) { fail++; System.out.println("FAIL 工作目录 " + cwd + " 应当要问"); }
        if (PrivRules.risky(new String[]{"/system/bin/sh", "-c", "cat ../Android/obb/x"}, false, "/sdcard/Download") != true) { fail++; System.out.println("FAIL ../ 应当要问"); }
        if (PrivRules.risky(new String[]{"/system/bin/sh", "-c", "cat Android/obb/x"}, false, "/sdcard") != true) { fail++; System.out.println("FAIL 相对 Android/obb 应当要问"); }
        if (PrivRules.risky(new String[]{"/system/bin/sh", "-c", "cat dev/input/event3"}, false, "/") != true) { fail++; System.out.println("FAIL 根目录下相对 dev/ 应当要问"); }
        if (PrivRules.risky(new String[]{"/system/bin/sh", "-c", "cat notes/a.txt"}, false, "/sdcard/Documents") != true) { fail++; System.out.println("FAIL 共享存储里读文件应当要问"); }
        if (PrivRules.risky(new String[]{"/system/bin/sh", "-c", "grep token a.txt"}, false, "/sdcard/Documents") != true) { fail++; System.out.println("FAIL 共享存储里 grep 应当要问"); }
        // cc-mem 在共享存储里的工作目录下跑：管道里的 grep / tail / sort 没有文件参数，不该问（DeepSeek 复核中-1）
        for (String c : new String[]{"echo @LRU; dumpsys activity lru; echo @PROC; dumpsys activity processes | grep -E '^ +\\*[A-Z]+\\* |packageList='",
                "cmd package resolve-activity --brief -c android.intent.category.HOME -a android.intent.action.MAIN | tail -1", "pm list packages | sort -u", "dumpsys meminfo | head -n 20 | cut -d : -f 1"})
            if (PrivRules.risky(new String[]{"/system/bin/sh", "-c", c}, false, "/sdcard/DeepSeekHarness") != false) { fail++; System.out.println("FAIL 共享存储工作目录下的管道不该问：" + c); }
        for (String c : new String[]{"tail -n 5 log.txt", "head -n5 a", "sort -k 2 x.csv", "grep -e x a.txt", "wc -l a.txt"})
            if (PrivRules.risky(new String[]{"/system/bin/sh", "-c", c}, false, "/sdcard/DeepSeekHarness") != true) { fail++; System.out.println("FAIL 共享存储工作目录下读文件应当要问：" + c); }
        if (PrivRules.risky(new String[]{"/system/bin/sh", "-c", "dumpsys meminfo"}, false, "/sdcard/Documents") != false) { fail++; System.out.println("FAIL 共享存储里 dumpsys 不该问"); }
        sh(true, "ps -A -o ARGS");
        sh(true, "dumpsys location");
        sh(true, "dumpsys account");
        sh(true, "dumpsys Accessibility");
        sh(true, "dumpsys -t 10 clipboard");
        sh(true, "dumpsys --proto account");
        sh(true, "dumpsys -T 5000 --priority NORMAL location");
        sh(true, "top -b -n 1");
        sh(false, "grep dev /system/build.prop"); sh(true, "grep dev /sdcard/a.txt");
        sh(false, "settings get global data_roaming");
        sh(false, "cat /system/build.prop");
        sh(false, "dumpsys activity processes 2>/dev/null");
        if (PrivRules.risky(new String[]{"dumpsys"}, true, null) != true) { fail++; System.out.println("FAIL 带环境变量的请求应当要问"); }
        if (PrivRules.risky(new String[]{"cat", "x"}, false, "/sdcard/Android/data/com.v") != true) { fail++; System.out.println("FAIL 工作目录在 Android/data 应当要问"); }
        if (PrivRules.risky(new String[]{"ls", "x"}, false, "/sdcard/Download") != false) { fail++; System.out.println("FAIL 工作目录在共享存储 ls 不该问"); }
        if (PrivRules.risky(new String[]{"cat", "x"}, false, "/sdcard/Download") != true) { fail++; System.out.println("FAIL 工作目录在共享存储 cat 应当要问"); }
        // 要问：装卸应用、改权限、改系统设置
        sh(true, "pm install /sdcard/evil.apk");
        sh(true, "pm install-create -S 123");
        sh(true, "cmd package install -r /data/local/tmp/x.apk");
        sh(true, "pm grant com.evil android.permission.RECORD_AUDIO");
        sh(true, "pm uninstall com.victim");
        sh(true, "pm disable-user com.victim");
        sh(true, "appops set com.evil SYSTEM_ALERT_WINDOW allow");
        sh(true, "cmd appops set com.evil RUN_IN_BACKGROUND allow");
        sh(true, "device_config put activity_manager max_phantom_processes 2147483647");
        sh(true, "settings put secure enabled_accessibility_services com.evil/.A");
        sh(true, "settings put global adb_enabled 1");
        sh(true, "cmd role add-role-holder android.app.role.SMS com.evil");
        sh(true, "dpm set-device-owner com.evil/.Admin");
        sh(true, "setprop persist.sys.x 1");
        sh(true, "service call phone 1");
        sh(true, "content insert --uri content://settings/secure --bind name:s:x --bind value:s:y");
        sh(true, "am instrument -w com.evil/.Runner");
        sh(true, "am broadcast -a android.intent.action.BOOT_COMPLETED -n cc.codroid/.SysEvents");
        sh(true, "echo hi; pm install x.apk");
        sh(true, "true && pm grant a b");
        sh(true, "(pm uninstall x)");
        want(true, "pm", "install", "/sdcard/x.apk");
        // 要问：藏起来的写法
        sh(true, "sh /sdcard/x.sh");
        sh(true, "eval \"$(cat /sdcard/x)\"");
        sh(true, "$(echo cG0K | base64 -d) install x");
        sh(true, "`echo pm` install x");
        sh(true, "echo cG0gaW5zdGFsbA== | base64 -d | sh");
        sh(true, "p=pm; $p install x");
        // 拆字、绝对路径、展开、选项夹在中间（10-31 复核补）
        sh(true, "'pm' install x");
        sh(true, "\"pm\" install x");
        sh(true, "p''m install x");
        sh(true, "p\\m install x");
        sh(true, "p\\\nm install x");
        sh(true, "/system/bin/pm install x");
        sh(true, "/system/bin/cmd package install x");
        sh(true, "{pm,install,x}");
        sh(true, "/system/bin/p? install x");
        sh(true, "/system/bin/p[m] install x");
        sh(true, "/s*/bin/pm list packages");
        sh(true, "cmd package --user 0 uninstall com.victim");
        sh(true, "pm -w uninstall x");
        sh(true, "settings --user 0 put secure x y");
        sh(true, "cmd appops --user 0 set com.evil X allow");
        sh(true, "am --user 0 instrument -w x/.R");
        sh(true, "content --user 0 insert --uri content://settings/secure");
        sh(true, "'settings' put global adb_enabled 1");
        want(true, "/system/bin/pm", "install", "x");
        want(true, "/system/bin/sh", "/sdcard/x.sh");
        // 引号里的通配、普通的花括号命令组不算
        sh(true, "logcat -d | grep 'cc.codroid*'");
        sh(false, "{ echo a; echo b; }");
        sh(false, "pm list packages | grep install");
        sh(true, "printf '\\160\\155' > /x");
        sh(true, ". /sdcard/x.sh");
        sh(true, "source /sdcard/x.sh");
        sh(true, "xargs pm < /sdcard/x");
        sh(true, "env pm install x");
        want(true, "/system/bin/sh");
        want(true, "sh", "/sdcard/x.sh");
        want(true, "toybox", "sh", "-c", "pm install x");
        want(true, "env", "X=1", "pm", "install", "x");
        want(true, "python3", "-c", "import os");
        // 11-03 L-17：sort 起外部程序 / 改临时目录
        sh(true, "sort --compress-program=toybox x");
        sh(true, "sort --comp=toybox x");
        sh(true, "sort -T /data/local/tmp /x");
        sh(true, "sort --temporary-directory=/x /y");
        sh(false, "pm list packages | sort -r");
        // 11-03 H-2：同意的签名只认本机生成、每次验证的钥匙（KeyProperties.ORIGIN_GENERATED=1，IMPORTED=2）
        if (!PrivRules.consentKeyOk(1, true, 0)) { fail++; System.out.println("FAIL consentKeyOk 每次验证 0"); }
        if (!PrivRules.consentKeyOk(1, true, -1)) { fail++; System.out.println("FAIL consentKeyOk 每次验证 -1"); }
        if (PrivRules.consentKeyOk(2, true, 0)) { fail++; System.out.println("FAIL consentKeyOk 导入的钥匙"); }
        if (PrivRules.consentKeyOk(1, false, 0)) { fail++; System.out.println("FAIL consentKeyOk 不要求验证"); }
        if (PrivRules.consentKeyOk(1, true, 30)) { fail++; System.out.println("FAIL consentKeyOk 解锁后 30 秒内可用"); }
        if (fail > 0) { System.out.println(fail + " 条不对"); System.exit(1); }
        System.out.println("PrivRules 全过");
    }
}
