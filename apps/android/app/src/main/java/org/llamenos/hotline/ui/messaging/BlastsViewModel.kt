package org.llamenos.hotline.ui.messaging

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
import kotlinx.serialization.Serializable
import org.llamenos.hotline.api.ApiService
import org.llamenos.hotline.hub.ActiveHubState
import org.llamenos.hotline.model.Member
import org.llamenos.hotline.model.MemberDirectory
import javax.inject.Inject

@Serializable
data class BlastItem(
    val id: String,
    val message: String,
    val status: String,
    val recipientCount: Int = 0,
    val createdAt: String = "",
)

@Serializable
data class BlastsListResponse(
    val blasts: List<BlastItem>,
)

@Serializable
data class CreateBlastRequest(
    val message: String,
    val recipientIds: List<String>,
    val scheduled: Boolean = false,
)

data class BlastsUiState(
    val blasts: List<BlastItem> = emptyList(),
    val users: List<Member> = emptyList(),
    val isLoading: Boolean = false,
    val error: String? = null,
    val showCreateDialog: Boolean = false,
)

/**
 * ViewModel for the Blasts screen.
 *
 * Provides CRUD for broadcast messages to users.
 */
@HiltViewModel
class BlastsViewModel @Inject constructor(
    private val apiService: ApiService,
    private val activeHubState: ActiveHubState,
) : ViewModel() {

    private val _uiState = MutableStateFlow(BlastsUiState())
    val uiState: StateFlow<BlastsUiState> = _uiState.asStateFlow()

    init {
        activeHubState.activeHubId
            .filterNotNull()
            .onEach { loadBlasts() }
            .launchIn(viewModelScope)
    }

    fun loadBlasts() {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoading = true, error = null) }
            try {
                val response = apiService.request<BlastsListResponse>(
                    "GET", "/api/admin/blasts",
                )
                _uiState.update {
                    it.copy(blasts = response.blasts, isLoading = false)
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(isLoading = false, error = e.message ?: "Failed to load blasts")
                }
            }
        }
    }

    fun showCreateDialog() {
        _uiState.update { it.copy(showCreateDialog = true) }
        loadUsers()
    }

    fun dismissCreateDialog() {
        _uiState.update { it.copy(showCreateDialog = false) }
    }

    private fun loadUsers() {
        viewModelScope.launch {
            try {
                val response = apiService.getMemberDirectory()
                _uiState.update { it.copy(users = response.members) }
            } catch (_: Exception) {
                // Silently fail — users list is supplementary
            }
        }
    }

    fun sendBlast(message: String, recipientIds: List<String>, scheduled: Boolean) {
        viewModelScope.launch {
            _uiState.update { it.copy(showCreateDialog = false, error = null) }
            try {
                val request = CreateBlastRequest(
                    message = message,
                    recipientIds = recipientIds,
                    scheduled = scheduled,
                )
                apiService.requestNoContent("POST", "/api/admin/blasts", request)
                loadBlasts()
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(error = e.message ?: "Failed to send blast")
                }
            }
        }
    }
}
