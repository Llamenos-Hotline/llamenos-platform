package org.llamenos.hotline.ui.events

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
import org.llamenos.core.CasePurpose
import org.llamenos.hotline.api.ApiService
import org.llamenos.hotline.api.NoActiveHubException
import org.llamenos.hotline.api.SessionState
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.crypto.NoAdminReaderException
import org.llamenos.hotline.crypto.RecordReaderSet
import org.llamenos.hotline.hub.ActiveHubState
import org.llamenos.hotline.model.CreateRecordRequest
import org.llamenos.hotline.model.EntityTypeDefinition
import org.llamenos.hotline.model.EntityTypesResponse
import org.llamenos.hotline.model.RecordsListResponse
import org.llamenos.hotline.ui.cases.DecryptedSummary
import org.llamenos.hotline.ui.cases.RecordSummaries
import org.llamenos.protocol.EnvelopeRecipientsResponse
import org.llamenos.protocol.Record
import org.llamenos.protocol.SharedAdminEnvelope
import javax.inject.Inject

/**
 * UI state for the events screens.
 *
 * Events are CMS records whose entity type has category === "event".
 * This mirrors the desktop events page which filters entity types by category.
 */
data class EventsUiState(
    // Entity types
    val entityTypes: List<EntityTypeDefinition> = emptyList(),
    val isLoadingEntityTypes: Boolean = false,

    // Event records
    val events: List<Record> = emptyList(),
    /** Record id → opened summary: an event's status lives there, the server holds none. */
    val summaries: Map<String, DecryptedSummary> = emptyMap(),
    val total: Int = 0,
    val isLoading: Boolean = false,
    val isRefreshing: Boolean = false,
    val error: String? = null,

    // Selected event detail
    val selectedEvent: Record? = null,
    val isLoadingDetail: Boolean = false,
    val detailError: String? = null,

    // Child records of the selected event (records whose parentRecordId is the event)
    val childRecords: List<Record> = emptyList(),
    val isLoadingChildren: Boolean = false,
    val childrenError: String? = null,

    // Search
    val searchQuery: String = "",

    // CMS enabled check
    val cmsEnabled: Boolean? = null,

    // Status update
    val isUpdatingStatus: Boolean = false,
    val actionError: String? = null,
    val actionSuccess: String? = null,
) {
    /**
     * Event entity types only (category === "event").
     */
    val eventEntityTypes: List<EntityTypeDefinition>
        get() = entityTypes.filter { it.category == org.llamenos.protocol.SharedEntityTypeDefinitionCategory.Event && !it.isArchived }

    /**
     * Map of entity type ID to definition for quick lookup.
     */
    val entityTypeMap: Map<String, EntityTypeDefinition>
        get() = entityTypes.associateBy { it.id }

    /**
     * Child records of the selected event that are themselves events.
     */
    val subEvents: List<Record>
        get() = childRecords.filter { isEventRecord(it) }

    /**
     * Child records of the selected event that are not events (cases and other entity types).
     */
    val linkedCases: List<Record>
        get() = childRecords.filterNot { isEventRecord(it) }

    private fun isEventRecord(record: Record): Boolean =
        entityTypeMap[record.entityTypeID]?.category == org.llamenos.protocol.SharedEntityTypeDefinitionCategory.Event

    /**
     * Events filtered by search query.
     */
    val filteredEvents: List<Record>
        get() = if (searchQuery.isBlank()) {
            events
        } else {
            val query = searchQuery.lowercase()
            events.filter { record ->
                (record.caseNumber ?: record.id).lowercase().contains(query)
            }
        }
}

/**
 * ViewModel for the events screens (list + detail).
 *
 * Loads entity type definitions filtered to event category, then fetches
 * records for those entity types. Supports search, status updates,
 * and pull-to-refresh.
 */
@HiltViewModel
class EventsViewModel @Inject constructor(
    private val apiService: ApiService,
    private val activeHubState: ActiveHubState,
    private val cryptoService: CryptoService,
    private val sessionState: SessionState,
) : ViewModel() {

    private val _uiState = MutableStateFlow(EventsUiState())
    val uiState: StateFlow<EventsUiState> = _uiState.asStateFlow()

    /** Opens and re-seals an event's summary: its status lives there, the server holds none. */
    private val summaries = RecordSummaries(apiService, cryptoService, sessionState)

    init {
        activeHubState.activeHubId
            .filterNotNull()
            .onEach { refresh() }
            .launchIn(viewModelScope)
    }

    /**
     * Check if CMS is enabled for this hub (launches in viewModelScope).
     */
    private fun checkCmsEnabled() {
        viewModelScope.launch {
            checkCmsEnabledSync()
        }
    }

    /**
     * Suspending version of CMS check — called from [refresh] for sequential execution.
     */
    private suspend fun checkCmsEnabledSync() {
        try {
            @kotlinx.serialization.Serializable
            data class CmsStatusResponse(val enabled: Boolean)

            val response = apiService.request<CmsStatusResponse>(
                "GET",
                apiService.hp("/api/settings/cms/case-management"),
            )
            _uiState.update { it.copy(cmsEnabled = response.enabled) }
        } catch (_: Exception) {
            _uiState.update { it.copy(cmsEnabled = false) }
        }
    }

    /**
     * Load entity type definitions from GET /api/settings/cms/entity-types.
     * After loading, triggers event record loading for event types.
     */
    fun loadEntityTypes() {
        viewModelScope.launch {
            loadEntityTypesSync()
        }
    }

    /**
     * Suspending version of entity type loading — called from [refresh] for sequential execution.
     *
     * The event list is loading from here until the records request settles. Leaving
     * `isLoading` false while entity types are fetched made the list render its
     * "No events" empty state for the whole round trip, before any record was asked for.
     */
    private suspend fun loadEntityTypesSync() {
        _uiState.update {
            it.copy(
                isLoadingEntityTypes = true,
                isLoading = it.events.isEmpty(),
                isRefreshing = it.events.isNotEmpty(),
                error = null,
            )
        }
        val response = try {
            apiService.request<EntityTypesResponse>(
                "GET",
                apiService.hp("/api/settings/cms/entity-types"),
            )
        } catch (e: Exception) {
            _uiState.update {
                it.copy(
                    isLoadingEntityTypes = false,
                    isLoading = false,
                    isRefreshing = false,
                    error = e.message ?: "Failed to load events",
                )
            }
            return
        }
        _uiState.update {
            it.copy(
                entityTypes = response.entityTypes,
                isLoadingEntityTypes = false,
            )
        }
        loadEventsSync()
    }

    /**
     * Load event records from GET /api/records filtered to event entity types.
     */
    fun loadEvents() {
        viewModelScope.launch { loadEventsSync() }
    }

    private suspend fun loadEventsSync() {
        val eventTypes = _uiState.value.eventEntityTypes
        if (eventTypes.isEmpty()) {
            _uiState.update {
                it.copy(
                    events = emptyList(),
                    total = 0,
                    isLoading = false,
                    isRefreshing = false,
                )
            }
            return
        }

        _uiState.update {
            it.copy(
                isLoading = it.events.isEmpty(),
                isRefreshing = it.events.isNotEmpty(),
                error = null,
            )
        }
        try {
            // Load records for the first event entity type
            val firstEventType = eventTypes.first()
            val response = apiService.request<RecordsListResponse>(
                "GET",
                apiService.activeHubPath("/api/records") + "?entityTypeId=${firstEventType.id}&limit=50",
            )
            _uiState.update {
                it.copy(
                    events = response.records,
                    total = response.total,
                    isLoading = false,
                    isRefreshing = false,
                )
            }
            // The status of each event lives in its sealed summary.
            for (record in response.records) {
                if (_uiState.value.summaries.containsKey(record.id)) continue
                val summary = summaries.open(record) ?: continue
                _uiState.update { it.copy(summaries = it.summaries + (record.id to summary)) }
            }
        } catch (_: NoActiveHubException) {
            // No hub to browse: nothing to load, which is not a failure (#2405, #2461).
            _uiState.update { it.copy(events = emptyList(), total = 0, isLoading = false, isRefreshing = false) }
        } catch (e: Exception) {
            _uiState.update {
                it.copy(
                    isLoading = false,
                    isRefreshing = false,
                    error = e.message ?: "Failed to load events",
                )
            }
        }
    }

    /**
     * Load a single event by ID for the detail view.
     */
    fun selectEvent(eventId: String) {
        viewModelScope.launch {
            _uiState.update {
                it.copy(
                    isLoadingDetail = true,
                    detailError = null,
                    selectedEvent = null,
                    childRecords = emptyList(),
                    childrenError = null,
                )
            }
            try {
                val record = apiService.request<Record>("GET", apiService.activeHubPath("/api/records/$eventId"))
                val summary = summaries.open(record)
                _uiState.update {
                    it.copy(
                        selectedEvent = record,
                        summaries = if (summary != null) it.summaries + (record.id to summary) else it.summaries - record.id,
                        isLoadingDetail = false,
                    )
                }
                loadChildRecords(eventId)
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isLoadingDetail = false,
                        detailError = e.message ?: "Failed to load event",
                    )
                }
            }
        }
    }

    /**
     * Load the child records of an event from GET /api/records?parentRecordId=.
     *
     * Record-based events nest sub-events and link cases through the record
     * parent/child relation, mirroring the desktop event detail. The deprecated
     * /api/events endpoints read the separate events table, which record-based
     * events never enter.
     */
    fun loadChildRecords(eventId: String) {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoadingChildren = true, childrenError = null) }
            try {
                val response = apiService.request<RecordsListResponse>(
                    "GET",
                    apiService.activeHubPath("/api/records") + "?parentRecordId=$eventId&limit=50",
                )
                _uiState.update {
                    it.copy(
                        childRecords = response.records,
                        isLoadingChildren = false,
                    )
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isLoadingChildren = false,
                        childrenError = e.message ?: "Failed to load linked records",
                    )
                }
            }
        }
    }

    /**
     * Update the status of an event record.
     */
    fun updateStatus(recordId: String, status: String) {
        viewModelScope.launch {
            _uiState.update { it.copy(isUpdatingStatus = true, actionError = null) }
            try {
                val record = _uiState.value.selectedEvent?.takeIf { it.id == recordId }
                    ?: _uiState.value.events.firstOrNull { it.id == recordId }
                    ?: error("Event not loaded")
                summaries.changeStatus(record, status)
                _uiState.update {
                    it.copy(
                        summaries = it.summaries - recordId,
                        isUpdatingStatus = false,
                        actionSuccess = "Status updated",
                    )
                }
                loadEvents()
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isUpdatingStatus = false,
                        actionError = e.message ?: "Failed to update status",
                    )
                }
            }
        }
    }

    /**
     * Create a new event record with the given entity type and title.
     *
     * The title and description are sealed on this device as a case summary
     * ([CasePurpose.SUMMARY]) to the readers the server names for a new record of
     * this type, plus this device and every admin of the hub; the server only ever receives the
     * ciphertext and its envelopes. With no admin able to read, the write is
     * refused (see [NoAdminReaderException]) rather than stored where no admin could
     * read it.
     */
    fun createEvent(entityTypeId: String, title: String, description: String, onSuccess: () -> Unit) {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoading = true) }
            try {
                // Use the entity type's default status
                val entityType = _uiState.value.entityTypes.find { it.id == entityTypeId }
                val defaultStatus = entityType?.defaultStatus ?: "active"

                val readers = RecordReaderSet.forNewRecord(
                    author = cryptoService.encryptionPubkeyHex,
                    adminReaders = { sessionState.adminReaders(apiService) },
                ) {
                    apiService.request<EnvelopeRecipientsResponse>(
                        "GET",
                        apiService.activeHubPath("/api/records/envelope-recipients") +
                            "?entityTypeId=$entityTypeId",
                    )
                }
                val sealed = cryptoService.sealCase(
                    CasePurpose.SUMMARY,
                    eventSummaryJson(title, description, defaultStatus),
                    readers.summary,
                )

                apiService.requestNoContent(
                    "POST",
                    apiService.activeHubPath("/api/records"),
                    CreateRecordRequest(
                        blindIndexes = emptyMap(),
                        encryptedSummary = sealed.ciphertextHex,
                        entityTypeID = entityTypeId,
                        summaryEnvelopes = sealed.envelopes.map {
                            SharedAdminEnvelope(ct = it.ct, enc = it.enc, pubkey = it.pubkey)
                        },
                    ),
                )
                loadEvents()
                onSuccess()
            } catch (e: Exception) {
                _uiState.update { it.copy(isLoading = false, actionError = e.message) }
            }
        }
    }

    /**
     * Set the search query for filtering events.
     */
    fun setSearchQuery(query: String) {
        _uiState.update { it.copy(searchQuery = query) }
    }

    fun refresh() {
        viewModelScope.launch {
            // Sequential: check CMS first, then load entity types.
            // Running these concurrently caused a race where checkCmsEnabled()
            // could set cmsEnabled=false (on transient error) before loadEntityTypes()
            // finished, permanently hiding the events UI for that ViewModel lifecycle.
            checkCmsEnabledSync()
            loadEntityTypesSync()
        }
    }

    fun dismissError() {
        _uiState.update { it.copy(error = null) }
    }

    fun dismissChildrenError() {
        _uiState.update { it.copy(childrenError = null) }
    }

    fun dismissActionError() {
        _uiState.update { it.copy(actionError = null) }
    }

    fun dismissActionSuccess() {
        _uiState.update { it.copy(actionSuccess = null) }
    }

    fun clearSelection() {
        _uiState.update {
            it.copy(
                selectedEvent = null,
                detailError = null,
                childRecords = emptyList(),
                childrenError = null,
            )
        }
    }
}
