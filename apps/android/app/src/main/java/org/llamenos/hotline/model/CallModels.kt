package org.llamenos.hotline.model

import kotlinx.serialization.Serializable

// ── Generated response types ────────────────────────────────────────────────

typealias CallRecord = org.llamenos.protocol.CallRecordResponse
typealias CallHistoryRecord = org.llamenos.protocol.SharedCall

/**
 * Active call — a call currently ringing or in progress, held by the hub it belongs to.
 * It never carries the caller's number, its HMAC, or any digits of it: a call is named
 * by its id, its hub and its times.
 *
 * [hubId] is required (#2461). Every call belongs to the hub whose number was dialled,
 * and its actions (answer, hang up, spam, ban) go to that hub's path, which need not be
 * the hub being browsed. A call with no hub would send its actions to an unscoped path
 * the server no longer serves.
 */
data class ActiveCall(
    val id: String,
    val answeredBy: String? = null,
    val startedAt: String,
    val status: String,
    val hubId: String,
)

/**
 * One row of `GET /api/hubs/{hubId}/calls/active` as it is read off the wire. The
 * client binds it to the hub it asked ([inHub]), so the hub a call is held by is the
 * hub its row came from — never a fallback.
 */
@Serializable
data class ActiveCallWire(
    val id: String,
    val answeredBy: String? = null,
    val startedAt: String,
    val status: String,
) {
    fun inHub(hubId: String): ActiveCall = ActiveCall(id, answeredBy, startedAt, status, hubId)
}

/**
 * Response from GET /api/hubs/{hubId}/calls/active — list of the volunteer's active calls.
 * Client-only type wrapping [ActiveCallWire] (not the generated one).
 */
@Serializable
data class ActiveCallsResponse(
    val calls: List<ActiveCallWire>,
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
