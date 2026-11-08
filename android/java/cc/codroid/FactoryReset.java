package cc.codroid;

import android.content.Context;
import android.system.Os;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.nio.charset.StandardCharsets;

/**
 * 恢复初始设置（用户 11-09：「和手机恢复出厂设置一样」）。误改了配置以后卡在「每轮都被拒、不出回答」、自己救不回来时用：
 * 用户级 Claude Code 配置、cccodroid 设置、shell 启动文件这些「每轮自动生效的东西」整体挪走，应用文件按安装包重铺，网关重启。
 *
 * 不删：挪走的都放进 ~/.ccapp-reset/<时间>/，按原来的相对路径摆，要找回就照路径拷回去。
 * 不动：会话记录（~/.claude/projects 下的 .jsonl）、工作区、开发工具包和组件、ssh、git 配置、导出的东西。
 * 厂商配置和密钥（ccapp-providers.json、Claude 登录凭据）默认保留，对话框里勾上才一起挪走。
 *
 * 只由原生对话框触发（MainActivity.askFactoryReset）：网关、脚本只能请求弹框，不能直接执行。
 * 执行时先停住网关（GatewayService.pause）：它内存里有设置，跑着的话会把挪走的文件按内存写回来。
 */
final class FactoryReset {
    private static final String TAG = "cccodroid-reset";

    /** home 下整个挪走的（文件或目录）。shell 启动文件同 guard/cc-guard.mjs 认的那一组 */
    private static final String[] MOVE = {
        "ccapp-settings.json", "ccapp-userconf.json", ".ccapp-userconf", ".cccodroid",
        ".claude/CLAUDE.md", ".claude/CLAUDE.local.md", ".claude/rules", ".claude/skills", ".claude/plugins", ".claude/commands",
        ".claude/agents", ".claude/output-styles", ".claude/settings.json", ".claude/settings.local.json", ".claude/keybindings.json",
        ".bashrc", ".bash_profile", ".bash_login", ".profile", ".zshrc", ".zprofile", ".zshenv", ".inputrc",
    };
    /** 勾了「厂商配置和密钥」才挪的 */
    private static final String[] KEYS = { "ccapp-providers.json", ".claude/.credentials.json" };
    /** 删掉就好、不用留底的开关文件 */
    private static final String[] DROP = { ".ccapp-safe-mode" };
    /** .claude.json 里这些键是配置（MCP、项目级的工具许可）：留底整份，原地只去掉它们，登录状态等别的键不动 */
    private static final String[] JSON_TOP = { "mcpServers" };
    private static final String[] JSON_PROJ = { "mcpServers", "enabledMcpjsonServers", "disabledMcpjsonServers", "allowedTools", "mcpContextUris" };

    private FactoryReset() {}

    /** 执行。返回留底目录；挪的过程中个别项失败不中断（记进结果），最后照样重铺、重启网关 */
    static File run(Context c, boolean keys) throws Exception {
        Env env = new Env(c);
        String stamp = new java.text.SimpleDateFormat("yyyyMMdd-HHmmss", java.util.Locale.ROOT).format(new java.util.Date());
        File bak = new File(new File(env.home, ".ccapp-reset"), stamp);
        java.util.List<String> moved = new java.util.ArrayList<>(), failed = new java.util.ArrayList<>();
        GatewayService.pause(true, Tr.t("正在恢复初始设置…"));
        try {
            if (!bak.mkdirs() && !bak.isDirectory()) throw new java.io.IOException(Tr.t("建不了留底目录：") + bak);
            try { Os.chmod(bak.getParent(), 0700); Os.chmod(bak.getPath(), 0700); } catch (Exception ignored) {}
            java.util.List<String> list = new java.util.ArrayList<>(java.util.Arrays.asList(MOVE));
            if (keys) list.addAll(java.util.Arrays.asList(KEYS));
            // 自动记忆：~/.claude/projects/<项目>/memory（会话记录 .jsonl 在同一层，不动）
            File[] projs = new File(env.home, ".claude/projects").listFiles();
            for (File p : projs == null ? new File[0] : projs) if (new File(p, "memory").exists() || isLink(new File(p, "memory"))) list.add(".claude/projects/" + p.getName() + "/memory");
            for (String rel : list) {
                File src = new File(env.home, rel);
                if (!src.exists() && !isLink(src)) continue;
                File dst = new File(bak, rel);
                dst.getParentFile().mkdirs();
                // 同一个文件系统里换名：软链挪的是链接本身，不跟进去
                try { Os.rename(src.getPath(), dst.getPath()); moved.add(rel); }
                catch (Exception e) { Log.w(TAG, "挪不走 " + rel, e); failed.add(rel); }
            }
            for (String rel : DROP) { File f = new File(env.home, rel); if (f.exists() || isLink(f)) { if (f.delete()) moved.add(rel); else failed.add(rel); } }
            try { if (stripClaudeJson(new File(env.home, ".claude.json"), new File(bak, ".claude.json"))) moved.add(".claude.json (MCP)"); }
            catch (Exception e) { Log.w(TAG, ".claude.json 没处理成", e); failed.add(".claude.json"); }
            // 应用自带的文件（网关、界面、守卫、bin/claude…）按安装包重铺
            try { AppFiles.deploy(c, env.app); AppFiles.markSeen(c); }
            catch (Exception e) { Log.w(TAG, "重铺应用文件失败", e); failed.add("files/app"); }
        } finally {
            // 停住之前正在起的那个网关（比如正在取运行库）可能在挪的时候起来了，内存里还是旧设置：再停一次再放行
            GatewayService.pause(true, Tr.t("正在恢复初始设置…"));
            GatewayService.pause(false, null);
        }
        JSONObject d = new JSONObject();
        d.put("backup", bak.getPath());
        d.put("moved", new JSONArray(moved));
        if (!failed.isEmpty()) d.put("failed", new JSONArray(failed));
        d.put("keys", keys);
        Ledger.add(env, "repair", failed.isEmpty(), Tr.f("恢复初始设置：挪走 {0} 项，留底在 {1}", moved.size(), bak.getPath())
            + (failed.isEmpty() ? "" : Tr.t("；没挪成：") + android.text.TextUtils.join(", ", failed)), d);
        Log.w(TAG, "恢复初始设置完成 " + d);
        if (!failed.isEmpty()) throw new Partial(bak, failed);
        return bak;
    }

    /** 有几项没挪成（多半是被占用或权限不对）：其余的照样做完了 */
    static final class Partial extends Exception {
        final File backup;
        Partial(File backup, java.util.List<String> failed) { super(android.text.TextUtils.join(", ", failed)); this.backup = backup; }
    }

    private static boolean isLink(File f) {
        try { return android.system.OsConstants.S_ISLNK(Os.lstat(f.getPath()).st_mode); } catch (Exception e) { return false; }
    }

    /** .claude.json 整份留底，原地去掉 MCP 和项目级许可。没有这些键就不动、返回 false。软链不碰（挪走链接本身留底） */
    private static boolean stripClaudeJson(File f, File bak) throws Exception {
        if (isLink(f)) { Os.rename(f.getPath(), bak.getPath()); return true; }
        if (!f.isFile() || f.length() > (64L << 20)) return false;
        byte[] raw = java.nio.file.Files.readAllBytes(f.toPath());
        JSONObject j = new JSONObject(new String(raw, StandardCharsets.UTF_8));
        boolean hit = false;
        for (String k : JSON_TOP) if (j.remove(k) != null) hit = true;
        JSONObject ps = j.optJSONObject("projects");
        if (ps != null) for (java.util.Iterator<String> it = ps.keys(); it.hasNext(); ) {
            JSONObject p = ps.optJSONObject(it.next());
            if (p != null) for (String k : JSON_PROJ) if (p.remove(k) != null) hit = true;
        }
        if (!hit) return false;
        java.nio.file.Files.write(bak.toPath(), raw);
        File tmp = new File(f.getPath() + ".reset-tmp");
        java.nio.file.Files.write(tmp.toPath(), j.toString(1).getBytes(StandardCharsets.UTF_8));
        try { Os.chmod(tmp.getPath(), 0600); } catch (Exception ignored) {}
        Os.rename(tmp.getPath(), f.getPath());
        return true;
    }
}
