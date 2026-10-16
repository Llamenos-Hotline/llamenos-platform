package org.llamenos.hotline.model

import kotlinx.serialization.Serializable

// ══════════════════════════════════════════════════════════════════════════════
// Re-exports of generated response types (source of truth for API responses)
// ══════════════════════════════════════════════════════════════════════════════

// ---- System Health ----
// Generated types use Double for numeric fields and ServiceStatusStatus enum
// for status. Extension properties in Extensions.kt adapt these for UI display.

typealias SystemHealth = org.llamenos.protocol.SystemHealthResponse
typealias ServerHealth = org.llamenos.protocol.Server
typealias CallMetrics = org.llamenos.protocol.Calls
typealias StorageInfo = org.llamenos.protocol.Storage
typealias BackupInfo = org.llamenos.protocol.Backup
typealias UserInfo = org.llamenos.protocol.Users
typealias ServiceStatus = org.llamenos.protocol.SystemHealthResponseService

// ---- Users ----
// Generated UserListResponseUser has: pubkey, name, roles, active, createdAt.
// Extension properties in Extensions.kt provide displayName, role, statusString.
typealias User = org.llamenos.protocol.UserListResponseUser
typealias UsersListResponse = org.llamenos.protocol.UserListResponse

// ---- Ban List ----
// Generated BanListResponseBan has: phone, bannedBy, bannedAt, reason.
// Extension properties in Extensions.kt provide identifierHash, createdBy, createdAt.
typealias BanEntry = org.llamenos.protocol.BanListResponseBan
typealias BanListResponse = org.llamenos.protocol.BanListResponse
typealias BulkBanRequest = org.llamenos.protocol.BulkBanBody

// ---- Audit Log ----
typealias AuditLogResponse = org.llamenos.protocol.AuditListResponse

// ---- Invites ----
// Generated Invite has: code, createdAt, createdBy, expiresAt, name, phone, roleIDS, usedAt?, usedBy?.
// Extension properties in Extensions.kt provide role and claimedBy.
typealias Invite = org.llamenos.protocol.Invite
typealias InvitesListResponse = org.llamenos.protocol.InviteListResponse

// ══════════════════════════════════════════════════════════════════════════════
// Client-specific request bodies (simplified shapes for the Android UI)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Request body for adding a ban via POST /api/admin/bans.
 * Client-specific shape — uses `identifier` (pre-hashed on client).
 */
@Serializable
data class AddBanRequest(
    val identifier: String,
    val reason: String? = null,
)

/**
 * Request body for creating an invite.
 * Client-specific simplified shape — the generated CreateInviteBody requires
 * name, phone, and roleIDS (List<String>) while this only needs role.
 */
@Serializable
data class CreateInviteRequest(
    val role: String,
)

// ---- User CRUD ----

/**
 * Request body for creating a user via POST /api/users.
 * Client-specific simplified shape.
 */
@Serializable
data class CreateUserRequest(
    val name: String,
    val phone: String,
    val role: String = "role-volunteer",
)

/**
 * Response from creating a user. Contains the user data
 * and a one-time device key that must be given to the user.
 * Client-only type — no generated equivalent.
 */
@Serializable
data class CreateUserResponse(
    val user: org.llamenos.protocol.UserListResponseUser,
    val deviceKey: String,
)

// ---- Shift Admin ----
//
// Admin shift CRUD (list/create/update/delete) uses the generated types directly —
// org.llamenos.protocol.CreateShiftBody / UpdateShiftBody / FallbackGroup, plus the
// ShiftResponse / ShiftsListResponse typealiases in ShiftModels.kt — rather than a
// hand-written duplicate. The generated `Shift` has `encryptedName`/`userPubkeys`
// where this file used to use `name`/`volunteerIds`; see the `Shift.name` and
// `Shift.volunteerCount` extension properties in Extensions.kt for UI display.
// (Previously diverged from the server schema entirely — same root cause as #1032
// and #1046 — see issue #1149.)

// ---- Custom Fields ----

/**
 * Response from GET /api/admin/custom-fields.
 * CustomFieldDef is a typealias for the protocol-generated CustomFieldDefinition.
 */
@Serializable
data class CustomFieldsResponse(
    val fields: List<org.llamenos.hotline.model.CustomFieldDef>,
)

/**
 * Request body for updating all custom fields via PUT /api/admin/custom-fields.
 */
@Serializable
data class UpdateCustomFieldsRequest(
    val fields: List<org.llamenos.hotline.model.CustomFieldDef>,
)

// ---- Report Categories (Settings) ----

/**
 * A report category with an ID and name, managed via admin settings.
 */
@Serializable
data class ReportCategory(
    val id: String,
    val name: String,
    val createdAt: String? = null,
)

/**
 * Response from GET /api/settings/report-types.
 */
@Serializable
data class ReportTypesResponse(
    val categories: List<ReportCategory>,
)

/**
 * Request body for POST /api/settings/report-types.
 */
@Serializable
data class CreateReportCategoryRequest(
    val name: String,
)

// ---- Admin settings: telephony, call, IVR, transcription, spam ----
//
// All five screens are the generated types now. Each used to carry a
// hand-written request/response pair here describing a shape the server does
// not have, and each save went to a `PUT` the server does not mount (#1724):
//
//   TelephonySettingsRequest/Response{provider,accountSid,authToken,phoneNumber}
//     GET/PUT /api/settings/telephony                    -> 404 on both verbs
//     now: GET /api/settings/telephony-provider  (TelephonyProvider)
//          POST /api/provider-setup/configure    (ConfigureProviderRequest)
//   CallSettingsRequest/Response{ringTimeout,maxCallDuration,parallelRingCount}
//     PUT /api/settings/call                             -> 404
//     now: GET/PATCH /api/settings/call          (CallSettings)
//     Those three settings do not exist server-side and never have; the two it
//     does have are queueTimeoutSeconds and voicemailMaxSeconds.
//   IvrLanguagesRequest/Response{languages:Map<String,Boolean>}
//     PUT /api/settings/ivr-languages                    -> 404, and the map
//     body is rejected 400 by the PATCH that is mounted: the server stores an
//     ordered enabledLanguages array, where position picks the keypad digit.
//     now: GET/PATCH /api/settings/ivr-languages (IvrLanguages)
//   transcription, which had no model at all and used a path with no route:
//     GET /api/admin/settings                            -> 404
//     PUT /api/admin/settings/transcription               -> 404
//     now: GET/PATCH /api/settings/transcription (TranscriptionSettings)
//   SpamSettingsRequest/Response{maxCallsPerHour,voiceCaptchaEnabled,knownNumberBypass}
//     PUT /api/settings/spam                             -> 404
//     now: GET/PATCH /api/settings/spam          (SpamSettings), whose rate
//     limit is per MINUTE, which also carries a block duration, and which has
//     no known-number bypass at all.

typealias TelephonyProviderConfig = org.llamenos.protocol.TelephonyProvider
typealias ConfigureProviderRequest = org.llamenos.protocol.ConfigureProviderRequest
typealias TelephonyProviderType = org.llamenos.protocol.SharedProviderType
typealias CallSettings = org.llamenos.protocol.CallSettings
typealias IvrLanguages = org.llamenos.protocol.IvrLanguages
typealias TranscriptionSettings = org.llamenos.protocol.TranscriptionSettings
typealias SpamSettings = org.llamenos.protocol.SpamSettings
