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
import org.llamenos.hotline.model.ContactDetail
import org.llamenos.protocol.ContactTimelineDetailResponse
import javax.inject.Inject

data class ContactDetailUiState(
    val contactHash: String = "",
    val contact: ContactDetail? = null,
    val isLoading: Boolean = false,
    val error: String? = null,
)

/**
 * ViewModel for the contact profile detail screen.
 *
 * Loads `GET /contacts/{hash}` — the contact's notes and conversations — and derives the
 * profile summary from it. Relationships are not loaded: the server keeps them on the
 * encrypted directory (`/directory/:id/relationships`, keyed by directory id), and nothing
 * maps a timeline contact hash to a directory id (#2002).
 */
@HiltViewModel
class ContactDetailViewModel @Inject constructor(
    private val apiService: ApiService,
) : ViewModel() {

    private val _uiState = MutableStateFlow(ContactDetailUiState())
    val uiState: StateFlow<ContactDetailUiState> = _uiState.asStateFlow()

    fun loadContact(contactHash: String) {
        if (contactHash == _uiState.value.contactHash && _uiState.value.contact != null) return

        _uiState.update { it.copy(contactHash = contactHash, isLoading = true, error = null) }

        viewModelScope.launch {
            try {
                val response = apiService.request<ContactTimelineDetailResponse>(
                    "GET",
                    apiService.hp("/api/contacts/$contactHash"),
                )
                _uiState.update {
                    it.copy(
                        contact = response.toContactDetail(contactHash),
                        isLoading = false,
                    )
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isLoading = false,
                        error = e.message ?: "Failed to load contact",
                    )
                }
            }
        }
    }
}
