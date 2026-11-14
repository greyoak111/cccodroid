package cc.codroid;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.hardware.biometrics.BiometricManager;
import android.hardware.biometrics.BiometricPrompt;
import android.os.Build;
import android.os.CancellationSignal;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyInfo;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.util.Log;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.Signature;
import java.util.ArrayDeque;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 用户点过头的安全开关（特权命令免确认、保活增强、设备工具总开关、读屏模式）存在哪。
 *
 * 以前直接放 SharedPreferences：那是本应用 uid 的普通文件，工具链里跑的任何脚本都能把 noask 改成 true，
 * 下次应用启动就当成「用户同意过」（11-03 独立审查 H-2）。现在：
 *   · 用户在原生对话框里点「允许」→ 本次运行立即生效（只记在内存里，别的进程改不了）；
 *   · 接着弹系统的锁屏验证，验过了用 Keystore 里一把「每次使用都要验证锁屏」的钥匙给这条同意签名，存盘。
 *     下次启动凭签名恢复；没签名、签名不对，就当没同意过；
 *   · 只认本机生成、要求每次验证（有效期 0）的钥匙：同 uid 的代码导入自己的钥匙（origin 不是 GENERATED），
 *     或生成一把「解锁后若干秒内可用」的钥匙蹭用户日常解锁，都过不了验签；
 *   · 验签用的公钥不信 entry 上的证书（同 uid 能 setKeyEntry 换成自己的，11-04 报告 A1），只信硬件密钥认证链：
 *     链到 Google 认证根、扩展里写明每次验证 / 本机生成 / 本应用 / challenge 对得上，规则见 KeyAttest；
 *   · 关掉 = 删掉这条的钥匙，之前留下的签名一起作废：旧链和旧签名放回新生成的 entry 上，创建时间对不上，翻不了案。
 * 安卓 11 以下、没设锁屏、或这台设备做不了硬件密钥认证（没有 Google 根、KeyMint 以前的老硬件）：
 * 签不了，只在本次运行有效。以前存的同意没有认证链，升级后要重新打开一次。
 */
final class Consent {
    static final String TAG = "cccodroid-consent";
    static final String NOASK = "noask", KEEPALIVE = "keepalive", DEV_ON = "dev.on", DEV_A11Y = "dev.a11y", WEBDEBUG = "webdebug", SHZ_AUTO = "shz.autostart";
    private static final String PREFS = "consent", ALIAS = "cc_consent_";
    /** 本次运行确认过或验过签的：名字 → 值 */
    private static final Map<String, String> MEM = new ConcurrentHashMap<>();
    /** 等着弹锁屏验证去签名的（只由 grant 放进来，外面没法塞） */
    private static final ArrayDeque<String[]> PENDING = new ArrayDeque<>();
    private static final Object LOCK = new Object();
    /** Google 硬件密钥认证根的公钥（SubjectPublicKeyInfo 的 SHA-256）：RSA 老根，和 2025 年起的 EC P-384 根。
     *  取自 https://android.googleapis.com/attestation/root（11-04） */
    static final java.util.Set<String> ROOTS = new java.util.HashSet<>(java.util.Arrays.asList(
        "feb2ea7551ee316ed4bb443c8293b884dbfdea40b603ee3e4f4a897e4580fbae",
        "3ee44512a1af2beb39c889490c60ea3f82e43f5d5a5532f5ab9419f676cd07ec"));

    private static SharedPreferences sp(Context c) { return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE); }
    private static byte[] msg(Context c, String name, String value) {
        return (c.getPackageName() + "\0consent\0" + name + "\0" + value).getBytes(StandardCharsets.UTF_8);
    }
    /** 生成钥匙时放进认证扩展的 challenge：绑定这条同意的名字和值 */
    private static byte[] challenge(Context c, String name, String value) throws Exception {
        return java.security.MessageDigest.getInstance("SHA-256").digest(msg(c, name, value));
    }
    /** 这条的认证链验不验得过：过了返回叶子证书，不过返回 null（原因进日志） */
    private static java.security.cert.X509Certificate attested(Context c, KeyStore ks, String name, String value) throws Exception {
        java.security.cert.Certificate[] ch = ks.getCertificateChain(ALIAS + name);
        java.util.Date d = ks.getCreationDate(ALIAS + name);
        if (ch == null || d == null) { Log.w(TAG, name + " 没有认证链"); return null; }
        java.security.cert.X509Certificate[] x = new java.security.cert.X509Certificate[ch.length];
        for (int i = 0; i < ch.length; i++) {
            if (!(ch[i] instanceof java.security.cert.X509Certificate)) return null;
            x[i] = (java.security.cert.X509Certificate) ch[i];
        }
        String why = KeyAttest.check(x, ROOTS, challenge(c, name, value), c.getPackageName(), d.getTime());
        if (!why.isEmpty()) { Log.w(TAG, name + " 的认证链验不过：" + why); return null; }
        return x[0];
    }

    /** 当前值；没同意过（或签名验不过）返回 null */
    static String get(Context c, String name) {
        String v = MEM.get(name);
        if (v != null) return v;
        synchronized (LOCK) {
            v = MEM.get(name);
            if (v != null) return v;
            SharedPreferences p = sp(c);
            String val = p.getString("v." + name, null), sig = p.getString("s." + name, null);
            if (val == null || sig == null) return null;
            if (!verify(c, name, val, sig)) { Log.w(TAG, name + " 的签名验不过，当作没同意"); return null; }
            MEM.put(name, val);
            return val;
        }
    }
    static boolean on(Context c, String name) { return get(c, name) != null; }

    /** 能不能存到下次启动：安卓 11+（每次验证的钥匙 + 锁屏密码验证）且设了锁屏 */
    static boolean persistable(Context c) {
        if (Build.VERSION.SDK_INT < 30) return false;
        KeyguardManager km = c.getSystemService(KeyguardManager.class);
        return km != null && km.isDeviceSecure();
    }

    /**
     * 用户刚在 cccodroid 自己的原生对话框里点了「允许」之后调（别的地方别调：这里不再问）。
     * 本次运行立即生效；能签名就排队弹锁屏验证，验过了存到下次启动
     */
    static void grant(Context c, String name, String value) {
        synchronized (LOCK) {
            MEM.put(name, value);
            // 旧签名先作废：值变了（读屏 自动 → 常开）不能让旧的那份还验得过
            dropSaved(c, name);
            if (!persistable(c)) return;
            PENDING.removeIf((x) -> x[0].equals(name));
            PENDING.add(new String[]{name, value});
        }
        try { c.startActivity(MainActivity.internal(c, MainActivity.ACTION_CONSENT).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)); }
        catch (Exception e) { Log.w(TAG, "弹不出锁屏验证", e); }
    }

    /** 关掉：内存、存档、钥匙一起清。不用验证 */
    static void revoke(Context c, String name) {
        synchronized (LOCK) {
            MEM.remove(name);
            PENDING.removeIf((x) -> x[0].equals(name));
            dropSaved(c, name);
        }
    }

    private static void dropSaved(Context c, String name) {
        sp(c).edit().remove("v." + name).remove("s." + name).commit();
        try { KeyStore ks = KeyStore.getInstance("AndroidKeyStore"); ks.load(null); ks.deleteEntry(ALIAS + name); }
        catch (Exception e) { Log.w(TAG, "删钥匙失败 " + name, e); }
    }

    /** 老版本明文存的开关：一律不认（就是审查说的能被伪造的那份），删掉。返回删掉了几项，给更新说明 / 日志用 */
    static int dropLegacy(Context c) {
        int n = 0;
        SharedPreferences pr = c.getSharedPreferences("priv", Context.MODE_PRIVATE), dv = c.getSharedPreferences(DeviceTools.PREFS, Context.MODE_PRIVATE);
        if (pr.contains("noask") || pr.contains("keepalive")) { n += (pr.getBoolean("noask", false) ? 1 : 0) + (pr.getBoolean("keepalive", false) ? 1 : 0); pr.edit().remove("noask").remove("keepalive").commit(); }
        if (dv.contains("on") || dv.contains("a11y") || dv.contains("a11yOk")) { n += (dv.getBoolean("on", false) ? 1 : 0) + ("off".equals(dv.getString("a11y", "off")) ? 0 : 1); dv.edit().remove("on").remove("a11y").remove("a11yOk").commit(); }
        if (n > 0) Log.w(TAG, "老版本明文存的 " + n + " 项同意已作废，要重新打开");
        return n;
    }

    private static String label(String name, String value) {
        switch (name) {
            case NOASK: return Tr.t("特权命令不再逐条确认");
            case KEEPALIVE: return Tr.t("后台保活增强");
            case DEV_ON: return Tr.t("设备工具");
            case WEBDEBUG: return Tr.t("网页调试");
            case DEV_A11Y: return "on".equals(value) ? Tr.t("读屏和点按：常开") : Tr.t("读屏和点按：用时自动开");
        }
        return name;
    }

    // ── 签名（主线程，MainActivity 收到 ACTION_CONSENT 时调）──
    private static boolean running;
    static void runNext(Activity a) {
        try { runNext0(a); }
        catch (Throwable t) {   // 主线程上：任何意外都别把应用带崩（DeepSeek 复核 11-03），这一项只在这次运行有效
            Log.w(TAG, "锁屏签名出错", t);
            synchronized (LOCK) { running = false; }
        }
    }
    private static void runNext0(Activity a) {
        String[] job;
        synchronized (LOCK) {
            if (running) return;
            // 界面正在关：留着等下次界面起来（MainActivity 收到 ACTION_CONSENT 或重新打开时）再问
            if (a.isDestroyed() || a.isFinishing()) return;
            job = PENDING.poll();
            if (job == null) return;
            // 排队期间被关掉了 / 值又变了：不签
            if (!job[1].equals(MEM.get(job[0]))) { a.runOnUiThread(() -> runNext(a)); return; }
            running = true;
        }
        final String name = job[0], value = job[1];
        Signature s;
        try {
            KeyPairGenerator g = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore");
            g.initialize(new KeyGenParameterSpec.Builder(ALIAS + name, KeyProperties.PURPOSE_SIGN | KeyProperties.PURPOSE_VERIFY)
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setUserAuthenticationRequired(true)
                .setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG | KeyProperties.AUTH_DEVICE_CREDENTIAL)
                .setInvalidatedByBiometricEnrollment(false)
                .setAttestationChallenge(challenge(a, name, value))
                .build());
            PrivateKey k = g.generateKeyPair().getPrivate();
            // 先验一遍认证链：这台设备做不了（没有 Google 根等）的话，存了下次也认不了，别让用户白验
            KeyStore ks = KeyStore.getInstance("AndroidKeyStore"); ks.load(null);
            if (attested(a, ks, name, value) == null) {
                try { ks.deleteEntry(ALIAS + name); } catch (Exception ignored) {}
                done(a, Tr.f("这台设备做不了硬件密钥认证，「{0}」只在这次运行有效", label(name, value)));
                return;
            }
            s = Signature.getInstance("SHA256withECDSA");
            s.initSign(k);
        } catch (Exception e) {
            Log.w(TAG, "生成签名钥匙失败", e);
            done(a, Tr.f("没能保存「{0}」，只在这次运行有效：", label(name, value)) + e.getMessage());
            return;
        }
        BiometricPrompt bp = new BiometricPrompt.Builder(a)
            .setTitle(Tr.t("用锁屏验证保存这项设置"))
            .setSubtitle(label(name, value))
            .setDescription(Tr.t("验证后，重启 cccodroid 也会保持打开。不验证的话只在这次运行有效。这样别的程序就改不了这项设置。"))
            .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG | BiometricManager.Authenticators.DEVICE_CREDENTIAL)
            .build();
        try {
            bp.authenticate(new BiometricPrompt.CryptoObject(s), new CancellationSignal(), a.getMainExecutor(), new BiometricPrompt.AuthenticationCallback() {
                @Override public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult r) {
                    try {
                        Signature sg = r.getCryptoObject().getSignature();
                        sg.update(msg(a, name, value));
                        String sig = Base64.encodeToString(sg.sign(), Base64.NO_WRAP);
                        synchronized (LOCK) {
                            // 验证期间用户又把它关了：别存
                            if (value.equals(MEM.get(name))) sp(a).edit().putString("v." + name, value).putString("s." + name, sig).commit();
                        }
                        Log.i(TAG, "已保存 " + name);
                        done(a, Tr.f("已保存：{0}", label(name, value)));
                    } catch (Exception e) { done(a, Tr.t("保存失败，只在这次运行有效：") + e.getMessage()); }
                }
                @Override public void onAuthenticationError(int code, CharSequence m) {
                    done(a, Tr.f("没有验证，「{0}」只在这次运行有效", label(name, value)));
                }
            });
        } catch (java.lang.SecurityException e) { done(a, Tr.t("弹不出锁屏验证（缺少生物识别权限），只在这次运行有效：") + e.getMessage()); }
        catch (Exception e) { done(a, Tr.t("弹不出锁屏验证，只在这次运行有效：") + e.getMessage()); }
    }
    private static void done(Activity a, String toast) {
        synchronized (LOCK) { running = false; }
        a.runOnUiThread(() -> {
            if (a.isDestroyed()) return;
            try { android.widget.Toast.makeText(a, toast, android.widget.Toast.LENGTH_LONG).show(); } catch (Exception ignored) {}
            runNext(a);
        });
    }

    // ── 验签 ──
    private static boolean verify(Context c, String name, String value, String sig) {
        try {
            KeyStore ks = KeyStore.getInstance("AndroidKeyStore"); ks.load(null);
            KeyStore.Entry e = ks.getEntry(ALIAS + name, null);
            if (!(e instanceof KeyStore.PrivateKeyEntry)) return false;
            KeyStore.PrivateKeyEntry pe = (KeyStore.PrivateKeyEntry) e;
            KeyInfo ki = KeyFactory.getInstance(pe.getPrivateKey().getAlgorithm(), "AndroidKeyStore").getKeySpec(pe.getPrivateKey(), KeyInfo.class);
            if (!keyOk(ki.getOrigin(), ki.isUserAuthenticationRequired(), ki.getUserAuthenticationValidityDurationSeconds())) return false;
            // entry 上的证书同 uid 能换，只信认证链验过的叶子公钥
            java.security.cert.X509Certificate leaf = attested(c, ks, name, value);
            if (leaf == null) return false;
            Signature s = Signature.getInstance("SHA256withECDSA");
            s.initVerify(leaf.getPublicKey());
            s.update(msg(c, name, value));
            return s.verify(Base64.decode(sig, Base64.NO_WRAP));
        } catch (Exception ex) { Log.w(TAG, "验签出错 " + name, ex); return false; }
    }
    /** 规则在 PrivRules（好在宿主上测） */
    static boolean keyOk(int origin, boolean authRequired, int validitySec) {
        return PrivRules.consentKeyOk(origin, authRequired, validitySec);
    }
}
