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
    "Cannot save: this hub has no admin able to read it. " +
        "Ask an administrator to register a device and try again.",
)

object RecordReaderSet {

    private val HEX64 = Regex("^[0-9a-f]{64}$")

    /**
     * Author + the server's tier + the hub's admin readers, in that order.
     *
     * [adminReaders] is the hub's admin reader set exactly as
     * `SessionState.adminReaders` resolved it (the crate's rule, #1035), never a
     * single key. `serverTiers == null` is a failed lookup and not an error: it
     * is advice about who ELSE may read, and a crisis hotline cannot fail to
     * record because an HTTP request for it failed. The author keeps their own
     * envelope and every admin keeps theirs; what the fallback never does is
     * name some other key to stand in — a made-up reader is an envelope nobody
     * can open (#1021). Server entries that are not 64-hex are dropped, not
     * repaired.
     *
     * @throws NoAdminReaderException when [adminReaders] is empty.
     */
    fun compose(
        serverTiers: EnvelopeRecipientsResponse?,
        author: String?,
        adminReaders: List<String>,
    ): RecordReaders {
        if (adminReaders.isEmpty()) throw NoAdminReaderException()
        fun tier(server: List<String>?): List<String> =
            (listOfNotNull(author) + (server ?: emptyList()).map { it.lowercase() }.filter { HEX64.matches(it) } + adminReaders)
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
     * [adminReaders] resolves the hub's admin set (`GET /api/hubs/:hubId/readers`)
     * and [lookup] performs `GET /api/records/:id/envelope-recipients`. The admin
     * set is resolved first: with no admin reader the write is refused without
     * spending the second round trip, and nothing has been written.
     */
    suspend fun forRecord(
        author: String?,
        adminReaders: suspend () -> List<String>,
        lookup: suspend () -> EnvelopeRecipientsResponse,
    ): RecordReaders {
        val admins = adminReaders()
        compose(null, author, admins)
        val tiers = try {
            lookup()
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (_: Exception) {
            null
        }
        return compose(tiers, author, admins)
    }

    /**
     * Readers of an existing record, for a write that REPLACES one of its tiers.
     *
     * Unlike [forRecord] a failed lookup is an error, not a fallback. A re-seal replaces the
     * envelope set, so sealing to the author and the admins alone would silently drop every
     * assignee and `editRoles` holder the record already had (#1682): the write would succeed
     * and those volunteers could no longer open the case.
     *
     * @throws NoAdminReaderException when [adminReaders] is empty.
     */
    suspend fun forReseal(
        author: String?,
        adminReaders: suspend () -> List<String>,
        lookup: suspend () -> EnvelopeRecipientsResponse,
    ): RecordReaders {
        val admins = adminReaders()
        return compose(lookup(), author, admins)
    }

    /**
     * Readers of a record that does not exist yet, asked at write time.
     *
     * [lookup] performs `GET /api/records/envelope-recipients?entityTypeId=…`,
     * which names the tiers for a new record of that type. Failure semantics are
     * those of [forRecord]: no admin recipient refuses the write before the
     * request; a failed lookup leaves the author and the admin.
     */
    suspend fun forNewRecord(
        author: String?,
        adminReaders: suspend () -> List<String>,
        lookup: suspend () -> EnvelopeRecipientsResponse,
    ): RecordReaders = forRecord(author, adminReaders, lookup)
}
