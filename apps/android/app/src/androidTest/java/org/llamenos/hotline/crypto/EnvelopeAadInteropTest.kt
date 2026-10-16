package org.llamenos.hotline.crypto

import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.llamenos.hotline.helpers.SimulationClient
import org.llamenos.protocol.CryptoLabels
import java.io.File

/**
 * Open, on a real device build, an envelope a real server wrote.
 *
 * `PROTOCOL.md` §2.4 binds `UTF-8(label)` to an envelope's content layer and
 * `UTF-8("{label}:key-wrap")` to its key wrap. Until #1520 the mobile FFI had
 * no AAD parameter on the symmetric layer at all and every call site passed
 * `aadHex = ""` at the wrap layer, so this app could not read anything the
 * server wrote — and no test could notice, because every Android test both
 * encrypted and decrypted with the app's own (wrong) convention.
 *
 * So this test never encrypts anything. The ciphertext comes from
 * `apps/worker/services/conversations.ts` running in a real server process and
 * is fetched back over HTTP, exactly as the app would receive it.
 *
 * The second half is the one that matters. An AAD parameter that is accepted
 * and ignored passes every happy-path test ever written while providing no
 * domain separation at all, which is indistinguishable from a correct
 * implementation until someone exploits it. Each `expectFailure` below is a
 * label confusion that must be rejected:
 *
 *  - another label's key-wrap AAD,
 *  - the *content* AAD of the same label at the key-wrap layer (the Albrecht
 *    defense proper: `hpkeSeal` carries content directly and wraps keys under
 *    the same label, so only the AAD separates the two),
 *  - the empty AAD this app used to pass,
 *  - and the un-converted wire hex, which is the encoding half of the bug.
 *
 * Run by `scripts/android-aad-interop.sh`, which boots an isolated server with
 * `ADMIN_DECRYPTION_PUBKEY` set to the pubkey phase 1 publishes, so the server
 * seals the inbound message to this device.
 */
@RunWith(AndroidJUnit4::class)
class EnvelopeAadInteropTest {

    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
    private val ctx = InstrumentationRegistry.getInstrumentation().targetContext
    private val stateFile = File(ctx.filesDir, "envelope-aad-interop-device.json")

    /**
     * The server's actual `GET /api/conversations/:id/messages` shape.
     *
     * Not `org.llamenos.hotline.model.MessagesListResponse`: that model
     * requires `recipientEnvelopes` and `channelType`, and the server sends
     * `readerEnvelopes` and no `channelType` at all, so it throws
     * `MissingFieldException` on every real response. That is a separate wire
     * contract defect; decoding through it here would conflate it with the
     * crypto this test exists to measure.
     */
    @Serializable
    private data class ServerMessages(val messages: List<ServerMessage> = emptyList())

    @Serializable
    private data class ServerMessage(
        val id: String,
        val encryptedContent: String,
        val readerEnvelopes: List<ServerEnvelope> = emptyList(),
    )

    @Serializable
    private data class ServerEnvelope(val pubkey: String, val enc: String, val ct: String)

    @Serializable
    private data class PersistedKeys(
        val kdfVersion: Int,
        val salt: String,
        val argon2MCost: Long,
        val argon2TCost: Long,
        val argon2PCost: Long,
        val nonce: String,
        val ciphertext: String,
        val deviceId: String,
        val signingPubkeyHex: String,
        val encryptionPubkeyHex: String,
    )

    /**
     * Phase 1 — generate this device's keys and publish the X25519 pubkey.
     *
     * The harness reads `DEVICE_X25519_PUBKEY` from logcat and restarts the
     * server with it as `ADMIN_DECRYPTION_PUBKEY`; phase 2 then unlocks the
     * same keys from `filesDir`. No key material is ever written to the log or
     * to the repository — only the public key and a PIN-encrypted blob in the
     * app's private storage.
     */
    @Test
    fun phase1PublishDevicePubkey(): Unit = runBlocking {
        val svc = CryptoService()
        assertTrue(
            "the native crypto library must be loaded — this test is worthless against a mock",
            svc.nativeLibLoaded,
        )
        val keys = svc.generateDeviceKeys(DEVICE_ID, PIN)
        stateFile.writeText(
            json.encodeToString(
                PersistedKeys(
                    kdfVersion = keys.kdfVersion.toInt(),
                    salt = keys.salt,
                    argon2MCost = keys.argon2MCost.toLong(),
                    argon2TCost = keys.argon2TCost.toLong(),
                    argon2PCost = keys.argon2PCost.toLong(),
                    nonce = keys.nonce,
                    ciphertext = keys.ciphertext,
                    deviceId = keys.state.deviceId,
                    signingPubkeyHex = keys.state.signingPubkeyHex,
                    encryptionPubkeyHex = keys.state.encryptionPubkeyHex,
                ),
            ),
        )
        Log.i(TAG, "DEVICE_X25519_PUBKEY=${keys.state.encryptionPubkeyHex}")

        // The Kotlin leg of the three-way byte-equality check. These come from
        // Rust via UniFFI, so they cannot drift from `envelope_aad.rs`; logging
        // them makes the agreement with `packages/shared/envelope-aad.ts`
        // readable rather than inferred (the cargo test
        // `rust_and_typescript_derive_identical_aad_for_every_label` is the
        // enforcing half).
        for (label in listOf(CryptoLabels.LABEL_MESSAGE, CryptoLabels.LABEL_CALL_META)) {
            Log.i(
                TAG,
                "AAD $label content=${org.llamenos.core.mobileContentAadHex(label)} " +
                    "keywrap=${org.llamenos.core.mobileKeyWrapAadHex(label)}",
            )
        }
    }

    /** Phase 2 — the round trip, and then the same round trip broken on purpose. */
    @Test
    fun phase2ServerEnvelopeOpensAndEveryWrongAadDoesNot(): Unit = runBlocking {
        val persisted = json.decodeFromString<PersistedKeys>(stateFile.readText())
        val svc = CryptoService()
        assertTrue("the native crypto library must be loaded", svc.nativeLibLoaded)
        svc.unlockWithPin(
            EncryptedDeviceKeys(
                kdfVersion = persisted.kdfVersion.toUByte(),
                salt = persisted.salt,
                argon2MCost = persisted.argon2MCost.toUInt(),
                argon2TCost = persisted.argon2TCost.toUInt(),
                argon2PCost = persisted.argon2PCost.toUInt(),
                nonce = persisted.nonce,
                ciphertext = persisted.ciphertext,
                state = DeviceKeyState(
                    deviceId = persisted.deviceId,
                    signingPubkeyHex = persisted.signingPubkeyHex,
                    encryptionPubkeyHex = persisted.encryptionPubkeyHex,
                ),
            ),
            PIN,
        )
        val ourPubkey = requireNotNull(svc.encryptionPubkeyHex)
        assertEquals(persisted.encryptionPubkeyHex, ourPubkey)

        // ── The server writes ────────────────────────────────────────
        val plaintext = "are you safe right now? ${System.currentTimeMillis()}"
        val sim = SimulationClient.simulateIncomingMessage("+15550001520", plaintext)
        assertTrue("simulateIncomingMessage failed: ${sim.error} ${sim.detail}", sim.ok)

        val body = SimulationClient.authorizedGet("/api/conversations/${sim.conversationId}/messages")
        val messages = json.decodeFromString<ServerMessages>(body).messages
        val message = messages.firstOrNull { it.id == sim.messageId }
            ?: fail("the server did not return message ${sim.messageId}").let { return@runBlocking }
        val wire = message.readerEnvelopes.firstOrNull { it.pubkey == ourPubkey }
            ?: fail(
                "the server sealed to none of this device's keys — readers were " +
                    message.readerEnvelopes.map { it.pubkey },
            ).let { return@runBlocking }

        // ── The device reads ─────────────────────────────────────────
        val envelope = HpkeEnvelope(
            v = HpkeEnvelope.CURRENT_VERSION,
            labelId = HpkeEnvelope.LABEL_ID_MESSAGE,
            enc = wire.enc,
            ct = wire.ct,
        )
        val opened = svc.decryptMessage(message.encryptedContent, envelope)
        assertNotNull("the server's envelope did not open on this device", opened)
        assertEquals(plaintext, opened)

        // ── Verify by breaking it ────────────────────────────────────
        // Below CryptoService, so a wrong AAD genuinely reaches the primitive.
        val ffiEnvelope = org.llamenos.core.HpkeEnvelope(
            v = HpkeEnvelope.CURRENT_VERSION.toUByte(),
            labelId = HpkeEnvelope.LABEL_ID_MESSAGE.toUByte(),
            enc = org.llamenos.core.mobileHexToBase64url(wire.enc),
            ct = org.llamenos.core.mobileHexToBase64url(wire.ct),
        )
        val correctKeyWrapAad = org.llamenos.core.mobileKeyWrapAadHex(CryptoLabels.LABEL_MESSAGE)
        val correctContentAad = org.llamenos.core.mobileContentAadHex(CryptoLabels.LABEL_MESSAGE)

        for ((name, aad) in listOf(
            "another label's key-wrap AAD" to
                org.llamenos.core.mobileKeyWrapAadHex(CryptoLabels.LABEL_NOTE_KEY),
            "the content AAD of the same label" to correctContentAad,
            "the empty AAD this app used to pass" to "",
        )) {
            expectFailure("key wrap opened under $name") {
                org.llamenos.core.mobileHpkeOpenKey(
                    envelope = ffiEnvelope,
                    expectedLabel = CryptoLabels.LABEL_MESSAGE,
                    aadHex = aad,
                )
            }
        }

        // The encoding half: wire hex handed straight to a record that carries
        // base64url, which is what this app did before.
        expectFailure("key wrap opened from un-converted wire hex") {
            org.llamenos.core.mobileHpkeOpenKey(
                envelope = org.llamenos.core.HpkeEnvelope(
                    v = HpkeEnvelope.CURRENT_VERSION.toUByte(),
                    labelId = HpkeEnvelope.LABEL_ID_MESSAGE.toUByte(),
                    enc = wire.enc,
                    ct = wire.ct,
                ),
                expectedLabel = CryptoLabels.LABEL_MESSAGE,
                aadHex = correctKeyWrapAad,
            )
        }

        // Content layer: the key is correct, only the AAD is wrong.
        val keyHex = org.llamenos.core.mobileHpkeOpenKey(
            envelope = ffiEnvelope,
            expectedLabel = CryptoLabels.LABEL_MESSAGE,
            aadHex = correctKeyWrapAad,
        )
        for ((name, aad) in listOf(
            "another label's content AAD" to
                org.llamenos.core.mobileContentAadHex(CryptoLabels.LABEL_CALL_META),
            "the key-wrap AAD of the same label" to correctKeyWrapAad,
            "the empty AAD this app used to pass" to "",
        )) {
            expectFailure("content opened under $name") {
                org.llamenos.core.mobileSymmetricDecrypt(
                    ciphertextHex = message.encryptedContent,
                    keyHex = keyHex,
                    aadHex = aad,
                )
            }
        }

        // And with everything correct it still opens — so the failures above
        // are the AAD and not a broken fixture.
        assertEquals(
            plaintext,
            String(
                hexToBytes(
                    org.llamenos.core.mobileSymmetricDecrypt(
                        ciphertextHex = message.encryptedContent,
                        keyHex = keyHex,
                        aadHex = correctContentAad,
                    ),
                ),
                Charsets.UTF_8,
            ),
        )
        svc.lock()
    }

    private inline fun expectFailure(what: String, block: () -> Unit) {
        try {
            block()
            fail("$what — the AAD is being accepted and ignored")
        } catch (_: org.llamenos.core.CryptoException) {
            // expected
        }
    }

    private fun hexToBytes(hex: String): ByteArray =
        ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    private companion object {
        const val TAG = "EnvelopeAadInterop"
        const val DEVICE_ID = "aad-interop-device"
        const val PIN = "24681357"
    }
}
