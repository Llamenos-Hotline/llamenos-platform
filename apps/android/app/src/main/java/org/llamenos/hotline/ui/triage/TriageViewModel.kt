package org.llamenos.hotline.ui.triage

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import org.llamenos.hotline.api.ApiService
import org.llamenos.hotline.hub.ActiveHubState
import org.llamenos.hotline.model.CmsReportTypesResponse
import org.llamenos.hotline.model.ConvertFromReportResponse
import org.llamenos.hotline.model.EntityTypeDefinition
import org.llamenos.hotline.model.EntityTypesResponse
import org.llamenos.hotline.model.Report
import org.llamenos.hotline.model.ReportsListResponse
import org.llamenos.protocol.ConvertFromReportBody
import org.llamenos.protocol.ReportTypeDefinition
import javax.inject.Inject

/**
 * Conversion status filters for the triage queue.
 */
enum class TriageStatusFilter(val apiValue: String?) {
    ALL(null),
    PENDING("pending"),
    IN_PROGRESS("in_progress"),
    COMPLETED("completed"),
}

data class TriageUiState(
    val reports: List<Report> = emptyList(),
    val total: Int = 0,
    val isLoading: Boolean = true,
    val isRefreshing: Boolean = false,
    val error: String? = null,
    val selectedFilter: TriageStatusFilter = TriageStatusFilter.PENDING,
    val reportTypes: List<ReportTypeDefinition> = emptyList(),
    /** Case types a report can be converted into — `GET /settings/cms/entity-types`, archived ones dropped. */
    val entityTypes: List<EntityTypeDefinition> = emptyList(),
    val isConverting: Boolean = false,
    val selectedReport: Report? = null,
    val lastConvertedRecordId: String? = null,
)

/**
 * ViewModel for the triage queue screen.
 *
 * Fetches reports with `conversionEnabled=true` from the reports API.
 * Supports filtering by conversion status and converting reports to case records.
 */
@HiltViewModel
class TriageViewModel @Inject constructor(
    private val apiService: ApiService,
    private val activeHubState: ActiveHubState,
) : ViewModel() {

    private val _uiState = MutableStateFlow(TriageUiState())
    val uiState: StateFlow<TriageUiState> = _uiState.asStateFlow()

    init {
        activeHubState.activeHubId
            .filterNotNull()
            .onEach { loadTriageQueue() }
            .launchIn(viewModelScope)
    }

    fun loadTriageQueue() {
        viewModelScope.launch {
            _uiState.update {
                it.copy(
                    isLoading = it.reports.isEmpty(),
                    isRefreshing = it.reports.isNotEmpty(),
                    error = null,
                )
            }
            val reportsDeferred = async { fetchReports() }
            val typesDeferred = async { fetchReportTypes() }
            val entityTypesDeferred = async { fetchEntityTypes() }
            reportsDeferred.await()
            typesDeferred.await()
            entityTypesDeferred.await()
        }
    }

    private suspend fun fetchReports() {
        try {
            val filter = _uiState.value.selectedFilter
            val path = buildString {
                append(apiService.activeHubPath("/api/reports"))
                append("?conversionEnabled=true&limit=50")
                filter.apiValue?.let { append("&conversionStatus=$it") }
            }
            val response = apiService.request<ReportsListResponse>("GET", path)
            _uiState.update {
                it.copy(
                    reports = response.conversations,
                    total = response.total,
                    isLoading = false,
                    isRefreshing = false,
                )
            }
        } catch (e: Exception) {
            _uiState.update {
                it.copy(
                    isLoading = false,
                    isRefreshing = false,
                    error = e.message ?: "Failed to load triage queue",
                )
            }
        }
    }

    private suspend fun fetchReportTypes() {
        try {
            val response = apiService.request<CmsReportTypesResponse>(
                "GET",
                "/api/settings/cms/report-types",
            )
            _uiState.update { it.copy(reportTypes = response.reportTypes) }
        } catch (_: Exception) {
            // Report types are optional
        }
    }

    /**
     * The conversion route needs the id of the case type to create, so the picker is fed
     * from the hub's entity types. Failing to load them is surfaced rather than swallowed:
     * without one the Convert action has nothing to send.
     */
    private suspend fun fetchEntityTypes() {
        try {
            val response = apiService.request<EntityTypesResponse>(
                "GET",
                apiService.hp("/api/settings/cms/entity-types"),
            )
            _uiState.update { it.copy(entityTypes = response.entityTypes.filterNot { type -> type.isArchived }) }
        } catch (e: Exception) {
            _uiState.update { it.copy(error = e.message ?: "Failed to load entity types") }
        }
    }

    fun setFilter(filter: TriageStatusFilter) {
        _uiState.update { it.copy(selectedFilter = filter, reports = emptyList(), total = 0) }
        loadTriageQueue()
    }

    fun refresh() {
        loadTriageQueue()
    }

    fun selectReport(report: Report) {
        _uiState.update { it.copy(selectedReport = report) }
    }

    fun dismissError() {
        _uiState.update { it.copy(error = null) }
    }

    /**
     * Convert a report to a case record of [entityTypeId] using the atomic conversion
     * endpoint (EP06-A3): `POST /records/convert-from-report`.
     *
     * This replaced `POST /reports/:id/convert-to-case`, which the server has never mounted
     * (#1730), and which sent a title and report type where the real route needs the id of
     * the entity type to create.
     */
    fun convertToEntity(report: Report, entityTypeId: String) {
        viewModelScope.launch {
            _uiState.update { it.copy(isConverting = true, error = null) }
            try {
                val body = ConvertFromReportBody(
                    reportID = report.id,
                    entityTypeID = entityTypeId,
                    additionalFields = JsonObject(emptyMap()),
                )
                val response = apiService.request<ConvertFromReportResponse>(
                    "POST",
                    apiService.hp("/api/records/convert-from-report"),
                    body = body,
                )
                _uiState.update {
                    it.copy(isConverting = false, selectedReport = null, lastConvertedRecordId = response.recordID)
                }
                loadTriageQueue()
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isConverting = false,
                        error = e.message ?: "Failed to convert report",
                    )
                }
            }
        }
    }

    /**
     * Load a single report by ID (for detail screen navigation).
     * Fetches the report from the API and adds it to the reports list
     * so the detail screen can find it.
     */
    fun loadReportById(reportId: String) {
        viewModelScope.launch {
            if (_uiState.value.reports.any { it.id == reportId }) return@launch
            _uiState.update { it.copy(isLoading = true, error = null) }
            try {
                val path = apiService.activeHubPath("/api/reports/$reportId")
                val report = apiService.request<Report>("GET", path)
                _uiState.update {
                    it.copy(
                        reports = it.reports + report,
                        isLoading = false,
                    )
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isLoading = false,
                        error = e.message ?: "Failed to load report",
                    )
                }
            }
            fetchReportTypes()
        }
    }

    /**
     * Resolve a report type label from its ID.
     */
    fun reportTypeLabel(typeId: String?): String? {
        if (typeId == null) return null
        return _uiState.value.reportTypes.find { it.id == typeId }?.label
    }
}
