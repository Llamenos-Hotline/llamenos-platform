package org.llamenos.hotline.model

import org.llamenos.protocol.BanListResponseBan
import org.llamenos.protocol.CallRecordResponse
import org.llamenos.protocol.Calls
import org.llamenos.protocol.SharedEntry
import org.llamenos.protocol.HubResponse
import org.llamenos.protocol.Invite
import org.llamenos.protocol.Server
import org.llamenos.protocol.Shift
import org.llamenos.protocol.SystemHealthResponseService
import org.llamenos.protocol.UserListResponseUser
import org.llamenos.protocol.Users

/**
 * Extension properties on generated protocol types.
 *
 * These adapt the generated API types for UI display and backward
 * compatibility with existing Android client code.
 */

// ── UserListResponseUser (typealias User) ──────────────────────────────────

/** Alias pubkey as id for UI code that uses `user.id` as a unique key. */
val UserListResponseUser.id: String
    get() = pubkey

/** Display name — the generated type uses `name` directly. */
val UserListResponseUser.displayName: String?
    get() = name.takeIf { it.isNotBlank() }

/** Primary role as a simple String (generated type uses `roles: List<String>`). */
val UserListResponseUser.role: String
    get() = roles.firstOrNull()?.removePrefix("role-") ?: "volunteer"

/** Status string derived from the `active` boolean. */
val UserListResponseUser.status: String
    get() = if (active) "active" else "inactive"

// ── BanListResponseBan (typealias BanEntry) ───────────────────────────────

/** Use phone hash as unique key (generated BanListResponseBan has no `id` field). */
val BanListResponseBan.id: String
    get() = phone

/** The hashed identifier — maps to `phone` in the generated type. */
val BanListResponseBan.identifierHash: String
    get() = phone

/** Who created the ban — maps to `bannedBy` in the generated type. */
val BanListResponseBan.createdBy: String
    get() = bannedBy

/** When the ban was created — maps to `bannedAt` in the generated type. */
val BanListResponseBan.createdAt: String
    get() = bannedAt

// ── SharedEntry (audit log entry) ───────────────────────────────────────────

/** Timestamp — maps to `createdAt` in the generated type. */
val SharedEntry.timestamp: String
    get() = createdAt

/** Details as a display string (generated type uses `JsonObject`). */
val SharedEntry.detailsString: String?
    get() = details.takeIf { it.isNotEmpty() }?.toString()

// ── Invite ─────────────────────────────────────────────────────────────────

/** Use code as unique key (generated Invite has no `id` field). */
val Invite.id: String
    get() = code

/** Primary role from the invite (generated uses `roleIDS: List<String>`). */
val Invite.role: String
    get() = roleIDS.firstOrNull()?.removePrefix("role-") ?: "volunteer"

/** Who claimed the invite — maps to `usedBy` in the generated type. */
val Invite.claimedBy: String?
    get() = usedBy

// ── HubResponse (typealias Hub) ────────────────────────────────────────────

/** Status as a String (generated type uses `HubStatus` enum). */
val HubResponse.statusString: String
    get() = status.value

// ── Shift (inner list item from ShiftListResponse) ────────────────────────

/** Convert Double day indices to Int for display formatting. */
val Shift.dayIndices: List<Int>
    get() = days.map { it.toInt() }

/** Derive a display status from the shift (no status field in generated type). */
val Shift.displayStatus: String
    get() = if (userPubkeys.isEmpty()) "available" else "assigned"

/**
 * Display name — maps to `encryptedName` in the generated type. Despite the
 * field name, no client currently encrypts this value (iOS renders it directly
 * too — see ShiftsView.swift); it is plaintext today.
 */
val Shift.name: String
    get() = encryptedName

/** Number of volunteers assigned to this shift. */
val Shift.volunteerCount: Int
    get() = userPubkeys.size

// ── CallRecordResponse ─────────────────────────────────────────────────────

/** Duration as Int (seconds), converting from Double?. */
val CallRecordResponse.durationSeconds: Int?
    get() = duration?.toInt()

/** Safe boolean accessors for nullable Boolean? fields. */
val CallRecordResponse.hasVoicemailFlag: Boolean
    get() = hasVoicemail == true

val CallRecordResponse.hasTranscriptionFlag: Boolean
    get() = hasTranscription == true

val CallRecordResponse.hasRecordingFlag: Boolean
    get() = hasRecording == true

// ── CallHistoryResponseCall (typealias CallHistoryRecord) ──────────────────

/** Duration as Int (seconds), converting from Double?. */
val CallHistoryResponseCall.durationSeconds: Int?
    get() = duration?.toInt()

val CallHistoryResponseCall.hasVoicemailFlag: Boolean
    get() = hasVoicemail == true

val CallHistoryResponseCall.hasTranscriptionFlag: Boolean
    get() = hasTranscription == true

val CallHistoryResponseCall.hasRecordingFlag: Boolean
    get() = hasRecording == true

// ── ActiveCallsResponseCall (typealias ActiveCall) ─────────────────────────

/** Status as a String (generated type uses `ActiveCallResponseStatus?` enum). */
val ActiveCallsResponseCall.statusString: String
    get() = status?.value ?: "unknown"

// ── Server (typealias ServerHealth) ────────────────────────────────────────

/** Uptime as Int seconds (generated type uses Double). */
val Server.uptimeSeconds: Int
    get() = uptime.toInt()

/** Status as a String (generated type uses `ServiceStatusStatus` enum). */
val Server.statusString: String
    get() = status.value

// ── SystemHealthResponseService (typealias ServiceStatus) ──────────────────

/** Status as a String (generated type uses `ServiceStatusStatus` enum). */
val SystemHealthResponseService.statusString: String
    get() = status.value

// ── Calls (typealias CallMetrics) ──────────────────────────────────────────

/** Int accessors for Double fields in call metrics. */
val Calls.todayInt: Int get() = today.toInt()
val Calls.activeInt: Int get() = active.toInt()
val Calls.missedInt: Int get() = missed.toInt()
val Calls.avgResponseSecondsInt: Int get() = avgResponseSeconds.toInt()

// ── Users (typealias UserInfo) ─────────────────────────────────────────────

/** Int accessors for Double fields in user metrics. */
val Users.totalActiveInt: Int get() = totalActive.toInt()
val Users.onlineNowInt: Int get() = onlineNow.toInt()
val Users.onShiftInt: Int get() = onShift.toInt()
val Users.shiftCoverageInt: Int get() = shiftCoverage.toInt()

// ── SystemHealthResponse (typealias SystemHealth) ──────────────────────────

/** Volunteers — maps to `users` field in generated type. */
val SystemHealth.volunteers: Users
    get() = users
