package org.llamenos.hotline.crypto

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.bouncycastle.crypto.generators.Argon2BytesGenerator
import org.bouncycastle.crypto.params.Argon2Parameters
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.params.X25519PrivateKeyParameters
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.llamenos.protocol.CryptoLabels
import org.llamenos.protocol.RecipientEnvelope
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Open, through this app's production readers, stored records the server wrote.
 *
 * Stored records — conversation messages (`LABEL_MESSAGE`) and call metadata
 * (`LABEL_CALL_META`) — carry **no AAD** on either layer; the label is bound as
 * the HPKE `info` only (`PROTOCOL.md` §2.4, §2.5). That is what the server's
 * `encryptMessageForStorage` / `encryptCallRecordForStorage` write and what the
 * desktop reads. Until #1927 this app sealed and opened messages under the
 * canonical notes AAD (`label` / `label:key-wrap`) instead, so nothing the
 * server or desktop wrote opened here, nothing written here opened anywhere
 * else, and every Android test passed — because each one encrypted and
 * decrypted with Android's own construction.
 *
 * So the bytes under test are not Android's. `stored-record-vectors.json`
 * (`packages/crypto/tests/fixtures/`, #1928) holds records sealed by the
 * server's own code for two fixed X25519 reader keys. This test loads each
 * reader into a real [CryptoService] through the real `mobileUnlock` path and
 * opens those exact bytes with [CryptoService.decryptMessage] and
 * [CryptoService.decryptCallMetadata]. It also proves the vector discriminates:
 * the canonical AAD this app used to pass must NOT open it.
 *
 * Runs on a device/emulator with the debug (`test-kdf`) native library, under
 * `-e cucumberUseAndroidJUnitRunner true -e class <this class>`. No server.
 */
@RunWith(AndroidJUnit4::class)
class EnvelopeAadInteropTest {

    private val json = Json { ignoreUnknownKeys = true }
    private val fixture: Fixture = InstrumentationRegistry.getInstrumentation().context.assets
        .open(FIXTURE_ASSET).bufferedReader().use { json.decodeFromString(it.readText()) }

    private val services = mutableListOf<CryptoService>()

    @After
    fun lockEverything() {
        services.forEach { it.lock() }
    }

    @Test
    fun theFixtureIsTheNoAadStoredRecordFormat() {
        // The vector itself must say what this test claims it says; if the
        // fixture is ever regenerated under another convention, fail here
        // rather than silently testing something else.
        assertEquals("", fixture.aadHex.content)
        assertEquals("", fixture.aadHex.keyWrap)
        assertEquals(CryptoLabels.LABEL_MESSAGE, record(CryptoLabels.LABEL_MESSAGE).label)
        assertEquals(CryptoLabels.LABEL_CALL_META, record(CryptoLabels.LABEL_CALL_META).label)
        assertEquals(2, fixture.readers.size)
    }

    @Test
    fun everyReaderOpensTheServersMessageThroughCryptoService(): Unit = runBlocking {
        val message = record(CryptoLabels.LABEL_MESSAGE)
        for (reader in fixture.readers) {
            val svc = unlockedAs(reader)
            assertEquals(
                "reader ${reader.name} could not open the server-written LABEL_MESSAGE record",
                message.plaintext,
                svc.decryptMessage(message.encryptedContent, message.readerEnvelopes.map { it.wire() }),
            )
        }
    }

    @Test
    fun everyReaderOpensTheServersCallMetadataThroughCryptoService(): Unit = runBlocking {
        val call = record(CryptoLabels.LABEL_CALL_META)
        val expected = json.decodeFromString<CallMetadata>(call.plaintext)
        for (reader in fixture.readers) {
            val svc = unlockedAs(reader)
            assertEquals(
                "reader ${reader.name} could not open the server-written LABEL_CALL_META record",
                expected,
                svc.decryptCallMetadata(
                    call.encryptedContent,
                    call.readerEnvelopes.map { AdminEnvelopeData(pubkey = it.pubkey, enc = it.enc, ct = it.ct) },
                ),
            )
        }
    }

    @Test
    fun aDeviceThatIsNotAReaderGetsNull(): Unit = runBlocking {
        val message = record(CryptoLabels.LABEL_MESSAGE)
        val volunteer = fixture.readers.first { it.name == "volunteer" }
        val svc = unlockedAs(volunteer)
        val others = message.readerEnvelopes.filter { it.pubkey != volunteer.x25519PubkeyHex }
        assertTrue("fixture must address another reader", others.isNotEmpty())
        assertNull(svc.decryptMessage(message.encryptedContent, others.map { it.wire() }))
    }

    /**
     * The vector discriminates: the canonical AAD — what this app passed until
     * #1927 — does not open the server's bytes, at either layer, while the
     * empty AAD does. Without this half, a reader that ignored its AAD would
     * pass every assertion above.
     */
    @Test
    fun theCanonicalAadThisAppUsedToPassDoesNotOpenTheServersBytes(): Unit = runBlocking {
        val message = record(CryptoLabels.LABEL_MESSAGE)
        val volunteer = fixture.readers.first { it.name == "volunteer" }
        unlockedAs(volunteer)
        val wire = message.readerEnvelopes.first { it.pubkey == volunteer.x25519PubkeyHex }
        val envelope = org.llamenos.core.HpkeEnvelope(
            v = HpkeEnvelope.CURRENT_VERSION.toUByte(),
            labelId = org.llamenos.core.mobileLabelToId(CryptoLabels.LABEL_MESSAGE),
            enc = org.llamenos.core.mobileHexToBase64url(wire.enc),
            ct = org.llamenos.core.mobileHexToBase64url(wire.ct),
        )

        expectFailure("key wrap opened under the canonical key-wrap AAD") {
            org.llamenos.core.mobileHpkeOpenKey(
                envelope = envelope,
                expectedLabel = CryptoLabels.LABEL_MESSAGE,
                aadHex = org.llamenos.core.mobileKeyWrapAadHex(CryptoLabels.LABEL_MESSAGE),
            )
        }
        val keyHex = org.llamenos.core.mobileHpkeOpenKey(
            envelope = envelope,
            expectedLabel = CryptoLabels.LABEL_MESSAGE,
            aadHex = fixture.aadHex.keyWrap,
        )
        expectFailure("content opened under the canonical content AAD") {
            org.llamenos.core.mobileSymmetricDecrypt(
                ciphertextHex = message.encryptedContent,
                keyHex = keyHex,
                aadHex = org.llamenos.core.mobileContentAadHex(CryptoLabels.LABEL_MESSAGE),
            )
        }
        assertEquals(
            message.plaintext,
            String(
                hexToBytes(
                    org.llamenos.core.mobileSymmetricDecrypt(
                        ciphertextHex = message.encryptedContent,
                        keyHex = keyHex,
                        aadHex = fixture.aadHex.content,
                    ),
                ),
                Charsets.UTF_8,
            ),
        )
    }

    /**
     * The writer half: a message this app seals opens under the desktop's
     * reader recipe (`platform.ts` `decryptMessage`: `hpkeOpenKeyFromState`
     * with `''`, then `aesGcmDecrypt` with `''`) — reproduced here with the
     * primitives and the fixture's empty AADs, not with [CryptoService.decryptMessage],
     * so the reader is not the writer's own counterpart.
     */
    @Test
    fun aMessageThisAppSealsOpensUnderTheDesktopReaderRecipe(): Unit = runBlocking {
        val volunteer = fixture.readers.first { it.name == "volunteer" }
        val admin = fixture.readers.first { it.name == "admin" }
        val plaintext = "android-sealed: ¿estás a salvo? ${System.nanoTime()}"

        val sealed = unlockedAs(volunteer).encryptMessage(plaintext, listOf(admin.x25519PubkeyHex))
        assertEquals(
            setOf(volunteer.x25519PubkeyHex, admin.x25519PubkeyHex),
            sealed.envelopes.map { it.pubkey }.toSet(),
        )

        unlockedAs(admin)
        val wire = sealed.envelopes.first { it.pubkey == admin.x25519PubkeyHex }
        val keyHex = org.llamenos.core.mobileHpkeOpenKey(
            envelope = org.llamenos.core.HpkeEnvelope(
                v = HpkeEnvelope.CURRENT_VERSION.toUByte(),
                labelId = org.llamenos.core.mobileLabelToId(CryptoLabels.LABEL_MESSAGE),
                enc = org.llamenos.core.mobileHexToBase64url(wire.enc),
                ct = org.llamenos.core.mobileHexToBase64url(wire.ct),
            ),
            expectedLabel = CryptoLabels.LABEL_MESSAGE,
            aadHex = fixture.aadHex.keyWrap,
        )
        val opened = org.llamenos.core.mobileSymmetricDecrypt(
            ciphertextHex = sealed.ciphertextHex,
            keyHex = keyHex,
            aadHex = fixture.aadHex.content,
        )
        assertEquals(plaintext, String(hexToBytes(opened), Charsets.UTF_8))
    }

    // ── Loading a fixture reader into the real mobile state ──────────────

    /**
     * A [CryptoService] unlocked as [reader], via the production `mobileUnlock`.
     *
     * The FFI deliberately has no "import a raw secret" call, so this builds the
     * PIN-encrypted device-key blob `device_keys.rs` reads — AES-256-GCM, no AAD,
     * under an Argon2id KEK, over `signing_seed || encryption_seed` — around the
     * fixture's X25519 secret. The Argon2id parameters are taken from a blob the
     * native library just generated, so this follows whichever KDF build
     * (`test-kdf` or production) is loaded. If that blob format ever changes,
     * unlock fails loudly here; it cannot pass vacuously.
     */
    private suspend fun unlockedAs(reader: FixtureReader): CryptoService {
        val svc = CryptoService().also { services += it }
        assertTrue(
            "the native crypto library must be loaded — this test is worthless against a mock",
            svc.nativeLibLoaded,
        )
        val params = svc.generateDeviceKeys("kdf-params-probe", PIN)
        svc.lock()

        val encryptionSeed = hexToBytes(reader.x25519SecretHex)
        assertEquals(
            "the fixture's published pubkey must be the one its secret derives",
            reader.x25519PubkeyHex,
            X25519PrivateKeyParameters(encryptionSeed, 0).generatePublicKey().encoded.toHex(),
        )
        val signingSeed = ByteArray(32) { SIGNING_SEED_BYTE }
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
        }.generateBytes(PIN.toByteArray(Charsets.UTF_8), kek)
        val ciphertext = Cipher.getInstance("AES/GCM/NoPadding").run {
            init(Cipher.ENCRYPT_MODE, SecretKeySpec(kek, "AES"), GCMParameterSpec(128, nonce))
            doFinal(signingSeed + encryptionSeed)
        }

        val state = svc.unlockWithPin(
            EncryptedDeviceKeys(
                kdfVersion = params.kdfVersion,
                salt = salt.toHex(),
                argon2MCost = params.argon2MCost,
                argon2TCost = params.argon2TCost,
                argon2PCost = params.argon2PCost,
                nonce = nonce.toHex(),
                ciphertext = ciphertext.toHex(),
                state = DeviceKeyState(
                    deviceId = "vector-${reader.name}",
                    signingPubkeyHex = Ed25519PrivateKeyParameters(signingSeed, 0)
                        .generatePublicKey().encoded.toHex(),
                    encryptionPubkeyHex = reader.x25519PubkeyHex,
                ),
            ),
            PIN,
        )
        assertEquals(reader.x25519PubkeyHex, state.encryptionPubkeyHex)
        assertNotNull(svc.encryptionPubkeyHex)
        return svc
    }

    // ── Fixture shape (stored-record-vectors.json) ───────────────────────

    @Serializable
    private data class Fixture(
        val aadHex: FixtureAad,
        val readers: List<FixtureReader>,
        val records: List<FixtureRecord>,
    )

    @Serializable
    private data class FixtureAad(val content: String, val keyWrap: String)

    @Serializable
    private data class FixtureReader(
        val name: String,
        val x25519SecretHex: String,
        val x25519PubkeyHex: String,
    )

    @Serializable
    private data class FixtureRecord(
        val name: String,
        val label: String,
        val plaintext: String,
        val encryptedContent: String,
        val readerEnvelopes: List<FixtureEnvelope>,
    )

    @Serializable
    private data class FixtureEnvelope(val pubkey: String, val enc: String, val ct: String) {
        fun wire() = RecipientEnvelope(pubkey = pubkey, enc = enc, ct = ct)
    }

    private fun record(label: String): FixtureRecord =
        fixture.records.firstOrNull { it.label == label }
            ?: error("$FIXTURE_ASSET has no $label record")

    private inline fun expectFailure(what: String, block: () -> Unit) {
        try {
            block()
            fail("$what — the AAD is being accepted and ignored, or the fixture does not discriminate")
        } catch (_: org.llamenos.core.CryptoException) {
            // expected
        }
    }

    private fun hexToBytes(hex: String): ByteArray =
        ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }

    private companion object {
        const val FIXTURE_ASSET = "stored-record-vectors.json"
        const val PIN = "24681357"
        const val SIGNING_SEED_BYTE: Byte = 0x5a
    }
}
