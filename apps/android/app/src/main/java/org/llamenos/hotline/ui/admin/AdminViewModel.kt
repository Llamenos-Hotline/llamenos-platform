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
import org.llamenos.hotline.model.CallSettingsRequest
import org.llamenos.hotline.model.CallSettingsResponse
import org.llamenos.hotline.model.CreateInviteRequest
import org.llamenos.hotline.model.CreateReportCategoryRequest
import org.llamenos.hotline.model.CreateShiftRequest
import org.llamenos.hotline.model.CreateUserRequest
import org.llamenos.hotline.model.CreateUserResponse
import org.llamenos.hotline.model.CustomFieldDef
import org.llamenos.hotline.model.CustomFieldsResponse
import org.llamenos.hotline.model.FallbackGroupRequest
import org.llamenos.hotline.model.Invite
import org.llamenos.hotline.model.InvitesListResponse
import org.llamenos.hotline.model.IvrLanguagesRequest
import org.llamenos.hotline.model.IvrLanguagesResponse
import org.llamenos.hotline.model.AdminShiftDetail
import org.llamenos.hotline.model.AdminShiftsListResponse
import org.llamenos.hotline.model.ReportCategory
import org.llamenos.hotline.model.ReportTypesResponse
import org.llamenos.hotline.model.SpamSettingsRequest
import org.llamenos.hotline.model.SpamSettingsResponse
import org.llamenos.hotline.model.SystemHealth
import org.llamenos.hotline.model.TelephonySettingsRequest
import org.llamenos.hotline.model.TelephonySettingsResponse
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
    val adminShifts: List<AdminShiftDetail> = emptyList(),
    val isLoadingAdminShifts: Boolean = false,
    val adminShiftsError: String? = null,
    val showCreateShiftDialog: Boolean = false,
    val editingShift: AdminShiftDetail? = null,

    // Admin settings (transcription)
    val transcriptionEnabled: Boolean = false,
    val transcriptionOptOut: Boolean = false,
    val isLoadingSettings: Boolean = false,
    val settingsError: String? = null,

    // Report categories
    val reportCategories: List<ReportCategory> = emptyList(),
    val isLoadingCategories: Boolean = false,
    val categoriesError: String? = null,
    val showAddCategoryDialog: Boolean = false,

    // Telephony settings
    val telephonyProvider: String = "twilio",
    val telephonyAccountSid: String = "",
    val telephonyAuthToken: String = "",
    val telephonyPhoneNumber: String = "",
    val isLoadingTelephony: Boolean = false,
    val telephonyError: String? = null,

    // Call settings
    val ringTimeout: Int = 30,
    val maxCallDuration: Int = 60,
    val parallelRingCount: Int = 3,
    val isLoadingCallSettings: Boolean = false,
    val callSettingsError: String? = null,

    // IVR languages
    val ivrLanguages: Map<String, Boolean> = emptyMap(),
    val isLoadingIvrLanguages: Boolean = false,
    val ivrLanguagesError: String? = null,

    // Spam settings
    val maxCallsPerHour: Int = 10,
    val voiceCaptchaEnabled: Boolean = false,
    val knownNumberBypass: Boolean = true,
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
                    "/api/admin/audit?page=$page&limit=50",
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
                val response = apiService.request<AdminShiftsListResponse>(
                    "GET", "/api/admin/shifts",
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

    fun showEditShiftDialog(shift: AdminShiftDetail) {
        _uiState.update { it.copy(showCreateShiftDialog = true, editingShift = shift) }
    }

    fun dismissShiftDialog() {
        _uiState.update { it.copy(showCreateShiftDialog = false, editingShift = null) }
    }

    fun createShift(name: String, startTime: String, endTime: String, volunteerIds: List<String> = emptyList()) {
        viewModelScope.launch {
            _uiState.update { it.copy(showCreateShiftDialog = false, editingShift = null, adminShiftsError = null) }
            try {
                val request = CreateShiftRequest(
                    name = name, startTime = startTime, endTime = endTime, volunteerIds = volunteerIds,
                )
                apiService.requestNoContent("POST", "/api/admin/shifts", request)
                loadAdminShifts()
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(adminShiftsError = e.message ?: "Failed to create shift")
                }
            }
        }
    }

    fun updateShift(shiftId: String, name: String, startTime: String, endTime: String, volunteerIds: List<String> = emptyList()) {
        viewModelScope.launch {
            _uiState.update { it.copy(showCreateShiftDialog = false, editingShift = null, adminShiftsError = null) }
            try {
                val request = CreateShiftRequest(
                    name = name, startTime = startTime, endTime = endTime, volunteerIds = volunteerIds,
                )
                apiService.requestNoContent("PUT", "/api/admin/shifts/$shiftId", request)
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
                apiService.requestNoContent("DELETE", "/api/admin/shifts/$shiftId")
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
                val request = FallbackGroupRequest(volunteerIds = volunteerIds)
                apiService.requestNoContent("PUT", "/api/admin/shifts/fallback", request)
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

    private fun loadTranscriptionSettings() {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoadingSettings = true, settingsError = null) }
            try {
                val response = apiService.request<Map<String, Any>>(
                    "GET",
                    "/api/admin/settings",
                )
                _uiState.update {
                    it.copy(
                        transcriptionEnabled = response["transcriptionEnabled"] as? Boolean ?: false,
                        transcriptionOptOut = response["allowVolunteerOptOut"] as? Boolean ?: false,
                        isLoadingSettings = false,
                    )
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(isLoadingSettings = false, settingsError = e.message)
                }
            }
        }
    }

    fun toggleTranscription(enabled: Boolean) {
        viewModelScope.launch {
            _uiState.update { it.copy(settingsError = null) }
            try {
                apiService.requestNoContent(
                    "PUT",
                    "/api/admin/settings/transcription",
                    mapOf("enabled" to enabled),
                )
                _uiState.update { it.copy(transcriptionEnabled = enabled) }
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
                apiService.requestNoContent(
                    "PUT",
                    "/api/admin/settings/transcription",
                    mapOf("allowVolunteerOptOut" to allowed),
                )
                _uiState.update { it.copy(transcriptionOptOut = allowed) }
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

    fun loadTelephonySettings() {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoadingTelephony = true, telephonyError = null) }
            try {
                val response = apiService.request<TelephonySettingsResponse>(
                    "GET", "/api/settings/telephony",
                )
                _uiState.update {
                    it.copy(
                        telephonyProvider = response.provider,
                        telephonyAccountSid = response.accountSid,
                        telephonyAuthToken = response.authToken,
                        telephonyPhoneNumber = response.phoneNumber,
                        isLoadingTelephony = false,
                    )
                }
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

    fun updateTelephonyProvider(provider: String) {
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

    fun saveTelephonySettings() {
        viewModelScope.launch {
            _uiState.update { it.copy(telephonyError = null) }
            try {
                val state = _uiState.value
                val request = TelephonySettingsRequest(
                    provider = state.telephonyProvider,
                    accountSid = state.telephonyAccountSid,
                    authToken = state.telephonyAuthToken,
                    phoneNumber = state.telephonyPhoneNumber,
                )
                apiService.requestNoContent("PUT", "/api/settings/telephony", request)
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
                val response = apiService.request<CallSettingsResponse>(
                    "GET", "/api/settings/call",
                )
                _uiState.update {
                    it.copy(
                        ringTimeout = response.ringTimeout,
                        maxCallDuration = response.maxCallDuration,
                        parallelRingCount = response.parallelRingCount,
                        isLoadingCallSettings = false,
                    )
                }
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

    fun updateRingTimeout(value: Int) {
        _uiState.update { it.copy(ringTimeout = value) }
    }

    fun updateMaxCallDuration(value: Int) {
        _uiState.update { it.copy(maxCallDuration = value) }
    }

    fun updateParallelRingCount(value: Int) {
        _uiState.update { it.copy(parallelRingCount = value) }
    }

    fun saveCallSettings() {
        viewModelScope.launch {
            _uiState.update { it.copy(callSettingsError = null) }
            try {
                val state = _uiState.value
                val request = CallSettingsRequest(
                    ringTimeout = state.ringTimeout,
                    maxCallDuration = state.maxCallDuration,
                    parallelRingCount = state.parallelRingCount,
                )
                apiService.requestNoContent("PUT", "/api/settings/call", request)
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
                val response = apiService.request<IvrLanguagesResponse>(
                    "GET", "/api/settings/ivr-languages",
                )
                _uiState.update {
                    it.copy(ivrLanguages = response.languages, isLoadingIvrLanguages = false)
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

    fun toggleIvrLanguage(code: String, enabled: Boolean) {
        _uiState.update {
            it.copy(ivrLanguages = it.ivrLanguages + (code to enabled))
        }
    }

    fun saveIvrLanguages() {
        viewModelScope.launch {
            _uiState.update { it.copy(ivrLanguagesError = null) }
            try {
                val request = IvrLanguagesRequest(languages = _uiState.value.ivrLanguages)
                apiService.requestNoContent("PUT", "/api/settings/ivr-languages", request)
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
                val response = apiService.request<SpamSettingsResponse>(
                    "GET", "/api/settings/spam",
                )
                _uiState.update {
                    it.copy(
                        maxCallsPerHour = response.maxCallsPerHour,
                        voiceCaptchaEnabled = response.voiceCaptchaEnabled,
                        knownNumberBypass = response.knownNumberBypass,
                        isLoadingSpamSettings = false,
                    )
                }
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

    fun updateMaxCallsPerHour(value: Int) {
        _uiState.update { it.copy(maxCallsPerHour = value) }
    }

    fun toggleVoiceCaptcha(enabled: Boolean) {
        _uiState.update { it.copy(voiceCaptchaEnabled = enabled) }
    }

    fun toggleKnownNumberBypass(enabled: Boolean) {
        _uiState.update { it.copy(knownNumberBypass = enabled) }
    }

    fun saveSpamSettings() {
        viewModelScope.launch {
            _uiState.update { it.copy(spamSettingsError = null) }
            try {
                val state = _uiState.value
                val request = SpamSettingsRequest(
                    maxCallsPerHour = state.maxCallsPerHour,
                    voiceCaptchaEnabled = state.voiceCaptchaEnabled,
                    knownNumberBypass = state.knownNumberBypass,
                )
                apiService.requestNoContent("PUT", "/api/settings/spam", request)
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
