package org.llamenos.hotline.crypto

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The device backup through this app's production path (#3053): [CryptoService]
 * over UniFFI into `packages/crypto/src/backup.rs` (v6).
 *
 * 1. Round trip: data sealed to the device BEFORE the backup — a note sealed to
 *    its X25519 key — opens on the restored device, and the restored device's
 *    X-Wing key is the one its genesis named. (The crate derives that key from
 *    the restored seed and unlocking checks it, so equality proves the seed came
 *    back; the crate's own test decapsulates an X-Wing ciphertext with it.)
 * 2. Refusal: a backup without the X-Wing seed — the committed v5 vector and a
 *    v6 file relabelled v5 — is refused as [BackupMissingXwingSeedException],
 *    whose message names the missing seed, and loads nothing.
 *
 * Runs on a device/emulator with the native library. No server.
 */
@RunWith(AndroidJUnit4::class)
class DeviceBackupTest {

    private val pin = "13572468"
    private val newPin = "86427531"

    @Test
    fun aRestoredDeviceOpensWhatWasSealedToItBeforeTheBackup() = runBlocking {
        val original = CryptoService()
        assertTrue("the native crypto library must be loaded", original.nativeLibLoaded)
        val blob = original.generateDeviceKeys("backup-android", pin)

        val note = original.encryptNote("""{"text":"sealed before the backup"}""", listOf(blob.state.encryptionPubkeyHex))
        val genesisPayload = original.userInitPayload()
        val genesis = original.createSigchainLink("g", 1, null, "2026-11-26T00:00:00Z", genesisPayload)
        val chainNamed = original
            .verifySigchain(Json.encodeToString(kotlinx.serialization.json.JsonArray.serializer(), kotlinx.serialization.json.JsonArray(listOf(linkJson(genesis)))))
            .activeDeviceKeys.single().encryptionPubkey
        assertEquals(blob.state.kemPubkeyHex, chainNamed)

        val recoveryKey = original.generateRecoveryKey()
        val backup = original.createBackup(pin, recoveryKey)
        original.lock()

        val restored = CryptoService()
        val restoredBlob = restored.restoreBackup(backup, recoveryKey, true, newPin, "backup-android-restored")
        val opened = restored.decryptNote(note.ciphertextHex, note.envelopes.single().hpkeEnvelope)
        assertEquals("sealed before the backup", opened?.text)
        assertEquals(chainNamed, restoredBlob.state.kemPubkeyHex)
        assertEquals(chainNamed, restored.kemPubkeyHex)
        // The restored blob unlocks under the new PIN to the same keys.
        restored.lock()
        assertEquals(chainNamed, CryptoService().unlockWithPin(restoredBlob, newPin).kemPubkeyHex)
    }

    @Test
    fun aBackupWithoutTheXwingSeedIsRefusedByName() = runBlocking {
        val original = CryptoService()
        original.generateDeviceKeys("backup-android-v5", pin)
        val recoveryKey = original.generateRecoveryKey()
        val v6 = Json.parseToJsonElement(original.createBackup(pin, recoveryKey)).jsonObject
        original.lock()
        val relabelled = JsonObject(v6 + ("v" to JsonPrimitive(5))).toString()

        val committed = InstrumentationRegistry.getInstrumentation().context.assets
            .open("backup-v5-without-xwing-seed.json").bufferedReader()
            .use { Json.parseToJsonElement(it.readText()).jsonObject }
        val cases = listOf(
            Triple("relabelled v6", relabelled, recoveryKey),
            Triple("committed v5", committed.getValue("backup").toString(), committed.getValue("recoveryKey").jsonPrimitive.content),
        )
        for ((name, file, credential) in cases) {
            val restored = CryptoService()
            try {
                restored.restoreBackup(file, credential, true, newPin, "r")
                fail("$name: restored")
            } catch (e: BackupMissingXwingSeedException) {
                assertTrue("$name: ${e.message}", e.message.orEmpty().contains("X-Wing seed"))
            }
            assertFalse("$name: a refused backup loads nothing", restored.isUnlocked)
        }
    }

    private fun linkJson(l: org.llamenos.core.SigchainLink) = kotlinx.serialization.json.buildJsonObject {
        put("id", JsonPrimitive(l.id))
        put("seq", JsonPrimitive(l.seq.toLong()))
        put("prevHash", l.prevHash?.let { JsonPrimitive(it) } ?: kotlinx.serialization.json.JsonNull)
        put("entryHash", JsonPrimitive(l.entryHash))
        put("signerDeviceId", JsonPrimitive(l.signerDeviceId))
        put("signerPubkey", JsonPrimitive(l.signerPubkey))
        put("signature", JsonPrimitive(l.signature))
        put("timestamp", JsonPrimitive(l.timestamp))
        put("payloadJson", JsonPrimitive(l.payloadJson))
    }
}
