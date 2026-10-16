package org.llamenos.hotline.model

import kotlinx.serialization.Serializable

// ── Generated response types ────────────────────────────────────────────────

typealias CallRecord = org.llamenos.protocol.CallRecordResponse
typealias CallHistoryRecord = org.llamenos.protocol.SharedCall

/**
 * Active call — a call currently ringing or in progress, as `/calls/active` sends it.
 * The server keys it `id`, like the generated `SharedCall` (#1129). It never sends the
 * caller's number or its HMAC, only `callerLast4`, so `callerNumber` is always null.
 */
@Serializable
data class ActiveCall(
    val id: String,
    val callerLast4: String? = null,
    val callerNumber: String? = null,
    val answeredBy: String? = null,
    val startedAt: String,
    val status: String,
)

/**
 * Response from GET /api/calls/active — list of the volunteer's active calls.
 * Client-only type wrapping our custom ActiveCall (not the generated one).
 */
@Serializable
data class ActiveCallsResponse(
    val calls: List<ActiveCall>,
)

/**
 * Call history response from GET /calls/history.
 * Uses the generated CallHistoryResponse. Pagination fields are Double.
 */
typealias CallHistoryResponse = org.llamenos.protocol.CallHistoryResponse

/**
 * Today's call count response from GET /calls/today-count.
 * Uses the generated TodayCountResponse. Count is Double.
 */
typealias CallCountResponse = org.llamenos.protocol.TodayCountResponse

// ── Client-specific request types ───────────────────────────────────────────

/**
 * Request body for POST /api/calls/{callId}/ban.
 * Uses the generated BanCallerBody.
 */
typealias BanRequest = org.llamenos.protocol.BanCallerBody
