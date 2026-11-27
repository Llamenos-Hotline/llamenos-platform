package org.llamenos.hotline.ui.cases

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import org.llamenos.core.CasePurpose
import org.llamenos.hotline.api.ApiService
import org.llamenos.hotline.api.SessionState
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.crypto.RecordReaderSet
import org.llamenos.hotline.model.UpdateRecordRequest
import org.llamenos.protocol.EnvelopeRecipientsResponse
import org.llamenos.protocol.RecipientEnvelope
import org.llamenos.protocol.Record
import org.llamenos.protocol.SharedAdminEnvelope

/**
 * Reads and re-seals a record's sealed summary: the one place the title, description, status and
 * severity of a case or an event are opened and written (#2779).
 *
 * The server holds neither status nor severity, so a client that shows, filters or changes one
 * does it here, through the summary.
 */
class RecordSummaries(
    private val apiService: ApiService,
    private val cryptoService: CryptoService,
    private val sessionState: SessionState,
) {

    /** Open a record's sealed summary, or null when this device cannot. */
    suspend fun open(record: Record): DecryptedSummary? {
        if (record.summaryEnvelopes.isEmpty()) return null
        return try {
            val plaintext = cryptoService.openCase(
                CasePurpose.SUMMARY,
                record.encryptedSummary,
                record.summaryEnvelopes.map { it.toRecipientEnvelope() },
            ) ?: return null
            val obj = parseSummaryObject(plaintext) ?: return null
            DecryptedSummary(
                title = obj["title"]?.jsonPrimitive?.contentOrNull,
                description = obj["description"]?.jsonPrimitive?.contentOrNull,
                status = obj["status"]?.jsonPrimitive?.contentOrNull,
                severity = obj["severity"]?.jsonPrimitive?.contentOrNull,
                raw = obj,
            )
        } catch (_: Exception) {
            null
        }
    }

    /**
     * Change a record's status: re-seal its summary with the new status VALUE and file the
     * transition as a sealed status-change entry. Nothing about the status travels in the clear.
     *
     * A status change REPLACES the summary, so the title, description and severity it carries come
     * from the current ciphertext. A summary this device cannot open is refused, never overwritten
     * with a blank one; and so is a re-seal whose reader lookup failed, which would drop every
     * assignee the record already had.
     *
     * @return the record as the server now holds it.
     */
    suspend fun changeStatus(record: Record, status: String): Record {
        val current = open(record)
            ?: error("The case summary cannot be opened on this device, so its status cannot be changed here.")
        val readers = RecordReaderSet.forReseal(
            author = cryptoService.encryptionPubkeyHex,
            adminReaders = { sessionState.adminReaders(apiService) },
        ) {
            apiService.request<EnvelopeRecipientsResponse>(
                "GET",
                apiService.activeHubPath("/api/records/${record.id}/envelope-recipients"),
            )
        }
        val summary = JsonObject(current.raw + ("status" to JsonPrimitive(status)))
        val sealedSummary = cryptoService.sealCase(CasePurpose.SUMMARY, summary.toString(), readers.summary)
        val sealedChange = cryptoService.sealCase(
            CasePurpose.COMMENT,
            CaseTriage.statusChangePlaintext(current.status, status),
            readers.summary,
        )
        fun wire(envelopes: List<RecipientEnvelope>) =
            envelopes.map { SharedAdminEnvelope(ct = it.ct, enc = it.enc, pubkey = it.pubkey) }

        val request = UpdateRecordRequest(
            encryptedSummary = sealedSummary.ciphertextHex,
            summaryEnvelopes = wire(sealedSummary.envelopes),
            statusChangeTypeHash = CaseTriage.STATUS_CHANGE_TYPE,
            statusChangeContent = sealedChange.ciphertextHex,
            statusChangeEnvelopes = wire(sealedChange.envelopes),
        )
        return apiService.request<Record>("PATCH", apiService.activeHubPath("/api/records/${record.id}"), request)
    }
}
