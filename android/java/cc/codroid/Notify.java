package cc.codroid;

import android.app.KeyguardManager;
import android.app.Notification;
import android.content.BroadcastReceiver;
import android.content.IntentFilter;
import android.os.PowerManager;
import android.service.notification.StatusBarNotification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.util.Log;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 界面不在前台时的系统通知（A1）：
 *   一轮跑完 → 普通通知「已完成」，点开回到那个会话；
 *   等权限确认 / 计划批准 / 选择题 → 单独一个渠道的通知，带命令摘要（不弹横幅）。
 * 通知里只放「拒绝」和「打开查看」：通知只能显示截断的摘要，看不全的命令不该在这里放行。
 *
 * 数据来源：订阅网关的事件流（/api/events）。每条 state 事件都带当前全部待确认项，
 * 和已发出的通知比对 —— 新的发、答掉的撤，断线重连或重放都不会重复。
 * 跑在 GatewayService 里：界面被关了、只剩前台服务时也能发。
 */
final class Notify {
    static final String TAG = "cccodroid";
    static final String CH_DONE = "done", CH_ASK = "ask";
    static final String ACTION_DENY = "cc.codroid.PERM_DENY";
    static final String ACTION_OPEN = "cc.codroid.OPEN_SESSION";
    private static final int ID_DONE = 50;           // 完成通知只留最新一条
    private static final String TAG_ASK = "ask";
    private static final String TAG_DONE = "done";     // 确认通知按 tag + 请求号区分

    private static volatile Notify self;
    static Notify get(Context c) {
        if (self == null) synchronized (Notify.class) { if (self == null) self = new Notify(c.getApplicationContext()); }
        return self;
    }

    private final Context ctx;
    private final NotificationManager nm;
    private final SharedPreferences sp;
    private final WorkIslandNotifications workIsland;
    private boolean islandSynced;
    private boolean islandMode;
    private JSONObject liveReply;
    private volatile boolean screenObserver;
    private static final String REPLY_MARKER = "cccodroid.workIslandReply";
    private final BroadcastReceiver onScreenState = new BroadcastReceiver() {
        @Override public void onReceive(Context c, Intent intent) {
            synchronized (Notify.this) {
                if (!screenObserver) return;
                boolean screenOff = Intent.ACTION_SCREEN_OFF.equals(intent.getAction());
                if (screenOff) redactReplies();
                workIsland.refreshIcons(!screenOff && unlocked());
            }
        }
    };
    private Thread loop;
    private volatile boolean stopping;

    // 只在事件线程里改；onBackground() 从主线程来，同步一下
    private final Map<String, JSONObject> pending = new HashMap<>();   // 网关当前的待确认项
    private final Set<String> shown = new HashSet<>();                 // 已经发过通知的请求号
    /** runId → 这一轮用户发的消息。通知里只用前 80 字，存 200 字够了；条数封顶，
     *  漏收 run_end 的旧轮次（网关换过、服务停过）不会无限累积（BUG-A05） */
    private static final int RUN_TEXT_KEEP = 64, RUN_TEXT_CHARS = 200;
    private final Map<String, String> runText = new java.util.LinkedHashMap<String, String>(16, 0.75f, false) {
        @Override protected boolean removeEldestEntry(Map.Entry<String, String> eldest) { return size() > RUN_TEXT_KEEP; }
    };
    private final Set<String> doneRuns = new HashSet<>();              // 发过完成通知的 runId（重放去重）
    /** 上一次 hello 里网关的启动号：变了说明网关重启过，旧轮次的终止事件再也送不到（BUG-A05） */
    private String lastBoot = "";

    private Notify(Context c) {
        ctx = c;
        nm = c.getSystemService(NotificationManager.class);
        workIsland = WorkIslandNotifications.supported() ? new WorkIslandNotifications(ctx, nm, this::unlocked) : null;
        sp = c.getSharedPreferences("notify", Context.MODE_PRIVATE);
        NotificationChannel done = new NotificationChannel(CH_DONE, Tr.t("任务完成"), NotificationManager.IMPORTANCE_DEFAULT);
        done.setDescription(Tr.t("应用在后台时，一轮任务跑完提醒一下"));
        // 不用 IMPORTANCE_HIGH：那会弹横幅。这是安静的开发工具，进通知栏、响一声就够（用户 2026-10-15 定）
        NotificationChannel ask = new NotificationChannel(CH_ASK, Tr.t("等你确认"), NotificationManager.IMPORTANCE_DEFAULT);
        ask.setDescription(Tr.t("应用在后台时，Claude 等你批准命令、计划或回答问题"));
        nm.createNotificationChannel(done);
        nm.createNotificationChannel(ask);
    }

    boolean doneOn() { return sp.getBoolean("done", true); }
    boolean askOn() { return sp.getBoolean("ask", true); }

    JSONObject status() throws Exception {
        NotificationChannel d = nm.getNotificationChannel(CH_DONE), a = nm.getNotificationChannel(CH_ASK);
        return new JSONObject().put("ok", true).put("done", doneOn()).put("ask", askOn())
            .put("system", nm.areNotificationsEnabled())
            .put("chDone", d == null || d.getImportance() != NotificationManager.IMPORTANCE_NONE)
            .put("chAsk", a == null || a.getImportance() != NotificationManager.IMPORTANCE_NONE);
    }

    synchronized void set(JSONObject req) {
        SharedPreferences.Editor e = sp.edit();
        if (req.has("done")) e.putBoolean("done", req.optBoolean("done", true));
        if (req.has("ask")) e.putBoolean("ask", req.optBoolean("ask", true));
        e.apply();
        if (!askOn()) clearAsks();
        if (!doneOn()) redactReplies();
    }

    // 服务快速停了又起（审查 #105 06-006）：以前先看旧线程还活着就返回、stopping 却没复位，旧线程随后退出，就再没人订阅了。
    // 现在先复位让旧线程接着干；它恰好已经走出循环的，退出时自己看到没在停，再起一条
    synchronized void start() {
        stopping = false;
        if (workIsland != null && !screenObserver) {
            // Remove stale private notifications left by a previous process.
            redactReplies();
            workIsland.cancel();
            try {
                IntentFilter filter = new IntentFilter(Intent.ACTION_SCREEN_OFF);
                filter.addAction(Intent.ACTION_SCREEN_ON);
                filter.addAction(Intent.ACTION_USER_PRESENT);
                ctx.registerReceiver(onScreenState, filter, Context.RECEIVER_NOT_EXPORTED);
                screenObserver = true;
            } catch (RuntimeException ignored) { /* no observer: no snippets or avatars */ }
        }
        if (loop != null && loop.isAlive()) return;
        spawn();
    }
    private void spawn() {
        loop = new Thread(this::run, "notify-events");
        loop.setDaemon(true);
        loop.start();
    }

    synchronized void stop() {
        stopping = true;
        resetIsland();
        if (screenObserver) {
            ctx.unregisterReceiver(onScreenState);
            screenObserver = false;
        }
    }

    private void resetIsland() {
        islandSynced = false;
        if (workIsland != null) {
            liveReply = null;
            redactReplies();
            workIsland.cancel();
        }
    }

    /** 界面回到前台：确认通知都撤掉（卡片就在眼前） */
    void onForeground() { clearAsks(); }

    /** 界面刚退到后台：还有没答的确认，现在补发 */
    void onBackground() { synchronized (this) { syncAsks(); } }

    private void clearAsks() {
        synchronized (this) {
            for (String id : shown) nm.cancel(TAG_ASK, id.hashCode());
            shown.clear();
        }
    }

    // ── 事件流 ──────────────────────────────────────────────────────
    private void run() {
        // 新一次订阅：上一次订阅留下的旧轮次文本再也等不到 run_end（新连接不带 Last-Event-ID，
        // 网关只重放还在跑的轮次）。先清掉；还在跑的会在 hello 快照 / run_start 重放里重新放回来（BUG-A05）
        synchronized (this) { runText.clear(); lastBoot = ""; }
        String lastId = null;
        while (!stopping) {
            HttpURLConnection c = null;
            try {
                c = Env.gateway(workIsland == null ? "/api/events" : "/api/events?notify=1");
                c.setConnectTimeout(3000);
                c.setReadTimeout(45_000);            // 网关每 15 秒一个心跳，45 秒没动静就当断了
                if (lastId != null) c.setRequestProperty("Last-Event-ID", lastId);
                if (c.getResponseCode() != 200) throw new java.io.IOException("HTTP " + c.getResponseCode());
                BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8));
                StringBuilder data = new StringBuilder();
                for (String line; (line = r.readLine()) != null && !stopping; ) {
                    if (line.isEmpty()) {
                        if (data.length() > 0) { onEvent(data.toString()); data.setLength(0); }
                    } else if (line.startsWith("data:")) {
                        if (data.length() > 0) data.append('\n');
                        data.append(line.substring(line.startsWith("data: ") ? 6 : 5));
                    } else if (line.startsWith("id:")) {
                        lastId = line.substring(3).trim();
                    }
                }
            } catch (Exception e) {
                // 网关还没起来 / 正在重启：安静地等，别刷日志
            } finally {
                if (c != null) c.disconnect();
                synchronized (this) { resetIsland(); }
            }
            sleep(2000);
        }
        synchronized (this) { if (!stopping && loop == Thread.currentThread()) spawn(); }
    }

    private void onEvent(String json) {
        try {
            JSONObject ev = new JSONObject(json);
            String type = ev.optString("type");
            synchronized (this) {
                if (workIsland != null && !stopping) {
                    if ("sync".equals(type)) {
                        islandSynced = true;
                        setIslandMode(ev.optBoolean("workIslandMode"));
                        renderIsland(ev.optJSONObject("workIsland"));
                    } else if (islandSynced && "work_island".equals(type)) {
                        renderIsland(ev.optJSONObject("frame"));
                    } else if (islandSynced && "work_island_mode".equals(type)) {
                        setIslandMode(ev.optBoolean("enabled"));
                    } else if (islandSynced && islandMode && "work_island_reply".equals(type)) {
                        liveReply = ev;
                    } else if ("work_island_reply_clear".equals(type)) {
                        redactReplies();
                    } else if (islandSynced && "work_island_preview".equals(type)) {
                        workIsland.preview(openIntent("", 82));
                    }
                }
                if ("hello".equals(type) || "state".equals(type)) {
                    if ("hello".equals(type)) {
                        // 订阅期间网关重启过（启动号变了）：旧轮次等不到终止事件，文本回收（BUG-A05）
                        String boot = ev.optString("boot");
                        if (gatewayChanged(boot, lastBoot)) runText.clear();
                        lastBoot = boot;
                    }
                    onState(ev);
                }
                else if ("run_start".equals(type)) runText.put(ev.optString("runId"), clip(ev.optString("text"), RUN_TEXT_CHARS));
                else if ("run_end".equals(type)) onRunEnd(ev);
                else if ("sched_note".equals(type)) onSchedNote(ev);
                else if ("sched_next".equals(type)) SchedAlarm.set(ctx, ev.optLong("at"));
                if ("hello".equals(type)) SchedAlarm.fromFile(ctx);   // 事件流（重）连上：按文件补定一次闹钟
            }
        } catch (Exception e) {
            Log.w(TAG, "通知：事件解析失败", e);
        }
    }

    private void renderIsland(JSONObject frame) {
        workIsland.render(frame, openIntent(frame == null ? "" : validatedSid(frame), 81));
    }

    private void setIslandMode(boolean on) {
        if (islandMode != on) clearAsks();
        islandMode = on;
        if (!on) redactReplies();
        syncAsks();
    }

    private boolean unlocked() {
        KeyguardManager keyguard = ctx.getSystemService(KeyguardManager.class);
        PowerManager power = ctx.getSystemService(PowerManager.class);
        return screenObserver && power != null && power.isInteractive() && keyguard != null
            && !keyguard.isKeyguardLocked() && !keyguard.isDeviceLocked();
    }

    private void redactReplies() {
        liveReply = null;
        // Do not recreate dismissed notifications. Only replace currently posted snippets in place.
        for (StatusBarNotification entry : nm.getActiveNotifications()) {
            if (!TAG_DONE.equals(entry.getTag())) continue;
            Notification current = entry.getNotification();
            if (current.extras.getBoolean(REPLY_MARKER)) {
                nm.notify(TAG_DONE, entry.getId(), islandDone(false, current.contentIntent, ""));
            }
        }
    }

    private Notification islandDone(boolean failed, PendingIntent open, String reply) {
        String title = failed ? Tr.t("出错了") : Tr.t("已完成");
        String status = failed ? title : Tr.t("这一轮跑完了");
        Notification.Builder b = new Notification.Builder(ctx, CH_DONE)
            .setSmallIcon(WorkIslandNotifications.icon(ctx)).setContentTitle(title)
            .setContentText(reply.isEmpty() ? status : reply)
            .setContentIntent(open).setAutoCancel(true).setOnlyAlertOnce(true);
        if (!reply.isEmpty()) {
            android.os.Bundle marker = new android.os.Bundle();
            marker.putBoolean(REPLY_MARKER, true);
            b.addExtras(marker).setStyle(new Notification.BigTextStyle().bigText(reply))
                .setVisibility(Notification.VISIBILITY_PRIVATE)
                .setPublicVersion(islandDone(false, open, ""));
        }
        return b.build();
    }

    /** 并行多会话：state 里的 runs 是所有正在跑的轮次（旧网关只有 run） */
    private void onState(JSONObject st) {
        pending.clear();
        JSONArray runs = st.optJSONArray("runs");
        if (runs == null) { runs = new JSONArray(); if (st.optJSONObject("run") != null) runs.put(st.optJSONObject("run")); }
        for (int k = 0; k < runs.length(); k++) {
            JSONObject run = runs.optJSONObject(k);
            if (run == null) continue;
            runText.put(run.optString("id"), clip(run.optString("text"), RUN_TEXT_CHARS));
            JSONArray ps = run.optJSONArray("perms");
            if (ps != null) for (int i = 0; i < ps.length(); i++) {
                JSONObject p = ps.optJSONObject(i);
                if (p != null && !p.optString("id").isEmpty()) pending.put(p.optString("id"), p);
            }
        }
        syncAsks();
    }

    /** pending 与已发通知对齐：答掉的撤，新的（且界面不在前台、开关开着）发 */
    private void syncAsks() {
        for (java.util.Iterator<String> it = shown.iterator(); it.hasNext(); ) {
            String id = it.next();
            if (!pending.containsKey(id)) { nm.cancel(TAG_ASK, id.hashCode()); it.remove(); }
        }
        if (MainActivity.visible || !askOn()) return;
        for (JSONObject p : pending.values()) {
            String id = p.optString("id");
            if (shown.add(id)) nm.notify(TAG_ASK, id.hashCode(), askNote(p));
        }
    }

    private void onRunEnd(JSONObject ev) {
        String runId = ev.optString("runId");
        String text = runText.remove(runId);
        JSONObject reply = liveReply;
        liveReply = null;
        // 只撤这一轮的确认项：别的会话可能还在等（紧跟着的 state 事件会再对齐一次）
        for (java.util.Iterator<JSONObject> it = pending.values().iterator(); it.hasNext(); )
            if (runId.equals(it.next().optString("runId"))) it.remove();
        syncAsks();
        if (!doneRuns.add(runId)) return;
        if (doneRuns.size() > 200) doneRuns.clear();
        // 网关自己发起的空闲压缩（auto=idle）不是用户等着的那一轮，不通知；定时任务按它自己的通知设置走 sched_note
        if (ev.optBoolean("sched")) return;
        if (ev.optBoolean("aborted") || !ev.optString("auto").isEmpty() || MainActivity.visible || !doneOn()) return;
        // 网关的 run_end 用 failed / isError 表示没成（审查 #105 06-004：以前只看 error 字段，网关从来不带，一律报「已完成」）
        boolean failed = ev.optBoolean("failed") || ev.optBoolean("isError") || ev.has("error") && !ev.isNull("error");
        String sid = validatedSid(ev);
        if (workIsland != null && (islandMode || !islandSynced)) {
            String snippet = "";
            long age = reply == null ? Long.MAX_VALUE : System.currentTimeMillis() - reply.optLong("at");
            if (!failed && islandSynced && !sid.isEmpty() && reply != null && age >= 0 && age < 10_000
                && runId.equals(reply.optString("runId")) && sid.equals(validatedSid(reply)) && unlocked()) {
                snippet = clip(reply.optString("text"), 160);
            }
            int id = sid.isEmpty() ? ID_DONE : sid.hashCode();
            PendingIntent open = openIntent(sid, 0);
            nm.notify(TAG_DONE, id, islandDone(failed, open, snippet));
            if (!snippet.isEmpty() && !unlocked()) redactReplies();
            return;
        }
        // 每个会话各留最新一条：并行时几个会话先后跑完，不互相顶掉
        nm.notify(TAG_DONE, sid.isEmpty() ? ID_DONE : sid.hashCode(), new Notification.Builder(ctx, CH_DONE)
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentTitle(failed ? Tr.t("出错了") : Tr.t("已完成"))
            .setContentText(clip(text == null || text.isEmpty() ? Tr.t("这一轮跑完了") : text, 80))
            .setContentIntent(openIntent(sid, 0))
            .setAutoCancel(true)
            .build());
    }

    /** 定时任务跑完：网关已按任务的通知设置筛过（每次 / 只在失败 / 只在有发现），这里只管界面不在前台时发出来 */
    private void onSchedNote(JSONObject ev) {
        if (MainActivity.visible || !doneOn()) return;
        String sid = ev.optString("sessionId");
        String key = "sched:" + ev.optString("taskId");
        nm.notify(TAG_DONE, key.hashCode(), new Notification.Builder(ctx, CH_DONE)
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentTitle(clip(ev.optString("title"), 60))
            .setContentText(clip(ev.optString("text"), 80))
            .setStyle(new Notification.BigTextStyle().bigText(clip(ev.optString("text"), 400)))
            .setContentIntent(openIntent(sid, 0))
            .setAutoCancel(true)
            .build());
    }

    private Notification askNote(JSONObject p) {
        if (workIsland != null && (islandMode || !islandSynced)) {
            String title;
            switch (p.optString("tool")) {
                case "Bash": case "PowerShell": title = Tr.t("命令待确认 · 点此打开会话"); break;
                case "ExitPlanMode": title = Tr.t("计划待批准 · 点此打开会话"); break;
                case "AskUserQuestion": title = Tr.t("提问待回答 · 点此打开会话"); break;
                default: title = Tr.t("操作待确认 · 点此打开会话");
            }
            return new Notification.Builder(ctx, CH_ASK)
                .setSmallIcon(WorkIslandNotifications.icon(ctx)).setContentTitle(Tr.t("待确认"))
                .setContentText(title).setContentIntent(openIntent(validatedSid(p), 1))
                .setAutoCancel(true).build();
        }
        String tool = p.optString("tool");
        JSONObject in = p.optJSONObject("input");
        if (in == null) in = new JSONObject();
        String title, body;
        boolean question = "AskUserQuestion".equals(tool);
        if ("ExitPlanMode".equals(tool)) {
            title = Tr.t("计划待批准");
            body = in.optString("plan");
        } else if (question) {
            title = Tr.t("Claude 想问你");
            JSONArray qs = in.optJSONArray("questions");
            JSONObject q = qs == null ? null : qs.optJSONObject(0);
            body = q == null ? "" : q.optString("question");
        } else {
            title = Tr.t("需要确认：") + tool;
            body = firstOf(in, "command", "file_path", "notebook_path", "url", "pattern", "path");
            if (body.isEmpty()) body = p.optString("description");
            if (body.isEmpty()) body = in.toString();
        }
        String id = p.optString("id");
        Notification.Builder b = new Notification.Builder(ctx, CH_ASK)
            .setSmallIcon(android.R.drawable.stat_sys_warning)
            .setContentTitle(title)
            .setContentText(clip(body, 120))
            .setStyle(new Notification.BigTextStyle().bigText(clip(body, 600)))
            .setCategory(Notification.CATEGORY_REMINDER)
            // 命令行里可能带着密钥：锁屏上只显示标题（审查 10-29 L16）
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setPublicVersion(new Notification.Builder(ctx, CH_ASK).setSmallIcon(android.R.drawable.stat_sys_warning).setContentTitle(title).build())
            .setContentIntent(openIntent(sidOf(p), 1 + Math.abs(id.hashCode() % 10000)))
            .setAutoCancel(true);
        // 选择题要选项，通知里答不了；其它的给「拒绝」，「允许」必须进应用看完整内容再点
        if (!question) {
            // 请求码是哈希取模，会撞；FLAG_UPDATE_CURRENT 又会把撞上的那个改成新的 extras——点 A 的「拒绝」拒掉的是 B。
            // 带上各自的 data，系统就当成不同的 PendingIntent（审查 10-30 第九份 安卓低17）
            Intent deny = new Intent(ctx, Events.class).setAction(ACTION_DENY).putExtra("id", id)
                .setData(android.net.Uri.parse("cccodroid-notify://deny/" + android.net.Uri.encode(id)));
            PendingIntent pi = PendingIntent.getBroadcast(ctx, 20000 + Math.abs(id.hashCode() % 10000), deny,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            b.addAction(new Notification.Action.Builder(null, Tr.t("拒绝"), pi).build());
        }
        b.addAction(new Notification.Action.Builder(null, Tr.t("打开查看"), openIntent(sidOf(p), 30000 + Math.abs(id.hashCode() % 10000))).build());
        return b.build();
    }

    /** 更新装完、界面没能自己回来（系统拦了后台启动）：发一条点开就回来的通知 */
    static void updatedTapToOpen(Context c) {
        Notify n = get(c);
        String v = "";
        try { v = c.getPackageManager().getPackageInfo(c.getPackageName(), 0).versionName; } catch (Exception ignored) {}
        n.nm.notify(TAG_DONE, 0x5eed, new Notification.Builder(c, CH_DONE)
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentTitle(Tr.f("cccodroid 已更新到 v{0}", v))
            .setContentText(Tr.t("点此打开即可继续使用"))
            .setContentIntent(n.openIntent("", 5))
            .setAutoCancel(true)
            .build());
    }

    /** hello 里的网关启动号变了（网关重启过）：旧轮次的 run_end 再也送不到，文本该回收（BUG-A05） */
    static boolean gatewayChanged(String boot, String lastBoot) {
        return boot != null && !boot.isEmpty() && lastBoot != null && !lastBoot.isEmpty() && !boot.equals(lastBoot);
    }

    /** 会话号：JSON 里是 null 时 optString 会给出字符串 "null"，要单独判 */
    private static String sidOf(JSONObject o) { return o.isNull("sessionId") ? "" : o.optString("sessionId", ""); }

    private static String validatedSid(JSONObject o) {
        String sid = sidOf(o);
        return sid.matches("[A-Za-z0-9_-]{1,80}") ? sid : "";
    }

    private PendingIntent openIntent(String sessionId, int req) {
        Intent i = MainActivity.internal(ctx, ACTION_OPEN)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (sessionId != null && !sessionId.isEmpty()) i.putExtra("session", sessionId);
        i.setData(android.net.Uri.parse("cccodroid-notify://open/" + req + "/" + android.net.Uri.encode(sessionId == null ? "" : sessionId)));   // 同上：撞码时别串会话
        return PendingIntent.getActivity(ctx, 60000 + req, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    /** 通知里点「拒绝」：转给网关，跟界面里点拒绝走同一个接口 */
    static void deny(Context c, String id) {
        try {
            byte[] body = new JSONObject().put("id", id).put("behavior", "deny")
                .put("message", "用户在通知里拒绝了这次操作。").toString().getBytes(StandardCharsets.UTF_8);
            HttpURLConnection h = Env.gateway("POST", "/api/perm/answer", body);
            h.setDoOutput(true);
            h.setConnectTimeout(3000); h.setReadTimeout(5000);
            h.setRequestProperty("Content-Type", "application/json");
            h.getOutputStream().write(body);
            int code = h.getResponseCode();
            Log.i(TAG, "通知里拒绝 " + id + " → HTTP " + code);
            h.disconnect();
            // 拒绝送到了，或者这项已经答过 / 不在了（409 / 404）：通知撤掉
            if (code == 200 || code == 409 || code == 404) { c.getSystemService(NotificationManager.class).cancel(TAG_ASK, id.hashCode()); return; }
        } catch (Exception e) {
            Log.w(TAG, "通知里拒绝失败", e);
        }
        // 没送到（审查 #105 06-005）：通知留着，那一轮其实还在等确认；告诉用户去应用里处理
        new android.os.Handler(android.os.Looper.getMainLooper()).post(() ->
            android.widget.Toast.makeText(c, Tr.t("拒绝没送到，打开应用里处理这项确认"), android.widget.Toast.LENGTH_LONG).show());
    }

    private static String firstOf(JSONObject o, String... keys) {
        for (String k : keys) { String v = o.optString(k); if (!v.isEmpty()) return v; }
        return "";
    }

    private static String clip(String s, int n) {
        s = s.trim();
        return s.length() <= n ? s : s.substring(0, n - 1) + "…";
    }

    private static void sleep(long ms) { try { Thread.sleep(ms); } catch (InterruptedException ignored) {} }
}
