package org.llamenos.hotline.ui.cases

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
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import org.llamenos.core.CasePurpose
import org.llamenos.hotline.api.ApiService
import org.llamenos.hotline.api.NoActiveHubException
import org.llamenos.hotline.api.SessionState
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.crypto.RecordReaderSet
import org.llamenos.hotline.hub.ActiveHubState
import org.llamenos.hotline.model.AssignRecordRequest
import org.llamenos.hotline.model.AssignResponse
import org.llamenos.hotline.model.CaseRecord
import org.llamenos.hotline.model.EntityTypesResponse
import org.llamenos.hotline.model.EvidenceItem
import org.llamenos.hotline.model.InteractionsResponse
import org.llamenos.hotline.model.RecordsListResponse
import org.llamenos.hotline.model.RecordContactsResponse
import org.llamenos.hotline.model.UpdateRecordRequest
import org.llamenos.protocol.CreateInteractionBody
import org.llamenos.hotline.model.CreateInteractionBodyContentEnvelope
import org.llamenos.hotline.model.EntityTypeDefinition
import org.llamenos.protocol.EnvelopeRecipientsResponse
import org.llamenos.protocol.Evidence
import org.llamenos.protocol.Interaction
import org.llamenos.hotline.model.InteractionType
import org.llamenos.protocol.Record
import org.llamenos.protocol.RecipientEnvelope
import org.llamenos.protocol.SharedAdminEnvelope
import org.llamenos.protocol.UnassignBody
import org.llamenos.protocol.RecordContact
import javax.inject.Inject

/** Records per page of the case list, filtered or not. */
private const val RECORDS_PAGE_SIZE = 20

/**
 * Active detail tab on the case detail screen.
 */
enum class CaseDetailTab {
    DETAILS,
    TIMELINE,
    CONTACTS,
    EVIDENCE,
}

/**
 * Display type for the case list — table (default), calendar, or timeline.
 */
enum class CaseDisplayType {
    TABLE,
    CALENDAR,
    TIMELINE,
}

/**
 * Sort order for timeline interactions.
 */
enum class TimelineSortOrder {
    NEWEST_FIRST,
    OLDEST_FIRST,
}

/**
 * Decrypted case summary fields.
 */
data class DecryptedSummary(
    val title: String? = null,
    val description: String? = null,
    /** The status VALUE (the entity type's `statuses[].value`), sealed with the summary. */
    val status: String? = null,
    /** The severity VALUE (the entity type's `severities[].value`), sealed with the summary. */
    val severity: String? = null,
    /**
     * The summary exactly as opened. A status change re-seals the WHOLE summary, so keys this
     * client does not read must survive it.
     */
    val raw: JsonObject = JsonObject(emptyMap()),
)

/**
 * UI state for the case management screens.
 */
data class CaseUiState(
    // Entity types
    val entityTypes: List<EntityTypeDefinition> = emptyList(),
    val isLoadingEntityTypes: Boolean = false,
    val entityTypesError: String? = null,

    // Records
    val records: List<Record> = emptyList(),
    val recordsTotal: Int = 0,
    val recordsPage: Int = 1,
    val hasMoreRecords: Boolean = false,
    val isLoadingRecords: Boolean = false,
    val isRefreshingRecords: Boolean = false,
    val recordsError: String? = null,

    // Filters
    val selectedEntityTypeId: String? = null,
    /** The status VALUE the list is filtered by, or null. Applied on this device: the server holds no status. */
    val selectedStatus: String? = null,
    /**
     * A status filter is active and its scan stopped at [CaseTriage.SCAN_LIMIT] with candidates left,
     * so the list is matches among the newest records only. The screen says so, and an empty list
     * says it too: it must not read as "none".
     */
    val filterScanBounded: Boolean = false,

    // EP06-A4: display mode and cross-hub
    val displayType: CaseDisplayType = CaseDisplayType.TABLE,
    val crossHubEnabled: Boolean = false,

    // Selected record detail
    val selectedRecord: Record? = null,
    val isLoadingDetail: Boolean = false,
    val detailError: String? = null,
    val activeTab: CaseDetailTab = CaseDetailTab.DETAILS,

    // Interactions (timeline)
    val interactions: List<Interaction> = emptyList(),
    val interactionsTotal: Int = 0,
    val isLoadingInteractions: Boolean = false,
    val interactionsError: String? = null,

    // Contacts
    val contacts: List<RecordContact> = emptyList(),
    val isLoadingContacts: Boolean = false,
    val contactsError: String? = null,

    // Evidence
    val evidence: List<Evidence> = emptyList(),
    val evidenceTotal: Int = 0,
    val isLoadingEvidence: Boolean = false,
    val evidenceError: String? = null,

    // Decrypted content
    val decryptedSummary: DecryptedSummary? = null,
    val decryptedFields: Map<String, String> = emptyMap(),
    val isDecryptingSummary: Boolean = false,
    val isDecryptingFields: Boolean = false,

    // Timeline sort
    val timelineSortOrder: TimelineSortOrder = TimelineSortOrder.NEWEST_FIRST,

    // Decrypted interaction content (interaction ID -> plaintext)
    val decryptedInteractions: Map<String, String> = emptyMap(),

    // Action states
    val isUpdatingStatus: Boolean = false,
    val isAddingComment: Boolean = false,
    val isAssigning: Boolean = false,
    val actionError: String? = null,
    val actionSuccess: String? = null,

    // Opened summaries for list display (record ID -> title, status, severity)
    val decryptedRecordSummaries: Map<String, DecryptedSummary> = emptyMap(),
) {
    /**
     * Active entity types that should be shown in the tab bar.
     * Filters out archived types and types not shown in navigation.
     */
    val visibleEntityTypes: List<EntityTypeDefinition>
        get() = entityTypes.filter { !it.isArchived && it.showInNavigation }

    /**
     * The entity type definition for the currently selected record.
     */
    val selectedEntityType: EntityTypeDefinition?
        get() = selectedRecord?.let { record ->
            entityTypes.find { it.id == record.entityTypeID }
        }

    /**
     * Interactions sorted by the current sort order.
     */
    val sortedInteractions: List<Interaction>
        get() = when (timelineSortOrder) {
            TimelineSortOrder.NEWEST_FIRST -> interactions.sortedByDescending { it.createdAt }
            TimelineSortOrder.OLDEST_FIRST -> interactions.sortedBy { it.createdAt }
        }
}

/**
 * ViewModel for the case management screens (list and detail).
 *
 * Loads entity type definitions and case records from the CMS API.
 * Supports filtering by entity type and status, case detail with
 * timeline interactions, linked contacts, and evidence.
 *
 * All E2EE content is encrypted/decrypted via [CryptoService].
 */
@HiltViewModel
class CaseManagementViewModel @Inject constructor(
    private val apiService: ApiService,
    private val cryptoService: CryptoService,
    private val sessionState: SessionState,
    private val activeHubState: ActiveHubState,
) : ViewModel() {

    private val _uiState = MutableStateFlow(CaseUiState())
    val uiState: StateFlow<CaseUiState> = _uiState.asStateFlow()

    /** The current user's signing pubkey (identity), or null if no key is loaded. */
    val currentUserPubkey: String?
        get() = cryptoService.signingPubkeyHex

    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
    }

    /** Reads and re-seals the sealed summary: status and severity live there, the server holds none. */
    private val summaries = RecordSummaries(apiService, cryptoService, sessionState)

    private suspend fun openSummary(record: Record): DecryptedSummary? = summaries.open(record)

    init {
        activeHubState.activeHubId
            .filterNotNull()
            .onEach { refresh() }
            .launchIn(viewModelScope)
    }

    // ---- Entity Types ----

    /**
     * Fetch entity type definitions from GET /api/settings/cms/entity-types.
     *
     * Entity types define the schema for case records: fields, statuses,
     * severities, numbering, and access control. They drive the entire
     * case management UI.
     */
    fun loadEntityTypes() {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoadingEntityTypes = true, entityTypesError = null) }
            try {
                val response = apiService.request<EntityTypesResponse>(
                    "GET",
                    "/api/settings/cms/entity-types",
                )
                _uiState.update {
                    it.copy(
                        entityTypes = response.entityTypes,
                        isLoadingEntityTypes = false,
                    )
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isLoadingEntityTypes = false,
                        entityTypesError = e.message ?: "Failed to load entity types",
                    )
                }
            }
        }
    }

    // ---- Records ----

    /**
     * Load case records from GET /api/records with optional filters.
     *
     * @param entityTypeId Filter by entity type (null for all types)
     * @param status Filter by status VALUE (null for all statuses). The status lives in the sealed
     *   summary, so this is applied here, over a bounded scan (see [CaseTriage]).
     * @param page Page number for pagination
     */
    fun loadRecords(
        entityTypeId: String? = _uiState.value.selectedEntityTypeId,
        status: String? = _uiState.value.selectedStatus,
        page: Int = 1,
    ) {
        viewModelScope.launch {
            _uiState.update {
                it.copy(
                    isLoadingRecords = it.records.isEmpty(),
                    isRefreshingRecords = it.records.isNotEmpty(),
                    recordsError = null,
                )
            }
            try {
                if (status != null) {
                    loadFilteredRecords(entityTypeId, status, page)
                    return@launch
                }
                val query = buildString {
                    append(apiService.activeHubPath("/api/records"))
                    append("?limit=$RECORDS_PAGE_SIZE&page=$page")
                    if (entityTypeId != null) {
                        append("&entityTypeId=$entityTypeId")
                    }
                    if (_uiState.value.crossHubEnabled) {
                        append("&crossHub=true")
                    }
                }
                val response = apiService.request<RecordsListResponse>("GET", query)
                _uiState.update {
                    it.copy(
                        records = response.records,
                        recordsTotal = response.total,
                        recordsPage = response.page,
                        hasMoreRecords = response.hasMore,
                        filterScanBounded = false,
                        isLoadingRecords = false,
                        isRefreshingRecords = false,
                    )
                }
            } catch (_: NoActiveHubException) {
                // No hub to browse: nothing to load, which is not a failure (#2405, #2461).
                _uiState.update {
                    it.copy(records = emptyList(), recordsTotal = 0, hasMoreRecords = false, isLoadingRecords = false, isRefreshingRecords = false)
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isLoadingRecords = false,
                        isRefreshingRecords = false,
                        recordsError = e.message ?: "Failed to load records",
                    )
                }
            }
        }
    }

    /**
     * Fetch the candidates the server can filter on (hub, entity type), open each summary and keep
     * the records whose status is [wanted], up to [CaseTriage.SCAN_LIMIT] records. The matches are
     * paged locally and `recordsTotal` is the size of the local result.
     */
    private suspend fun loadFilteredRecords(entityTypeId: String?, wanted: String, page: Int) {
        val summaries = mutableMapOf<String, DecryptedSummary>()
        val crossHub = _uiState.value.crossHubEnabled

        val scan = scanRecords(
            fetchPage = { pageNo, limit ->
                val query = buildString {
                    append(apiService.activeHubPath("/api/records"))
                    append("?limit=$limit&page=$pageNo")
                    if (entityTypeId != null) append("&entityTypeId=$entityTypeId")
                    if (crossHub) append("&crossHub=true")
                }
                val response = apiService.request<RecordsListResponse>("GET", query)
                CandidatePage(response.records, response.hasMore)
            },
            matches = { record ->
                val summary = openSummary(record)
                if (summary != null) summaries[record.id] = summary
                summary?.status == wanted
            },
        )

        _uiState.update {
            it.copy(
                records = CaseTriage.pageOf(scan.matches, page, RECORDS_PAGE_SIZE),
                recordsTotal = scan.matches.size,
                recordsPage = page,
                hasMoreRecords = page * RECORDS_PAGE_SIZE < scan.matches.size,
                filterScanBounded = scan.bounded,
                decryptedRecordSummaries = it.decryptedRecordSummaries + summaries,
                isLoadingRecords = false,
                isRefreshingRecords = false,
            )
        }
    }

    /**
     * Select an entity type tab to filter records.
     *
     * @param entityTypeId The entity type ID, or null for "All"
     */
    fun setEntityTypeFilter(entityTypeId: String?) {
        _uiState.update { it.copy(selectedEntityTypeId = entityTypeId, selectedStatus = null) }
        loadRecords(entityTypeId = entityTypeId, status = null)
    }

    /**
     * Set the status filter for record listing. [status] is a status VALUE.
     */
    fun setStatusFilter(status: String?) {
        _uiState.update { it.copy(selectedStatus = status) }
        loadRecords(status = status)
    }

    // ---- Record Detail ----

    /**
     * Load a single record by ID and set it as selected.
     * Also loads related data (interactions, contacts, evidence).
     */
    fun selectRecord(recordId: String) {
        viewModelScope.launch {
            _uiState.update {
                it.copy(
                    isLoadingDetail = true,
                    detailError = null,
                    selectedRecord = null,
                    // Another record's status must never show against this one.
                    decryptedSummary = null,
                    interactions = emptyList(),
                    contacts = emptyList(),
                    evidence = emptyList(),
                    activeTab = CaseDetailTab.DETAILS,
                )
            }
            try {
                val record = apiService.request<CaseRecord>("GET", apiService.activeHubPath("/api/records/$recordId"))
                _uiState.update {
                    it.copy(
                        selectedRecord = record,
                        isLoadingDetail = false,
                    )
                }
                // Load related data in parallel
                loadInteractions(recordId)
                loadContacts(recordId)
                loadEvidence(recordId)
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isLoadingDetail = false,
                        detailError = e.message ?: "Failed to load record",
                    )
                }
            }
        }
    }

    /**
     * Set the active detail tab.
     */
    fun setActiveTab(tab: CaseDetailTab) {
        _uiState.update { it.copy(activeTab = tab) }
    }

    /**
     * Change a record's status: re-seal its summary with the new status VALUE and file the
     * transition as a sealed status-change entry. Nothing about the status travels in the clear
     * (#2779).
     *
     * A status change REPLACES the summary, so the title, description and severity it carries come
     * from the current ciphertext. A summary this device cannot open is refused, never overwritten
     * with a blank one; and so is a re-seal whose reader lookup failed, which would drop every
     * assignee the record already had.
     *
     * @param recordId The record ID
     * @param status The new status VALUE
     */
    fun updateStatus(recordId: String, status: String) {
        viewModelScope.launch {
            _uiState.update { it.copy(isUpdatingStatus = true, actionError = null) }
            try {
                val record = _uiState.value.selectedRecord?.takeIf { it.id == recordId }
                    ?: _uiState.value.records.firstOrNull { it.id == recordId }
                    ?: error("Record not loaded")
                val updated = summaries.changeStatus(record, status)
                _uiState.update {
                    it.copy(
                        selectedRecord = updated,
                        // The cached summary is the old ciphertext's.
                        decryptedSummary = null,
                        decryptedRecordSummaries = it.decryptedRecordSummaries - recordId,
                        isUpdatingStatus = false,
                        actionSuccess = "Status updated",
                    )
                }
                decryptSummary(updated)
                // Reload the interactions to show the status change entry
                loadInteractions(recordId)
                // Refresh the list to reflect the new status
                loadRecords()
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

    // ---- Interactions (Timeline) ----

    /**
     * Load interactions for a case from GET /api/records/:id/interactions.
     */
    fun loadInteractions(recordId: String) {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoadingInteractions = true, interactionsError = null) }
            try {
                val response = apiService.request<InteractionsResponse>(
                    "GET",
                    apiService.activeHubPath("/api/records/$recordId/interactions") + "?limit=50",
                )
                _uiState.update {
                    it.copy(
                        interactions = response.interactions,
                        interactionsTotal = response.total,
                        isLoadingInteractions = false,
                    )
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isLoadingInteractions = false,
                        interactionsError = e.message ?: "Failed to load interactions",
                    )
                }
            }
        }
    }

    /**
     * Add a comment interaction to a case.
     *
     * The comment text is E2EE-encrypted for the author and all admin
     * pubkeys before being sent to the API.
     *
     * @param recordId The case record ID
     * @param comment The plaintext comment to encrypt and post
     */
    fun addComment(recordId: String, comment: String) {
        viewModelScope.launch {
            _uiState.update { it.copy(isAddingComment = true, actionError = null) }
            try {
                // A comment is working content: it goes to the `fields` tier the
                // server names for this record (its assignees, admins and
                // `editRoles` holders), asked now and not cached. A failed
                // lookup falls back to this device + the hub's admins, and no admin
                // reader refuses the write (RecordReaders.kt, #1682).
                val readers = RecordReaderSet.forRecord(
                    author = cryptoService.encryptionPubkeyHex,
                    adminReaders = { sessionState.adminReaders(apiService) },
                ) {
                    apiService.request<EnvelopeRecipientsResponse>(
                        "GET",
                        apiService.activeHubPath("/api/records/$recordId/envelope-recipients"),
                    )
                }
                // Sealed as a case comment, not a note: the crate supplies the label
                // and AAD, and this device is always a reader (#2499).
                val encrypted = cryptoService.sealCase(
                    CasePurpose.COMMENT,
                    comment,
                    readers.fields,
                )
                val envelopes = encrypted.envelopes.map { env ->
                    CreateInteractionBodyContentEnvelope(
                        pubkey = env.pubkey,
                        ct = env.ct,
                        enc = env.enc,
                    )
                }
                val request = CreateInteractionBody(
                    interactionType = InteractionType.Comment,
                    encryptedContent = encrypted.ciphertextHex,
                    contentEnvelopes = envelopes,
                    interactionTypeHash = "comment",
                )
                apiService.request<Interaction>(
                    "POST",
                    apiService.activeHubPath("/api/records/$recordId/interactions"),
                    request,
                )
                _uiState.update {
                    it.copy(
                        isAddingComment = false,
                        actionSuccess = "Comment added",
                    )
                }
                loadInteractions(recordId)
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isAddingComment = false,
                        actionError = e.message ?: "Failed to add comment",
                    )
                }
            }
        }
    }

    // ---- Contacts ----

    /**
     * Load contacts linked to a record from GET /api/records/:id/contacts.
     */
    fun loadContacts(recordId: String) {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoadingContacts = true, contactsError = null) }
            try {
                val response = apiService.request<RecordContactsResponse>(
                    "GET",
                    apiService.activeHubPath("/api/records/$recordId/contacts"),
                )
                _uiState.update {
                    it.copy(
                        contacts = response.contacts,
                        isLoadingContacts = false,
                    )
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isLoadingContacts = false,
                        contactsError = e.message ?: "Failed to load contacts",
                    )
                }
            }
        }
    }

    // ---- Evidence ----

    /**
     * Load evidence for a case from GET /api/records/:id/evidence.
     */
    fun loadEvidence(recordId: String) {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoadingEvidence = true, evidenceError = null) }
            try {
                val response = apiService.request<org.llamenos.protocol.EvidenceListResponse>(
                    "GET",
                    apiService.activeHubPath("/api/records/$recordId/evidence") + "?limit=50",
                )
                _uiState.update {
                    it.copy(
                        evidence = response.evidence,
                        evidenceTotal = response.total.toInt(),
                        isLoadingEvidence = false,
                    )
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isLoadingEvidence = false,
                        evidenceError = e.message ?: "Failed to load evidence",
                    )
                }
            }
        }
    }

    // ---- Assignment ----

    /**
     * Assign the current user to a record via POST /api/records/:id/assign.
     */
    fun assignToMe(recordId: String) {
        viewModelScope.launch {
            _uiState.update { it.copy(isAssigning = true, actionError = null) }
            val pubkey = cryptoService.signingPubkeyHex
            if (pubkey == null) {
                _uiState.update {
                    it.copy(isAssigning = false, actionError = "No identity available")
                }
                return@launch
            }
            try {
                val request = AssignRecordRequest(pubkeys = listOf(pubkey))
                val response = apiService.request<AssignResponse>(
                    "POST",
                    apiService.activeHubPath("/api/records/$recordId/assign"),
                    request,
                )
                // Update the selected record's assignedTo list from the response
                _uiState.update {
                    it.copy(
                        selectedRecord = it.selectedRecord?.copy(
                            assignedTo = response.assignedTo,
                        ),
                        isAssigning = false,
                        actionSuccess = "Assigned to you",
                    )
                }
                loadRecords()
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isAssigning = false,
                        actionError = e.message ?: "Failed to assign record",
                    )
                }
            }
        }
    }

    /**
     * Unassign the current user from a record via POST /api/records/:id/unassign.
     */
    fun unassignFromMe(recordId: String) {
        viewModelScope.launch {
            _uiState.update { it.copy(isAssigning = true, actionError = null) }
            val pubkey = cryptoService.signingPubkeyHex
            if (pubkey == null) {
                _uiState.update {
                    it.copy(isAssigning = false, actionError = "No identity available")
                }
                return@launch
            }
            try {
                val request = UnassignBody(pubkey = pubkey)
                val response = apiService.request<AssignResponse>(
                    "POST",
                    apiService.activeHubPath("/api/records/$recordId/unassign"),
                    request,
                )
                _uiState.update {
                    it.copy(
                        selectedRecord = it.selectedRecord?.copy(
                            assignedTo = response.assignedTo,
                        ),
                        isAssigning = false,
                        actionSuccess = "Unassigned",
                    )
                }
                loadRecords()
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isAssigning = false,
                        actionError = e.message ?: "Failed to unassign",
                    )
                }
            }
        }
    }

    // ---- Summary / Field Decryption ----

    /**
     * Decrypt the encrypted summary of the selected record.
     *
     * Finds the envelope matching our pubkey and decrypts the summary
     * JSON to extract title and description fields.
     */
    fun decryptSummary(record: Record) {
        if (record.summaryEnvelopes.isEmpty()) return

        viewModelScope.launch {
            _uiState.update { it.copy(isDecryptingSummary = true) }
            val summary = openSummary(record)
            _uiState.update { it.copy(decryptedSummary = summary, isDecryptingSummary = false) }
        }
    }

    /**
     * Decrypt the encrypted fields of the selected record.
     *
     * Finds the field envelope matching our pubkey and decrypts to
     * a map of field name -> value string.
     */
    fun decryptFields(record: Record) {
        val envelopes = record.fieldEnvelopes?.takeIf { it.isNotEmpty() } ?: return
        val encryptedFields = record.encryptedFields ?: return

        viewModelScope.launch {
            _uiState.update { it.copy(isDecryptingFields = true) }
            try {
                val plaintext = cryptoService.openCase(
                    CasePurpose.FIELDS,
                    encryptedFields,
                    envelopes.map { it.toRecipientEnvelope() },
                )
                if (plaintext != null) {
                    val jsonObj = json.decodeFromString<JsonObject>(plaintext)
                    val fields = jsonObj.mapValues { (_, value) ->
                        value.jsonPrimitive.contentOrNull ?: ""
                    }
                    _uiState.update {
                        it.copy(
                            decryptedFields = fields,
                            isDecryptingFields = false,
                        )
                    }
                } else {
                    _uiState.update { it.copy(isDecryptingFields = false) }
                }
            } catch (_: Exception) {
                _uiState.update { it.copy(isDecryptingFields = false) }
            }
        }
    }

    /**
     * Decrypt an interaction's encrypted content.
     */
    fun decryptInteraction(interaction: Interaction) {
        // A status change seals its transition the way a comment seals its text.
        if (interaction.interactionType != InteractionType.Comment &&
            interaction.interactionType != InteractionType.StatusChange
        ) {
            return
        }
        val encryptedContent = interaction.encryptedContent ?: return
        val envelopes = interaction.contentEnvelopes?.takeIf { it.isNotEmpty() } ?: return

        // Skip if already decrypted
        if (_uiState.value.decryptedInteractions.containsKey(interaction.id)) return

        viewModelScope.launch {
            try {
                // Opened as a case comment — the same purpose addComment seals with.
                // Android used to seal comments as notes and open them as messages,
                // so it could not read a comment it wrote itself (#2499).
                val plaintext = cryptoService.openCase(
                    CasePurpose.COMMENT,
                    encryptedContent,
                    envelopes.map { it.toRecipientEnvelope() },
                )
                if (plaintext != null) {
                    _uiState.update {
                        it.copy(
                            decryptedInteractions = it.decryptedInteractions + (interaction.id to plaintext),
                        )
                    }
                }
            } catch (_: Exception) {
                // Decryption failure — leave as encrypted
            }
        }
    }

    /**
     * Open the summaries of the listed records: the title, status and severity the list shows.
     */
    fun decryptRecordSummaries(records: List<Record>) {
        viewModelScope.launch {
            for (record in records) {
                // Skip if already opened
                if (_uiState.value.decryptedRecordSummaries.containsKey(record.id)) continue
                val summary = openSummary(record) ?: continue
                _uiState.update { it.copy(decryptedRecordSummaries = it.decryptedRecordSummaries + (record.id to summary)) }
            }
        }
    }

    // ---- Timeline Sort ----

    /**
     * Toggle the timeline sort order between newest and oldest first.
     */
    fun toggleTimelineSort() {
        _uiState.update {
            it.copy(
                timelineSortOrder = when (it.timelineSortOrder) {
                    TimelineSortOrder.NEWEST_FIRST -> TimelineSortOrder.OLDEST_FIRST
                    TimelineSortOrder.OLDEST_FIRST -> TimelineSortOrder.NEWEST_FIRST
                },
            )
        }
    }

    // ---- Refresh ----

    /**
     * Refresh all loaded data.
     */
    fun refresh() {
        loadEntityTypes()
        loadRecords()
        val selectedId = _uiState.value.selectedRecord?.id
        if (selectedId != null) {
            selectRecord(selectedId)
        }
    }

    /**
     * Dismiss the action error message.
     */
    fun dismissActionError() {
        _uiState.update { it.copy(actionError = null) }
    }

    /**
     * Dismiss the action success message.
     */
    fun dismissActionSuccess() {
        _uiState.update { it.copy(actionSuccess = null) }
    }

    /**
     * Dismiss the records error message.
     */
    fun dismissError() {
        _uiState.update { it.copy(recordsError = null) }
    }

    /**
     * Toggle cross-hub search and reload records.
     */
    fun toggleCrossHub() {
        _uiState.update { it.copy(crossHubEnabled = !it.crossHubEnabled) }
        loadRecords()
    }

    /**
     * Set the display type (table, calendar, timeline).
     */
    fun setDisplayType(type: CaseDisplayType) {
        _uiState.update { it.copy(displayType = type) }
    }

    /**
     * Clear the selected record and reset detail state.
     */
    fun clearSelection() {
        _uiState.update {
            it.copy(
                selectedRecord = null,
                interactions = emptyList(),
                contacts = emptyList(),
                evidence = emptyList(),
                activeTab = CaseDetailTab.DETAILS,
                detailError = null,
                decryptedSummary = null,
                decryptedFields = emptyMap(),
                decryptedInteractions = emptyMap(),
                timelineSortOrder = TimelineSortOrder.NEWEST_FIRST,
            )
        }
    }
}

/** A record/interaction envelope as the reader-envelope shape CryptoService opens. */
internal fun SharedAdminEnvelope.toRecipientEnvelope() =
    RecipientEnvelope(pubkey = pubkey, enc = enc, ct = ct)
