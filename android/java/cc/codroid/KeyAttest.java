package cc.codroid;

import java.math.BigInteger;
import java.security.MessageDigest;
import java.security.cert.X509Certificate;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;

/**
 * 硬件密钥认证（key attestation）的验链规则，给 Consent 用。纯 Java，不碰安卓 API，好在宿主上测（KeyAttestTest）。
 *
 * 为什么要它：AndroidKeyStore 允许同 uid 用 setKeyEntry 把一把钥匙的证书换成任意证书（不核对和私钥配不配），
 * 所以「拿 entry 上的证书公钥验签」挡不住同 uid 的脚本：换一张自签证书、用自己的私钥签，就验得过（11-04 报告 A1）。
 * 现在只认这样一条链：
 *   · 一级级签名验得过，最顶上那把公钥是 Google 的认证根（公钥哈希写死在 Consent）；
 *   · 只有叶子带认证扩展，上面几级都得是 CA 证书——免得拿一把自己能随便用的硬件钥匙当「签发者」去签一张假叶子；
 *   · 叶子扩展（TEE / StrongBox 写的）说：本机生成、EC 签名用、每次使用都要用户验证、challenge 对得上、属于本应用；
 *   · 扩展里系统服务写的创建时间（keystore2 不许调用方自己填）和 Keystore 里这条 entry 的创建时间对得上：
 *     旧链重放到新生成的 entry 上（用户关掉后想翻案）时间对不上。替换证书不改 entry 的创建时间（11-04 本机实测）。
 * 任何一项不满足、或者解析出错，都当验不过。
 */
final class KeyAttest {
    static final String OID = "1.3.6.1.4.1.11129.2.1.17";
    /** 扩展里的创建时间和 entry 的创建时间最多差多少（本机实测差 18ms） */
    static final long SKEW_MS = 5000;

    private KeyAttest() {}

    /** 公钥（SubjectPublicKeyInfo）的 SHA-256 十六进制，根证书按它认 */
    static String spki(X509Certificate c) throws Exception {
        StringBuilder sb = new StringBuilder();
        for (byte x : MessageDigest.getInstance("SHA-256").digest(c.getPublicKey().getEncoded())) sb.append(String.format("%02x", x & 0xff));
        return sb.toString();
    }

    /**
     * 验一条认证链。返回空串 = 通过，否则是原因（只进日志）。
     * @param rootPins 认可的根公钥哈希
     * @param challenge 生成钥匙时放进去的 challenge
     * @param pkg 本应用包名
     * @param entryCreatedMs KeyStore.getCreationDate(alias)
     */
    static String check(X509Certificate[] chain, Set<String> rootPins, byte[] challenge, String pkg, long entryCreatedMs) {
        try { return check0(chain, rootPins, challenge, pkg, entryCreatedMs); }
        catch (Exception | StackOverflowError e) { return "解析出错：" + e; }
    }

    private static String check0(X509Certificate[] chain, Set<String> rootPins, byte[] challenge, String pkg, long entryCreatedMs) throws Exception {
        if (chain == null || chain.length < 2 || chain.length > 10) return "链长度不对";
        for (X509Certificate c : chain) if (c == null) return "链里有空证书";
        // 不查证书有效期：不少设备出厂的认证批次证书早已过期或时间写得离谱，查了会把真设备拒掉；冒充靠的是伪造签名，有效期挡不住。
        // 防的范围：别的应用、改过的同意文件、自签 / 借来的链。挡不住的：本机同 uid 有代码执行时，拿另一台装了本应用的设备
        // 生成真链、卡准 5 秒窗口塞进来——challenge 只由消息推导、app id 只核包名。这已在 SECURITY.md 声明的范围之外
        // 1) 一级级签名；顶上那张自签，且公钥在认可的根里
        for (int i = 0; i < chain.length; i++) {
            X509Certificate issuer = chain[Math.min(i + 1, chain.length - 1)];
            try { chain[i].verify(issuer.getPublicKey()); }
            catch (Exception e) { return "第 " + i + " 级签名验不过"; }
        }
        if (!rootPins.contains(spki(chain[chain.length - 1]))) return "根不是认可的认证根";
        // 2) 叶子以上都得是 CA、不带认证扩展
        for (int i = 1; i < chain.length; i++) {
            if (chain[i].getBasicConstraints() < 0) return "第 " + i + " 级不是 CA";
            boolean[] ku = chain[i].getKeyUsage();
            if (ku != null && (ku.length <= 5 || !ku[5])) return "第 " + i + " 级不能签证书";
            if (chain[i].getExtensionValue(OID) != null) return "第 " + i + " 级带认证扩展";
        }
        if (chain[0].getBasicConstraints() >= 0) return "叶子是 CA";
        // 3) 叶子的认证扩展
        byte[] ext = chain[0].getExtensionValue(OID);
        if (ext == null) return "叶子没有认证扩展";
        Tlv os = rd(ext, 0, ext.length);
        if (os.tag != 4 || os.cls != 0 || os.e != ext.length) return "扩展外层不是 OCTET STRING";
        Tlv kd = rd(ext, os.s, os.e);
        if (kd.tag != 16 || !kd.cons) return "KeyDescription 不是 SEQUENCE";
        Tlv[] f = kids(ext, kd);
        if (f.length < 8) return "KeyDescription 字段不够";
        long attSec = num(ext, f[1], 10), kmSec = num(ext, f[3], 10);
        if (attSec != 1 && attSec != 2) return "认证不是硬件做的（" + attSec + "）";
        if (kmSec != 1 && kmSec != 2) return "钥匙不在硬件里（" + kmSec + "）";
        if (f[4].tag != 4 || f[4].cls != 0) return "challenge 类型不对";
        if (!Arrays.equals(Arrays.copyOfRange(ext, f[4].s, f[4].e), challenge)) return "challenge 对不上";
        Map<Long, Tlv> sw = auth(ext, f[6]), hw = auth(ext, f[7]);
        if (sw == null || hw == null) return "授权列表不对";
        // 不许出现的：免验证、限时验证、所有应用可用
        for (long t : new long[]{503, 505, 600}) if (sw.containsKey(t) || hw.containsKey(t)) return "授权列表里有 [" + t + "]";
        // 必须由硬件保证的：EC、签名用途、本机生成、要用户验证
        if (num(ext, inner(ext, hw.get(2L)), 8) != 3) return "不是 EC 钥匙";
        if (num(ext, inner(ext, hw.get(702L)), 8) != 0) return "不是本机生成的";
        if (num(ext, inner(ext, hw.get(504L)), 8) == 0) return "没有要求用户验证";
        Tlv purpose = inner(ext, hw.get(1L));
        if (purpose.tag != 17 || !purpose.cons) return "用途不是 SET";
        boolean sign = false;
        for (Tlv p : kids(ext, purpose)) if (num(ext, p, 8) == 2) sign = true;
        if (!sign) return "用途里没有签名";
        // 创建时间（系统服务填的，可能在任一列表里）
        Tlv cd = sw.containsKey(701L) ? sw.get(701L) : hw.get(701L);
        if (cd == null) return "没有创建时间";
        long created = num(ext, inner(ext, cd), 8);
        if (Math.abs(created - entryCreatedMs) > SKEW_MS) return "创建时间对不上（" + created + " / " + entryCreatedMs + "）";
        // 属于本应用（AttestationApplicationId：SEQUENCE { SET OF SEQUENCE { OCTET STRING 包名, INTEGER 版本 }, SET OF OCTET STRING 签名摘要 }）
        Tlv aid = sw.get(709L);
        if (aid == null) return "没有应用信息";
        Tlv aos = inner(ext, aid);
        if (aos.tag != 4) return "应用信息类型不对";
        Tlv aseq = rd(ext, aos.s, aos.e);
        if (aseq.tag != 16) return "应用信息不是 SEQUENCE";
        Tlv[] ap = kids(ext, aseq);
        if (ap.length < 1 || ap[0].tag != 17) return "应用信息里没有包列表";
        boolean mine = false;
        byte[] want = pkg.getBytes("UTF-8");
        for (Tlv info : kids(ext, ap[0])) {
            Tlv[] nv = kids(ext, info);
            if (nv.length >= 1 && nv[0].tag == 4 && Arrays.equals(Arrays.copyOfRange(ext, nv[0].s, nv[0].e), want)) mine = true;
        }
        if (!mine) return "不是本应用的钥匙";
        return "";
    }

    // ── 最小 DER 读取（只读这里用到的形状；越界、不定长一律抛） ──
    static final class Tlv {
        final int cls; final boolean cons; final long tag; final int s, e;
        Tlv(int cls, boolean cons, long tag, int s, int e) { this.cls = cls; this.cons = cons; this.tag = tag; this.s = s; this.e = e; }
    }

    static Tlv rd(byte[] b, int o, int lim) {
        if (o >= lim) throw new IllegalArgumentException("越界");
        int t = b[o++] & 0xff;
        int cls = t >> 6; boolean cons = (t & 0x20) != 0; long tag = t & 0x1f;
        if (tag == 0x1f) {
            tag = 0; int x, n = 0;
            do { if (o >= lim || ++n > 4) throw new IllegalArgumentException("标签太长"); x = b[o++] & 0xff; tag = tag * 128 + (x & 0x7f); } while ((x & 0x80) != 0);
        }
        if (o >= lim) throw new IllegalArgumentException("越界");
        int l = b[o++] & 0xff;
        if (l == 0x80) throw new IllegalArgumentException("不定长");
        if ((l & 0x80) != 0) {
            int n = l & 0x7f; if (n > 3) throw new IllegalArgumentException("长度太长");
            l = 0; while (n-- > 0) { if (o >= lim) throw new IllegalArgumentException("越界"); l = l * 256 + (b[o++] & 0xff); }
        }
        if (l < 0 || l > lim - o) throw new IllegalArgumentException("越界");
        return new Tlv(cls, cons, tag, o, o + l);
    }

    static Tlv[] kids(byte[] b, Tlv n) {
        if (!n.cons) throw new IllegalArgumentException("不是构造类型");
        java.util.ArrayList<Tlv> r = new java.util.ArrayList<>();
        for (int o = n.s; o < n.e; ) { Tlv k = rd(b, o, n.e); r.add(k); o = k.e; }
        return r.toArray(new Tlv[0]);
    }

    /** [tag] EXPLICIT 里面那一项（缺了就抛，调用方当验不过） */
    static Tlv inner(byte[] b, Tlv t) {
        if (t == null) throw new IllegalArgumentException("缺项");
        Tlv[] k = kids(b, t);
        if (k.length != 1) throw new IllegalArgumentException("显式标签里不止一项");
        return k[0];
    }

    /** INTEGER 或 ENUMERATED，最多 maxBytes 字节，不许负数 */
    static long num(byte[] b, Tlv t, int maxBytes) {
        if (t.cls != 0 || (t.tag != 2 && t.tag != 10) || t.e == t.s || t.e - t.s > maxBytes + 1) throw new IllegalArgumentException("不是整数");
        BigInteger v = new BigInteger(Arrays.copyOfRange(b, t.s, t.e));
        if (v.signum() < 0 || v.bitLength() > 63) throw new IllegalArgumentException("整数超范围");
        return v.longValue();
    }

    /** AuthorizationList：SEQUENCE OF [tag] EXPLICIT；同一标签出现两次就当坏的 */
    static Map<Long, Tlv> auth(byte[] b, Tlv seq) {
        if (seq.tag != 16 || !seq.cons) return null;
        Map<Long, Tlv> m = new HashMap<>();
        for (Tlv k : kids(b, seq)) {
            if (k.cls != 2 || !k.cons) return null;
            if (m.put(k.tag, k) != null) return null;
        }
        return m;
    }
}
