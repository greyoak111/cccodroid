package cc.codroid;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * 哪些特权命令可以不问就跑（见 Priv.ask，审查 v0513b 中-3）。纯逻辑，不碰安卓；测试 android/tests/cc/codroid/PrivRulesTest.java。
 *
 * 发请求的可能是混进工具链的脚本，它完全控制 argv。所以不去猜「哪些命令危险」（总有没列到的写法：shebang 脚本、$0、
 * 没列的子命令…），反过来：只有能逐词认清、每条都在下面查看类白名单里的命令免问，其余一律要用户点头。
 * 认不清的写法（变量、命令替换、通配、转义、子 shell、here-doc、带环境变量、自定路径的程序）都算认不清。
 */
final class PrivRules {
    private PrivRules() {}

    /** 不能免问就返回 true。env：请求自带了环境变量；cwd：请求的工作目录 */
    static boolean risky(String[] argv) { return risky(argv, false, null); }

    static boolean risky(String[] argv, boolean env, String cwd) {
        if (argv == null || argv.length == 0 || env) return true;
        // 工作目录：根目录，或共享存储里 Android/ 以外的地方（10-31 三轮复核：cwd=/sdcard/Android 再用相对路径 obb/x 就绕过了参数检查）
        if (cwd != null && !cwd.equals("/") && !(sharedPath(norm(cwd)) && pathOk(cwd) && !inAndroid(cwd))) return true;
        String base = cwd == null ? "/" : cwd;
        try {
            List<List<String>> cmds;
            List<String> targets = new ArrayList<>();
            if (("/system/bin/sh".equals(argv[0]) || "sh".equals(argv[0])) && argv.length == 3 && "-c".equals(argv[1])) {
                cmds = parse(argv[2], targets);
            } else {
                String a0 = argv[0];
                if (a0.indexOf('/') >= 0) {
                    if (!a0.matches("/system/bin/[A-Za-z0-9_.-]+")) return true;
                    a0 = a0.substring(a0.lastIndexOf('/') + 1);
                }
                List<String> one = new ArrayList<>(Arrays.asList(argv));
                one.set(0, a0);
                cmds = new ArrayList<>();
                cmds.add(one);
            }
            if (cmds == null || cmds.isEmpty()) return true;
            for (String t : targets) if (!targetOk(t)) return true;
            for (List<String> c : cmds) if (!cmdOk(c, base)) return true;
            return false;
        } catch (RuntimeException e) { return true; }
    }

    // ── 分词：只认最朴素的 shell 写法，认不清就返回 null ──
    // 命令名位置的词另记为「带引号」（以 \0 开头标记），好拒绝 'pm' 这类拆字
    private static final String QMARK = "\0";

    static List<List<String>> parse(String s, List<String> targets) {
        List<List<String>> cmds = new ArrayList<>();
        List<String> cur = new ArrayList<>();
        StringBuilder w = null;
        boolean quoted = false, wantTarget = false;
        int n = s.length();
        for (int i = 0; i < n; i++) {
            char c = s.charAt(i);
            char nx = i + 1 < n ? s.charAt(i + 1) : '\0';
            if (c == ' ' || c == '\t' || c == '\n' || c == ';' || c == '|' || c == '&') {
                if (w != null) { if (wantTarget) { targets.add(w.toString()); wantTarget = false; } else cur.add((quoted ? QMARK : "") + w); w = null; quoted = false; }
                if (c == ' ' || c == '\t') continue;
                if (wantTarget) return null;
                if ((c == '|' || c == '&') && nx == c) i++;
                if (!cur.isEmpty()) { cmds.add(cur); cur = new ArrayList<>(); }
                continue;
            }
            if (c == '>' || c == '<') {
                if (wantTarget) return null;
                if (w != null) {   // 2>&1 的 2 是 fd 号；echo a>x 的 a 是普通的词
                    if (quoted || !w.toString().matches("\\d")) cur.add((quoted ? QMARK : "") + w);
                    w = null; quoted = false;
                }
                if (c == '<' && nx == '<') return null;          // here-doc
                if (c == '>' && nx == '>') { i++; nx = i + 1 < n ? s.charAt(i + 1) : '\0'; }
                if (nx == '&') {                                // 2>&1、>&2
                    i++;
                    if (i + 1 >= n || !Character.isDigit(s.charAt(i + 1))) return null;
                    while (i + 1 < n && Character.isDigit(s.charAt(i + 1))) i++;
                    continue;
                }
                if (nx == '|' || nx == '(') return null;
                wantTarget = true;
                continue;
            }
            if (c == '\'') {
                int e = s.indexOf('\'', i + 1);
                if (e < 0) return null;
                if (w == null) w = new StringBuilder();
                w.append(s, i + 1, e); quoted = true; i = e;
                continue;
            }
            if (c == '"') {
                int e = s.indexOf('"', i + 1);
                if (e < 0) return null;
                String in = s.substring(i + 1, e);
                if (in.indexOf('$') >= 0 || in.indexOf('`') >= 0 || in.indexOf('\\') >= 0) return null;
                if (w == null) w = new StringBuilder();
                w.append(in); quoted = true; i = e;
                continue;
            }
            if (c == '{' || c == '}') {
                // 只认独立的 { … } 命令组（cc-mem 用 { 命令\n} 2>&1 合流），{a,b} 展开一律认不清
                boolean alone = w == null && (nx == '\0' || nx == ' ' || nx == '\t' || nx == '\n' || nx == ';' || (c == '}' && (nx == '>' || nx == '|' || nx == '&')));
                if (!alone || wantTarget) return null;
                if (c == '{' && !cur.isEmpty()) return null;
                if (!cur.isEmpty()) { cmds.add(cur); cur = new ArrayList<>(); }
                continue;
            }
            if ("$`\\()*?[]~#!".indexOf(c) >= 0) return null;
            if (c < 0x20 || c == 0x7f) return null;
            if (w == null) w = new StringBuilder();
            w.append(c);
        }
        if (w != null) { if (wantTarget) { targets.add(w.toString()); wantTarget = false; } else cur.add((quoted ? QMARK : "") + w); }
        if (wantTarget) return null;
        if (!cur.isEmpty()) cmds.add(cur);
        return cmds;
    }

    // ── 白名单：查看类命令，以及 cc-mem 用到的停后台 ──
    // logcat 不在里面：shell 读得到全机所有应用的日志（不少应用把令牌、手机号打进日志），应用自己只读得到自己的（11-01 独立审查中-2）
    private static final Set<String> FREE = new HashSet<>(Arrays.asList(
        "dumpsys", "getprop", "id", "whoami", "uname", "uptime", "df", "nproc", "free", "getenforce",
        "ls", "cat", "head", "tail", "grep", "egrep", "wc", "stat", "echo", "printf", "sort", "uniq", "cut", "tr",
        "pm", "cmd", "am", "settings", "appops", "device_config", "wm", "true", "false"));
    private static final Set<String> PM_RO = new HashSet<>(Arrays.asList(
        "list", "path", "dump", "resolve-activity", "query-activities", "query-services", "query-receivers", "has-feature"));
    // am start 不在里面：能免问把浏览器弹到任意网址、拨号盘预填号码，拿来钓鱼（v0514 审查低-1）。
    // 停后台这几条留着：内存管家（cc-mem）要用，最坏是把别的应用停掉，不碰数据
    private static final Set<String> AM_OK = new HashSet<>(Arrays.asList(
        "force-stop", "stop-app", "compact", "get-current-user", "get-config",
        "get-bg-restriction-level", "set-bg-restriction-level", "get-standby-bucket"));
    // dumpsys 后面的参数里出现这些词，多半是在改状态或交出平时脱敏的内容
    // （dumpsys battery set、deviceidle whitelist +x / deep、jobscheduler run、notification --noredact…）
    private static final Pattern DUMP_ACT = Pattern.compile(
        "(?:set|unplug|reset|enable|disable|whitelist|tempwhitelist|temp|except-idle-whitelist|sys-whitelist|force|unforce|step"
        + "|deep|light|screen|charging|motion|run|trigger|schedule|cancel|send|post|toggle|noredact"
        + "|put|delete|clear|add|remove|kill|start|stop|suspend|unsuspend)(?:[-_].*)?|\\+.*", Pattern.CASE_INSENSITIVE);

    // 这些服务的输出本身就是隐私：账户、最近位置、剪贴板、通知内容、无障碍状态、短信与通话（10-31 三轮复核）
    private static final Set<String> DUMP_PRIVATE = new HashSet<>(Arrays.asList(
        "account", "location", "clipboard", "notification", "accessibility", "isms", "telecom", "telephony.registry", "phone", "contacts", "credential",
        // 已存的 Wi-Fi（能推出常去的地方）、各应用用了多久、配对过的蓝牙设备（v0514 审查低-1）
        "wifi", "wifiscanner", "usagestats", "bluetooth_manager"));

    static boolean cmdOk(List<String> c) { return cmdOk(c, "/"); }

    static boolean cmdOk(List<String> c, String base) {
        String name = c.get(0);
        if (name.startsWith(QMARK) || !name.matches("[A-Za-z0-9_.-]+") || !FREE.contains(name)) return false;
        List<String> a = new ArrayList<>();
        for (int i = 1; i < c.size(); i++) a.add(c.get(i).startsWith(QMARK) ? c.get(i).substring(1) : c.get(i));
        // 带斜杠的相对路径按工作目录拼出来再认一遍
        for (String x : a) if (!pathOk(x) || (!x.startsWith("/") && x.indexOf('/') >= 0 && !pathOk(base + "/" + x))) return false;
        // 读文件内容的命令碰共享存储要问：没给应用存储权限时 shell 照样读得到（11-01 独立审查中-2）。
        // 参数里哪儿写着共享存储的路径都算；再按各命令的选项认出真正的文件参数，相对路径按工作目录拼出来再认
        //（工作目录在共享存储里时 cat notes.txt 也是读那里；管道里的 grep 'x'、tail -1 没有文件参数，不问）
        if (READERS.contains(name)) {
            for (String x : a) if (shared(x)) return false;
            for (String f : fileArgs(name, a)) if (!f.equals("-") && !f.startsWith("/") && shared(base + "/" + f)) return false;
        }
        String sub = a.isEmpty() ? "" : a.get(0);
        switch (name) {
            case "pm": return PM_RO.contains(sub);
            case "cmd": return "package".equals(sub) && a.size() > 1 && PM_RO.contains(a.get(1));
            case "settings": case "device_config": return "get".equals(sub) || "list".equals(sub);
            case "appops": return "get".equals(sub) || "query-op".equals(sub);
            case "wm": return a.size() == 1 && ("size".equals(sub) || "density".equals(sub));
            case "am": return AM_OK.contains(sub);
            case "dumpsys": {
                // 不带服务名就是把全部服务（剪贴板、账户、Wi-Fi…）一起转出来：dumpsys、dumpsys -t 10、dumpsys --proto 都是；
                // --skip 是「除了这几个全转」（11-01 独立审查中-1 及 DeepSeek 复核）
                String svc = null;
                for (int i = 0; i < a.size() && svc == null; i++) {
                    String x = a.get(i);
                    if (x.equals("--skip")) return false;
                    if (x.equals("-t") || x.equals("-T") || x.equals("--priority")) { i++; continue; }
                    if (!x.startsWith("-")) svc = x;
                }
                if (svc == null) return false;
                // 服务名前面能夹选项（dumpsys -t 10 clipboard、--proto account）：哪个位置出现都算（10-31 四轮复核）
                for (String x : a) { String l = x.toLowerCase(Locale.ROOT); if (DUMP_PRIVATE.contains(l) || l.startsWith("wifi")) return false; }   // wifiaware / wifip2p 等同族
                for (int i = 1; i < a.size(); i++) if (DUMP_ACT.matcher(a.get(i).replaceFirst("^-+", "")).matches()) return false;
                return true;
            }
            case "grep": case "egrep":
                for (String x : a) if (x.matches("-[A-Za-z]*[rRd].*|--(recursive|dereference-recursive|directories).*")) return false;
                return true;
            case "ls":
                for (String x : a) if (x.matches("-[A-Za-z]*R.*|--recursive")) return false;
                return true;
            case "sort":
                for (String x : a) if (x.matches("-[A-Za-z]*o.*|--output.*")) return false;
                return true;
            case "uniq": {   // uniq 输入 输出：第二个文件名是写
                int files = 0;
                for (String x : a) if (!x.startsWith("-")) files++;
                return files <= 1;
            }
            default: return true;
        }
    }

    // 参数里的路径：shell 读得到应用自己读不到的东西 —— 共享存储里别的应用的 Android/data、obb、media，
    // 输入设备（/dev/input 就是全机按键记录）、/proc 里别的进程、/data 下的崩溃转储、bugreport …；还有 .. 绕出去。
    // 先把 // 和 /./ 收掉再认（//data、/./dev 内核照样认）。参数里夹着的路径（--file=/dev/x、-f/proc/x）也算
    private static final Pattern PRIVATE = Pattern.compile(
        "(?i)(?:^|/)android/+[^/]|(?:^|/)(?:dev|proc|sys|data|d|bugreports|cache|acct|config|debug_ramdisk|data_mirror)(?:/|$)|(?:^|/)\\.\\.(?:/|$)");

    static String norm(String x) {
        String n = x.replaceAll("/+", "/");
        for (String p; !(p = n.replace("/./", "/")).equals(n); ) n = p;
        if (n.length() > 1 && n.endsWith("/.")) n = n.substring(0, n.length() - 2);
        if (n.length() > 1 && n.endsWith("/")) n = n.substring(0, n.length() - 1);
        return n;
    }

    static boolean inAndroid(String x) { return norm(x).toLowerCase(Locale.ROOT).matches("/(sdcard|storage/emulated/0)/android(/.*)?"); }

    static boolean pathOk(String x) {
        String n = norm(x);
        if (n.equals("/dev/null")) return true;
        // 不带斜杠的单词（grep dev、settings get global data）不是路径
        if (n.indexOf('/') < 0) return !n.equals("..");
        return !PRIVATE.matcher(n).find();
    }

    private static final Set<String> READERS = new HashSet<>(Arrays.asList(
        "cat", "head", "tail", "grep", "egrep", "wc", "sort", "uniq", "cut"));
    // 带值的选项（toybox 的写法）：值紧跟在后面（-n5、-fpat）或是下一个词；FILE_OPT 里的值是文件
    private static final java.util.Map<String, String> VAL_OPT = new java.util.HashMap<>();
    private static final java.util.Map<String, String> FILE_OPT = new java.util.HashMap<>();
    static {
        VAL_OPT.put("grep", "efmABCSMdD"); FILE_OPT.put("grep", "f"); VAL_OPT.put("egrep", "efmABCSMdD"); FILE_OPT.put("egrep", "f");
        VAL_OPT.put("head", "nc"); VAL_OPT.put("tail", "ncs"); VAL_OPT.put("cut", "bcfFCOd");
        VAL_OPT.put("sort", "kto"); FILE_OPT.put("sort", "o"); VAL_OPT.put("uniq", "fsw");
    }

    /** 认出命令要读的文件参数（grep 第一个位置参数是模式，除非给了 -e / -f）。长选项 --x=值 的值一律当文件看 */
    static List<String> fileArgs(String name, List<String> a) {
        String val = VAL_OPT.getOrDefault(name, ""), file = FILE_OPT.getOrDefault(name, "");
        List<String> files = new ArrayList<>(), pos = new ArrayList<>();
        boolean pat = false, rest = false;
        for (int i = 0; i < a.size(); i++) {
            String x = a.get(i);
            if (rest || x.equals("-") || !x.startsWith("-")) { pos.add(x); continue; }
            if (x.equals("--")) { rest = true; continue; }
            if (x.startsWith("--")) {
                int eq = x.indexOf('=');
                if (eq > 0) files.add(x.substring(eq + 1));
                if (x.startsWith("--regexp") || x.startsWith("--file")) pat = true;
                continue;
            }
            for (int j = 1; j < x.length(); j++) {
                char c = x.charAt(j);
                if (val.indexOf(c) < 0) continue;
                String v = j + 1 < x.length() ? x.substring(j + 1) : (i + 1 < a.size() ? a.get(++i) : "");
                if (file.indexOf(c) >= 0) files.add(v);
                if (c == 'e' || c == 'f') pat = true;
                break;
            }
        }
        if ((name.equals("grep") || name.equals("egrep")) && !pat && !pos.isEmpty()) pos.remove(0);
        files.addAll(pos);
        return files;
    }

    // 参数里夹着的也算（--file=/sdcard/x、-f/sdcard/x）
    private static final Pattern SHARED = Pattern.compile("(?i)(?:^|/)(?:sdcard|storage|mnt)(?:/|$)");

    static boolean shared(String x) { return SHARED.matcher(norm(x)).find(); }

    static boolean sharedPath(String x) { return x.matches("/(sdcard|storage/emulated/0)(/.*)?"); }

    /** 免问的重定向只有 /dev/null：写共享存储能悄悄改掉用户放在那里的脚本、放诱饵文件（v0514 审查低-1） */
    static boolean targetOk(String t) { return "/dev/null".equals(t); }
}
