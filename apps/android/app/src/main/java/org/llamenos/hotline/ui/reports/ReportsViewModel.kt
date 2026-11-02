package org.llamenos.hotline.ui.reports

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json
import org.llamenos.hotline.api.ApiService
import org.llamenos.hotline.api.NoActiveHubException
import org.llamenos.hotline.api.SessionState
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.hub.ActiveHubState
import org.llamenos.hotline.model.AssignReportRequest
import org.llamenos.hotline.model.CreateReportRequest
import org.llamenos.hotline.model.CreateTypedReportRequest
import org.llamenos.hotline.model.GeocodingAutocompleteRequest
import org.llamenos.hotline.model.LocationResult
import org.llamenos.hotline.model.Report
import org.llamenos.hotline.model.ReportCategoriesResponse
import org.llamenos.hotline.model.ReportEnvelope
import org.llamenos.hotline.model.CmsReportTypesResponse
import org.llamenos.hotline.model.ReportsListResponse
import org.llamenos.hotline.model.UpdateReportRequest
import org.llamenos.protocol.ReportTypeDefinition
import javax.inject.Inject

data class ReportsUiState(
    val reports: List<Report> = emptyList(),
    val total: Int = 0,
    val isLoading: Boolean = false,
    val isRefreshing: Boolean = false,
    val error: String? = null,
    val selectedStatus: ReportStatusFilter = ReportStatusFilter.ALL,
    val selectedCategory: String? = null,
    val categories: List<String> = emptyList(),
    val selectedReport: Report? = null,

    // Report types
    val reportTypes: List<ReportTypeDefinition> = emptyList(),
    val isLoadingReportTypes: Boolean = false,
    val reportTypesError: String? = null,
    val selectedReportType: ReportTypeDefinition? = null,
    val fieldValues: Map<String, String> = emptyMap(),

    // Action states
    val isCreating: Boolean = false,
    val isClaiming: Boolean = false,
    val isClosing: Boolean = false,
    val createSuccess: Boolean = false,
    val actionError: String? = null,
) {
    /**
     * Report types filtered to those marked as mobile-optimized.
     * Falls back to all non-archived types if none are mobile-optimized.
     */
    val mobileReportTypes: List<ReportTypeDefinition>
        get() {
            val activeTypes = reportTypes.filter { !it.isArchived }
            val mobileTypes = activeTypes.filter { it.mobileOptimized }
            return mobileTypes.ifEmpty { activeTypes }
        }

    /** Whether CMS report types are available for this hub. */
    val hasReportTypes: Boolean
        get() = reportTypes.any { !it.isArchived }
}

enum class ReportStatusFilter(val queryParam: String?) {
    ALL(null),
    ACTIVE("active"),
    WAITING("waiting"),
    CLOSED("closed"),
}

/**
 * ViewModel for the reports screen.
 *
 * Loads reports from GET /reports with status and category filtering.
 * Supports creating (both legacy and typed), claiming, and closing reports.
 * Fetches CMS report type definitions to drive template-based report creation.
 */
@HiltViewModel
class ReportsViewModel @Inject constructor(
    private val apiService: ApiService,
    private val cryptoService: CryptoService,
    private val sessionState: SessionState,
    private val activeHubState: ActiveHubState,
) : ViewModel() {

    private val _uiState = MutableStateFlow(ReportsUiState())
    val uiState: StateFlow<ReportsUiState> = _uiState.asStateFlow()

    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
    }

    init {
        activeHubState.activeHubId
            .filterNotNull()
            .onEach { loadReports() }
            .launchIn(viewModelScope)
    }

    fun loadReports() {
        viewModelScope.launch {
            _uiState.update {
                it.copy(
                    isLoading = it.reports.isEmpty(),
                    isRefreshing = it.reports.isNotEmpty(),
                    error = null,
                )
            }
            try {
                val query = buildString {
                    append(apiService.activeHubPath("/api/reports"))
                    append("?limit=50")
                    val status = _uiState.value.selectedStatus
                    if (status.queryParam != null) {
                        append("&status=${status.queryParam}")
                    }
                    val category = _uiState.value.selectedCategory
                    if (category != null) {
                        append("&category=$category")
                    }
                }
                val response = apiService.request<ReportsListResponse>("GET", query)
                _uiState.update {
                    it.copy(
                        reports = response.conversations,
                        total = response.total,
                        isLoading = false,
                        isRefreshing = false,
                    )
                }
            } catch (_: NoActiveHubException) {
                // No hub to browse: nothing to load, which is not a failure (#2405).
                _uiState.update {
                    it.copy(reports = emptyList(), total = 0, isLoading = false, isRefreshing = false)
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isLoading = false,
                        isRefreshing = false,
                        error = e.message ?: "Failed to load reports",
                    )
                }
            }
        }
    }

    private fun loadCategories() {
        viewModelScope.launch {
            try {
                val response = apiService.request<ReportCategoriesResponse>("GET", apiService.activeHubPath("/api/reports/categories"))
                _uiState.update { it.copy(categories = response.categories) }
            } catch (_: Exception) {
                // Non-critical — categories are optional
            }
        }
    }

    /**
     * Fetch CMS report type definitions from the backend.
     *
     * Report types drive the template-based report creation flow.
     * If the hub has no CMS report types configured, the legacy
     * free-form report creation screen is used as a fallback.
     */
    fun loadReportTypes() {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoadingReportTypes = true, reportTypesError = null) }
            try {
                val response = apiService.request<CmsReportTypesResponse>(
                    "GET",
                    "/api/settings/cms/report-types",
                )
                _uiState.update {
                    it.copy(
                        reportTypes = response.reportTypes,
                        isLoadingReportTypes = false,
                    )
                }
            } catch (_: Exception) {
                // Non-critical — fall back to legacy report creation
                _uiState.update {
                    it.copy(
                        isLoadingReportTypes = false,
                    )
                }
            }
        }
    }

    /**
     * Select a report type for the typed report creation form.
     */
    fun selectReportType(reportType: ReportTypeDefinition) {
        _uiState.update {
            it.copy(
                selectedReportType = reportType,
                fieldValues = emptyMap(),
                actionError = null,
            )
        }
    }

    /**
     * Update a field value in the current typed report form.
     */
    fun updateFieldValue(fieldName: String, value: String) {
        _uiState.update {
            it.copy(fieldValues = it.fieldValues + (fieldName to value))
        }
    }

    /**
     * Clear the selected report type and field values.
     */
    fun clearReportType() {
        _uiState.update {
            it.copy(
                selectedReportType = null,
                fieldValues = emptyMap(),
            )
        }
    }

    fun refresh() {
        loadReports()
    }

    fun setStatusFilter(filter: ReportStatusFilter) {
        _uiState.update { it.copy(selectedStatus = filter) }
        loadReports()
    }

    fun setCategoryFilter(category: String?) {
        _uiState.update { it.copy(selectedCategory = category) }
        loadReports()
    }

    fun selectReport(report: Report) {
        _uiState.update { it.copy(selectedReport = report) }
    }

    /**
     * Create a new encrypted report (legacy flow without report type).
     *
     * Encrypts the report body with per-report forward secrecy using the same
     * envelope pattern desktop uses for report content (`encryptMessage` /
     * `LABEL_MESSAGE` — see src/client/components/ReportForm.tsx and
     * src/client/components/cases/triage-report-content.tsx, which decrypts
     * report bodies with `decryptMessage`/`LABEL_MESSAGE`). This must stay in
     * sync with desktop's choice of label: HPKE enforces domain separation at
     * decrypt time, so a report encrypted under a different label is
     * unreadable cross-platform even though the ciphertext is otherwise valid.
     */
    fun createReport(title: String, category: String?, body: String) {
        viewModelScope.launch {
            _uiState.update { it.copy(isCreating = true, actionError = null, createSuccess = false) }
            try {
                sessionState.ensureAdminPubkeyLoaded(apiService)
                val encrypted = cryptoService.encryptMessage(body, sessionState.adminPubkeys)
                val envelopes = encrypted.envelopes.map { env ->
                    ReportEnvelope(
                        pubkey = env.pubkey,
                        ct = env.ct,
                        enc = env.enc,
                    )
                }
                val request = CreateReportRequest(
                    title = title,
                    category = category?.takeIf { it.isNotBlank() },
                    encryptedContent = encrypted.ciphertextHex,
                    readerEnvelopes = envelopes,
                )
                apiService.request<Report>("POST", apiService.activeHubPath("/api/reports"), request)
                _uiState.update { it.copy(isCreating = false, createSuccess = true) }
                refresh()
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isCreating = false,
                        actionError = e.message ?: "Failed to create report",
                    )
                }
            }
        }
    }

    /**
     * Create a typed report using the selected report type template.
     *
     * Field values (including any `location`-typed field, whose value is
     * itself a JSON-encoded [org.llamenos.hotline.model.LocationFieldValue])
     * are serialized as a flat JSON map — the same shape desktop's case/entity
     * field editor produces via `JSON.stringify(Object.fromEntries(...))` (see
     * src/client/components/cases/triage-case-creation-panel.tsx and
     * src/client/routes/cases.tsx) — then encrypted with `encryptMessage`
     * (`LABEL_MESSAGE`), matching desktop's `encryptMessage`/`decryptMessage`
     * pair for this same field-values payload. Using a different label here
     * would make the field values undecryptable on the platform that reads
     * them back, since HPKE enforces domain separation at decrypt time.
     *
     * @param reportTypeId The CMS report type ID
     * @param title The user-provided report title
     * @param fieldValues Map of field name to value (strings, including serialized selections)
     */
    fun createTypedReport(
        reportTypeId: String,
        title: String,
        fieldValues: Map<String, String>,
    ) {
        viewModelScope.launch {
            _uiState.update { it.copy(isCreating = true, actionError = null, createSuccess = false) }
            try {
                // Serialize field values as JSON for E2EE encryption
                val fieldsJson = json.encodeToString(
                    MapSerializer(String.serializer(), String.serializer()),
                    fieldValues,
                )

                sessionState.ensureAdminPubkeyLoaded(apiService)
                val encrypted = cryptoService.encryptMessage(fieldsJson, sessionState.adminPubkeys)
                val envelopes = encrypted.envelopes.map { env ->
                    ReportEnvelope(
                        pubkey = env.pubkey,
                        ct = env.ct,
                        enc = env.enc,
                    )
                }

                val reportType = _uiState.value.reportTypes.find { it.id == reportTypeId }
                val request = CreateTypedReportRequest(
                    title = title,
                    category = reportType?.category?.value?.takeIf { it.isNotBlank() && it != "report" },
                    reportTypeId = reportTypeId,
                    encryptedContent = encrypted.ciphertextHex,
                    readerEnvelopes = envelopes,
                )
                apiService.request<Report>("POST", apiService.activeHubPath("/api/reports"), request)
                _uiState.update {
                    it.copy(
                        isCreating = false,
                        createSuccess = true,
                        fieldValues = emptyMap(),
                        selectedReportType = null,
                    )
                }
                refresh()
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isCreating = false,
                        actionError = e.message ?: "Failed to create report",
                    )
                }
            }
        }
    }

    /**
     * Search for address suggestions via the geocoding autocomplete endpoint.
     *
     * Backs the `location`-typed field picker in [TypedReportCreateScreen]. Mirrors
     * desktop's `LocationField` (src/client/components/ui/location-field.tsx):
     * same minimum query length, same endpoint, same "fail soft to no suggestions"
     * behavior on error or rate limiting so a flaky geocoding provider never blocks
     * report creation. `/api/geocoding/autocomplete` is not hub-scoped (mounted only
     * on the top-level `authenticated` router in apps/worker/app.ts) so it is called
     * with the bare path, not [ApiService.hp].
     */
    suspend fun searchLocations(query: String): List<LocationResult> {
        if (query.length < 3) return emptyList()
        return try {
            apiService.request<List<LocationResult>>(
                "POST",
                "/api/geocoding/autocomplete",
                GeocodingAutocompleteRequest(query = query),
            )
        } catch (_: Exception) {
            emptyList()
        }
    }

    /**
     * Clear the create success flag after the UI has navigated back.
     */
    fun clearCreateSuccess() {
        _uiState.update { it.copy(createSuccess = false) }
    }

    /**
     * Claim a report by assigning it to the current volunteer.
     *
     * Sends POST /reports/:id/assign with the current user's pubkey,
     * which also transitions the report status from "waiting" to "active".
     */
    fun claimReport(reportId: String) {
        viewModelScope.launch {
            _uiState.update { it.copy(isClaiming = true, actionError = null) }
            val pubkey = cryptoService.signingPubkeyHex
            if (pubkey == null) {
                _uiState.update {
                    it.copy(isClaiming = false, actionError = "No identity available")
                }
                return@launch
            }
            try {
                val request = AssignReportRequest(assignedTo = pubkey)
                val updated = apiService.request<Report>("POST", apiService.activeHubPath("/api/reports/$reportId/assign"), request)
                _uiState.update {
                    it.copy(
                        isClaiming = false,
                        selectedReport = updated,
                    )
                }
                refresh()
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isClaiming = false,
                        actionError = e.message ?: "Failed to claim report",
                    )
                }
            }
        }
    }

    /**
     * Close a report by updating its status to "closed".
     *
     * Sends PATCH /reports/:id with { status: "closed" }.
     */
    fun closeReport(reportId: String) {
        viewModelScope.launch {
            _uiState.update { it.copy(isClosing = true, actionError = null) }
            try {
                val request = UpdateReportRequest(status = "closed")
                val updated = apiService.request<Report>("PATCH", apiService.activeHubPath("/api/reports/$reportId"), request)
                _uiState.update {
                    it.copy(
                        isClosing = false,
                        selectedReport = updated,
                    )
                }
                refresh()
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isClosing = false,
                        actionError = e.message ?: "Failed to close report",
                    )
                }
            }
        }
    }

    /**
     * Dismiss the action error message.
     */
    fun dismissActionError() {
        _uiState.update { it.copy(actionError = null) }
    }

    fun dismissError() {
        _uiState.update { it.copy(error = null) }
    }
}
