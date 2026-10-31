package org.llamenos.hotline.ui.contacts

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import org.llamenos.hotline.api.ApiService
import org.llamenos.hotline.model.ContactTimelineEvent
import org.llamenos.protocol.ContactTimelineDetailResponse
import javax.inject.Inject

data class ContactTimelineUiState(
    val contactHash: String = "",
    val events: List<ContactTimelineEvent> = emptyList(),
    val total: Int = 0,
    val isLoading: Boolean = false,
    val error: String? = null,
)

/**
 * ViewModel for the contact timeline screen.
 *
 * Loads timeline events from GET /contacts/{hash} — that route *is* the timeline
 * (PROTOCOL §4.29); there is no `/timeline` sub-path (#1730).
 */
@HiltViewModel
class ContactTimelineViewModel @Inject constructor(
    private val apiService: ApiService,
) : ViewModel() {

    private val _uiState = MutableStateFlow(ContactTimelineUiState())
    val uiState: StateFlow<ContactTimelineUiState> = _uiState.asStateFlow()

    fun loadTimeline(contactHash: String) {
        if (contactHash == _uiState.value.contactHash && _uiState.value.events.isNotEmpty()) return

        _uiState.update { it.copy(contactHash = contactHash, isLoading = true, error = null) }

        viewModelScope.launch {
            try {
                val response = apiService.request<ContactTimelineDetailResponse>(
                    "GET",
                    apiService.activeHubPath("/api/contacts/$contactHash"),
                )
                val events = response.toTimelineEvents()
                _uiState.update {
                    it.copy(
                        events = events,
                        total = events.size,
                        isLoading = false,
                    )
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isLoading = false,
                        error = e.message ?: "Failed to load timeline",
                    )
                }
            }
        }
    }
}
