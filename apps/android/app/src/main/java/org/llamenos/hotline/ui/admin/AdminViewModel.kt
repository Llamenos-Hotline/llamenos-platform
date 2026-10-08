package org.llamenos.hotline.ui.admin

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import org.llamenos.hotline.api.ApiService
import org.llamenos.hotline.model.AddBanRequest
import org.llamenos.protocol.SharedEntry
import org.llamenos.hotline.model.AuditLogResponse
import org.llamenos.hotline.model.BanEntry
import org.llamenos.hotline.model.BanListResponse
import org.llamenos.hotline.model.BulkBanRequest
import org.llamenos.hotline.model.CallSettings
import org.llamenos.hotline.model.CreateInviteRequest
import org.llamenos.hotline.model.CreateReportCategoryRequest
import org.llamenos.hotline.model.CreateUserRequest
import org.llamenos.hotline.model.CreateUserResponse
import org.llamenos.hotline.model.CustomFieldDef
import org.llamenos.hotline.model.CustomFieldsResponse
import org.llamenos.hotline.model.Invite
import org.llamenos.hotline.model.InvitesListResponse
import org.llamenos.hotline.model.IvrLanguages
import org.llamenos.hotline.model.ShiftResponse
import org.llamenos.hotline.model.ShiftsListResponse
import org.llamenos.protocol.CreateShiftBody
import org.llamenos.protocol.FallbackGroup
import org.llamenos.protocol.UpdateShiftBody
import org.llamenos.hotline.model.ReportCategory
import org.llamenos.hotline.model.ReportTypesResponse
import org.llamenos.hotline.model.SpamSettings
import org.llamenos.hotline.model.SystemHealth
import org.llamenos.hotline.model.ConfigureProviderRequest
import org.llamenos.hotline.model.TelephonyProviderConfig
import org.llamenos.hotline.model.TelephonyProviderType
import org.llamenos.hotline.model.TranscriptionSettings
import org.llamenos.hotline.model.UpdateCustomFieldsRequest
import org.llamenos.hotline.model.User
import org.llamenos.hotline.model.UsersListResponse
import org.llamenos.hotline.model.displayName
import org.llamenos.hotline.model.id
import org.llamenos.hotline.model.identifierHash
import javax.inject.Inject

/**
 * Admin panel tab indices for the TabRow.
 */
enum class AdminTab {
    VOLUNTEERS,
    BANS,
    AUDIT,
    INVITES,
    FIELDS,
    SCHEMA,
    SHIFTS,
    SETTINGS,
    SYSTEM_HEALTH,
}

data class ErasureRequestEntry(
    val id: String,
    val userId: String,
    val status: String,
    val requestedAt: String?,
    val executeAt: String?,
    val requestedBy: String?,
    val justification: String?,
    val emergencyOverride: Boolean = false,
)

data class RetentionCategoryEntry(
    val category: String,
    var retentionDays: Int?,
    val minRetentionDays: Int? = null,
)

/**
 * Defaults and ranges for the settings the server really has, mirroring the
 * fallbacks and the clamps in `packages/protocol/schemas/settings.ts` and
 * `apps/worker/services/settings.ts`. A value outside one of these ranges is
 * rejected by the validator before anything is stored.
 */
const val DEFAULT_QUEUE_TIMEOUT_SECONDS = 90
const val DEFAULT_VOICEMAIL_MAX_SECONDS = 120
const val DEFAULT_MAX_CALLS_PER_MINUTE = 3
const val DEFAULT_BLOCK_DURATION_MINUTES = 30

/** `callSettingsSchema`: both values are `.int().min(30).max(300)`. */
val CALL_SECONDS_RANGE = 30..300

/** `spamSettingsSchema`: `maxCallsPerMinute` is `.min(1).max(100)`. */
val MAX_CALLS_PER_MINUTE_RANGE = 1..100

/** `spamSettingsSchema`: `blockDurationMinutes` is `.min(1).max(1440)`. */
val BLOCK_DURATION_MINUTES_RANGE = 1..1440

data class AdminUiState(
    val selectedTab: AdminTab = AdminTab.VOLUNTEERS,
    val selectedAdminSection: String = "location-lookup",

    // Users
    val volunteers: List<User> = emptyList(),
    val isLoadingVolunteers: Boolean = false,
    val volunteersError: String? = null,
    val volunteerSearchQuery: String = "",
    val showAddVolunteerDialog: Boolean = false,
    val createdVolunteerDeviceKey: String? = null,
    val showDeleteVolunteerDialog: String? = null, // user ID to delete

    // Ban list
    val bans: List<BanEntry> = emptyList(),
    val isLoadingBans: Boolean = false,
    val bansError: String? = null,
    val showAddBanDialog: Boolean = false,
    val showBulkImportDialog: Boolean = false,

    // Audit log
    val auditEntries: List<SharedEntry> = emptyList(),
    val isLoadingAudit: Boolean = false,
    val auditError: String? = null,
    val auditPage: Int = 1,
    val auditTotal: Int = 0,
    val hasMoreAuditPages: Boolean = false,
    val auditSearchQuery: String = "",
    val auditEventFilter: String = "all",

    // Invites
    val invites: List<Invite> = emptyList(),
    val isLoadingInvites: Boolean = false,
    val invitesError: String? = null,
    val showCreateInviteDialog: Boolean = false,
    val createdInviteCode: String? = null,

    // Custom fields
    val customFields: List<CustomFieldDef> = emptyList(),
    val isLoadingFields: Boolean = false,
    val fieldsError: String? = null,
    val showCreateFieldDialog: Boolean = false,
    val editingField: CustomFieldDef? = null,

    // Admin shifts
    val adminShifts: List<ShiftResponse> = emptyList(),
    val isLoadingAdminShifts: Boolean = false,
    val adminShiftsError: String? = null,
    val showCreateShiftDialog: Boolean = false,
    val editingShift: ShiftResponse? = null,

    // Admin settings (transcription) — `globalEnabled` / `allowUserOptOut` of
    // `transcriptionSettingsSchema`, which is the whole of what the server has.
    val transcriptionEnabled: Boolean = false,
    val transcriptionOptOut: Boolean = false,
    val isLoadingSettings: Boolean = false,
    val settingsError: String? = null,

    // Report categories
    val reportCategories: List<ReportCategory> = emptyList(),
    val isLoadingCategories: Boolean = false,
    val categoriesError: String? = null,
    val showAddCategoryDialog: Boolean = false,

    // Telephony settings. The screen's editable state, converted to and from
    // `TelephonyProviderConfig` (read) and `ConfigureProviderRequest` (write)
    // at the wire boundary — two different shapes, so neither is re-described
    // here. `telephonyProvider` is the generated enum, so the picker offers
    // exactly the eight providers the server accepts rather than five.
    val telephonyProvider: TelephonyProviderType = TelephonyProviderType.Twilio,
    val telephonyAccountSid: String = "",
    val telephonyAuthToken: String = "",
    val telephonyPhoneNumber: String = "",
    val isLoadingTelephony: Boolean = false,
    val telephonyError: String? = null,

    // Call settings — the two the server has (`callSettingsSchema`), both in
    // seconds and both clamped to 30...300 server-side. They replace a ring
    // timeout, a maximum call duration and a parallel ring count: three
    // settings with no server field, no storage and no effect.
    val queueTimeoutSeconds: Int = DEFAULT_QUEUE_TIMEOUT_SECONDS,
    val voicemailMaxSeconds: Int = DEFAULT_VOICEMAIL_MAX_SECONDS,
    val isLoadingCallSettings: Boolean = false,
    val callSettingsError: String? = null,

    // IVR languages, in the order callers hear them — position decides the
    // keypad digit, which a Map<String, Boolean> could not express.
    val ivrEnabledLanguages: List<String> = emptyList(),
    val isLoadingIvrLanguages: Boolean = false,
    val ivrLanguagesError: String? = null,

    // Spam settings — the four of `spamSettingsSchema`. The rate limit is per
    // MINUTE (it was labelled per hour), the block duration was never offered,
    // and the known-number bypass the screen showed does not exist server-side:
    // it promised to exempt repeat callers from the CAPTCHA and did nothing.
    val voiceCaptchaEnabled: Boolean = false,
    val rateLimitEnabled: Boolean = true,
    val maxCallsPerMinute: Int = DEFAULT_MAX_CALLS_PER_MINUTE,
    val blockDurationMinutes: Int = DEFAULT_BLOCK_DURATION_MINUTES,
    val isLoadingSpamSettings: Boolean = false,
    val spamSettingsError: String? = null,

    // System health
    val systemHealth: SystemHealth? = null,
    val isLoadingHealth: Boolean = false,
    val healthError: String? = null,

    val erasureRequests: List<ErasureRequestEntry> = emptyList(),
    val isLoadingErasure: Boolean = false,
    val erasureError: String? = null,
    val showImmediateErasureDialog: String? = null,
    val immediateErasureJustification: String = "",

    val retentionCategories: List<RetentionCategoryEntry> = emptyList(),
    val isLoadingRetention: Boolean = false,
    val retentionError: String? = null,
    val isSavingRetention: Boolean = false,

    val platformBans: List<BanEntry> = emptyList(),
    val isLoadingPlatformBans: Boolean = false,
    val platformBansError: String? = null,
    val showAddPlatformBanDialog: Boolean = false,
    val platformBanSearchQuery: String = "",
    val platformBanSearchResults: List<BanEntry> = emptyList(),
)

/**
 * ViewModel for the Admin panel.
 *
 * Provides CRUD operations for users, ban lists, audit logs, and invites.
 * Only accessible to users with admin role. Data is fetched on tab selection
 * to avoid unnecessary API calls.
 *
 * On an admin section screen the route carries [SECTION_ARG]; that section is
 * selected (and its data loaded) once, when the ViewModel is created.
 */
// ══════════════════════════════════════════════════════════════════════════════
// Applying a server copy of a settings group onto the screen state
// ══════════════════════════════════════════════════════════════════════════════
//
// Every one of these routes answers with what it stored — after its own clamps
// and, for telephony, after encrypting the credentials — so the control ends up
// showing the stored value rather than the one that was dragged or typed. Each
// field of the generated types is nullable (the schemas are all-optional input
// shapes), and a field the server did not send keeps its current value rather
// than resetting to a default.

private fun AdminUiState.applying(settings: CallSettings): AdminUiState = copy(
    queueTimeoutSeconds = settings.queueTimeoutSeconds ?: queueTimeoutSeconds,
    voicemailMaxSeconds = settings.voicemailMaxSeconds ?: voicemailMaxSeconds,
)

private fun AdminUiState.applying(settings: TranscriptionSettings): AdminUiState = copy(
    transcriptionEnabled = settings.globalEnabled ?: transcriptionEnabled,
    transcriptionOptOut = settings.allowUserOptOut ?: transcriptionOptOut,
)

/**
 * `voiceCAPTCHAEnabled`, not `voiceCaptchaEnabled`, is the generated property
 * name. The wire key is `voiceCaptchaEnabled` — the schema's — and codegen
 * carries it on a `@SerialName`:
 *
 *     data class SpamSettings (
 *         ...
 *         @SerialName("voiceCaptchaEnabled")
 *         val voiceCAPTCHAEnabled: Boolean? = null
 *     )
 *
 * quicktype's `acronym-style: pascal` does uppercase CAPTCHA, in Swift as well
 * as Kotlin (`packages/protocol/generated/{kotlin/Types.kt,swift/Types.swift}`).
 * Worth stating in the source because `packages/protocol/generated/` is
 * gitignored and built on demand, so the declaration is not in a fresh
 * checkout: reading the property name out of `settings.ts` instead gives the
 * wrong answer, and `bun run codegen` is a prerequisite for compiling — or
 * reviewing — this file.
 */
private fun AdminUiState.applying(settings: SpamSettings): AdminUiState = copy(
    voiceCaptchaEnabled = settings.voiceCAPTCHAEnabled ?: voiceCaptchaEnabled,
    rateLimitEnabled = settings.rateLimitEnabled ?: rateLimitEnabled,
    maxCallsPerMinute = settings.maxCallsPerMinute ?: maxCallsPerMinute,
    blockDurationMinutes = settings.blockDurationMinutes ?: blockDurationMinutes,
)

/** `null` means no provider is configured, which leaves the form empty. */
private fun AdminUiState.applying(provider: TelephonyProviderConfig?): AdminUiState =
    if (provider == null) this else copy(
        telephonyProvider = provider.type,
        telephonyAccountSid = provider.accountSid ?: "",
        telephonyAuthToken = provider.authToken ?: "",
        telephonyPhoneNumber = provider.phoneNumber ?: "",
    )

@HiltViewModel
class AdminViewModel @Inject constructor(
    private val apiService: ApiService,
    savedStateHandle: SavedStateHandle,
) : ViewModel() {

    companion object {
        /** Route argument naming the admin sidebar section a screen shows. */
        const val SECTION_ARG = "section"
    }

    private val _uiState = MutableStateFlow(AdminUiState())
    val uiState: StateFlow<AdminUiState> = _uiState.asStateFlow()

    /**
     * One-shot event carrying the one-time volunteer nsec returned by the server.
     * Use a Channel (not StateFlow) so the sensitive value is never retained in persistent
     * ViewModel state — it fires once, is consumed by the UI, and is gone.
     */
    private val _nsecEvent = Channel<String>(Channel.CONFLATED)
    val nsecEvent = _nsecEvent.receiveAsFlow()

    init {
        val section = savedStateHandle.get<String>(SECTION_ARG)
        if (section != null) selectAdminSection(section) else loadVolunteers()
    }

    /**
     * Switch to a different admin tab and load its data.
     */
    fun selectTab(tab: AdminTab) {
        _uiState.update { it.copy(selectedTab = tab) }
        when (tab) {
            AdminTab.VOLUNTEERS -> loadVolunteers()
            AdminTab.BANS -> loadBans()
            AdminTab.AUDIT -> loadAuditLog(page = 1)
            AdminTab.INVITES -> loadInvites()
            AdminTab.FIELDS -> loadCustomFields()
            AdminTab.SCHEMA -> { /* Schema browser handled inline via SchemaBrowserViewModel */ }
            AdminTab.SHIFTS -> loadAdminShifts()
            AdminTab.SETTINGS -> loadAdminSettings()
            AdminTab.SYSTEM_HEALTH -> loadSystemHealth()
        }
    }

    /**
     * Select an admin section by slug (used by sidebar navigation).
     * Loads relevant data for sections that need it.
     */
    fun selectAdminSection(slug: String) {
        _uiState.update { it.copy(selectedAdminSection = slug) }
        when (slug) {
            "transcription" -> loadTranscriptionSettings()
            "report-types" -> loadReportCategories()
            "call-settings" -> loadCallSettings()
            "phone-menu-languages" -> loadIvrLanguages()
            "spam-protection" -> loadSpamSettings()
            "phone-provider" -> loadTelephonySettings()
            "custom-fields" -> loadCustomFields()
            "bans", "platform-bans" -> loadBans()
            "audit", "platform-audit" -> loadAuditLog(page = 1)
            "health", "platform-health" -> loadSystemHealth()
            "erasure-queue", "gdpr-erasure" -> loadErasureRequests()
            "retention" -> loadRetentionSettings()
            "platform-bans-manage" -> loadPlatformBans()
        }
    }

    // ---- Users ----

    fun loadVolunteers() {
        viewModelScope.launch {
            _uiState.update {
                it.copy(isLoadingVolunteers = true, volunteersError = null)
            }

            try {
                val response = apiService.request<UsersListResponse>(
                    "GET",
                    "/api/users",
                )
                _uiState.update {
                    it.copy(
                        volunteers = response.users,
                        isLoadingVolunteers = false,
                    )
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isLoadingVolunteers = false,
                        volunteersError = e.message ?: "Failed to load users",
                    )
                }
            }
        }
    }

    fun setVolunteerSearchQuery(query: String) {
        _uiState.update { it.copy(volunteerSearchQuery = query) }
    }

    /**
     * Filter users by search query (matches display name or pubkey prefix).
     */
    fun filteredVolunteers(): List<User> {
        val query = _uiState.value.volunteerSearchQuery.lowercase()
        if (query.isBlank()) return _uiState.value.volunteers

        return _uiState.value.volunteers.filter { user ->
            (user.displayName?.lowercase()?.contains(query) == true) ||
                    user.pubkey.lowercase().contains(query)
        }
    }

    // ---- Ban List ----

    fun loadBans() {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoadingBans = true, bansError = null) }

            try {
                val response = apiService.request<BanListResponse>(
                    "GET",
                    "/api/admin/bans",
                )
                _uiState.update {
                    it.copy(
                        bans = response.bans,
                        isLoadingBans = false,
                    )
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isLoadingBans = false,
                        bansError = e.message ?: "Failed to load ban list",
                    )
                }
            }
        }
    }

    fun showAddBanDialog() {
        _uiState.update { it.copy(showAddBanDialog = true) }
    }

    fun dismissAddBanDialog() {
        _uiState.update { it.copy(showAddBanDialog = false) }
    }

    fun addBan(identifier: String, reason: String?) {
        viewModelScope.launch {
            _uiState.update { it.copy(showAddBanDialog = false, bansError = null) }

            try {
                val request = AddBanRequest(
                    identifier = identifier,
                    reason = reason?.takeIf { it.isNotBlank() },
                )
                apiService.requestNoContent("POST", "/api/admin/bans", request)
                loadBans()
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(bansError = e.message ?: "Failed to add ban")
                }
            }
        }
    }

    fun removeBan(banId: String) {
        viewModelScope.launch {
            _uiState.update { it.copy(bansError = null) }

            try {
                apiService.requestNoContent("DELETE", "/api/admin/bans/$banId")
                loadBans()
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(bansError = e.message ?: "Failed to remove ban")
                }
            }
        }
    }

    // ---- Audit Log ----

    fun loadAuditLog(page: Int = 1) {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoadingAudit = true, auditError = null) }

            try {
                val response = apiService.request<AuditLogResponse>(
                    "GET",
                    apiService.hp("/api/audit") + "?page=$page&limit=50",
                )

                _uiState.update {
                    val allEntries = if (page == 1) {
                        response.entries
                    } else {
                        it.auditEntries + response.entries
                    }
                    it.copy(
                        auditEntries = allEntries,
                        isLoadingAudit = false,
                        auditPage = page,
                        auditTotal = response.total.toInt(),
                        hasMoreAuditPages = allEntries.size < response.total.toInt(),
                    )
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isLoadingAudit = false,
                        auditError = e.message ?: "Failed to load audit log",
                    )
                }
            }
        }
    }

    fun loadNextAuditPage() {
        val state = _uiState.value
        if (!state.hasMoreAuditPages || state.isLoadingAudit) return
        loadAuditLog(page = state.auditPage + 1)
    }

    // ---- Invites ----

    fun loadInvites() {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoadingInvites = true, invitesError = null) }

            try {
                val response = apiService.request<InvitesListResponse>(
                    "GET",
                    "/api/admin/invites",
                )
                _uiState.update {
                    it.copy(
                        invites = response.invites,
                        isLoadingInvites = false,
                    )
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isLoadingInvites = false,
                        invitesError = e.message ?: "Failed to load invites",
                    )
                }
            }
        }
    }

    fun showCreateInviteDialog() {
        _uiState.update { it.copy(showCreateInviteDialog = true, createdInviteCode = null) }
    }

    fun dismissCreateInviteDialog() {
        _uiState.update { it.copy(showCreateInviteDialog = false, createdInviteCode = null) }
    }

    fun createInvite(role: String) {
        viewModelScope.launch {
            _uiState.update { it.copy(invitesError = null) }

            try {
                val request = CreateInviteRequest(role = role)
                val invite = apiService.request<Invite>(
                    "POST",
                    "/api/admin/invites",
                    request,
                )
                _uiState.update {
                    it.copy(createdInviteCode = invite.code)
                }
                loadInvites()
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        invitesError = e.message ?: "Failed to create invite",
                    )
                }
            }
        }
    }

    fun clearCreatedInviteCode() {
        _uiState.update { it.copy(createdInviteCode = null) }
    }

    // ---- User CRUD ----

    fun showAddVolunteerDialog() {
        _uiState.update { it.copy(showAddVolunteerDialog = true, createdVolunteerDeviceKey = null) }
    }

    fun dismissAddVolunteerDialog() {
        _uiState.update { it.copy(showAddVolunteerDialog = false) }
    }

    fun clearCreatedVolunteerDeviceKey() {
        _uiState.update { it.copy(createdVolunteerDeviceKey = null) }
    }

    fun createVolunteer(name: String, phone: String, role: String = "role-volunteer") {
        viewModelScope.launch {
            _uiState.update { it.copy(showAddVolunteerDialog = false, volunteersError = null) }
            try {
                val request = CreateUserRequest(name = name, phone = phone, role = role)
                val response = apiService.request<CreateUserResponse>(
                    "POST", "/api/users", request,
                )
                _uiState.update { it.copy(createdVolunteerDeviceKey = response.deviceKey) }
                loadVolunteers()
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(volunteersError = e.message ?: "Failed to create user")
                }
            }
        }
    }

    fun showDeleteVolunteerDialog(volunteerId: String) {
        _uiState.update { it.copy(showDeleteVolunteerDialog = volunteerId) }
    }

    fun dismissDeleteVolunteerDialog() {
        _uiState.update { it.copy(showDeleteVolunteerDialog = null) }
    }

    fun deleteVolunteer(volunteerId: String) {
        viewModelScope.launch {
            _uiState.update { it.copy(showDeleteVolunteerDialog = null, volunteersError = null) }
            try {
                apiService.requestNoContent("DELETE", "/api/users/$volunteerId")
                loadVolunteers()
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(volunteersError = e.message ?: "Failed to delete user")
                }
            }
        }
    }

    // ---- Bulk Ban Import ----

    fun showBulkImportDialog() {
        _uiState.update { it.copy(showBulkImportDialog = true) }
    }

    fun dismissBulkImportDialog() {
        _uiState.update { it.copy(showBulkImportDialog = false) }
    }

    fun bulkImportBans(phones: List<String>, reason: String?) {
        viewModelScope.launch {
            _uiState.update { it.copy(showBulkImportDialog = false, bansError = null) }
            try {
                val request = BulkBanRequest(
                    phones = phones,
                    reason = reason?.takeIf { it.isNotBlank() },
                )
                apiService.requestNoContent("POST", "/api/admin/bans/bulk", request)
                loadBans()
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(bansError = e.message ?: "Failed to import bans")
                }
            }
        }
    }

    // ---- Audit Filters ----

    fun setAuditSearchQuery(query: String) {
        _uiState.update { it.copy(auditSearchQuery = query) }
        loadAuditLog(page = 1)
    }

    fun setAuditEventFilter(filter: String) {
        _uiState.update { it.copy(auditEventFilter = filter) }
        loadAuditLog(page = 1)
    }

    fun clearAuditFilters() {
        _uiState.update { it.copy(auditSearchQuery = "", auditEventFilter = "all") }
        loadAuditLog(page = 1)
    }

    // ---- Custom Fields ----

    fun loadCustomFields() {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoadingFields = true, fieldsError = null) }
            try {
                val response = apiService.request<CustomFieldsResponse>(
                    "GET", "/api/admin/custom-fields",
                )
                _uiState.update {
                    it.copy(customFields = response.fields, isLoadingFields = false)
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(isLoadingFields = false, fieldsError = e.message ?: "Failed to load fields")
                }
            }
        }
    }

    fun showCreateFieldDialog() {
        _uiState.update { it.copy(showCreateFieldDialog = true, editingField = null) }
    }

    fun showEditFieldDialog(field: CustomFieldDef) {
        _uiState.update { it.copy(showCreateFieldDialog = true, editingField = field) }
    }

    fun dismissFieldDialog() {
        _uiState.update { it.copy(showCreateFieldDialog = false, editingField = null) }
    }

    fun saveCustomField(field: CustomFieldDef) {
        viewModelScope.launch {
            _uiState.update { it.copy(showCreateFieldDialog = false, editingField = null, fieldsError = null) }
            try {
                val currentFields = _uiState.value.customFields.toMutableList()
                val existingIndex = currentFields.indexOfFirst { it.id == field.id }
                if (existingIndex >= 0) {
                    currentFields[existingIndex] = field
                } else {
                    currentFields.add(field)
                }
                val request = UpdateCustomFieldsRequest(fields = currentFields)
                apiService.requestNoContent("PUT", "/api/admin/custom-fields", request)
                loadCustomFields()
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(fieldsError = e.message ?: "Failed to save field")
                }
            }
        }
    }

    fun deleteCustomField(fieldId: String) {
        viewModelScope.launch {
            _uiState.update { it.copy(fieldsError = null) }
            try {
                val updatedFields = _uiState.value.customFields.filter { it.id != fieldId }
                val request = UpdateCustomFieldsRequest(fields = updatedFields)
                apiService.requestNoContent("PUT", "/api/admin/custom-fields", request)
                loadCustomFields()
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(fieldsError = e.message ?: "Failed to delete field")
                }
            }
        }
    }

    // ---- Admin Shift Management ----

    fun loadAdminShifts() {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoadingAdminShifts = true, adminShiftsError = null) }
            try {
                val response = apiService.request<ShiftsListResponse>(
                    "GET", apiService.hp("/api/shifts"),
                )
                _uiState.update {
                    it.copy(adminShifts = response.shifts, isLoadingAdminShifts = false)
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isLoadingAdminShifts = false,
                        adminShiftsError = e.message ?: "Failed to load shifts",
                    )
                }
            }
        }
    }

    fun showCreateShiftDialog() {
        _uiState.update { it.copy(showCreateShiftDialog = true, editingShift = null) }
    }

    fun showEditShiftDialog(shift: ShiftResponse) {
        _uiState.update { it.copy(showCreateShiftDialog = true, editingShift = shift) }
    }

    fun dismissShiftDialog() {
        _uiState.update { it.copy(showCreateShiftDialog = false, editingShift = null) }
    }

    /**
     * Create a new shift. [days] is the 0=Sun..6=Sat recurrence (see
     * [org.llamenos.hotline.util.DateFormatUtils.shortDayName]) — always required,
     * since the server has no default for a brand-new shift.
     */
    fun createShift(
        name: String,
        startTime: String,
        endTime: String,
        days: List<Int>,
        volunteerIds: List<String> = emptyList(),
    ) {
        viewModelScope.launch {
            _uiState.update { it.copy(showCreateShiftDialog = false, editingShift = null, adminShiftsError = null) }
            try {
                val request = CreateShiftBody(
                    id = java.util.UUID.randomUUID().toString(),
                    encryptedName = name,
                    startTime = startTime,
                    endTime = endTime,
                    days = days.map { it.toLong() },
                    userPubkeys = volunteerIds,
                )
                apiService.requestNoContent("POST", apiService.hp("/api/shifts"), request)
                loadAdminShifts()
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(adminShiftsError = e.message ?: "Failed to create shift")
                }
            }
        }
    }

    /**
     * Update an existing shift. [days] is always sent explicitly (never defaulted) —
     * the edit dialog pre-fills it from the shift being edited, so saving an unrelated
     * field (name, time) never silently rewrites recurrence (issue #1149).
     * [volunteerIds] defaults to null (omitted from the request) so that saving from
     * this dialog — which doesn't surface volunteer assignment — never wipes the
     * existing roster; volunteer assignment happens via [ShiftDetailViewModel].
     */
    fun updateShift(
        shiftId: String,
        name: String,
        startTime: String,
        endTime: String,
        days: List<Int>,
        volunteerIds: List<String>? = null,
    ) {
        viewModelScope.launch {
            _uiState.update { it.copy(showCreateShiftDialog = false, editingShift = null, adminShiftsError = null) }
            try {
                val request = UpdateShiftBody(
                    encryptedName = name,
                    startTime = startTime,
                    endTime = endTime,
                    days = days.map { it.toLong() },
                    userPubkeys = volunteerIds,
                )
                // PATCH, the only update verb the server mounts on this path
                // (`shifts.patch('/:id')`). The `PUT` sent here before answered
                // 404, so no shift edit from Android was ever stored — the same
                // defect as the nine admin settings screens in #1724.
                apiService.requestNoContent("PATCH", apiService.hp("/api/shifts/$shiftId"), request)
                loadAdminShifts()
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(adminShiftsError = e.message ?: "Failed to update shift")
                }
            }
        }
    }

    fun deleteShift(shiftId: String) {
        viewModelScope.launch {
            _uiState.update { it.copy(adminShiftsError = null) }
            try {
                apiService.requestNoContent("DELETE", apiService.hp("/api/shifts/$shiftId"))
                loadAdminShifts()
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(adminShiftsError = e.message ?: "Failed to delete shift")
                }
            }
        }
    }

    fun setFallbackGroup(volunteerIds: List<String>) {
        viewModelScope.launch {
            _uiState.update { it.copy(adminShiftsError = null) }
            try {
                val request = FallbackGroup(userPubkeys = volunteerIds)
                apiService.requestNoContent("PUT", apiService.hp("/api/shifts/fallback"), request)
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(adminShiftsError = e.message ?: "Failed to set fallback group")
                }
            }
        }
    }

    // ---- Admin Settings ----

    private fun loadAdminSettings() {
        loadTranscriptionSettings()
        // Load all settings sub-sections in parallel
        loadReportCategories()
        loadTelephonySettings()
        loadCallSettings()
        loadIvrLanguages()
        loadSpamSettings()
    }

    /**
     * Load the hub's transcription settings.
     *
     * `GET /api/settings/transcription` — the path the server mounts. This used
     * to read `/api/admin/settings`, which does not exist: the worker mounts
     * only `/admin/security-events`, `/admin/devices` and `/admin/events` under
     * that prefix, so the request 404'd and both switches sat at `false`
     * whatever the hub actually had configured (#1724).
     */
    private fun loadTranscriptionSettings() {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoadingSettings = true, settingsError = null) }
            try {
                val stored = apiService.request<TranscriptionSettings>(
                    "GET",
                    "/api/settings/transcription",
                )
                _uiState.update { it.applying(stored).copy(isLoadingSettings = false) }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(isLoadingSettings = false, settingsError = e.message)
                }
            }
        }
    }

    /**
     * Turn transcription on or off for the whole hub.
     *
     * `PATCH /api/settings/transcription`, the only write method the server
     * mounts, with the route's own response applied back onto the switch — so
     * it ends up showing what was stored rather than what was tapped.
     */
    fun toggleTranscription(enabled: Boolean) {
        viewModelScope.launch {
            _uiState.update { it.copy(settingsError = null) }
            try {
                val stored = apiService.request<TranscriptionSettings>(
                    "PATCH",
                    "/api/settings/transcription",
                    TranscriptionSettings(globalEnabled = enabled),
                )
                _uiState.update { it.applying(stored) }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(settingsError = e.message ?: "Failed to update transcription")
                }
            }
        }
    }

    fun toggleTranscriptionOptOut(allowed: Boolean) {
        viewModelScope.launch {
            _uiState.update { it.copy(settingsError = null) }
            try {
                val stored = apiService.request<TranscriptionSettings>(
                    "PATCH",
                    "/api/settings/transcription",
                    TranscriptionSettings(allowUserOptOut = allowed),
                )
                _uiState.update { it.applying(stored) }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(settingsError = e.message ?: "Failed to update opt-out setting")
                }
            }
        }
    }

    // ---- Report Categories ----

    fun loadReportCategories() {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoadingCategories = true, categoriesError = null) }
            try {
                val response = apiService.request<ReportTypesResponse>(
                    "GET", "/api/settings/report-types",
                )
                _uiState.update {
                    it.copy(reportCategories = response.categories, isLoadingCategories = false)
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isLoadingCategories = false,
                        categoriesError = e.message ?: "Failed to load report categories",
                    )
                }
            }
        }
    }

    fun showAddCategoryDialog() {
        _uiState.update { it.copy(showAddCategoryDialog = true) }
    }

    fun dismissAddCategoryDialog() {
        _uiState.update { it.copy(showAddCategoryDialog = false) }
    }

    fun addReportCategory(name: String) {
        viewModelScope.launch {
            _uiState.update { it.copy(showAddCategoryDialog = false, categoriesError = null) }
            try {
                val request = CreateReportCategoryRequest(name = name)
                apiService.requestNoContent("POST", "/api/settings/report-types", request)
                loadReportCategories()
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(categoriesError = e.message ?: "Failed to add category")
                }
            }
        }
    }

    fun deleteReportCategory(categoryId: String) {
        viewModelScope.launch {
            _uiState.update { it.copy(categoriesError = null) }
            try {
                apiService.requestNoContent("DELETE", "/api/settings/report-types/$categoryId")
                loadReportCategories()
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(categoriesError = e.message ?: "Failed to delete category")
                }
            }
        }
    }

    // ---- Telephony Settings ----

    /**
     * Load the configured telephony provider.
     *
     * `GET /api/settings/telephony-provider` — the path the server mounts and
     * the one the desktop client reads. `/api/settings/telephony` has never
     * existed and answers 404 on every verb, so this screen showed an empty
     * form however the hub was configured (#1724).
     *
     * The route answers a bare `null` when no provider has been configured yet,
     * which is the empty form and not an error.
     */
    fun loadTelephonySettings() {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoadingTelephony = true, telephonyError = null) }
            try {
                val stored = apiService.request<TelephonyProviderConfig?>(
                    "GET", "/api/settings/telephony-provider",
                )
                _uiState.update { it.applying(stored).copy(isLoadingTelephony = false) }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isLoadingTelephony = false,
                        telephonyError = e.message ?: "Failed to load telephony settings",
                    )
                }
            }
        }
    }

    fun updateTelephonyProvider(provider: TelephonyProviderType) {
        _uiState.update { it.copy(telephonyProvider = provider) }
    }

    fun updateTelephonyAccountSid(value: String) {
        _uiState.update { it.copy(telephonyAccountSid = value) }
    }

    fun updateTelephonyAuthToken(value: String) {
        _uiState.update { it.copy(telephonyAuthToken = value) }
    }

    fun updateTelephonyPhoneNumber(value: String) {
        _uiState.update { it.copy(telephonyPhoneNumber = value) }
    }

    /**
     * Save the telephony provider.
     *
     * `POST /api/provider-setup/configure`, which is the only write path for a
     * provider: `PATCH /api/settings/telephony-provider` is mounted but answers
     * 400 "updateTelephonyProvider is deprecated — use POST
     * /provider-setup/configure which encrypts credentials at rest". The
     * credentials travel in the request's `credentials` map and the service
     * encrypts them before storing.
     *
     * That route answers `{ ok: true }` rather than the stored provider, so the
     * screen re-reads it — which, for this screen, is the only way to see that
     * a credential was accepted.
     */
    fun saveTelephonySettings() {
        viewModelScope.launch {
            _uiState.update { it.copy(telephonyError = null) }
            try {
                val state = _uiState.value
                val credentials = buildMap {
                    if (state.telephonyAccountSid.isNotEmpty()) put("accountSid", state.telephonyAccountSid)
                    if (state.telephonyAuthToken.isNotEmpty()) put("authToken", state.telephonyAuthToken)
                }
                apiService.requestNoContent(
                    "POST",
                    "/api/provider-setup/configure",
                    ConfigureProviderRequest(
                        provider = state.telephonyProvider,
                        credentials = credentials.ifEmpty { null },
                        phoneNumber = state.telephonyPhoneNumber.ifEmpty { null },
                    ),
                )
                val stored = apiService.request<TelephonyProviderConfig?>(
                    "GET", "/api/settings/telephony-provider",
                )
                _uiState.update { it.applying(stored) }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(telephonyError = e.message ?: "Failed to save telephony settings")
                }
            }
        }
    }

    // ---- Call Settings ----

    fun loadCallSettings() {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoadingCallSettings = true, callSettingsError = null) }
            try {
                val stored = apiService.request<CallSettings>(
                    "GET", "/api/settings/call",
                )
                _uiState.update { it.applying(stored).copy(isLoadingCallSettings = false) }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isLoadingCallSettings = false,
                        callSettingsError = e.message ?: "Failed to load call settings",
                    )
                }
            }
        }
    }

    fun updateQueueTimeout(value: Int) {
        _uiState.update { it.copy(queueTimeoutSeconds = value) }
    }

    fun updateVoicemailMax(value: Int) {
        _uiState.update { it.copy(voicemailMaxSeconds = value) }
    }

    /**
     * Save the hub's two call settings.
     *
     * `PATCH`, the only write method the server mounts on this path
     * (`settings.patch('/call')`); the `PUT` sent here before answered 404, so
     * no call setting entered on Android has ever been stored. The route
     * answers with the settings after its own 30...300 clamp, so the response
     * is applied back onto the sliders.
     */
    fun saveCallSettings() {
        viewModelScope.launch {
            _uiState.update { it.copy(callSettingsError = null) }
            try {
                val state = _uiState.value
                val stored = apiService.request<CallSettings>(
                    "PATCH",
                    "/api/settings/call",
                    CallSettings(
                        queueTimeoutSeconds = state.queueTimeoutSeconds,
                        voicemailMaxSeconds = state.voicemailMaxSeconds,
                    ),
                )
                _uiState.update { it.applying(stored) }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(callSettingsError = e.message ?: "Failed to save call settings")
                }
            }
        }
    }

    // ---- IVR Languages ----

    fun loadIvrLanguages() {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoadingIvrLanguages = true, ivrLanguagesError = null) }
            try {
                val stored = apiService.request<IvrLanguages>(
                    "GET", "/api/settings/ivr-languages",
                )
                _uiState.update {
                    it.copy(
                        ivrEnabledLanguages = stored.enabledLanguages,
                        isLoadingIvrLanguages = false,
                    )
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isLoadingIvrLanguages = false,
                        ivrLanguagesError = e.message ?: "Failed to load IVR languages",
                    )
                }
            }
        }
    }

    /**
     * Enable or disable one IVR language.
     *
     * Enabling appends, so a newly enabled language takes the last keypad
     * position instead of displacing the ones callers already know.
     */
    fun toggleIvrLanguage(code: String, enabled: Boolean) {
        _uiState.update { state ->
            val next = when {
                enabled && code !in state.ivrEnabledLanguages -> state.ivrEnabledLanguages + code
                !enabled -> state.ivrEnabledLanguages - code
                else -> state.ivrEnabledLanguages
            }
            state.copy(ivrEnabledLanguages = next)
        }
    }

    /**
     * Save the hub's IVR languages.
     *
     * `PATCH`, the only write method on this path; the `PUT` sent before
     * answered 404. The body is the ordered `enabledLanguages` array the server
     * stores — the `{"languages": {code: bool}}` map sent before is rejected
     * with 400 "expected array, received undefined" even on the right verb. The
     * route validates the list against the configured provider's voice catalog
     * and answers with what it stored, so the response is applied back.
     */
    fun saveIvrLanguages() {
        viewModelScope.launch {
            _uiState.update { it.copy(ivrLanguagesError = null) }
            try {
                val stored = apiService.request<IvrLanguages>(
                    "PATCH",
                    "/api/settings/ivr-languages",
                    IvrLanguages(enabledLanguages = _uiState.value.ivrEnabledLanguages),
                )
                _uiState.update { it.copy(ivrEnabledLanguages = stored.enabledLanguages) }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(ivrLanguagesError = e.message ?: "Failed to save IVR languages")
                }
            }
        }
    }

    // ---- Spam Settings ----

    fun loadSpamSettings() {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoadingSpamSettings = true, spamSettingsError = null) }
            try {
                val stored = apiService.request<SpamSettings>(
                    "GET", "/api/settings/spam",
                )
                _uiState.update { it.applying(stored).copy(isLoadingSpamSettings = false) }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isLoadingSpamSettings = false,
                        spamSettingsError = e.message ?: "Failed to load spam settings",
                    )
                }
            }
        }
    }

    fun updateMaxCallsPerMinute(value: Int) {
        _uiState.update { it.copy(maxCallsPerMinute = value) }
    }

    fun updateBlockDuration(value: Int) {
        _uiState.update { it.copy(blockDurationMinutes = value) }
    }

    fun toggleVoiceCaptcha(enabled: Boolean) {
        _uiState.update { it.copy(voiceCaptchaEnabled = enabled) }
    }

    fun toggleRateLimit(enabled: Boolean) {
        _uiState.update { it.copy(rateLimitEnabled = enabled) }
    }

    /**
     * Save the hub's spam mitigation settings.
     *
     * `PATCH`, the only write method the server mounts on this path; the `PUT`
     * sent before answered 404. The route answers with the stored settings and
     * they are applied back onto the controls.
     */
    fun saveSpamSettings() {
        viewModelScope.launch {
            _uiState.update { it.copy(spamSettingsError = null) }
            try {
                val state = _uiState.value
                val stored = apiService.request<SpamSettings>(
                    "PATCH",
                    "/api/settings/spam",
                    SpamSettings(
                        blockDurationMinutes = state.blockDurationMinutes,
                        maxCallsPerMinute = state.maxCallsPerMinute,
                        rateLimitEnabled = state.rateLimitEnabled,
                        // See `applying(SpamSettings)` above: the generated
                        // property is `voiceCAPTCHAEnabled`, serialized as
                        // `voiceCaptchaEnabled`.
                        voiceCAPTCHAEnabled = state.voiceCaptchaEnabled,
                    ),
                )
                _uiState.update { it.applying(stored) }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(spamSettingsError = e.message ?: "Failed to save spam settings")
                }
            }
        }
    }

    // ---- System Health ----

    fun loadSystemHealth() {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoadingHealth = true, healthError = null) }
            try {
                val response = apiService.request<SystemHealth>(
                    "GET", "/api/system/health",
                )
                _uiState.update {
                    it.copy(systemHealth = response, isLoadingHealth = false)
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isLoadingHealth = false,
                        healthError = e.message ?: "Failed to load system health",
                    )
                }
            }
        }
    }

    fun loadErasureRequests() {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoadingErasure = true, erasureError = null) }
            try {
                val response = apiService.request<Map<String, Any?>>(
                    "GET", "/api/erasure/requests",
                )
                val requests = (response["requests"] as? List<*>)?.mapNotNull { rawEntry ->
                    val entry = rawEntry as? Map<*, *> ?: return@mapNotNull null
                    ErasureRequestEntry(
                        id = entry["id"] as? String ?: "",
                        userId = entry["userId"] as? String ?: "",
                        status = entry["status"] as? String ?: "",
                        requestedAt = entry["requestedAt"] as? String,
                        executeAt = entry["executeAt"] as? String,
                        requestedBy = entry["requestedBy"] as? String,
                        justification = entry["justification"] as? String,
                        emergencyOverride = entry["emergencyOverride"] as? Boolean ?: false,
                    )
                } ?: emptyList()
                _uiState.update {
                    it.copy(isLoadingErasure = false, erasureRequests = requests)
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isLoadingErasure = false,
                        erasureError = e.message ?: "Failed to load erasure requests",
                    )
                }
            }
        }
    }

    fun showImmediateErasureDialog(userId: String) {
        _uiState.update {
            it.copy(
                showImmediateErasureDialog = userId,
                immediateErasureJustification = "",
            )
        }
    }

    fun dismissImmediateErasureDialog() {
        _uiState.update { it.copy(showImmediateErasureDialog = null, immediateErasureJustification = "") }
    }

    fun updateImmediateErasureJustification(value: String) {
        _uiState.update { it.copy(immediateErasureJustification = value) }
    }

    fun executeImmediateErasure() {
        viewModelScope.launch {
            val state = _uiState.value
            val userId = state.showImmediateErasureDialog ?: return@launch
            val justification = state.immediateErasureJustification.trim()

            if (justification.isEmpty()) {
                _uiState.update { it.copy(erasureError = "Justification is required") }
                return@launch
            }

            _uiState.update { it.copy(erasureError = null) }
            try {
                apiService.requestNoContent(
                    "POST",
                    "/api/erasure/$userId",
                    mapOf("justification" to justification),
                )
                _uiState.update {
                    it.copy(
                        showImmediateErasureDialog = null,
                        immediateErasureJustification = "",
                    )
                }
                loadErasureRequests()
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(erasureError = e.message ?: "Failed to execute erasure")
                }
            }
        }
    }

    fun remoteWipeDevice(userId: String, devicePubkey: String) {
        viewModelScope.launch {
            _uiState.update { it.copy(erasureError = null) }
            try {
                apiService.requestNoContent(
                    "POST",
                    "/api/erasure/$userId/wipe-device/$devicePubkey",
                )
                loadErasureRequests()
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(erasureError = e.message ?: "Failed to send remote wipe")
                }
            }
        }
    }

    fun loadRetentionSettings() {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoadingRetention = true, retentionError = null) }
            try {
                val response = apiService.request<Map<String, Any?>>(
                    "GET", "/api/retention",
                )
                val categories = (response["categories"] as? List<*>)?.mapNotNull { rawEntry ->
                    val entry = rawEntry as? Map<*, *> ?: return@mapNotNull null
                    RetentionCategoryEntry(
                        category = entry["category"] as? String ?: "",
                        retentionDays = (entry["retentionDays"] as? Number)?.toInt(),
                        minRetentionDays = (entry["minRetentionDays"] as? Number)?.toInt(),
                    )
                } ?: emptyList()
                _uiState.update {
                    it.copy(isLoadingRetention = false, retentionCategories = categories)
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isLoadingRetention = false,
                        retentionError = e.message ?: "Failed to load retention settings",
                    )
                }
            }
        }
    }

    fun updateRetentionDays(category: String, days: Int?) {
        _uiState.update { state ->
            val updated = state.retentionCategories.map { entry ->
                if (entry.category == category) entry.copy(retentionDays = days)
                else entry
            }
            state.copy(retentionCategories = updated)
        }
    }

    fun saveRetentionSettings() {
        viewModelScope.launch {
            _uiState.update { it.copy(isSavingRetention = true, retentionError = null) }
            try {
                val body = mapOf("categories" to _uiState.value.retentionCategories)
                apiService.requestNoContent("PATCH", "/api/retention", body)
                _uiState.update { it.copy(isSavingRetention = false) }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isSavingRetention = false,
                        retentionError = e.message ?: "Failed to save retention settings",
                    )
                }
            }
        }
    }

    fun loadPlatformBans() {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoadingPlatformBans = true, platformBansError = null) }
            try {
                val bansResponse = apiService.request<BanListResponse>("GET", "/api/bans/platform")
                _uiState.update {
                    it.copy(
                        isLoadingPlatformBans = false,
                        platformBans = bansResponse.bans,
                    )
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isLoadingPlatformBans = false,
                        platformBansError = e.message ?: "Failed to load platform bans",
                    )
                }
            }
        }
    }

    fun showAddPlatformBanDialog() {
        _uiState.update { it.copy(showAddPlatformBanDialog = true) }
    }

    fun dismissAddPlatformBanDialog() {
        _uiState.update { it.copy(showAddPlatformBanDialog = false) }
    }

    fun addPlatformBan(identifierHash: String, reason: String?) {
        viewModelScope.launch {
            _uiState.update { it.copy(showAddPlatformBanDialog = false, platformBansError = null) }
            try {
                val body = AddBanRequest(
                    identifier = identifierHash,
                    reason = reason?.takeIf { it.isNotBlank() },
                )
                apiService.requestNoContent("POST", "/api/bans/platform", body)
                loadPlatformBans()
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(platformBansError = e.message ?: "Failed to add platform ban")
                }
            }
        }
    }

    fun removePlatformBan(banId: String) {
        viewModelScope.launch {
            _uiState.update { it.copy(platformBansError = null) }
            try {
                apiService.requestNoContent("DELETE", "/api/bans/platform/$banId")
                loadPlatformBans()
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(platformBansError = e.message ?: "Failed to remove platform ban")
                }
            }
        }
    }

    fun searchPlatformBans(query: String) {
        viewModelScope.launch {
            _uiState.update { it.copy(platformBansError = null) }
            try {
                val response = apiService.request<BanListResponse>(
                    "GET", "/api/bans/platform/search?q=$query",
                )
                _uiState.update {
                    it.copy(platformBanSearchResults = response.bans)
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(platformBansError = e.message ?: "Failed to search bans")
                }
            }
        }
    }

    fun promoteBanToPlatform(banId: String) {
        viewModelScope.launch {
            _uiState.update { it.copy(platformBansError = null) }
            try {
                val ban = _uiState.value.bans.firstOrNull { it.id == banId } ?: return@launch
                val body = AddBanRequest(
                    identifier = ban.identifierHash,
                    reason = ban.reason,
                )
                apiService.requestNoContent("POST", "/api/bans/platform", body)
                loadPlatformBans()
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(platformBansError = e.message ?: "Failed to promote ban")
                }
            }
        }
    }

    fun setPlatformBanSearchQuery(query: String) {
        _uiState.update { it.copy(platformBanSearchQuery = query) }
    }
}
