package cc.codroid;

import android.system.Os;
import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.BufferedReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.zip.GZIPInputStream;
import org.json.JSONObject;

/** 首次安装：把 devkit tar 解到 files/ 下、跑 first-run、再装官方 Claude Code。全程只写本应用私有目录。 */
final class Installer {
    interface Progress { void step(String msg); void bytes(long done, long total); }

    private final Env env;
    private final Progress ui;

    Installer(Env env, Progress ui) { this.env = env; this.ui = ui; }
    void step(String m) { ui.step(m); }

    // ── devkit 下载 ────────────────────────────────────────────────────
    /** 工具包镜像（VPS 直连，不过 Cloudflare 代理）：dl.cccodroid.net/devkit/<tag>/ 与 GitHub Release 里的文件逐字节相同 */
    static final String DEVKIT_MIRROR = "https://dl.cccodroid.net/devkit/";

    /**
     * 首次安装：按 APK 自带的清单（assets/devkit-pin.json：gz 的文件名、大小、sha256）下载 .tar.gz 到私有目录 ——
     * 断点续传（Range）、失败重试，首选地址连着失败就换备用地址接着同一个 .part 续传，sha256 对上才交给 installDevkit。
     * 校验值来自 APK 本身，所以镜像不需要被信任。先落盘再解压：边下边解的话网络一断就得从头来。
     * @param primary/alt 首选与备用的完整下载地址（GitHub / 镜像，按用户选的顺序）
     * @return 校验过的本地 .tar.gz
     */
    File downloadDevkit(JSONObject pin, String primary, String alt) throws IOException {
        JSONObject gz = pin.optJSONObject("gz"), tarInfo = pin.optJSONObject("tar");
        if (gz == null) throw new IOException(Tr.t("APK 里的工具包清单坏了"));
        String name = gz.optString("file"), sha = gz.optString("sha256");
        long size = gz.optLong("bytes");
        File done = new File(env.files, name), part = new File(env.files, name + ".part");
        lastBase = pin.optString("base"); lastSha = sha;
        lastTarSha = tarInfo != null ? tarInfo.optString("sha256", null) : null;
        // 空间先算清再下：下到一半才报「No space left」，用户白等十分钟还看不懂。
        // 峰值 = 还没下完的压缩包 + 解开后的全部文件（压缩包解完才删）+ Claude Code 与余量
        long have = done.isFile() ? done.length() : part.length();
        long tarBytes = tarInfo != null ? tarInfo.optLong("bytes", 0) : 0;
        long need = Math.max(0, size - have) + (tarBytes > 0 ? tarBytes : size * 3) + (400L << 20);
        long free = new android.os.StatFs(env.files.getPath()).getAvailableBytes();
        if (free < need) throw new NoSpace(need, free);
        ui.step(Tr.t("下载来源：") + host(primary));
        ui.step(String.format(Tr.t("下载开发工具包 %.0f MB%s…"), size / 1048576.0, part.length() > 0 ? String.format(Tr.t("（续传，已有 %.0f MB）"), part.length() / 1048576.0) : ""));
        File f = download(primary, alt, done, size, sha);
        ui.step(Tr.t("✓ sha256 与清单一致"));
        return f;
    }

    static String host(String url) {
        try { return new URL(url).getHost(); } catch (Exception e) { return url; }
    }

    /** 存储空间不够：消息直接给用户看，写清要多少、还剩多少 */
    static final class NoSpace extends IOException {
        NoSpace(long need, long free) {
            super(String.format(java.util.Locale.ROOT, Tr.t("存储空间不够：安装需要约 %.1f GB，手机里目前只剩 %.1f GB。清理出空间后点「重试」即可（已下载的部分会保留）。"),
                need / 1073741824.0, free / 1073741824.0));
        }
    }

    /** 最近一次 downloadDevkit 用的 Release 目录、gz 与 tar 的 sha256（installDevkit 记进 .devkit-ok，更新检查据此比对） */
    String lastBase, lastSha, lastTarSha;

    /**
     * 通用下载：断点续传 + 重试 + sha256（sha 为 null 则不校验）。.part 旁边的 .sha256 记着它属于哪个版本，
     * 换了版本就作废重下，别把两个版本拼在一起。
     */
    File download(String url, File done, long size, String sha) throws IOException { return download(url, (String) null, done, size, sha); }

    /** alt：备用地址（同一个文件的镜像）。主地址连着失败两次就换过去，接着同一个 .part 续传；内容由 sha256 把关，镜像不需要被信任 */
    File download(String url, String alt, File done, long size, String sha) throws IOException { return download(url, new String[]{ alt }, done, size, sha); }

    /** alts：按顺序的备用地址（空的跳过）；全换完了最后还有 gh-proxy 兜底 */
    File download(String url, String[] alts, File done, long size, String sha) throws IOException {
        if (done.isFile() && (size <= 0 || done.length() == size) && (sha == null || sha.equals(sha256(done)))) return done;
        File part = new File(done.getPath() + ".part"), tag = new File(done.getPath() + ".sha256"), seg = new File(part.getPath() + ".seg");
        done.getParentFile().mkdirs();
        String id = sha != null ? sha : url;
        if (!tag.isFile() || !id.equals(new String(java.nio.file.Files.readAllBytes(tag.toPath()), StandardCharsets.UTF_8).trim())) {
            part.delete(); seg.delete();
            write(tag, id + "\n");
        }
        // 候选来源：主地址、备用地址，最后是 GitHub 地址经 gh-proxy.com 加速（第三方，内容照样按 sha256 把关）。
        // 主地址和备用地址不再按写死的顺序排：先各要一小段测速，谁快谁当主，其余按快慢备用（群友 10-31：不开代理时 GitHub 卡住，镜像却通）。
        // gh-proxy 不参与测速、始终垫底：第三方，前面的都不行才去碰它
        java.util.List<String> cands = new java.util.ArrayList<>();
        cands.add(url);
        String proxy = ghProxy(url);
        for (String a : alts) if (a != null && !cands.contains(a)) { cands.add(a); if (proxy == null) proxy = ghProxy(a); }
        if (cands.size() > 1 && (hostRank != null || size >= PROBE * 4)) {
            if (hostRank == null) ui.step("  " + Tr.t("测速中…"));
            cands = rank(cands, size);
        }
        if (proxy != null && !cands.contains(proxy)) cands.add(proxy);
        // 这个 Installer 里给过校验不对的文件的主机：往后的文件（工具包按模块连着下）不再先找它，只留作最后的兜底
        java.util.List<String> good = new java.util.ArrayList<>(), shunned = new java.util.ArrayList<>();
        for (String c : cands) (badHosts.contains(host(c)) ? shunned : good).add(c);
        if (!good.isEmpty()) { good.addAll(shunned); cands = good; }
        url = cands.get(0);
        if (cands.size() > 1) ui.step("  " + Tr.t("下载来源：") + host(url));
        java.util.ArrayDeque<String> left = new java.util.ArrayDeque<>(cands.subList(1, cands.size()));
        java.util.Set<String> tried = new java.util.HashSet<>();
        tried.add(url);
        for (int attempt = 1; ; ) {
            for (; size <= 0 || part.length() < size || seg.isFile(); attempt++) {
                try { if (size >= 2 * MIN_SEG && (seg.isFile() || rangeOk(url))) fetchSegmented(url, part, seg, size); else { fetchRange(url, part, size); if (size <= 0) break; } }
                catch (IOException e) {
                    String next = left.peek();
                    if (next != null && attempt < 12) {      // 出一次错就换下一个，换下来的排到队尾，轮着来
                        ui.step("  " + Tr.f("{0} 下载不顺（{1}），改从 {2} 续传…", host(url), e.getMessage(), host(next)));
                        left.add(url);
                        url = left.poll();
                        // 一圈都试过了还不行：多半是网断了，歇一会儿再轮
                        if (!tried.add(url)) try { Thread.sleep(Math.min(attempt * 2000L, 20000L)); } catch (InterruptedException ie) { throw new IOException(ie); }
                        continue;
                    }
                    if (next != null) throw e;
                    // 慢但没断、又没别的来源可换：不算失败次数，接着续传（已下的不丢）——总比报错强
                    if (e instanceof SlowException) {
                        attempt--;
                        ui.step("  " + Tr.f("{0} 很慢（{1}），没有别的来源可换，接着下…", host(url), e.getMessage()));
                        continue;
                    }
                    if (attempt >= 8) throw e;
                    ui.step("  " + Tr.f("网络中断（{0}），{1} 秒后续传…", e.getMessage(), attempt * 3));
                    try { Thread.sleep(attempt * 3000L); } catch (InterruptedException ie) { throw new IOException(ie); }
                }
            }
            if (sha == null) break;
            String got = sha256(part);
            if (sha.equals(got)) break;
            part.delete(); seg.delete();
            IOException bad = new IOException(Tr.f("sha256 不符（期望 {0}…，实得 {1}…）", sha.substring(0, 12), got.substring(0, 12)));
            // 大小对、内容不对：这一份是谁给的说不准（中途可能换过源），至少当前这个不再用；换下一个从头下，都换完了才报错。
            // 坏来源装不进去这一点不变，只是别让它把重试也吃死
            String next = left.poll();
            if (next == null || attempt >= 12) throw bad;
            ui.step("  " + Tr.f("{0} 下来的文件校验不对，改从 {1} 重下…", host(url), host(next)));
            badHosts.add(host(url));
            url = next;
            attempt++;
        }
        done.delete();
        if (!part.renameTo(done)) throw new IOException(Tr.t("换名失败: ") + part);
        tag.delete();
        lastHost = host(url);
        return done;
    }

    private final java.util.Set<String> badHosts = new java.util.HashSet<>();

    /** 最近一次 download 最后是从哪台主机下完的（更新页写明来源） */
    String lastHost;

    // ── 来源测速 ──
    // 每个来源同时要头 256 KB，按收完的用时排；第一个测完后最多再等 3 秒，没测完的排在测完的后面。
    // 连不上的排到最后（可能只是一时不通，留作兜底）；回的总大小对不上的直接剔除（指错了文件）。
    // 同一个 Installer 下多个文件（工具包按模块下）只测第一次，后面照这个名次排
    static final int PROBE = 256 << 10;
    private java.util.List<String> hostRank;

    private java.util.List<String> rank(java.util.List<String> cands, long size) {
        if (hostRank != null) {
            java.util.List<String> r = new java.util.ArrayList<>(cands);
            java.util.Collections.sort(r, (a, b) -> Integer.compare(rankOf(a), rankOf(b)));     // 稳定排序：没测过的主机保持原顺序排在后面
            return r;
        }
        final int n = cands.size();
        final long[] ms = new long[n];
        final boolean[] fin = new boolean[n];
        final Object lk = new Object();
        for (int i = 0; i < n; i++) {
            final int k = i;
            Thread t = new Thread(() -> {
                long v = probe(cands.get(k), size);
                synchronized (lk) { ms[k] = v; fin[k] = true; lk.notifyAll(); }
            }, "probe-" + i);
            t.setDaemon(true);
            t.start();
        }
        long t0 = System.currentTimeMillis(), firstOk = 0;
        synchronized (lk) {
            for (;;) {
                boolean all = true;
                for (int i = 0; i < n; i++) { all &= fin[i]; if (fin[i] && ms[i] > 0 && firstOk == 0) firstOk = System.currentTimeMillis(); }
                long now = System.currentTimeMillis();
                if (all || now - t0 >= 15000 || firstOk > 0 && now - firstOk >= 3000) break;
                try { lk.wait(250); } catch (InterruptedException e) { break; }
            }
            java.util.List<Integer> ok = new java.util.ArrayList<>(), pending = new java.util.ArrayList<>(), down = new java.util.ArrayList<>();
            for (int i = 0; i < n; i++) {
                if (!fin[i]) pending.add(i);
                else if (ms[i] > 0) ok.add(i);
                else if (ms[i] == -1) down.add(i);         // -2 大小不符：剔除
            }
            java.util.Collections.sort(ok, (a, b) -> Long.compare(ms[a], ms[b]));
            java.util.List<String> r = new java.util.ArrayList<>();
            StringBuilder log = new StringBuilder();
            for (java.util.List<Integer> g : java.util.Arrays.asList(ok, pending, down)) for (int i : g) r.add(cands.get(i));
            for (int i = 0; i < n; i++) log.append(host(cands.get(i))).append('=').append(!fin[i] ? "?" : ms[i] > 0 ? (ms[i] % NO_RANGE) + (ms[i] >= NO_RANGE ? "ms/no-range" : "ms") : ms[i] == -1 ? "down" : "mismatch").append(' ');
            android.util.Log.i("Installer", "来源测速 " + log.toString().trim());
            if (r.isEmpty()) return cands;      // 全都对不上大小：多半是清单写错了，按原顺序下，最后由 sha256 说话
            if (!ok.isEmpty()) { hostRank = new java.util.ArrayList<>(); for (String u : r) hostRank.add(host(u)); }
            return r;
        }
    }

    private int rankOf(String url) {
        int i = hostRank.indexOf(host(url));
        return i < 0 ? hostRank.size() : i;
    }

    static final long NO_RANGE = 1_000_000;

    /** 要头 PROBE 字节，返回收完的毫秒数（至少 1，不认 Range 的另加 NO_RANGE）；连不上/出错 -1；总大小与清单不符 -2 */
    static long probe(String url, long size) {
        long t0 = System.currentTimeMillis();
        HttpURLConnection c = null;
        try {
            c = open(url);
            c.setConnectTimeout(10000);
            c.setReadTimeout(10000);
            c.setRequestProperty("Range", "bytes=0-" + (PROBE - 1));
            int code = code(c, url);
            if (code == 206) {
                String cr = c.getHeaderField("Content-Range");
                int slash = cr == null ? -1 : cr.lastIndexOf('/');
                if (size > 0 && slash >= 0 && !"*".equals(cr.substring(slash + 1).trim()) && Long.parseLong(cr.substring(slash + 1).trim()) != size) return -2;
            } else if (code == 200) {
                long len = c.getContentLengthLong();
                if (size > 0 && len >= 0 && len != size) return -2;
            } else return -1;
            long want = size > 0 ? Math.min(PROBE, size) : PROBE, got = 0;
            byte[] buf = new byte[1 << 15];
            try (InputStream in = c.getInputStream()) {
                for (int r; got < want && (r = in.read(buf)) > 0; ) got += r;
            }
            if (got < want) return -1;
            // 不认 Range 的（回 200）排在认的后面：大文件分段下、续传都用不了它，轮到它就得从头来
            return Math.max(1, System.currentTimeMillis() - t0) + (code == 200 ? NO_RANGE : 0);
        } catch (IOException | RuntimeException e) {
            return -1;
        } finally { if (c != null) c.disconnect(); }
    }

    static byte[] httpGetSmall(String url) throws IOException {
        HttpURLConnection c = open(url);
        try {
            if (code(c, url) != 200) throw new IOException("HTTP " + c.getResponseCode() + " " + url);
            // 只用来拿发布清单、锁文件、校验和这类小东西：读超过 32 MB 就是地址指错了或者对面出了问题，不往内存里塞（审查 v0.5.7 L10）
            if (c.getContentLengthLong() > SMALL_MAX) throw new IOException(Tr.t("响应太大，不像清单文件：") + url);
            try (InputStream in = c.getInputStream()) { return readAllBytes(in, SMALL_MAX); }
        } finally { c.disconnect(); }
    }
    static final long SMALL_MAX = 32L << 20;

    // ── 分段并行下载 ──
    // 单个连接常被限速（实测 dl.cccodroid.net 单线 2.7 MB/s，4 路并行 14 MB/s）：文件够大、服务器认 Range 时，
    // 把没下的部分切成几段、各开一条连接同时下，按偏移写进同一个 .part（先占满到总大小）。
    // 每段进度记在 .part.seg（每行「起 止 已下」，每秒落盘，只会比实际写入的少），被打断、换来源后按它续传；
    // 几个来源是逐字节同一份文件，最后照样核 sha256。和 gw/pget.mjs 是同一套做法
    static final int SEGS = 4;
    static final long MIN_SEG = 8L << 20;

    static String ghProxy(String url) {
        return url != null && url.startsWith("https://github.com/") ? "https://gh-proxy.com/" + url.substring("https://".length()) : null;
    }

    /** 认不认 Range：要 1 个字节，回 206 才算 */
    static boolean rangeOk(String url) {
        try {
            HttpURLConnection c = open(url);
            c.setRequestProperty("Range", "bytes=0-0");
            try { return c.getResponseCode() == 206; } finally { c.disconnect(); }
        } catch (IOException e) { return false; }
    }

    private void fetchSegmented(String url, File part, File segF, long size) throws IOException {
        long[][] segs = null;
        if (segF.isFile() && part.length() == size) {
            try {
                String[] ls = new String(java.nio.file.Files.readAllBytes(segF.toPath()), StandardCharsets.UTF_8).trim().split("\n");
                segs = new long[ls.length][];
                for (int i = 0; i < ls.length; i++) { String[] t = ls[i].trim().split(" "); segs[i] = new long[]{ Long.parseLong(t[0]), Long.parseLong(t[1]), Long.parseLong(t[2]) }; }
                if (segs.length == 0 || segs[segs.length - 1][1] != size - 1) segs = null;
            } catch (RuntimeException e) { segs = null; }
        }
        if (segs == null) {
            // .seg 坏了或和 .part 对不上：作废；以前单线下了一截的 .part（没有 .seg）从它末尾往后切
            long from = segF.isFile() ? 0 : Math.min(part.length(), size);
            if (segF.isFile()) { segF.delete(); part.delete(); }
            long left = size - from;
            int k = (int) Math.max(1, Math.min(SEGS, left / MIN_SEG));
            segs = new long[k][];
            for (int i = 0; i < k; i++) segs[i] = new long[]{ from + left * i / k, from + left * (i + 1) / k - 1, 0 };
            saveSegs(segF, segs);
        }
        try (java.io.RandomAccessFile raf = new java.io.RandomAccessFile(part, "rw")) { raf.setLength(size); }
        final long[][] S = segs;
        final IOException[] err = new IOException[1];
        Thread[] ts = new Thread[S.length];
        for (int i = 0; i < S.length; i++) {
            final long[] sg = S[i];
            ts[i] = new Thread(() -> {
                for (int a = 0; sg[2] < sg[1] - sg[0] + 1; a++) {
                    try { fetchPiece(url, part, sg); }
                    catch (IOException e) {
                        if (a >= 2) { synchronized (err) { if (err[0] == null) err[0] = e; } return; }
                        try { Thread.sleep(2000L * (a + 1)); } catch (InterruptedException ie) { return; }
                    }
                }
            }, "seg-" + i);
            ts[i].start();
        }
        for (boolean alive = true; alive; ) {
            alive = false;
            for (Thread t : ts) { try { t.join(1000); } catch (InterruptedException e) { throw new IOException(e); } alive |= t.isAlive(); }
            saveSegs(segF, S);
            long left = 0; for (long[] sg : S) left += sg[1] - sg[0] + 1 - sg[2];
            ui.bytes(size - left, size);
        }
        if (err[0] != null) throw err[0];
        segF.delete();
    }

    private static void saveSegs(File f, long[][] segs) {
        StringBuilder b = new StringBuilder();
        synchronized (segs) { for (long[] s : segs) b.append(s[0]).append(' ').append(s[1]).append(' ').append(s[2]).append('\n'); }
        try { write(f, b.toString()); } catch (IOException ignored) {}
    }

    /** 下一段：从 sg 已下的位置接着要到段尾，按偏移写进 part */
    private static void fetchPiece(String url, File part, long[] sg) throws IOException {
        HttpURLConnection c = open(url);
        c.setRequestProperty("Range", "bytes=" + (sg[0] + sg[2]) + "-" + sg[1]);
        try {
            if (code(c, url) != 206) throw new IOException("HTTP " + c.getResponseCode());
            try (InputStream in = new BufferedInputStream(c.getInputStream(), 1 << 16);
                 java.io.RandomAccessFile raf = new java.io.RandomAccessFile(part, "rw")) {
                byte[] buf = new byte[1 << 16];
                Slow slow = new Slow();
                for (int r; (r = in.read(buf)) > 0; ) {
                    slow.add(r);
                    long room = sg[1] - sg[0] + 1 - sg[2];
                    int n = (int) Math.min(r, room);
                    raf.seek(sg[0] + sg[2]);
                    raf.write(buf, 0, n);
                    sg[2] += n;
                    if (sg[2] >= sg[1] - sg[0] + 1) break;
                }
            }
            if (sg[2] < sg[1] - sg[0] + 1) throw new IOException(Tr.t("连接提前结束"));
        } finally { c.disconnect(); }
    }

    /** 从 part 现有长度续传到结束；服务器不认 Range（回 200）就从头写 */
    private void fetchRange(String url, File part, long size) throws IOException {
        long have = part.length();
        HttpURLConnection c = open(url);
        if (have > 0) c.setRequestProperty("Range", "bytes=" + have + "-");
        try {
            int code = code(c, url);
            boolean append = code == 206;
            if (code != 200 && code != 206) throw new IOException("HTTP " + code);
            if (!append) have = 0;
            try (InputStream in = new BufferedInputStream(c.getInputStream(), 1 << 16);
                 OutputStream out = new FileOutputStream(part, append)) {
                byte[] buf = new byte[1 << 16];
                long tick = 0;
                Slow slow = new Slow();
                for (int r; (r = in.read(buf)) > 0; ) {
                    out.write(buf, 0, r);
                    have += r;
                    slow.add(r);
                    // 每秒报一次进度：以前每 2 MB 报一次，慢的时候界面一直停在 0%，看着像死了
                    long now = System.currentTimeMillis();
                    if (now - tick >= 1000) { tick = now; ui.bytes(have, size); }
                }
            }
            ui.bytes(have, size);
            // 对面干脆利落地提前关了连接：当作出错，好走重试/换源的计数，别无声无息地一遍遍重连
            if (size > 0 && have < size) throw new IOException(Tr.t("连接提前结束"));
        } finally { c.disconnect(); }
    }

    /**
     * 低速判定：每 30 秒一窗，这一窗不到 600 KB（平均 20 KB/s）就抛错，交给上面的重试 / 换来源。
     * 读超时只管「一个字节都不来」；连接不断、却一点点往下滴的（群友报的 GitHub 挂着梯子也是这样）会一直耗着不换源。
     * 与 install-claude.mjs 的规则一致
     */
    static final class SlowException extends IOException { SlowException(String m) { super(m); } }

    static final class Slow {
        static final long WINDOW = 30_000, MIN = 600L << 10;
        long t0 = System.currentTimeMillis(), n;
        void add(int r) throws IOException {
            n += r;
            long now = System.currentTimeMillis();
            if (now - t0 < WINDOW) return;
            if (n < MIN) throw new SlowException(Tr.f("太慢（30 秒只下了 {0} KB）", n >> 10));
            t0 = now; n = 0;
        }
    }

    /** 取响应码；https 被重定向成了 http 就不认：内容有哈希兜底，但下了什么会被路上看见（审查 10-29 L14） */
    static int code(HttpURLConnection c, String url) throws IOException {
        int code = c.getResponseCode();
        if (url.startsWith("https:") && !"https".equals(c.getURL().getProtocol())) throw new IOException(Tr.t("下载地址被重定向到了不加密的 http，没有下载"));
        return code;
    }

    static HttpURLConnection open(String url) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setInstanceFollowRedirects(true);      // GitHub Release 会 302 到 objects.githubusercontent.com
        c.setConnectTimeout(20000);
        c.setReadTimeout(60000);                 // 60 秒没来一个字节就当断了，交给续传
        return c;
    }

    static String sha256(File f) throws IOException {
        try (InputStream in = new FileInputStream(f)) {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] buf = new byte[1 << 20];
            for (int r; (r = in.read(buf)) > 0; ) md.update(buf, 0, r);
            return hex(md.digest());
        } catch (java.security.NoSuchAlgorithmException e) { throw new IOException(e); }
    }

    private static byte[] readAllBytes(InputStream in, long max) throws IOException {
        java.io.ByteArrayOutputStream b = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        for (int r; (r = in.read(buf)) > 0; ) {
            if (b.size() + (long) r > max) throw new IOException(Tr.t("响应太大，不像清单文件"));
            b.write(buf, 0, r);
        }
        return b.toByteArray();
    }

    // ── devkit ─────────────────────────────────────────────────────────
    //
    // 替换分四步，每一步被打断（进程被杀、APK 升级重启、没电）都能在下次启动时由 recover() 收拾干净：
    //   1. 解到 usr.new/，边解边算 tar 的 sha256，和清单对不上就整个丢掉 —— 旧工具包一根毫毛不动
    //   2. 校验通过后在 usr.new/ 里写 .devkit-pending（要装成哪一版）
    //   3. usr → usr.old，usr.new → usr（两次换名）
    //   4. finish()：搬用户自装的东西、first-run、写 .devkit-ok、删 usr.old
    // .devkit-ok 是最后写的：没有它，网关不会启动，更新检查也不会把这份工具包当成装好了。
    static final String PENDING = ".devkit-pending";
    File usrNew() { return new File(env.files, "usr.new"); }
    File usrOld() { return new File(env.files, "usr.old"); }

    void installDevkit(String source) throws IOException { installDevkit(source, lastBase, lastSha, lastTarSha); }

    /** @param base/sha/tarSha 这份工具包来自哪个 Release、gz 与 tar 的 sha256（本地文件安装时可为 null）—— 写进 .devkit-ok，更新检查拿它比 */
    void installDevkit(String source, String base, String sha, String tarSha) throws IOException {
        // 本地文件没给 sha：自己算一个。已装记录里有了内容身份，更新检查才不会把它误认成别的版本
        if (sha == null && !source.startsWith("http")) { ui.step(Tr.t("计算工具包校验和…")); sha = sha256(new File(source)); }
        InputStream raw; long total;
        if (source.startsWith("http")) {
            HttpURLConnection c = (HttpURLConnection) new URL(source).openConnection();
            c.setInstanceFollowRedirects(true);
            raw = c.getInputStream(); total = c.getContentLengthLong();
        } else {
            File f = new File(source);
            raw = new FileInputStream(f); total = f.length();
        }
        installDevkit(raw, total, source.endsWith(".gz"), base, sha, tarSha);
    }

    /** 本地文件（系统文件选择器给的 content://）的来源：要读两遍（先认身份、再解包），所以给个能重开的入口 */
    interface Source { InputStream open() throws IOException; }

    /** 认本地包：读一遍算 sha256，看开头是不是 gzip（content:// 不一定有文件名）。返回 {sha256, "gz"|"tar"} */
    String[] scanLocal(Source src, long total) throws IOException {
        ui.step(Tr.t("核对文件…"));
        try (InputStream in = new BufferedInputStream(src.open(), 1 << 20)) {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] buf = new byte[1 << 20];
            long n = 0, tick = 0;
            int b0 = -1, b1 = -1;
            for (int r; (r = in.read(buf)) > 0; ) {
                if (n == 0 && r >= 2) { b0 = buf[0] & 0xff; b1 = buf[1] & 0xff; }
                md.update(buf, 0, r);
                n += r;
                if (n - tick > (8 << 20)) { tick = n; ui.bytes(n, total); }
            }
            ui.bytes(n, total);
            if (n < 1024) throw new IOException(Tr.t("文件太小，不是工具包"));
            return new String[]{hex(md.digest()), b0 == 0x1f && b1 == 0x8b ? "gz" : "tar"};
        } catch (java.security.NoSuchAlgorithmException e) { throw new IOException(e); }
    }

    /** 从流解包安装。tarSha 非空时边解边核，对不上整个丢掉、旧工具包不动（读两遍之间文件被换掉也拦得住） */
    void installDevkit(InputStream raw, long total, boolean gzip, String base, String sha, String tarSha) throws IOException {
        ui.step(Tr.t("解包开发工具包…"));
        File tmp = usrNew();
        deleteTree(tmp);
        tmp.mkdirs();
        String got = extractInto(tmp, raw, total, gzip, tarSha);
        JSONObject p = new JSONObject();
        try { p.put("base", base == null ? "" : base).put("sha256", sha == null ? "" : sha).put("tarSha256", got); }
        catch (org.json.JSONException ignored) {}
        write(new File(tmp, PENDING), p + "\n");
        swapIn(tmp);
        finish();
    }

    /** 解一个 tar(.gz) 到 dir（叠加，不先清空），边解边算 tar 的 sha256；tarSha 非空时对不上就整个删掉 dir、抛错。返回实得的 sha256 */
    String extractInto(File dir, InputStream raw, long total, boolean gzip, String tarSha) throws IOException {
        Counting in = new Counting(new BufferedInputStream(raw, 1 << 20), total);
        MessageDigest md;
        try { md = MessageDigest.getInstance("SHA-256"); } catch (java.security.NoSuchAlgorithmException e) { throw new IOException(e); }
        java.security.DigestInputStream s = new java.security.DigestInputStream(gzip ? new GZIPInputStream(in, 1 << 16) : in, md);
        try {
            untar(s, dir, "usr/");
            byte[] sink = new byte[1 << 16];
            while (s.read(sink) > 0) { }            // tar 末尾的填充块也算进校验和
        } catch (IOException | RuntimeException e) {     // 畸形包抛的运行时异常也要清掉半成品（审查 v0.5.7 L9）
            deleteTree(dir);
            throw new IOException(Tr.t("解包失败，旧工具包未改动：") + e.getMessage(), e);
        } finally { s.close(); }
        String got = hex(md.digest());
        if (tarSha != null && !tarSha.isEmpty() && !tarSha.equals(got)) {
            deleteTree(dir);
            throw new IOException(Tr.f("解出来的内容与清单不符（tar sha256 期望 {0}…，实得 {1}…），旧工具包未改动", tarSha.substring(0, 12), got.substring(0, 12)));
        }
        return got;
    }

    // ── 模块化工具包（0.3.9 起）：基础块 + 选中的模块一起解到 usr.new，全部核过才换上 ──
    // modules.json 来自 APK 的钉子（首装）或 GitHub Release（更新，验过 ed25519 签名），里面有每块 gz / tar 的 sha256；下载源不需要被信任。
    // 每块的 first-run 与 MANIFEST 在它的 dir（基础块是 libexec/devkit，其余 libexec/devkit/modules/<id>）；
    // 装好的块在 dir 里写 .ok。之后单个模块的加装 / 卸载由网关（gw/modules.mjs）做。
    static final String MODULES_JSON = "libexec/devkit/modules.json";

    /** 依赖闭包，按依赖顺序（基础块在最前）。不认识的 id 抛错 */
    static java.util.List<JSONObject> moduleOrder(JSONObject mj, java.util.Collection<String> want) throws IOException {
        java.util.Map<String, JSONObject> by = new java.util.LinkedHashMap<>();
        org.json.JSONArray all = mj.optJSONArray("modules");
        if (all == null) throw new IOException(Tr.t("模块清单坏了"));
        for (int i = 0; i < all.length(); i++) { JSONObject m = all.optJSONObject(i); if (m != null) by.put(m.optString("id"), m); }
        java.util.LinkedHashSet<String> out = new java.util.LinkedHashSet<>();
        java.util.List<String> todo = new java.util.ArrayList<>();
        for (JSONObject m : by.values()) if (m.optBoolean("required")) todo.add(m.optString("id"));
        todo.addAll(want);
        for (String id : todo) addWithDeps(by, id, out, new java.util.HashSet<>());
        java.util.List<JSONObject> r = new java.util.ArrayList<>();
        for (String id : out) r.add(by.get(id));
        return r;
    }
    private static void addWithDeps(java.util.Map<String, JSONObject> by, String id, java.util.Set<String> out, java.util.Set<String> path) throws IOException {
        if (out.contains(id)) return;
        JSONObject m = by.get(id);
        if (m == null) throw new IOException(Tr.f("模块清单里没有：{0}", id));
        if (!path.add(id)) throw new IOException(Tr.f("模块依赖成环：{0}", id));
        org.json.JSONArray d = m.optJSONArray("deps");
        if (d != null) for (int i = 0; i < d.length(); i++) addWithDeps(by, d.optString(i), out, path);
        out.add(id);
    }

    /**
     * 装模块化工具包（首装，或整包 / 旧快照换成这一份）。
     * @param mjBytes modules.json 原文（调用方已核过来源：钉子的 sha256 或 modules.json.sig 签名）
     * @param want 用户勾的模块（基础块和依赖自动带上）
     * @param base Release 目录（GitHub）；identity 这份快照整包 gz 的 sha256（写进 .devkit-ok，组件按它匹配）
     * @param mirrorFirst 先走 dl.cccodroid.net 镜像
     */
    void installModules(byte[] mjBytes, java.util.Collection<String> want, String base, String identity, boolean mirrorFirst) throws IOException {
        JSONObject mj;
        try { mj = new JSONObject(new String(mjBytes, StandardCharsets.UTF_8)); } catch (org.json.JSONException e) { throw new IOException(Tr.t("模块清单坏了"), e); }
        java.util.List<JSONObject> order = moduleOrder(mj, want);
        long dl = 0, unpacked = 0;
        for (JSONObject m : order) {
            JSONObject gz = m.optJSONObject("gz"), tar = m.optJSONObject("tar");
            if (gz == null || tar == null) throw new IOException(Tr.t("模块清单坏了"));
            File have = new File(env.files, gz.optString("file"));
            if (!have.isFile()) dl += gz.optLong("bytes") - new File(have.getPath() + ".part").length();
            unpacked += tar.optLong("bytes");
        }
        // 峰值：还要下的 + 已下的压缩包（解完一块删一块，按全部算）+ 解开后的全部 + 余量
        long need = Math.max(0, dl) + unpacked + (400L << 20);
        long free = new android.os.StatFs(env.files.getPath()).getAvailableBytes();
        if (free < need) throw new NoSpace(need, free);
        String tag = base.replaceAll("/+$", ""); tag = tag.substring(tag.lastIndexOf('/') + 1);
        java.util.List<File> gzs = new java.util.ArrayList<>();
        for (JSONObject m : order) {
            JSONObject gz = m.optJSONObject("gz");
            String file = gz.optString("file"), gh = base + file, mirror = DEVKIT_MIRROR + tag + "/" + file;
            ui.step(Tr.f("下载模块「{0}」{1} MB…", moduleName(m), String.valueOf(gz.optLong("bytes") >> 20)));
            gzs.add(download(mirrorFirst ? mirror : gh, mirrorFirst ? gh : mirror, new File(env.files, file), gz.optLong("bytes"), gz.optString("sha256")));
        }
        File tmp = usrNew();
        deleteTree(tmp);
        tmp.mkdirs();
        org.json.JSONArray ids = new org.json.JSONArray();
        for (int i = 0; i < order.size(); i++) {
            JSONObject m = order.get(i);
            ui.step(Tr.f("解包「{0}」…", moduleName(m)));
            File gz = gzs.get(i);
            extractInto(tmp, new FileInputStream(gz), gz.length(), true, m.optJSONObject("tar").optString("sha256"));
            ids.put(m.optString("id"));
        }
        write(new File(tmp, MODULES_JSON), new String(mjBytes, StandardCharsets.UTF_8));
        JSONObject p = new JSONObject();
        try { p.put("base", base).put("sha256", identity == null ? "" : identity).put("modules", ids).put("snapshot", mj.optString("snapshot")); }
        catch (org.json.JSONException ignored) {}
        write(new File(tmp, PENDING), p + "\n");
        swapIn(tmp);
        finish();
        for (File gz : gzs) gz.delete();          // 解完就删
    }

    static String moduleName(JSONObject m) {
        JSONObject n = m.optJSONObject("name");
        if (n == null) return m.optString("id");
        String s = n.optString(Tr.lang().startsWith("zh") ? "zh" : "en", "");
        return s.isEmpty() ? n.optString("zh", m.optString("id")) : s;
    }

    /** 两次换名把新版换上；第二次失败就把旧版换回来 */
    private void swapIn(File tmp) throws IOException {
        File old = usrOld();
        deleteTree(old);
        if (env.usr.exists() && !env.usr.renameTo(old)) throw new IOException(Tr.t("换名失败: ") + env.usr);
        if (!tmp.renameTo(env.usr)) {
            if (old.exists()) old.renameTo(env.usr);
            throw new IOException(Tr.t("换名失败: ") + tmp);
        }
    }

    /** 基础块和给出的各模块依次跑 first-run，再按改动时间剔除本机校验基线（见 pruneManifest）。返回各模块的目录 */
    private java.util.List<File> firstRuns(java.util.List<JSONObject> modList) throws IOException {
        long since = System.currentTimeMillis() - 2000;      // 文件系统时间戳精度留点余量
        ui.step(Tr.t("首次运行配置…"));
        int rc = run(env.bin("bash").getPath(), new File(env.usr, "libexec/devkit/first-run.sh").getPath());
        if (rc != 0) ui.step(Tr.f("（first-run 返回 {0}，不影响使用）", rc));
        java.util.List<File> modDirs = new java.util.ArrayList<>();
        for (JSONObject m : modList) {
            File dir = new File(env.usr, m.optString("dir"));
            modDirs.add(dir);
            File fr = new File(dir, "first-run.sh");
            if (fr.isFile()) {
                ui.step(Tr.f("「{0}」首次配置…", moduleName(m)));
                int r2 = run(env.bin("bash").getPath(), fr.getPath());
                if (r2 != 0) ui.step(Tr.f("（first-run 返回 {0}，不影响使用）", r2));
            }
        }
        // Guile 的编译缓存必须比源码新（哪怕包里两者同一秒），否则 gdb 启动时陷入重编译死循环
        run(env.bin("bash").getPath(), "-c", "find \"$PREFIX/lib/guile\" -name '*.go' -exec touch {} + 2>/dev/null; true");
        pruneManifest(new File(env.usr, MANIFEST), new File(env.usr, LOCAL_MANIFEST), since);
        for (File dir : modDirs) pruneManifest(new File(dir, "MANIFEST"), new File(dir, "MANIFEST.local"), since);
        return modDirs;
    }

    /** 0.4.17 及以前：36 的包首次安装时，first-run 跑在「部署界面与网关」之前，LD_PRELOAD 要的 app/lib/exec-shim-bionic.so
     *  还不在，bash 一起来就报 CANNOT LINK，first-run 整个没跑（postinst、Guile 缓存都缺）。
     *  判据：openssh 的 postinst 在缺主机钥匙时一定会生成 —— 有 openssh、却一把主机钥匙都没有，就是没跑过 */
    boolean firstRunMissed() {
        if (!new File(env.usr, "libexec/devkit/postinst/openssh").isFile()) return false;
        File[] k = new File(env.usr, "etc/ssh").listFiles((d, n) -> n.startsWith("ssh_host_") && n.endsWith("_key"));
        return k == null || k.length == 0;
    }
    /** 补跑一次：基础块 + 已装好的各模块（有 .ok 的） */
    void repairFirstRun() throws IOException {
        java.util.List<JSONObject> modList = new java.util.ArrayList<>();
        JSONObject mj = readModules();
        org.json.JSONArray all = mj == null ? null : mj.optJSONArray("modules");
        if (all != null) for (int i = 0; i < all.length(); i++) {
            JSONObject m = all.optJSONObject(i);
            if (m != null && !"base".equals(m.optString("kind")) && new File(new File(env.usr, m.optString("dir")), ".ok").isFile()) modList.add(m);
        }
        firstRuns(modList);
    }

    /** 换名之后的几步。可重入：中途被打断，下次启动 recover() 会再跑一遍 */
    private void finish() throws IOException {
        File old = usrOld(), pend = new File(env.usr, PENDING);
        JSONObject p;
        try { p = new JSONObject(new String(java.nio.file.Files.readAllBytes(pend.toPath()), StandardCharsets.UTF_8)); }
        catch (Exception e) { p = new JSONObject(); }
        if (old.isDirectory()) carryOverOnce(old);
        new File(env.usr, "tmp").mkdirs();
        env.home.mkdirs();

        // 模块化：其余各块按依赖顺序跑自己的 first-run，再写 .ok（网关据此认「已装」）
        java.util.List<JSONObject> modList = new java.util.ArrayList<>();
        org.json.JSONArray mods = p.optJSONArray("modules");
        JSONObject mj = readModules();
        if (mods != null && mj != null) for (int i = 0; i < mods.length(); i++) {
            JSONObject m = moduleById(mj, mods.optString(i));
            if (m != null && !"base".equals(m.optString("kind"))) modList.add(m);
        }
        java.util.List<File> modDirs = firstRuns(modList);
        writeResolvConf();
        for (File dir : modDirs) write(new File(dir, ".ok"), "{\"at\":" + System.currentTimeMillis() + "}\n");
        try { p.put("at", System.currentTimeMillis()); } catch (org.json.JSONException ignored) {}
        // 这一版的 carryOver 已经按相对路径认主了：告诉网关别对这份工具包做「旧版残留」清理（见 gw/orphans.mjs）
        write(new File(env.files, ".orphans-v1"), "{\"by\":\"installer\",\"at\":" + System.currentTimeMillis() + "}\n");
        write(new File(env.usr, ".devkit-ok"), p + "\n");       // 从这一刻起才算装好
        pend.delete();
        new File(env.files, CARRY_TRY).delete();
        if (old.exists()) { ui.step(Tr.t("清理旧版本…")); deleteTree(old); }
    }

    /** 搬用户自装包的「进行中」标记：放在 files/ 下（不在 usr 里），搬完删掉 */
    static final String CARRY_TRY = ".carry-try", CARRY_KEPT = "usr.old-kept";
    /** 这次收尾跳过了搬家时为 true（给修复账本用） */
    boolean carrySkipped;

    /**
     * carryOver 只试一次（群友报修，0.4.17 魅族 18 / Flyme）：有的机器上 f2fs 的 rename 会卡在内核里不返回（D 状态，
     * 同一时间别的应用的 rename 也卡），进程杀不掉、成了僵尸，App 再也打不开；而 .devkit-pending 还在，下次启动 recover()
     * 又从 carryOver 开始，又卡 —— 自己把自己锁死。rename 没法设超时，所以改成：进去之前落个标记，上一次带着标记死了，
     * 这次就不搬了 —— 旧目录整个换名留给用户（一次顶层 rename），工具包照常装完。搬的只是用户自己 pip / npm -g 装的包，
     * 跳过不影响工具包本身能用。
     */
    private void carryOverOnce(File old) throws IOException {
        File tryF = new File(env.files, CARRY_TRY);
        if (tryF.exists()) {
            carrySkipped = true;
            File kept = new File(env.files, CARRY_KEPT);
            if (kept.exists()) deleteTree(kept);      // 更早留下的那份：工具包已经又换过一版，没用了
            boolean ok = old.renameTo(kept);
            ui.step(ok ? Tr.f("上次搬你自己装的 pip / npm 包时卡住了，这次跳过；原来的目录留在 {0}", kept.getPath())
                       : Tr.t("上次搬你自己装的 pip / npm 包时卡住了，这次跳过"));
            tryF.delete();
            return;
        }
        try (java.io.FileOutputStream o = new java.io.FileOutputStream(tryF)) {
            o.write(("{\"at\":" + System.currentTimeMillis() + "}\n").getBytes(StandardCharsets.UTF_8));
            o.getFD().sync();                          // 要在卡住之前落到盘上，否则下次看不见
        }
        carryOver(old, env.usr);
        tryF.delete();
    }

    /**
     * 启动时先调：上次装工具包被打断的话，把目录收拾到一致状态。
     * @return 动过东西（接着装完了，或者退回了旧版）
     */
    /** 卸载工具包时先换名到这里再删：不能借用 usr.old，那是 recover() 眼里「退回旧版」的信号 */
    File usrTrash() { return new File(env.files, "usr.trash"); }

    /**
     * 卸载开发工具包（设置页「卸载」）：整个 usr 连同装在里面的组件、模块、pip / npm -g 装的东西一起删，
     * 组件记录也删（文件都在 usr 里）。home 里的会话、工作区、登录、设置不动。调用方负责先停网关，删完走首装流程。
     */
    void uninstallDevkit() throws IOException {
        File trash = usrTrash();
        if (trash.exists()) deleteTree(trash);
        if (env.usr.exists() && !env.usr.renameTo(trash)) throw new IOException(Tr.t("换名失败: ") + env.usr);
        ui.step(Tr.t("删除开发工具包文件…"));
        deleteTree(trash);
        deleteTree(new File(env.files, "components"));
        deleteTree(new File(env.files, "devkit-stage"));
    }

    /** 卸载删到一半被打断留下的 usr.trash：启动时顺手删掉 */
    void dropTrash() { deleteTree(usrTrash()); }

    /** 卸载 Claude Code：删掉 install-claude.mjs 装的各个版本，记下「用户卸了」（不再自动装回）。~/.claude 里的登录、会话、设置不动 */
    void uninstallClaude() throws IOException {
        write(env.claudeOffFlag(), "{\"at\":" + System.currentTimeMillis() + "}\n");
        deleteTree(new File(env.home, ".local/share/cccodroid/claude"));
    }

    /** 有没有上次中断留下要收拾的东西。只看不动 —— 没有就别去停网关 */
    boolean needsRecovery() {
        File neu = usrNew(), old = usrOld();
        return neu.exists() || old.exists() || new File(env.usr, PENDING).isFile();
    }

    /** recover() 这次做了什么（给修复账本用）；什么都没做时为 null */
    String recovered;

    boolean recover() throws IOException {
        File neu = usrNew(), old = usrOld();
        boolean did = false;
        recovered = null;
        // 断在两次换名之间：旧版已换下、新版（校验过的）还没换上
        if (!env.usr.exists() && neu.isDirectory() && new File(neu, PENDING).isFile()) {
            if (!neu.renameTo(env.usr)) throw new IOException(Tr.t("换名失败: ") + neu);
            did = true;
            recovered = Tr.t("两次换名之间被打断：把已校验的新版换上");
        }
        if (new File(env.usr, PENDING).isFile()) {
            ui.step(Tr.t("上次的开发工具包更新被打断了，接着完成…"));
            finish();
            recovered = (recovered == null ? "" : recovered + Tr.t("；")) + Tr.t("上次更新在收尾阶段被打断：重跑首次配置并写好校验基线");
            if (carrySkipped) recovered += Tr.t("；上次搬用户自装包时卡住，这次跳过，旧目录留在 usr.old-kept");
            return true;
        }
        if (!env.usr.exists() && old.isDirectory()) { old.renameTo(env.usr); did = true; recovered = Tr.t("新版没换上：退回旧版"); }   // 新版没成：退回旧版
        if (neu.exists()) { deleteTree(neu); did = true; recovered = (recovered == null ? "" : recovered + Tr.t("；")) + Tr.t("删掉解到一半的新版"); }   // 解到一半的残骸
        if (old.exists() && new File(env.usr, ".devkit-ok").isFile()) deleteTree(old);
        return did;
    }

    // ── 完整性：工具包里的 libexec/devkit/MANIFEST 记着每个文件的 sha256 与大小 ──
    static final String MANIFEST = "libexec/devkit/MANIFEST", LOCAL_MANIFEST = ".devkit-manifest";

    /**
     * 本机校验基线：包里的清单 + first-run 的改动。postinst 会删掉个别文件（剔除），也会现场重写一些
     * （例如 git-delta 重新生成补全脚本 —— 按改动时间认出来，按实际内容重记）。tar 里的文件保留了打包时的
     * 修改时间，first-run 写过的才是现在的时间，所以拿 since 一比就分得开。
     */
    private void pruneManifest(File man, File out, long since) {
        if (!man.isFile()) return;
        try {
            StringBuilder sb = new StringBuilder();
            int dropped = 0, rebased = 0;
            for (String l : java.nio.file.Files.readAllLines(man.toPath(), StandardCharsets.UTF_8)) {
                String[] f = l.split(" ", 3);
                if (f.length != 3) continue;
                File file = new File(env.usr, f[2]);
                if (!file.isFile()) { dropped++; continue; }
                if (file.lastModified() >= since) {
                    String h = sha256(file);
                    if (!h.equals(f[0])) { l = h + " " + file.length() + " " + f[2]; rebased++; }
                }
                sb.append(l).append('\n');
            }
            write(out, sb.toString());
            if (dropped + rebased > 0) ui.step(Tr.f("（首次配置删掉 {0} 个、改写 {1} 个文件，校验基线已按实际情况记下）", dropped, rebased));
        } catch (IOException e) { ui.step(Tr.f("（校验基线没写成：{0}）", e.getMessage())); }
    }

    /** 已装工具包的 modules.json；整包工具包没有，返回 null */
    JSONObject readModules() {
        try { return new JSONObject(new String(java.nio.file.Files.readAllBytes(new File(env.usr, MODULES_JSON).toPath()), StandardCharsets.UTF_8)); }
        catch (Exception e) { return null; }
    }
    static JSONObject moduleById(JSONObject mj, String id) {
        org.json.JSONArray a = mj.optJSONArray("modules");
        if (a != null) for (int i = 0; i < a.length(); i++) { JSONObject m = a.optJSONObject(i); if (m != null && id.equals(m.optString("id"))) return m; }
        return null;
    }

    /** 用户可能自己动的地方：配置、pip / npm 装的包。改了不算坏，只有"缺了"才算 */
    private static boolean userTouchable(String rel) {
        return rel.startsWith("etc/") || rel.startsWith("glibc/etc/") || rel.startsWith("var/")
            || rel.matches("lib/python3\\.\\d+/site-packages/.*") || rel.startsWith("lib/node_modules/");
    }

    /**
     * 核对已装工具包。full=false 只看文件在不在（几秒）；full=true 逐个算 sha256（一两分钟）。
     * @return {manifest, total, missing, changed, samples[]}；manifest=false 表示这一版工具包没带清单
     */
    JSONObject verifyDevkit(boolean full) throws Exception {
        JSONObject r = new JSONObject();
        File man = new File(env.usr, LOCAL_MANIFEST);
        if (!man.isFile()) man = new File(env.usr, MANIFEST);
        if (!man.isFile()) return r.put("manifest", false);
        java.util.List<String> lines = new java.util.ArrayList<>(java.nio.file.Files.readAllLines(man.toPath(), StandardCharsets.UTF_8));
        // 模块化：再加上已装各块的清单（first-run 改过的按 MANIFEST.local）
        JSONObject mj = readModules();
        org.json.JSONArray all = mj == null ? null : mj.optJSONArray("modules");
        if (all != null) for (int k = 0; k < all.length(); k++) {
            JSONObject m = all.optJSONObject(k);
            if (m == null || "base".equals(m.optString("kind"))) continue;
            File dir = new File(env.usr, m.optString("dir"));
            if (!new File(dir, ".ok").isFile()) continue;
            File mf = new File(dir, "MANIFEST.local");
            if (!mf.isFile()) mf = new File(dir, "MANIFEST");
            if (mf.isFile()) lines.addAll(java.nio.file.Files.readAllLines(mf.toPath(), StandardCharsets.UTF_8));
        }
        int missing = 0, changed = 0, i = 0;
        long bytes = 0, doneBytes = 0;
        for (String l : lines) { String[] f = l.split(" ", 3); if (f.length == 3) bytes += Long.parseLong(f[1]); }
        org.json.JSONArray samples = new org.json.JSONArray();
        for (String l : lines) {
            String[] f = l.split(" ", 3);
            if (f.length != 3) continue;
            i++;
            String rel = f[2];
            long size = Long.parseLong(f[1]);
            File file = new File(env.usr, rel);
            boolean bad = false, gone = !file.isFile();
            if (userTouchable(rel)) gone = false;
            else if (gone) { missing++; bad = true; }
            else if (full && !userTouchable(rel) && (file.length() != size || !f[0].equals(sha256(file)))) { changed++; bad = true; }
            if (bad && samples.length() < 12) samples.put((gone ? Tr.t("缺失 ") : Tr.t("改动 ")) + rel);
            doneBytes += full ? size : 0;
            if ((i & 255) == 0) ui.bytes(full ? doneBytes : i, full ? bytes : lines.size());
        }
        return r.put("manifest", true).put("total", i).put("missing", missing).put("changed", changed).put("samples", samples);
    }

    static String hex(byte[] d) {
        StringBuilder sb = new StringBuilder();
        for (byte b : d) sb.append(String.format("%02x", b));
        return sb.toString();
    }

    /**
     * 更新工具包时，把用户自己装进 $PREFIX 的东西搬到新目录：pip（不带 --user）、npm -g 装的包和它们的命令。
     * 判断"用户自己装的"：不在旧工具包任何一个包的文件清单（var/lib/dpkg/info/*.list）里，且新工具包里没有同名的。
     * Python 小版本变了就不搬 site-packages（编译过的扩展对不上新解释器）。
     */
    private void carryOver(File old, File neu) {
        java.util.Set<String> owned = new java.util.HashSet<>();
        File[] lists = new File(old, "var/lib/dpkg/info").listFiles((d, n) -> n.endsWith(".list"));
        if (lists != null) for (File l : lists) {
            // 清单里写的是 /data/data/<包名>/files/usr/…，而 env.usr 是 /data/user/0/…：只比 usr/ 之后的相对路径。
            // 0.3.9 及以前直接拿绝对路径比，一条都对不上，旧工具包和旧组件 bin/ 下的东西全被当成用户的搬了过来
            try {
                for (String line : java.nio.file.Files.readAllLines(l.toPath())) {
                    int i = line.indexOf("/files/usr/");
                    if (i >= 0) owned.add(line.trim().substring(i + 11));
                }
            }
            catch (IOException ignored) {}
        }
        java.util.List<String> dirs = new java.util.ArrayList<>(java.util.Arrays.asList("bin", "lib/node_modules"));
        File[] py = new File(old, "lib").listFiles((d, n) -> n.matches("python3\\.\\d+"));
        if (py != null) for (File p : py) if (new File(neu, "lib/" + p.getName()).isDirectory()) dirs.add("lib/" + p.getName() + "/site-packages");
        int n = 0;
        for (String d : dirs) {
            File[] kids = new File(old, d).listFiles();
            if (kids == null) continue;
            for (File k : kids) {
                String rel = d + "/" + k.getName();
                if (owned.contains(rel)) continue;
                File to = new File(neu, rel);
                if (to.exists() || isSymlink(to)) continue;
                to.getParentFile().mkdirs();
                if (k.renameTo(to)) n++;
            }
        }
        if (n > 0) ui.step(Tr.f("保留了你自己装进工具包的 {0} 项（pip / npm -g 等）", n));
    }

    /** glibc 版程序（官方 Claude Code）解析域名靠它；安卓没有 /etc/resolv.conf */
    private void writeResolvConf() throws IOException {
        File etc = new File(env.usr, "glibc/etc");
        etc.mkdirs();
        write(new File(etc, "resolv.conf"), "nameserver 8.8.8.8\nnameserver 1.1.1.1\nnameserver 223.5.5.5\n");
        File hosts = new File(etc, "hosts");
        if (!hosts.exists()) write(hosts, "127.0.0.1 localhost\n::1 localhost\n");
    }

    // ── 官方 Claude Code ───────────────────────────────────────────────
    /** ver：stable / latest / 具体版本号 —— 按设置里选的装，别先装个 stable 再让自动更新换掉（白下一次约 275 MB） */
    void installClaude(File script, String ver) throws IOException {
        ui.step(Tr.t("从官方渠道下载 Claude Code…"));
        int rc = run(env.bin("bash").getPath(), script.getPath(), ver);
        if (rc != 0 || !env.claudeReady()) throw new IOException(Tr.f("Claude Code 安装失败（rc={0}）", rc));
    }

    int run(String... cmd) throws IOException {
        ProcessBuilder pb = new ProcessBuilder(env.cmd(cmd));
        env.apply(pb.environment());
        pb.directory(env.home);
        pb.redirectErrorStream(true);
        Process p = pb.start();
        BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8));
        for (String l; (l = r.readLine()) != null; ) {
            // 脚本用 "@progress 已下 总量" 报进度：画进度条，不进日志
            if (l.startsWith("@progress ")) {
                String[] p2 = l.split(" ");
                try { ui.bytes(Long.parseLong(p2[1]), Long.parseLong(p2[2])); } catch (Exception ignored) {}
                continue;
            }
            ui.step(l);
        }
        try { return p.waitFor(); } catch (InterruptedException e) { throw new IOException(e); }
    }

    // ── tar（ustar + GNU 长名 + pax）────────────────────────────────────
    private void untar(InputStream in, File root, String strip) throws IOException {
        byte[] h = new byte[512];
        String longName = null, longLink = null;
        String rootPath = root.getCanonicalPath();
        while (true) {
            if (!readFully(in, h)) break;
            if (allZero(h)) break;
            long size = octal(h, 124, 12);
            if (size < 0) throw new IOException(Tr.t("tar 损坏：头记录大小不对"));
            char type = (char) (h[156] == 0 ? '0' : h[156]);
            int mode = (int) Math.max(0, octal(h, 100, 8));
            long mtime = Math.max(0, octal(h, 136, 12));
            if (type == 'L' || type == 'K' || type == 'x' || type == 'g') {
                byte[] body = readBody(in, size);
                if (type == 'L') longName = cstr(body, 0, body.length);
                else if (type == 'K') longLink = cstr(body, 0, body.length);
                else if (type == 'x') {
                    // 长度是字节数（含中文的路径一个字三字节）：在字节上往前走，切出一条再按 UTF-8 解（#104 05-006）
                    for (int i = 0; i < body.length; ) {
                        int sp = i, len;
                        while (sp < body.length && body[sp] != ' ') sp++;
                        // 每条是「长度 空格 键=值 换行」：长度读不出、不往前走、越过结尾都算坏包，抛 IOException 走清理
                        try { len = Integer.parseInt(new String(body, i, sp - i, StandardCharsets.US_ASCII)); } catch (RuntimeException e) { throw new IOException(Tr.t("tar 损坏：pax 记录格式不对")); }
                        if (sp >= body.length || len <= sp - i + 1 || i + len > body.length) throw new IOException(Tr.t("tar 损坏：pax 记录格式不对"));
                        String kv = new String(body, sp + 1, i + len - 1 - (sp + 1), StandardCharsets.UTF_8);
                        int eq = kv.indexOf('=');
                        if (kv.startsWith("path=")) longName = kv.substring(eq + 1);
                        if (kv.startsWith("linkpath=")) longLink = kv.substring(eq + 1);
                        i += len;
                    }
                }
                continue;
            }
            String prefix = cstr(h, 345, 155);
            String name = longName != null ? longName : (prefix.isEmpty() ? "" : prefix + "/") + cstr(h, 0, 100);
            String link = longLink != null ? longLink : cstr(h, 157, 100);
            longName = longLink = null;
            if (name.startsWith("./")) name = name.substring(2);
            if (!name.startsWith(strip)) { skip(in, size); continue; }
            name = name.substring(strip.length());
            if (name.isEmpty() || name.equals("/")) { skip(in, size); continue; }
            File f = new File(root, name);
            // 比前缀要带上分隔符：只比 rootPath 的话 usr.newEvil/x 也算在 usr 里头（审查 低5）
            // 链接条目查的是它「放在哪」（父目录），指向哪不限：工具包里本来就有指到 usr 外的链接，顺着它写文件时上面这条照样拦（审查 10-29 L11）
            if (!inside(type == '2' ? f.getParentFile() : f, rootPath)) throw new IOException(Tr.t("越界条目: ") + name);
            try {
                switch (type) {
                    case '5':
                        f.mkdirs();
                        Os.chmod(f.getPath(), (mode & 0777) | 0700);
                        break;
                    case '2':
                        f.getParentFile().mkdirs();
                        f.delete();
                        Os.symlink(link, f.getPath());
                        break;
                    case '1': {
                        String target = link.startsWith("./") ? link.substring(2) : link;
                        if (target.startsWith(strip)) target = target.substring(strip.length());
                        File tf = new File(root, target);
                        if (!inside(tf, rootPath)) throw new IOException(Tr.t("越界条目: ") + name);
                        f.getParentFile().mkdirs();
                        f.delete();
                        Os.link(tf.getPath(), f.getPath());
                        break;
                    }
                    case '0': case '7': {
                        f.getParentFile().mkdirs();
                        try (OutputStream o = new FileOutputStream(f)) { copy(in, o, size); }
                        pad(in, size);
                        Os.chmod(f.getPath(), (mode & 0777) | 0600);
                        // 保留包里的修改时间。不保留的话一律是解包那一刻，先后全凭解包顺序 ——
                        // gdb 内嵌的 Guile 一看 .scm 比编译好的 .go 新，就逐个重编译（而编译器本身用不了），
                        // 表现为 gdb 任何参数都无输出、原地空转烧 CPU。make 之类按时间戳判断的工具也会被搅乱。
                        if (mtime > 0) f.setLastModified(mtime * 1000);
                        continue;
                    }
                    default:
                        break;
                }
            } catch (android.system.ErrnoException e) {
                throw new IOException(name + ": " + e.getMessage());
            }
            skip(in, size);
        }
    }

    private static boolean inside(File f, String rootPath) throws IOException {
        String p = f.getCanonicalPath();
        return p.equals(rootPath) || p.startsWith(rootPath + File.separator);
    }

    private static boolean readFully(InputStream in, byte[] b) throws IOException {
        int off = 0;
        while (off < b.length) {
            int n = in.read(b, off, b.length - off);
            if (n < 0) { if (off == 0) return false; throw new IOException(Tr.t("tar 截断")); }
            off += n;
        }
        return true;
    }
    // 长名 / pax 记录读进内存：大小先夹住。负数、超大的直接当坏包（以前 (int) 截断成负数抛的是
    // NegativeArraySizeException，不是 IOException，躲过了解包失败时的清理，审查 v0.5.7 L9）
    private static byte[] readBody(InputStream in, long size) throws IOException {
        if (size < 0 || size > 1 << 20) throw new IOException(Tr.t("tar 损坏：头记录大小不对"));
        byte[] b = new byte[(int) size];
        readFully(in, b);
        pad(in, size);
        return b;
    }
    private static void copy(InputStream in, OutputStream o, long size) throws IOException {
        byte[] buf = new byte[1 << 16];
        while (size > 0) {
            int n = in.read(buf, 0, (int) Math.min(buf.length, size));
            if (n < 0) throw new IOException(Tr.t("tar 截断"));
            o.write(buf, 0, n);
            size -= n;
        }
    }
    private static void skip(InputStream in, long size) throws IOException {
        long n = (size + 511) / 512 * 512;
        byte[] buf = new byte[8192];
        while (n > 0) { int r = in.read(buf, 0, (int) Math.min(buf.length, n)); if (r < 0) throw new IOException(Tr.t("tar 截断")); n -= r; }
    }
    private static void pad(InputStream in, long size) throws IOException {
        long r = size % 512;
        if (r != 0) { byte[] z = new byte[(int) (512 - r)]; readFully(in, z); }
    }
    private static boolean allZero(byte[] b) { for (byte x : b) if (x != 0) return false; return true; }
    private static long octal(byte[] b, int off, int len) {
        long v = 0;
        for (int i = off; i < off + len; i++) {
            int c = b[i];
            if (c == 0 || c == ' ') { if (v != 0) break; else continue; }
            if (c < '0' || c > '7') return -1;           // 不是八进制数字（或 GNU 的 base-256 大文件编码）：交给调用处当坏包
            v = v * 8 + (c - '0');
        }
        return v;
    }
    private static String cstr(byte[] b, int off, int len) {
        int end = off;
        while (end < off + len && b[end] != 0) end++;
        return new String(b, off, end - off, StandardCharsets.UTF_8);
    }

    static void write(File f, String s) throws IOException {
        try (OutputStream o = new FileOutputStream(f)) { o.write(s.getBytes(StandardCharsets.UTF_8)); }
    }

    static void deleteTree(File f) {
        if (f == null || !f.exists() && !isSymlink(f)) return;
        if (f.isDirectory() && !isSymlink(f)) {
            File[] kids = f.listFiles();
            if (kids != null) for (File k : kids) deleteTree(k);
        }
        f.delete();
    }
    private static boolean isSymlink(File f) {
        try { return (Os.lstat(f.getPath()).st_mode & 0170000) == 0120000; }
        catch (Exception e) { return false; }
    }

    /** 统计已读字节，给进度条用 */
    private final class Counting extends InputStream {
        private final InputStream in; private final long total; private long done, lastTick;
        Counting(InputStream in, long total) { this.in = in; this.total = total; }
        @Override public int read() throws IOException { int b = in.read(); if (b >= 0) tick(1); return b; }
        @Override public int read(byte[] b, int o, int l) throws IOException { int n = in.read(b, o, l); if (n > 0) tick(n); return n; }
        private void tick(int n) {
            done += n;
            if (done - lastTick > (4 << 20) || done == total) { lastTick = done; ui.bytes(done, total); }
        }
        @Override public void close() throws IOException { in.close(); }
    }
}
