package org.llamenos.hotline.crypto

import org.llamenos.protocol.EnvelopeRecipientsResponse

/**
 * Who a case record's ciphertexts are sealed to, per tier (#1682).
 *
 * The Android half of the contract `src/client/lib/record-recipients.ts` states
 * for desktop; the platforms must not drift:
 *
 * | payload                       | tier      | because                                  |
 * |-------------------------------|-----------|------------------------------------------|
 * | record summary                | `summary` | every member who may see the case exists |
 * | custom field values           | `fields`  | assignees + admins + `editRoles` holders |
 * | timeline comments, evidence   | `fields`  | the people who work the case             |
 * | contact PII                   | `pii`     | admins + `contacts:view-pii` holders     |
 *
 * The tiers are computed by the server from permissions and `editRoles` slugs
 * (`apps/worker/lib/envelope-recipients.ts`); nothing here names a role. Android
 * sealed a comment to `[admin]` only, so the volunteer assigned to the case
 * could not open what a colleague wrote on it.
 */
data class RecordReaders(
    val summary: List<String>,
    val fields: List<String>,
    val pii: List<String>,
)

/**
 * There is no admin who could read what is about to be written.
 *
 * The same refusal notes make (#1468): an envelope set with no admin reader
 * stores and renders to its author and no admin can ever open it. The caller
 * reports it and writes nothing; it never substitutes a key.
 */
class NoAdminReaderException : IllegalStateException(
    "Cannot save: no admin decryption key is configured, so no admin could read it. " +
        "Ask an administrator to configure one.",
)

object RecordReaderSet {

    private val HEX64 = Regex("^[0-9a-f]{64}$")

    /** The admin decryption key as an HPKE recipient, or null when absent or not 64-hex. */
    fun adminRecipient(hex: String?): String? =
        hex?.trim()?.lowercase()?.takeIf { HEX64.matches(it) }

    /**
     * Author + the server's tier + the admin recipient, in that order.
     *
     * `serverTiers == null` is a failed lookup and not an error: it is advice
     * about who ELSE may read, and a crisis hotline cannot fail to record
     * because an HTTP request for it failed. The author keeps their own
     * envelope and the admin keeps theirs; what the fallback never does is name
     * some other key to stand in — a made-up reader is an envelope nobody can
     * open (#1021). Server entries that are not 64-hex are dropped, not repaired.
     *
     * @throws NoAdminReaderException without an admin recipient.
     */
    fun compose(
        serverTiers: EnvelopeRecipientsResponse?,
        author: String?,
        adminDecryptionPubkey: String?,
    ): RecordReaders {
        val admin = adminRecipient(adminDecryptionPubkey) ?: throw NoAdminReaderException()
        fun tier(server: List<String>?): List<String> =
            (listOfNotNull(author) + (server ?: emptyList()).map { it.lowercase() }.filter { HEX64.matches(it) } + admin)
                .distinctBy { it.lowercase() }
        return RecordReaders(
            summary = tier(serverTiers?.summary),
            fields = tier(serverTiers?.fields),
            pii = tier(serverTiers?.pii),
        )
    }

    /**
     * Readers of an existing record, asked at write time.
     *
     * [lookup] performs `GET /api/records/:id/envelope-recipients`. The admin
     * check runs before it: with no admin recipient the write is refused
     * without spending a round trip.
     */
    suspend fun forRecord(
        author: String?,
        adminDecryptionPubkey: String?,
        lookup: suspend () -> EnvelopeRecipientsResponse,
    ): RecordReaders {
        compose(null, author, adminDecryptionPubkey)
        val tiers = try {
            lookup()
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (_: Exception) {
            null
        }
        return compose(tiers, author, adminDecryptionPubkey)
    }
}
