package cc.codroid;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

/** Gateway-only wrapping service. The Android Keystore AES key is never exported. */
final class RemoteKeyStore {
    static final int MAX_SECRET_BYTES = 24 * 1024;
    private static final String ALIAS = "cc.codroid.remote.wrap.v1";
    private static final String TRANSFORM = "AES/GCM/NoPadding";

    private synchronized SecretKey key(boolean create) throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (!ks.containsAlias(ALIAS)) {
            if (!create) throw new java.security.KeyStoreException("REMOTE_MASTER_UNAVAILABLE");
            KeyGenerator gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            gen.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .setKeySize(256).build());
            gen.generateKey();
        }
        return (SecretKey) ks.getKey(ALIAS, null);
    }

    static void label(String purpose, String recordId) {
        if (!"identity-v1".equals(purpose) && !"pairing-v1".equals(purpose) && !"connection-v1".equals(purpose))
            throw new IllegalArgumentException("INVALID_VAULT_PURPOSE");
        RemotePolicy.id(recordId);
    }
    private byte[] aad(String purpose, String recordId) {
        label(purpose, recordId);
        return ("cc.codroid/remote/vault/v1\n" + purpose + "\n" + recordId).getBytes(StandardCharsets.UTF_8);
    }
    JSONObject seal(String purpose, String recordId, String plaintext) throws Exception {
        byte[] raw = decode(plaintext, MAX_SECRET_BYTES);
        try {
            Cipher cipher = Cipher.getInstance(TRANSFORM);
            cipher.init(Cipher.ENCRYPT_MODE, key(true));
            cipher.updateAAD(aad(purpose, recordId));
            return new JSONObject().put("v", 1).put("nonce", encode(cipher.getIV())).put("ciphertext", encode(cipher.doFinal(raw)));
        } finally { java.util.Arrays.fill(raw, (byte) 0); }
    }
    String open(String purpose, String recordId, JSONObject envelope) throws Exception {
        RemoteWire.exact(envelope, "v", "nonce", "ciphertext");
        if (RemoteWire.integer(envelope, "v", 1, 1) != 1) throw new IllegalArgumentException("INVALID_VAULT_VERSION");
        byte[] iv = decode(RemoteWire.string(envelope, "nonce"), 12);
        byte[] ciphertext = decode(RemoteWire.string(envelope, "ciphertext"), MAX_SECRET_BYTES + 16);
        if (iv.length != 12 || ciphertext.length < 16) throw new IllegalArgumentException("INVALID_VAULT_ENVELOPE");
        Cipher cipher = Cipher.getInstance(TRANSFORM);
        cipher.init(Cipher.DECRYPT_MODE, key(false), new GCMParameterSpec(128, iv));
        cipher.updateAAD(aad(purpose, recordId));
        byte[] raw = cipher.doFinal(ciphertext);
        try { return encode(raw); }
        finally { java.util.Arrays.fill(raw, (byte) 0); }
    }
    private static byte[] decode(String value, int max) {
        if (value.length() > ((max + 2) / 3) * 4 || !value.matches("(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?"))
            throw new IllegalArgumentException("INVALID_BASE64");
        byte[] result = Base64.decode(value, Base64.NO_WRAP);
        if (result.length > max || !encode(result).equals(value)) throw new IllegalArgumentException("INVALID_BASE64");
        return result;
    }
    private static String encode(byte[] value) { return Base64.encodeToString(value, Base64.NO_WRAP); }
}
