package org.llamenos.hotline.ui.cases

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.Json

/**
 * A record's triage state — its status and severity — lives ONLY in its sealed
 * summary (#2779, #3114). The server holds neither, so everything that shows,
 * filters or sorts by it happens here, after the summary is opened.
 *
 * The summary carries the status and severity VALUES (the stable keys of the entity
 * type's `statuses` / `severities`), never their labels: a label is editable text, and a
 * filter that matched on it would lose every record the day an admin renamed a status.
 *
 * When a status filter is active the server still filters on what it can see (hub, entity
 * type, parent) and pages that candidate set; the client opens each summary and keeps the
 * matches, up to [SCAN_LIMIT]. The bound is never silent: a result that stopped at it says
 * so, and an empty one says so too instead of reading as "none". This is the M1 shape;
 * filtered server pagination returns with v2's per-hub index tokens (D7/E5), which replace
 * the scan.
 */
object CaseTriage {
    /** How many of the newest records a status filter looks through (desktop: `CLIENT_FILTER_SCAN_LIMIT`). */
    const val SCAN_LIMIT = 2000

    /** Records fetched per round trip while scanning (the server's page cap). */
    const val BATCH_SIZE = 100

    /**
     * The interaction type that marks a write as a status change. The server cannot see the
     * status, so it learns that one happened from this and nothing else (registered as known
     * debt, #3118).
     */
    const val STATUS_CHANGE_TYPE = "status_change"

    private val json = Json { ignoreUnknownKeys = true }

    /** The transition a status change seals with its timeline entry: no text, just the two values. */
    fun statusChangePlaintext(previous: String?, next: String): String =
        buildJsonObject {
            put("text", JsonPrimitive(""))
            if (previous != null) put("previousStatus", JsonPrimitive(previous))
            put("newStatus", JsonPrimitive(next))
        }.toString()

    /** `{previous, next}` of a sealed status-change entry, or null when it is not one. */
    fun parseStatusChange(plaintext: String): StatusChange? = try {
        val obj = json.parseToJsonElement(plaintext).jsonObject
        val previous = obj["previousStatus"]?.jsonPrimitive?.contentOrNull
        val next = obj["newStatus"]?.jsonPrimitive?.contentOrNull
        if (previous == null && next == null) null else StatusChange(previous, next)
    } catch (_: Exception) {
        null
    }

    /** A page of [items], the way the server pages an unfiltered list. [page] is 1-based. */
    fun <T> pageOf(items: List<T>, page: Int, pageSize: Int): List<T> {
        val start = (page - 1) * pageSize
        if (start < 0 || start >= items.size) return emptyList()
        return items.subList(start, minOf(start + pageSize, items.size))
    }
}

/** The part of a transition a timeline entry shows. */
data class StatusChange(val previous: String?, val next: String?)

/** One page of the server's candidate set. */
data class CandidatePage<R>(val records: List<R>, val hasMore: Boolean)

/** What a scan found. */
data class ScanResult<R>(
    /** The matches, newest first (the server's `updated_at DESC` order is kept). */
    val matches: List<R>,
    /** Candidates opened. */
    val scanned: Int,
    /** The scan stopped at the bound while candidates remained: older records were not checked. */
    val bounded: Boolean,
)

/**
 * Page through the server-filtered candidate set, keeping the records [matches] accepts, until
 * the set is exhausted or [limit] records have been opened.
 */
suspend fun <R> scanRecords(
    limit: Int = CaseTriage.SCAN_LIMIT,
    batchSize: Int = CaseTriage.BATCH_SIZE,
    fetchPage: suspend (page: Int, limit: Int) -> CandidatePage<R>,
    matches: suspend (R) -> Boolean,
): ScanResult<R> {
    val kept = mutableListOf<R>()
    var scanned = 0
    var page = 1
    val size = minOf(batchSize, limit)

    while (true) {
        val batch = fetchPage(page, size)
        val taken = batch.records.take(limit - scanned)
        for (record in taken) {
            if (matches(record)) kept += record
        }
        scanned += taken.size

        if (scanned >= limit) {
            return ScanResult(kept, scanned, bounded = taken.size < batch.records.size || batch.hasMore)
        }
        if (!batch.hasMore) return ScanResult(kept, scanned, bounded = false)
        page += 1
    }
}

/** The summary's JSON object as opened; empty when the plaintext is not one. */
fun parseSummaryObject(plaintext: String): JsonObject? = try {
    Json.parseToJsonElement(plaintext).jsonObject
} catch (_: Exception) {
    null
}
