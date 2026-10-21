package org.llamenos.hotline.ui.contacts

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
import org.llamenos.hotline.hub.ActiveHubState
import org.llamenos.hotline.model.ContactSummary
import org.llamenos.hotline.model.ContactsListResponse
import javax.inject.Inject

data class ContactsUiState(
    val contacts: List<ContactSummary> = emptyList(),
    val total: Int = 0,
    val currentPage: Int = 1,
    val isLoading: Boolean = false,
    val isRefreshing: Boolean = false,
    val error: String? = null,
    val searchQuery: String = "",
    val contactTypes: List<String> = emptyList(),
    val selectedContactType: String? = null,
) {
    /**
     * The loaded contacts that match [searchQuery] by contact hash or last four digits.
     *
     * Search is local, over what has been loaded. The server has no contact search:
     * `GET /contacts/search` is shadowed by `GET /contacts/:hash` and answered 200 with a
     * lookup of a contact named "search", and `/contacts` takes only `page` and `limit`
     * (#2002). A server-side search is the server's to add.
     */
    val visibleContacts: List<ContactSummary>
        get() {
            val needle = searchQuery.trim()
            if (needle.isEmpty()) return contacts
            return contacts.filter { contact ->
                contact.contactHash.contains(needle, ignoreCase = true) ||
                    contact.last4?.contains(needle) == true
            }
        }
}

/**
 * ViewModel for the contacts screen.
 *
 * Loads paginated contact summaries from GET /contacts. Each contact
 * shows aggregated interaction counts (calls, conversations, notes, reports).
 * Search filters the loaded page(s) locally — see [ContactsUiState.visibleContacts].
 */
@HiltViewModel
class ContactsViewModel @Inject constructor(
    private val apiService: ApiService,
    private val activeHubState: ActiveHubState,
) : ViewModel() {

    private val _uiState = MutableStateFlow(ContactsUiState())
    val uiState: StateFlow<ContactsUiState> = _uiState.asStateFlow()

    init {
        activeHubState.activeHubId
            .filterNotNull()
            .onEach { loadContacts() }
            .launchIn(viewModelScope)
    }

    fun loadContacts(page: Int = 1) {
        viewModelScope.launch {
            _uiState.update {
                it.copy(
                    isLoading = page == 1 && it.contacts.isEmpty(),
                    isRefreshing = page == 1 && it.contacts.isNotEmpty(),
                    error = null,
                )
            }
            try {
                val query = buildString {
                    append(apiService.hp("/api/contacts"))
                    append("?page=$page&limit=50")
                }
                val response = apiService.request<ContactsListResponse>(
                    "GET",
                    query,
                )
                _uiState.update {
                    it.copy(
                        contacts = if (page == 1) response.contacts else it.contacts + response.contacts,
                        total = response.total,
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
                        error = e.message ?: "Failed to load contacts",
                    )
                }
            }
        }
    }

    fun refresh() {
        _uiState.update { it.copy(searchQuery = "", selectedContactType = null) }
        loadContacts(page = 1)
    }

    fun loadNextPage() {
        val state = _uiState.value
        if (state.contacts.size < state.total && !state.isLoading) {
            loadContacts(page = state.currentPage + 1)
        }
    }

    fun setSearchQuery(query: String) {
        _uiState.update { it.copy(searchQuery = query) }
    }

    fun setContactTypeFilter(contactType: String?) {
        _uiState.update { it.copy(selectedContactType = contactType, contacts = emptyList(), total = 0) }
        loadContacts(page = 1)
    }

    fun dismissError() {
        _uiState.update { it.copy(error = null) }
    }
}
