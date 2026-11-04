package cc.codroid;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.math.BigInteger;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.Signature;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.security.spec.ECGenParameterSpec;
import java.util.Collections;
import java.util.Set;

/**
 * KeyAttest 回归：现场合成认证链（不放真机证书，免得把设备信息带进仓库），一项项改坏看拒不拒。
 * 真机链另在本机验过（Google RSA 根、TEE、KeyMint 100）。sh scripts/java-tests.sh 跑
 */
public final class KeyAttestTest {
    static int fail = 0;
    static final String PKG = "cc.codroid";
    static final byte[] CHAL = "challenge-0123456789abcdef".getBytes();
    static final long CREATED = 1793788493719L;

    // ── 最小 DER 写入 ──
    static byte[] tlv(int tag, byte[]... parts) { return tlvL(new byte[]{(byte) tag}, parts); }
    static byte[] tlvL(byte[] tag, byte[]... parts) {
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        for (byte[] p : parts) body.write(p, 0, p.length);
        byte[] b = body.toByteArray();
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        o.write(tag, 0, tag.length);
        int l = b.length;
        if (l < 128) o.write(l);
        else if (l < 256) { o.write(0x81); o.write(l); }
        else { o.write(0x82); o.write(l >> 8); o.write(l & 0xff); }
        o.write(b, 0, b.length);
        return o.toByteArray();
    }
    static byte[] seq(byte[]... p) { return tlv(0x30, p); }
    static byte[] set(byte[]... p) { return tlv(0x31, p); }
    static byte[] integer(long v) { return tlv(0x02, BigInteger.valueOf(v).toByteArray()); }
    static byte[] enumerated(long v) { return tlv(0x0a, BigInteger.valueOf(v).toByteArray()); }
    static byte[] octet(byte[] v) { return tlv(0x04, v); }
    static byte[] bool(boolean v) { return tlv(0x01, new byte[]{(byte) (v ? 0xff : 0)}); }
    static byte[] oid(String dotted) {
        String[] p = dotted.split("\\.");
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        o.write(Integer.parseInt(p[0]) * 40 + Integer.parseInt(p[1]));
        for (int i = 2; i < p.length; i++) {
            long v = Long.parseLong(p[i]);
            byte[] tmp = new byte[10]; int n = 0;
            do { tmp[n++] = (byte) (v & 0x7f); v >>= 7; } while (v > 0);
            for (int j = n - 1; j >= 0; j--) o.write(tmp[j] | (j > 0 ? 0x80 : 0));
        }
        return tlv(0x06, o.toByteArray());
    }
    /** [tag] EXPLICIT（上下文类、构造），标签号可以大于 30 */
    static byte[] ctx(int tag, byte[]... p) {
        if (tag < 31) return tlv(0xa0 | tag, p);
        ByteArrayOutputStream t = new ByteArrayOutputStream();
        t.write(0xbf);
        byte[] tmp = new byte[5]; int n = 0; int v = tag;
        do { tmp[n++] = (byte) (v & 0x7f); v >>= 7; } while (v > 0);
        for (int j = n - 1; j >= 0; j--) t.write(tmp[j] | (j > 0 ? 0x80 : 0));
        return tlvL(t.toByteArray(), p);
    }
    static byte[] cat(byte[]... p) { ByteArrayOutputStream o = new ByteArrayOutputStream(); for (byte[] x : p) o.write(x, 0, x.length); return o.toByteArray(); }

    /** 认证扩展的各个可调项 */
    static final class Desc {
        long attSec = 1, kmSec = 1, alg = 3, origin = 0, authType = 3, created = CREATED;
        long[] purposes = {2, 3};
        byte[] chal = CHAL;
        String pkg = PKG;
        boolean noAuth, timeout, allApps, noCreated, dupTag, createdInHw;
        byte[] build() {
            byte[] sw = cat(
                noCreated || createdInHw ? new byte[0] : ctx(701, integer(created)),
                ctx(709, octet(seq(set(seq(octet(pkg.getBytes()), integer(1))), set(octet(new byte[32]))))));
            byte[][] ps = new byte[purposes.length][];
            for (int i = 0; i < purposes.length; i++) ps[i] = integer(purposes[i]);
            byte[] hw = cat(
                ctx(1, set(ps)), ctx(2, integer(alg)), ctx(3, integer(256)),
                noAuth ? ctx(503, tlv(0x05)) : new byte[0],
                authType >= 0 ? ctx(504, integer(authType)) : new byte[0],
                timeout ? ctx(505, integer(30)) : new byte[0],
                allApps ? ctx(600, tlv(0x05)) : new byte[0],
                createdInHw ? ctx(701, integer(created)) : new byte[0],
                ctx(702, integer(origin)),
                dupTag ? ctx(702, integer(origin)) : new byte[0]);
            return seq(integer(100), enumerated(attSec), integer(100), enumerated(kmSec), octet(chal), octet(new byte[0]), seq(sw), seq(hw));
        }
    }

    static long serial = 1;
    static X509Certificate cert(String subject, String issuer, PublicKey pub, PrivateKey signer, boolean ca, byte[] attest) throws Exception {
        byte[] alg = seq(oid("1.2.840.10045.4.3.2"));
        byte[] exts = cat(
            ca ? seq(oid("2.5.29.19"), bool(true), octet(seq(bool(true)))) : new byte[0],
            seq(oid("2.5.29.15"), bool(true), octet(tlv(0x03, ca ? new byte[]{1, 0x06} : new byte[]{7, (byte) 0x80}))),
            attest == null ? new byte[0] : seq(oid(KeyAttest.OID), octet(attest)));
        byte[] tbs = seq(ctx(0, integer(2)), integer(serial++), alg, name(issuer),
            seq(tlv(0x17, "200101000000Z".getBytes()), tlv(0x17, "491231000000Z".getBytes())),
            name(subject), pub.getEncoded(), ctx(3, seq(exts)));
        Signature s = Signature.getInstance("SHA256withECDSA");
        s.initSign(signer); s.update(tbs);
        byte[] sig = s.sign();
        byte[] der = seq(tbs, alg, tlv(0x03, cat(new byte[]{0}, sig)));
        return (X509Certificate) CertificateFactory.getInstance("X.509").generateCertificate(new ByteArrayInputStream(der));
    }
    static byte[] name(String cn) { return seq(set(seq(oid("2.5.4.3"), tlv(0x0c, cn.getBytes())))); }

    static KeyPair kp() throws Exception {
        KeyPairGenerator g = KeyPairGenerator.getInstance("EC");
        g.initialize(new ECGenParameterSpec("secp256r1"));
        return g.generateKeyPair();
    }

    static KeyPair root, inter, leaf, other;
    static X509Certificate rootCert, interCert;
    static Set<String> pins;

    static X509Certificate[] chain(Desc d) throws Exception {
        return new X509Certificate[]{cert("leaf", "inter", leaf.getPublic(), inter.getPrivate(), false, d.build()), interCert, rootCert};
    }

    static void want(String label, boolean ok, X509Certificate[] ch) { want(label, ok, ch, CREATED + 18); }
    static void want(String label, boolean ok, X509Certificate[] ch, long entryCreated) {
        String r = KeyAttest.check(ch, pins, CHAL, PKG, entryCreated);
        if (r.isEmpty() != ok) { fail++; System.out.println("FAIL " + label + "：" + (r.isEmpty() ? "不该通过" : r)); }
    }

    public static void main(String[] a) throws Exception {
        root = kp(); inter = kp(); leaf = kp(); other = kp();
        rootCert = cert("root", "root", root.getPublic(), root.getPrivate(), true, null);
        interCert = cert("inter", "root", inter.getPublic(), root.getPrivate(), true, null);
        pins = Collections.singleton(KeyAttest.spki(rootCert));

        want("正常的链", true, chain(new Desc()));
        { Desc d = new Desc(); d.attSec = 2; d.kmSec = 2; want("StrongBox", true, chain(d)); }
        { Desc d = new Desc(); d.createdInHw = true; want("创建时间在硬件列表里", true, chain(d)); }
        want("创建时间差 4 秒内", true, chain(new Desc()), CREATED + 4000);

        // 报告 A1 的原样：证书换成自签的
        X509Certificate self = cert("leaf", "leaf", other.getPublic(), other.getPrivate(), false, new Desc().build());
        want("换成自签证书", false, new X509Certificate[]{self});
        want("自签证书冒充两级", false, new X509Certificate[]{self, self});
        // 根不认
        Set<String> keep = pins;
        pins = Collections.singleton("00");
        want("根不在认可列表", false, chain(new Desc()));
        pins = keep;
        // 签名断开：叶子是别的钥匙签的
        want("叶子签名不对", false, new X509Certificate[]{cert("leaf", "inter", leaf.getPublic(), other.getPrivate(), false, new Desc().build()), interCert, rootCert});
        // 拿一把带认证扩展、自己随便能用的钥匙当签发者签假叶子
        { Desc weak = new Desc(); weak.noAuth = true;
          X509Certificate attested = cert("weak", "inter", other.getPublic(), inter.getPrivate(), false, weak.build());
          X509Certificate fake = cert("leaf", "weak", leaf.getPublic(), other.getPrivate(), false, new Desc().build());
          want("非 CA 当签发者", false, new X509Certificate[]{fake, attested, interCert, rootCert});
          X509Certificate attestedCa = cert("weak", "inter", other.getPublic(), inter.getPrivate(), true, weak.build());
          X509Certificate fake2 = cert("leaf", "weak", leaf.getPublic(), other.getPrivate(), false, new Desc().build());
          want("带认证扩展的 CA 当签发者", false, new X509Certificate[]{fake2, attestedCa, interCert, rootCert}); }
        // 叶子扩展的各项
        { Desc d = new Desc(); d.chal = "other".getBytes(); want("challenge 不对", false, chain(d)); }
        { Desc d = new Desc(); d.attSec = 0; want("软件认证", false, chain(d)); }
        { Desc d = new Desc(); d.kmSec = 0; want("软件钥匙", false, chain(d)); }
        { Desc d = new Desc(); d.noAuth = true; want("免验证", false, chain(d)); }
        { Desc d = new Desc(); d.timeout = true; want("限时验证", false, chain(d)); }
        { Desc d = new Desc(); d.allApps = true; want("所有应用可用", false, chain(d)); }
        { Desc d = new Desc(); d.authType = -1; want("没有验证方式", false, chain(d)); }
        { Desc d = new Desc(); d.authType = 0; want("验证方式为 0", false, chain(d)); }
        { Desc d = new Desc(); d.origin = 2; want("导入的钥匙", false, chain(d)); }
        { Desc d = new Desc(); d.alg = 1; want("RSA 钥匙", false, chain(d)); }
        { Desc d = new Desc(); d.purposes = new long[]{3}; want("只能验签", false, chain(d)); }
        { Desc d = new Desc(); d.noCreated = true; want("没有创建时间", false, chain(d)); }
        { Desc d = new Desc(); d.pkg = "com.evil"; want("别的应用", false, chain(d)); }
        { Desc d = new Desc(); d.dupTag = true; want("标签重复", false, chain(d)); }
        // 重放：旧链放到后来新生成的 entry 上
        want("创建时间对不上", false, chain(new Desc()), CREATED + 60_000);
        want("创建时间早于扩展", false, chain(new Desc()), CREATED - 60_000);
        // 乱码扩展不崩
        { X509Certificate junk = cert("leaf", "inter", leaf.getPublic(), inter.getPrivate(), false, new byte[]{0x30, (byte) 0x84, 1, 2, 3, 4});
          want("乱码扩展", false, new X509Certificate[]{junk, interCert, rootCert}); }
        { X509Certificate none = cert("leaf", "inter", leaf.getPublic(), inter.getPrivate(), false, null);
          want("没有扩展", false, new X509Certificate[]{none, interCert, rootCert}); }
        want("空链", false, new X509Certificate[0]);
        want("null", false, null);

        System.out.println(fail == 0 ? "KeyAttest 全部通过" : "KeyAttest 失败 " + fail + " 项");
        if (fail > 0) System.exit(1);
    }
}
