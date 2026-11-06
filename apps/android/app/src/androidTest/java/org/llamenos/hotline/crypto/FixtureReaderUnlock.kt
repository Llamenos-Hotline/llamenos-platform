package org.llamenos.hotline.crypto

import org.bouncycastle.crypto.generators.Argon2BytesGenerator
import org.bouncycastle.crypto.params.Argon2Parameters
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.params.X25519PrivateKeyParameters
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

private const val FIXTURE_PIN = "24681357"
private const val FIXTURE_SIGNING_SEED_BYTE: Byte = 0x5a

/**
 * A [CryptoService] unlocked as a conformance-fixture reader, via the production
 * `mobileUnlock`. Shared by the instrumented tests that open server-written vectors
 * through Android's production readers (`EnvelopeAadInteropTest`,
 * `CaseRecordVectorTest`).
 *
 * The FFI deliberately has no "import a raw secret" call, so this builds the
 * PIN-encrypted device-key blob `device_keys.rs` reads — AES-256-GCM, no AAD,
 * under an Argon2id KEK, over `signing_seed || encryption_seed` — around the
 * fixture's X25519 secret. The Argon2id parameters are taken from a blob the
 * native library just generated, so this follows whichever KDF build
 * (`test-kdf` or production) is loaded. If that blob format ever changes,
 * unlock fails loudly here; it cannot pass vacuously.
 */
internal suspend fun unlockFixtureReader(name: String, x25519SecretHex: String, x25519PubkeyHex: String): CryptoService {
    val svc = CryptoService()
    assertTrue(
        "the native crypto library must be loaded — this test is worthless against a mock",
        svc.nativeLibLoaded,
    )
    val params = svc.generateDeviceKeys("kdf-params-probe", FIXTURE_PIN)
    svc.lock()

    val encryptionSeed = fixtureHexToBytes(x25519SecretHex)
    assertEquals(
        "the fixture's published pubkey must be the one its secret derives",
        x25519PubkeyHex,
        X25519PrivateKeyParameters(encryptionSeed, 0).generatePublicKey().encoded.toFixtureHex(),
    )
    val signingSeed = ByteArray(32) { FIXTURE_SIGNING_SEED_BYTE }
    val salt = ByteArray(32).also { SecureRandom().nextBytes(it) }
    val nonce = ByteArray(12).also { SecureRandom().nextBytes(it) }
    val kek = ByteArray(32)
    Argon2BytesGenerator().apply {
        init(
            Argon2Parameters.Builder(Argon2Parameters.ARGON2_id)
                .withVersion(Argon2Parameters.ARGON2_VERSION_13)
                .withMemoryAsKB(params.argon2MCost.toInt())
                .withIterations(params.argon2TCost.toInt())
                .withParallelism(params.argon2PCost.toInt())
                .withSalt(salt)
                .build(),
        )
    }.generateBytes(FIXTURE_PIN.toByteArray(Charsets.UTF_8), kek)
    val ciphertext = Cipher.getInstance("AES/GCM/NoPadding").run {
        init(Cipher.ENCRYPT_MODE, SecretKeySpec(kek, "AES"), GCMParameterSpec(128, nonce))
        doFinal(signingSeed + encryptionSeed)
    }

    val state = svc.unlockWithPin(
        EncryptedDeviceKeys(
            kdfVersion = params.kdfVersion,
            salt = salt.toFixtureHex(),
            argon2MCost = params.argon2MCost,
            argon2TCost = params.argon2TCost,
            argon2PCost = params.argon2PCost,
            nonce = nonce.toFixtureHex(),
            ciphertext = ciphertext.toFixtureHex(),
            state = DeviceKeyState(
                deviceId = "vector-$name",
                signingPubkeyHex = Ed25519PrivateKeyParameters(signingSeed, 0)
                    .generatePublicKey().encoded.toFixtureHex(),
                encryptionPubkeyHex = x25519PubkeyHex,
            ),
        ),
        FIXTURE_PIN,
    )
    assertEquals(x25519PubkeyHex, state.encryptionPubkeyHex)
    assertNotNull(svc.encryptionPubkeyHex)
    return svc
}

internal fun fixtureHexToBytes(hex: String): ByteArray =
    ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

internal fun ByteArray.toFixtureHex(): String = joinToString("") { "%02x".format(it) }
