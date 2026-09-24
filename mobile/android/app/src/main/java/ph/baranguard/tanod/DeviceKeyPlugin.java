package ph.baranguard.tanod;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;

/**
 * DeviceKeyPlugin — code-review finding H-09 (2026-09-24 external audit):
 * "X-Device-Id is an identifier, not strong proof of device authenticity."
 *
 * Generates a hardware-backed EC P-256 keypair in the Android Keystore on
 * first use, never exportable (the private key material never leaves
 * secure hardware/TEE — `KeyStore.getKey()` returns a reference the OS
 * uses on the device's behalf, not the raw bytes). `getPublicKey()` hands
 * the public half to `POST /devices/register`'s `device_public_key_pem`
 * (see DevicesController.php); `sign()` signs a caller-built canonical
 * string — `Baranguard\Lib\DeviceSignature::canonicalMessage()` on the
 * server, mirrored in deviceIdentity.ts's `signDeviceRequest()` — so both
 * sides compute the identical bytes independently, nothing sensitive
 * needs to cross the JS bridge except the already-public device_id and a
 * timestamp.
 *
 * StrongBox (a separate secure chip, where the device has one) is
 * attempted first and silently falls back to the normal Keystore/TEE
 * backing on any device that lacks it — most devices, including the
 * Infinix X6840 this project's other native work was verified on
 * (HANDOFF.md), do not have a StrongBox module, and treating its absence
 * as fatal would break key generation entirely for exactly the hardware
 * already in use.
 *
 * CODE-COMPLETE, DEVICE-UNVERIFIED this session — no phone was attached
 * (DEVLOG.md). Gradle-compiles clean (`./gradlew assembleDebug`); the
 * actual Keystore generation/signing path needs a real device to confirm,
 * same "prove it, don't claim it" gap this project already tracks
 * elsewhere for exactly this reason (see REMAINING.md's device-verification
 * items).
 */
@CapacitorPlugin(name = "DeviceKey")
public class DeviceKeyPlugin extends Plugin {

    private static final String KEY_ALIAS = "baranguard_device_identity";
    private static final String KEYSTORE_PROVIDER = "AndroidKeyStore";

    @PluginMethod
    public void getPublicKey(PluginCall call) {
        try {
            KeyPair keyPair = getOrCreateKeyPair();
            JSObject result = new JSObject();
            result.put("publicKeyPem", publicKeyToPem(keyPair.getPublic()));
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Could not get/create the device identity key: " + e.getMessage(), e);
        }
    }

    /** Body `{payload: string}` -> `{signature: base64 DER ECDSA signature}`. */
    @PluginMethod
    public void sign(PluginCall call) {
        String payload = call.getString("payload");
        if (payload == null) {
            call.reject("payload is required");
            return;
        }
        try {
            KeyPair keyPair = getOrCreateKeyPair();
            Signature signature = Signature.getInstance("SHA256withECDSA");
            signature.initSign(keyPair.getPrivate());
            signature.update(payload.getBytes("UTF-8"));
            byte[] signed = signature.sign();

            JSObject result = new JSObject();
            result.put("signature", Base64.encodeToString(signed, Base64.NO_WRAP));
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Could not sign the request: " + e.getMessage(), e);
        }
    }

    private KeyPair getOrCreateKeyPair() throws Exception {
        KeyStore keyStore = KeyStore.getInstance(KEYSTORE_PROVIDER);
        keyStore.load(null);

        if (!keyStore.containsAlias(KEY_ALIAS)) {
            generateKeyPair();
        }

        PrivateKey privateKey = (PrivateKey) keyStore.getKey(KEY_ALIAS, null);
        PublicKey publicKey = keyStore.getCertificate(KEY_ALIAS).getPublicKey();
        return new KeyPair(publicKey, privateKey);
    }

    private void generateKeyPair() throws Exception {
        KeyGenParameterSpec.Builder specBuilder = new KeyGenParameterSpec.Builder(
                KEY_ALIAS, KeyProperties.PURPOSE_SIGN)
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"));

        // Best-effort StrongBox — see class doc. Try, then fall back.
        try {
            specBuilder.setIsStrongBoxBacked(true);
            KeyPairGenerator kpg = KeyPairGenerator.getInstance(
                    KeyProperties.KEY_ALGORITHM_EC, KEYSTORE_PROVIDER);
            kpg.initialize(specBuilder.build());
            kpg.generateKeyPair();
            return;
        } catch (Exception strongBoxUnavailable) {
            // Fall through to a non-StrongBox key below — expected on most
            // devices, not an error worth surfacing to the caller.
        }

        KeyGenParameterSpec.Builder fallbackSpec = new KeyGenParameterSpec.Builder(
                KEY_ALIAS, KeyProperties.PURPOSE_SIGN)
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"));
        KeyPairGenerator kpg = KeyPairGenerator.getInstance(
                KeyProperties.KEY_ALGORITHM_EC, KEYSTORE_PROVIDER);
        kpg.initialize(fallbackSpec.build());
        kpg.generateKeyPair();
    }

    /** SPKI DER (X.509) -> PEM, matching what PHP's openssl_pkey_get_public() expects directly. */
    private String publicKeyToPem(PublicKey publicKey) {
        String base64 = Base64.encodeToString(publicKey.getEncoded(), Base64.NO_WRAP);
        StringBuilder pem = new StringBuilder();
        pem.append("-----BEGIN PUBLIC KEY-----\n");
        for (int i = 0; i < base64.length(); i += 64) {
            pem.append(base64, i, Math.min(i + 64, base64.length())).append("\n");
        }
        pem.append("-----END PUBLIC KEY-----\n");
        return pem.toString();
    }
}
