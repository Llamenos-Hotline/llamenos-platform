package org.llamenos.hotline.helpers

import kotlinx.serialization.Serializable

/**
 * Response of `POST /api/test-seed`, mirroring `seedResultSchema` in
 * `apps/worker/lib/test-seed-result.ts` (#3088).
 *
 * This file is deliberately pure Kotlin + kotlinx.serialization — no Android, no
 * HTTP — and its directory is also a source root of the JVM unit-test source set,
 * so `SeedResultTest` can decode the server's wire JSON without an emulator.
 *
 * Defaults fail closed: a response missing `ok` is not ok.
 */
@Serializable
data class SeedStep(
    val step: String,
    /** `"ok"` or `"failed"`. */
    val outcome: String,
    val error: String? = null,
)

@Serializable
data class EntityTypeResult(
    val id: String = "",
    val name: String = "",
    val category: String = "",
)

@Serializable
data class RecordResult(
    val id: String = "",
    val entityTypeId: String = "",
    val caseNumber: String? = null,
)

@Serializable
data class IdResult(val id: String = "")

@Serializable
data class PubkeyResult(val pubkey: String = "")

@Serializable
data class SeedResult(
    val ok: Boolean = false,
    val hubId: String = "",
    val entityTypes: List<EntityTypeResult> = emptyList(),
    val records: List<RecordResult> = emptyList(),
    val reportTypes: List<IdResult> = emptyList(),
    val triageReports: List<IdResult> = emptyList(),
    val shifts: List<IdResult> = emptyList(),
    val contacts: List<IdResult> = emptyList(),
    val members: List<PubkeyResult> = emptyList(),
    /** Every requested step, in order, with what happened to it. */
    val steps: List<SeedStep> = emptyList(),
    /** `"<step>: <error>"` per failed step; empty exactly when [ok]. */
    val failures: List<String> = emptyList(),
    /** Notes about steps that DID happen. Never a substitute for a failure. */
    val warnings: List<String> = emptyList(),
) {
    /** Returns this result, or throws naming every step that did not happen. */
    fun requireOk(): SeedResult {
        if (ok && failures.isEmpty()) return this
        val named = failures.ifEmpty { listOf("server reported ok=false without naming a step") }
        throw SeedFailedException(named, this)
    }
}

/** A seed step the server could not perform; the message names each one. */
class SeedFailedException(
    val failures: List<String>,
    val result: SeedResult,
) : IllegalStateException("test-seed failed (${failures.size} step(s)): ${failures.joinToString("; ")}")
