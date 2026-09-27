package ph.baranguard.tanod.devicekey

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.PublicKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec

/**
 * H-09 device identity key — port of ../mobile's DeviceKeyPlugin.java.
 * Same alias, curve, signature encoding and PEM layout, so the server's
 * `DeviceSignature` accepts either app's signatures unchanged. The private
 * key never leaves the Keystore; only the public PEM and signatures cross
 * into JS.
 */
class DeviceKeyModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("DeviceKey")

    AsyncFunction("getPublicKey") {
      publicKeyToPem(getOrCreatePublicKey())
    }

    AsyncFunction("sign") { payload: String ->
      val signature = Signature.getInstance("SHA256withECDSA")
      signature.initSign(getOrCreatePrivateKey())
      signature.update(payload.toByteArray(Charsets.UTF_8))
      Base64.encodeToString(signature.sign(), Base64.NO_WRAP)
    }
  }

  private fun keyStore(): KeyStore =
    KeyStore.getInstance(KEYSTORE_PROVIDER).apply { load(null) }

  private fun ensureKeyPair(store: KeyStore) {
    if (!store.containsAlias(KEY_ALIAS)) generateKeyPair()
  }

  private fun getOrCreatePrivateKey(): PrivateKey {
    val store = keyStore()
    ensureKeyPair(store)
    return store.getKey(KEY_ALIAS, null) as PrivateKey
  }

  private fun getOrCreatePublicKey(): PublicKey {
    val store = keyStore()
    ensureKeyPair(store)
    return store.getCertificate(KEY_ALIAS).publicKey
  }

  private fun specBuilder(): KeyGenParameterSpec.Builder =
    KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_SIGN)
      .setDigests(KeyProperties.DIGEST_SHA256)
      .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))

  private fun generateKeyPair() {
    // StrongBox first; most devices (including the Infinix X6840) lack it,
    // so its absence silently falls back to a normal TEE-backed key.
    try {
      val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, KEYSTORE_PROVIDER)
      generator.initialize(specBuilder().setIsStrongBoxBacked(true).build())
      generator.generateKeyPair()
      return
    } catch (_: Exception) {
    }
    val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, KEYSTORE_PROVIDER)
    generator.initialize(specBuilder().build())
    generator.generateKeyPair()
  }

  /** SPKI DER -> PEM with 64-char lines, what PHP's openssl_pkey_get_public() expects. */
  private fun publicKeyToPem(publicKey: PublicKey): String {
    val base64 = Base64.encodeToString(publicKey.encoded, Base64.NO_WRAP)
    return buildString {
      append("-----BEGIN PUBLIC KEY-----\n")
      base64.chunked(64).forEach { append(it).append('\n') }
      append("-----END PUBLIC KEY-----\n")
    }
  }

  companion object {
    private const val KEY_ALIAS = "baranguard_device_identity"
    private const val KEYSTORE_PROVIDER = "AndroidKeyStore"
  }
}
