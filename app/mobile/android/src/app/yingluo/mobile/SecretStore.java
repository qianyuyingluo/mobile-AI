package app.yingluo.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class SecretStore {
    private static final String KEY_ALIAS = "yingluo-credentials-v1";
    private static final int IV_LENGTH = 12;
    private final SharedPreferences preferences;

    SecretStore(Context context) {
        preferences = context.getSharedPreferences("credentials", Context.MODE_PRIVATE);
    }

    private static boolean allowed(String name) {
        return "chatApiKey".equals(name) || "workToken".equals(name);
    }

    private static SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(KEY_ALIAS)) return (SecretKey) store.getKey(KEY_ALIAS, null);
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setKeySize(256)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build());
        return generator.generateKey();
    }

    synchronized String get(String name) {
        if (!allowed(name)) return "";
        String value = preferences.getString(name, null);
        if (value == null) return "";
        try {
            byte[] encrypted = Base64.decode(value, Base64.NO_WRAP);
            if (encrypted.length < IV_LENGTH + 16) return "";
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, encrypted, 0, IV_LENGTH));
            cipher.updateAAD(name.getBytes(StandardCharsets.UTF_8));
            return new String(cipher.doFinal(encrypted, IV_LENGTH, encrypted.length - IV_LENGTH),
                    StandardCharsets.UTF_8);
        } catch (Exception invalid) {
            return "";
        }
    }

    synchronized boolean set(String name, String value) {
        if (!allowed(name) || value == null || value.length() > 8192) return false;
        if (value.isEmpty()) return preferences.edit().remove(name).commit();
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key());
            cipher.updateAAD(name.getBytes(StandardCharsets.UTF_8));
            byte[] ciphertext = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
            byte[] iv = cipher.getIV();
            if (iv.length != IV_LENGTH) return false;
            byte[] encoded = Arrays.copyOf(iv, iv.length + ciphertext.length);
            System.arraycopy(ciphertext, 0, encoded, iv.length, ciphertext.length);
            return preferences.edit().putString(name, Base64.encodeToString(encoded, Base64.NO_WRAP)).commit();
        } catch (Exception unavailable) {
            return false;
        }
    }
}
