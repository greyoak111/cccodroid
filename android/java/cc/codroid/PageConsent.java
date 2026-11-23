package cc.codroid;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Context;
import android.os.SystemClock;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.util.Log;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.cert.Certificate;
import java.security.cert.X509Certificate;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.X509EncodedKeySpec;
import java.util.Enumeration;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

/** One authenticated signing authority for one native settings visit. Its private key stays in RAM. */
final class PageConsent {
    private static final String ROOT = "cc_consent_page_", MARKER = "cc_consent_marker_";
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final Set<String> PENDING_ROOTS = new HashSet<>();
    private static final ExecutorService GC = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "page-consent-gc");
        t.setDaemon(true);
        return t;
    });
    private static Visit active;

    private static final class Visit {
        final Activity owner;
        final String id = UUID.randomUUID().toString();
        final Map<String, Ticket> tickets = new LinkedHashMap<>();
        Authority authority;
        boolean prompting;
        boolean stoppedDuringPrompt;

        Visit(Activity owner) { this.owner = owner; }
    }

    private static final class Ticket {
        final String operation, argument;
        final long issuedAt = SystemClock.elapsedRealtime();

        Ticket(String operation, String argument) { this.operation = operation; this.argument = argument; }
    }

    static synchronized void visible(Activity owner, boolean visible) {
        if (visible) {
            if (active == null || active.owner != owner) active = new Visit(owner);
        } else if (active != null && active.owner == owner) active = null;
    }

    static synchronized void onActivityResume(Activity owner) {
        if (active != null && active.owner == owner) active.stoppedDuringPrompt = false;
    }

    /** Preserve an in-flight PIN/pattern credential prompt (which pauses/stops the activity) without keeping stale visits. */
    static synchronized void onLeaveOrStop(Activity owner) {
        if (active == null || active.owner != owner) return;
        if (active.prompting && !owner.isFinishing() && !owner.isDestroyed() && usable(owner)) {
            active.stoppedDuringPrompt = true;
            return;
        }
        active = null;
    }

    static synchronized void setPrompting(Activity owner, String id, boolean prompting) {
        if (active != null && active.owner == owner && active.id.equals(id)) {
            active.prompting = prompting;
            if (prompting) active.stoppedDuringPrompt = false;
        }
    }

    static synchronized void finishPrompt(Activity owner, String id, boolean succeeded) {
        if (active != null && active.owner == owner && active.id.equals(id)) {
            active.prompting = false;
            if (!succeeded && active.stoppedDuringPrompt) active = null;
        }
    }

    static synchronized String ticket(Activity owner, String operation, String argument) {
        if (active == null || active.owner != owner || !usable(owner)) return "";
        if (active.tickets.size() >= 8) active.tickets.remove(active.tickets.keySet().iterator().next());
        String token = UUID.randomUUID().toString();
        active.tickets.put(token, new Ticket(operation, argument));
        return token;
    }

    static synchronized String consume(Context c, String token, String operation, String argument) {
        if (active == null || !usable(c)) return null;
        Ticket ticket = active.tickets.remove(token);
        if (ticket == null || SystemClock.elapsedRealtime() - ticket.issuedAt > 10000
            || !ticket.operation.equals(operation) || !ticket.argument.equals(argument)) return null;
        return active.id;
    }

    static synchronized boolean current(Context c, String id) {
        return active != null && active.id.equals(id) && usable(c);
    }

    private static boolean usable(Context c) {
        KeyguardManager keyguard = c.getSystemService(KeyguardManager.class);
        return keyguard != null && !keyguard.isDeviceLocked();
    }

    static final class Enrollment {
        final String rootId;
        final KeyPair delegate;
        final Signature signing;

        Enrollment(String rootId, KeyPair delegate, Signature signing) {
            this.rootId = rootId;
            this.delegate = delegate;
            this.signing = signing;
        }

        Authority complete(Context c, Signature authenticated) throws Exception {
            byte[] publicKey = delegate.getPublic().getEncoded();
            authenticated.update(proofMessage(c, rootId, publicKey));
            return new Authority(rootId, delegate, authenticated.sign());
        }
    }

    static final class Authority {
        final String rootId;
        final KeyPair delegate;
        final byte[] proof;

        Authority(String rootId, KeyPair delegate, byte[] proof) {
            this.rootId = rootId;
            this.delegate = delegate;
            this.proof = proof;
        }
    }

    static Enrollment enroll(Context c) throws Exception {
        pruneUnusedRootsAsync(c);
        String rootId = UUID.randomUUID().toString();
        synchronized (PageConsent.class) { PENDING_ROOTS.add(rootId); }
        KeyPairGenerator ephemeral = KeyPairGenerator.getInstance("EC");
        ephemeral.initialize(new ECGenParameterSpec("secp256r1"));
        KeyPair delegate = ephemeral.generateKeyPair();
        byte[] challenge = hash(proofMessage(c, rootId, delegate.getPublic().getEncoded()));
        KeyPairGenerator hardware = KeyPairGenerator.getInstance("EC", "AndroidKeyStore");
        hardware.initialize(new KeyGenParameterSpec.Builder(ROOT + rootId, KeyProperties.PURPOSE_SIGN | KeyProperties.PURPOSE_VERIFY)
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setUserAuthenticationRequired(true)
            .setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG | KeyProperties.AUTH_DEVICE_CREDENTIAL)
            .setInvalidatedByBiometricEnrollment(false)
            .setAttestationChallenge(challenge)
            .build());
        try {
            PrivateKey key = hardware.generateKeyPair().getPrivate();
            if (attested(c, keyStore(), rootId, challenge) == null) throw new GeneralPageError(Tr.t("设备不支持硬件密钥认证"));
            Signature signing = Signature.getInstance("SHA256withECDSA");
            signing.initSign(key);
            return new Enrollment(rootId, delegate, signing);
        } catch (Exception e) {
            discard(rootId);
            throw e;
        }
    }

    static synchronized Authority authority(Context c, String id) {
        return current(c, id) ? active.authority : null;
    }

    static synchronized boolean activate(Context c, String id, Authority authority) {
        PENDING_ROOTS.remove(authority.rootId);
        if (!current(c, id)) return false;
        active.authority = authority;
        return true;
    }

    static synchronized boolean save(Context c, String id, String name, String value) throws Exception {
        Authority authority = authority(c, id);
        if (authority == null) return false;
        KeyPairGenerator generator = KeyPairGenerator.getInstance("EC", "AndroidKeyStore");
        generator.initialize(new KeyGenParameterSpec.Builder(MARKER + name, KeyProperties.PURPOSE_SIGN)
            .setDigests(KeyProperties.DIGEST_SHA256).build());
        byte[] marker = generator.generateKeyPair().getPublic().getEncoded();
        byte[] signature = sign(authority.delegate.getPrivate(), recordMessage(c, name, value, authority.rootId, marker));
        String record = new JSONObject().put("root", authority.rootId).put("value", value)
            .put("delegate", encode(authority.delegate.getPublic().getEncoded())).put("proof", encode(authority.proof))
            .put("marker", encode(marker)).put("signature", encode(signature)).toString();
        return usable(c) && c.getSharedPreferences("consent", Context.MODE_PRIVATE).edit().putString("page." + name, record).commit();
    }

    static String restore(Context c, String name, String serialized) {
        try {
            JSONObject record = new JSONObject(serialized);
            String value = record.getString("value"), rootId = record.getString("root");
            if (!UUID.fromString(rootId).toString().equals(rootId)) return null;
            byte[] delegate = decode(record.getString("delegate")), marker = decode(record.getString("marker"));
            KeyStore store = keyStore();
            byte[] message = proofMessage(c, rootId, delegate);
            X509Certificate leaf = attested(c, store, rootId, hash(message));
            if (leaf == null || !verify(leaf.getPublicKey(), message, decode(record.getString("proof")))) return null;
            if (!verify(publicKey(delegate), recordMessage(c, name, value, rootId, marker), decode(record.getString("signature")))) return null;
            // A restored certificate is insufficient: revocation deletes the actual private key.
            PrivateKey key = (PrivateKey) store.getKey(MARKER + name, null);
            if (key == null) return null;
            byte[] probe = new byte[32];
            RANDOM.nextBytes(probe);
            return verify(publicKey(marker), probe, sign(key, probe)) ? value : null;
        } catch (Exception e) {
            Log.w(Consent.TAG, "无法恢复页面授权 " + name, e);
            return null;
        }
    }

    static void removeMarker(String name) { delete(MARKER + name); }
    static void discard(String rootId) {
        synchronized (PageConsent.class) { PENDING_ROOTS.remove(rootId); }
        delete(ROOT + rootId);
    }

    /** Reclaim unreferenced hardware root keys so StrongBox/KeyStore slots do not leak across visits. */
    static void pruneUnusedRootsAsync(Context c) {
        final Context app = c.getApplicationContext();
        GC.execute(() -> {
            try {
                Set<String> inUse = new HashSet<>();
                synchronized (PageConsent.class) {
                    if (active != null && active.authority != null) inUse.add(active.authority.rootId);
                    inUse.addAll(PENDING_ROOTS);
                }
                Map<String, ?> all = app.getSharedPreferences("consent", Context.MODE_PRIVATE).getAll();
                for (Map.Entry<String, ?> entry : all.entrySet()) {
                    if (!entry.getKey().startsWith("page.") || !(entry.getValue() instanceof String)) continue;
                    try {
                        String root = new JSONObject((String) entry.getValue()).optString("root", "");
                        if (!root.isEmpty()) inUse.add(root);
                    } catch (Exception ignored) {}
                }
                KeyStore ks = keyStore();
                Enumeration<String> aliases = ks.aliases();
                while (aliases.hasMoreElements()) {
                    String alias = aliases.nextElement();
                    if (!alias.startsWith(ROOT)) continue;
                    String rootId = alias.substring(ROOT.length());
                    boolean stillActive;
                    synchronized (PageConsent.class) {
                        stillActive = inUse.contains(rootId) || PENDING_ROOTS.contains(rootId)
                            || (active != null && active.authority != null && rootId.equals(active.authority.rootId));
                    }
                    if (!stillActive) {
                        try { ks.deleteEntry(alias); }
                        catch (Exception e) { Log.w(Consent.TAG, "无法清理旧页面密钥 " + alias, e); }
                    }
                }
            } catch (Exception e) {
                Log.w(Consent.TAG, "清理页面授权密钥失败", e);
            }
        });
    }

    private static void delete(String alias) {
        try { keyStore().deleteEntry(alias); }
        catch (Exception e) { Log.w(Consent.TAG, "无法移除授权密钥", e); }
    }

    private static KeyStore keyStore() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        return ks;
    }

    private static X509Certificate attested(Context c, KeyStore ks, String rootId, byte[] challenge) throws Exception {
        String alias = ROOT + rootId;
        Certificate[] chain = ks.getCertificateChain(alias);
        java.util.Date creation = ks.getCreationDate(alias);
        if (chain == null || creation == null) return null;
        X509Certificate[] certificates = new X509Certificate[chain.length];
        for (int i = 0; i < chain.length; i++) {
            if (!(chain[i] instanceof X509Certificate)) return null;
            certificates[i] = (X509Certificate) chain[i];
        }
        return KeyAttest.check(certificates, Consent.ROOTS, challenge, c.getPackageName(), creation.getTime()).isEmpty()
            ? certificates[0] : null;
    }

    private static byte[] proofMessage(Context c, String rootId, byte[] delegate) {
        return bytes(c.getPackageName() + "\0device-page-key\0" + rootId + "\0" + encode(delegate));
    }

    private static byte[] recordMessage(Context c, String name, String value, String rootId, byte[] marker) {
        return bytes(c.getPackageName() + "\0device-page-record\0" + name + "\0" + value + "\0" + rootId + "\0" + encode(marker));
    }

    private static byte[] bytes(String value) { return value.getBytes(StandardCharsets.UTF_8); }
    private static byte[] hash(byte[] value) throws Exception { return MessageDigest.getInstance("SHA-256").digest(value); }
    private static String encode(byte[] value) { return Base64.encodeToString(value, Base64.NO_WRAP); }
    private static byte[] decode(String value) { return Base64.decode(value, Base64.NO_WRAP); }
    private static PublicKey publicKey(byte[] value) throws Exception {
        return KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(value));
    }

    private static byte[] sign(PrivateKey key, byte[] message) throws Exception {
        Signature s = Signature.getInstance("SHA256withECDSA");
        s.initSign(key);
        s.update(message);
        return s.sign();
    }

    private static boolean verify(PublicKey key, byte[] message, byte[] signature) throws Exception {
        Signature s = Signature.getInstance("SHA256withECDSA");
        s.initVerify(key);
        s.update(message);
        return s.verify(signature);
    }

    private static final class GeneralPageError extends Exception {
        GeneralPageError(String description) { super(description); }
    }
}
