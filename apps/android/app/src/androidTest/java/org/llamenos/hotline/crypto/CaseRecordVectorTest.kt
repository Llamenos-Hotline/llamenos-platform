package org.llamenos.hotline.crypto

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.llamenos.core.CasePurpose
import org.llamenos.protocol.CryptoLabels
import org.llamenos.protocol.RecipientEnvelope

/**
 * Open, through this app's production readers, case records and case comments
 * as the server persisted them (#2499).
 *
 * Before #2499 Android opened case summaries and fields as stored messages
 * (`LABEL_MESSAGE`, no AAD), sealed case comments as notes and opened them as
 * messages — so it could read neither iOS's case records nor its own comments,
 * while every Android test passed, because each encrypted and decrypted with
 * Android's own choice. The bytes under test here are not Android's:
 * `case-record-vectors.json` (`packages/crypto/tests/fixtures/`) is what
 * `CasesService` stored for ciphertexts `packages/crypto/src/case_record.rs`
 * sealed. Each fixture reader is loaded into a real [CryptoService] through the
 * real `mobileUnlock` path, and the exact bytes are opened with
 * [CryptoService.openCase]. The writer half seals with [CryptoService.sealCase]
 * and opens under the fixture's declared label and AAD with the primitives.
 *
 * Runs on a device/emulator with the debug (`test-kdf`) native library, under
 * `-e cucumberUseAndroidJUnitRunner true -e class <this class>`. No server.
 */
@RunWith(AndroidJUnit4::class)
class CaseRecordVectorTest {

    private val json = Json { ignoreUnknownKeys = true }
    private val fixture: Fixture = InstrumentationRegistry.getInstrumentation().context.assets
        .open(FIXTURE_ASSET).bufferedReader().use { json.decodeFromString(it.readText()) }

    private val services = mutableListOf<CryptoService>()

    @After
    fun lockEverything() {
        services.forEach { it.lock() }
    }

    @Test
    fun theFixtureNamesOneLabelPerPurposeAndTheCanonicalAad() {
        val expected = mapOf(
            "summary" to CryptoLabels.LABEL_CASE_SUMMARY,
            "fields" to CryptoLabels.LABEL_CASE_FIELDS,
            "comment" to CryptoLabels.LABEL_CASE_COMMENT,
        )
        assertEquals(expected.keys, fixture.records.map { it.purpose }.toSet())
        for (rec in fixture.records) {
            assertEquals(expected[rec.purpose], rec.label)
            assertEquals(org.llamenos.core.mobileContentAadHex(rec.label), rec.aadHex.content)
            assertEquals(org.llamenos.core.mobileKeyWrapAadHex(rec.label), rec.aadHex.keyWrap)
            assertEquals(fixture.readers.map { it.x25519PubkeyHex }, rec.readerEnvelopes.map { it.pubkey })
        }
    }

    @Test
    fun everyReaderOpensEveryPersistedCaseCiphertextThroughCryptoService(): Unit = runBlocking {
        for (reader in fixture.readers) {
            val svc = unlockedAs(reader)
            for (rec in fixture.records) {
                assertEquals(
                    "reader ${reader.name} could not open the server-persisted ${rec.name}",
                    rec.plaintext,
                    svc.openCase(rec.casePurpose(), rec.encryptedContent, rec.readerEnvelopes.map { it.wire() }),
                )
            }
        }
    }

    @Test
    fun aDeviceThatIsNotAReaderGetsNull(): Unit = runBlocking {
        val rec = fixture.records.first()
        val volunteer = fixture.readers.first { it.name == "volunteer" }
        val svc = unlockedAs(volunteer)
        val others = rec.readerEnvelopes.filter { it.pubkey != volunteer.x25519PubkeyHex }
        assertNull(svc.openCase(rec.casePurpose(), rec.encryptedContent, others.map { it.wire() }))
    }

    /**
     * The vector discriminates: the stored-message reader this app used for case
     * records until #2499 ([CryptoService.decryptMessage]) opens none of it, and no
     * record opens as another purpose.
     */
    @Test
    fun thePre2499ReaderAndTheOtherPurposesDoNotOpenIt(): Unit = runBlocking {
        val volunteer = fixture.readers.first { it.name == "volunteer" }
        val svc = unlockedAs(volunteer)
        for (rec in fixture.records) {
            assertNull(
                "${rec.name} opened as a stored message",
                svc.decryptMessage(rec.encryptedContent, rec.readerEnvelopes.map { it.wire() }),
            )
            for (other in CasePurpose.entries.filter { it != rec.casePurpose() }) {
                try {
                    svc.openCase(other, rec.encryptedContent, rec.readerEnvelopes.map { it.wire() })
                    fail("${rec.name} opened as $other")
                } catch (_: CryptoException) {
                    // expected
                }
            }
        }
    }

    /**
     * The writer half — and the comment defect: a comment this app seals opens for
     * this app (it could not before) and for the other fixture reader, under the
     * fixture's declared label and AAD, with the primitives rather than [CryptoService.openCase].
     */
    @Test
    fun whatThisAppSealsIsTheServerPersistedFormat(): Unit = runBlocking {
        val volunteer = fixture.readers.first { it.name == "volunteer" }
        val admin = fixture.readers.first { it.name == "admin" }
        for (rec in fixture.records) {
            val plaintext = "android-sealed ${rec.purpose}: ¿estás a salvo? ${System.nanoTime()}"
            val writer = unlockedAs(volunteer)
            val sealed = writer.sealCase(rec.casePurpose(), plaintext, listOf(admin.x25519PubkeyHex))
            assertEquals(listOf(volunteer.x25519PubkeyHex, admin.x25519PubkeyHex), sealed.envelopes.map { it.pubkey })
            assertEquals(plaintext, writer.openCase(rec.casePurpose(), sealed.ciphertextHex, sealed.envelopes))

            unlockedAs(admin)
            val wire = sealed.envelopes.first { it.pubkey == admin.x25519PubkeyHex }
            val keyHex = org.llamenos.core.mobileHpkeOpenKey(
                envelope = org.llamenos.core.HpkeEnvelope(
                    v = HpkeEnvelope.CURRENT_VERSION.toUByte(),
                    labelId = org.llamenos.core.mobileLabelToId(rec.label),
                    enc = org.llamenos.core.mobileHexToBase64url(wire.enc),
                    ct = org.llamenos.core.mobileHexToBase64url(wire.ct),
                ),
                expectedLabel = rec.label,
                aadHex = rec.aadHex.keyWrap,
            )
            val opened = org.llamenos.core.mobileSymmetricDecrypt(
                ciphertextHex = sealed.ciphertextHex,
                keyHex = keyHex,
                aadHex = rec.aadHex.content,
            )
            assertEquals(plaintext, String(fixtureHexToBytes(opened), Charsets.UTF_8))
        }
    }

    private suspend fun unlockedAs(reader: FixtureReader): CryptoService =
        unlockFixtureReader(reader.name, reader.x25519SecretHex, reader.x25519PubkeyHex)
            .also { services += it }

    // ── Fixture shape (case-record-vectors.json) ─────────────────────────

    @Serializable
    private data class Fixture(val readers: List<FixtureReader>, val records: List<FixtureRecord>)

    @Serializable
    private data class FixtureReader(val name: String, val x25519SecretHex: String, val x25519PubkeyHex: String)

    @Serializable
    private data class FixtureAad(val content: String, val keyWrap: String)

    @Serializable
    private data class FixtureRecord(
        val name: String,
        val purpose: String,
        val label: String,
        val aadHex: FixtureAad,
        val plaintext: String,
        val encryptedContent: String,
        val readerEnvelopes: List<FixtureEnvelope>,
    ) {
        fun casePurpose(): CasePurpose = when (purpose) {
            "summary" -> CasePurpose.SUMMARY
            "fields" -> CasePurpose.FIELDS
            "comment" -> CasePurpose.COMMENT
            else -> error("unknown purpose $purpose in $FIXTURE_ASSET")
        }
    }

    @Serializable
    private data class FixtureEnvelope(val pubkey: String, val enc: String, val ct: String) {
        fun wire() = RecipientEnvelope(pubkey = pubkey, enc = enc, ct = ct)
    }

    private companion object {
        const val FIXTURE_ASSET = "case-record-vectors.json"
    }
}
