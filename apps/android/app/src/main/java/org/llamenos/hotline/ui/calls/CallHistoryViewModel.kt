package org.llamenos.hotline.ui.calls

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
import org.llamenos.hotline.api.ApiService
import org.llamenos.hotline.crypto.AdminEnvelopeData
import org.llamenos.hotline.crypto.CryptoService
import org.llamenos.hotline.hub.ActiveHubState
import org.llamenos.hotline.model.CallHistoryRecord
import org.llamenos.hotline.model.CallHistoryResponse
import javax.inject.Inject

/**
 * UI-facing wrapper around a call record with decrypted metadata.
 * Admin users will see decrypted caller number and answered-by volunteer.
 */
data class DecryptedCallRecord(
    val record: CallHistoryRecord,
    val decryptedCallerNumber: String? = null,
    val decryptedAnsweredBy: String? = null,
)

data class CallHistoryUiState(
    val calls: List<DecryptedCallRecord> = emptyList(),
    val total: Int = 0,
    val currentPage: Int = 1,
    val isLoading: Boolean = false,
    val isRefreshing: Boolean = false,
    val error: String? = null,
    val searchQuery: String = "",
    val selectedFilter: CallStatusFilter = CallStatusFilter.ALL,
    val dateFrom: String? = null,
    val dateTo: String? = null,
)

enum class CallStatusFilter(val queryParam: String?) {
    ALL(null),
    COMPLETED("completed"),
    UNANSWERED("unanswered"),
}

/**
 * ViewModel for the call history screen.
 *
 * Loads paginated call history from GET /calls/history with optional search
 * and status filtering. Supports pull-to-refresh and pagination.
 */
@HiltViewModel
class CallHistoryViewModel @Inject constructor(
    private val apiService: ApiService,
    private val activeHubState: ActiveHubState,
    private val cryptoService: CryptoService,
) : ViewModel() {

    private val _uiState = MutableStateFlow(CallHistoryUiState())
    val uiState: StateFlow<CallHistoryUiState> = _uiState.asStateFlow()

    init {
        activeHubState.activeHubId
            .filterNotNull()
            .onEach { loadCalls() }
            .launchIn(viewModelScope)
    }

    fun loadCalls(page: Int = 1) {
        viewModelScope.launch {
            _uiState.update {
                it.copy(
                    isLoading = page == 1 && it.calls.isEmpty(),
                    isRefreshing = page == 1 && it.calls.isNotEmpty(),
                    error = null,
                )
            }
            try {
                val query = buildString {
                    append(apiService.hp("/api/calls/history"))
                    append("?page=$page&limit=50")
                    val search = _uiState.value.searchQuery
                    if (search.isNotBlank()) {
                        append("&search=$search")
                    }
                    val filter = _uiState.value.selectedFilter
                    if (filter.queryParam != null) {
                        append("&status=${filter.queryParam}")
                    }
                    val from = _uiState.value.dateFrom
                    if (from != null) {
                        append("&dateFrom=$from")
                    }
                    val to = _uiState.value.dateTo
                    if (to != null) {
                        append("&dateTo=$to")
                    }
                }
                val response = apiService.request<CallHistoryResponse>("GET", query)
                val decryptedCalls = response.calls.map { call ->
                    val meta = if (call.encryptedContent != null && call.adminEnvelopes != null) {
                        val envelopes = call.adminEnvelopes!!.map { env ->
                            AdminEnvelopeData(
                                pubkey = env.pubkey,
                                enc = env.enc,
                                ct = env.ct,
                            )
                        }
                        cryptoService.decryptCallMetadata(call.encryptedContent!!, envelopes)
                    } else {
                        null
                    }
                    DecryptedCallRecord(
                        record = call,
                        decryptedCallerNumber = meta?.callerNumber,
                        decryptedAnsweredBy = meta?.answeredBy,
                    )
                }
                _uiState.update {
                    it.copy(
                        calls = if (page == 1) decryptedCalls else it.calls + decryptedCalls,
                        total = response.total.toInt(),
                        currentPage = page,
                        isLoading = false,
                        isRefreshing = false,
                    )
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isLoading = false,
                        isRefreshing = false,
                        error = e.message ?: "Failed to load call history",
                    )
                }
            }
        }
    }

    fun refresh() {
        loadCalls(page = 1)
    }

    fun loadNextPage() {
        val state = _uiState.value
        if (state.calls.size < state.total && !state.isLoading) {
            loadCalls(page = state.currentPage + 1)
        }
    }

    fun setSearchQuery(query: String) {
        _uiState.update { it.copy(searchQuery = query) }
        loadCalls(page = 1)
    }

    fun setFilter(filter: CallStatusFilter) {
        _uiState.update { it.copy(selectedFilter = filter) }
        loadCalls(page = 1)
    }

    fun setDateFrom(date: String?) {
        _uiState.update { it.copy(dateFrom = date) }
        loadCalls(page = 1)
    }

    fun setDateTo(date: String?) {
        _uiState.update { it.copy(dateTo = date) }
        loadCalls(page = 1)
    }

    fun clearDateRange() {
        _uiState.update { it.copy(dateFrom = null, dateTo = null) }
        loadCalls(page = 1)
    }

    /**
     * A call's recording audio, for in-app playback (`GET /calls/:callId/recording`,
     * apps/worker/routes/calls.ts). Hub-scoped like the list it was picked from.
     */
    suspend fun loadRecording(callId: String): ByteArray =
        apiService.requestBytes("GET", apiService.hp("/api/calls/$callId/recording"))

    fun dismissError() {
        _uiState.update { it.copy(error = null) }
    }
}
